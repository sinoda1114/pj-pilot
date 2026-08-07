/**
 * DB のタスク/依存関係の行を、`propagate.ts` が扱う `ScheduleTask`/`Dependency`
 * （DB非依存の最小限の型、`lib/scheduling/types.ts`）に変換するアダプタ。
 */

import type { Dependency, ScheduleTask, TaskType } from "./types";

export interface DbTaskForScheduling {
  id: string;
  parentId: string | null;
  type: TaskType;
  startDate: string;
  endDate: string;
  progress: number;
  estimatedHours: number | null;
  actualHours: number | null;
  isPinned: boolean;
  deletedAt: Date | null;
}

export interface DbDependencyForScheduling {
  predecessorId: string;
  successorId: string;
}

export function toScheduleTasks(dbTasks: DbTaskForScheduling[]): ScheduleTask[] {
  return dbTasks.map((t) => ({
    id: t.id,
    parentId: t.parentId,
    type: t.type,
    startDate: t.startDate,
    endDate: t.endDate,
    progress: t.progress,
    estimatedHours: t.estimatedHours,
    actualHours: t.actualHours,
    isPinned: t.isPinned,
    isDeleted: t.deletedAt !== null,
  }));
}

export function toDependencies(dbDependencies: DbDependencyForScheduling[]): Dependency[] {
  return dbDependencies.map((d) => ({
    predecessorId: d.predecessorId,
    successorId: d.successorId,
  }));
}
