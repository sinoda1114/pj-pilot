ALTER TABLE `tasks` ADD `board_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `tasks` SET `board_order` = (
  SELECT COUNT(*) FROM `tasks` AS t2
   WHERE t2.`project_id` = `tasks`.`project_id`
     AND t2.`status`     = `tasks`.`status`
     AND ( t2.`created_at` <  `tasks`.`created_at`
        OR (t2.`created_at` = `tasks`.`created_at` AND t2.`id` < `tasks`.`id`) )
);--> statement-breakpoint
CREATE INDEX `tasks_project_status_board_order_idx` ON `tasks` (`project_id`,`status`,`board_order`);
