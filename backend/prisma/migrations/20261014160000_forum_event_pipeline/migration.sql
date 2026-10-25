-- Additive forum pipeline state only. Existing accounts, forum bodies, counters and novel indexes remain untouched.
CREATE TABLE `forum_events` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `eventKey` VARCHAR(36) NOT NULL,
  `kind` VARCHAR(48) NOT NULL,
  `postId` INTEGER NOT NULL,
  `postRevision` INTEGER NOT NULL,
  `actorId` INTEGER NULL,
  `payloadJson` JSON NOT NULL,
  `occurredAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `forum_events_eventKey_key` (`eventKey`),
  INDEX `forum_events_postId_id_idx` (`postId`, `id`),
  INDEX `forum_events_createdAt_id_idx` (`createdAt`, `id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `forum_event_deliveries` (
  `eventId` BIGINT NOT NULL,
  `consumer` VARCHAR(80) NOT NULL,
  `state` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `leaseToken` VARCHAR(36) NULL,
  `leaseUntil` DATETIME(3) NULL,
  `errorCode` VARCHAR(64) NULL,
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `forum_delivery_ready` (`consumer`, `state`, `availableAt`, `eventId`),
  INDEX `forum_delivery_expired` (`state`, `leaseUntil`, `eventId`),
  PRIMARY KEY (`eventId`, `consumer`),
  CONSTRAINT `forum_event_deliveries_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `forum_events` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `forum_read_model_states` (
  `key` VARCHAR(120) NOT NULL,
  `payloadJson` JSON NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'IDLE',
  `cursor` BIGINT NULL,
  `metadataJson` JSON NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `forum_interaction_buckets` (
  `postId` INTEGER NOT NULL,
  `hour` DATETIME(3) NOT NULL,
  `viewDelta` BIGINT NOT NULL DEFAULT 0,
  `likeDelta` INTEGER NOT NULL DEFAULT 0,
  `commentDelta` INTEGER NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `forum_interaction_buckets_hour_postId_idx` (`hour`, `postId`),
  PRIMARY KEY (`postId`, `hour`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `forum_view_batches` (
  `id` VARCHAR(100) NOT NULL,
  `payloadHash` VARCHAR(64) NOT NULL,
  `postId` INTEGER NULL,
  `count` INTEGER NOT NULL DEFAULT 0,
  `bucketStart` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `forum_view_batches_createdAt_idx` (`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `forum_subscriptions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `conversationId` INTEGER NULL,
  `filterKey` VARCHAR(64) NOT NULL,
  `kind` VARCHAR(24) NOT NULL,
  `filtersJson` JSON NOT NULL,
  `categoryId` INTEGER NULL,
  `postId` INTEGER NULL,
  `anchorKey` VARCHAR(8) NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `cooldownSeconds` INTEGER NOT NULL DEFAULT 3600,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `forum_subscriptions_userId_filterKey_key` (`userId`, `filterKey`),
  INDEX `forum_subscription_candidates` (`enabled`, `kind`, `categoryId`, `anchorKey`, `id`),
  INDEX `forum_subscriptions_enabled_postId_id_idx` (`enabled`, `postId`, `id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `forum_subscriptions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `forum_subscription_deliveries` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `subscriptionId` INTEGER NOT NULL,
  `windowStart` DATETIME(3) NOT NULL,
  `notificationId` INTEGER NULL,
  `userId` INTEGER NOT NULL,
  `count` INTEGER NOT NULL DEFAULT 0,
  `postIdsJson` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `forum_subscription_deliveries_subscriptionId_windowStart_key` (`subscriptionId`, `windowStart`),
  INDEX `forum_subscription_deliveries_userId_createdAt_idx` (`userId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `forum_subscription_deliveries_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `forum_subscriptions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
