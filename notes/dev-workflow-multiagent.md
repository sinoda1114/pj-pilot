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
- push 前に **`/ai-review`（1 段ゲート・v3）** を通す。対象は `origin/HEAD` からのコミット済み差分全体。
  ただし、差分が大きいブランチ（`escalation-rules` の `max_files` / `max_added` を超える）では、1 周目は全体を見て、
  直しの 2 周目以降は**前回レビューした SHA から HEAD までの差分だけ**を見る（差分レビュー）。項目が片づいたら、
  最後にもう 1 回全体を見る。必ず全体を見たいときは `/ai-review --full`。
  内部で自前観点 own-review と Codex 純正 `codex exec review` を並列・独立に実行して突合し、
  結論は `BLOCK` / `MUST-ADDRESS` / `PASS` の 3 段。高リスク差分（auth / payment / schema 等のパス、危険 API の追加行、
  規模、セキュリティ指摘あり）はセキュリティの深掘り own-security を**機械判定で自動起動**する。人が別途叩く運用はしない。
  `MUST-ADDRESS` は 1 件ずつ「直す」か「理由を記録して別サブエージェントが検証」して片づける。
  高リスク項目の人の承認は、ユーザー自身が端末で `resolve-item.sh --approve-human` を実行する（AI は代行しない）。
  結果は作業ツリーごとの git のディレクトリの中の `ai-review/latest.json`（`$(git rev-parse --absolute-git-dir)/ai-review/latest.json`）に記録され、pre-push フックが検査する
  （未レビュー・`block`・`must-address` の未処理・昇格未実施・v2 の記録（`fix`）・全体のレビューを 2 回（最初と最後）経ていない差分レビューの記録は push 拒否）。
- **クラウドセッションでは `/ai-review` が使えない**（Codex CLI 不在）。クラウドは `/code-review` 単独で確認し、
  正式なゲートはローカルで `/ai-review` を通してから push する。
  worktree 運用では skill を **worktree 側で実行**する（cwd の現在ブランチを見るため）。
- 仕様: `.claude/skills/ai-review/SKILL.md`。設計根拠: `.claude/skills/ai-review/DESIGN-v3.md`。
- コンフリクトは feature 側で `git merge origin/main`（or rebase）して解消してから PR を出す。

## 3. デプロイは「git 駆動・単一オーナー」（手動 CLI 禁止）

- **`main にマージ ＝ 本番(Production)自動デプロイ`** に一本化する。
  実装は **Vercel の Git 連携**（Production Branch = `main`、vercel[bot] がデプロイ）。
  リポジトリに `.github/workflows/deploy.yml` は置かない（二重デプロイになるため）。
- CI のゲートは **PR 側**で効かせる: main のブランチ保護で `ci / build`・`ci / e2e` を必須にしており、
  CI が赤の PR はマージできない。
  - 既知の穴: Git 連携は main への push を CI の結果を待たずにデプロイする。保護は
    `strict: false`（マージ前に最新 main への追従を求めない。2026-11-19 に
    `gh api repos/sinoda1114/pj-pilot/branches/main/protection` で確認）なので、各 PR は緑でも
    マージ後の main 上の組み合わせで CI が赤になった場合、その状態のまま本番に出る。
    マージ後に main の最新コミットの CI が赤なら、すぐに revert PR を出す。
    `ci.yml` は同じ ref の旧ジョブをキャンセルするため、連続マージでは途中のコミットの CI が
    「キャンセル」で終わる。最新コミットの CI が緑なら問題なしとみなし、最新がキャンセルなら再実行して確かめる。
  - CI 成功をデプロイの前提にしたくなったら、ci-standard の CD 標準
    （https://github.com/sinoda1114/ci-standard/blob/main/docs/CD.md、
    `templates/deploy-vercel-caller.yml`）で deploy.yml 方式へ移行する。その際は Vercel 側の
    main の自動デプロイを止め（二重デプロイ防止）、この節を書き換える。
- 本番URLは ci-standard の `monitor-urls.txt` に登録する（30分ごとの死活監視・障害Issue自動起票）。
- **手動デプロイ（`vercel --prod` 等の CLI）は原則禁止**（本番状態の二重化を防ぐ）。
  例外は初回構築（`docs/DEPLOY_RUNBOOK.md` の Step 6）だけ。運用開始後は main へのマージで出す。
- **緊急時のロールバック**は番人が Vercel ダッシュボードの Instant Rollback で行い、必ず記録する。
  - 戻す先: Deployments 一覧から、原因コミットより前の正常な本番デプロイを選ぶ（直前とは限らない。
    原因の後にさらにマージがあれば、直前のデプロイも原因を含む）。任意の過去デプロイに戻せるのは
    Pro プランの機能（2026-11-19 時点でプロジェクトのチームは Pro。Hobby は 1 つ前にしか戻せない）。
  - DB は戻らない: 原因コミットにマイグレーション（`drizzle/`）が含まれる場合は、旧コードが新スキーマで
    動くかを先に確かめる。動かないなら、ロールバックせず前に進める修正（forward fix）を選ぶ。
  - ロールバック中は、番人が revert 以外の PR をマージしない（本番に出す対象を 1 つに保つ）。
  - Instant Rollback をすると Vercel は Production ドメインの自動割り当てを止めるので、
    そのままでは後の main へのマージが本番に反映されない。配信を戻した後は次の順で main と本番をそろえる:
    1. 原因コミットを `git revert` する PR を出してマージする。
    2. main の最新コミット（revert のコミット）の Production デプロイが成功し、CI が緑であることを確かめる。
    3. ダッシュボードでそのデプロイを Promote して、自動割り当てを戻す。
       「Undo Rollback」は使わない（ロールバック元＝原因コミットのデプロイが本番に戻るため）。
    4. 本番 URL が main の最新コミットのデプロイを指していることを確かめる。
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
