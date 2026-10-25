ALTER TABLE `rag_index_versions` ADD COLUMN `graphVersion` VARCHAR(64) NULL;
CREATE TABLE `legacy_imports` (
 `fingerprint` VARCHAR(64) NOT NULL, `report` JSON NOT NULL,
 `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`fingerprint`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `novel_entity_mentions` (
 `id` INTEGER NOT NULL AUTO_INCREMENT, `indexVersionId` INTEGER NOT NULL,
 `graphVersion` VARCHAR(64) NOT NULL, `chunkId` VARCHAR(191) NOT NULL, `entityKey` VARCHAR(64) NOT NULL,
 PRIMARY KEY (`id`), UNIQUE INDEX `novel_mentions_chunk_entity_key` (`chunkId`,`graphVersion`,`entityKey`),
 INDEX `novel_mentions_lookup` (`indexVersionId`,`graphVersion`,`entityKey`),
 CONSTRAINT `novel_mentions_chunk_fk` FOREIGN KEY (`chunkId`) REFERENCES `knowledge_chunks` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `novel_graph_scenes` (
 `id` VARCHAR(64) NOT NULL, `indexVersionId` INTEGER NOT NULL, `graphVersion` VARCHAR(64) NOT NULL,
 `status` VARCHAR(16) NOT NULL, `workerToken` VARCHAR(36) NULL, `leaseUntil` DATETIME(3) NULL,
 `metrics` JSON NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY (`id`), INDEX `novel_graph_scenes_indexVersionId_graphVersion_status_idx` (`indexVersionId`,`graphVersion`,`status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `novel_graph_facts` (
 `id` VARCHAR(36) NOT NULL, `sceneId` VARCHAR(64) NOT NULL, `indexVersionId` INTEGER NOT NULL,
 `chunkId` VARCHAR(191) NOT NULL, `subjectKey` VARCHAR(64) NOT NULL, `predicate` VARCHAR(32) NOT NULL,
 `targetKey` VARCHAR(64) NULL, `objectText` VARCHAR(200) NOT NULL, `quote` TEXT NOT NULL,
 `speakerKey` VARCHAR(64) NULL, `chapter` VARCHAR(191) NULL,
 PRIMARY KEY (`id`), INDEX `novel_graph_entity_path` (`indexVersionId`,`subjectKey`,`targetKey`),
 INDEX `novel_graph_facts_chunkId_idx` (`chunkId`),
 CONSTRAINT `novel_graph_facts_scene_fk` FOREIGN KEY (`sceneId`) REFERENCES `novel_graph_scenes` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT `novel_graph_facts_chunk_fk` FOREIGN KEY (`chunkId`) REFERENCES `knowledge_chunks` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
