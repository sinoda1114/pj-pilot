# pj-pilot Phase 2 実装計画（カンバンボード / ダッシュボード）

`REQUIREMENTS.md` §機能スコープ「Phase 2」と、2026-08-08 のヒアリング確定分を入力として
作成した実装計画です。Phase 1 の計画書 [`docs/IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)
§8「Phase 2（詳細化しない）」を、ここで詳細化します。

- 作成日: 2026-08-08
- 対象: カンバンボード（PJ単位）/ ダッシュボード（全PJ横断）
- 前提: Phase 1（M0〜M6）はマージ済み。`origin/main` = `d20565b` を起点とする

> ## ✅ 実装完了（2026-08-08）
>
> **本計画の M7〜M9（Issue #36〜#51）は全て実装・マージ済みです。**
> 以降の本文は計画時点の記述であり、着手前の判断材料として残しています。
> **現在の実装の正本はコードです。** 食い違いを見つけたらコードを優先してください。
>
> | マイルストーン | PR | 主な成果物 |
> |---|---|---|
> | M7 基盤 | [#42](https://github.com/sinoda1114/pj-pilot/pull/42) | `tasks.board_order` + マイグレーション 0003 / 依存5点 / `todayInTimeZone` |
> | M8 カンバン | [#43](https://github.com/sinoda1114/pj-pilot/pull/43) | `lib/board/` / `/projects/[id]/board` |
> | M9 ダッシュボード | [#44](https://github.com/sinoda1114/pj-pilot/pull/44) | `lib/dashboard/` / `/dashboard` |
>
> ### 計画から変えた点
>
> 実装中に判明して計画と異なる結論になったものだけを挙げます。
>
> - **§6.5 のチャート**: 横棒グラフの Y 軸は既定幅（60px）だと日本語のプロジェクト名が
>   頭から切れる。軸幅を明示し、長い名前は末尾を省略する（実機のスクリーンショットで発見）。
> - **§6.4 のクエリ**: `listAllActiveTaskTypeTasks` は `projects` と内部結合し、
>   **削除済みプロジェクトのタスクも除外**する。計画ではタスクの生存フィルタしか
>   書いていなかったが、PJ を論理削除しても配下タスクの `deleted_at` が必ず立つとは
>   限らず、「消したはずの PJ のタスクが出続ける」ため。
> - **§6.2 の進捗率**: タスク0件の PJ は `percent` を `null` にして 0% と区別する
>   （0 として棒グラフに混ぜると「着手していないだけ」が「遅れている」ように見えるため）。
> - **リスク R-8 の追加分**: ヘッダーのリンクで、Server Component から Mantine の
>   `component={Link}` を Client Component 境界に渡すと実行時エラーになる
>   （`app/projects/page.tsx` に既出の罠）。Link で Text を包む形にする。
> - **§7.3 の E2E**: キーボード D&D は**キー入力の間に待機が必須**。dnd-kit は矢印キーで
>   座標を更新したあと次のフレームで衝突判定を走らせるため、間を空けずに確定すると
>   `onDragEnd` の `over` が `active` 自身になり何も起きない。
> - **未決事項の扱い**: Q-1〜Q-3 はいずれも計画の既定のまま実装した
>   （進捗の自動変更なし / 期限超過は20件超で「もっと見る」/ カンバンにフィルターなし）。

---

## 1. ヒアリング確定分

| # | 論点 | 確定内容 |
|---|---|---|
| 1 | カンバンのスコープ | プロジェクト単位（`/projects/[id]/board`） |
| 2 | 列の基準 | 既存の `tasks.status`（未着手 / 対応中 / 確認中 / 完了）。**enum の追加はしない** |
| 3 | 対象タスク | `type = 'task'` のみ（summary / milestone は出さない） |
| 4 | 列間 D&D | 実装する（ドロップでステータス変更） |
| 5 | D&D 実装 | 専用ライブラリ（dnd-kit）を使う |
| 6 | 列内の並び替え | 可能にする。順序は **`tasks.board_order` を新設して保存**（§4） |
| 7 | ダッシュボードのスコープ | 全プロジェクト横断（`/dashboard`） |
| 8 | 表示項目 | ステータス別タスク数 / 期限超過タスク一覧 / プロジェクト別進捗率 |
| 9 | グラフ | 必要（`@mantine/charts`） |
| 10 | CSV エクスポート | 今回は含めない |
| 11 | 進め方 | 計画書を先に作る（本ドキュメント） |

---

## 2. 現状（Phase 1 の到達点）

計画の前提になる既存資産を、実物のコードで確認しました。

| 資産 | 実物 | Phase 2 での扱い |
|---|---|---|
| `tasks` テーブル | `lib/db/schema/app.ts:92` | `board_order` を1列追加（§4） |
| ステータス enum | `todo` / `in_progress` / `review` / `done`（CHECK 制約付き） | **そのまま。変更しない** |
| 日本語ラベル層 | `lib/labels.ts`（`statusLabel` 等） | 列見出しにそのまま使う。DB値を画面に出さない規約を踏襲 |
| 生存レコードの問い合わせ | `lib/db/queries.ts`（`deleted_at IS NULL` を集約） | 新規クエリも**必ずこのファイルに追加**する |
| タスク更新のロジック | `lib/tasks/service.ts` の `updateTask`（`EDITABLE_TASK_FIELDS` 許可リスト） | 再実装しない。`board_order` を許可リストに追加して再利用 |
| 認可ヘルパ | `lib/auth/authz.ts` の `requireLogin`（決定 D-15: タスク編集は全ログインユーザーに開放） | そのまま踏襲 |
| Server Actions の検証層 | `app/projects/[id]/tasks/actions.ts`（ランタイム検証 → service 呼び出し → `ActionResult`） | 同じ3層構成をボード用アクションでも踏襲 |
| PJ配下のタブ | `components/projects/ProjectTabs.tsx`（tasks / gantt / trash / settings） | `board` タブを追加 |
| サマリー再集計 | `lib/tasks/summary.ts` | **呼ばない**（§5.5 参照） |
| DBテストの型 | `mkdtempSync` + `migrate()` でファイルDBを立てる（`lib/tasks/hierarchy.test.ts`） | そのまま踏襲 |
| E2E のログイン | `e2e/helpers/auth.ts`（Better Auth `testUtils` で Cookie 直接発行） | そのまま踏襲 |
| CI | `.github/workflows/ci.yml`（lint / typecheck / coverage / build / audit / e2e） | 変更なし。カバレッジ閾値（85/75/85/85）を割らないこと |

`sortOrder`（`sort_order`）は既に **WBS 階層の表示順** として `lib/tasks/hierarchy.ts` の
indent / outdent が読み書きしています（`hierarchy.ts:44,68,83,122`）。§4 の判断はこの実物に基づきます。

---

## 3. 調査で確定した事実（2026-08-08 時点）

npm レジストリの実物（`npm view`）で確認しました。

| パッケージ | バージョン | license | peer |
|---|---|---|---|
| `@dnd-kit/core` | 6.3.1 | MIT | `react >=16.8.0` / `react-dom >=16.8.0` |
| `@dnd-kit/sortable` | 10.0.0 | MIT | `react >=16.8.0` / `@dnd-kit/core ^6.3.0` |
| `@dnd-kit/utilities` | 3.2.2 | MIT | （`CSS.Transform.toString` に必要） |
| `@mantine/charts` | 9.5.1 | MIT | `@mantine/core 9.5.1` / `@mantine/hooks 9.5.1` / `react ^19.2.0` / **`recharts >=3.2.1`** |
| `recharts` | 3.10.1 | MIT | `react ^16.8〜^19` / `react-is` / `react-dom` |

確定事項:

- **`@mantine/charts` の peer は `@mantine/core 9.5.1` の完全一致**。本リポジトリの Mantine は
  9.5.1（`package.json`）なので、そのまま噛み合います。Mantine を上げるときは charts も
  同時に上げる必要がある（dependabot の major 更新で片方だけ動くと peer が壊れる）。
- **`recharts` は `@mantine/charts` の peer であり、依存ではない**。npm 7+ は peer を自動導入
  しますが、暗黙に入ったバージョンに依存すると再現性が落ちるため、`recharts@3.10.1` を
  `dependencies` に**明示的に**追加します（`.npmrc` の `save-exact=true` により固定される）。
  `react-is` は recharts の peer なので npm の自動解決に任せ、導入後に `npm ls recharts react-is`
  で解決結果を確認します。
- **dnd-kit は React 19 のバージョン上限を持たない**（`>=16.8.0`）。React 19.2.8 で使えます。
- dnd-kit は `KeyboardSensor` を標準で持ち、Space → 矢印 → Space のキーボード操作で
  D&D が完結します。これは a11y 要件（Phase 1 M6 #35）を満たすと同時に、
  **E2E での決定的な操作手段**になります（§7.3）。

### 3.1 dnd-kit を選んだ理由

自作（HTML5 Drag and Drop API）を採らない理由は、`dragover` の `preventDefault` 漏れ・
ドラッグ画像・タッチ非対応・キーボード非対応といった落とし穴を全部自前で踏むことになるためです。
dnd-kit はポインタ／キーボード／タッチのセンサーと a11y アナウンスを標準で持ち、
`@dnd-kit/sortable` が「列内の並び替え」に必要な配列操作（`arrayMove`）まで提供します。
`react-beautiful-dnd` は 2025 年時点でメンテナンス終了（Atlassian が後継を別ライセンスへ移行）
のため候補から外します。

---

## 4. データモデルの変更 ⚠️ 要承認（ユーザー承認済み: 2026-08-08「GO」）

### 4.1 変更内容

`tasks` テーブルに **1列だけ**追加します。他のテーブル・カラムには一切触れません。

```ts
// lib/db/schema/app.ts の tasks テーブルに追加
// カンバン列内の表示順。sort_order（WBS階層の表示順）とは別の軸で持つ。
boardOrder: integer("board_order").notNull().default(0),
```

インデックスも1本追加します（列描画のクエリ `project_id + status + 生存` に効く）。

```ts
index("tasks_project_status_board_order_idx").on(
  table.projectId, table.status, table.boardOrder,
),
```

### 4.2 なぜ既存の `sort_order` を共用しないか

`sort_order` は `lib/tasks/hierarchy.ts` の indent / outdent が
「同じ `parent_id` を持つ兄弟の中での表示順」として読み書きしています。共用すると、
**カンバンで並び替えた瞬間に Gantt / タスク一覧の WBS 階層の並びまで変わります。**
逆に、Gantt でインデントするとカンバンの並びが飛びます。
2つの順序は意味が違う（片方は階層内の兄弟順、もう片方は列内の順）ので、列を分けます。

中間テーブル（`task_board_positions` 等）を新設する案も検討しましたが、
1タスクにつき高々1行の 1:1 テーブルになり、JOIN と「行が無いタスク」のフォールバック処理が
増えるだけで得るものがないため採りません。

### 4.3 マイグレーション

`drizzle-kit generate` が生成する `ALTER TABLE ADD COLUMN` に、**手書きでバックフィルを追記**します。
`NOT NULL DEFAULT 0` だけだと既存の全タスクが `board_order = 0` になり、列内の順序が
「同値の並び」＝不定になるためです。

```sql
--> statement-breakpoint 区切りで2文
ALTER TABLE `tasks` ADD `board_order` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `tasks` SET `board_order` = (
  SELECT COUNT(*) FROM `tasks` AS t2
   WHERE t2.`project_id` = `tasks`.`project_id`
     AND t2.`status`     = `tasks`.`status`
     AND ( t2.`created_at` <  `tasks`.`created_at`
        OR (t2.`created_at` = `tasks`.`created_at` AND t2.`id` < `tasks`.`id`) )
);
```

- 相関サブクエリのみを使い、`UPDATE ... FROM` や窓関数に依存しません（libSQL のバージョン差で
  こけないようにするため）。
- `created_at` 同値のタイブレークに `id` を使うため、結果は決定的です。
- **非破壊**（既存列の削除・型変更なし）。ロールバックは §10 参照。

**この SQL は実際に検証済みです。** `local.db`（12タスク / 5プロジェクト）のコピーに対して
`@libsql/client` から上記2文を実行し、`(project_id, status)` ごとに `board_order` が
`0..n-1` で振られること、`(project_id, status, board_order)` の重複が **0 件**であることを
確認しました。

### 4.4 許可リストへの追加

`lib/tasks/service.ts` の `EDITABLE_TASK_FIELDS` に `"boardOrder"` を追加します。
この配列はマスアサインメント防止の許可リスト（`service.ts:65`）であり、
ここに入れないと `updateTask` 経由では一切書き込めません。

---

## 5. カンバンボードの設計

### 5.1 画面とルーティング

| パス | 種別 | 役割 |
|---|---|---|
| `/projects/[id]/board` | Server Component | 認可 → データ取得のみ |
| `BoardClient.tsx` | Client Component | dnd-kit の `DndContext` と描画 |

Phase 1 のタスク一覧（`app/projects/[id]/tasks/page.tsx` → `TasksPageClient.tsx`）と同じ
「Server Component はデータ取得だけ、描画とインタラクションは Client へ委譲」の構成にします。
`components/projects/ProjectTabs.tsx` の `TABS` に `{ segment: "board", label: "ボード" }` を
タスクと Gantt の間に挿入します。

### 5.2 データ取得

`lib/db/queries.ts` に1本追加します（生存フィルタをこのファイルに集約する §3.2 規約に従う）。

```ts
/** カンバン用。type='task' の生存タスクのみを、列内の表示順で返す。 */
export async function listActiveBoardTasksByProject(db: Db, projectId: string) {
  return db.select().from(tasks)
    .where(and(
      eq(tasks.projectId, projectId),
      eq(tasks.type, "task"),
      isNull(tasks.deletedAt),
    ))
    .orderBy(asc(tasks.boardOrder), asc(tasks.id));
}
```

`id` を第2ソートキーにするのは、`board_order` が同値になった場合（並行更新の隙間など）でも
描画順が揺れないようにするためです。React の `key` の並びが安定し、D&D 中のちらつきを防ぎます。

### 5.3 並び替えアルゴリズム（列の完全リインデックス）

ドロップ確定時に、**影響を受けた列のタスク全件に対して `board_order = 0..n-1` を振り直します。**

```
moveTaskOnBoard(taskId, toStatus, toIndex):
  1. tx 開始
  2. 対象タスクを取得（生存・同一PJ・type='task' を検証）
  3. 移動元の列（fromStatus）と移動先の列（toStatus）の生存タスクを board_order 昇順で取得
  4. fromStatus から対象を除去 / toStatus の toIndex 位置へ挿入
  5. 変化した行だけ UPDATE（board_order、列をまたぐ場合は status も）
  6. tx コミット
```

- **フラクショナルインデックス（隣接2件の中間値）は採りません。** 実装が単純で読みやすい
  ことを優先します。1列あたりのタスク数は現実的に数十件で、全件 UPDATE でも
  数十行の書き込みに収まります。将来 1 列が数百件を超えたら再検討します（§9 R-3）。
- 読み取り（現在の列の並び）と書き込みを **1つの `db.transaction()` にまとめます**。
  `lib/tasks/hierarchy.ts` が TOCTOU 対策で同じことをしており、それに揃えます。
- 同一列内・同一位置へのドロップ（実質的な変化なし）は、UPDATE を1件も発行せず早期 return します。

純粋関数と DB 操作は分けます。

- `lib/board/order.ts` … `reorderWithinColumn` / `moveAcrossColumns`（配列 → 配列の純粋関数）。
  ここに全ての境界条件（先頭 / 末尾 / 範囲外 index / 空列 / 同一位置）のテストを集めます。
- `lib/board/service.ts` … `requireLogin` → 検証 → トランザクション → 純粋関数の適用 → 永続化。

### 5.4 Server Action

`app/projects/[id]/board/actions.ts` を、既存 `tasks/actions.ts` と同じ3層構成で書きます。

```ts
export async function moveTaskOnBoardAction(
  projectId: string, taskId: string, toStatus: unknown, toIndex: unknown,
): Promise<ActionResult>
```

ランタイム検証で弾くもの:

- `toStatus` が `STATUSES`（`todo`/`in_progress`/`review`/`done`）に含まれない値
- `toIndex` が非整数・負数
- 対象タスクが `projectId` に属していない（**他PJのタスクIDを送り込む攻撃**の遮断。
  Server Action の引数はクライアントから任意に送れるため、`projectId` との突き合わせを
  service 層で必ず行う）
- 対象タスクの `type` が `'task'` でない（summary / milestone をボード経由で動かさせない）

成功後は `revalidatePath` で `/projects/${projectId}/board` に加えて
`/projects/${projectId}/tasks` も再検証します（ステータス変更が一覧にも波及するため）。

### 5.5 サマリー再集計を呼ばない理由

`lib/tasks/summary.ts` の `recomputeAndPersistAncestorSummaries` が集計するのは
`progress` / `estimatedHours` / `actualHours` の3つで、`status` は集計対象外です
（`summary.ts` の docstring）。カンバンの操作はこの3つを変えないため、呼ぶ必要がありません。
呼ばないことを service 層のコメントに明記し、将来の「なぜ呼んでいないのか」を残します。

### 5.6 UI

| 要素 | 実装 |
|---|---|
| 列 | `todo` / `in_progress` / `review` / `done` の4列。見出しは `statusLabel()` の日本語 |
| 列の色 | `TasksPageClient.tsx` の `STATUS_COLORS`（gray / blue / yellow / green）を共通化して再利用 |
| カード | タイトル・優先度 Badge・期間・進捗・担当者。`TasksPageClient` の表示要素に揃える |
| カードのクリック | 既存の `components/tasks/TaskDrawer.tsx` を開く（詳細編集は再実装しない） |
| ドラッグ中 | `DragOverlay` で掴んでいるカードを追従表示。元の位置はプレースホルダ |
| 空の列 | 「タスクがありません」のプレースホルダ（**空でもドロップ先になる**ことが要件） |
| 楽観更新 | ドロップ直後にローカル state を更新 → Server Action → 失敗時は元に戻して通知 |
| 失敗時 | `@mantine/notifications` でエラー表示（M4 の伝播トーストと同じ作法） |

実装上の注意:

- `DndContext` には**明示的な `id` を渡します**。省略すると内部の `useId` 由来の識別子が
  SSR とクライアントでずれる可能性があり、ハイドレーション警告の温床になります。
- 空の列をドロップ可能にするには、列そのものを `useDroppable` にする必要があります
  （`SortableContext` は items が空だとドロップ判定を持たないため）。ここは実装漏れが
  起きやすい箇所なので、E2E で「空の列へ移動できる」ケースを明示的に押さえます。
- ボードは横スクロールします。4列がビューポートに収まらない画面幅（M6 #35 のレスポンシブ確認と
  同じ基準）では、列を固定幅にして横スクロールさせます。

### 5.7 ステータスと進捗の連動について（決定）

「完了列に落としたら `progress` を 100 にするか」は、**連動させません。**
ヒアリングで挙がっていない挙動であり、勝手に進捗を書き換えると
サマリータスクの集計値（`lib/tasks/summary.ts`）まで芋づるで変わるためです。
必要になったら別途決めます（§9 未決事項 Q-1）。

---

## 6. ダッシュボードの設計

### 6.1 画面とルーティング

| パス | 種別 | 役割 |
|---|---|---|
| `/dashboard` | Server Component | 認可 → 集計 → Client へ渡す |
| `DashboardClient.tsx` | Client Component | `@mantine/charts` の描画（チャートはクライアント専用） |

ヘッダー（`app/layout.tsx`）に `/dashboard` へのリンクを追加します。
閲覧は全ログインユーザーに開いている（決定 D-08）ため、`requireLogin` のみで
プロジェクトの絞り込みは行いません。

### 6.2 集計の対象と定義

**対象は `type = 'task'` の生存タスクのみ**（カンバンと同じ基準）。

- `summary` は子の集計行なので、含めると二重計上になる。
- `milestone` は決定 D-12 により Phase 1 の UI から作成できず、実データが存在しない。

| 指標 | 定義 |
|---|---|
| ステータス別タスク数 | 全PJ横断で `status` ごとに件数。ドーナツチャート + 数値 |
| 期限超過タスク一覧 | `end_date < 今日` **かつ** `status != 'done'`。期限の古い順。PJ名とタスク名を出しリンクする |
| プロジェクト別進捗率 | `完了タスク数 / 全タスク数`（件数ベース）。横棒チャート |

**進捗率を「件数ベース」にする理由。** `progress` カラムは手入力で、未入力のまま 0 が残っている
タスクが多く、平均を取ると実態より低く出ます。`status = 'done'` は
カンバンとタスク一覧の両方で日常的に更新される値なので、こちらのほうが実態を反映します。
タスクが 0 件の PJ は分母 0 になるため、進捗率 0% ではなく「タスクなし」と表示します。

### 6.3 「今日」の判定（重要）

Vercel のサーバは **UTC** で動きます。素朴に `new Date()` から日付を取ると、
JST の 0:00〜9:00 の間はサーバ側の日付が1日前になり、**期限超過の判定が丸1日ずれます。**

`lib/dates/date-only.ts` に、タイムゾーンを明示して date-only 文字列を得るヘルパーを追加します。

```ts
/**
 * 指定タイムゾーンにおける「今日」を 'YYYY-MM-DD' で返す。
 * 'en-CA' ロケールの日付書式が ISO と同じ YYYY-MM-DD であることを利用する。
 */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}
