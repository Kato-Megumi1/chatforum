import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ToolRunService } from './tool-run.service';
import { currentToolWriteApproval, normalizedToolArgs, ToolApprovalPendingError, toolArgsHash, ToolStepUncertainError,
  TOOL_POLICY_VERSION, toolPolicy } from './tool-run.policy';

const runId='10000000-0000-4000-8000-000000000001';
const scope={userId:3,conversationId:4,runId,workerToken:'worker',fileSourceEpoch:7};
const writeArgs={action:'create',kind:'NEW_POSTS',query:'校园',confirmed:true};
function fixture(){
  const user:any={status:'ACTIVE',authVersion:2},conversation:any={memoryEpoch:7,conversationType:'ASSISTANT'};
  const run:any={id:runId,userId:3,conversationId:4,status:'RUNNING',workerToken:'worker',leaseUntil:new Date(Date.now()+60000)};
  const rows:any[]=[];
  const matches=(row:any,where:any):boolean=>Object.entries(where||{}).every(([key,value]:any)=>{
    if(key==='run')return matches(run,value);
    if(value&&typeof value==='object'&&!Array.isArray(value)&&!(value instanceof Date)){
      if('in'in value)return value.in.includes(row[key]);
      if('gt'in value)return row[key]>value.gt;
    }
    return row[key]===value;
  });
  const db:any={user:{findUnique:jest.fn(async({where}:any)=>where.id===3?user:null)},
    conversation:{findFirst:jest.fn(async({where}:any)=>where.id===4&&where.userId===3?conversation:null)},
    chatRun:{findFirst:jest.fn(async({where}:any)=>matches(run,where)?run:null),
      updateMany:jest.fn(async({where,data}:any)=>{if(!matches(run,where))return{count:0};Object.assign(run,data);return{count:1};})},
    chatToolStep:{
      findUnique:jest.fn(async({where}:any)=>rows.find(row=>row.runId===where.runId_stepKey.runId&&row.stepKey===where.runId_stepKey.stepKey)||null),
      findFirst:jest.fn(async({where,orderBy}:any)=>{const found=rows.filter(row=>matches(row,where));return orderBy?found.at(-1)||null:found[0]||null;}),
      findMany:jest.fn(async({where,take}:any)=>rows.filter(row=>matches(row,where)).slice(0,take)),
      create:jest.fn(async({data}:any)=>{const row={...data,id:'20000000-0000-4000-8000-'+String(rows.length+1).padStart(12,'0'),
        createdAt:new Date(),updatedAt:new Date(),approvedAt:null,finishedAt:null,result:null};rows.push(row);return row;}),
      updateMany:jest.fn(async({where,data}:any)=>{const found=rows.filter(row=>matches(row,where));for(const row of found)Object.assign(row,data);return{count:found.length};}),
      update:jest.fn(async({where,data}:any)=>{const row=rows.find(row=>matches(row,where));Object.assign(row,data);return row;}),
      count:jest.fn(async({where}:any)=>rows.filter(row=>matches(row,where)).length),
    },$queryRaw:jest.fn(async()=>[{id:3}])};
  db.$transaction=jest.fn(async(callback:any)=>callback(db));
  return{service:new ToolRunService(db),db,user,conversation,run,rows};
}

