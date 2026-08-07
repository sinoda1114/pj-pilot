/**
 * 生存レコード（`deleted_at IS NULL`）のみを返す問い合わせを集約する（§3.2 / §4.4(c)）。
 *
 * 論理削除の最大の事故は「絞り込みの書き忘れで削除済みが表示・伝播対象に入る」こと。
 * 画面や Server Action・service 層は素の `db.select()` をここ以外に書かず、必ずこのファイルを通す。
 */

import type { ResultSet } from "@libsql/client";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { projects, taskDependencies, tasks } from "./schema";
import type * as schema from "./schema";

/**
 * `LibSQLDatabase<typeof schema>` ではなくこの共通の基底型を使うのは、
 * `db.transaction(async (tx) => ...)` のコールバック引数 `tx` の型が
 * `LibSQLDatabase` ではなく `SQLiteTransaction`（`batch` を持たない）になるため。
 * ここで使うクエリはどちらの型にも共通する部分だけなので、両方から呼べるようにする。
 */
export type Db = BaseSQLiteDatabase<"async", ResultSet, typeof schema>;

export async function listActiveProjects(db: Db) {
  return db.select().from(projects).where(isNull(projects.deletedAt));
}

export async function getActiveProject(db: Db, projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);

  return project;
}

export async function getActiveTask(db: Db, taskId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    .limit(1);

  return task;
}

/** 復元時の祖先チェーン走査（§4.4(a)）では削除済みの行も見る必要があるため、生存フィルタをかけない。 */
export async function getTaskById(db: Db, taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

  return task;
}

export async function listActiveChildren(db: Db, parentId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.parentId, parentId), isNull(tasks.deletedAt)));
}

/**
 * 指定したプロジェクト内で、指定した `parentId` を持つ生存タスクを返す。
 * `listActiveChildren` と異なり `parentId` に `null` を渡すとルート直下
 * （`parent_id IS NULL`）の生存タスクを返す（SQL の `parent_id = NULL` は
 * 常に false になるため isNull で分岐する）。
 *
 * `projectId` を必須にしているのは、`parentId = null`（ルート直下）のケースだと
 * `parent_id` だけでは他プロジェクトのルートタスクと区別できないため。
 * これを付け忘れると、あるプロジェクトのルートタスクをインデントしたときに
 * 別プロジェクトのルートタスクが「直前の兄弟」として誤って選ばれ、
 * プロジェクトをまたいだ親子関係が生まれてしまう（レビューで発見・修正）。
 * indent/outdent（`lib/tasks/hierarchy.ts`）で「兄弟の特定」と
 * 「新しい親の子一覧取得」の両方に使う汎用ヘルパー。
 */
export async function listActiveTasksByParent(db: Db, projectId: string, parentId: string | null) {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        parentId === null ? isNull(tasks.parentId) : eq(tasks.parentId, parentId),
        isNull(tasks.deletedAt),
      ),
    );
}

export async function listActiveTasksByProject(db: Db, projectId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
}

/**
 * 依存連動の伝播（`lib/scheduling/propagate.ts`）用。生存/削除済みを問わず
 * プロジェクトの全タスクを返す。伝播ロジックは「削除済みタスクに到達したら
 * 枝を打ち切り、その理由をトーストで通知する」（決定D-06 / §5.4）ため、
 * 削除済みタスクも `isDeleted: true` として伝播対象のグラフに含めておく
 * 必要がある。生存タスクだけを渡すと、削除済みタスクがグラフから単に
 * 存在しなくなるだけで、`skipped` に理由付きで記録できなくなる。
 */
export async function listAllTasksByProject(db: Db, projectId: string) {
  return db.select().from(tasks).where(eq(tasks.projectId, projectId));
}

/**
 * `task_dependencies` に `deleted_at` は無い（決定 D-06: タスク削除時も依存レコード自体は残す）。
 * そのため生存フィルタは不要で、単純にプロジェクト単位で全件返す。
 */
export async function listDependenciesByProject(db: Db, projectId: string) {
  return db.select().from(taskDependencies).where(eq(taskDependencies.projectId, projectId));
}

/**
 * ゴミ箱画面（M1 #9c）用。指定したプロジェクトの論理削除済み（`deleted_at IS NOT NULL`）
 * タスクのみを返す。生存タスクのみを返す他のヘルパーとは逆に、ここでは意図的に
 * 削除済みのものだけを絞り込む（§3.2 の「絞り込みの書き忘れ防止」の考え方を、
 * ゴミ箱という「削除済みだけを見せたい」画面にもそのまま適用する）。
 */
export async function listDeletedTasksByProject(db: Db, projectId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNotNull(tasks.deletedAt)));
}
