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
import { ActionInputError, assertValidId, assertValidText } from "../../lib/actions/input";
import { requireLogin } from "../../lib/auth/authz";
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
  restoreProject,
  updateProject,
  type UpdateProjectInput,
} from "../../lib/projects/service";

export type ActionResult = { ok: true } | { ok: false; message: string };

function toActionResult(error: unknown): ActionResult {
  if (
    error instanceof UnauthorizedError ||
    error instanceof ForbiddenError ||
    error instanceof NotFoundError ||
    error instanceof ValidationError ||
    error instanceof ActionInputError
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

/**
 * 入力をランタイム検証して正規化する。
 *
 * 以前はこのファイルだけ `input` を型注釈のまま信頼し、`input.name.trim()` を
 * `getSession()` **より前**・`try` の外で呼んでいた。そのため未ログインの相手でも
 * `{"name": 1}` や `null` を POST するだけで未捕捉の `TypeError` を起こせ、
 * `{ok:false}` にすらならず 500 になることを監査で実測した。
 * 同ファイルの `dependencySyncEnabled` だけは「Server Action は公開エンドポイント」
 * という理由でランタイム検証済みだったので、その方針を全項目に揃える。
 */
function normalizeProjectInput(input: unknown): { name?: string; description?: string | null } {
  if (typeof input !== "object" || input === null) {
    throw new ActionInputError("不正な入力です");
  }
  const value = input as Record<string, unknown>;
  const normalized: { name?: string; description?: string | null } = {};

  if (value.name !== undefined) {
    normalized.name = assertValidText(value.name, {
      label: "プロジェクト名",
      maxLength: NAME_MAX_LENGTH,
      required: true,
    });
  }

  if (value.description !== undefined) {
    normalized.description =
      value.description === null
        ? null
        : assertValidText(value.description, {
            label: "説明",
            maxLength: DESCRIPTION_MAX_LENGTH,
            required: false,
          }) || null;
  }

  return normalized;
}

export async function createProjectAction(input: unknown): Promise<ActionResult> {
  try {
    // 認可を最初に通す。検証や DB 照会が先だと、未ログインでも例外の形や
    // メッセージの違いから内部の状態を推測できてしまう
    // （`app/projects/[id]/tasks/actions.ts` の `updateTaskAction` と同じ方針）。
    const session = await getSession();
    requireLogin(session);

    const { name, description } = normalizeProjectInput(input);
    if (name === undefined) {
      throw new ActionInputError("プロジェクト名を入力してください");
    }

    await createProject(db, session, { name, description: description ?? undefined });
  } catch (error) {
    return toActionResult(error);
  }

  revalidatePath("/projects");
  return { ok: true };
}

export interface UpdateProjectActionInput {
  name?: string;
  description?: string | null;
  dependencySyncEnabled?: boolean;
}

export async function updateProjectAction(
  projectId: unknown,
  input: unknown,
): Promise<ActionResult> {
  let validProjectId: string;
  try {
    const session = await getSession();
    requireLogin(session);

    validProjectId = assertValidId(projectId, "projectId");

    const updates: UpdateProjectInput = {};
    const { name, description } = normalizeProjectInput(input);
    if (name !== undefined) {
      updates.name = name;
    }
    if (description !== undefined) {
      updates.description = description;
    }

    const value = input as Record<string, unknown>;
    if (value.dependencySyncEnabled !== undefined) {
      // Server Action は直接呼び出し可能な公開エンドポイントでもあるため、
      // TypeScript の型注釈（コンパイル時のみ）を信頼せず、ここでランタイム検証する
      // （`app/projects/[id]/tasks/actions.ts` の `isPinned` 検証と同じ方針。
      // セキュリティレビュー指摘）。
      if (typeof value.dependencySyncEnabled !== "boolean") {
        throw new ActionInputError("依存連動の指定が不正です");
      }
      updates.dependencySyncEnabled = value.dependencySyncEnabled;
    }

    await updateProject(db, session, validProjectId, updates);
  } catch (error) {
    return toActionResult(error);
  }

  revalidatePath("/projects");
  // タスク/Gantt/ゴミ箱/設定の各タブが共有するレイアウト（ヘッダーのPJ名）もまとめて再検証する。
  revalidatePath(`/projects/${validProjectId}`, "layout");
  return { ok: true };
}

export async function deleteProjectAction(projectId: unknown): Promise<ActionResult> {
  let validProjectId: string;
  try {
    const session = await getSession();
    requireLogin(session);

    validProjectId = assertValidId(projectId, "projectId");
    await deleteProject(db, session, validProjectId);
  } catch (error) {
    return toActionResult(error);
  }

  revalidatePath("/projects");
  // 削除後にキャッシュされたレイアウト（ヘッダーのPJ名等）が残らないようにする
  // （updateProjectActionと同様。Bugbot指摘）。
  revalidatePath(`/projects/${validProjectId}`, "layout");
  return { ok: true };
}

/**
 * ゴミ箱から論理削除済みのプロジェクトを戻す（Issue #65）。
 *
 * 決定 D-15 に合わせて owner 限定。判定は `restoreProject` が行うので、ここでは
 * 認可の入口（`requireLogin`）と ID の形だけを見る。
 */
export async function restoreProjectAction(projectId: unknown): Promise<ActionResult> {
  let validProjectId: string;
  try {
    const session = await getSession();
    requireLogin(session);

    validProjectId = assertValidId(projectId, "projectId");
    await restoreProject(db, session, validProjectId);
  } catch (error) {
    return toActionResult(error);
  }

  revalidatePath("/projects");
  // 復元した PJ の配下ページのレイアウト（ヘッダーのPJ名）も貼り直す。
  revalidatePath(`/projects/${validProjectId}`, "layout");
  return { ok: true };
}
