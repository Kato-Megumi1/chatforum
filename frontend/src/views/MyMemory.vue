<template>
  <section class="memory-page">
    <header class="memory-heading"><el-button text @click="router.back()"><el-icon><ArrowLeft /></el-icon>返回</el-button><h1>我的记忆</h1></header>
    <div class="memory-toolbar">
      <el-select v-model="conversationId" filterable placeholder="选择对话" aria-label="选择对话" @change="loadEntries(false)">
        <el-option v-for="conversation in conversations" :key="conversation.id" :value="conversation.id"
          :label="conversation.title + (conversation.conversationType === 'ROLEPLAY' ? ' · ' + (conversation.personaLabel || '角色对话') : '')" />
      </el-select>
      <el-button v-if="nextConversation" :loading="loadingConversations" @click="loadConversations(true)">更多对话</el-button>
      <el-radio-group v-model="filter" aria-label="记忆筛选"><el-radio-button value="all">全部</el-radio-button><el-radio-button value="pinned">已固定</el-radio-button></el-radio-group>
      <el-button :loading="loading || loadingConversations" @click="conversationId ? loadEntries(false) : loadConversations()"><el-icon><Refresh /></el-icon>刷新</el-button>
    </div>
    <div v-if="rebuilding" class="memory-state" role="status"><el-icon class="is-loading"><Loading /></el-icon>正在整理较早的记忆</div>
    <p v-if="loadError" role="alert">{{ loadError }}</p>
    <el-skeleton v-if="loading && !entries.length" :rows="5" animated />
    <el-empty v-else-if="!visibleEntries.length" :description="rebuilding ? '记忆整理中' : '还没有记忆'" />
    <div v-else class="memory-list">
      <article v-for="entry in visibleEntries" :key="entry.kind + ':' + entry.id" class="memory-card">
        <div class="memory-card-heading"><el-tag v-if="entry.kind === 'pin'" effect="light" round><el-icon><StarFilled /></el-icon>已固定</el-tag><span v-else>对话摘录</span></div>
        <p :class="{'memory-excerpt': entry.text.length > 240 && !expanded.has(entry.kind + ':' + entry.id)}">{{ entry.text }}</p>
        <el-button v-if="entry.text.length > 240" class="excerpt-toggle" text @click="toggleExcerpt(entry)">{{ expanded.has(entry.kind + ':' + entry.id) ? '收起' : '展开' }}</el-button>
        <footer>
          <el-button text :disabled="busy || confirming" @click="showSources(entry)"><el-icon><Link /></el-icon>查看来源</el-button>
          <el-button text :disabled="busy || confirming" @click="mutate(entry, entry.kind === 'pin' ? 'unpin' : 'pin')"><el-icon><Star /></el-icon>{{ entry.kind === 'pin' ? '取消固定' : '固定' }}</el-button>
          <el-button text type="danger" :disabled="busy || confirming" @click="forget(entry)"><el-icon><Delete /></el-icon>删除记忆</el-button>
        </footer>
      </article>
    </div>
    <el-button v-if="nextBefore" class="load-more" :loading="loading" @click="loadEntries(true)">更早的记忆</el-button>
    <el-dialog v-model="sourceDialog" title="记忆来源" width="min(680px, calc(100vw - 24px))" @closed="sources = []">
      <el-skeleton v-if="loadingSources" :rows="5" animated />
      <p v-else-if="sourceError" role="alert">{{ sourceError }}</p>
      <article v-for="source in sources" :key="source.id" class="memory-source">
        <header>{{ source.role === 'user' ? '我' : '回复' }}<el-button text @click="openSource(source.id)">定位原消息<el-icon><TopRight /></el-icon></el-button></header>
        <p>{{ source.content }}</p><span v-if="source.truncated" class="source-truncated">长消息可通过“定位原消息”查看全文。</span>
      </article>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, Delete, Link, Loading, Refresh, Star, StarFilled, TopRight } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import { useUserStore } from '@/stores/user';
import request from '@/utils/request';

