<template>
  <el-dialog :model-value="modelValue" title="举报内容" width="min(440px, 92vw)" :close-on-click-modal="!sending" @update:model-value="close">
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="举报原因"><el-select v-model="reason" aria-label="举报原因" style="width:100%">
        <el-option v-for="choice in choices" :key="choice" :label="choice" :value="choice" />
      </el-select></el-form-item>
      <el-form-item label="补充说明"><el-input v-model="detail" type="textarea" :rows="4" maxlength="1800" show-word-limit placeholder="说明需要管理员核查的问题" aria-label="举报补充说明" /></el-form-item>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
    </el-form>
    <template #footer><el-button :disabled="sending" @click="close(false)">取消</el-button><el-button type="primary" :loading="sending" :disabled="!reason || reason === '其他' && !detail.trim()" @click="submit">提交举报</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import request from '@/utils/request';
import { useUserStore } from '@/stores/user';
const props=defineProps<{modelValue:boolean;type:'POST'|'COMMENT';targetId:number}>();
const emit=defineEmits<{(event:'update:modelValue',value:boolean):void}>();
const user=useUserStore(), choices=['垃圾广告','人身攻击','隐私泄露','违法违规','其他'];
const reason=ref(''),detail=ref(''),sending=ref(false),error=ref('');
let requestId='',generation=0;
const sameSession=(session:ReturnType<typeof user.getAuthSession>)=>{const current=user.getAuthSession();return current.userId===session.userId&&current.epoch===session.epoch;};
function reset(){generation++;reason.value='';detail.value='';error.value='';sending.value=false;requestId=crypto.randomUUID();}
watch(()=>[props.modelValue,props.type,props.targetId,user.user?.id,user.token],reset);
function close(value:boolean){if(!sending.value)emit('update:modelValue',value);}
async function submit(){
  if(sending.value||!props.modelValue||!user.user||!reason.value||reason.value==='其他'&&!detail.value.trim())return;
  const current=++generation,session=user.getAuthSession();sending.value=true;error.value='';
  if(!requestId)requestId=crypto.randomUUID();
  try{
    await request.post('/forum/reports',{requestId,type:props.type,targetId:props.targetId,reason:reason.value,detail:detail.value});
    if(current!==generation||!sameSession(session))return;
    ElMessage.success('举报已提交');emit('update:modelValue',false);
  }catch(e:any){if(current===generation&&sameSession(session))error.value=e?.message||'举报暂时未能提交';}
  finally{if(current===generation)sending.value=false;}
}
</script>
