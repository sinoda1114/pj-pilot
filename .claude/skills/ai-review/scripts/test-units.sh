#!/usr/bin/env bash
# /ai-review の小さな回帰テスト（gate.py・pre-push・run-reviews.sh の端のケース）。
# test-gate.sh より狭く速い（数秒）。実モデルは呼ばない。
#   使い方: scripts/test-units.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
GP="$here/gate.py"; HOOK="$here/../hooks/pre-push"; RR="$here/run-reviews.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/units-test.XXXXXX")" && [ -n "$T" ] && [ -d "$T" ] || { echo "mktemp 失敗" >&2; exit 2; }
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok(){ echo "  PASS $1"; pass=$((pass+1)); }
ng(){ echo "  FAIL $1"; fail=$((fail+1)); }
G(){ git -c user.email=t@t -c user.name=t "$@"; }

echo "1. gate.py"
# git が見つからなくても、is_ancestor は例外で落ちずに False を返す
out="$(cd "$T" && python3 -I - "$here" <<'PY' 2>&1
import sys, subprocess
sys.path.insert(0, sys.argv[1])
import gate
def boom(*a, **k):
    raise FileNotFoundError("git")
subprocess.run = boom
print(gate.is_ancestor("a" * 40, "HEAD"))
PY
)"
[ "$out" = "False" ] && ok "git が無くても is_ancestor は False を返す" || ng "is_ancestor が落ちた: $out"

# 差分レビューで全体レビューが足りないときも、未処理の項目を一緒に出す
cat > "$T/latest.json" <<'JSON'
{"version": 3, "head_sha": "h", "mode": "branch", "verdict": "must-address", "scope": "incremental", "full_count": 1,
 "must_address": [{"id": "R1", "tier": "MUST-ADDRESS", "file": "a.py", "line": 3, "status": "open"}]}
JSON
out="$(python3 "$GP" check --latest "$T/latest.json" --head h 2>&1)"; rc=$?
if [ $rc -eq 1 ] && printf '%s' "$out" | grep -q '全体レビュー' && printf '%s' "$out" | grep -q 'R1'; then
  ok "差分レビューの不足と、未処理の項目を両方出す"
else
  ng "check の出力: rc=$rc $out"
fi

# 項目が壊れていても（dict でない）、表示で落ちない
cat > "$T/latest2.json" <<'JSON'
{"version": 3, "head_sha": "h", "mode": "branch", "verdict": "must-address", "scope": "incremental", "full_count": 1,
 "must_address": ["壊れた項目"]}
JSON
out="$(python3 "$GP" check --latest "$T/latest2.json" --head h 2>&1)"; rc=$?
[ $rc -eq 1 ] && ! printf '%s' "$out" | grep -q Traceback && ok "壊れた項目でも check は落ちずに止める" || ng "check: rc=$rc $(printf '%s' "$out" | tail -2)"

echo "2. run-reviews.sh"
# escalation.json の書き換えは、一時ファイルに書いてから置き換える（途中で失敗しても中途半端なファイルを残さない）
n="$(grep -c 'json.dump(d, open(' "$RR")"
[ "$n" = "0" ] && ok "escalation.json を開いたまま json.dump しない" || ng "json.dump(d, open(...)) が ${n} か所に残っている"

