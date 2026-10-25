<template>
  <main class="reports-page">
    <el-page-header title="返回社区" @back="$router.push('/forum')" />
    <section class="reports-card">
      <h1>举报与申诉</h1>
      <nav class="report-tabs" aria-label="举报记录分类"><button :class="{active:kind==='mine'}" @click="setKind('mine')">我的举报</button><button :class="{active:kind==='decisions'}" @click="setKind('decisions')">我的处理与申诉</button></nav>
      <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button link @click="load(false)">重试</el-button></el-alert>
      <el-skeleton v-if="loading && !rows.length" :rows="5" animated />
      <el-empty v-else-if="!rows.length" :description="kind==='mine'?'暂无举报记录':'暂无内容处理记录'" />
      <article v-for="item in rows" :key="item.id" :id="'report-'+item.id" class="report-item">
        <div class="report-heading"><strong>{{ item.type==='COMMENT'?'评论':'帖子' }} #{{ item.commentId || item.targetId }}</strong><el-tag :type="statusType(item)">{{ statusText(item) }}</el-tag></div>
        <router-link v-if="item.post" :to="'/forum/post/'+item.targetId">{{ item.post.title }}</router-link>
        <p v-if="kind==='mine'" class="report-reason">{{ item.reason }}</p>
        <p v-if="item.decisionReason">处理说明：{{ item.decisionReason }}</p>
        <div v-if="item.appeal" class="appeal-record"><strong>申诉{{ appealText(item.appeal.status) }}</strong><p>{{ item.appeal.reason }}</p><p v-if="item.appeal.decisionReason">{{ item.appeal.decisionReason }}</p></div>
        <div class="report-footer"><time>{{ date(item.createdAt) }}</time><el-button v-if="kind==='decisions' && item.decision==='HIDE' && !item.appeal" size="small" @click="beginAppeal(item)">提交申诉</el-button></div>
      </article>
      <el-button v-if="nextCursor" class="load-more" :loading="loading" @click="load(true)">加载更多</el-button>
    </section>
    <el-dialog v-model="appealOpen" title="提交申诉" width="min(480px, 92vw)" :close-on-click-modal="!appealing">
      <el-input v-model="appealReason" type="textarea" :rows="5" maxlength="2000" show-word-limit placeholder="说明你认为需要复核的原因" aria-label="申诉原因" />
      <el-alert v-if="appealError" :title="appealError" type="error" :closable="false" />
      <template #footer><el-button :disabled="appealing" @click="appealOpen=false">取消</el-button><el-button type="primary" :loading="appealing" :disabled="!appealReason.trim()" @click="submitAppeal">提交申诉</el-button></template>
    </el-dialog>
  </main>
