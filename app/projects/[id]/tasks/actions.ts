"use server";

/**
 * タスク一覧/詳細画面（M2 #14〜#17）用の Server Actions。
 *
 * ここでは `lib/tasks/service.ts` 等のビジネスロジックを一切再実装しない。
 * このファイルの責務は次の3点だけ:
 *   1. `getSession()` でセッションを取得し、service 層へ橋渡しする。
 *   2. クライアントから届く値は Server Action の境界を越える時点で型情報が失われる
 *      （ネットワーク越しに任意の JSON を送りつけられ得る）ため、service 層に渡す前に
 *      ランタイムで検証する（マスアサインメント・不正な enum 値の混入を防ぐ）。
 *   3. ドメインエラーを `ActionResult` に変換し、予期しないエラーは再 throw する。
 */

import { revalidatePath } from "next/cache";
import { ForbiddenError, UnauthorizedError } from "../../../../lib/auth/errors";
import { getSession } from "../../../../lib/auth/session";
import { db } from "../../../../lib/db";
import { NotFoundError, ValidationError } from "../../../../lib/errors";
import { setTaskAssignees } from "../../../../lib/tasks/assignees";
import {
  deleteTask,
  deleteTaskSubtree,
  promoteChildrenAndDeleteTask,
} from "../../../../lib/tasks/deletion";
import { HasChildrenError } from "../../../../lib/tasks/errors";
import { createTask, updateTask } from "../../../../lib/tasks/service";

export type ActionResult = { ok: true } | { ok: false; message: string };

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const STATUSES = ["todo", "in_progress", "review", "done"] as const;
type Priority = (typeof PRIORITIES)[number];
type Status = (typeof STATUSES)[number];

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_ASSIGNEES = 50;
const MAX_USER_ID_LENGTH = 100;

/** ランタイム検証に失敗したときのエラー。ドメインエラー（`ActionResult.ok=false`）として扱う。 */
class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionInputError";
  }
}

export interface TaskFormInput {
  title: string;
  startDate: string;
  endDate: string;
  priority?: Priority;
  status?: Status;
  progress?: number;
  estimatedHours?: number | null;
  actualHours?: number | null;
  isPinned?: boolean;
}

/**
 * クライアントから届いた値を `TaskFormInput` として扱ってよいかをランタイムで検証する。
 * `type`（task/summary/milestone）はこの画面からは一切受け付けない
 * （決定 D-12: Phase 1 では milestone を UI に出さない。summary はサマリー集計
 * ロジック側が管理する値のため、ここから任意に変更できるようにしない）。
 */
function assertValidTaskFormInput(input: unknown): asserts input is TaskFormInput {
  if (typeof input !== "object" || input === null) {
    throw new ActionInputError("不正な入力です");
  }
  const value = input as Record<string, unknown>;

  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    throw new ActionInputError("タイトルは必須です");
  }
  if (value.title.length > MAX_TITLE_LENGTH) {
    throw new ActionInputError(`タイトルは${MAX_TITLE_LENGTH}文字以内で入力してください`);
  }
  if (typeof value.startDate !== "string" || !DATE_ONLY_PATTERN.test(value.startDate)) {
    throw new ActionInputError("開始日の形式が不正です");
  }
  if (typeof value.endDate !== "string" || !DATE_ONLY_PATTERN.test(value.endDate)) {
    throw new ActionInputError("終了日の形式が不正です");
  }
  if (
    value.priority !== undefined &&
    !PRIORITIES.includes(value.priority as (typeof PRIORITIES)[number])
  ) {
    throw new ActionInputError("優先度の値が不正です");
  }
  if (
    value.status !== undefined &&
    !STATUSES.includes(value.status as (typeof STATUSES)[number])
  ) {
    throw new ActionInputError("ステータスの値が不正です");
  }
  if (
    value.progress !== undefined &&
    (typeof value.progress !== "number" ||
      !Number.isInteger(value.progress) ||
      value.progress < 0 ||
      value.progress > 100)
  ) {
    throw new ActionInputError("進捗は0〜100の整数で入力してください");
  }
  for (const key of ["estimatedHours", "actualHours"] as const) {
    const hours = value[key];
    if (
      hours !== undefined &&
      hours !== null &&
      (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0)
    ) {
      throw new ActionInputError("工数は0以上の数値で入力してください");
    }
  }
  if (value.isPinned !== undefined && typeof value.isPinned !== "boolean") {
    throw new ActionInputError("ピン留めの指定が不正です");
  }
}

