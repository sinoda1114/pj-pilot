#!/usr/bin/env bash
# /ai-review 昇格判定（機械判定。モデル不使用）
#
# 使い方:
#   escalation-check.sh [--base <ref>] [--local] [--rules <file>] [--local-rules <file>]
#     --base <ref>   比較元（既定: origin/HEAD の指す枝、無ければ origin/main / origin/master）
#     --local        未コミット差分（staged + unstaged + untracked）を対象にする
#     --rules        共通ルール（既定: このスクリプトと同じディレクトリの ../escalation-rules.txt）
#     --local-rules  プロジェクト追記（既定: $PWD/.ai-review/escalation-rules.local.txt、無ければ無視）
#
# 出力: JSON 1 行を stdout に出す。
#   {"escalate":true|false,"reasons":[...],"secret_paths":[...],"files":N,"added":N,"base":"..."}
# 終了コード: 0 = 判定完了（escalate の真偽は JSON で見る）、2 = git 取得失敗
#
# bash 3.2（macOS 既定）で動く。連想配列・mapfile は使わない。
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rules="$here/../escalation-rules.txt"
local_rules="$PWD/.ai-review/escalation-rules.local.txt"
base=""
mode="branch"

while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="$2"; shift 2 ;;
    --local) mode="local"; shift ;;
    --rules) rules="$2"; shift 2 ;;
    --local-rules) local_rules="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo '{"error":"not a git repository"}'; exit 2; }

resolve_base() {
  local b
  b="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [ -n "$b" ]; then echo "$b"; return; fi
  for c in origin/main origin/master main master; do
    if git rev-parse -q --verify "$c" >/dev/null 2>&1; then echo "$c"; return; fi
  done
  echo ""
}

if [ "$mode" = "branch" ]; then
  [ -n "$base" ] || base="$(resolve_base)"
  if [ -z "$base" ]; then
    echo '{"error":"base ref not found. run: git remote set-head origin -a"}'; exit 2
  fi
  merge_base="$(git merge-base "$base" HEAD 2>/dev/null || true)"
  [ -n "$merge_base" ] || { echo "{\"error\":\"no merge-base with $base\"}"; exit 2; }
  files="$(git diff --name-only "$merge_base" HEAD 2>/dev/null)"
  added_lines="$(git diff "$merge_base" HEAD 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' | sed 's/^+//')"
else
  base="(uncommitted)"
  tracked="$(git diff --name-only HEAD 2>/dev/null)"
  untracked="$(git ls-files --others --exclude-standard 2>/dev/null)"
  files="$(printf '%s\n%s\n' "$tracked" "$untracked" | sed '/^$/d')"
  added_tracked="$(git diff HEAD 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' | sed 's/^+//')"
  added_untracked=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if LC_ALL=C grep -qI . "$f" 2>/dev/null; then
      added_untracked="$added_untracked
$(cat "$f")"
    fi
  done <<EOF
$untracked
EOF
  added_lines="$(printf '%s\n%s\n' "$added_tracked" "$added_untracked")"
fi

file_count="$(printf '%s\n' "$files" | sed '/^$/d' | wc -l | tr -d ' ')"
added_count="$(printf '%s\n' "$added_lines" | sed '/^$/d' | wc -l | tr -d ' ')"

reasons=""
secret_paths=""
max_files=""
max_added=""

# 文字単位で切り詰める。cut -c も awk substr も UTF-8 では実質バイト単位で切れ、
# 多バイト文字の途中で割れると JSON に不正バイトが混入して全体がパース不能になる。
# 日本語のコメント行は content ルールに日常的に当たるため確実に踏む。
# perl が無ければ切り詰めない。長い理由より不正 JSON の方が害が大きい。
trunc_chars() {
  if command -v perl >/dev/null 2>&1; then
    printf '%s' "$1" | perl -CS -ne 'print substr($_, 0, 120)'
  else
    printf '%s' "$1"
  fi
}

add_reason() { reasons="$reasons
$1"; }

# ルールファイルを共通 → ローカルの順に読む
read_rules() {
  local f="$1"
  [ -f "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    kind="${line%%[[:space:]]*}"
    pat="${line#*[[:space:]]}"
    pat="$(printf '%s' "$pat" | sed 's/^[[:space:]]*//')"
    if [ "${secret_only:-0}" = "1" ] && [ "$kind" != "secret" ]; then continue; fi
    if [ "${secret_only:-0}" = "0" ] && [ "$kind" = "secret" ]; then continue; fi
    case "$kind" in
      path)
        hit="$(printf '%s\n' "$files" | grep -iE -m1 -- "$pat" || true)"
        [ -n "$hit" ] && add_reason "A:path:$hit"
        ;;
      content)
        # 秘密ファイル由来の行は本文を絶対に理由へ載せない（外部モデルにもレポートにも出さない）。
        # そのため判定対象を content_lines（secret パス除外済み）に限定する。
        hit="$(printf '%s\n' "$content_lines" | grep -iE -m1 -- "$pat" || true)"
        [ -n "$hit" ] && add_reason "B:content:$(trunc_chars "$hit")"
        ;;
      secret)
        hit="$(printf '%s\n' "$files" | grep -iE -- "$pat" || true)"
        [ -n "$hit" ] && secret_paths="$secret_paths
