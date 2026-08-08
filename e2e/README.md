# E2E テストの書き方（Mantine ロケータ規約）

Playwright で Mantine コンポーネントを操作するときの規約。ここに書いてあるものは
**すべて実際に CI か実機で踏んだ罠**で、同じ書き方をすると再発する。新しい spec を
書く前に一読すること。個々の発生箇所には spec 内コメントでも同じ説明を残している。

## 規約（結論）

| 対象 | 使う | 使わない |
|---|---|---|
| Select（単一選択） | `page.getByRole("combobox", { name: "ラベル" })` | `getByLabel("ラベル")` |
| MultiSelect | 外側ラッパーの `data-testid` 経由で `getByTestId(...).getByRole("combobox")` | `getByLabel` / 素の `getByRole("combobox")` |
| ドロップダウンの選択肢 | `page.getByRole("option", { name: "...", exact: true })` | テキスト一致 |
| dnd-kit のドラッグ対象 | sortable を張った**外側の要素**に `data-testid` | 内側の `Card` 等に testid |
| 画面・プロジェクト名 | ヘッダーのリンク名（「ダッシュボード」等）と重複しない名前 | 機能名入りの名前 |

## それぞれの理由（踏んだ罠）

### 1. `getByLabel` は Select で strict mode violation になる

Mantine の Select は、展開後の listbox にも `aria-labelledby` で同じラベルが紐づく。
そのため `getByLabel("ステータス")` が入力欄と listbox の2要素に一致し、
strict mode violation で落ちる。**開閉のタイミングに依存するため、ローカルでは
通って CI でだけ落ちる**（csv-export.spec.ts で実際に発生）。
`getByRole("combobox", { name: ... })` なら入力欄だけに一致する。

### 2. MultiSelect は選択後に入力欄が隠れる

非 `searchable` の MultiSelect は、値を選ぶと内側の `<input>` が
`data-type="hidden"` になり、ラッパー要素がクリックを横取りする。さらに罠 1 も
同時に踏む。また Mantine は `data-testid` を**内側の input に転送する**ため、
コンポーネントに直接 testid を渡しても「隠れた input」を掴んでしまう。

対策は二段構え（board.spec.ts / BoardClient.tsx）:

- testid はコンポーネントではなく**外側の `<div data-testid="...">`** に付ける
- `getByTestId("...").getByRole("combobox")` で開き、選択後は `Escape` で閉じる
- 併せて MultiSelect 自体を `searchable` にしておくと入力欄が隠れなくなる

### 3. dnd-kit のドラッグは sortable の要素に testid を付ける

`useSortable` のリスナーを張った外側の要素ではなく内側の `Card` に testid を
付けると、キーボード操作（`focus()` → Space → 矢印）がドラッグ対象に届かず、
**何も起きないまま黙って成功扱い**になる。sortable を張った要素自体に testid を
付けること。またキー操作の間には待ち時間が必要（`KEY_SETTLE_MS = 200`。
連打すると `over === active` のまま判定が進み移動しない）。

### 4. テストデータの名前にヘッダーのリンク名を含めない

プロジェクト名に「ダッシュボード」を含めると、一覧のプロジェクトリンクと
ヘッダーのナビゲーションリンクが同名になり strict mode violation になる
（dashboard.spec.ts で実際に発生）。`E2E 集計検証用 ${Date.now()}` のように
機能名を避け、かつ**実行ごとに一意**な名前にする（retry や `beforeAll` 再実行で
前回の残骸を拾わないため。csv-export.spec.ts で実際に発生）。

## その他の運用

- E2E は port 3000 の開発サーバーを共有するため**並列実行しない**
  （サブエージェントに分担させる場合も E2E だけは中央で直列実行する）。
- ローカル DB（`file:local.db`）はプロセス間競合で `SQLITE_BUSY` になりうる。
  `createDb` が busy timeout 5000ms を既定で持つ（`lib/db/client.ts`）。
