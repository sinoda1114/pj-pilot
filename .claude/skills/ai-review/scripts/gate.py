#!/usr/bin/env python3
"""/ai-review v3 のゲート判定の下請け（標準ライブラリのみ。モデル不使用）。

サブコマンド:
  table-check --output <レビュー出力> --files <changed-files.txt>
      自前観点（own-review / own-security）の判定表に、変更ファイルがすべて載っているかを見る。
      載っていないファイルを 1 行ずつ出す（全部あれば何も出さない）。終了コード 0。
  summary --run <run ディレクトリ>
      生出力から機械的に決まる「下限の結論」（floor）、判定表の欠け、--deep の推奨を JSON で出す。
      突合（メインのエージェント）はこの floor より軽い結論を付けられない。
  record --run <dir> --verdict <v> [--items <json>] ...（record-gate.sh から呼ぶ）
      latest.json を組み立てて標準出力に出す。
  resolve --latest <latest.json> --id <ID> ...（resolve-item.sh から呼ぶ）
      MUST-ADDRESS の 1 件の処理（fixed / accepted / 検証結果 / 人の承認）を記録する。
  check --latest <latest.json> --head <sha>
      pre-push と同じ基準で、未処理の項目を数える（テスト・確認用）。

結論の段（DESIGN-v3.md §4）:
  own-review / own-security の結論行 BLOCK / MUST-ADDRESS / PASS をそのまま使う。
  Codex の [P1] は BLOCK 相当、[P2] / [P3] は MUST-ADDRESS 相当。
  判定表の欠け（再実行しても埋まらない）と、結論行を読めない出力は MUST-ADDRESS。
  レビュー結果が 1 つも無ければ block。
"""
import argparse
import datetime
import json
import os
import re
import sys

LEVEL = {"pass": 0, "must-address": 1, "block": 2}
TIER_LEVEL = {"MUST-ADDRESS": 1, "BLOCK": 2}
TOKEN_TO_VERDICT = {"PASS": "pass", "MUST-ADDRESS": "must-address", "BLOCK": "block"}
SEVERITIES = ("High", "Medium", "Low")

# 出力ファイル名（拡張子なし）= レビュアー名。項目の source はこの名前を "+" でつなぐ。
OWN_REVIEWERS = ("own-review", "own-security", "own-review-fable")
CODEX_REVIEWERS = ("codex-review", "codex-astra")

# 注入型の指摘（外部入力がコマンド・SQL・パス・LDAP・XPath・テンプレート・リダイレクト・
# デシリアライズに届く）を summary から拾う語。人の承認が要る高リスクの判定を、エージェントの
# 申告だけに任せないための下限。拾いすぎは「人に聞く回数が増える」側に倒れるだけなので許容する。
INJECTION_RE = re.compile(
    r"injection|インジェクション|注入|command\s*exec|コマンド実行|os\s*command|"
    r"path\s*traversal|パストラバーサル|ディレクトリトラバーサル|ssti|"
    r"open\s*redirect|オープンリダイレクト|deserializ|デシリアライズ|逆シリアル化",
    re.I,
)
# 出力先の語。単独では拾いすぎる（「SQL の結果が空のとき」など）ので、区分がセキュリティの項目にだけ使う

def die(msg, code=1):
    print(safe(msg), file=sys.stderr)
    sys.exit(code)


CATEGORY_ALIASES = {"security": "security", "セキュリティ": "security",
                    "correctness": "correctness", "正しさ": "correctness",
                    "design": "design", "設計": "design"}


def safe(s):
    """端末へ出す前に制御文字（タブ・改行は残す。C1 も含む）を ? にする。エスケープシーケンスを効かせない。"""
    return "".join("?" if (ord(c) < 32 and c not in "\t\n") or 127 <= ord(c) < 160 else c for c in str(s))


def now():
    return datetime.datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


# ---------------------------------------------------------------- 判定表の検査

def _unwrap(c):
    """前後で対になった装飾（**x**、`x`、_x_ など）だけを外す。_worker.js の _ は残す。"""
    c = c.strip()
    changed = True
    while changed:
        changed = False
        for d in ("**", "__", "`", "*", "_"):
            if len(c) > 2 * len(d) and c.startswith(d) and c.endswith(d):
                c = c[len(d):-len(d)].strip()
                changed = True
    return c


