/**
 * Better Auth 本実装までの暫定セッション取得層（M2 UI 着手にあたり導入）。
 *
 * Better Auth は未修正の Critical 脆弱性があるため導入を保留している
 * （`lib/auth/types.ts` 参照）。一方で各ドメインの service.ts 側は
 * `session: AuthSession | null` を受け取る形で実装済みのため、UI 側の
 * Server Actions / Server Components が呼び出すセッション取得口だけを
 * 先に用意する。Cookie に入れた開発用ユーザーIDをそのまま `AuthSession` として
 * 返すだけで、実際の認証（ログイン可否の判定）は行わない。
 *
 * Better Auth 導入後は本ファイルの実装だけを
 * `auth.api.getSession({ headers: await headers() })` の結果を
 * `AuthSession` に詰め替える形に差し替える想定。呼び出し側
 * （`getSession()` のシグネチャ）は変えない。
 */
import { cookies } from "next/headers";
import { DEV_SESSION_COOKIE, DEV_USERS } from "./dev-users";
import type { AuthSession } from "./types";

const DEFAULT_DEV_USER_ID = DEV_USERS[0].userId;

/**
 * 現在のセッションを返す。Cookie が無ければ既定の開発用ユーザーを返す
 * （Better Auth 導入前は「常にログイン済み」の状態になる）。
 */
export async function getSession(): Promise<AuthSession | null> {
  const store = await cookies();
  const userId = store.get(DEV_SESSION_COOKIE)?.value ?? DEFAULT_DEV_USER_ID;
  return { userId };
}
