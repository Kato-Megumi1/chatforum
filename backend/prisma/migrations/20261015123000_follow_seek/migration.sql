-- Keep the uniqueness constraint and foreign keys. These covering leading keys
-- serve the actual outgoing/incoming id-seek order, not the old inverted names.
CREATE INDEX `follows_followerId_id_idx` ON `follows` (`followerId`, `id`);
CREATE INDEX `follows_followingId_id_idx` ON `follows` (`followingId`, `id`);
