CREATE TABLE `chat_attachments` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `conversationId` INTEGER NOT NULL,
  `name` VARCHAR(180) NOT NULL,
  `kind` VARCHAR(12) NOT NULL,
  `mime` VARCHAR(100) NOT NULL,
  `bytes` INTEGER NOT NULL,
  `data` LONGBLOB NOT NULL,
  `text` MEDIUMTEXT NOT NULL,
  `pages` JSON NOT NULL,
  `pageCount` INTEGER NOT NULL DEFAULT 0,
  `needsVision` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `chat_attachments_conversationId_name_key` (`conversationId`,`name`),
  CONSTRAINT `chat_attachments_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
