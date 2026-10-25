// Restore ONLY to a fresh disposable volume, without network/ports. Never restores over production.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),dir=path.resolve(process.argv[2]||'');
if(!dir.startsWith(path.join(root,'.local','backups')+path.sep))throw Error('Private backup path required');
const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
function docker(args){const r=spawnSync('docker',args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:60000});
 if(r.status!==0)throw Error('Restore check step failed: '+args[0]);return r.stdout.trim();}
const name='chatforum-restorecheck-'+crypto.randomBytes(6).toString('hex'),label='chatforum.restore-check='+name;
let volume=false,container=false;
(async()=>{try{
 for(const f of manifest.files){if(!/^(mysql|redis|qdrant)-volume\.tgz$/.test(f.name))throw Error('Unexpected archive');
  if(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,f.name))).digest('hex')!==f.sha256)throw Error('Archive digest mismatch');
  docker(['run','--rm','--network','none','--read-only','--entrypoint','tar','--mount','type=bind,src='+dir+',dst=/backup,readonly',manifest.image,'-tzf','/backup/'+f.name]);
 }
 docker(['volume','create','--label',label,name]);volume=true;
 docker(['run','--rm','--network','none','--read-only','--entrypoint','tar',
  '--mount','type=bind,src='+dir+',dst=/backup,readonly','--mount','type=volume,src='+name+',dst=/restore',manifest.image,
  '-xzf','/backup/mysql-volume.tgz','-C','/restore']);
 docker(['run','-d','--name',name,'--label',label,'--network','none','--env-file','docker/.env',
  '--mount','type=volume,src='+name+',dst=/var/lib/mysql','mysql:8.0','--skip-networking','--skip-log-bin']);container=true;
 let ready=false;
 for(let i=0;i<45;i++){
  const check=spawnSync('docker',['exec',name,'mysqladmin','ping','--silent'],{encoding:'utf8',windowsHide:true});
  if(check.status===0){ready=true;break;}await new Promise(r=>setTimeout(r,2000));
 }
 if(!ready)throw Error('Restored MySQL did not become ready');
 const counts=docker(['exec',name,'sh','-c','MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -B chatforum -e "SELECT (SELECT COUNT(*) FROM users),(SELECT COUNT(*) FROM chat_messages),(SELECT COUNT(*) FROM knowledge_chunks)"']).split('\t').map(Number);
 if(counts.length!==3||counts.some(n=>!Number.isSafeInteger(n)||n<1))throw Error('Unexpected restored data');
 // Keep only identity/password digests; login timestamps/points may legitimately change after release.
 const identity=docker(['exec',name,'sh','-c','MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -B chatforum -e "SELECT id,SHA2(JSON_ARRAY(id,email,username,password,role,status),256) FROM users ORDER BY id"']);
 manifest.originalAccountDigests=identity.split('\n').filter(Boolean).map(line=>{const [id,sha256]=line.split('\t');return {id:Number(id),sha256};});
 manifest.restoreTested={mysql:true,archivesVerified:true,at:new Date().toISOString()};
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
 console.log(JSON.stringify({mysqlRestorePassed:true,users:counts[0],messages:counts[1],chunks:counts[2],productionTouched:false}));
}finally{
 if(container){const c=JSON.parse(docker(['inspect',name]))[0];if(c.Config.Labels['chatforum.restore-check']!==name)throw Error('Cleanup ownership mismatch');
  docker(['stop','--time','20',name]);docker(['rm',name]);}
 if(volume){const v=JSON.parse(docker(['volume','inspect',name]))[0];if(v.Labels['chatforum.restore-check']!==name)throw Error('Cleanup volume ownership mismatch');docker(['volume','rm',name]);}
 console.log('Disposable restore copy cleaned; original archives retained');
}})().catch(()=>{console.error('Backup restore check failed; production untouched');process.exitCode=1;});
