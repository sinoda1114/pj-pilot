import { test, expect } from "@playwright/test";
import { createDb } from "../lib/db/client";
import { createDependency } from "../lib/dependencies/service";
import { createProject } from "../lib/projects/service";
import { createTask } from "../lib/tasks/service";
import { addSessionCookies, createTestUser } from "./helpers/auth";

/**
 * Gantt 画面の E2E（M3 #20 / M4 ドラッグ連動）。既存タスクの階層・日付・依存線の
 * 表示に加え、ドラッグでの移動→依存連動→Undo、依存の新規作成を検証する。
 *
 * テストデータの作成は実際のログインフローを経由せず service 層を直接呼び出すが、
 * 呼び出しに使う`userId`は`testUtils`で作成した実Better Authユーザーのものを使う
 * （各ページの`requireLogin`が実セッションを要求するため）。
 */
let session: Awaited<ReturnType<typeof createTestUser>>;

let projectId: string;
let emptyProjectId: string;
let dragProjectId: string;
/** サマリードラッグ禁止（Issue #50）の検証用。他テストの日付を動かさないよう分ける。 */
let summaryProjectId: string;
let linkProjectId: string;

// 2 つのテストが同じファイル DB（`file:local.db`、webServer が起動する唯一の
// Next.js に紐づく）へ並行して書き込むと `SQLITE_BUSY: database is locked` が
// 非決定的に発生する（実機確認済み）ため、データ作成は 1 つの `beforeAll` に
// まとめて 1 コネクションで直列に行い、テスト自体も `serial` で実行する
// （`playwright.config.ts` で `workers: 1` に固定済みだが、念のためファイル内でも直列化する）。
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  session = await createTestUser({ email: "e2e-gantt@example.com", name: "E2E Gantt" });
  const authSession = { userId: session.userId };

  const { db, client } = createDb();
  try {
    const project = await createProject(db, authSession, {
      name: `E2E Gantt表示確認 ${Date.now()}`,
    });
    projectId = project.id;

    const parent = await createTask(db, authSession, projectId, {
      title: "E2E親タスク",
      type: "summary",
      startDate: "2026-08-10",
      endDate: "2026-08-20",
    });

    await createTask(db, authSession, projectId, {
      title: "E2E子タスクA",
      parentId: parent.id,
      startDate: "2026-08-10",
      endDate: "2026-08-14",
      sortOrder: 0,
    });

    await createTask(db, authSession, projectId, {
      title: "E2E子タスクB",
      parentId: parent.id,
      startDate: "2026-08-15",
      endDate: "2026-08-20",
      sortOrder: 1,
    });

    await createTask(db, authSession, projectId, {
      title: "E2Eピン留めタスク",
      startDate: "2026-08-10",
      endDate: "2026-08-12",
      isPinned: true,
    });

    const empty = await createProject(db, authSession, {
      name: `E2E Gantt空状態確認 ${Date.now()}`,
    });
    emptyProjectId = empty.id;

    // ドラッグ連動用: A→Bの依存を持つ2タスク。
    const dragProject = await createProject(db, authSession, {
      name: `E2E Ganttドラッグ連動確認 ${Date.now()}`,
    });
    dragProjectId = dragProject.id;

    const summaryProject = await createProject(
      db,
      authSession,
      { name: `E2E サマリードラッグ検証用 ${Date.now()}` },
    );
    summaryProjectId = summaryProject.id;
    const summaryParent = await createTask(db, authSession, summaryProjectId, {
      title: "SD親サマリー",
      type: "summary",
      startDate: "2026-08-10",
      endDate: "2026-08-20",
    });
    await createTask(db, authSession, summaryProjectId, {
      title: "SD子A",
      parentId: summaryParent.id,
      startDate: "2026-08-10",
      endDate: "2026-08-14",
      sortOrder: 0,
    });
    await createTask(db, authSession, summaryProjectId, {
      title: "SD子B",
      parentId: summaryParent.id,
      startDate: "2026-08-15",
      endDate: "2026-08-20",
      sortOrder: 1,
    });
    const dragA = await createTask(db, authSession, dragProjectId, {
      title: "E2Eドラッグ元タスク",
      startDate: "2026-08-10",
      endDate: "2026-08-12",
    });
    const dragB = await createTask(db, authSession, dragProjectId, {
      title: "E2Eドラッグ先タスク",
      startDate: "2026-08-13",
      endDate: "2026-08-15",
    });
    await createDependency(db, authSession, dragProjectId, dragA.id, dragB.id);

    // 依存新規作成用: 依存の無い2タスク。
    const linkProject = await createProject(db, authSession, {
      name: `E2E Gantt依存作成確認 ${Date.now()}`,
    });
    linkProjectId = linkProject.id;
    await createTask(db, authSession, linkProjectId, {
      title: "E2E依存元候補",
      startDate: "2026-08-10",
      endDate: "2026-08-12",
    });
    await createTask(db, authSession, linkProjectId, {
      title: "E2E依存先候補",
      startDate: "2026-08-13",
      endDate: "2026-08-15",
    });
  } finally {
    client.close();
  }
});

