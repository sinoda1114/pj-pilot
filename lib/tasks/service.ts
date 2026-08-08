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
import {
  getActiveProject,
  getActiveTask,
  listActiveBoardTasksByProject,
  listActiveTasksByProject,
  type Db,
} from "../db/queries";
import { tasks } from "../db/schema";
import type * as schema from "../db/schema";
import { NotFoundError, ValidationError } from "../errors";
import { markAsSummary, unmarkSummaryIfChildless } from "./summary-marker";

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
      | "boardOrder"
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
    | "boardOrder"
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
  // カンバンの列内の表示順（Phase 2 §4.4）。この配列に入れないと updateTask 経由では
  // 一切書き込めない（マスアサインメント防止の許可リストのため）。
  "boardOrder",
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

/**
 * 指定した status 列の末尾に置くための `board_order` を返す（列が空なら 0）。
 *
 * **件数ではなく `max + 1`** を使う。列の `board_order` は必ずしも 0..n-1 に
 * 整っていないため（Drawer でステータスを変えると移動元の値をそのまま持ち込むので、
 * 件数より大きい値が残ることがある）、件数で採番すると既存行の前に割り込む。
 * 実測: `board_order = 7` の行が1件ある列に追加すると、件数方式では 1 になり
 * 新しいタスクが既存行より前に表示される。
 *
 * `listActiveBoardTasksByProject` は `type='task'` の生存タスクだけを返すので、
 * 削除済み・サマリー・マイルストーンは採番に影響しない（カンバンに出ないため）。
 *
 * 呼び出し元（`createTask`）のトランザクション内で使う前提。libSQL は書き込み
 * トランザクションを直列化するため、採番と INSERT の間に別リクエストが割り込んで
 * 同じ値が2件出ることはない。
 */
async function nextBoardOrder(db: Db, projectId: string, status: string): Promise<number> {
  const boardTasks = await listActiveBoardTasksByProject(db, projectId);
  return boardTasks
    .filter((row) => row.status === status)
    .reduce((max, row) => Math.max(max, row.boardOrder + 1), 0);
}

export async function createTask(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  projectId: string,
  input: CreateTaskInput,
) {
  requireLogin(session);

  // 検証（PJ・親タスクの生存、board_order の採番）と INSERT を1つのトランザクションに
  // まとめる。分けたままだと、親の生存を確認したあと INSERT するまでの間に別リクエストが
  // その親を論理削除でき、「アクティブな子を持つ削除済みタスク」という不変条件違反が
  // 生まれる（`lib/tasks/deletion.ts` の `deleteTask` は子が居れば拒否するが、
  // その判定より後に子が INSERT されると擦り抜ける）。`deleteTask` / `indentTask` /
  // `createDependency` と同じ TOCTOU 対策。
  return db.transaction(async (tx) => {
    const project = await getActiveProject(tx, projectId);
    if (!project) {
      throw new NotFoundError("プロジェクトが見つかりません");
    }

    // 検証の順序は変えない。日付チェックを PJ チェックより先に出すと、削除済み PJ への
    // 作成で「日付が不正」と言われ、日付を直して再送すると今度は「PJ が無い」と言われる
    // ことになり、利用者に2往復させてしまう（/code-review の指摘）。
    assertValidDateRange(input.startDate, input.endDate);

    if (input.parentId) {
      const parent = await getActiveTask(tx, input.parentId);
      if (!parent) {
        throw new NotFoundError("親タスクが見つかりません");
      }
      if (parent.projectId !== projectId) {
        throw new ValidationError("親タスクは同じプロジェクト内である必要があります");
      }
    }

    const [task] = await tx
      .insert(tasks)
      .values({
        // `boardOrder` 未指定なら、移動先の列の末尾に採番する。
        // 既定値 0 のままだと、画面から作ったタスクが全て 0 になり
        //   - カンバンの初期表示順が id（cuid2。作成順ではない）依存になる
        //   - `board_order` が正規化されず、並び替えの前提が最初から崩れる（Issue #55）
        // の2つが起きる。`pickEditableTaskFields` より前に置いて、明示指定があれば
        // そちらで上書きされるようにする。
        boardOrder: await nextBoardOrder(tx, projectId, input.status ?? "todo"),
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

    // 子ができた親に `type='summary'` の印を付ける（Issue #59）。決定 D-11 の集計は
    // `type === "summary"` の行しか処理しないため、ここが漏れると「生存する子を持つ
    // `task`」が生まれ、日付・進捗・工数の自動集計が静かに効かなくなる。
    // INSERT と同じトランザクション内で行い、片方だけ反映された状態を残さない。
    await markAsSummary(tx, task.parentId);

    return task;
  });
}

export async function updateTask(
  db: LibSQLDatabase<typeof schema>,
  session: AuthSession | null,
  taskId: string,
  input: UpdateTaskInput,
) {
  requireLogin(session);

  // 親の付け替えは「タスク本体の UPDATE」と「新旧の親の `type` の付け替え」の
  // 最大3行を書き換える。トランザクションでまとめないと、途中で失敗したときに
  // 「子が0件なのに summary」「子が居るのに task」という中途半端な木が残る。
  // 検証と書き込みの間に別リクエストが割り込む TOCTOU（createTask / deleteTask /
  // indentTask と同じ）への対策も兼ねる。
  return db.transaction(async (tx) => {
    const existing = await getActiveTask(tx, taskId);
    if (!existing) {
      throw new NotFoundError("タスクが見つかりません");
    }

    assertValidDateRange(input.startDate ?? existing.startDate, input.endDate ?? existing.endDate);

    if (input.parentId !== undefined && input.parentId !== null) {
      if (input.parentId === taskId) {
        throw new ValidationError("タスクは自分自身を親にできません");
      }

      const parent = await getActiveTask(tx, input.parentId);
      if (!parent) {
        throw new NotFoundError("親タスクが見つかりません");
      }
      if (parent.projectId !== existing.projectId) {
        throw new ValidationError("親タスクは同じプロジェクト内である必要があります");
      }
      if (await isDescendantOf(tx, taskId, input.parentId)) {
        throw new ValidationError("子孫タスクを親にすると循環参照になります");
      }
    }

    const updates = pickEditableTaskFields(input);
    if (Object.keys(updates).length === 0) {
      return existing;
    }

    const [updated] = await tx.update(tasks).set(updates).where(eq(tasks.id, taskId)).returning();

    if (!updated) {
      throw new Error("タスクの更新に失敗しました");
    }

    // 親が実際に変わったときだけ印を付け替える（Issue #59）。`input.parentId` の
    // 有無ではなく更新後の実値と比較するのは、同じ親を指定し直しただけの更新で
    // 余計な UPDATE を撃たないため（`updatedAt` は `$onUpdate` で毎回動く）。
    if (updated.parentId !== existing.parentId) {
      // 新しい親は子を持つようになったので summary に。ルート直下へ移した場合
      // （`parentId: null`）は `markAsSummary` 側が no-op になる。
      await markAsSummary(tx, updated.parentId);
      // 元の親は最後の子が抜けたなら `task` に戻す。他に子が残っていれば
      // `unmarkSummaryIfChildless` 側で何もしない。
      await unmarkSummaryIfChildless(tx, existing.parentId);
    }

    return updated;
  });
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
  // `updateTask` のトランザクション内から呼ぶため、`LibSQLDatabase` ではなく
  // `tx` とも共通の基底型で受ける（`lib/db/queries.ts` の `Db` の注記と同じ理由）。
  db: Db,
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
