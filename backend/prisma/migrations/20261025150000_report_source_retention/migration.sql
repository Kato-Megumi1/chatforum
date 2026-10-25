-- Keep case history when the reported post is later hard-deleted.
ALTER TABLE `reports` ADD COLUMN `postId` INTEGER NULL;
UPDATE `reports` SET `postId` = `targetId`;
ALTER TABLE `reports` DROP FOREIGN KEY `reports_targetId_fkey`;
ALTER TABLE `reports` ADD CONSTRAINT `reports_postId_fkey`
  FOREIGN KEY (`postId`) REFERENCES `posts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
