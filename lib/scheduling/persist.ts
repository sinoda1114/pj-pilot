/**
 * `propagate.ts`（`moveTask`/`resizeTaskEnd`）が返す `PropagateResult` を
 * DBへ書き込む。伝播ロジック自体はDB非依存の純粋関数のため、書き込みは
 * この層に分離する。
 */

import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { tasks } from "../db/schema";
import type * as schema from "../db/schema";
import type { PropagateResult } from "./types";

export async function persistPropagateResult(
  db: LibSQLDatabase<typeof schema>,
  result: PropagateResult,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const change of result.changes) {
      await tx
        .update(tasks)
        .set({ startDate: change.after.startDate, endDate: change.after.endDate })
        .where(eq(tasks.id, change.id));
    }

    for (const summary of result.summaryUpdates) {
      await tx
        .update(tasks)
        .set({
          progress: summary.progress,
          estimatedHours: summary.estimatedHours,
          actualHours: summary.actualHours,
        })
        .where(eq(tasks.id, summary.id));
    }
  });
}
