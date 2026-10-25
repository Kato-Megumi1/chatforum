<template>
  <section
    class="messages-page"
    :class="{ 'thread-open': !!conversation || opening || threadError }"
    aria-label="社区私信"
  >
    <aside class="inbox-pane">
      <header class="inbox-heading">
        <div>
          <h1>私信</h1>
        </div>
        <el-button circle aria-label="新私信" @click="openContacts"
          ><el-icon><EditPen /></el-icon
        ></el-button>
      </header>
      <div class="inbox-tabs" role="tablist" aria-label="私信分类">
        <button
          :class="{ active: box === 'inbox' }"
          role="tab"
          :aria-selected="box === 'inbox'"
          @click="switchBox('inbox')"
        >
          收件箱<span v-if="counts.inbox">{{ counts.inbox }}</span>
        </button>
        <button
          :class="{ active: box === 'requests' }"
          role="tab"
          :aria-selected="box === 'requests'"
          @click="switchBox('requests')"
        >
          消息请求<span v-if="counts.requests">{{ counts.requests }}</span>
        </button>
      </div>
      <div class="inbox-tools">
        <el-button
          text
          size="small"
          :loading="loadingList"
          @click="loadThreads()"
          >刷新</el-button
        >
      </div>
      <div class="inbox-list" v-loading="loadingList">
        <el-alert
          v-if="listError"
          title="暂时没能加载私信"
          type="error"
          :closable="false"
          ><el-button text @click="loadThreads()">重试</el-button></el-alert
        >
        <div v-else-if="!threads.length && !loadingList" class="list-empty">
          <el-icon><Message /></el-icon>
          <h3>{{ box === "requests" ? "暂时没有消息请求" : "还没有私信" }}</h3>
          <el-button v-if="box === 'inbox'" plain @click="openContacts"
            >发起私信</el-button
          >
        </div>
        <router-link
          v-for="thread in threads"
          :key="thread.id"
          class="thread-item"
          :class="{ selected: conversation?.id === thread.id }"
          :to="{
            path: '/messages',
            query: {
              thread: String(thread.id),
              ...(box === 'requests' ? { box: 'requests' } : {}),
            },
          }"
        >
          <el-avatar :src="thread.peer.avatar || undefined" :size="44">{{
            thread.peer.username.slice(0, 1)
          }}</el-avatar>
          <div class="thread-copy">
            <div>
              <strong>{{ thread.peer.username }}</strong
              ><time>{{ shortTime(thread.lastMessage?.createdAt) }}</time>
            </div>
            <p>{{ preview(thread) }}</p>
          </div>
          <span
            v-if="thread.unreadCount"
            class="unread-dot"
            :aria-label="thread.unreadCount + '条未读'"
          ></span>
        </router-link>
        <el-button
          v-if="listCursor"
          class="load-threads"
          text
          :loading="loadingMoreThreads"
          @click="loadThreads(true)"
          >更早的对话</el-button
        >
      </div>
    </aside>
    <main class="conversation-pane">
      <div
        v-if="opening"
        class="conversation-empty"
        v-loading="true"
        aria-label="正在打开私信"
      ></div>
      <div v-else-if="!conversation" class="conversation-empty">
        <div class="empty-symbol">
          <el-icon><ChatLineRound /></el-icon>
        </div>
        <h2>
          {{ threadError ? "这段私信暂时无法打开" : "选择一个对话" }}
        </h2>
        <el-button v-if="threadError" plain round @click="backToInbox"
          >返回列表</el-button
        ><el-button v-else type="primary" round @click="openContacts"
          >新私信</el-button
        >
      </div>
      <template v-else>
        <header class="conversation-heading">
          <el-button
            class="back-to-inbox"
            text
            circle
            aria-label="返回私信列表"
            @click="backToInbox"
            ><el-icon><ArrowLeft /></el-icon
          ></el-button>
          <router-link
            class="peer-heading"
            :to="'/user/' + conversation.peer.id"
            ><el-avatar
              :size="38"
              :src="conversation.peer.avatar || undefined"
              >{{ conversation.peer.username.slice(0, 1) }}</el-avatar
            >
            <div>
              <strong>{{ conversation.peer.username }}</strong>
            </div></router-link
          >
          <el-dropdown trigger="click"
            ><el-button circle text aria-label="私信设置"
              ><el-icon><MoreFilled /></el-icon></el-button
            ><template #dropdown
              ><el-dropdown-menu
                ><el-dropdown-item @click="toggleBlock">{{
                  conversation.blockedByMe ? "解除屏蔽" : "屏蔽此成员"
                }}</el-dropdown-item></el-dropdown-menu
              ></template
            ></el-dropdown
          >
        </header>
        <div v-if="conversation.blocked" class="relationship-note blocked-note">
          {{
            conversation.blockedByMe
              ? "你已屏蔽此成员，私信内容已隐藏。"
              : "当前无法与此成员继续私信。"
          }}<el-button v-if="conversation.blockedByMe" link @click="toggleBlock"
            >解除屏蔽</el-button
          >
        </div>
        <div
          v-else-if="conversation.state === 'DECLINED'"
          class="relationship-note"
        >
          这条消息请求已结束，不能继续发送。<el-button
            v-if="conversation.canAccept"
            link
            :loading="decisionBusy"
            @click="decide('accept')"
            >重新接受请求</el-button
          >
        </div>
        <div
          v-else-if="conversation.state === 'PENDING'"
          class="relationship-note"
        >
          <template v-if="conversation.requestDirection === 'incoming'"
            ><span>这位成员想与你交流。接受后才能继续对话。</span>
            <div class="request-actions">
              <el-button
                size="small"
                :disabled="decisionBusy"
                @click="decide('decline')"
                >拒绝</el-button
              ><el-button
                size="small"
                type="primary"
                :loading="decisionBusy"
                @click="decide('accept')"
                >接受请求</el-button
              >
            </div></template
          >
          <template v-else>{{
            conversation.canSend
              ? "先发一句问候吧，对方接受请求后可继续交流。"
              : "消息请求已发送，等待对方接受。"
          }}</template>
        </div>
        <div
          ref="messageScroll"
          class="message-scroll"
          @scroll.passive="onMessagesScroll"
        >
          <el-button
            v-if="olderCursor"
            class="older-messages"
            text
            :loading="loadingOlder"
            @click="loadOlder"
            >查看更早消息</el-button
          >
          <article
            v-for="message in messages"
            :key="message.id"
            class="direct-message"
            :class="{ mine: message.senderId === user.user?.id }"
          >
            <div class="message-bubble">{{ message.content }}</div>
            <time>{{ messageTime(message.createdAt) }}</time>
          </article>
        </div>
        <el-button
          v-if="newMessagesBelow"
          class="new-below"
          round
          size="small"
          @click="toBottom"
          >有新消息 · 回到底部</el-button
        >
        <div
          v-if="sendUncertain && !conversation.blocked"
          class="send-status"
          role="status"
        >
          发送结果未确认，请重试。<el-button
            link
            :disabled="sending"
            @click="send(true)"
            >重试发送</el-button
          >
        </div>
        <form class="direct-composer" @submit.prevent="send()">
          <el-input
            v-model="draft"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 6 }"
            :maxlength="2000"
            :disabled="
              !conversation.canSend ||
              conversation.blocked ||
              sending ||
              sendUncertain
            "
            :placeholder="
              conversation.canSend ? '发一条私信…' : '暂时无法发送消息'
            "
            aria-label="私信内容"
            @keydown="onComposerKey"
          />
          <div class="composer-bottom">
            <el-button
              type="primary"
              round
              native-type="submit"
              :disabled="!canSend"
              :loading="sending"
              aria-label="发送私信"
              ><el-icon><Promotion /></el-icon><span>发送</span></el-button
            >
          </div>
        </form>
      </template>
    </main>
    <el-dialog
      v-model="contactsOpen"
      title="新私信"
      width="min(440px, calc(100vw - 24px))"
      @closed="clearContacts"
    >
      <el-input
        v-model="contactQuery"
        placeholder="搜索社区用户名，至少 2 个字"
        maxlength="40"
        clearable
        aria-label="搜索私信联系人"
        @input="scheduleContactSearch"
      />
      <div class="contact-results" v-loading="searchingContacts">
        <p v-if="contactQuery.trim().length >= 2 && !contactResults.length && !searchingContacts">
          没有找到匹配的成员
        </p>
        <button
          v-for="contact in contactResults"
          :key="contact.id"
          @click="openPeer(contact.id)"
        >
          <el-avatar :size="36" :src="contact.avatar || undefined">{{
            contact.username.slice(0, 1)
          }}</el-avatar
          ><strong>{{ contact.username }}</strong
          ><el-icon><ArrowRight /></el-icon>
        </button>
      </div>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import {
  ArrowLeft,
  ArrowRight,
  ChatLineRound,
  EditPen,
  Message,
  MoreFilled,
  Promotion,
} from "@element-plus/icons-vue";
import request from "@/utils/request";
import { useUserStore } from "@/stores/user";
import { useDirectMessageStore } from "@/stores/direct-messages";
import {
  DirectConversation,
  DirectMessage,
  DirectPeer,
  directMessageDraftKey,
  mergeDirectMessages,
  messageIdAfter,
  uncertainDirectSend,
} from "@/utils/direct-messages";

