ALTER TABLE `chat_messages` ADD COLUMN `ragMetadata` JSON NULL;
ALTER TABLE `knowledge_bases` ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `knowledge_base_documents` ADD COLUMN `isDeleted` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `rag_index_versions`
  ADD COLUMN `workerToken` VARCHAR(191) NULL,
  ADD COLUMN `leaseUntil` DATETIME(3) NULL,
  ADD COLUMN `manifest` JSON NULL;
ALTER TABLE `rag_review_tasks` ADD COLUMN `reason` TEXT NULL;
