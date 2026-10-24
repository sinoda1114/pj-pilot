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
unset AI_REVIEW_BYPASS AI_REVIEW_DRY_TABLE_MISSING AI_REVIEW_DRY_VERDICT AI_REVIEW_DRY_CODEX AI_REVIEW_DRY_EMPTY AI_REVIEW_DRY_FAIL AI_REVIEW_DRY_FAIL_RETRY
export AI_REVIEW_DRY_SLEEP=0

G init -q --bare -b main "$T/origin.git" || die "bare リポジトリ"
G clone -q "$T/origin.git" "$T/repo" 2>/dev/null || die "clone"
cd "$T/repo" || die "cd"
echo base > a.txt; G add -A; G commit -qm base; P origin HEAD:main || die "push"
G fetch -q origin && G remote set-head origin main >/dev/null || die "origin/HEAD の設定"
# この端末に入っている pre-push（グローバルの core.hooksPath）に左右されないよう、テスト用のリポジトリでは今のフックを使う
mkdir -p "$T/hooks" && cp "$HOOK" "$T/hooks/pre-push" && chmod +x "$T/hooks/pre-push"
printf '[core]\n\thooksPath = %s\n' "$T/hooks" > "$T/gitconfig"; export GIT_CONFIG_GLOBAL="$T/gitconfig"
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
grep -q -- '-m gpt-6.1-sol -c model_reasoning_effort="high"' .review-reports/r1/codex-review.md && ok "codex-review は gpt-6.1-sol / high の純正 review（独自の指示なし）" || ng "codex のモデル"
grep -q -- 'exec review --base origin/main --skip-git-repo-check' .review-reports/r1/codex-review.md && ok "Codex に比較元を渡す" || ng "codex の比較元"
grep -q -- '-c notify=\[\] -c mcp_servers={}' .review-reports/r1/codex-review.md && ok "Codex のプロジェクト設定（notify・MCP）を打ち消す" || ng "codex の設定の打ち消し"
grep -q -- '-c project_doc_max_bytes=0' .review-reports/r1/codex-review.md && ok "Codex にレビュー対象の AGENTS.md を読ませない（指示で指摘を消されないように）" || ng "AGENTS.md を読ませない設定が無い"
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
notty bash "$RI" --id H1 --approve-human --note "ユーザー: H1 はそのままでよい" >"$T/appr.out" 2>&1; grep -qF "$here/resolve-item.sh" "$T/appr.out" && ok "承認の案内は、スキルの実際の場所のパスを示す（決め打ちしない）" || ng "承認の案内のパス: $(tail -1 "$T/appr.out")"
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

echo "11b. レビュー対象の .review-reports のシンボリックリンク"
mkdir -p "$T/evil"; ln -s "$T/evil" .review-reports.lnk
mv .review-reports "$T/rr.keep"; mv .review-reports.lnk .review-reports; G add .review-reports; G commit -qm evil-link
run --out .review-reports/rx1; [ -z "$(ls -A "$T/evil")" ] && ok "追跡されたシンボリックリンクの .review-reports には書かない（run-reviews.sh）" || ng "リンク先に書いた: $(ls "$T/evil")"
bash "$RG" --verdict pass --escalate false --escalation-done false --no-diff >"$T/rg.out" 2>&1; [ ! -e "$T/evil/latest.json" ] && grep -q 'シンボリックリンク' "$T/rg.out" && ok "record-gate.sh もリンク先に書かず、理由を示して止まる" || ng "record-gate.sh: $(tail -1 "$T/rg.out")"
bash "$RI" --list >"$T/ri.out" 2>&1; grep -q 'シンボリックリンク' "$T/ri.out" && ok "resolve-item.sh もリンクの .review-reports を拒む" || ng "resolve-item.sh: $(tail -1 "$T/ri.out")"
G rm -q --cached .review-reports; rm .review-reports; G commit -qm unlink; mv "$T/rr.keep" .review-reports
echo "11c. .review-reports の確認（サブディレクトリ・大文字小文字違い）"
mkdir -p "$T/evil2" sub; ln -s "$T/evil2" sub/.review-reports; G add sub/.review-reports; G commit -qm sublink
( cd sub && AI_REVIEW_DRY_RUN=1 bash "$RR" --out .review-reports/rx2 >/dev/null 2>&1 ); [ -z "$(ls -A "$T/evil2")" ] && ok "サブディレクトリの追跡された .review-reports にも書かない" || ng "サブディレクトリのリンク先に書いた"
G rm -q --cached sub/.review-reports; rm sub/.review-reports; G commit -qm unsub
mkdir -p .Review-Reports-x; echo x > .Review-Reports-x/f; G add .Review-Reports-x; G commit -qm notmatch
run --out .review-reports/rx3; [ -s .review-reports/rx3/status.txt ] && ok "似た名前（.Review-Reports-x）は誤って止めない" || ng "似た名前で止めた"
G rm -rq .Review-Reports-x; G commit -qm unnotmatch
mv .review-reports "$T/rr.keep2"; mkdir -p .Review-Reports; echo x > .Review-Reports/latest.md; G add -f .Review-Reports; G commit -qm icase
run --out "$T/outside-icase"; [ ! -s "$T/outside-icase/status.txt" ] && ok "大文字小文字違いの追跡された .Review-Reports があれば止める" || ng "大文字小文字違いを見逃した"
printf 'refs/heads/feat %s refs/heads/feat %s\n' "$(git rev-parse HEAD)" 0000000000000000000000000000000000000000 | AI_REVIEW_ALLOW_DRY=1 bash "$HOOK" origin x >"$T/hk.out" 2>&1 && ng "pre-push が追跡された .review-reports の記録を読んだ" || { grep -q '追跡' "$T/hk.out" && ok "pre-push も追跡された .review-reports を拒む" || ng "pre-push の理由: $(tail -1 "$T/hk.out")"; }
G rm -rq .Review-Reports; G commit -qm unicase; rm -rf .Review-Reports; mv "$T/rr.keep2" .review-reports

echo "11d. リポジトリ自身の pre-push を呼び継ぐ"
hk="$(git rev-parse --git-common-dir)/hooks/pre-push"
printf '#!/bin/sh\ncat > "%s/chained.in"\nexit 7\n' "$T" > "$hk"; chmod +x "$hk"
AI_REVIEW_BYPASS=1 bash "$HOOK" origin x >/dev/null 2>&1 <<EOF
refs/heads/feat $(git rev-parse HEAD) refs/heads/feat 0000000000000000000000000000000000000000
EOF
rc=$?; [ $rc -eq 7 ] && grep -q "refs/heads/feat" "$T/chained.in" && ok "ゲートを通したら .git/hooks/pre-push を同じ入力で呼び継ぎ、その結果を返す" || ng "呼び継ぎ rc=$rc"
rm -f "$T/chained.in"
printf 'refs/heads/feat %s refs/heads/feat %s\n' "$(git rev-parse HEAD)" 0000000000000000000000000000000000000000 | bash "$HOOK" origin x >/dev/null 2>&1
[ ! -e "$T/chained.in" ] && ok "ゲートが拒んだときは呼び継がない" || ng "拒否したのに呼び継いだ"
rm -f "$hk"

echo "11e. リポジトリ単位の core.hooksPath でゲートが動かないことを知らせる"
git config --local core.hooksPath .git/hooks
run --out .review-reports/rhp
grep -q '^WARN: .*core.hooksPath' .review-reports/rhp/status.txt && ok "リポジトリ単位の core.hooksPath があれば、pre-push ゲートが動かないと WARN を残す" || ng "hooksPath の WARN なし"
git config --local --unset core.hooksPath
run --out .review-reports/rhp2
! grep -q 'core.hooksPath' .review-reports/rhp2/status.txt && ok "設定が無ければ WARN を出さない" || ng "設定が無いのに WARN"

