// Optional local operator process. The public Nest API never gets a Docker socket.
// Only random job IDs and bounded HTML enter disposable network-none containers.
'use strict';
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION='offline-html-v1';
const seccomp=path.resolve(__dirname,'../docker/artifact-review/seccomp.json');
function validJob(job){return job&&UUID.test(job.id)&&typeof job.html==='string'&&Buffer.byteLength(job.html)<=64000&&
  createHash('sha256').update(job.html).digest('hex')===job.sourceHash&&
  JSON.stringify(job.viewports)===JSON.stringify([{width:390,height:844},{width:1280,height:900}]);}
function dockerArgs(job){
  if(!validJob(job))throw new Error('Invalid review job');
  return ['run','--pull=never','--rm','-i','--init','--name','cf-artifact-review-'+job.id,'--network','none','--read-only','--user','1000:1000',
    '--cap-drop','ALL','--security-opt','no-new-privileges','--security-opt','seccomp='+seccomp,
    '--pids-limit','160','--memory','512m','--cpus','1','--tmpfs','/tmp:rw,noexec,nosuid,size=128m','--shm-size','128m',
    '-e','XDG_CONFIG_HOME=/tmp/.config','-e','XDG_CACHE_HOME=/tmp/.cache',
    'chatforum-artifact-review:local'];
}
function runJob(job,{signal,timeoutMs=22000}={}){
  const args=dockerArgs(job),name='cf-artifact-review-'+job.id;
  return new Promise(resolve=>{
    let output='',settled=false,timedOut=false,stopping=false;
    const child=spawn('docker',args,{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    const cleanup=()=>spawnSync('docker',['rm','-f',name],{stdio:'ignore',windowsHide:true,timeout:3000,shell:false});
    const stop=()=>{if(stopping)return;stopping=true;cleanup();child.kill();};
    const abort=()=>stop();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)stop();
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(value);};
    const failed=code=>({id:job.id,sourceHash:job.sourceHash,rendererVersion:VERSION,status:'failed',error:code,views:[]});
    child.on('error',()=>finish(failed('RENDERER_UNAVAILABLE')));
    child.stdout.on('data',part=>{output+=part;if(Buffer.byteLength(output)>6*1024*1024){stop();finish(failed('RESULT_TOO_LARGE'));}});
    child.stderr.on('data',()=>{}); // No page text, user code or diagnostic process output enters public logs.
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(job));
    child.on('close',code=>{
      // Daemon creation can finish after the first rm/CLI termination. Reconcile
      // this exact random name again; the image also has its own hard deadline.
      if(stopping)cleanup();
      if(timedOut)return finish(failed('RENDER_TIMEOUT'));if(signal?.aborted)return finish(failed('RENDER_CANCELLED'));
      try{const value=JSON.parse(output);if(code!==0||value.status!=='rendered'||value.id!==job.id||value.sourceHash!==job.sourceHash)throw new Error();finish(value);}
      catch{finish(failed('RENDER_FAILED'));}
    });
  });
}
async function main(){
  const position=process.argv.indexOf('--queue');
  if(position<0||!process.argv[position+1])throw new Error('Usage: node scripts/artifact-review-daemon.cjs --queue <dedicated-private-directory> [--once]');
  const root=path.resolve(process.argv[position+1]),input=path.join(root,'in'),output=path.join(root,'out'),locks=path.join(root,'active');
  for(const folder of [input,output,locks])await fs.mkdir(folder,{recursive:true,mode:0o700});
  let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
  do{
    const entries=await fs.readdir(input,{withFileTypes:true});
    for(const entry of entries){
      if(stopped)break;const id=entry.name.replace(/\.json$/,'');
      if(!entry.isFile()||!entry.name.endsWith('.json')||!UUID.test(id))continue;
      const source=path.join(input,entry.name),lock=path.join(locks,id+'.lock');let lease;
      try{lease=await fs.open(lock,'wx',0o600);}catch{continue;}
      try{
        const stat=await fs.lstat(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512000)continue;
        const job=JSON.parse(await fs.readFile(source,'utf8'));if(!validJob(job)||job.id!==id)continue;
        const controller=new AbortController();const cancelled=setInterval(()=>{if(stopped)controller.abort();else void fs.access(source).catch(()=>controller.abort());},100);
        let result;try{result=await runJob(job,{signal:controller.signal});}finally{clearInterval(cancelled);}
        if(!controller.signal.aborted&&!stopped){
          const temporary=path.join(output,id+'.tmp');await fs.writeFile(temporary,JSON.stringify(result),{mode:0o600});
          await fs.rename(temporary,path.join(output,id+'.json'));
        }
      }finally{await lease.close();await fs.unlink(lock).catch(()=>{});await fs.unlink(source).catch(()=>{});}
    }
    if(!stopped&&!process.argv.includes('--once'))await new Promise(resolve=>setTimeout(resolve,150));
  }while(!stopped&&!process.argv.includes('--once'));
}
module.exports={validJob,dockerArgs,runJob};
if(require.main===module)main().catch(()=>{console.error('Offline artifact-review runner stopped. Check its dedicated queue directory and Docker availability.');process.exitCode=1;});