interface Conversation {id:number;title:string;conversationType:string;personaLabel?:string}
interface Entry {kind:'episode'|'pin';id:number;text:string;sourceIds:number[];pinned:boolean;version:string}
interface Source {id:number;role:string;content:string;truncated:boolean}
const router=useRouter(),route=useRoute(),user=useUserStore();
const conversations=ref<Conversation[]>([]),conversationId=ref<number>(),nextConversation=ref<number|null>(null);
const entries=ref<Entry[]>([]),nextBefore=ref<number|null>(null),filter=ref('all');
const expanded=ref(new Set<string>());
const loading=ref(false),loadingConversations=ref(false),busy=ref(false),confirming=ref(false),rebuilding=ref(false);
const loadError=ref('');
const sourceDialog=ref(false),sources=ref<Source[]>([]),loadingSources=ref(false),sourceError=ref('');
let generation=0,sourceGeneration=0,alive=true,loadedConversationId:number|undefined,rebuildTimer:ReturnType<typeof setTimeout>|undefined;
const visibleEntries=computed(()=>entries.value.filter(entry=>filter.value!=='pinned'||entry.kind==='pin'));
const current=(session:ReturnType<typeof user.getAuthSession>,stamp:number,cid?:number)=>alive&&stamp===generation&&
  user.getAuthSession().userId===session.userId&&user.getAuthSession().epoch===session.epoch&&(cid===undefined||conversationId.value===cid);
const action=(entry:Entry)=>({kind:entry.kind,id:entry.id,version:entry.version});
function toggleExcerpt(entry:Entry){const key=entry.kind+':'+entry.id,next=new Set(expanded.value);next.has(key)?next.delete(key):next.add(key);expanded.value=next;}
async function loadConversations(more=false) {
  const session=user.getAuthSession(),stamp=generation;loadingConversations.value=true;
  try {
    const page=await request.get<{items:Conversation[];nextBefore:number|null}>('/chat/memory/conversations'+(more&&nextConversation.value?'?before='+nextConversation.value:''));
    if(!current(session,stamp))return;
    conversations.value=more?[...conversations.value,...page.items]:page.items;nextConversation.value=page.nextBefore;
    if(!conversationId.value){
      const requested=typeof route.query.conversationId==='string'&&/^\d+$/.test(route.query.conversationId)?Number(route.query.conversationId):0;
      conversationId.value=Number.isSafeInteger(requested)&&requested>0?requested:conversations.value[0]?.id;
      if(conversationId.value)await loadEntries(false);
    }
  } catch {if(current(session,stamp))loadError.value='对话读取失败，请刷新重试。';}
  finally {if(alive&&user.getAuthSession().epoch===session.epoch)loadingConversations.value=false;}
}
async function loadEntries(more=false) {
  if(!conversationId.value)return;
  if(rebuildTimer)clearTimeout(rebuildTimer);
  const cid=conversationId.value,session=user.getAuthSession(),stamp=++generation;
  if(loadedConversationId!==cid){entries.value=[];expanded.value.clear();nextBefore.value=null;sourceDialog.value=false;sources.value=[];sourceGeneration++;loadedConversationId=cid;}
  loading.value=true;loadError.value='';
  try {
    const page=await request.get<{conversation?:Conversation;items:Entry[];nextBefore:number|null;rebuildStatus:string}>(
      '/chat/memory/'+cid+(more&&nextBefore.value?'?before='+nextBefore.value:''));
    if(!current(session,stamp,cid))return;
    if(page.conversation&&!conversations.value.some(item=>item.id===cid))conversations.value.unshift(page.conversation);
    entries.value=more?[...entries.value,...page.items]:page.items;nextBefore.value=page.nextBefore;
    rebuilding.value=['QUEUED','RUNNING'].includes(page.rebuildStatus);
    if(rebuilding.value&&!more){
      const poll=()=>{if(!current(session,stamp,cid))return;
        if(document.hidden||sourceDialog.value||busy.value||confirming.value){rebuildTimer=setTimeout(poll,3000);return;}
        void loadEntries(false);
      };rebuildTimer=setTimeout(poll,3000);
    }
  } catch {if(current(session,stamp,cid))loadError.value='记忆读取失败，请刷新重试。';}
  finally {if(current(session,stamp,cid))loading.value=false;}
}
async function mutate(entry:Entry,operation:'pin'|'unpin'|'forget') {
  if(busy.value||!conversationId.value)return;
  const cid=conversationId.value,session=user.getAuthSession(),stamp=generation;busy.value=true;
  try {
    await request.post('/chat/memory/'+cid+'/'+operation,action(entry));
    if(current(session,stamp,cid)){if(operation==='forget'){sourceDialog.value=false;sources.value=[];}await loadEntries(false);}
  } catch { /* The shared request handler reports the mutation error. */ }
  finally {if(alive&&user.getAuthSession().epoch===session.epoch)busy.value=false;}
}
async function forget(entry:Entry) {
  if(confirming.value||busy.value)return;
  const cid=conversationId.value,session=user.getAuthSession(),stamp=generation;
  confirming.value=true;
  try {await ElMessageBox.confirm('聊天原文会保留，但这段来源不再用于后续记忆。','删除这段记忆？',{confirmButtonText:'删除记忆',cancelButtonText:'取消',type:'warning'});}
  catch {return;}
  finally {if(user.getAuthSession().epoch===session.epoch)confirming.value=false;}
  if(current(session,stamp,cid))await mutate(entry,'forget');
}
async function showSources(entry:Entry) {
  if(!conversationId.value)return;
  const cid=conversationId.value,session=user.getAuthSession(),stamp=generation,sourceStamp=++sourceGeneration;
  sourceDialog.value=true;sources.value=[];sourceError.value='';loadingSources.value=true;
  try {
    const data=await request.post<{messages:Source[]}>('/chat/memory/'+cid+'/sources',action(entry));
    if(current(session,stamp,cid)&&sourceStamp===sourceGeneration&&sourceDialog.value)sources.value=data.messages;
  } catch {if(current(session,stamp,cid)&&sourceStamp===sourceGeneration)sourceError.value='来源读取失败，请刷新记忆后重试。';}
  finally {if(sourceStamp===sourceGeneration)loadingSources.value=false;}
}
function openSource(messageId:number) {
  if(!conversationId.value)return;
  void router.push({path:'/chat',query:{conversationId:String(conversationId.value),messageId:String(messageId)}});
}
watch([()=>user.user?.id,()=>{void user.token;return user.getAuthSession().epoch;}],()=>{
  generation++;sourceGeneration++;if(rebuildTimer)clearTimeout(rebuildTimer);
  conversations.value=[];entries.value=[];expanded.value.clear();sources.value=[];conversationId.value=undefined;
  sourceDialog.value=false;busy.value=false;confirming.value=false;loading.value=false;loadingSources.value=false;
  loadingConversations.value=false;rebuilding.value=false;nextBefore.value=null;nextConversation.value=null;loadError.value='';
  loadedConversationId=undefined;
  const stamp=generation;
  void nextTick(()=>{if(alive&&stamp===generation&&user.user)void loadConversations();});
},{flush:'sync'});
onMounted(()=>void loadConversations().catch(()=>undefined));
onBeforeUnmount(()=>{alive=false;generation++;sourceGeneration++;if(rebuildTimer)clearTimeout(rebuildTimer);sources.value=[];entries.value=[];});
</script>

