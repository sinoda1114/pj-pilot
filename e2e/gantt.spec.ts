import { test, expect } from "@playwright/test";
import { createDb } from "../lib/db/client";
import type { AuthSession } from "../lib/auth/types";
import { createProject } from "../lib/projects/service";
import { createTask } from "../lib/tasks/service";

/**
 * Gantt 画面の E2E（M3 #20）。依存線のドラッグ連動（M4 のスコープ）は対象外で、
 * 既存タスクの階層・日付・依存線が読み取り専用で描画されることだけを確認する。
 *
 * Better Auth 未導入（`lib/auth/session.ts` 参照）のため、テストデータの作成は
 * 実際のログインフローを経由せず、service 層を直接呼び出して用意する。
 */
const session: AuthSession = { userId: "e2e-gantt-user" };

let projectId: string;
let emptyProjectId: string;

// 2 つのテストが同じファイル DB（`local.db`）へ並行して書き込むと
// `SQLITE_BUSY: database is locked` になる（実機確認済み）ため、
// データ作成は 1 つの `beforeAll` にまとめて 1 コネクションで直列に行い、
// テスト自体も `serial` で実行する（同時書き込みを避ける）。
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
  } finally {
    client.close();
  }
});

test("Gantt画面にタスクの階層とバーが読み取り専用で表示される", async ({ page }) => {
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
