#!/usr/bin/env bash
# run-reviews.sh の隔離と record-gate.sh の SHA 照合の回帰テスト（DESIGN-v2.md §12）。
# AI_REVIEW_DRY_RUN=1 で実レビュアーは起動しない（トークンを使わない）。数十秒で終わる。
#   使い方: scripts/test-isolation.sh [run-reviews.sh のパス]
# run-reviews.sh / record-gate.sh を直したら通すこと。
set -u
RR="${1:-$(cd "$(dirname "$0")" && pwd)/run-reviews.sh}"
RR="$(cd "$(dirname "$RR")" && pwd)/$(basename "$RR")" || exit 2   # 相対パスでも動くように
RG="$(dirname "$RR")/record-gate.sh"
[ -f "$RR" ] && [ -f "$RG" ] || { echo "run-reviews.sh / record-gate.sh が見つからない" >&2; exit 2; }
# 準備に失敗したらここで止める。続けると、一時リポジトリではなく呼び出し元で git を操作しかねない
T="$(mktemp -d "${TMPDIR:-/tmp}/rr-test.XXXXXX")" && [ -n "$T" ] && [ -d "$T" ] || { echo "mktemp 失敗" >&2; exit 2; }
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok(){ echo "  PASS $1"; pass=$((pass+1)); }
ng(){ echo "  FAIL $1"; fail=$((fail+1)); }
G(){ git -c user.email=t@t -c user.name=t "$@"; }
die(){ echo "準備に失敗: $1" >&2; exit 2; }
# 一時リポジトリへの push にはグローバルの pre-push フック（ai-review のゲート）を効かせない。
# 効くと push が拒まれ、origin/main ができないまま別の条件で試すことになる
P(){ G push -q --no-verify "$@" 2>/dev/null; }
G init -q --bare -b main "$T/origin.git" || die "bare リポジトリ"
G clone -q "$T/origin.git" "$T/repo" 2>/dev/null || die "clone"
cd "$T/repo" || die "cd"
[ "$(pwd -P)" = "$(cd "$T/repo" && pwd -P)" ] || die "作業ディレクトリの確認"
echo base > a.txt; G add -A; G commit -qm base; P origin HEAD:main || die "push"
# push 直後は origin/main の追跡用の参照が無いので fetch してから origin/HEAD を張る。
# 失敗を捨てると、比較元がローカルの main に落ちて本物と違う条件で試すことになる
G fetch -q origin && G remote set-head origin main >/dev/null || die "origin/HEAD の設定"
echo committed > a.txt; G commit -qam change
printf 'node_modules/\n.env\n' > .gitignore; G add .gitignore; G commit -qm ignore
mkdir -p node_modules/pkg && echo x > node_modules/pkg/i.js; echo SECRET=1 > .env
field(){ sed -n "s/^$3: //p" "$1/$2.md"; }
wt_count(){ git worktree list | wc -l | tr -d ' '; }
excl="$(git rev-parse --git-path info/exclude)"
# .review-reports/ の行は run-reviews.sh が最初の実行で恒久的に足す既存の仕様。それ以外が変わらないかを見る
excl_now(){ grep -v '^\.review-reports/$' "$excl" 2>/dev/null; }
run(){ AI_REVIEW_DRY_RUN=1 bash "$RR" "$@" >/dev/null 2>&1; }
HEADSHA="$(git rev-parse --short HEAD)"

echo "1. clean な作業ツリーでも隔離する（レビュー中に書き換えられても混ざらないように）"
excl_before="$(excl_now)"
run --out "$T/o1"
[ "$(field "$T/o1" code-review cwd)" != "$(pwd -P)" ] && ok "worktree で動く" || ng "元のリポジトリで動いた"
grep -q '^isolated:' "$T/o1/status.txt" && ok "status.txt に隔離を記録" || ng "記録なし"
[ "$(field "$T/o1" code-review node_modules)" = "yes" ] && ok "node_modules の中身が使える" || ng "node_modules が空"
[ "$(field "$T/o1" code-review dotenv)" = "yes" ] && ok ".env など ignore 済みのファイルも使える" || ng ".env なし"
[ "$(field "$T/o1" code-review uncommitted)" = "0" ] && ok "リンクが未追跡として見えない（0 件）" || ng "未コミット=$(field "$T/o1" code-review uncommitted)"
[ "$(excl_now)" = "$excl_before" ] && ok "共有の info/exclude を変えない" || ng "info/exclude が変わった"
[ "$(wt_count)" = "1" ] && ok "終了後に worktree が消える" || ng "残った: $(wt_count)"

