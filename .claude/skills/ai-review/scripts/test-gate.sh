#!/usr/bin/env bash
# /ai-review v3 のゲート判定の回帰テスト（DESIGN-v3.md）。
# AI_REVIEW_DRY_RUN=1 とフィクスチャだけを使い、実モデルは呼ばない。十数秒で終わる。
#   使い方: scripts/test-gate.sh
# run-reviews.sh / record-gate.sh / resolve-item.sh / gate.py / hooks/pre-push を直したら通すこと。
set -u
here="$(cd "$(dirname "$0")" && pwd)"
RR="$here/run-reviews.sh"; RG="$here/record-gate.sh"; RI="$here/resolve-item.sh"; GP="$here/gate.py"
HOOK="$here/../hooks/pre-push"
for f in "$RR" "$RG" "$RI" "$GP" "$HOOK"; do [ -f "$f" ] || { echo "見つからない: $f" >&2; exit 2; }; done
T="$(mktemp -d "${TMPDIR:-/tmp}/gate-test.XXXXXX")" && [ -n "$T" ] && [ -d "$T" ] || { echo "mktemp 失敗" >&2; exit 2; }
trap '[ -n "${KEEP:-}" ] || rm -rf "$T"' EXIT
pass=0; fail=0
ok(){ echo "  PASS $1"; pass=$((pass+1)); }
ng(){ echo "  FAIL $1"; fail=$((fail+1)); }
G(){ git -c user.email=t@t -c user.name=t "$@"; }
die(){ echo "準備に失敗: $1" >&2; exit 2; }
P(){ G push -q --no-verify "$@" 2>/dev/null; }
unset AI_REVIEW_BYPASS AI_REVIEW_DRY_TABLE_MISSING AI_REVIEW_DRY_VERDICT AI_REVIEW_DRY_CODEX AI_REVIEW_DRY_EMPTY
export AI_REVIEW_DRY_SLEEP=0