</template>
<script setup lang="ts">
import {ref,watch,onUnmounted,nextTick} from 'vue';
import {useRoute} from 'vue-router';
import {ElMessage} from 'element-plus';
import request from '@/utils/request';
import {useUserStore} from '@/stores/user';
const user=useUserStore(),route=useRoute(),kind=ref<'mine'|'decisions'>('mine'),rows=ref<any[]>([]),nextCursor=ref<number|null>(null),loading=ref(false),error=ref('');
if(route.query.tab==='decisions')kind.value='decisions';
const appealOpen=ref(false),appealReason=ref(''),appealError=ref(''),appealing=ref(false),selected=ref<any>(null);let generation=0,appealGeneration=0;
const date=(value:string)=>new Date(value).toLocaleString('zh-CN');
const sameSession=(session:ReturnType<typeof user.getAuthSession>)=>{const current=user.getAuthSession();return current.userId===session.userId&&current.epoch===session.epoch;};
const appealText=(state:string)=>(({PENDING:'待处理',ACCEPTED:'已通过',REJECTED:'未通过'} as Record<string,string>)[state]||state);
const statusText=(item:any)=>item.decision==='RESTORED'?'已恢复':(({PENDING:'待处理',RESOLVED:'已处理',REJECTED:'未采纳'} as Record<string,string>)[item.status]||item.status);
const statusType=(item:any)=>item.decision==='RESTORED'?'success':item.status==='PENDING'?'warning':'info';
function reset(){generation++;appealGeneration++;rows.value=[];nextCursor.value=null;error.value='';loading.value=false;appealOpen.value=false;appealReason.value='';appealError.value='';appealing.value=false;selected.value=null;}
function setKind(value:'mine'|'decisions'){if(kind.value===value)return;kind.value=value;reset();void load(false);}
async function load(more=false){
  const current=++generation,session=user.getAuthSession();if(!user.user)return;loading.value=true;error.value='';
  try{
    const endpoint=kind.value==='mine'?'/forum/reports':'/forum/reports/decisions';
    const data=await request.get(endpoint,{params:{...(more&&nextCursor.value?{before:nextCursor.value}:{}),limit:20}});
    if(current!==generation||!sameSession(session))return;
    rows.value=more?[...rows.value,...data.rows]:data.rows;nextCursor.value=data.nextCursor;
    const target=Number(route.query.case);if(!more&&Number.isSafeInteger(target)&&target>0){await nextTick();document.getElementById('report-'+target)?.scrollIntoView({block:'center'});}
  }catch(e:any){if(current===generation&&sameSession(session))error.value=e?.message||'记录暂时无法加载';}
  finally{if(current===generation)loading.value=false;}
}
function beginAppeal(item:any){selected.value=item;appealReason.value='';appealError.value='';appealOpen.value=true;}
async function submitAppeal(){
  if(!selected.value||appealing.value||!appealReason.value.trim())return;
  const current=++appealGeneration,session=user.getAuthSession(),target=selected.value;appealing.value=true;appealError.value='';
  try{await request.post('/forum/reports/'+target.id+'/appeal',{expectedRevision:target.revision,reason:appealReason.value});
    if(current!==appealGeneration||!sameSession(session))return;appealOpen.value=false;ElMessage.success('申诉已提交');await load(false);
  }catch(e:any){if(current===appealGeneration&&sameSession(session))appealError.value=e?.message||'申诉暂时未能提交';}
  finally{if(current===appealGeneration)appealing.value=false;}
}
watch(()=>[user.user?.id,user.token],()=>{reset();void load(false);},{immediate:true});
watch(()=>route.fullPath,()=>{kind.value=route.query.tab==='decisions'?'decisions':'mine';reset();void load(false);});
onUnmounted(reset);
</script>
<style scoped>
.reports-page{max-width:880px;margin:0 auto;padding:24px 20px 70px}.reports-card{margin-top:20px;background:#fff;border:1px solid #e7edf5;border-radius:20px;padding:28px}h1{margin:0 0 22px;font-size:25px}.report-tabs{display:flex;gap:8px;margin-bottom:18px}.report-tabs button{border:0;border-radius:12px;padding:12px 16px;color:#596b84;background:#f3f6fa;font:inherit;cursor:pointer}.report-tabs button.active{background:#e8f4ff;color:#2674ba}.report-item{padding:20px 0;border-bottom:1px solid #edf1f6}.report-heading,.report-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.report-item a{display:inline-block;margin-top:10px;color:#3178b4;text-decoration:none}.report-item p{white-space:pre-wrap;line-height:1.65;overflow-wrap:anywhere;color:#52647d}.report-footer{font-size:13px;color:#8b98aa}.appeal-record{margin:14px 0;padding:14px;background:#f6f8fb;border-radius:12px}.load-more{display:flex;margin:22px auto 0}@media(max-width:900px){.reports-page{padding:16px 12px 80px}.reports-card{padding:20px 16px;border-radius:16px}.report-tabs button{padding:11px;font-size:14px}.report-item{padding:18px 0}}
</style>
