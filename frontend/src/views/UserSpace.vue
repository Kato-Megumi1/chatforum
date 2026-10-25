<template>
  <div class="user-space-container">
    <div class="user-space-wrapper">
      <el-page-header @back="$router.back()" title="返回" class="page-header" />
      <el-skeleton v-if="profileLoading" :rows="6" animated />
      <el-empty v-else-if="!user" description="这位用户暂时无法访问"><el-button @click="loadUser">重新加载</el-button></el-empty>
      <div class="user-space-main" v-else>
        <div class="user-banner">
          <div class="banner-avatar">
            <el-avatar :size="88" :src="user.avatar" class="space-avatar">
              {{ user.username.charAt(0).toUpperCase() }}
            </el-avatar>
          </div>
          <div class="banner-info">
            <h1 class="space-name">{{ user.username }}</h1>
            <div class="space-badges">
              <el-tag type="primary" effect="plain" round>Lv.{{ user.level }}</el-tag>
              <el-tag type="success" effect="plain" round>{{ user.points }} 积分</el-tag>
            </div>
            <p class="space-bio" v-if="user.bio">{{ user.bio }}</p>
            <div class="follow-actions" v-if="currentUserId !== user.id">
              <el-button
                :type="user.isFollowing ? 'default' : 'primary'"
                round
                :loading="followPending.has(user.id)"
                :aria-pressed="!!user.isFollowing"
                :aria-label="(user.isFollowing ? '取消关注 ' : '关注 ') + user.username"
                @click="handleFollow(user)"
              >
                {{ user.isFollowing ? '已关注' : '+ 关注' }}
              </el-button>
              <el-button round @click="messageUser(user.id)"><el-icon><ChatDotRound /></el-icon>私信</el-button>
            </div>
            <div v-else class="follow-actions"><router-link to="/user/profile">编辑资料</router-link><router-link to="/user/profile?activity=favorites">我的收藏</router-link><router-link to="/messages">私信</router-link></div>
          </div>
        </div>
        <div class="user-counts">
          <button class="count-item" :class="{ selected: spaceTab === 'posts' }" @click="selectTab('posts')">
            <div class="count-number">{{ user._count?.posts || 0 }}</div>
            <div class="count-label">帖子</div>
          </button>
          <div class="count-divider"></div>
          <button class="count-item" :class="{ selected: spaceTab === 'followers' }" @click="selectTab('followers')">
            <div class="count-number">{{ user._count?.followers || 0 }}</div>
            <div class="count-label">粉丝</div>
          </button>
          <div class="count-divider"></div>
          <button class="count-item" :class="{ selected: spaceTab === 'following' }" @click="selectTab('following')">
            <div class="count-number">{{ user._count?.following || 0 }}</div>
            <div class="count-label">关注</div>
          </button>
        </div>
        <div v-if="spaceTab === 'posts'" class="public-posts" v-loading="postsLoading">
          <h2>{{ currentUserId === user.id ? '我的帖子' : 'TA 的帖子' }}</h2>
          <el-alert v-if="postsError" title="暂时没能加载帖子，请重试" type="error" :closable="false" show-icon><el-button link @click="loadPosts">重新加载</el-button></el-alert>
          <el-empty v-if="!posts.length && !postsLoading && !postsError" description="还没有公开帖子" :image-size="76" />
          <router-link v-for="post in posts" :key="post.id" class="public-post" :to="'/forum/post/' + post.id"><strong>{{ post.title }}</strong><p>{{ post.summary }}</p><small>{{ post.category?.name }} · {{ post.commentCount }} 条评论</small></router-link>
          <el-pagination v-if="total > 10" :disabled="postsLoading" layout="prev, pager, next" :pager-count="5" :total="total" :page-size="10" v-model:current-page="page" @current-change="loadPosts" />
        </div>
        <section v-else class="people-section" :aria-label="spaceTab === 'followers' ? '粉丝列表' : '关注列表'" v-loading="peopleLoading">
          <h2>{{ spaceTab === 'followers' ? '粉丝' : '关注的人' }}</h2>
          <el-empty v-if="!people.length && !peopleLoading" :image-size="76" :description="peopleError ? '暂时没能加载，请重试' : spaceTab === 'followers' ? '还没有粉丝' : '还没有关注其他人'" />
          <el-button v-if="peopleError" :loading="peopleLoading" @click="loadPeople(peopleRetryAppend)">{{ peopleRetryAppend ? '重试加载更多' : '重新加载' }}</el-button>
          <article v-for="person in people" :key="person.id" class="person-row">
            <router-link :to="'/user/' + person.id" class="person-profile"><el-avatar :size="44" :src="person.avatar">{{ person.username.slice(0, 1) }}</el-avatar><div><strong>{{ person.username }}</strong><p v-if="person.bio">{{ person.bio }}</p></div></router-link>
            <el-button v-if="person.id !== currentUserId" round size="small" :loading="followPending.has(person.id)" :type="person.isFollowing ? 'default' : 'primary'" :aria-pressed="!!person.isFollowing" :aria-label="(person.isFollowing ? '取消关注 ' : '关注 ') + person.username" @click="handleFollow(person)">{{ person.isFollowing ? '已关注' : '+ 关注' }}</el-button>
          </article>
          <el-button v-if="peopleHasMore && !peopleError" class="load-people" :loading="peopleLoading" @click="loadPeople(true)">加载更多</el-button>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useUserStore } from '@/stores/user';
