<template>
  <div ref="container" class="forum-container" @scroll.passive="savePosition">
    <div class="forum-hero">
      <div class="hero-content">
        <h1>天大论坛</h1>
      </div>
      <el-button v-if="userStore.user" type="primary" size="large" class="btn-publish" @click="$router.push('/forum/create')">
        <el-icon><Edit /></el-icon>
        发布帖子
      </el-button>
    </div>
    <div class="forum-main">
      <aside class="forum-sidebar">
        <div class="sidebar-card">
          <div class="card-title">分类</div>
          <div class="category-list">
            <div
              class="category-item"
              :class="{ active: !categoryId }"
              @click="setCategory('')"
            >
              <span>全部</span>
              <span class="category-count">{{ categoryTotal }}</span>
            </div>
            <div
              v-for="cat in categories"
              :key="cat.id"
              class="category-item"
              :class="{ active: categoryId === String(cat.id) }"
              @click="setCategory(String(cat.id))"
            >
              <span>{{ cat.name }}</span>
              <span class="category-count">{{ cat._count?.posts || 0 }}</span>
            </div>
          </div>
        </div>
        <div class="sidebar-card">
          <div class="card-title">热门标签</div>
          <button class="mobile-tag-toggle" @click="tagsExpanded = !tagsExpanded">{{ tagsExpanded ? '收起标签' : '按标签筛选' }}{{ tagId ? ' · 已选择' : '' }}</button>
          <div class="tag-cloud" :class="{ expanded: tagsExpanded }">
            <el-tag
              v-for="tag in tags"
              :key="tag.id"
              :effect="tagId === String(tag.id) ? 'dark' : 'plain'"
              :type="tagId === String(tag.id) ? 'primary' : 'info'"
              class="tag-item"
              @click="tagId = tagId === String(tag.id) ? '' : String(tag.id); applyFilters()"
            >
              {{ tag.name }}
            </el-tag>
          </div>
        </div>
      </aside>
      <div class="forum-content">
        <div class="content-toolbar" :class="{ 'has-mobile-publish': !!userStore.user }">
          <ForumSearchInput
            v-model="searchText"
            :account-id="userStore.user?.id"
            class="search-input"
            @submit="applyFilters"
            @clear="applyFilters"
          />
          <el-button v-if="userStore.user" class="mobile-publish" type="primary" aria-label="发布帖子" @click="$router.push('/forum/create')"><el-icon><Edit /></el-icon></el-button>
          <el-radio-group v-model="sortBy" size="default" @change="applyFilters" class="sort-group" aria-label="帖子排序">
            <el-radio-button value="createdAt">最新</el-radio-button>
            <el-radio-button value="popular">热门</el-radio-button>
            <el-radio-button value="likes">最多点赞</el-radio-button>
          </el-radio-group>
          <el-select v-if="sortBy === 'popular'" v-model="hotBasis" class="hot-period" aria-label="热榜口径" @change="changeHotBasis">
            <el-option label="近期互动" value="interaction" /><el-option label="发布衰减" value="published" />
          </el-select>
          <el-select v-if="sortBy === 'popular'" v-model="hotPeriod" class="hot-period" aria-label="热门范围" @change="applyFilters">
            <el-option :label="hotBasis === 'interaction' ? '24 小时互动' : '24 小时发布'" value="today" /><el-option :label="hotBasis === 'interaction' ? '7 日互动' : '7 日发布'" value="week" /><el-option v-if="hotBasis === 'published'" label="全部发布" value="all" />
          </el-select>
          <el-button class="mobile-filter-button" :class="{ selected: mobileFilterCount > 0 }" :aria-expanded="mobileFiltersOpen" @click="mobileFiltersOpen = true"><el-icon><Filter /></el-icon>筛选<span v-if="mobileFilterCount" class="filter-count">{{ mobileFilterCount }}</span></el-button>
        </div>
        <div v-if="searchText || categoryId || tagId" class="filter-summary"><span class="desktop-filter-label">已筛选{{ searchText ? ' · ' + searchText : '' }}</span><span class="mobile-filter-label">{{ mobileFilterSummary }}</span><el-button link @click="clearFilters">清除筛选</el-button></div>
        <div class="mobile-feed-meta"><span>{{ mobileFeedLabel }}</span><el-button link :disabled="loading" @click="refreshFirst"><el-icon><Refresh /></el-icon>刷新</el-button></div>
        <p v-if="mobileCoverageNote" class="mobile-coverage-note">{{ mobileCoverageNote }}</p>
        <div v-if="sortBy === 'popular'" class="feed-note hot-updated desktop-feed-detail"><span v-if="updatedAt">更新于 {{ formatUpdatedAt(updatedAt) }}</span><el-button link @click="refreshFirst">刷新热榜</el-button></div>
        <div v-if="sortBy !== 'popular'" class="feed-note feed-refresh desktop-feed-detail"><span v-if="updatedAt">列表时间 {{ formatUpdatedAt(updatedAt) }}</span><el-button link @click="refreshFirst">{{ sortBy === 'likes' ? '刷新排序' : '刷新帖子' }}</el-button></div>
        <p v-if="coverageNote" class="feed-note desktop-feed-detail">{{ coverageNote }}</p>
        <p v-if="windowCountsNote" class="feed-note desktop-feed-detail">{{ windowCountsNote }}</p>
        <el-alert v-if="hotStatusNote" :title="hotStatusNote" :type="hotStatus === 'stale' ? 'warning' : 'info'" :closable="false" />
        <el-alert v-if="searchNote" :title="searchNote" type="warning" :closable="false" />
        <div v-if="userStore.user && sortBy !== 'likes'" class="feed-tracking desktop-feed-detail"><el-button :loading="tracking" :disabled="!canTrack || trackedScopes.has(trackingKey)" @click="trackCurrent">{{ trackedScopes.has(trackingKey) ? '已开启追踪' : sortBy === 'popular' ? '追踪热榜变化' : '追踪新帖' }}</el-button><span v-if="trackingHint">{{ trackingHint }}</span><router-link to="/notifications">管理追踪</router-link></div>
        <el-alert v-if="navigationNotice" :title="navigationNotice" type="info" :closable="false" />
        <el-alert v-if="cursorExpired" title="列表已过期，请刷新。" type="warning" :closable="false"><el-button link @click="refreshFirst">刷新首屏</el-button></el-alert>
        <div v-if="loading && hasListSnapshot" class="feed-loading-status" role="status">{{ usingCachedSnapshot ? '正在核对更新，先显示上次列表' : '正在更新帖子…' }}</div>
        <div v-if="loadSlow" class="feed-retry-notice" role="status"><span>网络响应较慢，可以继续等待或重试。</span><el-button link @click="retryCurrentPage">重新加载</el-button></div>
        <el-alert v-if="loadError" :title="hasListSnapshot ? '更新失败，当前显示上次列表' : '暂时没能加载帖子，请重试'" type="warning" :closable="false"><el-button link @click="retryCurrentPage">重新加载</el-button></el-alert>
        <div class="post-list" :aria-busy="loading">
          <div v-if="loading && !hasListSnapshot" class="feed-skeleton" role="status" aria-label="正在加载帖子">
            <div v-for="row in 4" :key="row" class="post-skeleton" aria-hidden="true"><i class="skeleton-line skeleton-category"></i><i class="skeleton-line skeleton-title"></i><i class="skeleton-line skeleton-summary"></i><i class="skeleton-line skeleton-summary short"></i><div class="skeleton-footer"><i class="skeleton-avatar"></i><i class="skeleton-line skeleton-author"></i><i class="skeleton-line skeleton-stats"></i></div></div>
          </div>
          <div v-if="posts.length === 0 && (!loading || hasListSnapshot) && !loadError && !cursorExpired && !hotBlocked" class="empty-posts">
            <el-icon :size="48" color="#C9CDD4"><Document /></el-icon>
            <p>{{ hasMore ? '本页帖子已不可访问，可继续查看下一页' : '暂无帖子' }}</p>
          </div>
          <article v-for="post in posts" :key="post.id" class="post-card" :aria-label="post.title">
            <router-link :to="'/forum/post/' + post.id" class="post-card-header post-content-link" @click="savePosition">
              <div class="post-badges">
                <el-tag v-if="post.isTop" type="danger" size="small" effect="dark">置顶</el-tag>
                <el-tag v-if="post.isEssence" type="warning" size="small" effect="dark">精华</el-tag>
                <span v-if="post.category" class="post-category">{{ post.category.name }}</span>
              </div>
              <h3 class="post-title">{{ post.title }}</h3>
              <p v-if="post.summary" class="post-summary">{{ post.summary }}</p>
            </router-link>
            <div class="post-card-footer">
              <div class="post-author">
                <router-link :to="'/user/' + post.user.id" class="author-profile" @click="savePosition" :aria-label="'查看 ' + post.user.username + ' 的主页'">
                <el-avatar :size="24" :src="post.user.avatar" class="author-avatar">
                  {{ post.user.username.charAt(0).toUpperCase() }}
                </el-avatar>
                <span class="author-name">{{ post.user.username }}</span>
                </router-link>
                <button v-if="post.user.id !== userStore.user?.id" class="author-follow" :class="{ followed: post.user.isFollowing }" :disabled="followPending.has(post.user.id)" :aria-pressed="!!post.user.isFollowing" :aria-label="(post.user.isFollowing ? '取消关注 ' : '关注 ') + post.user.username" @click="toggleAuthor(post.user)">{{ followPending.has(post.user.id) ? '处理中' : post.user.isFollowing ? '已关注' : '关注' }}</button>
                <span class="mobile-post-time">{{ formatTime(post.createdAt) }}</span>
              </div>
              <div class="post-stats">
                <span class="stat-item" :aria-label="'浏览 ' + post.viewCount + ' 次'">
                  <el-icon><View /></el-icon>
                  {{ post.viewCount }}
                </span>
                <router-link :to="'/forum/post/' + post.id" class="stat-item stat-comment" @click="savePosition" :aria-label="post.commentCount + ' 条评论'">
                  <el-icon><ChatDotRound /></el-icon>
                  {{ post.commentCount }}
                </router-link>
                <span class="stat-item" :aria-label="'获赞 ' + post.likeCount + ' 次'">
                  <el-icon><Star /></el-icon>
                  {{ post.likeCount }}
                </span>
                <button class="bookmark-action" :class="{ saved: post.isFavorited }" :disabled="favoritePending.has(post.id)" :aria-pressed="!!post.isFavorited" :aria-label="(post.isFavorited ? '取消收藏：' : '收藏：') + post.title" @click="toggleFavorite(post)"><el-icon><Collection /></el-icon><span>{{ post.isFavorited ? '已收藏' : '收藏' }}</span></button>
                <span class="stat-time">{{ formatTime(post.createdAt) }}</span>
              </div>
            </div>
            <div v-if="post.lastReplyAt" class="last-reply">最近回复 · {{ formatTime(post.lastReplyAt) }}</div>
          </article>
        </div>
        <div class="pagination-wrapper seek-pagination" v-if="posts.length || page > 1 || hasMore">
          <el-button :disabled="page <= 1 || loading || cursorExpired" @click="previousPage">{{ hasPreviousCursor ? '上一页' : '返回首屏' }}</el-button>
          <span class="page-label">第 {{ page }} 页</span>
          <el-button :disabled="!hasMore || loading || cursorExpired" @click="nextPage">下一页</el-button>
          <el-select v-model="pageSize" aria-label="每页条数" class="page-size" @change="applyFilters"><el-option v-for="size in [10, 20, 50]" :key="size" :label="size + ' 条/页'" :value="size" /></el-select>
        </div>
      </div>
    </div>
    <el-drawer v-model="mobileFiltersOpen" title="筛选与追踪" direction="btt" size="min(78dvh, 640px)" append-to-body class="mobile-forum-drawer">
      <div class="mobile-filter-content">
        <div class="mobile-filter-fields">
          <label>分类<el-select v-model="categoryId" clearable :value-on-clear="''" placeholder="全部分类" aria-label="筛选分类" @change="applyFilters"><el-option v-for="cat in categories" :key="cat.id" :label="cat.name" :value="String(cat.id)" /></el-select></label>
          <label>标签<el-select v-model="tagId" clearable :value-on-clear="''" placeholder="全部标签" aria-label="筛选标签" @change="applyFilters"><el-option v-for="tag in tags" :key="tag.id" :label="tag.name" :value="String(tag.id)" /></el-select></label>
          <template v-if="sortBy === 'popular'">
            <label>热榜口径<el-select v-model="hotBasis" aria-label="筛选热榜口径" @change="changeHotBasis"><el-option label="近期互动" value="interaction" /><el-option label="发布衰减" value="published" /></el-select></label>
            <label>时间范围<el-select v-model="hotPeriod" aria-label="筛选热榜范围" @change="applyFilters"><el-option :label="hotBasis === 'interaction' ? '24 小时互动' : '24 小时发布'" value="today" /><el-option :label="hotBasis === 'interaction' ? '7 日互动' : '7 日发布'" value="week" /><el-option v-if="hotBasis === 'published'" label="全部发布" value="all" /></el-select></label>
          </template>
        </div>
        <div class="mobile-filter-notes"><p v-if="coverageNote">{{ coverageNote }}</p><p v-if="windowCountsNote">{{ windowCountsNote }}</p><p v-if="updatedAt">更新于 {{ formatUpdatedAt(updatedAt) }}</p></div>
        <section v-if="userStore.user && sortBy !== 'likes'" class="mobile-tracking" aria-label="持续追踪设置"><div><strong>持续追踪</strong><router-link to="/notifications" @click="mobileFiltersOpen = false">管理追踪</router-link></div><p v-if="trackingHint">{{ trackingHint }}</p><el-button :loading="tracking" :disabled="!canTrack || trackedScopes.has(trackingKey)" @click="trackCurrent">{{ trackedScopes.has(trackingKey) ? '已开启追踪' : sortBy === 'popular' ? '追踪热榜变化' : '追踪新帖' }}</el-button></section>
        <div class="mobile-filter-actions"><el-button @click="clearFilters">清除筛选</el-button><el-button type="primary" @click="mobileFiltersOpen = false">查看帖子</el-button></div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRouter, useRoute, onBeforeRouteLeave } from 'vue-router';
