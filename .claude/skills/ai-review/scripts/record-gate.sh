#!/usr/bin/env bash
# /ai-review ゲート結果の記録（pre-push フックが読む）
#
# 使い方:
#   record-gate.sh --verdict <pass|fix|block> --escalate <true|false> --escalation-done <true|false> \
#                  [--skipped-by-user <true|false>] [--reason "<text>"] [--report <path>] [--mode branch|local]
#                  [--no-diff]
#
# branch モードでは、--report に run ディレクトリ内のレポートを渡す（run-reviews.sh が残した
# reviewed_sha.* と HEAD を照合する）。レビューを回していない「差分なし」の記録だけは --no-diff を付け、
# origin/HEAD との間に本当に差分が無いことを確かめて記録する。
#
# 書き先: $PWD/.review-reports/latest.json（HEAD の SHA を自動で記録）
set -uo pipefail

verdict=""; escalate="false"; done_flag="false"; skipped="false"; reason=""; report=""; mode="branch"; no_diff="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --verdict) verdict="$2"; shift 2 ;;
    --escalate) escalate="$2"; shift 2 ;;
    --escalation-done) done_flag="$2"; shift 2 ;;
    --skipped-by-user) skipped="$2"; shift 2 ;;
    --reason) reason="$2"; shift 2 ;;
    --report) report="$2"; shift 2 ;;
    --mode) mode="$2"; shift 2 ;;
    --no-diff) no_diff="true"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
case "$verdict" in pass|fix|block) ;; *) echo "--verdict must be pass|fix|block" >&2; exit 1 ;; esac
case "$mode" in branch|local) ;; *) echo "--mode must be branch|local" >&2; exit 1 ;; esac
# boolean は必ず検証する。JSON に生の文字列が入るとフックが "yes" != "true" と読んで
# 昇格チェックを黙って飛ばす。
for pair in "escalate:$escalate" "escalation-done:$done_flag" "skipped-by-user:$skipped"; do
  case "${pair#*:}" in
    true|false) ;;
    *) echo "--${pair%%:*} must be true|false (got '${pair#*:}')" >&2; exit 1 ;;
  esac
done
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 1; }
# --report の置き場所（レビューの run ディレクトリ）は、下で cd する前に解決しておく
report_dir=""
[ -n "$report" ] && report_dir="$(cd "$(dirname "$report")" 2>/dev/null && pwd)"
# リポジトリルートへ移動してから書く。サブディレクトリから実行すると
# sub/.review-reports/latest.json に落ち、ルートで動くフックが見つけられない。
cd "$(git rev-parse --show-toplevel)" || { echo "cannot cd to repo root" >&2; exit 1; }

sha="$(git rev-parse HEAD)"
# レビューした SHA と照合する。run-reviews.sh は実際にレビューした SHA を
# <run>/reviewed_sha.review（昇格時は .security も）に残す。レビューは数分〜15 分かかり、
# その間に HEAD が動くと、未レビューのコミットに結果が結び付いて pre-push も通ってしまう。
# 照合できないとき（reviewed_sha が無い、--report が無い）に黙って通すと、手順のミスが
# そのまま検査なしに落ちるので、branch モードでは拒む。
if [ "$mode" = "branch" ]; then
  if [ "$no_diff" = "true" ]; then
    # 例外の経路を抜け道にしないよう、本当に差分が無いことを確かめる
    base="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    [ -n "$base" ] || { echo "origin/HEAD が無いため差分なしを確かめられません（git remote set-head origin -a）" >&2; exit 1; }
    mb="$(git merge-base "$base" HEAD 2>/dev/null)" || mb=""
    if [ -z "$mb" ] || ! git diff --quiet "$mb" HEAD 2>/dev/null; then
      echo "--no-diff が指定されましたが、$base との間に差分があります。/ai-review を回してください。" >&2
      exit 1
    fi
  else
    if [ -z "$report_dir" ] || [ ! -f "$report_dir/reviewed_sha.review" ]; then
      echo "レビューした SHA の記録（reviewed_sha.review）が見つかりません。" >&2
      echo "--report に run ディレクトリ内のレポートを渡してください（差分なしの記録なら --no-diff）。" >&2
      exit 1
    fi
    for f in "$report_dir"/reviewed_sha.*; do
      [ -f "$f" ] || continue
      r="$(head -n 1 "$f")"
      if [ "$r" != "$sha" ]; then
        echo "レビューした SHA（${r:0:7}、$(basename "$f")）と HEAD（${sha:0:7}）が違います。" >&2
        echo "レビュー後に HEAD が動いたので、この結果は記録できません。/ai-review を回し直してください。" >&2
        exit 1
      fi
    done
  fi
fi
branch="$(git rev-parse --abbrev-ref HEAD)"
ts="$(date +%Y-%m-%dT%H:%M:%S%z)"
# 改行・タブ・制御文字も潰す。--reason が複数行だと不正 JSON になる。
esc() {
  printf '%s' "$1" | LC_ALL=C awk '
    BEGIN { RS="\n"; ORS="" }
    {
      if (NR > 1) printf "\\n"
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (c == "\\") printf "\\\\"
        else if (c == "\"") printf "\\\""
        else if (c == "\t") printf "\\t"
        else if (c == "\r") printf "\\r"
        else {
          v = 0
          for (j = 0; j < 32; j++) if (c == sprintf("%c", j)) { v = 1; printf "\\u%04x", j; break }
          if (!v) printf "%s", c
        }
      }
    }'
}

mkdir -p .review-reports
cat > .review-reports/latest.json <<EOF
{
  "head_sha": "$sha",
  "branch": "$(esc "$branch")",
  "mode": "$mode",
  "verdict": "$verdict",
  "escalate": $escalate,
  "escalation_done": $done_flag,
  "skipped_by_user": $skipped,
  "reason": "$(esc "$reason")",
  "report": "$(esc "$report")",
  "recorded_at": "$ts"
}
EOF
cat .review-reports/latest.json
