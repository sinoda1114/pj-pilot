/**
 * カンバンボードのビジネスロジック（Phase 2 §5.3 / M8 #40）。
 *
 * 並び替えの計算そのものは `lib/board/order.ts`（純粋関数）に置いてあり、
 * ここは「取得 → 純粋関数を適用 → 永続化」の層に徹する。数式を再実装しない。
 *
 * 決定 D-15 のとおり、タスクの編集は全ログインユーザーに開いているため
 * owner チェックは行わない（`lib/tasks/service.ts` と同じ）。
 */

import { and, eq, isNull } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { requireLogin } from "../auth/authz";
import type { AuthSession } from "../auth/types";
import { getActiveProject, listActiveBoardTasksByProject, type Db } from "../db/queries";
import { tasks } from "../db/schema";
import type * as schema from "../db/schema";
import { NotFoundError, ValidationError } from "../errors";
import { moveAcrossColumns, reorderWithinColumn } from "./order";

/** カンバンの列。既存の `tasks.status` をそのまま使う（決定 P2-01）。 */
export const BOARD_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export function isBoardStatus(value: unknown): value is BoardStatus {
  return typeof value === "string" && (BOARD_STATUSES as readonly string[]).includes(value);
}

export async function listBoardTasks(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  projectId: string,
) {
  requireLogin(session);

  const project = await getActiveProject(db, projectId);
  if (!project) {
    throw new NotFoundError("プロジェクトが見つかりません");
  }

  return listActiveBoardTasksByProject(db, projectId);
}

/**
 * カンバン上でタスクを `toStatus` 列の `toIndex` の位置へ移動する。
 *
 * 影響を受けた列のタスクに `board_order = 0..n-1` を振り直す（列の完全リインデックス。
 * 決定 P2-05）。読み取り（現在の列の並び）と書き込みは1つの `db.transaction()` に
 * まとめる。`lib/tasks/hierarchy.ts` と同じ TOCTOU 対策で、判定に使った並びが
 * 書き込みまでの間に別リクエストで変わるのを防ぐ。
 *
 * `lib/tasks/summary.ts` の再集計は**呼ばない**。サマリーが集計するのは
 * progress / estimatedHours / actualHours の3つで、`status` は集計対象外のため
 * （§5.5）。ここで呼ぶと無駄な書き込みが増えるだけになる。
 */
export async function moveTaskOnBoard(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  projectId: string,
  taskId: string,
  toStatus: BoardStatus,
  toIndex: number,
): Promise<void> {
  requireLogin(session);

  if (!isBoardStatus(toStatus)) {
    throw new ValidationError("ステータスの値が不正です");
  }
  if (!Number.isInteger(toIndex) || toIndex < 0) {
    throw new ValidationError("移動先の位置が不正です");
  }

  await db.transaction(async (tx) => {
    const task = await findBoardTask(tx, projectId, taskId);
    const fromStatus = task.status;

    // 移動対象になりうるのはボードに出ているタスクだけ。summary / milestone /
    // 論理削除済み / 他プロジェクトの行は、この一覧に入らないので board_order を
    // 書き換えられることもない。
    const boardTasks = await listActiveBoardTasksByProject(tx, projectId);
    const idsIn = (status: string) =>
      boardTasks.filter((row) => row.status === status).map((row) => row.id);

    if (fromStatus === toStatus) {
      const before = idsIn(fromStatus);
      const after = reorderWithinColumn(before, taskId, toIndex);
      await persistColumnOrder(tx, before, after, null);
      return;
    }

    const beforeFrom = idsIn(fromStatus);
    const beforeTo = idsIn(toStatus);
    const { from: afterFrom, to: afterTo } = moveAcrossColumns(
      beforeFrom,
      beforeTo,
      taskId,
      toIndex,
    );

    await persistColumnOrder(tx, beforeFrom, afterFrom, null);
    await persistColumnOrder(tx, beforeTo, afterTo, toStatus);
  });
}

/**
 * ボードの操作対象として妥当なタスクかを検証して返す。
 *
 * `projectId` との突き合わせを必ず行う。Server Action の引数はクライアントから
 * 任意の値を送れるため、他プロジェクトのタスクIDを送り込まれても動かせないようにする。
 */
async function findBoardTask(tx: Db, projectId: string, taskId: string) {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
    .limit(1);

  if (!task) {
    throw new NotFoundError("タスクが見つかりません");
  }
  if (task.type !== "task") {
    throw new ValidationError("サマリー・マイルストーンはボード上で移動できません");
  }

  return task;
}

/**
 * 列の並びを永続化する。`before` と `after` を突き合わせ、**実際に変化した行だけ**
 * UPDATE する（同じ値の書き込みで `updated_at` が無駄に進むのを防ぐ）。
 *
 * `status` に値を渡すと board_order と併せて status も更新する（列をまたぐ移動のとき）。
 */
async function persistColumnOrder(
  tx: Db,
  before: readonly string[],
  after: readonly string[],
  status: BoardStatus | null,
): Promise<void> {
  for (const [index, id] of after.entries()) {
    const movedWithinColumn = before[index] !== id;
    const changesStatus = status !== null && !before.includes(id);

    if (!movedWithinColumn && !changesStatus) {
      continue;
    }

    await tx
      .update(tasks)
      .set(status !== null && changesStatus ? { boardOrder: index, status } : { boardOrder: index })
      .where(eq(tasks.id, id));
  }
}