import { forumFilters, forumQuery, forumFilterKey, readForumNavigation, saveForumNavigation } from '@/utils/forum-experience';
import { forumFeedCache, forumFeedCacheRevision, invalidateForumFeedCache, type ForumFeedCacheQuery } from '@/utils/forum-feed-cache';
import request from '@/utils/request';
import { useUserStore } from '@/stores/user';
import { ElMessage } from 'element-plus';
import { Filter, Refresh } from '@element-plus/icons-vue';
import ForumSearchInput from '@/components/ForumSearchInput.vue';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();

const posts = ref<any[]>([]);
const favoritePending = reactive(new Set<number>()), followPending = reactive(new Set<number>());
let socialEpoch = 0;
function requireAccount() {
  if (userStore.user) return true;
  ElMessage.info('登录后即可关注和收藏');
  void router.push({ path: '/login', query: { redirect: route.fullPath } });
  return false;
}
async function toggleFavorite(post: any) {
  if (!requireAccount() || favoritePending.has(post.id)) return;
  const account = userStore.user!.id, stamp = requestId, epoch = socialEpoch;
  favoritePending.add(post.id);
  try {
    const result = post.isFavorited ? await request.delete('/forum/posts/' + post.id + '/favorite') : await request.post('/forum/posts/' + post.id + '/favorite');
    if (epoch !== socialEpoch || account !== userStore.user?.id || stamp !== requestId || !posts.value.includes(post)) return;
    if (typeof result?.isFavorited !== 'boolean') throw new Error('Missing favorite state');
    post.isFavorited = result.isFavorited;
    ElMessage.success(post.isFavorited ? '已加入我的收藏' : '已取消收藏');
  } catch { /* shared request error leaves the last confirmed state intact */ }
  finally { if (epoch === socialEpoch) favoritePending.delete(post.id); }
}
async function toggleAuthor(author: any) {
  if (!requireAccount() || author.id === userStore.user?.id || followPending.has(author.id)) return;
  const account = userStore.user!.id, stamp = requestId, epoch = socialEpoch;
  followPending.add(author.id);
  try {
    const result = author.isFollowing ? await request.delete('/users/' + author.id + '/follow') : await request.post('/users/' + author.id + '/follow');
    if (epoch !== socialEpoch || account !== userStore.user?.id || stamp !== requestId) return;
    if (typeof result?.isFollowing !== 'boolean') throw new Error('Missing follow state');
    for (const item of posts.value) if (item.user.id === author.id) item.user.isFollowing = result.isFollowing;
  } catch { /* do not turn an unavailable user or failed request into a successful follow */ }
  finally { if (epoch === socialEpoch) followPending.delete(author.id); }
}
const categories = ref<any[]>([]);
const tags = ref<any[]>([]);
const categoryTotal = computed(() => categories.value.reduce((sum, category) => sum + (category._count?.posts || 0), 0));
const categoryId = ref('');
const tagId = ref('');
const searchText = ref('');
const sortBy = ref('createdAt');
const page = ref(1);
const pageSize = ref(20);
const cursor = ref(''), nextCursor = ref(''), hasMore = ref(false), updatedAt = ref(''), coverageNote = ref('');
const navigationNotice = ref(''), cursorExpired = ref(false);
const hotBasis = ref('interaction'), hotStatus = ref(''), searchNote = ref(''), windowCountsNote = ref('');
const tracking = ref(false), trackedScopes = reactive(new Set<string>());
let trackingRequest = 0;
const hotBlocked = computed(() => sortBy.value === 'popular' && ['not_ready', 'disabled', 'unsupported_scope'].includes(hotStatus.value));
const hotStatusNote = computed(() => ({ not_ready: '热榜尚未就绪，请稍后刷新。',
  disabled: '热榜未启用，可切换排行。', unsupported_scope: '此筛选暂不支持热榜，请调整筛选。',
  stale: '热榜更新延迟，暂显示上次结果。' }[hotStatus.value] || ''));
