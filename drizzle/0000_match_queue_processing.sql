ALTER TABLE `match_queue` ADD COLUMN `spotify_album_id` text;
--> statement-breakpoint
ALTER TABLE `match_queue` ADD COLUMN `attempts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `match_queue` ADD COLUMN `last_attempt_at` integer;
--> statement-breakpoint
ALTER TABLE `match_queue` ADD COLUMN `processed_at` integer;
--> statement-breakpoint
ALTER TABLE `match_queue` ADD COLUMN `error_message` text;
--> statement-breakpoint
ALTER TABLE `match_queue` ADD COLUMN `workflow_run_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `match_queue_status_idx` ON `match_queue` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `match_queue_album_idx` ON `match_queue` (`spotify_album_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `match_queue_status_album_idx` ON `match_queue` (`status`,`spotify_album_id`);
