"use server";

/**
 * ゴミ箱画面の Server Action（M1 #9c）。
 *
 * ドメインエラー（`NotFoundError` 等）は catch して `ActionResult` に変換し、
 * 予期しないエラーはそのまま再 throw する（呼び出し側の Client Component が
 * 「なぜ失敗したか」を画面に出せるようにするため。想定外のエラーまで握り潰すと
 * 障害の発見が遅れるので区別する）。
 */
import { revalidatePath } from "next/cache";
import { ActionInputError, assertValidId } from "../../../../lib/actions/input";
import { requireLogin } from "../../../../lib/auth/authz";
import { ForbiddenError, UnauthorizedError } from "../../../../lib/auth/errors";
import { getSession } from "../../../../lib/auth/session";
import { db } from "../../../../lib/db";
import { getProjectScopedTask } from "../../../../lib/db/queries";
import { restoreTask } from "../../../../lib/tasks/deletion";
import { NotFoundError } from "../../../../lib/errors";

export type ActionResult = { ok: true } | { ok: false; message: string };

/**
 * `restoreTask` が投げうるドメインエラー。ここに無いエラー（バグ・DB接続断等）は
 * 区別せず再 throw し、Next.js の error boundary / ログに載せる。
 */
function isDomainError(error: unknown): error is Error {
  return (
    error instanceof NotFoundError ||
    error instanceof UnauthorizedError ||
    error instanceof ForbiddenError ||
    error instanceof ActionInputError
  );
}

export async function restoreTaskAction(
  rawProjectId: unknown,
  rawTaskId: unknown,
): Promise<ActionResult> {
  const session = await getSession();
  let projectId: string;

  try {
    // 認可を最初に通す。境界チェックが先だと、未ログインでも DB 照会が走り、返る
    // メッセージの違いからゴミ箱内タスクの所属を判別できてしまう（/code-review の指摘）。
    requireLogin(session);

    projectId = assertValidId(rawProjectId, "projectId");
    const taskId = assertValidId(rawTaskId, "taskId");

    // URL 由来の `projectId` と、クライアントから届いた `taskId` の整合を確かめる。
    // 省くと ①他プロジェクトの削除済みタスクを復元できる、②owner が論理削除した PJ
    // （配下タスクは消えない）のタスクを誰でも復元できる、の2つが起きる（実測で確認済み）。
    // `getProjectScopedTask` はタスク自身の生存を見ないので、復元対象（削除済み）でも通る。
    const scoped = await getProjectScopedTask(db, projectId, taskId);
    if (!scoped) {
      throw new NotFoundError("タスクが見つかりません");
    }

    await restoreTask(db, session, taskId);
  } catch (error) {
    if (isDomainError(error)) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  revalidatePath(`/projects/${projectId}/trash`);
  return { ok: true };
}
