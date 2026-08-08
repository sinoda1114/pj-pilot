/**
 * タスクのインデント/アウトデント操作（WBS階層編集, M3 #19）。
 *
 * 決定 D-15: タスクの編集は全ログインユーザーに開いているため、
 * lib/tasks/service.ts / lib/tasks/deletion.ts と同じく owner チェックは行わない。
 *
 * 判定（直前の兄弟・祖父母の特定、sortOrder の算出）と書き込みを db.transaction() で
 * まとめているのは lib/tasks/deletion.ts と同じ理由。チェックと書き込みの間に
 * 別リクエストが割り込むと、TOCTOU 競合により算出した sortOrder が古くなったり、
 * 兄弟関係が変わってしまうことがあるため（セキュリティレビュー指摘のパターンを踏襲）。
 *
 * 循環参照について:
 * lib/tasks/service.ts の updateTask は「ユーザーが任意の parentId を指定できる」
 * ため isDescendantOf で循環をガードしている。一方 indent/outdent は新しい親を
 * ユーザー入力からではなく、常にツリー構造から機械的に決める。
 *   - indent: 新しい親は「タスクと同じ parentId を持つ、sortOrder が直前の兄弟」。
 *     兄弟は自分自身とは別の枝であり、正常なツリー（親は必ず子と異なるノード）である限り
 *     自分の子孫にはなり得ない。
 *   - outdent: 新しい親は「現在の親の parentId（祖父母）」、つまり自分の祖先。
 *     正常なツリーでは祖先が自分の子孫になることはない。
 * そのため、既存のツリーに循環が無い前提であれば、indent/outdent 自体が新たな
 * 循環を作ることは構造上あり得ず、isDescendantOf 相当の追加ガードは不要と判断した。
 */

import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { requireLogin } from "../auth/authz";
import type { AuthSession } from "../auth/types";
import { getActiveTask, listActiveTasksByParent, type Db } from "../db/queries";
import { tasks } from "../db/schema";
import type * as schema from "../db/schema";
import { NotFoundError, ValidationError } from "../errors";
import { markAsSummary, unmarkSummaryIfChildless } from "./summary-marker";

/**
 * 新しい親（`parentId`）の生存している子の中で最大の `sortOrder + 1` を返す
 * （子が居ない場合は 0）。indent/outdent 共通で「末尾に追加する」ために使う。
 */
async function nextSortOrderUnder(
  db: Db,
  projectId: string,
  parentId: string | null,
): Promise<number> {
  const children = await listActiveTasksByParent(db, projectId, parentId);
  const maxSortOrder = children.reduce((max, child) => Math.max(max, child.sortOrder), -1);
  return maxSortOrder + 1;
}

/**
 * タスクを「直前の兄弟タスクの子」にする（WBSのインデント操作）。
 * 直前の兄弟が存在しない（最初の子、または兄弟が居ない）場合は ValidationError。
 */
export async function indentTask(
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

    const siblings = await listActiveTasksByParent(tx, task.projectId, task.parentId);
    // 「直前の兄弟」= 自分より sortOrder が小さい兄弟のうち最大のもの。
    const precedingSibling = siblings
      .filter((sibling) => sibling.id !== task.id && sibling.sortOrder < task.sortOrder)
      .reduce<(typeof siblings)[number] | null>(
        (latest, sibling) =>
          latest === null || sibling.sortOrder > latest.sortOrder ? sibling : latest,
        null,
      );

    if (!precedingSibling) {
      throw new ValidationError("直前の兄弟タスクがないため、インデントできません");
    }

    const newSortOrder = await nextSortOrderUnder(tx, task.projectId, precedingSibling.id);

    await tx
      .update(tasks)
      .set({ parentId: precedingSibling.id, sortOrder: newSortOrder })
      .where(eq(tasks.id, taskId));

    await markAsSummary(tx, precedingSibling.id);
  });
}


/**
 * タスクを「現在の親と同じ階層（親の直後）」に上げる（WBSのアウトデント操作）。
 * 既にルート（親が居ない）タスクは ValidationError。
 */
export async function outdentTask(
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

    if (task.parentId === null) {
      throw new ValidationError("ルートタスクはこれ以上アウトデントできません");
    }

    const parent = await getActiveTask(tx, task.parentId);
    // 生存している子を持つ親は論理削除できない（lib/tasks/deletion.ts の deleteTask /
    // promoteChildrenAndDeleteTask）ため通常は必ず見つかるはずだが、
    // 万一データ不整合があった場合に備えて防御的に扱う。
    if (!parent) {
      throw new NotFoundError("親タスクが見つかりません");
    }

    const grandparentId = parent.parentId;
    const newSortOrder = await nextSortOrderUnder(tx, task.projectId, grandparentId);

    await tx
      .update(tasks)
      .set({ parentId: grandparentId, sortOrder: newSortOrder })
      .where(eq(tasks.id, taskId));

    // 元の親から最後の子が抜けたら summary の印を外す。
    await unmarkSummaryIfChildless(tx, parent.id);
    // 祖父母は子（この task）を持つようになったので印を付ける。ルート直下へ
    // 上がった場合（grandparentId が null）は対象なし。
    if (grandparentId) {
      await markAsSummary(tx, grandparentId);
    }
  });
}
