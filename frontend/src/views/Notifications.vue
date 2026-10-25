<template>
  <div class="notifications-page"><div class="notifications-wrapper">
    <el-page-header @back="$router.push('/forum')" title="返回社区" />
    <section class="notification-card">
      <div class="heading"><div><h1>消息通知</h1><p>{{ notifications.unreadCount }} 条未读</p></div><el-button :disabled="!notifications.unreadCount" :loading="markingAll" @click="readAll">全部已读</el-button></div>
      <div class="notification-filters">
        <nav class="notification-types" aria-label="消息分类">
          <button v-for="item in notificationTypes" :key="item.value" :class="{ active: notificationType === item.value }" :aria-pressed="notificationType === item.value" @click="setType(item.value)">{{ item.label }}</button>
        </nav>
        <el-radio-group v-model="unreadOnly" @change="resetList"><el-radio-button :value="false">全部</el-radio-button><el-radio-button :value="true">未读</el-radio-button></el-radio-group>
      </div>
      <div v-loading="loading" class="notification-list" :aria-busy="loading">
        <el-alert v-if="loadError" title="暂时没能加载消息通知，请重试" type="error" :closable="false" show-icon><el-button link @click="load">重新加载</el-button></el-alert>
        <el-empty v-if="!items.length && !loading && !loadError" description="暂时没有新消息" />
        <article v-for="item in items" :key="item.id" class="notification-item" :class="{ unread: !item.isRead }">
          <div class="notification-dot"></div><div class="notification-body"><div class="notification-meta"><strong>{{ item.title }}</strong><span>{{ formatTime(item.createdAt) }}</span></div><p>{{ item.content }}</p>
            <div class="notification-actions"><el-button v-if="target(item)" link type="primary" :disabled="busy.has(item.id)" @click="open(item)">查看详情</el-button><el-button v-if="!item.isRead" link :disabled="busy.has(item.id)" @click="read(item)">标记已读</el-button><span v-else>已读</span></div>
          </div>
        </article>
      </div>
      <el-pagination v-if="total > 20" :disabled="loading" layout="prev, pager, next" :pager-count="5" :page-size="20" :total="total" v-model:current-page="page" @current-change="load" />
    </section>
    <section class="notification-card subscription-card">
      <div class="heading"><h2>持续追踪</h2><el-button :loading="subscriptionsLoading" :disabled="subscriptionBusy.size > 0" @click="loadSubscriptions">刷新追踪</el-button></div>
      <el-alert v-if="subscriptionsError" title="追踪列表暂时无法加载，请重试。" type="error" :closable="false" />
      <div v-loading="subscriptionsLoading" class="subscription-list">
        <el-empty v-if="!subscriptions.length && !subscriptionsLoading && !subscriptionsError" description="尚未开启追踪，可在论坛或帖子详情中添加" />
        <article v-for="item in subscriptions" :key="item.id" class="subscription-item">
          <div class="subscription-scope"><strong>{{ watchTitle(item) }}</strong><el-tag size="small" :type="item.enabled ? 'success' : 'info'">{{ item.enabled ? '已开启' : '已暂停' }}</el-tag><p>{{ watchScope(item) }}</p><span>每 {{ Math.max(1, Math.round(item.cooldownSeconds / 60)) }} 分钟合并提醒</span></div>
          <div class="subscription-actions"><el-button :disabled="subscriptionBusy.has(item.id)" @click="setWatchEnabled(item)">{{ item.enabled ? '暂停' : '开启' }}</el-button><el-button type="danger" plain :disabled="subscriptionBusy.has(item.id)" @click="removeWatch(item)">删除追踪</el-button></div>
        </article>
      </div>
    </section>
  </div></div>
