import { LocalWorkspaceService } from './local-workspace.service';
function fixture() {
  const entries = new Map<string,string>();
  const redis: any = { get: async(k:string)=>entries.get(k)||null, set: async(k:string,v:string)=>{entries.set(k,v);return 'OK';}, del: async(k:string)=>entries.delete(k),
    compareReplace: async(k:string,old:string,v:string)=>{if(entries.get(k)!==old)return false;entries.set(k,v);return true;},
    compareDelete: async(k:string,old:string)=>{if(entries.get(k)===old)entries.delete(k);},
    getClient:()=>({set:async(k:string,v:string)=>{if(entries.has(k))return null;entries.set(k,v);return 'OK';}}) };
  let active=true, running=true, workspaceId='';
  const db: any={conversation:{findFirst:jest.fn(async({where}:any)=>active&&where.userId===1&&where.id===2?{id:2}:null)},chatRun:{count:async()=>0,findFirst:jest.fn(async({where}:any)=>running&&where.userId===1&&where.conversationId===2&&where.id==='run'?{input:{codingWorkspaceId:workspaceId}}:null)}};
  return { service:new LocalWorkspaceService(db,redis), entries, scope:{userId:1,conversationId:2},
    workspace:(id:string)=>workspaceId=id, revoke:()=>active=false, cancel:()=>running=false };
}
describe('local workspace broker',()=>{
  it('scopes connection to active owner and browser capability',async()=>{
    const f=fixture(),c=await f.service.connect(f.scope,'project');
    await expect(f.service.poll({...f.scope,userId:3},c.id,c.token)).rejects.toThrow();
    await expect(f.service.poll(f.scope,c.id,'0'.repeat(64))).rejects.toThrow();
    expect(JSON.stringify([...f.entries.values()])).not.toContain(c.token);
    f.revoke();await expect(f.service.poll(f.scope,c.id,c.token)).rejects.toThrow();
  });
  it('hands a tool to the browser and accepts one idempotent receipt',async()=>{
    const f=fixture(),c=await f.service.connect(f.scope,'project');f.workspace(c.id);
    const result=f.service.tool({action:'read',path:'a.ts'},{...f.scope,codingWorkspaceId:c.id,runId:'run'});
    await new Promise(r=>setTimeout(r,10));
    const {operation:op}=await f.service.poll(f.scope,c.id,c.token);expect(op.args.path).toBe('a.ts');
    const receipt={success:true,data:{content:'1: safe',hash:'abc'}};
    await f.service.complete(f.scope,c.id,c.token,op.id,receipt);
    await f.service.complete(f.scope,c.id,c.token,op.id,receipt);
    await expect(f.service.complete(f.scope,c.id,c.token,op.id,{success:true,data:{content:'different'}})).rejects.toThrow();
    expect((await result).content).toBe('1: safe');
    expect([...f.entries.keys()].some(k=>/operation|result/.test(k))).toBe(false);
  });
  it('cancelled run and replaced directory cannot execute queued writes',async()=>{
    const f=fixture(),c=await f.service.connect(f.scope,'project');f.workspace(c.id);
    const promise=f.service.tool({action:'write',path:'a.ts',expectedHash:'absent',content:'x'},{...f.scope,codingWorkspaceId:c.id,runId:'run'});
    const rejected=expect(promise).rejects.toThrow();await new Promise(r=>setTimeout(r,10));
    const {operation:op}=await f.service.poll(f.scope,c.id,c.token);f.cancel();
    await expect(f.service.authorize(f.scope,c.id,c.token,op.id)).rejects.toThrow();
    await rejected;
    await f.service.connect(f.scope,'other');await expect(f.service.poll(f.scope,c.id,c.token)).rejects.toThrow();
  });
  it('rejects model-supplied scope, traversal, secrets and missing run context',async()=>{
    const f=fixture(),c=await f.service.connect(f.scope,'project');f.workspace(c.id);const scope={...f.scope,codingWorkspaceId:c.id,runId:'run'};
    for(const args of [{action:'read',path:'../a.ts'},{action:'list',userId:5},{action:'write',path:'x.ts',content:'x'},{action:'write',path:'x.ts',expectedHash:'absent',content:['-----BEGIN','PRIVATE KEY-----'].join(' ')}])await expect(f.service.tool(args,scope)).rejects.toThrow();
    await expect(f.service.tool({action:'list'},{...scope,runId:'wrong'})).rejects.toThrow();
    expect([...f.entries.keys()].some(k=>k.includes('operation'))).toBe(false);
  });
});