import request from '@/utils/request';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

const user = ref<any>(null);
const currentUserId = computed(() => userStore.user?.id || null);
const posts = ref<any[]>([]), postsLoading = ref(false), postsError = ref(false), total = ref(0), page = ref(1), profileLoading = ref(false);
const spaceTab = computed(() => ['followers', 'following'].includes(String(route.query.people)) ? String(route.query.people) : 'posts');
const people = ref<any[]>([]), peopleLoading = ref(false), peopleError = ref(false), peopleHasMore = ref(false), peopleCursor = ref<number | null>(null);
const peopleRetryAppend = ref(false);
const followPending = reactive(new Set<number>());
let generation = 0, postRequest = 0, peopleRequest = 0, followEpoch = 0;

const loadUser = async () => {
  const stamp = ++generation, id = route.params.id, account = currentUserId.value;
  profileLoading.value = true;
  try { const data = await request.get(`/users/${id}`);
    if (stamp === generation && id === route.params.id && account === currentUserId.value) user.value = data;
  } catch { /* unavailable accounts have no public profile */ }
  finally { if (stamp === generation) profileLoading.value = false; }
};
async function loadPosts() {
  const stamp = ++postRequest, id = route.params.id, account = currentUserId.value; postsLoading.value = true; postsError.value = false;
  try { const data: any = await request.get('/forum/posts', { params: { userId: id, page: page.value, limit: 10 } });
    if (stamp !== postRequest || id !== route.params.id || account !== currentUserId.value) return; posts.value = data.data; total.value = data.total;
  } catch { if (stamp === postRequest && id === route.params.id && account === currentUserId.value) postsError.value = true; }
  finally { if (stamp === postRequest) postsLoading.value = false; }
}

function requireLogin() {
  if (currentUserId.value) return true;
  ElMessage.info('请先登录'); void router.push({ path: '/login', query: { redirect: route.fullPath } }); return false;
}
function messageUser(id: number) { if (requireLogin()) void router.push({ path: '/messages', query: { user: String(id) } }); }
function selectTab(tab: string) { void router.replace({ query: { ...route.query, people: tab === 'posts' ? undefined : tab } }); }
const handleFollow = async (target: any) => {
  if (!requireLogin() || target.id === currentUserId.value || followPending.has(target.id)) return;
  const stamp = generation, account = currentUserId.value, epoch = followEpoch;
  followPending.add(target.id);
  try {
    const result = target.isFollowing ? await request.delete(`/users/${target.id}/follow`) : await request.post(`/users/${target.id}/follow`);
    if (stamp !== generation || account !== currentUserId.value || epoch !== followEpoch) return;
    if (typeof result?.isFollowing !== 'boolean') throw new Error('Missing follow state');
    for (const person of people.value) if (person.id === target.id) person.isFollowing = result.isFollowing;
    if (user.value?.id === target.id) { user.value.isFollowing = result.isFollowing; user.value._count.followers = result.followers; }
    if (user.value?.id === account && target !== user.value) {
      // Re-read counts rather than assuming the operation created a new edge in another tab.
      const refreshed = await request.get(`/users/${account}`);
      if (stamp === generation && account === currentUserId.value && epoch === followEpoch) user.value = refreshed;
    }
  } catch { /* retain the last confirmed state on server or permission errors */ }
  finally { if (epoch === followEpoch) followPending.delete(target.id); }
};

async function loadPeople(append = false) {
  if (spaceTab.value === 'posts' || (append && peopleLoading.value)) return;
  const stamp = ++peopleRequest, id = route.params.id, tab = spaceTab.value, account = currentUserId.value;
  peopleLoading.value = true; peopleError.value = false; peopleRetryAppend.value = append;
  try {
    const data = await request.get(`/users/${id}/${tab}`, { params: { limit: 20, ...(append && peopleCursor.value ? { cursor: peopleCursor.value } : {}) } });
    if (stamp !== peopleRequest || id !== route.params.id || tab !== spaceTab.value || account !== currentUserId.value) return;
    people.value = append ? [...people.value, ...data.data.filter((p: any) => !people.value.some(old => old.id === p.id))] : data.data;
    peopleHasMore.value = !!data.hasMore; peopleCursor.value = data.nextCursor;
  } catch { if (stamp === peopleRequest) peopleError.value = true; }
  finally { if (stamp === peopleRequest) peopleLoading.value = false; }
}