test.beforeEach(async ({ context }) => {
  await addSessionCookies(context, session.cookies);
});

test("Gantt画面にタスクの階層とバーが表示される", async ({ page }) => {
  await page.goto(`/projects/${projectId}/gantt`);

  // SVAR Gantt はクライアント専用（ssr:false）のため、コンテナが描画されるまで待つ。
  const ganttContainer = page.locator(".wx-gantt");
  await expect(ganttContainer).toBeVisible();

  // 階層（親子とも）が WBS グリッドに表示されていること。
  // タスク名はチャート側のバー内ラベルにも重複して出るため（実機確認済み）、
  // グリッド領域（`.wx-grid`）に絞って探す。
  const grid = page.locator(".wx-grid");
  await expect(grid.getByText("E2E親タスク")).toBeVisible();
  await expect(grid.getByText("E2E子タスクA")).toBeVisible();
  await expect(grid.getByText("E2E子タスクB")).toBeVisible();

  // 親1件・子2件・ピン留め1件ぶんのバーが描画されていること（階層が展開されている）。
  await expect(page.locator(".wx-bar")).toHaveCount(4);
});

test("ピン留めされたタスクはタスク名の先頭に📌が表示される（M5 #30）", async ({ page }) => {
  await page.goto(`/projects/${projectId}/gantt`);
  await page.locator(".wx-gantt").waitFor();

  const grid = page.locator(".wx-grid");
  await expect(grid.getByText("📌 E2Eピン留めタスク")).toBeVisible();
  // ピン留めされていない通常タスクには付かないこと。
  await expect(grid.getByText("📌 E2E親タスク")).toHaveCount(0);
});

test("タスクが無いプロジェクトでも空状態が表示されエラーにならない", async ({ page }) => {
  await page.goto(`/projects/${emptyProjectId}/gantt`);
  await expect(page.getByText("タスクがまだ登録されていません。")).toBeVisible();
});

test("バーをドラッグすると依存する後続タスクも連動し、元に戻すで復元できる（M4）", async ({
  page,
}) => {
  await page.goto(`/projects/${dragProjectId}/gantt`);
  await page.locator(".wx-gantt").waitFor();

  const bars = page.locator(".wx-bar");
  await expect(bars).toHaveCount(2);

  const grid = page.locator(".wx-grid");
  await expect(grid.getByText("2026-08-10")).toBeVisible();
  await expect(grid.getByText("2026-08-13")).toBeVisible();

  const barA = bars.first();
  const box = await barA.boundingBox();
  if (!box) throw new Error("バーの座標が取得できません");

  // 右方向へ200px（実測で1日あたり100px、2日ぶん）ドラッグする。
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect(page.getByText(/件のタスクを移動しました/)).toBeVisible();

  // 依存元・依存先ともギャップ（1日）を維持したまま2日分シフトしていること。
  await expect(grid.getByText("2026-08-12")).toBeVisible();
  await expect(grid.getByText("2026-08-15")).toBeVisible();

  await page.getByRole("button", { name: "元に戻す" }).click();
  await expect(page.getByText("元に戻しました")).toBeVisible();

  // 元の日付に戻っていること。
  await expect(grid.getByText("2026-08-10")).toBeVisible();
  await expect(grid.getByText("2026-08-13")).toBeVisible();
});

