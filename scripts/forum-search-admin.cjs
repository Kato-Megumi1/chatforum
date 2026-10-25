#!/usr/bin/env node
'use strict';

// Deliberately fixed to the local production compose project. Never load .env,
// start Nest, invoke lifecycle bootstrap hooks, or relay raw subprocess output.
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const CONTAINER = 'chatforum-next-chatforum-1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CONSUMERS = ['forum-projections-v1', 'forum-search-v1', 'forum-subscriptions-v1'];
const HELP = `Local Docker forum search administration (no model/mail workers).
  node scripts/forum-search-admin.cjs [status]
  node scripts/forum-search-admin.cjs build --confirm BUILD_FORUM_SEARCH
  node scripts/forum-search-admin.cjs batch <buildId>
  node scripts/forum-search-admin.cjs validate <buildId> --confirm <buildId>
  node scripts/forum-search-admin.cjs publish <buildId> --confirm <buildId>
  node scripts/forum-search-admin.cjs retry-dead <consumer> --confirm <consumer>

Target: ${CONTAINER}, compose project chatforum-next; no target overrides.
status is read-only. batch processes at most 100 records; retry-dead resets at
most 20 DEAD deliveries for the named built-in consumer. Neither runs workers.
Build first, wait for backfill/event catch-up, validate to READY, then explicitly
publish. Old indices are retained. Raw errors, credentials and content are hidden.
`;

function fail(code) { throw Object.assign(new Error(code), { safeCode: code }); }

function parseArgs(args) {
  const positional = [];
  let confirmation;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--confirm') {
      if (confirmation !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
      confirmation = args[++i];
    } else {
      if (args[i].startsWith('-')) fail('INVALID_ARGUMENTS');
      positional.push(args[i]);
    }
  }
  const action = positional[0] || 'status';
  if (!['status', 'build', 'batch', 'validate', 'publish', 'retry-dead'].includes(action)) fail('INVALID_ARGUMENTS');
  const hasId = ['batch', 'validate', 'publish'].includes(action);
  if (positional.length !== (hasId || action === 'retry-dead' ? 2 : args.length ? 1 : 0)) fail('INVALID_ARGUMENTS');
  const id = hasId ? positional[1] : undefined;
  const consumer = action === 'retry-dead' ? positional[1] : undefined;
  if (hasId && !UUID.test(id)) fail('INVALID_BUILD_ID');
  if (consumer && !CONSUMERS.includes(consumer)) fail('INVALID_CONSUMER');
  const required = action === 'build' ? 'BUILD_FORUM_SEARCH'
    : ['validate', 'publish'].includes(action) ? id : action === 'retry-dead' ? consumer : undefined;
  if (required !== undefined && confirmation !== required) fail('CONFIRMATION_REQUIRED');
  if (required === undefined && confirmation !== undefined) fail('INVALID_ARGUMENTS');
  return { action, id, consumer, confirmation };
}

