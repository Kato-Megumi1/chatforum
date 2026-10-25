<template>
  <div class="create-post-container">
    <div class="create-post-wrapper">
      <el-page-header @back="goBack" title="返回" class="page-header" />
      <div class="create-post-main" v-loading="loading">
        <div class="editor-heading"><h1 class="page-title">{{ editing ? '编辑帖子' : '发布帖子' }}</h1><span class="draft-state" aria-live="polite">{{ savedLabel }}</span></div>
        <el-alert v-if="conflict" type="warning" title="帖子已被其他页面修改，你的草稿仍在。请先查看最新内容再决定如何合并。" :closable="false"><el-button link @click="openLatest">查看最新内容</el-button></el-alert>
        <el-form :model="form" label-position="top" class="post-form">
          <el-form-item label="标题">
            <el-input
              v-model="form.title"
              placeholder="请输入帖子标题"
              maxlength="150"
              show-word-limit
              size="large"
            />
          </el-form-item>
          <el-row :gutter="16">
            <el-col :xs="24" :sm="12">
              <el-form-item label="分类">
                <el-select v-model="form.categoryId" placeholder="请选择分类" size="large" style="width: 100%">
                  <el-option
                    v-for="cat in categories"
                    :key="cat.id"
                    :label="cat.name"
                    :value="cat.id"
                  />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :xs="24" :sm="12">
              <el-form-item label="标签">
                <el-select
                  v-model="form.tags"
                  multiple
                  filterable
                  remote
                  reserve-keyword
                  :remote-method="searchTags"
                  :loading="tagsLoading"
                  @visible-change="onTagsOpen"
                  allow-create
                  placeholder="选择或创建标签"
                  size="large"
                  style="width: 100%"
                >
                  <el-option v-for="tag in tagOptions" :key="tag.name" :label="tag.name" :value="tag.name" />
                  <template v-if="tagsError || tagsHasMore" #footer>
                    <el-button v-if="tagsError" link @click="loadTags(false)">标签暂未加载，重试</el-button>
                    <el-button v-else-if="tagsHasMore" link :loading="tagsLoading" @click="loadTags(true)">加载更多标签</el-button>
                  </template>
                </el-select>
              </el-form-item>
            </el-col>
          </el-row>
          <el-form-item label="内容">
            <div class="editor-switch"><el-button :type="preview ? 'default' : 'primary'" size="small" plain @click="preview = false">编辑</el-button><el-button :type="preview ? 'primary' : 'default'" size="small" plain @click="preview = true">预览</el-button></div>
            <el-input
              v-if="!preview"
              v-model="form.content"
              type="textarea"
              :rows="18"
              maxlength="50000"
              show-word-limit
              placeholder="想说什么就直接写吧..."
              class="content-textarea"
              aria-label="帖子内容"
            />
            <div v-else class="plain-preview">{{ form.content || '写下内容后，就能在这里查看排版。' }}</div>
          </el-form-item>
          <el-form-item>
            <div class="form-actions">
              <el-button type="primary" :loading="submitting" @click="handleSubmit" size="large" round class="btn-submit">
                {{ editing ? '保存修改' : '发布帖子' }}
              </el-button>
              <el-button size="large" round @click="goBack">返回</el-button>
              <el-button v-if="hasDraft" link type="info" @click="clearDraft">清除草稿</el-button>
            </div>
          </el-form-item>
        </el-form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, watch, computed } from 'vue';
import { useRouter, useRoute, onBeforeRouteLeave } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import request from '@/utils/request';
import { useUserStore } from '@/stores/user';
import { forumDraftKey } from '@/utils/forum-experience';

const router = useRouter();
const route = useRoute(), userStore = useUserStore();
// The old editor unmounts after the shared route has already changed. Keep every
// draft, revision and request bound to this mounted editor, never the next route.
const editorPostId = String(route.params.id || '');
const editing = computed(() => !!editorPostId);
const account = userStore.user?.id || 0;
const draftKey = forumDraftKey(account, editorPostId || undefined);

const categories = ref<any[]>([]);
const tags = ref<any[]>([]);
const tagsLoading = ref(false), tagsHasMore = ref(false), tagsError = ref(false);
const tagOptions = computed(() => [...new Map([...form.tags.map(name => ({ name })), ...tags.value].map(tag => [tag.name, tag])).values()]);
let tagsQuery = '', tagsCursor = '', tagsRequestId = 0;
const submitting = ref(false);
const loading = ref(false), preview = ref(false), hasDraft = ref(false), conflict = ref(false), savedLabel = ref('');
const revision = ref(0);
const contentFormat = ref<'plain' | 'markdown'>('plain');
let ready = false, published = false, timer: ReturnType<typeof setTimeout> | undefined, baseline = '', observedForm = '';

