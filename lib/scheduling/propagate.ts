/**
 * 依存連動（ギャップ維持型）の伝播ロジック。docs/IMPLEMENTATION_PLAN.md §5 を実装する。
 *
 * DB にも React にも依存しない純粋関数群。呼び出し側（Server Action）が
 * ScheduleTask[] / Dependency[] を渡し、変更結果を受け取って永続化する。
 *
 * アルゴリズムの要点（§5.1）:
 *   1. T 自身の日付は常に更新する（移動 or リサイズ）。
 *   2. PJ の連動トグル OFF、または修飾キー押下時は T のみで終了する。
 *   3. task_dependencies を有向グラフとみなし、T から到達可能な後続を
 *      トポロジカル順（実装上は BFS で十分）に走査する。
 *   4. 削除済み・ピン留めのタスクは動かさず、そこで枝を打ち切る（決定 D-06）。
 *   5. 訪問済みノードは再シフトしない（合流時の二重適用防止、T-5）。
 *   6. 影響を受けたタスクの祖先 summary を、子の日付/工数/進捗から
 *      深い方から順に再計算する（ボトムアップ、決定 D-11）。
 */

import { addDaysToDateOnly } from "../dates/date-only";
import type {
  DateChange,
  Dependency,
  PropagateResult,
  ScheduleTask,
  SkipReason,
  SummaryAggregate,
  TaskChange,
} from "./types";

interface PropagateInput {
  taskId: string;
  deltaDays: number;
  tasks: ScheduleTask[];
  dependencies: Dependency[];
  dependencySyncEnabled: boolean;
  /** Shift ドラッグ等、ドラッグ操作時だけ連動を一時的に切る修飾キー（決定 D-08 の§5.1 手順2）。 */
  bypassSync?: boolean;
}

function shiftDates(dates: DateChange, deltaDays: number): DateChange {
  return {
    startDate: addDaysToDateOnly(dates.startDate, deltaDays),
    endDate: addDaysToDateOnly(dates.endDate, deltaDays),
  };
}

function toDateChange(t: ScheduleTask): DateChange {
  return { startDate: t.startDate, endDate: t.endDate };
}

/**
 * T から到達可能な後続を辿り、動かせるタスクに Δ を適用する。
 * ピン留め・削除済みのタスクに達したら、そこで枝を打ち切る（そのタスク自身は動かさない）。
 */
function propagateToSuccessors(
  startId: string,
  deltaDays: number,
  tasksById: Map<string, ScheduleTask>,
  successorsOf: Map<string, string[]>,
  visited: Set<string>,
): { changedIds: string[]; skipped: { id: string; reason: SkipReason }[] } {
  const changedIds: string[] = [];
  const skipped: { id: string; reason: SkipReason }[] = [];
  const queue = [...(successorsOf.get(startId) ?? [])];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);

    const successor = tasksById.get(id);
    if (!successor) {
      continue;
    }

    if (successor.isDeleted) {
      skipped.push({ id, reason: "deleted" });
      continue; // このタスクより先へは伝播しない
    }
    if (successor.isPinned) {
      skipped.push({ id, reason: "pinned" });
      continue; // このタスクより先へは伝播しない
    }

    changedIds.push(id);
    queue.push(...(successorsOf.get(id) ?? []));
  }

  return { changedIds, skipped };
}

/**
 * summary タスクの progress/estimatedHours/actualHours を、直接の子から集計する
 * （決定 D-11: 工数は単純合計、進捗は見積工数による加重平均。見積が無い子は重み 1）。
 *
 * ドラッグ操作による伝播（moveTask/resizeTaskEnd 内の recomputeAncestorSummaries）と、
 * タスク CRUD 経由の再集計（lib/tasks/summary.ts）の両方から呼ばれる、この2経路で
 * 数式が食い違わないようにするための唯一の計算箇所。DB も React も参照しない純粋関数。
 */
export function aggregateSummaryValues(
  children: Pick<ScheduleTask, "progress" | "estimatedHours" | "actualHours">[],
): Pick<SummaryAggregate, "progress" | "estimatedHours" | "actualHours"> {
  const estimatedHours = children.reduce((sum, c) => sum + (c.estimatedHours ?? 0), 0);
  const actualHours = children.reduce((sum, c) => sum + (c.actualHours ?? 0), 0);
  const weightedSum = children.reduce((sum, c) => sum + c.progress * (c.estimatedHours ?? 1), 0);
  const totalWeight = children.reduce((sum, c) => sum + (c.estimatedHours ?? 1), 0);
  const progress = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  return { progress, estimatedHours, actualHours };
}