const route = useRoute(),
  router = useRouter(),
  user = useUserStore(),
  counts = useDirectMessageStore();
const box = ref<"inbox" | "requests">("inbox"),
  threads = ref<DirectConversation[]>([]),
  listCursor = ref("");
const loadingList = ref(false),
  loadingMoreThreads = ref(false),
  listError = ref(false),
  opening = ref(false),
  threadError = ref(false);
const conversation = ref<DirectConversation | null>(null),
  messages = ref<DirectMessage[]>([]),
  olderCursor = ref(""),
  loadingOlder = ref(false);
const draft = ref(""),
  sending = ref(false),
  decisionBusy = ref(false),
  sendUncertain = ref(false),
  messageScroll = ref<HTMLElement | null>(null),
  newMessagesBelow = ref(false);
const contactsOpen = ref(false),
  contactQuery = ref(""),
  contactResults = ref<DirectPeer[]>([]),
  searchingContacts = ref(false);
const drafts = new Map<string, string>(),
  pending = new Map<string, { content: string; clientMessageId: string }>();
let accountGeneration = 0,
  threadGeneration = 0,
  listGeneration = 0,
  contactsGeneration = 0,
  peerGeneration = 0,
  polling = false,
  reading = false,
  lastAcknowledged = "0";
let refreshTimer: ReturnType<typeof setInterval> | undefined,
  contactTimer: ReturnType<typeof setTimeout> | undefined;