const canTrack = computed(() => !tagId.value && Array.from(searchText.value.trim()).length !== 1 && searchText.value.trim().length <= 160
  && !(sortBy.value === 'popular' && (hotPeriod.value === 'all' || hotBlocked.value)));
const trackingKey = computed(() => JSON.stringify([sortBy.value, categoryId.value, searchText.value.trim(), hotPeriod.value, hotBasis.value]));
const trackingHint = computed(() => tagId.value ? '标签筛选暂不支持追踪，可改用分类或关键词。' : !canTrack.value ? '追踪需有效的热榜窗口，关键词为空或 2～160 字符。' : '');
const loading = ref(false);
const hasListSnapshot = ref(false), usingCachedSnapshot = ref(false), loadSlow = ref(false);
const loadError = ref(false), hotPeriod = ref('week'), tagsExpanded = ref(false), container = ref<HTMLElement | null>(null);
const mobileFiltersOpen = ref(false);
const mobileFilterCount = computed(() => Number(!!categoryId.value) + Number(!!tagId.value));
const mobileFilterSummary = computed(() => [categories.value.find(cat => String(cat.id) === categoryId.value)?.name,
  tags.value.find(tag => String(tag.id) === tagId.value)?.name, searchText.value.trim()].filter(Boolean).join(' · ') || '已筛选');
