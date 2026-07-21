CREATE TABLE `b2_objects` (
	`key` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`last_modified` text NOT NULL,
	`etag` text,
	`mirrored_at` text,
	`published_image_id` integer,
	`first_seen_at` text NOT NULL,
	FOREIGN KEY (`published_image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`root` text NOT NULL,
	`rel_path` text NOT NULL,
	`dir` text NOT NULL,
	`stem` text NOT NULL,
	`ext` text NOT NULL,
	`kind` text NOT NULL,
	`file_size` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`capture_at` text,
	`orientation` integer,
	`rating` integer,
	`width` integer,
	`height` integer,
	`raw_path` text,
	`indexed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `images_root_rel_path_uq` ON `images` (`root`,`rel_path`);--> statement-breakpoint
CREATE INDEX `images_dir_idx` ON `images` (`dir`);--> statement-breakpoint
CREATE INDEX `images_capture_at_idx` ON `images` (`capture_at`);--> statement-breakpoint
CREATE INDEX `images_rating_idx` ON `images` (`rating`);--> statement-breakpoint
CREATE TABLE `share_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`share_id` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_tokens_token_unique` ON `share_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`root` text NOT NULL,
	`dir` text NOT NULL,
	`min_rating` integer,
	`size_limit` text NOT NULL,
	`include_raws` integer DEFAULT 0 NOT NULL,
	`password_hash` text,
	`expires_at` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shares_slug_unique` ON `shares` (`slug`);