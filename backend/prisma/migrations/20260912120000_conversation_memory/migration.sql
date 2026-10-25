CREATE TABLE `conversation_memories` (
  `conversationId` INTEGER NOT NULL,
  `personaKey` VARCHAR(80) NOT NULL,
  `revision` VARCHAR(64) NOT NULL,
  `snapshot` JSON NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`conversationId`, `personaKey`),
  CONSTRAINT `conversation_memories_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
