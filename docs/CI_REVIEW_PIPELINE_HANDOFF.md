# CI/PRレビューパイプライン改善 引き継ぎ指示書

PR #33（Better Auth本実装）のマージ作業を通じて、現状のCI/PRレビュー体制（GitHub Actions +
Cursor Bugbot + Amazon Q + Devin Review + Socket Security + Copilot + セルフレビュー）を
実際に一通り動かして観測した、**仕組みとしての抜け・弱点**をまとめたもの。個々のレビュー内容の
良し悪しではなく、パイプラインの機能面の話。

このファイルは**今この時点でのスナップショット**（2026-08-08、PR #33の実物で確認済み）。
`docs/LOCAL_SETUP.md` と同じく、GitHub の Web UI（Settings 画面）でしか操作できない項目が
中心のため、クラウドセッションのGitHub MCPサーバー経由では実行できない
（ブランチ保護ルール・Reviewers設定を読み書きするツールが無いことを実際に確認済み）。

---

## 0. 前提: 何を実際に観測したか

PR #33で実際に動いた構成、および観測した具体的な事象。

| 項目 | 状態 |
|---|---|
| GitHub Actions CI（lint/typecheck/test/build/audit/e2e） | ✅ 機能している |
| Cursor Bugbot | ✅ 機能している（2件検出、autofix提案あり） |
| Amazon Q Developer | ⚠️ 機能はしているが誤検知あり（5件中2件が事実誤認） |
| Devin Review | ✅ 機能している（3件検出、提案diff付き。ただし後述のステータス解決の問題あり） |
| Socket Security | ✅ 機能している（依存追加の信頼性スコア表示のみ、ブロックはしない） |
| GitHub Copilot（レビュー） | ❌ **Reviewersに登録されているが実際には一度もレビューしていない**（"Copilot review effort: Still in progress?" のまま） |
| 自分（Claude Code）のセルフレビュー | ✅ `/code-review`・`/security-review` を手動実行（CLAUDE.mdの規約） |

具体的に問題だった点:

- Devin Reviewのコミットステータスは長時間 `pending`（"analyzing your changes"）のままで、
  レビューコメント自体は後から届いたが、コミットステータスAPI（`GET /repos/{owner}/{repo}/commits/{sha}/status`）
  で確認すると最終的に `total_count: 0` となり、success/failureのどちらにも解決しなかった
  （マージ後に確認）。**これがブランチ保護の必須チェックに設定されていた場合、正式に
  解決しないまま塩漬けになりマージ不能になっていた可能性がある。**
- Amazon Qが「Critical」とラベル付けした5件中2件は、実際には
  JavaScriptの空文字列falsy判定の誤認、Next.jsの`matcher`パターンの適用範囲の誤認による
  誤検知だった（PRコメントで理由を説明して見送った）。ボット側に信頼度スコアや
  優先順位付けの仕組みが無く、**すべて人間（またはClaude）が1件ずつ真偽判定する運用**になっている。

---

## 1. GitHubブランチ保護ルールの確認・設定（Web UIのみ、未実施）

`Settings → Branches → Branch protection rules → main` で以下を確認・設定する。

1. **Require status checks to pass before merging** を有効化し、必須チェックとして
   **`ci / build`・`ci / e2e`** の2ジョブを指定する。
   - ⚠️ **チェック名に注意。** PR #38（標準CI `sinoda1114/ci-standard` への切替）以降、
     再利用ワークフロー呼び出しになったため、チェック名は `build` / `e2e` ではなく
     **`ci / build` / `ci / e2e`**（`<呼び出し側のjob id> / <呼び出し先のjob名>`）になる。
     旧名を指定すると、そのチェックは永久に報告されず**全PRがマージ不能**になる。
     設定前に実際のPRのチェック一覧で名前を確認すること。
   - `ci / detect` は `build` / `e2e` の前提ジョブであり、必須に含める必要はない。
   - **Devin Review・Amazon Q・Cursor Bugbotは必須チェックに含めない**こと。
     これらはコミットステータス/チェックが最後まで解決しないことがある
     （上記0節参照）ため、必須にすると正当なPRがマージ不能になるリスクがある。
     あくまで参考情報として扱う。
2. **Require conversation resolution before merging** を有効化する。
   今回は手動で全10スレッドを解消してからマージしたが、この設定が無いと
   ボットの指摘が未解決のままでもマージできてしまう。
