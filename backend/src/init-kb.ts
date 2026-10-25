/**
 * Legacy MemoryVectorStore bootstrap is retired. Never copy/rename JSON indexes
 * or invent chunk counts on startup. Import the original novel via the UI,
 * then build -> validate -> activate an immutable Qdrant index.
 */
console.log('Legacy JSON index initialization disabled. Use 小说库 → 上传原文 → 构建索引 → 发布。');
export {};