echo "13. 差分レビュー（大きいブランチの 2 周目以降は、前回レビューした SHA からの差分だけを見る）"
G checkout -q -b inc origin/main
mkdir -p .ai-review; printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
echo 'p' > p1.js; echo 'q' > p2.js; G add p1.js p2.js; G commit -qm big
sget(){ python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v=d.get(sys.argv[2]); print(json.dumps(v) if isinstance(v,bool) or v is None else v)' "$1" "$2"; }
rec13(){ local r="$1"; shift; bash "$RG" --escalate false --escalation-done false --report "$r/report.md" "$@" >"$T/rg.out" 2>&1; }
# 1 周目: 前回の記録とつながらない → 全体
run --out .review-reports/i1
[ "$(sget .review-reports/i1/scope.json scope)" = "full" ] && ok "1 周目は全体をレビューする" || ng "1 周目の scope: $(cat .review-reports/i1/scope.json 2>&1)"
h1="$(git rev-parse HEAD)"
AI_REVIEW_DRY_RUN=1 AI_REVIEW_DRY_VERDICT=MUST-ADDRESS bash "$RR" --out .review-reports/i1 >/dev/null 2>&1
iti="$(items '[{"id":"R1","source":"own-review","file":"p1.js","line":1,"tier":"MUST-ADDRESS","severity":"Medium","summary":"境界の値で落ちる","high_risk":false,"category":"correctness"},{"id":"R2","source":"own-review","file":"p2.js","line":1,"tier":"MUST-ADDRESS","severity":"Low","summary":"空文字で落ちる","high_risk":false,"category":"correctness"}]')"
rec13 .review-reports/i1 --verdict must-address --items "$iti" || ng "1 周目の記録: $(cat "$T/rg.out")"
[ "$(jget scope)" = "full" ] && [ "$(jget full_count)" = "1" ] && ok "記録に scope=full・full_count=1 を残す" || ng "1 周目の記録: scope=$(jget scope) full_count=$(jget full_count)"
bash "$RI" --id R1 --fixed --note "境界を直した" >/dev/null 2>&1
echo 'p fixed' > p1.js; G commit -qam fix1
# 2 周目: 前回の記録につながり、差分が大きい → 前回の SHA からの差分だけ
run --out .review-reports/i2
[ "$(sget .review-reports/i2/scope.json scope)" = "incremental" ] && [ "$(sget .review-reports/i2/scope.json since)" = "$h1" ] && ok "2 周目は前回レビューした SHA からの差分をレビューする" || ng "2 周目の scope: $(cat .review-reports/i2/scope.json 2>&1)"
grep -q -- "exec review --base $h1 " .review-reports/i2/codex-review.md && ok "Codex の比較元も前回レビューした SHA にする" || ng "Codex の比較元: $(grep -o 'exec review --base [^ ]*' .review-reports/i2/codex-review.md)"
grep -q "比較範囲: $h1\.\.\.HEAD" .review-reports/i2/own-review.prompt.md && ok "自前観点のプロンプトの比較範囲も前回の SHA から" || ng "プロンプトの比較範囲: $(grep '比較範囲' .review-reports/i2/own-review.prompt.md)"
[ "$(cat .review-reports/i2/changed-files.txt)" = "p1.js" ] && ok "判定表の対象は前回からの変更ファイルだけ" || ng "変更ファイル: $(cat .review-reports/i2/changed-files.txt)"
rec13 .review-reports/i2 --verdict pass || ng "2 周目の記録: $(cat "$T/rg.out")"
[ "$(jget scope)" = "incremental" ] && [ "$(jget since_sha)" = "$h1" ] && [ "$(jget full_count)" = "1" ] && ok "記録に scope=incremental・since_sha を残す" || ng "2 周目の記録: $(jget scope) $(jget since_sha) $(jget full_count)"
python3 -c 'import json,sys; m={i["id"]:i for i in json.load(open(sys.argv[1]))["must_address"]}; sys.exit(0 if m.get("prev-R1",{}).get("re_reviewed_sha") and m.get("carry-R2",{}).get("status")=="open" else 1)' "$latest" \
  && ok "fixed は再レビュー済み（prev-）、未処理は carry- で引き継ぐ（差分レビューでは同じ指摘が出直さないため）" || ng "引き継ぎ: $(jget must_address)"
[ "$(jget verdict)" = "must-address" ] && ok "引き継いだ未処理の項目があれば must-address" || ng "verdict=$(jget verdict)"
bash "$RI" --id carry-R2 --accepted --reason "呼び出し元 p0.js:3 で空文字を弾いている" >/dev/null 2>&1 && bash "$RI" --id carry-R2 --verifier upheld --note "検証: 成立" >/dev/null 2>&1 \
  && ok "引き継いだ未処理の項目は今の HEAD で片づけられる" || ng "carry-R2 を処理できない"
hook && ng "全体のレビューを 1 回しか経ていない差分レビューの記録で push を通した" || ok "差分レビューの記録は、最後の全体レビューを経るまで push を止める"
grep -q '全体' "$T/hook.out" && ok "拒否理由に最後の全体レビューが要ることを出す" || ng "拒否理由: $(cat "$T/hook.out")"
# 3 周目: 差分レビューが片づいた → 最後の全体レビュー（規模による昇格はしない）
run --out .review-reports/i3
[ "$(sget .review-reports/i3/scope.json scope)" = "full" ] && [ "$(sget .review-reports/i3/scope.json no_size)" = "true" ] && ok "差分レビューが片づいたら最後に全体を見る（規模による昇格は 1 周目だけ）" || ng "3 周目の scope: $(cat .review-reports/i3/scope.json 2>&1)"
rec13 .review-reports/i3 --verdict pass || ng "3 周目の記録: $(cat "$T/rg.out")"
[ "$(jget full_count)" = "2" ] && hook && ok "最後の全体レビューが通れば push を通す" || ng "3 周目: full_count=$(jget full_count) $(cat "$T/hook.out")"
# 4 周目: 最後の全体レビューの後の修正は差分レビューで足りる
echo 'q2' > p2.js; G commit -qam fix2
run --out .review-reports/i4
[ "$(sget .review-reports/i4/scope.json scope)" = "incremental" ] && ok "最後の全体レビューの後も差分レビューにする" || ng "4 周目の scope: $(cat .review-reports/i4/scope.json 2>&1)"
rec13 .review-reports/i4 --verdict pass && [ "$(jget full_count)" = "2" ] && hook && ok "全体レビュー 2 回を経た差分レビューの記録は push を通す" || ng "4 周目: $(cat "$T/rg.out") $(cat "$T/hook.out")"
# 改ざん: 前回の記録とつながらない差分レビューは記録しない
echo 'r' > p3.js; G add p3.js; G commit -qm more
run --out .review-reports/i5
python3 - "$latest" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["head_sha"]="0"*40; json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PY
rec13 .review-reports/i5 --verdict pass && ng "前回の記録とつながらない差分レビューを記録できた" || ok "比較元が前回の記録の head_sha でない差分レビューは記録しない"
# --full で全体を強制できる。規模の小さいブランチは常に全体
run --out .review-reports/i6 --full
[ "$(sget .review-reports/i6/scope.json scope)" = "full" ] && ok "--full なら全体をレビューする" || ng "--full: $(cat .review-reports/i6/scope.json 2>&1)"
rm -f .ai-review/escalation-rules.local.txt
rec13 .review-reports/i6 --verdict pass >/dev/null 2>&1
echo 's' >> p3.js; G commit -qam small
run --out .review-reports/i7
[ "$(sget .review-reports/i7/scope.json scope)" = "full" ] && ok "差分が小さいブランチは毎回全体をレビューする" || ng "小さい差分: $(cat .review-reports/i7/scope.json 2>&1)"
# 深掘り（--security）は同じ run の比較範囲を使う
printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
rec13 .review-reports/i7 --verdict pass >/dev/null 2>&1
echo 't' >> p1.js; G commit -qam t
run --out .review-reports/i8; run --out .review-reports/i8 --security
[ "$(cat .review-reports/i8/reviewed_base.security 2>/dev/null)" = "$(sget .review-reports/i8/scope.json since)" ] && ok "差分レビューの深掘りも同じ比較範囲を使う" || ng "深掘りの比較元: $(cat .review-reports/i8/reviewed_base.security 2>&1)"
rm -rf .ai-review
# 昇格判定の --no-size
echo '{}' > /dev/null
o="$(bash "$here/escalation-check.sh" --no-size --rules <(printf 'max_files 0\nmax_added 0\n') --local-rules /dev/null)"
printf '%s' "$o" | grep -q 'C:size' && ng "--no-size でも規模で昇格した: $o" || ok "--no-size なら規模では昇格しない"
printf '%s' "$o" | grep -q '"size_skipped":true' && ok "規模の判定を飛ばしたことを残す" || ng "size_skipped なし: $o"

echo "13a. --incremental なら小さい差分でも差分レビューにする"
G checkout -q -b inc3 origin/main
echo 'w' > w1.js; G add w1.js; G commit -qm small1
run --out .review-reports/k1; rec13 .review-reports/k1 --verdict pass >/dev/null 2>&1
echo 'w2' >> w1.js; G commit -qam small2
run --out .review-reports/k2
[ "$(sget .review-reports/k2/scope.json scope)" = "full" ] && ok "小さい差分は既定では全体" || ng "k2: $(cat .review-reports/k2/scope.json)"
run --out .review-reports/k3 --incremental
[ "$(sget .review-reports/k3/scope.json scope)" = "incremental" ] && ok "--incremental なら小さい差分でも差分レビュー" || ng "k3: $(cat .review-reports/k3/scope.json)"

echo "13b. 1 周目で深掘りが加わったブランチは、最後の全体レビューでも深掘りを加える"
G checkout -q -b inc2 origin/main
mkdir -p .ai-review; printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
echo 'u' > u1.js; echo 'v' > u2.js; G add u1.js u2.js; G commit -qm big2
run --out .review-reports/j1; run --out .review-reports/j1 --security
bash "$RG" --verdict pass --escalate true --escalation-done true --report .review-reports/j1/report.md >"$T/rg.out" 2>&1 || ng "j1 の記録: $(cat "$T/rg.out")"
[ "$(jget chain_escalated)" = "true" ] && ok "1 周目で深掘りが加わったことを記録に残す（chain_escalated）" || ng "chain_escalated=$(jget chain_escalated)"
echo 'u fixed' > u1.js; G commit -qam fixu
run --out .review-reports/j2
[ "$(sget .review-reports/j2/scope.json scope)" = "incremental" ] && [ "$(sget .review-reports/j2/scope.json force_escalation)" != "true" ] && ok "差分レビューの周は、その周の差分で深掘りを判定する（強制しない）" || ng "j2: $(cat .review-reports/j2/scope.json)"
rec13 .review-reports/j2 --verdict pass || ng "j2 の記録: $(cat "$T/rg.out")"
[ "$(jget chain_escalated)" = "true" ] && ok "chain_escalated を差分レビューの記録にも引き継ぐ" || ng "引き継ぎ chain_escalated=$(jget chain_escalated)"
run --out .review-reports/j3
[ "$(sget .review-reports/j3/scope.json scope)" = "full" ] && [ "$(sget .review-reports/j3/scope.json force_escalation)" = "true" ] && ok "最後の全体レビューでは深掘りを強制する" || ng "j3: $(cat .review-reports/j3/scope.json)"
grep -q '"escalate": *true' .review-reports/j3/escalation.json && grep -q 'F:chain' .review-reports/j3/escalation.json && ok "escalation.json に昇格の理由（F:chain）を残す" || ng "j3 escalation: $(cat .review-reports/j3/escalation.json)"
rec13 .review-reports/j3 --verdict pass && ng "最後の全体レビューを深掘りなしで記録できた" || ok "最後の全体レビューは深掘りなしでは記録しない"
run --out .review-reports/j3 --security
bash "$RG" --verdict pass --escalate true --escalation-done true --report .review-reports/j3/report.md >"$T/rg.out" 2>&1 && [ "$(jget full_count)" = "2" ] && hook \
  && ok "深掘りを加えた最後の全体レビューが通れば push を通す" || ng "j3 の記録: $(cat "$T/rg.out") $(cat "$T/hook.out")"
rm -rf .ai-review

echo "12a. インストール先に依存しない"
grep -q '__AI_REVIEW_SKILL_DIR__' "$HOOK" && ok "pre-push はスキルの場所を埋め込む場所（__AI_REVIEW_SKILL_DIR__）を持つ" || ng "pre-push にスキルの場所の埋め込み口が無い"
sd0="$here/.."; grep -rn '~/.claude/skills/ai-review' "$sd0/hooks" "$sd0/scripts/gate.py" "$sd0/scripts/resolve-item.sh" "$sd0/scripts/record-gate.sh" "$sd0/scripts/run-reviews.sh" >/dev/null && ng "スクリプト・フックに ~/.claude/skills/ai-review の決め打ちが残っている" || ok "スクリプト・フックに導入先の決め打ちが無い"
echo "12. JEV・ECC への依存が残っていない"
sd="$here/.."
[ ! -e "$sd/scripts/jev-judge.py" ] && [ ! -e "$sd/scripts/jev-escalation.py" ] && ok "JEV のスクリプトを削除" || ng "JEV のスクリプトが残っている"
grep -qi 'jev' "$sd/SKILL.md" "$sd/scripts/run-reviews.sh" "$sd/scripts/record-gate.sh" "$sd/hooks/pre-push" && ng "JEV の記述が残っている" || ok "SKILL.md・スクリプトに JEV の記述なし"
grep -q 'commands/code-review.md\|ECC' "$sd/SKILL.md" "$sd/scripts/run-reviews.sh" && ng "ECC への依存が残っている" || ok "ECC（~/.claude/commands/code-review.md）に依存しない"

echo "13d. 差分レビューの穴（2026-10-12 の /ai-review の指摘 R1〜R5）"
mkdir -p .ai-review
# R1: 同じ HEAD で回し直しても、全体レビューの回数は増やさない
G checkout -q -b fc1 origin/main
printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
echo 1 > d1.js; echo 2 > d2.js; G add d1.js d2.js; G commit -qm big
for r in d1 d2; do  # 大きいブランチの 1 周目（規模で深掘り）と、同じ HEAD での回し直し
  AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/$r; run --out .review-reports/$r --security
  bash "$RG" --verdict pass --escalate true --escalation-done true --report .review-reports/$r/report.md >"$T/rg.out" 2>&1 || ng "$r の記録: $(cat "$T/rg.out")"
done
[ "$(jget full_count)" = "1" ] && ok "同じ HEAD の回し直しでは full_count を増やさない（R1）" || ng "full_count=$(jget full_count)"
echo 3 >> d1.js; G commit -qam fix1
AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/d3
[ "$(sget .review-reports/d3/scope.json scope)" = "incremental" ] && ok "次の周は差分レビュー" || ng "d3: $(cat .review-reports/d3/scope.json)"
rec13 .review-reports/d3 --verdict pass >/dev/null 2>&1
hook >/dev/null 2>&1 && ng "最後の全体レビューを経ずに push を通した（R1）" || ok "最後の全体レビューを経ていなければ push を止める（R1）"
# R2: 差分レビューでも、秘密情報の判定はブランチ全体で行う
G checkout -q -b sec1 origin/main
echo 1 > e1.js; echo 2 > e2.js; echo 'K=1' > .env; G add -f e1.js e2.js .env; G commit -qm withenv
AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/s1; run --out .review-reports/s1 --security
bash "$RG" --verdict pass --escalate true --escalation-done true --report .review-reports/s1/report.md >"$T/rg.out" 2>&1 || ng "s1 の記録: $(cat "$T/rg.out")"
echo 3 >> e1.js; G commit -qam e
AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/s2
[ "$(sget .review-reports/s2/scope.json scope)" = "incremental" ] || ng "s2 が差分レビューにならない: $(cat .review-reports/s2/scope.json)"
grep -q '\.env' .review-reports/s2/escalation.json && ok "差分の外の .env も secret_paths に残す（R2）" || ng "s2: $(cat .review-reports/s2/escalation.json)"
grep -q 'UNAVAILABLE codex-review' .review-reports/s2/status.txt && ok "その場合は Codex を起動しない（R2）" || ng "s2 status: $(grep -i codex .review-reports/s2/status.txt)"
# R3: 1 周目が小さく、後で上限を超えたブランチは、規模による深掘りを求める
G checkout -q -b sz1 origin/main
rm -f .ai-review/escalation-rules.local.txt
echo 1 > z1.js; G add z1.js; G commit -qm small
AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/z1; rec13 .review-reports/z1 --verdict pass >"$T/rg.out" 2>&1 || ng "z1 の記録: $(cat "$T/rg.out")"
printf 'max_files 2\n' > .ai-review/escalation-rules.local.txt
echo 2 > z2.js; echo 3 > z3.js; G add z2.js z3.js; G commit -qm grow
AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/z2
grep -q 'F:size' .review-reports/z2/escalation.json && grep -q '"escalate": *true' .review-reports/z2/escalation.json && ok "後で大きくなったブランチは規模で深掘りを求める（R3）" || ng "z2: $(cat .review-reports/z2/escalation.json) / $(cat .review-reports/z2/scope.json)"
# R5: 差分レビューでは、差分に入っていないファイルの fixed は再レビュー済みにしない
G checkout -q -b fx1 origin/main
printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
echo 1 > f1.js; echo 2 > f2.js; G add f1.js f2.js; G commit -qm big
run --out .review-reports/x1
echo '[{"id":"R1","source":"own-review","file":"f1.js","line":1,"tier":"MUST-ADDRESS","severity":"Medium","category":"correctness","summary":"f1 の不具合","high_risk":false}]' > "$T/x1-items.json"
rec13 .review-reports/x1 --verdict must-address --items "$T/x1-items.json" >/dev/null 2>&1
bash "$RI" --id R1 --fixed --note "直した（嘘）" >/dev/null 2>&1
echo 3 >> f2.js; G commit -qam unrelated
run --out .review-reports/x2; rec13 .review-reports/x2 --verdict pass >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(".review-reports/latest.json")); s={i["id"]: i["status"] for i in d["must_address"]}; sys.exit(0 if s.get("carry-R1") == "open" and "prev-R1" not in s else 1)' && ok "差分に入っていないファイルの fixed は open のまま引き継ぐ（R5）" || ng "x2: $(python3 -c 'import json; print([(i["id"], i["status"]) for i in json.load(open(".review-reports/latest.json"))["must_address"]])')"
G checkout -q -b fx2 origin/main
echo 1 > g1.js; echo 2 > g2.js; G add g1.js g2.js; G commit -qm big
run --out .review-reports/y1
sed 's/f1/g1/g' "$T/x1-items.json" > "$T/y1-items.json"
rec13 .review-reports/y1 --verdict must-address --items "$T/y1-items.json" >/dev/null 2>&1
bash "$RI" --id R1 --fixed --note "直した" >/dev/null 2>&1
echo 3 >> g1.js; G commit -qam fixg1
run --out .review-reports/y2; rec13 .review-reports/y2 --verdict pass >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(".review-reports/latest.json")); s={i["id"]: i["status"] for i in d["must_address"]}; sys.exit(0 if s.get("prev-R1") == "fixed" else 1)' && ok "差分に入ったファイルの fixed は再レビュー済みにする（R5）" || ng "y2: $(python3 -c 'import json; print([(i["id"], i["status"]) for i in json.load(open(".review-reports/latest.json"))["must_address"]])')"
rm -rf .ai-review

