# 既存（運用中）プロジェクトへの後付け適用ガイド

新規は「テンプレを土台にする」で済むが、既に動いているプロジェクトは
**全コピー厳禁**（既存の `CLAUDE.md` / `.github` / `notes` を潰すため）。
**不足ファイルを足し、既存ファイルには追記**して当てる。

> 前提: 挙動ルール（worktree / 2 段ゲート / デプロイ規律 / GitHub 正本 / Issue 管理 / 供給網）は
> `~/.claude` グローバルに入れてあれば **この端末の全 PJ に自動適用済み**。
> よって既存 PJ の後付けは、主に「**リポ同梱が必要なファイル**」の追加と、GitHub 側の初期設定。

## 手順（低リスク順）

### 0. ブランチを切る
```bash
git fetch origin
git worktree add ../<repo>-standardize -b chore/standardize origin/main
```

### 1. 低リスクなファイルを追加（無ければ）
- `.npmrc`（`ignore-scripts=true` / `audit-level=high` / `save-exact=true`）
  — **ビルド済み環境を壊さないか確認してから**。ネイティブビルドが要る依存があれば `npm rebuild` 運用を併記。
- `.github/ISSUE_TEMPLATE/task.yml`
- `.github/dependabot.yml`

いずれも新規追加なので既存を壊さない。

### 2. CI を整える
- `.github/workflows/ci.yml` が **無ければ** テンプレのものを追加。
- **既にある** 場合は上書きせず、不足ステップ（`npm ci` / `npm audit --audit-level=high` / `tsc --noEmit`）だけ **差分で足す**。
- 既存 CI が `npm install` を使っていたら `npm ci` へ置換を提案。

### 3. AI 指示・notes を統合（上書きしない）
- `notes/dev-workflow-multiagent.md` / `notes/task-management-issue-workflow.md` / `notes/apply-to-existing-project.md` が無ければ追加。
- 既存 `CLAUDE.md` / `AGENTS.md` がある場合は、テンプレの **固有値テーブルと notes へのポインタだけ** を追記する。
  挙動の再説明は足さない（`~/.claude` グローバルと重複するため）。

### 4. GitHub 側のセットアップ
```bash
git remote set-head origin -a   # origin/HEAD（/security-review が必要）
# type:* ラベル（status ラベルは作らない）
for t in bug feature content i18n legal billing data mobile ops; do \
  gh label create "type:$t" --color ededed 2>/dev/null || true; done
```
- GitHub Project を作成（Inbox / Ready / Waiting / Doing / PR / Prod Check / Done）。
- デプロイ基盤の git 連携（Production Branch = main・Preview 有効）が未設定なら設定。
- 既存のタスク台帳（巨大 Markdown 等）があれば、先頭に「現役正本ではない」と明記して凍結し、現役タスクだけ Issue / Project へ段階移行。

### 5. 取り込み
差分は **`/ai-review` → commit → `/security-review` → PR → マージ** で入れる（＝テンプレ自身のルールで取り込む）。

## チェックリスト
- [ ] lockfile が `.gitignore` に入っていないか（入っていたら外す）
- [ ] CI の依存解決が `npm ci` か（`npm install` なら置換）
- [ ] `.env` / `.env.*` がリポにコミットされていないか
- [ ] 既存 `CLAUDE.md` / `notes` を上書きで潰していないか（追記になっているか）
- [ ] `origin/HEAD` 設定済みか
- [ ] 状態は Project カラム・種別は `type:*`（`status:*` ラベルを作っていないか）
