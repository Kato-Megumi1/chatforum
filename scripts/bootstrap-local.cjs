const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),file=path.join(root,'.local/admin-bootstrap.env');
if(!fs.existsSync(file)){console.error('Run node scripts/setup-local.cjs first.');process.exit(1);}
const env={...process.env};
for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const m=line.match(/^(ADMIN_EMAIL|ADMIN_PASSWORD)=(.+)$/);if(m)env[m[1]]=m[2];}
const result=spawnSync('docker',['compose','--env-file','docker/.env','-f','docker/docker-compose.yml','exec','-T',
 '-e','ADMIN_EMAIL','-e','ADMIN_PASSWORD','chatforum','npm','run','bootstrap'],{cwd:root,env,stdio:'inherit'});
process.exit(result.status??1);