def _clean_cell(c):
    c = c.strip()
    m = re.match(r"^\[([^\]]+)\]\([^)]*\)$", c)  # [path](path) の形
    if m:
        c = m.group(1)
    c = _unwrap(c)
    c = re.sub(r"^\./", "", c)
    c = re.sub(r":\d+(-\d+)?$", "", c)  # path:12 の形
    return _unwrap(c)


def _repo_path(f):
    """項目の file をリポジトリからの相対パスにする（./、隔離 worktree や本体の絶対パスを外す）。"""
    f = _clean_cell(f or "")
    if f.startswith("/"):
        m = re.match(r"^.*?/ai-review-wt\.[^/]+/(.*)$", f)
        if m:
            f = m.group(1)
        else:
            root = os.getcwd().rstrip("/") + "/"
            if f.startswith(root):
                f = f[len(root):]
    return f


def _table_lines(text):
    """判定表の行を返す。「判定表」を含む見出しがあれば、その節の表だけ。無ければ出力中のすべての表。
    攻撃面の一覧など別の表の 1 列目にパスがあっても、判定表に載ったことにしないため。"""
    lines = text.splitlines()
    heads = [i for i, l in enumerate(lines) if re.match(r"^\s*#{1,6}\s.*判定表", l)]
    if heads:
        body = []
        for i in heads:
            for l in lines[i + 1:]:
                if re.match(r"^\s*#{1,6}\s", l):
                    break
                body.append(l)
        return [l.strip() for l in body if l.strip().startswith("|") and l.strip().count("|") >= 3]
    # 見出しが無ければ、ヘッダ行の 1 列目が「ファイル」の表だけ（攻撃面の一覧などの表を判定表と数えない）
    out, in_table = [], False
    for l in lines:
        s = l.strip()
        if not (s.startswith("|") and s.count("|") >= 3):
            in_table = False
            continue
        if not in_table:
            in_table = True
            use = _clean_cell(s.strip("|").split("|")[0]) == "ファイル"
        if use:
            out.append(s)
    return out


def table_paths(text):
    """判定表の 1 列目を集める（見出し行・区切り行も入るが、照合で無害）。"""
    cells = set()
    for s in _table_lines(text):
        first = s.strip("|").split("|")[0]
        c = _clean_cell(first)
        if c:
            cells.add(c)
    return cells


def missing_files(text, files):
    """判定表に載っていない変更ファイルを返す。完全なパスで照合し、末尾だけの一致
    （例 index.js）は、変更ファイルの中で候補がちょうど 1 つに決まるときだけ認める。"""
    files = [f.strip() for f in files if f.strip()]
    covered = set()
    for c in table_paths(text):
        if c in files:
            covered.add(c)
            continue
        cand = [f for f in files if f.endswith("/" + c) or c.endswith("/" + f)]
        if len(cand) == 1:
            covered.add(cand[0])
    return [f for f in files if f not in covered]


def cmd_table_check(a):
    files = [l for l in read(a.files).splitlines() if l.strip()]
    for f in missing_files(read(a.output), files):
        print(f)


# ---------------------------------------------------------------- 結論の読み取り

_TOK = re.compile(r"(?<![A-Z-])(BLOCK|MUST-ADDRESS|PASS)(?![A-Z-])")
# プロンプトが最後の行に書かせる機械用の行（「VERDICT: BLOCK」）
_VERDICT = re.compile(r"^\s*[*`]*VERDICT\s*[:：]\s*[*`]*(BLOCK|MUST-ADDRESS|PASS)[*`]*\s*$")
_HEADING = re.compile(r"^\s*#{1,6}\s")
# 結論の節の見出し: 中身が「結論」だけ（番号・括弧書き・コロンは可）。「### 1. 結論の読み取りが…」は含めない
_CONCLUSION_HEADING = re.compile(r"^\s*#{1,6}\s*(?:[\d.]+\s*)?[*`]*結論[*`]*\s*(?:[（(:：].*)?$")


def _heaviest(ts):
    return max(ts, key=lambda t: LEVEL[TOKEN_TO_VERDICT[t]])


def _strip_fences(lines):
    """``` / ~~~ で囲まれた範囲を除く（引用したコードの中の「## 結論」や語を読まない）。"""
    out, fence = [], None
    for l in lines:
        m = re.match(r"^\s*(```|~~~)", l)
        if m:
            fence = None if fence == m.group(1) else (fence or m.group(1))
            continue
        if fence is None:
            out.append(l)
    # 閉じていないフェンスがあれば、除かずに全体を読む（後ろの VERDICT や [P1] を落とさない。止める側に倒す）
    return out if fence is None else list(lines)


