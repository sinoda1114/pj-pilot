/**
 * 認可ヘルパ（M1 #11 / docs/IMPLEMENTATION_PLAN.md §6「認可の考え方」）。
 *
 * 防御線は 2 段だけ（決定 D-07 / D-08 / D-15）。
 *   1. requireLogin    — ログインできているか（閲覧は全ログインユーザーに開く）
 *   2. requireProjectOwner — 破壊的操作（PJ 削除等）を role='owner' のみに絞る
 *
 * 「読めるかどうか」の判定は存在しない。全ルート・全 Server Action の先頭で
 * このどちらかを必ず通すことで、認可漏れの余地を減らす設計。
 */

import { and, eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { projectMembers } from "../db/schema";
import type * as schema from "../db/schema";
import { ForbiddenError, UnauthorizedError } from "./errors";
import type { AuthSession } from "./types";

/**
 * ログイン済みであることを確認する。`session` は呼び出し側が
 * （将来的には Better Auth のセッション取得結果から）渡す。
 */
export function requireLogin(session: AuthSession | null): AuthSession {
  if (!session) {
    throw new UnauthorizedError();
  }
  return session;
}

/**
 * 指定した PJ の role='owner' メンバーであることを確認する。
 * メンバーでない、または role が 'owner' でなければ ForbiddenError を投げる。
 *
 * `projects.deletedAt`（論理削除）は見ない。削除済み PJ に対する復元・完全削除等の
 * 操作を owner に許すかどうかは呼び出し側（該当 Server Action）の責務とする
 * （Devin レビュー指摘。M2 以降、実際の呼び出し箇所ができた時点で判断する）。
 */
export async function requireProjectOwner(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession,
  projectId: string,
): Promise<void> {
  const [membership] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, session.userId)))
    .limit(1);

  if (!membership || membership.role !== "owner") {
    throw new ForbiddenError();
  }
}
