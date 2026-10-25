# .review-reports を記録の置き場所として信用できるかを確かめる。run-reviews.sh・record-gate.sh・resolve-item.sh から source する。
# hooks/pre-push は ~/.git-hooks に単独で置かれ、このファイルを読めないので、同じ中身の写しを持つ（直すときは両方直す）。
#
# reports_untrusted <リポジトリのルート> [コミット...]:
#   .review-reports がシンボリックリンクか、索引か、コミット（既定は HEAD）のツリーにあれば 0（信用できない）を返す。
#   索引だけを見ると、git rm --cached で外しただけのコミット済みの .review-reports を見落とす。
#   どの階層でも、大文字小文字を区別せずに見る（macOS の既定のファイルシステムは大文字小文字を区別しない）。
#   grep -q は途中で読むのをやめ、pipefail の下で上流が SIGPIPE で失敗扱いになるので、-c で最後まで読む。
#   既知の限界: ファイルシステムの上での別名（同じ実体になる綴りの違う名前）の確認は、索引と作業ツリーだけで行う
#   （チェックアウトしていないコミットのツリーの名前は、ファイルシステムで比べられない）。
# record_file [<リポジトリの中のパス>]: ゲートが信用する記録（latest.json）の場所。作業ツリーごとの git のディレクトリの中
#   （.git/ai-review/latest.json。作業ツリーの別のディレクトリなら .git/worktrees/<名前>/ai-review/latest.json）。
#   チェックアウトや reset では作れない場所に置く（作業ツリーの .review-reports だと、祖先のコミットに仕込んだ偽の記録が
#   reset の後に追跡されないファイルとして残り、それでゲートを通せた）。レビューの出力（run-*）は .review-reports に置く。
record_file() {
  local gd; gd="$(git -C "${1:-.}" rev-parse --absolute-git-dir 2>/dev/null)" && [ -n "$gd" ] || return 1
  printf '%s/ai-review/latest.json\n' "$gd"
}