def own_conclusion(text):
    """自前観点の結論を読む。読めなければ None。
    1. 最後の空でない行が「VERDICT: X」ならそれ。
    2. 無ければ、「結論」の見出し（4.4 結論 など）の節（次の見出しまで）にある語すべてで最も重いもの。
    3. 見出しも無ければ、「結論」を含む行の語で最も重いもの。
    2・3 は言い回し（否定文、基準の書き写し、表）を解釈しない。読み違えるなら止める側に倒す。"""
    lines = _strip_fences(list(text.splitlines()))
    # VERDICT 行は最後の空でない行だけを読む（本文の途中で引用された「VERDICT: PASS」を採らない）
    tail = [l for l in lines if l.strip()][-1:] 
    m = _VERDICT.match(tail[0]) if tail else None
    if m:
        return m.group(1)
    toks = []
    for i, l in enumerate(lines):
        if _CONCLUSION_HEADING.match(l):
            for x in lines[i + 1:]:
                if _HEADING.match(x):
                    break
                toks += _TOK.findall(x)
    if not toks:
        toks = [t for l in lines if "結論" in l for t in _TOK.findall(l)]
    return _heaviest(toks) if toks else None


# 行頭（箇条書き・番号・見出しの記号と装飾の後）の優先度。実測の形は「- [P1] …」だが、「- **[P1]**」「1. [P2]」
# 「- **P1** …」「- P1: …」も同じ優先度として数える（形がずれても軽い側に落とさない）
_CODEX_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)]|#{1,6})?\s*[*_`]*[\[(]?P([0-3])\b")


def codex_levels(text):
    """行頭の優先度だけを数える（本文の途中・コードフェンスの中で引用された [P1] は数えない）。"""
    p = {k: 0 for k in range(4)}
    for l in _strip_fences(text.splitlines()):
        m = _CODEX_ITEM.match(l)
        if m:
            p[int(m.group(1))] += 1
    # P0 は Codex の最上位（P1 より重い）。BLOCK 相当に含める
    return {"P1": p[0] + p[1], "P2": p[2], "P3": p[3]}


