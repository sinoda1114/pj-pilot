"use server";

/**
 * 開発用ユーザー切り替えの Server Action。`lib/auth/session.ts` の
 * 暫定セッション実装とセットで、Better Auth 導入時に削除する。
 */
import { cookies } from "next/headers";
import { DEV_SESSION_COOKIE, DEV_USERS } from "./dev-users";

export async function setDevUser(userId: string): Promise<void> {
  if (!DEV_USERS.some((u) => u.userId === userId)) {
    throw new Error(`不明な開発用ユーザーです: ${userId}`);
  }
  const store = await cookies();
  store.set(DEV_SESSION_COOKIE, userId, { path: "/", sameSite: "lax" });
}
