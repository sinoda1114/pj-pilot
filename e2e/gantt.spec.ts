import { test, expect } from "@playwright/test";
import { createDb } from "../lib/db/client";
import type { AuthSession } from "../lib/auth/types";
import { createDependency } from "../lib/dependencies/service";
import { createProject } from "../lib/projects/service";
import { createTask } from "../lib/tasks/service";

/**
 * Gantt 画面の E2E（M3 #20 / M4 ドラッグ連動）。既存タスクの階層・日付・依存線の
 * 表示に加え、ドラッグでの移動→依存連動→Undo、依存の新規作成を検証する。
 *
 * Better Auth 未導入（`lib/auth/session.ts` 参照）のため、テストデータの作成は
 * 実際のログインフローを経由せず、service 層を直接呼び出して用意する。
 */
const session: AuthSession = { userId: "e2e-gantt-user" };

let projectId: string;
let emptyProjectId: string;
let dragProjectId: string;
let linkProjectId: string;

// 2 つのテストが同じファイル DB（`file:local.db`、webServer が起動する唯一の
// Next.js に紐づく）へ並行して書き込むと `SQLITE_BUSY: database is locked` が
// 非決定的に発生する（実機確認済み）ため、データ作成は 1 つの `beforeAll` に
// まとめて 1 コネクションで直列に行い、テスト自体も `serial` で実行する
// （`playwright.config.ts` で `workers: 1` に固定済みだが、念のためファイル内でも直列化する）。
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const { db, client } = createDb();
  try {
    const project = await createProject(db, session, {
      name: `E2E Gantt表示確認 ${Date.now()}`,
    });
    projectId = project.id;

    const parent = await createTask(db, session, projectId, {
      title: "E2E親タスク",
      type: "summary",
      startDate: "2026-08-10",
      endDate: "2026-08-20",
    });

    await createTask(db, session, projectId, {
      title: "E2E子タスクA",
      parentId: parent.id,
      startDate: "2026-08-10",
      endDate: "2026-08-14",
      sortOrder: 0,
    });

    await createTask(db, session, projectId, {
      title: "E2E子タスクB",
      parentId: parent.id,
      startDate: "2026-08-15",
      endDate: "2026-08-20",
      sortOrder: 1,
    });

    const empty = await createProject(db, session, {
      name: `E2E Gantt空状態確認 ${Date.now()}`,
    });
    emptyProjectId = empty.id;

    // ドラッグ連動用: A→Bの依存を持つ2タスク。
    const dragProject = await createProject(db, session, {
      name: `E2E Ganttドラッグ連動確認 ${Date.now()}`,
    });
    dragProjectId = dragProject.id;
    const dragA = await createTask(db, session, dragProjectId, {
      title: "E2Eドラッグ元タスク",
      startDate: "2026-08-10",
      endDate: "2026-08-12",
    });
    const dragB = await createTask(db, session, dragProjectId, {
      title: "E2Eドラッグ先タスク",
      startDate: "2026-08-13",
      endDate: "2026-08-15",
    });
    await createDependency(db, session, dragProjectId, dragA.id, dragB.id);

    // 依存新規作成用: 依存の無い2タスク。
    const linkProject = await createProject(db, session, {
      name: `E2E Gantt依存作成確認 ${Date.now()}`,
    });
    linkProjectId = linkProject.id;
    await createTask(db, session, linkProjectId, {
      title: "E2E依存元候補",
      startDate: "2026-08-10",
      endDate: "2026-08-12",
    });
    await createTask(db, session, linkProjectId, {
      title: "E2E依存先候補",
      startDate: "2026-08-13",
      endDate: "2026-08-15",
    });
  } finally {
    client.close();
  }
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

  // 親1件・子2件ぶんのバーが描画されていること（階層が展開されている）。
  await expect(page.locator(".wx-bar")).toHaveCount(3);
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