function buildSuccessorMap(dependencies: Dependency[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const { predecessorId, successorId } of dependencies) {
    if (!map.has(predecessorId)) {
      map.set(predecessorId, []);
    }
    map.get(predecessorId)!.push(successorId);
  }
  return map;
}

/**
 * タスクの深さ（ルートからの距離）。summary 再計算をボトムアップで処理する順序決めに使う。
 *
 * `parentId` はこのモジュールの外側（アプリ層）で作られる WBS 階層であり、依存グラフの
 * `wouldCreateCycle` のような事前チェックが無い。データ不整合等で循環した親子関係が
 * 渡された場合でもスタックオーバーフローで丸ごとクラッシュしないよう、探索中のノードを
 * 記録して循環を検出したら深さ 0 として打ち切る。
 */
function computeDepths(tasks: ScheduleTask[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depths = new Map<string, number>();

  function depthOf(id: string, visiting: Set<string>): number {
    const cached = depths.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(id)) {
      return 0; // 循環した parentId チェーン。これ以上遡らない。
    }
    visiting.add(id);

    const t = byId.get(id);
    const depth = t?.parentId ? depthOf(t.parentId, visiting) + 1 : 0;
    depths.set(id, depth);
    return depth;
  }

  for (const t of tasks) {
    depthOf(t.id, new Set());
  }
  return depths;
}

/**
 * 変更されたタスクの祖先 summary を、深い方（子に近い方）から順に再計算する。
 * 日付は子の min(start)/max(end)、工数は単純合計、進捗は見積工数による加重平均
 * （見積が無い子は重み 1 の均等重みとして混ぜる。決定 D-11）。
 */
function recomputeAncestorSummaries(
  changedIds: string[],
  tasksById: Map<string, ScheduleTask>,
  childrenOf: Map<string, string[]>,
  depths: Map<string, number>,
): { dateChanges: TaskChange[]; summaryUpdates: SummaryAggregate[] } {
  const ancestorIds = new Set<string>();
  for (const id of changedIds) {
    const visited = new Set<string>([id]);
    let parentId = tasksById.get(id)?.parentId ?? null;
    // parentId が循環している不整合データでも無限ループしないよう、訪問済みで打ち切る
    // （computeDepths の depthOf と同じ理由。§9 参照）。
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      ancestorIds.add(parentId);
      parentId = tasksById.get(parentId)?.parentId ?? null;
    }
  }

  const orderedAncestors = [...ancestorIds].sort(
    (a, b) => (depths.get(b) ?? 0) - (depths.get(a) ?? 0),
  );

  const dateChanges: TaskChange[] = [];
  const summaryUpdates: SummaryAggregate[] = [];

  // 深い祖先から先に再計算することで、孫summaryの最新値を親summaryの集計に使える。
  const latestById = new Map<string, ScheduleTask>();

  for (const id of orderedAncestors) {
    const summary = tasksById.get(id);
    if (!summary) {
      continue;
    }
    const children = (childrenOf.get(id) ?? [])
      .map((childId) => latestById.get(childId) ?? tasksById.get(childId))
      .filter((c): c is ScheduleTask => c !== undefined);

    if (children.length === 0) {
      continue;
    }

    const startDate = children.map((c) => c.startDate).reduce((min, d) => (d < min ? d : min));
    const endDate = children.map((c) => c.endDate).reduce((max, d) => (d > max ? d : max));

    const { progress, estimatedHours, actualHours } = aggregateSummaryValues(children);

    const before = toDateChange(summary);
    const after = { startDate, endDate };
    const updated: ScheduleTask = {
      ...summary,
      startDate,
      endDate,
      progress,
      estimatedHours,
      actualHours,
    };
    latestById.set(id, updated);

    if (before.startDate !== after.startDate || before.endDate !== after.endDate) {
      dateChanges.push({ id, before, after });
    }
    summaryUpdates.push({ id, progress, estimatedHours, actualHours });
  }

  return { dateChanges, summaryUpdates };
}

