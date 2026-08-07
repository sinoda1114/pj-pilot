import { test, expect } from "@playwright/test";
import { createLoggedInSession } from "./helpers/auth";

/**
 * M2 #13: プロジェクトの作成 → 一覧表示 → 編集 → 削除の一連のフローを検証する。
 *
 * 同一 DB を使う他のテストと並行実行されても衝突しないよう、プロジェクト名は
 * テストごとに一意な値（タイムスタンプ + ランダム値）にする。
 * カード内の「編集」「削除」ボタンは `data-testid` に project.id を含めて
 * 一意化してあるため、一覧リンクの href から id を取り出して対象を絞り込む。
 */
test("プロジェクトの作成・編集・削除が一気通貫で行える", async ({ page, context }) => {
  await createLoggedInSession(context, {
    email: "e2e-project-crud@example.com",
    name: "E2E Project CRUD",
  });

  const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const createdName = `E2Eテストプロジェクト ${uniqueSuffix}`;
  const renamedName = `E2Eテストプロジェクト（編集後） ${uniqueSuffix}`;

  await page.goto("/projects");

  // --- 作成 ---
  await page.getByRole("button", { name: "プロジェクトを作成" }).click();
  const createModal = page.getByRole("dialog", { name: "プロジェクトを作成" });
  await createModal.getByLabel("プロジェクト名").fill(createdName);
  await createModal.getByLabel("説明").fill("E2Eテストで作成したプロジェクトです");
  await createModal.getByRole("button", { name: "作成" }).click();

  await expect(page.getByText("作成しました", { exact: true })).toBeVisible();
  const createdLink = page.getByRole("link", { name: createdName });
  await expect(createdLink).toBeVisible();

  const href = await createdLink.getAttribute("href");
  expect(href).toBeTruthy();
  const projectId = href?.match(/\/projects\/([^/]+)\/tasks/)?.[1];
  expect(projectId).toBeTruthy();

  // --- 編集 ---
  await page.getByTestId(`edit-project-${projectId}`).click();
  const editModal = page.getByRole("dialog", { name: "プロジェクトを編集" });
  const nameInput = editModal.getByLabel("プロジェクト名");
  await expect(nameInput).toHaveValue(createdName);
  await nameInput.fill(renamedName);
  await editModal.getByRole("button", { name: "保存" }).click();

  await expect(page.getByText("更新しました", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: renamedName })).toBeVisible();
  await expect(page.getByRole("link", { name: createdName, exact: true })).toHaveCount(0);

  // --- 削除 ---
  await page.getByTestId(`delete-project-${projectId}`).click();
  const confirmModal = page.getByRole("dialog", { name: "プロジェクトを削除しますか？" });
  await confirmModal.getByRole("button", { name: "削除する" }).click();

  await expect(page.getByText("削除しました", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: renamedName })).toHaveCount(0);
});
