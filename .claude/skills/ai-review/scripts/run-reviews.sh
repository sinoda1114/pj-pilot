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
#   Claude : claude-opus-5-5 / high  （/code-review・/security-review とも）
#   Codex  : gpt-6-sol       / high
#   2026-09-23 ベンチで選定（ai-review-benchmark-v2/case-110-balanced/MEASUREMENT-ISSUES.md ほか）。
#   Opus 5.5 は CLI 2.1.280 以上が必要。既定 effort が medium なので --effort high を明示し続けること。
#
# 終了コード: 0 = 全て正常終了、1 = いずれかが失敗・タイムアウト・レビュアー 0 起動（status.txt に詳細）
# 環境変数 AI_REVIEW_DRY_RUN=1 で実コマンドを起動せずダミー出力を書く（テスト用）。
# モデル・effort は環境変数で上書きできない（固定が契約。変えるならこのファイルを直す）。
set -uo pipefail

CLAUDE_MODEL="claude-opus-5-5"
CLAUDE_EFFORT="high"
CODEX_MODEL="gpt-6-sol"
CODEX_EFFORT="high"

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
mkdir -p "$out" 2>/dev/null || { echo "cannot create --out: $out" >&2; exit 1; }
# レビュアーは隔離用の worktree で動くので、出力先は絶対パスで固定する。
# 解決に失敗して空になると、以降の出力が / 直下に向かうので止める。
out="$(cd "$out" 2>/dev/null && pwd -P)"
[ -n "$out" ] || { echo "cannot resolve --out" >&2; exit 1; }
status="$out/status.txt"; : > "$status"

# .review-reports/ をレビュー対象から外す（.git/info/exclude はコミットされないローカル設定。
# 未登録だと /code-review と Codex が自分の生成物を untracked として拾いノイズになる）
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
run_cwd="$PWD"; wt=""; retry_pid=""; reviewed_sha=""
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
  local top="$1" dst="$2" e c
  git -C "$top" ls-files --others --ignored --exclude-standard --directory -z 2>/dev/null |
    while IFS= read -r -d '' e; do
      [ -n "$e" ] || continue
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
  tmp_root="${TMPDIR:-/tmp}"; tmp_root="${tmp_root%/}"
  # SIGKILL などで EXIT の trap が走らずに残った隔離用の worktree を回収する。
  # ディレクトリ名に作成したプロセスの PID を入れてあるので、そのプロセスがいなければ孤児とみなす。
  git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | while IFS= read -r w; do
    b="${w##*/}"
    case "$b" in ai-review-wt.*) ;; *) continue ;; esac
    opid="${b#ai-review-wt.}"; opid="${opid%%.*}"
    case "$opid" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$opid" 2>/dev/null && continue
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
      leaked="$(git -C "$wt" status --porcelain 2>/dev/null | sed -n 's/^?? //p')"
      if [ -n "$leaked" ]; then
        printf '%s\n' "$leaked" | while IFS= read -r l; do rm -rf "${wt:?}/${l%/}"; done
        echo "WARN: ignore されずに見えた項目を隔離環境から外した（$(printf '%s\n' "$leaked" | wc -l | tr -d ' ') 件。HEAD の .gitignore と作業ツリーの規則が違う）" >> "$status"
      fi
      rel="$(git rev-parse --show-prefix)"
      run_cwd="$wt/$rel"; [ -d "$run_cwd" ] || run_cwd="$wt"
      echo "isolated: HEAD $(git rev-parse --short "$reviewed_sha") の clean な worktree でレビューする ($wt)" >> "$status"
    else
      [ -n "$wt" ] && rm -rf "$wt"; wt=""
      echo "WARN: worktree を作れなかったため元の作業ツリーでレビューする（未コミットの変更が混ざる可能性あり）" >> "$status"
    fi
  fi
  # record-gate.sh が HEAD と照合する（レビュー中に HEAD が動いたら記録を拒む）
  printf '%s\n' "$reviewed_sha" > "$out/reviewed_sha.$([ $security -eq 1 ] && echo security || echo review)"
fi

# ---- 起動 ----
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
      # レビュアーが終わる時点の、実際に動いている場所の状態を記録する（隔離のテスト用）
      ( sleep "${AI_REVIEW_DRY_SLEEP:-1}"
        cd "$run_cwd" && {
          echo "# DRY RUN: $name"; echo "cmd: $*"; echo "cwd: $(pwd -P)"
          echo "head: $(git rev-parse --short HEAD)"
          echo "uncommitted: $(git status --porcelain | wc -l | tr -d ' ')"
          echo "node_modules: $([ -n "$(ls -A node_modules 2>/dev/null)" ] && echo yes || echo no)"
          echo "dotenv: $([ -e .env ] && echo yes || echo no)"
        } > "$out/$name.md"
        # 実行時と同じ後処理を通すため、Codex は -o 相当の最終回答ファイルも作る。
        # `[ ] && cp` で終えると code-review では偽になり、終了コード 1 で「失敗」扱いになる
        if [ "$name" = "codex-review" ]; then cp "$out/$name.md" "$out/codex-review.last"; fi
      ) &
    fi
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
    ( cd "$run_cwd" && exec "$@" < /dev/null > "$out/$name.md" 2> "$out/$name.err" ) &
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
    retry_cmd=()
    while IFS= read -r -d '' arg; do retry_cmd+=("$arg"); done < "$out/$n.cmd"
    if [ ${#retry_cmd[@]} -gt 0 ]; then
      # 再試行にも初回と同じタイムアウトと終了コード記録を適用する。
      # 同期実行 + `|| true` だと、途中まで出力して落ちた再試行が ok 扱いになり、
      # 応答待ちで止まるとゲート全体が戻らない。
      ( cd "$run_cwd" && exec "${retry_cmd[@]}" < /dev/null > "$out/$n.md" 2>> "$out/$n.err" ) &
      rp=$!; retry_pid="$rp"; re=0
      echo "retry $n pid=$rp (空出力: 並列衝突とみなし単独で再実行) $(date +%H:%M:%S)" >> "$status"
      while kill -0 "$rp" 2>/dev/null; do
        if [ "$re" -ge "$timeout_sec" ]; then
          kill "$rp" 2>/dev/null; sleep 2; kill -9 "$rp" 2>/dev/null
          timed_out="$timed_out $n"; echo "TIMEOUT retry $n after ${timeout_sec}s" >> "$status"; break
        fi
        sleep 3; re=$((re + 3))
      done
      if wait "$rp" 2>/dev/null; then :; else is_timed_out "$n" || failed="$failed $n"; fi
      retry_pid=""
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
echo "elapsed=${elapsed}s base=$base mode=$mode isolated=$([ -n "$wt" ] && echo yes || echo no)" >> "$status"
cat "$status"
exit $rc_all
