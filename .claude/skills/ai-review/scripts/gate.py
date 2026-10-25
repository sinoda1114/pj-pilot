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
import shlex
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


def _strip_root(f):
    """隔離 worktree や本体の絶対パスを外す。"""
    if f.startswith("/"):
        m = re.match(r"^.*?/ai-review-wt\.[^/]+/(.*)$", f)
        if m:
            f = m.group(1)
        else:
            root = os.getcwd().rstrip("/") + "/"
            if f.startswith(root):
                f = f[len(root):]
    return f


def _repo_path(f):
    """項目の file をリポジトリからの相対パスにする（./、隔離 worktree や本体の絶対パスを外す）。"""
    return _strip_root(_clean_cell(f or ""))


def _in_tree(rev, path):
    """path が rev の木にあるか。git が失敗したら None（呼び出し側は「分からない」を安全な側に倒す）"""
    if not (isinstance(rev, str) and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", rev)):
        return None  # 記録から読んだ値なので、SHA の形でなければ git に渡さない
    if "\0" in path:
        return False  # NUL を含む名前のファイルは作れない
    import subprocess
    try:
        r = subprocess.run(["git", "--literal-pathspecs", "ls-tree", "-z", "--full-tree", "--name-only", rev, "--", path],
                           capture_output=True)
    except (OSError, ValueError):
        return None
    if r.returncode != 0:
        return None
    return path.encode("utf-8", "surrogateescape") in r.stdout.split(b"\0")


def _in_diff(f, changed, item_head):
    """項目の file が、差分の一覧（git が出した生のパスの集合）にあるか。
    項目が指すファイルを、項目を最初に記録したときの木（item_head）で 1 つに決めてから比べる。整形しない形
    （絶対パスと ./ だけ外す）がその木にあればそれ、無ければ整形（空白・:行番号・装飾を外す）した形。
    整形した形と整形しない形の両方で比べると、変わった名前のファイル（`n8.js:12`）を足したり、それに付いた
    fixed を `n8.js` の変更で片づけたりして、確かめていない fixed を再レビュー済みにできる（ai-review#5 の 8）。
    git で決められなければ一致にしない（fixed は open に戻る）"""
    f = f or ""
    raw = re.sub(r"^\./", "", _strip_root(f))
    exists = _in_tree(item_head, raw)
    if exists is None:
        return False
    return (raw if exists else _repo_path(f)) in changed


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
        if iid.startswith(("auto-", "prev-", "carry-")):
            die("--items[%d] の id %r は予約されています（auto- / prev- / carry- は記録時に自動で付く）" % (i, iid))
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


# ---------------------------------------------------------------- 差分レビュー（DESIGN-v3.md §10）
# 大きいブランチでは、2 周目以降は前回レビューした SHA からの差分だけをレビューする。
# 1 周目（全体）から差分レビューが途切れずにつながっていること（チェーン）を記録で確かめ、
# push の前には全体のレビューを 2 回（最初と最後）経ていることを求める。

FULL_REVIEWS_BEFORE_PUSH = 2


def size_limits(rule_files):
    """escalation-rules の max_files / max_added（後のファイルが前を上書きする）"""
    lim = {}
    for rf in rule_files or []:
        try:
            with open(rf, encoding="utf-8") as f:
                lines = f.read().splitlines()
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) >= 2 and parts[0] in ("max_files", "max_added") and parts[1].isdigit():
                lim[parts[0]] = int(parts[1])
    return lim


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError, TypeError):
        return {}
    return d if isinstance(d, dict) else {}


def write_json_atomic(path, data):
    """同じディレクトリの一時ファイルに書いてから置き換える。失敗したら一時ファイルを消す"""
    import pathlib
    import tempfile
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".")
    os.close(fd)
    try:
        pathlib.Path(tmp).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def merge_secret_paths(esc, full):
    """escalation.json に、ブランチ全体の判定（full）の秘密情報のパスを足す。full が無ければ "?"（Codex を起動しない）"""
    # 読めなければ例外で落とす（黙って空にすると、秘密情報が無いことにされ Codex を起動してしまう）
    with open(esc, encoding="utf-8") as fh:
        d = json.load(fh)
    if full:
        with open(full, encoding="utf-8") as fh:
            f = json.load(fh)
        d["secret_paths"] = list(dict.fromkeys((d.get("secret_paths") or []) + (f.get("secret_paths") or [])))
    else:
        d["secret_paths"] = "?"
    write_json_atomic(esc, d)


