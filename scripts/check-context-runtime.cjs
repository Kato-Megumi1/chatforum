// Isolated fixtures only. Never loads production credentials or invokes a paid provider.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const backend = path.resolve(__dirname, '../backend');
const env = { ...process.env, RUN_CONTEXT_INTEGRATION: '1',
  DATABASE_URL: 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test',
  QDRANT_URL: 'http://127.0.0.1:36336', REDIS_HOST: '127.0.0.1', REDIS_PORT: '36386', REDIS_PASSWORD: '',
  JWT_ACCESS_SECRET: 'integration-test-access-secret-at-least-32', JWT_REFRESH_SECRET: 'integration-test-refresh-secret-at-least-32',
  DEEPSEEK_API_KEY: 'fixture-not-a-real-key', DASHSCOPE_API_KEY: 'fixture-not-a-real-key',
  DEFAULT_MODEL_API_KEY: 'fixture-not-a-real-key', EMBEDDING_API_KEY: 'fixture-not-a-real-key',
  CHAT_WORKER_ENABLED: 'false', RAG_WORKER_ENABLED: 'false', LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' };
for (const args of [
  [require.resolve('../backend/node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
  [require.resolve('../backend/node_modules/jest/bin/jest.js'), '--runInBand', 'context-runtime.integration.spec',
    ...(process.env.CONTEXT_TEST_PATTERN ? ['-t', process.env.CONTEXT_TEST_PATTERN] : [])],
]) {
  const run = spawnSync(process.execPath, args, { cwd: backend, env, stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status || 1);
}