<style scoped lang="scss">
.memory-card p.memory-excerpt{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}.excerpt-toggle{margin:-8px 0 8px;padding-left:0}
.memory-page{max-width:1000px;margin:auto;padding:28px 24px 48px}.memory-heading{display:flex;align-items:center;gap:20px;margin-bottom:24px}.memory-heading h1{font-size:24px;margin:0}.memory-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:22px}.memory-toolbar .el-select{flex:1;min-width:240px;max-width:460px}.memory-list{display:grid;gap:16px}.memory-card{background:var(--el-bg-color);border:1px solid var(--el-border-color-light);border-radius:18px;padding:20px 24px}.memory-card-heading{color:var(--el-text-color-secondary);font-size:13px}.memory-card-heading .el-icon{margin-right:5px}.memory-card p,.memory-source p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8;margin:14px 0}.memory-card footer{display:flex;gap:6px;flex-wrap:wrap}.memory-card footer .el-button+.el-button{margin-left:0}.memory-state{display:flex;align-items:center;gap:8px;margin:8px 0 20px;color:var(--el-color-primary)}.load-more{display:block;margin:24px auto 0}.memory-source{padding:12px 0;border-bottom:1px solid var(--el-border-color-lighter)}.memory-source header{display:flex;align-items:center;justify-content:space-between;font-weight:600}.source-truncated{color:var(--el-text-color-secondary);font-size:13px}@media(max-width:900px){.memory-page{padding:16px 12px 28px}.memory-heading{margin-bottom:20px;gap:12px}.memory-heading h1{font-size:21px}.memory-toolbar{gap:10px}.memory-toolbar .el-select{min-width:100%;max-width:none}.memory-card{padding:16px;border-radius:16px}.memory-card footer .el-button{padding:8px}.memory-card p{font-size:15px}}
</style>