echo "2-3. 未コミットの変更あり（変更 + 未追跡）"
echo DIRTY > a.txt; echo junk > untracked.txt
run --out "$T/o2"
[ "$(field "$T/o2" code-review cwd)" != "$(pwd -P)" ] && [ "$(field "$T/o2" codex-review cwd)" != "$(pwd -P)" ] && ok "両レビュアーとも worktree で動く" || ng "cwd がずれた"
[ "$(field "$T/o2" code-review head)" = "$HEADSHA" ] && ok "HEAD を見る" || ng "head=$(field "$T/o2" code-review head)"
[ "$(field "$T/o2" code-review uncommitted)" = "0" ] && ok "未コミットの変更・未追跡が見えない（0 件）" || ng "未コミット=$(field "$T/o2" code-review uncommitted)"
grep -q '^uncommitted=2$' "$T/o2/status.txt" && ok "対象外になった未コミットの件数を status.txt に残す" || ng "件数の記録なし"
[ "$(cat a.txt)" = "DIRTY" ] && [ -f untracked.txt ] && ok "元の未コミット変更は無傷" || ng "元の変更が壊れた"
git checkout -q -- a.txt; rm -f untracked.txt

echo "4. --local（未コミットを見るモード）は隔離しない"
run --out "$T/o4" --local
[ "$(field "$T/o4" code-review cwd)" = "$(pwd -P)" ] && ok "元のリポジトリで動く" || ng "cwd=$(field "$T/o4" code-review cwd)"

echo "5. --security も隔離する"
run --out "$T/o5" --security
[ "$(field "$T/o5" security-review cwd)" != "$(pwd -P)" ] && ok "worktree で動く" || ng "元のリポジトリで動いた"

echo "6. --out"
run --out rel-out
[ -s "$T/repo/rel-out/code-review.md" ] && ok "相対パスでも元のリポジトリに書かれる" || ng "rel-out に出力なし"; rm -rf rel-out
AI_REVIEW_DRY_RUN=1 bash "$RR" --out /dev/null/x >/dev/null 2>&1; rc=$?
[ ${rc} -ne 0 ] && ok "作れない出力先では起動せず失敗する（exit ${rc}）" || ng "作れない出力先で成功扱い"

echo "7. レビュー中に本体が書き換えられても混ざらず、共有設定にも触れない"
( AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_SLEEP=3 bash "$RR" --out "$T/o7" >/dev/null 2>&1 ) & rp=$!
# 隔離の有無に関係なく必ず出る行を待つ（isolated: を待つと、隔離しない版では
# レビューが終わってから書き換えることになり、何も試さずに通ってしまう）
for _ in $(seq 1 50); do grep -q '^started code-review' "$T/o7/status.txt" 2>/dev/null && break; sleep 0.2; done
mid_excl="$(excl_now)"
echo RACE > a.txt; echo late > late.txt                      # 開始後に別作業が書き換える
wait "$rp"
[ "$(field "$T/o7" code-review uncommitted)" = "0" ] && ok "開始後の書き換えは見えない" || ng "混ざった: 未コミット=$(field "$T/o7" code-review uncommitted)"
[ "$mid_excl" = "$excl_before" ] && ok "実行中も info/exclude は変わらない（他の worktree に影響しない）" || ng "実行中に info/exclude が変わった"
git checkout -q -- a.txt; rm -f late.txt

echo "8. 止められた場合"
( AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_SLEEP=30 bash "$RR" --out "$T/o8" >/dev/null 2>&1 ) & rp=$!
for _ in $(seq 1 50); do grep -q '^isolated:' "$T/o8/status.txt" 2>/dev/null && break; sleep 0.2; done
kill -TERM "$rp" 2>/dev/null; wait "$rp" 2>/dev/null; sleep 1
[ "$(wt_count)" = "1" ] && ok "worktree が消える" || ng "残った: $(wt_count)"
alive=""; for p in $(sed -n 's/^started .* pid=\([0-9]*\).*/\1/p' "$T/o8/status.txt"); do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
[ -z "$alive" ] && ok "レビュアーも止まる" || { ng "生き残った:$alive"; for p in $alive; do kill "$p" 2>/dev/null; done; }
( AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_EMPTY=1 bash "$RR" --out "$T/o8b" >/dev/null 2>&1 ) & rp=$!
for _ in $(seq 1 100); do grep -q '^retry .* pid=' "$T/o8b/status.txt" 2>/dev/null && break; sleep 0.2; done
rpid="$(sed -n 's/^retry .* pid=\([0-9]*\).*/\1/p' "$T/o8b/status.txt" | head -1)"
kill -TERM "$rp" 2>/dev/null; wait "$rp" 2>/dev/null; sleep 1
[ -n "$rpid" ] && ! kill -0 "$rpid" 2>/dev/null && ok "再試行中のレビュアーも止まる" || { ng "再試行が生き残った（pid=${rpid:-不明}）"; [ -n "$rpid" ] && kill "$rpid" 2>/dev/null; }

