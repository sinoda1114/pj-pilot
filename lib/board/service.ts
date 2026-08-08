/**
 * カンバンボードのビジネスロジック（Phase 2 §5.3 / M8 #40）。
 *
 * 並び替えの計算そのものは `lib/board/order.ts`（純粋関数）に置いてあり、
 * ここは「取得 → 純粋関数を適用 → 永続化」の層に徹する。数式を再実装しない。
 *
 * 決定 D-15 のとおり、タスクの編集は全ログインユーザーに開いているため
 * owner チェックは行わない（`lib/tasks/service.ts` と同じ）。
 */

import { and, eq, isNull, type InferSelectModel } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { requireLogin } from "../auth/authz";
import type { AuthSession } from "../auth/types";
import { getActiveProject, listActiveBoardTasksByProject, type Db } from "../db/queries";
import { tasks } from "../db/schema";
import type * as schema from "../db/schema";
import { NotFoundError, ValidationError } from "../errors";
import { moveAcrossColumns, reorderWithinColumn } from "./order";

/** スキーマが定めるタスクのステータス。カンバンの列定義がこれと一致することを型で保証する。 */
type TaskStatus = InferSelectModel<typeof tasks>["status"];

/** カンバンの列。既存の `tasks.status` をそのまま使う（決定 P2-01）。左から並ぶ順。 */
export const BOARD_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

/**
 * 列の左からの位置。`Record<スキーマの status, number>` にしてあるため、
 * `tasks.status` の enum に値が増えたら**ここがコンパイルエラーになり**、
 * 列の追加漏れにビルド時点で気付ける。
 *
 * 実行時に「不正な status なら null」と握りつぶす形は採らない。`tasks.status` は
 * Drizzle 側で 4 つのリテラル union に絞られており（`"bogus"` を代入すると型エラーに
 * なることを確認済み）、DB にも `tasks_status_check` の CHECK 制約がある。
 * 二重に守られている値を実行時に再チェックしても、将来 enum が増えたときに
 * 「静かに列から消える」だけで、むしろ発見が遅れる。
 */
export const BOARD_COLUMN_ORDER: Record<TaskStatus, number> = {
  todo: 0,
  in_progress: 1,
  review: 2,
  done: 3,
};

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
    // PJ の生存を確認する。`findBoardTask` は `tasks.project_id` しか見ないため、
    // これが無いと owner が論理削除した PJ（`deleteProject` は配下タスクに触れない）の
    // カードを誰でも動かし続けられる。他の Server Action と条件を揃える。
    const project = await getActiveProject(tx, projectId);
    if (!project) {
      throw new NotFoundError("プロジェクトが見つかりません");
    }

    const task = await findBoardTask(tx, projectId, taskId);
    const fromStatus = task.status;

    // 移動対象になりうるのはボードに出ているタスクだけ。summary / milestone /
    // 論理削除済み / 他プロジェクトの行は、この一覧に入らないので board_order を
    // 書き換えられることもない。
    const boardTasks = await listActiveBoardTasksByProject(tx, projectId);
    const idsIn = (status: string) =>
      boardTasks.filter((row) => row.status === status).map((row) => row.id);
    // 「実際に変化した行だけ UPDATE する」判定に使う現在値のスナップショット。
    const current = new Map<string, CurrentRow>(
      boardTasks.map((row) => [row.id, { boardOrder: row.boardOrder, status: row.status }]),
    );

    if (fromStatus === toStatus) {
      const after = reorderWithinColumn(idsIn(fromStatus), taskId, toIndex);
      await persistColumnOrder(tx, current, after, null);
      return;
    }

    const { from: afterFrom, to: afterTo } = moveAcrossColumns(
      idsIn(fromStatus),
      idsIn(toStatus),
      taskId,
      toIndex,
    );

    await persistColumnOrder(tx, current, afterFrom, null);
    await persistColumnOrder(tx, current, afterTo, toStatus);
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

/** `persistColumnOrder` が「この行は書き換えが要るか」を判断するための現在値。 */
type CurrentRow = { boardOrder: number; status: string };

/**
 * 列の並びを永続化する。`after` の**添字がそのまま新しい `board_order`** になる
 * （完全リインデックス方式。決定 P2-05）。
 *
 * 書き換えの要否は **DB に入っている実際の `board_order` / `status` と突き合わせて**
 * 判断する。同じ値の UPDATE を避けて `updated_at` が無駄に進まないようにするためだが、
 * 「並び順の配列と添字を比べる」方式にしてはいけない。それは
 * **DB が既に 0..n-1 に正規化されている**ことを暗黙の前提にしており、次のように
 * 前提が崩れるとリインデックスが中途半端に終わって並びが壊れるため（Issue #55）。
 *
 *   - `createTask` は `board_order` を採番しないので、画面から作ったタスクは全て 0
 *   - 削除しても残りの列は詰め直されず、復元時にも再計算されない（重複・欠番）
 *   - Drawer でステータスを変えると、移動元列での値をそのまま移動先へ持ち込む
 *
 * 実測では、全て 0 の列で2番目の位置へドラッグすると、画面は `B,C,A,D` を見せるのに
 * 保存後は `B,A,D,C` になり、掴んだカードが列の末尾へ飛んでいた。
 * 現在値と比較する方式なら、そうした壊れた状態も次の操作で 0..n-1 に自己修復する。
 */
async function persistColumnOrder(
  tx: Db,
  current: ReadonlyMap<string, CurrentRow>,
  after: readonly string[],
  status: BoardStatus | null,
): Promise<void> {
  for (const [index, id] of after.entries()) {
    const row = current.get(id);
    const needsOrder = row === undefined || row.boardOrder !== index;
    const needsStatus = status !== null && row?.status !== status;

    if (!needsOrder && !needsStatus) {
      continue;
    }

    await tx
      .update(tasks)
      .set(needsStatus ? { boardOrder: index, status } : { boardOrder: index })
      .where(eq(tasks.id, id));
  }
}
