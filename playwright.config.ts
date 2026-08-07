import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // 全スペックファイルが `file:local.db`（webServer が起動する1つの Next.js に
  // 紐づく唯一の SQLite ファイル）を共有しているため、複数ワーカーで並列実行すると
  // `SQLITE_BUSY: database is locked` が非決定的に発生する（M2〜M3のPRが増え、
  // 複数スペックが同時に書き込むようになって実機で再現）。ワーカーを1つに固定し、
  // スペック間の書き込みを直列化する。
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // このサンドボックスにはビルド番号が固定の Chromium が事前インストールされている
        // （PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers）。@playwright/test のバージョンが
        // 期待するビルドとズレることがあるため、ダウンロードさせず直接指定する。
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : undefined,
      },
    },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
