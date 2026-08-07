"use server";

/**
 * プロジェクト CRUD の Server Actions（M2 #13）。
 *
 * ビジネスロジックは `lib/projects/service.ts` に実装済みのため、ここでは
 * セッション取得・DB ハンドルの解決・入力の軽い正規化・エラーの戻り値変換だけを行う。
 * 既知のドメインエラー（Unauthorized/Forbidden/NotFound/Validation）は catch して
 * `{ ok: false, message }` に変換し、クライアント側で通知表示に使う。
 * それ以外の予期しない例外は再 throw し、Next.js のエラーハンドリングに委ねる。
 */

import { revalidatePath } from "next/cache";
import { ForbiddenError, UnauthorizedError } from "../../lib/auth/errors";
import { getSession } from "../../lib/auth/session";
import { db } from "../../lib/db";
import { NotFoundError, ValidationError } from "../../lib/errors";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH as DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH as NAME_MAX_LENGTH,
} from "../../lib/projects/constants";
import {
  createProject,
  deleteProject,
  updateProject,
  type UpdateProjectInput,
} from "../../lib/projects/service";

export type ActionResult = { ok: true } | { ok: false; message: string };

function toActionResult(error: unknown): ActionResult {
  if (
    error instanceof UnauthorizedError ||
    error instanceof ForbiddenError ||
    error instanceof NotFoundError ||
    error instanceof ValidationError
  ) {
    return { ok: false, message: error.message };
  }
  // 未知のエラーはここで握り潰さず再 throw する（呼び出し側の catch で処理）。
  throw error;
}

export interface CreateProjectActionInput {
  name: string;
  description?: string;
}

export async function createProjectAction(input: CreateProjectActionInput): Promise<ActionResult> {
  const name = input.name.trim();
  if (!name) {
    return { ok: false, message: "プロジェクト名を入力してください" };
  }
  if (name.length > NAME_MAX_LENGTH) {
    return { ok: false, message: `プロジェクト名は${NAME_MAX_LENGTH}文字以内で入力してください` };
  }

  const description = input.description?.trim();
  if (description && description.length > DESCRIPTION_MAX_LENGTH) {
    return { ok: false, message: `説明は${DESCRIPTION_MAX_LENGTH}文字以内で入力してください` };
  }

  try {
    const session = await getSession();
    await createProject(db, session, { name, description: description || undefined });
  } catch (error) {
    return toActionResult(error);
  }

  revalidatePath("/projects");
  return { ok: true };
}

export interface UpdateProjectActionInput {
  name?: string;
  description?: string | null;
}

export async function updateProjectAction(
  projectId: string,
  input: UpdateProjectActionInput,
): Promise<ActionResult> {
  const updates: UpdateProjectInput = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      return { ok: false, message: "プロジェクト名を入力してください" };
    }
    if (name.length > NAME_MAX_LENGTH) {
      return { ok: false, message: `プロジェクト名は${NAME_MAX_LENGTH}文字以内で入力してください` };
    }
    updates.name = name;
  }

  if (input.description !== undefined) {
    const description = input.description === null ? null : input.description.trim();
    if (description && description.length > DESCRIPTION_MAX_LENGTH) {
      return { ok: false, message: `説明は${DESCRIPTION_MAX_LENGTH}文字以内で入力してください` };
    }
    updates.description = description || null;
  }

  try {
    const session = await getSession();
    await updateProject(db, session, projectId, updates);
  } catch (error) {
    return toActionResult(error);
  }

  revalidatePath("/projects");
  // タスク/Gantt/ゴミ箱の各タブが共有するレイアウト（ヘッダーのPJ名）もまとめて再検証する。
  revalidatePath(`/projects/${projectId}`, "layout");
  return { ok: true };
}

export async function deleteProjectAction(projectId: string): Promise<ActionResult> {
  try {
    const session = await getSession();
    await deleteProject(db, session, projectId);
  } catch (error) {
    return toActionResult(error);
  }

  revalidatePath("/projects");
  return { ok: true };
}
