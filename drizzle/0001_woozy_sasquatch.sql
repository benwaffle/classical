CREATE TABLE `metadata_migration_audit` (
	`id` integer PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text,
	`decision` text NOT NULL,
	`reason` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metadata_migration_audit_entity_source_idx` ON `metadata_migration_audit` (`entity_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `metadata_migration_audit_decision_idx` ON `metadata_migration_audit` (`decision`);--> statement-breakpoint
CREATE TABLE `recording_track_v2` (
	`recording_id` integer NOT NULL,
	`spotify_track_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`recording_id`, `spotify_track_id`),
	FOREIGN KEY (`recording_id`) REFERENCES `recording_v2`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`spotify_track_id`) REFERENCES `spotify_track`(`spotify_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recording_track_v2_track_idx` ON `recording_track_v2` (`spotify_track_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recording_track_v2_position_idx` ON `recording_track_v2` (`recording_id`,`position`);--> statement-breakpoint
CREATE TABLE `recording_v2` (
	`id` integer PRIMARY KEY NOT NULL,
	`spotify_album_id` text NOT NULL,
	`work_id` integer NOT NULL,
	`popularity` integer,
	FOREIGN KEY (`spotify_album_id`) REFERENCES `spotify_album`(`spotify_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_id`) REFERENCES `work`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recording_v2_work_idx` ON `recording_v2` (`work_id`);--> statement-breakpoint
CREATE INDEX `recording_v2_album_idx` ON `recording_v2` (`spotify_album_id`);--> statement-breakpoint
CREATE TABLE `track_work_part_v2` (
	`spotify_track_id` text NOT NULL,
	`work_part_id` integer NOT NULL,
	`start_ms` integer,
	`end_ms` integer,
	`match_source` text DEFAULT 'migrated' NOT NULL,
	`match_status` text DEFAULT 'needs_review' NOT NULL,
	PRIMARY KEY(`spotify_track_id`, `work_part_id`),
	FOREIGN KEY (`spotify_track_id`) REFERENCES `spotify_track`(`spotify_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_part_id`) REFERENCES `work_part_v2`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `track_work_part_v2_part_idx` ON `track_work_part_v2` (`work_part_id`);--> statement-breakpoint
CREATE INDEX `track_work_part_v2_status_idx` ON `track_work_part_v2` (`match_status`);--> statement-breakpoint
CREATE TABLE `work_catalog_v2` (
	`id` integer PRIMARY KEY NOT NULL,
	`work_id` integer NOT NULL,
	`system` text NOT NULL,
	`number` text NOT NULL,
	`normalized_system` text NOT NULL,
	`normalized_number` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`work_id`) REFERENCES `work`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_catalog_v2_work_idx` ON `work_catalog_v2` (`work_id`);--> statement-breakpoint
CREATE INDEX `work_catalog_v2_lookup_idx` ON `work_catalog_v2` (`normalized_system`,`normalized_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_catalog_v2_work_catalog_idx` ON `work_catalog_v2` (`work_id`,`normalized_system`,`normalized_number`);--> statement-breakpoint
CREATE TABLE `work_part_v2` (
	`id` integer PRIMARY KEY NOT NULL,
	`work_id` integer NOT NULL,
	`position` integer NOT NULL,
	`label` text,
	`title` text,
	FOREIGN KEY (`work_id`) REFERENCES `work`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_part_v2_work_idx` ON `work_part_v2` (`work_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_part_v2_work_position_idx` ON `work_part_v2` (`work_id`,`position`);--> statement-breakpoint
ALTER TABLE `spotify_track` ADD `disc_number` integer DEFAULT 1 NOT NULL;