const mobileCoverageNote = computed(() => coverageNote.value.includes('仅显示首屏') ? '此筛选仅显示首屏，查看更多请切换“最新”。' : sortBy.value === 'likes' ? '点赞榜限前 100 页，查看更多请切换“最新”。' : '');
const mobileFeedLabel = computed(() => sortBy.value === 'popular'
  ? `${hotBasis.value === 'interaction' ? '近期互动' : '发布衰减'} · ${hotPeriod.value === 'today' ? '24 小时' : hotPeriod.value === 'week' ? '7 日' : '全部历史'}${coverageNote.value && !mobileCoverageNote.value ? ' · Top 200' : ''}`
  : sortBy.value === 'likes' ? '按点赞数排序' : updatedAt.value ? '更新于 ' + dayjs(updatedAt.value).format('MM-DD HH:mm') : '按发布时间排序');
let requestId = 0, restorePosition = false, initialLoad = true;
let savedNavigation = readForumNavigation(userStore.user?.id || 0), cursorHistory: Record<string, string> = {};
let historyKey = '', likesCountKey = '', likesTotal: number | null = null;
let activeRead: AbortController | null = null;
let slowTimer: ReturnType<typeof setTimeout> | null = null, cacheExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let displayedCacheExpiresAt = 0;
let bypassNextLoad = false;
function cancelRead() {
  activeRead?.abort(); activeRead = null;
  if (slowTimer) clearTimeout(slowTimer);
  if (cacheExpiryTimer) clearTimeout(cacheExpiryTimer);
  slowTimer = cacheExpiryTimer = null; loadSlow.value = false;
}
function cacheQuery(): ForumFeedCacheQuery {
  // Typing a search is not a submission. A retry must retain the route's
  // committed query rather than silently searching an unfinished input.
  return { categoryId: categoryId.value, tagId: tagId.value, search: forumFilters(route.query).search, sortBy: sortBy.value,
    hotBasis: hotBasis.value, hotPeriod: hotPeriod.value, pageSize: pageSize.value, page: page.value, cursor: cursor.value };
}
function clearListSnapshot() {
  posts.value = []; hasListSnapshot.value = false; usingCachedSnapshot.value = false;
  displayedCacheExpiresAt = 0;
  hasMore.value = false; nextCursor.value = ''; coverageNote.value = ''; updatedAt.value = '';
  hotStatus.value = ''; searchNote.value = ''; windowCountsNote.value = '';
}
const hasPreviousCursor = computed(() => sortBy.value === 'likes' || !!cursorHistory[String(page.value - 1)]);
function savePosition() {
  if (route.path !== '/forum') return;
  saveForumNavigation(userStore.user?.id || 0, route.fullPath, container.value?.scrollTop || 0,
    { filterKey: historyKey, cursors: cursorHistory });
}
function filters() { return { categoryId: categoryId.value, tagId: tagId.value, search: searchText.value, sortBy: sortBy.value, hotPeriod: hotPeriod.value, page: page.value, limit: pageSize.value, cursor: cursor.value }; }
function routeQuery() { return { ...forumQuery(filters()), ...(sortBy.value === 'popular' ? { hotBasis: hotBasis.value } : {}) }; }
function scopedFilterKey(value = filters()) { return forumFilterKey(value) + (value.sortBy === 'popular' ? ':' + hotBasis.value : ''); }
function changeHotBasis() { if (hotBasis.value === 'interaction' && hotPeriod.value === 'all') hotPeriod.value = 'week'; applyFilters(); }
async function trackCurrent() {
  if (!canTrack.value || tracking.value || !userStore.user) return;
  const account = userStore.user.id, key = trackingKey.value, stamp = ++trackingRequest;
  const body: any = { kind: sortBy.value === 'popular' ? 'HOT_RISE' : 'NEW_POSTS', cooldownSeconds: 3600 };
  if (categoryId.value) body.categoryId = Number(categoryId.value);
  if (searchText.value.trim()) body.query = searchText.value.trim();
  if (sortBy.value === 'popular') { body.hours = hotPeriod.value === 'today' ? 24 : 168; body.rankingBasis = hotBasis.value; }
  tracking.value = true;
  try {
    const created = await request.post('/forum/subscriptions', body);
    if (stamp !== trackingRequest || account !== userStore.user?.id || key !== trackingKey.value) return;
    if (created?.enabled !== true) { ElMessage.warning('追踪尚未启用，请到消息通知确认状态'); return; }
    trackedScopes.add(key); ElMessage.success('已开启追踪，可在消息通知中管理');
  } catch { /* the shared handler reports errors; do not claim that a watch was saved */ }
  finally { if (stamp === trackingRequest) tracking.value = false; }
}
function applyFilters() { page.value = 1; cursor.value = ''; cursorHistory = {}; navigationNotice.value = ''; void navigate(); }
function setCategory(id: string) { categoryId.value = id; applyFilters(); }
function clearFilters() { categoryId.value = ''; tagId.value = ''; searchText.value = ''; applyFilters(); }
function refreshFirst() { invalidateForumFeedCache(); bypassNextLoad = true; cursorHistory = {}; likesCountKey = ''; likesTotal = null; page.value = 1; cursor.value = ''; navigationNotice.value = ''; void navigate(); }
function previousPage() {
  if (page.value <= 1) return;
  navigationNotice.value = '';
  if (sortBy.value === 'likes') { page.value--; cursor.value = ''; }
  else if (hasPreviousCursor.value) { page.value--; cursor.value = cursorHistory[String(page.value)]; }
  else { refreshFirst(); return; }
  void navigate();
}
function nextPage() {
  if (!hasMore.value) return;
  navigationNotice.value = '';
  page.value++; cursor.value = sortBy.value === 'likes' ? '' : nextCursor.value;
  void navigate();
}
async function navigate() {
  restorePosition = false;
  const target = { path: '/forum', query: routeQuery() };
  if (router.resolve(target).fullPath === route.fullPath) {
    const bypassCache = bypassNextLoad; bypassNextLoad = false;
    await loadPosts({ bypassCache });
  }
  else await router.push(target);
}

function applyFeed(data: any, key: string, isLikes: boolean, cachedTotal: number | null = likesTotal) {
  posts.value = data.data;
  hasListSnapshot.value = true;
  searchNote.value = data.degraded ? '全文搜索暂不可用，已切换关键词匹配。' : '';
  hotStatus.value = data.snapshot?.status || '';
  windowCountsNote.value = data.snapshot?.windowCountsBasis === 'signed_net_deltas_since_activation'
    ? '按启用后记录的互动净变化排名；卡片显示累计数。' : '';
  cursorExpired.value = false;
  if (isLikes) {
    if (typeof data.total === 'number') { likesTotal = data.total; likesCountKey = key; }
    else if (cachedTotal !== null) { likesTotal = cachedTotal; likesCountKey = key; }
    hasMore.value = page.value < 100 && posts.value.length === pageSize.value && (likesTotal === null || page.value * pageSize.value < likesTotal);
    nextCursor.value = ''; updatedAt.value = '';
    coverageNote.value = '点赞榜限前 100 页，查看更多请切换“最新”。';
  } else {
    hasMore.value = !!data.hasMore && !!data.nextCursor;
    nextCursor.value = data.nextCursor || '';
    if (data.pageCursor) { cursor.value = data.pageCursor; cursorHistory[String(page.value)] = data.pageCursor; }
    updatedAt.value = data.snapshot?.asOf || data.asOf || '';
    coverageNote.value = data.snapshot?.paging === 'first_page_only'
      ? '此筛选仅显示首屏，查看更多请切换“最新”。'
      : data.snapshot ? '仅显示热榜前 200 条。' : '';
  }
}

