/**
 * サマリータスクの progress/estimatedHours/actualHours を、子タスクの生存状態から
 * 再集計して DB に永続化する（M3 #22 / 決定 D-11）。
 *
 * 集計の数式そのものは lib/scheduling/propagate.ts の `aggregateSummaryValues`
 * （ドラッグ操作による伝播でも使われる）を再利用する。ここではその関数を
 * 「DB 行 → ScheduleTask 相当の最小形」に変換し、祖先チェーンを辿って
 * 永続化する薄い変換層だけを持つ。数式自体を再実装しない。
 *
 * この関数は内部ヘルパーとして設計してあり、requireLogin 等の認可チェックは行わない
 * （lib/tasks/deletion.ts の collectActiveDescendantIds と同じ位置づけ。
 * 呼び出し元の createTask/updateTask/deleteTask が既にログイン確認済みであることが前提）。
 */

import { eq } from "drizzle-orm";
import { aggregateSummaryValues } from "../scheduling/propagate";
import { getTaskById, listActiveChildren, type Db } from "../db/queries";
import { tasks } from "../db/schema";

/**
 * `taskId` の祖先を `parentId` チェーンで辿り、`type = 'summary'` の祖先それぞれについて、
 * 生存している直接の子から progress/estimatedHours/actualHours を再集計して書き戻す。
 *
 * 本番での呼び出し元は `app/projects/[id]/gantt/actions.ts` の `undoDateChangesAction`
 * （「元に戻す」）**のみ**。タスクの作成・更新・削除（`lib/tasks/service.ts` /
 * `lib/tasks/deletion.ts`）からは呼ばれていないため、Drawer で子の工数や進捗を変えても
 * 親 summary は再集計されない。これは決定 D-11 に対する未接続であり、Issue #51 の
 * 後半（「タスクはどうやって summary になるのか」）と併せて扱う。
 *
 * - 子に近い祖先から順に処理する（親summaryの再集計結果を、祖父summaryの集計に使えるようにするため）。
 * - 循環した `parent_id`（本来は起こらないはずの壊れたデータ）でも無限ループしないよう、
 *   訪問済みノードで打ち切る（lib/tasks/deletion.ts の restoreTask / lib/scheduling/propagate.ts と同じ方針）。
 * - 読み取り（祖先チェーンの走査・子の一覧取得）と書き込み（集計結果の更新）は
 *   1つの db.transaction() にまとめる（TOCTOU対策。lib/tasks/deletion.ts と同じパターン）。
 * - `type` が summary でない祖先は書き換えない。
 * - 論理削除済みの祖先は書き換えない（通常のカスケード削除の下では生存子を持つ削除済み
 *   summary は存在しないはずだが、防御的ガードとして持つ。§4.4(c) の多層防御と同じ方針）。
 * - 子を持たない（または生存している子がいない）summary は、既存値をそのまま残す
 *   （lib/scheduling/propagate.ts の recomputeAncestorSummaries と同じ挙動）。
 */
export async function recomputeAndPersistAncestorSummaries(
  db: Db,
  taskId: string,
): Promise<void> {
  type TaskRow = NonNullable<Awaited<ReturnType<typeof getTaskById>>>;

  await db.transaction(async (tx) => {
    const start = await getTaskById(tx, taskId);
    if (!start) {
      // 呼び出し元で既に削除されている等。祖先を辿りようがないので何もしない。
      return;
    }

    // parentId チェーンを taskId に近い順（=深い順）に集める。
    // この順序でそのまま処理すれば、祖父summaryの集計時には
    // 直前に更新した親summaryの最新値を DB から読み直せる。
    // 走査中に取得した行はそのまま使い回し、同じ行を2回フェッチしない
    // （祖先が深いほど本番の Turso HTTP 接続でラウンドトリップが倍になるのを避けるため）。
    const ancestorIds: string[] = [];
    const ancestorsById = new Map<string, TaskRow>();
    const visited = new Set<string>([taskId]);
    let parentId = start.parentId;

    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = await getTaskById(tx, parentId);
      if (!parent) {
        break;
      }
      ancestorIds.push(parentId);
      ancestorsById.set(parentId, parent);
      parentId = parent.parentId;
    }

    for (const ancestorId of ancestorIds) {
      const ancestor = ancestorsById.get(ancestorId);
      if (!ancestor || ancestor.type !== "summary" || ancestor.deletedAt !== null) {
        continue;
      }

      const children = await listActiveChildren(tx, ancestorId);
      if (children.length === 0) {
        continue;
      }

      const { progress, estimatedHours, actualHours } = aggregateSummaryValues(children);

      await tx
        .update(tasks)
        .set({ progress, estimatedHours, actualHours })
        .where(eq(tasks.id, ancestorId));
    }
  });
}
