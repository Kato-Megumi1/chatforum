-- Private, recoverable file source; does not change existing messages or artifacts.
ALTER TABLE `chat_runs` ADD COLUMN `privateState` JSON NULL;
