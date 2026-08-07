import { test, expect } from "@playwright/test";
import { createDb } from "../lib/db/client";
import type { AuthSession } from "../lib/auth/types";
import { createProject } from "../lib/projects/service";

/**
 * プロジェクト設定画面（M5 #29）: 依存連動トグルの表示・切り替え・永続化を検証する。
 * Better Auth 未導入のため、テストデータの作成はservice層を直接呼び出す
 * （e2e/gantt.spec.ts 等と同じ方針）。
 */
const session: AuthSession = { userId: "e2e-settings-user" };

let projectId: string;

test.beforeAll(async () => {
  const { db, client } = createDb();
  try {
    const project = await createProject(db, session, {
      name: `E2E設定画面確認 ${Date.now()}`,
    });
    projectId = project.id;
  } finally {
    client.close();
  }
});

test("依存連動トグルの初期状態はONで、OFFに切り替えるとリロード後も反映される", async ({ page }) => {
  await page.goto(`/projects/${projectId}/settings`);

  const toggle = page.getByRole("switch", { name: "依存連動" });
  await expect(toggle).toBeChecked();

  await toggle.click();
  await expect(page.getByText("依存連動をOFFにしました")).toBeVisible();
  await expect(toggle).not.toBeChecked();

  await page.reload();
  await expect(page.getByRole("switch", { name: "依存連動" })).not.toBeChecked();
});