def cmd_merge_secrets(a):
    merge_secret_paths(a.esc, a.full)


def force_escalation(scope, esc):
    """scope.json の force_escalation が真なら、escalation.json の escalate を真にして理由を足す"""
    with open(scope, encoding="utf-8") as fh:
        sc = json.load(fh)
    if sc.get("force_escalation") is not True:
        return
    with open(esc, encoding="utf-8") as fh:
        d = json.load(fh)
    d["escalate"] = True
    why = {"size": "F:size:ブランチ全体が規模の上限を超えたが、まだ規模による深掘りをしていない"}
    d["reasons"] = (d.get("reasons") or []) + [why.get(sc.get("force_reason"), "F:chain:1 周目で深掘りが加わったブランチの最後の全体レビュー")]
    write_json_atomic(esc, d)


def cmd_force_escalation(a):
    force_escalation(a.scope, a.esc)


def carried_over(it):
    """前回の記録の項目が、次の周の記録に持ち越されるか（再レビュー済みの fixed だけは持ち越さない）。
    cmd_record の引き継ぎと carries_block の両方がこれを使う（片方だけ変えると block が消える穴が戻る）"""
    return not (it.get("status") == "fixed" and it.get("re_reviewed_sha"))


def carries_block(prev):
    """前回の記録に、次の周へ BLOCK を持ち越す項目があるか。
    未再レビューの fixed の BLOCK も True にする。heavy_fixed（tier == BLOCK）が拾って次の周は全体レビューに
    なるので block は消えない（heavy_fixed の条件を緩めるときは、ここも見直す）"""
    return any(isinstance(it, dict) and it.get("tier") == "BLOCK" and carried_over(it)
               for it in prev.get("must_address") or [])


def block_not_carried(prev):
    """結論が block なのに、次の周へ BLOCK を持ち越す項目が無い記録か。差分レビューが引き継ぐのは項目だけなので、
    この記録の次を差分レビューにすると block が消え、差分で何も出なければ pass になる（ai-review#5 の 9）。
    チェーンは切らずに（深掘りの義務 chain_escalated や full_count を残すため）、次の周を全体にする"""
    return prev.get("verdict") == "block" and not carries_block(prev)