def summarize(run):
    sources = {}
    floor = None  # None = レビュー結果なし
    auto_items = []

    def raise_to(v):
        nonlocal floor
        if floor is None or LEVEL[v] > LEVEL[floor]:
            floor = v

    for name in OWN_REVIEWERS:
        text = read(os.path.join(run, name + ".md"))
        # 判定表の欠けで回し直したときは、初回（attempt1）の結論も読み、重い方を採る。
        # 初回の BLOCK が再実行の PASS や空白だけの出力で消えないように
        first = read(os.path.join(run, name + ".attempt1.md"))
        if not text.strip() and not first.strip():
            continue
        tok = own_conclusion(text) if text.strip() else None
        tok1 = own_conclusion(first) if first.strip() else None
        # 読めない結論（None）は must-address とみなし、初回と再実行の重い方を採る。
        # 初回が読めないときも、再実行の PASS で消さない（読めない項目として残す）
        cur = LEVEL[TOKEN_TO_VERDICT[tok]] if tok is not None else LEVEL["must-address"]
        if tok1 is not None and LEVEL[TOKEN_TO_VERDICT[tok1]] > cur:
            tok = tok1
        elif first.strip() and tok1 is None and (tok is None or LEVEL[TOKEN_TO_VERDICT[tok]] < LEVEL["must-address"]):
            tok = None
        if tok is None:
            sources[name] = {"level": "must-address", "detail": "結論行を読み取れない"}
            raise_to("must-address")
            auto_items.append({
                "source": "parse:" + name, "file": "", "line": None, "tier": "MUST-ADDRESS",
                "severity": "Medium",
                "summary": "%s の出力に結論行（BLOCK / MUST-ADDRESS / PASS）が無い。生出力を読んで確かめる" % name,
            })
        else:
            v = TOKEN_TO_VERDICT[tok]
            sources[name] = {"level": v, "detail": "結論 " + tok}
            raise_to(v)
    for name in CODEX_REVIEWERS:
        text = read(os.path.join(run, name + ".md"))
        if not text.strip():
            continue
        lv = codex_levels(text)
        v = "block" if lv["P1"] else ("must-address" if lv["P2"] or lv["P3"] else "pass")
        sources[name] = {"level": v, "detail": "P1=%d P2=%d P3=%d" % (lv["P1"], lv["P2"], lv["P3"])}
        raise_to(v)

    # 起動した（または失敗・未導入と記録された）のに出力を読めないレビュアー。残った側だけで PASS にさせず、
    # 未取得の項目にする。出力を読めたレビュアーには、古い status の行から付けない
    why = {}
    for st in ("status.txt", "status-security.txt"):
        for l in read(os.path.join(run, st)).splitlines():
            m = re.match(r"^(started|FAILED|TIMEOUT|EMPTY|UNAVAILABLE) (\S+)", l)
            if m and m.group(2) in OWN_REVIEWERS + CODEX_REVIEWERS:
                if m.group(1) != "started" or m.group(2) not in why:
                    why[m.group(2)] = "空の出力" if m.group(1) == "started" else m.group(1)
    for name, w in why.items():
        if read(os.path.join(run, name + ".md")).strip():
            continue
        raise_to("must-address")
        auto_items.append({
            "source": "unavailable:" + name, "file": "", "line": None, "tier": "MUST-ADDRESS",
            "severity": "Medium",
            "summary": "%s の結果を取れなかった（%s）。回し直すか、二重化できていないことを理由に記録する" % (name, w),
        })

    missing = {}
    for name in OWN_REVIEWERS:
        mf = [l for l in read(os.path.join(run, name + ".missing.txt")).splitlines() if l.strip()]
        if not mf:
            continue
        missing[name] = mf
        raise_to("must-address")
        for f in mf:
            auto_items.append({
                "source": "table-check:" + name, "file": f, "line": None, "tier": "MUST-ADDRESS",
                "severity": "Medium",
                "summary": "判定なし（要確認）: %s の判定表にこのファイルが無い（再実行しても埋まらなかった）" % name,
            })

    reasons_block = floor == "block"
    # 読めたレビュー結果が 1 つも無ければ block（未取得の項目で must-address に下げない）
    if not any(not k.startswith("_") for k in sources):
        floor = "block"
        sources["_none"] = {"level": "block", "detail": "レビュー結果が 1 つも無い"}

    deep = os.path.exists(os.path.join(run, "deep.flag"))
    rec = []
    if not deep:
        esc = {}
        try:
            with open(os.path.join(run, "escalation.json"), encoding="utf-8") as f:
                esc = json.load(f)
        except (OSError, ValueError):
            esc = {}
        rs = esc.get("reasons") or []
        size = [r for r in rs if r.startswith("C:")]
        path_a = [r for r in rs if r.startswith("A:")]
        if size:
            rec.append("差分が大きい（" + ", ".join(size) + "）")
        if reasons_block:
            rec.append("BLOCK 相当の指摘がある")
        if path_a:
            rec.append("高リスクのパスに当たる（" + ", ".join(path_a[:3]) + "）")
    return {
        "floor": floor,
        "sources": sources,
        "missing": missing,
        "auto_items": auto_items,
        "deep": deep,
        "deep_recommended": bool(rec),
        "deep_recommend_reasons": rec,
    }


def cmd_summary(a):
    print(json.dumps(summarize(a.run), ensure_ascii=False, indent=2))


# ---------------------------------------------------------------- 高リスクの判定

def _ere_to_py(p):
    # escalation-rules.txt の path ルールは POSIX ERE。Python の re に無い文字クラスだけ置き換える
    for k, v in (("[:alnum:]", "A-Za-z0-9"), ("[:alpha:]", "A-Za-z"), ("[:digit:]", "0-9"),
                 ("[:space:]", " \\t\\r\\n\\f\\v"), ("[:upper:]", "A-Z"), ("[:lower:]", "a-z"),
                 ("[:xdigit:]", "0-9A-Fa-f"), ("[:blank:]", " \\t"), ("[:cntrl:]", "\\x00-\\x1f\\x7f"),
                 ("[:print:]", "\\x20-\\x7e"), ("[:graph:]", "\\x21-\\x7e"),
                 ("[:punct:]", "!-/:-@\\[-`{-~")):
        p = p.replace(k, v)
    return p


def path_rules(rule_files):
    pats = []
    for rf in rule_files:
        for line in read(rf).splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = line.split(None, 1)
            if len(parts) == 2 and parts[0] == "path":
                # 変換できないルールを黙って捨てると、そのパスの指摘が高リスクから外れる。記録ごと止める
                src = parts[1].strip()
                py = _ere_to_py(src)
                if "[:" in py:
                    die("%s の path ルール %r は変換できない文字クラスを含みます" % (rf, src))
                try:
                    pats.append(re.compile(py, re.I))
                except re.error as e:
                    die("%s の path ルール %r を読めません: %s" % (rf, src, e))
    return pats


