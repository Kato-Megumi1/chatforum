<template>
  <section v-if="items.length||error" class="tool-approvals" aria-label="待确认操作">
    <div v-if="error" class="approval-error" role="status"><span>{{ error }}</span><button type="button" @click="load">重试</button></div>
    <article v-for="item in items" :key="item.id" class="tool-approval-card" data-testid="tool-approval-card">
      <h3>{{ item.title }}</h3>
      <dl v-if="Object.keys(item.details).length">
        <template v-for="(value,key) in item.details" :key="key"><dt>{{ detailName(key) }}</dt><dd>{{ detailValue(key,value) }}</dd></template>
      </dl>
      <div class="approval-actions">
        <button type="button" class="approve" :disabled="busy===item.id" @click="decide(item,true)">{{ busy===item.id?'处理中…':'确认执行' }}</button>
        <button type="button" :disabled="busy===item.id" @click="decide(item,false)">不执行</button>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount,onMounted,ref,watch } from 'vue';
import { useUserStore } from '@/stores/user';
import { decideToolApproval,fetchToolApprovals,readToolRunStatus,type ToolApproval } from '@/utils/tool-approvals';
const props=defineProps<{conversationId?:number|null;revision?:number}>();
const emit=defineEmits<{changed:[value:{runId:string;status:string}]}>();
const user=useUserStore(),items=ref<ToolApproval[]>([]),busy=ref<string|null>(null),error=ref('');
const sameSession=(session:ReturnType<typeof user.getAuthSession>)=>{const now=user.getAuthSession();return now.userId===session.userId&&now.epoch===session.epoch;};
let generation=0,controller:AbortController|undefined,timer:ReturnType<typeof setInterval>|undefined;
const knownRuns=new Set<string>();
const detailName=(key:string)=>({id:'追踪编号',kind:'类型',postId:'帖子',categoryId:'分类',hours:'窗口',rankingBasis:'排行依据',query:'关键词',cooldownSeconds:'合并间隔'}[key]||key);
const detailValue=(key:string,value:string|number)=>key==='hours'?value+' 小时':key==='cooldownSeconds'?value+' 秒':
  ({NEW_POSTS:'新帖',POST_ACTIVITY:'帖子动态',HOT_RISE:'热榜变化',published:'发布时间',interaction:'窗口内互动'}[value]||value);
async function load(){
  if(!props.conversationId||!user.user){items.value=[];knownRuns.clear();error.value='';return;}
  controller?.abort();controller=new AbortController();
  const stamp=++generation,cid=props.conversationId,session=user.getAuthSession();
  const current=()=>stamp===generation&&props.conversationId===cid&&sameSession(session);
  try{
    const next=await fetchToolApprovals(cid,controller.signal);
    if(!current())return;
    error.value='';
    items.value=next;
    const waiting=new Set(next.map(item=>item.runId));
    for(const runId of knownRuns)if(!waiting.has(runId)){
      const state=await readToolRunStatus(runId);
      if(!current())return;
      if(state.status!=='WAITING_APPROVAL'){knownRuns.delete(runId);emit('changed',{runId,status:state.status});}
    }
    for(const runId of waiting)knownRuns.add(runId);
  }catch{if(current())error.value='操作确认暂时加载失败';}
}
async function decide(item:ToolApproval,approved:boolean){
  if(busy.value||!items.value.some(row=>row.id===item.id)||!props.conversationId)return;
  const stamp=generation,cid=props.conversationId,session=user.getAuthSession();busy.value=item.id;
  try{
    const result=await decideToolApproval(item,approved);
    if(stamp!==generation||props.conversationId!==cid||!sameSession(session))return;
    items.value=items.value.filter(row=>row.id!==item.id);
    if(result.status!=='WAITING_APPROVAL')knownRuns.delete(item.runId);
    emit('changed',{runId:item.runId,status:result.status});
  }catch{if(stamp===generation&&props.conversationId===cid&&sameSession(session))error.value='操作未确认，请重试';}
  finally{if(sameSession(session))busy.value=null;}
}
watch(()=>[props.conversationId,props.revision,user.user,user.token],()=>{generation++;controller?.abort();items.value=[];knownRuns.clear();busy.value=null;error.value='';void load();},{immediate:true});
onMounted(()=>{timer=setInterval(()=>{if(!document.hidden&&!busy.value)void load();},3000);});
onBeforeUnmount(()=>{generation++;controller?.abort();if(timer)clearInterval(timer);knownRuns.clear();});
</script>

<style scoped>
.tool-approvals{margin:14px 0;display:grid;gap:10px;max-width:680px}
.approval-error{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;color:#986739}
.tool-approval-card{border:1px solid #c6d9ed;border-radius:14px;padding:15px 17px;background:#f6faff;color:#263c57}
h3{font-size:14px;margin:0 0 10px;font-weight:600}
dl{display:grid;grid-template-columns:auto 1fr;gap:5px 16px;margin:0 0 13px;font-size:13px;line-height:1.5}
dt{color:#64768c}dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
.approval-actions{display:flex;gap:10px;flex-wrap:wrap}
button{font:inherit;font-size:13px;min-height:36px;padding:6px 15px;border:1px solid #c5d6e7;border-radius:9px;color:#365d88;background:white;cursor:pointer}
button.approve{background:#315d8e;color:white;border-color:#315d8e}button:disabled{opacity:.55;cursor:wait}
button:focus-visible{outline:2px solid #4394d2;outline-offset:3px}
@media(max-width:900px){.tool-approval-card{padding:14px}.approval-actions button{min-height:42px}}
</style>
