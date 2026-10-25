CREATE TABLE `coding_files` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `conversationId` INTEGER NOT NULL,
  `path` VARCHAR(180) NOT NULL,
  `content` MEDIUMTEXT NOT NULL,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `bytes` INTEGER NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `coding_files_conversationId_path_key` (`conversationId`, `path`),
  CONSTRAINT `coding_files_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `coding_changes` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `conversationId` INTEGER NOT NULL,
  `path` VARCHAR(180) NOT NULL,
  `baseRevision` INTEGER NOT NULL,
  `before` MEDIUMTEXT NOT NULL,
  `after` MEDIUMTEXT NOT NULL,
  `description` VARCHAR(240) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `coding_changes_conversationId_status_createdAt_idx` (`conversationId`, `status`, `createdAt`),
  CONSTRAINT `coding_changes_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
