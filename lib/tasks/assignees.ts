/**
 * タスクへの複数担当者の割り当て（M2 #17 のうち UI に依存しない部分）。
 *
 * `MultiSelect` は「選択済み一覧」を確定値として onChange するのが自然なため、
 * 個別の assign/unassign ではなく `setTaskAssignees` で希望する担当者一覧を
 * まるごと置き換える API にしてある。
 *
 * userId には認証テーブル追加まで FK 制約が無い（lib/db/schema/app.ts 参照）ため、
 * ここでも実在チェックはしない。
 */

import { and, eq, inArray } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { requireLogin } from "../auth/authz";
import type { AuthSession } from "../auth/types";
import { getActiveTask } from "../db/queries";
import { taskAssignees } from "../db/schema";
import type * as schema from "../db/schema";
import { NotFoundError } from "../errors";

export async function listTaskAssignees(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
) {
  requireLogin(session);

  const task = await getActiveTask(db, taskId);
  if (!task) {
    throw new NotFoundError("タスクが見つかりません");
  }

  return db.select().from(taskAssignees).where(eq(taskAssignees.taskId, taskId));
}

/** 指定した `userIds` を唯一の担当者一覧にする（無い分は追加、余分は削除）。 */
export async function setTaskAssignees(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
  userIds: string[],
): Promise<void> {
  requireLogin(session);

  const task = await getActiveTask(db, taskId);
  if (!task) {
    throw new NotFoundError("タスクが見つかりません");
  }

  // 重複した userId が渡されても実質的な担当者一覧は変わらないため、正規化しておく。
  const desiredSet = new Set(userIds);

  await db.transaction(async (tx) => {
    const current = await tx.select().from(taskAssignees).where(eq(taskAssignees.taskId, taskId));
    const currentUserIds = new Set(current.map((row) => row.userId));

    // 差分を JS 側で計算してから delete/insert する。`inArray`/`notInArray` に
    // 空配列を渡した場合の SQL 生成に依存しないため、境界条件を考えずに済む。
    const toRemove = current.map((row) => row.userId).filter((userId) => !desiredSet.has(userId));
    const toInsert = [...desiredSet].filter((userId) => !currentUserIds.has(userId));

    if (toRemove.length > 0) {
      await tx
        .delete(taskAssignees)
        .where(and(eq(taskAssignees.taskId, taskId), inArray(taskAssignees.userId, toRemove)));
    }
    if (toInsert.length > 0) {
      await tx.insert(taskAssignees).values(toInsert.map((userId) => ({ taskId, userId })));
    }
  });
}
