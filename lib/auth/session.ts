/**
 * セッション取得層。Better Auth のセッション取得結果を `AuthSession` に
 * 詰め替えて返す。呼び出し側（`getSession()` のシグネチャ）は変えない
 * （以前の暫定実装からの移行時に約束していた契約）。
 *
 * `auth.api.getSession()` は1リクエスト中に複数回呼ばれうる
 * （`getSession()` 経由と `app/layout.tsx` の表示用取得の両方から）ため、
 * React の `cache()` でラップしてDBへの重複アクセスを避ける。
 *
 * ドメイン制限（決定D-07）は `lib/auth.ts` の `databaseHooks.user.create.before`
 * で新規アカウント作成時にチェック済みだが、それだけでは
 * `ALLOWED_EMAIL_DOMAINS` を後から狭めた場合に既存アカウントの再ログインを
 * 弾けない。ここでも毎回のセッション取得時にドメインを再チェックすることで、
 * 「ドメイン制限が実質唯一の防御線」（リスクR-10）という前提に対して
 * 多層防御にする。
 */
import { cache } from "react";
import { headers } from "next/headers";
import { auth } from "../auth";
import { isAllowedEmailDomain } from "./domain-restriction";
import type { AuthSession } from "./types";

/**
 * Better Auth の生セッション（`session`/`user` を含む）を返す。表示用に
 * 実ユーザー名/emailが必要な箇所（`app/layout.tsx`）はこちらを直接使う。
 */
export const getFullSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

/** 現在のセッションを返す。ドメイン制限を満たさなければ未ログイン扱い（null）。 */
export async function getSession(): Promise<AuthSession | null> {
  const fullSession = await getFullSession();
  if (!fullSession) {
    return null;
  }
  if (!isAllowedEmailDomain(fullSession.user.email, process.env.ALLOWED_EMAIL_DOMAINS)) {
    return null;
  }
  return { userId: fullSession.user.id };
}
