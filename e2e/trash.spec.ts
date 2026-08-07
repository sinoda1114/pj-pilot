import { test, expect } from "@playwright/test";
import { createDb } from "../lib/db/client";
import { createProject } from "../lib/projects/service";
import { createTask } from "../lib/tasks/service";
import { deleteTask } from "../lib/tasks/deletion";

const SESSION = { userId: "e2e-trash-user" };

test.describe("ゴミ箱画面（M1 #9c）", () => {
  test("削除済みタスクが一覧に表示され、復元ボタンで一覧から消える", async ({ page }) => {
    const { db, client } = createDb();
    const uniqueTitle = `E2E復元対象タスク-${Date.now()}`;

    let projectId: string;
    try {
      const project = await createProject(db, SESSION, {
        name: `E2Eゴミ箱テスト-${Date.now()}`,
      });
      projectId = project.id;

      const task = await createTask(db, SESSION, project.id, {
        title: uniqueTitle,
        startDate: "2026-08-01",
        endDate: "2026-08-05",
      });

      await deleteTask(db, SESSION, task.id);
    } finally {
      client.close();
    }

    await page.goto(`/projects/${projectId}/trash`);

    const row = page.getByRole("row", { name: new RegExp(uniqueTitle) });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "復元" }).click();

    await expect(page.getByText(uniqueTitle)).not.toBeVisible();
  });
});