echo "13e. 差分レビューの穴（2 回目の /ai-review の指摘 S1〜S7）"
mkdir -p .ai-review; printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
ids(){ python3 -c 'import json; print(" ".join("%s:%s" % (i["id"], i["status"]) for i in json.load(open(".review-reports/latest.json"))["must_address"]))'; }
mk(){ printf '[{"id":"%s","source":"own-review","file":"%s","line":1,"tier":"%s","severity":"Medium","category":"%s","summary":"%s","high_risk":%s}]' "$1" "$2" "$3" "$4" "$5" "$6" > "$T/$1-$7.json"; echo "$T/$1-$7.json"; }
# S1: 深掘りを済ませていない記録とは、チェーンをつながない
G checkout -q -b e1 origin/main
echo 1 > k1.js; echo 2 > k2.js; G add k1.js k2.js; G commit -qm big
run --out .review-reports/e1a
bash "$RG" --verdict pass --escalate true --escalation-done false --report .review-reports/e1a/report.md >/dev/null 2>&1
echo 3 >> k1.js; G commit -qam e1
run --out .review-reports/e1b
[ "$(sget .review-reports/e1b/scope.json scope)" = "full" ] && ok "深掘りが済んでいない記録の次は全体レビュー（S1）" || ng "e1b: $(cat .review-reports/e1b/scope.json)"
# S2・S3: パスの形・削除で fixed を open に戻さない
G checkout -q -b e2 origin/main
echo 1 > m1.js; echo 2 > m2.js; echo 3 > m3.js; G add m1.js m2.js m3.js; G commit -qm big
run --out .review-reports/e2a
python3 - "$T/e2.json" <<'PY'
import json, sys
it = lambda i, f: {"id": i, "source": "own-review", "file": f, "line": 1, "tier": "MUST-ADDRESS", "severity": "Medium",
                   "category": "correctness", "summary": "x " + i, "high_risk": False}