function docker(args, input) {
  const result = spawnSync('docker', args, {
    input, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal) fail('DOCKER_COMMAND_FAILED');
  return result;
}

function verifyLocalContainer() {
  // An inherited remote DOCKER_HOST must not silently redirect this operator CLI.
  if (process.env.DOCKER_HOST) fail('DOCKER_HOST_OVERRIDE_REFUSED');
  const context = docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']);
  if (context.status !== 0) fail('DOCKER_CONTEXT_CHECK_FAILED');
  let endpoint;
  try { endpoint = JSON.parse(context.stdout.trim()); } catch { fail('DOCKER_CONTEXT_CHECK_FAILED'); }
  if (typeof endpoint !== 'string' || !(
    /^npipe:\/\/\/.+\/pipe\/(?:docker_engine|dockerDesktopLinuxEngine)$/i.test(endpoint)
    || /^unix:\/\/(?:\/var\/run\/docker\.sock|\/run\/user\/\d+\/docker\.sock|\/[^\r\n]+\/\.docker\/run\/docker\.sock)$/.test(endpoint)
  )) fail('NONLOCAL_DOCKER_REFUSED');

  const format = '{"name":{{json .Name}},"running":{{json .State.Running}},'
    + '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
    + '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
    + '"workdir":{{json .Config.WorkingDir}}}';
  const inspected = docker(['inspect', '--type', 'container', '--format', format, CONTAINER]);
  if (inspected.status !== 0) fail('CONTAINER_CHECK_FAILED');
  let identity;
  try { identity = JSON.parse(inspected.stdout.trim()); } catch { fail('CONTAINER_CHECK_FAILED'); }
  if (identity.name !== '/' + CONTAINER || identity.project !== 'chatforum-next'
    || identity.service !== 'chatforum' || identity.workdir !== '/app/backend') fail('CONTAINER_IDENTITY_MISMATCH');
  if (identity.running !== true) fail('CONTAINER_NOT_RUNNING');
}

// A real function rather than a raw script string lets node --check also parse
// the stdin program. All values crossing the process boundary are allowlisted.
async function containerMain(options) {
  const emit = value => process.stdout.write(options.marker + JSON.stringify(value) + '\n');
  const reject = code => { throw Object.assign(new Error(code), { safeCode: code }); };
  const safeCodes = new Set(['TARGET_DATABASE_MISMATCH', 'TEST_ENVIRONMENT_REFUSED', 'CONTAINER_WORKDIR_MISMATCH',
    'COMPILED_MODULES_UNAVAILABLE', 'FORUM_SEARCH_UNAVAILABLE', 'FORUM_SEARCH_EXPIRED', 'FORUM_SEARCH_INVALID_CURSOR',
    'FORUM_SEARCH_NOT_READY', 'FORUM_SEARCH_CONFLICT', 'INVALID_FORUM_EVENT_RETRY', 'FORUM_SEARCH_ADMIN_FAILED']);
  const codeOf = error => {
    const code = error?.safeCode || error?.code;
    return safeCodes.has(code) ? code : 'FORUM_SEARCH_ADMIN_FAILED';
  };
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const cursor = value => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : null;
  const uuid = value => typeof value === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) ? value : null;
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? value : null;
  const safeBuild = build => build ? {
    id: uuid(build.id), status: ['BUILDING', 'READY', 'PUBLISHING', 'ACTIVE', 'RETIRED', 'FAILED'].includes(build.status) ? build.status : 'UNKNOWN',
    initialized: build.initialized === true, maxPostId: integer(build.maxPostId), postCursor: integer(build.postCursor),
    scanDone: build.scanDone === true, startEventId: cursor(build.startEventId), eventCursor: cursor(build.eventCursor),
    validatedEventId: cursor(build.validatedEventId), expectedCount: integer(build.expectedCount),
    createdAt: timestamp(build.createdAt), updatedAt: timestamp(build.updatedAt),
    errorCode: build.errorCode ? codeOf({ code: build.errorCode }) : null,
  } : null;
  let db, indices, events, output;
  try {
    if (process.cwd() !== '/app/backend') reject('CONTAINER_WORKDIR_MISMATCH');
    if (process.env.NODE_ENV === 'test' || Object.keys(process.env).some(key =>
      /^RUN_.*INTEGRATION$/.test(key) && /^(?:true|1)$/i.test(process.env[key] || ''))) reject('TEST_ENVIRONMENT_REFUSED');
    let database;
    try { database = new URL(process.env.DATABASE_URL || ''); } catch { reject('TARGET_DATABASE_MISMATCH'); }
    if (database.protocol !== 'mysql:' || database.hostname !== 'mysql'
      || !['', '3306'].includes(database.port) || database.pathname !== '/chatforum'
      || database.search || database.hash) reject('TARGET_DATABASE_MISMATCH');

    let PrismaService, ForumSearchAdapter, ForumSearchIndexService, ForumEventsService;
    try {
      // No app.module, NestFactory, onApplicationBootstrap, register, or runBatch.
      require('@nestjs/common').Logger.overrideLogger(false);
      ({ PrismaService } = require('/app/backend/dist/src/common/prisma.service'));
      ({ ForumSearchAdapter } = require('/app/backend/dist/src/modules/forum/forum-search.adapter'));
      ({ ForumSearchIndexService } = require('/app/backend/dist/src/modules/forum/forum-search-index.service'));
      ({ ForumEventsService } = require('/app/backend/dist/src/modules/forum/forum-events.service'));
    } catch { reject('COMPILED_MODULES_UNAVAILABLE'); }
    db = new PrismaService();
    const adapter = new ForumSearchAdapter();
    indices = new ForumSearchIndexService(db, adapter);
    events = new ForumEventsService(db);
    await db.$connect();
    let result;
    if (options.action === 'status') {
      const status = await indices.status();
      result = { configured: status.configured === true, enabled: status.enabled === true,
        activeIndexReady: Boolean(status.activeIndex), activeBuildId: uuid(status.activeBuildId),
        candidate: safeBuild(status.candidate),
        degraded: status.degraded === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED'
          : status.degraded ? codeOf({ code: status.degraded }) : null };
    } else if (options.action === 'build') {
      result = safeBuild(await indices.startBuild({ confirmation: options.confirmation }));
    } else if (options.action === 'batch') {
      result = safeBuild(await indices.runBuildBatch(options.id, 100));
    } else if (options.action === 'validate') {
      if (options.confirmation !== options.id) reject('FORUM_SEARCH_CONFLICT');
      result = safeBuild(await indices.validateBuild(options.id));
    } else if (options.action === 'publish') {
      result = safeBuild(await indices.publish(options.id, { confirmation: options.confirmation }));
    } else if (options.action === 'retry-dead') {
      if (options.confirmation !== options.consumer) reject('INVALID_FORUM_EVENT_RETRY');
      result = { consumer: options.consumer, retried: integer(await events.retryDead(options.consumer, 20)), limit: 20 };
    } else reject('FORUM_SEARCH_ADMIN_FAILED');
    output = { ok: true, action: options.action, observedAt: new Date().toISOString(), result };
  } catch (error) {
    output = { ok: false, action: options.action, error: codeOf(error) };
  } finally {
    try {
      indices?.onModuleDestroy();
      events?.onModuleDestroy();
      await db?.$disconnect();
    } catch { output = { ok: false, action: options.action, error: 'FORUM_SEARCH_ADMIN_FAILED' }; }
  }
  emit(output);
  process.exitCode = output.ok ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(HELP);
    return;
  }
  const options = parseArgs(args);
  verifyLocalContainer();
  const marker = 'FORUM_SEARCH_ADMIN_' + randomBytes(16).toString('hex') + ':';
  const program = '(' + containerMain.toString() + ')(' + JSON.stringify({ ...options, marker }) + ');\n';
  const executed = docker(['exec', '-i', CONTAINER, 'node'], program);
  // Never print Docker/Nest/Prisma stderr or unrelated stdout; they may contain
  // server URLs, credentials or SQL. Emit only our structured, sanitized result.
  const lines = executed.stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
  if (lines.length !== 1) fail('CONTAINER_COMMAND_FAILED');
  let output;
  try { output = JSON.parse(lines[0].slice(marker.length)); } catch { fail('CONTAINER_COMMAND_FAILED'); }
  if (typeof output?.ok !== 'boolean' || output.action !== options.action
    || executed.status !== (output.ok ? 0 : 1)) fail('CONTAINER_COMMAND_FAILED');
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = output.ok ? 0 : 1;
}

try { main(); } catch (error) {
  // safeCode is assigned only by this file, never by child process stderr.
  const allowed = new Set(['INVALID_ARGUMENTS', 'INVALID_BUILD_ID', 'INVALID_CONSUMER', 'CONFIRMATION_REQUIRED',
    'DOCKER_COMMAND_FAILED', 'DOCKER_HOST_OVERRIDE_REFUSED', 'DOCKER_CONTEXT_CHECK_FAILED', 'NONLOCAL_DOCKER_REFUSED',
    'CONTAINER_CHECK_FAILED', 'CONTAINER_IDENTITY_MISMATCH', 'CONTAINER_NOT_RUNNING', 'CONTAINER_COMMAND_FAILED']);
  process.stderr.write(JSON.stringify({ ok: false, error: allowed.has(error?.safeCode) ? error.safeCode : 'FORUM_SEARCH_ADMIN_FAILED' }) + '\n');
  process.exitCode = 1;
}
