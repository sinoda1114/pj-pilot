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
! grep -q '".tmp"' "$RR" && { grep -q 'mkstemp' "$RR" || grep -q 'gate.py" merge-secrets' "$RR"; } && grep -q 'mkstemp' "$GP" && ok "run-reviews.sh の一時ファイルは mkstemp で作る（gate.py の書き換えを含む）" || ng "予測できる .tmp が残っている"

echo "5. 記録の置き場所（.git の中）"
rec_json(){ printf '{"version": 3, "head_sha": "%s", "branch": "main", "mode": "branch", "verdict": "pass", "scope": "full", "full_count": 1, "escalate": false, "escalation_done": false, "skipped_by_user": false}\n' "$1"; }
mkrepo "$T/r11"; h11="$(git -C "$T/r11" rev-parse HEAD)"
mkdir -p "$T/r11/.review-reports"; rec_json "$h11" > "$T/r11/.review-reports/latest.json"   # 作業ツリーにだけある記録（チェックアウトや reset で作れる）
(cd "$T/r11" && printf 'refs/heads/main %s refs/heads/main %s\n' "$h11" $zero | bash "$HOOK" origin x > "$T/r11.out" 2>&1); rc=$?
[ $rc -ne 0 ] && grep -q '置き場所' "$T/r11.out" && ok "作業ツリーにだけある記録では通さず、置き場所が変わったと知らせる" || ng "rc=$rc $(head -1 "$T/r11.out")"
gd11="$(git -C "$T/r11" rev-parse --absolute-git-dir)"; mkdir -p "$gd11/ai-review"; rec_json "$h11" > "$gd11/ai-review/latest.json"
(cd "$T/r11" && printf 'refs/heads/main %s refs/heads/main %s\n' "$h11" $zero | bash "$HOOK" origin x > "$T/r11b.out" 2>&1); rc=$?
[ $rc -eq 0 ] && ok ".git の中の記録で通す" || ng "rc=$rc $(head -2 "$T/r11b.out")"
( . "$here/reports-guard.sh"; [ "$(record_file "$T/r11")" = "$gd11/ai-review/latest.json" ] ) && ok "record_file は作業ツリーごとの .git の中を指す" || ng "record_file"

