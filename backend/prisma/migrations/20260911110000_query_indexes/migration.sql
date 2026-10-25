ALTER TABLE comments MODIFY content TEXT NOT NULL;
CREATE INDEX chat_messages_conversationId_createdAt_id_idx ON chat_messages(conversationId, createdAt, id);
CREATE INDEX posts_status_createdAt_id_idx ON posts(status, createdAt, id);
CREATE INDEX comments_postId_parentId_status_createdAt_idx ON comments(postId, parentId, status, createdAt);
