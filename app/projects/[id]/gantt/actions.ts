"use server";

/**
 * Gantt画面のドラッグ操作（移動・リサイズ・依存の追加/削除）を扱う Server Actions
 * （M4）。伝播ロジック本体は `lib/scheduling/propagate.ts`（DB非依存の純粋関数）に
 * あり、ここではセッション取得・DB取得・永続化・エラーの戻り値変換だけを行う。
 */

import { revalidatePath } from "next/cache";
import { isValidDateOnly } from "../../../../lib/dates/date-only";
import { requireLogin } from "../../../../lib/auth/authz";
import { ForbiddenError, UnauthorizedError } from "../../../../lib/auth/errors";
import { getSession } from "../../../../lib/auth/session";
import { db } from "../../../../lib/db";
import {
  getActiveProject,
  listAllTasksByProject,
  listDependenciesByProject,
} from "../../../../lib/db/queries";
import { createDependency, deleteDependency } from "../../../../lib/dependencies/service";
import { NotFoundError, ValidationError } from "../../../../lib/errors";
import { toDependencies, toScheduleTasks } from "../../../../lib/scheduling/adapter";
import { persistPropagateResult } from "../../../../lib/scheduling/persist";
import { moveTask, resizeTaskEnd } from "../../../../lib/scheduling/propagate";
import type { PropagateResult } from "../../../../lib/scheduling/types";
import { recomputeAndPersistAncestorSummaries } from "../../../../lib/tasks/summary";

export type PropagateActionResult =
  | { ok: true; result: PropagateResult }
  | { ok: false; message: string };

export type ActionResult = { ok: true } | { ok: false; message: string };

function toActionError(error: unknown): { ok: false; message: string } | never {
  if (
    error instanceof UnauthorizedError ||
    error instanceof ForbiddenError ||
    error instanceof NotFoundError ||
    error instanceof ValidationError
  ) {
    return { ok: false, message: error.message };
  }
  throw error;
}

/** 100年分。通常のドラッグ操作ではまず到達しない、妥当な範囲の上限。 */
const MAX_DELTA_DAYS = 36500;

async function runPropagation(
  projectId: string,
  taskId: string,
  deltaDays: number,
  bypassSync: boolean,
  kind: "move" | "resize",
): Promise<PropagateActionResult> {
  try {
    requireLogin(await getSession());

    // Server Action は直接呼び出し可能な公開エンドポイントでもあるため、
    // ブラウザのGantt操作という前提を信頼せず、`deltaDays` がここで壊れて
    // いないか検証する。`NaN`/`Infinity`/極端な値をそのまま
    // `addDaysToDateOnly` に渡すと、DBに不正な日付文字列
    // （`NaN-NaN-NaN`等）が書き込まれてしまう。
    if (!Number.isInteger(deltaDays) || Math.abs(deltaDays) > MAX_DELTA_DAYS) {
      throw new ValidationError("移動量が不正です");
    }

    const project = await getActiveProject(db, projectId);
    if (!project) {
      throw new NotFoundError("プロジェクトが見つかりません");
    }

    const dbTasks = await listAllTasksByProject(db, projectId);
    const target = dbTasks.find((t) => t.id === taskId);
    if (!target || target.deletedAt) {
      throw new NotFoundError("タスクが見つかりません");
    }

    const dbDependencies = await listDependenciesByProject(db, projectId);

    const input = {
      taskId,
      deltaDays,
      tasks: toScheduleTasks(dbTasks),
      dependencies: toDependencies(dbDependencies),
      dependencySyncEnabled: project.dependencySyncEnabled,
      bypassSync,
    };

    const result = kind === "move" ? moveTask(input) : resizeTaskEnd(input);

    await persistPropagateResult(db, result);

    revalidatePath(`/projects/${projectId}/gantt`);
    revalidatePath(`/projects/${projectId}/tasks`);

    return { ok: true, result };
  } catch (error) {
    return toActionError(error);
  }
}

/** タスクバーの移動確定（決定D-01: ΔはSVARが返す整数の日数をそのまま使う）。 */
export async function moveTaskAction(
  projectId: string,
  taskId: string,
  deltaDays: number,
  bypassSync: boolean,
): Promise<PropagateActionResult> {
  return runPropagation(projectId, taskId, deltaDays, bypassSync, "move");
}

/** タスクバーのリサイズ確定（終了日のみΔシフト、決定D-01）。 */
export async function resizeTaskEndAction(
  projectId: string,
  taskId: string,
  deltaDays: number,
  bypassSync: boolean,
): Promise<PropagateActionResult> {
  return runPropagation(projectId, taskId, deltaDays, bypassSync, "resize");
}

/**
 * 直前1回の伝播を取り消す（§5.4）。クライアントが保持している「変更前の日付」を
 * そのまま書き戻すだけで、再度伝播ロジックを走らせるわけではない
 * （取り消し操作自体が新たな依存連動を引き起こすと直感に反するため）。
 * 日付を戻した後、影響を受けたタスクの祖先サマリーを再計算する。
 */
export async function undoDateChangesAction(
  projectId: string,
  changes: { id: string; startDate: string; endDate: string }[],
): Promise<ActionResult> {
  try {
    requireLogin(await getSession());

    const project = await getActiveProject(db, projectId);
    if (!project) {
      throw new NotFoundError("プロジェクトが見つかりません");
    }

    // `changes` はクライアントが保持していた値をそのまま送り返してくる。
    // ここで `projectId` に属するタスクかどうかを検証しないと、ログイン済みの
    // 誰もが任意の他プロジェクトのタスクIDを指定して日付を書き換えられてしまう
    // （IDOR）。§4.4(c) の「素の db.select() を書かず lib/db/queries.ts を通す」
    // 規約に沿って取得したタスク一覧と突き合わせる。
    const dbTasks = await listAllTasksByProject(db, projectId);
    const validTaskIds = new Set(dbTasks.map((t) => t.id));
    const isInvalid = changes.some(
      (c) => !validTaskIds.has(c.id) || !isValidDateOnly(c.startDate) || !isValidDateOnly(c.endDate),
    );
    if (isInvalid) {
      throw new ValidationError("元に戻す内容が不正です");
    }

    await persistPropagateResult(db, {
      changes: changes.map((c) => ({
        id: c.id,
        before: { startDate: c.startDate, endDate: c.endDate },
        after: { startDate: c.startDate, endDate: c.endDate },
      })),
      skipped: [],
      summaryUpdates: [],
    });

    for (const change of changes) {
      await recomputeAndPersistAncestorSummaries(db, change.id);
    }

    revalidatePath(`/projects/${projectId}/gantt`);
    revalidatePath(`/projects/${projectId}/tasks`);

    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

/** Gantt上での依存作成（FS固定、決定は`lib/dependencies/service.ts`側で検証済み）。 */
export async function createDependencyAction(
  projectId: string,
  predecessorId: string,
  successorId: string,
): Promise<ActionResult> {
  try {
    const session = await getSession();
    await createDependency(db, session, projectId, predecessorId, successorId);
    revalidatePath(`/projects/${projectId}/gantt`);
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteDependencyAction(
  projectId: string,
  dependencyId: string,
): Promise<ActionResult> {
  try {
    const session = await getSession();
    await deleteDependency(db, session, dependencyId);
    revalidatePath(`/projects/${projectId}/gantt`);
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
