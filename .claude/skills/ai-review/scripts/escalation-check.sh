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
    case "$kind" in
      path)
        hit="$(printf '%s\n' "$files" | grep -iE -m1 -- "$pat" || true)"
        [ -n "$hit" ] && add_reason "A:path:$hit"
        ;;
      content)
        hit="$(printf '%s\n' "$added_lines" | grep -iE -m1 -- "$pat" || true)"
        [ -n "$hit" ] && add_reason "B:content:$(printf '%s' "$hit" | cut -c1-120)"
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
read_rules "$rules"
read_rules "$local_rules"

[ -n "$max_files" ] && [ "$file_count" -gt "$max_files" ] && add_reason "C:size:files=$file_count>$max_files"
[ -n "$max_added" ] && [ "$added_count" -gt "$max_added" ] && add_reason "C:size:added=$added_count>$max_added"

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
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
