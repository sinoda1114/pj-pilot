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
import { getActiveTask, getTaskById, listActiveChildren, type Db } from "../db/queries";
import { tasks } from "../db/schema";
import type * as schema from "../db/schema";
import { NotFoundError } from "../errors";
import { HasChildrenError } from "./errors";

/**
 * 子を持たないタスクだけを対象とする単純な論理削除。
 * 子がいる場合は既定で拒否し（決定 D-02）、呼び出し側に
 * `deleteTaskSubtree` か `promoteChildrenAndDeleteTask` を選ばせる。
 *
 * 「子が居ないことの確認」と「削除」をトランザクションでまとめているのは、
 * 確認と書き込みの間に別リクエストが子タスクを作成すると、削除後に
 * 「アクティブな子を持つ削除済みタスク」という不変条件違反が起こり得るため
 * （lib/dependencies/service.ts の createDependency と同じ TOCTOU 対策。
 * セキュリティレビュー指摘）。
 */
export async function deleteTask(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
): Promise<void> {
  requireLogin(session);

  await db.transaction(async (tx) => {
    const task = await getActiveTask(tx, taskId);
    if (!task) {
      throw new NotFoundError("タスクが見つかりません");
    }

    const children = await listActiveChildren(tx, taskId);
    if (children.length > 0) {
      throw new HasChildrenError();
    }

    await tx.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, taskId));
  });
}

/**
 * サブツリーごと削除。タスク自身とその子孫全てに `deleted_at` を入れる（決定 D-02）。
 * 子孫の収集と削除をトランザクションでまとめ、収集後に増えた子孫が
 * 取りこぼされないようにする（TOCTOU対策。セキュリティレビュー指摘）。
 */
export async function deleteTaskSubtree(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
): Promise<void> {
  requireLogin(session);

  await db.transaction(async (tx) => {
    const task = await getActiveTask(tx, taskId);
    if (!task) {
      throw new NotFoundError("タスクが見つかりません");
    }

    const idsToDelete = await collectActiveDescendantIds(tx, taskId);

    await tx.update(tasks).set({ deletedAt: new Date() }).where(inArray(tasks.id, idsToDelete));
  });
}

/** 子を繰り上げて親だけ削除。子の `parent_id` を祖父に付け替える（決定 D-02）。 */
export async function promoteChildrenAndDeleteTask(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
): Promise<void> {
  requireLogin(session);

  // 子の一覧取得・繰り上げ・タスク自体の削除を1つのトランザクションにまとめる。
  // 分けて書くと、取得後に増えた子が繰り上げ対象から漏れたり、繰り上げと削除の
  // 片方だけが成功する中途半端な状態が起こり得るため（TOCTOU対策。セキュリティレビュー指摘）。
  await db.transaction(async (tx) => {
    const task = await getActiveTask(tx, taskId);
    if (!task) {
      throw new NotFoundError("タスクが見つかりません");
    }

    const children = await listActiveChildren(tx, taskId);

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
 * 祖先チェーンの走査と復元をトランザクションでまとめ、走査中に他のリクエストが
 * 祖先の削除状態を変えても矛盾が生じないようにする（TOCTOU対策。セキュリティレビュー指摘）。
 */
export async function restoreTask(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
): Promise<void> {
  requireLogin(session);

  await db.transaction(async (tx) => {
    const task = await getTaskById(tx, taskId);
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
      const ancestor = await getTaskById(tx, ancestorId);
      if (!ancestor) {
        break;
      }
      if (ancestor.deletedAt !== null) {
        idsToRestore.push(ancestor.id);
      }
      ancestorId = ancestor.parentId;
    }

    await tx.update(tasks).set({ deletedAt: null }).where(inArray(tasks.id, idsToRestore));
  });
}

async function collectActiveDescendantIds(db: Db, rootId: string): Promise<string[]> {
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
