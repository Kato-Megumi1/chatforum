CREATE TABLE chat_runs (
 id VARCHAR(36) NOT NULL, userId INTEGER NOT NULL, conversationId INTEGER NOT NULL,
 requestId VARCHAR(36) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
 input JSON NOT NULL, result JSON NULL, error VARCHAR(255) NULL, workerToken VARCHAR(36) NULL,
 leaseUntil DATETIME(3) NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 updatedAt DATETIME(3) NOT NULL,
 PRIMARY KEY (id), UNIQUE INDEX chat_runs_userId_requestId_key (userId, requestId),
 INDEX chat_runs_status_createdAt_idx (status, createdAt),
 CONSTRAINT chat_runs_conversationId_fkey FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
