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

    // 「終了日 ≧ 開始日」は全 CRUD 経路が守っている不変条件（`lib/tasks/service.ts` の
    // `assertValidDateRange`）。リサイズは終了日だけを Δ シフトするため、大きく縮める
    // 値を渡すと逆転した日付をそのまま書き込めてしまう（実測: -30 で
    // 2026-08-10〜2026-07-13）。SVAR 側にバー幅の clamp があるため Gantt の UI からは
    // 起こせないが、Server Action は直接呼べる公開エンドポイントなので、
    // `deltaDays` の範囲チェックと同じ趣旨でここでも守る。
    // 逆転データが入ると Gantt の描画と伝播計算が壊れ、フォームは「終了日は開始日以降」
    // で弾くため UI からは直せなくなる。
    // 判定は**操作対象のタスク1件だけ**を見る。
    //
    // 逆転を新たに作れるのはリサイズ（終了日だけを Δ シフトする）の対象タスクに限られる。
    // 後続タスクは start/end を同じ Δ だけずらすので区間の長さが変わらず、サマリーの
    // 日付は子から導出した結果でしかない。
    //
    // 一方で `result.changes` 全体を見ると、旧バグ等で**既に**逆転している行の巻き添えで
    // 正常な操作まで拒否されてしまう。実測で確認した2パターン:
    //   - 逆転行へ伝播する無関係なタスクのドラッグが全拒否され、逆転行自身の移動も
    //     拒否されるため Gantt から修復できなくなる（/code-review の指摘）
    //   - 逆転した子を1件持つサマリーは、再集計の結果 `before` 正常 → `after` 逆転に
    //     なる（実測: 2026-08-01〜08-20 → 2026-08-13〜07-16）。`/code-review` は
    //     「サマリーは逆転しない」としていたが誤りで、Cursor Bugbot の指摘が正しかった
    // 条件は2つとも必要:
    //   - **操作対象1件だけ**を見る（サマリーや後続の巻き添えを避ける）
    //   - その1件が**新たに**逆転した場合のみ弾く（`before` 正常 → `after` 逆転）
    // 移動は start/end を同じ Δ だけずらす平行移動なので、既に逆転している行を動かしても
    // 逆転を作りも直しもしない。`after` だけを見て弾くと、旧バグ由来の逆転行を Gantt 上で
    // 動かすことすらできなくなる（Cursor Bugbot の指摘。再現を確認した）。
    const targetChange = result.changes.find((change) => change.id === taskId);
    const newlyInverted =
      targetChange !== undefined &&
      targetChange.before.endDate >= targetChange.before.startDate &&
      targetChange.after.endDate < targetChange.after.startDate;
    if (newlyInverted) {
      throw new ValidationError("終了日は開始日以降である必要があります");
    }

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

    // **先に**削除済みタスクを落とす。`listAllTasksByProject` は削除済みも返すため
    // （伝播が「後続が削除済みか」を見るために必要）、絞らないとゴミ箱の中のタスクの
    // 日付まで書き換わる。一方でドラッグ確定から「元に戻す」を押すまでの間に別の誰かが
    // 1件削除しただけで payload 全体を弾くと、他の正常なタスクまで戻せなくなる。
    //
    // 検証より前に落とすのが要点。順序が逆だと、削除済みタスクのスナップショットが
    // 旧バグ由来の逆転した日付を持っていた場合に payload 全体が弾かれ、「削除済みは
    // 除外して残りは戻す」という意図が働かない（Cursor Bugbot の指摘。実測で確認）。
    const deletedIds = new Set(dbTasks.filter((t) => t.deletedAt !== null).map((t) => t.id));
    const applicable = changes.filter((c) => !deletedIds.has(c.id));

    // 残った分を検証する。他プロジェクトの ID・壊れた日付・逆転した日付が1つでもあれば
    // 全体を拒否する（正規の Undo payload には現れない＝改竄とみなす）。
    // 終了日 ≧ 開始日 は全経路で守っている不変条件（`lib/tasks/service.ts` の
    // `assertValidDateRange`）。ここだけ抜けていると逆転した日付を注入され、Gantt の
    // 描画と伝播計算が壊れたうえ、フォームが弾くので UI からは直せなくなる。
    const validTaskIds = new Set(dbTasks.map((t) => t.id));
    const isInvalid = applicable.some(
      (c) =>
        !validTaskIds.has(c.id) ||
        !isValidDateOnly(c.startDate) ||
        !isValidDateOnly(c.endDate) ||
        c.endDate < c.startDate,
    );
    if (isInvalid) {
      throw new ValidationError("元に戻す内容が不正です");
    }

    await persistPropagateResult(db, {
      changes: applicable.map((c) => ({
        id: c.id,
        before: { startDate: c.startDate, endDate: c.endDate },
        after: { startDate: c.startDate, endDate: c.endDate },
      })),
      skipped: [],
      summaryUpdates: [],
    });

    for (const change of applicable) {
      await recomputeAndPersistAncestorSummaries(db, change.id);
    }

    revalidatePath(`/projects/${projectId}/gantt`);
    revalidatePath(`/projects/${projectId}/tasks`);

    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export type CreateDependencyActionResult =
  | { ok: true; dependencyId: string }
  | { ok: false; message: string };

/** Gantt上での依存作成（FS固定、決定は`lib/dependencies/service.ts`側で検証済み）。 */
export async function createDependencyAction(
  projectId: string,
  predecessorId: string,
  successorId: string,
): Promise<CreateDependencyActionResult> {
  try {
    const session = await getSession();
    const dependency = await createDependency(db, session, projectId, predecessorId, successorId);
    revalidatePath(`/projects/${projectId}/gantt`);
    return { ok: true, dependencyId: dependency.id };
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

    // `dependencyId` が本当にこの `projectId` に属するかを検証してから削除する。
    // `lib/dependencies/service.ts` の `deleteDependency` は `dependencyId` だけで
    // 削除できる既存実装（決定D-15と同様、依存の削除も全ログインユーザーに
    // 開いている）だが、Server Action は直接呼び出し可能な公開エンドポイントで
    // もあるため、ログイン済みの誰もが無関係な他プロジェクトの `dependencyId` を
    // 渡して削除できてしまう（Cursor Bugbot指摘、undoで直したIDORと同種）。
    const projectDependencies = await listDependenciesByProject(db, projectId);
    if (!projectDependencies.some((d) => d.id === dependencyId)) {
      throw new NotFoundError("依存が見つかりません");
    }

    await deleteDependency(db, session, dependencyId);
    revalidatePath(`/projects/${projectId}/gantt`);
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