def chain_continues(prev, branch, merge_base, prev_ancestor, dry=False):
    """前回の記録が、今回のレビューと同じチェーン（同じブランチ・同じ起点・HEAD の祖先）にあるか"""
    return bool(
        prev.get("mode") == "branch"
        # ダミー実行の記録は、ダミー実行どうしでしかつなげない（実モデルのチェーンに混ぜない）
        and bool(prev.get("dry_run")) == dry
        and prev.get("branch") == branch
        and prev.get("chain_base")
        and prev.get("chain_base") == merge_base
        and isinstance(prev.get("full_count"), int) and prev["full_count"] >= 1
        # レビュアーが 1 本も結果を返さなかった記録（中身のない block）とはつながない
        and "_none" not in (prev.get("sources") or {})
        # 深掘りを求められたのに済ませていない記録とはつながない（つなぐと、次の差分の記録で深掘りの義務が消える）
        and not (prev.get("escalate") is True and prev.get("escalation_done") is not True
                 and prev.get("skipped_by_user") is not True)
        and isinstance(prev.get("head_sha"), str)
        and bool(re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", prev["head_sha"]))
        and prev_ancestor
    )


def is_ancestor(sha, head):
    """sha が head の祖先か（git で確かめる）。つなぎ先を差し替えたとき、シェルが確かめた値の代わりに使う"""
    if not (isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", sha)):
        return False
    import subprocess
    try:
        return subprocess.run(["git", "merge-base", "--is-ancestor", sha, head], capture_output=True).returncode == 0
    except OSError:  # git が見つからないなど。確かめられなければ祖先とみなさない
        return False


def branch_record(prev):
    """--local の記録が持っている、直前の branch の記録（差分レビューのチェーンを --local で切らないため）"""
    if prev.get("mode") != "local" or not isinstance(prev.get("_branch_record"), str) or not prev["_branch_record"]:
        return None
    try:
        d = json.loads(prev["_branch_record"])
    except ValueError:
        return None
    return d if isinstance(d, dict) else None


def heavy_fixed(prev, pats=None):
    """前回の記録で fixed にしたが、まだ再レビューしていない項目のうち、差分レビューでは確かめきれないもの:
    重い項目（BLOCK・高リスク・セキュリティ）と、差分に入らず open に戻したことがある項目（reopened）"""
    return [it for it in prev.get("must_address") or []
            if isinstance(it, dict) and it.get("status") == "fixed" and not it.get("re_reviewed_sha")
            and (it.get("tier") == "BLOCK" or it.get("high_risk") is True or it.get("category") == "security"
                 or it.get("reopened") is True
                 # 今の高リスクの決まり（後から足した path ルールを含む）にも当てる
                 or (pats is not None and high_risk_of(it, pats)[0]))]


def cmd_plan(a):
    prev = read_json(a.latest)
    # 祖先の確認はシェルが sed で読んだ値で行っているので、JSON の値と同じときだけつなぐ
    anc = a.prev_ancestor == "true" and prev.get("head_sha") == a.prev_head
    if branch_record(prev) is not None:  # 直近が --local の記録なら、その前の branch の記録につなぐ
        prev = branch_record(prev)
        anc = is_ancestor(prev.get("head_sha"), a.head)
    chained = chain_continues(prev, a.branch, a.merge_base, anc, a.dry)
    lim = size_limits(a.rules)
    large = a.files > lim.get("max_files", 10 ** 9) or a.added > lim.get("max_added", 10 ** 9)
    clean = chained and not unresolved(prev, prev.get("head_sha")) and prev.get("verdict") in ("pass", "must-address")
    out = {"scope": "full", "since": "", "no_size": chained, "merge_base": a.merge_base}
    if a.full:
        out["why"] = "--full の指定"
    elif not chained:
        out["why"] = "前回の記録とつながらない（1 周目・別のブランチ・起点が変わった）"
    elif not large and not a.incremental:
        out["why"] = "差分が小さい（max_files / max_added 以下）ので毎回全体を見る"
    elif prev.get("head_sha") == a.head:
        out["why"] = "前回と同じ HEAD"
    elif heavy_fixed(prev, path_rules(a.rules or [])):
        # 差分レビューは「そのファイルが差分にあるか」までしか確かめられない。重い項目と、一度 open に戻した項目の
        # fixed は全体で確かめる（戻した項目は、差分レビューを続ける限り確かめられない）
        out["why"] = "BLOCK・高リスク・セキュリティ、または差分に入らなかった項目を fixed にしたので、全体で確かめる"
    elif block_not_carried(prev):
        out["why"] = "前回の結論は block だが、引き継げる BLOCK の項目が無い（差分レビューでは block を引き継げない）ので、全体を見る"
    elif large and prev.get("chain_size_escalated") is not True:
        # 規模による深掘りがまだのブランチは、深掘りが全体を見るように、この周を全体にする
        out["why"] = "ブランチ全体が規模の上限を超えたが、まだ規模による深掘りをしていないので、全体を深掘りする"
    elif prev.get("scope") == "incremental" and clean and prev["full_count"] < FULL_REVIEWS_BEFORE_PUSH:
        out["why"] = "差分レビューが片づいたので、最後に全体を見る"
    else:
        out.update({"scope": "incremental", "since": prev["head_sha"],
                    "why": "前回レビューした %s からの差分だけを見る" % prev["head_sha"][:7]})
    # 1 周目で深掘りが加わったブランチは、2 回目以降の全体レビュー（最後の全体）でも深掘りを加える。
    # 差分レビューの周は、その周の差分の昇格判定に任せる
    # 強制するのは「差分レビューの後の全体」（最後の全体）だけ。小さいブランチは毎周全体なので、毎周強制しない
    out["force_escalation"] = bool(chained and out["scope"] == "full" and prev.get("chain_escalated") is True
                                   and prev.get("scope") == "incremental")
    out["force_reason"] = "chain" if out["force_escalation"] else ""
    # 差分レビューの周は規模の判定を飛ばす（no_size）。ただし、今のブランチ全体が上限を超えているのに、
    # これまでの周で規模による深掘りを一度もしていなければ、深掘りを求める（1 周目が小さかったブランチ）
    if chained and large and prev.get("chain_size_escalated") is not True and out["scope"] == "full":
        out["force_escalation"] = True
        out["force_reason"] = "size"
    print(json.dumps(out, ensure_ascii=False))


def cmd_record(a):
    items = load_items(a.items)
    s = summarize(a.run) if a.run else None
    esc = None
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
    prev = read_json(a.previous) if a.previous else {}
    prev_anc = a.prev_ancestor == "true"
    local_prev = prev if prev.get("mode") == "local" else None
    if a.mode == "branch" and branch_record(prev) is not None:
        prev = branch_record(prev)
        prev_anc = is_ancestor(prev.get("head_sha"), a.head)
    # 同じ run か: run ディレクトリの名前（run-<時刻>）で比べる（--report が相対パスでも、どこから記録しても同じになる）
    run_name = os.path.basename(os.path.normpath(os.path.abspath(a.run))) if a.run else ""
    prev_run = prev.get("run") or os.path.basename(os.path.dirname(os.path.normpath(prev.get("report") or "")))
    same_run = bool(run_name) and prev_run == run_name
    if same_run:
        # 同じ出力先で run-reviews.sh を回し直したなら、記録し直しではない（レビュー済みの印が前の記録より新しい）
        try:
            ran = os.path.getmtime(os.path.join(a.run, "reviewed_sha.review"))
            rec_at = datetime.datetime.strptime(prev.get("recorded_at") or "", "%Y-%m-%dT%H:%M:%S%z").timestamp()
            same_run = ran < rec_at + 1  # recorded_at は秒で切り捨てているので 1 秒の余裕を見る
        except (OSError, ValueError):
            same_run = False
    replaced = {}
    prev_prev = prev.get("_previous")
    if isinstance(prev_prev, str):
        try:
            prev_prev = json.loads(prev_prev) if prev_prev else {}
        except ValueError:
            prev_prev = None
    if same_run and isinstance(prev_prev, dict) and prev.get("head_sha") == a.head:
        sc0 = read_json(os.path.join(a.run, "scope.json")) or {}
        if prev.get("scope") == sc0.get("scope", "full") and (prev.get("scope") != "incremental"
                                                             or prev.get("since_sha") == sc0.get("since")):
            # 同じ HEAD・同じ範囲の run を記録し直す（深掘りを後から済ませたときなど）。
            # 前回の記録は今回の結果なので、その前の記録をつなぎ先にする
            replaced = prev  # 記録し直す前の記録（その間に付けた項目の処理を引き継ぐ）
            prev = prev_prev
            prev_anc = is_ancestor(prev.get("head_sha"), a.head)  # 差し替えたつなぎ先は git で確かめ直す
    is_dry = bool(a.run) and os.path.exists(os.path.join(a.run, "dry-run.flag"))
    chained = chain_continues(prev, a.branch, a.merge_base, prev_anc, is_dry)
    scope = {"scope": "full"}
    # チェーン（差分レビュー・最後の全体）の検査は branch の記録だけ。--local は途中の確認で push の根拠にしない
    if a.run and not a.no_diff and a.mode == "branch":
        scope = read_json(os.path.join(a.run, "scope.json")) or {"scope": "full"}
        if scope.get("scope") not in ("full", "incremental"):
            die("run ディレクトリの scope.json が不正です（scope=%r）" % scope.get("scope"))
        if scope["scope"] == "incremental":
            if not chained or scope.get("since") != prev.get("head_sha") or prev.get("head_sha") == a.head:
                die("差分レビューの比較元（%s）が、同じブランチの前回の記録の head_sha（%s）とつながりません。"
                    "run-reviews.sh --full で全体をレビューしてください"
                    % (str(scope.get("since"))[:7], str(prev.get("head_sha"))[:7]))
        try:
            with open(os.path.join(a.run, "escalation.json"), encoding="utf-8") as f:
                size_skipped = json.load(f).get("size_skipped") is True
        except (OSError, ValueError, AttributeError):
            size_skipped = False
        heavy = heavy_fixed(prev, path_rules(a.rules or [])) if scope["scope"] == "incremental" else []  # 判定と表示で同じ結果を使う
        if heavy:
            die("前回の記録に、差分レビューでは確かめきれない fixed（%s）があります。"
                "run-reviews.sh --full で全体をレビューしてから記録してください"
                % ", ".join(str(it.get("id")) for it in heavy)[:200])
        if scope["scope"] == "incremental" and block_not_carried(prev):
            die("前回の記録の結論は block ですが、引き継げる BLOCK の項目がありません（差分レビューでは block を"
                "引き継げません）。run-reviews.sh --full で全体をレビューしてから記録してください")
        if size_skipped and not chained:
            die("規模による昇格を飛ばした run ですが、前回の記録とつながりません（規模の判定は 1 周目に要る）")
        if (scope["scope"] == "full" and chained and prev.get("chain_escalated") is True
                and prev.get("scope") == "incremental"
                and a.escalate != "true"):
            die("1 周目で深掘りが加わったブランチの全体レビューです。own-security を回し、--escalate true で記録してください"
                "（ユーザーが明示した場合だけ --skipped-by-user true）")
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
    if LEVEL[verdict] > LEVEL[given]:
        print("[ai-review] 結論を %s → %s に引き上げました（生出力・項目から機械的に決まる下限）"
              % (given, verdict), file=sys.stderr)

    # 前回の記録で fixed にした項目は、HEAD が進んだ新しいレビューで再レビュー済みとして残す
    prev_fixed = []
    carried = []
    incremental = scope.get("scope") == "incremental"
    changed = set()
    taken = {str(it["id"]) for it in items}

    def carry_id(iid):
        """引き継ぐ項目の ID。今回の項目・先に引き継いだ項目と重なれば番号を足す（resolve-item が最初の 1 件しか触れないため）"""
        iid = str(iid)
        base = iid if iid.startswith("carry-") else "carry-" + iid
        cid, n = base, 2
        while cid in taken:
            cid, n = "%s-%d" % (base, n), n + 1
        taken.add(cid)
        return cid
    if incremental and a.run:
        # 削除・名前変更の旧パスも含む一覧（changed-files-all.nul。NUL 区切り）を使う。判定表用の changed-files.txt は
        # 削除を除き、改行区切りなので使わない。git が出したパスはそのまま比べる（strip や _repo_path の整形をすると、
        # 改行・末尾の空白・:行番号 を含む名前のファイルで別のパスを「差分にある」と見せかけられる。ai-review#5 の 8）。
        # newline="" で読む（既定の改行変換は CR を LF に変え、CR と LF だけが違う別のパスを一致させる）
        try:
            with open(os.path.join(a.run, "changed-files-all.nul"), encoding="utf-8", errors="surrogateescape",
                      newline="") as f:
                changed = {p for p in f.read().split("\0") if p}
        except OSError:
            # 一覧が無ければ、差分にあると確かめられないので fixed は open に戻る
            if os.path.exists(os.path.join(a.run, "changed-files-all.txt")):
                print("[ai-review] 注意: run ディレクトリの変更ファイルの一覧が古い形式（changed-files-all.txt）です。"
                      "fixed はすべて open に戻ります。run-reviews.sh を回し直してください", file=sys.stderr)
    if prev.get("branch") == a.branch and prev.get("head_sha") and prev.get("head_sha") != a.head:
        for it in prev.get("must_address") or []:
            if not isinstance(it, dict):
                continue
            if (it.get("status") == "fixed" and not it.get("re_reviewed_sha") and incremental
                    and not _in_diff(it.get("file"), changed, it.get("item_head") or prev["head_sha"])):
                # 差分レビューは差分の中しか見ないので、差分にそのファイルが無い fixed は確かめられていない。
                # 再レビュー済みにせず、open に戻して引き継ぐ（偽の fixed で BLOCK・高リスクを抜けさせない）
                c = dict(it, status="open")
                c["id"] = carry_id(it.get("id"))
                c["carried_from"] = prev.get("head_sha")
                # 項目を最初に記録した HEAD は上書きせずに持ち回る（_in_diff は、項目が指すファイルをその木で決める。
                # 直前の記録の木で決めると、間の周に足した同名のファイルで指す先をすり替えられる）
                c["item_head"] = it.get("item_head") or prev.get("head_sha")
                c["note"] = "fixed だったが、差分レビューの差分にこのファイルが無いので確かめられていない"
                c["reopened"] = True  # また fixed にしたら、次の周は全体で確かめる（heavy_fixed）
                carried.append(c)
            elif it.get("status") == "fixed" and not it.get("re_reviewed_sha"):
                c = dict(it)
                c["id"] = "prev-" + str(it.get("id"))
                c["re_reviewed_sha"] = a.head
                c["previous_head_sha"] = prev.get("head_sha")
                prev_fixed.append(c)
            elif incremental and carried_over(it):
                # 差分レビューは前回より前のコードを見直さないので、同じ指摘は出直さない。
                # 片づいていない項目（と、片づいた accepted）を引き継いで落とさない
                c = dict(it)
                c["id"] = carry_id(it.get("id"))
                c["carried_from"] = prev.get("head_sha")
                # 項目を最初に記録した HEAD は上書きせずに持ち回る（_in_diff は、項目が指すファイルをその木で決める。
                # 直前の記録の木で決めると、間の周に足した同名のファイルで指す先をすり替えられる）
                c["item_head"] = it.get("item_head") or prev.get("head_sha")
                if c.get("status") == "accepted":
                    # 理由が差分のどこ（別のファイルの呼び出し元など）に依存するかは機械では分からない。
                    # HEAD が進んだので、検証と人の承認をやり直す（理由そのものは残す）
                    c["verifier"] = "pending"
                    c.pop("approved_by", None)
                    c.pop("approval_note", None)
                carried.append(c)
    # 引き継いだ項目にも、今の高リスクの決まりを当てる（後から足した path ルールを含む）
    for c in carried:
        hr, why = high_risk_of(c, pats)
        if hr and c.get("high_risk") is not True:
            c["high_risk"] = True
            c["high_risk_reason"] = why
            c.pop("approved_by", None)
    if carried:
        level = max([level] + [TIER_LEVEL.get(it.get("tier"), 1) for it in carried])
        verdict = [k for k, v in LEVEL.items() if v == level][0]
    # 記録し直しでは、同じ項目（新しい項目・自動の項目・引き継ぎ・再レビュー済み）に付けた処理
    # （fixed・accepted・検証・承認）を引き継ぐ。照合は ID・file・summary がすべて同じこと
    if replaced:
        done = {str(it.get("id")): it for it in replaced.get("must_address") or []
                if isinstance(it, dict) and it.get("status") in ("fixed", "accepted")}
        keep = ("status", "history", "reason", "verifier", "verifier_note", "approved_by", "approval_note",
                "fixed_at", "fixed_note")
        for it in items + carried + prev_fixed:
            old = done.get(str(it.get("id")))
            if old and old.get("file") == it.get("file") and old.get("summary") == it.get("summary"):
                it.update({k: old[k] for k in keep if k in old})
    if verdict == "must-address" and not items and not carried:
        die("結論が must-address ですが項目がありません")

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
        "run": os.path.basename(os.path.normpath(os.path.abspath(a.run))) if a.run else "",
        "recorded_at": now(),
        "sources": (s["sources"] if s else {}),
        "must_address": items + carried + prev_fixed,
    }
    if a.mode == "branch" and not a.no_diff:
        # チェーンの記録（次の周の plan と pre-push が読む）
        rec["scope"] = scope.get("scope", "full")
        rec["chain_base"] = a.merge_base
        base_count = prev["full_count"] if chained else 0
        # 数えるのは「1 周目の全体」と「差分の周の後の全体」だけ。同じ HEAD や全体どうしの回し直しでは増やさない
        # （増やすと、最後の全体レビューを経ずに pre-push の full_count >= 2 を満たせる）
        counts = rec["scope"] == "full" and (not chained or prev.get("scope") == "incremental")
        rec["full_count"] = base_count + (1 if counts else 0)
        # 規模による深掘りが済んだか: 規模の昇格（C:・F:size）で深掘りした、または全体レビューで深掘りした
        # （ブランチ全体を深掘りしたので、規模の懸念も見ている）。ダミー実行の判定は規模を見ないので済んだ扱いにする
        # （実際の判定は AI_REVIEW_DRY_ESCALATION=real で試す）
        size_esc = isinstance(esc, dict) and any(str(r).startswith(("C:", "F:size")) for r in esc.get("reasons") or [])
        # ユーザーが明示して深掘りを飛ばした全体レビューも「済んだ」扱いにする（求め続けると、毎周全体と深掘りの要求になる）
        # 飛ばした扱いにするのは、昇格を求められたうえでユーザーが飛ばしたときだけ
        full_deep = rec["scope"] == "full" and (a.escalation_done == "true"
                                                or (a.escalate == "true" and a.skipped_by_user == "true"))
        dry_esc = isinstance(esc, dict) and esc.get("dry_run") is True
        rec["chain_size_escalated"] = bool((prev.get("chain_size_escalated") is True and chained)
                                           or (size_esc and a.escalation_done == "true" and rec["scope"] == "full") or full_deep or dry_esc)
        rec["chain_escalated"] = (prev.get("chain_escalated") is True) if chained else (a.escalate == "true")
        if rec["scope"] == "incremental":
            rec["since_sha"] = scope.get("since")
    elif a.no_diff:
        rec["scope"] = "none"
    if a.run and os.path.exists(os.path.join(a.run, "dry-run.flag")):
        # ダミー実行（AI_REVIEW_DRY_RUN=1）の結果。pre-push は AI_REVIEW_ALLOW_DRY=1 が無ければ拒む
        rec["dry_run"] = True
        print("[ai-review] 注意: ダミー実行の結果です。push の根拠になりません", file=sys.stderr)
    if a.mode == "branch" and not a.no_diff:
        # 同じ HEAD の run を記録し直すときのつなぎ先（1 段だけ）。前の記録とつながったときだけ残す（つながらなければ空）。
        # JSON の文字列で持つ（pre-push はファイル全体を grep するので、入れ子の dry_run などのキーを拾わせない）
        # 同じブランチの前の記録なら残す（記録し直しのときに、祖先かを git で確かめ直してからつなぐ）
        rec["_previous"] = (json.dumps({k: v for k, v in prev.items() if k != "_previous"}, ensure_ascii=False)
                            if prev.get("branch") == a.branch and prev.get("mode") == "branch" else "")
    if a.mode == "local":
        # 直前の branch の記録を持っておく（次の branch のレビューが、--local を挟んでも差分レビューのチェーンにつながる）
        b = (local_prev and branch_record(local_prev)) or (prev if prev.get("mode") == "branch" else None)
        # 1 段前の記録（_previous）も含めて丸ごと持つ（--local の後に、同じ branch の run を記録し直せるように）
        rec["_branch_record"] = json.dumps(b, ensure_ascii=False) if b else ""
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
    if rec.get("scope") == "incremental" and not (
            isinstance(rec.get("full_count"), int) and rec["full_count"] >= FULL_REVIEWS_BEFORE_PUSH):
        print("-\t-\t-\t差分レビューの記録です。push の前に最後の全体レビューが要る"
              "（未処理の項目があれば先に片づける。片づいていれば /ai-review の再実行で全体を見る）")
        need_full = True
    else:
        need_full = False
    if rec.get("verdict") == "must-address" and not (rec.get("must_address") or []):
        # pre-push と同じ基準: must-address なのに項目が無い記録は壊れている
        print("-\t-\t-\tverdict=must-address なのに項目が無い（記録が壊れている）")
        sys.exit(1)
    for it in bad:
        if not isinstance(it, dict):  # 項目の形が壊れている（表示で落ちない）
            print("-\t-\t-\t項目の形が不正（記録が壊れている）")
            continue
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
    sys.exit(1 if bad or need_full else 0)  # 全体レビューの不足と未処理の項目は、両方出してから止める


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
            ri = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resolve-item.sh")
            die("人の承認は、ユーザー自身が端末で実行してください（端末がありません）:\n"
                "  %s --id %s --approve-human --note \"<承認の理由>\"" % (shlex.quote(ri), shlex.quote(a.id)))
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
    r.add_argument("--merge-base", default="")
    r.add_argument("--prev-ancestor", default="false")
    r.set_defaults(fn=cmd_record)

    pl = sp.add_parser("plan")
    pl.add_argument("--latest", required=True)
    pl.add_argument("--head", required=True)
    pl.add_argument("--branch", required=True)
    pl.add_argument("--merge-base", required=True)
    pl.add_argument("--prev-ancestor", default="false")
    pl.add_argument("--prev-head", default="")
    pl.add_argument("--files", type=int, required=True)
    pl.add_argument("--added", type=int, required=True)
    pl.add_argument("--rules", action="append")
    pl.add_argument("--full", action="store_true")
    pl.add_argument("--dry", action="store_true")
    pl.add_argument("--incremental", action="store_true", help="規模に関係なく、つながっていれば差分レビューにする（/ai-review-fix の 2 周目以降）")
    pl.set_defaults(fn=cmd_plan)

    ms = sp.add_parser("merge-secrets")
    ms.add_argument("--esc", required=True)
    ms.add_argument("--full", default="")
    ms.set_defaults(fn=cmd_merge_secrets)

    fe = sp.add_parser("force-escalation")
    fe.add_argument("--scope", required=True)
    fe.add_argument("--esc", required=True)
    fe.set_defaults(fn=cmd_force_escalation)

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
