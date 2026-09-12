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
    # stdin は必ず /dev/null に落とす。claude -p も codex exec も stdin を待つため、
    # バックグラウンドで親の stdin を継承すると EOF が来ず、空出力のまま終わる
    # （2026-09-11 に code-review が 0 バイトで返る形で発生。stderr に
    #  "no stdin data received in 3s" が出る）。
    # 再実行用にコマンドを保存（並列時の衝突で空出力になった場合に単独で回し直す）
    printf '%s\0' "$@" > "$out/$name.cmd"
    # exec でサブシェルを置き換える。こうしないと $! はラッパーのサブシェル PID になり、
    # タイムアウト時に kill してもレビュアー本体が生き残って .md を書き続ける
    # （書きかけの出力を完成品として ok 判定してしまう）。
    ( exec "$@" < /dev/null > "$out/$name.md" 2> "$out/$name.err" ) &
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
    # /code-review の既定は「未コミット差分」。branch モードで引数なしだと push 対象の
    # コミット済み差分を一切見ず、たまたま残っている未追跡ファイルだけをレビューしてしまう
    # （2026-09-11 に実際に発生し、未追跡の doc 1 件だけがレビューされた）。
    # 対策として diff range を引数で渡す（実測で動作確認済み）。渡すのは「何を見るか」だけで、
    # レビュー観点は /code-review 側に委ねる。
    # 注意: 引数なしの後ろに改行＋説明文を足す形は code-review が空を返すため使わないこと。
    if [ "$mode" = "local" ]; then
      cr_prompt="/code-review"
    else
      cr_prompt="/code-review ${base:-origin/HEAD}...HEAD"
    fi
    run_bg code-review "$claude_bin" -p --model "$CLAUDE_MODEL" --effort "$CLAUDE_EFFORT" \
        --no-session-persistence --output-format text "$cr_prompt"
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
if [ -f "$out/codex-review.last" ]; then
  mv "$out/codex-review.md" "$out/codex-review.log" 2>/dev/null || true
  mv "$out/codex-review.last" "$out/codex-review.md"
  : > "$out/codex-review.used-o"
fi
# 空出力は単独で 1 回だけ回し直す。
# code-review と codex は検証のため同じ作業ツリーで npm test / next build を走らせるため、
# 並列だと .next/ 等で衝突して片方が黙って終了することがある（2026-09-11 に実測。
# 単独実行なら同じコマンドが正常に完走することを確認済み）。ここで直列に取り直す。
is_timed_out() { case " $timed_out " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# タイムアウトした側は、途中まで書かれた .md が残っていても完成品ではない。
# 部分的な出力を「レビュー済み」として突合に使わないよう退避する。
for n in $names; do
  if is_timed_out "$n" && [ -s "$out/$n.md" ]; then
    mv "$out/$n.md" "$out/$n.partial.md" 2>/dev/null || true
    : > "$out/$n.md"
    echo "PARTIAL $n を $n.partial.md へ退避（タイムアウトのため未完成）" >> "$status"
  fi
done

for n in $names; do
  if is_timed_out "$n"; then continue; fi
  case " $failed " in *" $n "*) continue ;; esac
  if [ ! -s "$out/$n.md" ] || [ ! -f "$out/$n.cmd" ]; then
    [ -f "$out/$n.cmd" ] || continue
    echo "retry $n (空出力: 並列衝突とみなし単独で再実行) $(date +%H:%M:%S)" >> "$status"
    retry_cmd=()
    while IFS= read -r -d '' arg; do retry_cmd+=("$arg"); done < "$out/$n.cmd"
    if [ ${#retry_cmd[@]} -gt 0 ]; then
      "${retry_cmd[@]}" < /dev/null > "$out/$n.md" 2>> "$out/$n.err" || true
      # Codex は -o の最終回答を正とするため、退避を再適用する
      if [ "$n" = "codex-review" ] && [ -f "$out/codex-review.last" ]; then
        mv "$out/codex-review.md" "$out/codex-review.log" 2>/dev/null || true
        mv "$out/codex-review.last" "$out/codex-review.md"
        # 初回後処理と同じくマーカーを立てる。これが無いと最終判定が
        # 「-o の最終回答なし」と誤認し、成功したリトライ結果を捨てる。
        : > "$out/codex-review.used-o"
      fi
    fi
  fi
done

is_failed() { case " $failed " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

for n in $names; do
  if is_timed_out "$n"; then
    echo "TIMEOUT $n (未完成。$n.partial.md に途中出力があれば参考のみ)" >> "$status"; rc_all=1
  elif is_failed "$n"; then
    # 途中まで出力があっても完成品ではない。突合に使わせない。
    [ -s "$out/$n.md" ] && { mv "$out/$n.md" "$out/$n.partial.md" 2>/dev/null || true; : > "$out/$n.md"; }
    echo "FAILED $n (非ゼロ終了。$n.err 参照。途中出力は $n.partial.md)" >> "$status"; rc_all=1
  elif [ "$n" = "codex-review" ] && [ ! -f "$out/codex-review.used-o" ]; then
    # Codex は -o の最終回答が正。stdout の進捗ログだけが残った状態を ok にしない。
    [ -s "$out/$n.md" ] && { mv "$out/$n.md" "$out/$n.partial.md" 2>/dev/null || true; : > "$out/$n.md"; }
    echo "FAILED $n (-o の最終回答が書かれていない。$n.partial.md は stdout ログ)" >> "$status"; rc_all=1
  elif [ -s "$out/$n.md" ]; then
    echo "ok $n $(wc -l < "$out/$n.md" | tr -d ' ') lines $(date +%H:%M:%S)" >> "$status"
  else
    echo "EMPTY $n (see $n.err)" >> "$status"; rc_all=1
  fi
done
echo "elapsed=${elapsed}s base=$base mode=$mode" >> "$status"
cat "$status"
exit $rc_all
