/**
 * プロジェクト CRUD のビジネスロジック（M2 #13）。
 *
 * Next.js の 'use server' 境界（実際のセッション取得）とは意図的に分離してある。
 * 認証実装（Better Auth）待ちのため、session は呼び出し側が用意して渡す設計にした
 * （lib/auth/authz.ts と同じ方針）。将来、実際の Server Action から
 * `requireLogin(await getSession())` の結果をそのままここへ渡す形で接続する想定。
 */

import { and, eq, isNotNull } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { requireLogin, requireProjectOwner } from "../auth/authz";
import type { AuthSession } from "../auth/types";
import {
  getActiveProject,
  listActiveProjects,
  listDeletedProjects as listDeletedProjectRows,
} from "../db/queries";
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

  // input をそのまま .set() に渡さず、許可したキーだけを明示的に拾う。
  // UpdateProjectInput はコンパイル時の型でしかなく、将来 Server Action が
  // ランタイム検証（zod等）を省略して生の入力をそのまま渡した場合、
  // 型に無い deletedAt / createdAt 等を紛れ込ませて上書きされる
  // マスアサインメントを防ぐため（セキュリティレビュー指摘）。
  const updates: UpdateProjectInput = {};
  if (input.name !== undefined) {
    updates.name = input.name;
  }
  if (input.description !== undefined) {
    updates.description = input.description;
  }
  if (input.dependencySyncEnabled !== undefined) {
    updates.dependencySyncEnabled = input.dependencySyncEnabled;
  }

  // 更新項目が1つも無いと Drizzle が "No values to set" で例外を投げるため、
  // その場合は DB に触らず既存の状態を返す（Amazon Q レビュー指摘）。
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
 * ゴミ箱に入っている（論理削除済みの）プロジェクト一覧（Issue #65）。
 *
 * 一覧そのものは決定 D-08 に従い全ログインユーザーに開く（`listProjects` と同じ）。
 * 実際に復元できるのは owner だけで、その判定は `restoreProject` が行う。
 * 一覧を owner に絞らないのは、「誰かが誤って消した」ことに気づける状態を保つため。
 */
export async function listDeletedProjects(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
) {
  requireLogin(session);
  return listDeletedProjectRows(db);
}

/**
 * 論理削除したプロジェクトをゴミ箱から戻す（Issue #65）。
 *
 * 決定 D-15 に合わせて **owner のみ**。削除できるのが owner だけなので、復元も揃える。
 *
 * 配下タスクには触れない。PJ の削除が配下タスクの `deleted_at` を立てない設計
 * （§4.4）なので、PJ を戻せば配下タスクもそのまま戻る。PJ 削除とは別に個別削除された
 * タスクは削除済みのままで、そちらはタスクのゴミ箱から個別に戻す。
 *
 * 判定と UPDATE を `db.transaction` でまとめるのは、間に別リクエストが割り込んで
 * 30日経過ぶんの物理削除（cron）が走った場合に、消えた行を復元したつもりになるのを
 * 防ぐため（`lib/tasks/deletion.ts` と同じ TOCTOU 対策）。
 */
export async function restoreProject(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  projectId: string,
): Promise<void> {
  const authed = requireLogin(session);

  await db.transaction(async (tx) => {
    // `getActiveProject` は生存のみを返すので使えない。ここでは「削除済みであること」を
    // 条件にして引く。生存中の PJ に対して復元を投げても NotFound になる。
    const [existing] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), isNotNull(projects.deletedAt)))
      .limit(1);

    if (!existing) {
      throw new NotFoundError("削除済みのプロジェクトが見つかりません");
    }

    // `requireProjectOwner` は `projects.deletedAt` を見ない（authz.ts のコメント参照）。
    // 「削除済み PJ への操作を owner に許すかは呼び出し側の責務」という設計なので、
    // ここで削除済みであることを確認したうえで owner 判定を通す。
    await requireProjectOwner(tx, authed, projectId);

    // `.returning()` で実際に更新できたことまで確認する。
    //
    // 直前の SELECT と owner 判定を通っていても、その間に 30 日経過ぶんの物理削除（cron）が
    // 割り込んで行が消えていれば UPDATE は 0 行になる。`.returning()` を付けずに投げっぱなしに
    // すると、何も復元していないのに「復元しました」と出せてしまう（Cursor Bugbot 指摘）。
    // ローカルのファイル DB では SQLite が競合を検出して例外にする可能性が高いが、本番の
    // Turso（HTTP 接続）でも同じ保証があるとは限らないため、結果を見て判断する。
    const restored = await tx
      .update(projects)
      .set({ deletedAt: null })
      .where(and(eq(projects.id, projectId), isNotNull(projects.deletedAt)))
      .returning({ id: projects.id });

    if (restored.length === 0) {
      throw new NotFoundError("削除済みのプロジェクトが見つかりません");
    }
  });
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