json.dump([it("P1", "./m1.js"), it("P2", "m2.js")], open(sys.argv[1], "w"))
PY
rec13 .review-reports/e2a --verdict must-address --items "$T/e2.json" >/dev/null 2>&1
bash "$RI" --id P1 --fixed --note n >/dev/null 2>&1; bash "$RI" --id P2 --fixed --note n >/dev/null 2>&1
echo 4 >> m1.js; G rm -q m2.js; G commit -qam fix
run --out .review-reports/e2b; rec13 .review-reports/e2b --verdict pass >/dev/null 2>&1
case " $(ids) " in *" prev-P1:fixed "*) ok "./ 付きのパスの fixed も、差分に入っていれば再レビュー済み（S2）" ;; *) ng "S2: $(ids)" ;; esac
case " $(ids) " in *" prev-P2:fixed "*) ok "ファイルを消して直した fixed も再レビュー済み（S3）" ;; *) ng "S3: $(ids)" ;; esac
# S4: 引き継ぐ項目の ID を重ねない
G checkout -q -b e4 origin/main
echo 1 > n1.js; echo 2 > n2.js; G add n1.js n2.js; G commit -qm big
run --out .review-reports/e4a; rec13 .review-reports/e4a --verdict must-address --items "$(mk R1 n1.js MUST-ADDRESS correctness first false a)" >/dev/null 2>&1
echo 3 >> n2.js; G commit -qam e4b
run --out .review-reports/e4b; rec13 .review-reports/e4b --verdict must-address --items "$(mk R1 n2.js MUST-ADDRESS correctness second false b)" >/dev/null 2>&1
echo 4 >> n2.js; G commit -qam e4c
run --out .review-reports/e4c; rec13 .review-reports/e4c --verdict pass >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(".review-reports/latest.json")); x=[i["id"] for i in d["must_address"]]; sys.exit(0 if len(x)==len(set(x))==2 else 1)' && ok "引き継ぐ項目の ID は一意（S4）" || ng "S4: $(ids)"
# S5: 差分レビューで引き継ぐ accepted は、検証と人の承認をやり直す
G checkout -q -b e5 origin/main
echo 1 > q1.js; echo 2 > q2.js; G add q1.js q2.js; G commit -qm big
run --out .review-reports/e5a; rec13 .review-reports/e5a --verdict must-address --items "$(mk A1 q1.js MUST-ADDRESS correctness acc false a)" >/dev/null 2>&1
bash "$RI" --id A1 --accepted --reason "呼び出し元 q2.js で弾いている" >/dev/null 2>&1; bash "$RI" --id A1 --verifier upheld --note ok >/dev/null 2>&1
echo 3 >> q2.js; G commit -qam e5b
run --out .review-reports/e5b; rec13 .review-reports/e5b --verdict pass >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(".review-reports/latest.json")); a=[i for i in d["must_address"] if i["id"].endswith("A1")][0]; sys.exit(0 if a.get("verifier") == "pending" else 1)' && ok "引き継いだ accepted は検証をやり直す（S5）" || ng "S5: $(python3 -c 'import json; print(json.load(open(".review-reports/latest.json"))["must_address"])')"
# S6: BLOCK・高リスク・セキュリティの fixed の次は全体レビュー
G checkout -q -b e6 origin/main
echo 1 > r1.js; echo 2 > r2.js; G add r1.js r2.js; G commit -qm big
run --out .review-reports/e6a; rec13 .review-reports/e6a --verdict block --items "$(mk B1 r1.js BLOCK correctness blk false a)" >/dev/null 2>&1
bash "$RI" --id B1 --fixed --note n >/dev/null 2>&1
echo 3 >> r1.js; G commit -qam e6b
run --out .review-reports/e6b
[ "$(sget .review-reports/e6b/scope.json scope)" = "full" ] && ok "BLOCK の fixed の次は全体レビュー（S6）" || ng "S6: $(cat .review-reports/e6b/scope.json)"
rm -rf .ai-review
# S7: 混み合いの判定は Codex のエラー行に絞る
G checkout -q -b e7 origin/main
echo c > c7.js; G add c7.js; G commit -qm c7
AI_REVIEW_CAPACITY_WAIT=0 AI_REVIEW_DRY_FAIL="codex-review:mention" run --out .review-reports/e7
grep -q '混み合い' .review-reports/e7/status.txt && ng "at capacity を含むだけの別の失敗で回し直した（S7）" || ok "Codex の混み合いのエラー行でなければ回し直さない（S7）"

echo "13f. 差分レビューの穴（3 回目の /ai-review の指摘 T1〜T8）"
mkdir -p .ai-review; printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
# T1: run の後に重い項目を fixed にしても、差分レビューの記録では再レビュー済みにしない
G checkout -q -b f1 origin/main
echo 1 > w1.js; echo 2 > w2.js; G add w1.js w2.js; G commit -qm big
run --out .review-reports/t1a; rec13 .review-reports/t1a --verdict block --items "$(mk B1 w1.js BLOCK correctness blk false t1)" >/dev/null 2>&1
echo 3 >> w1.js; G commit -qam t1b
run --out .review-reports/t1b
bash "$RI" --id B1 --fixed --note n >/dev/null 2>&1
rec13 .review-reports/t1b --verdict pass && ng "run の後に付けた重い fixed を差分レビューで通した（T1）" || ok "重い fixed が前回にあれば、差分レビューの記録を拒む（T1）"
# T2: 規模の深掘りを求める周は、全体を見る
[ "$(sget .review-reports/z2/scope.json scope)" = "full" ] && ok "規模の深掘り（F:size）を求める周は全体レビュー（T2）" || ng "T2: $(cat .review-reports/z2/scope.json)"
# T3: 差分に入らず open に戻した fixed を、また fixed にしたら全体で確かめる
G checkout -q -b f3 origin/main
echo 1 > v1.js; echo 2 > v2.js; G add v1.js v2.js; G commit -qm big
run --out .review-reports/t3a; rec13 .review-reports/t3a --verdict must-address --items "$(mk M1 v1.js MUST-ADDRESS correctness m false t3)" >/dev/null 2>&1
bash "$RI" --id M1 --fixed --note n >/dev/null 2>&1
echo 3 >> v2.js; G commit -qam t3b
run --out .review-reports/t3b; rec13 .review-reports/t3b --verdict pass >/dev/null 2>&1
bash "$RI" --id carry-M1 --fixed --note n >/dev/null 2>&1
echo 4 >> v2.js; G commit -qam t3c
run --out .review-reports/t3c
[ "$(sget .review-reports/t3c/scope.json scope)" = "full" ] && ok "open に戻した fixed をまた fixed にしたら全体レビュー（T3）" || ng "T3: $(cat .review-reports/t3c/scope.json)"
# T4: 引き継いだ項目にも、今の高リスクの決まりを当てる
G checkout -q -b f4 origin/main
mkdir -p hr; echo 1 > hr/x.js; echo 2 > u9.js; G add hr/x.js u9.js; G commit -qm big
run --out .review-reports/t4a; rec13 .review-reports/t4a --verdict must-address --items "$(mk H1 hr/x.js MUST-ADDRESS correctness h false t4)" >/dev/null 2>&1
printf 'max_files 1\npath ^hr/\n' > .ai-review/escalation-rules.local.txt
echo 3 >> u9.js; G commit -qam t4b
run --out .review-reports/t4b; rec13 .review-reports/t4b --verdict pass >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(".review-reports/latest.json")); h=[i for i in d["must_address"] if i["id"].endswith("H1")][0]; sys.exit(0 if h["high_risk"] is True else 1)' && ok "引き継いだ項目に、後から足した path ルールの高リスクを当てる（T4）" || ng "T4: $(ids)"
printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
# T5: 日本語名のファイルを消して直した fixed も照合できる
G checkout -q -b f5 origin/main
echo 1 > 日本語.js; echo 2 > y5.js; echo 3 > y6.js; G add 日本語.js y5.js y6.js; G commit -qm big
run --out .review-reports/t5a; rec13 .review-reports/t5a --verdict must-address --items "$(mk J1 日本語.js MUST-ADDRESS correctness j false t5)" >/dev/null 2>&1
bash "$RI" --id J1 --fixed --note n >/dev/null 2>&1
G rm -q 日本語.js; G commit -qm del
git config core.quotePath true
run --out .review-reports/t5b; rec13 .review-reports/t5b --verdict pass >/dev/null 2>&1
git config --unset core.quotePath
[ "$(sget .review-reports/t5b/scope.json scope)" = "incremental" ] || ng "t5b が差分レビューにならない: $(cat .review-reports/t5b/scope.json)"
case " $(ids) " in *" prev-J1:fixed "*) ok "日本語名のファイルを消して直した fixed も再レビュー済み（T5）" ;; *) ng "T5: $(ids)" ;; esac
# T5n: 改行・末尾の空白・:行番号 を含む名前のファイルで、fixed のファイルが「差分にある」と見せかけない（ai-review#5 の 8）
G checkout -q -b f8 origin/main
echo 1 > n8.js; echo 2 > n9.js; G add n8.js n9.js; G commit -qm big
run --out .review-reports/t5n1; rec13 .review-reports/t5n1 --verdict must-address --items "$(mk N1 n8.js MUST-ADDRESS correctness n false t5n)" >/dev/null 2>&1
bash "$RI" --id N1 --fixed --note "直した（嘘）" >/dev/null 2>&1
nlname="$(printf 'n8.js\nzz')"
echo x > "$nlname"; echo x > 'n8.js '; echo x > 'n8.js:12'; G add -- "$nlname" 'n8.js ' 'n8.js:12'; G commit -qm trick
run --out .review-reports/t5n2; rec13 .review-reports/t5n2 --verdict pass >/dev/null 2>&1
[ "$(sget .review-reports/t5n2/scope.json scope)" = "incremental" ] || ng "t5n2 が差分レビューにならない: $(cat .review-reports/t5n2/scope.json)"
case " $(ids) " in *" carry-N1:open "*) ok "改行・空白・:行番号 を含む名前のファイルでは、別のファイルの fixed を再レビュー済みにしない（T5n）" ;; *) ng "T5n: $(ids)" ;; esac
# 逆向き: 変わった名前のファイルに付いた fixed を、普通の名前のファイルや CR と LF だけが違うファイルの変更で
# 再レビュー済みにしない。実在しない「v8.js:3」のような書き方の揺れは、これまでどおり v8.js と照合する。
# 書き方の揺れ（u8.js:3）と同じ名前のファイルを差分に足しても、u8.js の fixed を片づけたことにしない
G checkout -q -b f9 origin/main
lfname="$(printf 'c8\nzz.js')"; crname="$(printf 'c8\rzz.js')"
echo 1 > w8.js; echo 2 > 'w8.js:12'; echo 3 > "$lfname"; echo 4 > v8.js; echo 5 > u8.js; G add -- w8.js 'w8.js:12' "$lfname" v8.js u8.js; G commit -qm big
python3 - "$T/t5r.json" <<'PY'
import json, sys
it = lambda i, f: {"id": i, "source": "own-review", "file": f, "line": 1, "tier": "MUST-ADDRESS", "severity": "Medium",
                   "category": "correctness", "summary": "x " + i, "high_risk": False}
