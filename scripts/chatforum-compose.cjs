// One explicit environment per invocation; no cleanup, seed or credential output.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const base = 'docker/docker-compose.yml';
const forum = 'docker/compose.forum-search.yml';
const scale = 'docker/compose.forum-scale.yml';
const review = 'docker/compose.artifact-review.yml';
const productionFiles = [base, forum, scale, review];

function composePlan(environment, action = 'plan', options = {}) {
  if (!['production', 'rag-test', 'search-test'].includes(environment) ||
      !['plan', 'up', 'build', 'ps', 'stop'].includes(action))
    throw Error('Use production|rag-test|search-test and plan|up|build|ps|stop');
  if (options.artifactReview && environment !== 'production') throw Error('Artifact review is a production-only opt-in');
  let args, files, envOverrides = {};
  if (environment === 'production') {
    const existing = (options.existingFiles || []).map(file => String(file).replace(/\\/g, '/'));
    // Container labels cannot supply arbitrary Compose files or CLI arguments.
    const unknown = existing.filter(file => !productionFiles.some(allowed => file === allowed || file.endsWith('/' + allowed)));
    if (unknown.length) throw Error('Existing production configuration has unknown overlays; review it before changing the stack');
    files = [base, forum, scale];
    if (options.artifactReview || existing.some(file => file === review || file.endsWith('/' + review))) files.push(review);
    args = ['compose', '--env-file', 'docker/.env'];
  } else if (environment === 'rag-test') {
    files = ['docker/compose.test.yml'];
    args = ['compose', '-p', 'chatforum-rag-test'];
  } else {
    files = [forum];
    args = ['compose', '-p', 'chatforum-forum-search-test'];
    envOverrides = { FORUM_SEARCH_HOST_PORT: '39201' };
  }
  for (const file of files) args.push('-f', file);
  if (environment !== 'rag-test') args.push('--profile', 'forum-search');
  if (action === 'up') args.push('up', '-d', ...(environment === 'production' ? ['--build'] : []));
  if (action === 'build') {
    if (environment !== 'production') throw Error('Test dependency environments do not build application images');
    args.push('build', 'chatforum');
  }
  if (action === 'ps' || action === 'stop') args.push(action);
  return { environment, action, files, args, envOverrides, mutates: ['up', 'build', 'stop'].includes(action) };
}

function existingProductionFiles() {
  const result = spawnSync('docker', ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project.config_files" }}',
    'chatforum-next-chatforum-1'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status === 0) return result.stdout.trim().split(',').filter(Boolean);
  if (/No such (?:object|container)/i.test(result.stderr || '')) return [];
  throw Error('Docker configuration cannot be checked; no stack changes were made');
}

function main(argv) {
  const positional = argv.filter(arg => !arg.startsWith('--'));
  if (positional.length > 2 || argv.some(arg => arg.startsWith('--') && !['--artifact-review', '--dry-run'].includes(arg)))
    throw Error('Unknown argument');
  const [environment, action = 'plan'] = positional;
  const plan = composePlan(environment, action, { artifactReview: argv.includes('--artifact-review'),
    existingFiles: environment === 'production' ? existingProductionFiles() : [] });
  if (action === 'plan' || argv.includes('--dry-run')) { console.log(JSON.stringify(plan, null, 2)); return; }
  const result = spawnSync('docker', plan.args, { cwd: root, env: { ...process.env, ...plan.envOverrides },
    stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw Error('Compose command did not complete successfully');
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { composePlan };