# 古い版のフック（記録を作業ツリーから読む）があれば、置き換えを知らせる。古い場所に写しは置かず、残った記録は消す
# （写しを置くと、作業ツリーに仕込んだ偽の記録で古いフックを通せる抜け道が残る）
OLDHOOK='#!/usr/bin/env bash\n# ai-review-managed-hook\nf=".review-reports/latest.json"\n'
oldrec(){ mkdir -p "$T/r12/.review-reports"; rec_json x > "$T/r12/.review-reports/latest.json"; }
warn12(){ ( cd "$T/r12" && . "$here/reports-guard.sh"; warn_old_hook ) 2> "$1"; }
mkrepo "$T/r12"; mkdir -p "$T/r12hooks"
printf '%b' "$OLDHOOK" > "$T/r12hooks/pre-push"; chmod +x "$T/r12hooks/pre-push"
git -C "$T/r12" config core.hooksPath "$T/r12hooks"
oldrec; warn12 "$T/r12.err"
[ ! -e "$T/r12/.review-reports/latest.json" ] && grep -q '正しく働きません' "$T/r12.err" && grep -q '置き換えて' "$T/r12.err" && ! grep -q '消すか' "$T/r12.err" && ok "効いているフックが古い版なら、置き換えを知らせ（削除は勧めない）、古い場所の記録を消す" || ng "効いているフック: $(cat "$T/r12.err")"
# 新しい版のフックだけなら何も言わない。古い場所に残った記録は、それでも消す
cp "$HOOK" "$T/r12hooks/pre-push"; oldrec; warn12 "$T/r12b.err"
[ ! -e "$T/r12/.review-reports/latest.json" ] && [ ! -s "$T/r12b.err" ] && ok "新しい版のフックなら何も言わず、古い場所の記録は消す" || ng "新しい版: $(cat "$T/r12b.err")"
# リポジトリのフック（.git/hooks/pre-push）が古い版でも知らせる（呼び継ぐ仕組みは新しいフックとは限らない）
printf '%b' "$OLDHOOK" > "$T/r12/.git/hooks/pre-push"; chmod +x "$T/r12/.git/hooks/pre-push"
mkdir -p "$T/r12other"; printf '#!/bin/sh\nexit 0\n' > "$T/r12other/pre-push"; chmod +x "$T/r12other/pre-push"
git -C "$T/r12" config core.hooksPath "$T/r12other"; warn12 "$T/r12c.err"
grep -q '正しく働きません' "$T/r12c.err" && ok "効いているフックが別物でも、リポジトリのフックの古い版を知らせる" || ng "リポジトリのフック: $(cat "$T/r12c.err")"
# 実行権が無くても知らせる（後で実行権を付けると、古いフックのまま効きはじめる）
chmod -x "$T/r12/.git/hooks/pre-push"; warn12 "$T/r12d.err"
grep -q '正しく働きません' "$T/r12d.err" && ok "実行権の無い古いフックも知らせる" || ng "実行権なし: $(cat "$T/r12d.err")"
rm -f "$T/r12/.git/hooks/pre-push"; git -C "$T/r12" config core.hooksPath "$T/r12hooks"
# 古い場所の記録を消せなければ、黙らずに知らせる
mkdir -p "$T/r12/.review-reports/latest.json"   # ディレクトリは rm -f で消えない（root でも同じ）
warn12 "$T/r12e.err"
grep -q '消せませんでした' "$T/r12e.err" && ok "古い場所の記録を消せなければ知らせる" || ng "消せなかったのに黙った: $(cat "$T/r12e.err")"
rm -rf "$T/r12/.review-reports"
# .review-reports がシンボリックリンクなら、リンク先の記録を消さない
mkdir -p "$T/r12link"; rec_json x > "$T/r12link/latest.json"; ln -s "$T/r12link" "$T/r12/.review-reports"
warn12 /dev/null
[ -f "$T/r12link/latest.json" ] && ok ".review-reports がリンクなら、リンク先を消さない" || ng "リンク先の記録を消した"
rm -f "$T/r12/.review-reports"
# 書き手は古い場所に写しを置かない
grep -q 'record_compat_copy' "$here/record-gate.sh" "$here/resolve-item.sh" "$here/reports-guard.sh"; [ $? -eq 1 ] && ok "互換の写しの仕組みが残っていない" || ng "record_compat_copy が残っている"
grep -q '# ai-review-record: git-dir' "$HOOK" && ok "フックに版の目印がある" || ng "フックに版の目印が無い"
! grep -q 'tmp="\$f.tmp.\$\$"' "$here/resolve-item.sh" && ok "resolve-item.sh の一時ファイルは mktemp で作る" || ng "予測できる一時ファイル名が残っている"

echo "13. UTF-8 のロケールで、全角文字の直前の変数を変数名の一部として読まない"
# bash は UTF-8 のロケールで `$f（` の全角文字のバイトまで変数名として読み、set -u の下で落ちる
bad="$(LC_ALL=C grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^ -~]' "$here"/*.sh "$HOOK" | grep -vE ':[0-9]+:[[:space:]]*#')"
[ -z "$bad" ] && ok "スクリプトに、全角文字の直前の裸の \$変数が無い" || ng "全角文字の直前の裸の \$変数: $bad"
# 入っている UTF-8 のロケールを使う（入っていない名前を渡すと bash は警告して続け、検査が素通りになるため）
u8=""
for l in ja_JP.UTF-8 en_US.UTF-8 C.UTF-8 C.utf8 en_US.utf8; do
  locale -a 2>/dev/null | grep -qixF "$l" && { u8="$l"; break; }
done
if [ -z "$u8" ]; then
  echo "  SKIP UTF-8 のロケールが入っていないため、resolve-item.sh の実行の検査を飛ばす（静的検査は上で実施）"
