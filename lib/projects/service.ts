/**
 * プロジェクト CRUD のビジネスロジック（M2 #13）。
 *
 * Next.js の 'use server' 境界（実際のセッション取得）とは意図的に分離してある。
 * 認証実装（Better Auth）待ちのため、session は呼び出し側が用意して渡す設計にした
 * （lib/auth/authz.ts と同じ方針）。将来、実際の Server Action から
 * `requireLogin(await getSession())` の結果をそのままここへ渡す形で接続する想定。
 */

import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { requireLogin, requireProjectOwner } from "../auth/authz";
import type { AuthSession } from "../auth/types";
import { getActiveProject, listActiveProjects } from "../db/queries";
import { projectMembers, projects } from "../db/schema";
import type * as schema from "../db/schema";
import { NotFoundError } from "../errors";

export interface CreateProjectInput {
  name: string;
  description?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  dependencySyncEnabled?: boolean;
}

/** 決定 D-08: 閲覧は全ログインユーザーに開く。所属チェックはしない。 */
export async function listProjects(db: LibSQLDatabase<typeof schema>, session: AuthSession | null) {
  requireLogin(session);
  return listActiveProjects(db);
}

/**
 * 作成者はそのまま `project_members.role='owner'` として登録される。
 * 2つの INSERT はトランザクションでまとめる。分けたままだと2つ目が失敗した際に
 * owner の居ないプロジェクトが残り、誰も削除できなくなる（Amazon Q レビュー指摘）。
 */
export async function createProject(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  input: CreateProjectInput,
) {
  const authed = requireLogin(session);

  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ name: input.name, description: input.description })
      .returning();

    if (!project) {
      throw new Error("プロジェクトの作成に失敗しました");
    }

    await tx.insert(projectMembers).values({
      projectId: project.id,
      userId: authed.userId,
      role: "owner",
    });

    return project;
  });
}

/** 決定 D-08/§6: PJ の編集自体は全ログインユーザーに開く（削除だけが owner 限定）。 */
export async function updateProject(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  projectId: string,
  input: UpdateProjectInput,
) {
  requireLogin(session);

  const existing = await getActiveProject(db, projectId);
  if (!existing) {
    throw new NotFoundError("プロジェクトが見つかりません");
  }

  // 更新項目が1つも無い（`{}` や全キーが undefined）と Drizzle が
  // "No values to set" で例外を投げるため、その場合は DB に触らず既存の状態を返す
  // （Amazon Q レビュー指摘: `{ name: undefined }` は Object.keys では検出できない）。
  const updates = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(updates).length === 0) {
    return existing;
  }

  const [updated] = await db
    .update(projects)
    .set(updates)
    .where(eq(projects.id, projectId))
    .returning();

  if (!updated) {
    throw new Error("プロジェクトの更新に失敗しました");
  }

  return updated;
}

/**
 * 決定 D-15: PJ の削除は `role='owner'` のみ。
 * §4.4: 論理削除のみ（`deleted_at` を入れる）で、配下タスクには触れない。
 */
export async function deleteProject(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  projectId: string,
): Promise<void> {
  const authed = requireLogin(session);

  const existing = await getActiveProject(db, projectId);
  if (!existing) {
    throw new NotFoundError("プロジェクトが見つかりません");
  }

  await requireProjectOwner(db, authed, projectId);

  await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, projectId));
}