$hit"
        ;;
      max_files) max_files="$pat" ;;
      max_added) max_added="$pat" ;;
    esac
  done < "$f"
}
# --- 2 パス構成 ---
# 1 パス目: secret ルールだけを適用して秘密ファイルを確定する。
# 2 パス目: 秘密ファイル由来の行を除いた content_lines に対して content ルールを適用する。
# こうしないと、tracked な .env の行が content ルールに一致したとき、その本文が
# reasons に入りレポートと外部モデルへ流出する（SKILL.md は「ファイル名だけ」と規定）。
secret_only=1
read_rules "$rules"
read_rules "$local_rules"
secret_only=0

content_lines="$added_lines"
if [ -n "$(printf '%s' "$secret_paths" | tr -d '[:space:]')" ]; then
  # 秘密ファイルを除いた一覧を作り、そこからだけ content 判定用の行を組み直す。
  # 「秘密があるから content 判定を全部やめる」は安全だが過剰で、eval( 等の
  # 本来拾うべき追加行を取りこぼす。除外は秘密ファイル単位に留める。
  safe_files="$(printf '%s\n' "$files" | sed '/^$/d')"
  while IFS= read -r sp; do
    [ -n "$sp" ] || continue
    safe_files="$(printf '%s\n' "$safe_files" | grep -vxF -- "$sp" || true)"
  done <<SECEOF
$secret_paths
SECEOF
  content_lines=""
  while IFS= read -r sf; do
    [ -n "$sf" ] || continue
    if [ "$mode" = "branch" ]; then
      chunk="$(git diff "$merge_base" HEAD -- "$sf" 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' | sed 's/^+//')"
    elif git ls-files --error-unmatch -- "$sf" >/dev/null 2>&1; then
      chunk="$(git diff HEAD -- "$sf" 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' | sed 's/^+//')"
    elif LC_ALL=C grep -qI . "$sf" 2>/dev/null; then
      chunk="$(cat "$sf" 2>/dev/null)"
    else
      chunk=""
    fi
    [ -n "$chunk" ] && content_lines="$content_lines
$chunk"
  done <<FEOF
$safe_files
FEOF
fi

reasons=""
read_rules "$rules"
read_rules "$local_rules"

[ -n "$max_files" ] && [ "$file_count" -gt "$max_files" ] && add_reason "C:size:files=$file_count>$max_files"
[ -n "$max_added" ] && [ "$added_count" -gt "$max_added" ] && add_reason "C:size:added=$added_count>$max_added"

# JSON 文字列のエスケープ。制御文字を必ず潰す。
# 生のタブ・改行が混じると JSON が壊れ、SKILL.md §3.2 がこれを読めずゲートの
# 安全側の経路が死ぬ（content ルールはインデント行に当たるため日常的に起きる）。
json_escape() {
  printf '%s' "$1" | LC_ALL=C awk '
    BEGIN { RS="\n"; ORS="" }
    {
      if (NR > 1) printf "\\n"
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1); o = index(chars, c)
        if (c == "\\") printf "\\\\"
        else if (c == "\"") printf "\\\""
        else if (c == "\t") printf "\\t"
        else if (c == "\r") printf "\\r"
        else {
          v = 0
          for (j = 0; j < 32; j++) if (c == sprintf("%c", j)) { v = 1; printf "\\u%04x", j; break }
          if (!v) printf "%s", c
        }
      }
    }'
}
to_json_array() {
  local out="" first=1 item
  while IFS= read -r item; do
    [ -n "$item" ] || continue
    if [ $first -eq 1 ]; then first=0; else out="$out,"; fi
    out="$out\"$(json_escape "$item")\""
  done <<EOF
$1
EOF
  printf '[%s]' "$out"
}

escalate=false
[ -n "$(printf '%s' "$reasons" | sed '/^$/d')" ] && escalate=true

printf '{"escalate":%s,"reasons":%s,"secret_paths":%s,"files":%s,"added":%s,"base":"%s"}\n' \
  "$escalate" "$(to_json_array "$reasons")" "$(to_json_array "$secret_paths")" \
  "$file_count" "$added_count" "$(json_escape "$base")"