json.dump([it("B1", "w8.js:12"), it("C1", "c8\nzz.js"), it("V1", "v8.js:3"), it("U1", "u8.js:3")], open(sys.argv[1], "w"))
PY
run --out .review-reports/t5r1; rec13 .review-reports/t5r1 --verdict must-address --items "$T/t5r.json" >/dev/null 2>&1
for i in B1 C1 V1 U1; do bash "$RI" --id $i --fixed --note "直した" >/dev/null 2>&1; done
echo 5 >> w8.js; echo 6 > "$crname"; echo 7 >> v8.js; echo 8 > 'u8.js:3'; G add -- w8.js "$crname" v8.js 'u8.js:3'; G commit -qm trick2
run --out .review-reports/t5r2; rec13 .review-reports/t5r2 --verdict pass >/dev/null 2>&1
[ "$(sget .review-reports/t5r2/scope.json scope)" = "incremental" ] || ng "t5r2 が差分レビューにならない: $(cat .review-reports/t5r2/scope.json)"
case " $(ids) " in *" carry-B1:open "*) ok "実在する w8.js:12 の fixed を、w8.js の変更で再レビュー済みにしない（T5n）" ;; *) ng "T5n（:行番号の逆向き）: $(ids)" ;; esac
case " $(ids) " in *" carry-C1:open "*) ok "LF を含む名前の fixed を、CR だけが違う名前の変更で再レビュー済みにしない（T5n）" ;; *) ng "T5n（CR と LF）: $(ids)" ;; esac
case " $(ids) " in *" prev-V1:fixed "*) ok "実在しない v8.js:3 は v8.js と照合し、変更があれば再レビュー済みにする（T5n）" ;; *) ng "T5n（書き方の揺れ）: $(ids)" ;; esac
case " $(ids) " in *" carry-U1:open "*) ok "書き方の揺れ u8.js:3 と同じ名前のファイルを足しても、u8.js の fixed を再レビュー済みにしない（T5n）" ;; *) ng "T5n（揺れと同名のファイル）: $(ids)" ;; esac
# 2 周に分けても同じ: 引き継いだ項目が指すファイルは、項目を最初に記録した周の木で決める（直前の周の木ではない）
G checkout -q -b f10 origin/main
echo 1 > x8.js; echo 2 > x9.js; G add x8.js x9.js; G commit -qm big
run --out .review-reports/t5s1; rec13 .review-reports/t5s1 --verdict must-address --items "$(mk X1 'x8.js:12' MUST-ADDRESS correctness x false t5s)" >/dev/null 2>&1
echo 3 > 'x8.js:12'; G add -- 'x8.js:12'; G commit -qm add-decoy
run --out .review-reports/t5s2; rec13 .review-reports/t5s2 --verdict pass >/dev/null 2>&1
bash "$RI" --id carry-X1 --fixed --note "直した（嘘）" >/dev/null 2>&1
echo 4 >> 'x8.js:12'; G add -- 'x8.js:12'; G commit -qm touch-decoy
run --out .review-reports/t5s3; rec13 .review-reports/t5s3 --verdict pass >/dev/null 2>&1
[ "$(sget .review-reports/t5s3/scope.json scope)" = "incremental" ] || ng "t5s3 が差分レビューにならない: $(cat .review-reports/t5s3/scope.json)"
case " $(ids) " in *" carry-X1:open "*) ok "間の周に足した同名のファイルで、引き継いだ項目の指す先をすり替えさせない（T5n）" ;; *) ng "T5n（2 周に分けたすり替え）: $(ids)" ;; esac
# T6・T7: 引き継ぎだけでも must-address で記録でき、同じ run を記録し直せる
G checkout -q -b f6 origin/main
echo 1 > s1.js; echo 2 > s2.js; G add s1.js s2.js; G commit -qm big
run --out .review-reports/t6a; rec13 .review-reports/t6a --verdict must-address --items "$(mk O1 s1.js MUST-ADDRESS correctness o false t6)" >/dev/null 2>&1
echo 3 >> s2.js; G commit -qam t6b
run --out .review-reports/t6b
rec13 .review-reports/t6b --verdict must-address && ok "引き継ぎだけでも must-address で記録できる（T6）" || ng "T6: $(cat "$T/rg.out")"
rec13 .review-reports/t6b --verdict must-address && case " $(ids) " in *" carry-O1:open "*) ok "同じ差分レビューの run を記録し直せ、引き継ぎも残る（T7）" ;; *) ng "T7 の引き継ぎ: $(ids)" ;; esac || ng "T7: $(cat "$T/rg.out")"
rm -rf .ai-review
# T8: 混み合いの判定は pipefail の下でも正しく真になる
grep -q "grep -qE '^(ERROR|error)" "$RR" && ng "tail | grep -q のまま（T8）" || ok "混み合いの判定で grep -q をパイプの後ろに置かない（T8）"

echo "13g. 差分レビューの穴（4 回目の /ai-review の指摘 U1〜U4）"
mkdir -p .ai-review; printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
# U1: fixed で引き継ぐ項目にも今の高リスクの決まりを当て、高リスクなら全体で確かめる
G checkout -q -b g1 origin/main
mkdir -p hq; echo 1 > hq/a.js; echo 2 > g9.js; G add hq/a.js g9.js; G commit -qm big
run --out .review-reports/u1a; rec13 .review-reports/u1a --verdict must-address --items "$(mk L1 hq/a.js MUST-ADDRESS correctness l false u1)" >/dev/null 2>&1
bash "$RI" --id L1 --fixed --note n >/dev/null 2>&1
printf 'max_files 1\npath ^hq/\n' > .ai-review/escalation-rules.local.txt
echo 3 >> hq/a.js; G commit -qam u1b
run --out .review-reports/u1b
[ "$(sget .review-reports/u1b/scope.json scope)" = "full" ] && ok "後から高リスクになった fixed の次は全体レビュー（U1）" || ng "U1: $(cat .review-reports/u1b/scope.json)"
printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
# U2: 予備の処理が失敗しても Codex を止める
grep -q 'secret_full_failed=1' "$RR" && grep -q 'secret_full_failed' "$RR" && ok "ブランチ全体の秘密情報の判定に失敗したら、シェルの側で Codex を止める（U2）" || ng "U2: 止める処理が無い"
# U3: 同じ HEAD の全体レビューの run を記録し直せる（深掘りを後から済ませた場合）
G checkout -q -b g3 origin/main
echo 1 > g31.js; echo 2 > g32.js; G add g31.js g32.js; G commit -qm big
run --out .review-reports/u3a; rec13 .review-reports/u3a --verdict pass >/dev/null 2>&1
echo 3 >> g31.js; G commit -qam u3b
run --out .review-reports/u3b; rec13 .review-reports/u3b --verdict pass >/dev/null 2>&1
run --out .review-reports/u3c
[ "$(sget .review-reports/u3c/scope.json scope)" = "full" ] || ng "u3c が全体にならない: $(cat .review-reports/u3c/scope.json)"
bash "$RG" --verdict pass --escalate true --escalation-done false --report .review-reports/u3c/report.md >/dev/null 2>&1
run --out .review-reports/u3c --security
bash "$RG" --verdict pass --escalate true --escalation-done true --report .review-reports/u3c/report.md >"$T/rg.out" 2>&1 && [ "$(jget full_count)" = "2" ] && ok "深掘りを後から済ませて、同じ全体レビューを記録し直せる（U3）" || ng "U3: $(cat "$T/rg.out") full_count=$(jget full_count)"
rm -rf .ai-review
# U4: 差分レビューの起点が違うときは、そのことを言う
grep -q '差分レビューの起点' "$RG" && ok "差分レビューの起点が違うときのエラー文を分ける（U4）" || ng "U4: エラー文が分かれていない"