echo "9. 異常終了で残った worktree の回収"
tmp_root="${TMPDIR:-/tmp}"; tmp_root="${tmp_root%/}"
dead="$tmp_root/ai-review-wt.999999.test$$"; live="$tmp_root/ai-review-wt.$$.test$$"
git worktree add -q --detach "$dead" HEAD && git worktree add -q --detach "$live" HEAD
run --out "$T/o9"
git worktree list | grep -q "ai-review-wt.999999.test$$" && ng "作成者のいない worktree が残った" || ok "作成者のいない worktree を回収する"
git worktree list | grep -q "ai-review-wt.$$.test$$" && ok "作成者が生きている worktree には触れない" || ng "生きている worktree まで消した"
grep -q '^reclaimed:' "$T/o9/status.txt" && ok "回収を status.txt に記録" || ng "記録なし"
git worktree remove --force "$live" 2>/dev/null; rm -rf "$dead" "$live"; git worktree prune

echo "10. ignore の規則が HEAD と作業ツリーで違う項目（未コミットの .gitignore 変更）"
echo 'extra/' >> .gitignore; mkdir -p extra && echo e > extra/f.txt
run --out "$T/o10"
[ "$(field "$T/o10" code-review uncommitted)" = "0" ] && ok "HEAD では ignore されない項目は持ち込まない（0 件）" || ng "未コミット=$(field "$T/o10" code-review uncommitted)"
grep -q '^WARN: ignore されずに見えた' "$T/o10/status.txt" && ok "外したことを WARN で残す" || ng "WARN なし"
git checkout -q -- .gitignore; rm -rf extra

echo "11. 初期化済みの submodule があれば隔離しない（空の submodule で検証させない）"
G init -q --bare -b main "$T/sub.git"; G clone -q "$T/sub.git" "$T/subsrc" 2>/dev/null
( cd "$T/subsrc" && echo s > s.txt && G add -A && G commit -qm s && P origin HEAD:main )
if G -c protocol.file.allow=always submodule add -q "$T/sub.git" vendor/sub >/dev/null 2>&1 && G commit -qm sub; then
  [ -f .gitmodules ] && git submodule status | grep -q '^[^-]' || ng "準備: submodule が初期化されていない"
run --out "$T/o11"
[ "$(field "$T/o11" code-review cwd)" = "$(pwd -P)" ] && ok "元の作業ツリーで動く" || ng "隔離してしまった"
grep -q '^WARN: 初期化済みの submodule' "$T/o11/status.txt" && ok "WARN で残す" || ng "WARN なし"
G reset -q --hard HEAD~1; rm -rf vendor .gitmodules; git config --remove-section submodule.vendor/sub 2>/dev/null; rm -rf .git/modules
else
  ng "準備: submodule を追加できない"
fi

echo "12. record-gate.sh の照合"
HEADSHA="$(git rev-parse --short HEAD)"
run --out "$T/o12"
(bash "$RG" --verdict pass --escalate false --escalation-done false --report "$T/o12/report.md" >/dev/null 2>&1) && ok "HEAD が同じなら記録できる" || ng "同じ HEAD で拒まれた"
G commit -q --allow-empty -m "レビュー後に積まれたコミット"
(bash "$RG" --verdict pass --escalate false --escalation-done false --report "$T/o12/report.md" >/dev/null 2>&1) && ng "未レビューのコミットに pass を記録できてしまう" || ok "レビュー後に HEAD が動いたら記録を拒む"
mkdir -p "$T/o12b"
(bash "$RG" --verdict pass --escalate false --escalation-done false --report "$T/o12b/report.md" >/dev/null 2>&1) && ng "reviewed_sha が無くても記録できてしまう" || ok "reviewed_sha が無ければ記録を拒む"
(bash "$RG" --verdict pass --escalate false --escalation-done false >/dev/null 2>&1) && ng "--report も --no-diff も無しで記録できてしまう" || ok "--report も --no-diff も無ければ拒む"
(bash "$RG" --verdict pass --escalate false --escalation-done false --no-diff >/dev/null 2>&1) && ng "差分があるのに --no-diff で記録できてしまう" || ok "差分があれば --no-diff を拒む"
G checkout -q --detach origin/main
(bash "$RG" --verdict pass --escalate false --escalation-done false --no-diff >/dev/null 2>&1) && ok "本当に差分が無ければ --no-diff で記録できる" || ng "差分なしなのに --no-diff が拒まれた"
G checkout -q -

echo "== PASS $pass / FAIL $fail =="
[ $fail -eq 0 ]
