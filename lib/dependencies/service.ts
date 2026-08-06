/**
 * 依存関係の CRUD + 循環検出（M4 #23）。
 *
 * 初版は FS（Finish-to-Start）固定で、ラグ属性は持たない（§4.3）。
 * 循環検出は lib/scheduling/propagate.ts の `wouldCreateCycle` をそのまま使い、
 * 伝播ロジックと判定基準がずれないようにする（§5.2）。
 */

import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { requireLogin } from "../auth/authz";
import type { AuthSession } from "../auth/types";
import { getActiveProject, getActiveTask, listDependenciesByProject } from "../db/queries";
import { taskDependencies } from "../db/schema";
import type * as schema from "../db/schema";
import { NotFoundError, ValidationError } from "../errors";
import { wouldCreateCycle } from "../scheduling/propagate";

export async function listDependencies(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  projectId: string,
) {
  requireLogin(session);

  const project = await getActiveProject(db, projectId);
  if (!project) {
    throw new NotFoundError("プロジェクトが見つかりません");
  }

  return listDependenciesByProject(db, projectId);
}

/**
 * 検証（重複・循環チェック）から INSERT までをトランザクションでまとめる。
 * 分けたままだと、検証後・INSERT 前に別のリクエストが依存を追加した場合に
 * 循環チェックが古い状態に基づいてしまう TOCTOU 競合が起こり得る
 * （Amazon Q レビュー指摘）。SQLite/libSQL は書き込みトランザクションを
 * 直列化するため、この一連の処理をトランザクション化すれば防げる。
 */
export async function createDependency(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  projectId: string,
  predecessorId: string,
  successorId: string,
) {
  requireLogin(session);

  if (predecessorId === successorId) {
    throw new ValidationError("タスクは自分自身に依存できません");
  }

  return db.transaction(async (tx) => {
    const project = await getActiveProject(tx, projectId);
    if (!project) {
      throw new NotFoundError("プロジェクトが見つかりません");
    }

    const predecessor = await getActiveTask(tx, predecessorId);
    if (!predecessor) {
      throw new NotFoundError("先行タスクが見つかりません");
    }
    if (predecessor.projectId !== projectId) {
      throw new ValidationError("先行タスクは同じプロジェクト内である必要があります");
    }

    const successor = await getActiveTask(tx, successorId);
    if (!successor) {
      throw new NotFoundError("後続タスクが見つかりません");
    }
    if (successor.projectId !== projectId) {
      throw new ValidationError("後続タスクは同じプロジェクト内である必要があります");
    }

    const existingDependencies = await listDependenciesByProject(tx, projectId);

    const alreadyExists = existingDependencies.some(
      (dep) => dep.predecessorId === predecessorId && dep.successorId === successorId,
    );
    if (alreadyExists) {
      throw new ValidationError("同じ依存が既に存在します");
    }

    const createsCycle = wouldCreateCycle(
      existingDependencies.map((dep) => ({
        predecessorId: dep.predecessorId,
        successorId: dep.successorId,
      })),
      predecessorId,
      successorId,
    );
    if (createsCycle) {
      throw new ValidationError("この依存を追加すると循環参照になります（§5.2）");
    }

    const [dependency] = await tx
      .insert(taskDependencies)
      .values({ projectId, predecessorId, successorId })
      .returning();

    if (!dependency) {
      throw new Error("依存の作成に失敗しました");
    }

    return dependency;
  });
}

/**
 * `task_dependencies` に論理削除の仕組みは無い（決定 D-06 が対象にしているのは
 * タスク削除に伴う扱いであって、依存レコード自体の CRUD ではない）ため、
 * これは物理削除。
 */
export async function deleteDependency(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  dependencyId: string,
): Promise<void> {
  requireLogin(session);

  const [existing] = await db
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.id, dependencyId))
    .limit(1);

  if (!existing) {
    throw new NotFoundError("依存が見つかりません");
  }

  await db.delete(taskDependencies).where(eq(taskDependencies.id, dependencyId));
}