async function retryCurrentPage() {
  // A manual retry replaces the in-flight read, keeping its exact signed page.
  await loadPosts({ bypassCache: true, preserveScroll: true });
}

const loadPosts = async (options: { bypassCache?: boolean; preserveScroll?: boolean } = {}) => {
  const scrollAtStart = container.value?.scrollTop || 0;
  cancelRead();
  const stamp = ++requestId, session = userStore.getAuthSession(), controller = new AbortController();
  const isLikes = sortBy.value === 'likes', requestedQuery = cacheQuery();
  const key = scopedFilterKey({ ...filters(), search: requestedQuery.search });
  const scopeRevision = forumFeedCacheRevision(session);
  const cached = options.bypassCache ? null : forumFeedCache.read(session, requestedQuery);
  const restoreScroll = !options.preserveScroll && restorePosition && savedNavigation?.path === route.fullPath ? savedNavigation.scroll : null;
  const keepScroll = options.preserveScroll || hasListSnapshot.value;
  const isCurrent = () => stamp === requestId && route.path === '/forum' &&
    session.userId === userStore.getAuthSession().userId && session.epoch === userStore.getAuthSession().epoch;
  let completedScroll: number | null = null;
  activeRead = controller;
  historyKey = key;
  loading.value = true;
  loadError.value = false; cursorExpired.value = false;
  if (cached) {
    applyFeed(cached.value.data, key, isLikes, cached.value.likesTotal);
    usingCachedSnapshot.value = true;
    displayedCacheExpiresAt = cached.expiresAt;
  }
  if (usingCachedSnapshot.value) {
    // A cache is a short head-start, not an indefinite permission snapshot.
    // Retrying does not extend the original cached page's lifetime.
    cacheExpiryTimer = setTimeout(() => {
      if (!isCurrent() || !usingCachedSnapshot.value) return;
      clearListSnapshot();
      if (!loading.value) loadError.value = true;
    }, Math.max(0, displayedCacheExpiresAt - Date.now()));
  }
  slowTimer = setTimeout(() => { if (isCurrent() && loading.value) loadSlow.value = true; }, 6000);
  try {
    await nextTick();
    if (!isCurrent()) return;
    if (cached || keepScroll) {
      if (restoreScroll !== null) container.value?.scrollTo({ top: restoreScroll });
      else if (keepScroll) container.value?.scrollTo({ top: scrollAtStart });
    } else if (restoreScroll === null) container.value?.scrollTo({ top: 0 });
    if (cached) restorePosition = false;
    const params: any = {
      limit: requestedQuery.pageSize,
    };
    if (requestedQuery.sortBy === 'popular') { params.hotPeriod = requestedQuery.hotPeriod; params.hotBasis = requestedQuery.hotBasis; }
    if (requestedQuery.categoryId) params.categoryId = requestedQuery.categoryId;
    if (requestedQuery.tagId) params.tagId = requestedQuery.tagId;
    if (requestedQuery.search) params.search = requestedQuery.search;

    if (isLikes) {
      params.page = requestedQuery.page; params.sortBy = 'likes'; params.includeTotal = likesCountKey !== key;
    } else {
      params.sort = requestedQuery.sortBy === 'popular' ? 'hot' : 'latest';
      if (cursor.value) params.cursor = cursor.value;
    }
    const data = await request.get(isLikes ? '/forum/posts' : '/forum/feed', { params, signal: controller.signal, _quiet: true });
    if (!isCurrent()) return;
    if (scopeRevision !== forumFeedCacheRevision() || favoritePending.size || followPending.size) {
      // A write finished while this read was in flight; its old social state
      // must not replace the newer confirmed state already on screen.
      if (!hasListSnapshot.value) loadError.value = true;
      return;
    }
    const scrollBeforeUpdate = container.value?.scrollTop || 0;
    completedScroll = cached || keepScroll ? scrollBeforeUpdate : restoreScroll ?? 0;
    applyFeed(data, key, isLikes);
    usingCachedSnapshot.value = false; displayedCacheExpiresAt = 0;
    if (cacheExpiryTimer) clearTimeout(cacheExpiryTimer); cacheExpiryTimer = null;
    const snapshot = { data, likesTotal };
    forumFeedCache.write(session, requestedQuery, snapshot, scopeRevision);
    // First-page requests acquire a signed page token. Cache that exact token
    // too, so a return from detail never opens a new snapshot behind the user.
    forumFeedCache.write(session, { ...requestedQuery, cursor: isLikes ? '' : data.pageCursor || requestedQuery.cursor }, snapshot, scopeRevision);
    if (restorePosition && sortBy.value === 'popular' && !data.pageCursor) {
      navigationNotice.value = '此筛选不支持翻页，已返回首屏。';
    }
    restorePosition = false;
  } catch (error: any) {
    if (isCurrent() && error.code !== 'ERR_CANCELED' && error.code !== 'AUTH_SESSION_CHANGED') {
      const status = error.response?.status;
      if (status === 401 || status === 403 || status === 409 || (status === 400 && cursor.value)) {
        invalidateForumFeedCache(); clearListSnapshot();
      }
      if (status === 409 || (status === 400 && cursor.value)) {
        cursorExpired.value = true; loadError.value = false; hasMore.value = false;
      } else loadError.value = true;
    }
  } finally {
    if (stamp === requestId) {
      // Measure at completion, not when the request started: the reader may
      // have scrolled while waiting. Flush the status/error/slow-hint changes
      // together before restoring, otherwise scroll anchoring shifts it again.
      const settledScroll = completedScroll ?? (hasListSnapshot.value ? container.value?.scrollTop || 0 : null);
      loading.value = false; loadSlow.value = false; activeRead = null;
      if (slowTimer) clearTimeout(slowTimer); slowTimer = null;
      await nextTick();
      if (isCurrent() && settledScroll !== null) {
        container.value?.scrollTo({ top: settledScroll });
        savePosition();
      }
    }
  }
};

