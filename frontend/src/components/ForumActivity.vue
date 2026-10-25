<template>
  <section class="forum-activity">
    <nav class="activity-navigation" aria-label="社区动态">
      <div class="activity-tabs" role="tablist" aria-label="我的社区内容">
        <button v-for="(tab, index) in activityTabs" :key="tab.key" type="button" role="tab"
          :id="'activity-tab-' + tab.key" :data-activity="tab.key" :aria-selected="active === tab.key"
          aria-controls="activity-panel" :tabindex="active === tab.key ? 0 : -1"
          class="activity-pill" :class="{ 'is-active': active === tab.key }"
          @click="changeTab(tab.key)" @keydown="handleTabKeydown($event, index)">
          <el-icon aria-hidden="true"><component :is="tab.icon" /></el-icon>{{ tab.label }}
        </button>
      </div>
      <router-link to="/messages" class="activity-pill activity-messages"><el-icon aria-hidden="true"><ChatDotRound /></el-icon>私信</router-link>
    </nav>
    <div id="activity-panel" v-loading="loading" class="activity-list" role="tabpanel" tabindex="0" :aria-busy="loading" :aria-labelledby="'activity-tab-' + active">
      <el-alert v-if="loadError" title="暂时没能加载社区内容，请重试" type="error" :closable="false" show-icon><el-button link @click="load">重新加载</el-button></el-alert>
      <el-empty v-if="!items.length && !loading && !loadError" :description="emptyText" :image-size="76" />
      <template v-for="item in items" :key="item.id">
        <router-link v-if="active === 'following'" class="activity-item follow-item" :to="'/user/' + item.id"><el-avatar :src="item.avatar" :size="38">{{ item.username.slice(0, 1) }}</el-avatar><div><strong>{{ item.username }}</strong><p v-if="item.bio">{{ item.bio }}</p></div></router-link>
        <router-link v-else-if="active === 'replies' && item.post?.status === 'APPROVED'" class="activity-item" :to="'/forum/post/' + item.post.id + '?comment=' + item.id"><strong>{{ item.post.title }}</strong><p class="reply-content">{{ item.content }}</p><small>{{ date(item.createdAt) }}</small></router-link>
        <div v-else-if="active === 'replies'" class="activity-item"><strong>原帖已不可访问</strong><p>{{ item.content }}</p></div>
        <router-link v-else class="activity-item" :to="'/forum/post/' + item.id"><strong>{{ item.title }}</strong><p>{{ item.summary }}</p><small>{{ item.category?.name }} · {{ date(item.createdAt) }} · {{ item.commentCount }} 条评论<span v-if="item.status && item.status !== 'APPROVED'"> · {{ item.status === 'PENDING' ? '审核中' : '暂未公开' }}</span></small></router-link>
      </template>
    </div>
    <el-pagination v-if="total > 10" :disabled="loading" layout="prev, pager, next" :page-size="10" :total="total" :pager-count="5" v-model:current-page="page" @current-change="load" />
  </section>
</template>
<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { ChatDotRound, Collection, Document, User } from '@element-plus/icons-vue';
import request from '@/utils/request';
import dayjs from 'dayjs';
const route = useRoute(), router = useRouter(), user = useUserStore();
const active = ref('posts'), page = ref(1), total = ref(0), items = ref<any[]>([]), loading = ref(false), loadError = ref(false);
const activityTabs = [
  { key: 'posts', label: '我的帖子', icon: Document },
  { key: 'replies', label: '我的回复', icon: ChatDotRound },
  { key: 'favorites', label: '我的收藏', icon: Collection },
  { key: 'following', label: '我的关注', icon: User },
];
let generation = 0;
const date = (time: string) => dayjs(time).format('YYYY-MM-DD');
const emptyText = computed(() => ({ posts: '还没有发布帖子', replies: '还没有参与讨论', favorites: '还没有收藏帖子', following: '还没有关注其他人' }[active.value] || '暂无内容'));
async function load() {
  const stamp = ++generation, account = user.user?.id;
  if (!account) return;
  loading.value = true; loadError.value = false;
  try { const data: any = await request.get('/forum/me/' + active.value, { params: { page: page.value, limit: 10 } });
    if (stamp !== generation || account !== user.user?.id) return; items.value = data.data; total.value = data.total;
  } catch { if (stamp === generation && account === user.user?.id) loadError.value = true; }
  finally { if (stamp === generation) loading.value = false; }
}
function changeTab(key: string) {
  if (active.value === key) return;
  generation++; active.value = key; page.value = 1; items.value = []; total.value = 0;
  void router.replace({ query: { ...route.query, activity: key } });
}
function handleTabKeydown(event: KeyboardEvent, index: number) {
  let target = index;
  if (event.key === 'ArrowRight') target = (index + 1) % activityTabs.length;
  else if (event.key === 'ArrowLeft') target = (index + activityTabs.length - 1) % activityTabs.length;
  else if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = activityTabs.length - 1;
  else return;
  event.preventDefault();
  changeTab(activityTabs[target].key);
  const tabs = (event.currentTarget as HTMLElement).parentElement;
  tabs?.querySelector<HTMLButtonElement>('[data-activity="' + activityTabs[target].key + '"]')?.focus();
}
watch(() => [route.query.activity, user.user?.id], () => {
  generation++; active.value = ['posts', 'replies', 'favorites', 'following'].includes(String(route.query.activity)) ? String(route.query.activity) : 'posts';
  page.value = 1; total.value = 0; items.value = []; loading.value = false; loadError.value = false;
  if (user.user) void load();
}, { immediate: true });
onUnmounted(() => { generation++; });
</script>
<style scoped lang="scss">
.activity-list { min-height:160px; } .activity-item { display:block; color:var(--text-primary); text-decoration:none; padding:18px 0; border-bottom:1px solid var(--border-light); }
.activity-item:hover strong { color:var(--primary-color); } .activity-item strong { font-size:14px; overflow-wrap:anywhere; }
.activity-item p { font-size:13px; line-height:1.8; color:var(--text-secondary); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; margin:8px 0; }
.activity-item small { font-size:11px; color:var(--text-secondary); } .follow-item { display:flex; align-items:center; gap:14px; } .follow-item .el-avatar { flex-shrink:0; }
.reply-content { white-space:pre-wrap; } .el-pagination { margin-top:24px; justify-content:center; }
.activity-navigation { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:2px 0 20px; }
.activity-tabs { display:contents; }
.activity-pill { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:40px; padding:9px 13px; border:1px solid transparent; border-radius:12px; background:var(--primary-bg); color:var(--primary-dark); font:inherit; font-size:13px; line-height:20px; white-space:nowrap; text-decoration:none; cursor:pointer; transition:background .15s, border-color .15s; }
.activity-pill:hover { background:#dceefa; }
.activity-pill.is-active { background:#dceefa; border-color:#a8cff3; color:#1864ab; font-weight:600; }
.activity-pill:focus-visible { outline:2px solid var(--primary-color); outline-offset:3px; }
.activity-pill .el-icon { font-size:16px; }
@media (max-width: 900px) { .activity-navigation { gap:8px; padding-bottom:16px; } .activity-pill { padding:8px 11px; } }
</style>