# abs_git_path <リポジトリの中のディレクトリ> <rev-parse の引数...>: git が返すパスを絶対パスにする
#   （絶対パスで返させる書式の指定は git 2.31 より前に無いので使わない。相対パスは -C のディレクトリから解く）
abs_git_path() {
  local d="$1" p; shift
  p="$(git -C "$d" rev-parse "$@" 2>/dev/null)" && [ -n "$p" ] || return 1
  case "$p" in /*) ;; *) p="$(CDPATH='' cd -- "$d" 2>/dev/null && pwd)/$p" || return 1 ;; esac
  printf '%s\n' "$p"
}

# hooks_dir [<リポジトリの中のディレクトリ>]: 効いている pre-push の置き場所。core.hooksPath（~ や ~user は git 自身に
#   展開させ、相対パスは作業ツリーのルートから解く）か、無ければ共通の git のディレクトリの hooks
hooks_dir() {
  local d="${1:-.}" hp top
  local rc
  hp="$(git -C "$d" config --type=path --includes --get core.hooksPath 2>/dev/null)"; rc=$?
  # --type=path は git 2.18 より前に無い。キーが無い（1）以外の失敗は、--path で読み直す
  if [ $rc -ne 0 ] && [ $rc -ne 1 ]; then
    hp="$(git -C "$d" config --path --includes --get core.hooksPath 2>/dev/null)"; rc=$?
    [ $rc -eq 0 ] || [ $rc -eq 1 ] || return 1   # 設定を読めない
  fi
  if [ -z "$hp" ]; then
    hp="$(abs_git_path "$d" --git-common-dir)" || return 1
    printf '%s/hooks\n' "$hp"; return 0
  fi
  case "$hp" in
    /*) ;;
    *) top="$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)" || top="$(CDPATH='' cd -- "$d" 2>/dev/null && pwd)" || return 1; hp="$top/$hp" ;;
  esac
  printf '%s\n' "$hp"
}

# warn_old_hook: 記録を書いた後に呼ぶ。古い場所（作業ツリーの .review-reports/latest.json）に残った記録を消し、
#   古い版の ai-review のフック（記録をそこから読む）があれば置き換えを知らせる。古い場所に写しは置かない
#   （置くと、作業ツリーに仕込んだ偽の記録で古いフックを通せる抜け道が残る）。どう振る舞うかはほかのフックとの
#   組み合わせで変わるので、案内では動きを断言しない
warn_old_hook() {
  local top hp hk
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  hp="$(hooks_dir)" || hp=""
  # 効いている置き場所と、リポジトリのフック（呼び継がれうる）の両方を見る。実行権は問わない（後で付けると効きはじめる）
  for hk in ${hp:+"$hp/pre-push"} "$(abs_git_path . --git-common-dir)/hooks/pre-push"; do
    if [ -f "$hk" ] && grep -qxF '# ai-review-managed-hook' "$hk" && ! grep -qxF '# ai-review-record: git-dir' "$hk"; then
      echo "注意: 古い版の pre-push フック（${hk}）があります。記録を作業ツリーの .review-reports から読む版なので、ゲートが正しく働きません。スキルの hooks/pre-push で置き換えてください（グローバルの置き場所のフックなら、install.sh の実行し直しでも置き換わります）" >&2
      break
    fi
  done
  # 古い場所に残った記録（偽の記録かもしれない）は、新しいフックは読まないので、いつも消す。
  # .review-reports がリンクなら、リンク先のファイルを消さない（呼び出し元の検査に頼らない）
  [ -L "$top/.review-reports" ] && return 0
  rm -f "$top/.review-reports/latest.json" 2>/dev/null
  if [ -e "$top/.review-reports/latest.json" ] || [ -L "$top/.review-reports/latest.json" ]; then
    echo "注意: 古い場所の記録（$top/.review-reports/latest.json）を消せませんでした。古いフックはこれを信用するので、手で消してください" >&2
  fi
  return 0
}

# reports_unreadable <リポジトリのルート> <コミット>: 指す先はあるのにコミットを読めない、または ref が壊れていれば 0
#   （読めないものは信用しない）。ツリーを読めるかは、呼び出し元がツリーを 1 回だけ読むときに見る
reports_unreadable() {
  if ! git -C "$1" rev-parse -q --verify "$2" >/dev/null 2>&1; then
    # 「まだ無い」と見なすのは、生まれる前のブランチ（HEAD が指す ref のファイルが無い）だけ。ref のファイルが
    # あるのに解決できないとき（壊れている）や、HEAD が ref を指していないときは、読めないものとして信用しない
    local ref; ref="$(git -C "$1" symbolic-ref -q "$2" 2>/dev/null)" || return 0
    [ -e "$(abs_git_path "$1" --git-path "$ref")" ] && return 0
    git -C "$1" for-each-ref --format='%(refname)' "$ref" 2>/dev/null | grep -qxF "$ref" && return 0   # packed-refs にある
    return 1
  fi
  ! git -C "$1" rev-parse -q --verify "$2^{commit}" >/dev/null 2>&1   # 指す先はあるのに、コミットを読めない
}
# reports_untrusted が 0 を返したときの理由: link（シンボリックリンク）・tracked（追跡されている）・
#   index（索引を読めない）・unreadable（コミットやツリーを読めない）
REPORTS_WHY=""
# reports_untrusted_message: 理由に合った文言を標準エラーに出す
reports_untrusted_message() {
  if [ "$REPORTS_WHY" = "index" ]; then
    echo "索引（.git/index）を読めません。.review-reports が追跡されていないかを確かめられないので、レビューの出力を書けません。" >&2
    echo "索引が壊れていないかを確かめてください（git status でエラーが出ないか）。" >&2
  elif [ "$REPORTS_WHY" = "unreadable" ]; then
    echo "コミットのツリーを読めません。.review-reports が含まれていないかを確かめられないので、レビューの出力を書けません。" >&2
    echo "リポジトリが壊れていないか（git fsck）、遅延取得のオブジェクトが取れるかを確かめてください。" >&2
  else
    echo "リポジトリの .review-reports がシンボリックリンクか、git で追跡されています（サブディレクトリ・大文字小文字違いを含む）。レビューの出力を書けません。" >&2
    echo "レビュー対象のコミットに .review-reports が含まれていないか確かめてください。" >&2
  fi
}
reports_untrusted() {
  # 言語設定に左右されない（UTF-8 として不正なバイトの名前で、tr などが途中で止まって検査を素通りしない）
  local -x LC_ALL=C
  local top="$1"; shift
  git -C "$top" ls-files -z >/dev/null 2>&1 || { REPORTS_WHY=index; return 0; }   # 索引を読めなければ信用しない
  local pat='(^|/)\.review-reports(/|$)' c n
  REPORTS_WHY=link; [ -L "$top/.review-reports" ] && return 0
  REPORTS_WHY=tracked; [ "$(git -C "$top" ls-files -z 2>/dev/null | tr '\0' '\n' | grep -ciE "$pat")" != "0" ] && return 0
  # 綴りは違っても、ファイルシステムの上で .review-reports と同じ実体になる名前（大文字小文字・Unicode の同一視）で
  # 追跡されているものも信用しない。追跡されているパスの先頭の名前ごとに、同じ実体かを確かめる
  local first
  while IFS= read -r first; do
    [ -n "$first" ] && [ "$first" != ".review-reports" ] && [ "$top/$first" -ef "$top/.review-reports" ] && return 0
  done < <(git -C "$top" ls-files -z 2>/dev/null | tr '\0' '\n' | cut -d/ -f1 | LC_ALL=C sort -u)
  [ $# -gt 0 ] || set -- HEAD
  for c in "$@"; do
    reports_unreadable "$top" "$c" && { REPORTS_WHY=unreadable; return 0; }
    git -C "$top" rev-parse -q --verify "$c^{commit}" >/dev/null 2>&1 || continue   # 生まれる前のブランチ（読むツリーが無い）
    # ツリーは 1 回だけ読む。読めなければ（git が失敗したら）信用しない
    n="$(git -C "$top" ls-tree -r -z --name-only "$c" 2>/dev/null | tr '\0' '\n' | grep -ciE "$pat"; echo " ${PIPESTATUS[0]}")"
    [ "${n##* }" = "0" ] || { REPORTS_WHY=unreadable; return 0; }
    REPORTS_WHY=tracked
    [ "${n%%[!0-9]*}" != "0" ] && return 0
  done
  return 1
}