else
  mkdir -p "$T/r13" && G -C "$T/r13" init -q && G -C "$T/r13" commit -q --allow-empty -m init
  out="$(cd "$T/r13" && LC_ALL="$u8" bash "$here/resolve-item.sh" --id R1 --fixed --note x 2>&1)"
  printf '%s' "$out" | grep -q '記録（.*）がありません' && ! printf '%s' "$out" | grep -qE '未割り当て|unbound' \
    && ok "記録が無いとき、resolve-item.sh は UTF-8 のロケール（${u8}）でも理由を出して止まる" || ng "resolve-item.sh（${u8}）: $out"
fi

echo "14. Issue #9 の残り"
# 索引を読めないときは、コミットのツリーではなく索引を読めないと知らせる
mkrepo "$T/r14"; printf 'garbage' > "$T/r14/.git/index"
( . "$here/reports-guard.sh"; reports_untrusted "$T/r14" && reports_untrusted_message ) 2> "$T/r14.err"
grep -q '索引' "$T/r14.err" && ! grep -q 'コミットのツリーを読めません' "$T/r14.err" && ok "索引を読めないときは索引を読めないと知らせる" || ng "索引: $(cat "$T/r14.err")"
# --path-format の無い古い git（2.31 より前）でも、壊れた HEAD の ref を「生まれる前のブランチ」と取り違えない
mkdir -p "$T/oldgit"; realgit="$(command -v git)"
printf '#!/bin/sh\nfor a in "$@"; do case "$a" in --path-format*) echo "fatal: unknown option $a" >&2; exit 129 ;; esac; done\nexec "%s" "$@"\n' "$realgit" > "$T/oldgit/git"; chmod +x "$T/oldgit/git"
! grep -q -e '--path-format' "$here/reports-guard.sh" "$here/../hooks/pre-push" && ok "reports-guard.sh と pre-push は --path-format を使わない" || ng "--path-format が残っている: $(grep -n -e '--path-format' "$here/reports-guard.sh" "$here/../hooks/pre-push")"
# 古い git でも、リポジトリのフック（.git/hooks/pre-push）の古い版を見つける
mkrepo "$T/r14c"; printf '%b' "$OLDHOOK" > "$T/r14c/.git/hooks/pre-push"; chmod +x "$T/r14c/.git/hooks/pre-push"
( cd "$T/r14c" && PATH="$T/oldgit:$PATH" GIT_CONFIG_GLOBAL="$T/r12empty"; export PATH GIT_CONFIG_GLOBAL; . "$here/reports-guard.sh"; warn_old_hook ) 2> "$T/r14c.err"
grep -q '正しく働きません' "$T/r14c.err" && ok "古い git でも、リポジトリのフックの古い版を見つける" || ng "古い git: $(cat "$T/r14c.err")"
# 効いているフックの置き場所は 1 つの関数（hooks_dir）で決める。相対パスはルートから、~/ は HOME から
mkrepo "$T/r14d"; git -C "$T/r14d" config core.hooksPath hk
( cd "$T/r14d" && . "$here/reports-guard.sh"; d="$(hooks_dir)"; [ "$d" -ef "$T/r14d/hk" ] || [ "$d" = "$T/r14d/hk" ] || [ "$d" = "$(cd "$T/r14d" && pwd -P)/hk" ] ) && ok "hooks_dir は相対パスをルートから解く" || ng "hooks_dir（相対）: $(cd "$T/r14d" && . "$here/reports-guard.sh"; hooks_dir)"
git -C "$T/r14d" config core.hooksPath '~/hk'
( cd "$T/r14d" && . "$here/reports-guard.sh"; [ "$(hooks_dir)" = "$HOME/hk" ] ) && ok "hooks_dir は ~/ を HOME から解く" || ng "hooks_dir（~）"
! grep -q 'git config --get core.hooksPath' "$here/record-gate.sh" && grep -q 'hooks_dir' "$here/record-gate.sh" && ok "record-gate.sh も hooks_dir を使う" || ng "record-gate.sh が自前で置き場所を探している"
# コミット 1 つにつき ls-tree -r は 1 回だけ
mkdir -p "$T/countgit"; printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = ls-tree ] && echo x >> "%s/lstree.count"; done\nexec "%s" "$@"\n' "$T" "$realgit" > "$T/countgit/git"; chmod +x "$T/countgit/git"
mkrepo "$T/r14e"; rm -f "$T/lstree.count"
( PATH="$T/countgit:$PATH"; . "$here/reports-guard.sh"; reports_untrusted "$T/r14e" HEAD ) >/dev/null 2>&1
[ "$(wc -l < "$T/lstree.count" 2>/dev/null | tr -d ' ')" = "1" ] && ok "コミット 1 つにつき ls-tree は 1 回" || ng "ls-tree の回数: $(wc -l < "$T/lstree.count" 2>/dev/null)"
# 作業ツリーが分からず bare でもないときは、ゲートを飛ばさずに止める（bare なら呼び継ぐ）
mkrepo "$T/r14f"; h14f="$(git -C "$T/r14f" rev-parse HEAD)"
(cd "$T/r14f/.git" && printf 'refs/heads/main %s refs/heads/main %s\n' "$h14f" $zero | bash "$HOOK" origin x > "$T/r14f.out" 2>&1); rc=$?
[ $rc -ne 0 ] && ok "作業ツリーが分からず bare でもなければ止める" || ng "作業ツリー不明で通した: $(head -2 "$T/r14f.out")"
git clone -q --bare "$T/r14f" "$T/r14g.git"
(cd "$T/r14g.git" && printf 'refs/heads/main %s refs/heads/main %s\n' "$h14f" $zero | bash "$HOOK" origin x > "$T/r14g.out" 2>&1); rc=$?
[ $rc -eq 0 ] && ok "bare リポジトリなら通す（呼び継ぐ）" || ng "bare で止めた: $(head -2 "$T/r14g.out")"
# escalation.json の書き換えに失敗しても、一時ファイルを残さない
mkdir -p "$T/r14h"; echo '{"escalate": false, "secret_paths": []}' > "$T/r14h/escalation.json"; echo '{"secret_paths": [".env"]}' > "$T/r14h/full.json"
out="$(cd "$T" && python3 -I - "$here" "$T/r14h" 2>&1 <<'PY'
import sys, pathlib
sys.path.insert(0, sys.argv[1])
import gate
def boom(self, *a, **k):
    raise OSError("disk full")