def high_risk_of(item, pats):
    f = _repo_path(item.get("file"))
    if f and any(p.search(f) for p in pats):
        return True, "path-A"
    # セキュリティの指摘は語の照合に頼らず高リスクにする（「os.system に渡す」のような書き方で外れないように）
    if CATEGORY_ALIASES.get(str(item.get("category") or "").strip().lower()) == "security":
        return True, "security"
    summary = item.get("summary") or ""
    if INJECTION_RE.search(summary):
        return True, "injection"
    return False, ""


# ---------------------------------------------------------------- 記録

def load_items(path):
    if not path:
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        die("--items を JSON として読めません: %s" % e)
    if isinstance(data, dict):
        data = data.get("must_address", data.get("items"))
    if not isinstance(data, list):
        die("--items は項目の配列にしてください")
    seen = set()
    out = []
    for i, it in enumerate(data):
        if not isinstance(it, dict):
            die("--items[%d] がオブジェクトではありません" % i)
        iid = str(it.get("id") or "").strip()
        if not iid or iid in seen:
            die("--items[%d] の id が空か重複しています（%r）" % (i, iid))
        if iid.startswith(("auto-", "prev-")):
            die("--items[%d] の id %r は予約されています（auto- / prev- は記録時に自動で付く）" % (i, iid))
        seen.add(iid)
        tier = it.get("tier")
        if tier not in TIER_LEVEL:
            die("--items[%s] の tier は BLOCK か MUST-ADDRESS（強化提案・安全は項目にしない）" % iid)
        sev = it.get("severity")
        if sev not in SEVERITIES:
            die("--items[%s] の severity は High / Medium / Low" % iid)
        src = str(it.get("source") or "").strip()
        if not src:
            die("--items[%s] の source が空です" % iid)
        if not isinstance(it.get("high_risk", False), bool):
            die("--items[%s] の high_risk は true / false" % iid)
        # category は必須。省いたり書き方を変えたりして、セキュリティの指摘を高リスクから外させない
        cat = CATEGORY_ALIASES.get(str(it.get("category") or "").strip().lower())
        if cat is None:
            die("--items[%s] の category は security / correctness / design のどれか（%r）" % (iid, it.get("category")))
        line = it.get("line")
        out.append({
            "id": iid,
            "source": src,
            "file": str(it.get("file") or ""),
            "line": line if isinstance(line, (int, str)) or line is None else str(line),
            "tier": tier,
            "severity": sev,
            "category": cat,
            "summary": str(it.get("summary") or ""),
            "high_risk": bool(it.get("high_risk", False)),
            "status": "open",  # 記録時は必ず open。処理は resolve-item.sh で 1 件ずつ行う
        })
    return out


