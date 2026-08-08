import { expect, test } from "@playwright/test";
import { createDb, type DbHandle } from "../lib/db/client";
import { createProject } from "../lib/projects/service";
import { createTask } from "../lib/tasks/service";
import { addSessionCookies, createTestUser } from "./helpers/auth";

/**
 * ダッシュボードの e2e（Phase 2 M9 #51）。
 *
 * ダッシュボードは**全プロジェクト横断**なので、他のテストが作ったプロジェクトの
 * データも混ざる。そのため「全体の件数」ではなく、**このテストが作ったデータが
 * 正しく現れるか**を検証する（他テストの実行順に依存しないようにするため）。
 */

let session: Awaited<ReturnType<typeof createTestUser>>;
let handle: DbHandle;
let projectName: string;

test.beforeAll(async () => {
  session = await createTestUser({ email: "e2e-dashboard@example.com", name: "E2E Dashboard" });

  const resolvedUrl = process.env.TURSO_DATABASE_URL ?? "file:local.db";
  handle = createDb(resolvedUrl);

  // プロジェクト名に「ダッシュボード」を含めない。含めるとプロジェクト一覧の
  // リンク名と、ヘッダーの「ダッシュボード」リンクが同じ名前で衝突し、
  // ロケータが strict mode violation になる（実際に踏んだ）。
  projectName = `E2E 集計検証用 ${Date.now()}`;
  const project = await createProject(handle.db, { userId: session.userId }, { name: projectName });

  // 期限を大きく過ぎた未完了タスク（期限超過に出るはず）
  await createTask(handle.db, { userId: session.userId }, project.id, {
    title: "E2E期限超過タスク",
    startDate: "2020-01-01",
    endDate: "2020-01-05",
    status: "in_progress",
  });
  // 期限を過ぎているが完了済み（出ないはず）
  await createTask(handle.db, { userId: session.userId }, project.id, {
    title: "E2E完了済みで期限切れ",
    startDate: "2020-01-01",
    endDate: "2020-01-05",
    status: "done",
  });
  // 遠い未来（出ないはず）
  await createTask(handle.db, { userId: session.userId }, project.id, {
    title: "E2E未来タスク",
    startDate: "2099-01-01",
    endDate: "2099-12-31",
    status: "todo",
  });
});

test.afterAll(() => {
  handle.client.close();
});

test.beforeEach(async ({ context }) => {
  await addSessionCookies(context, session.cookies);
});

test("ヘッダーのリンクからダッシュボードへ遷移できる", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("link", { name: "ダッシュボード", exact: true }).click();

  await expect(page.getByRole("heading", { name: "ダッシュボード", level: 2 })).toBeVisible();
});

test("期限超過タスクが一覧に出る。完了済み・未来のタスクは出ない", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByTestId("overdue-section")).toBeVisible();

  const table = page.getByTestId("overdue-table");
  await expect(table.getByText("E2E期限超過タスク")).toBeVisible();

  // 完了済みと未来のタスクは期限超過ではない
  await expect(table.getByText("E2E完了済みで期限切れ")).toHaveCount(0);
  await expect(table.getByText("E2E未来タスク")).toHaveCount(0);
});

test("ステータス別タスク数とプロジェクト別進捗率が表示される", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { name: "ステータス別タスク数" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "プロジェクト別進捗率" })).toBeVisible();

  // このテストのプロジェクトは 3件中1件が完了 = 33%。グラフに項目が出ていること
  await expect(page.getByText(projectName, { exact: false }).first()).toBeVisible();
});

test("期限超過の基準日が日本時間で表示される", async ({ page }) => {
  await page.goto("/dashboard");

  // Vercel は UTC 稼働なので、素朴な実装だと JST 0〜9時にずれる（決定 P2-08）。
  // 画面に出している基準日が JST の今日と一致することを確認する。
  const todayInJst = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  await expect(page.getByText(`基準日: ${todayInJst}（日本時間）`)).toBeVisible();
});
