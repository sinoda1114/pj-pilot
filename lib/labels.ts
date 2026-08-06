/**
 * 表示ラベル層（M1 #11b / 決定 D-17〜D-19）。
 *
 * DB は英字の enum 値のみを持ち、日本語は表示のためだけにこの1ファイルに集約する。
 * 画面のどこにも DB 値を直接出さない。語彙を変えたくなってもマイグレーションが
 * 不要になり、URL のフィルター条件（`?priority=high` 等）も壊れない。
 */

import type { InferSelectModel } from "drizzle-orm";
import type { projectMembers, tasks } from "./db/schema";

type Priority = InferSelectModel<typeof tasks>["priority"];
type Status = InferSelectModel<typeof tasks>["status"];
type TaskType = InferSelectModel<typeof tasks>["type"];
type ProjectRole = InferSelectModel<typeof projectMembers>["role"];

/** 決定 D-18 */
const PRIORITY_LABELS: Record<Priority, string> = {
  low: "低",
  medium: "中",
  high: "高",
  urgent: "緊急",
};

/** 決定 D-19 */
const STATUS_LABELS: Record<Status, string> = {
  todo: "未着手",
  in_progress: "対応中",
  review: "確認中",
  done: "完了",
};

const TASK_TYPE_LABELS: Record<TaskType, string> = {
  task: "タスク",
  summary: "サマリー",
  milestone: "マイルストーン",
};

const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = {
  owner: "オーナー",
  member: "メンバー",
};

export function priorityLabel(value: Priority): string {
  return PRIORITY_LABELS[value];
}

export function statusLabel(value: Status): string {
  return STATUS_LABELS[value];
}

export function taskTypeLabel(value: TaskType): string {
  return TASK_TYPE_LABELS[value];
}

export function projectRoleLabel(value: ProjectRole): string {
  return PROJECT_ROLE_LABELS[value];
}
