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

## 1. GitHubブランチ保護ルールの確認・設定 ✅ 設定済み（2026-08-08 に実地で確認）

**下記1・2はいずれも既に設定されています。** 設定画面を見たのではなく、
実際にマージを試みたときの GitHub のエラーがそのまま証拠になりました。

| 項目 | 状態 | 根拠 |
|---|---|---|
| Require status checks（必須2件） | ✅ 設定済み | PR #36 のマージ時に `2 of 2 required status checks are expected` で拒否された |
| Require conversation resolution | ✅ 設定済み | PR #38 のマージ時に `405 All comments must be resolved.` で拒否された |

以降は設定内容の記録として残します。変更するときの参照用です。

`Settings → Branches → Branch protection rules → main`:

1. **Require status checks to pass before merging** を有効化し、必須チェックとして
   **`ci / build`・`ci / e2e`** の2ジョブを指定する。
   - ⚠️ **チェック名に注意。** PR #38（標準CI `sinoda1114/ci-standard` への切替、**マージ済み**）
     により `.github/workflows/ci.yml` は再利用ワークフロー呼び出しになった。このため
     `main` 上のチェック名は `build` / `e2e` ではなく
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

## 4. テストカバレッジのしきい値チェック ✅ 対応済み（PR #35）

**この項目は本ドキュメント作成後に完了しました。追加作業は不要です。**

`vitest.config.ts` に `test.coverage`（provider: v8、statements / branches / functions / lines の
しきい値）が定義済みで、CI の build ジョブが `npm run test:coverage` を実行しています。
しきい値は実測値の少し下に置くラチェット方式で、カバレッジの退行だけを止める設定です。

導入時は 85 / 75 / 85 / 85 でしたが、2026-08-08 の補強（Server Actions・認可・境界値・
防御的分岐のテスト追加）で実測が Stmts 95.67 / Branch 92.88 / Funcs 94.14 / Lines 95.46 まで
上がったため、**94 / 90 / 92 / 94 へ引き上げ済み**です。方針どおり、向上したら随時引き上げます。

## 4b. E2Eの flaky（`SQLITE_BUSY: database is locked`）✅ 対応済み

**PR #34 の CI で実際に再現しました**（[run 31233023338](https://github.com/sinoda1114/pj-pilot/actions/runs/31233023338/job/93040407105)）。
Markdown 1ファイルの追加しかない PR で e2e が 2件失敗しており、変更内容とは無関係です。

```
Error: Failed query: insert into "user" ...
  at e2e/helpers/auth.ts:66
[cause]: LibsqlError: SQLITE_BUSY: database is locked
```

**`playwright.config.ts` の `workers: 1` / `fullyParallel: false` では防げません。**
この設定はスペック間の並列を止めるものですが、ロックの衝突は**プロセス間**で起きているためです。

| 書き込むプロセス | 経路 |
|---|---|
| Playwright のテストプロセス | `e2e/helpers/auth.ts` → `createDb()` → `file:local.db` |
| Next.js サーバープロセス（`webServer`） | Server Actions → `lib/db` → `file:local.db` |

同じ SQLite ファイルに別プロセスから同時に書き込むため、ワーカーを1つにしても衝突します。
`retries: 2` があってもリトライごとに同じ競合が起きうるため、たまに 3回とも落ちます。

### 実測して確定させたこと

対処案を机上で選ばず、別プロセスにロックを保持させる実験で計測しました。

| 設定 | 結果 |
|---|---|
| busy timeout なし（SQLite の既定） | **1ms で `SQLITE_BUSY`**（待たずに即失敗） |
| busy timeout = 5000ms | **308ms 待って成功**（相手の解放を待てた） |
| busy timeout = 5000ms + `journal_mode = WAL` | 308ms 待って成功（**WAL による差は無し**） |

- **WAL は採用しませんでした。** この失敗モードは書き込み同士の競合であり、
  読み取りと書き込みの並行性を上げる WAL は寄与しないと実測で分かったためです。
- **最初の計測は誤りでした。** 同一プロセス内の2接続で測ったところ busy timeout が
  効かないという結果になりましたが、これは同期ドライバが待機中にイベントループごと
  止めてしまい、解放側の `COMMIT` が走れなかったためです。実際の CI は別プロセス同士
  なので、プロセスを分けて測り直したのが上表です。**計測手段そのものを疑うこと。**

### 採用した対処

`lib/db/client.ts` の `createClient` に **`timeout` 設定オプション**を渡します
（`LOCAL_BUSY_TIMEOUT_MS = 5000`）。`PRAGMA busy_timeout` を後から `execute` する方法は
採りません。`@libsql/client` の型定義に「client が開く**すべての**接続に適用される。
`transaction()` の後に内部的に作られる接続も含む」と明記されており、手動 PRAGMA では
`db.transaction()`（`lib/tasks/hierarchy.ts` 等が TOCTOU 対策で多用）の内部接続に
効かず、肝心のところで取りこぼすためです。両方の経路で効くことを実測で確認済みです。

本番の Turso HTTP 接続では、このオプションは無視されます（型定義に明記）。

### 副作用: 同一プロセス内の競合テストは opt-out が必要

`busy timeout` は**プロセス間**の競合にしか効きません。同一プロセス内では、待っている側が
イベントループを止めてしまい、ロックを持っている側の continuation が走れないため、
待つだけ無駄でタイムアウト分だけ固まってから結局失敗します。

TOCTOU 対策を検証する既存テスト（`lib/tasks/deletion.test.ts` /
`lib/dependencies/service.test.ts`）はまさに同一プロセス内で競合を起こすため、
`createDb(url, undefined, { busyTimeoutMs: 0 })` で明示的に既定挙動へ戻しています。
**同種のテストを追加するときは同じ指定が必要です**（忘れるとテストが5秒固まって失敗します）。

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
| 1. ブランチ保護（必須チェック・会話解決必須化） | ✅ 完了 | 2026-08-08 に設定済みであることを実地で確認（§1） |
| 2. Copilot連携の確認 | 中（残） | 動いていない設定を放置すると誤解のもとになる。PR #44 では Reviewers に現れておらず、既に外れている可能性がある（設定画面は API から読めないため目視が必要） |
| 3. 裁定ポリシー明文化 | 中 | 実装コストが低く、今回学んだことをすぐ反映できる（PR #36 で対応） |
| 4b. E2Eの flaky（SQLITE_BUSY） | ✅ 完了 | `lib/db/client.ts` に busy timeout を導入して解消 |
| 8. Secret scanning確認 | 中 | Public リポジトリのため実害が大きい（R-5参照） |
| 4 | ✅ 完了 | PR #35 で導入済み |
| 5〜7 | 低〜中 | アプリ規模・チーム規模に対してはオーバースペック気味。必要になった時点で着手でよい |
