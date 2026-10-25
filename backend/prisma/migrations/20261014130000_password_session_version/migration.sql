-- Existing passwords and sessions are preserved at version zero until that owner changes their password.
ALTER TABLE `users` ADD COLUMN `authVersion` INTEGER NOT NULL DEFAULT 0;
