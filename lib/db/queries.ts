/**
 * 生存レコード（`deleted_at IS NULL`）のみを返す問い合わせを集約する（§3.2 / §4.4(c)）。
 *
 * 論理削除の最大の事故は「絞り込みの書き忘れで削除済みが表示・伝播対象に入る」こと。
 * 画面や Server Action・service 層は素の `db.select()` をここ以外に書かず、必ずこのファイルを通す。
 */

import { and, eq, isNull } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { projects } from "./schema";
import type * as schema from "./schema";

export async function listActiveProjects(db: LibSQLDatabase<typeof schema>) {
  return db.select().from(projects).where(isNull(projects.deletedAt));
}

export async function getActiveProject(db: LibSQLDatabase<typeof schema>, projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);

  return project;
}
