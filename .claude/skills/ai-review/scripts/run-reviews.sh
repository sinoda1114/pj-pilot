#!/usr/bin/env bash
# /ai-review 純正レビューの並列起動
#
# 使い方:
#   run-reviews.sh --out <dir> [--base <ref>] [--local] [--no-codex] [--security] [--timeout <sec>]
#     --out <dir>    出力先。code-review.md / codex-review.md / security-review.md / status.txt を書く
#     --base <ref>   Codex --base に渡す比較元（既定: origin/HEAD → origin/main → origin/master）
#     --local        未コミット差分モード（/code-review は staged を見る。Codex は --uncommitted）
#     --no-codex     Codex を起動しない（秘密情報が差分に含まれる場合など）
#     --security     /code-review と Codex の代わりに /security-review だけを起動する（昇格用）
#     --timeout      各コマンドの上限秒（既定 900）
#
# モデル・effort は固定（DESIGN-v2.md §5）。セッションのモデルに関係なくここで指定する。
#   Claude : claude-opus-5 / high
#   Codex  : gpt-5.6-sol   / high
#
# 終了コード: 0 = 全て正常終了、1 = いずれかが失敗またはタイムアウト（status.txt に詳細）
# 環境変数 AI_REVIEW_DRY_RUN=1 で実コマンドを起動せずダミー出力を書く（テスト用）。
set -uo pipefail

CLAUDE_MODEL="${AI_REVIEW_CLAUDE_MODEL:-claude-opus-5}"
CLAUDE_EFFORT="${AI_REVIEW_CLAUDE_EFFORT:-high}"
CODEX_MODEL="${AI_REVIEW_CODEX_MODEL:-gpt-5.6-sol}"
CODEX_EFFORT="${AI_REVIEW_CODEX_EFFORT:-high}"

out=""; base=""; mode="branch"; use_codex=1; security=0; timeout_sec=900
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    --local) mode="local"; shift ;;
    --no-codex) use_codex=0; shift ;;
    --security) security=1; shift ;;
    --timeout) timeout_sec="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$out" ] || { echo "--out is required" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 1; }
mkdir -p "$out"
status="$out/status.txt"; : > "$status"

# .review-reports/ をレビュー対象から外す（.git/info/exclude はコミットされないローカル設定。
# 未登録だと /code-review と Codex が自分の生成物を untracked として拾いノイズになる）
git_dir="$(git rev-parse --git-dir 2>/dev/null)"
if [ -n "$git_dir" ] && ! grep -qs '^\.review-reports/\?$' "$git_dir/info/exclude" 2>/dev/null; then
  mkdir -p "$git_dir/info"; echo '.review-reports/' >> "$git_dir/info/exclude"
  echo "added .review-reports/ to $git_dir/info/exclude" >> "$status"
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

# ---- 起動 ----
# run_bg <name> <cmd...> : バックグラウンド起動し pid を返す。stdout は <out>/<name>.md、stderr は <name>.err
pids=""; names=""
run_bg() {
  local name="$1"; shift
  if [ "${AI_REVIEW_DRY_RUN:-0}" = "1" ]; then
    { echo "# DRY RUN: $name"; echo "cmd: $*"; } > "$out/$name.md"
    : > "$out/$name.err"
    ( sleep 1 ) &
  else
    ( "$@" > "$out/$name.md" 2> "$out/$name.err" ) &
  fi
  pids="$pids $!"; names="$names $name"
  echo "started $name pid=$! $(date +%H:%M:%S)" >> "$status"
}

claude_bin="$(command -v claude || true)"
codex_bin="$(command -v codex || true)"

if [ $security -eq 1 ]; then
  [ -n "$claude_bin" ] || { echo "claude not found" >> "$status"; exit 1; }
  # /security-review は origin/HEAD... 固定。未設定なら先に git remote set-head origin -a
  run_bg security-review "$claude_bin" -p --model "$CLAUDE_MODEL" --effort "$CLAUDE_EFFORT" \
      --no-session-persistence --output-format text "/security-review"
else
  if [ -n "$claude_bin" ]; then
    # /code-review: 引数なし = 現在ブランチをベース(origin/HEAD 等)と比較。--local では staged を見る
    run_bg code-review "$claude_bin" -p --model "$CLAUDE_MODEL" --effort "$CLAUDE_EFFORT" \
        --no-session-persistence --output-format text "/code-review"
  else
    echo "claude not found: /code-review skipped" >> "$status"
  fi
  if [ $use_codex -eq 1 ]; then
    if [ -n "$codex_bin" ]; then
      codex_out="$out/codex-review.last"
      if [ "$mode" = "local" ]; then
        run_bg codex-review "$codex_bin" exec review --uncommitted --skip-git-repo-check \
            -m "$CODEX_MODEL" -c model_reasoning_effort="\"$CODEX_EFFORT\"" -c sandbox_mode="\"read-only\"" \
            -o "$codex_out"
      else
        [ -n "$base" ] || { echo "base ref not found for codex --base" >> "$status"; }
        run_bg codex-review "$codex_bin" exec review --base "$base" --skip-git-repo-check \
            -m "$CODEX_MODEL" -c model_reasoning_effort="\"$CODEX_EFFORT\"" -c sandbox_mode="\"read-only\"" \
            -o "$codex_out"
      fi
    else
      echo "codex not found: codex review skipped" >> "$status"
    fi
  else
    echo "codex disabled (--no-codex)" >> "$status"
  fi
fi

# ---- 自前タイムアウト（timeout コマンド非依存）----
elapsed=0; rc_all=0
while :; do
  alive=0
  for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
  [ $alive -eq 0 ] && break
  if [ "$elapsed" -ge "$timeout_sec" ]; then
    for p in $pids; do kill "$p" 2>/dev/null; done
    sleep 2
    for p in $pids; do kill -9 "$p" 2>/dev/null; done
    echo "TIMEOUT after ${timeout_sec}s" >> "$status"; rc_all=1
    break
  fi
  sleep 3; elapsed=$((elapsed + 3))
done
for p in $pids; do wait "$p" 2>/dev/null; done

# ---- 後処理 ----
# Codex は -o の最終回答を正とし、stdout ログは .log に退避
if [ -f "$out/codex-review.last" ]; then
  mv "$out/codex-review.md" "$out/codex-review.log" 2>/dev/null || true
  mv "$out/codex-review.last" "$out/codex-review.md"
fi
for n in $names; do
  if [ -s "$out/$n.md" ]; then
    echo "ok $n $(wc -l < "$out/$n.md" | tr -d ' ') lines $(date +%H:%M:%S)" >> "$status"
  else
    echo "EMPTY $n (see $n.err)" >> "$status"; rc_all=1
  fi
done
echo "elapsed=${elapsed}s base=$base mode=$mode" >> "$status"
cat "$status"
exit $rc_all
