export default () => ({
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD,
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '7d',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },
  llm: {
    defaultApiKey: process.env.DEFAULT_MODEL_API_KEY || '',
    defaultApiBase: process.env.DEFAULT_MODEL_API_BASE || 'https://api.deepseek.com',
    defaultModel: process.env.DEFAULT_MODEL_NAME || 'deepseek-chat',
  },
  embedding: {
    defaultApiKey: process.env.EMBEDDING_API_KEY || process.env.DEFAULT_MODEL_API_KEY || '',
    defaultApiBase: process.env.EMBEDDING_API_BASE || 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: process.env.EMBEDDING_MODEL || 'embedding-3',
  },
  upload: {
    dir: process.env.UPLOAD_DIR || './uploads',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 5 * 1024 * 1024,
  },
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },
});
