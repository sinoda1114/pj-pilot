#!/usr/bin/env python3
"""/ai-review 突合補助: JEV（TypeSafe AI System One）で指摘を型付き判定する。

使い方:
  jev-judge.py --findings <findings.json> --out <jev.json> [--escalation <escalation.json>]
    --escalation を渡すと secret_paths が空でない場合に何も送らず available=false で終了する（スクリプト側のガード）。
    加えて各指摘文を秘密情報パターン（鍵・トークン・パスワード代入・PEM）で走査し、該当する指摘は送らない。

入力 findings.json（オーケストレータ＝Claude が両レビュー出力から書き起こす）:
  [
    {"id": "cr-1", "source": "code-review", "file": "src/util.ts", "line": 2,
     "text": "<指摘文（issue + 根拠 + fix をそのまま）>"},
    {"id": "cx-1", "source": "codex", "file": "src/util.ts", "line": 2, "text": "..."}
  ]

出力 jev.json:
  {"available": true|false, "reason": "...", "model": "typesafe-ai/jev",
   "findings": {"cr-1": {"is_security": 0.97, "assumption": 0.12, "severity": 4, "severity_confidence": 0.8}, ...},
   "pairs": [{"a": "cr-1", "b": "cx-1", "same_issue": 0.93}, ...]}

方針（DESIGN-v2.md §10）:
  - JEV は指摘を落とさない・裁定しない。突合の「型付け」と検証順の優先付けにだけ使う。
  - フェイルセーフ: キー無し / API エラー / タイムアウト / 入力不正なら available=false を書いて exit 0。ゲートの成否に影響させない。
    1 件でも呼び出しに失敗したら結果全体を available=false にする（部分結果を「完全な型付け」として使わせない）。
  - 秘密情報: 呼び出し側（SKILL.md §3.2）が secret_paths ありのとき本スクリプトを起動しない。
  - 経路（優先順）: ① TypeSafe 直接 API（https://api.typesafe.ai/v1/systemone、model jev-latest）: env TYPESAFE_API_KEY
    ② Vercel AI Gateway の TypeSafe 互換 API（https://ai-gateway.vercel.sh/typesafe/v1/systemone、model typesafe-ai/jev）: env AI_GATEWAY_API_KEY
    どちらも ~/.config/ai-review/jev.env（KEY=... 形式）から読める。
  - severity は criteria の添字 0..3 の期待値（連続値）。legend/probabilities も保存する。
  - テスト: AI_REVIEW_JEV_MOCK=1 で API を呼ばず決定的なダミー値を返す。
"""
import argparse, json, os, re, sys, time, urllib.request, urllib.error
from pathlib import Path

ROUTES = [  # (env key name, endpoint, model)
    ("TYPESAFE_API_KEY", "https://api.typesafe.ai/v1/systemone", "jev-latest"),
    ("AI_GATEWAY_API_KEY", "https://ai-gateway.vercel.sh/typesafe/v1/systemone", "typesafe-ai/jev"),
]
TIMEOUT_SEC = 20
# Cloudflare が urllib 既定の UA（Python-urllib/3.x）を error code 1010 で遮断する（2026-09-23 実測）。
USER_AGENT = "ai-review-jev/2 (+https://github.com/sinoda1114)"
STATE_MAX_CHARS = 12000  # 64k トークン上限に対して十分小さく

SECURITY_Q = ("Is this review finding a security vulnerability, i.e. injection (SQL/command/LDAP/XPath), "
              "XSS, SSRF, path traversal, authentication/authorization flaw, weak cryptography or randomness, "
              "insecure deserialization, secret exposure, or trust-boundary violation?")
ASSUMPTION_Q = ("Does the finding's reasoning rely on an unverified assumption about code outside the shown diff, "
                "such as assuming a helper or callee returns attacker-controlled input, or assuming a configuration value?")
