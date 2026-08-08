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
import {
  getActiveTask,
  getTaskById,
  listActiveChildren,
  listChildrenIncludingDeleted,
  type Db,
} from "../db/queries";
import { tasks } from "../db/schema";
import type * as schema from "../db/schema";
import { NotFoundError } from "../errors";
import { HasChildrenError } from "./errors";
import { markAsSummary, unmarkSummaryIfChildless } from "./summary-marker";

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

    await unmarkSummaryIfChildless(tx, task.parentId);
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

    await unmarkSummaryIfChildless(tx, task.parentId);
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

    // 子を繰り上げた先（祖父母）は子を持つようになったので印を付ける。
    // 繰り上げる子が居なければ、祖父母から最後の子（この task）が抜けた形になる。
    if (children.length > 0) {
      await markAsSummary(tx, task.parentId);
    } else {
      await unmarkSummaryIfChildless(tx, task.parentId);
    }
  });
}

/**
 * 削除済みタスクを復元する。上下の両方向へ広げる。
 *
 * - **祖先**: 削除済みならまとめて復元する（§4.4(a): 宙に浮いた子が生まれないため）。
 * - **子孫**: **同じ操作で消されたもの**だけ復元する（Issue #54）。
 *
 * 子孫を復元しないと、「子タスクごと削除」したあと親だけを復元したときに子孫が
 * ゴミ箱へ取り残され、利用者には復元できたように見えたまま 30 日後の cron
 * （`lib/tasks/purge.ts`）で静かに物理削除される。復元不能なデータ消失になる。
 *
 * 「同じ操作か」は `deleted_at` の一致で判定する。`deleteTaskSubtree` は単一の
 * `new Date()` を全行に入れるため、サブツリー削除で消えた行は完全に同じ値を持つ
 * （実測で確認）。別々のタイミングで消した子まで巻き込むと、利用者が意図して
 * ゴミ箱に残したものを勝手に復活させてしまうため、この絞り込みが要る。
 *
 * なお `deleted_at` は秒精度（`integer timestamp`）なので、同じ秒内に別々の削除を
 * 行った場合は区別できない。実害は「意図より1件多く戻る」程度で、データ消失より
 * ずっと軽いため許容する。
 *
 * 走査と復元をトランザクションでまとめ、走査中に他のリクエストが削除状態を
 * 変えても矛盾が生じないようにする（TOCTOU対策。セキュリティレビュー指摘）。
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

    // 親 ID を後段で引き直さずに済むよう、走査中に行そのものを覚えておく。
    const restoredById = new Map<string, { parentId: string | null }>([
      [taskId, { parentId: task.parentId }],
    ]);
    for (const ancestorId of idsToRestore.slice(1)) {
      const ancestor = await getTaskById(tx, ancestorId);
      restoredById.set(ancestorId, { parentId: ancestor?.parentId ?? null });
    }

    if (task.deletedAt !== null) {
      const descendants = await collectSameDeletionDescendantIds(tx, taskId, task.deletedAt);
      for (const { id, parentId } of descendants) {
        idsToRestore.push(id);
        restoredById.set(id, { parentId });
      }
    }

    await tx.update(tasks).set({ deletedAt: null }).where(inArray(tasks.id, idsToRestore));

    // 復元後の印を両方向で整える。
    //   - 復元した行の親は生存する子を持つようになるので印を付ける。怠ると
    //     「生存子を持つ type='task'」が再生産され、決定 D-11 の集計が黙って効かなくなる。
    //   - 復元した行自身は、子が付いてこない場合がある（`promoteChildrenAndDeleteTask`
    //     で子を繰り上げてから消したサマリーなど）。その場合は印を外さないと
    //     「子0件のサマリー」が復活する（実測で再現。/code-review の指摘）。
    //
    // 親 ID は走査済みなので `getTaskById` を引き直さず、重複を除いてから処理する
    // （200行のサブツリー復元で書き込みトランザクション内の往復が膨らむのを避ける）。
    const parentIds = new Set<string>();
    for (const id of idsToRestore) {
      const restored = restoredById.get(id);
      if (restored?.parentId) {
        parentIds.add(restored.parentId);
      }
    }
    for (const parentId of parentIds) {
      await markAsSummary(tx, parentId);
    }
    for (const id of idsToRestore) {
      await unmarkSummaryIfChildless(tx, id);
    }
  });
}

/**
 * `rootId` の子孫のうち、`deletedAt` が `deletedAt` と一致するものの id を返す
 * （`rootId` 自身は含まない）。
 *
 * 一致しない子（別のタイミングで消したもの）に達したらそこで枝を打ち切る。その先の
 * 子孫は「別々に消された枝」なので、まとめて戻す対象ではない。
 */
async function collectSameDeletionDescendantIds(
  db: Db,
  rootId: string,
  deletedAt: Date,
): Promise<{ id: string; parentId: string | null }[]> {
  const ids: { id: string; parentId: string | null }[] = [];
  const visited = new Set<string>([rootId]);
  const queue = [rootId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    for (const child of await listChildrenIncludingDeleted(db, current)) {
      // 循環した parent_id（本来は起こらない壊れたデータ）でも無限ループしない。
      if (visited.has(child.id)) {
        continue;
      }
      visited.add(child.id);
      if (child.deletedAt?.getTime() !== deletedAt.getTime()) {
        continue;
      }
      ids.push({ id: child.id, parentId: child.parentId });
      queue.push(child.id);
    }
  }

  return ids;
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
