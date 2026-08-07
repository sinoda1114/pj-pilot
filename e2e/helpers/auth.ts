/**
 * E2Eテスト用のログイン済みセッション作成ヘルパー（PR-B）。
 *
 * 実際のGoogle OAuthフローは経由せず、`better-auth/plugins`の`testUtils`
 * プラグインを使って直接ユーザー/セッションを作成し、発行されたCookieを
 * Playwrightのブラウザコンテキストへ注入する（公式に文書化された
 * E2Eテスト手法）。このテスト専用の `betterAuth` インスタンスは
 * `lib/auth.ts`（本番用）とは別に定義し、`testUtils` プラグインを本番設定に
 * 混ぜないようにする。
 *
 * ローカル実行時は `.env.local` が必要（`playwright.config.ts` で
 * `@next/env` によりロード済み）。実行中のNext.jsサーバーと同じ
 * `BETTER_AUTH_SECRET`/DBファイルを使わないと、発行したCookieがサーバー側で
 * 検証できない。
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { testUtils } from "better-auth/plugins";
import type { BrowserContext } from "@playwright/test";
import { createDb } from "../../lib/db/client";
import * as schema from "../../lib/db/schema/auth";

/**
 * テスト用ユーザーを作成し、ログイン済みCookieを発行する（ブラウザへの注入は行わない）。
 * `beforeAll`でテストデータを`service.ts`経由で用意してから、各テストの
 * `context`（`beforeAll`時点ではまだ存在しない）へ`addSessionCookies`で
 * 注入する2段階の構成にするためのもの。
 */
export async function createTestUser(overrides: { email: string; name: string }) {
  const { db, client } = createDb();
  try {
    const testAuth = betterAuth({
      database: drizzleAdapter(db, { provider: "sqlite", schema }),
      secret: process.env.BETTER_AUTH_SECRET,
      baseURL: process.env.BETTER_AUTH_URL,
      plugins: [testUtils()],
    });

    const ctx = await testAuth.$context;
    const test = ctx.test;
    if (!test) {
      throw new Error("testUtilsプラグインが有効になっていません");
    }

    const user = test.createUser({ email: overrides.email, name: overrides.name });
    const saved = await test.saveUser(user);
    const { cookies } = await test.login({ userId: saved.id });

    return { userId: saved.id, cookies };
  } finally {
    client.close();
  }
}

/** `createTestUser`が発行したCookieを、実際のテスト用`context`へ注入する。 */
export async function addSessionCookies(
  context: BrowserContext,
  cookies: Awaited<ReturnType<typeof createTestUser>>["cookies"],
): Promise<void> {
  await context.addCookies(
    cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure ?? false,
      sameSite: cookie.sameSite ?? "Lax",
    })),
  );
}

/**
 * テスト用ユーザーを作成し、ログイン済みのCookieを`context`へ注入する。
 * 返り値の`userId`は、既存の直接`service.ts`呼び出しでのテストデータ作成
 * （`createProject(db, { userId }, ...)`等）にそのまま使う。
 * 1テストにつき1回ログインすれば十分なファイル（`context`がbeforeAllより前に
 * 使えない構成が不要なケース）向け。beforeAllでテストデータを準備するファイルは
 * `createTestUser` + `addSessionCookies`を組み合わせて使う。
 */
export async function createLoggedInSession(
  context: BrowserContext,
  overrides: { email: string; name: string },
): Promise<{ userId: string }> {
  const { userId, cookies } = await createTestUser(overrides);
  await addSessionCookies(context, cookies);
  return { userId };
}
