CREATE TABLE `plan_light_days` (
	`plan_id` integer NOT NULL,
	`date` text NOT NULL,
	`new_quota` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`plan_id`, `date`),
	FOREIGN KEY (`plan_id`) REFERENCES `study_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
