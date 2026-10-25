const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { composePlan } = require('./chatforum-compose.cjs');
test('production always retains forum search and scale, with review opt-in only', () => {
  const plan = composePlan('production', 'up');
  assert.equal(plan.files.length, 3);
  assert(plan.files.includes('docker/compose.forum-scale.yml'));
  assert.deepEqual(plan.args.slice(-3), ['up', '-d', '--build']);
  assert.equal(composePlan('production', 'plan', { artifactReview: true }).files.length, 4);
});
test('an existing production review overlay is preserved even when its container is stopped', () => {
  const plan = composePlan('production', 'up', { existingFiles: [
    'E:\\repo\\docker\\docker-compose.yml', 'E:\\repo\\docker\\compose.forum-search.yml',
    'E:\\repo\\docker\\compose.forum-scale.yml', 'E:\\repo\\docker\\compose.artifact-review.yml'] });
  assert(plan.files.includes('docker/compose.artifact-review.yml'));
  assert.throws(() => composePlan('production', 'up', { existingFiles: ['E:/private/custom-compose.yml'] }), /unknown overlays/);
});
test('test environments have fixed projects and a search port separate from production', () => {
  const search = composePlan('search-test', 'up');
  assert.deepEqual(search.args.slice(0, 3), ['compose', '-p', 'chatforum-forum-search-test']);
  assert.equal(search.envOverrides.FORUM_SEARCH_HOST_PORT, '39201');
  const rag = composePlan('rag-test', 'up');
  assert.deepEqual(rag.args.slice(0, 3), ['compose', '-p', 'chatforum-rag-test']);
  assert.deepEqual(rag.files, ['docker/compose.test.yml']);
});
test('the wrapper cannot prune volumes, silently accept arbitrary environments or build tests', () => {
  for (const action of ['down', 'rm', 'prune', 'config']) assert.throws(() => composePlan('production', action));
  assert.throws(() => composePlan('things-local-e2e', 'up'));
  assert.throws(() => composePlan('rag-test', 'build'));
  assert.throws(() => composePlan('search-test', 'up', { artifactReview: true }));
  assert.equal(composePlan('rag-test').mutates, false);
});
test('integration databases use dedicated named volumes, not accumulating anonymous image volumes', () => {
  const source = readFileSync(require('node:path').join(__dirname, '../docker/compose.test.yml'), 'utf8');
  assert(source.includes('test_mysql_data:/var/lib/mysql'));
  assert(source.includes('test_redis_data:/data'));
  assert(!source.includes('external:'));
  assert(!source.includes('chatforum-next_'));
});
test('the real search integration fixture refuses the production search endpoint', () => {
  const fixture = readFileSync(require('node:path').join(__dirname, '../backend/src/modules/forum/forum-search.integration.spec.ts'), 'utf8');
  assert(fixture.includes("const endpoint = 'http://127.0.0.1:39201'"));
  assert(fixture.includes('process.env.FORUM_SEARCH_URL !== endpoint'));
  assert(!fixture.includes("const endpoint = 'http://127.0.0.1:39200'"));
});
