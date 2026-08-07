import { defineConfig, devices } from "@playwright/test";
// `@next/env` はexportsフィールドを持たない純CJSパッケージで、named importの
// 静的検出（cjs-module-lexer）に失敗するため、default importからdestructureする。
import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

// Playwright のテストプロセス（`e2e/**/*.spec.ts`）は Next.js の子プロセスとは
// 別プロセスのため、`next start`（`webServer.command`）が自動で読む `.env.local`
// は Playwright 自身のプロセスには反映されない。`e2e/helpers/auth.ts` が
// `lib/auth.ts` と同じ `BETTER_AUTH_SECRET` 等でテスト用セッションを発行する
// 必要があるため、Next.js公式の `@next/env`（`.env.local` 等の優先順位込みの
// 読み込み処理）で明示的にロードする。`webServer.command` はデフォルトで
// 親プロセス（Playwright）の `process.env` を継承するため、ここでロードすれば
// 実サーバー側にも同じ値が伝わる。
loadEnvConfig(process.cwd());

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