const loadCategories = async () => {
  const data = await request.get('/forum/categories');
  categories.value = data;
};

const loadTags = async () => {
  const data = await request.get('/forum/tags');
  tags.value = data;
};

const formatTime = (time: string) => {
  return dayjs(time).fromNow();
};
const formatUpdatedAt = (time: string) => dayjs(time).format('MM-DD HH:mm:ss');

let tagTimer: ReturnType<typeof setInterval> | null = null;
let mobileMedia: MediaQueryList | null = null;
const closeDesktopFilters = () => { if (!mobileMedia?.matches) mobileFiltersOpen.value = false; };

watch(() => route.fullPath, async () => {
  if (route.path !== '/forum') return;
  const f = forumFilters(route.query); categoryId.value = f.categoryId; tagId.value = f.tagId; searchText.value = f.search;
  sortBy.value = f.sortBy; hotPeriod.value = f.hotPeriod; page.value = f.page; pageSize.value = f.limit; cursor.value = f.cursor;
  hotBasis.value = route.query.hotBasis === 'published' || (f.hotPeriod === 'all' && route.query.hotBasis !== 'interaction') ? 'published' : 'interaction';
  if (sortBy.value === 'popular' && hotPeriod.value === 'all' && hotBasis.value === 'interaction') {
    hotBasis.value = 'published'; navigationNotice.value = '全部历史仅支持“发布衰减”。';
  }
  restorePosition = initialLoad && savedNavigation?.path === route.fullPath;
  const key = scopedFilterKey(f);
  if (key !== historyKey) { cursorHistory = restorePosition && savedNavigation?.feed?.filterKey === key ? { ...savedNavigation.feed.cursors } : {}; historyKey = key; }
  if (restorePosition && !cursor.value) cursor.value = cursorHistory[String(page.value)] || '';
  initialLoad = false;
  if ((sortBy.value !== 'likes' && page.value > 1 && !cursor.value) || (sortBy.value === 'likes' && page.value > 100)) {
    navigationNotice.value = sortBy.value === 'likes' ? '旧链接超过点赞排序的 100 页范围，已返回首屏。' : '旧页码链接没有可恢复的游标，已返回首屏。';
    page.value = 1; cursor.value = ''; cursorHistory = {}; restorePosition = false;
    await router.replace({ path: '/forum', query: routeQuery() });
    return;
  }
  cursorExpired.value = false; clearListSnapshot();
  const bypassCache = bypassNextLoad; bypassNextLoad = false;
  void loadPosts({ bypassCache });
}, { immediate: true });
watch(() => { const session = userStore.getAuthSession(); return JSON.stringify([session.userId, session.epoch]); }, () => {
  socialEpoch++; favoritePending.clear(); followPending.clear();
  requestId++; cancelRead(); invalidateForumFeedCache(); clearListSnapshot(); cursorHistory = {}; likesCountKey = ''; likesTotal = null;
  savedNavigation = null; initialLoad = false; historyKey = ''; refreshFirst();
  trackingRequest++; tracking.value = false; trackedScopes.clear();
}, { flush: 'sync' });
onBeforeRouteLeave(() => { savePosition(); requestId++; cancelRead(); });
onMounted(() => {
  mobileMedia = window.matchMedia('(max-width: 900px)');
  mobileMedia.addEventListener('change', closeDesktopFilters);
  void loadCategories().catch(() => {});
  void loadTags().catch(() => {});
  // 每 5 分钟刷新热门标签
  tagTimer = setInterval(() => void loadTags().catch(() => {}), 5 * 60 * 1000);
});

onUnmounted(() => {
  mobileMedia?.removeEventListener('change', closeDesktopFilters);
  requestId++;
  cancelRead();
  trackingRequest++;
  if (tagTimer) clearInterval(tagTimer);
});
</script>

<style lang="scss" scoped>
.forum-container {
  height: 100%;
  overflow-y: auto;
  background: var(--bg-page);
}

.forum-hero {
  background: linear-gradient(135deg, #EBF8FE 0%, #D6EEFB 40%, #C5E4F7 100%);
  padding: 32px 40px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #C5E4F7;

  h1 {
    margin: 0 0 4px;
    font-size: 24px;
    color: var(--primary-dark);
    font-weight: 700;
  }

  p {
    margin: 0;
    font-size: 14px;
    color: #5A8DB5;
  }
}

.btn-publish {
  border-radius: 24px;
  height: 42px;
  padding: 0 28px;
  font-weight: 500;
  box-shadow: 0 4px 14px rgba(74, 158, 220, 0.35);
  transition: all var(--transition);

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 20px rgba(74, 158, 220, 0.5);
  }
}

.forum-main {
  display: flex;
  padding: 24px 32px;
  gap: 24px;
  max-width: 1400px;
  margin: 0 auto;
}

.forum-sidebar {
  width: 250px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sidebar-card {
  background: #fff;
  border-radius: var(--radius-md);
  padding: 18px;
  box-shadow: var(--shadow-sm);
}

.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
  padding-left: 10px;
  border-left: 3px solid var(--primary-light);
}

.category-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-regular);
  transition: all var(--transition);

  &:hover {
    background: var(--bg-page);
  }

  &.active {
    background: var(--primary-bg);
    color: var(--primary-color);
    font-weight: 600;

    .category-count {
      color: var(--primary-color);
    }
  }
}

.category-count {
  font-size: 11px;
  color: var(--text-placeholder);
  background: var(--bg-page);
  padding: 2px 8px;
  border-radius: 10px;
}

.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag-item {
  cursor: pointer;
  transition: all var(--transition);

  &:hover {
    transform: translateY(-1px);
  }
}

.forum-content {
  flex: 1;
  min-width: 0;
}

.content-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.search-input {
  flex: 1;
  max-width: 360px;

  :deep(.el-input__wrapper) {
    border-radius: 24px;
    box-shadow: var(--shadow-sm);
  }
}

.sort-group {
  :deep(.el-radio-button__inner) {
    border-radius: 20px;
  }
}

