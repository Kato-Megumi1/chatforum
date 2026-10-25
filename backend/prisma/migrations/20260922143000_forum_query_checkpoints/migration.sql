CREATE TABLE `forum_query_checkpoints` (
  `conversationId` INTEGER NOT NULL,
  `filterKey` VARCHAR(64) NOT NULL,
  `queriedAt` DATETIME(3) NOT NULL,
  `snapshot` JSON NOT NULL,
  PRIMARY KEY (`conversationId`, `filterKey`),
  INDEX `forum_query_checkpoints_conversationId_queriedAt_idx` (`conversationId`, `queriedAt`),
  CONSTRAINT `forum_query_checkpoints_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `posts_status_categoryId_createdAt_id_idx` ON `posts` (`status`, `categoryId`, `createdAt`, `id`);
