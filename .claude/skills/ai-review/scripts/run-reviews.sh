#!/usr/bin/env bash
# /ai-review v3 レビュアーの並列起動
#
# 使い方:
#   run-reviews.sh --out <dir> [--base <ref>] [--local] [--no-codex] [--security] [--deep] [--timeout <sec>]
#     --out <dir>    出力先。<レビュアー名>.md / status.txt / changed-files.txt などを書く
#     --base <ref>   比較元（既定: origin/HEAD → origin/main → origin/master）
#     --local        未コミット差分モード（自前観点は未コミットの変更を読む。Codex は --uncommitted）
#     --no-codex     Codex を起動しない（秘密情報が差分に含まれる場合など）
#     --security     通常の 2 本の代わりに own-security（セキュリティの深掘り）だけを起動する（昇格用）
#     --deep         強化版。通常の 2 本に加えて own-security・own-review（Fable 5.1）・Codex（Astra）を並列で起動する
#     --timeout      各コマンドの上限秒（既定 900）
#
# レビュアー（出力ファイル名 = 名前。DESIGN-v3.md §3）:
#   own-review        prompts/own-review.md   × claude-opus-5-5 / high   （毎回）
#   codex-review      codex exec review 純正  × gpt-6-sol       / high   （毎回。独自の指示は渡さない）
#   own-security      prompts/own-security.md × claude-opus-5-5 / high   （--security と --deep）
#   own-review-fable  prompts/own-review.md   × claude-fable-5-1 / high  （--deep）
#   codex-astra       codex exec review 純正  × gpt-6-astra     / high   （--deep）
#   モデル・effort は固定（環境変数で上書きできない。変えるならこのファイルを直す）。
#   Opus 5.5 は CLI 2.1.280 以上が必要。既定 effort が medium なので --effort high を明示し続けること。
#
# 自前観点のプロンプトは、スラッシュコマンドとして入れずに本文を claude -p に直接渡す。
# frontmatter を外し、「対象: $ARGUMENTS（…）」の行を具体的な対象に置き換える（実際に渡した本文は
# <名前>.prompt.md に残す）。道具は読み取りと git だけに絞り、--permission-mode dontAsk で
# それ以外を黙って拒否させる（ユーザー設定の auto モードで書き込みやネットワークが通らないように）。
#
# 自前観点の出力は、判定表に変更ファイルがすべて載っているかを機械で確かめ、欠けていれば 1 回だけ
# 単独で回し直す。それでも欠けたファイルは <名前>.missing.txt に残す（gate.py が MUST-ADDRESS にする）。
#
# 終了コード: 0 = 全て正常終了、1 = いずれかが失敗・タイムアウト・レビュアー 0 起動（status.txt に詳細）
# 環境変数 AI_REVIEW_DRY_RUN=1 で実コマンドを起動せずダミー出力を書く（テスト用）。
#   AI_REVIEW_DRY_TABLE_MISSING=1|once  自前観点のダミー出力から判定表の 1 行目を抜く（once は初回だけ）
#   AI_REVIEW_DRY_VERDICT=PASS|MUST-ADDRESS|BLOCK  自前観点のダミー出力の結論
set -uo pipefail

CLAUDE_MODEL="claude-opus-5-5"
CLAUDE_DEEP_MODEL="claude-fable-5-1"
CLAUDE_EFFORT="high"
CODEX_MODEL="gpt-6-sol"
CODEX_DEEP_MODEL="gpt-6-astra"
CODEX_EFFORT="high"
# 自前観点に許す道具（読み取り + 読み取り系の git サブコマンドのみ）と、明示的に禁じる道具。
# Bash(git:*) にしない: `git -c core.fsmonitor=<cmd> status` などで任意のコマンドを実行でき、
# git config で共有の .git/config（ai-review.skip、core.hooksPath）も書き換えられる（2026-09-23 に実測）。
# git grep も入れない（-O で任意のコマンドを開く）。検索は Grep を使わせる。
CLAUDE_TOOLS="Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*),Bash(git status:*),Bash(git ls-files:*),Bash(git rev-parse:*),Bash(git blame:*),Bash(git merge-base:*),Bash(git cat-file:*),Task,Agent,TodoWrite"
# 許した git でも、ファイルに書く・外部コマンドを呼ぶオプションは位置に関係なく拒む（ワイルドカードの拒否ルールが
# 効くことを実測済み。--output はファイルを書く、--ext-diff / --textconv は設定のコマンドを動かす）
CLAUDE_DENY="Write,Edit,NotebookEdit,WebFetch,WebSearch,Bash(git *--output*),Bash(git *--ext-diff*),Bash(git *--textconv*),Bash(git *--no-index*),Bash(git *--contents*)"
# 設定の隔離（start_own）: --setting-sources "" でユーザー・プロジェクト・ローカルの settings を読まない。
# ユーザーの permissions.allow（Bash(bash *) など）は dontAsk でも通り、上の許可リストを迂回する。
# レビュー対象のコミットに入った .claude/settings.json のフックは、開発者の権限で任意のコマンドを動かす。
# --safe-mode で CLAUDE.md・スキル・プラグイン・出力スタイルを外し、--strict-mcp-config で MCP を外す。
# どれも 2026-09-23 に実測（従来の起動ではフックと bash -c が実行され、隔離後は拒否・git は動く）

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_dir="$here"  # 同梱スクリプトの場所（here は後で別の用途に上書きされるので、こちらを使う）
prompt_dir="$here/../prompts"
gate_py="$here/gate.py"

