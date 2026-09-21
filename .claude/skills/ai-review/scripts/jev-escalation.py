#!/usr/bin/env python3
"""昇格トリガー F（任意・追加方向のみ）: 差分の内容を JEV に見せ、
「認証・認可・セッション/トークン・決済・永続データの形や挙動を変えるか」の確率を返す。

usage: jev-escalation.py --base <ref> [--threshold 0.8]   # コミット済み差分（merge-base..HEAD）
       jev-escalation.py --local        [--threshold 0.8]   # 未コミット差分
出力（stdout に JSON 1 行）: {"available":true|false,"risk":0.85,"escalate":true|false,"reason":"..."}

方針（DESIGN-v2.md §10）:
  - grep（escalation-check.sh）の代わりではなく**追加**。JEV が低くても grep の昇格は解除しない。
  - フェイルセーフ: キー無し・API エラー・差分取得失敗は available=false、escalate=false で exit 0。
  - 秘密情報: 呼び出し側で secret_paths が空でなければ実行しない。加えて差分本文に鍵・トークンらしき値があれば送らない。
  - 効果測定（2026-09-21、pj-pilot 直近 30 PR）: grep が見逃した高リスク PR 1 件を ≥0.8 で拾い、余計な昇格 0 件。
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path

ENDPOINT, MODEL = "https://api.typesafe.ai/v1/systemone", "jev-latest"
GATEWAY = ("https://ai-gateway.vercel.sh/typesafe/v1/systemone", "typesafe-ai/jev")
Q = ("Does this code change modify authentication, authorization, session or token handling, payment or billing, "
     "or the shape or behavior of persistently stored data (database schema, migrations, storage formats)? "
     "Answer based on the actual code in the diff, not on file names alone.")
SECRET_RE = re.compile(r"(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|"
                       r"(?i:(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['\"][^'\"]{8,}['\"]))")
MAX_CHARS = 12000


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


def out(d):
    print(json.dumps(d, ensure_ascii=False)); return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=""); ap.add_argument("--local", action="store_true")
    ap.add_argument("--threshold", type=float, default=0.8)
    a = ap.parse_args()
    res = {"available": False, "risk": None, "escalate": False, "reason": ""}
    key, ep, model = load_route()
    if not key:
        res["reason"] = "no key"; return out(res)
    try:
        if a.local:
            diff = subprocess.run(["git", "diff", "HEAD"], capture_output=True, text=True, check=True).stdout
            files = subprocess.run(["git", "diff", "--name-only", "HEAD"], capture_output=True, text=True).stdout
        else:
            base = a.base or subprocess.run(["git", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
                                            capture_output=True, text=True).stdout.strip() or "origin/main"
            mb = subprocess.run(["git", "merge-base", base, "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
            diff = subprocess.run(["git", "diff", mb, "HEAD"], capture_output=True, text=True, check=True).stdout
            files = subprocess.run(["git", "diff", "--name-only", mb, "HEAD"], capture_output=True, text=True).stdout
    except Exception as e:
        res["reason"] = f"diff failed: {type(e).__name__}"; return out(res)
    if not diff.strip():
        res["reason"] = "empty diff"; return out(res)
    if SECRET_RE.search(diff):
        res["reason"] = "secret-like value in diff; nothing sent"; return out(res)
    state = f"Files:\n{files}\n\nDiff (truncated to {MAX_CHARS} chars):\n{diff[:MAX_CHARS]}"
    body = json.dumps({"model": model, "state": state, "questions": {"risk": {"type": "noul", "instructions": Q}}}).encode()
    req = urllib.request.Request(ep, data=body, method="POST", headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                risk = json.loads(r.read().decode())["answers"]["risk"]["noul"]
            res.update({"available": True, "risk": risk, "escalate": risk >= a.threshold,
                        "reason": f"F:jev:{risk:.2f}" if risk >= a.threshold else f"jev {risk:.2f} < {a.threshold}"})
            return out(res)
        except Exception as e:
            if attempt < 2:
                time.sleep(2 ** attempt); continue
            res["reason"] = f"{type(e).__name__}"[:80]; return out(res)


if __name__ == "__main__":
    sys.exit(main())