const live = (account: number | undefined, stamp: number) =>
  account === user.user?.id && stamp === accountGeneration;
const current = (account: number | undefined, stamp: number, id: number) =>
  account === user.user?.id &&
  stamp === threadGeneration &&
  conversation.value?.id === id;
const canSend = computed(
  () =>
    !!conversation.value?.canSend &&
    !conversation.value.blocked &&
    !!draft.value.trim() &&
    !sending.value &&
    !sendUncertain.value &&
    draft.value.length <= 2000,
);
const shortTime = (time?: string) =>
  time
    ? new Date(time).toLocaleDateString("zh-CN", {
        month: "numeric",
        day: "numeric",
      })
    : "";
const messageTime = (time: string) =>
  new Date(time).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const preview = (thread: DirectConversation) =>
  thread.blocked
    ? "暂时无法私信"
    : thread.state === "DECLINED"
      ? "请求已结束"
      : thread.lastMessage?.content || "还没有消息";
const nearBottom = () =>
  !!messageScroll.value &&
  messageScroll.value.scrollHeight -
    messageScroll.value.scrollTop -
    messageScroll.value.clientHeight <
    64;
function rememberDraft() {
  if (conversation.value && user.user)
    drafts.set(
      directMessageDraftKey(user.user.id, conversation.value.id),
      draft.value,
    );
}
watch(draft, rememberDraft);
function replaceThread(thread: DirectConversation) {
  if (conversation.value?.id === thread.id) {
    conversation.value = thread;
    if (thread.blocked) messages.value = [];
  }
  const index = threads.value.findIndex((item) => item.id === thread.id);
  if (index >= 0) threads.value[index] = thread;
}
function reconcilePending() {
  if (!conversation.value || !user.user) return;
  const key = directMessageDraftKey(user.user.id, conversation.value.id),
    saved = pending.get(key);
  if (
    saved &&
    messages.value.some(
      (message) =>
        message.clientMessageId === saved.clientMessageId &&
        message.senderId === user.user!.id,
    )
  ) {
    pending.delete(key);
    sendUncertain.value = false;
    if (draft.value.trim() === saved.content) {
      draft.value = "";
      drafts.delete(key);
    }
  }
}
async function loadThreads(more = false) {
  if (
    !user.user ||
    (more && !listCursor.value) ||
    (more && loadingMoreThreads.value)
  )
    return;
  const account = user.user.id,
    stamp = ++listGeneration,
    selectedBox = box.value;
  if (more) loadingMoreThreads.value = true;
  else loadingList.value = true;
  listError.value = false;
  try {
    const data = await request.get<{
      data: DirectConversation[];
      nextCursor: string | null;
    }>("/direct-messages/conversations", {
      params: {
        box: selectedBox,
        limit: 20,
        ...(more ? { cursor: listCursor.value } : {}),
      },
    });
    if (
      stamp !== listGeneration ||
      account !== user.user?.id ||
      box.value !== selectedBox
    )
      return;
    threads.value = more
      ? [
          ...threads.value,
          ...data.data.filter(
            (item) => !threads.value.some((old) => old.id === item.id),
          ),
        ]
      : data.data;
    listCursor.value = data.nextCursor || "";
  } catch {
    if (stamp === listGeneration && account === user.user?.id)
      listError.value = true;
  } finally {
    if (stamp === listGeneration) {
      loadingList.value = false;
      loadingMoreThreads.value = false;
    }
  }
}
async function readVisible() {
  if (
    reading ||
    document.hidden ||
    !nearBottom() ||
    !conversation.value ||
    conversation.value.blocked ||
    !messages.value.length
  )
    return;
  const last = messages.value[messages.value.length - 1].id;
  if (!messageIdAfter(last, lastAcknowledged)) return;
  const id = conversation.value.id,
    stamp = threadGeneration,
    account = user.user?.id;
  reading = true;
  try {
    const result = await request.put<{
      lastReadMessageId: string;
      unreadCount: number;
    }>(`/direct-messages/conversations/${id}/read`, {
      lastReadMessageId: last,
    });
    if (current(account, stamp, id)) {
      lastAcknowledged = result.lastReadMessageId;
      const item = threads.value.find((row) => row.id === id);
      if (item) item.unreadCount = result.unreadCount;
      void counts.refresh({ force: true });
    }
  } catch {
    /* No successful-read claim on errors; retry when the current thread is polled. */
  } finally {
    reading = false;
  }
}
async function toBottom() {
  await nextTick();
  if (messageScroll.value) {
    messageScroll.value.scrollTop = messageScroll.value.scrollHeight;
    newMessagesBelow.value = false;
    void readVisible();
  }
}
function onMessagesScroll() {
  if (nearBottom()) {
    newMessagesBelow.value = false;
    void readVisible();
  }
}
async function selectThread(id: number) {
  peerGeneration++;
  rememberDraft();
  const stamp = ++threadGeneration,
    account = user.user?.id;
  conversation.value = null;
  messages.value = [];
  draft.value = "";
  olderCursor.value = "";
  opening.value = true;
  threadError.value = false;
  sendUncertain.value = false;
  newMessagesBelow.value = false;
  lastAcknowledged = "0";
  sending.value = false;
  decisionBusy.value = false;
  loadingOlder.value = false;
  try {
    // Metadata remains readable by either participant after blocking; message bodies do not.
    const meta = await request.get<{ conversation: DirectConversation }>(
      `/direct-messages/conversations/${id}`,
    );
    if (stamp !== threadGeneration || account !== user.user?.id) return;
    const data = meta.conversation.blocked
      ? { ...meta, data: [], nextCursor: null, lastReadMessageId: "0" }
      : await request.get<{
          conversation: DirectConversation;
          data: DirectMessage[];
          nextCursor: string | null;
          lastReadMessageId: string;
        }>(`/direct-messages/conversations/${id}/messages`, {
          params: { limit: 30 },
        });
    if (stamp !== threadGeneration || account !== user.user?.id) return;
    conversation.value = data.conversation;
    messages.value = data.conversation.blocked
      ? []
      : mergeDirectMessages([], data.data);
    olderCursor.value = data.nextCursor || "";
    lastAcknowledged = data.lastReadMessageId || "0";
    const key = directMessageDraftKey(account!, id);
    draft.value = drafts.get(key) || "";
    sendUncertain.value = pending.has(key);
    reconcilePending();
    opening.value = false;
    await toBottom();
  } catch {
    if (stamp === threadGeneration && account === user.user?.id)
      threadError.value = true;
  } finally {
    if (stamp === threadGeneration) opening.value = false;
  }
}
async function openPeer(recipientId: number) {
  const stamp = accountGeneration,
    peerStamp = ++peerGeneration,
    account = user.user?.id;
  contactsOpen.value = false;
  rememberDraft();
  opening.value = true;
  try {
    const data = await request.post<{ conversation: DirectConversation }>(
      "/direct-messages/conversations",
      { recipientId },
    );
    if (!live(account, stamp) || peerStamp !== peerGeneration) return;
    if (
      route.query.thread === String(data.conversation.id) &&
      !route.query.user
    )
      await selectThread(data.conversation.id);
    else
      await router.replace({
        path: "/messages",
        query: { thread: String(data.conversation.id) },
      });
    void loadThreads();
  } catch {
    if (live(account, stamp) && peerStamp === peerGeneration)
      opening.value = false;
  }
}
async function loadOlder() {
  if (!conversation.value || !olderCursor.value || loadingOlder.value) return;
  const id = conversation.value.id,
    stamp = threadGeneration,
    account = user.user?.id,
    scroll = messageScroll.value,
    oldHeight = scroll?.scrollHeight || 0,
    oldTop = scroll?.scrollTop || 0;
  loadingOlder.value = true;
  try {
    const data = await request.get<{
      conversation: DirectConversation;
      data: DirectMessage[];
      nextCursor: string | null;
    }>(`/direct-messages/conversations/${id}/messages`, {
      params: { cursor: olderCursor.value, limit: 30 },
    });
    if (!current(account, stamp, id)) return;
    replaceThread(data.conversation);
    messages.value = data.conversation.blocked
      ? []
      : mergeDirectMessages(messages.value, data.data);
    olderCursor.value = data.nextCursor || "";
    await nextTick();
    if (current(account, stamp, id) && scroll)
      scroll.scrollTop = scroll.scrollHeight - oldHeight + oldTop;
  } catch {
    /* Keep existing messages; global request handling reports the failure. */
  } finally {
    if (current(account, stamp, id)) loadingOlder.value = false;
  }
}
async function send(retry = false) {
  if (
    !conversation.value ||
    !user.user ||
    sending.value ||
    conversation.value.blocked
  )
    return;
  const id = conversation.value.id,
    stamp = threadGeneration,
    account = user.user.id,
    key = directMessageDraftKey(account, id),
    content = draft.value.trim();
  const saved = pending.get(key);
  if (retry ? !saved : !canSend.value) return;
  const payload = retry
    ? saved!
    : { content, clientMessageId: crypto.randomUUID() };
  pending.set(key, payload);
  sending.value = true;
  sendUncertain.value = false;
  try {
    const result = await request.post<{
      message: DirectMessage;
      conversation: DirectConversation;
    }>(`/direct-messages/conversations/${id}/messages`, payload);
    if (!current(account, stamp, id)) return;
    replaceThread(result.conversation);
    messages.value = mergeDirectMessages(messages.value, [result.message]);
    pending.delete(key);
    drafts.delete(key);
    draft.value = "";
    sendUncertain.value = false;
    await toBottom();
    void loadThreads();
    void counts.refresh({ force: true });
  } catch (error) {
    if (current(account, stamp, id)) {
      sendUncertain.value = uncertainDirectSend(error);
      if (!sendUncertain.value) pending.delete(key);
    }
  } finally {
    if (current(account, stamp, id)) sending.value = false;
  }
}
function onComposerKey(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}
async function decide(action: "accept" | "decline") {
  if (!conversation.value || decisionBusy.value) return;
  const id = conversation.value.id,
    stamp = threadGeneration,
    account = user.user?.id;
  if (action === "decline")
    try {
      await ElMessageBox.confirm(
        "拒绝这条消息请求？对方将无法继续发送。",
        "拒绝请求",
        { confirmButtonText: "拒绝", cancelButtonText: "取消" },
      );
    } catch {
      return;
    }
  if (!current(account, stamp, id)) return;
  decisionBusy.value = true;
  try {
    const result = await request.patch<{ conversation: DirectConversation }>(
      `/direct-messages/conversations/${id}/request`,
      { action },
    );
    if (!current(account, stamp, id)) return;
    replaceThread(result.conversation);
    void loadThreads();
    void counts.refresh({ force: true });
  } catch {
    /* Do not change request state after a failed decision. */
  } finally {
    if (current(account, stamp, id)) decisionBusy.value = false;
  }
}
async function toggleBlock() {
  if (!conversation.value) return;
  const id = conversation.value.id,
    stamp = threadGeneration,
    account = user.user?.id,
    peer = conversation.value.peer.id,
    blocked = !conversation.value.blockedByMe;
  try {
    await ElMessageBox.confirm(
      blocked
        ? "屏蔽后双方无法继续私信，此处的内容也将隐藏。"
        : "解除屏蔽后仍保留原请求状态，不会自动接受消息。",
      blocked ? "屏蔽成员" : "解除屏蔽",
      {
        confirmButtonText: blocked ? "屏蔽" : "解除屏蔽",
        cancelButtonText: "取消",
      },
    );
  } catch {
    return;
  }
  if (!current(account, stamp, id)) return;
  try {
    await request.put(`/direct-messages/users/${peer}/block`, { blocked });
    if (!current(account, stamp, id)) return;
    await selectThread(id);
    void loadThreads();
    void counts.refresh({ force: true });
  } catch {
    /* No local block/unblock success claim without the server response. */
  }
}
async function poll() {
  if (polling || document.hidden || !user.user) return;
  polling = true;
  try {
    if (!conversation.value) {
      await loadThreads();
      return;
    }
    const id = conversation.value.id,
      stamp = threadGeneration,
      account = user.user.id,
      bottom = nearBottom(),
      afterId = messages.value[messages.value.length - 1]?.id;
    const meta = await request.get<{ conversation: DirectConversation }>(
      `/direct-messages/conversations/${id}`,
    );
    if (!current(account, stamp, id)) return;
    replaceThread(meta.conversation);
    if (meta.conversation.blocked) {
      olderCursor.value = "";
      void counts.refresh();
      return;
    }
    const data = await request.get<{
      conversation: DirectConversation;
      data: DirectMessage[];
      nextCursor: string | null;
    }>(`/direct-messages/conversations/${id}/messages`, {
      params: { ...(afterId ? { afterId } : {}), limit: 30 },
    });
    if (!current(account, stamp, id)) return;
    replaceThread(data.conversation);
    if (!afterId) olderCursor.value = data.nextCursor || "";
    const before = messages.value.length;
    messages.value = data.conversation.blocked
      ? []
      : mergeDirectMessages(messages.value, data.data);
    reconcilePending();
    if (messages.value.length > before) {
      if (bottom) await toBottom();
      else newMessagesBelow.value = true;
    } else if (bottom) void readVisible();
    void counts.refresh();
  } catch {
    /* Keep existing messages on transient polling failure; explicit refresh remains available. */
  } finally {
    polling = false;
  }
}
function openContacts() {
  contactsOpen.value = true;
}
function clearContacts() {
  contactsGeneration++;
  clearTimeout(contactTimer);
  contactQuery.value = "";
  contactResults.value = [];
  searchingContacts.value = false;
}
function scheduleContactSearch() {
  clearTimeout(contactTimer);
  const stamp = ++contactsGeneration,
    account = user.user?.id,
    q = contactQuery.value.trim();
  contactResults.value = [];
  if (q.length < 2) {
    searchingContacts.value = false;
    return;
  }
  searchingContacts.value = true;
  contactTimer = setTimeout(async () => {
    try {
      const data = await request.get<{ data: DirectPeer[] }>(
        "/direct-messages/contacts",
        { params: { query: q } },
      );
      if (stamp === contactsGeneration && account === user.user?.id)
        contactResults.value = data.data;
    } catch {
      /* Do not show stale contacts on failure. */
    } finally {
      if (stamp === contactsGeneration) searchingContacts.value = false;
    }
  }, 250);
}
function backToInbox() {
  rememberDraft();
  peerGeneration++;
  threadGeneration++;
  conversation.value = null;
  messages.value = [];
  opening.value = false;
  threadError.value = false;
  void router.push({
    path: "/messages",
    query: box.value === "requests" ? { box: "requests" } : {},
  });
}
function switchBox(value: "inbox" | "requests") {
  box.value = value;
  void router.push({
    path: "/messages",
    query: {
      ...(conversation.value ? { thread: String(conversation.value.id) } : {}),
      ...(value === "requests" ? { box: value } : {}),
    },
  });
  void loadThreads();
}
watch(
  () => [route.query.thread, route.query.user, user.user?.id],
  () => {
    const id =
      typeof route.query.thread === "string" && /^\d+$/.test(route.query.thread)
        ? Number(route.query.thread)
        : 0;
    const peer =
      typeof route.query.user === "string" && /^\d+$/.test(route.query.user)
        ? Number(route.query.user)
        : 0;
    box.value = route.query.box === "requests" ? "requests" : "inbox";
    if (!user.user) return;
    if (Number.isSafeInteger(id) && id > 0) void selectThread(id);
    else if (Number.isSafeInteger(peer) && peer > 0 && peer !== user.user.id)
      void openPeer(peer);
    else {
      threadGeneration++;
      conversation.value = null;
      messages.value = [];
      opening.value = false;
    }
    void loadThreads();
  },
  { immediate: true },
);
watch(
  () => user.user?.id,
  () => {
    accountGeneration++;
    threadGeneration++;
    listGeneration++;
    contactsGeneration++;
    drafts.clear();
    pending.clear();
    conversation.value = null;
    messages.value = [];
    threads.value = [];
    draft.value = "";
    contactsOpen.value = false;
    clearContacts();
  },
  { flush: "sync" },
);
onMounted(() => {
  document.addEventListener("visibilitychange", poll);
  window.addEventListener("focus", poll);
  refreshTimer = setInterval(poll, 5000);
});
onUnmounted(() => {
  accountGeneration++;
  threadGeneration++;
  listGeneration++;
  contactsGeneration++;
  drafts.clear();
  pending.clear();
  clearInterval(refreshTimer);
  clearTimeout(contactTimer);
  document.removeEventListener("visibilitychange", poll);
  window.removeEventListener("focus", poll);
});
</script>

