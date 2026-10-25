-- Re-enabling a watcher establishes a new event-time boundary; no disabled-period replay.
ALTER TABLE `forum_subscriptions` ADD COLUMN `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