</template>
<script setup lang="ts">
import { ref, reactive, watch, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import request from '@/utils/request';
import { useNotificationStore } from '@/stores/notifications';
import { useUserStore } from '@/stores/user';
import { notificationTarget } from '@/utils/forum-experience';
import dayjs from 'dayjs';
import { ElMessageBox } from 'element-plus';
const router = useRouter(), notifications = useNotificationStore(), user = useUserStore();
const items = ref<any[]>([]), page = ref(1), total = ref(0), unreadOnly = ref(false), loading = ref(false), loadError = ref(false), markingAll = ref(false);
const notificationType = ref('');
const notificationTypes = [{ value: '', label: '全部消息' }, { value: 'COMMENT', label: '评论与回复' },
  { value: 'LIKE', label: '收到的赞' }, { value: 'FOLLOW', label: '新增关注' }, { value: 'SYSTEM', label: '系统与追踪' }];
function resetList() { page.value = 1; items.value = []; total.value = 0; void load(); }
function setType(value: string) {
  if (!notificationTypes.some(item => item.value === value) || value === notificationType.value) return;
  notificationType.value = value; resetList();
}
const busy = reactive(new Set<number>()); let generation = 0, markAllRequest = 0, identityGeneration = 0;
const subscriptions = ref<any[]>([]), subscriptionsLoading = ref(false), subscriptionsError = ref(false);
const subscriptionBusy = reactive(new Set<number>()); let subscriptionGeneration = 0;
const watchLabels: Record<string, string> = { NEW_POSTS: '新帖追踪', POST_ACTIVITY: '帖子更新', HOT_RISE: '热榜变化' };
function watchTitle(item: any) { return watchLabels[String(item.kind)] || '论坛追踪'; }
function watchScope(item: any) {
  const f = item.filtersJson || {}, parts: string[] = [];
  if (f.postId) parts.push('帖子 #' + f.postId); else parts.push(f.categoryId ? '分类 #' + f.categoryId : '全站');
  if (f.query) parts.push('关键词：' + f.query);
  if (item.kind === 'HOT_RISE') parts.push((f.hours === 168 ? '7 日' : '24 小时') + (f.rankingBasis === 'published' ? '发布衰减' : '互动净变化'));
  return parts.join(' · ');
}
async function loadSubscriptions() {
  const stamp = ++subscriptionGeneration, account = user.user?.id;
  if (!account) return;
  subscriptionsLoading.value = true; subscriptionsError.value = false;
  try {
    const data = await request.get('/forum/subscriptions');
    if (stamp !== subscriptionGeneration || account !== user.user?.id) return;
    subscriptions.value = Array.isArray(data) ? data : [];
  } catch { if (stamp === subscriptionGeneration && account === user.user?.id) subscriptionsError.value = true; }
  finally { if (stamp === subscriptionGeneration) subscriptionsLoading.value = false; }
}
async function setWatchEnabled(item: any) {
  if (subscriptionBusy.has(item.id)) return;
  const account = user.user?.id, stamp = subscriptionGeneration, enabled = !item.enabled;
  subscriptionBusy.add(item.id);
  try {
    const result = await request.patch('/forum/subscriptions/' + item.id, { enabled });
    if (stamp !== subscriptionGeneration || account !== user.user?.id || result?.ok !== true) return;
    item.enabled = enabled;
  } catch { /* keep the confirmed previous state */ }
  finally { if (stamp === subscriptionGeneration) subscriptionBusy.delete(item.id); }
}
async function removeWatch(item: any) {
  if (subscriptionBusy.has(item.id)) return;
  const account = user.user?.id, stamp = subscriptionGeneration;
  try { await ElMessageBox.confirm('停止追踪并移除这条设置？已有通知会保留。', '删除追踪', { confirmButtonText: '删除', cancelButtonText: '保留', type: 'warning' }); }
  catch { return; }
  if (stamp !== subscriptionGeneration || account !== user.user?.id) return;
  subscriptionBusy.add(item.id);
  try {
    const result = await request.delete('/forum/subscriptions/' + item.id);
    if (stamp !== subscriptionGeneration || account !== user.user?.id || result?.ok !== true) return;
    subscriptions.value = subscriptions.value.filter(value => value.id !== item.id);
  } catch { /* retain the confirmed server item */ }
  finally { if (stamp === subscriptionGeneration) subscriptionBusy.delete(item.id); }
}
const formatTime = (time: string) => dayjs(time).format('MM-DD HH:mm');
function target(item: any) { return typeof item.url === 'string' && /^\/(?:forum\/post\/\d+(?:\?comment=\d+)?|user\/\d+|reports\?case=[1-9]\d*&tab=(?:mine|decisions))$/.test(item.url) ? item.url : item.url === null ? null : notificationTarget(item); }
async function load() {
  const stamp = ++generation, account = user.user?.id;
  if (!account) return;
  // Count reads share the store's request/TTL gate; list snapshots cannot overwrite its newer result.
  void notifications.refresh().catch(() => { /* Badge failures do not block the notification list. */ });
  loading.value = true; loadError.value = false;
  try { const data: any = await request.get('/forum/notifications', { params: { page: page.value, limit: 20, unreadOnly: unreadOnly.value,
    ...(notificationType.value ? { type: notificationType.value } : {}) } });
    if (stamp !== generation || account !== user.user?.id) return;
    items.value = data.data; total.value = data.total;
  } catch { if (stamp === generation && account === user.user?.id) loadError.value = true; }
  finally { if (stamp === generation) loading.value = false; }
}
async function read(item: any) {
  if (item.isRead || busy.has(item.id)) return; busy.add(item.id);
  const account = user.user?.id, stamp = generation, action = identityGeneration;
  try { await request.put('/forum/notifications/' + item.id + '/read');
    if (stamp !== generation || account !== user.user?.id) return;
    item.isRead = true;
    if (unreadOnly.value) { items.value = items.value.filter(i => i.id !== item.id); total.value = Math.max(0, total.value - 1); }
    const emptyLastPage = unreadOnly.value && !items.value.length && page.value > 1;
    // A badge refresh is auxiliary; it must not strand the list on an empty page.
    try { await notifications.refresh({ force: true }); } catch { /* retain the current badge until its next refresh */ }
    if (emptyLastPage && stamp === generation && account === user.user?.id) { page.value--; await load(); }
  } catch { /* The shared handler reports the failure; keep the last confirmed read state. */ }
  finally { if (action === identityGeneration && account === user.user?.id) busy.delete(item.id); }
}
async function open(item: any) {
  const url = target(item), account = user.user?.id, action = identityGeneration;
  if (!url || busy.has(item.id)) return;
  await read(item);
  // Marking a notification is best effort and must not prevent opening an accessible destination.
  if (action === identityGeneration && account === user.user?.id) void router.push(url);
}
async function readAll() {
  if (markingAll.value) return; markingAll.value = true;
  const account = user.user?.id, stamp = generation, action = ++markAllRequest;
  try { await request.put('/forum/notifications/read-all'); if (account !== user.user?.id || stamp !== generation) return;
    try { await notifications.refresh({ force: true }); } catch { /* the list still needs to reflect the confirmed operation */ }
    if (account !== user.user?.id || stamp !== generation) return;
    if (unreadOnly.value) page.value = 1;
    await load(); }
  catch { /* A failed request is not a successful mark-all operation. */ }
  finally { if (action === markAllRequest && account === user.user?.id) markingAll.value = false; }
}
watch(() => user.user?.id, () => {
  generation++; subscriptionGeneration++; markAllRequest++; identityGeneration++; items.value = []; subscriptions.value = []; page.value = 1; total.value = 0; notificationType.value = ''; unreadOnly.value = false;
  subscriptionBusy.clear(); busy.clear(); markingAll.value = false; loading.value = false; loadError.value = false; subscriptionsLoading.value = false; subscriptionsError.value = false;
  if (user.user) { void load(); void loadSubscriptions(); }
}, { immediate: true });
onUnmounted(() => { generation++; subscriptionGeneration++; markAllRequest++; identityGeneration++; });
</script>
<style scoped lang="scss">
.notifications-page { height: 100%; overflow-y: auto; background: var(--bg-page); }
.notifications-wrapper { max-width: 860px; margin: auto; padding: 24px 20px 40px; }
.notification-card { margin-top: 20px; padding: 30px; border: 1px solid var(--border-light); background: #fff; border-radius: 20px; }
.heading, .notification-meta { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
h1 { margin: 0; font-size: 24px; } .heading p { color: var(--text-secondary); font-size: 13px; margin: 8px 0 20px; }
h2 { margin: 0; font-size: 20px; }
.subscription-list { min-height: 80px; }
.subscription-item { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px; padding: 20px 0; border-bottom: 1px solid var(--border-light); }
.subscription-scope { min-width: 0; flex: 1; }.subscription-scope strong { margin-right: 10px; }.subscription-scope p { overflow-wrap: anywhere; margin: 10px 0; font-size: 13px; }
.subscription-scope span { font-size: 12px; color: var(--text-secondary); line-height: 1.7; }
.subscription-actions { display: flex; gap: 8px; }.subscription-actions .el-button { margin-left: 0; }
.notification-list { margin-top: 20px; min-height: 160px; }
.notification-filters { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.notification-types { display: flex; align-items: center; gap: 6px; max-width: 100%; overflow-x: auto; padding-bottom: 3px; }
.notification-types button { flex-shrink: 0; border: 0; border-radius: 12px; background: #f2f5fa; color: #53657d; padding: 0 12px; min-height: 44px; font: inherit; font-size: 13px; cursor: pointer; }
.notification-types button.active { background: #e4f2ff; color: #176caa; font-weight: 600; }
.notification-types button:focus-visible { outline: 2px solid #409eff; outline-offset: -2px; }
.notification-item { display: flex; gap: 12px; padding: 22px 0; border-bottom: 1px solid var(--border-light); }
.notification-dot { flex-shrink: 0; width: 7px; height: 7px; margin-top: 6px; border-radius: 50%; background: transparent; }
.unread .notification-dot { background: var(--primary-color); } .notification-body { min-width: 0; flex: 1; }
.notification-meta strong { overflow-wrap: anywhere; font-size: 14px; } .notification-meta span, .notification-actions span { font-size: 12px; color: var(--text-secondary); }
.notification-body p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; color: var(--text-regular); line-height: 1.7; }
.notification-actions { display: flex; gap: 16px; align-items: center; } .el-pagination { margin-top: 24px; justify-content: center; }
@media (max-width:900px) { .notifications-page { background:#faf9f7; } .notifications-wrapper { padding:16px 12px 28px; } .notification-card { padding:22px 16px; border-color:#eee7eb; } }
</style>