out=""; base=""; mode="branch"; use_codex=1; codex_off=""; security=0; deep=0; timeout_sec=900
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    --local) mode="local"; shift ;;
    --no-codex) use_codex=0; shift ;;
    --security) security=1; shift ;;
    --deep) deep=1; shift ;;
    --timeout) timeout_sec="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$out" ] || { echo "--out is required" >&2; exit 1; }
[ $security -eq 1 ] && [ $deep -eq 1 ] && { echo "--security と --deep は併用しない（--deep は own-security を含む）" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 1; }
py="$(command -v python3 || true)"
[ -n "$py" ] || { echo "python3 が見つからない（判定表の検査と記録に使う）" >&2; exit 1; }
for f in own-review.md own-security.md; do
  [ -f "$prompt_dir/$f" ] || { echo "プロンプトが見つからない: $prompt_dir/$f" >&2; exit 1; }
done
mkdir -p "$out" 2>/dev/null || { echo "cannot create --out: $out" >&2; exit 1; }
# レビュアーは隔離用の worktree で動くので、出力先は絶対パスで固定する。
# 解決に失敗して空になると、以降の出力が / 直下に向かうので止める。
out="$(cd "$out" 2>/dev/null && pwd -P)"
[ -n "$out" ] || { echo "cannot resolve --out" >&2; exit 1; }
# 昇格の実行は、先に回した通常のレビューの status.txt を消さないよう別のファイルに書く
if [ $security -eq 1 ]; then status="$out/status-security.txt"; else status="$out/status.txt"; fi
: > "$status"
[ $deep -eq 1 ] && : > "$out/deep.flag"
# --out を使い回したとき、前回の付随ファイル（判定表の欠け・初回の出力・Codex の -o の印）を今回の判定に
# 混ぜない。起動するレビュアーの分だけ消す（--security は通常の 2 本の分を消さない）
# 通常の実行（--deep を含む）は 5 本すべての出力を消す（前回の --deep や深掘りの古い出力を今回の結果として
# 読ませない。--security はこの後に同じ run へ足すもの）。--security は own-security の分だけ消す。
# reviewed_sha.* も消し、スクリプトが最後まで進んだときだけ書く（途中で止まった run を記録させない）。
if [ $security -eq 1 ]; then clear_names="own-security"; rm -f "$out/reviewed_sha.security" "$out/reviewed_base.security"
else clear_names="own-review codex-review own-security own-review-fable codex-astra"
  rm -f "$out/reviewed_sha.review" "$out/reviewed_sha.security" "$out/reviewed_base.review" "$out/reviewed_base.security" \
        "$out/status-security.txt"; fi
for n in $clear_names; do
  for x in md err cmd prompt.md last used-o missing.txt attempt1.md partial.md retry-partial.md dry-once; do
    rm -f "$out/$n.$x"
  done
done
[ $security -eq 0 ] && [ $deep -eq 0 ] && rm -f "$out/deep.flag"
# ダミー実行の印（record が latest.json に dry_run として残し、pre-push が拒む）
if [ "${AI_REVIEW_DRY_RUN:-0}" = "1" ]; then : > "$out/dry-run.flag"; elif [ $security -eq 0 ]; then rm -f "$out/dry-run.flag"; fi

# .review-reports/ をレビュー対象から外す（.git/info/exclude はコミットされないローカル設定。
# 未登録だとレビュアーが自分の生成物を untracked として拾いノイズになる）
# linked worktree では --git-dir が .git/worktrees/<name> を返し、そこに書いても Git は読まない。
# --git-path info/exclude なら共通 .git/info/exclude に解決される。
exclude_file="$(git rev-parse --git-path info/exclude 2>/dev/null)"
if [ -n "$exclude_file" ] && ! grep -qs '^\.review-reports/\?$' "$exclude_file" 2>/dev/null; then
  mkdir -p "$(dirname "$exclude_file")"; echo '.review-reports/' >> "$exclude_file"
  echo "added .review-reports/ to $exclude_file" >> "$status"
fi

resolve_base() {
  local b
  b="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [ -n "$b" ]; then echo "$b"; return; fi
  for c in origin/main origin/master main master; do
    if git rev-parse -q --verify "$c" >/dev/null 2>&1; then echo "$c"; return; fi
  done
  echo ""
}
[ -n "$base" ] || base="$(resolve_base)"

