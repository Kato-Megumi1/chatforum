import request from './request';

export interface ToolApproval {
  id:string;runId:string;argsHash:string;policyVersion:'tool-execution-v1';state:'WAITING_APPROVAL';
  title:string;details:Record<string,string|number>;
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
export function readToolApproval(value:unknown):ToolApproval|undefined{
  const raw=value as any;
  if(!raw||!uuid(raw.id)||!uuid(raw.runId)||typeof raw.argsHash!=='string'||!/^[a-f\d]{64}$/.test(raw.argsHash)||
    raw.policyVersion!=='tool-execution-v1'||raw.state!=='WAITING_APPROVAL'||raw.toolName!=='manage_forum_tracking')return;
  const details:Record<string,string|number>={};
  for(const key of ['id','postId','categoryId','hours','cooldownSeconds'])
    if(Number.isSafeInteger(raw.details?.[key])&&raw.details[key]>0)details[key]=raw.details[key];
  for(const key of ['kind','rankingBasis','query'])if(typeof raw.details?.[key]==='string')details[key]=raw.details[key].slice(0,160);
  return{id:raw.id,runId:raw.runId,argsHash:raw.argsHash,policyVersion:raw.policyVersion,state:raw.state,
    title:typeof raw.title==='string'?raw.title.slice(0,40):'论坛追踪操作',details};
}
export async function fetchToolApprovals(conversationId:number,signal?:AbortSignal):Promise<ToolApproval[]>{
  const rows=await request.get<unknown>('/chat/tool-runs/approvals?conversationId='+conversationId,{signal,_quiet:true});
  return Array.isArray(rows)?rows.slice(0,30).map(readToolApproval).filter((item):item is ToolApproval=>!!item):[];
}
export async function decideToolApproval(item:ToolApproval,approved:boolean){
  const safe=readToolApproval({...item,toolName:'manage_forum_tracking'});
  if(!safe)throw Error('操作确认信息无效，请刷新后重试');
  return request.post<{runId:string;status:string}>('/chat/tool-runs/'+safe.runId+'/steps/'+safe.id+'/decision',
    {approved,argsHash:safe.argsHash,policyVersion:safe.policyVersion});
}
export const readToolRunStatus=(runId:string)=>request.get<{status:string}>('/chat/runs/'+runId,{_quiet:true});