test("依存の無いタスク同士をクリックで依存を新規作成できる（M4）", async ({ page }) => {
  await page.goto(`/projects/${linkProjectId}/gantt`);
  await page.locator(".wx-gantt").waitFor();

  const bars = page.locator(".wx-bar");
  await expect(bars).toHaveCount(2);
  await expect(page.locator("svg.wx-links .wx-line")).toHaveCount(0);
  // SVAR側のレイアウト計算（バーの最終位置確定）を待つ。
  await page.waitForTimeout(300);

  const source = bars.first();
  const target = bars.nth(1);

  // SVAR の依存作成インタラクションはドラッグではなく、終了側ハンドル→
  // 別バーの開始側ハンドルの順にクリックする2段階方式（実機確認済み）。
  // SVAR 側のクリック判定は `event.target.classList.contains("wx-link")` を
  // 直接見ており、ハンドル内側の `.wx-inner` 子要素がクリック位置の中心に
  // 重なっていると `event.target` がそちらになり判定を取りこぼす（実機確認済み）。
  // そのため Playwright の座標クリックではなく、ハンドル要素自身に直接
  // `click` イベントを発行する。
  async function clickLinkHandle(handle: import("@playwright/test").Locator) {
    await handle.evaluate((el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  await source.hover();
  await clickLinkHandle(source.locator(".wx-link.wx-right"));
  // 1回目のクリック（リンク開始点の選択）が SVAR 側の内部状態に反映されるのを待つ
  // （待たずに2回目をクリックすると開始点選択が成立せず、依存が作成されない
  // ことを実機で確認済み）。
  await page.waitForTimeout(200);
  await target.hover();
  await clickLinkHandle(target.locator(".wx-link.wx-left"));

  await expect(page.locator("svg.wx-links .wx-line")).toHaveCount(1);
});

/**
 * サマリーのバーはドラッグさせない（Issue #50）。
 *
 * SVAR はサマリー行のバー（`.wx-bar.wx-summary`）も通常どおりドラッグできてしまう。
 * 動かすと子が取り残されて日付が乖離し、あとで子を1日でも動かした瞬間に再集計が
 * 走って利用者が触っていない行が勝手に元へ戻る（実機で再現を確認した）。
 * サマリーの期間は子から導出するのが正（決定 D-11）なので、直接の操作を禁じる。
 */
test("サマリーのバーはドラッグしても動かず、理由が通知される（Issue #50）", async ({ page }) => {
  await page.goto(`/projects/${summaryProjectId}/gantt`);
  await page.locator(".wx-gantt").waitFor();

  const grid = page.locator(".wx-grid");
  const before = await grid.innerText();

  const summaryBar = page.locator(".wx-bar.wx-summary").first();
  const box = await summaryBar.boundingBox();
  if (!box) throw new Error("サマリーバーの座標が取得できません");
  const childBefore = (await page.locator(".wx-bar.wx-task").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();

  // 拒否の通知。`toBeVisible` の既定待ちだけだと、フル実行時に取りこぼすこと
  // （間欠的な失敗）を確認したため、明示的に長めの待ちを与える。
  await expect(page.getByText("サマリーの期間は子タスクから自動で決まります")).toBeVisible({
    timeout: 10_000,
  });

  // **バーの視覚位置も戻っていること。** `false` を返すだけでは SVAR が
  // ドラッグ中に書き換えた座標が残り、画面と DB が食い違う（実測で 100px ずれた）。
  // 一覧のテキストだけを見ていると見逃すため、座標そのものを確認する。
  // 位置の戻しは `api.exec` 経由の非同期な再描画なので、固定待ちではなくポーリングする。
  // サマリーをドラッグすると SVAR は子のバーも一緒に動かすので、子も戻すこと。
  await expect
    .poll(
      async () => {
        const s = await summaryBar.boundingBox();
        const c = await page.locator(".wx-bar.wx-task").first().boundingBox();
        return {
          summary: Math.round((s?.x ?? 0) - box.x),
          child: Math.round((c?.x ?? 0) - childBefore.x),
        };
      },
      { timeout: 10_000 },
    )
    .toEqual({ summary: 0, child: 0 });

  expect(await grid.innerText()).toBe(before);
});

test("通常タスクを動かすと、サマリーは子から再計算されて追従する（Issue #50）", async ({
  page,
}) => {
  await page.goto(`/projects/${summaryProjectId}/gantt`);
  await page.locator(".wx-gantt").waitFor();

  const grid = page.locator(".wx-grid");
  // 子A（08-10〜08-14）を1日ぶん右へ動かす
  const taskBar = page.locator(".wx-bar.wx-task").first();
  const box = await taskBar.boundingBox();
  if (!box) throw new Error("タスクバーの座標が取得できません");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect(page.getByText(/件のタスクを移動しました/)).toBeVisible();

  // 具体的な日付では固定しない。CI は `retries: 2` で同じ spec を再実行するため、
  // 1回目で動かした日付が残っていると2回目の期待値が構造的に成立しない。
  // 「サマリーの開始日が子の最小開始日と一致する」という不変条件で確認する。
  await expect
    .poll(
      async () => {
        const rows = (await grid.innerText()).split("\n").map((line) => line.trim());
        const summaryStart = rows[rows.indexOf("SD親サマリー") + 1];
        const childStart = rows[rows.indexOf("SD子A") + 1];
        return { summaryStart, childStart, moved: childStart !== "2026-08-10" };
      },
      { timeout: 10_000 },
    )
    .toEqual(expect.objectContaining({ moved: true }));

  const rows = (await grid.innerText()).split("\n").map((line) => line.trim());
  expect(rows[rows.indexOf("SD親サマリー") + 1]).toBe(rows[rows.indexOf("SD子A") + 1]);
});
