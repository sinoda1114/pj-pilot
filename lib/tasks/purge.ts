/**
 * ゴミ箱の物理削除ロジック（M1 #9c / docs/IMPLEMENTATION_PLAN.md §4.4(a)(b)、決定 D-05）。
 *
 * Vercel Cron（`app/api/cron/purge-trash/route.ts`）から日次で呼ばれる想定。
 * ルートは認証（`CRON_SECRET`）だけを担い、削除そのものはこの純粋な関数に閉じ込める
 * （テストしやすさと、認証層と削除ロジックの責務分離のため）。
 *
 * §4.4(b) が明示するとおり、Turso（HTTP接続）は外部キー制約の
 * ON DELETE CASCADE に頼れない。そのため関連行の削除を
 * `task_assignees` → `task_dependencies` → `tasks` → `projects`
 * の順にアプリケーション層で明示的に行い、`db.batch()`（libsql 上は暗黙の
 * トランザクション）で1回の原子的な操作として順序を固定する。
 *
 * プロジェクト自体が30日超前に論理削除されている場合、そのプロジェクト自体が
 * 画面上から隠れているため、配下タスクは個別に `deleted_at` が入っているかを問わず
 * まとめて物理削除する（そうしないと、PJ を削除しても配下タスクだけがいつまでも
 * 残り続け、孤児化する）。
 *
 * TOCTOU 対策: 「対象を SELECT で確定 → ID配列で DELETE」という2段階にすると、
 * その間に対象タスクが復元される（`deleted_at` が NULL に戻る）と、復元直後の
 * タスクを物理削除してしまう競合が起こり得る。それを避けるため、各 DELETE の
 * `WHERE` 句には事前計算した ID 配列ではなく条件式（サブクエリ）自体を持たせ、
 * `db.batch()` という単一のトランザクション内で対象を確定させながら削除する
 * （`lib/tasks/deletion.ts` が個々の操作を `db.transaction()` でまとめているのと
 * 同じ考え方）。件数も削除前の別 SELECT ではなく `.returning()` で実際に削除された
 * 行から数える。
 */

import { and, inArray, isNotNull, lt, or, type SQL } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { projectMembers, projects, taskAssignees, taskDependencies, tasks } from "../db/schema";
import type * as schema from "../db/schema";

/** ゴミ箱の保持期間（決定 D-05）。 */
const TRASH_RETENTION_DAYS = 30;

export interface PurgeTrashResult {
  /** 物理削除したプロジェクト数（30日超前に論理削除されていたもの）。 */
  purgedProjectCount: number;
  /** 物理削除したタスク数（上記プロジェクト配下 + 個別に30日超前に削除されたタスク）。 */
  purgedTaskCount: number;
  /** 上記タスクに紐づいていた `task_assignees` の行数。 */
  purgedAssigneeCount: number;
  /** 上記タスクに紐づいていた `task_dependencies` の行数。 */
  purgedDependencyCount: number;
  /** 物理削除したプロジェクトに紐づいていた `project_members` の行数。 */
  purgedMemberCount: number;
}

/** `now` から見て「30日超前」の境界時刻を返す。`deleted_at < cutoff` が物理削除の対象。 */
export function trashCutoffDate(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - TRASH_RETENTION_DAYS);
  return cutoff;
}

/**
 * 30日超前に論理削除されたプロジェクト・タスクを物理削除する。
 *
 * `db` には `LibSQLDatabase`（`batch()` を持つ）を要求する。`lib/db/queries.ts` の
 * 共通型 `Db`（`BaseSQLiteDatabase`）は `transaction` のコールバック引数と互換にするため
 * `batch` を持たない設計になっており、ここでは使えない。
 */
export async function purgeExpiredTrash(
  db: LibSQLDatabase<typeof schema>,
  now: Date = new Date(),
): Promise<PurgeTrashResult> {
  const cutoff = trashCutoffDate(now);

  const isExpiredProject = and(isNotNull(projects.deletedAt), lt(projects.deletedAt, cutoff)) as SQL;
  const expiredProjectIds = db.select({ id: projects.id }).from(projects).where(isExpiredProject);

  // 「個別に30日超前に削除された」タスク、または「30日超前に削除されたプロジェクト配下」の
  // タスク（個別の deleted_at の有無を問わない）のどちらかが物理削除の対象。
  const isTaskToPurge = or(
    and(isNotNull(tasks.deletedAt), lt(tasks.deletedAt, cutoff)),
    inArray(tasks.projectId, expiredProjectIds),
  ) as SQL;
  const taskIdsToPurge = db.select({ id: tasks.id }).from(tasks).where(isTaskToPurge);

  // 5文とも常に発行する。`db.batch()` の型が空配列を許さない非空タプルを要求するため
  // 分岐で組み立てる必要があった旧実装と異なり、条件式は「マッチ0件」でも有効な SQL なので
  // 分岐が不要になっている。projects を最後に削除するのは、それより前の文の中の
  // `expiredProjectIds` サブクエリがまだ削除されていない projects 行を参照するため。
  // project_members も同じ理由で projects より前に削除する必要がある
  // （`/security-review` 指摘: 元実装は project_members を消しておらず、
  // プロジェクト削除のたびに孤児が積み上がっていた）。
  const [deletedAssignees, deletedDependencies, deletedTasks, deletedMembers, deletedProjects] =
    await db.batch([
      db
        .delete(taskAssignees)
        .where(inArray(taskAssignees.taskId, taskIdsToPurge))
        .returning({ taskId: taskAssignees.taskId }),
      db
        .delete(taskDependencies)
        .where(
          or(
            inArray(taskDependencies.predecessorId, taskIdsToPurge),
            inArray(taskDependencies.successorId, taskIdsToPurge),
          ),
        )
        .returning({ id: taskDependencies.id }),
      db.delete(tasks).where(isTaskToPurge).returning({ id: tasks.id }),
      db
        .delete(projectMembers)
        .where(inArray(projectMembers.projectId, expiredProjectIds))
        .returning({ userId: projectMembers.userId }),
      db.delete(projects).where(isExpiredProject).returning({ id: projects.id }),
    ]);

  return {
    purgedProjectCount: deletedProjects.length,
    purgedTaskCount: deletedTasks.length,
    purgedAssigneeCount: deletedAssignees.length,
    purgedDependencyCount: deletedDependencies.length,
    purgedMemberCount: deletedMembers.length,
  };
}
