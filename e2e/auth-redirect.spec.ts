import { expect, test } from "@playwright/test";

/**
 * 未ログイン時の入り口の足切り（`proxy.ts`）の e2e。
 *
 * 認証まわりは「データが漏れないこと」だけでなく「ログイン画面へ導かれること」も
 * 要件のうち。ページ側の `requireLogin` は例外を投げるだけなので、そこに落ちると
 * 利用者にはログイン導線ではなく汎用エラー画面が出てしまう（実際に `/dashboard` が
 * proxy の matcher から漏れていてこの状態だった）。
 *
 * 新しいトップレベルのルートを足したら、このファイルの `PROTECTED_PATHS` にも
 * 追加すること。ここが増えないまま画面だけ増えると、同じ漏れが静かに再発する。
 */

/** ログインが要る画面。`proxy.ts` の `config.matcher` と対応させる。 */
const PROTECTED_PATHS = [
  "/projects",
  "/projects/does-not-exist/tasks",
  "/projects/does-not-exist/board",
  "/projects/does-not-exist/gantt",
  "/dashboard",
];

// Cookie を注入しない（他のスペックと違い `addSessionCookies` を呼ばない）ことで
// 未ログイン状態を作る。`test.use` で明示し、ブラウザ状態の持ち越しも断つ。
test.use({ storageState: { cookies: [], origins: [] } });

for (const path of PROTECTED_PATHS) {
  test(`未ログインで ${path} を開くとログイン画面へ飛ばされる`, async ({ page }) => {
    await page.goto(path);

    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole("button", { name: "Googleでログイン" })).toBeVisible();
  });
}

test("ログイン画面自体は未ログインでも開ける（リダイレクトのループにならない）", async ({
  page,
}) => {
  await page.goto("/sign-in");

  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("button", { name: "Googleでログイン" })).toBeVisible();
});