def cmd_record(a):
    items = load_items(a.items)
    s = summarize(a.run) if a.run else None
    # 昇格はスクリプトの判定（escalation.json）を下限にする。エージェントの --escalate false で打ち消させない
    if a.run and not a.no_diff:
        try:
            with open(os.path.join(a.run, "escalation.json"), encoding="utf-8") as f:
                esc = json.load(f)
        except (OSError, ValueError):
            esc = None
        # 無い・壊れている escalation.json を「昇格不要」と読まない（run-reviews.sh が必ず作る）
        if not isinstance(esc, dict) or not isinstance(esc.get("escalate"), bool):
            die("run ディレクトリの escalation.json が無いか読めません。run-reviews.sh を回し直してください")
        if esc["escalate"] and a.escalate != "true":
            die("escalation.json は昇格を求めています（%s）が、--escalate false で記録しようとしました。"
                "own-security を回すか、ユーザーが明示した場合だけ --escalate true --skipped-by-user true で記録してください"
                % ", ".join(esc.get("reasons") or [])[:300])
    # セキュリティの指摘があれば深掘り（own-security）を要求する（SKILL の昇格条件 D を機械で守る）
    if a.run and not a.no_diff and a.escalate != "true" and any(it["category"] == "security" for it in items):
        die("セキュリティの指摘（category=security）があります。own-security を回し、--escalate true で記録してください")
    given = a.verdict
    floor = s["floor"] if s else "pass"
    if a.no_diff:
        floor = "pass"
        s = None
        if items:
            die("--no-diff の記録に項目は付けられません")

    # 自動で足す項目（判定表の欠け・結論を読めない出力）
    if s:
        n = 0
        for ai in s["auto_items"]:
            n += 1
            it = dict(ai)
            it.update({"id": "auto-%d" % n, "category": "", "high_risk": False, "status": "open"})
            items.append(it)

    # レビュアーごとの下限を、項目が覆っているかを確かめる（突合で 1 人分の指摘を丸ごと落とさない）
    if s:
        for name, info in s["sources"].items():
            need = LEVEL[info["level"]]
            if name.startswith("_") or need == 0:
                continue
            covered = any(
                TIER_LEVEL[it["tier"]] >= need
                and name in [x.split(":", 1)[-1] for x in re.split(r"[+,\s]+", it["source"])
                             if not x.startswith("table-check:")]
                for it in items
            )
            if not covered:
                die("%s の結論は %s（%s）ですが、source に %s を含む %s 以上の項目がありません。"
                    "指摘を items に書き起こしてください（直さない指摘も、落とさずに resolve-item.sh で処理する）"
                    % (name, info["level"], info["detail"], name,
                       "BLOCK" if need == 2 else "MUST-ADDRESS"))

    # 高リスク（人の承認が要る）を機械的に足す。エージェントの申告は下げられない
    pats = path_rules(a.rules or [])
    for it in items:
        hr, why = high_risk_of(it, pats)
        if hr and not it["high_risk"]:
            it["high_risk"] = True
            it["high_risk_reason"] = why
        elif it["high_risk"]:
            it.setdefault("high_risk_reason", why or "reviewer")

    level = max([LEVEL[given], LEVEL[floor]] + [TIER_LEVEL[it["tier"]] for it in items])
    verdict = [k for k, v in LEVEL.items() if v == level][0]
    if verdict == "must-address" and not items:
        die("結論が must-address ですが項目がありません")
    if LEVEL[verdict] > LEVEL[given]:
        print("[ai-review] 結論を %s → %s に引き上げました（生出力・項目から機械的に決まる下限）"
              % (given, verdict), file=sys.stderr)

    # 前回の記録で fixed にした項目は、HEAD が進んだ新しいレビューで再レビュー済みとして残す
    prev_fixed = []
    try:
        with open(a.previous, encoding="utf-8") as f:
            prev = json.load(f)
    except (OSError, ValueError, TypeError):
        prev = {}
    if not isinstance(prev, dict):
        prev = {}
    if prev.get("branch") == a.branch and prev.get("head_sha") and prev.get("head_sha") != a.head:
        for it in prev.get("must_address") or []:
            if it.get("status") == "fixed" and not it.get("re_reviewed_sha"):
                c = dict(it)
                c["id"] = "prev-" + str(it.get("id"))
                c["re_reviewed_sha"] = a.head
                c["previous_head_sha"] = prev.get("head_sha")
                prev_fixed.append(c)

    rec = {
        "version": 3,
        "head_sha": a.head,
        "branch": a.branch,
        "mode": a.mode,
        "verdict": verdict,
        "floor_verdict": floor,
        "deep": bool(s and s["deep"]),
        "deep_recommended": bool(s and s["deep_recommended"]),
        "deep_recommend_reasons": (s["deep_recommend_reasons"] if s else []),
        "escalate": a.escalate == "true",
        "escalation_done": a.escalation_done == "true",
        "skipped_by_user": a.skipped_by_user == "true",
        "reason": a.reason or "",
        "report": a.report or "",
        "recorded_at": now(),
        "sources": (s["sources"] if s else {}),
        "must_address": items + prev_fixed,
    }
    if a.run and os.path.exists(os.path.join(a.run, "dry-run.flag")):
        # ダミー実行（AI_REVIEW_DRY_RUN=1）の結果。pre-push は AI_REVIEW_ALLOW_DRY=1 が無ければ拒む
        rec["dry_run"] = True
        print("[ai-review] 注意: ダミー実行の結果です。push の根拠になりません", file=sys.stderr)
    print(json.dumps(rec, ensure_ascii=False, indent=2))
    if rec["deep_recommended"]:
        print(safe("[ai-review] --deep を推奨: " + " / ".join(rec["deep_recommend_reasons"])), file=sys.stderr)


# ---------------------------------------------------------------- 未処理の判定（pre-push と同じ基準）

def item_ok(it, head):
    st = it.get("status")
    if st == "fixed":
        # fixed は「直したので再レビューが要る」。HEAD が進んだ新しいレビューで引き継がれたものだけ通す
        return bool(it.get("re_reviewed_sha")) and it.get("re_reviewed_sha") == head
    if st == "accepted":
        if it.get("verifier") != "upheld":
            return False
        if it.get("high_risk") is True and it.get("approved_by") != "human":
            return False
        return True
    return False


