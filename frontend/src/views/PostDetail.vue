<template>
  <div ref="container" class="post-page" :data-reading-font="readingFont" :style="readingStyle"><div class="post-wrapper">
    <el-page-header @back="goBack" title="返回讨论"><template #extra>
      <el-popover placement="bottom-end" :width="260" trigger="click">
        <template #reference><button class="reading-settings-trigger" type="button" aria-label="阅读设置"><span aria-hidden="true">Aa</span>阅读设置</button></template>
        <div class="reading-settings-panel"><div class="reading-settings-title">帖子文字大小</div>
          <div class="reading-font-options" role="group" aria-label="帖子文字大小"><button v-for="option in READING_FONT_OPTIONS" :key="option.value" type="button" :aria-pressed="readingFont === option.value" @click="setReadingFont(option.value)">{{ option.label }}</button></div>
          <div class="reading-settings-footer"><span v-if="!readingPreferenceSaved" role="status">设置已生效，但未能保存</span><button type="button" @click="setReadingFont('standard')">恢复标准</button></div>
        </div>
      </el-popover>
    </template></el-page-header>
    <el-skeleton v-if="loading" :rows="8" animated class="post-card" />
    <el-empty v-else-if="!post" description="帖子暂时无法访问"><el-button @click="load">重试</el-button></el-empty>
    <article v-else class="post-card">
      <div class="eyebrow">{{ post.category?.name || '校园交流' }}</div>
      <h1>{{ post.title }}</h1>
      <div class="post-meta">
        <router-link class="author-link author-avatar-link" :to="'/user/' + post.user.id" :aria-label="'查看 ' + post.user.username + ' 的主页'"><el-avatar :size="36" :src="post.user.avatar">{{ post.user.username.slice(0, 1) }}</el-avatar></router-link>
        <router-link class="author-link" :to="'/user/' + post.user.id"><strong>{{ post.user.username }}</strong></router-link><span>{{ formatTime(post.createdAt) }}</span>
        <span>{{ post.viewCount }} 阅读 · {{ post.commentCount }} 条评论</span>
        <el-button v-if="post.user.id !== userStore.user?.id" size="small" round :type="post.user.isFollowing ? 'default' : 'primary'" :loading="busy.has('follow')" :aria-pressed="!!post.user.isFollowing" :aria-label="(post.user.isFollowing ? '取消关注 ' : '关注 ') + post.user.username" @click="toggleAuthor">{{ post.user.isFollowing ? '已关注' : '+ 关注作者' }}</el-button>
      </div>
      <div v-if="post.contentFormat === 'markdown'" class="post-content legacy-content" v-html="legacyContent" @click="handleLegacyLink" />
      <div v-else class="post-content">{{ post.content }}</div>
      <div class="tags"><el-tag v-for="pt in post.tags" :key="pt.tag.id" effect="plain" round>{{ pt.tag.name }}</el-tag></div>
      <div class="post-actions">
        <el-button round :type="post.isLiked ? 'primary' : 'default'" :loading="busy.has('like')" @click="togglePost('like')">{{ post.isLiked ? '已点赞' : '点赞' }} {{ post.likeCount }}</el-button>
        <el-button round :type="post.isFavorited ? 'primary' : 'default'" :aria-pressed="!!post.isFavorited" :aria-label="post.isFavorited ? '取消收藏帖子' : '收藏帖子'" :loading="busy.has('favorite')" @click="togglePost('favorite')"><el-icon><Collection /></el-icon>{{ post.isFavorited ? '已收藏' : '收藏帖子' }}</el-button>
        <router-link v-if="post.isFavorited" class="my-favorites" to="/user/profile?activity=favorites">我的收藏</router-link>
        <el-button v-if="userStore.user" round :loading="tracking" :disabled="trackedPost === post.id" @click="trackPost">{{ trackedPost === post.id ? '已追踪更新' : '追踪帖子更新' }}</el-button>
        <el-button v-if="post.user.id === userStore.user?.id" round @click="$router.push('/forum/post/' + post.id + '/edit')">编辑帖子</el-button>
        <el-button v-if="userStore.user && post.user.id !== userStore.user.id" link @click="openReport('POST',post.id)">举报</el-button>
      </div>
      <section class="discussion" :aria-labelledby="'post-discussion-' + post.id">
        <div class="discussion-heading"><h2 ref="discussionHeading" :id="'post-discussion-' + post.id" tabindex="-1">评论 <span>{{ post.commentCount }}</span></h2>
          <div class="discussion-controls"><el-switch v-model="onlyAuthor" active-text="只看楼主" aria-label="只看楼主" :disabled="submitting || replySubmitting" @change="changeAuthorFilter" />
          <el-select v-model="sortOrder" aria-label="评论排序" style="width:120px" @change="changeSort">
            <el-option label="最新优先" value="desc" /><el-option label="最早优先" value="asc" />
          </el-select></div>
        </div>
        <p v-if="onlyAuthor" class="hint author-filter-hint" role="status">只看楼主发言 · {{ authorCommentCount }} 条</p>
        <p v-if="focusUnavailable" class="hint" role="status">{{ onlyAuthor ? '这条评论不在“只看楼主”范围内或已不可访问，以下仅展示楼主发言。' : '这条评论已不可访问，以下是帖子的当前讨论。' }}</p>
        <div v-if="userStore.user" ref="commentComposer" class="composer" :class="{ 'composer-expanded': commentComposerOpen }">
          <button class="mobile-compose-trigger" type="button" :aria-expanded="commentComposerOpen" aria-controls="post-comment-editor" @click="toggleCommentComposer">
            <span>{{ commentComposerOpen ? '收起编辑器' : commentText.trim() ? '继续编辑评论' : '写下你的评论…' }}</span><el-icon><Edit /></el-icon>
          </button>
          <div id="post-comment-editor" class="composer-editor">
            <el-input v-model="commentText" type="textarea" :rows="3" maxlength="4000" show-word-limit placeholder="写下你的评论，分享观点或提个问题…" aria-label="评论内容" />
            <div class="composer-actions comment-submit-actions"><el-button type="primary" round :loading="submitting" :disabled="!commentText.trim()" @click="submitComment">发表评论</el-button></div>
          </div>
        </div>
        <el-button v-else plain round @click="$router.push('/login')">登录后参与讨论</el-button>
        <div v-loading="commentsLoading" class="comments">
          <el-alert v-if="commentsError" class="comments-error" title="评论暂时加载失败，请重试" type="error" :closable="false"><el-button link @click="loadComments">重试评论</el-button></el-alert>
          <el-empty v-if="!comments.length && !commentsLoading && !commentsError" :image-size="72" :description="onlyAuthor ? '楼主暂时还没有发言' : '还没有评论'" />
          <div v-for="comment in comments" :key="comment.id" :id="'comment-' + comment.id" class="comment" :class="{ 'new-comment': highlightedId === comment.id }">
            <el-avatar v-if="!comment.contextOnly" :size="36" :src="comment.user.avatar">{{ comment.user.username.slice(0, 1) }}</el-avatar>
            <div class="comment-body">
              <p v-if="comment.contextOnly" class="thread-context">该楼层用于展示楼主回复</p>
              <template v-else><div class="comment-meta"><router-link class="author-link" :to="'/user/' + comment.user.id"><strong>{{ comment.user.username }}</strong></router-link><span>{{ formatTime(comment.createdAt) }}</span></div>
              <p class="comment-text" :class="{ deleted: comment.status === 'DELETED' }">{{ comment.content }}</p></template>
              <div class="comment-actions" v-if="!comment.contextOnly && comment.status !== 'DELETED'">
                <el-button link :type="comment.isLiked ? 'primary' : 'info'" :disabled="busy.has('c' + comment.id)" @click="toggleComment(comment)">赞 {{ comment.likeCount || '' }}</el-button>
                <el-button v-if="userStore.user" link :aria-expanded="replyTo === comment.id" :aria-controls="'reply-editor-' + comment.id" @click="beginReply(comment)">回复</el-button>
                <el-button v-if="comment.canDelete" link type="danger" :disabled="busy.has('d' + comment.id)" @click="removeComment(comment)">删除</el-button>
                <el-button v-if="userStore.user && comment.user.id !== userStore.user.id" link @click="openReport('COMMENT',comment.id)">举报</el-button>
              </div>
              <div v-if="!comment.contextOnly && replyTo === comment.id" :id="'reply-editor-' + comment.id" class="reply-composer" role="group" :aria-label="'回复 ' + comment.user.username">
                <el-input v-model="replyText" type="textarea" :rows="2" maxlength="4000" show-word-limit :placeholder="'回复 ' + comment.user.username" aria-label="回复内容" />
                <div class="composer-actions"><el-button link @click="closeReply">取消</el-button><el-button type="primary" size="small" :loading="replySubmitting" :disabled="!replyText.trim()" @click="submitReply(comment)">发送回复</el-button></div>
              </div>
              <div v-if="comment.replies?.length" class="replies">
                <div v-for="reply in comment.replies" :key="reply.id" :id="'comment-' + reply.id" class="reply" :class="{ 'new-comment': highlightedId === reply.id }">
                  <router-link class="author-link" :to="'/user/' + reply.user.id"><strong>{{ reply.user.username }}</strong></router-link><span class="reply-date">{{ formatTime(reply.createdAt) }}</span>
                  <p class="comment-text">{{ reply.content }}</p>
                  <el-button v-if="reply.canDelete" link size="small" type="danger" :disabled="busy.has('d' + reply.id)" @click="removeComment(reply)">删除</el-button>
                  <el-button v-if="userStore.user && reply.user.id !== userStore.user.id" link size="small" @click="openReport('COMMENT',reply.id)">举报</el-button>
                </div>
              </div>
              <el-button v-if="comment.replyCount > 3 && !expanded[comment.id]" link type="primary" :loading="busy.has('r' + comment.id)" @click="loadReplies(comment, 1)">查看全部 {{ comment.replyCount }} 条回复</el-button>
              <el-pagination v-if="expanded[comment.id] && comment.replyCount > 10" small layout="prev, pager, next" :pager-count="5" :page-size="10" :total="comment.replyCount" :current-page="expanded[comment.id]" @current-change="(p: number) => loadReplies(comment, p)" />
            </div>
          </div>
        </div>
        <el-pagination v-if="total > 10" class="pagination" background layout="prev, pager, next" :pager-count="5" :page-size="10" :total="total" v-model:current-page="page" @current-change="changeCommentPage" />
      </section>
    </article>
  </div>
    <footer v-if="post && !loading" class="mobile-post-dock" role="group" aria-label="帖子快捷操作">
      <button class="dock-compose" type="button" :aria-expanded="commentComposerOpen" aria-controls="post-comment-editor" @click="openCommentComposer"><el-icon><Edit /></el-icon><span>{{ commentText.trim() ? '继续编辑评论' : '写评论…' }}</span></button>
      <button class="dock-action" type="button" :aria-label="'查看 ' + post.commentCount + ' 条评论'" :aria-controls="'post-discussion-' + post.id" @click="jumpToDiscussion"><el-icon><ChatDotRound /></el-icon><span>{{ post.commentCount }}</span></button>
      <button class="dock-action" :class="{ saved: post.isFavorited }" type="button" :aria-label="post.isFavorited ? '取消收藏帖子' : '收藏帖子'" :aria-pressed="!!post.isFavorited" :disabled="busy.has('favorite')" @click="togglePost('favorite')"><el-icon><Collection /></el-icon><span>{{ post.isFavorited ? '已收藏' : '收藏' }}</span></button>
    </footer>
    <ReportDialog v-model="reportOpen" :type="reportType" :target-id="reportTarget" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed, nextTick, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { readForumNavigation } from '@/utils/forum-experience';