describe('durable tool steps and independent consent',()=>{
  test('a model confirmed=true never executes a write; a separately approved exact version resumes the same task once',async()=>{
    const f=fixture(),execute=jest.fn(async(args)=>{expect(args.confirmed).toBe(true);expect(currentToolWriteApproval(scope,args)).toBeDefined();return'{"success":true,"data":{"id":8}}';});
    await expect(f.service.invoke('manage_forum_tracking',writeArgs,scope,execute)).rejects.toBeInstanceOf(ToolApprovalPendingError);
    expect(execute).not.toHaveBeenCalled();expect(f.rows).toHaveLength(1);
    const step=f.rows[0];await f.service.pause(runId,'worker',step.id);expect(f.run.status).toBe('WAITING_APPROVAL');
    const decision=await f.service.decide(3,runId,step.id,true,step.argsHash,TOOL_POLICY_VERSION,2);
    expect(decision.status).toBe('QUEUED');f.run.status='RUNNING';f.run.workerToken='next-worker';f.run.leaseUntil=new Date(Date.now()+60000);
    const next={...scope,workerToken:'next-worker'};
    expect(await f.service.invoke('manage_forum_tracking',writeArgs,next,execute)).toContain('"id":8');
    expect(await f.service.invoke('manage_forum_tracking',{...writeArgs,confirmed:false},next,execute)).toContain('"id":8');
    expect(execute).toHaveBeenCalledTimes(1);expect(f.rows[0].state).toBe('SUCCEEDED');
    expect(currentToolWriteApproval(scope,writeArgs)).toBeUndefined();
  });
  test('rejecting an operation persists a refusal and never calls its write handler',async()=>{
    const f=fixture(),execute=jest.fn();await expect(f.service.invoke('manage_forum_tracking',writeArgs,scope,execute)).rejects.toBeInstanceOf(ToolApprovalPendingError);
    const step=f.rows[0];await f.service.pause(runId,'worker',step.id);await f.service.decide(3,runId,step.id,false,step.argsHash,TOOL_POLICY_VERSION,2);
    f.run.status='RUNNING';f.run.workerToken='worker';f.run.leaseUntil=new Date(Date.now()+60000);
    expect(JSON.parse(await f.service.invoke('manage_forum_tracking',writeArgs,scope,execute))).toMatchObject({success:false,data:{code:'USER_REJECTED'}});
    expect(execute).not.toHaveBeenCalled();
  });
  test('a write whose completion is unknown cannot be automatically repeated after reconstruction',async()=>{
    const f=fixture(),execute=jest.fn(async()=>{throw Error('synthetic post-write disconnect');});
    await expect(f.service.invoke('code_workspace',{action:'propose',path:'x.txt',content:'synthetic'},scope,execute)).rejects.toThrow();
    expect(f.rows[0].state).toBe('UNCERTAIN');
    await expect(new ToolRunService(f.db).invoke('code_workspace',{action:'propose',path:'x.txt',content:'synthetic'},scope,execute)).rejects.toBeInstanceOf(ToolStepUncertainError);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test('read steps are durable but are actually revalidated/read again instead of replaying stale facts or source blobs',async()=>{
    const f=fixture(),execute=jest.fn().mockResolvedValueOnce('PRIVATE_OLD_SOURCE').mockResolvedValueOnce('PRIVATE_CURRENT_SOURCE');
    expect(await f.service.invoke('get_forum_post',{postId:8},scope,execute)).toBe('PRIVATE_OLD_SOURCE');
    expect(await f.service.invoke('get_forum_post',{postId:8},scope,execute)).toBe('PRIVATE_CURRENT_SOURCE');
    expect(execute).toHaveBeenCalledTimes(2);expect(JSON.stringify(f.rows[0].result)).not.toContain('PRIVATE_');
    f.user.status='DISABLED';await expect(f.service.invoke('get_forum_post',{postId:8},scope,execute)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  test('current worker lease, ownership and history epoch are checked before any step or external invocation',async()=>{
    const f=fixture(),execute=jest.fn();
    await expect(f.service.invoke('calculator',{expression:'2+2'},{...scope,userId:99},execute)).rejects.toThrow();
    f.run.leaseUntil=new Date(0);await expect(f.service.invoke('calculator',{expression:'2+2'},scope,execute)).rejects.toThrow('租约');
    f.run.leaseUntil=new Date(Date.now()+60000);f.conversation.memoryEpoch=8;
    await expect(f.service.invoke('calculator',{expression:'2+2'},scope,execute)).rejects.toThrow('历史');
    expect(execute).not.toHaveBeenCalled();expect(f.rows).toHaveLength(0);
  });
  test('wrong hashes, revoked auth versions and changed epochs cannot approve the waiting action',async()=>{
    const f=fixture();await expect(f.service.invoke('manage_forum_tracking',writeArgs,scope,jest.fn())).rejects.toThrow();
    const step=f.rows[0];await f.service.pause(runId,'worker',step.id);
    await expect(f.service.decide(3,runId,step.id,true,'f'.repeat(64),TOOL_POLICY_VERSION,2)).rejects.toThrow('版本');
    f.user.authVersion=3;await expect(f.service.decide(3,runId,step.id,true,step.argsHash,TOOL_POLICY_VERSION,2)).rejects.toBeInstanceOf(UnauthorizedException);
    f.user.authVersion=2;f.conversation.memoryEpoch=8;await expect(f.service.decide(3,runId,step.id,true,step.argsHash,TOOL_POLICY_VERSION,2)).rejects.toThrow('版本');
    expect(step.state).toBe('WAITING_APPROVAL');
  });
  test('roleplay cannot get write capabilities, while read tools retain their own current permission checks',async()=>{
    const f=fixture();f.conversation.conversationType='ROLEPLAY';
    await expect(f.service.invoke('manage_forum_tracking',writeArgs,scope,jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.rows).toHaveLength(0);
  });
  test('public pending and history views are allowlisted, never arguments, private results or provider chains',async()=>{
    const f=fixture();await expect(f.service.invoke('manage_forum_tracking',writeArgs,scope,jest.fn())).rejects.toThrow();
    const step=f.rows[0];step.arguments.extra='PRIVATE_EXTRA';step.result={text:'PRIVATE_SOURCE'};await f.service.pause(runId,'worker',step.id);
    const pending=await f.service.approvals(3,4,2),history=await f.service.steps(3,runId,2);
    expect(pending).toHaveLength(1);expect(history[0].argsHash).toBe(step.argsHash);
    expect(JSON.stringify({pending,history})).not.toContain('PRIVATE_');
    expect(JSON.stringify(pending)).not.toContain('arguments');
  });
  test('model secrets/reasoning fields are not valid persisted tool arguments, and confirmation is excluded from identity',()=>{
    expect(toolArgsHash('manage_forum_tracking',writeArgs)).toBe(toolArgsHash('manage_forum_tracking',{...writeArgs,confirmed:false}));
    for(const key of ['reasoning_content','apiKey','password'])expect(()=>normalizedToolArgs('calculator',{[key]:'private'})).toThrow('PRIVATE_FIELD');
    expect(()=>toolPolicy('run_shell',{})).toThrow('POLICY');
  });
});
