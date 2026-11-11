CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer,
	`problem_id` integer NOT NULL,
	`type` text NOT NULL,
	`scheduled_date` text NOT NULL,
	`original_date` text NOT NULL,
	`cohort_week` text,
	`position` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`completed_at` integer,
	`completed_date` text,
	`completed_session_id` text,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `study_plans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`problem_id`) REFERENCES `problems`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `assignments_date_idx` ON `assignments` (`scheduled_date`,`status`);--> statement-breakpoint
CREATE INDEX `assignments_problem_idx` ON `assignments` (`problem_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_weekend_uq` ON `assignments` (`problem_id`,`cohort_week`) WHERE type = 'weekend_review';--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_open_uq` ON `assignments` (`problem_id`,`type`) WHERE status in ('pending','in_progress');--> statement-breakpoint
CREATE TABLE `daily_snapshots` (
	`date` text PRIMARY KEY NOT NULL,
	`due_count` integer NOT NULL,
	`overdue_count` integer NOT NULL,
	`mastery` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plan_days` (
	`plan_id` integer NOT NULL,
	`date` text NOT NULL,
	`new_allocated_at` integer,
	`srs_allocated_at` integer,
	PRIMARY KEY(`plan_id`, `date`),
	FOREIGN KEY (`plan_id`) REFERENCES `study_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plan_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer NOT NULL,
	`problem_id` integer NOT NULL,
	`position` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source_list_id` integer,
	`added_manually` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `study_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`problem_id`) REFERENCES `problems`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_list_id`) REFERENCES `study_lists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_queue_plan_problem_uq` ON `plan_queue` (`plan_id`,`problem_id`);--> statement-breakpoint
CREATE INDEX `plan_queue_order_idx` ON `plan_queue` (`plan_id`,`status`,`position`);--> statement-breakpoint
CREATE TABLE `plan_skips` (
	`plan_id` integer NOT NULL,
	`date` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`plan_id`, `date`),
	FOREIGN KEY (`plan_id`) REFERENCES `study_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `problem_note_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`problem_id` integer NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`problem_id`) REFERENCES `problems`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `problem_notes` (
	`problem_id` integer PRIMARY KEY NOT NULL,
	`insight` text DEFAULT '' NOT NULL,
	`recognition` text DEFAULT '' NOT NULL,
	`time_complexity` text DEFAULT '' NOT NULL,
	`space_complexity` text DEFAULT '' NOT NULL,
	`edge_cases` text DEFAULT '' NOT NULL,
	`pitfalls` text DEFAULT '' NOT NULL,
	`related` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`problem_id`) REFERENCES `problems`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `problems` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text DEFAULT 'leetcode' NOT NULL,
	`platform_question_id` text,
	`frontend_id` text,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`difficulty` text DEFAULT 'Unknown' NOT NULL,
	`url` text NOT NULL,
	`topics` text DEFAULT '[]' NOT NULL,
	`patterns` text DEFAULT '[]' NOT NULL,
	`paid_only` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `problems_platform_slug_uq` ON `problems` (`platform`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `problems_platform_qid_uq` ON `problems` (`platform`,`platform_question_id`) WHERE platform_question_id is not null;--> statement-breakpoint
CREATE INDEX `problems_frontend_idx` ON `problems` (`frontend_id`);--> statement-breakpoint
CREATE TABLE `review_state` (
	`problem_id` integer PRIMARY KEY NOT NULL,
	`stage` text DEFAULT 'learning' NOT NULL,
	`interval_days` integer DEFAULT 0 NOT NULL,
	`next_due_date` text,
	`last_reviewed_date` text,
	`last_outcome` text,
	`success_streak` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`review_count` integer DEFAULT 0 NOT NULL,
	`first_practiced_date` text,
	`postponed_to` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`problem_id`) REFERENCES `problems`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_state_due_idx` ON `review_state` (`next_due_date`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`problem_id` integer NOT NULL,
	`assignment_id` integer,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`ended_date` text,
	`paused_at` integer,
	`paused_ms` integer DEFAULT 0 NOT NULL,
	`active_ms` integer,
	`duration_override_ms` integer,
	`last_activity_at` integer,
	`first_accepted_at` integer,
	`outcome` text,
	`hints_used` integer DEFAULT false NOT NULL,
	`revealed_hints` integer DEFAULT false NOT NULL,
	`revealed_notes` integer DEFAULT false NOT NULL,
	`revealed_code` integer DEFAULT false NOT NULL,
	`difficulty_rating` integer,
	`notes` text,
	`struggles` text,
	`takeaway` text,
	`mistakes` text,
	`patterns` text,
	`recommended_review_date` text,
	`next_review_date` text,
	`next_review_overridden` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`problem_id`) REFERENCES `problems`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sessions_problem_idx` ON `sessions` (`problem_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `sessions_ended_idx` ON `sessions` (`ended_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_one_open_uq` ON `sessions` (`problem_id`) WHERE status in ('not_started','in_progress','paused');--> statement-breakpoint
CREATE TABLE `study_list_problems` (
	`list_id` integer NOT NULL,
	`problem_id` integer NOT NULL,
	`position` integer NOT NULL,
	`group_name` text,
	PRIMARY KEY(`list_id`, `problem_id`),
	FOREIGN KEY (`list_id`) REFERENCES `study_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`problem_id`) REFERENCES `problems`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slp_list_position_uq` ON `study_list_problems` (`list_id`,`position`);--> statement-breakpoint
CREATE TABLE `study_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`source` text DEFAULT 'leetcode' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `study_lists_slug_unique` ON `study_lists` (`slug`);--> statement-breakpoint
CREATE TABLE `study_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`start_date` text NOT NULL,
	`time_zone` text NOT NULL,
	`settings` text NOT NULL,
	`paused_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text,
	`problem_id` integer NOT NULL,
	`kind` text DEFAULT 'submit' NOT NULL,
	`platform_submission_id` text,
	`fingerprint` text NOT NULL,
	`code` text,
	`language` text,
	`verdict` text DEFAULT 'Unknown' NOT NULL,
	`status_code` integer,
	`runtime` text,
	`memory` text,
	`total_correct` integer,
	`total_testcases` integer,
	`details` text,
	`submitted_at` integer NOT NULL,
	`judged_at` integer,
	`capture_source` text NOT NULL,
	`attribution` text DEFAULT 'none' NOT NULL,
	`sync_event_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`problem_id`) REFERENCES `problems`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_platform_uq` ON `submissions` (`platform_submission_id`) WHERE platform_submission_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_fingerprint_uq` ON `submissions` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `submissions_session_idx` ON `submissions` (`session_id`);--> statement-breakpoint
CREATE INDEX `submissions_problem_idx` ON `submissions` (`problem_id`,`submitted_at`);--> statement-breakpoint
CREATE TABLE `sync_events` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`session_id` text,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`client_created_at` integer NOT NULL,
	`received_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_events_received_idx` ON `sync_events` (`received_at`);