<template>
  <div class="assistant-composer">
    <div v-if="files?.length" class="attachment-list" aria-label="待发送附件">
      <div v-for="file in files" :key="`${file.kind || 'text'}-${file.id}`" class="attachment-chip">
        <button class="attachment-open" @click="emit('files')" :title="file.path"><el-icon><Document /></el-icon><span>{{ file.path }}</span></button>
        <button class="attachment-remove" :disabled="busy || uploading || removing" :aria-label="`移除待发送附件 ${file.path}`" @click="emit('remove',file)"><el-icon><Close /></el-icon></button>
      </div>
    </div>
    <el-input class="chat-textarea" :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" type="textarea"
      :autosize="{ minRows: 3, maxRows: 10 }" placeholder="输入消息…" :disabled="busy"
      @paste="pasteFiles" @keydown.enter="emit('enter', $event)" aria-label="消息输入" />
    <div class="composer-bottom">
      <div class="composer-tools">
        <el-popover v-model:visible="uploadMenu" placement="top-start" :width="180" trigger="click">
          <template #reference><button class="add-file" aria-label="添加文件" :disabled="busy || uploading || removing"><el-icon><Plus /></el-icon></button></template>
          <button class="upload-file-menu" :disabled="busy || uploading || removing" @click="openPicker"><el-icon><Upload /></el-icon>{{ uploading ? '正在上传…' : '上传文件' }}</button>
          <button class="upload-file-menu library-menu" @click="uploadMenu=false;emit('files')"><el-icon><FolderOpened /></el-icon>会话文件<span v-if="libraryFiles?.length">{{ libraryFiles.length }}</span></button>
          <button class="upload-file-menu mobile-settings-menu" @click="uploadMenu=false;emit('settings')"><el-icon><Setting /></el-icon>模型设置</button>
        </el-popover>
        <input ref="fileInput" type="file" :accept="CHAT_FILE_ACCEPT" multiple hidden @change="chooseFiles" />
        <div class="composer-modes" role="group" aria-label="回答模式">
          <button :class="{ selected: mode === 'normal' }" :aria-pressed="mode === 'normal'" :disabled="busy" @click="emit('update:mode', 'normal')">普通</button>
          <button :class="{ selected: mode === 'agent' }" :aria-pressed="mode === 'agent'" :disabled="busy" @click="emit('update:mode', 'agent')"><el-icon><MagicStick /></el-icon>Agent</button>
        </div>
        <button class="tool-pill coding-button" :class="{ enabled: coding && mode === 'agent' }" @click="emit('coding')" :disabled="busy" aria-label="打开编程 Agent 工作区"><span class="code-symbol">&lt;/&gt;</span><span class="coding-label-desktop">编程 Agent</span><span class="coding-label-mobile">编程</span></button>
        <AnswerPreferences :deep-thinking="deepThinking" :web-search="webSearch" :busy="busy || uploading || removing"
          @update:deep-thinking="emit('update:deepThinking',$event)" @update:web-search="emit('update:webSearch',$event)" @settings="emit('settings')" />
      </div>
      <button v-if="busy && !uploading && !removing" class="composer-send stop" aria-label="停止生成" @click="emit('stop')"><span></span></button>
      <button v-else class="composer-send btn-send" aria-label="发送消息" :disabled="(!modelValue.trim() && !files?.length) || uploading || removing" @pointerdown.prevent @click="emit('send')"><el-icon><Top /></el-icon></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import AnswerPreferences from '@/components/AnswerPreferences.vue';
import { CHAT_FILE_ACCEPT, type ChatFile } from '@/utils/chat-files';
import { clipboardFiles } from '@/utils/clipboard-files';
const props = defineProps<{ modelValue: string; mode: string; busy: boolean; coding: boolean; deepThinking:boolean;webSearch:boolean; files?: ChatFile[]; libraryFiles?:ChatFile[]; uploading?: boolean; removing?: boolean }>();
const fileInput = ref<HTMLInputElement>();
const uploadMenu=ref(false);
const emit = defineEmits(['update:modelValue', 'update:mode', 'update:deepThinking','update:webSearch', 'enter', 'send', 'stop', 'settings', 'coding', 'disableCoding', 'upload', 'files', 'remove']);
function openPicker(){
  uploadMenu.value=false;
  if(props.busy || props.uploading || props.removing)return;
  fileInput.value?.click();
}
function chooseFiles(event:Event) {
  const input=event.target as HTMLInputElement;
  const files=Array.from(input.files||[]);
  input.value='';
  if(props.busy || props.uploading || props.removing)return;
  if(files.length)emit('upload',files);
}
function pasteFiles(event:ClipboardEvent) {
  const files=clipboardFiles(event.clipboardData,props.libraryFiles?.map(f=>f.path));
  if(!files.length)return; // Leave ordinary text/code paste to the browser, including cursor/selection behavior.
  event.preventDefault();
  if(props.busy || props.uploading || props.removing)return;
  uploadMenu.value=false;emit('upload',files);
}
</script>

