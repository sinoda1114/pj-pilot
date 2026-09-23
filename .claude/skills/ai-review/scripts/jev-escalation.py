#!/usr/bin/env python3
"""昇格トリガー F（任意・追加方向のみ）: 差分の内容を JEV に見せ、
「認証・認可・セッション/トークン・決済・永続データの形や挙動を変えるか」の確率を返す。

usage: jev-escalation.py --base <ref> [--escalation <escalation.json>] [--threshold 0.8]   # コミット済み差分（merge-base..HEAD）
       jev-escalation.py --local        [--escalation <escalation.json>] [--threshold 0.8]   # 未コミット差分（staged + unstaged + untracked）
出力（stdout に JSON 1 行）: {"available":true|false,"risk":0.85,"escalate":true|false,"reason":"...","chunks":N}

方針（DESIGN-v2.md §10）:
  - grep（escalation-check.sh）の代わりではなく**追加**。JEV が低くても grep の昇格は解除しない。
  - フェイルセーフ: キー無し・API エラー・差分取得失敗・応答不正は available=false、escalate=false で exit 0。
  - 秘密情報: --escalation の secret_paths が空でなければ送らない。差分本文に鍵・トークンらしき値があれば送らない。
    （値検出は jev-judge.py と同じパターン + 引用符なしの TOKEN=... を含む）
  - 差分が大きいときは頭から切らず、ファイル単位のチャンク（各 ≤ MAX_CHARS）に分けて全て評価し、最大の確率を採る。
  - 効果測定（2026-09-21、pj-pilot 直近 30 PR）: grep が見逃した高リスク PR 1 件を ≥0.8 で拾い、余計な昇格 0 件。
  - テスト: AI_REVIEW_JEV_MOCK=1 で API を呼ばず、差分に auth/payment/migration/schema/session/token 語があれば 0.9、無ければ 0.1 を返す。
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path

ENDPOINT, MODEL = "https://api.typesafe.ai/v1/systemone", "jev-latest"
# Cloudflare が urllib 既定の UA（Python-urllib/3.x）を error code 1010 で遮断する（2026-09-23 実測）。
USER_AGENT = "ai-review-jev/2 (+https://github.com/sinoda1114)"
GATEWAY = ("https://ai-gateway.vercel.sh/typesafe/v1/systemone", "typesafe-ai/jev")
Q = ("Does this code change modify authentication, authorization, session or token handling, payment or billing, "
     "or the shape or behavior of persistently stored data (database schema, migrations, storage formats)? "
     "Answer based on the actual code in the diff, not on file names alone.")
SECRET_RE = re.compile(
    r"(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|"
    r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|"
    r"(?i:(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['\"][^'\"]{8,}['\"])|"
    r"(?i:\b(password|passwd|secret|api[_-]?key|token)\s*=\s*[A-Za-z0-9_\-./+]{12,}\b))")
MAX_CHARS = 12000
MAX_CHUNKS = 12  # 上限を超える巨大差分は規模トリガー C が既に昇格させる


def load_route():
    env = dict(os.environ)
    p = Path.home() / ".config/ai-review/jev.env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1); env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    if env.get("TYPESAFE_API_KEY", "").strip():
        return env["TYPESAFE_API_KEY"].strip(), ENDPOINT, MODEL
    if env.get("AI_GATEWAY_API_KEY", "").strip():
        return env["AI_GATEWAY_API_KEY"].strip(), GATEWAY[0], GATEWAY[1]
    return "", "", ""


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout


def collect_diff(local, base):
    """(diff_text, file_list) を返す。--local は staged + unstaged + untracked（テキストのみ、symlink 除外）。"""
    if local:
        diff = run(["git", "diff", "HEAD"])
        files = run(["git", "diff", "--name-only", "HEAD"]).splitlines()
        for f in run(["git", "ls-files", "--others", "--exclude-standard"]).splitlines():
            p = Path(f)
            if not f or p.is_symlink() or not p.is_file():
                continue
            try:
                raw = p.read_bytes()
            except OSError:
                continue
            if b"\x00" in raw[:8000]:
                continue  # バイナリ
            text = raw.decode("utf-8", errors="replace")
            files.append(f)
            diff += f"\ndiff --git a/{f} b/{f}\nnew file mode 100644\n--- /dev/null\n+++ b/{f}\n" + "".join("+" + l + "\n" for l in text.splitlines())
        return diff, files
    base = base or (subprocess.run(["git", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
                                   capture_output=True, text=True).stdout.strip() or "origin/main")
    mb = run(["git", "merge-base", base, "HEAD"]).strip()
    return run(["git", "diff", mb, "HEAD"]), run(["git", "diff", "--name-only", mb, "HEAD"]).splitlines()


def split_chunks(diff):
    """ファイル境界で分割し、各チャンクを MAX_CHARS 以下にまとめる。1 ファイルが上限超なら頭から切る。"""
    parts = re.split(r"(?m)^(?=diff --git )", diff)
    parts = [p for p in parts if p.strip()]
    chunks, cur = [], ""
    for p in parts:
        p = p[:MAX_CHARS]
        if cur and len(cur) + len(p) > MAX_CHARS:
            chunks.append(cur); cur = ""
        cur += p
    if cur:
        chunks.append(cur)
    return chunks[:MAX_CHUNKS]


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


def ask(route, state):
    key, ep, model = route
    body = json.dumps({"model": model, "state": state, "questions": {"risk": {"type": "noul", "instructions": Q}}}).encode()
    req = urllib.request.Request(ep, data=body, method="POST", headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                data = json.loads(r.read().decode())
            risk = data["answers"]["risk"]["noul"]
            if not isinstance(risk, (int, float)):
                return None, "unexpected response shape"
            return float(risk), None
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as e:
            return None, f"bad response: {type(e).__name__}"
        except urllib.error.HTTPError as e:
            if e.code in (429, 529) and attempt < 2:
                time.sleep(2 ** attempt); continue
            detail = http_error_detail(e, key)
            return None, f"HTTP {e.code}: {detail}" if detail else f"HTTP {e.code}"
        except Exception as e:
            if attempt < 2:
                time.sleep(2 ** attempt); continue
            return None, type(e).__name__
    return None, "unreachable"


def mock_ask(state):
    return (0.9 if re.search(r"auth|login|session|token|payment|billing|migrat|schema|persist|storage", state, re.I) else 0.1), None


def out(d):
    print(json.dumps(d, ensure_ascii=False)); return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=""); ap.add_argument("--local", action="store_true")
    ap.add_argument("--escalation", default=""); ap.add_argument("--threshold", type=float, default=0.8)
    a = ap.parse_args()
    res = {"available": False, "risk": None, "escalate": False, "reason": "", "chunks": 0}
    mock = os.environ.get("AI_REVIEW_JEV_MOCK") == "1"
    route = ("mock", "mock", "mock") if mock else load_route()
    if not route[0]:
        res["reason"] = "no key"; return out(res)
    if a.escalation:
        try:
            if json.loads(Path(a.escalation).read_text()).get("secret_paths"):
                res["reason"] = "secret_paths present; nothing sent"; return out(res)
        except Exception as e:
            res["reason"] = f"cannot read escalation.json ({type(e).__name__}); nothing sent"; return out(res)
    try:
        diff, files = collect_diff(a.local, a.base)
    except Exception as e:
        res["reason"] = f"diff failed: {type(e).__name__}"; return out(res)
    if not diff.strip():
        res["reason"] = "empty diff"; return out(res)
    if SECRET_RE.search(diff):
        res["reason"] = "secret-like value in diff; nothing sent"; return out(res)
    chunks = split_chunks(diff)
    file_list = "\n".join(files)
    risks = []
    for i, ch in enumerate(chunks, 1):
        state = f"Files in this change:\n{file_list}\n\nDiff part {i}/{len(chunks)}:\n{ch}"
        risk, err = mock_ask(state) if mock else ask(route, state)
        if err:
            res["reason"] = f"chunk {i}: {err}"; res["chunks"] = len(chunks); return out(res)
        risks.append(risk)
    risk = max(risks)
    res.update({"available": True, "risk": round(risk, 3), "chunks": len(chunks), "escalate": risk >= a.threshold,
                "reason": f"F:jev:{risk:.2f}" if risk >= a.threshold else f"jev {risk:.2f} < {a.threshold}"})
    return out(res)


if __name__ == "__main__":
    sys.exit(main())
