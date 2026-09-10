#!/usr/bin/env bash
# /ai-review ゲート結果の記録（pre-push フックが読む）
#
# 使い方:
#   record-gate.sh --verdict <pass|fix|block> --escalate <true|false> --escalation-done <true|false> \
#                  [--skipped-by-user <true|false>] [--reason "<text>"] [--report <path>] [--mode branch|local]
#
# 書き先: $PWD/.review-reports/latest.json（HEAD の SHA を自動で記録）
set -uo pipefail

verdict=""; escalate="false"; done_flag="false"; skipped="false"; reason=""; report=""; mode="branch"
while [ $# -gt 0 ]; do
  case "$1" in
    --verdict) verdict="$2"; shift 2 ;;
    --escalate) escalate="$2"; shift 2 ;;
    --escalation-done) done_flag="$2"; shift 2 ;;
    --skipped-by-user) skipped="$2"; shift 2 ;;
    --reason) reason="$2"; shift 2 ;;
    --report) report="$2"; shift 2 ;;
    --mode) mode="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
case "$verdict" in pass|fix|block) ;; *) echo "--verdict must be pass|fix|block" >&2; exit 1 ;; esac
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 1; }

sha="$(git rev-parse HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"
ts="$(date +%Y-%m-%dT%H:%M:%S%z)"
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

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