const form = reactive({
  title: '',
  categoryId: null as number | null,
  tags: [] as string[],
  content: '',
});
const snapshot = () => JSON.stringify({ ...form, revision: revision.value });
const changed = () => ready && !published && snapshot() !== baseline;
function saveDraft() {
  if (!ready || published || userStore.user?.id !== account) return;
  if (!changed()) { savedLabel.value = ''; return; }
  try { localStorage.setItem(draftKey, JSON.stringify({ userId: account, postId: editorPostId, ...form, revision: revision.value, savedAt: Date.now() }));
    hasDraft.value = true; savedLabel.value = '草稿已保存 · ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch { savedLabel.value = '草稿未保存，请保持页面打开'; }
}
watch(form, () => {
  if (!ready) return;
  const current = snapshot();
  // An async option list can re-emit an equivalent select model; that is not a user edit.
  if (current === observedForm) return;
  observedForm = current; savedLabel.value = '正在保存…'; clearTimeout(timer); timer = setTimeout(saveDraft, 500);
}, { deep: true, flush: 'sync' });
watch(() => userStore.user?.id, id => {
  if (id === account) return;
  ready = false; published = true; clearTimeout(timer);
  tagsRequestId++; tags.value = []; tagsLoading.value = false; tagsHasMore.value = false; tagsQuery = ''; tagsCursor = '';
  Object.assign(form, { title: '', categoryId: null, tags: [], content: '' });
  savedLabel.value = ''; hasDraft.value = false;
});
function restoreDraft() {
  try { const value = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (!value || value.userId !== account || value.postId !== editorPostId || typeof value.title !== 'string' || typeof value.content !== 'string') return;
    // Never silently truncate a restored draft; the editor and server share the same limits.
    form.title = value.title; form.content = value.content;
    form.categoryId = Number.isSafeInteger(value.categoryId) ? value.categoryId : null;
    form.tags = Array.isArray(value.tags) ? value.tags.filter((s: unknown) => typeof s === 'string').slice(0, 10) : [];
    // Keep the draft's base revision; restoring it must not silently overwrite newer edits.
    if (editing.value && Number.isSafeInteger(value.revision)) { conflict.value = revision.value !== value.revision; revision.value = value.revision; }
    hasDraft.value = true; savedLabel.value = '已恢复上次草稿';
  } catch { /* malformed or unavailable local draft is ignored */ }
}
async function clearDraft() {
  try { await ElMessageBox.confirm('清除后不能恢复这份本机草稿。', '清除草稿？', { confirmButtonText: '清除', cancelButtonText: '保留' }); }
  catch { return; }
  clearTimeout(timer); localStorage.removeItem(draftKey); hasDraft.value = false; savedLabel.value = '草稿已清除';
  ready = false;
  if (editing.value) { const original = JSON.parse(baseline); Object.assign(form, { title: original.title, categoryId: original.categoryId, tags: original.tags, content: original.content }); revision.value = original.revision; conflict.value = false; }
  else { Object.assign(form, { title: '', categoryId: null, tags: [], content: '' }); baseline = snapshot(); }
  observedForm = snapshot(); ready = true;
}
function goBack() { router.push(editing.value ? '/forum/post/' + editorPostId : '/forum'); }
function openLatest() { window.open(router.resolve('/forum/post/' + editorPostId).href, '_blank', 'noopener'); }
function beforeUnload(event: BeforeUnloadEvent) { if (changed()) { saveDraft(); event.preventDefault(); event.returnValue = ''; } }
onBeforeRouteLeave(async () => {
  if (!changed()) return true; saveDraft();
  try { await ElMessageBox.confirm(hasDraft.value ? '未发布内容已保存在本机草稿，之后可继续编辑。' : '草稿未能保存，离开会丢失未发布内容。', '离开编辑页面？', { confirmButtonText: '离开', cancelButtonText: '继续编辑' }); return true; }
  catch { return false; }
});

const loadCategories = async () => {
  const data = await request.get('/forum/categories');
  categories.value = (data as any).data || (data as unknown as any[]);
};

async function loadTags(append = false) {
  if (userStore.user?.id !== account || (append && (tagsLoading.value || !tagsCursor))) return;
  const stamp = ++tagsRequestId;
  tagsLoading.value = true; tagsError.value = false;
  try {
    const data = await request.get('/forum/tag-options', { params: { q: tagsQuery, limit: 30, ...(append ? { cursor: tagsCursor } : {}) } });
    if (stamp !== tagsRequestId || userStore.user?.id !== account) return;
    tags.value = append ? [...tags.value, ...data.data] : data.data;
    tagsCursor = data.nextCursor || ''; tagsHasMore.value = !!data.hasMore && !!tagsCursor;
  } catch { if (stamp === tagsRequestId) tagsError.value = true;
  } finally { if (stamp === tagsRequestId) tagsLoading.value = false; }
}
function searchTags(query: string) { tagsQuery = query; tagsCursor = ''; tags.value = []; void loadTags(); }
function onTagsOpen(visible: boolean) { if (visible && !tags.value.length && !tagsLoading.value) void loadTags(); }

const handleSubmit = async () => {
  if (userStore.user?.id !== account) { ElMessage.warning('登录账号已变化，请重新打开编辑页面'); return; }
  if (!form.title.trim()) {
    ElMessage.warning('请输入标题');
    return;
  }

  if (!form.categoryId) {
    ElMessage.warning('请选择分类');
    return;
  }

  if (!form.content.trim()) {
    ElMessage.warning('请输入内容');
    return;
  }

  submitting.value = true;
  try {
    const input = {
      title: form.title.trim(),
      categoryId: form.categoryId,
      tags: form.tags,
      content: form.content.trim(),
      contentFormat: contentFormat.value,
      ...(editing.value ? { expectedRevision: revision.value } : {}),
    };
    const data = editing.value ? await request.put('/forum/posts/' + editorPostId, input) : await request.post('/forum/posts', input);
    published = true; clearTimeout(timer); localStorage.removeItem(draftKey);
    ElMessage.success(editing.value ? '修改已保存' : '发布成功');
    router.push(`/forum/post/${(data as any).id}`);
  } catch (error: any) {
    if (error.response?.status === 409) conflict.value = true;
    saveDraft();
  } finally {
    submitting.value = false;
  }
};

onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  void loadCategories().catch(() => {}); void loadTags().catch(() => {});
  if (editing.value) {
    loading.value = true;
    try { const post: any = await request.get('/forum/posts/' + editorPostId);
      if (userStore.user?.id !== account) return;
      if (post.user.id !== account) { published = true; await router.replace('/forum/post/' + editorPostId); return; }
      Object.assign(form, { title: post.title, content: post.content, categoryId: post.categoryId || post.category?.id || null, tags: post.tags?.map((t: any) => t.tag.name) || [] });
      revision.value = post.revision;
      contentFormat.value = post.contentFormat === 'markdown' ? 'markdown' : 'plain';
    } catch { published = true; await router.replace('/forum'); return; } finally { loading.value = false; }
  }
  baseline = snapshot(); restoreDraft(); observedForm = snapshot(); ready = true;
});
onUnmounted(() => { tagsRequestId++; clearTimeout(timer); saveDraft(); window.removeEventListener('beforeunload', beforeUnload); });
</script>

