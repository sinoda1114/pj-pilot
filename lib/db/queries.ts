/**
 * 生存レコード（`deleted_at IS NULL`）のみを返す問い合わせを集約する（§3.2 / §4.4(c)）。
 *
 * 論理削除の最大の事故は「絞り込みの書き忘れで削除済みが表示・伝播対象に入る」こと。
 * 画面や Server Action・service 層は素の `db.select()` をここ以外に書かず、必ずこのファイルを通す。
 */

import type { ResultSet } from "@libsql/client";
import { and, eq, isNull } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { projects, taskDependencies, tasks } from "./schema";
import type * as schema from "./schema";

/**
 * `LibSQLDatabase<typeof schema>` ではなくこの共通の基底型を使うのは、
 * `db.transaction(async (tx) => ...)` のコールバック引数 `tx` の型が
 * `LibSQLDatabase` ではなく `SQLiteTransaction`（`batch` を持たない）になるため。
 * ここで使うクエリはどちらの型にも共通する部分だけなので、両方から呼べるようにする。
 */
type Db = BaseSQLiteDatabase<"async", ResultSet, typeof schema>;

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
  return db.select().from(tasks).where(and(eq(tasks.parentId, parentId), isNull(tasks.deletedAt)));
}

export async function listActiveTasksByProject(db: Db, projectId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
}

/**
 * `task_dependencies` に `deleted_at` は無い（決定 D-06: タスク削除時も依存レコード自体は残す）。
 * そのため生存フィルタは不要で、単純にプロジェクト単位で全件返す。
 */
export async function listDependenciesByProject(db: Db, projectId: string) {
  return db.select().from(taskDependencies).where(eq(taskDependencies.projectId, projectId));
}