# ---- 作業ツリーの隔離（branch / security モード）----
# ブランチモードと昇格の対象はコミット済みの差分（base...HEAD）。ところが作業ツリーに
# 未コミットの変更があると、Codex は HEAD の差分ではなく作業ツリーをレビューし、
# 二重レビューが黙って 1 本に減る（2026-09-23 に ~/.claude で実測。フック 1 ファイルの
# コミットに対し、Codex の指摘 3 件がすべて別作業の未コミット SKILL.md だった）。
# 開始時に clean でも、レビューの数分〜15 分の間に別作業が書き換えれば同じことが起きるので、
# 常に HEAD の clean な worktree を作ってレビュアーをそこで動かす。出力は $out（元の
# リポジトリ、絶対パス）に書くので、record-gate.sh と pre-push フックの流れは変わらない。
# --local は未コミットの変更を見るのが目的なので隔離しない。詳細は DESIGN-v2.md §12。
run_cwd="$PWD"; wt=""; retry_pid=""; reviewed_sha=""; sha_file=""; base_file=""
cleanup_wt() {
  [ -n "$wt" ] || return 0
  git worktree remove --force "$wt" >/dev/null 2>&1 || { rm -rf "$wt"; git worktree prune >/dev/null 2>&1; }
  wt=""
}
on_signal() {
  # 止められたら、再試行中のものも含めてレビュアーを止めてから片付ける。
  # 止めないと、worktree が消えた後もレビュアーが動き続けてトークンを使う。
  for p in ${pids:-} ${retry_pid:-}; do kill "$p" 2>/dev/null; done
  cleanup_wt; exit "$1"
}
# 本体の ignore 済みの項目（node_modules、.env、ビルド成果物など）を worktree に用意する。
# 共有の info/exclude には書かない。同じリポジトリの他の worktree（別ブランチで .gitignore が
# 違うことがある）の見え方まで変わり、未追跡ファイルが git add -A から漏れうるため。
# ディレクトリは worktree に本物のディレクトリを作り、中身を一段ずつリンクする。本物の
# ディレクトリなので .gitignore の dir/ パターンに一致して ignore され、git は中を見ない
# （ディレクトリそのものをリンクすると dir/ パターンに一致せず、未追跡に見える）。
# ファイルはそのままリンクする（ファイル用のパターンはリンクにも一致する）。
link_ignored() {
  local top="$1" dst="$2" e c er
  git -C "$top" ls-files --others --ignored --exclude-standard --directory -z 2>/dev/null |
    while IFS= read -r -d '' e; do
      [ -n "$e" ] || continue
      # レビューの出力置き場は、どこにあっても持ち込まない。持ち込むと、並列で動く他方の
      # レビュアーの書きかけの出力を読めてしまい、ブラインドで回す意味が崩れる。
      # サブディレクトリから起動すると sub/.review-reports になるので、名前で外す。
      case "/${e%/}/" in */.review-reports/*) continue ;; esac
      # --out は任意の場所を指せるので、実際の出力先とも比べる。シンボリックリンクを経由した
      # 指定でもすり抜けないよう、リンクを解決した実パス同士で比べる（$out は pwd -P 済み）
      er="$(cd "$top/${e%/}" 2>/dev/null && pwd -P)" || er=""
      if [ -n "$er" ] && [ "$out" != "$top_real" ]; then
        case "$out/" in "$er"/*)
          # 出力先を含む項目を丸ごと外すので、その中身を要る検証が飛ぶ。黙らずに知らせる
          echo "WARN: 出力先が ignore 済みの ${e%/} の中にあるため、${e%/} を隔離環境に持ち込まない（その中身を要る検証は飛ぶ）" >> "$status"
          continue ;;
        esac
        case "$er/" in "$out"/*) continue ;; esac
      fi
      if [ "${e%/}" != "$e" ]; then
        e="${e%/}"
        { [ -e "$dst/$e" ] || [ -L "$dst/$e" ]; } && [ ! -d "$dst/$e" ] && continue
        mkdir -p "$dst/$e" || continue
        for c in "$top/$e"/* "$top/$e"/.[!.]* "$top/$e"/..?*; do
          { [ -e "$c" ] || [ -L "$c" ]; } || continue
          { [ -e "$dst/$e/${c##*/}" ] || [ -L "$dst/$e/${c##*/}" ]; } || ln -s "$c" "$dst/$e/${c##*/}"
        done
      else
        { [ -e "$dst/$e" ] || [ -L "$dst/$e" ]; } && continue
        mkdir -p "$dst/$(dirname "$e")" && ln -s "$top/$e" "$dst/$e"
      fi
    done
}
if [ "$mode" != "local" ]; then
  reviewed_sha="$(git rev-parse HEAD)"
  top="$(git rev-parse --show-toplevel)"
  top_real="$(cd "$top" && pwd -P)"
  tmp_root="${TMPDIR:-/tmp}"; tmp_root="${tmp_root%/}"
  # SIGKILL などで EXIT の trap が走らずに残った隔離用の worktree を回収する。
  # ディレクトリ名に作成したプロセスの PID を入れてあるので、そのプロセスがいなければ孤児とみなす。
  # 隔離用の worktree の中から起動されたときは、作成者がいなくてもその worktree は消さない
  cur_real="$(pwd -P)"
  git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | while IFS= read -r w; do
    b="${w##*/}"
    case "$b" in ai-review-wt.*) ;; *) continue ;; esac
    opid="${b#ai-review-wt.}"; opid="${opid%%.*}"
    case "$opid" in ''|*[!0-9]*) continue ;; esac
    wreal="$(cd "$w" 2>/dev/null && pwd -P)"
    [ -n "$wreal" ] && case "$cur_real/" in "$wreal/"*) continue ;; esac
    # kill -0 は別ユーザーのプロセスに EPERM を返し「いない」と誤判定し、ps は無い環境がある。
    # どちらか一方でも「いる」と言えば生きているとみなす（誤って消すより残す方が安全）
    { kill -0 "$opid" 2>/dev/null || ps -p "$opid" >/dev/null 2>&1; } && continue
    git worktree remove --force "$w" >/dev/null 2>&1 || rm -rf "$w"
    echo "reclaimed: 前回の実行が残した worktree を回収した ($w)" >> "$status"
  done
  git worktree prune >/dev/null 2>&1
  # レビュー対象外になる未コミットの件数を残す（突合で「push にも含まれない」と書くため）
  echo "uncommitted=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')" >> "$status"
  if [ -f "$top/.gitmodules" ] && git -C "$top" submodule status 2>/dev/null | grep -q '^[^-]'; then
    # worktree に移すと submodule が空になり、import・ビルド・参照先の確認が壊れる。
    # 隔離前と同じく元の作業ツリーで動かす（その代わり未コミットの変更が混ざりうる）
    echo "WARN: 初期化済みの submodule があるため隔離せず、元の作業ツリーでレビューする（未コミットの変更が混ざる可能性あり）" >> "$status"
  else
    wt="$(mktemp -d "$tmp_root/ai-review-wt.$$.XXXXXX" 2>/dev/null)" || wt=""
    if [ -n "$wt" ]; then
      trap cleanup_wt EXIT
      trap 'on_signal 143' TERM
      trap 'on_signal 130' INT
    fi
    if [ -n "$wt" ] && git worktree add -q --detach "$wt" "$reviewed_sha" >/dev/null 2>&1; then
      link_ignored "$top" "$wt"
      # HEAD の .gitignore では ignore されない項目（作業ツリーの .gitignore が未コミットで
      # 変わっている等）は未追跡に見え、Codex がレビュー対象に含める。持ち込まずに外す。
      # 作ったばかりの worktree で未追跡なのは、ここで持ち込んだものだけ。
      # porcelain は日本語・空白・引用符を含むパスを "\346..." の形で引用して返すので、
      # -z で生のパスを読む（引用された表示のまま rm すると何も消えない）
      n_rm=0
      while IFS= read -r -d '' l; do
        case "$l" in '?? '*)
          l="${wt:?}/${l#?? }"; l="${l%/}"
          # rm -rf は対象が無くても 0 を返すので、あったものだけを数える
          { [ -e "$l" ] || [ -L "$l" ]; } && rm -rf "$l" && n_rm=$((n_rm + 1)) ;;
        esac
      done < <(git -C "$wt" status --porcelain -z 2>/dev/null)
      [ "$n_rm" -gt 0 ] && echo "WARN: ignore されずに見えた項目を隔離環境から外した（$n_rm 件。HEAD の .gitignore と作業ツリーの規則が違う）" >> "$status"
      # 外す処理が 1 件も成功しなかった場合も含めて、最後に残っていないかを確かめる
      n_left="$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
      [ "$n_left" = "0" ] || echo "WARN: 外しきれずに隔離環境に未追跡が $n_left 件残っている。Codex のレビュー対象に混ざる" >> "$status"
      rel="$(git rev-parse --show-prefix)"
      run_cwd="$wt/$rel"; [ -d "$run_cwd" ] || run_cwd="$wt"
      echo "isolated: HEAD $(git rev-parse --short "$reviewed_sha") の clean な worktree でレビューする ($wt)" >> "$status"
    else
      [ -n "$wt" ] && rm -rf "$wt"; wt=""
      echo "WARN: worktree を作れなかったため元の作業ツリーでレビューする（未コミットの変更が混ざる可能性あり）" >> "$status"
    fi
  fi
  # record-gate.sh が HEAD と照合する（レビュー中に HEAD が動いたら記録を拒む）。書くのは最後（完走したときだけ）
  kind="$([ $security -eq 1 ] && echo security || echo review)"
  sha_file="$out/reviewed_sha.$kind"; base_file="$out/reviewed_base.$kind"