G init -q --bare -b main "$T/origin.git" || die "bare リポジトリ"
G clone -q "$T/origin.git" "$T/repo" 2>/dev/null || die "clone"
cd "$T/repo" || die "cd"
echo base > a.txt; G add -A; G commit -qm base; P origin HEAD:main || die "push"
G fetch -q origin && G remote set-head origin main >/dev/null || die "origin/HEAD の設定"
G checkout -q -b feat
mkdir -p src/auth; echo 'x' > src/app.js; echo 'y' > src/auth/login.js; G add -A; G commit -qm change
run(){ AI_REVIEW_DRY_RUN=1 bash "$RR" "$@" >/dev/null 2>&1; }
# pre-push を今の HEAD の push として呼ぶ。終了コードを返す
hook(){ printf 'refs/heads/feat %s refs/heads/feat %s\n' "$(git rev-parse HEAD)" 0000000000000000000000000000000000000000 | AI_REVIEW_ALLOW_DRY=1 bash "$HOOK" origin "$T/origin.git" >"$T/hook.out" 2>&1; }
hook_nodry(){ printf 'refs/heads/feat %s refs/heads/feat %s\n' "$(git rev-parse HEAD)" 0000000000000000000000000000000000000000 | bash "$HOOK" origin "$T/origin.git" >"$T/hook.out" 2>&1; }
latest=".review-reports/latest.json"
# 制御端末なしで動かす（端末から test-gate.sh を回しても /dev/tty の入力待ちで止まらないように）
notty(){ python3 -c 'import subprocess,sys; sys.exit(subprocess.run(sys.argv[1:], stdin=subprocess.DEVNULL, start_new_session=True).returncode)' "$@"; }
# 疑似端末で 1 行を打ち込んでコマンドを動かす（人の承認のテスト用。macOS の script はパイプの入力を渡せない）
tty_run(){ python3 - "$@" <<'PY'
import os, pty, sys, time
line, cmd = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
time.sleep(0.5); os.write(fd, (line + "\n").encode())
while True:
    try:
        if not os.read(fd, 1024): break
    except OSError:
        break
_, st = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(st))
PY
}
jget(){ python3 -c 'import json,sys; d=json.load(open(sys.argv[1]));
for k in sys.argv[2].split("."):
    d = d[int(k)] if isinstance(d, list) else d.get(k)
print(json.dumps(d) if isinstance(d,(dict,list,bool)) or d is None else d)' "$latest" "$1"; }
# 項目のフィクスチャを書き、そのパスを返す。毎回別のファイルにする（同じファイルだと後の呼び出しが前の項目を
# 上書きする。$(...) の中で呼ぶのでカウンタは使えない）
items(){ local f; f="$(mktemp "$T/items.XXXXXX")" || exit 2; printf '%s' "$1" > "$f"; echo "$f"; }

echo "1. ダミー実行（AI_REVIEW_DRY_RUN=1）"
run --out .review-reports/r1; rc=$?
[ $rc -eq 0 ] && ok "通常モードが正常終了する" || ng "rc=$rc"
n="$(grep -c '^started ' .review-reports/r1/status.txt)"
[ "$n" = "2" ] && ok "通常は 2 本（own-review と codex-review）" || ng "起動数=$n"
grep -q -- '--model claude-opus-5-5 --effort high' .review-reports/r1/own-review.md && ok "own-review は claude-opus-5-5 / high" || ng "own-review のモデル"
grep -q -- '--permission-mode dontAsk ' .review-reports/r1/own-review.md && grep -q -- '--allowedTools Read,Grep,Glob,Bash(git diff:\*),' .review-reports/r1/own-review.md && ok "道具は読み取り + 読み取り系の git に絞り、それ以外は dontAsk で拒否" || ng "道具の制限"
grep -q 'Bash(git:\*)\|Bash(git grep' .review-reports/r1/own-review.md && ng "git 全体（または git grep）を許している" || ok "git 全体・git grep は許さない（git -c での任意実行を塞ぐ）"
grep -q -- "Bash(git \*--contents\*)" .review-reports/r1/own-review.md && ok "git blame --contents（リポジトリ外の読み取り）を拒む" || ng "--contents の拒否"
grep -q -- "--setting-sources  --safe-mode --strict-mcp-config" .review-reports/r1/own-review.md && ok "ユーザー・プロジェクトの設定（allow・フック・CLAUDE.md）と MCP を読ませない" || ng "設定の隔離"
grep -q -- "--disallowedTools .*Bash(git \*--output\*)" .review-reports/r1/own-review.md && ok "git の --output（ファイル書き込み）を位置に関係なく拒む" || ng "--output の拒否"
grep -q -- '-m gpt-6-sol -c model_reasoning_effort="high"' .review-reports/r1/codex-review.md && ok "codex-review は gpt-6-sol / high の純正 review（独自の指示なし）" || ng "codex のモデル"
grep -q -- 'exec review --base origin/main --skip-git-repo-check' .review-reports/r1/codex-review.md && ok "Codex に比較元を渡す" || ng "codex の比較元"
grep -q -- '-c notify=\[\] -c mcp_servers={}' .review-reports/r1/codex-review.md && ok "Codex のプロジェクト設定（notify・MCP）を打ち消す" || ng "codex の設定の打ち消し"
[ -f .review-reports/r1/code-review.md ] && ng "v2 の /code-review を起動した" || ok "ECC の /code-review を使わない"
grep -q '/code-review\|/security-review' .review-reports/r1/own-review.md && ng "スラッシュコマンドを渡した" || ok "スラッシュコマンドではなく本文を渡す"

echo "2. プロンプトの組み立て"
pr=.review-reports/r1/own-review.prompt.md
head -1 "$pr" | grep -q '^---$' && ng "frontmatter が残った" || ok "frontmatter を外す"
grep -q 'description:' "$pr" && ng "frontmatter の中身が残った" || ok "frontmatter の中身も残らない"
grep -q '\$ARGUMENTS' "$pr" && ng "\$ARGUMENTS が残った" || ok "\$ARGUMENTS を置き換える"
grep -qx '比較範囲: origin/main...HEAD の差分' "$pr" && ok "branch モードの対象行" || ng "対象行: $(sed -n 3p "$pr")"
grep -q '^#* 4.4 結論' "$pr" && ok "本文はそのまま（結論の節がある）" || ng "本文が欠けた"
echo z > c.txt
run --out .review-reports/r1l --local
grep -qx '対象: 未コミットの変更（ステージ済み・未ステージ・未追跡）' .review-reports/r1l/own-review.prompt.md && ok "--local の対象行" || ng "--local の対象行"
grep -q -- 'exec review --uncommitted' .review-reports/r1l/codex-review.md && ok "--local の Codex は --uncommitted" || ng "--local の codex"
grep -qx 'c.txt' .review-reports/r1l/changed-files.txt && ok "--local の変更ファイルに未追跡を含む" || ng "未追跡が一覧に無い"
: > empty.txt; printf '\n\n' > nl.txt
run --out .review-reports/r1e --local
grep -qx 'empty.txt' .review-reports/r1e/changed-files.txt && grep -qx 'nl.txt' .review-reports/r1e/changed-files.txt && ok "空・改行だけの未追跡ファイルも変更一覧に含める" || ng "空の未追跡が漏れる"
rm -f empty.txt nl.txt
rm -f c.txt

echo "3. --deep は 5 本を並列で起動する"
run --out .review-reports/r3 --deep; rc=$?
st=.review-reports/r3/status.txt
n="$(grep -c '^started ' "$st")"
[ "$n" = "5" ] && ok "5 本起動（rc=${rc}）" || ng "起動数=$n"
bad=""
for nm in own-review codex-review own-security own-review-fable codex-astra; do
  grep -q "^started $nm " "$st" && grep -q "^ok $nm " "$st" || bad="$bad $nm"
done
[ -z "$bad" ] && ok "5 本とも起動・完了（own-review / codex-review / own-security / own-review-fable / codex-astra）" || ng "起動・完了していない:$bad"
grep -q -- '--model claude-fable-5-1 --effort high' .review-reports/r3/own-review-fable.md && ok "2 人目の Claude は claude-fable-5-1 / high" || ng "fable のモデル"
grep -q -- '-m gpt-6-astra -c model_reasoning_effort="high"' .review-reports/r3/codex-astra.md && ok "2 人目の Codex は gpt-6-astra / high" || ng "astra のモデル"
grep -q '^# セキュリティの深掘りレビュー' .review-reports/r3/own-security.prompt.md && ok "own-security は深掘りのプロンプト" || ng "own-security のプロンプト"
[ -f .review-reports/r3/deep.flag ] && ok "deep の印を残す" || ng "deep.flag なし"
AI_REVIEW_DRY_RUN=1 bash "$RR" --out .review-reports/rx --deep --security >/dev/null 2>&1 && ng "--deep と --security を併用できた" || ok "--deep と --security は併用しない"
run --out .review-reports/r3n --deep --no-codex
echo s > .env.local; G add -A; G commit -qm secret
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_ESCALATION=real bash "$RR" --out .review-reports/r3sec >/dev/null 2>&1
grep -q '^started codex' .review-reports/r3sec/status.txt && ng "秘密情報を含む差分で Codex を起動した" || ok "escalation.json の secret_paths があれば Codex を起動しない"
mkdir -p .codex; echo 'model_provider = "x"' > .codex/config.toml; G add -A; G commit -qm codexcfg
AI_REVIEW_DRY_RUN=1 bash "$RR" --out .review-reports/r3cx >/dev/null 2>&1
grep -q '^started codex' .review-reports/r3cx/status.txt && ng "レビュー対象に .codex/ があるのに Codex を起動した" || ok "レビュー対象の木に .codex/ があれば Codex を起動しない"
grep -q '^UNAVAILABLE codex-review' .review-reports/r3cx/status.txt && ok "設定を理由に止めた Codex は UNAVAILABLE（未取得）として残す" || ng "止めた Codex が未取得にならない"
( cd src && AI_REVIEW_DRY_RUN=1 bash "$RR" --out ../.review-reports/r3cs >/dev/null 2>&1 )
grep -q '^started codex' .review-reports/r3cs/status.txt && ng "サブディレクトリから起動すると直下の .codex/ を見逃した" || ok "サブディレクトリから起動しても、木の直下の .codex/ を検出する"

G rm -rq .codex; G commit -qm uncodex
mkdir -p src/deep/.codex src/deep/x; echo 'model_provider = "x"' > src/deep/.codex/config.toml; echo 1 > src/deep/x/f; G add -A; G commit -qm midcodex
( cd src/deep/x && AI_REVIEW_DRY_RUN=1 bash "$RR" --out ../../../.review-reports/r3cm >/dev/null 2>&1 )
grep -q '^started codex' .review-reports/r3cm/status.txt && ng "途中の階層の .codex/ を見逃した" || ok "起動位置から木の直下までの途中の .codex/ も検出する"
G rm -rq src/deep; G commit -qm unmid
d="$T/fl-nf"; mkdir -p "$d"; printf '## 4.4 結論\n**`PASS`**\nVERDICT: PASS\n' > "$d/own-review.md"; printf 'UNAVAILABLE codex-review (codex not found)\n' > "$d/status.txt"
python3 "$GP" summary --run "$d" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["floor"]=="must-address" and any(i["source"]=="unavailable:codex-review" for i in d["auto_items"]), d' 2>/dev/null && ok "codex が見つからない（UNAVAILABLE）ときも未取得の項目にし、1 人だけで PASS にしない" || ng "not found で PASS"
grep -q 'echo "UNAVAILABLE \$name (codex not found)"' "$RR" && ok "run-reviews.sh は未導入を UNAVAILABLE として status に書く" || ng "UNAVAILABLE を書かない"
# 比較元に共通の祖先が無いと escalation-check.sh は失敗する（孤立したブランチで再現）
G checkout -q --orphan lonely && G commit -qm lonely && G checkout -q feat
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_ESCALATION=real bash "$RR" --out .review-reports/r3bad --base lonely >/dev/null 2>&1
grep -q 'WARN: escalation-check.sh が失敗' .review-reports/r3bad/status.txt || ng "準備: escalation-check.sh が失敗していない"
grep -q '^started codex' .review-reports/r3bad/status.txt && ng "秘密情報の判定ができないのに Codex を起動した" || ok "秘密情報の判定ができなければ Codex を起動しない（止める側）"
G rm -q .env.local; G commit -qm unsecret
[ "$(grep -c '^started ' .review-reports/r3n/status.txt)" = "3" ] && ok "--deep --no-codex は Claude の 3 本だけ" || ng "no-codex の起動数"
grep -q '^UNAVAILABLE codex-review' .review-reports/r3n/status.txt && ok "--no-codex を明示しても UNAVAILABLE（二重化の欠け）として残す" || ng "--no-codex が未取得にならない"
printf 'x\n' > .review-reports/r3n/reviewed_base.security
run --out .review-reports/r3n
[ ! -e .review-reports/r3n/reviewed_base.security ] && ok "通常の実行は古い reviewed_base.* も消す" || ng "古い reviewed_base が残る"
mkdir -p "$T/reviewed_sha.dir"; run --out "$T/reviewed_sha.dir"
[ -f "$T/reviewed_sha.dir/reviewed_base.review" ] && ok "出力先のパスに reviewed_sha を含んでも reviewed_base を正しく書く" || ng "reviewed_base の書き出し先を誤った"
run --out .review-reports/r3 --security
[ -s .review-reports/r3/status.txt ] && [ -s .review-reports/r3/status-security.txt ] && ok "--security は通常の status.txt を消さない" || ng "status.txt が消えた"
[ -f .review-reports/r3/reviewed_sha.security ] && ok "--security も reviewed_sha を残す" || ng "reviewed_sha.security なし"
printf '#!/bin/sh\ntouch "%s/FAKE-ESC"\necho "{\\"escalate\\":false}"\n' "$T" > escalation-check.sh; chmod +x escalation-check.sh
echo '{"escalate":false,"reasons":[],"secret_paths":[]}' > "$T/stale.json"; mkdir -p .review-reports/r3e; cp "$T/stale.json" .review-reports/r3e/escalation.json
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_ESCALATION=real bash "$RR" --out .review-reports/r3e >/dev/null 2>&1
[ ! -e "$T/FAKE-ESC" ] && ok "起動したディレクトリの escalation-check.sh を実行しない（同梱のものを使う）" || ng "リポジトリ側の escalation-check.sh を実行した"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["escalate"] is True and any(r.startswith("A:path:src/auth") for r in d["reasons"])' .review-reports/r3e/escalation.json 2>/dev/null && ok "通常の実行は escalation.json を作り直す（古い escalate=false を使わない）" || ng "escalation.json: $(cat .review-reports/r3e/escalation.json)"
rm -f escalation-check.sh
bsha="$(git rev-parse origin/main)"
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_ESCALATION=real bash "$RR" --out .review-reports/r3b --base "$bsha" >/dev/null 2>&1
[ "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("base"))' .review-reports/r3b/escalation.json 2>/dev/null)" = "$bsha" ] && ok "--base を昇格判定にも渡す" || ng "base: $(cat .review-reports/r3b/escalation.json)"

echo "4. 判定表の検査（フィクスチャ）"
printf 'src/app.js\nsrc/auth/login.js\nREADME.md\n' > "$T/files.txt"
cat > "$T/out.md" <<'EOF'
## 4.1 判定表
| ファイル | セキュリティ判定 | その他の最重段 | 根拠（1行） |
|---|---|---|---|
| `src/app.js` | 安全 | なし | 外部入力なし |
| **./src/auth/login.js:12** | 脆弱 | 不具合 | 経路あり |
## 4.4 結論
**`BLOCK`**（指摘 1）
EOF
m="$(python3 "$GP" table-check --output "$T/out.md" --files "$T/files.txt")"
[ "$m" = "README.md" ] && ok "欠けたファイルだけを返す（装飾・./・行番号付きの行も照合）" || ng "欠け=[$m]"
python3 -c 'import sys;p=sys.argv[1];s=open(p).read();open(p,"w").write(s.replace("## 4.4 結論","| [README.md](README.md) | 安全 | なし | 文書 |\n## 4.4 結論"))' "$T/out.md"
m="$(python3 "$GP" table-check --output "$T/out.md" --files "$T/files.txt")"
[ -z "$m" ] && ok "リンク形式の行も照合する" || ng "欠け=[$m]"
printf '_worker.js\n__tests__/app.test.js\n' > "$T/files4.txt"
printf '## 判定表\n| ファイル | 判定 |\n|---|---|\n| `_worker.js` | 安全 |\n| __tests__/app.test.js | 安全 |\n' > "$T/out4.md"
m="$(python3 "$GP" table-check --output "$T/out4.md" --files "$T/files4.txt")"
[ -z "$m" ] && ok "ファイル名の先頭・末尾の _ を装飾として削らない" || ng "欠け=[$m]"
printf '**判定表**\n| 入口 | 出力先 |\n|---|---|\n| src/app.js | shell |\n\n| ファイル | 判定 |\n|---|---|\n| README.md | 安全 |\n' > "$T/out5.md"
m="$(python3 "$GP" table-check --output "$T/out5.md" --files "$T/files.txt" | tr '\n' ' ')"
[ "$m" = "src/app.js src/auth/login.js " ] && ok "判定表の見出しが無ければ、1 列目が「ファイル」の表だけを照合する" || ng "欠け=[$m]"
printf 'src/a/index.js\nsrc/b/index.js\n' > "$T/files2.txt"
printf '## 判定表\n| ファイル | 判定 |\n|---|---|\n| index.js | 安全 |\n' > "$T/out2.md"
m="$(python3 "$GP" table-check --output "$T/out2.md" --files "$T/files2.txt" | tr '\n' ' ')"
[ "$m" = "src/a/index.js src/b/index.js " ] && ok "同名ファイルが複数あるとき、末尾だけの行では判定済みにしない" || ng "欠け=[$m]"
printf '## 攻撃面の一覧\n| 入口 | 出力先 |\n|---|---|\n| src/b/index.js | shell |\n## 判定表\n| ファイル | 判定 |\n|---|---|\n| src/a/index.js | 安全 |\n' > "$T/out3.md"
m="$(python3 "$GP" table-check --output "$T/out3.md" --files "$T/files2.txt")"
[ "$m" = "src/b/index.js" ] && ok "判定表の節の表だけを照合する（別の表の 1 列目は数えない）" || ng "欠け=[$m]"

echo "5. 判定表の欠け → 1 回だけ再実行"
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_TABLE_MISSING=once bash "$RR" --out .review-reports/r5a >/dev/null 2>&1
st=.review-reports/r5a/status.txt
grep -q '^retry own-review .*判定表の欠け' "$st" && ok "欠けていれば単独で再実行する" || ng "再実行しない"
grep -q '^table ok own-review (再実行後)' "$st" && [ ! -f .review-reports/r5a/own-review.missing.txt ] && ok "再実行で埋まれば欠けを残さない" || ng "埋まったのに欠けが残る"
[ -f .review-reports/r5a/own-review.attempt1.md ] && ok "初回の出力を attempt1 として残す" || ng "attempt1 なし"
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_TABLE_MISSING=1 bash "$RR" --out .review-reports/r5b >/dev/null 2>&1
st=.review-reports/r5b/status.txt
[ "$(grep -c '^retry own-review' "$st")" = "1" ] && ok "再実行は 1 回だけ" || ng "再実行の回数=$(grep -c '^retry own-review' "$st")"
grep -q '^TABLE-INCOMPLETE own-review 1 件' "$st" && [ -s .review-reports/r5b/own-review.missing.txt ] && ok "埋まらなければ missing.txt に残す" || ng "missing.txt なし"
grep -q '^retry codex' "$st" && ng "Codex まで再実行した" || ok "Codex は判定表の検査の対象外"
python3 "$GP" summary --run .review-reports/r5b > "$T/s5.json"
python3 - "$T/s5.json" <<'PY' && ok "欠けは floor=must-address、判定なし（要確認）の自動項目になる" || ng "summary: $(cat "$T/s5.json")"
import json,sys; s=json.load(open(sys.argv[1]))
assert s["floor"]=="must-address", s["floor"]
assert any(i["source"]=="table-check:own-review" and i["summary"].startswith("判定なし（要確認）") for i in s["auto_items"])
PY

echo "6. 結論の読み取りと下限（floor）"
mk(){ d="$T/fl-$1"; mkdir -p "$d"; printf '%s\n' "$2" > "$d/own-review.md"; printf '%s\n' "$3" > "$d/codex-review.md"; python3 "$GP" summary --run "$d" | python3 -c 'import json,sys;print(json.load(sys.stdin)["floor"])'; }
[ "$(mk a $'## 4.4 結論\n\n**`PASS`**' 'No findings.')" = "pass" ] && ok "PASS + 指摘なし → pass" || ng "pass"
[ "$(mk b $'### 4.4 結論\n**`MUST-ADDRESS`**（#1）' 'No findings.')" = "must-address" ] && ok "MUST-ADDRESS → must-address" || ng "ma"
[ "$(mk c $'## 結論\n\n**`BLOCK`**（指摘 1。MUST-ADDRESS に当たるものとして指摘 2 もある）' 'No findings.')" = "block" ] && ok "BLOCK（後ろに MUST-ADDRESS の語があっても）→ block" || ng "block"
[ "$(mk d $'## 4.4 結論\n**`PASS`**' $'- [P1] Bad thing — src/app.js:1\n  body')" = "block" ] && ok "Codex の [P1] → block" || ng "codex P1"
[ "$(mk e $'## 4.4 結論\n**`PASS`**' $'- [P3] Nit — src/app.js:1')" = "must-address" ] && ok "Codex の [P3] → must-address" || ng "codex P3"
[ "$(mk v $'## 4.4 結論\n**`PASS`**\nVERDICT: PASS' $'No actionable regression was found. The test file mentions `[P1]` as a fixture.\n```\n- [P1] quoted\n```')" = "pass" ] && ok "Codex の本文・フェンスの中の [P1] は数えない（行頭の - [Pn] だけ）" || ng "引用の [P1] を数えた"
[ "$(mk w $'## 4.4 結論\n**`PASS`**\nVERDICT: PASS' $'Review comments:\n- P1: Command injection — src/app.js:1')" = "block" ] && ok "Codex の優先度が想定と違う形（- P1:）でも、その優先度で数える" || ng "形式違いを pass にした"
d="$T/fl-x"; mkdir -p "$d"; printf '## 4.4 結論\n**`PASS`**\nVERDICT: PASS\n' > "$d/own-review.md"; : > "$d/codex-review.md"; printf 'ok own-review 3 lines\nFAILED codex-review (非ゼロ終了)\n' > "$d/status.txt"
python3 "$GP" summary --run "$d" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["floor"]=="must-address", d;assert any(i["source"]=="unavailable:codex-review" for i in d["auto_items"])' 2>/dev/null && ok "失敗・タイムアウトしたレビュアーは未取得の自動項目（must-address）にする" || ng "失敗したレビュアーが黙って消える"
d="$T/fl-y"; mkdir -p "$d"; : > "$d/own-review.md"; : > "$d/codex-review.md"; printf 'FAILED own-review (x)\nTIMEOUT codex-review (x)\n' > "$d/status.txt"
[ "$(python3 "$GP" summary --run "$d" | python3 -c 'import json,sys;print(json.load(sys.stdin)["floor"])')" = "block" ] && ok "全員が失敗・タイムアウトなら block（未取得の項目で下げない）" || ng "全員失敗が block にならない"
[ "$(mk z $'## 4.4 結論\n**`PASS`**\nVERDICT: PASS' $'- [P2] minor — a.js:1\n- **P1** SQL injection — b.js:2')" = "block" ] && ok "正常な - [Pn] に別の形の優先度（- **P1**）が混ざっても、その優先度で数える" || ng "混在で P1 を無視"
[ "$(mk z2 $'## 4.4 結論\n**`PASS`**\nVERDICT: PASS' $'- **[P1]** SQL injection — b.js:2\n1. [P2] minor — a.js:1')" = "block" ] && ok "装飾・番号付きの [Pn]（- **[P1]**、1. [P2]）も数える" || ng "装飾つきの [P1] を数えない"
d="$T/fl-y2"; mkdir -p "$d"; printf '## 4.4 結論\n**`PASS`**\nVERDICT: PASS\n' > "$d/own-review.md"; printf -- '- [P2] x — a.js:1\n' > "$d/codex-review.md"; printf 'TIMEOUT codex-review (x)\n' > "$d/status.txt"
python3 "$GP" summary --run "$d" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert not any(i["source"].startswith("unavailable:") for i in d["auto_items"])' 2>/dev/null && ok "出力を読めたレビュアーには、古い status の行から未取得の項目を付けない" || ng "読めた出力に未取得の項目"
d="$T/fl-y3"; mkdir -p "$d"; printf '## 4.4 結論\n**`PASS`**\nVERDICT: PASS\n' > "$d/own-review.md"; printf '  \n\n' > "$d/codex-review.md"; printf 'ok own-review\nok codex-review\n' > "$d/status.txt"; printf 'started own-review\nstarted codex-review\n' >> "$d/status.txt"
python3 "$GP" summary --run "$d" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["floor"]=="must-address" and any(i["source"]=="unavailable:codex-review" for i in d["auto_items"]), d' 2>/dev/null && ok "起動したのに空白だけの出力のレビュアーは未取得にする" || ng "空白だけの出力が黙って消える"
[ "$(mk f $'指摘なし。' 'No findings.')" = "must-address" ] && ok "結論行が読めない → must-address（黙って pass にしない）" || ng "unknown"
[ "$(mk h $'## 4.4 結論\n\nPASS には当たりません。**`MUST-ADDRESS`**（指摘 1）' 'No findings.')" = "must-address" ] && ok "強調された結論を優先する（前に PASS の語があっても）" || ng "強調の優先"
[ "$(mk i $'## 4.4 結論\n\nBLOCK ではなく MUST-ADDRESS です（指摘 1）' 'No findings.')" = "block" ] && ok "強調が無ければ最初の行の最も重い語（安全側）" || ng "強調なし"
[ "$(mk j $'## 4.4 結論\n\n`PASS` には当たりません。**`BLOCK`**（指摘 1）' 'No findings.')" = "block" ] && ok "同じ行に強調が複数あれば最も重いもの" || ng "強調の最重"
[ "$(mk k $'## 4.4 結論\n\n| `BLOCK` | High がある |\n| `PASS` | なし |\n\n**`PASS`**\n\nVERDICT: PASS' 'No findings.')" = "pass" ] && ok "VERDICT 行があればそれを読む（書き写した表があっても）" || ng "VERDICT 行"
[ "$(mk k2 $'## 4.4 結論\n\n| `BLOCK` | High がある |\n| `PASS` | なし |\n\n**`PASS`**' 'No findings.')" = "block" ] && ok "VERDICT 行が無ければ結論の節の最も重い語（止める側）" || ng "VERDICT なしの安全側"
d="$T/fl-l"; mkdir -p "$d"; printf '## 4.4 結論\n**`PASS`**\n' > "$d/own-review.md"; printf '## 4.4 結論\n**`BLOCK`**\n' > "$d/own-review.attempt1.md"
[ "$(python3 "$GP" summary --run "$d" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["floor"],d["sources"]["own-review"]["level"])')" = "block block" ] && ok "判定表の再実行前（attempt1）の結論も下限に入れる（重い方）" || ng "attempt1 が消える"
d="$T/fl-m"; mkdir -p "$d"; printf '指摘なし。\n' > "$d/own-review.md"; printf '## 4.4 結論\n**`BLOCK`**\n' > "$d/own-review.attempt1.md"
[ "$(python3 "$GP" summary --run "$d" | python3 -c 'import json,sys;print(json.load(sys.stdin)["floor"])')" = "block" ] && ok "再実行の結論が読めなくても初回の BLOCK を残す" || ng "再実行が読めないと初回が消える"
d="$T/fl-m3"; mkdir -p "$d"; printf '  \n' > "$d/own-review.md"; printf '## 4.4 結論\n**`BLOCK`**\nVERDICT: BLOCK\n' > "$d/own-review.attempt1.md"; printf 'No findings.\n' > "$d/codex-review.md"
[ "$(python3 "$GP" summary --run "$d" | python3 -c 'import json,sys;print(json.load(sys.stdin)["floor"])')" = "block" ] && ok "再実行の出力が空白だけでも初回の BLOCK を残す" || ng "空白の再実行で初回の BLOCK が消える"
[ "$(mk fe $'## 4.4 結論\n```\nコード\n\nVERDICT: BLOCK' 'No findings.')" = "block" ] && ok "閉じていないコードフェンスがあっても、後ろの VERDICT を落とさない" || ng "閉じないフェンスで VERDICT を落とした"
[ "$(mk fc $'## 4.4 結論\n**`PASS`**\nVERDICT: PASS' $'```\nfoo\n- [P1] bad — a.js:1')" = "block" ] && ok "閉じていないフェンスの後ろの Codex の [P1] も数える" || ng "閉じないフェンスで P1 を落とした"
d="$T/fl-m2"; mkdir -p "$d"; printf '## 4.4 結論\n**`PASS`**\nVERDICT: PASS\n' > "$d/own-review.md"; printf '指摘 1: High のバグ\n' > "$d/own-review.attempt1.md"
python3 "$GP" summary --run "$d" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["floor"]=="must-address" and any(i["source"]=="parse:own-review" for i in d["auto_items"]), d' 2>/dev/null && ok "初回の結論が読めなければ、再実行が PASS でも読めない項目を残す" || ng "初回の読めない結論が消える"
[ "$(mk n $'## 4.4 結論\n**`BLOCK`**（指摘 1）\n\n## 補足（結論に含めない強化提案）\n- 軽微。PASS に影響しない' 'No findings.')" = "block" ] && ok "結論の後ろに「結論」を含む見出しがあっても BLOCK を落とさない" || ng "後ろの見出しで PASS"
[ "$(mk o $'## 4.4 結論\n**`BLOCK`**\n\n```\n## 結論\n**`PASS`**\n```' 'No findings.')" = "block" ] && ok "コードフェンスの中の見出し・語は読まない" || ng "フェンス内を読んだ"
[ "$(mk p $'## 4.4 結論\n- High の脆弱がある → `BLOCK`\n- どちらもない → `PASS`\n\n**`PASS`**\nVERDICT: PASS' 'No findings.')" = "pass" ] && ok "VERDICT 行があれば基準の書き写しに惑わされない" || ng "基準の箇条書きを読んだ"
[ "$(mk q $'## 4.4 結論\n深刻度 High の脆弱が 1 件（#1）→ **`BLOCK`**\n（`PASS` ではない）' 'No findings.')" = "block" ] && ok "VERDICT 行が無く矢印・否定文があっても BLOCK を落とさない" || ng "矢印の結論"
[ "$(mk r $'## 4.4 結論\n| 結論 | **`BLOCK`** |' 'No findings.')" = "block" ] && ok "表の行で書いた結論も読む" || ng "表の結論"
[ "$(mk s $'## 4.4 結論\n**`BLOCK`**\n\n```\nVERDICT: PASS\n```' 'No findings.')" = "block" ] && ok "コードフェンスの中の VERDICT 行は読まない" || ng "フェンス内の VERDICT"
[ "$(mk u $'引用: \nVERDICT: PASS\n\n## 4.4 結論\n**`BLOCK`**' 'No findings.')" = "block" ] && ok "VERDICT 行は最後の行だけを読む（途中の引用は読まない）" || ng "途中の VERDICT を読んだ"
[ "$(mk t $'### 1. 結論の読み取りが誤る\n- BLOCK の下限が落ちる\n\n## 4.4 結論\n**`PASS`**' 'No findings.')" = "pass" ] && ok "指摘の見出しに「結論」の語があっても結論の節とみなさない" || ng "指摘の見出しを結論と読んだ"
mkdir -p .review-reports/r6s; printf 'src/app.js\n' > .review-reports/r6s/own-review.missing.txt; printf '## 4.4 結論\n**`BLOCK`**\n' > .review-reports/r6s/own-review.attempt1.md; : > .review-reports/r6s/codex-review.used-o
run --out .review-reports/r6s
[ ! -e .review-reports/r6s/own-review.missing.txt ] && [ ! -e .review-reports/r6s/own-review.attempt1.md ] && ok "--out を使い回しても前回の missing.txt / attempt1.md を残さない" || ng "前回の付随ファイルが残る"
printf '## 4.4 結論\n**`BLOCK`**\n' > .review-reports/r6s/own-security.md; printf '## 4.4 結論\n**`BLOCK`**\n' > .review-reports/r6s/codex-astra.md; : > .review-reports/r6s/reviewed_sha.security
run --out .review-reports/r6s
[ ! -e .review-reports/r6s/own-security.md ] && [ ! -e .review-reports/r6s/codex-astra.md ] && [ ! -e .review-reports/r6s/reviewed_sha.security ] && ok "通常の実行は、今回起動しない深掘り・--deep の古い出力を消す" || ng "古い出力が残る"
[ -s .review-reports/r6s/escalation.json ] && ok "escalation.json が無ければ run-reviews.sh が作る" || ng "escalation.json を作らない"
mkdir -p "$T/fl-g"; [ "$(python3 "$GP" summary --run "$T/fl-g" | python3 -c 'import json,sys;print(json.load(sys.stdin)["floor"])')" = "block" ] && ok "レビュー結果が 1 つも無い → block" || ng "none"

echo "7. --deep の推奨"
mkdir -p "$T/rec"; printf '## 4.4 結論\n**`PASS`**\n' > "$T/rec/own-review.md"
echo '{"escalate":true,"reasons":["C:size:files=25>20"],"secret_paths":[],"files":25,"added":10,"base":"origin/main"}' > "$T/rec/escalation.json"
python3 "$GP" summary --run "$T/rec" | grep -q '"deep_recommended": true' && ok "規模超過で推奨" || ng "規模"
echo '{"escalate":true,"reasons":["A:path:src/auth/login.js"],"secret_paths":[]}' > "$T/rec/escalation.json"
python3 "$GP" summary --run "$T/rec" | grep -q '"deep_recommended": true' && ok "高リスクのパスで推奨" || ng "path A"
echo '{"escalate":true,"reasons":["B:content:eval("],"secret_paths":[]}' > "$T/rec/escalation.json"
python3 "$GP" summary --run "$T/rec" | grep -q '"deep_recommended": false' && ok "内容（B）だけなら推奨しない" || ng "B で推奨した"
printf '## 4.4 結論\n**`BLOCK`**\n' > "$T/rec/own-review.md"
python3 "$GP" summary --run "$T/rec" | grep -q 'BLOCK 相当の指摘がある' && ok "BLOCK 相当で推奨" || ng "block"
: > "$T/rec/deep.flag"
python3 "$GP" summary --run "$T/rec" | grep -q '"deep_recommended": false' && ok "--deep を回した後は推奨しない" || ng "deep 後も推奨"

echo "8. 記録（record-gate.sh）"
run --out .review-reports/r8
rec(){ bash "$RG" --escalate false --escalation-done false --report .review-reports/r8/report.md "$@" >"$T/rg.out" 2>&1; }
rec --verdict pass && [ "$(jget verdict)" = "pass" ] && [ "$(jget must_address)" = "[]" ] && ok "PASS なら pass・項目なしで記録" || ng "pass の記録: $(cat "$T/rg.out")"
[ "$(jget version)" = "3" ] && ok "version=3 を記録" || ng "version"
rec --verdict fix && ng "v2 の fix を受け付けた" || ok "v2 の verdict=fix は受け付けない"
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_VERDICT=MUST-ADDRESS bash "$RR" --out .review-reports/r8 >/dev/null 2>&1
rec --verdict pass && ng "MUST-ADDRESS の出力を項目なし・pass で記録できた" || ok "レビュアーの結論に見合う項目が無ければ拒む"
grep -q 'own-review' "$T/rg.out" && ok "どのレビュアーの分が足りないかを示す" || ng "理由: $(cat "$T/rg.out")"
it="$(items '[{"id":"R1","source":"own-review","file":"src/app.js","line":1,"tier":"MUST-ADDRESS","severity":"Medium","summary":"境界の値で落ちる","high_risk":false,"category":"correctness"}]')"
rec --verdict pass --items "$it" && [ "$(jget verdict)" = "must-address" ] && ok "結論は下限（must-address）へ引き上げて記録" || ng "引き上げ: $(cat "$T/rg.out")"
[ "$(jget must_address.0.status)" = "open" ] && ok "項目は open で記録" || ng "status"
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_CODEX='- [P1] Command built from input — src/app.js:1' bash "$RR" --out .review-reports/r8 >/dev/null 2>&1
rec --verdict pass --items "$it" && ng "Codex の P1 を MUST-ADDRESS の項目だけで記録できた" || ok "Codex の P1 には BLOCK の項目が要る"
it2="$(items '[{"id":"R1","source":"own-review","file":"src/app.js","line":1,"tier":"MUST-ADDRESS","severity":"Medium","summary":"境界の値で落ちる","high_risk":false,"category":"correctness"},{"id":"C1","source":"codex-review","file":"src/app.js","line":1,"tier":"BLOCK","severity":"High","summary":"入力からコマンドを組み立てる（コマンドインジェクション）","high_risk":false,"category":"correctness"}]')"
rec --verdict must-address --items "$it2" && [ "$(jget verdict)" = "block" ] && ok "P1 → block で記録" || ng "block: $(cat "$T/rg.out")"
[ "$(jget must_address.1.high_risk)" = "true" ] && ok "注入型の指摘は high_risk を自動で true にする" || ng "注入型の high_risk"
it3="$(items '[{"id":"R1","source":"own-review+codex-review","file":"src/auth/login.js","line":3,"tier":"MUST-ADDRESS","severity":"Low","summary":"ログの文言","high_risk":false,"category":"correctness"}]')"
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_VERDICT=MUST-ADDRESS AI_REVIEW_DRY_CODEX='- [P2] Log — src/auth/login.js:3' bash "$RR" --out .review-reports/r8 >/dev/null 2>&1
rec --verdict must-address --items "$it3" && [ "$(jget must_address.0.high_risk)" = "true" ] && [ "$(jget must_address.0.high_risk_reason)" = "path-A" ] && ok "昇格ルールの path（A）に当たるファイルは high_risk" || ng "path A の high_risk: $(cat "$T/rg.out")"
rec --verdict must-address --items "$it3" --escalation-done true && ng "own-security の出力なしで昇格済みと記録できた" || ok "昇格済みの記録には own-security.md が要る"
printf '## 4.4 結論\n**`PASS`**\n' > .review-reports/r8/own-security.md
rec --verdict must-address --items "$it3" --escalate true --escalation-done true && ng "完走していない own-security（reviewed_sha.security なし）で昇格済みと記録できた" || ok "昇格済みの記録には完走した own-security（reviewed_sha.security か --deep）が要る"
rm -f .review-reports/r8/own-security.md
itbad="$(items '[{"id":"R1","source":"own-review","file":"a","line":1,"tier":"強化提案","severity":"Low","summary":"x","high_risk":false,"category":"correctness"}]')"
rec --verdict pass --items "$itbad" && ng "不正な tier を受け付けた" || ok "tier は BLOCK / MUST-ADDRESS のみ"
itdup="$(items '[{"id":"R1","source":"own-review","file":"a","tier":"MUST-ADDRESS","severity":"Low","summary":"x","category":"correctness"},{"id":"R1","source":"own-review","file":"b","tier":"MUST-ADDRESS","severity":"Low","summary":"y","category":"correctness"}]')"
rec --verdict pass --items "$itdup" && ng "重複 id を受け付けた" || ok "重複 id は拒む"
run --out .review-reports/r8n --base HEAD
bash "$RG" --verdict pass --escalate false --escalation-done false --report .review-reports/r8n/report.md >"$T/rg.out" 2>&1 && ng "--base HEAD で比較範囲を狭めた run を記録できた" || ok "比較元が origin/HEAD との merge-base でない run は記録しない"
mkdir -p .review-reports/r8p; printf '指摘なし。\n' > .review-reports/r8p/own-review.md; git rev-parse HEAD > .review-reports/r8p/reviewed_sha.review; git merge-base origin/main HEAD > .review-reports/r8p/reviewed_base.review; echo '{"escalate":false,"reasons":[],"secret_paths":[]}' > .review-reports/r8p/escalation.json
bash "$RG" --verdict must-address --escalate false --escalation-done false --report .review-reports/r8p/report.md >"$T/rg.out" 2>&1 && [ "$(jget must_address.0.source)" = "parse:own-review" ] && ok "結論行を読めない出力は自動項目だけで記録できる" || ng "parse の自動項目で記録できない: $(cat "$T/rg.out")"
run --out .review-reports/r8s --security
bash "$RG" --verdict pass --escalate true --escalation-done true --report .review-reports/r8s/report.md >"$T/rg.out" 2>&1 && ng "--security 単独の実行を push の根拠として記録できた" || ok "--security 単独は push の根拠にならない（通常の 2 本の reviewed_sha.review が要る）"
mkdir -p .review-reports/r8t; printf '## 4.4 結論\n**`MUST-ADDRESS`**（指摘 1）\n' > .review-reports/r8t/own-review.md; echo src/app.js > .review-reports/r8t/own-review.missing.txt; git rev-parse HEAD > .review-reports/r8t/reviewed_sha.review; git merge-base origin/main HEAD > .review-reports/r8t/reviewed_base.review; echo '{"escalate":false,"reasons":[],"secret_paths":[]}' > .review-reports/r8t/escalation.json
bash "$RG" --verdict must-address --escalate false --escalation-done false --report .review-reports/r8t/report.md >"$T/rg.out" 2>&1 && ng "判定表の欠けの自動項目だけで own-review の指摘を省けた" || ok "判定表の欠けの自動項目はレビュアーの指摘の代わりにならない"
itauto="$(items '[{"id":"auto-1","source":"own-review","file":"a","tier":"MUST-ADDRESS","severity":"Low","summary":"x","category":"correctness"}]')"
rec --verdict pass --items "$itauto" && ng "予約された id（auto-）を受け付けた" || ok "auto- / prev- で始まる id は拒む"
mkdir -p .ai-review; echo 'path ^src/[[:xdigit:]]+/' > .ai-review/escalation-rules.local.txt
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_VERDICT=MUST-ADDRESS bash "$RR" --out .review-reports/r8 >/dev/null 2>&1
itx="$(items '[{"id":"X1","source":"own-review","file":"src/ab12/x.js","line":1,"tier":"MUST-ADDRESS","severity":"Low","summary":"文言","high_risk":false,"category":"correctness"}]')"
rec --verdict must-address --items "$itx" && [ "$(jget must_address.0.high_risk)" = "true" ] && ok "path ルールの [[:xdigit:]] も grep -E と同じく一致させる" || ng "xdigit: $(cat "$T/rg.out")"
echo 'path ^src/[[:nosuch:]]/' > .ai-review/escalation-rules.local.txt
rec --verdict must-address --items "$itx" && ng "変換できない path ルールを黙って無視した" || ok "変換できない path ルールは記録を拒む（高リスクの判定を黙って外さない）"
rm -rf .ai-review
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_VERDICT=MUST-ADDRESS bash "$RR" --out .review-reports/r8 >/dev/null 2>&1
itn="$(items '[{"id":"N1","source":"own-review","file":"./.github/workflows/ci.yml","line":1,"tier":"MUST-ADDRESS","severity":"Low","summary":"権限","high_risk":false,"category":"correctness"},{"id":"N2","source":"own-review","file":"/private/var/folders/x/T/ai-review-wt.1.abc/.github/workflows/ci.yml","line":1,"tier":"MUST-ADDRESS","severity":"Low","summary":"権限","high_risk":false,"category":"correctness"},{"id":"N3","source":"own-review","file":"src/run.py","line":1,"tier":"MUST-ADDRESS","severity":"Medium","category":"security","summary":"request.args を os.system に渡す","high_risk":false}]')"
rec --verdict must-address --items "$itn" --escalate true --skipped-by-user true --reason "テスト: 昇格はスキップ扱い" && [ "$(jget must_address.0.high_risk)" = "true" ] && [ "$(jget must_address.1.high_risk)" = "true" ] && ok "./ や隔離 worktree の絶対パスも正規化して path ルールに照合する" || ng "パスの正規化: $(cat "$T/rg.out")"
[ "$(jget must_address.2.high_risk)" = "true" ] && ok "セキュリティの指摘は語に関係なく高リスク（人の承認が要る）" || ng "security の high_risk"
itc="$(items '[{"id":"E1","source":"own-review","file":"src/a\u001b]0;evil\u0007b.js","line":1,"tier":"MUST-ADDRESS","severity":"Low","category":"Security","summary":"x","high_risk":false}]')"
rec --verdict must-address --items "$itc" --escalate true --skipped-by-user true --reason "テスト: 昇格はスキップ扱い" >/dev/null 2>&1
[ "$(jget must_address.0.high_risk)" = "true" ] && ok "category の大文字小文字を区別せず Security も高リスク" || ng "category の正規化"
bash "$RI" --list > "$T/list.out" 2>&1; hook >/dev/null
! grep -q $'\x1b' "$T/list.out" "$T/hook.out" && ok "ファイル名の制御文字を端末へそのまま出さない（--list・pre-push）" || ng "制御文字が出力された"
itc1="$(items '[{"id":"E2","source":"own-review","file":"src/a\u009b2Jb.js","line":1,"tier":"MUST-ADDRESS","severity":"Low","category":"correctness","summary":"x\u009by","high_risk":false}]')"
rec --verdict must-address --items "$itc1" >"$T/rg1.out" 2>&1; hook >/dev/null
! grep -q $'\xc2\x9b' "$T/rg1.out" "$T/hook.out" && ok "C1 制御文字（U+009B）も記録の表示・pre-push に出さない" || ng "C1 が出力された"
itbadc="$(items '[{"id":"C1","source":"own-review","file":"a","tier":"MUST-ADDRESS","severity":"Low","category":"misc","summary":"x"}]')"
rec --verdict must-address --items "$itbadc" && ng "不正な category を受け付けた" || ok "category は security / correctness / design のどれか"
AI_REVIEW_DRY_RUN=1 bash "$RR" --out .review-reports/r8x >/dev/null 2>&1
itsec="$(items '[{"id":"S1","source":"own-review","file":"src/fetch.py","line":1,"tier":"MUST-ADDRESS","severity":"Medium","category":"security","summary":"urlopen(user_url)","high_risk":false}]')"
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_VERDICT=MUST-ADDRESS bash "$RR" --out .review-reports/r8x >/dev/null 2>&1
bash "$RG" --verdict must-address --items "$itsec" --escalate false --escalation-done false --report .review-reports/r8x/report.md >"$T/rg.out" 2>&1 && ng "セキュリティの指摘があるのに深掘りなしで記録できた" || ok "セキュリティの指摘があれば深掘り（昇格）を要求する"
printf '{"escalate": true, "reasons": ["B:content:\\u001b]0;evil\\u0007x"], "secret_paths": []}\n' > .review-reports/r8x/escalation.json
bash "$RG" --verdict pass --escalate false --escalation-done false --report .review-reports/r8x/report.md >"$T/rg.out" 2>&1
! grep -q $'\x1b' "$T/rg.out" && ok "エラー表示でも制御文字を出さない" || ng "エラー表示に制御文字"
rm -f .review-reports/r8/escalation.json
rec --verdict must-address --items "$itn" --escalate true --skipped-by-user true --reason "テスト: 昇格はスキップ扱い" && ng "escalation.json なしで記録できた" || ok "branch の記録には escalation.json が要る"
rm -rf .ai-review
run --out .review-reports/r8e
echo '{"escalate":true,"reasons":["A:path:src/auth/login.js"],"secret_paths":[]}' > .review-reports/r8e/escalation.json
bash "$RG" --verdict pass --escalate false --escalation-done false --report .review-reports/r8e/report.md >"$T/rg.out" 2>&1 && ng "機械の昇格判定（escalate=true）を --escalate false で打ち消せた" || ok "escalation.json が昇格を求めるなら --escalate false は拒む"