echo "13h. 1 段前の記録（_previous）まわり（5 回目の /ai-review の指摘 V1〜V3）"
mkdir -p .ai-review; printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
# V1: つながらなかった記録は、記録し直しのつなぎ先にしない
G checkout -q -b h1 origin/main
echo 1 > o1.js; echo 2 > o2.js; G add o1.js o2.js; G commit -qm big
run --out .review-reports/v1a; rec13 .review-reports/v1a --verdict pass >/dev/null 2>&1
G checkout -q -b h1b origin/main
echo 1 > o3.js; echo 2 > o4.js; G add o3.js o4.js; G commit -qm other
run --out .review-reports/v1b; rec13 .review-reports/v1b --verdict pass >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(".review-reports/latest.json")); p=d.get("_previous"); p=json.loads(p) if isinstance(p,str) and p else p; sys.exit(0 if not p else 1)' && ok "つながらなかった前の記録は _previous に残さない（V1）" || ng "V1: $(python3 -c 'import json; print(json.load(open(".review-reports/latest.json")).get("_previous"))' | head -c 200)"
# V2: _previous の中のキーを pre-push が拾わない
G checkout -q -b h2 origin/main
echo 1 > o5.js; echo 2 > o6.js; G add o5.js o6.js; G commit -qm big
run --out .review-reports/v2a; rec13 .review-reports/v2a --verdict pass >/dev/null 2>&1
echo 3 >> o5.js; G commit -qam v2b
run --out .review-reports/v2b; rec13 .review-reports/v2b --verdict pass >/dev/null 2>&1
python3 -c 'import json,sys; d=json.load(open(".review-reports/latest.json")); sys.exit(0 if isinstance(d.get("_previous"), str) and json.loads(d["_previous"]).get("head_sha") else 1)' && ok "_previous は JSON の文字列で持つ（入れ子のキーを pre-push の grep が拾わない）（V2）" || ng "V2: $(python3 -c 'import json; print(type(json.load(open(".review-reports/latest.json")).get("_previous")))')"
! grep -q '^    "dry_run"\|^  "_previous": {' .review-reports/latest.json && ok "記録の入れ子に dry_run のキーが出ない（V2）" || ng "V2: 入れ子のキー"
# V3: サブディレクトリから相対パスで記録しても、同じ run だと分かる
mkdir -p sub; ( cd sub && bash "$RG" --verdict pass --escalate false --escalation-done false --report ../.review-reports/v2b/report.md >"$T/rg.out" 2>&1 ) && ok "サブディレクトリから相対パスで同じ run を記録し直せる（V3）" || ng "V3: $(cat "$T/rg.out")"
rm -rf .ai-review sub

echo "13i. 6 回目の /ai-review の指摘 W1〜W4"
mkdir -p .ai-review; printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
# W1: レビュアーが全部失敗した記録とはチェーンをつながない
G checkout -q -b i1 origin/main
echo 1 > a91.js; echo 2 > a92.js; G add a91.js a92.js; G commit -qm big
run --out .review-reports/w1a; rec13 .review-reports/w1a --verdict pass >/dev/null 2>&1
python3 - <<'PY'
import json
p = ".review-reports/latest.json"; d = json.load(open(p))
d["sources"] = {"_none": {"level": "block", "detail": "全部未取得"}}; d["verdict"] = "block"
json.dump(d, open(p, "w"))
PY
echo 3 >> a91.js; G commit -qam w1b
run --out .review-reports/w1b
[ "$(sget .review-reports/w1b/scope.json scope)" = "full" ] && ok "レビュアーが全部失敗した記録の次は全体レビュー（W1）" || ng "W1: $(cat .review-reports/w1b/scope.json)"
# W2: 同じ出力先で回し直した run は、記録し直しとして扱わない
G checkout -q -b i2 origin/main
echo 1 > a93.js; echo 2 > a94.js; G add a93.js a94.js; G commit -qm big
AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/w2a; run --out .review-reports/w2a --security
bash "$RG" --verdict pass --escalate true --escalation-done true --report .review-reports/w2a/report.md >"$T/rg.out" 2>&1 || ng "w2a の記録: $(cat "$T/rg.out")"
sleep 1; AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/w2a; run --out .review-reports/w2a --security
grep -q '"size_skipped": *true' .review-reports/w2a/escalation.json || ng "w2a の回し直しで規模の判定を飛ばしていない: $(cat .review-reports/w2a/escalation.json)"
bash "$RG" --verdict pass --escalate true --escalation-done true --report .review-reports/w2a/report.md >"$T/rg.out" 2>&1 && ok "同じ出力先で回し直した run も記録できる（W2）" || ng "W2: $(cat "$T/rg.out")"
# W4: 記録し直しでも、その間に付けた処理を残す
G checkout -q -b i4 origin/main
echo 1 > a95.js; echo 2 > a96.js; G add a95.js a96.js; G commit -qm big
run --out .review-reports/w4a
rec13 .review-reports/w4a --verdict must-address --items "$(mk Q1 a95.js MUST-ADDRESS correctness q false w4)" >/dev/null 2>&1
bash "$RI" --id Q1 --accepted --reason "a96.js で弾いている" >/dev/null 2>&1
rec13 .review-reports/w4a --verdict must-address --items "$T/Q1-w4.json" >/dev/null 2>&1
case " $(ids) " in *" Q1:accepted "*) ok "記録し直しでも、付けた accepted を残す（W4）" ;; *) ng "W4: $(ids)" ;; esac
# W3: 差分レビューの記録は、効いている pre-push が対応しているときだけ受け付ける
G checkout -q -b i3 origin/main
echo 1 > a97.js; echo 2 > a98.js; G add a97.js a98.js; G commit -qm big
run --out .review-reports/w3a; rec13 .review-reports/w3a --verdict pass >/dev/null 2>&1
echo 3 >> a97.js; G commit -qam w3b
run --out .review-reports/w3b
mkdir -p "$T/oldhooks"; printf '#!/bin/sh\n# ai-review-managed-hook\n# 古いフック（全体レビューの回数を見ない）\nexit 0\n' > "$T/oldhooks/pre-push"; chmod +x "$T/oldhooks/pre-push"
git config core.hooksPath "$T/oldhooks"
rec13 .review-reports/w3b --verdict pass && ng "古い pre-push のまま差分レビューを記録した（W3）" || ok "古い pre-push では差分レビューを記録しない（W3）"
grep -q 'pre-push' "$T/rg.out" && ok "pre-push の入れ替えを案内する（W3）" || ng "W3 の案内: $(cat "$T/rg.out")"
cp "$HOOK" "$T/oldhooks/pre-push"
rec13 .review-reports/w3b --verdict pass && ok "対応した pre-push なら記録できる（W3）" || ng "W3（新しいフック）: $(cat "$T/rg.out")"
git config --unset core.hooksPath
rm -rf .ai-review

echo "13j. 7 回目の /ai-review の指摘 X1〜X3"
mkdir -p .ai-review; printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
# X1: 記録し直しでも、引き継いだ項目に付けた処理を残す
G checkout -q -b j1 origin/main
echo 1 > b11.js; echo 2 > b12.js; G add b11.js b12.js; G commit -qm big
run --out .review-reports/x1a; rec13 .review-reports/x1a --verdict must-address --items "$(mk C1 b11.js MUST-ADDRESS correctness c false x1)" >/dev/null 2>&1
echo 3 >> b12.js; G commit -qam x1b
run --out .review-reports/x1b; rec13 .review-reports/x1b --verdict must-address >/dev/null 2>&1
bash "$RI" --id carry-C1 --accepted --reason "b12.js で弾いている" >/dev/null 2>&1
rec13 .review-reports/x1b --verdict must-address >/dev/null 2>&1
case " $(ids) " in *" carry-C1:accepted "*) ok "記録し直しでも、引き継いだ項目の accepted を残す（X1）" ;; *) ng "X1: $(ids)" ;; esac
# X2: ai-review 以外のフックは「古い ai-review のフック」と取り違えない
echo 4 >> b12.js; G commit -qam x2
run --out .review-reports/x2
mkdir -p "$T/huskyhooks"; printf '#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\nnpx lint-staged\n' > "$T/huskyhooks/pre-push"
git config core.hooksPath "$T/huskyhooks"
rec13 .review-reports/x2 --verdict must-address && ok "ai-review 以外のフックなら、差分レビューの記録を拒まない（X2）" || ng "X2: $(cat "$T/rg.out")"
git config --unset core.hooksPath
# X3: --report にファイル名だけを渡しても、同じ run だと分かる
echo 5 >> b12.js; G commit -qam x3
run --out .review-reports/x3; ( cd .review-reports/x3 && bash "$RG" --verdict must-address --escalate false --escalation-done false --report report.md >"$T/rg.out" 2>&1 ) || ng "x3 の 1 回目: $(cat "$T/rg.out")"
( cd .review-reports/x3 && bash "$RG" --verdict must-address --escalate false --escalation-done false --report report.md >"$T/rg.out" 2>&1 ) && ok "--report にファイル名だけでも、同じ run を記録し直せる（X3）" || ng "X3: $(cat "$T/rg.out")"
rm -rf .ai-review

echo "13k. 混み合いの回し直しは 1 回だけ（8 回目の /ai-review の指摘 Y1）"
G checkout -q -b k1 origin/main
echo c > k91.js; G add k91.js; G commit -qm k1
AI_REVIEW_CAPACITY_WAIT=0 AI_REVIEW_DRY_FAIL="codex-review:capacity" AI_REVIEW_DRY_FAIL_RETRY=empty run --out .review-reports/y1
[ "$(grep -c '^retry codex-review' .review-reports/y1/status.txt)" = "1" ] && ok "混み合いの回し直しが空の出力でも、空出力の回し直しを重ねない（Y1）" || ng "Y1: $(grep '^retry' .review-reports/y1/status.txt)"

