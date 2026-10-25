ALTER TABLE `conversations` ADD COLUMN `memoryEpoch` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `conversations`
  ADD COLUMN `conversationType` VARCHAR(16) NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN `personaKey` VARCHAR(80) NULL,
  ADD COLUMN `personaLabel` VARCHAR(80) NULL,
  ADD COLUMN `customPersonaPrompt` TEXT NULL,
  ADD COLUMN `sharedMemory` BOOLEAN NOT NULL DEFAULT false;

-- Only unambiguous server-tagged histories are classified. Mixed/untagged histories remain
-- readable as LEGACY; never guess an identity from assistant prose or overwrite old messages.
UPDATE `conversations` c JOIN (
  SELECT conversationId, MIN(JSON_UNQUOTE(JSON_EXTRACT(ragMetadata, '$.personaKey'))) AS persona
  FROM chat_messages WHERE role = 'ASSISTANT' GROUP BY conversationId
  HAVING COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(ragMetadata, '$.personaKey'))) = 1
    AND COUNT(JSON_UNQUOTE(JSON_EXTRACT(ragMetadata, '$.personaKey'))) = COUNT(*)
) h ON h.conversationId = c.id
SET c.conversationType = IF(h.persona = 'assistant', 'ASSISTANT', 'ROLEPLAY'),
    c.personaKey = h.persona,
    c.personaLabel = CASE h.persona WHEN 'kato_megumi_persona' THEN '加藤惠'
      WHEN 'yukinoshita_yukino_persona' THEN '雪之下雪乃' ELSE 'AI 助手' END
WHERE h.persona IN ('assistant', 'kato_megumi_persona', 'yukinoshita_yukino_persona');
CREATE TABLE `conversation_episodes` (
  `conversationId` INTEGER NOT NULL,
  `personaKey` VARCHAR(80) NOT NULL,
  `lastMessageId` INTEGER NOT NULL,
  `text` TEXT NOT NULL,
  `sourceIds` JSON NOT NULL,
  `evidence` JSON NULL,
  PRIMARY KEY (`conversationId`, `personaKey`, `lastMessageId`),
  CONSTRAINT `conversation_episodes_conversation_fkey` FOREIGN KEY (`conversationId`)
    REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `chat_runs` ADD COLUMN `usage` JSON NULL;
CREATE INDEX `novel_graph_target_path` ON `novel_graph_facts` (`indexVersionId`, `targetKey`, `subjectKey`);