echo "9. pre-push の判定"
git config ai-review.skip false
run --out .review-reports/r9
rec9(){ bash "$RG" --escalate false --escalation-done false --report .review-reports/r9/report.md "$@" >"$T/rg.out" 2>&1; }
rec9 --verdict pass; hook && ok "pass → 通す" || ng "pass で拒否: $(cat "$T/hook.out")"
grep -q 'ALLOW_DRY' "$T/hook.out" && ok "AI_REVIEW_ALLOW_DRY で通したときは警告を出す" || ng "ALLOW_DRY の警告なし"
hook_nodry && ng "ダミー実行の記録を通した" || ok "ダミー実行（AI_REVIEW_DRY_RUN）の記録は通さない"
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_VERDICT=BLOCK bash "$RR" --out .review-reports/r9 >/dev/null 2>&1
itb="$(items '[{"id":"B1","source":"own-review","file":"src/app.js","line":1,"tier":"BLOCK","severity":"High","summary":"データが消える","high_risk":false,"category":"correctness"}]')"
rec9 --verdict block --items "$itb"; hook && ng "block を通した" || ok "block → 拒否"
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_VERDICT=MUST-ADDRESS bash "$RR" --out .review-reports/r9 >/dev/null 2>&1
itm="$(items '[{"id":"M1","source":"own-review","file":"src/app.js","line":2,"tier":"MUST-ADDRESS","severity":"Medium","summary":"空配列で例外","high_risk":false,"category":"correctness"}]')"
rec9 --verdict must-address --items "$itm"; hook && ng "未処理の must-address を通した" || ok "must-address（open）→ 拒否"
grep -q 'M1' "$T/hook.out" && ok "拒否理由に未処理の項目を出す" || ng "理由に項目なし"
bash "$RI" --id M1 --accepted --reason "" >/dev/null 2>&1 && ng "理由なしで accepted にできた" || ok "accepted には理由が要る"
bash "$RI" --id M1 --accepted --reason "呼び出し元 src/x.js:10 で空配列を弾いている" >/dev/null 2>&1
hook && ng "検証前の accepted を通した" || ok "accepted（検証待ち）→ 拒否"
bash "$RI" --id M1 --verifier rejected --note "src/x.js に該当の検査は無い" >/dev/null 2>&1
[ "$(jget must_address.0.status)" = "open" ] && ok "検証で退けられたら open に戻る" || ng "rejected 後の status=$(jget must_address.0.status)"
hook && ng "rejected を通した" || ok "rejected → 拒否"
bash "$RI" --id M1 --accepted --reason "src/x.js:12 の guard で空配列は来ない" >/dev/null 2>&1
bash "$RI" --id M1 --accepted --reason "-oの出力で確認した" >"$T/ri.out" 2>&1 && [ "$(jget must_address.0.reason)" = "-oの出力で確認した" ] && ok "- で始まる理由も記録できる" || ng "- で始まる理由: $(cat "$T/ri.out")"
bash "$RI" --id M1 --verifier upheld --note "guard を確認" >/dev/null 2>&1
hook && ok "must-address（accepted + 検証 upheld、高リスクでない）→ 通す" || ng "解決済みで拒否: $(cat "$T/hook.out")"
printf 'open("%s/PWNED","w").write("x")\nraise SystemExit(99)\n' "$T" > json.py
hook && [ ! -e "$T/PWNED" ] && ok "リポジトリ直下の json.py をフックが import しない（python3 -I）" || ng "json.py が読み込まれた: $(cat "$T/hook.out")"
rm -f json.py "$T/PWNED"
bash "$RI" --id M1 --approve-human --note "OK" >/dev/null 2>&1 && ng "高リスクでない項目に人の承認を記録できた" || ok "高リスクでない項目には人の承認を付けない"