def unresolved(rec, head):
    items = rec.get("must_address") if isinstance(rec, dict) else None
    return [it for it in (items or []) if not isinstance(it, dict) or not item_ok(it, head)]


def cmd_check(a):
    try:
        with open(a.latest, encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, ValueError) as e:
        die("latest.json を読めません: %s" % e, 2)
    bad = unresolved(rec, a.head)
    if rec.get("verdict") == "must-address" and not (rec.get("must_address") or []):
        # pre-push と同じ基準: must-address なのに項目が無い記録は壊れている
        print("-\t-\t-\tverdict=must-address なのに項目が無い（記録が壊れている）")
        sys.exit(1)
    for it in bad:
        why = {
            "open": "未処理",
            "fixed": "fixed と記録済み。commit して /ai-review を再実行する",
        }.get(it.get("status"), "")
        if it.get("status") == "accepted":
            if it.get("verifier") != "upheld":
                why = "理由の検証が済んでいない（verifier=%s）" % it.get("verifier")
            else:
                why = "高リスクのため人の承認が要る"
        print(safe("%s\t%s\t%s:%s\t%s" % (it.get("id"), it.get("tier"), it.get("file"), it.get("line"), why)))
    sys.exit(1 if bad else 0)


# ---------------------------------------------------------------- 1 件の処理

