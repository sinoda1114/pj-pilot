#!/usr/bin/env bash
# /ai-review v3 MUST-ADDRESS の 1 件を処理した記録（C 案。DESIGN-v3.md §6）
#
# 使い方（リポジトリ内のどこからでも。書き先はルートの .review-reports/latest.json）:
#   resolve-item.sh --list
#   resolve-item.sh --id <ID> --fixed [--note "<何を直したか>"]
#       直した。commit して /ai-review を再実行するまで push は通らない（再実行で「再レビュー済み」として引き継ぐ）
#   resolve-item.sh --id <ID> --accepted --reason "<直さない理由。コードで確かめられる形で>"
#       直さない。理由は検証待ちになる
#   resolve-item.sh --id <ID> --verifier upheld|rejected --note "<検証したサブエージェントの結論>"
#       作業の文脈を持たない別のサブエージェントが、理由がコードで成り立つかを確かめた結果。
#       rejected なら項目は open に戻る
#   resolve-item.sh --id <ID> --approve-human --note "<承認の理由>"
#       高リスク（high_risk=true）の項目だけ。ユーザー自身が端末で実行し、確認のため ID を打ち込む
#       （端末が無いと記録しない。AI が自分で承認してはいけない）
#
# 理由・検証・承認は、レビューした HEAD（latest.json の head_sha）に対してだけ記録できる。
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
id=""; action=""; reason=""; verdict=""; note=""; list=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list) list=1; shift ;;
    --id) id="$2"; shift 2 ;;
    --fixed) action="fixed"; shift ;;
    --accepted) action="accepted"; shift ;;
    --reason) reason="$2"; shift 2 ;;
    --verifier) action="verifier"; verdict="$2"; shift 2 ;;
    --approve-human) action="approve"; shift ;;
    --note) note="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
py="$(command -v python3 || true)"
[ -n "$py" ] || { echo "python3 が見つかりません" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)" || exit 1
f=".review-reports/latest.json"
[ -f "$f" ] || { echo "$f がありません。先に /ai-review を実行してください" >&2; exit 1; }

if [ $list -eq 1 ]; then
  exec "$py" -I "$here/gate.py" resolve --latest "$f" --list
fi
[ -n "$id" ] && [ -n "$action" ] || { echo "--id と処理（--fixed / --accepted / --verifier / --approve-human）が要ります" >&2; exit 1; }
if [ "$action" = "verifier" ]; then
  case "$verdict" in upheld|rejected) ;; *) echo "--verifier は upheld か rejected" >&2; exit 1 ;; esac
fi

# 人の承認の端末（/dev/tty）での確認は gate.py resolve が行う（gate.py を直接呼んでも迂回できないように）
# 値は --x=値 の形で渡す（- で始まる理由・メモを argparse がオプションと取り違えないように）
set -- resolve --latest "$f" --head="$(git rev-parse HEAD)" --id="$id" --action="$action" --reason="$reason" --note="$note"
[ -n "$verdict" ] && set -- "$@" --verdict "$verdict"
tmp="$f.tmp.$$"
if ! "$py" -I "$here/gate.py" "$@" > "$tmp"; then
  rm -f "$tmp"; exit 1
fi
mv "$tmp" "$f"
"$py" -I "$here/gate.py" resolve --latest "$f" --list
