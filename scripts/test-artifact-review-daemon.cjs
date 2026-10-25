// Pure launcher race fixtures: no Docker daemon, real HTML execution or model calls.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const make = () => {
  const html = '<h1>synthetic launcher fixture</h1>';
  return { id: randomUUID(), html, sourceHash: createHash('sha256').update(html).digest('hex'),
    viewports: [{ width: 390, height: 844 }, { width: 1280, height: 900 }] };
};

function launcher(mode) {
  const events = [], dockerCalls = [], state = { exists: false, closed: false, killed: false, writes: 0 };
  let job, child, expectedName, stopped = false;
  const close = code => {
    if (state.closed) return;
    state.closed = true; events.push('cli-close'); child.emit('close', code);
  };
  const spawn = (command, args, options) => {
    assert.equal(command, 'docker'); assert.equal(options.shell, false);
    dockerCalls.push({ command, args, options }); events.push('cli-spawn');
    expectedName = args[args.indexOf('--name') + 1];
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.kill = () => {
      if (stopped) return true; stopped = true; state.killed = true; events.push('cli-kill');
      // Docker has accepted the request but its create/start result appears only
      // after the first cancellation rm saw no container. Killing the local CLI
      // is deliberately not simulated as cancelling the remote daemon request.
      if (mode === 'late-start') { state.exists = true; events.push('daemon-created-after-first-rm'); }
      queueMicrotask(() => close(137)); return true;
    };
    child.stdin.end = input => {
      job = JSON.parse(input); state.writes++;
      queueMicrotask(() => {
        if (mode === 'success') {
          state.exists = true;
          child.stdout.emit('data', JSON.stringify({ id: job.id, sourceHash: job.sourceHash,
            rendererVersion: 'offline-html-v1', status: 'rendered', views: [] }));
          state.exists = false; close(0); // --rm handles a normal completed run.
        } else if (mode === 'oversize') {
          state.exists = true; child.stdout.emit('data', Buffer.alloc(6 * 1024 * 1024 + 1, 120));
        } else if (mode === 'running') state.exists = true;
      });
    };
    return child;
  };
  const spawnSync = (command, args, options) => {
    assert.equal(command, 'docker'); assert.equal(options.shell, false);
    dockerCalls.push({ command, args, options });
    if (args[0] === 'rm') {
      assert.equal(args[1], '-f'); assert.equal(args[2], expectedName);
      events.push(state.exists ? 'rm-existing' : 'rm-absent');
      const found = state.exists; state.exists = false;
      return { status: found ? 0 : 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'inspect' || args[0] === 'ps') {
      events.push('probe'); return { status: state.exists ? 0 : 1, stdout: state.exists ? 'true\n' : '', stderr: '' };
    }
    throw Error('Unexpected mock Docker operation: ' + args[0]);
  };
  const module = { exports: {} };
  const source = readFileSync(join(__dirname, 'artifact-review-daemon.cjs'), 'utf8');
  const sandbox = { module, exports: module.exports, __dirname, Buffer, console, process: { argv: [], once() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, AbortController,
    require(name) { return name === 'node:child_process' ? { spawn, spawnSync } : require(name); } };
  sandbox.require.main = {};
  vm.runInNewContext(source, sandbox, { filename: 'artifact-review-daemon.cjs' });
  return { api: module.exports, events, dockerCalls, state };
}

test('sandbox launcher has no mounts/socket/privileged fallback and a fixed name/image', () => {
  const fixture = launcher('success'), job = make(), args = Array.from(fixture.api.dockerArgs(job));
  for (const [option, value] of [['--name', 'cf-artifact-review-' + job.id], ['--network', 'none'], ['--user', '1000:1000'],
    ['--cap-drop', 'ALL'], ['--memory', '512m'], ['--pids-limit', '160']]) assert.equal(args[args.indexOf(option) + 1], value);
  assert(args.includes('--read-only')); assert(args.includes('no-new-privileges'));
  assert.equal(args.at(-1), 'chatforum-artifact-review:local');
  assert(!args.some(value => value === '--privileged' || value === '-v' || value === '--mount' || value === '--volume' || /docker\.sock|--no-sandbox/u.test(value)));
});

test('deadline cleans a daemon-started container even when the first rm found nothing', { timeout: 8000 }, async () => {
  const fixture = launcher('late-start'), job = make();
  const result = await fixture.api.runJob(job, { timeoutMs: 10 });
  await delay(30);
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'RENDER_TIMEOUT');
  assert(fixture.events.includes('daemon-created-after-first-rm'));
  assert(fixture.events.indexOf('rm-existing') > fixture.events.indexOf('daemon-created-after-first-rm'), 'Remote startup after first rm must be cleaned again');
  assert.equal(fixture.state.exists, false); assert(fixture.state.killed);
});

test('already-aborted admission and running cancellation never return a successful render', { timeout: 8000 }, async () => {
  for (const preAborted of [true, false]) {
    const fixture = launcher('late-start'), job = make(), controller = new AbortController();
    if (preAborted) controller.abort();
    const operation = fixture.api.runJob(job, { signal: controller.signal, timeoutMs: 500 });
    if (!preAborted) controller.abort();
    const result = await operation; await delay(30);
    assert.equal(result.status, 'failed'); assert.equal(result.error, 'RENDER_CANCELLED');
    assert.equal(fixture.state.exists, false, 'Abort cannot leave late-started daemon work alive');
  }
});

test('oversized process stdout cannot pass or leave its sandbox running', { timeout: 8000 }, async () => {
  const fixture = launcher('oversize');
  const result = await fixture.api.runJob(make(), { timeoutMs: 500 }); await delay(30);
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'RESULT_TOO_LARGE');
  assert.equal(fixture.state.exists, false); assert(fixture.state.killed);
});

test('success preserves source identity and sends only the validated job on stdin', { timeout: 8000 }, async () => {
  const fixture = launcher('success'), job = make();
  const result = await fixture.api.runJob(job, { timeoutMs: 500 });
  assert.equal(result.status, 'rendered'); assert.equal(result.id, job.id); assert.equal(result.sourceHash, job.sourceHash);
  assert.equal(fixture.state.writes, 1); assert.equal(fixture.state.exists, false);
  const run = fixture.dockerCalls.find(call => call.args[0] === 'run');
  assert(run && !run.args.includes(job.html), 'HTML must not appear in command-line arguments');
});
