/**
 * タスク CRUD のビジネスロジック（M2 #14）。
 *
 * 削除・復元は lib/tasks/deletion.ts に分離してある（M1 #9b）。
 * 決定 D-15: タスクの編集・削除は全ログインユーザーに開いているため、
 * lib/projects/service.ts と異なり owner チェックは行わない。
 */

import { eq, type InferInsertModel } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { requireLogin } from "../auth/authz";
import type { AuthSession } from "../auth/types";
import { diffInCalendarDays, isValidDateOnly } from "../dates/date-only";
import { getActiveProject, getActiveTask, listActiveTasksByProject } from "../db/queries";
import { tasks } from "../db/schema";
import type * as schema from "../db/schema";
import { NotFoundError, ValidationError } from "../errors";

type TaskRow = InferInsertModel<typeof tasks>;

export type CreateTaskInput = Pick<TaskRow, "title" | "startDate" | "endDate"> &
  Partial<
    Pick<
      TaskRow,
      | "parentId"
      | "priority"
      | "status"
      | "type"
      | "progress"
      | "estimatedHours"
      | "actualHours"
      | "isPinned"
      | "sortOrder"
    >
  >;

export type UpdateTaskInput = Partial<
  Pick<
    TaskRow,
    | "title"
    | "startDate"
    | "endDate"
    | "parentId"
    | "priority"
    | "status"
    | "type"
    | "progress"
    | "estimatedHours"
    | "actualHours"
    | "isPinned"
    | "sortOrder"
  >
>;

/**
 * ユーザーが編集してよいカラムの許可リスト。`projectId` / `id` / `deletedAt` /
 * `createdAt` / `updatedAt` は含めない。
 *
 * `input` をそのまま `.values()`/`.set()` に渡さずここを通すのは、
 * `CreateTaskInput`/`UpdateTaskInput` がコンパイル時の型でしかなく、将来
 * Server Action がランタイム検証（zod等）を省略して生の入力をそのまま渡した場合、
 * 型に無い `projectId` や `deletedAt` を紛れ込ませて上書きされるマスアサインメントを
 * 防ぐため（セキュリティレビュー指摘）。
 */
const EDITABLE_TASK_FIELDS = [
  "title",
  "startDate",
  "endDate",
  "parentId",
  "priority",
  "status",
  "type",
  "progress",
  "estimatedHours",
  "actualHours",
  "isPinned",
  "sortOrder",
] as const;

function pickEditableTaskFields(
  input: CreateTaskInput | UpdateTaskInput,
): Partial<Pick<TaskRow, (typeof EDITABLE_TASK_FIELDS)[number]>> {
  const picked: Partial<Pick<TaskRow, (typeof EDITABLE_TASK_FIELDS)[number]>> = {};
  for (const key of EDITABLE_TASK_FIELDS) {
    if (input[key] !== undefined) {
      (picked as Record<string, unknown>)[key] = input[key];
    }
  }
  return picked;
}

export async function listTasks(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  projectId: string,
) {
  requireLogin(session);

  const project = await getActiveProject(db, projectId);
  if (!project) {
    throw new NotFoundError("プロジェクトが見つかりません");
  }

  return listActiveTasksByProject(db, projectId);
}

export async function getTask(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
) {
  requireLogin(session);

  const task = await getActiveTask(db, taskId);
  if (!task) {
    throw new NotFoundError("タスクが見つかりません");
  }

  return task;
}

export async function createTask(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  projectId: string,
  input: CreateTaskInput,
) {
  requireLogin(session);

  const project = await getActiveProject(db, projectId);
  if (!project) {
    throw new NotFoundError("プロジェクトが見つかりません");
  }

  assertValidDateRange(input.startDate, input.endDate);

  if (input.parentId) {
    const parent = await getActiveTask(db, input.parentId);
    if (!parent) {
      throw new NotFoundError("親タスクが見つかりません");
    }
    if (parent.projectId !== projectId) {
      throw new ValidationError("親タスクは同じプロジェクト内である必要があります");
    }
  }

  const [task] = await db
    .insert(tasks)
    .values({
      ...pickEditableTaskFields(input),
      // 必須列は CreateTaskInput の型で保証されているのを明示的にも保つ
      // （pickEditableTaskFields の戻り値は update 側と共通化するため Partial 型）。
      title: input.title,
      startDate: input.startDate,
      endDate: input.endDate,
      projectId,
    })
    .returning();

  if (!task) {
    throw new Error("タスクの作成に失敗しました");
  }

  return task;
}

export async function updateTask(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
  input: UpdateTaskInput,
) {
  requireLogin(session);

  const existing = await getActiveTask(db, taskId);
  if (!existing) {
    throw new NotFoundError("タスクが見つかりません");
  }

  assertValidDateRange(input.startDate ?? existing.startDate, input.endDate ?? existing.endDate);

  if (input.parentId !== undefined && input.parentId !== null) {
    if (input.parentId === taskId) {
      throw new ValidationError("タスクは自分自身を親にできません");
    }

    const parent = await getActiveTask(db, input.parentId);
    if (!parent) {
      throw new NotFoundError("親タスクが見つかりません");
    }
    if (parent.projectId !== existing.projectId) {
      throw new ValidationError("親タスクは同じプロジェクト内である必要があります");
    }
    if (await isDescendantOf(db, taskId, input.parentId)) {
      throw new ValidationError("子孫タスクを親にすると循環参照になります");
    }
  }

  const updates = pickEditableTaskFields(input);
  if (Object.keys(updates).length === 0) {
    return existing;
  }

  const [updated] = await db.update(tasks).set(updates).where(eq(tasks.id, taskId)).returning();

  if (!updated) {
    throw new Error("タスクの更新に失敗しました");
  }

  return updated;
}

function assertValidDateRange(startDate: string, endDate: string): void {
  if (!isValidDateOnly(startDate) || !isValidDateOnly(endDate)) {
    throw new ValidationError("日付は 'YYYY-MM-DD' 形式の実在する日付である必要があります");
  }
  if (diffInCalendarDays(endDate, startDate) < 0) {
    throw new ValidationError("終了日は開始日以降である必要があります");
  }
}

/**
 * `candidateId` が `ancestorId` の子孫かどうかを判定する（reparent 時の循環防止）。
 * 論理削除済みの枝も含めて全体を見る必要があるため、queries.ts の生存フィルタ付き
 * ヘルパーは使わずここで直接たどる（`lib/scheduling/propagate.ts` と同じ visited 方針）。
 */
async function isDescendantOf(
  db: LibSQLDatabase<typeof schema>,
  ancestorId: string,
  candidateId: string,
): Promise<boolean> {
  const visited = new Set<string>([ancestorId]);
  const queue = [ancestorId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const children = await db.select().from(tasks).where(eq(tasks.parentId, current));
    for (const child of children) {
      if (child.id === candidateId) {
        return true;
      }
      if (visited.has(child.id)) {
        continue;
      }
      visited.add(child.id);
      queue.push(child.id);
    }
  }

  return false;
}
