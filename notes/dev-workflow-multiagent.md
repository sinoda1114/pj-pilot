# マルチエージェント開発の運用規律（正本）

> 目的: 複数エージェント/セッションが**同じ作業コピー・同じ main を同時に書く**ことで起きる
> 衝突（未コミット変更の巻き込み・main 直コミット競合・本番デプロイの二重化）を物理的に無くす。
> このファイルが運用の正本。全エージェントはここに従う。

## 1. 作業空間の分離：1エージェント＝1 worktree＝1ブランチ

- リポジトリの**実体ディレクトリ `~/dev/pj-pilot` は「main 統合＋デプロイ専用」**。
  ここで feature 開発をしない。番人（人間 or デプロイ担当エージェント）だけが触る。
- 機能開発は **`git worktree` で各自の作業空間**を切り、**専用 feature ブランチ**で行う。
  `.git` は共有されるが**作業ファイルは完全分離**＝未コミット衝突が原理的に起きない。

```bash
# 必ず origin/main 起点で切る（起点省略禁止。本体 HEAD が古いと退行事故になる）
git fetch origin
git worktree add ../pj-pilot-<topic> -b feat/<topic> origin/main
# 起点ズレ確認（0 であること）
git -C ../pj-pilot-<topic> rev-list --count origin/main..HEAD

# 一覧 / 後片付け
git worktree list
git worktree remove ../pj-pilot-<topic>   # マージ後に撤去
```

- 命名規則: `feat/<topic>` `fix/<topic>` `chore/<topic>`。worktree dir は `../pj-pilot-<topic>`。
- **同じファイルを2つの worktree で同時編集しない**（役割境界を守る）。
- worktree は本体 repo の `node_modules` を symlink すると検証が速い（`ln -s ../pj-pilot/node_modules node_modules`）。

## 2. main は「PR マージ専用」（直コミット禁止）

- **誰も main に直接 commit / push しない**。例外なし。
- 機能は feature ブランチ → **PR → マージ**。
- マージ前に **2 段ゲート**（`/ai-review` → コミット → `/security-review`）を通す。
- 2 段ゲートはスコープが違う: `/ai-review` = 未コミット差分、`/security-review` = ブランチ全体（`origin/HEAD` 差分）。
  直列で回す。worktree 運用では skill を **worktree 側で実行**する（cwd の現在ブランチを見るため）。
- コンフリクトは feature 側で `git merge origin/main`（or rebase）して解消してから PR を出す。

## 3. デプロイは「git 駆動・単一オーナー」（手動 CLI 禁止）

- **`main にマージ ＝ 本番(Production)自動デプロイ`** に一本化する。
  実装は **ci-standard の CD 標準**（https://github.com/sinoda1114/ci-standard/blob/main/docs/CD.md）を使う:
  `.github/workflows/deploy.yml`（テンプレートは ci-standard/templates/deploy-*-caller.yml）で
  「標準CI成功 → デプロイ → 疎通確認」を直列自動実行する。
  プラットフォームの Git 連携（CIが赤でもデプロイされる）より、CI をゲートにできるこの方式を優先する。
- 本番URLは ci-standard の `monitor-urls.txt` に登録する（30分ごとの死活監視・障害Issue自動起票）。
- **手動デプロイは原則禁止**（本番状態の二重化を防ぐ）。緊急時のみ番人が deploy.yml の
  workflow_dispatch で実施し、必ず記録。
- **PR ごとに自動でプレビュー URL が発行**される。→ **機能別の動作確認はプレビュー URL で**。本番は main だけ。
- 環境変数は Vercel ダッシュボードが正本（`.env.local` はローカル dev 用、リポに出さない）。
- 短時間の連続マージで自動デプロイを取りこぼすことがある。**マージ後は Production の発火を確認**する。

## 4. 役割境界

- 担当領域ごとにエージェント/役割を分ける（UI / 認証・課金 / データ取得 / 法務・SEO・インフラ / レビュー監督 等）。
- 担当外ファイルは触らない。越境が要るときは PR 説明に明記し、レビュー担当が確認する。

## 5. タスクの正本

- タスクの正本は **GitHub Issue / Project**（`notes/task-management-issue-workflow.md`）。
- セッション内の TaskList は揮発する。状態は GitHub を正とする（記憶・伝聞で語らない）。

## 6. PR 状態は GitHub が正本

- マージ依頼・状態言及の前に `gh pr list --state open` を実行し、その出力を正とする。
- 番人はマージ前に `gh pr view <N> --json state,mergedAt` で確認（MERGED なら何もしない）。
- 依頼側も「PR #N マージして」の前に `gh pr list` で番号と未マージを確認する。