import { forumPostPath, resolveForumLinks } from '@/utils/forum-links';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { ElMessage, ElMessageBox } from 'element-plus';
import request from '@/utils/request';
import ReportDialog from '@/components/ReportDialog.vue';
import { useUserStore } from '@/stores/user';
import { READING_FONT_OPTIONS, readReadingFont, saveReadingFont, readingFontStyle, type ReadingFont } from '@/utils/reading-preferences';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
dayjs.extend(relativeTime); dayjs.locale('zh-cn');
const route = useRoute(), router = useRouter(), userStore = useUserStore();
const reportOpen=ref(false),reportType=ref<'POST'|'COMMENT'>('POST'),reportTarget=ref(0);
function openReport(type:'POST'|'COMMENT',id:number){reportType.value=type;reportTarget.value=id;reportOpen.value=true;}
const readingFont = ref<ReadingFont>(readReadingFont(userStore.user?.id)), readingPreferenceSaved = ref(true);
const readingStyle = computed(() => readingFontStyle(readingFont.value));
function setReadingFont(value: ReadingFont) {
  readingFont.value = value;
  readingPreferenceSaved.value = saveReadingFont(userStore.user?.id, value);
}
const post = ref<any>(null), comments = ref<any[]>([]), loading = ref(true), commentsLoading = ref(false), commentsError = ref(false);
const page = ref(1), total = ref(0), sortOrder = ref('desc'), commentText = ref(''), replyText = ref('');
const replyTo = ref<number | null>(null), submitting = ref(false), replySubmitting = ref(false);
const expanded = reactive<Record<number, number>>({}), busy = reactive(new Set<string>());
const highlightedId = ref<number | null>(null), container = ref<HTMLElement | null>(null);
const discussionHeading = ref<HTMLElement | null>(null), commentComposer = ref<HTMLElement | null>(null);
const commentComposerOpen = ref(false), replyDrafts = new Map<number, string>();
const onlyAuthor = ref(false), authorCommentCount = ref(0);
const focusUnavailable = ref(false);
const tracking = ref(false), trackedPost = ref<number | null>(null);
let trackingRequest = 0;
const legacyContent = computed(() => {
  const safe = DOMPurify.sanitize(marked.parse(post.value?.content || '', { async: false }) as string,
    { FORBID_TAGS: ['style', 'iframe', 'form', 'input'], FORBID_ATTR: ['style', 'data-forum-post-path'] });
  return resolveForumLinks(safe, path => router.resolve(path).href);
});
function handleLegacyLink(event: MouseEvent) {
  if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element)?.closest('a[data-forum-post-path]');
  const path = forumPostPath(link?.getAttribute('data-forum-post-path') || '');
  if (path) { event.preventDefault(); router.push(path); }
}
let generation = 0, commentRequest = 0;
const threadRevisions = new Map<number, number>();
function invalidateCommentRead() { commentRequest++; commentsLoading.value = false; }
function mutateThread(id: number) { threadRevisions.set(id, (threadRevisions.get(id) || 0) + 1); invalidateCommentRead(); }
let focusPending = true;
function goBack() {
  const previous = window.history.state?.back;
  if (typeof previous === 'string' && /^\/chat(?:\?|$)/.test(previous)) { router.back(); return; }
  const saved = readForumNavigation(userStore.user?.id || 0); router.push(saved?.path || '/forum');
}
async function focusComment(id: number) { highlightedId.value = id; await nextTick(); document.getElementById('comment-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
const scrollBehavior = (): ScrollBehavior => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
async function jumpToDiscussion() {
  await nextTick();
  discussionHeading.value?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  discussionHeading.value?.focus({ preventScroll: true });
}
async function openCommentComposer() {
  if (!loggedIn()) return;
  const target = post.value?.id;
  commentComposerOpen.value = true;
  await nextTick();
  if (target !== post.value?.id) return;
  commentComposer.value?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  commentComposer.value?.querySelector('textarea')?.focus({ preventScroll: true });
}
function toggleCommentComposer() {
  if (commentComposerOpen.value) commentComposerOpen.value = false;
  else void openCommentComposer();
}
const formatTime = (time: string) => dayjs(time).fromNow();
const loggedIn = () => { if (userStore.user) return true; ElMessage.warning('请先登录'); return false; };
async function trackPost() {
  if (!loggedIn() || !post.value || tracking.value) return;
  const target = post.value.id, account = userStore.user!.id, stamp = generation, requestStamp = ++trackingRequest;
  tracking.value = true;
  try {
    const created = await request.post('/forum/subscriptions', { kind: 'POST_ACTIVITY', postId: target, cooldownSeconds: 3600 });
    if (stamp !== generation || requestStamp !== trackingRequest || target !== post.value?.id || account !== userStore.user?.id) return;
    if (created?.enabled !== true) { ElMessage.warning('追踪尚未启用，请到消息通知确认状态'); return; }
    trackedPost.value = target; ElMessage.success('已关注帖子更新，可在消息通知中管理');
  } catch { /* do not convert failed or stale requests into a successful follow */ }
  finally { if (requestStamp === trackingRequest) tracking.value = false; }
}
async function loadComments() {
  const stamp = ++commentRequest, id = route.params.id;
  commentsLoading.value = true; commentsError.value = false;
  try {
    const focusId = focusPending && /^\d+$/.test(String(route.query.comment || '')) ? Number(route.query.comment) : undefined;
    const params = { page: page.value, limit: 10, sortOrder: sortOrder.value, ...(onlyAuthor.value ? { onlyAuthor: true } : {}) };
    let data: any;
    try { data = await request.get('/forum/posts/' + id + '/comments', { params: { ...params, ...(focusId ? { commentId: focusId } : {}) } }); }
    catch (error: any) {
      if (!focusId || error.response?.status !== 404) throw error;
      if (stamp !== commentRequest || id !== route.params.id) return;
      // A withdrawn notification target is not a failure to load the entire discussion.
      focusPending = false; focusUnavailable.value = true; highlightedId.value = null;
      data = await request.get('/forum/posts/' + id + '/comments', { params });
    }
    if (stamp !== commentRequest || id !== route.params.id) return;
    comments.value = data.data; total.value = data.total;
    if (data.page) page.value = data.page;
    if (typeof data.activeCount === 'number' && onlyAuthor.value) authorCommentCount.value = data.activeCount;
    // A filtered response still carries the complete discussion count. Never
    // replace it with the number of author-only utterances or root threads.
    if (post.value) {
      if (typeof data.totalActiveCount === 'number') post.value.commentCount = data.totalActiveCount;
      else if (!onlyAuthor.value && typeof data.activeCount === 'number') post.value.commentCount = data.activeCount;
    }
    if (focusId) { focusPending = false; if (data.focusId) await focusComment(data.focusId); }
  } catch {
    // A failed read is not an empty discussion. Keep the confirmed thread/draft
    // and offer an explicit retry, including after changing the author filter.
    if (stamp === commentRequest && id === route.params.id) commentsError.value = true;
  }
  finally { if (stamp === commentRequest) commentsLoading.value = false; }
}
async function load() {
  const stamp = ++generation; loading.value = true; post.value = null;
  try { const data = await request.get('/forum/posts/' + route.params.id); if (stamp === generation) post.value = data; }
  catch { /* empty state offers retry */ }
  finally { if (stamp === generation) loading.value = false; }
  if (stamp === generation && post.value) {
    const target = post.value.id;
    await loadComments();
    if (stamp !== generation) return;
    try {
      const stored = sessionStorage.getItem('forum-viewer-token');
      const viewed: any = await request.post('/forum/posts/' + target + '/view', stored ? { viewerToken: stored } : {});
      if (viewed.viewerToken) sessionStorage.setItem('forum-viewer-token', viewed.viewerToken);
      if (stamp === generation && typeof viewed.viewCount === 'number') post.value.viewCount = viewed.viewCount;
    } catch { /* view measurement failure must not block reading */ }
  }
}
function changeSort() { page.value = 1; focusPending = false; Object.keys(expanded).forEach(key => delete expanded[Number(key)]); void loadComments(); }
function changeCommentPage() { focusPending = false; Object.keys(expanded).forEach(key => delete expanded[Number(key)]); void loadComments(); }
function changeAuthorFilter() {
  generation++; invalidateCommentRead(); page.value = 1; total.value = 0; comments.value = [];
  authorCommentCount.value = 0; focusUnavailable.value = false; highlightedId.value = null;
  focusPending = /^\d+$/.test(String(route.query.comment || ''));
  Object.keys(expanded).forEach(key => delete expanded[Number(key)]); threadRevisions.clear(); closeReply();
  void loadComments();
}
async function locked(key: string, fn: () => Promise<void>) {
  if (busy.has(key)) return; busy.add(key);
  try { await fn(); } catch { /* request interceptor reports failures */ } finally { busy.delete(key); }
}
async function togglePost(kind: 'like' | 'favorite') {
  if (!loggedIn()) return;
  const target = post.value, field = kind === 'like' ? 'isLiked' : 'isFavorited';
  const stamp = generation, account = userStore.user!.id;
  await locked(kind, async () => {
    const url = '/forum/posts/' + target.id + '/' + kind, was = !!target[field];
    const result = was ? await request.delete(url) : await request.post(url);
    if (stamp !== generation || account !== userStore.user?.id || target !== post.value) return;
    if (kind === 'favorite' && typeof result?.isFavorited !== 'boolean') throw new Error('Missing favorite state');
    target[field] = kind === 'favorite' ? result.isFavorited : !was;
    if (kind === 'like') target.likeCount = Math.max(0, target.likeCount + (was ? -1 : 1));
  });
}
async function toggleAuthor() {
  if (!loggedIn() || !post.value || post.value.user.id === userStore.user?.id) return;
  const target = post.value, stamp = generation, account = userStore.user!.id;
  await locked('follow', async () => {
    const url = '/users/' + target.user.id + '/follow';
    const result = target.user.isFollowing ? await request.delete(url) : await request.post(url);
    if (stamp !== generation || account !== userStore.user?.id || target !== post.value) return;
    if (typeof result?.isFollowing !== 'boolean') throw new Error('Missing follow state');
    target.user.isFollowing = result.isFollowing;
  });
}
async function toggleComment(comment: any) {
  if (!loggedIn()) return;
  await locked('c' + comment.id, async () => {
    const url = '/forum/comments/' + comment.id + '/like', was = comment.isLiked;
    if (was) await request.delete(url); else await request.post(url);
    comment.isLiked = !was; comment.likeCount = Math.max(0, comment.likeCount + (was ? -1 : 1));
  });
}
function closeReply() {
  if (replyTo.value !== null) replyDrafts.set(replyTo.value, replyText.value);
  replyTo.value = null;
}
async function beginReply(comment: any) {
  if (replyTo.value !== comment.id) { closeReply(); replyText.value = replyDrafts.get(comment.id) || ''; }
  replyTo.value = comment.id;
  await nextTick();
  const editor = container.value?.querySelector<HTMLElement>('#reply-editor-' + comment.id);
  editor?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  editor?.querySelector('textarea')?.focus({ preventScroll: true });
}
async function submitComment() {
  if (submitting.value || !commentText.value.trim() || !loggedIn()) return;
  const target = post.value, session = userStore.getAuthSession(), content = commentText.value.trim(), previousCount = target.commentCount;
  submitting.value = true;
  try {
    const added: any = await request.post('/forum/posts/' + target.id + '/comments', { content });
    const currentSession = userStore.getAuthSession();
    if (target !== post.value || session.userId !== currentSession.userId || session.epoch !== currentSession.epoch) return;
    if (commentText.value.trim() === content) { commentText.value = ''; commentComposerOpen.value = false; }
    invalidateCommentRead();
    // Locally show this user's new comment without replacing the thread or collapsing replies.
    // Filter changes do not change the post identity. Preserve a newer full
    // count read while this mutation was pending instead of double-counting it.
    post.value.commentCount = Math.max(post.value.commentCount, previousCount + 1);
    if (!onlyAuthor.value || userStore.user?.id === post.value.user.id) {
      if (!comments.value.some(comment => comment.id === added.id)) {
        if (sortOrder.value === 'desc') comments.value.unshift(added); else comments.value.push(added);
        total.value++; if (onlyAuthor.value) authorCommentCount.value++;
      }
      await focusComment(added.id);
    }
    ElMessage.success(onlyAuthor.value && userStore.user?.id !== post.value.user.id ? '评论已发布，当前仅展示楼主发言' : '评论已发布');
  } catch { /* keep the draft on failure */ } finally { submitting.value = false; }
}
async function submitReply(comment: any) {
  if (replySubmitting.value || !replyText.value.trim() || !loggedIn()) return;
  const target = post.value, session = userStore.getAuthSession(), content = replyText.value.trim(), previousCount = target.commentCount;
  replySubmitting.value = true;
  try {
    const added: any = await request.post('/forum/posts/' + target.id + '/comments', { content, parentId: comment.id });
    const currentSession = userStore.getAuthSession();
    if (target !== post.value || session.userId !== currentSession.userId || session.epoch !== currentSession.epoch) return;
    if (replyTo.value === comment.id && replyText.value.trim() === content) {
      replyText.value = ''; replyTo.value = null; replyDrafts.delete(comment.id);
    } else if (replyDrafts.get(comment.id)?.trim() === content) replyDrafts.delete(comment.id);
    mutateThread(comment.id);
    post.value.commentCount = Math.max(post.value.commentCount, previousCount + 1);
    const visible = !onlyAuthor.value || added.user?.id === post.value.user.id;
    const thread = comments.value.find(item => item.id === comment.id);
    if (visible && thread && !thread.replies?.some((reply: any) => reply.id === added.id)) {
      thread.replies = [...(thread.replies || []), added]; thread.replyCount++;
      if (onlyAuthor.value) authorCommentCount.value++;
      await focusComment(added.id);
    }
    ElMessage.success(visible ? '回复已发布' : '回复已发布，当前仅展示楼主发言');
  } catch { /* keep the draft on failure */ } finally { replySubmitting.value = false; }
}
async function loadReplies(comment: any, nextPage: number) {
  const target = post.value.id, stamp = generation, revision = threadRevisions.get(comment.id) || 0;
  await locked('r' + comment.id, async () => {
    const result: any = await request.get('/forum/posts/' + target + '/comments', { params: { parentId: comment.id, page: nextPage, limit: 10, sortOrder: 'asc', ...(onlyAuthor.value ? { onlyAuthor: true } : {}) } });
    if (target !== post.value?.id || stamp !== generation || revision !== (threadRevisions.get(comment.id) || 0)) return;
    comment.replies = result.data; comment.replyCount = result.total; expanded[comment.id] = nextPage;
  });
}
async function removeComment(comment: any) {
  const target = post.value?.id, stamp = generation, account = userStore.user?.id;
  await locked('d' + comment.id, async () => {
    await ElMessageBox.confirm('删除后正文不再显示，其他人的回复会保留。', '删除这条评论？', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '保留' });
    if (target !== post.value?.id || stamp !== generation || account !== userStore.user?.id) return;
    await request.delete('/forum/comments/' + comment.id);
    if (target !== post.value?.id || stamp !== generation || account !== userStore.user?.id) return;
    mutateThread(comment.parentId || comment.id);
    comment.status = 'DELETED'; comment.content = '评论已删除'; comment.canDelete = false;
    if (comment.parentId) { const parent = comments.value.find(c => c.id === comment.parentId); if (parent) parent.replyCount = Math.max(0, parent.replyCount - 1); }
    post.value.commentCount = Math.max(0, post.value.commentCount - 1);
    if (onlyAuthor.value && comment.user?.id === post.value.user.id) authorCommentCount.value = Math.max(0, authorCommentCount.value - 1);
  });
}
watch(() => [route.params.id, route.query.comment], (current, previous) => {
  generation++; commentRequest++; focusPending = true; page.value = 1; commentText.value = ''; replyText.value = ''; replyTo.value = null;
  if (current[0] !== previous?.[0]) onlyAuthor.value = false;
  authorCommentCount.value = 0;
  commentComposerOpen.value = false; replyDrafts.clear();
  trackingRequest++; tracking.value = false; trackedPost.value = null;
  focusUnavailable.value = false; highlightedId.value = null;
  Object.keys(expanded).forEach(key => delete expanded[Number(key)]); void load();
  threadRevisions.clear();
}, { immediate: true });
watch(() => userStore.user?.id, () => {
  readingFont.value = readReadingFont(userStore.user?.id); readingPreferenceSaved.value = true;
  generation++; commentRequest++; trackingRequest++; tracking.value = false; trackedPost.value = null;
  commentComposerOpen.value = false; replyDrafts.clear(); onlyAuthor.value = false; authorCommentCount.value = 0;
  commentText.value = ''; replyText.value = ''; replyTo.value = null; void load();
});
onUnmounted(() => { generation++; commentRequest++; trackingRequest++; });
</script>

<style scoped lang="scss">
.post-page { height: 100%; overflow-y: auto; background: var(--bg-page); }
.post-wrapper { max-width: 860px; margin: auto; padding: 24px 20px 48px; }
.post-card { background: #fff; border: 1px solid var(--border-light); border-radius: 20px; padding: 36px; margin-top: 20px; box-shadow: 0 8px 32px #43566b08; }
.eyebrow { font-size: 11px; letter-spacing: 2px; color: var(--primary-color); font-weight: 600; }
h1 { font-size: 27px; line-height: 1.5; margin: 12px 0 18px; overflow-wrap: anywhere; }
.post-meta, .post-actions, .tags, .comment-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.post-meta, .comment-meta span, .hint, .reply-date { font-size: 12px; color: var(--text-secondary); }
.post-meta strong, .comment-meta strong { color: var(--text-primary); font-size: 14px; }
.author-link { color: inherit; text-decoration: none; } .author-link:hover { color: var(--primary-color); }
.author-avatar-link { display: inline-flex; }
.my-favorites { font-size: 12px; color: var(--primary-color); text-decoration: none; }
.post-actions .el-icon { margin-right: 5px; }
.new-comment { background: #eef7ff; border-radius: 10px; box-shadow: 0 0 0 8px #eef7ff; }
.post-content { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.95; padding: 28px 0; font-size: var(--reading-body-size, 15px); }
.legacy-content { white-space: normal; }
.legacy-content :deep(img) { display: block; max-width: 100%; height: auto; border-radius: 10px; margin: 16px 0; }
.legacy-content :deep(a) { color: var(--primary-color); }
.legacy-content :deep(pre) { max-width: 100%; overflow-x: auto; white-space: pre; background: #f6f8fb; padding: 14px; border-radius: 10px; }
.legacy-content :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.post-actions { padding: 24px 0 4px; }
.discussion { border-top: 1px solid var(--border-light); margin-top: 32px; padding-top: 20px; }
.discussion-heading, .composer-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.discussion-controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.thread-context { color: var(--text-secondary); font-size: 12px; margin: 0 0 10px; }
.author-filter-hint { margin-top: 0; }
h2 { font-size: 19px; margin: 0; } h2 span { font-size: 12px; background: #f0f4f9; padding: 3px 8px; border-radius: 12px; margin-left: 6px; }
.hint { margin: 12px 0 20px; }
.composer { padding: 16px; background: #f7f9fc; border-radius: 14px; }
.composer-actions { margin-top: 12px; } .comment-submit-actions { justify-content: flex-end; }
.comments { min-height: 80px; margin-top: 24px; }
.comment { display: flex; gap: 12px; border-bottom: 1px solid var(--border-light); padding: 22px 0; }
.comment > .el-avatar { flex-shrink: 0; } .comment-body { flex: 1; min-width: 0; }
.comment-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.75; font-size: var(--reading-comment-size, 14px); margin: 10px 0 6px; }
.deleted { color: var(--text-secondary); font-style: italic; }
.replies { background: #f7f9fc; border-radius: 12px; margin-top: 12px; padding: 4px 14px; }
.reply { padding: 12px 0; border-bottom: 1px solid #e8edf4; font-size: 13px; } .reply:last-child { border: none; }
.reply-date { margin-left: 10px; } .reply-composer { margin-top: 12px; }
.pagination { margin-top: 24px; justify-content: center; }
.comment-meta strong, .reply strong, .post-meta strong { overflow-wrap: anywhere; min-width: 0; }
.comment-body :deep(.el-pagination) { flex-wrap: wrap; }
.mobile-post-dock, .mobile-compose-trigger { display: none; }
.reading-settings-trigger { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.reading-settings-trigger::before { content: ''; position: absolute; inset: -10px -4px; }
.reading-settings-trigger > span { font-size: 15px; font-weight: 600; }
.reading-settings-trigger:hover { color: var(--primary-color); background: var(--primary-bg); }
.reading-settings-trigger:focus-visible, .reading-font-options button:focus-visible, .reading-settings-footer button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
.reading-settings-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 12px; }
.reading-font-options { display: flex; gap: 6px; }
.reading-font-options button { flex: 1; min-height: 40px; border: 1px solid var(--border-light); border-radius: 8px; background: #fff; color: var(--text-regular); font: inherit; cursor: pointer; }
.reading-font-options button[aria-pressed='true'] { color: var(--primary-color); background: var(--primary-bg); border-color: var(--primary-color); }
.reading-settings-footer { font-size: 11px; line-height: 1.7; color: var(--text-secondary); }
.reading-settings-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.reading-settings-footer button { flex-shrink: 0; min-height: 36px; border: 0; background: transparent; color: var(--primary-color); font: inherit; cursor: pointer; }
.post-page:not([data-reading-font='standard']) .legacy-content :deep(pre), .post-page:not([data-reading-font='standard']) .legacy-content :deep(code) { font-size: var(--reading-body-size); }
@media (max-width: 600px) { .post-wrapper { padding: 16px 12px 32px; } .post-card { padding: 22px 16px; border-radius: 14px; } h1 { font-size: 22px; } .composer { padding: 12px; } }
@media (max-width: 900px) {
  .post-page { background: #faf9f7; display: flex; flex-direction: column; overflow: hidden; }
  .post-wrapper { padding: 16px 16px 28px; width: 100%; box-sizing: border-box; flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; }
  .post-card { border: 1px solid #eee7eb; box-shadow: none; border-radius: 20px; padding: 22px 18px; }
  .eyebrow { color: #a17c8f; font-size: 9px; }
  h1 { color: #3c333a; font-size: 22px; letter-spacing: -.3px; }
  .post-content { color: #50454d; font-size: var(--reading-body-size, 15px); }
  .composer, .replies { background: #f7f2f5; border-radius: 14px; }
  .comment-meta strong { color: #69555f; }
  .post-actions .el-button, .composer-actions .el-button, .comment-actions .el-button, .reply > .el-button { min-height: 44px; min-width: 44px; }
  .comment-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .comment-actions .el-button + .el-button { margin-left: 0; }
  .discussion-heading h2 { scroll-margin-top: 12px; }
  .discussion-controls { gap: 8px; }
  .discussion-controls .el-switch { min-height: 44px; }
  .discussion-heading h2:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 4px; border-radius: 4px; }
  .composer { padding: 0; }
  .mobile-compose-trigger { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 48px; padding: 12px; border: 0; border-radius: 14px; background: transparent; color: var(--text-secondary); font: inherit; text-align: left; cursor: pointer; }
  .composer-editor { display: none; padding: 0 12px 12px; }
  .composer-expanded .composer-editor { display: block; }
  .composer-expanded .mobile-compose-trigger { min-height: 44px; font-size: 12px; }
  // This dock is a flex sibling of the mobile scroll area, not viewport-fixed:
  // MainLayout's existing bottom navigation and safe-area inset stay below it.
  .mobile-post-dock { display: flex; align-items: center; flex: 0 0 auto; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border-light); background: #fff; }
  .mobile-post-dock button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; border: 0; font: inherit; cursor: pointer; color: var(--text-secondary); }
  .mobile-post-dock button:focus-visible, .mobile-compose-trigger:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .dock-compose { flex: 1; min-width: 0; border-radius: 22px; background: #f2f5f9; padding: 0 12px; justify-content: flex-start !important; font-size: 14px !important; }
  .dock-compose span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .dock-action { flex: 0 0 auto; min-width: 48px; max-width: 76px; padding: 0 4px; background: transparent; flex-direction: column; gap: 2px !important; font-size: 10px !important; }
  .dock-action .el-icon { font-size: 20px; }
  .dock-action span { max-width: 68px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dock-action.saved { color: var(--primary-color); }
  .mobile-post-dock button:disabled { opacity: .5; cursor: wait; }
}
</style>