<style lang="scss" scoped>
.create-post-container {
  height: 100%;
  overflow-y: auto;
  background: var(--bg-page);
}

.create-post-wrapper {
  max-width: 860px;
  margin: 0 auto;
  padding: 24px 20px;
}

.page-header {
  margin-bottom: 16px;
}

.create-post-main {
  background: #fff;
  border-radius: var(--radius-lg);
  padding: 36px;
  box-shadow: var(--shadow-sm);
}

.page-title {
  margin: 0 0 28px;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
}
.editor-heading { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 12px; }
.draft-state { color: var(--text-secondary); font-size: 12px; margin-bottom: 16px; }
.editor-switch { display: flex; width: 100%; gap: 8px; margin-bottom: 10px; }
.plain-preview { min-height: 360px; white-space: pre-wrap; overflow-wrap: anywhere; width: 100%; padding: 16px; line-height: 1.9; color: var(--text-primary); border: 1px solid var(--border-light); border-radius: 10px; }

.post-form {
  :deep(.el-form-item__label) {
    font-weight: 600;
    color: var(--text-primary);
    font-size: 14px;
  }

  :deep(.el-input__wrapper),
  :deep(.el-select .el-input__wrapper) {
    border-radius: var(--radius-sm);
  }
}

.content-textarea {
  :deep(.el-textarea__inner) {
    border-radius: var(--radius-sm);
    resize: vertical;
    font-size: 14px;
    line-height: 1.8;
    box-shadow: none;
  }
}

.form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.btn-submit {
  box-shadow: 0 4px 14px rgba(22, 93, 255, 0.3);
  transition: all var(--transition);

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 20px rgba(22, 93, 255, 0.4);
  }
}
@media (max-width: 640px) {
  .create-post-wrapper { padding: 16px 12px 48px; }
  .create-post-main { padding: 20px 16px; }
}
@media (max-width: 900px) {
  .create-post-container { background: #faf9f7; }
  .create-post-main { border: 1px solid #eee7eb; border-radius: 20px; box-shadow: none; }
  .page-title { color: #3c333a; }
  .btn-submit { background: #a66b83; border: 0; box-shadow: none; }
}
</style>