function buildChildrenMap(tasks: ScheduleTask[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const t of tasks) {
    if (!t.parentId) {
      continue;
    }
    if (!map.has(t.parentId)) {
      map.set(t.parentId, []);
    }
    map.get(t.parentId)!.push(t.id);
  }
  return map;
}

/**
 * 共通の伝播処理。T 自身の新しい日付（selfAfter）は呼び出し側（moveTask / resizeTaskEnd）が
 * 決め、この関数は「Δ をどう後続へ伝播するか」だけを担う。
 */
function runPropagation(input: PropagateInput, selfAfter: DateChange): PropagateResult {
  const { taskId, deltaDays, tasks, dependencies, dependencySyncEnabled, bypassSync } = input;

  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const target = tasksById.get(taskId);
  if (!target) {
    throw new Error(`task not found: ${taskId}`);
  }

  const changes: TaskChange[] = [{ id: taskId, before: toDateChange(target), after: selfAfter }];

  const shouldPropagate = dependencySyncEnabled && !bypassSync;

  let skipped: { id: string; reason: SkipReason }[] = [];
  const changedIds = [taskId];

  if (shouldPropagate) {
    const successorsOf = buildSuccessorMap(dependencies);
    const visited = new Set<string>([taskId]);
    const result = propagateToSuccessors(taskId, deltaDays, tasksById, successorsOf, visited);
    skipped = result.skipped;

    for (const id of result.changedIds) {
      const t = tasksById.get(id)!;
      const before = toDateChange(t);
      const after = shiftDates(before, deltaDays);
      changes.push({ id, before, after });
      changedIds.push(id);
    }
  }

  // 変更後の日付を反映した最新状態を使って summary を再計算する。
  const updatedTasksById = new Map(tasksById);
  for (const change of changes) {
    const original = updatedTasksById.get(change.id);
    if (original) {
      updatedTasksById.set(change.id, {
        ...original,
        startDate: change.after.startDate,
        endDate: change.after.endDate,
      });
    }
  }

  const childrenOf = buildChildrenMap(tasks);
  const depths = computeDepths(tasks);
  const { dateChanges: summaryDateChanges, summaryUpdates } = recomputeAncestorSummaries(
    changedIds,
    updatedTasksById,
    childrenOf,
    depths,
  );

  return {
    changes: [...changes, ...summaryDateChanges],
    skipped,
    summaryUpdates,
  };
}

/** タスクをドラッグで Δ 日移動する（start・end とも Δ シフト）。 */
export function moveTask(input: PropagateInput): PropagateResult {
  const target = input.tasks.find((t) => t.id === input.taskId);
  if (!target) {
    throw new Error(`task not found: ${input.taskId}`);
  }
  const selfAfter = shiftDates(toDateChange(target), input.deltaDays);
  return runPropagation(input, selfAfter);
}

/**
 * タスクのバーをリサイズして終了日だけを Δ 日動かす（決定 D-01）。
 * 開始日は変えず、後続への伝播は移動時と同じ Δ を使う。
 */
export function resizeTaskEnd(input: PropagateInput): PropagateResult {
  const target = input.tasks.find((t) => t.id === input.taskId);
  if (!target) {
    throw new Error(`task not found: ${input.taskId}`);
  }
  const selfAfter: DateChange = {
    startDate: target.startDate,
    endDate: addDaysToDateOnly(target.endDate, input.deltaDays),
  };
  return runPropagation(input, selfAfter);
}

/**
 * `predecessorId → successorId` の依存を追加した場合にサイクルができるかを判定する。
 * 依存の作成時（Server Action）にこの関数で事前チェックし、true なら追加を拒否する（§5.2）。
 */
export function wouldCreateCycle(
  dependencies: Dependency[],
  predecessorId: string,
  successorId: string,
): boolean {
  if (predecessorId === successorId) {
    return true; // 自己参照は常にサイクル
  }

  const successorsOf = buildSuccessorMap(dependencies);
  // successorId から辿って predecessorId に戻ってこられるなら、
  // predecessorId → successorId を足した瞬間にサイクルになる。
  const visited = new Set<string>();
  const stack = [successorId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === predecessorId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    stack.push(...(successorsOf.get(current) ?? []));
  }

  return false;
}