ith="$(items '[{"id":"H1","source":"own-review","file":"src/app.js","line":3,"tier":"MUST-ADDRESS","severity":"Medium","summary":"入力がパスに届く（パストラバーサル）","category":"security","high_risk":false}]')"
rec9 --verdict must-address --items "$ith" --escalate true --skipped-by-user true --reason "テスト: 昇格はスキップ扱い"
[ "$(jget must_address.0.high_risk)" = "true" ] || ng "準備: H1 が高リスクにならない"
bash "$RI" --id H1 --approve-human --note "OK" >/dev/null 2>&1 && ng "検証前に人の承認を記録できた" || ok "人の承認は accepted + upheld の後だけ"
bash "$RI" --id H1 --accepted --reason "基準ディレクトリの確認が src/app.js:5 にある" >/dev/null 2>&1
bash "$RI" --id H1 --verifier upheld --note "確認した" >/dev/null 2>&1
hook && ng "高リスクを人の承認なしで通した" || ok "高リスク（accepted + upheld、人の承認なし）→ 拒否"
grep -q '人の承認' "$T/hook.out" && ok "拒否理由に「人の承認が要る」を出す" || ng "理由: $(cat "$T/hook.out")"
bash "$RI" --id H1 --approve-human --note "" >/dev/null 2>&1 && ng "発言なしで承認を記録できた" || ok "人の承認には発言の記録が要る"
notty bash "$RI" --id H1 --approve-human --note "ユーザー: H1 はそのままでよい" >/dev/null 2>&1 && ng "端末なしで人の承認を記録できた" || ok "人の承認は端末で ID を打ち込まないと記録しない（AI の Bash からは書けない）"
notty python3 "$GP" resolve --latest "$latest" --head "$(git rev-parse HEAD)" --id H1 --action approve --note "OK" >/dev/null 2>&1 && ng "gate.py を直接呼んで端末なしで承認できた" || ok "gate.py を直接呼んでも、端末の確認なしに人の承認は書けない"
tty_run H9 bash "$RI" --id H1 --approve-human --note "ユーザー: H1 はそのままでよい" >/dev/null 2>&1 && ng "違う ID の入力で承認を記録できた" || ok "端末で打ち込んだ ID が違えば記録しない"
tty_run H1 bash "$RI" --id H1 --approve-human --note "ユーザー: H1 はそのままでよい" >/dev/null 2>&1
hook && ok "高リスク + 人の承認 → 通す" || ng "承認後に拒否: $(cat "$T/hook.out")"

