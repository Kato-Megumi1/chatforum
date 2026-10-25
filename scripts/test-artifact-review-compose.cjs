// Pure static opt-in checks. No Docker, network, configuration secrets, or data reads.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const read = relative => readFileSync(join(root, relative), 'utf8');
const optIn = read('docker/compose.artifact-review.yml');
const effectiveLines = optIn.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));

test('opt-in adds exactly one fixed API environment value and one dedicated private bind', () => {
  assert.deepEqual(effectiveLines, [
    'services:',
    '  chatforum:',
    '    environment:',
    '      ARTIFACT_REVIEW_QUEUE_DIR: /app/artifact-review',
    '    volumes:',
    '      - ../.local/artifact-review-queue:/app/artifact-review',
  ]);
});

test('no socket, extra host paths, public storage, ports, or execution privileges are granted to the API', () => {
  const yaml = effectiveLines.join('\n');
  assert(!/docker\.sock|docker_engine|DOCKER_HOST|\.env|storage|uploads|\/var\/run|\$\{/i.test(yaml));
  assert(!/^\s*(?:privileged|cap_add|cap_drop|security_opt|devices|network_mode|pid|ipc|user|ports|expose|entrypoint|command|build|image):/m.test(yaml));
  assert.equal(effectiveLines.filter(line => /^\s+- /.test(line)).length, 1);
});

test('existing production composition stays opt-in and does not acquire the review queue implicitly', () => {
  for (const file of ['docker/docker-compose.yml', 'docker/compose.forum-search.yml', 'docker/compose.forum-scale.yml']) {
    const yaml = read(file);
    assert(!/ARTIFACT_REVIEW_QUEUE_DIR|artifact-review-queue|docker\.sock|DOCKER_HOST/i.test(yaml), file);
  }
  const api = read('backend/src/modules/coding/artifact-review.service.ts');
  assert(api.includes("process.env.ARTIFACT_REVIEW_QUEUE_DIR?.trim()"));
  assert(api.includes('if (!value || !isAbsolute(value)) return undefined;'));
});

test('renderer remains an independent restricted host launcher, not a privileged compose service', () => {
  const operator = read('scripts/artifact-review-daemon.cjs');
  assert(operator.includes("'--network','none'"));
  assert(operator.includes("'--user','1000:1000'"));
  assert(operator.includes("'--cap-drop','ALL'"));
  assert(operator.includes("'--security-opt','no-new-privileges'"));
  assert(operator.includes("'--read-only'"));
  assert(!operator.includes("'--mount'"));
  assert(!operator.includes("'--privileged'"));
  assert(!operator.includes("'--no-sandbox'"));
});