3. Require branches to be up to date before merging は、単独開発者運用のため任意
   （必要になったら有効化）。

## 2. Copilotレビュー連携の確認

`Settings → Copilot → Code review` （または該当するリポジトリ設定）で、PRレビューが
実際に有効化されているか確認する。PR #33ではReviewersに`Copilot`が表示されるものの、
一度もコメントを投稿していない。設定が有効なのに動いていないなら要調査、
使う予定が無いなら**Reviewersから外す**（レビュー待ちのように見えて実際は何も起きない
状態を無くす）。

## 3. ボット指摘の裁定ポリシーをCLAUDE.mdに明文化する（実施可能・軽微）

`CLAUDE.md`の「push前のレビュー」節に、以下を追記することを推奨する。

- 複数のAIレビュー（Cursor/Amazon Q/Devin等）が同じ変更を指摘した場合、内容が矛盾する
  ことがある。**指摘は鵜呑みにせず、実際にコード・ドキュメント（言語仕様・フレームワーク
  ソース等）を確認してから対応要否を判断する**（今回のAmazon Q誤検知2件のように）。
- 対応しない場合は、必ずその場（PRの当該スレッド）に理由を返信する
  （すでにCLAUDE.mdの「レビュー依頼のプロンプト」節に近い記載はあるが、
  「複数ボットの矛盾」への言及は無い）。

## 4. テストカバレッジのしきい値チェック（実装可能・フォローアップPRで検討）

現状CIは「テストが通るか」のみで、カバレッジ%の計測・しきい値強制は無い
（`vitest.config.ts`に`coverage`設定なし）。導入する場合:

```bash
npm install --save-dev @vitest/coverage-v8
```

`vitest.config.ts`に`test.coverage`を追加し、CIに`vitest run --coverage`のジョブを追加する。
しきい値は既存カバレッジの実測値を先に取ってから決める（いきなり高い値を強制しない）。

## 5. Visual regression（見た目の自動回帰検知）の検討

CLAUDE.mdは「UI変更のPRにはスクリーンショットを手動添付する」規約のみで、自動的な
見た目の差分検知は無い。導入するなら Playwright の `toHaveScreenshot()`
（追加インフラ不要、既存のPlaywright構成にそのまま乗る）が最小コスト。
ただしベースライン画像の管理（OS/フォント差異でCI環境と手元で結果が変わりやすい）が
運用コストになるため、優先度は低めでよい。

## 6. バンドルサイズ/パフォーマンス回帰チェックの検討

Next.jsのビルド出力（`.next/`）のサイズをPRごとに比較する仕組みは無い。
`@next/bundle-analyzer`をCIに組み込み、PRコメントで差分を報告するアクション
（例: `github.com/hashicorp/nextjs-bundle-analysis` 等）の導入を検討してもよいが、
現状のアプリ規模ではまだ優先度は低い。

## 7. 自動マージの検討

現状はCI green確認後に都度手動でマージしている（`enable_pr_auto_merge`相当の設定は無し）。
単独開発者運用なら手動マージのままでも実害は薄いが、チェック待ちの手待ち時間を減らすなら
`Settings → General → Allow auto-merge` を有効化した上で、PR作成時に auto-merge を
オンにする運用に変更できる。**ただし1節の必須チェック設定が先**（そうでないと
ボットレビュー待たずに自動マージされてしまう）。

## 8. Secret scanning / push protectionの可視化確認

`docs/LOCAL_SETUP.md` §1に記載の通り、`Settings → Code security` で
Secret scanning・Push protectionを有効化する作業自体は別ドキュメントで先送りされている
（未確認）。有効化されていれば、PRのチェック欄に専用のステータスとして
出るはずなので、今回のPRタイムラインに出ていない点も含めて確認する。

---

## 優先度の目安

| 項目 | 優先度 | 理由 |
|---|---|---|
| 1. ブランチ保護（必須チェック・会話解決必須化） | 高 | 今回「レビュー中でもマージできる」状態を実際に経験した |
| 2. Copilot連携の確認 | 中 | 動いていない設定を放置すると誤解のもとになる |
| 3. 裁定ポリシー明文化 | 中 | 実装コストが低く、今回学んだことをすぐ反映できる |
| 8. Secret scanning確認 | 中 | Public リポジトリのため実害が大きい（R-5参照） |
| 4〜7 | 低〜中 | アプリ規模・チーム規模に対してはオーバースペック気味。必要になった時点で着手でよい |
