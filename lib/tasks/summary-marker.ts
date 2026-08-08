/**
 * 「子を持つタスクに `type='summary'` の印を付ける／外す」処理（Issue #51）。
 *
 * 決定 D-11（親タスクの日付・進捗・工数は子から自動集計）の集計側
 * （`lib/tasks/summary.ts` / `lib/scheduling/propagate.ts`）は `type === "summary"` の
 * 祖先しか処理しない。にもかかわらず、その型を設定する本番経路が存在せず
 * （`scripts/seed.ts` のみ）、決定が実データに対して一度も機能していなかった。
 *
 * 印の付け外しは**親子関係が変わるすべての経路**で行う必要がある。1箇所でも漏れると
 * 「生存する子を持つ `task`」（集計されない）や「子が0件の `summary`」（カンバンにも
 * ダッシュボードにも出ず、Gantt でもドラッグできない行き止まり）が生まれるため、
 * 各所で書き直さず、この2関数を共有する。
 *
 * 呼び出し元:
 *   - `lib/tasks/hierarchy.ts`: indent / outdent
 *   - `lib/tasks/deletion.ts`: 削除3経路 / 復元
 */

import { eq } from "drizzle-orm";
import { getActiveTask, listActiveChildren, type Db } from "../db/queries";
import { tasks } from "../db/schema";

/**
 * 子を持つようになったタスクに `type='summary'` の印を付ける。
 *
 * `milestone` は書き換えない。決定 D-12 で Phase 1 の UI には出さないが値としては
 * 許容されており、意図して設定された種別を階層操作の副作用で潰さないため。
 */
export async function markAsSummary(db: Db, taskId: string | null): Promise<void> {
  if (!taskId) {
    return;
  }
  const target = await getActiveTask(db, taskId);
  if (!target || target.type !== "task") {
    return;
  }
  await db.update(tasks).set({ type: "summary" }).where(eq(tasks.id, taskId));
}

/**
 * 生存している子が居なくなったサマリーを `task` に戻す。
 *
 * 戻さないと「子が1件も無いのにサマリー」という行が残る。その状態では
 * カンバン・ダッシュボード（`type='task'` で絞る）から消え、Gantt ではドラッグも
 * 拒否され（Issue #50）、再集計も子0件でスキップされるため、利用者からは
 * 手の出しようがなくなる。
 */
export async function unmarkSummaryIfChildless(db: Db, taskId: string | null): Promise<void> {
  if (!taskId) {
    return;
  }
  const target = await getActiveTask(db, taskId);
  if (!target || target.type !== "summary") {
    return;
  }
  const children = await listActiveChildren(db, taskId);
  if (children.length > 0) {
    return;
  }
  await db.update(tasks).set({ type: "task" }).where(eq(tasks.id, taskId));
}
