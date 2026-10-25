// Cold backup only; refuses a running stack. Never exports to a publication directory.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const label = process.argv[2] || 'context';
if (!/^[a-z0-9-]{1,30}$/.test(label)) throw Error('Invalid backup label');
function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: root, encoding: 'utf8', windowsHide: true, ...options });
  if (r.status !== 0) throw Error('Docker backup step failed: ' + args[0]);
  return r.stdout.trim();
}
const services = ['chatforum', 'mysql', 'redis', 'qdrant'];
const inspected = services.map(s => JSON.parse(docker(['inspect', 'chatforum-next-' + s + '-1']))[0]);
for (let i = 0; i < inspected.length; i++) {
  const c = inspected[i];
  if (c.Config.Labels['com.docker.compose.project'] !== 'chatforum-next' || c.Config.Labels['com.docker.compose.service'] !== services[i] || c.State.Running)
    throw Error('Refusing: expected stopped production stack only');
}
const suffix = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
const dir = path.join(root, '.local', 'backups', 'before-' + label + '-' + suffix);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const image = inspected[0].Image;
const imageTag = 'chatforum-next-chatforum:before-' + label + '-' + suffix.toLowerCase();
docker(['image', 'tag', image, imageTag]);
const files = [];
for (let i = 1; i < services.length; i++) {
  const volume = inspected[i].Mounts.find(m => m.Type === 'volume' && m.Name === 'chatforum-next_' + services[i] + '_data');
  if (!volume) throw Error('Unexpected volume layout');
  const name = services[i] + '-volume.tgz';
  docker(['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'sh',
    '--mount', 'type=volume,src=' + volume.Name + ',dst=/source,readonly',
    '--mount', 'type=bind,src=' + dir + ',dst=/backup', image,
    '-c', 'tar -czf /backup/' + name + ' -C /source .']);
  const file = path.join(dir, name);
  files.push({ name, bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  console.log('Archived stopped volume: ' + services[i]);
}
for (const rel of ['backend/storage', 'backend/uploads', 'backend/.env', 'docker/.env']) {
  const src = path.resolve(root, rel), dest = path.join(dir, rel);
  if (!src.startsWith(root + path.sep) || !dest.startsWith(dir + path.sep)) throw Error('Invalid backup path');
  if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false }); }
}
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), image, files,
  stack: inspected.map(c => ({ name: c.Name, image: c.Image, mounts: c.Mounts.map(m => ({ type: m.Type, name: m.Name, destination: m.Destination })) })),
  originalFilesAndPrivateConfig: true, restoreTested: false }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ backup: dir, oldImageRetained: imageTag, archives: files.map(f => ({ name: f.name, bytes: f.bytes })) }));
