-- Share model rework (design §4, stage 1). `shares`/`share_tokens` rows are
-- intentionally discarded here rather than migrated: password/size_limit/
-- include_raws have no equivalent in the new role-based model, and `title`/
-- `source_type` have no source column to backfill from. `images` is a
-- rebuildable cache untouched by this migration.
--
-- Statement ORDER is load-bearing under `PRAGMA foreign_keys=ON` (set in
-- db/index.ts): DROP TABLE performs an implicit DELETE FROM first, so a child
-- table must be dropped before its parent and created after it. Dropping
-- `shares` while `share_tokens` still holds rows raises "FOREIGN KEY
-- constraint failed" — a failure that only reproduces on a database that
-- already has share rows, i.e. production, never a fresh test db.
DROP TABLE `share_tokens`;--> statement-breakpoint
DROP TABLE `shares`;--> statement-breakpoint
CREATE TABLE `shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`source_type` text NOT NULL,
	`root` text,
	`dir` text,
	`min_rating` integer,
	`expires_at` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shares_slug_unique` ON `shares` (`slug`);--> statement-breakpoint
CREATE TABLE `share_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`share_id` integer NOT NULL,
	`token` text NOT NULL,
	`role` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_tokens_token_unique` ON `share_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `share_images` (
	`share_id` integer NOT NULL,
	`image_id` integer NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`share_id`, `image_id`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_images_share_id_idx` ON `share_images` (`share_id`);
