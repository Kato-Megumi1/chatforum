// Read-only pre-publication scan. Never prints matched secret values.
const fs = require('node:fs'), { spawnSync } = require('node:child_process');
const root = require('node:path').resolve(__dirname, '..');
const staged=process.argv.includes('--staged');
const listing = spawnSync(staged?'git':'rg', staged?['ls-files','--cached','-z']:['--files', '--hidden', '--no-require-git', '-g', '!.git/**'], { cwd: root, encoding: 'utf8' });
if (listing.status !== 0) { console.error('File listing failed; install Git/ripgrep and run from the project.'); process.exit(2); }
const files = listing.stdout.trim().split(staged?'\0':/\r?\n/).filter(Boolean), secrets = [];
const credentialFile=root+'/.local/gitee-token';
if(fs.existsSync(credentialFile)){const value=fs.readFileSync(credentialFile,'utf8').trim();if(value.length>=10)secrets.push({name:'GITEE_TOKEN',value});}
for (const envFile of ['backend/.env', 'docker/.env']) {
  if (!fs.existsSync(root + '/' + envFile)) continue;
  for (const line of fs.readFileSync(root + '/' + envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]*(?:KEY|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (value.length >= 12 && !value.includes('${')) secrets.push({ name: match[1], value });
  }
}
const problems = [];
const normalized = new Set(files.map(f=>f.replace(/\\/g,'/')));
for (const required of ['package-lock.json','backend/package-lock.json','frontend/package-lock.json','backend/prisma/schema.prisma','backend/prisma/migrations/migration_lock.toml'])
  if(!normalized.has(required))problems.push(required+': required reproducible source missing');
for(const migration of fs.readdirSync(root+'/backend/prisma/migrations',{withFileTypes:true}).filter(e=>e.isDirectory())){
 const rel='backend/prisma/migrations/'+migration.name+'/migration.sql';
 if(fs.existsSync(root+'/'+rel)&&!normalized.has(rel))problems.push(rel+': required migration missing');
}
for (const file of files) {
  if (/\.(epub|pdf|docx?)$/i.test(file) || /(?:^|[\\/])(?:storage|uploads|\.local)[\\/]/.test(file)) problems.push(file + ': private data included');
  if (/(?:^|[\\/])(?:\.claude|\.codex|\.agents|node_modules|dist|coverage|backups|test-results)[\\/]/.test(file)) problems.push(file + ': generated or private tooling file included');
  if (/\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|mp3)$/i.test(file)) continue;
  const indexed=staged?spawnSync('git',['show',':'+file.replace(/\\/g,'/')],{cwd:root,encoding:'utf8',maxBuffer:10000000}):null;
  if(indexed&&indexed.status!==0){problems.push(file+': index unreadable');continue;}
  const text = indexed?indexed.stdout:fs.readFileSync(root + '/' + file, 'utf8');
  for (const secret of secrets) if (text.includes(secret.value)) problems.push(file + ': matches local ' + secret.name);
  if (/(?:sk-[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text)) problems.push(file + ': credential-like pattern');
  if (/(?:^|[\\/])\.env(?:$|\.)/.test(file) && !file.endsWith('.example')) problems.push(file + ': environment file exposed');
}
if (problems.length) { console.error([...new Set(problems)].join('\n')); process.exit(1); }
console.log('PASS: ' + files.length + (staged?' indexed':' publishable')+' files; local secret values/private data not detected. This is not a Git history scan.');
