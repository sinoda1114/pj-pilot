#!/usr/bin/env bash
# /ai-review v3 ゲート結果の記録（pre-push フックが読む）
#
# 使い方:
#   record-gate.sh --verdict <pass|must-address|block> [--items <items.json>] \
#                  --escalate <true|false> --escalation-done <true|false> \
#                  [--skipped-by-user <true|false>] [--reason "<text>"] [--report <path>] [--mode branch|local]
#                  [--no-diff]
#
# --items は突合で書き起こした指摘（BLOCK・MUST-ADDRESS の段のもの）の配列。形は DESIGN-v3.md §5。
# 結論は「--verdict」「生出力から機械的に決まる下限（gate.py summary）」「項目の段」の最も重いものになる。
# レビュアーの結論に見合う項目が無い（1 人分の指摘を丸ごと落とした）ときは記録を拒む。
# 判定表の欠け・結論を読めない出力は、自動で MUST-ADDRESS の項目として足される。
# 高リスク（人の承認が要る）は、昇格ルールの path に当たるファイル・注入型の指摘で自動的に true になる。
#
# branch モードでは、--report に run ディレクトリ内のレポートを渡す（run-reviews.sh が残した
# reviewed_sha.* と HEAD を照合する）。レビューを回していない「差分なし」の記録だけは --no-diff を付け、
# origin/HEAD との間に本当に差分が無いことを確かめて記録する。
#
# 書き先: $PWD/.review-reports/latest.json（HEAD の SHA を自動で記録）
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
verdict=""; items=""; escalate="false"; done_flag="false"; skipped="false"; reason=""; report=""; mode="branch"; no_diff="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --verdict) verdict="$2"; shift 2 ;;
    --items) items="$2"; shift 2 ;;
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
case "$verdict" in pass|must-address|block) ;; *) echo "--verdict must be pass|must-address|block" >&2; exit 1 ;; esac
case "$mode" in branch|local) ;; *) echo "--mode must be branch|local" >&2; exit 1 ;; esac
# boolean は必ず検証する。JSON に生の文字列が入るとフックが "yes" != "true" と読んで
# 昇格チェックを黙って飛ばす。
for pair in "escalate:$escalate" "escalation-done:$done_flag" "skipped-by-user:$skipped"; do
  case "${pair#*:}" in
    true|false) ;;
    *) echo "--${pair%%:*} must be true|false (got '${pair#*:}')" >&2; exit 1 ;;
  esac
done
py="$(command -v python3 || true)"
[ -n "$py" ] || { echo "python3 が見つかりません（記録に使う）" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 1; }
# --report の置き場所（レビューの run ディレクトリ）と --items は、下で cd する前に解決しておく
report_dir=""
[ -n "$report" ] && report_dir="$(cd "$(dirname "$report")" 2>/dev/null && pwd)"
if [ -n "$items" ]; then
  [ -f "$items" ] || { echo "--items が見つかりません: $items" >&2; exit 1; }
  items="$(cd "$(dirname "$items")" && pwd)/$(basename "$items")"
fi
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
    # push の根拠には通常の 2 本（own-review ‖ codex-review）の reviewed_sha.review が要る。
    # --security 単独の run は追加の深掘りで、それだけでは二重のレビューを経ていないので記録しない
    if [ -z "$report_dir" ] || [ ! -f "$report_dir/reviewed_sha.review" ]; then
      echo "レビューした SHA の記録（reviewed_sha.review）が見つかりません。--security 単独の実行は push の根拠になりません。" >&2
      echo "--report に run ディレクトリ内のレポートを渡してください（差分なしの記録なら --no-diff）。" >&2
      exit 1
    fi
    # 比較範囲の起点が、origin/HEAD との merge-base であること（範囲を狭めた run を通さない）
    dbase="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    dmb="$([ -n "$dbase" ] && git merge-base "$dbase" HEAD 2>/dev/null || true)"
    if [ -z "$dmb" ] || [ ! -f "$report_dir/reviewed_base.review" ]; then
      echo "比較範囲の起点（reviewed_base.review）か、origin/HEAD との merge-base が見つかりません。" >&2
      exit 1
    fi
    for f in "$report_dir"/reviewed_base.*; do
      [ -f "$f" ] || continue
      if [ "$(head -n 1 "$f")" != "$dmb" ]; then
        echo "レビューした比較範囲の起点（$(head -c 7 "$f")、$(basename "$f")）が、$dbase との merge-base（${dmb:0:7}）と違います。" >&2
        echo "既定の比較元（--base を付けない）で /ai-review を回し直してください。" >&2
        exit 1
      fi
    done
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
# 昇格を実施済みと記録するなら、深掘りの出力が run ディレクトリに要る（記録だけの「実施済み」を防ぐ）
if [ "$mode" = "branch" ] && [ "$no_diff" != "true" ] && [ "$done_flag" = "true" ]; then
  # 出力があるだけでなく、完走したこと（--security の reviewed_sha.security、または --deep の run）も要る
  if [ -z "$report_dir" ] || [ ! -s "$report_dir/own-security.md" ] || \
     { [ ! -f "$report_dir/reviewed_sha.security" ] && [ ! -f "$report_dir/deep.flag" ]; }; then
    echo "--escalation-done true ですが、run ディレクトリに own-security.md がありません。" >&2
    echo "run-reviews.sh --security（または --deep）を回してから記録してください。" >&2
    exit 1
  fi
fi
branch="$(git rev-parse --abbrev-ref HEAD)"

mkdir -p .review-reports
# 値は --x=値 の形で渡す（- で始まる理由を argparse がオプションと取り違えないように）
set -- record --verdict="$verdict" --head="$sha" --branch="$branch" --mode="$mode" \
  --escalate="$escalate" --escalation-done="$done_flag" --skipped-by-user="$skipped" \
  --reason="$reason" --report="$report" --previous .review-reports/latest.json \
  --rules "$here/../escalation-rules.txt" --rules ".ai-review/escalation-rules.local.txt"
[ -n "$items" ] && set -- "$@" --items="$items"
[ -n "$report_dir" ] && set -- "$@" --run "$report_dir"
[ "$no_diff" = "true" ] && set -- "$@" --no-diff
tmp=".review-reports/latest.json.tmp.$$"
if ! "$py" -I "$here/gate.py" "$@" > "$tmp"; then
  rm -f "$tmp"; echo "記録しませんでした（上のエラーを直して記録し直す）" >&2; exit 1
fi
# 途中で落ちて壊れた latest.json を残さないよう、書き終えてから置き換える
mv "$tmp" .review-reports/latest.json
# 表示は要約だけにし、制御文字（C0・C1）を潰す（latest.json の値はレビュー対象のファイル名などを含む）
"$py" -I "$here/gate.py" resolve --latest .review-reports/latest.json --list