echo "3. pre-push"
export GIT_CONFIG_GLOBAL="$T/gitconfig"; : > "$GIT_CONFIG_GLOBAL"   # この端末のグローバルの設定に左右されない
zero=0000000000000000000000000000000000000000
mkrepo(){  # <dir>: コミット 1 つと、呼び継がれたら印を残す .git/hooks/pre-push を持つリポジトリ
  G init -q -b main "$1" && (cd "$1" && echo a > a.txt && G add a.txt && G commit -qm a) || exit 2
  printf '#!/bin/sh\nwc -l < /dev/stdin | tr -d " " > "%s/chained"\n' "$1" > "$1/.git/hooks/pre-push"; chmod +x "$1/.git/hooks/pre-push"
}
# 入力が空のときも呼び継ぎ、空行を渡さない
mkrepo "$T/r1"
(cd "$T/r1" && printf '' | bash "$HOOK" origin x >/dev/null 2>&1)
[ "$(cat "$T/r1/chained" 2>/dev/null)" = "0" ] && ok "入力が空なら、呼び継いだフックに空行を渡さない" || ng "呼び継いだフックの入力の行数: $(cat "$T/r1/chained" 2>/dev/null)"
# bare リポジトリでも、リポジトリ自身の pre-push を呼び継ぐ
G init -q --bare "$T/bare.git"; printf '#!/bin/sh\necho called > "%s/bare-chained"\n' "$T" > "$T/bare.git/hooks/pre-push"; chmod +x "$T/bare.git/hooks/pre-push"
(cd "$T/bare.git" && printf '' | bash "$HOOK" origin x >/dev/null 2>&1)
[ -f "$T/bare-chained" ] && ok "bare リポジトリでも、リポジトリ自身の pre-push を呼び継ぐ" || ng "bare リポジトリで呼び継がなかった"
# シグナルで止まっても、一時ファイルを残さない
mkrepo "$T/r2"; mkdir -p "$T/tmp"
printf '#!/bin/sh\nsleep 2\n' > "$T/r2/.git/hooks/pre-push"
printf 'refs/heads/main %s refs/heads/main %s\n' "$(git -C "$T/r2" rev-parse HEAD)" $zero > "$T/r2.in"
(cd "$T/r2" && AI_REVIEW_BYPASS=1 TMPDIR="$T/tmp" exec bash "$HOOK" origin x < "$T/r2.in" >/dev/null 2>&1) &   # exec: PID をフック本体にする
hp=$!; sleep 1; kill -TERM $hp 2>/dev/null; wait $hp 2>/dev/null
[ -z "$(ls -A "$T/tmp")" ] && ok "シグナルで止まっても、一時ファイルを残さない" || ng "一時ファイルが残った: $(ls "$T/tmp")"
# 索引から外しても、push するコミットに .review-reports があれば信用しない
mkrepo "$T/r3"
(cd "$T/r3" && mkdir .review-reports && echo '{}' > .review-reports/latest.json && G add .review-reports && G commit -qm r && G rm -q --cached -r .review-reports)
(cd "$T/r3" && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" $zero | bash "$HOOK" origin x > "$T/r3.out" 2>&1); rc=$?
[ $rc -ne 0 ] && grep -q '追跡されています' "$T/r3.out" && ok "push するコミットに .review-reports があれば拒む" || ng "rc=$rc $(cat "$T/r3.out")"
# 3 つのスクリプトも、コミットのツリーまで見る
(cd "$T/r3" && bash "$here/resolve-item.sh" --list > "$T/r3-ri.out" 2>&1); rc=$?
[ $rc -ne 0 ] && grep -q '追跡されています' "$T/r3-ri.out" && ok "resolve-item.sh も、コミットのツリーの .review-reports を拒む" || ng "resolve-item.sh: rc=$rc $(head -2 "$T/r3-ri.out")"

echo "4. 強化（own-security の提案）"
# pre-push の写しと reports-guard.sh が食い違っていない（同じパターン・同じ手順）
gp="$(grep -o "pat='[^']*'" "$here/reports-guard.sh" | head -1)"; hp="$(grep -o "pat='[^']*'" "$HOOK" | head -1)"
if [ -n "$gp" ] && [ "$gp" = "$hp" ] && grep -q 'ls-tree -r -z --name-only' "$HOOK" && grep -q 'ls-tree -r -z --name-only' "$here/reports-guard.sh" \
   && grep -q 'reports_unreadable' "$HOOK" && grep -q 'reports_unreadable' "$here/reports-guard.sh"; then
  ok "pre-push の写しと reports-guard.sh の検査が一致する"
else
  ng "検査が食い違っている: guard=[$gp] hook=[$hp]"
fi
# コミットのツリーを読めなければ、信用できない側に倒す
mkrepo "$T/r4"; obj="$(git -C "$T/r4" rev-parse HEAD^{tree})"
rm -f "$T/r4/.git/objects/${obj:0:2}/${obj:2}"
( . "$here/reports-guard.sh"; reports_untrusted "$T/r4" ) && ok "コミットのツリーを読めなければ信用しない" || ng "読めないツリーを信用した"
# 読めないときは、追跡されているとは言わずに、読めないと言う
(cd "$T/r4" && bash "$here/resolve-item.sh" --list > "$T/r4-ri.out" 2>&1)
grep -q '読めません' "$T/r4-ri.out" && ! grep -q '追跡されています' "$T/r4-ri.out" && ok "ツリーを読めないときは、読めないと知らせる" || ng "文言: $(head -1 "$T/r4-ri.out")"
# HEAD はあるのにコミットを読めなければ、信用しない
mkrepo "$T/r5"; cm="$(git -C "$T/r5" rev-parse HEAD)"; rm -f "$T/r5/.git/objects/${cm:0:2}/${cm:2}"
( . "$here/reports-guard.sh"; reports_untrusted "$T/r5" ) && ok "HEAD のコミットを読めなければ信用しない" || ng "壊れた HEAD を信用した"
# ファイルシステムの上で同じディレクトリになる別名（大文字小文字だけ違うなど）も見落とさない
mkrepo "$T/r6"; mkdir "$T/r6/.Review-Reportx" 2>/dev/null
if [ -d "$T/r6/.REVIEW-REPORTS-CHECK" ] || { mkdir "$T/r6/.Case-Test" && [ -d "$T/r6/.case-test" ]; }; then
  # 大文字小文字を区別しないファイルシステム: 綴りの違う名前で追跡させ、検査の正規表現を通らない形にする
  (cd "$T/r6" && mkdir -p ".review-reportſ" 2>/dev/null; true)
  alias=""; for n in ".review-reportſ" ".REVIEW-REPORTS"; do [ -d "$T/r6/$n" ] || mkdir "$T/r6/$n" 2>/dev/null; [ "$T/r6/$n" -ef "$T/r6/.review-reports" ] && { alias="$n"; break; }; done
  if [ -n "$alias" ]; then
    echo '{}' > "$T/r6/$alias/latest.json"; (cd "$T/r6" && G add -- "$alias" && G commit -qm alias)
    ( . "$here/reports-guard.sh"; reports_untrusted "$T/r6" ) && ok "同じディレクトリになる別名（${alias}）で追跡されたものも信用しない" || ng "別名（${alias}）の追跡を信用した"
    (cd "$T/r6" && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" $zero | bash "$HOOK" origin x > "$T/r6.out" 2>&1); rc=$?
    [ $rc -ne 0 ] && grep -q '追跡されています' "$T/r6.out" && ok "pre-push も別名（${alias}）の追跡を拒む" || ng "pre-push: rc=$rc $(head -1 "$T/r6.out")"
  else ok "（このファイルシステムでは別名が作れないので省く）"; fi
else ok "（大文字小文字を区別するファイルシステムなので省く）"; fi
# HEAD の ref の中身が壊れていたら、「HEAD がまだ無い」と取り違えない
mkrepo "$T/r7"; echo "garbage" > "$T/r7/.git/refs/heads/main"
( . "$here/reports-guard.sh"; reports_untrusted "$T/r7" ) && ok "壊れた ref の HEAD は信用しない" || ng "壊れた ref を「まだ無い」と取り違えた"
# 生まれる前のブランチ（ほかのブランチにはコミットがある）は「読めない」ではなく、まだ無いと扱う
mkrepo "$T/r8"; G -C "$T/r8" switch -q --orphan fresh 2>/dev/null || G -C "$T/r8" checkout -q --orphan fresh
( . "$here/reports-guard.sh"; reports_unreadable "$T/r8" HEAD ) && ng "生まれる前のブランチを「読めない」とした" || ok "生まれる前のブランチは、読めないとは扱わない"
# ref が全部壊れていても（ほかの ref が無い）、まだ無いと取り違えない
mkrepo "$T/r9"; for r in "$T/r9/.git/refs/heads/"*; do echo garbage > "$r"; done; rm -f "$T/r9/.git/packed-refs"
( . "$here/reports-guard.sh"; reports_unreadable "$T/r9" HEAD ) && ok "ref が全部壊れていたら読めないと扱う" || ng "ref が全部壊れたのを、まだ無いと取り違えた"
# reports-guard.sh を読み込めなければ、検査を素通りせずに止まる
mkdir -p "$T/noguard"; cp "$here/resolve-item.sh" "$here/gate.py" "$T/noguard/"
(cd "$T/r3" && bash "$T/noguard/resolve-item.sh" --list > "$T/noguard.out" 2>&1); rc=$?
[ $rc -ne 0 ] && grep -q 'reports-guard.sh' "$T/noguard.out" && ok "reports-guard.sh が無ければ止まる" || ng "素通りした: rc=$rc $(head -1 "$T/noguard.out")"
# 不正な UTF-8 の名前があっても、言語設定のせいで検査を素通りしない
mkrepo "$T/r10"; bl="$(printf 'x' | git -C "$T/r10" hash-object -w --stdin)"
printf '100644 %s\t-\377\n100644 %s\t.review-reports/latest.json\n' "$bl" "$bl" | git -C "$T/r10" update-index --index-info
( export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; . "$here/reports-guard.sh"; reports_untrusted "$T/r10" ) && ok "不正なバイトの名前の後ろの .review-reports も見落とさない" || ng "言語設定で検査を素通りした"
(cd "$T/r10" && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" $zero | LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 bash "$HOOK" origin x > "$T/r10.out" 2>&1); rc=$?
[ $rc -ne 0 ] && grep -q '追跡されています' "$T/r10.out" && ok "pre-push も不正なバイトの名前で素通りしない" || ng "pre-push: rc=$rc $(head -1 "$T/r10.out")"
# 一時ファイルの名前は予測できない
! grep -q '".tmp"' "$RR" && grep -q 'mkstemp' "$RR" && ok "run-reviews.sh の一時ファイルは mkstemp で作る" || ng "予測できる .tmp が残っている"

echo "== PASS $pass / FAIL $fail =="
[ $fail -eq 0 ]
