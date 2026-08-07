/**
 * Better Auth サーバー側インスタンス（決定 D-04）。Google OAuth のみを有効にし、
 * 決定 D-07（許可ドメイン制限）を `databaseHooks.user.create.before` で強制する。
 *
 * このフックは、そのメールアドレスに対応する `user` レコードが初めて作られる
 * （＝初回サインアップの）タイミングにのみ発火し、既存ユーザーの再ログインでは
 * 発火しない。`ALLOWED_EMAIL_DOMAINS` を後から狭めた場合に既存ユーザーを弾く
 * ことはこのフックだけではできないため、`lib/auth/session.ts` 側でも
 * 毎回のセッション取得時にドメインを再チェックする（多層防御）。
 *
 * `plugins: [nextCookies()]` は公式のNext.js統合ドキュメントが推奨する設定
 * （Server Action からの呼び出しでも Cookie が正しく設定されるようにする）。
 * プラグイン配列の最後に置く必要がある。
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { APIError } from "better-auth/api";
import { db } from "./db";
import * as schema from "./db/schema";
import { isAllowedEmailDomain } from "./auth/domain-restriction";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  baseURL: process.env.BETTER_AUTH_URL,
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!isAllowedEmailDomain(user.email, process.env.ALLOWED_EMAIL_DOMAINS)) {
            throw new APIError("BAD_REQUEST", { message: "許可されていないメールドメインです" });
          }
          return { data: user };
        },
      },
    },
  },
  plugins: [nextCookies()],
});
