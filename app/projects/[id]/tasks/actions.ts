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
import {
  ActionInputError,
  assertValidId,
  assertValidText,
} from "../../../../lib/actions/input";
import { requireLogin } from "../../../../lib/auth/authz";
import { ForbiddenError, UnauthorizedError } from "../../../../lib/auth/errors";
import { getSession } from "../../../../lib/auth/session";
import { db } from "../../../../lib/db";
import { getProjectScopedTask } from "../../../../lib/db/queries";
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

/**
 * URL 由来の `projectId` と、クライアントから届いた `taskId` の整合を確かめる。
 *
 * Server Action はクライアントから任意の引数で直接呼べるため、これを省くと
 * ①他プロジェクトのタスクを操作できる、②owner が論理削除した PJ（配下タスクは
 * 消えない）のタスクを誰でも操作し続けられる、の2つが起きる。いずれも実測で確認済み。
 * `app/projects/[id]/gantt/actions.ts` が既に行っている突き合わせと同じ趣旨。
 */
async function assertTaskInProject(projectId: string, taskId: string): Promise<void> {
  const task = await getProjectScopedTask(db, projectId, taskId);
  if (!task) {
    throw new NotFoundError("タスクが見つかりません");
  }
}

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const STATUSES = ["todo", "in_progress", "review", "done"] as const;
type Priority = (typeof PRIORITIES)[number];
type Status = (typeof STATUSES)[number];

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_ASSIGNEES = 50;
const MAX_USER_ID_LENGTH = 100;
/**
 * 工数の上限。`Number.isFinite` だけでは `1e308` が通ってしまい、サマリー集計
 * （`lib/scheduling/propagate.ts` の `aggregateSummaryValues`）で子2件を足すと
 * `Infinity`、加重平均が `Infinity / Infinity = NaN` になる。その値を書こうとして
 * libSQL が例外を投げ、**以後そのサマリー配下は Gantt から一切動かせなくなる**
 * （監査で実測）。業務上あり得ない桁はここで止める。
 */
const MAX_HOURS = 100_000;

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

  // 制御文字（特に NUL）も弾く。`trim()` は NUL を空白として扱わないため
  // `title = "\u0000"` が「必須」を通過してしまうが、libSQL は C 文字列として扱うので
  // 保存時に切り捨てられて DB には空文字列が入る（監査で実測）。
  assertValidText(value.title, {
    label: "タイトル",
    maxLength: MAX_TITLE_LENGTH,
    required: true,
    requiredMessage: "タイトルは必須です",
  });
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
      (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0 || hours > MAX_HOURS)
    ) {
      throw new ActionInputError(`工数は0〜${MAX_HOURS}の数値で入力してください`);
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
  rawProjectId: unknown,
  input: unknown,
  assigneeUserIds: unknown,
): Promise<ActionResult & { taskId?: string }> {
  const session = await getSession();

  try {
    requireLogin(session);
    const projectId = assertValidId(rawProjectId, "projectId");
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
  rawProjectId: unknown,
  rawTaskId: unknown,
  input: unknown,
  assigneeUserIds: unknown,
): Promise<ActionResult> {
  const session = await getSession();

  try {
    // 認可を最初に通す。`assertTaskInProject` が先だと、未ログインでも DB 照会が走り、
    // 返るメッセージの違い（「ログインが必要です」/「タスクが見つかりません」）から
    // taskId の所属を判別できてしまう（/code-review の指摘）。
    requireLogin(session);
    const projectId = assertValidId(rawProjectId, "projectId");
    const taskId = assertValidId(rawTaskId, "taskId");
    assertValidTaskFormInput(input);
    const userIds = assertValidUserIds(assigneeUserIds);
    await assertTaskInProject(projectId, taskId);

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
  rawProjectId: unknown,
  rawTaskId: unknown,
  mode?: "subtree" | "promote",
): Promise<ActionResult> {
  const session = await getSession();

  try {
    requireLogin(session);
    const projectId = assertValidId(rawProjectId, "projectId");
    const taskId = assertValidId(rawTaskId, "taskId");
    await assertTaskInProject(projectId, taskId);

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
  rawProjectId: unknown,
  rawTaskId: unknown,
  userIds: unknown,
): Promise<ActionResult> {
  const session = await getSession();

  try {
    requireLogin(session);
    const projectId = assertValidId(rawProjectId, "projectId");
    const taskId = assertValidId(rawTaskId, "taskId");
    const validated = assertValidUserIds(userIds);
    await assertTaskInProject(projectId, taskId);
    await setTaskAssignees(db, session, taskId, validated);

    revalidatePath(`/projects/${projectId}/tasks`);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}
