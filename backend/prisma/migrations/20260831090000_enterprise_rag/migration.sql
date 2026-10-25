-- Enterprise RAG: ACL, versioned documents, versioned indexes and expert review.

ALTER TABLE `knowledge_bases`
  ADD COLUMN `ownerId` INTEGER NULL,
  ADD COLUMN `visibility` ENUM('PRIVATE', 'SHARED', 'PUBLIC') NOT NULL DEFAULT 'PRIVATE',
  ADD COLUMN `activeIndexVersion` INTEGER NULL,
  ADD COLUMN `candidateIndexVersion` INTEGER NULL,
  ADD COLUMN `indexCanaryPercent` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `minConfidence` DOUBLE NOT NULL DEFAULT 0.55;

UPDATE `knowledge_bases`
SET `ownerId` = (SELECT `id` FROM `users` WHERE `role` = 'ADMIN' ORDER BY `id` LIMIT 1)
WHERE `ownerId` IS NULL;

ALTER TABLE `knowledge_bases`
  ADD INDEX `knowledge_bases_ownerId_idx`(`ownerId`),
  ADD INDEX `knowledge_bases_visibility_idx`(`visibility`),
  ADD CONSTRAINT `knowledge_bases_ownerId_fkey`
    FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `knowledge_base_documents`
  ADD COLUMN `logicalId` VARCHAR(191) NULL,
  ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `isCurrent` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `mimeType` VARCHAR(191) NULL,
  ADD COLUMN `checksum` VARCHAR(191) NULL,
  ADD COLUMN `ownerId` INTEGER NULL,
  ADD COLUMN `visibility` ENUM('INHERIT', 'PRIVATE', 'PUBLIC') NOT NULL DEFAULT 'INHERIT',
  ADD COLUMN `metadata` JSON NULL;

UPDATE `knowledge_base_documents` SET `logicalId` = UUID() WHERE `logicalId` IS NULL;

ALTER TABLE `knowledge_base_documents`
  MODIFY `logicalId` VARCHAR(191) NOT NULL,
  ADD UNIQUE INDEX `knowledge_base_documents_knowledgeBaseId_logicalId_version_key`(`knowledgeBaseId`, `logicalId`, `version`),
  ADD INDEX `knowledge_base_documents_knowledgeBaseId_isCurrent_status_idx`(`knowledgeBaseId`, `isCurrent`, `status`),
  ADD INDEX `knowledge_base_documents_ownerId_idx`(`ownerId`),
  ADD CONSTRAINT `knowledge_base_documents_ownerId_fkey`
    FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `knowledge_base_acls` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `knowledgeBaseId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `permission` ENUM('READ', 'WRITE', 'ADMIN') NOT NULL DEFAULT 'READ',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `knowledge_base_acls_knowledgeBaseId_userId_key`(`knowledgeBaseId`, `userId`),
  INDEX `knowledge_base_acls_userId_permission_idx`(`userId`, `permission`),
  PRIMARY KEY (`id`),
  CONSTRAINT `knowledge_base_acls_knowledgeBaseId_fkey` FOREIGN KEY (`knowledgeBaseId`) REFERENCES `knowledge_bases`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `knowledge_base_acls_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `knowledge_document_acls` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `documentId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `permission` ENUM('READ', 'WRITE', 'ADMIN') NOT NULL DEFAULT 'READ',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `knowledge_document_acls_documentId_userId_key`(`documentId`, `userId`),
  INDEX `knowledge_document_acls_userId_permission_idx`(`userId`, `permission`),
  PRIMARY KEY (`id`),
  CONSTRAINT `knowledge_document_acls_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `knowledge_base_documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `knowledge_document_acls_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `rag_index_versions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `knowledgeBaseId` INTEGER NOT NULL,
  `version` INTEGER NOT NULL,
  `collectionName` VARCHAR(191) NOT NULL,
  `status` ENUM('BUILDING', 'READY', 'ACTIVE', 'ARCHIVED', 'FAILED') NOT NULL DEFAULT 'BUILDING',
  `chunkCount` INTEGER NOT NULL DEFAULT 0,
  `metrics` JSON NULL,
  `error` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `readyAt` DATETIME(3) NULL,
  `activatedAt` DATETIME(3) NULL,
  UNIQUE INDEX `rag_index_versions_collectionName_key`(`collectionName`),
  UNIQUE INDEX `rag_index_versions_knowledgeBaseId_version_key`(`knowledgeBaseId`, `version`),
  INDEX `rag_index_versions_knowledgeBaseId_status_idx`(`knowledgeBaseId`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `rag_index_versions_knowledgeBaseId_fkey` FOREIGN KEY (`knowledgeBaseId`) REFERENCES `knowledge_bases`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `knowledge_chunks` (
  `id` VARCHAR(191) NOT NULL,
  `knowledgeBaseId` INTEGER NOT NULL,
  `indexVersionId` INTEGER NOT NULL,
  `documentId` INTEGER NOT NULL,
  `documentVersion` INTEGER NOT NULL,
  `chunkIndex` INTEGER NOT NULL,
  `content` LONGTEXT NOT NULL,
  `contentHash` VARCHAR(191) NOT NULL,
  `vectorId` VARCHAR(191) NOT NULL,
  `page` INTEGER NULL,
  `chapter` VARCHAR(191) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `knowledge_chunks_vectorId_key`(`vectorId`),
  UNIQUE INDEX `knowledge_chunks_version_chunk_key`(`indexVersionId`, `documentId`, `documentVersion`, `chunkIndex`),
  INDEX `knowledge_chunks_knowledgeBaseId_indexVersionId_idx`(`knowledgeBaseId`, `indexVersionId`),
  INDEX `knowledge_chunks_documentId_documentVersion_idx`(`documentId`, `documentVersion`),
  PRIMARY KEY (`id`),
  CONSTRAINT `knowledge_chunks_knowledgeBaseId_fkey` FOREIGN KEY (`knowledgeBaseId`) REFERENCES `knowledge_bases`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `knowledge_chunks_indexVersionId_fkey` FOREIGN KEY (`indexVersionId`) REFERENCES `rag_index_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `knowledge_chunks_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `knowledge_base_documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE FULLTEXT INDEX `knowledge_chunks_content_fulltext`
  ON `knowledge_chunks`(`content`) WITH PARSER ngram;

CREATE TABLE `rag_review_tasks` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `knowledgeBaseId` INTEGER NOT NULL,
  `requesterId` INTEGER NOT NULL,
  `assignedToId` INTEGER NULL,
  `question` TEXT NOT NULL,
  `rewrittenQuery` TEXT NULL,
  `evidence` JSON NULL,
  `confidence` DOUBLE NOT NULL,
  `status` ENUM('PENDING', 'IN_REVIEW', 'RESOLVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  `expertAnswer` LONGTEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `resolvedAt` DATETIME(3) NULL,
  INDEX `rag_review_tasks_knowledgeBaseId_status_createdAt_idx`(`knowledgeBaseId`, `status`, `createdAt`),
  INDEX `rag_review_tasks_requesterId_status_idx`(`requesterId`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `rag_review_tasks_knowledgeBaseId_fkey` FOREIGN KEY (`knowledgeBaseId`) REFERENCES `knowledge_bases`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `rag_review_tasks_requesterId_fkey` FOREIGN KEY (`requesterId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `rag_review_tasks_assignedToId_fkey` FOREIGN KEY (`assignedToId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