<style scoped>
.assistant-composer { width: 100%; padding: 17px 18px 12px; border: 1px solid #b7c7dc; background: #fff; border-radius: 25px; box-shadow: 0 6px 24px #253f6212, 0 1px 3px #253f6208; box-sizing: border-box; }
.assistant-composer:focus-within { border-color: #6084b7; box-shadow: 0 0 0 3px #557fb514, 0 6px 24px #253f6212; }
.assistant-composer :deep(.el-textarea__inner) { box-shadow: none; background: transparent; resize: none; padding: 2px 6px 12px; font-size: 16px; line-height: 1.7; color: #202733; }
.assistant-composer :deep(.el-textarea__inner::placeholder) { color: #657287; }
.composer-bottom { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
.add-file { display:grid;place-items:center;width:33px;height:33px;border-radius:50%;background:#e8edf4;font-size:22px;color:#334a68;flex-shrink:0; }
.upload-file-menu { width:100%;display:flex;gap:9px;align-items:center;padding:12px;border:0;background:#f2f5fa;border-radius:9px;color:#273c59;cursor:pointer;font-size:14px; }
.attachment-list { display:flex;gap:8px;overflow-x:auto;padding:0 4px 12px; }
.attachment-chip { display:flex;align-items:center;gap:4px;flex-shrink:0;max-width:250px;border:1px solid #d4dfed;background:#f3f6fb;border-radius:11px;padding:5px 6px 5px 10px;font-size:12px; }
.attachment-open { display:flex;align-items:center;gap:7px;min-width:0;padding:4px 0; }.attachment-open span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.attachment-remove { width:28px;height:28px;display:grid;place-items:center;flex-shrink:0;border-radius:7px;font-size:14px; }
.attachment-remove:hover:not(:disabled) { background:#e4eaf3;color:#223e65; }
.composer-tools { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
.composer-modes { display: flex; padding: 3px; border-radius: 18px; background: #e7ecf3; gap: 2px; }
button { font: inherit; cursor: pointer; border: 0; background: transparent; color: #435166; }
button:disabled { cursor: not-allowed; opacity: .5; }
button:focus-visible { outline: 2px solid #668bdf; outline-offset: 2px; }
.composer-modes button { display: inline-flex; align-items: center; gap: 4px; padding: 6px 11px; font-size: 13px; border-radius: 15px; }
.composer-modes button.selected { color: #203f6c; background: white; box-shadow: 0 1px 4px #253f6226; font-weight: 600; }
.tool-pill { border-radius: 16px; font-size: 13px; padding: 8px 9px; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.tool-pill:hover { background: #eaf0f8; color: #243d62; }
.tool-pill.enabled { background: #e0eafa; color: #234f89; }
.coding-label-mobile, .mobile-settings-menu { display: none; }
.code-symbol { font-size: 13px; font-weight: 600; }
.composer-send { display: flex; align-items: center; justify-content: center; flex: 0 0 36px; width: 36px; height: 36px; border-radius: 50%; background: #2d4d77; color: white; font-size: 20px; }
.composer-send:disabled { background: #e0e6ef; color: #77869b; opacity: 1; }
.stop span { width: 11px; height: 11px; background: white; border-radius: 2px; }
.library-menu { margin-top:6px;background:transparent; }.library-menu span { margin-left:auto;font-size:12px;color:#657287; }
@media(max-width: 900px) {
  .assistant-composer { border-radius: 21px; padding: 13px 10px 10px; }
  .composer-bottom { gap: 6px; }
  .composer-tools { flex-wrap: nowrap; gap: 4px; }
  .add-file { width: 40px; height: 40px; border-radius: 11px; font-size: 23px; }
  .composer-modes { flex-shrink: 0; padding: 2px; gap: 0; border-radius: 11px; }
  .composer-modes button { min-height: 40px; padding: 0 8px; gap: 3px; border-radius: 9px; font-size: 12px; }
  .tool-pill { flex-shrink: 0; min-height: 40px; border-radius: 10px; font-size: 12px; padding: 0 7px; gap: 4px; }
  .coding-label-desktop, .settings-tool { display: none; }
  .coding-label-mobile { display: none; }
  .coding-button { width:34px;padding:0;justify-content:center; }
  .mobile-settings-menu { display: flex; margin-top: 6px; background: transparent; }
  .composer-send { flex-basis: 40px; width: 40px; height: 40px; }
  .attachment-remove { width: 36px; height: 36px; }
  .upload-file-menu { min-height: 44px; }
}
@media(max-width: 370px) {
  .composer-tools { gap: 2px; }
  .composer-modes button { padding-right: 7px; padding-left: 7px; }
  .coding-button { padding-right: 5px; padding-left: 5px; }
}
</style>
