/**
 * タスクの論理削除・復元ロジック（M1 #9b / §4.4(a) / 決定 D-02）。
 *
 * 決定 D-15: タスクの編集・削除は全ログインユーザーに開いている（PJ削除のような
 * owner 限定ではない）ため、ここでは requireLogin のみを通す。
 */

import { eq, inArray } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { requireLogin } from "../auth/authz";
import type { AuthSession } from "../auth/types";
import { getActiveTask, getTaskById, listActiveChildren } from "../db/queries";
import { tasks } from "../db/schema";
import type * as schema from "../db/schema";
import { NotFoundError } from "../errors";
import { HasChildrenError } from "./errors";

/**
 * 子を持たないタスクだけを対象とする単純な論理削除。
 * 子がいる場合は既定で拒否し（決定 D-02）、呼び出し側に
 * `deleteTaskSubtree` か `promoteChildrenAndDeleteTask` を選ばせる。
 */
export async function deleteTask(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
): Promise<void> {
  requireLogin(session);

  const task = await getActiveTask(db, taskId);
  if (!task) {
    throw new NotFoundError("タスクが見つかりません");
  }

  const children = await listActiveChildren(db, taskId);
  if (children.length > 0) {
    throw new HasChildrenError();
  }

  await db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, taskId));
}

/** サブツリーごと削除。タスク自身とその子孫全てに `deleted_at` を入れる（決定 D-02）。 */
export async function deleteTaskSubtree(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
): Promise<void> {
  requireLogin(session);

  const task = await getActiveTask(db, taskId);
  if (!task) {
    throw new NotFoundError("タスクが見つかりません");
  }

  const idsToDelete = await collectActiveDescendantIds(db, taskId);

  // 単一の UPDATE ... WHERE IN なのでトランザクションでの明示的な保護は不要。
  await db.update(tasks).set({ deletedAt: new Date() }).where(inArray(tasks.id, idsToDelete));
}

/** 子を繰り上げて親だけ削除。子の `parent_id` を祖父に付け替える（決定 D-02）。 */
export async function promoteChildrenAndDeleteTask(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
): Promise<void> {
  requireLogin(session);

  const task = await getActiveTask(db, taskId);
  if (!task) {
    throw new NotFoundError("タスクが見つかりません");
  }

  const children = await listActiveChildren(db, taskId);

  // 子の繰り上げとタスク自体の削除は分けて書くと、片方だけ成功した場合に
  // 中途半端な状態（親が消えたのに子が繰り上がっていない等）が残るため、
  // createProject と同じ理由でトランザクションにまとめる。
  await db.transaction(async (tx) => {
    if (children.length > 0) {
      await tx
        .update(tasks)
        .set({ parentId: task.parentId })
        .where(
          inArray(
            tasks.id,
            children.map((child) => child.id),
          ),
        );
    }
    await tx.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, taskId));
  });
}

/**
 * 削除済みタスクを復元する。祖先が削除済みならまとめて復元する
 * （§4.4(a): 宙に浮いた子が生まれないため）。
 */
export async function restoreTask(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
): Promise<void> {
  requireLogin(session);

  const task = await getTaskById(db, taskId);
  if (!task) {
    throw new NotFoundError("タスクが見つかりません");
  }

  const idsToRestore = [taskId];
  const visited = new Set<string>([taskId]);
  let ancestorId = task.parentId;

  // 循環した parent_id（本来は起こらないはずの壊れたデータ）でも無限ループしないよう
  // visited で防御する（lib/scheduling/propagate.ts と同じ方針）。
  while (ancestorId && !visited.has(ancestorId)) {
    visited.add(ancestorId);
    const ancestor = await getTaskById(db, ancestorId);
    if (!ancestor) {
      break;
    }
    if (ancestor.deletedAt !== null) {
      idsToRestore.push(ancestor.id);
    }
    ancestorId = ancestor.parentId;
  }

  await db.update(tasks).set({ deletedAt: null }).where(inArray(tasks.id, idsToRestore));
}

async function collectActiveDescendantIds(
  db: LibSQLDatabase<typeof schema>,
  rootId: string,
): Promise<string[]> {
  const ids = [rootId];
  const visited = new Set<string>([rootId]);
  const queue = [rootId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const children = await listActiveChildren(db, current);
    for (const child of children) {
      if (visited.has(child.id)) {
        continue;
      }
      visited.add(child.id);
      ids.push(child.id);
      queue.push(child.id);
    }
  }

  return ids;
}