echo "10. fixed は再レビューで初めて通る"
rec9 --verdict must-address --items "$itm" || ng "準備: M1 を記録できない: $(cat "$T/rg.out")"
bash "$RI" --id M1 --fixed --note "空配列を弾く" >"$T/ri.out" 2>&1 || ng "準備: M1 を fixed にできない: $(cat "$T/ri.out")"
[ "$(jget must_address.0.status)" = "fixed" ] || ng "準備: M1 が fixed になっていない"
hook && ng "fixed（未再レビュー）を通した" || ok "fixed（再レビュー前）→ 拒否"
echo fixed >> src/app.js; G commit -qam fix
bash "$RI" --id M1 --accepted --reason "x" >/dev/null 2>&1 && ng "HEAD が動いた後に理由を記録できた" || ok "レビュー後に HEAD が動いたら理由・検証・承認は記録できない"
run --out .review-reports/r10
bash "$RG" --verdict pass --escalate false --escalation-done false --report .review-reports/r10/report.md >"$T/rg.out" 2>&1
[ "$(jget must_address.0.id)" = "prev-M1" ] && [ "$(jget must_address.0.re_reviewed_sha)" = "$(git rev-parse HEAD)" ] && ok "前回 fixed の項目を再レビュー済みとして引き継ぐ" || ng "引き継ぎ: $(jget must_address)"
[ "$(jget verdict)" = "pass" ] && hook && ok "再レビュー後の pass → 通す" || ng "再レビュー後に拒否: $(cat "$T/hook.out")"
bash "$RI" --id prev-M1 --accepted --reason "x" >/dev/null 2>&1 && ng "引き継いだ項目を書き換えられた" || ok "引き継いだ項目は変更できない"
python3 - "$latest" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["verdict"]="must-address"; json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PY
hook && ok "fixed かつ re_reviewed_sha = HEAD の項目は処理済みとみなす" || ng "引き継ぎ項目で拒否: $(cat "$T/hook.out")"

