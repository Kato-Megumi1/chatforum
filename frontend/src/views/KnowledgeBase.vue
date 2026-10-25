<template>
  <div class="novel-page" v-loading="loading">
    <div class="heading">
      <h2>小说与角色记忆</h2>
      <el-button type="primary" @click="creating = true">创建小说库</el-button>
    </div>
    <el-empty v-if="!books.length && !loading" description="暂无知识库" />
    <el-card v-for="kb in books" :key="kb.id" class="book">
      <template #header>
        <div class="heading"><strong>{{ kb.name }}</strong><el-tag>{{ kb.permission === 'READ' ? '读者' : '维护者' }}</el-tag></div>
      </template>
      <p v-if="kb.description">{{ kb.description }}</p>
      <p v-if="!kb.chatReady" class="setup-hint">{{ kb.chatUnavailableReason }}<span v-if="kb.permission === 'READ'">，请联系维护者。</span></p>
      <div class="badges">
        <el-tag :type="kb.activeIndexVersion ? 'success' : 'warning'">
          {{ kb.activeIndexVersion ? '线上索引 v' + kb.activeIndexVersion : '尚未发布索引' }}
        </el-tag>
        <el-tag v-if="kb.candidateIndexVersion">灰度 v{{ kb.candidateIndexVersion }} · {{ kb.indexCanaryPercent }}%</el-tag>
        <el-tag type="info">{{ kb.visibility === 'PUBLIC' ? '登录用户可读' : '受限访问' }}</el-tag>
      </div>
      <el-tabs>
        <el-tab-pane label="原文版本">
          <el-upload v-if="kb.permission !== 'READ'" :action="uploadUrl(kb)" :headers="uploadHeaders"
            :show-file-list="false" :before-upload="beforeUpload" :on-success="uploaded" :on-error="uploadError" accept=".epub,.txt,.pdf">
            <el-button type="primary" plain>{{ currentDoc(kb) ? '上传小说修订版' : '导入小说原文' }}</el-button>
          </el-upload>
          <div class="mobile-document-list">
            <div v-for="doc in kb.documents" :key="doc.id" class="mobile-document">
              <el-icon><Document /></el-icon><div><strong>{{ doc.fileName }}</strong>
                <p>原文 v{{ doc.version }} · {{ doc.isCurrent ? '当前版本' : '历史版本' }} · {{ doc.chunkCount }} 段</p>
                <span>{{ doc.status === 'COMPLETED' ? '已入库' : doc.status }}</span>
              </div>
            </div>
            <p v-if="!kb.documents.length">尚未导入原文</p>
          </div>
          <el-table :data="kb.documents" class="document-table">
            <el-table-column prop="fileName" label="文件" min-width="220" />
            <el-table-column prop="version" label="版本" width="70" />
            <el-table-column label="当前" width="80"><template #default="{ row }">{{ row.isCurrent ? '是' : '历史' }}</template></el-table-column>
            <el-table-column prop="status" label="处理状态" width="120" />
            <el-table-column prop="chunkCount" label="片段数" width="90" />
          </el-table>
        </el-tab-pane>
        <el-tab-pane v-if="kb.permission !== 'READ'" label="索引发布" @click="loadIndexes(kb.id)">
          <div class="actions">
            <el-button @click="build(kb.id)" :loading="busy">构建新索引</el-button>
            <el-button @click="loadIndexes(kb.id)">刷新状态</el-button>
          </div>
          <el-table :data="indexes[kb.id] || []">
            <el-table-column prop="version" label="版本" width="70" />
            <el-table-column prop="status" label="状态" width="100" />
            <el-table-column prop="chunkCount" label="片段数" width="90" />
            <el-table-column label="验证结果" min-width="150"><template #default="{ row }">
              {{ row.error || (row.metrics?.validated ? '数量一致 · 检索验证通过' : '等待验证') }}
            </template></el-table-column>
            <el-table-column v-if="kb.permission === 'ADMIN'" label="发布 / 回滚" min-width="250">
              <template #default="{ row }">
                <template v-if="['READY', 'ARCHIVED'].includes(row.status)">
                  <el-button size="small" @click="activate(kb.id, row.version)">发布 v{{ row.version }}</el-button>
                  <el-button v-if="kb.activeIndexVersion" size="small" @click="canary(kb.id, row.version)">灰度 10%</el-button>
                </template>
                <span v-else-if="row.status === 'ACTIVE'">当前线上版本</span>
              </template>
            </el-table-column>
          </el-table>
          <el-button v-if="kb.candidateIndexVersion && kb.permission === 'ADMIN'" text @click="stopCanary(kb)">停止灰度</el-button>
        </el-tab-pane>
        <el-tab-pane label="检索预览">
          <el-input v-model="queries[kb.id]" placeholder="输入人名、章节细节或对话场景" @keyup.enter="search(kb.id)">
            <template #append><el-button @click="search(kb.id)" :loading="busy">检索</el-button></template>
          </el-input>
          <p v-if="results[kb.id]">本次使用索引 v{{ results[kb.id].indexVersion }}<span v-if="results[kb.id].degraded"> · 检索服务部分降级</span></p>
          <div v-for="p in results[kb.id]?.passages || []" :key="p.citation.chunkId" class="passage">
            <strong>{{ p.citation.chapter || p.citation.fileName }} · 原文 v{{ p.citation.documentVersion }}</strong>
            <p>{{ p.content }}</p>
          </div>
        </el-tab-pane>
        <el-tab-pane label="人物与场景图谱">
          <div class="actions">
            <el-button v-if="kb.permission === 'ADMIN' && kb.activeIndexVersion" :loading="busy" @click="buildGraph(kb)">建立 / 更新实体索引</el-button>
            <el-button @click="loadGraph(kb.id)">查看图谱</el-button>
          </div>
          <template v-if="graphs[kb.id]">
            <div class="badges"><el-tag v-for="entity in graphs[kb.id].entities" :key="entity.key">{{ entity.name }} · {{ entity.mentions }} 段提及</el-tag></div>
            <el-empty v-if="!graphs[kb.id].facts?.length" description="暂无场景关系" />
            <div v-for="(fact, i) in graphs[kb.id].facts" :key="i" class="passage">
              <strong>{{ fact.subject }} → {{ fact.target || fact.predicate }}</strong>
              <p>{{ fact.text }}</p><p>{{ fact.chapter }}</p>
              <RagEvidence :metadata="{ state: 'graph', knowledgeBaseId: kb.id, indexVersion: graphs[kb.id].indexVersion, citations: [{ ...fact.citation, label: 1 }] }" />
            </div>
          </template>
        </el-tab-pane>
        <el-tab-pane v-if="kb.permission === 'ADMIN'" label="访问权限">
          <el-switch :model-value="kb.visibility === 'PUBLIC'" active-text="登录用户可读" inactive-text="受限访问" aria-label="知识库访问范围"
            @change="(v: any) => visibility(kb.id, v)" />
          <div class="actions">
            <el-input-number v-model="aclUser" :min="1" />
            <el-select v-model="aclPermission" style="width: 120px">
              <el-option label="读者" value="READ" /><el-option label="维护者" value="WRITE" /><el-option label="库管理员" value="ADMIN" />
            </el-select>
            <el-button @click="grant(kb.id)">授权用户 ID</el-button>
            <el-button @click="revoke(kb.id)">撤回授权</el-button>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>
    <el-dialog v-model="creating" title="创建角色小说库" width="min(480px, 95vw)">
      <el-form label-position="top">
        <el-form-item label="名称"><el-input v-model="form.name" placeholder="加藤惠小说库" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="form.description" type="textarea" /></el-form-item>
        <el-form-item label="访问范围"><el-switch v-model="form.shared" active-text="登录用户可读" inactive-text="仅自己和管理员" /></el-form-item>
      </el-form>
      <template #footer><el-button type="primary" @click="create" :loading="busy">创建</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import request from '@/utils/request';
