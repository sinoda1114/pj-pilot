import { expect, test, type Page } from "@playwright/test";
import { createDb, type DbHandle } from "../lib/db/client";
import { createProject } from "../lib/projects/service";
import { createTask } from "../lib/tasks/service";
import { addSessionCookies, createTestUser } from "./helpers/auth";

/**
 * カンバンボードの e2e（Phase 2 M8 #45）。
 *
 * **D&D はキーボード操作で駆動する**（決定 P2-11）。dnd-kit は `KeyboardSensor` を
 * 標準で持ち、Space でつかむ → 矢印で移動 → Space で確定、という離散的な
 * イベント列で完結する。マウスの `mouse.move` を刻む方式はドラッグ判定のしきい値や
 * アニメーション待ちに依存して flaky になりやすく、同時に a11y の実動作確認も兼ねられる
 * ため、こちらを採る。
 */

let session: Awaited<ReturnType<typeof createTestUser>>;
let handle: DbHandle;
let projectId: string;
/** Issue #55 の回帰テスト専用のプロジェクト（他テストの並び順に影響されないよう分ける）。 */
let newTaskProjectId: string;

test.beforeAll(async () => {
  session = await createTestUser({ email: "e2e-board@example.com", name: "E2E Board" });

  const resolvedUrl = process.env.TURSO_DATABASE_URL ?? "file:local.db";
  handle = createDb(resolvedUrl);

  const project = await createProject(
    handle.db,
    { userId: session.userId },
    { name: `E2E カンバン検証用 ${Date.now()}` },
  );
  projectId = project.id;

  const newTaskProject = await createProject(
    handle.db,
    { userId: session.userId },
    { name: `E2E 新規作成順検証用 ${Date.now()}` },
  );
  newTaskProjectId = newTaskProject.id;

  // 未着手に3件だけ置く。他の列は空にしておき、「空の列へ移動できる」ことも検証する。
  for (const [index, title] of ["ボードA", "ボードB", "ボードC"].entries()) {
    await createTask(handle.db, { userId: session.userId }, projectId, {
      title,
      startDate: "2026-08-01",
      endDate: "2026-08-05",
      status: "todo",
      boardOrder: index,
    });
  }
});

test.afterAll(() => {
  handle.client.close();
});

test.beforeEach(async ({ context }) => {
  await addSessionCookies(context, session.cookies);
});

/** 指定した列に並んでいるカードのタイトルを、表示順のまま返す。 */
async function columnTitles(page: Page, status: string): Promise<string[]> {
  const cards = page.getByTestId(`board-column-${status}`).getByTestId("board-card");
  return (await cards.allInnerTexts()).map((text) => text.split("\n")[0]!.trim());
}

/**
 * キーボードでカードをつかみ、指定回数だけ矢印キーを押してから確定する。
 * dnd-kit の KeyboardSensor は Space/Enter でつかみ、矢印で移動、再度 Space/Enter で確定する。
 *
 * **キー入力の間に待機を入れるのが必須。** dnd-kit は矢印キーで座標を更新したあと、
 * 次のフレームで衝突判定を走らせて `over` を決める。間を空けずに確定の Space を押すと
 * 移動が反映される前に確定してしまい、`onDragEnd` の `over` が `active` 自身になって
 * 「何も起きない」状態になる（実際にブラウザ上で `over === active` を観測して特定した）。
 */
const KEY_SETTLE_MS = 200;

async function keyboardDrag(
  page: Page,
  cardTitle: string,
  key: "ArrowRight" | "ArrowLeft" | "ArrowUp" | "ArrowDown",
  times: number,
): Promise<void> {
  const card = page.getByTestId("board-card").filter({ hasText: cardTitle }).first();
  await card.scrollIntoViewIfNeeded();
  await card.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(KEY_SETTLE_MS);
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press(key);
    await page.waitForTimeout(KEY_SETTLE_MS);
  }
  await page.keyboard.press("Space");
}

test("未着手のカードを対応中へ移動でき、リロード後も保持される（列間D&D）", async ({ page }) => {
  await page.goto(`/projects/${projectId}/board`);
  await expect(page.getByTestId("board-column-todo")).toBeVisible();
  expect(await columnTitles(page, "todo")).toEqual(["ボードA", "ボードB", "ボードC"]);

  await keyboardDrag(page, "ボードA", "ArrowRight", 1);

  await expect
    .poll(() => columnTitles(page, "in_progress"), { timeout: 10_000 })
    .toEqual(["ボードA"]);

  // リロードしても保たれる ＝ ローカル state だけでなく DB に永続化されている
  await page.reload();
  await expect(page.getByTestId("board-column-in_progress")).toBeVisible();
  expect(await columnTitles(page, "in_progress")).toEqual(["ボードA"]);
  expect(await columnTitles(page, "todo")).toEqual(["ボードB", "ボードC"]);
});

