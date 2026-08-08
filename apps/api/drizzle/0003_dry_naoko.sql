CREATE TABLE `image_keywords` (
	`image_id` integer NOT NULL,
	`path` text NOT NULL,
	`leaf` text NOT NULL,
	PRIMARY KEY(`image_id`, `path`),
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `image_keywords_path_idx` ON `image_keywords` (`path`);