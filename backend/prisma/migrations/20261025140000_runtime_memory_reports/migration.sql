-- AlterTable
ALTER TABLE `notifications` ADD COLUMN `relatedReportId` INTEGER NULL;

-- AlterTable
ALTER TABLE `reports` ADD COLUMN `clientRequestId` VARCHAR(36) NULL,
    ADD COLUMN `commentId` INTEGER NULL,
    ADD COLUMN `decidedAt` DATETIME(3) NULL,
    ADD COLUMN `decidedById` INTEGER NULL,
    ADD COLUMN `decision` VARCHAR(16) NULL,
    ADD COLUMN `decisionReason` TEXT NULL,
    ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `targetRevision` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `targetUpdatedAt` DATETIME(3) NULL,
    ADD COLUMN `targetUserId` INTEGER NULL,
    MODIFY `reason` TEXT NOT NULL;

-- CreateTable
CREATE TABLE `chat_tool_steps` (
    `id` VARCHAR(36) NOT NULL,
    `runId` VARCHAR(36) NOT NULL,
    `stepKey` CHAR(64) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `toolName` VARCHAR(80) NOT NULL,
    `effect` VARCHAR(12) NOT NULL,
    `policyVersion` VARCHAR(40) NOT NULL,
    `argsHash` CHAR(64) NOT NULL,
    `arguments` JSON NOT NULL,
    `result` JSON NULL,
    `state` VARCHAR(24) NOT NULL,
    `sourceEpoch` INTEGER NOT NULL,
    `authVersion` INTEGER NOT NULL,
    `workerToken` VARCHAR(36) NULL,
    `approvedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `chat_tool_steps_runId_sequence_idx`(`runId`, `sequence`),
    INDEX `chat_tool_steps_state_updatedAt_idx`(`state`, `updatedAt`),
    UNIQUE INDEX `chat_tool_steps_runId_stepKey_key`(`runId`, `stepKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `memory_rebuild_jobs` (
    `conversationId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `personaKey` VARCHAR(80) NOT NULL,
    `epoch` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    `workerToken` VARCHAR(36) NULL,
    `leaseUntil` DATETIME(3) NULL,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `errorCode` VARCHAR(40) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `memory_rebuild_jobs_status_nextAttemptAt_leaseUntil_idx`(`status`, `nextAttemptAt`, `leaseUntil`),
    PRIMARY KEY (`conversationId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `conversation_memory_pins` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `conversationId` INTEGER NOT NULL,
    `personaKey` VARCHAR(80) NOT NULL,
    `sourceIds` JSON NOT NULL,
    `sourceHash` CHAR(64) NOT NULL,
    `text` TEXT NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `conversation_memory_pins_userId_conversationId_id_idx`(`userId`, `conversationId`, `id`),
    UNIQUE INDEX `conversation_memory_pins_conversationId_sourceHash_key`(`conversationId`, `sourceHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `conversation_memory_suppressions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `conversationId` INTEGER NOT NULL,
    `messageId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `conversation_memory_suppressions_userId_conversationId_idx`(`userId`, `conversationId`),
    UNIQUE INDEX `conversation_memory_suppressions_conversationId_messageId_key`(`conversationId`, `messageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `report_appeals` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reportId` INTEGER NOT NULL,
    `appellantId` INTEGER NOT NULL,
    `reason` TEXT NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `revision` INTEGER NOT NULL DEFAULT 1,
    `decisionReason` TEXT NULL,
    `decidedById` INTEGER NULL,
    `decidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `report_appeals_reportId_key`(`reportId`),
    INDEX `report_appeals_appellantId_createdAt_id_idx`(`appellantId`, `createdAt`, `id`),
    INDEX `report_appeals_status_createdAt_id_idx`(`status`, `createdAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE FULLTEXT INDEX `memory_episode_ngram` ON `conversation_episodes`(`text`) WITH PARSER ngram;

-- CreateIndex
CREATE INDEX `reports_reporterId_createdAt_id_idx` ON `reports`(`reporterId`, `createdAt`, `id`);

-- CreateIndex
CREATE INDEX `reports_targetUserId_createdAt_id_idx` ON `reports`(`targetUserId`, `createdAt`, `id`);

-- CreateIndex
CREATE INDEX `reports_status_createdAt_id_idx` ON `reports`(`status`, `createdAt`, `id`);

-- CreateIndex
CREATE UNIQUE INDEX `reports_reporterId_clientRequestId_key` ON `reports`(`reporterId`, `clientRequestId`);

-- AddForeignKey
ALTER TABLE `chat_tool_steps` ADD CONSTRAINT `chat_tool_steps_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `chat_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `memory_rebuild_jobs` ADD CONSTRAINT `memory_rebuild_jobs_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `conversation_memory_pins` ADD CONSTRAINT `conversation_memory_pins_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `conversation_memory_suppressions` ADD CONSTRAINT `conversation_memory_suppressions_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `conversation_memory_suppressions` ADD CONSTRAINT `conversation_memory_suppressions_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `chat_messages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `report_appeals` ADD CONSTRAINT `report_appeals_reportId_fkey` FOREIGN KEY (`reportId`) REFERENCES `reports`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