echo "13l. 9 回目の /ai-review の指摘 Z1・Z2"
mkdir -p .ai-review
# Z1: 規模の深掘りをユーザーが飛ばしたら、次の周から求め続けない
G checkout -q -b l1 origin/main
echo 1 > l11.js; G add l11.js; G commit -qm small
AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/z1a; rec13 .review-reports/z1a --verdict pass >/dev/null 2>&1
printf 'max_files 2\n' > .ai-review/escalation-rules.local.txt
echo 2 > l12.js; echo 3 > l13.js; G add l12.js l13.js; G commit -qm grow
AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/z1b
bash "$RG" --verdict pass --escalate true --escalation-done false --skipped-by-user true --reason "ユーザーが規模の深掘りを飛ばす" --report .review-reports/z1b/report.md >"$T/rg.out" 2>&1 || ng "z1b の記録: $(cat "$T/rg.out")"
echo 4 >> l12.js; G commit -qam z1c
AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/z1c
[ "$(sget .review-reports/z1c/scope.json force_reason)" != "size" ] && ok "ユーザーが飛ばした規模の深掘りは、次の周から求め続けない（Z1）" || ng "Z1: $(cat .review-reports/z1c/scope.json)"
# Z2: 実行権の無い pre-push は、効いているフックとして扱わない
printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
G checkout -q -b l2 origin/main
echo 1 > l21.js; echo 2 > l22.js; G add l21.js l22.js; G commit -qm big
run --out .review-reports/z2a; rec13 .review-reports/z2a --verdict pass >/dev/null 2>&1
echo 3 >> l21.js; G commit -qam z2b
run --out .review-reports/z2b
mkdir -p "$T/noexec"; cp "$HOOK" "$T/noexec/pre-push"; chmod -x "$T/noexec/pre-push"
git config core.hooksPath "$T/noexec"
rec13 .review-reports/z2b --verdict pass; grep -q '実行権' "$T/rg.out" && ok "実行権の無い pre-push はゲートが効いていないと注意する（Z2）" || ng "Z2: $(cat "$T/rg.out")"
git config --unset core.hooksPath
rm -rf .ai-review

echo "13m. 10 回目の /ai-review の指摘 AA1〜AA3"
# AA1: 小さいブランチでは、2 周目以降の全体レビューに深掘りを強制しない
G checkout -q -b m1 origin/main
echo 1 > m11.js; G add m11.js; G commit -qm small
run --out .review-reports/aa1a; run --out .review-reports/aa1a --security
bash "$RG" --verdict pass --escalate true --escalation-done true --report .review-reports/aa1a/report.md >"$T/rg.out" 2>&1 || ng "aa1a の記録: $(cat "$T/rg.out")"
echo 2 >> m11.js; G commit -qam aa1b
run --out .review-reports/aa1b
[ "$(sget .review-reports/aa1b/scope.json force_escalation)" = "false" ] && ok "小さいブランチの 2 周目の全体レビューには深掘りを強制しない（AA1）" || ng "AA1: $(cat .review-reports/aa1b/scope.json)"
rec13 .review-reports/aa1b --verdict pass && ok "その周は深掘りなしで記録できる（AA1）" || ng "AA1 の記録: $(cat "$T/rg.out")"
# AA2: --local の記録はチェーンの検査に入れない
echo 3 >> m11.js
run --out .review-reports/aa2 --local
bash "$RG" --verdict pass --escalate false --escalation-done false --report .review-reports/aa2/report.md --mode local >"$T/rg.out" 2>&1 && ok "--local の記録は、深掘りが要る全体レビューとして拒まない（AA2）" || ng "AA2: $(cat "$T/rg.out")"
G checkout -q -- m11.js
# AA3: pre-push の案内は、未処理の項目があれば先に片づけるように言う
grep -q '未処理の項目があれば' "$HOOK" && ok "差分レビューの拒否の案内に、未処理の項目を先に片づけることを書く（AA3）" || ng "AA3: 案内が直っていない"

echo "13n. 11 回目の /ai-review の指摘 BB1・BB2"
mkdir -p .ai-review; printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
# BB1: 差分レビューの途中で --local を記録しても、次の branch のレビューはチェーンにつながる
G checkout -q -b n1 origin/main
echo 1 > n91.js; echo 2 > n92.js; G add n91.js n92.js; G commit -qm big
run --out .review-reports/bb1a; rec13 .review-reports/bb1a --verdict pass >/dev/null 2>&1
echo 3 >> n91.js
run --out .review-reports/bb1l --local
bash "$RG" --verdict pass --escalate false --escalation-done false --report .review-reports/bb1l/report.md --mode local >"$T/rg.out" 2>&1 || ng "bb1l の記録: $(cat "$T/rg.out")"
G commit -qam bb1b
run --out .review-reports/bb1b
[ "$(sget .review-reports/bb1b/scope.json scope)" = "incremental" ] && ok "--local の記録を挟んでも、次の branch のレビューは差分レビューにつながる（BB1）" || ng "BB1: $(cat .review-reports/bb1b/scope.json)"
rec13 .review-reports/bb1b --verdict pass >"$T/rg.out" 2>&1 && [ "$(jget full_count)" = "1" ] && ok "full_count も数え直さない（BB1）" || ng "BB1 の記録: $(cat "$T/rg.out") full_count=$(jget full_count)"
# BB2: つながっていない記録を記録し直しても、prev- の項目を残す
G checkout -q -b n2 origin/main
echo 1 > n93.js; echo 2 > n94.js; G add n93.js n94.js; G commit -qm big
run --out .review-reports/bb2a
bash "$RG" --verdict must-address --items "$(mk F1 n93.js MUST-ADDRESS correctness f false bb2)" --escalate true --escalation-done false --report .review-reports/bb2a/report.md >/dev/null 2>&1  # 深掘りを済ませていない（次とつながらない）記録
bash "$RI" --id F1 --fixed --note n >/dev/null 2>&1
echo 3 >> n93.js; G commit -qam bb2b
run --out .review-reports/bb2b --full; rec13 .review-reports/bb2b --verdict pass >/dev/null 2>&1
case " $(ids) " in *" prev-F1:fixed "*) : ;; *) ng "bb2b の前提: $(ids)" ;; esac
rec13 .review-reports/bb2b --verdict pass >/dev/null 2>&1
case " $(ids) " in *" prev-F1:fixed "*) ok "記録し直しても prev- の項目を残す（BB2）" ;; *) ng "BB2: $(ids)" ;; esac
rm -rf .ai-review

echo "13o. 12 回目の /ai-review の指摘 CC1〜CC3"
mkdir -p .ai-review; printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
# CC1: --local を挟んでも、同じ branch の run を記録し直せる
G checkout -q -b o1 origin/main
echo 1 > o91.js; echo 2 > o92.js; G add o91.js o92.js; G commit -qm big
run --out .review-reports/cc1a; rec13 .review-reports/cc1a --verdict pass >/dev/null 2>&1
echo 3 >> o91.js; G commit -qam cc1b
run --out .review-reports/cc1b; rec13 .review-reports/cc1b --verdict pass >/dev/null 2>&1
echo 4 >> o92.js
run --out .review-reports/cc1l --local
bash "$RG" --verdict pass --escalate false --escalation-done false --report .review-reports/cc1l/report.md --mode local >/dev/null 2>&1
G checkout -q -- o92.js
rec13 .review-reports/cc1b --verdict pass && ok "--local を挟んでも、同じ差分レビューの run を記録し直せる（CC1）" || ng "CC1: $(cat "$T/rg.out")"
# CC2: 古い ai-review のフックは、実行権が無くても差分レビューの記録を拒む
G checkout -q -b o2 origin/main
echo 1 > o95.js; echo 2 > o96.js; G add o95.js o96.js; G commit -qm big
run --out .review-reports/cc2a; rec13 .review-reports/cc2a --verdict pass >/dev/null 2>&1
echo 3 >> o95.js; G commit -qam cc2
run --out .review-reports/cc2
[ "$(sget .review-reports/cc2/scope.json scope)" = "incremental" ] || ng "cc2 が差分レビューにならない: $(cat .review-reports/cc2/scope.json)"
mkdir -p "$T/oldnoexec"; printf '#!/bin/sh\n# ai-review-managed-hook\nexit 0\n' > "$T/oldnoexec/pre-push"; chmod -x "$T/oldnoexec/pre-push"
git config core.hooksPath "$T/oldnoexec"
rec13 .review-reports/cc2 --verdict pass && ng "実行権の無い古いフックのまま差分レビューを記録した（CC2）" || ok "古い ai-review のフックは、実行権が無くても差分レビューの記録を拒む（CC2）"
git config --unset core.hooksPath
# CC3: 昇格が求められていない記録の --skipped-by-user では、規模の深掘りを済んだ扱いにしない
G checkout -q -b o3 origin/main
rm -f .ai-review/escalation-rules.local.txt
echo 1 > o93.js; G add o93.js; G commit -qm small
AI_REVIEW_DRY_ESCALATION=real run --out .review-reports/cc3a
bash "$RG" --verdict pass --escalate false --escalation-done false --skipped-by-user true --reason r --report .review-reports/cc3a/report.md >/dev/null 2>&1
[ "$(jget chain_size_escalated)" = "false" ] && ok "昇格が求められていない記録の --skipped-by-user では、規模の深掘りを済んだ扱いにしない（CC3）" || ng "CC3: chain_size_escalated=$(jget chain_size_escalated)"
# DD1: 引き継げる BLOCK の項目が無い block の記録の次は、チェーンを保ったまま全体レビューにする（ai-review#5 の 9）。
# 差分レビューが引き継ぐのは項目だけなので、差分にすると block が消え、差分で何も出なければ pass で push できてしまう
printf 'max_files 1\n' > .ai-review/escalation-rules.local.txt
G checkout -q -b d91 origin/main
echo 1 > d91.js; echo 2 > d92.js; G add d91.js d92.js; G commit -qm big
run --out .review-reports/dd1a; rec13 .review-reports/dd1a --verdict pass
echo 3 >> d91.js; G commit -qam dd1b
run --out .review-reports/dd1b; rec13 .review-reports/dd1b --verdict pass
run --out .review-reports/dd1c; rec13 .review-reports/dd1c --verdict block
[ "$(jget verdict)" = "block" ] && [ "$(jget full_count)" = "2" ] || ng "DD1 の準備: verdict=$(jget verdict) full_count=$(jget full_count) $(cat "$T/rg.out")"
hd1c="$(git rev-parse HEAD)"; cp "$latest" "$T/dd1c.json"
echo 4 >> d91.js; G commit -qam dd1d
run --out .review-reports/dd1d
[ "$(sget .review-reports/dd1d/scope.json scope)" = "full" ] && [ "$(sget .review-reports/dd1d/scope.json no_size)" = "true" ] && grep -q '引き継げる BLOCK' .review-reports/dd1d/scope.json \
  && ok "BLOCK の項目が無い block の記録の次は、チェーンを保ったまま全体レビュー（DD1）" || ng "DD1: $(cat .review-reports/dd1d/scope.json)"