test("同じ列の中で並び替えでき、リロード後も順序が保たれる（列内D&D）", async ({ page }) => {
  await page.goto(`/projects/${projectId}/board`);
  await expect(page.getByTestId("board-column-todo")).toBeVisible();
  const before = await columnTitles(page, "todo");
  expect(before).toEqual(["ボードB", "ボードC"]);

  await keyboardDrag(page, "ボードB", "ArrowDown", 1);

  await expect
    .poll(() => columnTitles(page, "todo"), { timeout: 10_000 })
    .toEqual(["ボードC", "ボードB"]);

  await page.reload();
  await expect(page.getByTestId("board-column-todo")).toBeVisible();
  expect(await columnTitles(page, "todo")).toEqual(["ボードC", "ボードB"]);
});

test("タスクが1件も無い列にも移動できる（空の列がドロップ先になる）", async ({ page }) => {
  await page.goto(`/projects/${projectId}/board`);
  await expect(page.getByTestId("board-column-review")).toBeVisible();
  // 確認中は空のまま
  expect(await columnTitles(page, "review")).toEqual([]);

  // 対応中（ボードA）→ 確認中 へ1つ右
  await keyboardDrag(page, "ボードA", "ArrowRight", 1);

  await expect.poll(() => columnTitles(page, "review"), { timeout: 10_000 }).toEqual(["ボードA"]);

  await page.reload();
  await expect(page.getByTestId("board-column-review")).toBeVisible();
  expect(await columnTitles(page, "review")).toEqual(["ボードA"]);
});

test("カードをクリックすると詳細Drawerが開く", async ({ page }) => {
  await page.goto(`/projects/${projectId}/board`);
  await page.getByTestId("board-card").filter({ hasText: "ボードC" }).first().click();

  await expect(page.getByRole("textbox", { name: "タイトル" })).toHaveValue("ボードC");
});

/**
 * Cursor Bugbot の指摘（Medium）の回帰テスト。
 *
 * ボードは楽観更新のためにタスク一覧をローカル state に持つ。Drawer で保存したあと
 * `router.refresh()` でサーバー側は取り直されるが、ローカル state を新しい props と
 * 同期していないと、DB は更新済みなのにカードは古いタイトルのまま残る。
 */
test("Drawerで編集して保存すると、カードの表示も更新される", async ({ page }) => {
  await page.goto(`/projects/${projectId}/board`);
  await page.getByTestId("board-card").filter({ hasText: "ボードC" }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "タスク詳細" })).toBeVisible();
  await dialog.getByLabel("タイトル").fill("ボードC（更新済み）");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();

  // リロードせずに、その場のカード表示が更新されること
  await expect(
    page.getByTestId("board-card").filter({ hasText: "ボードC（更新済み）" }),
  ).toBeVisible({ timeout: 10_000 });
});

/**
 * Issue #55 の回帰テスト。
 *
 * 上のテスト群は `beforeAll` で `boardOrder: index` を**明示的に**渡しているため、
 * 「画面から新規作成したタスクをドラッグする」という実際の利用経路を踏んでいない。
 * `createTaskAction` は `boardOrder` を渡さないので、採番が無いと全タスクが 0 になり、
 * その状態でドラッグすると掴んだカードが列の末尾へ飛んでいた。
 *
 * ここでは画面の「新規タスク作成」から作り、そのままカンバンで並び替える。
 */