```

集計側では `todayInTimeZone("Asia/Tokyo")` を使います。`now` を引数で差し替えられるように
することで、日付境界（JST 0:00 直後 / 23:59）のテストを固定時刻で書けます。
比較は date-only 文字列の辞書順比較で成立します（ゼロ埋め固定長のため）。

### 6.4 集計ロジックの置き場所

- `lib/dashboard/metrics.ts` … **タスク配列 → 集計結果** の純粋関数群。
  `countByStatus` / `findOverdueTasks` / `computeProjectProgress`。ここにテストを集中させます。
- `lib/db/queries.ts` … `listAllActiveTaskTypeTasks(db)`（全PJ横断・`type='task'`・生存）を追加。

集計はアプリ側の純粋関数で行い、SQL の `GROUP BY` には寄せません。
理由は、①テストが DB なしで書けること、②Phase 1 の全ロジックが
「クエリは queries.ts / 計算は純粋関数」の構成で統一されていること、の2点です。
PJ 数・タスク数が数千を超えたら SQL 集計へ寄せます（§9 R-4）。

### 6.5 グラフ

`@mantine/charts` の `DonutChart`（ステータス別）と `BarChart`（PJ別進捗率）を使います。

- `app/layout.tsx` に `import "@mantine/charts/styles.css";` を追加します。
  既存の `mantine-datatable/styles.css` と同じで、**CSS の import 漏れは描画崩れとして現れます**。
- チャートは Client Component 内でのみ使います。
- データが 0 件のときはチャートを描かず「データがありません」を出します
  （空配列を渡した Recharts は高さ 0 の空要素になり、原因の分かりにくい見た目の不具合になるため）。

---

## 7. テスト計画（TDD）

Red → Green → Refactor。純粋関数のテストを先に書いてから DB・UI に降ります。

### 7.1 ユニット（Vitest）

| ファイル | ケース |
|---|---|
| `lib/board/order.test.ts` | 列内の前方/後方移動・先頭/末尾・同一位置（変化なし）・空列への挿入・index が範囲外・1件だけの列 |
| `lib/board/service.test.ts` | 列間移動で `status` と `board_order` が両方更新される / 移動元の列が詰まる / 他PJのタスクIDは `NotFoundError` / `type='summary'` は `ValidationError` / 論理削除済みは対象外 / 未ログインは `UnauthorizedError` |
| `lib/dashboard/metrics.test.ts` | ステータス別の件数（0件の status も 0 として出る）/ 期限超過は `done` を除外する / 期限が今日ちょうどは超過ではない / 分母 0 の PJ / `type != 'task'` の除外 |
| `lib/dates/date-only.test.ts`（追記） | `todayInTimeZone("Asia/Tokyo")` が JST 0:00 直後・23:59 で正しい日付を返す（`now` を固定して検証） |

DB を使うテストは既存作法（`mkdtempSync` + `migrate()` でファイル DB）に揃えます。
`project_members` / `task_assignees` に FK があるため、必要に応じて
`lib/db/testHelpers.ts` の `insertTestUsers` を使います。

**カバレッジ閾値（statements 85 / branches 75 / functions 85 / lines 85）を割らないこと。**
新規の Client Component は node 環境のテストで拾えないため、
純粋関数側（`lib/board/order.ts` / `lib/dashboard/metrics.ts`）を厚く書いて相殺します。

### 7.2 検証は自分で実行する

`npm run lint` / `npm run typecheck` / `npm run test:coverage` / `npm run build` /
`npm run test:e2e` を実行し、PASS / FAIL を提示します。

### 7.3 E2E（Playwright）

`e2e/board.spec.ts` と `e2e/dashboard.spec.ts` を追加します。

**D&D はキーボード操作（dnd-kit の `KeyboardSensor`）で駆動します。**
マウスの `mouse.move` を刻む方式は、ドラッグ判定のしきい値やアニメーション待ちに依存して
不安定（flaky）になりがちです。キーボード操作なら Space → 矢印 → Space の離散的な
イベント列で完結し、決定的に再現できます。a11y の実動作確認も同時に果たせます。

| ケース | 検証内容 |
|---|---|
| 列間移動 | 未着手のカードを対応中へ移動 → リロード後も対応中にいる（＝DBに永続化されている） |
| 列内並び替え | 同一列の1番目と2番目を入れ替え → リロード後も順序が保たれる |
| 空の列へ移動 | タスクが1件も無い列にドロップできる |
| ダッシュボード | 期限超過タスクが一覧に出る / ステータス別の件数が実データと一致する |

---

## 8. Issue 分解

Phase 1 と同じ「半日〜1日」の粒度です。**#36〜#38 は直列**（スキーマが全ての前提）、
**M8 と M9 は並行可能**です。

### M7 — 基盤（直列）

| # | Issue | type |
|---|---|---|
| 36 | `tasks.board_order` 追加 + バックフィル付きマイグレーション + `EDITABLE_TASK_FIELDS` 更新（§4） | data |
| 37 | 依存追加: `@dnd-kit/core` / `@dnd-kit/sortable` / `@dnd-kit/utilities` / `@mantine/charts` / `recharts`。`npm ls` で peer 解決を確認。あわせて `.github/dependabot.yml` に `@mantine/*` をまとめる `groups` を追加（R-5） | ops |
| 38 | `lib/dates/date-only.ts` に `todayInTimeZone` を追加 + テスト（§6.3） | feature |

### M8 — カンバンボード

| # | Issue | type |
|---|---|---|
| 39 | `lib/board/order.ts`（純粋関数）を TDD で実装 | feature |
| 40 | `lib/board/service.ts` + `listActiveBoardTasksByProject` クエリ + DBテスト | feature |
| 41 | `moveTaskOnBoardAction`（ランタイム検証・他PJ遮断・type 検証） | feature |
| 42 | `/projects/[id]/board` の画面と `BoardClient`（dnd-kit / DragOverlay / 空列の droppable） | feature |
| 43 | カードから `TaskDrawer` を開く導線 + 楽観更新と失敗時のロールバック通知 | feature |
| 44 | `ProjectTabs` に「ボード」タブを追加 | feature |
| 45 | E2E: 列間移動 / 列内並び替え / 空列への移動（キーボード D&D） | feature |

### M9 — ダッシュボード

| # | Issue | type |
|---|---|---|
| 46 | `lib/dashboard/metrics.ts`（純粋関数）を TDD で実装 | feature |
| 47 | 全PJ横断クエリ `listAllActiveTaskTypeTasks` を `queries.ts` に追加 | data |
| 48 | `/dashboard` の画面 + `DashboardClient`（DonutChart / BarChart / 期限超過テーブル） | feature |
| 49 | `app/layout.tsx` に charts の CSS import とヘッダーリンクを追加 | feature |
| 50 | 空状態（タスク0件 / 期限超過0件 / PJ0件）の整備 | feature |
| 51 | E2E: ダッシュボードの数値と一覧が実データと一致する | feature |

---

## 9. リスクと未決事項

| ID | 内容 | 対処 |
|---|---|---|
| R-1 | `board_order` のバックフィル SQL が Turso 本番で意図どおり動かない | ローカルのファイル DB で migrate → 実データ形状で結果を検証してから push。相関サブクエリのみを使い、方言依存を避ける（§4.3） |
| R-2 | 並行操作（2人が同じ列を同時に並び替え）で順序が食い違う | 読み書きを1トランザクションに入れる。それでも「後勝ち」にはなるが、列の完全リインデックス方式なので**壊れた状態（重複・欠番）にはならない**。リロードで整合する |
| R-3 | 1列のタスクが数百件を超えると、ドロップごとの全件 UPDATE が重くなる | 現状の想定規模では問題にならない。閾値を超えたらフラクショナルインデックスへ移行（§5.3） |
| R-4 | ダッシュボードの全PJ横断集計が、データ増加で遅くなる | 純粋関数での集計は数千件までは問題ない。超えたら SQL の `GROUP BY` へ寄せる（§6.4） |
| R-5 | `@mantine/charts` と `@mantine/core` の peer がバージョン完全一致 | 現在の `.github/dependabot.yml` に `groups` 設定は**無く**、`@mantine/*` は個別の PR で上がる。片方だけ上がると peer が壊れるため、**M7 #37 で `@mantine/*` をまとめる `groups` を追加する**（下記） |
| R-6 | dnd-kit の SSR ハイドレーション不一致 | `DndContext` に明示的な `id` を渡す（§5.6） |
| R-7 | 空の列にドロップできない実装漏れ | 列自体を `useDroppable` にする。E2E で明示的に押さえる（§7.3） |
| R-8 | Vercel の UTC と JST のずれで期限超過が1日ずれる | `todayInTimeZone("Asia/Tokyo")` を使う。境界時刻を固定したテストを書く（§6.3） |

未決事項（実装をブロックしません。この計画では下記の既定で進めます）:

- **Q-1**: 完了列へのドロップで `progress` を 100 にするか → **既定: しない**（§5.7）
- **Q-2**: ダッシュボードの期限超過一覧の表示件数上限 → **既定: 上限なし。20件超で「もっと見る」**
- **Q-3**: カンバンにフィルター（担当者・優先度）を付けるか → **既定: 今回は付けない。**
  ヒアリングの表示項目に無く、スコープを膨らませないため

---

## 10. ロールバック

| 変更 | 戻し方 |
|---|---|
| 画面・ロジック（M8 / M9） | PR を revert する。追加ファイルのみで既存画面を書き換えないため、影響は局所的 |
| `ProjectTabs` / `app/layout.tsx` への追記 | 同上（数行の追記のみ） |
| `board_order` カラム | **列は残したまま無害化する。**`NOT NULL DEFAULT 0` の追加列であり、読む側のコードが消えれば値は誰も見ない。SQLite の `DROP COLUMN` はインデックス付き列で制約があり、無理に落とすほうが危険 |
| 依存パッケージ | `package.json` / `package-lock.json` を revert |

**`board_order` の追加は既存データを一切書き換えません**（追加列のバックフィルのみ）。
Phase 1 の機能はこの列を読まないため、Phase 2 を丸ごと revert しても Phase 1 は動きます。

---

## 11. 決定ログ

| ID | 決定 | 根拠 |
|---|---|---|
| P2-01 | カンバンの列は既存 `status` を使い、enum を変更しない | スキーマ変更を最小に。ラベルは `lib/labels.ts` が既に日本語化済み |
| P2-02 | カンバンの対象は `type='task'` のみ | summary は集計行、milestone は D-12 により UI 非公開 |
| P2-03 | 列内の順序は `tasks.board_order` を新設して保存 | `sort_order` は WBS 階層順として `hierarchy.ts` が使用中。共用すると Gantt の並びが壊れる（§4.2） |
| P2-04 | D&D は dnd-kit（`@dnd-kit/core` + `sortable`） | MIT / React 19 対応 / キーボード・タッチ・a11y を標準装備。`react-beautiful-dnd` はメンテ終了 |
| P2-05 | 並び替えは列の完全リインデックス（フラクショナルインデックスを使わない） | 実装が単純で不変条件が明快。想定規模で性能問題にならない |
| P2-06 | ステータス変更で `progress` を自動変更しない | ヒアリング外の挙動。サマリー集計に波及する |
| P2-07 | ダッシュボードの進捗率は件数ベース（`done` の割合） | `progress` は手入力で未入力の 0 が多く、実態を反映しない |
| P2-08 | 「今日」は `Asia/Tokyo` 固定で求める | Vercel は UTC。素朴な実装だと JST 0〜9 時に期限超過が1日ずれる |
| P2-09 | `recharts` を `dependencies` に明示追加 | `@mantine/charts` の peer。暗黙の自動解決に依存すると再現性が落ちる |
| P2-10 | 集計は SQL ではなくアプリ側の純粋関数で行う | DB なしでテストでき、Phase 1 の構成（クエリと計算の分離）と一貫する |
| P2-11 | E2E の D&D はキーボード操作で駆動する | マウスのドラッグ再現は flaky。キーボードなら決定的で、a11y の検証も兼ねる |
| P2-12 | CSV エクスポートは含めない | ヒアリングで明示的に対象外 |