pathlib.Path.write_text = boom
try:
    gate.merge_secret_paths(sys.argv[2] + "/escalation.json", sys.argv[2] + "/full.json")
except OSError:
    pass
PY
)"
[ "$(ls "$T/r14h" | wc -l | tr -d ' ')" = "2" ] && ok "escalation.json の書き換えに失敗しても一時ファイルを残さない" || ng "一時ファイルが残った: $(ls "$T/r14h") $out"
python3 -I - "$here" "$T/r14h" >/dev/null 2>&1 <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import gate
gate.merge_secret_paths(sys.argv[2] + "/escalation.json", None)
PY
grep -q '"secret_paths": "?"' "$T/r14h/escalation.json" && ok "全体の判定が無いときは secret_paths を ? にする" || ng "secret_paths: $(cat "$T/r14h/escalation.json")"
# 全体の判定が読めなければ、黙って足さずに失敗する（呼び出し元が ? に倒して Codex を止める）
echo '{"escalate": false, "secret_paths": []}' > "$T/r14h/escalation.json"; printf 'broken' > "$T/r14h/full.json"
python3 -I "$GP" merge-secrets --esc "$T/r14h/escalation.json" --full "$T/r14h/full.json" >/dev/null 2>&1; rc=$?
[ $rc -ne 0 ] && grep -q '"secret_paths": \[\]' "$T/r14h/escalation.json" && ok "全体の判定が読めなければ失敗し、escalation.json を変えない" || ng "壊れた全体の判定: rc=$rc $(cat "$T/r14h/escalation.json")"
# force-escalation は escalate を真にし、理由を足す
echo '{"force_escalation": true, "force_reason": "size"}' > "$T/r14h/scope.json"
python3 -I "$GP" force-escalation --scope "$T/r14h/scope.json" --esc "$T/r14h/escalation.json" && grep -q '"escalate": true' "$T/r14h/escalation.json" && grep -q 'F:size' "$T/r14h/escalation.json" && [ "$(ls "$T/r14h" | wc -l | tr -d ' ')" = "3" ] && ok "force-escalation は escalate を真にして理由を足す（一時ファイルを残さない）" || ng "force-escalation: $(cat "$T/r14h/escalation.json"; ls "$T/r14h")"
# record-gate.sh を通しで動かす: 古いフックが入っていれば知らせ、作業ツリーの偽の記録を消すので、古いフックのままでは push が止まる
mkrepo "$T/r14o"; git clone -q --bare "$T/r14o" "$T/r14o.git"; git clone -q "$T/r14o.git" "$T/r14p"
git -C "$T/r14p" remote set-head origin -a >/dev/null 2>&1
mkdir -p "$T/r14phooks"
# 古いフックの最初の検査（記録が無ければ止める）だけを写したもの
printf '#!/usr/bin/env bash\n# ai-review-managed-hook\nf=".review-reports/latest.json"\n[ -f "$f" ] || exit 1\nexit 0\n' > "$T/r14phooks/pre-push"; chmod +x "$T/r14phooks/pre-push"
git -C "$T/r14p" config core.hooksPath "$T/r14phooks"
mkdir -p "$T/r14p/.review-reports"; rec_json "$(git -C "$T/r14p" rev-parse HEAD)" > "$T/r14p/.review-reports/latest.json"   # 仕込まれた偽の記録
(cd "$T/r14p" && GIT_CONFIG_GLOBAL="$T/r12empty" bash "$here/record-gate.sh" --verdict pass --escalate false --escalation-done false --no-diff --reason "差分なし" > "$T/r14p.out" 2>&1); rc=$?
(cd "$T/r14p" && bash "$T/r14phooks/pre-push" origin x < /dev/null); hrc=$?
[ $rc -eq 0 ] && grep -q '正しく働きません' "$T/r14p.out" && [ ! -e "$T/r14p/.review-reports/latest.json" ] && [ -f "$(git -C "$T/r14p" rev-parse --absolute-git-dir)/ai-review/latest.json" ] && [ $hrc -ne 0 ] \
  && ok "record-gate.sh は古いフックを知らせ、偽の記録を消し、古いフックのままでは push が止まる" || ng "通し: rc=$rc hook=$hrc $(tail -3 "$T/r14p.out")"
