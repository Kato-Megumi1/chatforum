<template>
  <div ref="root" class="forum-search-input" @focusin="showHistory" @focusout="leaveHistory" @keydown.esc.stop.prevent="closeHistory(true)">
    <el-input ref="input" :model-value="modelValue" placeholder="搜索帖子标题或内容..." aria-label="搜索帖子"
      maxlength="200" :prefix-icon="Search" size="large" clearable autocomplete="off" :aria-controls="visible ? historyId : undefined"
      @update:model-value="emit('update:modelValue', String($event))" @keydown="inputKeydown" @click="inputClick" @clear="clearSearch" />
    <section v-if="visible" :id="historyId" class="search-history" aria-label="搜索历史">
      <div class="history-heading"><span>最近搜索</span><button type="button" @pointerdown.prevent @click="clearHistory">清空</button></div>
      <p v-if="storageError" role="alert" class="history-error">暂时无法清除浏览器历史，请检查站点存储权限。</p>
      <ul>
        <li v-for="entry in history" :key="entry.query">
          <button type="button" class="history-query" data-history-query @pointerdown.prevent @click="selectHistory(entry)" @keydown="historyKeydown($event, entry)"><el-icon aria-hidden="true"><Clock /></el-icon><span>{{ entry.query }}</span></button>
          <button type="button" class="history-remove" :aria-label="'删除搜索记录：' + entry.query" @pointerdown.prevent @click="removeHistory(entry)"><el-icon aria-hidden="true"><Close /></el-icon></button>
        </li>
      </ul>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { Clock, Close, Search } from '@element-plus/icons-vue';
import type { InputInstance } from 'element-plus';
import { clearForumSearchHistory, readForumSearchHistory, rememberForumSearch, removeForumSearch, submittedForumQuery,
  type ForumSearchEntry, type SearchHistoryStorage } from '@/utils/forum-search-history';

const props = defineProps<{ modelValue: string; accountId?: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; submit: []; clear: [] }>();
const root = ref<HTMLElement>(), input = ref<InputInstance>(), history = ref<ForumSearchEntry[]>([]), open = ref(false), storageError = ref(false);
const historyId = 'forum-search-history-' + useId();
const visible = computed(() => open.value && history.value.length > 0);
let focusAccount: number | undefined, suppressFocus = false, restoringItemFocus = false;
function storage(): SearchHistoryStorage | undefined { try { return window.localStorage; } catch { return undefined; } }
function refreshHistory() { history.value = readForumSearchHistory(props.accountId, storage()); }
function showHistory() {
  if (suppressFocus) return;
  refreshHistory(); storageError.value = false; focusAccount = props.accountId; open.value = true;
}
function leaveHistory(event: FocusEvent) {
  if (restoringItemFocus) return;
  if (!root.value?.contains(event.relatedTarget as Node | null)) open.value = false;
}
function closeHistory(focus = false) {
  open.value = false;
  if (focus) { suppressFocus = true; input.value?.focus(); void nextTick(() => { suppressFocus = false; }); }
}
function submit() {
  const query = submittedForumQuery(props.modelValue);
  emit('update:modelValue', query);
  if (query) rememberForumSearch(props.accountId, query, storage());
  refreshHistory(); closeHistory(); emit('submit');
}
function inputKeydown(event: KeyboardEvent) {
  // Enter committing Chinese IME text is not a submitted search.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter') { event.preventDefault(); submit(); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    showHistory();
    if (!visible.value) return;
    event.preventDefault();
    void nextTick(() => { const buttons = root.value?.querySelectorAll<HTMLButtonElement>('[data-history-query]');
      buttons?.[event.key === 'ArrowDown' ? 0 : buttons.length - 1]?.focus(); });
  }
}
function validEntry(entry: ForumSearchEntry) { return open.value && focusAccount === props.accountId && history.value.includes(entry); }
function selectHistory(entry: ForumSearchEntry) {
  if (!validEntry(entry)) return;
  emit('update:modelValue', entry.query);
  rememberForumSearch(props.accountId, entry.query, storage()); refreshHistory(); closeHistory(true); emit('submit');
}
function removeHistory(entry: ForumSearchEntry) {
  if (!validEntry(entry)) return;
  const index = history.value.indexOf(entry), restoreFocus = document.activeElement?.classList.contains('history-remove'), account = props.accountId;
  storageError.value = !removeForumSearch(props.accountId, entry.query, storage());
  if (!storageError.value) {
    restoringItemFocus = !!restoreFocus;
    refreshHistory();
    if (restoreFocus) void nextTick(() => {
      try {
        if (account !== props.accountId || !open.value) return;
        const buttons = root.value?.querySelectorAll<HTMLButtonElement>('[data-history-query]');
        if (buttons?.length) buttons[Math.min(index, buttons.length - 1)].focus(); else closeHistory(true);
      } finally { restoringItemFocus = false; }
    });
  }
}
function clearHistory() {
  if (!open.value || focusAccount !== props.accountId) return;
  storageError.value = !clearForumSearchHistory(props.accountId, storage());
  if (!storageError.value) { refreshHistory(); closeHistory(true); }
}
function clearSearch() { closeHistory(); emit('clear'); }
function inputClick(event: MouseEvent) { if (event.target instanceof HTMLInputElement) showHistory(); }
function outsidePointer(event: PointerEvent) { if (!root.value?.contains(event.target as Node | null)) closeHistory(); }
function historyKeydown(event: KeyboardEvent, entry: ForumSearchEntry) {
  const index = history.value.indexOf(entry), count = history.value.length;
  let target: number;
  if (event.key === 'ArrowDown') target = (index + 1) % count;
  else if (event.key === 'ArrowUp') target = (index + count - 1) % count;
  else if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = count - 1;
  else return;
  event.preventDefault(); root.value?.querySelectorAll<HTMLButtonElement>('[data-history-query]')[target]?.focus();
}
watch(() => props.accountId, () => { open.value = false; focusAccount = undefined; storageError.value = false; refreshHistory(); }, { immediate: true, flush: 'sync' });
onMounted(() => document.addEventListener('pointerdown', outsidePointer));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outsidePointer));
</script>
<style scoped>
.forum-search-input { position: relative; min-width: 0; }
.search-history { position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 20; padding: 8px; border: 1px solid var(--border-light); border-radius: 16px; box-shadow: 0 8px 28px #1a2e461c; background: #fff; }
.history-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 8px; color: var(--text-secondary); font-size: 12px; }
.history-heading button { border: 0; background: transparent; color: var(--primary-color); font: inherit; min-height: 40px; padding: 0 8px; cursor: pointer; }
.search-history ul { list-style: none; max-height: min(320px, 42dvh); overflow-y: auto; padding: 0; margin: 0; }
.search-history li { display: flex; align-items: center; gap: 4px; }
.search-history button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; border-radius: 10px; }
.history-query, .history-remove { border: 0; background: transparent; color: var(--text-regular); font: inherit; cursor: pointer; min-height: 44px; }
.history-query { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; padding: 8px; text-align: left; font-size: 13px; }
.history-query span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-query .el-icon { flex-shrink: 0; color: var(--text-placeholder); }
.history-query:hover, .history-remove:hover { background: var(--primary-bg); border-radius: 10px; }
.history-remove { display: grid; place-items: center; flex-shrink: 0; width: 44px; color: var(--text-secondary); }
.history-error { color: var(--el-color-danger); font-size: 12px; line-height: 1.6; padding: 0 8px; margin: 4px 0; }
</style>
