/**
 * アプリケーションドメインのスキーマ（docs/IMPLEMENTATION_PLAN.md §4）。
 *
 * 認証まわり（user / session / account / verification）はここに含めない。
 * `@better-auth/cli generate` の出力を別ファイルとして追加する予定だが、
 * 2026-08-06 時点で better-auth 本体に未修正の Critical 脆弱性
 * （OAuth 関連、修正版未公開）があるため導入を保留している。
 * 認証実装まではユーザー参照カラムを外部キー制約なしの text で持ち、
 * 認証テーブルが追加され次第 FK を張るマイグレーションを別途行う。
 */

import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { createId } from "@paralleldrive/cuid2";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
};

export const projects = sqliteTable(
  "projects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    description: text("description"),
    // 依存連動ON/OFF ①PJ単位（決定 D-... §5.1手順1）
    dependencySyncEnabled: integer("dependency_sync_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    // 論理削除。NULL = 生存（決定 D-03）
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (table) => [index("projects_deleted_at_idx").on(table.deletedAt)],
);

/**
 * PJ メンバーと権限。閲覧は全ログインユーザーに開いている（決定 D-08）ため、
 * このテーブルは可視性の制御には使わない。role='owner' が PJ 削除権限を持つ
 * （決定 D-15）。userId は認証テーブル追加まで FK 制約なし。
 */
export const projectMembers = sqliteTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "member"] })
      .notNull()
      .default("member"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    // enum は TypeScript 側の型付けのみで SQL の CHECK にはならないため、
    // 生の SQL やアプリ層のバグで無効な値が入るのを DB レベルでも防ぐ（多層防御）。
    check("project_members_role_check", sql`${table.role} IN ('owner', 'member')`),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    // WBS階層。NULL = ルート。自己参照
    parentId: text("parent_id").references((): AnySQLiteColumn => tasks.id),
    title: text("title").notNull(),
    // date-only 'YYYY-MM-DD'（§3.2 の規約。タイムゾーン変換をしない）
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    progress: integer("progress").notNull().default(0),
    priority: text("priority", { enum: ["low", "medium", "high", "urgent"] })
      .notNull()
      .default("medium"),
    status: text("status", { enum: ["todo", "in_progress", "review", "done"] })
      .notNull()
      .default("todo"),
    type: text("type", { enum: ["task", "summary", "milestone"] })
      .notNull()
      .default("task"),
    estimatedHours: real("estimated_hours"),
    actualHours: real("actual_hours"),
    // 依存連動ON/OFF ②タスク単位ピン留め
    isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
    // 同一 parentId 内の表示順
    sortOrder: integer("sort_order").notNull().default(0),
    // 論理削除。NULL = 生存（決定 D-03）
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (table) => [
    index("tasks_project_id_deleted_at_idx").on(table.projectId, table.deletedAt),
    index("tasks_parent_id_idx").on(table.parentId),
    // enum は TypeScript 側の型付けのみで SQL の CHECK にはならないため、
    // 生の SQL やアプリ層のバグで無効な値が入るのを DB レベルでも防ぐ（多層防御）。
    check("tasks_priority_check", sql`${table.priority} IN ('low', 'medium', 'high', 'urgent')`),
    check("tasks_status_check", sql`${table.status} IN ('todo', 'in_progress', 'review', 'done')`),
    check("tasks_type_check", sql`${table.type} IN ('task', 'summary', 'milestone')`),
  ],
);

/** 複数担当者の中間テーブル。userId は認証テーブル追加まで FK 制約なし。 */
export const taskAssignees = sqliteTable(
  "task_assignees",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    userId: text("user_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.userId] })],
);

/**
 * 依存関係。初版は FS（type='FS' 固定）のみ。ラグ属性は持たない
 * （ギャップ維持型の連動により、バー間の隙間が実質ラグとして機能するため）。
 */
export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    predecessorId: text("predecessor_id")
      .notNull()
      .references(() => tasks.id),
    successorId: text("successor_id")
      .notNull()
      .references(() => tasks.id),
    type: text("type", { enum: ["FS"] })
      .notNull()
      .default("FS"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("task_dependencies_project_id_idx").on(table.projectId),
    unique("task_dependencies_predecessor_successor_unique").on(
      table.predecessorId,
      table.successorId,
    ),
    // 初版は FS 固定（§4.3）。SS/FF/SF を追加するときはここも合わせて変更する。
    check("task_dependencies_type_check", sql`${table.type} IN ('FS')`),
  ],
);
