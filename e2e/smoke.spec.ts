import { test, expect } from "@playwright/test";

test("トップページはプロジェクト一覧へリダイレクトされる", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText("pj-pilot", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "プロジェクト一覧" })).toBeVisible();
  await expect(page.getByRole("button", { name: "プロジェクトを作成" })).toBeVisible();
});