.post-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.feed-loading-status, .feed-retry-notice { color: var(--text-secondary); font-size: 12px; line-height: 1.7; margin: 8px 0 12px; }
.feed-retry-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 12px; border-radius: var(--radius-sm); background: var(--primary-bg); }
.feed-retry-notice .el-button { flex-shrink: 0; min-height: 36px; }
.feed-skeleton { display: grid; gap: 12px; }
.post-skeleton { padding: 20px 24px; border-radius: var(--radius-md); background: #fff; box-shadow: var(--shadow-sm); }
.skeleton-line, .skeleton-avatar { display: block; background: #eef0f3; border-radius: 5px; }
.skeleton-line { height: 12px; margin-bottom: 10px; }
.skeleton-category { width: 68px; height: 16px; }
.skeleton-title { width: 77%; height: 18px; margin: 14px 0; }
.skeleton-summary { width: 100%; }
.skeleton-summary.short { width: 64%; }
.skeleton-footer { display: flex; align-items: center; gap: 8px; margin-top: 20px; }
.skeleton-avatar { width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0; }
.skeleton-author { width: 72px; margin: 0; }
.skeleton-stats { width: 28%; margin: 0 0 0 auto; }
/* Static bars remain calm on slow connections, including reduced-motion mode. */

.empty-posts {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 64px 0;
  color: var(--text-secondary);

  p {
    margin-top: 12px;
    font-size: 14px;
  }
}

.post-card {
  display: block;
  color: inherit;
  text-decoration: none;
  background: #fff;
  border-radius: var(--radius-md);
  padding: 20px 24px;
  cursor: default;
  transition: all var(--transition);
  box-shadow: var(--shadow-sm);
  border-left: 3px solid transparent;
  position: relative;

  &:hover {
    border-left-color: var(--primary-color);
    box-shadow: 0 4px 16px rgba(74, 158, 220, 0.12);
    transform: translateX(2px);
  }
}
.post-content-link { display: block; color: inherit; text-decoration: none; }
.post-content-link:hover .post-title { color: var(--primary-color); }
.author-profile { display: inline-flex; align-items: center; gap: 8px; min-width: 0; color: inherit; text-decoration: none; }
.author-profile:hover .author-name { color: var(--primary-color); }
.author-follow, .bookmark-action { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 32px; padding: 4px 8px; border: 0; border-radius: 10px; background: transparent; color: var(--text-secondary); font: inherit; cursor: pointer; }
.author-follow { font-size: 12px; color: var(--primary-color); background: var(--primary-bg); white-space: nowrap; }
.author-follow.followed { color: var(--text-secondary); background: #f2f4f7; }
.bookmark-action.saved { color: var(--primary-color); background: var(--primary-bg); }
.author-follow:hover, .bookmark-action:hover { filter: brightness(.92); }
.author-follow:disabled, .bookmark-action:disabled { opacity: .55; cursor: wait; }
.stat-comment { color: inherit; text-decoration: none; }
.stat-comment:hover { color: var(--primary-color); }
.post-content-link:focus-visible, .author-profile:focus-visible, .author-follow:focus-visible, .bookmark-action:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 3px; }
.post-summary { margin: 8px 0 0; font-size: 13px; line-height: 1.8; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.post-category { font-size: 11px; color: var(--primary-dark); background: var(--primary-bg); padding: 2px 8px; border-radius: 8px; }
.last-reply { font-size: 11px; color: var(--text-secondary); margin-top: 12px; }
.hot-period { width: 124px; flex-shrink: 0; }
.mobile-tag-toggle { display: none; }
.filter-summary { display: flex; align-items: center; gap: 16px; font-size: 12px; color: var(--text-secondary); padding-bottom: 12px; }

.post-card-header {
  margin-bottom: 14px;
}

.post-badges {
  margin-bottom: 8px;
  display: flex;
  gap: 6px;
}

.post-title {
  overflow-wrap: anywhere;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.5;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.post-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.post-author {
  display: flex;
  align-items: center;
  gap: 8px;
}

.author-avatar {
  flex-shrink: 0;
}

.author-name {
  font-size: 13px;
  color: var(--text-regular);
  font-weight: 500;
}

.post-stats {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.stat-time {
  color: var(--text-placeholder);
  font-size: 12px;
}

.pagination-wrapper {
  display: flex;
  justify-content: center;
  margin-top: 28px;
}
.seek-pagination { align-items: center; gap: 12px; flex-wrap: wrap; }
.page-label { font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
.page-size { width: 112px; }
.feed-note { margin: 10px 0; font-size: 12px; line-height: 1.7; color: var(--text-secondary); overflow-wrap: anywhere; }
.hot-updated { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.feed-refresh { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.feed-tracking { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 12px 0; font-size: 12px; color: var(--text-secondary); }
.feed-tracking a { color: var(--primary-color); }
.mobile-publish, .mobile-filter-button, .mobile-feed-meta, .mobile-coverage-note, .mobile-filter-label, .mobile-post-time { display: none; }

@media (max-width: 900px) {
  .content-toolbar { position: sticky; top: 0; z-index: 3; background: #faf9f7; padding: 10px 0; }
  .mobile-tag-toggle { display: block; border: 0; padding: 4px 0; background: transparent; color: #897480; font-size: 12px; }
  .tag-cloud:not(.expanded) { display: none; }
  .hot-period { width: 112px; margin-left: auto; }
  .content-toolbar { flex-wrap: wrap; }
  .search-input { flex-basis: 100%; max-width: none; }
  .post-card-footer { flex-wrap: wrap; gap: 12px; }
  .post-stats { flex-wrap: wrap; gap: 12px; }
  .pagination-wrapper :deep(.el-pagination__sizes),
  .pagination-wrapper :deep(.el-pagination__jump) { display: none; }
}

@media (max-width: 900px) {
  .forum-hero { padding: 20px; gap: 16px; flex-wrap: wrap; }
  .forum-main { flex-direction: column; padding: 16px 16px 48px; gap: 16px; }
  .forum-sidebar { width: 100%; gap: 12px; }
  .sidebar-card { padding: 12px; }
  .category-list { display: flex; flex-wrap: wrap; gap: 4px; }
  .category-item { gap: 10px; min-height: 40px; }
  .post-author { min-width: 0; }
  .author-name { overflow-wrap: anywhere; }
}

@media (max-width: 640px) {
  .forum-main { padding-inline: 12px; }
  .forum-hero { padding: 18px 16px; }
  .forum-hero p { line-height: 1.6; }
  .post-card { padding: 16px; }
  .pagination-wrapper :deep(.el-pagination__total) { display: none; }
}
@media (max-width: 900px) {
  .forum-container { background: #faf9f7; }
  .forum-hero { padding: 20px 20px 22px; background: transparent; border: 0; flex-wrap: nowrap; gap: 14px; }
  .hero-content { min-width: 0; flex: 1; }
  .forum-hero h1 { font-size: 25px; color: #302c31; letter-spacing: -.6px; margin-bottom: 8px; }
  .forum-hero p { font-size: 11px; color: #9b9098; line-height: 1.7; }
  .btn-publish { flex-shrink: 0; height: 38px; padding: 0 14px; font-size: 12px; border: 0; background: #a66b83; box-shadow: none; }
  .forum-main { padding: 0 16px 28px; gap: 14px; }
  .forum-sidebar { gap: 10px; }
  .sidebar-card { padding: 0; background: none; box-shadow: none; min-width: 0; }
  .card-title { display: none; }
  .category-list { flex-wrap: nowrap; overflow-x: auto; padding: 2px 0; gap: 8px; scrollbar-width: none; }
  .category-item { white-space: nowrap; min-height: 38px; padding: 9px 16px; border-radius: 20px; background: #eeeae8; color: #81767d; }
  .category-item.active { background: #463c43; color: #fff; font-weight: 500; }
  .category-count { display: none; }
  .tag-cloud { gap: 6px; }
  .tag-item { border: 0; border-radius: 8px; background: #f3eeef; color: #a18493; font-size: 10px; }
  .content-toolbar { gap: 12px; margin-bottom: 18px; }
  .search-input :deep(.el-input__wrapper) { min-height: 44px; border: 1px solid #ebe5e8; box-shadow: none; background: #fff; }
  .sort-group :deep(.el-radio-button__inner) { border: 0; box-shadow: none; background: transparent; padding: 7px 12px; color: #a3979f; }
  .sort-group :deep(.is-active .el-radio-button__inner) { color: #955d76; background: #f3e5ed; }
  .post-card { padding: 20px 18px; border: 1px solid #eee8ec; border-radius: 18px; box-shadow: 0 2px 8px #39303803; }
  .post-card:hover { transform: none; }
  .post-badges:empty { display: none; }
  .post-title { font-size: 16px; line-height: 1.7; color: #3d343b; font-weight: 600; }
  .post-card-footer { gap: 14px; }
  .post-author { flex-basis: 100%; }
  .author-name { font-size: 12px; color: #897e85; }
  .post-stats { font-size: 11px; gap: 16px; color: #a69aa2; width: 100%; }
  .stat-time { margin-left: auto; font-size: 10px; }
  .pagination-wrapper { margin-top: 22px; }
  .seek-pagination { gap: 8px; }
  .seek-pagination .page-size { width: 100px; }
  .seek-pagination :deep(.el-button) { margin-left: 0; padding-inline: 11px; }
}

/* Mobile keeps discovery controls close to the feed; the established desktop layout stays above. */
@media (max-width: 900px) {
  .forum-hero, .forum-sidebar, .desktop-feed-detail, .desktop-filter-label { display: none; }
  .forum-main { padding: 0 12px 28px; }
  .content-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 12px 0 8px; margin-bottom: 0; }
  .search-input { grid-column: 1 / -1; min-width: 0; width: 100%; }
  .has-mobile-publish .search-input { grid-column: 1; }
  .search-input :deep(.el-input__wrapper) { min-height: 42px; }
  .mobile-publish { display: inline-flex; width: 44px; height: 44px; padding: 0; margin: 0; border-radius: 14px; background: #a66b83; border-color: #a66b83; }
  .mobile-publish .el-icon { font-size: 19px; }
  .sort-group { grid-row: 2; grid-column: 1; min-width: 0; flex-wrap: nowrap; }
  .sort-group :deep(.el-radio-button__inner) { min-height: 40px; padding: 12px 10px; font-size: 12px; }
  .mobile-filter-button { display: inline-flex; grid-row: 2; grid-column: 2; min-height: 40px; padding: 0 10px; margin: 0; gap: 4px; border: 0; border-radius: 12px; color: #796c75; background: #eee9ec; }
  .mobile-filter-button.selected { color: #955d76; background: #f3e5ed; }
  .filter-count { font-size: 11px; margin-left: 4px; }
  .content-toolbar > .hot-period { display: none; }
  .mobile-feed-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 36px; margin-bottom: 6px; font-size: 11px; color: #92818c; }
  .mobile-feed-meta > span { min-width: 0; overflow-wrap: anywhere; }
  .mobile-feed-meta .el-button { min-height: 36px; padding: 4px 0 4px 10px; color: #8e657a; font-size: 12px; flex-shrink: 0; }
  .mobile-feed-meta .el-icon { margin-right: 4px; }
  .mobile-coverage-note { display: block; margin: 0 0 10px; font-size: 11px; color: var(--text-secondary); line-height: 1.6; }
  .filter-summary { padding: 6px 0 0; gap: 8px; }
  .mobile-filter-label { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; min-width: 0; flex: 1; }
  .filter-summary .el-button { min-height: 36px; flex-shrink: 0; }
  .post-card { padding: 16px; border-radius: 16px; }
  .post-skeleton { padding: 16px; border: 1px solid #eee8ec; border-radius: 16px; box-shadow: none; }
  .skeleton-footer { margin-top: 16px; }
  .feed-retry-notice { gap: 8px; }
  .post-card-header { margin-bottom: 8px; }
  .post-title { line-height: 1.6; }
  .post-summary { margin-top: 6px; line-height: 1.65; }
  .post-card-footer { gap: 2px; }
  .post-author { flex-basis: 100%; min-width: 0; gap: 8px; }
  .author-profile { flex: 1; min-width: 0; gap: 7px; }
  .author-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .author-follow { min-height: 40px; padding-inline: 8px; flex-shrink: 0; }
  .mobile-post-time { display: inline; margin-left: auto; font-size: 10px; white-space: nowrap; color: #a69aa2; flex-shrink: 0; }
  .post-stats { align-items: center; gap: 16px; }
  .post-stats .stat-item { min-height: 40px; }
  .post-stats .bookmark-action { margin-left: auto; min-height: 40px; }
  .post-stats .stat-time { display: none; }
  .last-reply { margin-top: 4px; }
  .mobile-filter-content { padding-bottom: max(8px, env(safe-area-inset-bottom)); }
  .mobile-filter-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px 12px; }
  .mobile-filter-fields label { display: flex; flex-direction: column; gap: 8px; color: var(--text-regular); font-size: 13px; min-width: 0; }
  .mobile-filter-fields .el-select { width: 100%; }
  .mobile-filter-fields :deep(.el-select__wrapper) { min-height: 40px; }
  .mobile-filter-notes { color: var(--text-secondary); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
  .mobile-filter-notes p { margin: 16px 0 0; }
  .mobile-tracking { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--border-light); }
  .mobile-tracking > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
  .mobile-tracking a { color: var(--primary-color); font-size: 12px; text-decoration: none; }
  .mobile-tracking p { color: var(--text-secondary); font-size: 12px; line-height: 1.7; }
  .mobile-tracking > .el-button { min-height: 40px; }
  .mobile-filter-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 24px; }
  .mobile-filter-actions .el-button { min-height: 42px; margin: 0; }
  .seek-pagination :deep(.el-button), .seek-pagination :deep(.el-select__wrapper) { min-height: 40px; }
}
</style>