import { apiUrl } from '@/utils/api';
import { useUserStore } from '@/stores/user';
import RagEvidence from '@/components/RagEvidence.vue';
const user = useUserStore();
const books = ref<any[]>([]), loading = ref(false), busy = ref(false), creating = ref(false);
const indexes = ref<Record<number, any[]>>({});
const results = ref<Record<number, any>>({}), queries = ref<Record<number, string>>({});
const graphs = ref<Record<number, any>>({});
const aclUser = ref(1), aclPermission = ref('READ'), form = ref({ name: '', description: '', shared: false });
const uploadHeaders = computed(() => ({ Authorization: 'Bearer ' + user.token }));
const currentDoc = (kb: any) => kb.documents.find((d: any) => d.isCurrent);
const base = (id: number) => '/rag/knowledge-bases/' + id;
const uploadUrl = (kb: any) => apiUrl(base(kb.id) + '/documents' +
  (currentDoc(kb) ? '/' + currentDoc(kb).id + '/versions' : ''));
async function run(fn: () => Promise<void>) {
  if (busy.value) return; busy.value = true;
  try { await fn(); } catch { /* request interceptor displays server errors */ } finally { busy.value = false; }
}
async function load() {
  loading.value = true;
  try {
    books.value = await request.get('/rag/knowledge-bases');
    await Promise.all(books.value.filter(kb => kb.permission !== 'READ').map(kb => loadIndexes(kb.id)));
  } catch { /* already displayed */ } finally { loading.value = false; }
}
async function loadIndexes(id: number) { indexes.value[id] = await request.get(base(id) + '/indexes'); }
async function loadGraph(id: number) { graphs.value[id] = await request.get(base(id) + '/graph'); }
async function buildGraph(kb: any) { await run(async () => {
  await request.post(base(kb.id) + '/indexes/' + kb.activeIndexVersion + '/graph');
  await loadGraph(kb.id); ElMessage.success('实体索引已就绪，后续问答将使用场景图谱');
}); }
async function create() { await run(async () => {
  if (!form.value.name.trim()) { ElMessage.warning('请填写知识库名称'); return; }
  await request.post('/rag/knowledge-bases', { name: form.value.name.trim(), description: form.value.description, visibility: form.value.shared ? 'PUBLIC' : 'PRIVATE' });
  creating.value = false; form.value = { name: '', description: '', shared: false }; await load();
}); }
async function build(id: number) { await run(async () => {
  try { await ElMessageBox.confirm('构建会将此库原文分批发送给服务端配置的嵌入模型供应商，并产生模型费用。确认你有权处理这些内容并同意发送？', '构建索引'); }
  catch { return; }
  await request.post(base(id) + '/reindex'); ElMessage.success('构建任务已入队，线上索引保持可用'); await loadIndexes(id);
}); }
async function activate(id: number, version: number) {
  try { await ElMessageBox.confirm('发布索引 v' + version + '？旧索引会保留，随时可切回。', '发布索引'); }
  catch { return; }
  await run(async () => { await request.post(base(id) + '/indexes/' + version + '/activate'); await load(); });
}
async function canary(id: number, version: number) { await run(async () => {
  await request.put(base(id) + '/canary', { version, percent: 10 }); await load();
}); }
async function stopCanary(kb: any) { await run(async () => {
  await request.put(base(kb.id) + '/canary', { version: kb.candidateIndexVersion, percent: 0 }); await load();
}); }
async function visibility(id: number, value: boolean) { await run(async () => {
  await request.put(base(id), { visibility: value ? 'PUBLIC' : 'SHARED' }); await load();
}); }
async function grant(id: number) { await run(async () => {
  await request.put(base(id) + '/acl/' + aclUser.value, { permission: aclPermission.value }); ElMessage.success('已授权');
}); }
async function revoke(id: number) { await run(async () => {
  await request.delete(base(id) + '/acl/' + aclUser.value); ElMessage.success('已撤回');
}); }
async function search(id: number) { await run(async () => {
  if (!queries.value[id]?.trim()) return;
  results.value[id] = await request.post(base(id) + '/search', { query: queries.value[id], topK: 6 });
}); }
function beforeUpload(file: File) {
  if (file.size > 50 * 1024 * 1024) { ElMessage.warning('最大 50MB'); return false; }
  return true;
}
function uploaded(response: any) {
  if (!response.success) return ElMessage.error(response.message || '上传失败');
  ElMessage.success('原文已保存，请构建并发布新索引'); void load();
}
function uploadError() { ElMessage.error('上传失败，请检查登录状态、权限和网络'); }
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(() => {
    for (const kb of books.value) {
      if (indexes.value[kb.id]?.some(i => i.status === 'BUILDING'))
        void loadIndexes(kb.id).catch(() => undefined);
    }
  }, 5000);
});
onUnmounted(() => clearInterval(timer));
</script>
<style scoped>
.novel-page { width: 100%; height: 100%; overflow-y: auto; max-width: 1120px; margin: auto; padding: 24px; }
@media (max-width: 640px) { .novel-page { padding: 16px 12px 40px; } }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.heading h2 { margin-bottom: 6px; }
.heading p, .book p { color: #677387; line-height: 1.7; }
.book { margin: 20px 0; min-width: 0; overflow-wrap: anywhere; }
.badges, .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 12px 0; }
.passage { padding: 16px 0; border-bottom: 1px solid #e7eaf0; }
.passage p { white-space: pre-wrap; }
.setup-hint { padding: 12px; border-radius: 10px; background: #fff9ed; }
.mobile-document-list { display: none; }
@media (max-width: 900px) {
  .novel-page { padding: 18px 16px 28px; background: #faf9f7; }
  .heading { gap: 14px; }
  .heading h2 { font-size: 25px; color: #302c31; letter-spacing: -.6px; }
  .heading p { font-size: 12px; color: #a0949c; margin-top: 10px; }
  .heading > .el-button { border-radius: 20px; background: #a66b83; border: 0; padding: 18px 16px; }
  .book { border: 1px solid #eee7eb; border-radius: 20px; box-shadow: 0 4px 20px #3e303b04; }
  .book :deep(.el-card__header) { padding: 20px 18px; background: #fffcfd; border-color: #f2edf0; }
  .book :deep(.el-card__body) { padding: 18px; }
  .book p { font-size: 12px; line-height: 1.85; }
  .book strong { font-size: 16px; color: #493c45; }
  .badges { gap: 6px; margin: 16px 0; }
  .badges .el-tag { font-size: 10px; border: 0; border-radius: 7px; }
  .book :deep(.el-tabs__item) { font-size: 12px; padding: 0 14px; }
  .book :deep(.el-tabs__nav-wrap::after) { height: 1px; background: #f0eaee; }
  .document-table { display: none; }
  .mobile-document-list { display: block; margin-top: 16px; }
  .mobile-document { display: flex; align-items: flex-start; gap: 12px; padding: 16px 12px; background: #f8f5f7; border-radius: 14px; margin: 10px 0; }
  .mobile-document > .el-icon { font-size: 23px; color: #aa7b92; padding-top: 2px; flex-shrink: 0; }
  .mobile-document > div { min-width: 0; }
  .mobile-document strong { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; line-height: 1.8; font-weight: 500; }
  .mobile-document p { font-size: 10px; color: #a0949c; margin: 6px 0; }
  .mobile-document span { font-size: 10px; color: #728b7b; }
}
</style>
