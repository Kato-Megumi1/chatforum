<template>
  <el-popover v-model:visible="visible" placement="top-end" :width="280" trigger="click" popper-class="answer-preferences-popover">
    <template #reference>
      <button type="button" class="answer-preferences-trigger" :class="{ active: deepThinking || webSearch }" aria-label="回答设置"
        :aria-expanded="visible" aria-haspopup="dialog" title="回答设置">
        <el-icon><Operation /></el-icon><span class="preferences-label">回答设置</span><i v-if="deepThinking || webSearch" class="preferences-dot" aria-hidden="true"></i>
      </button>
    </template>
    <div class="answer-preferences-panel" role="group" aria-label="本次会话的回答设置">
      <div class="preference-row"><strong>深度思考</strong>
        <el-switch :model-value="deepThinking" aria-label="深度思考" :disabled="busy" @change="set('deepThinking', $event)" /></div>
      <div class="preference-row"><strong>联网搜索</strong>
        <el-switch :model-value="webSearch" aria-label="联网搜索" :disabled="busy" @change="set('webSearch', $event)" /></div>
      <button type="button" class="preferences-models" @click="visible=false;emit('settings')"><el-icon><Setting /></el-icon>模型设置<el-icon><ArrowRight /></el-icon></button>
    </div>
  </el-popover>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { Operation, Setting, ArrowRight } from '@element-plus/icons-vue';
const props = defineProps<{ deepThinking:boolean;webSearch:boolean;busy?:boolean }>();
const emit = defineEmits<{ 'update:deepThinking':[value:boolean];'update:webSearch':[value:boolean];settings:[] }>();
const visible=ref(false);
function set(name:'deepThinking'|'webSearch',value:string|number|boolean){
  if(props.busy||typeof value!=='boolean')return;
  if(name==='deepThinking')emit('update:deepThinking',value);else emit('update:webSearch',value);
}
</script>
<style scoped>
.answer-preferences-trigger { position:relative;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:33px;padding:7px 9px;border:0;border-radius:10px;background:transparent;color:#657287;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer; }
.answer-preferences-trigger.active { color:#365d8c; }.answer-preferences-trigger:hover { background:#eef3f9; }
.answer-preferences-trigger:focus-visible,.preferences-models:focus-visible { outline:2px solid #668bdf;outline-offset:2px; }
.answer-preferences-trigger>.el-icon { font-size:16px; }.preferences-dot { width:4px;height:4px;border-radius:50%;background:#4f83c0; }
.answer-preferences-panel { color:#2e3e54; }
.preference-row { display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0; }.preference-row+ .preference-row { border-top:1px solid #edf0f5; }
.preference-row strong { display:block;font-size:13px;font-weight:500; }
.preferences-models { display:flex;align-items:center;gap:6px;width:100%;margin-top:7px;padding:11px 0 3px;background:transparent;border:0;border-top:1px solid #edf0f5;text-align:left;color:#557291;font-size:12px;cursor:pointer; }.preferences-models>.el-icon:last-child { margin-left:auto; }
@media(max-width:900px) { .answer-preferences-trigger { min-height:40px;width:34px;padding:0;flex-shrink:0; }.preferences-label { display:none; }.preferences-dot { position:absolute;top:7px;right:5px; } }
</style>