def cmd_resolve(a):
    try:
        with open(a.latest, encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, ValueError) as e:
        die("latest.json を読めません: %s" % e)
    items = rec.get("must_address") or []
    if a.list:
        for it in items:
            print(safe("%s\t%s\t%s\t%s:%s\t%s\tstatus=%s verifier=%s high_risk=%s approved_by=%s" % (
                it.get("id"), it.get("tier"), it.get("severity"), it.get("file"), it.get("line"),
                it.get("source"), it.get("status"), it.get("verifier", "-"),
                it.get("high_risk"), it.get("approved_by", "-"))))
        return
    target = [it for it in items if str(it.get("id")) == a.id]
    if not target:
        die("id=%s の項目がありません（--list で確認）" % a.id)
    it = target[0]
    hist = it.setdefault("history", [])
    ts = now()

    if a.action != "fixed" and rec.get("head_sha") != a.head:
        die("latest.json の head_sha（%s）と HEAD（%s）が違います。理由・検証・承認はレビューした"
            "コードに対して記録するものです。/ai-review を再実行してください" % (str(rec.get("head_sha"))[:7], a.head[:7]))
    if it.get("status") == "fixed" and it.get("re_reviewed_sha"):
        die("id=%s は再レビュー済みの引き継ぎ項目です。変更できません" % a.id)

    if a.action == "fixed":
        it["status"] = "fixed"
        it["fixed_at"] = ts
        it["fixed_note"] = a.note or ""
        for k in ("verifier", "verifier_note", "approved_by", "approval_note"):
            it.pop(k, None)
        hist.append({"at": ts, "action": "fixed", "note": a.note or ""})
        print("[ai-review] %s を fixed と記録しました。commit して /ai-review を再実行するまで push は通りません" % a.id,
              file=sys.stderr)
    elif a.action == "accepted":
        if not (a.reason or "").strip():
            die("--accepted には --reason（直さない理由。コードで確かめられる形で）が要ります")
        it["status"] = "accepted"
        it["reason"] = a.reason.strip()
        it["verifier"] = "pending"
        for k in ("verifier_note", "approved_by", "approval_note"):
            it.pop(k, None)
        hist.append({"at": ts, "action": "accepted", "reason": it["reason"]})
        print("[ai-review] %s を accepted（検証待ち）と記録しました。作業の文脈を持たない別のサブエージェントに"
              "理由をコードで検証させ、--verifier upheld|rejected で記録してください" % a.id, file=sys.stderr)
    elif a.action == "verifier":
        if it.get("status") != "accepted" or it.get("verifier") != "pending":
            die("id=%s は検証待ちではありません（status=%s verifier=%s）" % (a.id, it.get("status"), it.get("verifier")))
        if not (a.note or "").strip():
            die("--verifier には --note（検証したサブエージェントの結論の要約）が要ります")
        it["verifier_note"] = a.note.strip()
        hist.append({"at": ts, "action": "verifier", "result": a.verdict, "note": it["verifier_note"]})
        if a.verdict == "upheld":
            it["verifier"] = "upheld"
            if it.get("high_risk"):
                print("[ai-review] %s は高リスクです。ユーザーにチャットで承認を求め、明示の承認があったときだけ"
                      " --approve-human を記録してください（自分で承認しない）" % a.id, file=sys.stderr)
        else:
            it["verifier"] = "rejected"
            it["status"] = "open"
            print("[ai-review] %s の理由は検証で退けられました。open に戻しました（直すか、別の理由で出し直す）" % a.id,
                  file=sys.stderr)
    elif a.action == "approve":
        if not it.get("high_risk"):
            die("id=%s は高リスクではないので人の承認は要りません" % a.id)
        if it.get("status") != "accepted" or it.get("verifier") != "upheld":
            die("人の承認は、accepted かつ検証 upheld の項目にだけ記録できます")
        if not (a.note or "").strip():
            die("--approve-human には --note（承認の理由）が要ります")
        # 端末（/dev/tty）で ID を打ち込んだときだけ記録する。resolve-item.sh を経ずに gate.py を直接呼んでも同じ。
        # AI の Bash には端末が無い（疑似端末を作れば通せるので、技術的な強制ではない。DESIGN-v3.md）
        try:
            # 読み書き両用（r+）はシークできず例外になるので、読みと書きを分けて開く
            tty_in = open("/dev/tty", "r", encoding="utf-8")
            tty_out = open("/dev/tty", "w", encoding="utf-8")
        except OSError:
            die("人の承認は、ユーザー自身が端末で実行してください（端末がありません）:\n"
                "  ~/.claude/skills/ai-review/scripts/resolve-item.sh --id %s --approve-human --note \"<承認の理由>\"" % a.id)
        with tty_in, tty_out:
            tty_out.write("[ai-review] 項目 %s を人として承認します。確認のため ID を入力してください: " % safe(a.id))
            tty_out.flush()
            typed = tty_in.readline().strip()
        if typed != a.id:
            die("入力が ID と一致しないため記録しません")
        it["approved_by"] = "human"
        it["approval_note"] = a.note.strip()
        it["approved_at"] = ts
        hist.append({"at": ts, "action": "approved_by_human", "note": it["approval_note"]})

    left = unresolved(rec, rec.get("head_sha"))
    print(json.dumps(rec, ensure_ascii=False, indent=2))
    print("[ai-review] 未処理 %d 件" % len(left), file=sys.stderr)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest="cmd", required=True)

    t = sp.add_parser("table-check")
    t.add_argument("--output", required=True)
    t.add_argument("--files", required=True)
    t.set_defaults(fn=cmd_table_check)

    s = sp.add_parser("summary")
    s.add_argument("--run", required=True)
    s.set_defaults(fn=cmd_summary)

    r = sp.add_parser("record")
    r.add_argument("--run", default="")
    r.add_argument("--verdict", required=True, choices=list(LEVEL))
    r.add_argument("--items", default="")
    r.add_argument("--head", required=True)
    r.add_argument("--branch", default="")
    r.add_argument("--mode", default="branch")
    r.add_argument("--escalate", default="false")
    r.add_argument("--escalation-done", default="false")
    r.add_argument("--skipped-by-user", default="false")
    r.add_argument("--reason", default="")
    r.add_argument("--report", default="")
    r.add_argument("--previous", default="")
    r.add_argument("--rules", action="append")
    r.add_argument("--no-diff", action="store_true")
    r.set_defaults(fn=cmd_record)

    c = sp.add_parser("check")
    c.add_argument("--latest", required=True)
    c.add_argument("--head", required=True)
    c.set_defaults(fn=cmd_check)

    v = sp.add_parser("resolve")
    v.add_argument("--latest", required=True)
    v.add_argument("--head", default="")
    v.add_argument("--list", action="store_true")
    v.add_argument("--id", default="")
    v.add_argument("--action", choices=["fixed", "accepted", "verifier", "approve"])
    v.add_argument("--reason", default="")
    v.add_argument("--verdict", choices=["upheld", "rejected"])
    v.add_argument("--note", default="")
    v.set_defaults(fn=cmd_resolve)

    a = p.parse_args()
    if a.cmd == "resolve" and not a.list:
        if not a.id or not a.action:
            die("--id と処理（--fixed / --accepted / --verifier / --approve-human）が要ります")
        if a.action == "verifier" and not a.verdict:
            die("--verifier には upheld か rejected を付けてください")
    a.fn(a)


if __name__ == "__main__":
    main()
