<template>
  <el-drawer :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" title="会话文件" size="min(960px, 100vw)" class="code-workspace">
    <div class="workspace-actions">
      <el-button type="primary" :disabled="busy || refreshKey" @click="uploadInput?.click()"><el-icon><Upload /></el-icon>上传文件</el-button>
      <el-button :disabled="busy" @click="showCreate = !showCreate">新建文件</el-button>
      <el-button :disabled="busy || !workspace.files.some(f=>!f.kind)" @click="download">文本代码 ZIP</el-button>
      <el-button :disabled="busy" @click="load">刷新</el-button>
      <input ref="uploadInput" type="file" multiple hidden :accept="CHAT_FILE_ACCEPT" @change="upload" />
    </div>
    <div v-if="showCreate" class="create-code">
      <el-input v-model="newPath" placeholder="文件路径" aria-label="新文件路径" />
      <el-input v-model="newContent" type="textarea" :rows="5" placeholder="文件内容" aria-label="新文件内容" />
      <el-button type="primary" :disabled="busy || !newPath.trim()" @click="create">保存文件</el-button>
    </div>
    <p v-if="error" class="workspace-error" role="alert">{{ error }}</p>
    <el-tabs v-model="tab">
      <el-tab-pane :label="`文件 · ${workspace.files.length}`" name="files">
        <div v-if="!workspace.files.length" class="workspace-empty"><el-icon :size="32"><FolderOpened /></el-icon><h3>暂无文件</h3></div>
        <div v-else class="workspace-files"><nav aria-label="代码文件"><button v-for="file in workspace.files" :key="file.path" :class="{selected:selectedPath===file.path}" @click="readFile(file.path)"><el-icon><Document /></el-icon><span>{{ file.path }}</span><small>v{{ file.revision }}</small></button></nav>
          <div class="file-view"><header>{{ selectedPath || '选择文件查看' }} <template v-if="selectedPath"><el-button link type="primary" :disabled="busy || refreshKey" @click="attachSelected">添加到消息</el-button><el-button link type="primary" :disabled="busy" @click="downloadSelected">下载此文件</el-button><el-button link type="danger" :disabled="busy || refreshKey" @click="removeSelected">删除此文件</el-button></template></header><pre>{{ selectedContent }}</pre></div></div>
      </el-tab-pane>
      <el-tab-pane :label="`变更审查${pending ? ' · '+pending+' 待确认' : ''}`" name="changes">
        <div v-if="!workspace.changes.length" class="workspace-empty"><h3>暂无修改建议</h3></div>
        <div v-for="change in workspace.changes" :key="change.id" class="change-row"><button @click="readChange(change.id)"><strong>{{ change.path }}</strong><span>{{ change.description }}</span></button><el-tag :type="change.status==='PENDING'?'warning':change.status==='APPLIED'?'success':'info'" size="small">{{ statusLabel(change.status) }}</el-tag></div>
        <section v-if="selectedChange" class="diff-view"><header><strong>{{ selectedChange.path }}</strong><small>基于 v{{ selectedChange.baseRevision }} · 从第 {{ diff.startLine }} 行起</small></header>
          <div class="diff-columns"><div><label>删除 / 原内容</label><pre class="diff-remove">{{ diff.removed || '（无）' }}</pre></div><div><label>新增 / 修改后</label><pre class="diff-add">{{ diff.added || '（无）' }}</pre></div></div>
          <div class="diff-actions"><el-button type="primary" :disabled="busy" @click="downloadModified">下载修改版</el-button><template v-if="selectedChange.status==='PENDING'"><el-button v-if="!isDocument(selectedChange.path)" :disabled="busy || refreshKey" @click="decide('apply')">确认应用这项修改</el-button><el-button :disabled="busy || refreshKey" @click="decide('reject')">关闭此提案</el-button></template></div>
        </section>
      </el-tab-pane>
    </el-tabs>
  </el-drawer>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import request from '@/utils/request';
