/**
 * 依存連動の伝播ロジック（lib/scheduling/propagate.ts）が扱うドメイン型。
 * DB スキーマ（docs/IMPLEMENTATION_PLAN.md §4）とは意図的に分離した、
 * この純粋関数モジュール専用の最小限の形。DB も React も import しない。
 */

export type TaskType = "task" | "summary" | "milestone";

export interface ScheduleTask {
  id: string;
  parentId: string | null;
  type: TaskType;
  startDate: string; // date-only 'YYYY-MM-DD'
  endDate: string; // date-only 'YYYY-MM-DD'
  progress: number; // 0-100
  estimatedHours: number | null;
  actualHours: number | null;
  isPinned: boolean;
  /** 論理削除フラグ（決定 D-06: 削除済みタスクは依存グラフから除外し、そこで枝を打ち切る） */
  isDeleted: boolean;
}

export interface Dependency {
  predecessorId: string;
  successorId: string;
}

export interface DateChange {
  startDate: string;
  endDate: string;
}

export interface TaskChange {
  id: string;
  before: DateChange;
  after: DateChange;
}

/** 伝播が枝を打ち切った理由。トーストでの通知に使う（§5.4）。 */
export type SkipReason = "pinned" | "deleted" | "summary";

export interface SkippedTask {
  id: string;
  reason: SkipReason;
}

/** サマリータスクの再集計結果（決定 D-11: 工数は単純合計、進捗は見積工数による加重平均）。 */
export interface SummaryAggregate {
  id: string;
  progress: number;
  estimatedHours: number;
  actualHours: number;
}

export interface PropagateResult {
  /** T 自身を含む、日付が変わったすべてのタスク（サマリーの日付再計算結果も含む）。 */
  changes: TaskChange[];
  /** ピン留め・削除済みで伝播が打ち切られたタスク。 */
  skipped: SkippedTask[];
  /** 子の変更を受けて再集計されたサマリータスクの進捗・工数。 */
  summaryUpdates: SummaryAggregate[];
}
