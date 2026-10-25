<template>
  <div v-if="artifacts?.length && ownsSession()" class="file-artifacts" aria-label="生成的文件">
    <article v-for="file in artifacts" :key="file.changeId" class="artifact-card">
      <div class="artifact-main">
        <el-icon class="artifact-icon"><Document /></el-icon>
        <div class="artifact-copy"><strong>{{ file.path }}</strong></div>
        <button :disabled="downloading.has(file.changeId)" @click="download(file)" :aria-label="'下载修改版 ' + file.path"><el-icon><Download /></el-icon>下载</button>
      </div>
      <ArtifactReview v-if="isHtmlArtifact(file.path)" :conversation-id="conversationId" :change-id="file.changeId" :path="file.path" :review="file.review" />
    </article>
  </div>
</template>
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import request from '@/utils/request';
import { downloadChatFile } from '@/utils/chat-files';
import { useUserStore } from '@/stores/user';
import { isHtmlArtifact, type ArtifactReviewSummary } from '@/utils/artifact-review';
import ArtifactReview from '@/components/ArtifactReview.vue';
interface FileArtifact { changeId: number; path: string; review?: ArtifactReviewSummary }
const props = defineProps<{ conversationId: number; artifacts?: FileArtifact[] }>();
const user = useUserStore(), owner = user.getAuthSession();
const downloading = ref(new Set<number>()), requests = new Map<number, AbortController>();
let active = true, version = 0;
const ownsSession = () => { const current = user.getAuthSession(); return !!user.token && owner.userId !== null && current.userId === owner.userId && current.epoch === owner.epoch; };
function reset() { version++; for (const connection of requests.values()) connection.abort(); requests.clear(); downloading.value = new Set(); }
watch(() => { const session = user.getAuthSession(); return `${props.conversationId}:${session.userId}:${session.epoch}:${!!user.token}`; }, reset, { flush: 'sync' });
onUnmounted(() => { active = false; reset(); });
async function download(file: FileArtifact) {
  if (!active || !ownsSession() || downloading.value.has(file.changeId) || !Number.isSafeInteger(file.changeId) || file.changeId < 1 || !Number.isSafeInteger(props.conversationId) || props.conversationId < 1) return;
  const cid = props.conversationId, stamp = version, connection = new AbortController();
  const current = () => active && stamp === version && props.conversationId === cid && ownsSession();
  requests.set(file.changeId, connection); downloading.value.add(file.changeId);
  try {
    const saved = await request.get<Blob>(`/coding/${cid}/changes/${file.changeId}/download`,{responseType:'blob',timeout:60000,signal:connection.signal});
    if (current() && props.artifacts?.some(item => item.changeId === file.changeId && item.path === file.path)) downloadChatFile(file.path, saved);
  } catch(e:any) { if (current() && !connection.signal.aborted) ElMessage.error(e.message || '下载失败，请重试'); }
  finally { if (current()) { requests.delete(file.changeId); downloading.value.delete(file.changeId); } }
}
</script>
<style scoped>
.file-artifacts { display:grid;gap:9px;margin-top:14px;max-width:500px; }.artifact-card { border:1px solid #ccd8e7;background:#f5f8fc;border-radius:14px;padding:13px; }.artifact-main { display:flex;align-items:center;gap:12px; }.artifact-icon { font-size:25px;color:#426ba2; }.artifact-copy { flex:1;min-width:0; }.artifact-card strong { display:block;font-size:13px;overflow-wrap:anywhere;color:#2c405c; }.artifact-main>button { display:flex;gap:4px;align-items:center;border:1px solid #d0dced;border-radius:9px;padding:8px;background:white;color:#315e99;cursor:pointer;flex-shrink:0; }.artifact-main>button:disabled { opacity:.5;cursor:wait; }
</style>
