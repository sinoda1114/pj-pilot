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
import { ForbiddenError, UnauthorizedError } from "../../../../lib/auth/errors";
import { getSession } from "../../../../lib/auth/session";
import { db } from "../../../../lib/db";
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
    error instanceof ForbiddenError
  );
}

export async function restoreTaskAction(projectId: string, taskId: string): Promise<ActionResult> {
  const session = await getSession();

  try {
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