import { codeArchive, codeDiff } from '@/utils/code-workspace';
import { CHAT_FILE_ACCEPT, uploadChatFiles, downloadChatFile, deleteChatFile } from '@/utils/chat-files';
const props = defineProps<{ modelValue: boolean; conversationId: number; refreshKey: boolean }>();
const emit = defineEmits(['update:modelValue', 'changed', 'attach']);
const workspace = ref<{ files:any[];changes:any[] }>({ files:[], changes:[] });
const busy=ref(false),error=ref(''),tab=ref('files'),uploadInput=ref<HTMLInputElement>();
const selectedPath=ref(''),selectedContent=ref(''),selectedChange=ref<any>(null),showCreate=ref(false),newPath=ref(''),newContent=ref('');
const pending=computed(()=>workspace.value.changes.filter(c=>c.status==='PENDING').length);
const diff=computed(()=>codeDiff(selectedChange.value?.before||'',selectedChange.value?.after||''));
const statusLabel=(status:string)=>({PENDING:'待确认',APPLIED:'已应用',REJECTED:'已关闭'}[status]||status);
const isDocument=(path:string)=>/\.(pdf|docx)$/i.test(path);
let epoch=0;
async function run(operation:(base:string,current:()=>boolean)=>Promise<void>) {
  if (busy.value || !props.conversationId) return;
  const stamp=epoch,cid=props.conversationId;busy.value=true;error.value='';
  const current=()=>stamp===epoch&&cid===props.conversationId;
  try { await operation('/coding/'+cid,current); }
  catch(e:any) { if(current())error.value=e.message||'工作区操作失败'; }
  finally { if(current())busy.value=false; }
}
async function load() { await run(async(base,current)=>{const data=await request.get(base);if(current())workspace.value=data;}); }
async function importCode(files:Array<{path:string;content:string}>) {
  await run(async(base,current)=>{await request.post(base+'/files',{files});const data=await request.get(base);if(current()){workspace.value=data;showCreate.value=false;newPath.value='';newContent.value='';emit('changed');ElMessage.success('文件已保存到当前会话');}});
}
async function upload(event:Event) {
  const input=event.target as HTMLInputElement,files=Array.from(input.files||[]),cid=props.conversationId;input.value='';
  if(!files.length)return;
  await run(async(base,current)=>{try{await uploadChatFiles(cid,files,saved=>{if(current())emit('attach',saved);});}finally{const data=await request.get(base);if(current()){workspace.value=data;emit('changed');}}});
}
function attachSelected(){const file=workspace.value.files.find(f=>f.path===selectedPath.value);if(file&&!props.refreshKey){emit('attach',[file]);emit('update:modelValue',false);}}
const create=()=>importCode([{path:newPath.value.trim(),content:newContent.value}]);
async function readFile(path:string) {
  const file=workspace.value.files.find(f=>f.path===path);
  if(file?.kind){selectedPath.value=path;selectedContent.value=`${file.kind.toUpperCase()} · ${(file.bytes/1024).toFixed(1)} KB${file.pageCount?'\n'+file.pageCount+' 页':''}`;return;}
  await run(async(base,current)=>{const files=await request.get<Array<{path:string;content:string}>>(base+'/files');if(current()){selectedPath.value=path;selectedContent.value=files.find(f=>f.path===path)?.content||'';}});
}
async function downloadSelected(){const file=workspace.value.files.find(f=>f.path===selectedPath.value);if(!file?.kind){downloadChatFile(selectedPath.value,selectedContent.value);return;}await run(async(base,current)=>{const data=await request.get<Blob>(base+'/attachments/'+file.id+'/download',{responseType:'blob',timeout:60000});if(current())downloadChatFile(file.path,data);});}
async function removeSelected() {
  const file=workspace.value.files.find(f=>f.path===selectedPath.value),cid=props.conversationId;
  if(!file || props.refreshKey)return;
  await run(async(base,current)=>{
    try { await ElMessageBox.confirm(`删除“${file.path}”及其同名修改版？本机原件和已发送的消息不受影响。`,'删除附件',{confirmButtonText:'删除',cancelButtonText:'取消',type:'warning'}); }
    catch(e){if(e==='cancel'||e==='close')return;throw e;}
    if(!current() || props.refreshKey)return;
    await deleteChatFile(cid,file);
    if(current()){
      selectedPath.value='';selectedContent.value='';
      if(selectedChange.value?.path===file.path)selectedChange.value=null;
      emit('changed');ElMessage.success('附件已删除');
    }
    const data=await request.get(base);if(current())workspace.value=data;
  });
}
async function downloadModified(){const file=selectedChange.value;if(!file)return;await run(async(base,current)=>{const data=await request.get<Blob>(base+'/changes/'+file.id+'/download',{responseType:'blob',timeout:60000});if(current())downloadChatFile(file.path,data);});}
async function readChange(id:number) { await run(async(base,current)=>{const data=await request.get(base+'/changes/'+id);if(current())selectedChange.value=data;}); }
async function decide(decision:'apply'|'reject') {
  const id=selectedChange.value?.id;if(!id)return;
  await run(async(base,current)=>{const result=await request.post(base+'/changes/'+id+'/decision',{decision});const data=await request.get(base);if(current()){workspace.value=data;selectedChange.value.status=result.status;selectedPath.value='';selectedContent.value='';emit('changed');}});
}
async function download() { await run(async(base,current)=>{const files=await request.get<Array<{path:string;content:string}>>(base+'/files');if(!current())return;const url=URL.createObjectURL(codeArchive(files));const a=document.createElement('a');a.href=url;a.download='chatforum-workspace-'+props.conversationId+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}); }
watch(()=>props.conversationId,()=>{epoch++;busy.value=false;workspace.value={files:[],changes:[]};selectedChange.value=null;selectedPath.value='';selectedContent.value='';newContent.value='';newPath.value='';showCreate.value=false;});
watch(()=>[props.modelValue,props.conversationId,props.refreshKey],()=>{if(props.modelValue&&!props.refreshKey)void load();},{immediate:true});
</script>
<style scoped>
.workspace-actions { display:flex;flex-wrap:wrap;gap:8px;margin-bottom:15px; }.workspace-actions :deep(.el-button + .el-button) { margin-left:0; }
.workspace-empty { text-align:center;padding:55px 16px;color:#858b98; }.workspace-empty h3 { font-size:17px;color:#515968; }
.workspace-files { display:grid;grid-template-columns:210px minmax(0,1fr);border:1px solid #e7e9ef;border-radius:12px;overflow:hidden;min-height:380px; }.workspace-files nav { padding:8px;background:#fafbfc;max-height:540px;overflow:auto; }.workspace-files nav button { width:100%;border:0;background:transparent;display:flex;align-items:center;gap:7px;text-align:left;padding:10px 6px;font-size:12px;color:#5b6573;cursor:pointer; }.workspace-files nav button span { overflow:hidden;text-overflow:ellipsis; }.workspace-files nav button small { margin-left:auto;flex-shrink:0; }.workspace-files nav button.selected { background:#edf3ff;color:#3967ac;border-radius:6px; }
.file-view { min-width:0; }.file-view header,.diff-view header { padding:12px 15px;background:#fafbfc;border-bottom:1px solid #eaecf0;font-size:12px; }.file-view pre { margin:0;padding:15px;max-height:500px;overflow:auto;font-size:12px;line-height:1.7; }
.create-code { display:grid;gap:10px;padding:15px;background:#f8fafc;border-radius:12px;margin-bottom:15px; }.create-code :deep(textarea) { font-family:monospace; }.create-code button { justify-self:start; }.workspace-error { color:#c34c55;font-size:13px; }
.change-row { display:flex;align-items:center;gap:12px;border-bottom:1px solid #edf0f4;padding:12px 2px; }.change-row button { flex:1;min-width:0;text-align:left;background:none;border:0;cursor:pointer; }.change-row strong,.change-row span { display:block;overflow-wrap:anywhere; }.change-row strong { font-size:13px;color:#405978; }.change-row span { font-size:12px;color:#9096a1;margin-top:5px; }
.diff-view { margin-top:18px;border:1px solid #e8ebf0;border-radius:10px;overflow:hidden; }.diff-view header { display:flex;justify-content:space-between;gap:8px; }.diff-view small { color:#9096a1; }.diff-columns { display:grid;grid-template-columns:1fr 1fr; }.diff-columns>div { min-width:0; }.diff-columns label { display:block;padding:8px 12px;font-size:11px;color:#737d8b; }.diff-columns pre { margin:0;padding:12px;max-height:360px;overflow:auto;font:12px/1.7 monospace;min-height:100px; }.diff-remove { background:#fff3f3;color:#9f3d42; }.diff-add { background:#edf9f1;color:#2f6c43; }.diff-actions { padding:15px; }
@media(max-width:900px) { .workspace-files { grid-template-columns:1fr; }.workspace-files nav { max-height:140px;border-bottom:1px solid #eee; }.diff-columns { grid-template-columns:1fr; }.diff-view header { flex-direction:column; } }
</style>