fi


# ---- 変更ファイルの一覧（判定表の検査に使う）----
# 削除したファイルは全文を読めないので除く。バイナリ（numstat が "-"）も判定表に載らないことが多いので除く。
# パスは常にリポジトリのルートからの相対（git diff の既定、ls-files は -C でルートから）。
repo_top="$(git rev-parse --show-toplevel)"
changed="$out/changed-files.txt"; : > "$changed"
list_numstat() {
  local a d p
  while IFS= read -r -d '' rec; do
    a="${rec%%$'\t'*}"; rec="${rec#*$'\t'}"; d="${rec%%$'\t'*}"; p="${rec#*$'\t'}"
    [ "$a" = "-" ] && [ "$d" = "-" ] && continue
    printf '%s\n' "$p"
  done
}
if [ "$mode" = "local" ]; then
  git -C "$repo_top" diff --numstat --no-renames --diff-filter=d -z HEAD 2>/dev/null | list_numstat >> "$changed"
  git -C "$repo_top" ls-files --others --exclude-standard -z 2>/dev/null |
    while IFS= read -r -d '' p; do
      case "/$p/" in */.review-reports/*) continue ;; esac
      [ -L "$repo_top/$p" ] && continue
      # 空や改行だけのファイルもテキストとして含める（grep -I . では漏れる）。バイナリだけ外す
      { [ ! -s "$repo_top/$p" ] || LC_ALL=C grep -qI '' "$repo_top/$p" 2>/dev/null; } && printf '%s\n' "$p"
    done >> "$changed"
elif [ -n "$base" ]; then
  git -C "$repo_top" diff --numstat --no-renames --diff-filter=d -z "$base...$reviewed_sha" 2>/dev/null | list_numstat >> "$changed"
fi
echo "changed_files=$(wc -l < "$changed" | tr -d ' ')" >> "$status"
# 昇格判定（escalation.json）を作る。record は branch の記録にこれを必須にし、下限として使う。
# 通常の実行（--deep を含む）は毎回作り直す（--out を使い回したとき、前の差分の判定を使わない）。
# --security は同じ run に足すものなので、あればそのまま使う。比較元はレビューと同じものを渡す。
if [ $security -eq 0 ] || [ ! -s "$out/escalation.json" ]; then
  rm -f "$out/escalation.json"
  if [ "${AI_REVIEW_DRY_RUN:-0}" = "1" ] && [ "${AI_REVIEW_DRY_ESCALATION:-}" != "real" ]; then
    echo '{"escalate": false, "reasons": [], "secret_paths": [], "dry_run": true}' > "$out/escalation.json"
  else
    esc_args=(); [ "$mode" = "local" ] && esc_args+=(--local); [ "$mode" != "local" ] && [ -n "$base" ] && esc_args+=(--base "$base")
    # 一時ファイルに書き、成功したときだけ置く（失敗で空のファイルを残さない）
    if ( cd "$repo_top" && "$script_dir/escalation-check.sh" ${esc_args[@]+"${esc_args[@]}"} ) > "$out/escalation.json.tmp" 2>> "$status"; then
      mv "$out/escalation.json.tmp" "$out/escalation.json"
    else
      rm -f "$out/escalation.json.tmp"
      echo "WARN: escalation-check.sh が失敗した（record は escalation.json を読めないと拒む）" >> "$status"
    fi
  fi
fi
# 秘密情報のファイルが差分にあれば、外部モデル（Codex）を起動しない（エージェントの --no-codex に頼らない）。
# 判定できない（escalation.json が無い・読めない）ときも起動しない（止める側に倒す）
if [ $use_codex -eq 1 ]; then
  n_secret="$("$py" -I -c 'import json,sys
d = json.load(open(sys.argv[1], encoding="utf-8", errors="replace"))
sp = d.get("secret_paths")
print(len(sp) if isinstance(sp, list) else "?")' "$out/escalation.json" 2>/dev/null || echo "?")"
  if [ "$n_secret" = "?" ] || [ -z "$n_secret" ]; then
    use_codex=0
    codex_off="秘密情報の判定ができない（escalation.json が無いか読めない）"
  elif [ "$n_secret" != "0" ]; then
    use_codex=0
    codex_off="秘密情報のファイルが差分に $n_secret 件ある（escalation.json の secret_paths）"
  fi
fi

# ---- 自前観点のプロンプトを組み立てる ----
# frontmatter（先頭の --- から次の --- まで）を外し、「対象: $ARGUMENTS」の行を対象に置き換える。
# 置き換える行が見つからなければ、プロンプトの形が変わったとみなして止める（黙って $ARGUMENTS のまま渡さない）。
if [ "$mode" = "local" ]; then
  target_line="対象: 未コミットの変更（ステージ済み・未ステージ・未追跡）"
else
  target_line="比較範囲: ${base:-origin/HEAD}...HEAD の差分"
fi
render_prompt() {
  TARGET_LINE="$target_line" awk '
    NR == 1 && $0 == "---" { fm = 1; next }
    fm == 1 { if ($0 == "---") fm = 2; next }
    /^対象: \$ARGUMENTS/ { print ENVIRON["TARGET_LINE"]; hit = 1; next }
    { print }
    END { if (!hit) exit 3 }
  ' "$1"
}
prompt_review="$(render_prompt "$prompt_dir/own-review.md")" || { echo "own-review.md に「対象: \$ARGUMENTS」の行が無い" >> "$status"; cat "$status"; exit 1; }
prompt_security="$(render_prompt "$prompt_dir/own-security.md")" || { echo "own-security.md に「対象: \$ARGUMENTS」の行が無い" >> "$status"; cat "$status"; exit 1; }

# ---- 起動 ----
# ダミー出力（AI_REVIEW_DRY_RUN=1）。レビュアーが終わる時点の、実際に動いている場所の状態を記録する（隔離のテスト用）。
# 自前観点には判定表と結論、Codex には最終回答ファイル（-o 相当）を作り、実行時と同じ後処理を通す。
dry_write() {
  local name="$1"; shift
  sleep "${AI_REVIEW_DRY_SLEEP:-1}"
  cd "$run_cwd" || return 1
  {
    echo "# DRY RUN: $name"
    # プロンプト本文は長く、表の行も含む（判定表の検査を惑わす）ので長さだけ出す
    printf 'cmd:'; for a in "$@"; do if [ ${#a} -gt 1000 ]; then printf ' <prompt %s chars>' "${#a}"; else printf ' %s' "$a"; fi; done; echo
    echo "cwd: $(pwd -P)"
    echo "head: $(git rev-parse --short HEAD)"
    echo "uncommitted: $(git status --porcelain | wc -l | tr -d ' ')"
    echo "node_modules: $([ -n "$(ls -A node_modules 2>/dev/null)" ] && echo yes || echo no)"
    echo "dotenv: $([ -e .env ] && echo yes || echo no)"
    echo "review_reports: $([ -e .review-reports ] && echo yes || echo no)"
    # 隔離環境のシンボリックリンクから、出力先（またはその祖先）へ届くものの数
    local n=0 l t
    if [ -n "$wt" ]; then
      while IFS= read -r -d '' l; do
        t="$(cd "$l" 2>/dev/null && pwd -P)" || continue
        case "$t/" in "$out"/*) n=$((n + 1)); continue ;; esac
        case "$out/" in "$t"/*) n=$((n + 1)) ;; esac
      done < <(find "$wt" -type l -print0 2>/dev/null)
    fi
    echo "out_leak: $n"
    case "$name" in
      own-*)
        local skip=0 f first=1
        case "${AI_REVIEW_DRY_TABLE_MISSING:-0}" in
          1) skip=1 ;;
          once) [ -e "$out/$name.dry-once" ] || { skip=1; : > "$out/$name.dry-once"; } ;;
        esac
        echo; echo "## 4.1 判定表"; echo
        echo "| ファイル | セキュリティ判定 | その他の最重段 | 根拠（1行） |"
        echo "|---|---|---|---|"
        while IFS= read -r f; do
          [ -n "$f" ] || continue
          if [ $first -eq 1 ] && [ $skip -eq 1 ]; then first=0; continue; fi
          first=0
          echo "| \`$f\` | 安全 | なし | dry run |"
        done < "$changed"
        echo; echo "## 4.4 結論"; echo; echo "**\`${AI_REVIEW_DRY_VERDICT:-PASS}\`**"; echo; echo "VERDICT: ${AI_REVIEW_DRY_VERDICT:-PASS}"
        ;;
      codex-*)
        echo; echo "${AI_REVIEW_DRY_CODEX:-No findings (dry run).}"
        ;;
    esac
  } > "$out/$name.md"
  # `[ ] && cp` で終えると codex 以外で偽になり、終了コード 1 で「失敗」扱いになるので if で書く
  case "$name" in codex-*) cp "$out/$name.md" "$out/$name.last" ;; esac
  return 0
}

# run_bg <name> <cmd...> : バックグラウンド起動し pid を返す。stdout は <out>/<name>.md、stderr は <name>.err
pids=""; names=""
run_bg() {
  local name="$1"; shift
  if [ "${AI_REVIEW_DRY_RUN:-0}" = "1" ]; then
    : > "$out/$name.err"
    if [ "${AI_REVIEW_DRY_EMPTY:-0}" = "1" ]; then
      # 空出力を作り、再試行の経路を通す（再試行するコマンドは sleep で代用する）
      printf '%s\0' sleep 30 > "$out/$name.cmd"; : > "$out/$name.md"
      ( sleep 1 ) &
    else
      ( dry_write "$name" "$@" ) &
    fi
  else
    # stdin は必ず /dev/null に落とす。claude -p も codex exec も stdin を待つため、
    # バックグラウンドで親の stdin を継承すると EOF が来ず、空出力のまま終わる
    # （2026-09-11 に code-review が 0 バイトで返る形で発生。stderr に
    #  "no stdin data received in 3s" が出る）。
    # 再実行用にコマンドを保存（並列時の衝突で空出力になった場合・判定表が欠けた場合に単独で回し直す）
    printf '%s\0' "$@" > "$out/$name.cmd"
    # exec でサブシェルを置き換える。こうしないと $! はラッパーのサブシェル PID になり、
    # タイムアウト時に kill してもレビュアー本体が生き残って .md を書き続ける
    # （書きかけの出力を完成品として ok 判定してしまう）。
    ( cd "$run_cwd" && exec "$@" < /dev/null > "$out/$name.md" 2> "$out/$name.err" ) &
  fi
  pids="$pids $!"; names="$names $name"
  echo "started $name pid=$! $(date +%H:%M:%S)" >> "$status"
}

claude_bin="$(command -v claude || true)"
codex_bin="$(command -v codex || true)"
# ダミー実行ではコマンドが無くても起動の組み立てを試せるようにする
if [ "${AI_REVIEW_DRY_RUN:-0}" = "1" ]; then
  [ -n "$claude_bin" ] || claude_bin="claude"
  [ -n "$codex_bin" ] || codex_bin="codex"
fi

# 自前観点を起動する。<name> <model> <prompt>
# プロンプトは -p の直後に置く（--allowedTools などの可変長オプションの後ろに置くと、道具名として飲み込まれる）
start_own() {
  local name="$1" model="$2" prompt="$3"
  if [ -z "$claude_bin" ]; then echo "UNAVAILABLE $name (claude not found)" >> "$status"; return; fi
  printf '%s\n' "$prompt" > "$out/$name.prompt.md"
  run_bg "$name" "$claude_bin" -p "$prompt" --model "$model" --effort "$CLAUDE_EFFORT" \
      --no-session-persistence --output-format text --permission-mode dontAsk \
      --setting-sources "" --safe-mode --strict-mcp-config \
      --allowedTools "$CLAUDE_TOOLS" --disallowedTools "$CLAUDE_DENY"
}
# 純正の Codex review を起動する（独自の指示は渡さない）。<name> <model>
start_codex() {
  local name="$1" model="$2"
  # 止めたときは理由に関係なく UNAVAILABLE（gate が未取得の項目にする。1 人だけで PASS にしない）
  if [ -n "$codex_off" ]; then echo "UNAVAILABLE $name (codex disabled: $codex_off)" >> "$status"; return; fi
  if [ $use_codex -ne 1 ]; then echo "UNAVAILABLE $name (codex disabled: --no-codex)" >> "$status"; return; fi
  if [ -z "$codex_bin" ]; then echo "UNAVAILABLE $name (codex not found)" >> "$status"; return; fi
  # レビュー対象の木に .codex/ があれば起動しない（プロジェクト設定の model_provider などで送信先や指示を
  # 差し替えられうる。どの条件で読まれるかは未確認なので、止める側に倒す）
  # 検査するのは Codex が動く木の直下（サブディレクトリから起動しても、直下の設定が読まれうる）
  # 起動位置から木の直下までの各階層を見る（途中の階層の .codex/ も読まれうる）
  local tree_top d; tree_top="$(cd "$run_cwd" && git rev-parse --show-toplevel 2>/dev/null && true)"
  tree_top="$(cd "${tree_top:-$run_cwd}" && pwd -P)"; d="$(cd "$run_cwd" && pwd -P)"
  while :; do
    if [ -e "$d/.codex" ]; then echo "UNAVAILABLE $name (codex disabled: レビュー対象に .codex/ がある)" >> "$status"; return; fi
    [ "$d" = "$tree_top" ] || [ "$d" = "/" ] && break
    d="$(dirname "$d")"
  done
  if [ "$mode" = "local" ]; then
    run_bg "$name" "$codex_bin" exec review --uncommitted --skip-git-repo-check \
        -m "$model" -c model_reasoning_effort="\"$CODEX_EFFORT\"" -c sandbox_mode="\"read-only\"" -c notify=[] -c mcp_servers={} \
        -o "$out/$name.last"
  else
    [ -n "$base" ] || { echo "base ref not found for codex --base" >> "$status"; }
    run_bg "$name" "$codex_bin" exec review --base "$base" --skip-git-repo-check \
        -m "$model" -c model_reasoning_effort="\"$CODEX_EFFORT\"" -c sandbox_mode="\"read-only\"" -c notify=[] -c mcp_servers={} \
        -o "$out/$name.last"
  fi
}

if [ $security -eq 1 ]; then
  start_own own-security "$CLAUDE_MODEL" "$prompt_security"
else
  start_own own-review "$CLAUDE_MODEL" "$prompt_review"
  start_codex codex-review "$CODEX_MODEL"
  if [ $deep -eq 1 ]; then
    start_own own-security "$CLAUDE_MODEL" "$prompt_security"
    start_own own-review-fable "$CLAUDE_DEEP_MODEL" "$prompt_review"
    start_codex codex-astra "$CODEX_DEEP_MODEL"
  fi
fi

# レビュアーが 1 つも起動できなければ失敗。ここで 0 を返すと「レビュー済み」として突合へ進んでしまう。
if [ -z "$(printf '%s' "$names" | tr -d '[:space:]')" ]; then
  echo "NO REVIEWER STARTED（claude/codex が見つからないか無効化されている）" >> "$status"
  cat "$status"; exit 1
fi

# ---- 自前タイムアウト（timeout コマンド非依存）----
elapsed=0; rc_all=0; timed_out=""
while :; do
  alive=0
  for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
  [ $alive -eq 0 ] && break
  if [ "$elapsed" -ge "$timeout_sec" ]; then
    # まだ生きているものだけを timed_out に記録する（完走済みは巻き込まない）
    set -- $pids; i=1
    for n in $names; do
      eval "p=\${$i}"
      if kill -0 "$p" 2>/dev/null; then timed_out="$timed_out $n"; fi
      i=$((i + 1))
    done
    for p in $pids; do kill "$p" 2>/dev/null; done
    sleep 2
    for p in $pids; do kill -9 "$p" 2>/dev/null; done
    echo "TIMEOUT after ${timeout_sec}s:$timed_out" >> "$status"; rc_all=1
    break
  fi
  sleep 3; elapsed=$((elapsed + 3))
done
# 終了コードを名前ごとに保存する。捨てると、レビュアーが認証エラー等で落ちて
# 途中まで stdout を吐いた場合に「指摘ゼロのレビュー済み」として突合へ入り、
# 二重化が黙って壊れて block が pass に落ちる。
failed=""
set -- $pids; i=1
for n in $names; do
  eval "p=\${$i}"
  if wait "$p" 2>/dev/null; then :; else failed="$failed $n"; fi
  i=$((i + 1))
done


# ---- 後処理 ----
# Codex は -o の最終回答を正とし、stdout ログは .log に退避
post_codex() {
  local n="$1"
  case "$n" in codex-*) ;; *) return 0 ;; esac
  if [ -f "$out/$n.last" ]; then
    mv "$out/$n.md" "$out/$n.log" 2>/dev/null || true
    mv "$out/$n.last" "$out/$n.md"
    : > "$out/$n.used-o"
  fi
}
for n in $names; do post_codex "$n"; done

is_timed_out() { case " $timed_out " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
is_failed() { case " $failed " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# 1 本だけを単独で回し直す。初回と同じタイムアウトを適用し、結果を返す（0 = 正常、1 = 失敗、2 = タイムアウト）。
# 同期実行 + `|| true` だと、途中まで出力して落ちた再試行が ok 扱いになり、応答待ちで止まるとゲート全体が戻らない。
rerun_one() {
  local n="$1" why="$2" rp re=0 rc=0
  if [ "${AI_REVIEW_DRY_RUN:-0}" = "1" ] && [ "${AI_REVIEW_DRY_EMPTY:-0}" != "1" ]; then
    ( dry_write "$n" ) &
  else
    [ -f "$out/$n.cmd" ] || return 1
    local retry_cmd=() arg
    while IFS= read -r -d '' arg; do retry_cmd+=("$arg"); done < "$out/$n.cmd"
    [ ${#retry_cmd[@]} -gt 0 ] || return 1
    # 前回の -o の印・最終回答を残すと、再実行が -o を書かずに終わっても stdout のログが ok になる
    rm -f "$out/$n.used-o" "$out/$n.last"
    ( cd "$run_cwd" && exec "${retry_cmd[@]}" < /dev/null > "$out/$n.md" 2>> "$out/$n.err" ) &
  fi
  rp=$!; retry_pid="$rp"
  echo "retry $n pid=$rp ($why) $(date +%H:%M:%S)" >> "$status"
  while kill -0 "$rp" 2>/dev/null; do
    if [ "$re" -ge "$timeout_sec" ]; then
      kill "$rp" 2>/dev/null; sleep 2; kill -9 "$rp" 2>/dev/null
      echo "TIMEOUT retry $n after ${timeout_sec}s" >> "$status"; rc=2; break
    fi
    sleep 3; re=$((re + 3))
  done
  if wait "$rp" 2>/dev/null; then :; else [ $rc -eq 2 ] || rc=1; fi
  retry_pid=""
  # Codex は -o の最終回答を正とするため、退避を再適用する（マーカーが無いと成功した再試行を捨てる）
  post_codex "$n"
  return $rc
}

# タイムアウトした側は、途中まで書かれた .md が残っていても完成品ではない。
# 部分的な出力を「レビュー済み」として突合に使わないよう退避する。
for n in $names; do
  if is_timed_out "$n" && [ -s "$out/$n.md" ]; then
    mv "$out/$n.md" "$out/$n.partial.md" 2>/dev/null || true
    : > "$out/$n.md"
    echo "PARTIAL $n を $n.partial.md へ退避（タイムアウトのため未完成）" >> "$status"
  fi
done

# 空出力は単独で 1 回だけ回し直す。
# 並列で同じ作業ツリーの npm test / next build を走らせると .next/ 等で衝突して片方が黙って
# 終了することがある（2026-09-11 に実測。単独実行なら同じコマンドが正常に完走する）。ここで直列に取り直す。
for n in $names; do
  if is_timed_out "$n" || is_failed "$n"; then continue; fi
  if [ ! -s "$out/$n.md" ] && [ -f "$out/$n.cmd" ]; then
    rerun_one "$n" "空出力: 並列衝突とみなし単独で再実行"; rc=$?
    [ $rc -eq 2 ] && timed_out="$timed_out $n"
    [ $rc -eq 1 ] && failed="$failed $n"
  fi
done

# ---- 判定表の検査（自前観点のみ）----
# v2・v3 の試作で、判定表から脆弱なファイルの行が 1 件抜ける書き漏れが毎回のように起きた（ai-review-deep-plan.md）。
# 欠けていれば 1 回だけ単独で回し直し、それでも欠けたファイルは <名前>.missing.txt に残す。
# 再実行が失敗・タイムアウト・空なら、初回の出力に戻して初回の欠けを残す（初回は完走しているので失敗扱いにしない）。
table_missing() { "$py" -I "$gate_py" table-check --output "$out/$1.md" --files "$changed"; }
for n in $names; do
  case "$n" in own-*) ;; *) continue ;; esac
  if is_timed_out "$n" || is_failed "$n" || [ ! -s "$out/$n.md" ]; then continue; fi
  if [ ! -s "$changed" ]; then
    echo "WARN: 変更ファイルの一覧が空のため $n の判定表を検査しない" >> "$status"; continue
  fi
  miss="$(table_missing "$n")"
  [ -n "$miss" ] || { echo "table ok $n" >> "$status"; continue; }
  echo "TABLE-MISSING $n $(printf '%s\n' "$miss" | wc -l | tr -d ' ') 件（1 回だけ単独で再実行）" >> "$status"
  cp "$out/$n.md" "$out/$n.attempt1.md"
  rerun_one "$n" "判定表の欠け"; rc=$?
  if [ $rc -ne 0 ] || ! grep -q '[^[:space:]]' "$out/$n.md" 2>/dev/null; then
    [ -s "$out/$n.md" ] && mv "$out/$n.md" "$out/$n.retry-partial.md"
    cp "$out/$n.attempt1.md" "$out/$n.md"
    echo "WARN: $n の再実行が完了しなかったため初回の出力を使う" >> "$status"
  else
    miss="$(table_missing "$n")"
  fi
  if [ -n "$miss" ]; then
    printf '%s\n' "$miss" > "$out/$n.missing.txt"
    echo "TABLE-INCOMPLETE $n $(printf '%s\n' "$miss" | wc -l | tr -d ' ') 件（判定なし（要確認）として MUST-ADDRESS にする）" >> "$status"
  else
    echo "table ok $n (再実行後)" >> "$status"
  fi
done

for n in $names; do
  if is_timed_out "$n"; then
    # 再実行がタイムアウトしたときの書きかけも、完成品として突合に使わせない
    [ -s "$out/$n.md" ] && { mv "$out/$n.md" "$out/$n.partial.md" 2>/dev/null || true; : > "$out/$n.md"; }
    echo "TIMEOUT $n (未完成。$n.partial.md に途中出力があれば参考のみ)" >> "$status"; rc_all=1
  elif is_failed "$n"; then
    # 途中まで出力があっても完成品ではない。突合に使わせない。
    [ -s "$out/$n.md" ] && { mv "$out/$n.md" "$out/$n.partial.md" 2>/dev/null || true; : > "$out/$n.md"; }
    echo "FAILED $n (非ゼロ終了。$n.err 参照。途中出力は $n.partial.md)" >> "$status"; rc_all=1
  elif case "$n" in codex-*) [ ! -f "$out/$n.used-o" ] ;; *) false ;; esac; then
    # Codex は -o の最終回答が正。stdout の進捗ログだけが残った状態を ok にしない。
    [ -s "$out/$n.md" ] && { mv "$out/$n.md" "$out/$n.partial.md" 2>/dev/null || true; : > "$out/$n.md"; }
    echo "FAILED $n (-o の最終回答が書かれていない。$n.partial.md は stdout ログ)" >> "$status"; rc_all=1
  elif grep -q '[^[:space:]]' "$out/$n.md" 2>/dev/null; then
    echo "ok $n $(wc -l < "$out/$n.md" | tr -d ' ') lines $(date +%H:%M:%S)" >> "$status"
  else
    echo "EMPTY $n (see $n.err)" >> "$status"; rc_all=1
  fi
done
echo "elapsed=${elapsed}s base=$base mode=$mode deep=$deep security=$security isolated=$([ -n "$wt" ] && echo yes || echo no)" >> "$status"
[ -n "${sha_file:-}" ] && printf '%s\n' "$reviewed_sha" > "$sha_file"
# 実際に使った比較範囲の起点（merge-base）も残す。record は origin/HEAD との merge-base と一致しなければ拒む
# （--base HEAD のように範囲を狭めて、未レビューのコミットを通さない）
if [ -n "${sha_file:-}" ] && [ "$mode" != "local" ] && [ -n "$base" ]; then
  git -C "$repo_top" merge-base "$base" "$reviewed_sha" > "$base_file" 2>/dev/null || true
fi
cat "$status"
exit $rc_all