printf '{"scope": "incremental", "since": "%s"}' "$hd1c" > .review-reports/dd1d/scope.json
echo "$hd1c" > .review-reports/dd1d/reviewed_base.review
if rec13 .review-reports/dd1d --verdict pass; then
  hook && ng "BLOCK の項目が無い block の記録につないだ差分レビューが pass になり、push を通した（DD1）" || ng "BLOCK の項目が無い block の記録につないで差分レビューを記録できた（DD1）"
else
  grep -q '引き継げる BLOCK の項目がありません' "$T/rg.out" && ok "BLOCK の項目が無い block の記録につなぐ差分レビューは記録しない（DD1）" || ng "DD1 の記録が別の理由で止まった: $(cat "$T/rg.out")"
fi
# 再レビュー済みの fixed（引き継がれない）しか BLOCK の項目が無い block の記録も同じ
cp "$T/dd1c.json" "$latest"
python3 - "$latest" "$hd1c" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
d["must_address"] = [{"id": "prev-B0", "source": "own-review", "file": "d91.js", "line": 1, "tier": "BLOCK", "severity": "High",
                      "summary": "x", "high_risk": False, "category": "correctness", "status": "fixed", "re_reviewed_sha": sys.argv[2]}]
json.dump(d, open(p, "w"), ensure_ascii=False, indent=2)
PY
run --out .review-reports/dd1e
[ "$(sget .review-reports/dd1e/scope.json scope)" = "full" ] && ok "BLOCK の項目が再レビュー済みの fixed だけの block の記録の次も全体レビュー（DD1）" || ng "DD1（再レビュー済み）: $(cat .review-reports/dd1e/scope.json)"
printf '{"scope": "incremental", "since": "%s"}' "$hd1c" > .review-reports/dd1e/scope.json
echo "$hd1c" > .review-reports/dd1e/reviewed_base.review
if rec13 .review-reports/dd1e --verdict pass; then
  ng "BLOCK の項目が再レビュー済みの fixed だけの block の記録につないで差分レビューを記録できた（DD1）"
else
  grep -q '引き継げる BLOCK の項目がありません' "$T/rg.out" && ok "BLOCK の項目が再レビュー済みの fixed だけの block の記録につなぐ差分レビューも記録しない（DD1）" || ng "DD1（再レビュー済み）の記録が別の理由で止まった: $(cat "$T/rg.out")"
fi
# 未再レビューの fixed の BLOCK は持ち越す扱いだが、heavy_fixed で全体レビューになる（block は消えない）
cp "$T/dd1c.json" "$latest"
python3 - "$latest" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
d["must_address"] = [{"id": "B0", "source": "own-review", "file": "d91.js", "line": 1, "tier": "BLOCK", "severity": "High",
                      "summary": "x", "high_risk": False, "category": "correctness", "status": "fixed"}]
json.dump(d, open(p, "w"), ensure_ascii=False, indent=2)
PY
run --out .review-reports/dd1f
[ "$(sget .review-reports/dd1f/scope.json scope)" = "full" ] && grep -q 'fixed にしたので' .review-reports/dd1f/scope.json && ok "BLOCK の項目が未再レビューの fixed の block の記録の次は、heavy_fixed で全体レビュー（DD1）" || ng "DD1（未再レビュー）: $(cat .review-reports/dd1f/scope.json)"
# 全体に戻しても、1 周目の深掘りの義務（chain_escalated）は残り、最後の全体レビューに深掘りを強制する
G checkout -q -b d93 origin/main
echo 1 > d95.js; echo 2 > d96.js; G add d95.js d96.js; G commit -qm big
run --out .review-reports/dd3a
bash "$RG" --verdict pass --escalate true --escalation-done false --skipped-by-user true --reason r --report .review-reports/dd3a/report.md >"$T/rg.out" 2>&1
[ "$(jget chain_escalated)" = "true" ] || ng "DD1 の準備（深掘り）: chain_escalated=$(jget chain_escalated) $(cat "$T/rg.out")"
echo 3 >> d95.js; G commit -qam dd3b
run --out .review-reports/dd3b; rec13 .review-reports/dd3b --verdict block
[ "$(jget scope)" = "incremental" ] && [ "$(jget verdict)" = "block" ] || ng "DD1 の準備（差分の block）: scope=$(jget scope) verdict=$(jget verdict) $(cat "$T/rg.out")"
echo 4 >> d96.js; G commit -qam dd3c
run --out .review-reports/dd3c
[ "$(sget .review-reports/dd3c/scope.json scope)" = "full" ] && [ "$(sget .review-reports/dd3c/scope.json force_escalation)" = "true" ] && [ "$(sget .review-reports/dd3c/scope.json force_reason)" = "chain" ] \
  && ok "BLOCK の項目が無い差分の block の次の全体レビューにも、1 周目の深掘りを強制する（DD1）" || ng "DD1（深掘りの義務）: $(cat .review-reports/dd3c/scope.json)"
# 引き継げる BLOCK の項目がある block の記録とは、これまでどおりつなぎ、block を項目ごと引き継ぐ
G checkout -q -b d92 origin/main
echo 1 > d93.js; echo 2 > d94.js; G add d93.js d94.js; G commit -qm big
run --out .review-reports/dd2a
itb="$(items '[{"id":"B1","source":"own-review","file":"d93.js","line":1,"tier":"BLOCK","severity":"High","summary":"入力を検査していない","high_risk":false,"category":"correctness"}]')"
rec13 .review-reports/dd2a --verdict block --items "$itb" || ng "DD1 の準備（BLOCK の項目あり）: $(cat "$T/rg.out")"
echo 3 >> d94.js; G commit -qam dd2b
run --out .review-reports/dd2b
rec13 .review-reports/dd2b --verdict pass
[ "$(sget .review-reports/dd2b/scope.json scope)" = "incremental" ] && [ "$(jget verdict)" = "block" ] && jget must_address | grep -q '"carry-B1"' \
  && ok "未処理の BLOCK の項目がある block の記録には差分レビューでつなぎ、block を引き継ぐ（DD1）" || ng "DD1（BLOCK の項目あり）: $(cat .review-reports/dd2b/scope.json) verdict=$(jget verdict) $(cat "$T/rg.out")"
rm -rf .ai-review

echo "13c. Codex の混み合い（at capacity）は、待ってから 1 回だけ回し直す"
G checkout -q -b cap1 origin/main
echo 'c' > c1.js; G add c1.js; G commit -qm cap
export AI_REVIEW_CAPACITY_WAIT=0
AI_REVIEW_DRY_FAIL="codex-review:capacity" run --out .review-reports/c1
grep -q '^retry codex-review .*混み合い' .review-reports/c1/status.txt && ok "混み合いなら回し直す" || ng "c1: $(cat .review-reports/c1/status.txt)"
grep -q '^ok codex-review' .review-reports/c1/status.txt && [ -s .review-reports/c1/codex-review.md ] && ok "回し直しが通れば、その出力を使う" || ng "c1 の結果: $(grep codex-review .review-reports/c1/status.txt)"
AI_REVIEW_DRY_FAIL="codex-review:capacity" AI_REVIEW_DRY_FAIL_RETRY=1 run --out .review-reports/c2
[ "$(grep -c '^retry codex-review .*混み合い' .review-reports/c2/status.txt)" = "1" ] && ok "回し直しは 1 回だけ（ループしない）" || ng "c2: $(grep retry .review-reports/c2/status.txt)"
grep -q 'FAILED codex-review' .review-reports/c2/status.txt && ok "回し直しも失敗すれば、失敗のまま残す" || ng "c2 の結果: $(grep codex-review .review-reports/c2/status.txt)"
AI_REVIEW_DRY_FAIL="codex-review:other" run --out .review-reports/c3
grep -q '混み合い' .review-reports/c3/status.txt && ng "混み合い以外の失敗で待った" || ok "混み合い以外の失敗では待たない"
AI_REVIEW_DRY_FAIL="own-review:capacity" run --out .review-reports/c4
grep -q '混み合い' .review-reports/c4/status.txt && ng "Claude 側の失敗を Codex の混み合いとして扱った" || ok "Claude 側の失敗は、この経路の対象にしない"
unset AI_REVIEW_CAPACITY_WAIT

echo "== PASS $pass / FAIL $fail =="
[ $fail -eq 0 ]