SEVERITY_Q = "How likely is this finding to be exploitable in practice, based only on the evidence given?"
SEVERITY_CRITERIA = ["theoretical or not exploitable", "exploitable only under unusual conditions",
                     "plausibly exploitable with attacker-controlled input", "directly exploitable as described"]
SAME_Q = "Do finding A and finding B describe the same underlying problem at the same code location?"

# 指摘文に秘密情報らしき値が含まれていたら送らない（パス判定を補う値判定）
SECRET_VALUE_RE = re.compile(
    r"(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|"
    r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|(?i:(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['\"][^'\"]{8,}['\"]))")


def load_route():
    """(key, endpoint, model) を優先順で返す。無ければ ("", "", "")。"""
    env = dict(os.environ)
    p = Path.home() / ".config/ai-review/jev.env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    for name, endpoint, model in ROUTES:
        if env.get(name, "").strip():
            return env[name].strip(), endpoint, model
    return "", "", ""


CONTROL_RE = re.compile(r"[\x00-\x08\x0e-\x1f\x7f]")   # ANSI エスケープや NUL をログに流さない


def http_error_detail(e, key):
    """HTTPError の応答本文の先頭 120 文字。鍵は伏せ、制御文字は除く。本文が読めなければ空文字。"""
    limit = 4096 + len(key)
    try:
        data = e.read(limit)
    except Exception:
        return ""
    raw = data.decode(errors="replace")
    if key:
        raw = raw.replace(key, "<key>")
        if len(data) >= limit:
            # 上限で鍵が途中まで入っていると完全一致で伏せられず、空白を畳むと先頭 120 字へ寄ってくる。末尾を捨てる
            raw = raw[:-len(key)]
    return " ".join(CONTROL_RE.sub("", raw).split())[:120]


def call(route, state, questions):
    key, endpoint, model = route
    body = json.dumps({"model": model, "state": state, "questions": questions}).encode()
    req = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as r:
                return json.loads(r.read().decode()), None
        except urllib.error.HTTPError as e:
            if e.code in (429, 529) and attempt < 2:
                time.sleep(2 ** attempt); continue
            detail = http_error_detail(e, key)
            return None, f"HTTP {e.code}: {detail}" if detail else f"HTTP {e.code}"
        except Exception as e:  # timeout, network
            if attempt < 2:
                time.sleep(2 ** attempt); continue
            return None, f"{type(e).__name__}: {e}"
    return None, "unreachable"


def mock_answers(state, questions):
    """決定的なダミー: 'exec(' / 'SELECT' 等を含めば security 高、'なら' / 'はず' / 'assum' を含めば assumption 高。"""
    s = state.lower()
    out = {}
    for qid, q in questions.items():
        if q["type"] == "noul":
            if qid == "is_security":
                v = 0.9 if any(t in s for t in ["exec(", "select", "innerhtml", "eval(", "injection", "xss"]) else 0.1
            elif qid == "assumption":
                v = 0.85 if any(t in s for t in ["なら", "はず", "assum", "前提", "presum"]) else 0.1
            else:
                v = 0.9 if "same_issue" == qid and "<<same>>" in s else 0.2
            out[qid] = {"type": "noul", "noul": v}
        elif q["type"] == "score":
            # criteria の添字 0..3 の範囲に収める（実 API と同じ値域）
            out[qid] = {"type": "score", "score": 3 if "exec(" in s else 1, "confidence": 0.7}
    return {"model": "mock", "answers": out}


def truncate(text):
    return text if len(text) <= STATE_MAX_CHARS else text[:STATE_MAX_CHARS] + "\n[truncated]"


def write_out(path, result):
    try:
        Path(path).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    except OSError as e:  # 書けなくてもゲートを止めない。stderr に残すだけ
        print(f"jev-judge: cannot write {path}: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--findings", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--escalation", default="")
    args = ap.parse_args()
    mock = os.environ.get("AI_REVIEW_JEV_MOCK") == "1"
    route = ("mock", "mock", "mock") if mock else load_route()
    result = {"available": False, "reason": "", "model": route[2], "endpoint": route[1], "findings": {}, "pairs": []}
    # 入力の検証。壊れていても例外で落とさず available=false で返す
    try:
        findings = json.loads(Path(args.findings).read_text())
        assert isinstance(findings, list)
        for i, f in enumerate(findings):
            assert isinstance(f, dict) and f.get("id") and f.get("text") is not None, f"findings[{i}] に id/text が無い"
    except Exception as e:
        result["reason"] = f"invalid findings.json: {type(e).__name__}: {e}"[:300]
        write_out(args.out, result); return 0
    if args.escalation:
        try:
            esc = json.loads(Path(args.escalation).read_text())
            if esc.get("secret_paths"):
                result["reason"] = "secret_paths present; nothing sent to JEV"
                write_out(args.out, result); return 0
        except Exception as e:
            result["reason"] = f"cannot read escalation.json ({type(e).__name__}); nothing sent"
            write_out(args.out, result); return 0
    redacted = [f["id"] for f in findings if SECRET_VALUE_RE.search(str(f.get("text", "")))]
    if redacted:
        findings = [f for f in findings if f["id"] not in redacted]
        result["redacted"] = redacted
    if not mock and not route[0]:
        result["reason"] = "TYPESAFE_API_KEY / AI_GATEWAY_API_KEY not set (env or ~/.config/ai-review/jev.env)"
        write_out(args.out, result); return 0

    def ask(state, questions):
        if mock:
            if os.environ.get("AI_REVIEW_JEV_MOCK_FAIL") == "1" and "same_issue" in questions:
                return None, "mock failure"
            return mock_answers(state, questions), None
        return call(route, state, questions)

    errors = []
    for f in findings:
        state = truncate(f"Review finding by {f.get('source','?')} at {f.get('file','?')}:{f.get('line','?')}\n\n{f.get('text','')}")
        resp, err = ask(state, {
            "is_security": {"type": "noul", "instructions": SECURITY_Q},
            "assumption": {"type": "noul", "instructions": ASSUMPTION_Q},
            "severity": {"type": "score", "instructions": SEVERITY_Q, "criteria": SEVERITY_CRITERIA},
        })
        if err:
            errors.append(f"{f.get('id')}: {err}"); continue
        a = resp.get("answers", {})
        result["findings"][f["id"]] = {
            "is_security": a.get("is_security", {}).get("noul"),
            "assumption": a.get("assumption", {}).get("noul"),
            "severity": a.get("severity", {}).get("score"),            # 0..3 の期待値
            "severity_confidence": a.get("severity", {}).get("confidence"),
            "severity_probabilities": a.get("severity", {}).get("probabilities"),
        }
        if resp.get("model"):
            result["model"] = resp["model"]
    # 同一ファイルの code-review × codex ペアだけ同一性を問う
    by_src = {}
    for f in findings:
        by_src.setdefault(f.get("source"), []).append(f)
    for a in by_src.get("code-review", []):
        for b in by_src.get("codex", []):
            if a.get("file") != b.get("file"):
                continue
            state = truncate(f"Finding A ({a.get('file')}:{a.get('line')}):\n{a.get('text','')}\n\nFinding B ({b.get('file')}:{b.get('line')}):\n{b.get('text','')}")
            if mock and a.get("line") == b.get("line"):
                state += "\n<<same>>"
            resp, err = ask(state, {"same_issue": {"type": "noul", "instructions": SAME_Q}})
            if err:
                errors.append(f"{a['id']}x{b['id']}: {err}"); continue
            result["pairs"].append({"a": a["id"], "b": b["id"],
                                    "same_issue": resp.get("answers", {}).get("same_issue", {}).get("noul")})
    # 1 件でも失敗したら全体を不可にする（部分結果で突合させない）
    if errors:
        result["available"] = False
        result["reason"] = "partial failure; JEV results discarded: " + "; ".join(errors)[:900]
        result["findings"], result["pairs"] = {}, []
    else:
        result["available"] = True
    write_out(args.out, result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
