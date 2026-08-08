/**
 * `propagate.ts`（`moveTask`/`resizeTaskEnd`）が返す `PropagateResult` を
 * DBへ書き込む。伝播ロジック自体はDB非依存の純粋関数のため、書き込みは
 * この層に分離する。
 */

import { and, eq, isNull } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { tasks } from "../db/schema";
import type * as schema from "../db/schema";
import type { PropagateResult } from "./types";

/**
 * 書き込みは常に「生存しているタスク」に限る。
 *
 * 呼び出し元（`runPropagation` の `target.deletedAt` チェック、`propagateToSuccessors`
 * の deleted スキップ、`undoDateChangesAction` の削除済み除外）が既に塞いでいるが、
 * §4.4(c) の多層防御としてはここが最後の1枚。実際、祖先サマリーの再集計に
 * 生存チェックが無かったときは、この UPDATE を通ってゴミ箱の中の行の日付が
 * 書き換わっていた（監査で実測）。
 */
export async function persistPropagateResult(
  db: LibSQLDatabase<typeof schema>,
  result: PropagateResult,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const change of result.changes) {
      await tx
        .update(tasks)
        .set({ startDate: change.after.startDate, endDate: change.after.endDate })
        .where(and(eq(tasks.id, change.id), isNull(tasks.deletedAt)));
    }

    for (const summary of result.summaryUpdates) {
      await tx
        .update(tasks)
        .set({
          progress: summary.progress,
          estimatedHours: summary.estimatedHours,
          actualHours: summary.actualHours,
        })
        .where(and(eq(tasks.id, summary.id), isNull(tasks.deletedAt)));
    }
  });
}
