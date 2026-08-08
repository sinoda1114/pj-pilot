"use server";

/**
 * カンバンボード（Phase 2 M8 #41）用の Server Actions。
 *
 * `app/projects/[id]/tasks/actions.ts` と同じ3層構成に揃える。
 *   1. `getSession()` でセッションを取得し、service 層へ橋渡しする。
 *   2. クライアントから届く値は Server Action の境界を越える時点で型情報が失われる
 *      （ネットワーク越しに任意の JSON を送りつけられ得る）ため、service 層に渡す前に
 *      ランタイムで検証する。
 *   3. ドメインエラーを `ActionResult` に変換し、予期しないエラーは再 throw する。
 *
 * ビジネスロジックはここに書かない（`lib/board/service.ts` にある）。
 */

import { revalidatePath } from "next/cache";
import { ForbiddenError, UnauthorizedError } from "../../../../lib/auth/errors";
import { getSession } from "../../../../lib/auth/session";
import { isBoardStatus, moveTaskOnBoard } from "../../../../lib/board/service";
import { db } from "../../../../lib/db";
import { NotFoundError, ValidationError } from "../../../../lib/errors";

export type ActionResult = { ok: true } | { ok: false; message: string };

/** ランタイム検証に失敗したときのエラー。ドメインエラーとして扱う。 */
class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionInputError";
  }
}

function isDomainError(error: unknown): error is Error {
  return (
    error instanceof UnauthorizedError ||
    error instanceof ForbiddenError ||
    error instanceof NotFoundError ||
    error instanceof ValidationError ||
    error instanceof ActionInputError
  );
}

function toFailure(error: unknown): ActionResult {
  if (isDomainError(error)) {
    return { ok: false, message: error.message };
  }
  // 予期しないエラーは仕様どおり再 throw する。
  throw error;
}

/**
 * カンバン上でタスクを別の列・別の位置へ移動する。
 *
 * `taskId` が `projectId` に属するかの検証は service 層で行う（他プロジェクトの
 * タスクIDを送り込まれても動かせないようにするため）。ここでは形の検証だけを行う。
 */
export async function moveTaskOnBoardAction(
  projectId: string,
  taskId: unknown,
  toStatus: unknown,
  toIndex: unknown,
): Promise<ActionResult> {
  const session = await getSession();

  try {
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      throw new ActionInputError("タスクの指定が不正です");
    }
    if (!isBoardStatus(toStatus)) {
      throw new ActionInputError("ステータスの値が不正です");
    }
    if (typeof toIndex !== "number" || !Number.isInteger(toIndex) || toIndex < 0) {
      throw new ActionInputError("移動先の位置が不正です");
    }

    await moveTaskOnBoard(db, session, projectId, taskId, toStatus, toIndex);

    revalidatePath(`/projects/${projectId}/board`);
    // ステータス変更はタスク一覧にも波及するため、そちらも再検証する。
    revalidatePath(`/projects/${projectId}/tasks`);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}