test("画面から作ったタスクをカンバンで並び替えても、掴んだ位置に留まる（Issue #55）", async ({
  page,
}) => {
  const runId = Date.now().toString(36).slice(-6);
  const titles = [`新規A${runId}`, `新規B${runId}`, `新規C${runId}`];

  // UI の「新規タスク作成」から3件作る（boardOrder は渡されない経路）
  await page.goto(`/projects/${newTaskProjectId}/tasks`);
  for (const title of titles) {
    await page.getByRole("button", { name: "新規タスク作成" }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("textbox", { name: "タイトル" }).fill(title);
    await drawer.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }

  await page.goto(`/projects/${newTaskProjectId}/board`);
  await expect(page.getByTestId("board-column-todo")).toBeVisible();
  // 作成順に並ぶこと（採番が無いと id 依存の順序になり、この時点で崩れる）
  expect(await columnTitles(page, "todo")).toEqual(titles);

  // 先頭を1つ下へ動かす
  await keyboardDrag(page, titles[0]!, "ArrowDown", 1);

  const expected = [titles[1]!, titles[0]!, titles[2]!];
  await expect.poll(() => columnTitles(page, "todo"), { timeout: 10_000 }).toEqual(expected);

  await page.reload();
  await expect(page.getByTestId("board-column-todo")).toBeVisible();
  expect(await columnTitles(page, "todo")).toEqual(expected);
});

/**
 * カンバンの絞り込み（計画書 §9 の未決事項 Q-3 を「付ける」に変更した分）。
 *
 * 上のテスト群はカードの並びを実際に動かして共有状態を書き換えていくため、
 * 絞り込みの検証は**専用のプロジェクトを別に作って**行う。同じプロジェクトを使うと
 * 実行順やリトライで初期状態が変わり、期待値が壊れる。
 */
test.describe("絞り込み", () => {
  let filterProjectId: string;

  test.beforeAll(async () => {
    const project = await createProject(
      handle.db,
      { userId: session.userId },
      { name: `E2E カンバン絞り込み検証用 ${Date.now()}` },
    );
    filterProjectId = project.id;

    const rows = [
      { title: "絞込用-緊急", priority: "urgent" },
      { title: "絞込用-高", priority: "high" },
      { title: "絞込用-中", priority: "medium" },
    ] as const;

    for (const [index, row] of rows.entries()) {
      await createTask(handle.db, { userId: session.userId }, filterProjectId, {
        title: row.title,
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        status: "todo",
        priority: row.priority,
        boardOrder: index,
      });
    }
  });

  test("優先度で絞り込むと該当カードだけが残り、解除すると全件に戻る", async ({ page }) => {
    await page.goto(`/projects/${filterProjectId}/board`);
    await expect(page.getByTestId("board-column-todo")).toBeVisible();
    expect(await columnTitles(page, "todo")).toEqual(["絞込用-緊急", "絞込用-高", "絞込用-中"]);
    await expect(page.getByTestId("board-count-todo")).toHaveText("3");
    // 絞り込んでいない間は「絞り込み中」の表示を出さない
    await expect(page.getByTestId("board-filter-status")).toBeHidden();

    // 「高」だけを選ぶ。
    // ラベル起点（getByLabel / getByRole("combobox")）では安定しない。Mantine の
    // MultiSelect は ①展開後の listbox にも aria-labelledby でラベルが紐づくため
    // getByLabel が2要素に一致し、②選択後は内側の入力欄が data-type="hidden" になって
    // ラッパーがクリックを横取りする。どちらも実際に踏んだので testid でラッパーを掴む。
    await page.getByTestId("board-filter-priority").getByRole("combobox").click();
    await page.getByRole("option", { name: "高", exact: true }).click();
    await page.keyboard.press("Escape");

    await expect.poll(() => columnTitles(page, "todo"), { timeout: 10_000 }).toEqual(["絞込用-高"]);
    // 件数バッジは絞り込み後の件数
    await expect(page.getByTestId("board-count-todo")).toHaveText("1");
    // 絞り込み中である旨が出ている
    await expect(page.getByTestId("board-filter-status")).toContainText("全3件中1件");

    // 「緊急」も足すと OR で2件になる
    await page.getByTestId("board-filter-priority").getByRole("combobox").click();
    await page.getByRole("option", { name: "緊急", exact: true }).click();
    await page.keyboard.press("Escape");

    await expect
      .poll(() => columnTitles(page, "todo"), { timeout: 10_000 })
      .toEqual(["絞込用-緊急", "絞込用-高"]);
    await expect(page.getByTestId("board-count-todo")).toHaveText("2");

    // 解除すると全件に戻る
    await page.getByRole("button", { name: "絞り込みを解除" }).click();

    await expect
      .poll(() => columnTitles(page, "todo"), { timeout: 10_000 })
      .toEqual(["絞込用-緊急", "絞込用-高", "絞込用-中"]);
    await expect(page.getByTestId("board-count-todo")).toHaveText("3");
    await expect(page.getByTestId("board-filter-status")).toBeHidden();
  });
});