/** 担当者一覧（自由入力の userId 配列）をランタイムで検証・正規化する。 */
function assertValidUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ActionInputError("担当者の指定が不正です");
  }
  if (value.length > MAX_ASSIGNEES) {
    throw new ActionInputError(`担当者は${MAX_ASSIGNEES}人以内で指定してください`);
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new ActionInputError("担当者の指定が不正です");
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_USER_ID_LENGTH) {
      throw new ActionInputError("担当者IDが不正です");
    }
    return trimmed;
  });
  return [...new Set(normalized)];
}

/** ドメインエラー（呼び出し元の入力に起因するエラー）かどうかを判定する。 */
function isDomainError(error: unknown): error is Error {
  return (
    error instanceof UnauthorizedError ||
    error instanceof ForbiddenError ||
    error instanceof NotFoundError ||
    error instanceof ValidationError ||
    error instanceof HasChildrenError ||
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

export async function createTaskAction(
  projectId: string,
  input: unknown,
  assigneeUserIds: unknown,
): Promise<ActionResult & { taskId?: string }> {
  const session = await getSession();

  try {
    assertValidTaskFormInput(input);
    const userIds = assertValidUserIds(assigneeUserIds);

    const created = await createTask(db, session, projectId, {
      title: input.title.trim(),
      startDate: input.startDate,
      endDate: input.endDate,
      priority: input.priority,
      status: input.status,
      progress: input.progress,
      estimatedHours: input.estimatedHours ?? undefined,
      actualHours: input.actualHours ?? undefined,
      isPinned: input.isPinned,
    });

    if (userIds.length > 0) {
      await setTaskAssignees(db, session, created.id, userIds);
    }

    revalidatePath(`/projects/${projectId}/tasks`);
    return { ok: true, taskId: created.id };
  } catch (error) {
    return toFailure(error);
  }
}

export async function updateTaskAction(
  projectId: string,
  taskId: string,
  input: unknown,
  assigneeUserIds: unknown,
): Promise<ActionResult> {
  const session = await getSession();

  try {
    assertValidTaskFormInput(input);
    const userIds = assertValidUserIds(assigneeUserIds);

    await updateTask(db, session, taskId, {
      title: input.title.trim(),
      startDate: input.startDate,
      endDate: input.endDate,
      priority: input.priority,
      status: input.status,
      progress: input.progress,
      // `updateTask` は Partial 更新（キー省略 = 変更しない）を前提にしているため、
      // `undefined`（キー省略）と `null`（明示的にクリア）を区別して素通しする。
      // `?? null` にすると省略時まで毎回クリア扱いになり、部分更新の意味が壊れる。
      estimatedHours: input.estimatedHours,
      actualHours: input.actualHours,
      isPinned: input.isPinned,
    });

    await setTaskAssignees(db, session, taskId, userIds);

    revalidatePath(`/projects/${projectId}/tasks`);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * `mode` 省略時は子を持たないタスクの単純削除を試みる。子がいる場合は
 * `HasChildrenError`（メッセージは `HAS_CHILDREN_MESSAGE` と一致）を
 * `{ok:false}` として返すので、呼び出し側（`TaskDrawer`）がユーザーに
 * `"subtree"` / `"promote"` のどちらかを選ばせてから再度呼び出す（決定 D-02）。
 */
export async function deleteTaskAction(
  projectId: string,
  taskId: string,
  mode?: "subtree" | "promote",
): Promise<ActionResult> {
  const session = await getSession();

  try {
    if (mode === "subtree") {
      await deleteTaskSubtree(db, session, taskId);
    } else if (mode === "promote") {
      await promoteChildrenAndDeleteTask(db, session, taskId);
    } else {
      await deleteTask(db, session, taskId);
    }

    revalidatePath(`/projects/${projectId}/tasks`);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

export async function setTaskAssigneesAction(
  projectId: string,
  taskId: string,
  userIds: unknown,
): Promise<ActionResult> {
  const session = await getSession();

  try {
    const validated = assertValidUserIds(userIds);
    await setTaskAssignees(db, session, taskId, validated);

    revalidatePath(`/projects/${projectId}/tasks`);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}
