import { test, expect } from "@playwright/test";
import { createDb } from "../lib/db/client";
import { createProject } from "../lib/projects/service";
import { addSessionCookies, createTestUser } from "./helpers/auth";

/**
 * プロジェクト設定画面（M5 #29）: 依存連動トグルの表示・切り替え・永続化を検証する。
 * テストデータの作成はservice層を直接呼び出す（e2e/gantt.spec.ts 等と同じ方針）が、
 * 呼び出しに使う`userId`は`testUtils`で実際に作成したBetter Authユーザーのものを使う
 * （各ページの`requireLogin`が実セッションを要求するため）。
 */
let session: Awaited<ReturnType<typeof createTestUser>>;
let projectId: string;

test.beforeAll(async () => {
  session = await createTestUser({
    email: "e2e-settings@example.com",
    name: "E2E Settings",
  });

  const { db, client } = createDb();
  try {
    const project = await createProject(db, { userId: session.userId }, {
      name: `E2E設定画面確認 ${Date.now()}`,
    });
    projectId = project.id;
  } finally {
    client.close();
  }
});

test.beforeEach(async ({ context }) => {
  await addSessionCookies(context, session.cookies);
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
