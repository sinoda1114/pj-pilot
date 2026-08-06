CREATE TABLE `project_members` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_members_role_check" CHECK("project_members"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`dependency_sync_enabled` integer DEFAULT true NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_deleted_at_idx` ON `projects` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `task_assignees` (
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`predecessor_id` text NOT NULL,
	`successor_id` text NOT NULL,
	`type` text DEFAULT 'FS' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`predecessor_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`successor_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_dependencies_type_check" CHECK("task_dependencies"."type" IN ('FS')),
	CONSTRAINT "task_dependencies_no_self_reference" CHECK("task_dependencies"."predecessor_id" != "task_dependencies"."successor_id")
);
--> statement-breakpoint
CREATE INDEX `task_dependencies_project_id_idx` ON `task_dependencies` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_dependencies_predecessor_successor_unique` ON `task_dependencies` (`predecessor_id`,`successor_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`type` text DEFAULT 'task' NOT NULL,
	`estimated_hours` real,
	`actual_hours` real,
	`is_pinned` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_priority_check" CHECK("tasks"."priority" IN ('low', 'medium', 'high', 'urgent')),
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" IN ('todo', 'in_progress', 'review', 'done')),
	CONSTRAINT "tasks_type_check" CHECK("tasks"."type" IN ('task', 'summary', 'milestone')),
	CONSTRAINT "tasks_progress_check" CHECK("tasks"."progress" BETWEEN 0 AND 100),
	CONSTRAINT "tasks_estimated_hours_check" CHECK("tasks"."estimated_hours" IS NULL OR "tasks"."estimated_hours" >= 0),
	CONSTRAINT "tasks_actual_hours_check" CHECK("tasks"."actual_hours" IS NULL OR "tasks"."actual_hours" >= 0),
	CONSTRAINT "tasks_no_self_parent_check" CHECK("tasks"."parent_id" IS NULL OR "tasks"."parent_id" != "tasks"."id")
);
--> statement-breakpoint
CREATE INDEX `tasks_project_id_deleted_at_idx` ON `tasks` (`project_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `tasks_parent_id_idx` ON `tasks` (`parent_id`);