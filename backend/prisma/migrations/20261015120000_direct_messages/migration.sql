-- New user-to-user messaging domain only; existing accounts, hashes and AI history stay unchanged.
CREATE TABLE `direct_message_threads` (
 `id` INTEGER NOT NULL AUTO_INCREMENT,
 `userLowId` INTEGER NOT NULL, `userHighId` INTEGER NOT NULL,
 `initiatorId` INTEGER NOT NULL, `recipientId` INTEGER NOT NULL,
 `state` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
 `lastMessageId` BIGINT NOT NULL DEFAULT 0, `lastMessageAt` DATETIME(3) NULL,
 `lowReadMessageId` BIGINT NOT NULL DEFAULT 0, `highReadMessageId` BIGINT NOT NULL DEFAULT 0,
 `lowUnread` INTEGER NOT NULL DEFAULT 0, `highUnread` INTEGER NOT NULL DEFAULT 0,
 `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
 PRIMARY KEY (`id`), UNIQUE INDEX `direct_message_threads_userLowId_userHighId_key` (`userLowId`,`userHighId`),
 INDEX `direct_message_threads_userLowId_lastMessageId_id_idx` (`userLowId`,`lastMessageId`,`id`),
 INDEX `direct_message_threads_userHighId_lastMessageId_id_idx` (`userHighId`,`lastMessageId`,`id`),
 INDEX `direct_message_threads_recipientId_state_lastMessageId_id_idx` (`recipientId`,`state`,`lastMessageId`,`id`),
 CONSTRAINT `direct_message_threads_userLowId_fkey` FOREIGN KEY (`userLowId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT `direct_message_threads_userHighId_fkey` FOREIGN KEY (`userHighId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `direct_messages` (
 `id` BIGINT NOT NULL AUTO_INCREMENT, `threadId` INTEGER NOT NULL, `senderId` INTEGER NOT NULL,
 `clientMessageId` VARCHAR(36) NOT NULL, `content` TEXT NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY (`id`), UNIQUE INDEX `direct_messages_senderId_clientMessageId_key` (`senderId`,`clientMessageId`),
 INDEX `direct_messages_threadId_id_idx` (`threadId`,`id`), INDEX `direct_messages_threadId_senderId_id_idx` (`threadId`,`senderId`,`id`),
 CONSTRAINT `direct_messages_threadId_fkey` FOREIGN KEY (`threadId`) REFERENCES `direct_message_threads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT `direct_messages_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `direct_message_blocks` (
 `id` INTEGER NOT NULL AUTO_INCREMENT, `blockerId` INTEGER NOT NULL, `blockedId` INTEGER NOT NULL,
 `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
 UNIQUE INDEX `direct_message_blocks_blockerId_blockedId_key` (`blockerId`,`blockedId`),
 INDEX `direct_message_blocks_blockedId_blockerId_idx` (`blockedId`,`blockerId`),
 CONSTRAINT `direct_message_blocks_blockerId_fkey` FOREIGN KEY (`blockerId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT `direct_message_blocks_blockedId_fkey` FOREIGN KEY (`blockedId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
