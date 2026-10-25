<template>
  <el-drawer :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" title="编程工作区" size="min(860px, 100vw)" class="local-code-workspace">
    <div class="folder-hero"><div class="folder-mark"><el-icon><FolderOpened /></el-icon></div><h2>{{ connection ? connection.name : '选择项目文件夹' }}</h2></div>
    <div v-if="!supported" class="local-notice">当前浏览器不支持本机目录，请使用文件副本。</div>
    <el-checkbox v-model="consent" :disabled="busy">允许 Agent 直接读写我选择的文件夹，并发送相关代码片段给当前模型</el-checkbox>
    <div class="local-actions"><el-button type="primary" :disabled="!supported || !consent || busy || selecting" @click="choose">{{ connection ? '更换文件夹' : '选择本机文件夹' }}</el-button><el-button v-if="connection" @click="disconnect">断开连接</el-button><el-button v-if="connection" @click="refresh">刷新文件</el-button></div>
    <p v-if="error || localWorkspaceError" role="alert" class="local-error">{{ error || localWorkspaceError }}</p>
    <div v-if="connection" class="local-files"><nav aria-label="本机项目文件"><button v-for="path in paths" :key="path" @click="read(path)">{{ path }}</button><p v-if="!paths.length">暂无代码文件</p></nav><pre>{{ preview || '点击文件查看内容' }}</pre></div>
    <section v-if="localActivity.length && connection" class="local-activity"><h3>本次文件操作</h3><div v-for="item in localActivity" :key="item.id"><code>{{ item.action }} {{ item.path }}</code><span>{{ item.status }}</span></div></section>
    <details class="cloud-fallback"><summary>会话文件</summary><el-button :disabled="busy" @click="openCloud">打开文件副本</el-button></details>
    <CodeWorkspace v-model="showCloud" :append-to-body="true" :conversation-id="conversationId" :refresh-key="busy" />
  </el-drawer>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { FolderOpened } from '@element-plus/icons-vue';
import CodeWorkspace from './CodeWorkspace.vue';
import { connectLocalFolder, disconnectLocalWorkspace, localConnection, localWorkspace, localWorkspaceError, localActivity, supportsLocalWorkspace } from '@/utils/local-workspace';
const props = defineProps<{ modelValue: boolean; conversationId: number; ownerId: number; busy: boolean }>();
const emit = defineEmits(['update:modelValue', 'cloud']);
const supported = supportsLocalWorkspace(), consent = ref(false), selecting = ref(false), error = ref(''), paths = ref<string[]>([]), preview = ref(''), showCloud = ref(false);
const connection = computed(() => localConnection(props.conversationId, props.ownerId));
const selectedPath = ref('');
let mounted = true;
onBeforeUnmount(() => { mounted = false; });
async function choose() {
  if (!consent.value || props.busy) return;
  const cid = props.conversationId, owner = props.ownerId; selecting.value = true; error.value = '';
  try {
    // Keep the picker in the user gesture, before any network await.
    const root = await (window as any).showDirectoryPicker({ mode: 'readwrite', id: 'chatforum-code' });
    if (!mounted || cid !== props.conversationId || owner !== props.ownerId || !props.modelValue) return;
    if (await root.queryPermission({ mode: 'readwrite' }) !== 'granted') throw Error('未获得目录读写授权');
    if (!mounted || cid !== props.conversationId || owner !== props.ownerId || !props.modelValue) return;
    await connectLocalFolder(root, cid, owner); await refresh();
  } catch (e: any) { if (e.name !== 'AbortError') error.value = e.message || '目录连接失败'; }
  finally { selecting.value = false; }
}
function disconnect() { disconnectLocalWorkspace(); paths.value = []; preview.value = ''; selectedPath.value = ''; }
async function refresh() { const c = connection.value; if (!c) return; try { const result = await c.files.list(); if (connection.value === c) { paths.value = result.paths; if (result.truncated) error.value = '项目较大，此处仅显示受限扫描结果；可直接指定文件路径读取。'; if (selectedPath.value) await read(selectedPath.value); } } catch(e: any) { error.value = e.message; } }
async function read(path: string) { const c = connection.value; if (!c) return; selectedPath.value = path; try { const result = await c.files.execute({ action: 'read', path }); if (connection.value === c && selectedPath.value === path) preview.value = result.content + (result.nextLine ? '\n…文件较长，Agent 可继续分段读取。' : ''); } catch(e: any) { error.value = e.message; preview.value = ''; } }
function openCloud() { if (connection.value) disconnect(); emit('cloud'); emit('update:modelValue', false); showCloud.value = true; }
watch(() => props.conversationId, () => { paths.value = []; preview.value = ''; selectedPath.value = ''; showCloud.value = false; consent.value = false; error.value = ''; });
watch(() => [props.modelValue, localWorkspace.value?.id, localActivity.value.length], () => { if (props.modelValue) void refresh(); });
</script>
<style scoped>
.folder-hero{text-align:center;padding:20px 0}.folder-mark{display:grid;place-items:center;margin:auto;background:#e3edfc;color:#40699d;width:62px;height:62px;border-radius:20px;font-size:32px}.folder-hero h2{font-size:23px;overflow-wrap:anywhere}.folder-hero p,.local-hint{font-size:13px;color:#627084;line-height:1.8}.local-notice{background:#eef3fa;border:1px solid #dce5f2;padding:14px;border-radius:12px;color:#455874;font-size:13px;line-height:1.8;margin:14px 0}.local-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.local-actions :deep(.el-button){margin:0}.local-error{color:#b34844;font-size:13px}.local-files{display:grid;grid-template-columns:190px minmax(0,1fr);border:1px solid #dce3ee;border-radius:12px;overflow:hidden}.local-files nav{max-height:330px;overflow:auto;background:#eef2f7;padding:8px}.local-files button{display:block;text-align:left;border:0;background:none;cursor:pointer;padding:9px;width:100%;overflow-wrap:anywhere;color:#365883}.local-files pre{overflow:auto;padding:14px;margin:0;max-height:330px;background:#fafbfd;font-size:12px}.local-files p{font-size:13px;line-height:1.8}.local-activity div{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #e4eaf2;font-size:12px;overflow-wrap:anywhere}.local-activity h3{font-size:15px}.cloud-fallback{margin-top:25px;color:#5d6a7b;font-size:13px;line-height:1.8}.cloud-fallback summary{cursor:pointer}:deep(.el-checkbox){height:auto;align-items:flex-start}:deep(.el-checkbox__label){white-space:normal;line-height:1.6}@media(max-width:600px){.local-files{grid-template-columns:1fr}.local-files nav{max-height:150px}.folder-hero{padding:8px 0}.local-activity div{flex-direction:column}}
</style>
