import { expect, test } from "@playwright/test";
import { createDb, type DbHandle } from "../lib/db/client";
import { createProject } from "../lib/projects/service";

/**
 * タスク CRUD 画面の e2e（M2 #14〜#17）。
 *
 * テスト用のプロジェクトはシード（`npm run db:seed`）に依存せず、
 * `lib/projects/service.ts` の `createProject` をテストのセットアップから直接呼んで
 * 用意する。webServer（`npm run build && npm run start`）が使うのと同じ DB ファイルを
 * 同じ URL 解決ロジック（`TURSO_DATABASE_URL` が無ければ `file:local.db`）で直接開く。
 */

const SESSION = { userId: "e2e-tester" };

let handle: DbHandle;
let projectId: string;

test.beforeAll(async () => {
  const resolvedUrl = process.env.TURSO_DATABASE_URL ?? "file:local.db";
  handle = createDb(resolvedUrl);

  const project = await createProject(handle.db, SESSION, {
    name: `E2E タスクCRUD検証用 ${Date.now()}`,
  });
  projectId = project.id;
});

test.afterAll(() => {
  handle.client.close();
});

test("タスクを新規作成→一覧に表示→Drawerで編集→保存が反映される", async ({ page }) => {
  await page.goto(`/projects/${projectId}/tasks`);
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();

  // --- 新規作成 ---
  await page.getByRole("button", { name: "新規タスク作成" }).click();

  const createDialog = page.getByRole("dialog");
  await expect(createDialog.getByRole("heading", { name: "新規タスク作成" })).toBeVisible();

  const taskTitle = `E2Eテストタスク ${Date.now()}`;
  await createDialog.getByLabel("タイトル").fill(taskTitle);
  await createDialog.getByLabel("担当者").fill("e2e-assignee");
  await createDialog.getByLabel("担当者").press("Enter");
  await createDialog.getByRole("button", { name: "保存" }).click();

  // 保存成功で Drawer が閉じ、一覧に反映される。
  await expect(createDialog).toBeHidden();
  await expect(page.getByText(taskTitle, { exact: true })).toBeVisible();
  await expect(page.getByText("e2e-assignee", { exact: true })).toBeVisible();

  // --- 編集 ---
  await page.getByText(taskTitle, { exact: true }).click();

  const editDialog = page.getByRole("dialog");
  await expect(editDialog.getByRole("heading", { name: "タスク詳細" })).toBeVisible();

  const updatedTitle = `${taskTitle}（更新済み）`;
  await editDialog.getByLabel("タイトル").fill(updatedTitle);
  await editDialog.getByLabel("ステータス").click();
  await page.getByRole("option", { name: "対応中" }).click();
  await editDialog.getByRole("button", { name: "保存" }).click();

  await expect(editDialog).toBeHidden();
  const updatedRow = page.locator("tr", { hasText: updatedTitle });
  await expect(updatedRow).toBeVisible();
  await expect(updatedRow).toContainText("対応中");
});

test("子タスクを持つタスクは削除方法の選択を求められる", async ({ page }) => {
  const session = SESSION;
  const parent = await createTaskForTest(session, "親タスク");
  await createTaskForTest(session, "子タスク", parent.id);

  await page.goto(`/projects/${projectId}/tasks`);
  await page.getByText("親タスク", { exact: true }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "削除" }).click();

  await expect(dialog.getByText("子タスクが存在します")).toBeVisible();
  await dialog.getByRole("button", { name: "子タスクごと削除" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText("親タスク", { exact: true })).toHaveCount(0);
});

async function createTaskForTest(session: { userId: string }, title: string, parentId?: string) {
  const { createTask } = await import("../lib/tasks/service");
  return createTask(handle.db, session, projectId, {
    title,
    startDate: "2026-08-10",
    endDate: "2026-08-11",
    parentId,
  });
}