<style scoped lang="scss">
.messages-page {
  display: flex;
  height: 100%;
  min-height: 0;
  max-width: 1280px;
  margin: auto;
  background: #fff;
  border-left: 1px solid #e8edf3;
  border-right: 1px solid #e8edf3;
  color: #223044;
}
.inbox-pane {
  width: 350px;
  flex-shrink: 0;
  border-right: 1px solid #e8edf3;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.inbox-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 26px 24px 20px;
}
.inbox-heading h1 {
  font-size: 27px;
  letter-spacing: -1px;
}
.inbox-tabs {
  display: flex;
  padding: 0 18px;
  border-bottom: 1px solid #edf0f4;
  gap: 18px;
}
.inbox-tabs button {
  background: none;
  border: 0;
  padding: 13px 8px;
  color: #8591a2;
  font-size: 14px;
  font-weight: 600;
  border-bottom: 3px solid transparent;
  cursor: pointer;
}
.inbox-tabs button.active {
  color: #317ac1;
  border-bottom-color: #468fd2;
}
.inbox-tabs span {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 9px;
  background: #eaf3fc;
  margin-left: 6px;
}
.inbox-tools {
  padding: 14px 20px 8px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  font-size: 11px;
  color: #8a96a6;
}
.inbox-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.thread-item {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 18px 20px;
  color: inherit;
  text-decoration: none;
  border-left: 3px solid transparent;
}
.thread-item:hover {
  background: #f8fafc;
}
.thread-item.selected {
  background: #eef5fc;
  border-left-color: #4a8fcf;
}
.thread-item .el-avatar {
  flex-shrink: 0;
}
.thread-copy {
  min-width: 0;
  flex: 1;
}
.thread-copy > div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.thread-copy strong {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.thread-copy time {
  font-size: 10px;
  color: #9aa4b3;
  white-space: nowrap;
}
.thread-copy p {
  font-size: 12px;
  margin-top: 7px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #8491a3;
}
.unread-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4191db;
  flex-shrink: 0;
}
.load-threads {
  width: 100%;
}
.conversation-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  position: relative;
  background: #fcfdff;
}
.conversation-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 40px;
  text-align: center;
}
.conversation-empty h2 {
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.7px;
  margin: 22px 0 12px;
}
.conversation-empty p {
  max-width: 340px;
  color: #8b98aa;
  line-height: 1.8;
  font-size: 13px;
  margin-bottom: 26px;
}
.empty-symbol {
  background: #edf4fc;
  color: #73a1d0;
  border-radius: 26px;
  width: 88px;
  height: 88px;
  display: grid;
  place-items: center;
  font-size: 38px;
}
.list-empty {
  padding: 64px 24px;
  text-align: center;
  color: #9aa6b6;
}
.list-empty > .el-icon {
  font-size: 38px;
}
.list-empty h3 {
  font-size: 15px;
  color: #5d7087;
  margin: 18px 0 10px;
}
.list-empty p {
  font-size: 12px;
  line-height: 1.8;
  margin-bottom: 20px;
}
.conversation-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  border-bottom: 1px solid #e9eef5;
  padding: 18px 26px;
  background: #fff;
}
.peer-heading {
  display: flex;
  align-items: center;
  gap: 11px;
  color: inherit;
  text-decoration: none;
  flex: 1;
  min-width: 0;
}
.peer-heading strong {
  display: block;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.peer-heading small {
  display: block;
  color: #95a1b0;
  font-size: 10px;
  margin-top: 4px;
}
.back-to-inbox {
  display: none;
}
.relationship-note {
  padding: 14px 24px;
  border-bottom: 1px solid #e6edf5;
  background: #f2f7fc;
  color: #7187a1;
  font-size: 12px;
  line-height: 1.8;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.request-actions {
  display: flex;
  flex-shrink: 0;
}
.blocked-note {
  background: #faf1f1;
  color: #9b7070;
}
.message-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 26px 30px;
  overscroll-behavior: contain;
}
.direct-message {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  margin: 0 0 22px;
}
.message-bubble {
  max-width: min(82%, 580px);
  background: #fff;
  border: 1px solid #e5ebf2;
  box-shadow: 0 2px 7px #dae1ea18;
  padding: 12px 16px;
  border-radius: 17px 17px 17px 5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.75;
  color: #35475f;
}
.direct-message time {
  font-size: 10px;
  color: #abb3bf;
  margin: 6px 3px 0;
}
.direct-message.mine {
  align-items: flex-end;
}
.mine .message-bubble {
  background: #eaf3fc;
  border-color: #dfebf8;
  border-radius: 17px 17px 5px 17px;
}
.older-messages {
  display: block;
  margin: 0 auto 22px;
}
.direct-composer {
  margin: 0 24px 22px;
  padding: 14px 15px 12px;
  border: 1px solid #dfe7f0;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 4px 22px #cdd8e42b;
}
.direct-composer :deep(.el-textarea__inner) {
  box-shadow: none;
  padding: 2px 0 8px;
  resize: none;
  color: #3a4e66;
  font-size: 14px;
  line-height: 1.65;
  background: transparent;
}
.direct-composer :deep(.is-disabled .el-textarea__inner) {
  background: transparent;
}
.composer-bottom {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding-top: 8px;
  gap: 8px;
}
.composer-bottom .el-button {
  min-width: 82px;
}
.new-below {
  position: absolute;
  bottom: 174px;
  align-self: center;
  box-shadow: 0 3px 20px #d2deeb80;
}
.send-status {
  font-size: 11px;
  color: #a78056;
  padding: 8px 26px;
  line-height: 1.8;
}
.contact-results {
  min-height: 130px;
  padding-top: 16px;
}
.contact-results > p {
  font-size: 12px;
  color: #9aa4b3;
  line-height: 1.8;
}
.contact-results > button {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 12px;
  padding: 14px 5px;
  background: none;
  border: 0;
  border-bottom: 1px solid #edf0f5;
  color: #3a5069;
  cursor: pointer;
}
.contact-results > button strong {
  flex: 1;
  text-align: left;
  overflow-wrap: anywhere;
}
.contact-results > button:hover {
  background: #f5f8fc;
}
@media (max-width: 900px) {
  .messages-page {
    border: 0;
    max-width: none;
  }
  .inbox-pane {
    width: 100%;
    border: 0;
  }
  .conversation-pane {
    display: none;
  }
  .thread-open .inbox-pane {
    display: none;
  }
  .thread-open .conversation-pane {
    display: flex;
  }
  .inbox-heading {
    padding: 22px 22px 16px;
  }
  .inbox-heading h1 {
    font-size: 26px;
  }
  .conversation-heading {
    padding: 12px 14px;
  }
  .back-to-inbox {
    display: flex;
  }
  .relationship-note {
    padding: 12px 18px;
    flex-wrap: wrap;
    font-size: 12px;
  }
  .request-actions {
    margin-left: auto;
  }
  .message-scroll {
    padding: 20px 16px;
  }
  .message-bubble {
    max-width: 88%;
    font-size: 15px;
  }
  .direct-composer {
    margin: 0 12px 12px;
    padding: 12px 13px 10px;
    border-radius: 18px;
  }
  .direct-composer :deep(.el-textarea__inner) {
    font-size: 16px;
  }
  .conversation-empty {
    padding: 30px;
  }
  .new-below {
    bottom: 162px;
  }
  .thread-item {
    padding: 17px 20px;
  }
}
</style>