# 初回コミットの前（生まれる前のブランチ）は、ツリーを読めないとは扱わない（--local のレビューを止めない）
mkdir -p "$T/r14q" && git -C "$T/r14q" init -q -b main
( . "$here/reports-guard.sh"; ! reports_untrusted "$T/r14q" HEAD ) && ok "初回コミットの前のリポジトリは信用する（ツリーを読めないと扱わない）" || ng "初回コミットの前を止めた: $( . "$here/reports-guard.sh"; reports_untrusted "$T/r14q" HEAD; echo "$REPORTS_WHY")"
# --type=path の無い古い git（2.18 より前）でも、core.hooksPath を読む
mkdir -p "$T/oldgit2"
printf '#!/bin/sh\nfor a in "$@"; do case "$a" in --type*) echo "error: unknown option $a" >&2; exit 129 ;; esac; done\nexec "%s" "$@"\n' "$realgit" > "$T/oldgit2/git"; chmod +x "$T/oldgit2/git"
mkrepo "$T/r14r"; git -C "$T/r14r" config core.hooksPath "$T/r14rhooks"
( cd "$T/r14r" && PATH="$T/oldgit2:$PATH"; . "$here/reports-guard.sh"; [ "$(hooks_dir)" = "$T/r14rhooks" ] ) && ok "--type=path が無い git でも core.hooksPath を読む" || ng "古い git の hooks_dir: $(cd "$T/r14r" && PATH="$T/oldgit2:$PATH"; . "$here/reports-guard.sh"; hooks_dir)"
echo "15. Issue #16"
# Git for Windows が返す C:/ 形式の絶対パスを、相対パスと取り違えない
mkdir -p "$T/wingit"; realgit16="$(command -v git)"
printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = --git-common-dir ] && { echo "C:/repo/.git"; exit 0; }; done\nexec "%s" "$@"\n' "$realgit16" > "$T/wingit/git"; chmod +x "$T/wingit/git"; printf '#!/bin/sh\necho MINGW64_NT-10.0\n' > "$T/wingit/uname"; chmod +x "$T/wingit/uname"   # Git for Windows の環境のふり
mkrepo "$T/r16a"
( PATH="$T/wingit:$PATH"; . "$here/reports-guard.sh"; [ "$(abs_git_path "$T/r16a" --git-common-dir)" = "C:/repo/.git" ] ) && ok "C:/ 形式のパスは絶対パスとして扱う" || ng "C:/ を相対パスと取り違えた: $(PATH="$T/wingit:$PATH"; . "$here/reports-guard.sh"; abs_git_path "$T/r16a" --git-common-dir)"
# 予測できる名前の一時ファイル（$$ や固定の名前に書いてから mv する）を見つける検査。悪い例を見つけられることも確かめる
tmp_ok(){ [ -f "$1" ] || return 1; ! grep -nE '(\.tmp(\.\$\$)?"?[[:space:]]*$|\.tmp\.\$\$|tmp="[^"$]*\.tmp"|>[[:space:]]*"[^"]*\.tmp")' "$1" | grep -v '^[0-9]*:[[:space:]]*#' | grep -q .; }
printf 'x=1 > "$out/escalation.json.tmp"\n' > "$T/bad1.sh"; printf 'tmp="$f.tmp.$$"\n' > "$T/bad2.sh"
! tmp_ok "$T/bad1.sh" && ! tmp_ok "$T/bad2.sh" && ok "一時ファイルの検査は、予測できる名前の悪い例を見つける" || ng "検査が悪い例を見落とした"
tmp_ok "$RR" && tmp_ok "$here/record-gate.sh" && tmp_ok "$here/resolve-item.sh" && ok "run-reviews.sh・record-gate.sh・resolve-item.sh に予測できる名前の一時ファイルが無い" || ng "予測できる一時ファイル: $(grep -nE '\.tmp' "$RR" "$here/record-gate.sh" "$here/resolve-item.sh" | head -3)"
# pre-push は作業ツリーのルートに移れなければ止める（動かして確かめる）
mkdir -p "$T/gonegit"
printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = --show-toplevel ] && { echo "%s/no-such-dir"; exit 0; }; done\nexec "%s" "$@"\n' "$T" "$realgit16" > "$T/gonegit/git"; chmod +x "$T/gonegit/git"
mkrepo "$T/r16b"; h16b="$(git -C "$T/r16b" rev-parse HEAD)"
(cd "$T/r16b" && printf 'refs/heads/main %s refs/heads/main %s\n' "$h16b" $zero | PATH="$T/gonegit:$PATH" bash "$HOOK" origin x > "$T/r16b.out" 2>&1); rc=$?
[ $rc -ne 0 ] && grep -q '移れません' "$T/r16b.out" && ok "pre-push はルートに移れなければ止める（動かして確かめる）" || ng "ルートに移れないのに: rc=$rc $(head -2 "$T/r16b.out")"
# hooks_dir も C:/ 形式の core.hooksPath を絶対パスとして扱う
mkdir -p "$T/wingit2"
printf '#!/bin/sh\ncase " $* " in *" config "*hooksPath*) echo "C:/Users/u/.git-hooks"; exit 0 ;; esac\nexec "%s" "$@"\n' "$realgit16" > "$T/wingit2/git"; chmod +x "$T/wingit2/git"; printf '#!/bin/sh\necho MINGW64_NT-10.0\n' > "$T/wingit2/uname"; chmod +x "$T/wingit2/uname"   # Git for Windows の環境のふり
( cd "$T/r16a" && PATH="$T/wingit2:$PATH"; . "$here/reports-guard.sh"; [ "$(hooks_dir)" = "C:/Users/u/.git-hooks" ] ) && ok "hooks_dir も C:/ 形式を絶対パスとして扱う" || ng "hooks_dir が C:/ を相対パスと取り違えた: $(cd "$T/r16a" && PATH="$T/wingit2:$PATH"; . "$here/reports-guard.sh"; hooks_dir)"
# 一時ファイルの検査は、対象のファイルが無ければ通さない
! tmp_ok "$T/no-such-file.sh" && ok "一時ファイルの検査は、対象のファイルが無ければ通さない" || ng "無いファイルを通した"
# バックスラッシュ形式（C:\...）と UNC（\\server\...）も Windows の絶対パスとして扱い、区切りを / にそろえる
mkdir -p "$T/wingit3"
printf '#!/bin/sh\ncase " $* " in *" config "*hooksPath*) printf "%%s\\n" "C:\\\\Users\\\\u\\\\hooks"; exit 0 ;; esac\nexec "%s" "$@"\n' "$realgit16" > "$T/wingit3/git"; chmod +x "$T/wingit3/git"; printf '#!/bin/sh\necho MINGW64_NT-10.0\n' > "$T/wingit3/uname"; chmod +x "$T/wingit3/uname"   # Git for Windows の環境のふり
( cd "$T/r16a" && PATH="$T/wingit3:$PATH"; . "$here/reports-guard.sh"; [ "$(hooks_dir)" = "C:/Users/u/hooks" ] ) && ok "hooks_dir は C:\\ 形式も絶対パスとして扱う" || ng "C:\\ 形式: $(cd "$T/r16a" && PATH="$T/wingit3:$PATH"; . "$here/reports-guard.sh"; hooks_dir)"
mkdir -p "$T/wingit4"
printf '#!/bin/sh\ncase " $* " in *" config "*hooksPath*) printf "%%s\\n" "\\\\\\\\srv\\\\share\\\\hooks"; exit 0 ;; esac\nexec "%s" "$@"\n' "$realgit16" > "$T/wingit4/git"; chmod +x "$T/wingit4/git"; printf '#!/bin/sh\necho MINGW64_NT-10.0\n' > "$T/wingit4/uname"; chmod +x "$T/wingit4/uname"   # Git for Windows の環境のふり
( cd "$T/r16a" && PATH="$T/wingit4:$PATH"; . "$here/reports-guard.sh"; [ "$(hooks_dir)" = "//srv/share/hooks" ] ) && ok "hooks_dir は UNC 形式も絶対パスとして扱う" || ng "UNC 形式: $(cd "$T/r16a" && PATH="$T/wingit4:$PATH"; . "$here/reports-guard.sh"; hooks_dir)"
# 一時ファイルを作れないときは、escalation-check.sh の失敗と取り違えない文言で記録する
grep -q '一時ファイルを作れない' "$RR" && ok "一時ファイルを作れないときは、その旨を記録する" || ng "一時ファイルを作れないときの記録が無い"
# Windows でない環境では、C:/ の形は（c: という名前のディレクトリの下の）相対パスのまま扱う
mkdir -p "$T/winpath-only"; printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = --git-common-dir ] && { echo "C:/repo/.git"; exit 0; }; done\nexec "%s" "$@"\n' "$realgit16" > "$T/winpath-only/git"; chmod +x "$T/winpath-only/git"; printf '#!/bin/sh\necho Linux\n' > "$T/winpath-only/uname"; chmod +x "$T/winpath-only/uname"   # Windows でない環境のふり（Windows の上でも同じ結果になる）
( PATH="$T/winpath-only:$PATH"; . "$here/reports-guard.sh"; [ "$(abs_git_path "$T/r16a" --git-common-dir)" != "C:/repo/.git" ] ) && ok "Windows でなければ C:/ の形を絶対パスとみなさない" || ng "Windows でないのに C:/ を絶対パスとみなした"
echo "== PASS $pass / FAIL $fail =="
[ $fail -eq 0 ]
