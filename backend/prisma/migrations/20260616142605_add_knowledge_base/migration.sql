/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `prompt_templates` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `chat_messages` MODIFY `content` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `comments` MODIFY `content` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `posts` MODIFY `content` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `prompt_templates` MODIFY `content` VARCHAR(191) NOT NULL;

-- CreateTable
CREATE TABLE `knowledge_bases` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `embeddingApiKey` VARCHAR(191) NULL,
    `embeddingApiBase` VARCHAR(191) NULL,
    `embeddingModel` VARCHAR(191) NOT NULL DEFAULT 'text-embedding-3-small',
    `chunkSize` INTEGER NOT NULL DEFAULT 500,
    `chunkOverlap` INTEGER NOT NULL DEFAULT 50,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `knowledge_bases_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_base_documents` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fileName` VARCHAR(191) NOT NULL,
    `fileType` VARCHAR(191) NOT NULL,
    `fileSize` INTEGER NOT NULL,
    `filePath` VARCHAR(191) NOT NULL,
    `chunkCount` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `knowledgeBaseId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `prompt_templates_name_key` ON `prompt_templates`(`name`);

-- AddForeignKey
ALTER TABLE `knowledge_base_documents` ADD CONSTRAINT `knowledge_base_documents_knowledgeBaseId_fkey` FOREIGN KEY (`knowledgeBaseId`) REFERENCES `knowledge_bases`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