echo "11. 既存の検査（HEAD・BYPASS・壊れた記録）"
G commit -q --allow-empty -m later
hook && ng "HEAD が違うのに通した" || ok "head_sha ≠ push 対象 → 拒否"
AI_REVIEW_BYPASS=1 bash "$HOOK" >/dev/null 2>&1 <<EOF && ok "AI_REVIEW_BYPASS=1 は従来どおり通す" || ng "BYPASS が効かない"
refs/heads/feat $(git rev-parse HEAD) refs/heads/feat 0000000000000000000000000000000000000000
EOF
run --out .review-reports/r11
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_VERDICT=MUST-ADDRESS bash "$RR" --out .review-reports/r11 >/dev/null 2>&1
bash "$RG" --verdict must-address --items "$itm" --escalate false --escalation-done false --report .review-reports/r11/report.md >/dev/null 2>&1
python3 - "$latest" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["must_address"]=[]; json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PY
hook && ng "must-address なのに項目が無い記録を通した" || ok "must-address で項目が空の記録 → 拒否"
python3 "$GP" check --latest "$latest" --head "$(git rev-parse HEAD)" >/dev/null 2>&1; [ $? -eq 1 ] && ok "gate.py check も pre-push と同じく must-address で項目が空なら拒む" || ng "check"
python3 - "$latest" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["verdict"]="fix"; json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PY
hook && ng "v2 の verdict=fix を通した" || ok "v2 の記録（fix）→ 拒否"

echo "12. JEV・ECC への依存が残っていない"
sd="$here/.."
[ ! -e "$sd/scripts/jev-judge.py" ] && [ ! -e "$sd/scripts/jev-escalation.py" ] && ok "JEV のスクリプトを削除" || ng "JEV のスクリプトが残っている"
grep -qi 'jev' "$sd/SKILL.md" "$sd/scripts/run-reviews.sh" "$sd/scripts/record-gate.sh" "$sd/hooks/pre-push" && ng "JEV の記述が残っている" || ok "SKILL.md・スクリプトに JEV の記述なし"
grep -q 'commands/code-review.md\|ECC' "$sd/SKILL.md" "$sd/scripts/run-reviews.sh" && ng "ECC への依存が残っている" || ok "ECC（~/.claude/commands/code-review.md）に依存しない"

echo "== PASS $pass / FAIL $fail =="
[ $fail -eq 0 ]
