-- Additive only: existing posts, accounts, comments and counters remain untouched.
ALTER TABLE `posts` ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 1;
ALTER TABLE `posts` ADD COLUMN `contentFormat` VARCHAR(16) NOT NULL DEFAULT 'markdown';
ALTER TABLE `notifications` ADD COLUMN `relatedCommentId` INTEGER NULL;
CREATE FULLTEXT INDEX `posts_title_content_fulltext` ON `posts` (`title`, `content`) WITH PARSER ngram;
CREATE INDEX `comments_postId_status_createdAt_id_idx` ON `comments` (`postId`, `status`, `createdAt`, `id`);
CREATE INDEX `notifications_userId_isRead_createdAt_id_idx` ON `notifications` (`userId`, `isRead`, `createdAt`, `id`);
CREATE INDEX `notifications_userId_createdAt_id_idx` ON `notifications` (`userId`, `createdAt`, `id`);
CREATE TABLE `post_view_receipts` (
  `postId` INTEGER NOT NULL,
  `viewerHash` VARCHAR(64) NOT NULL,
  `viewedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`postId`, `viewerHash`),
  INDEX `post_view_receipts_viewedAt_idx` (`viewedAt`),
  CONSTRAINT `post_view_receipts_postId_fkey` FOREIGN KEY (`postId`) REFERENCES `posts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