watch(() => [route.params.id, userStore.user?.id], () => {
  followEpoch++; followPending.clear(); peopleRequest++;
  user.value = null; posts.value = []; page.value = 1; total.value = 0; postsError.value = false;
  people.value = []; peopleCursor.value = null; peopleHasMore.value = false; peopleError.value = false; peopleRetryAppend.value = false; peopleLoading.value = false;
  void loadUser(); void loadPosts();
  if (spaceTab.value !== 'posts') void loadPeople();
}, { immediate: true });
watch(() => route.query.people, () => { peopleRequest++; people.value = []; peopleCursor.value = null; peopleHasMore.value = false; peopleError.value = false; peopleRetryAppend.value = false; peopleLoading.value = false; if (spaceTab.value !== 'posts') void loadPeople(); });
onUnmounted(() => { generation++; postRequest++; peopleRequest++; followEpoch++; });
</script>

<style lang="scss" scoped>
.user-space-container {
  height: 100%;
  overflow-y: auto;
  background: var(--bg-page);
}

.user-space-wrapper {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px 20px;
}

.page-header {
  margin-bottom: 16px;
}

.user-space-main {
  background: #fff;
  border-radius: var(--radius-lg);
  padding: 36px;
  box-shadow: var(--shadow-sm);
}

.user-banner {
  display: flex;
  gap: 24px;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--border-light);
}

.banner-avatar {
  flex-shrink: 0;
}

.space-avatar {
  border: 3px solid var(--primary-bg);
  box-shadow: var(--shadow-sm);
}

.banner-info {
  flex: 1;
  min-width: 0;
}

.space-name {
  margin: 0 0 10px;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
}

.space-badges {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.space-bio {
  font-size: 14px;
  color: var(--text-regular);
  margin: 0 0 16px;
  line-height: 1.6;
}

.follow-actions {
  margin-top: 4px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
.follow-actions a { color: var(--primary-color); font-size: 13px; text-decoration: none; }

.user-counts {
  display: flex;
  justify-content: space-around;
  align-items: center;
  padding: 28px 0;
  border-bottom: 1px solid var(--border-light);
}

.count-item {
  text-align: center;
  border: 0; background: transparent; cursor: pointer; padding: 8px 20px; border-radius: 12px;
}
.count-item:hover, .count-item.selected { background: var(--primary-bg); }
.count-item:focus-visible { outline: 2px solid var(--primary-color); }
.people-section h2 { margin: 26px 0 10px; font-size: 18px; }
.person-row { display: flex; align-items: center; gap: 12px; padding: 16px 0; border-bottom: 1px solid var(--border-light); }
.person-profile { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; color: var(--text-primary); text-decoration: none; }
.person-profile .el-avatar { flex-shrink: 0; }
.person-profile div { min-width: 0; }
.person-profile strong { font-size: 14px; overflow-wrap: anywhere; }
.person-profile p { margin: 5px 0 0; color: var(--text-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.load-people { display: flex; margin: 22px auto 0; }

.count-number {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.count-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.count-divider {
  width: 1px;
  height: 36px;
  background: var(--border-light);
}

.empty-state {
  padding: 48px 0 16px;
}
.public-posts h2 { font-size:18px; margin:28px 0 8px; }
.public-post { display:block; color:var(--text-primary); text-decoration:none; padding:18px 0; border-bottom:1px solid var(--border-light); }
.public-post strong { font-size:14px; overflow-wrap:anywhere; } .public-post:hover strong { color:var(--primary-color); }
.public-post p { font-size:13px; line-height:1.8; color:var(--text-secondary); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
.public-post small { color:var(--text-secondary); font-size:12px; } .el-pagination { justify-content:center; margin-top:24px; }
@media (max-width: 640px) {
  .user-space-wrapper { padding: 16px 12px 48px; }
  .user-space-main { padding: 20px 16px; }
  .user-banner { flex-wrap: wrap; gap: 16px; }
  .banner-info { flex-basis: 150px; overflow-wrap: anywhere; }
  .space-badges { flex-wrap: wrap; }
}
@media (max-width: 900px) {
  .user-space-container { background: #faf9f7; }
  .user-space-main { border: 1px solid #eee7eb; border-radius: 20px; box-shadow: none; }
}
</style>
