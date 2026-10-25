<template>
  <div class="chat-layout" :class="{ 'assistant-layout': isAssistant }">
    <header class="mobile-chat-header">
      <button class="mobile-icon-button mobile-conversations" @click="mobileSidebar = !mobileSidebar" :aria-expanded="mobileSidebar" aria-label="对话列表"><el-icon><Expand /></el-icon></button>
      <button class="mobile-conversation-title" @click="isAssistant ? showSettings = true : mobileOptions = !mobileOptions" :aria-expanded="mobileOptions" :disabled="!chatStore.currentConversation && !isAssistant" :aria-label="isAssistant ? '模型设置' : '对话选项'">
        <img v-if="selectedPersona === 'kato_megumi_persona'" :src="publicAsset('kato-megumi-avatar.jpg')" alt="" />
        <span><strong>{{ isLegacy ? '旧历史' : hasPersonaActive ? personaDisplayName : activeSpace === 'ROLEPLAY' ? '角色对话' : '普通 AI' }} <el-icon><ArrowDown /></el-icon></strong>
          <small v-if="!isAssistant">{{ isLegacy ? '只读' : '角色扮演' }}</small></span>
      </button>
      <button class="mobile-icon-button" @click="handleNewChat(); mobileSidebar = false" aria-label="新建对话"><el-icon><EditPen /></el-icon></button>
    </header>
    <button v-if="mobileSidebar" class="sidebar-backdrop" aria-label="关闭对话列表" @click="mobileSidebar = false"></button>
    <button v-if="mobileOptions" class="mobile-options-backdrop" aria-label="关闭对话选项" @click="mobileOptions = false"></button>
    <aside class="chat-sidebar" :class="{ 'mobile-open': mobileSidebar }">
      <div class="sidebar-header">
        <div class="conversation-spaces" role="tablist" aria-label="会话类型">
          <button role="tab" :aria-selected="activeSpace === 'ASSISTANT'" :class="{active: activeSpace === 'ASSISTANT'}" @click="switchSpace('ASSISTANT')">普通 AI</button>
          <button role="tab" :aria-selected="activeSpace === 'ROLEPLAY'" :class="{active: activeSpace === 'ROLEPLAY'}" @click="switchSpace('ROLEPLAY')">角色对话</button>
          <button v-if="hasLegacy" role="tab" :aria-selected="activeSpace === 'LEGACY'" :class="{active: activeSpace === 'LEGACY'}" @click="switchSpace('LEGACY')">旧历史</button>
        </div>
        <el-button type="primary" class="btn-new-chat" @click="handleNewChat(); mobileSidebar = false">
          <el-icon><Plus /></el-icon>
          {{ activeSpace === 'ROLEPLAY' ? '新建角色对话' : '新建 AI 对话' }}
        </el-button>
      </div>
      <div class="sidebar-content">
        <div class="conversation-list">
          <div
            v-for="conv in visibleConversations"
            :key="conv.id"
            class="conversation-item"
            :class="{ active: chatStore.currentConversation?.id === conv.id }"
            @click="chatStore.selectConversation(conv); mobileSidebar = false"
          >
            <div class="conversation-icon">
              <el-icon><ChatDotRound /></el-icon>
            </div>
            <div class="conversation-info">
              <div class="conversation-title">{{ conv.title }}</div>
              <div class="conversation-time">{{ conv.personaLabel || (conv.conversationType === 'ASSISTANT' ? 'AI 助手' : '旧历史') }} · {{ formatTime(conv.updatedAt) }}</div>
            </div>
            <el-dropdown trigger="click" @click.stop>
              <el-icon class="conversation-more"><MoreFilled /></el-icon>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="handleRenameConversation(conv)">
                    <el-icon><Edit /></el-icon>
                    重命名
                  </el-dropdown-item>
                  <el-dropdown-item @click="handlePinConversation(conv)">
                    <el-icon><Top /></el-icon>
                    {{ conv.isPinned ? '取消置顶' : '置顶' }}
                  </el-dropdown-item>
                  <el-dropdown-item divided @click="handleDeleteConversation(conv)">
                    <el-icon><Delete /></el-icon>
                    删除
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
          <div v-if="visibleConversations.length === 0" class="sidebar-empty">
            <el-icon :size="40" color="#C9CDD4"><ChatDotRound /></el-icon>
            <p>暂无对话</p>
          </div>
        </div>
      </div>
      <div class="sidebar-footer">
        <el-button class="btn-settings" @click="showSettings = true">
          <el-icon><Setting /></el-icon>
          模型设置
        </el-button>
        <el-button v-if="CONNECTION_SETTINGS_ENABLED" class="mobile-connection-button" text @click="openConnection"><el-icon><Connection /></el-icon>连接设置</el-button>
      </div>
    </aside>
    <main class="chat-main" :class="{ 'persona-theme': hasPersonaActive, 'assistant-main': isAssistant }">
      <header v-if="isAssistant" class="assistant-page-heading"><span>{{ chatStore.currentConversation?.title === 'New Conversation' ? '新对话' : chatStore.currentConversation?.title || 'AI 助手' }}</span><button aria-label="对话设置" @click="showSettings = true"><el-icon><MoreFilled /></el-icon></button></header>
      <div v-if="isAssistant && !chatStore.isLoadingConversation && !chatStore.messages.length" class="assistant-welcome">
        <div class="welcome-copy"><h1>有什么我能帮你的吗？</h1></div>
        <div class="assistant-start">
          <div class="assistant-suggestions"><button @click="suggest('帮我看看论坛最新的7条帖子', true)"><el-icon><ChatLineSquare /></el-icon>逛逛社区<span>↗</span></button><button @click="openCoding"><span class="code-symbol">&lt;/&gt;</span>一起写代码<span>↗</span></button></div>
          <AssistantComposer v-model="inputText" v-model:mode="agentMode" v-model:deep-thinking="deepThinking" v-model:web-search="webSearch"
            :busy="chatStore.isStreaming || uploadingFiles" :coding="codingEnabled" :files="pendingFiles" :library-files="chatFiles" :uploading="uploadingFiles" @upload="uploadFiles" @remove="removePendingFile" @files="openFileLibrary" @enter="handleKeyDown" @send="handleSendMessage" @stop="handleStopGeneration" @settings="showSettings = true" @coding="openCoding" />
        </div>
      </div>
      <div v-else-if="!chatStore.currentConversation" class="chat-empty">
        <div class="empty-icon">
          <el-icon :size="56" color="var(--primary-color)">
            <ChatDotRound />
          </el-icon>
        </div>
        <h2>{{ activeSpace === 'ROLEPLAY' ? '角色对话' : '普通 AI' }}</h2>
        <el-button type="primary" size="large" class="btn-start" @click="handleNewChat(); mobileSidebar = false">
          <el-icon><Plus /></el-icon>
          新建对话
        </el-button>
      </div>
      <div v-else class="chat-content">
        <div v-if="isLegacy" class="identity-notice">旧会话只读</div>
        <div v-if="hasPersonaActive" class="persona-bar">
          <div class="persona-bar-avatar">
            <img v-if="selectedPersona === 'kato_megumi_persona'" :src="publicAsset('kato-megumi-avatar.jpg')" alt="加藤惠" />
            <div v-else class="persona-avatar-placeholder" :class="personaAvatarClass">{{ personaDisplayName[0] }}</div>
          </div>
          <span class="persona-bar-text"><strong>{{ personaDisplayName }}</strong></span>
          <el-tag size="small" type="danger" effect="plain">角色对话</el-tag>
        </div>
        <div v-if="!isAssistant" class="chat-toolbar" :class="{ 'mobile-open': mobileOptions }">
          <div class="mobile-options-heading"><strong>对话选项</strong><button class="mobile-icon-button" @click="mobileOptions = false" aria-label="收起对话选项"><el-icon><Close /></el-icon></button></div>
          <div class="toolbar-left">
            <div class="toolbar-item persona-select">
              <span class="toolbar-label">{{ hasPersonaActive ? '当前角色' : '切换为角色' }}</span>
              <el-select v-model="selectedPersona" size="small" placeholder="选择角色" class="toolbar-select" :disabled="chatStore.isStreaming || isLegacy" :class="{ 'has-persona': hasPersonaActive }">
                <el-option label="无" value="" />
                <el-option label="加藤惠" value="kato_megumi_persona" />
                <el-option label="雪之下雪乃" value="yukinoshita_yukino_persona" />
                <el-option label="自定义角色..." value="custom" />
              </el-select>
            </div>
            <div class="toolbar-item mode-toggle">
              <span class="toolbar-label">工具模式</span>
              <el-radio-group v-model="agentMode" size="small">
                <el-radio-button value="normal">普通</el-radio-button>
                <el-radio-button value="agent">Agent</el-radio-button>
              </el-radio-group>
            </div>
            <div class="toolbar-item kb-select">
              <span class="toolbar-label">知识库</span>
              <el-select v-model="selectedKnowledgeBaseId" aria-label="选择知识库" size="small" placeholder="不使用知识库" class="toolbar-select" clearable
                :loading="knowledgeLoading" :disabled="chatStore.isStreaming" @visible-change="(v: boolean) => v && loadKnowledgeBases()">
                <el-option label="不使用知识库" :value="0" />
                <el-option v-for="kb in knowledgeBases" :key="kb.id" :label="kb.name + (kb.chatReady ? '' : '（暂不可用）')"
                  :value="kb.id" :disabled="!kb.chatReady" :title="kb.chatUnavailableReason || kb.name" />
              </el-select>
            </div>
          </div>
          <div class="toolbar-right">
            <el-button size="small" @click="showSettings = true">
              <el-icon><Setting /></el-icon>
              设置
            </el-button>
          </div>
        </div>
        <div v-if="!isAssistant && (knowledgeError || selectedKnowledgeIssue)" class="knowledge-notice" role="status">
          {{ knowledgeError || selectedKnowledgeIssue }}
          <el-button text type="primary" @click="loadKnowledgeBases">刷新列表</el-button>
        </div>
        <div v-if="selectedPersona === 'custom'" class="custom-persona-inline">
          <el-input v-model="customPersonaName" placeholder="角色名称" size="small" class="custom-name" :disabled="chatStore.messages.length > 0" />
          <el-input v-model="customPersonaPrompt" type="textarea" :rows="2" placeholder="角色设定" size="small" class="custom-prompt" :disabled="chatStore.messages.length > 0" />
        </div>
      <div class="dialogue-surface">
        <div v-if="hasPersonaActive" class="roleplay-wallpaper" aria-hidden="true">
          <img src="@/assets/images/roleplay-megumi-background.jpg" alt="" draggable="false" />
        </div>
      <div class="chat-messages" :class="{'loading-history':loadingHistory}" ref="messagesRef" @click="openForumPost" @scroll.passive="loadEarlierOnScroll">
          <div v-if="Number(route.query.messageId)>0 && Number(route.query.conversationId)===chatStore.currentConversation?.id" class="history-pagination">
            <el-button text size="small" :loading="chatStore.isLoadingConversation" @click="showLatestMessages">回到最新消息</el-button>
          </div>
          <div v-if="chatStore.hasOlderMessages" class="history-pagination">
            <el-button text size="small" :loading="loadingHistory" @click="loadEarlierMessages">{{ historyLoadError ? '加载失败，重试' : '加载更早消息' }}</el-button>
          </div>
          <div
            v-for="(msg, idx) in chatStore.messages"
            :key="msg.id || idx"
            :data-message-id="msg.id"
            class="chat-message"
            :class="msg.role"
          >
            <div v-if="!msg.failure" class="message-avatar">
              <div v-if="msg.role === 'user'" class="avatar-inner user-avatar-bg">
                <el-icon :size="18"><User /></el-icon>
              </div>
              <div v-else class="avatar-inner" :class="hasPersonaActive ? personaAvatarBgClass : 'ai-avatar-bg'">
                <img v-if="hasPersonaActive && selectedPersona === 'kato_megumi_persona'" :src="publicAsset('kato-megumi-avatar.jpg')" class="persona-avatar-img" alt="加藤惠" />
                <span v-else-if="hasPersonaActive" class="persona-avatar-text">{{ personaDisplayName[0] }}</span>
                <el-icon v-else :size="18"><Service /></el-icon>
              </div>
            </div>
            <div class="message-body">
              <div v-if="!msg.failure" class="message-role">{{ msg.role === 'user' ? userDisplayName : messageIdentity(msg) }}</div>
              <MessageAttachments v-if="isAssistant && msg.role==='user' && msg.ragMetadata?.messageAttachments?.length" :conversation-id="msg.conversationId" :files="msg.ragMetadata.messageAttachments" />
              <div v-if="msg.failure" class="generation-failure" role="alert">
                <div class="failure-heading"><strong>{{ failureHeading(msg) }}</strong><span>{{ (msg.failure.elapsedMs / 1000).toFixed(1) }} 秒</span></div>
                <p v-if="failureDescription(msg)">{{ failureDescription(msg) }}</p>
                <div class="failure-actions">
                  <el-button v-if="recoverableFile(msg)" size="small" type="primary" plain :disabled="chatStore.isStreaming" @click="continueAnswer(msg)">继续完成文件</el-button>
                  <el-button v-else-if="msg.failure.retryable" size="small" type="primary" plain :disabled="chatStore.isStreaming" @click="retryFailedAnswer(msg)">重新发送</el-button>
                  <el-button size="small" text :disabled="chatStore.isStreaming" @click="chatStore.dismissFailedAttempt(msg.conversationId)">移除</el-button>
                </div>
              </div>
              <div v-else-if="msg.content || msg.role!=='user'" class="message-bubble" :class="[msg.role, { 'thinking-bubble': msg.pending && !msg.content }]">
                <span v-if="msg.waitingApproval" class="approval-waiting" role="status">等待操作确认</span>
                <span v-else-if="msg.pending && !msg.content" class="typing-indicator" role="status" aria-label="正在思考"><span></span><span></span><span></span></span>
                <template v-else>
                <div v-if="hasToolResults(msg.content)" class="tool-results">
                  <div v-for="(result, idx) in getToolResults(msg.content)" :key="idx" class="tool-result-item">
                    <div class="tool-result-header">
                      <el-icon class="tool-icon"><MagicStick /></el-icon>
                      <span>技能调用结果</span>
                    </div>
                    <div class="tool-result-content" v-html="renderMarkdown(result)"></div>
                  </div>
                  <el-divider />
                </div>
                <div class="message-text" v-html="renderMarkdown(getCleanContent(msg.content))"></div>
                <RagEvidence v-if="msg.role === 'assistant'" :metadata="msg.ragMetadata" />
                <WebSearchSources v-if="isAssistant && msg.role === 'assistant' && !msg.pending" :metadata="msg.ragMetadata?.webSearch" />
                <FileArtifacts v-if="isAssistant" :conversation-id="chatStore.currentConversation!.id" :artifacts="msg.ragMetadata?.fileArtifacts" />
                </template>
              </div>
              <ToolApprovals v-if="isAssistant && msg.waitingApproval" :conversation-id="msg.conversationId"
                :revision="chatStore.approvalRevision" @changed="chatStore.onToolApprovalChanged" />
              <GenerationStatus v-if="msg.role === 'assistant' && !msg.failure && !msg.waitingApproval" :pending="msg.pending" :busy="chatStore.isStreaming"
                :progress="msg.ragMetadata?.performance" :generation="isAssistant ? msg.ragMetadata?.generation : undefined"
                :allow-thinking="isAssistant" @continue="continueAnswer(msg)" />
              <div
                v-if="msg.content && !msg.pending && !msg.localAttempt"
                class="message-actions"
                :class="{ 'is-pinned': clickedMsgId === msg.id }"
                @click.stop="clickedMsgId = clickedMsgId === msg.id ? null : msg.id"
              >
                <span class="actions-trigger">…</span>
                <span class="actions-menu">
                  <el-button link type="primary" size="small" @click.stop="copyMessage(msg.content)">
                    <el-icon><DocumentCopy /></el-icon>
                    复制
                  </el-button>
                  <el-button link type="danger" size="small" @click.stop="handleDeleteMessage(msg)">
                    <el-icon><Delete /></el-icon>
                    删除
                  </el-button>
                </span>
              </div>
            </div>
          </div>
          <div class="scroll-anchor" ref="scrollAnchor"></div>
        </div>
        <div class="chat-input-area">
          <template v-if="isAssistant">
            <AssistantComposer v-model="inputText" v-model:mode="agentMode" v-model:deep-thinking="deepThinking" v-model:web-search="webSearch"
              :busy="chatStore.isStreaming || uploadingFiles" :coding="codingEnabled" :files="pendingFiles" :library-files="chatFiles" :uploading="uploadingFiles" @upload="uploadFiles" @remove="removePendingFile" @files="openFileLibrary" @enter="handleKeyDown" @send="handleSendMessage" @stop="handleStopGeneration" @settings="showSettings = true" @coding="openCoding" />
          </template>
          <div v-else class="chat-input-wrapper">
            <el-input
              v-model="inputText"
              type="textarea"
              :rows="3"
              :placeholder="messagePlaceholder"
              @keydown.enter="handleKeyDown"
              :disabled="chatStore.isStreaming || isLegacy"
              class="chat-textarea"
            />
            <div class="roleplay-composer-bottom">
            <el-button
              v-if="chatStore.isStreaming"
              type="danger"
              circle
              class="btn-stop"
              aria-label="停止生成"
              @click="handleStopGeneration"
            >
              <el-icon><VideoPause /></el-icon>
            </el-button>
            <el-button
              v-else
              type="primary"
              :disabled="!inputText.trim() || isLegacy"
              class="btn-send"
              aria-label="发送消息"
              @pointerdown.prevent
              @click="handleSendMessage"
            >
              <el-icon><Promotion /></el-icon>
            </el-button>
            </div>
          </div>
        </div>
      </div>
      </div>
    </main>
    <CodeWorkspace v-if="isAssistant && chatStore.currentConversation" v-model="showCode" :conversation-id="chatStore.currentConversation.id" :refresh-key="chatStore.isStreaming || uploadingFiles" @changed="refreshFiles" @attach="attachFiles" />
    <el-drawer v-model="showSettings" title="模型设置" size="min(420px, 100vw)" class="settings-drawer">
      <el-form label-position="top">
        <el-form-item label="对话模型">
          <el-select v-model="selectedModelId" aria-label="设置中的对话模型" style="width: 100%" :disabled="chatStore.isStreaming">
            <el-option v-for="model in chatStore.llmConfig.models" :key="model.id" :label="model.label + (model.available ? '' : '（不可用）')"
              :value="model.id" :disabled="!model.available" />
          </el-select>
        </el-form-item>
        <div v-if="isAssistant" class="response-settings">
          <div v-if="isAssistant" class="response-setting-row">
            <label id="thinking-setting-label">深度思考</label>
            <el-switch v-model="deepThinking" aria-label="深度思考" :disabled="chatStore.isStreaming || uploadingFiles" />
          </div>
          <div class="response-setting-row">
            <label id="web-setting-label">联网搜索</label>
            <el-switch v-model="webSearch" aria-label="联网搜索" :disabled="chatStore.isStreaming || uploadingFiles" />
          </div>
        </div>
        <el-form-item v-if="chatStore.currentConversation && !isLegacy" :label="hasPersonaActive ? '同角色跨会话记忆' : '普通 AI 跨会话记忆'">
          <el-switch :model-value="!!chatStore.currentConversation.sharedMemory" :disabled="chatStore.isStreaming" @change="toggleSharedMemory" />
        </el-form-item>
        <div v-if="agentMode === 'agent'" class="skills-section">
          <div class="skills-header">
            <span class="skills-label">工具</span>
            <el-button text type="primary" size="small" @click="toggleAllSkills">
              {{ enabledSkills.length === toolSkills.length ? '全部禁用' : '全部启用' }}
            </el-button>
          </div>
          <div class="skills-grid">
            <el-checkbox-group v-model="enabledSkills">
              <div v-for="skill in toolSkills" :key="skill.name" class="skill-item">
                <el-checkbox :value="skill.name" :label="skill.name" border>
                  <div class="skill-info">
                    <span class="skill-name">{{ skill.description }}</span>
                  </div>
                </el-checkbox>
              </div>
            </el-checkbox-group>
          </div>
        </div>
        <el-alert v-if="!selectedModel?.available" type="warning" :closable="false" title="当前模型不可用" />
      </el-form>
    </el-drawer>
    <el-dialog v-model="showRenameDialog" title="重命名对话" width="min(400px, 95vw)" class="rename-dialog">
      <el-input v-model="renameTitle" placeholder="请输入新标题" size="large" />
      <template #footer>
        <el-button @click="showRenameDialog = false">取消</el-button>
        <el-button type="primary" @click="confirmRename">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { marked } from 'marked';
import { forumPostPath, resolveForumLinks } from '@/utils/forum-links';
import { initialChat, type ChatSpace } from '@/utils/chat-navigation';
import DOMPurify from 'dompurify';
import RagEvidence from '@/components/RagEvidence.vue';
import WebSearchSources from '@/components/WebSearchSources.vue';
import AssistantComposer from '@/components/AssistantComposer.vue';
import CodeWorkspace from '@/components/CodeWorkspace.vue';
import FileArtifacts from '@/components/FileArtifacts.vue';
import MessageAttachments from '@/components/MessageAttachments.vue';
import GenerationStatus from '@/components/GenerationStatus.vue';
import ToolApprovals from '@/components/ToolApprovals.vue';
import { uploadChatFiles, chatFileKey, type ChatFile } from '@/utils/chat-files';
import { recoverChatDraft, sameDraftFiles, sameDraftSession } from '@/utils/chat-draft-recovery';
import { conversationResponseOptions, defaultKatoKnowledgeBaseId } from '@/utils/roleplay-defaults';
import { readFileResume, readRecoverableFileGeneration } from '@/utils/file-resume';
import { publicAsset, CONNECTION_SETTINGS_ENABLED } from '@/utils/api';
import { useChatStore } from '@/stores/chat';
import { useUserStore } from '@/stores/user';
import dayjs from 'dayjs';
import request from '@/utils/request';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';

const chatStore = useChatStore();
const router = useRouter(), route = useRoute();
const mobileSidebar = ref(false);
const mobileOptions = ref(false);
const openConnection = () => { window.dispatchEvent(new Event('chatforum:connection-settings')); mobileSidebar.value = false; };
const userStore = useUserStore();
const chatFiles = ref<ChatFile[]>([]), uploadingFiles = ref(false);
const pendingFiles=computed(()=>chatStore.currentConversation ? chatStore.draftAttachments[chatStore.currentConversation.id]||[] : []);
const ownerId = userStore.user!.id;
chatStore.initializeNavigation(ownerId);
let viewActive = true, initializing = true, restoring = true;
const ownsView = () => viewActive && userStore.user?.id === ownerId && chatStore.navigation.userId === ownerId;
const messagesRef = ref<HTMLElement>();
const scrollAnchor = ref<HTMLElement>();
const loadingHistory=ref(false),historyLoadError=ref(false);
const inputText = ref('');
const messagePlaceholder = '输入消息…';
const showSettings = ref(false);
const showCode = ref(false), draftMode = ref('normal'), draftCoding = ref(false);
const draftDeepThinking = ref(true), draftWebSearch = ref(false);
const showRenameDialog = ref(false);
const renameTitle = ref('');
const renamingConversation = ref<any>(null);
const skills = ref<any[]>([]);
const enabledSkills = ref<string[]>([]);
const knowledgeBases = ref<any[]>([]);
const knowledgeLoading = ref(false), knowledgeError = ref('');
const clickedMsgId = ref<number | null>(null);
const activeSpace = computed({ get: () => chatStore.navigation.space, set: (space: ChatSpace) => chatStore.setSpace(space) });
const hasLegacy = computed(() => chatStore.conversations.some(c => !c.conversationType || c.conversationType === 'LEGACY'));
const isLegacy = computed(() => !!chatStore.currentConversation && (!chatStore.currentConversation.conversationType || chatStore.currentConversation.conversationType === 'LEGACY'));
const isAssistant = computed(() => chatStore.currentConversation ? chatStore.currentConversation.conversationType === 'ASSISTANT' : activeSpace.value === 'ASSISTANT');
const visibleConversations = computed(() => chatStore.conversations.filter(c => (c.conversationType || 'LEGACY') === activeSpace.value));
const switchSpace = async (space: 'ASSISTANT' | 'ROLEPLAY' | 'LEGACY') => {
  saveView();
  activeSpace.value = space;
  const target = chatStore.conversations.find(c => (c.conversationType || 'LEGACY') === space);
  try { if (target) await chatStore.selectConversation(target); else chatStore.clearSelection(); }
  catch (e: any) { ElMessage.error(e.message || '会话加载失败，请重试'); }
};
watch(() => chatStore.currentConversation?.id, (id, previousId) => {
  saveView(previousId);
  showCode.value = false;
  if (chatStore.currentConversation) activeSpace.value = chatStore.currentConversation.conversationType || 'LEGACY';
  inputText.value = id ? chatStore.drafts[id] || '' : '';
}, { flush: 'sync' });
// Drafts are volatile store state, not navigation storage. A returned chat view
// must observe recovery from an older view's still-running durable request.
watch(inputText, value => {
  const id = chatStore.currentConversation?.id;
  if (ownsView() && id) chatStore.drafts[id] = value;
}, { flush: 'sync' });
watch(() => {
  const id = chatStore.currentConversation?.id;
  return id ? chatStore.drafts[id] : undefined;
}, value => {
  if (ownsView() && !inputText.value && value) inputText.value = value;
}, { flush: 'sync' });
const toggleSharedMemory = async (value: boolean | string | number) => {
  if (!chatStore.currentConversation) return;
  try { await chatStore.updateConversation(chatStore.currentConversation.id, { sharedMemory: value === true }); }
  catch (e: any) { ElMessage.error(e.message || '记忆设置保存失败'); }
};
const switchPersona = async (persona: string) => {
  if (chatStore.isStreaming || isLegacy.value) return;
  const identity = { conversationType: persona ? 'ROLEPLAY' : 'ASSISTANT', persona: persona || undefined };
  try {
    const current = chatStore.currentConversation;
    if (current && !chatStore.messages.length) await chatStore.configureIdentity(current.id, identity);
    else {
      const conversation = await chatStore.createConversation(undefined, identity);
      await chatStore.selectConversation(conversation);
      ElMessage.info('已新建对话');
    }
    activeSpace.value = persona ? 'ROLEPLAY' : 'ASSISTANT';
    if (persona === 'kato_megumi_persona' && chatStore.currentConversation) {
      chatStore.saveConversationSettings(chatStore.currentConversation.id, { agentMode: 'agent', knowledgeBaseId: 0, katoDefaultKnowledgePending: true });
      applyKatoKnowledgeDefault();
    }
  } catch (e: any) { ElMessage.error(e.message || '切换失败'); }
};
const messageIdentity = (msg: any) => {
  const key = msg.ragMetadata?.personaKey;
  return key === 'assistant' ? 'AI 助手' : personaMap[key]?.name || (isLegacy.value ? '历史助理' : aiDisplayName.value);
};

// Mode & persona settings, persisted per-conversation via chat store
const agentMode = computed({
  get: () => {
    const cid = chatStore.currentConversation?.id;
    return cid ? chatStore.getConversationSettings(cid).agentMode : draftMode.value;
  },
  set: (val: string) => {
    const cid = chatStore.currentConversation?.id;
    if (cid) chatStore.saveConversationSettings(cid, { agentMode: val });
    else draftMode.value = val;
  },
});

const deepThinking = computed({
  get: () => {
    if (!isAssistant.value) return false;
    const cid = chatStore.currentConversation?.id;
    return cid ? conversationResponseOptions(chatStore.getConversationSettings(cid)).deepThinking : draftDeepThinking.value;
  },
  set: (value: boolean) => {
    if (chatStore.isStreaming || uploadingFiles.value || !isAssistant.value) return;
    const cid = chatStore.currentConversation?.id;
    if (cid) chatStore.saveConversationSettings(cid, { deepThinking: value });
    else draftDeepThinking.value = value;
  },
});
const webSearch = computed({
  get: () => {
    if (!isAssistant.value) return false;
    const cid = chatStore.currentConversation?.id;
    return cid ? conversationResponseOptions(chatStore.getConversationSettings(cid)).webSearch : draftWebSearch.value;
  },
  set: (value: boolean) => {
    if (chatStore.isStreaming || uploadingFiles.value || !isAssistant.value) return;
    const cid = chatStore.currentConversation?.id;
    if (cid) chatStore.saveConversationSettings(cid, { webSearch: value });
    else draftWebSearch.value = value;
  },
});

const selectedPersona = computed({
  get: () => {
    const conv = chatStore.currentConversation;
    return conv?.conversationType === 'ROLEPLAY' ? (conv.personaKey?.startsWith('custom:') ? 'custom' : conv.personaKey || '') : '';
  },
  set: (val: string) => {
    void switchPersona(val);
  },
});

const customPersonaName = computed({
  get: () => {
    const cid = chatStore.currentConversation?.id;
    return cid ? chatStore.getConversationSettings(cid).customPersonaName || chatStore.currentConversation?.personaLabel || '' : '';
  },
  set: (val: string) => {
    const cid = chatStore.currentConversation?.id;
    if (cid) chatStore.saveConversationSettings(cid, { customPersonaName: val });
  },
});

const customPersonaPrompt = computed({
  get: () => {
    const cid = chatStore.currentConversation?.id;
    return cid ? chatStore.getConversationSettings(cid).customPersonaPrompt || chatStore.currentConversation?.customPersonaPrompt || '' : '';
  },
  set: (val: string) => {
    const cid = chatStore.currentConversation?.id;
    if (cid) chatStore.saveConversationSettings(cid, { customPersonaPrompt: val });
  },
});

const selectedKnowledgeBaseId = computed({
  get: () => {
    if (isAssistant.value) return 0;
    const cid = chatStore.currentConversation?.id;
    return cid ? chatStore.getConversationSettings(cid).knowledgeBaseId : 0;
  },
  set: (val: number) => {
    if (isAssistant.value) return;
    const cid = chatStore.currentConversation?.id;
    if (cid) chatStore.saveConversationSettings(cid, { knowledgeBaseId: val || 0, katoDefaultKnowledgePending: false });
  },
});

const selectedModelId = computed({
  get: () => chatStore.selectedModelId(chatStore.currentConversation?.id),
  set: (modelId: string) => {
    if (chatStore.currentConversation) chatStore.saveConversationSettings(chatStore.currentConversation.id, { modelId });
    else chatStore.preferredModelId = modelId;
  },
});
const selectedModel = computed(() => chatStore.llmConfig.models.find(m => m.id === selectedModelId.value));
const katoKnowledgeDefaultPending = computed(() => {
  const conv = chatStore.currentConversation;
  return conv?.conversationType === 'ROLEPLAY' && conv.personaKey === 'kato_megumi_persona' &&
    !!chatStore.getConversationSettings(conv.id).katoDefaultKnowledgePending;
});
const selectedKnowledgeIssue = computed(() => {
  if (knowledgeLoading.value) return '';
  if (katoKnowledgeDefaultPending.value) return '默认原作知识库暂不可用，请重新选择。';
  if (!selectedKnowledgeBaseId.value) return '';
  const kb = knowledgeBases.value.find(k => k.id === selectedKnowledgeBaseId.value);
  return !kb ? '所选知识库不可访问，请重新选择。' : !kb.chatReady ? kb.chatUnavailableReason : '';
});

const toolSkills = computed(() => {
  return skills.value.filter(s => s.category !== '角色扮演' && s.name !== 'code_workspace' && s.name !== 'web_search');
});
const codingEnabled = computed({
  get: () => chatStore.currentConversation ? !!chatStore.getConversationSettings(chatStore.currentConversation.id).codingEnabled : draftCoding.value,
  set: (value: boolean) => { if (chatStore.currentConversation) chatStore.saveConversationSettings(chatStore.currentConversation.id, { codingEnabled: value }); else draftCoding.value = value; },
});
let creatingAssistant: Promise<void> | undefined;
async function ensureAssistantConversation() {
  if (creatingAssistant) return creatingAssistant;
  if (chatStore.currentConversation) return;
  creatingAssistant = createAssistant();
  try { await creatingAssistant; } finally { creatingAssistant = undefined; }
}
async function createAssistant() {
  const mode = draftMode.value, coding = draftCoding.value, draft = inputText.value;
  const options = { deepThinking: draftDeepThinking.value, webSearch: draftWebSearch.value };
  const conversation = await chatStore.createConversation(undefined, { conversationType: 'ASSISTANT' });
  if (!ownsView() || !isAssistant.value || chatStore.currentConversation) throw new Error('已切换页面，请在当前会话重试');
  chatStore.saveConversationSettings(conversation.id, { agentMode: mode, knowledgeBaseId: 0, codingEnabled: coding, ...options });
  await chatStore.selectConversation(conversation);
  if (!ownsView() || chatStore.navigation.conversationId !== conversation.id) throw new Error('已切换会话，请重试');
  inputText.value = draft;
}
let openingCode = false;
async function openCoding() {
  if (openingCode || uploadingFiles.value || chatStore.isStreaming || !isAssistant.value) return;
  openingCode = true;
  try { await ensureAssistantConversation(); agentMode.value = 'agent'; codingEnabled.value = true; showCode.value = true; }
  catch (e: any) { ElMessage.error(e.message || '工作区打开失败'); }
  finally { openingCode = false; }
}
async function openFileLibrary() {
  if(openingCode || uploadingFiles.value || !isAssistant.value)return;
  openingCode=true;
  try{await ensureAssistantConversation();if(ownsView()&&isAssistant.value)showCode.value=true;}
  catch(e:any){ElMessage.error(e.message||'文件列表打开失败');}finally{openingCode=false;}
}
function attachFiles(files:ChatFile[]) {
  const cid=chatStore.currentConversation?.id;
  if(!cid||!ownsView()||!isAssistant.value)return;
  chatStore.draftAttachments[cid]=[...new Map([...pendingFiles.value,...files].map(f=>[chatFileKey(f),f])).values()];
  codingEnabled.value=true;
}
function removePendingFile(file:ChatFile) {
  const cid=chatStore.currentConversation?.id;if(!cid||chatStore.isStreaming)return;
  chatStore.draftAttachments[cid]=pendingFiles.value.filter(f=>chatFileKey(f)!==chatFileKey(file));
}
let fileEpoch = 0;
async function refreshFiles() {
  const cid = chatStore.currentConversation?.id, epoch = ++fileEpoch;
  chatFiles.value = [];
  if (!cid || !isAssistant.value || !ownsView()) return;
  try { const value = await request.get<{files:ChatFile[]}>('/coding/'+cid);
    if (epoch === fileEpoch && ownsView() && cid === chatStore.currentConversation?.id && isAssistant.value) {
      chatFiles.value = value.files || [];
      chatStore.draftAttachments[cid]=pendingFiles.value.filter(f=>chatFiles.value.some(saved=>chatFileKey(saved)===chatFileKey(f)));
    }
  } catch { /* The drawer provides a visible retry; never reuse another conversation's files. */ }
}
async function uploadFiles(files:File[]) {
  if (uploadingFiles.value || chatStore.isStreaming || !isAssistant.value) return;
  uploadingFiles.value = true;
  try {
    await ensureAssistantConversation();
    const cid = chatStore.currentConversation!.id;
    if (!ownsView() || cid !== chatStore.currentConversation?.id || !isAssistant.value) return;
    await uploadChatFiles(cid, files, saved=>{if(ownsView()&&cid===chatStore.currentConversation?.id)attachFiles(saved);});
    if (!ownsView() || cid !== chatStore.currentConversation?.id) return;
    codingEnabled.value = true;
    await refreshFiles(); ElMessage.success('已上传');
  } catch(e:any) { ElMessage.error(e.message || '上传失败，请检查文件格式'); }
  finally { uploadingFiles.value = false; await refreshFiles(); }
}
watch(() => [chatStore.currentConversation?.id, chatStore.isStreaming, userStore.user?.id], () => { if (!chatStore.isStreaming) void refreshFiles(); }, {immediate:true});
function suggest(text: string, useAgent: boolean) { inputText.value = text; agentMode.value = useAgent ? 'agent' : 'normal'; }

const personaMap: Record<string, { name: string; color: string }> = {
  kato_megumi_persona: { name: '加藤惠', color: '#E8A0BF' },
  yukinoshita_yukino_persona: { name: '雪之下雪乃', color: '#7B9EC7' },
};

const hasPersonaActive = computed(() => {
  return !!selectedPersona.value;
});

const personaDisplayName = computed(() => {
  if (selectedPersona.value === 'custom') return customPersonaName.value || '自定义角色';
  return personaMap[selectedPersona.value]?.name || '';
});

const personaAvatarClass = computed(() => {
  if (selectedPersona.value === 'kato_megumi_persona') return 'persona-avatar-megumi';
  if (selectedPersona.value === 'yukinoshita_yukino_persona') return 'persona-avatar-yukino';
  return 'persona-avatar-custom';
});

const personaAvatarBgClass = computed(() => {
  if (selectedPersona.value === 'kato_megumi_persona') return 'persona-avatar-bg persona-avatar-megumi';
  if (selectedPersona.value === 'yukinoshita_yukino_persona') return 'persona-avatar-bg persona-avatar-yukino';
  return 'persona-avatar-bg persona-avatar-custom';
});

const userDisplayName = computed(() => {
  return userStore.user?.username || '你';
});

const aiDisplayName = computed(() => {
  if (hasPersonaActive.value) return personaDisplayName.value;
  return 'AI 助手';
});

const scrollToBottom = () => {
  nextTick(() => {
    if (ownsView()) messagesRef.value?.scrollTo({ top: messagesRef.value.scrollHeight, behavior: 'smooth' });
  });
};

const loadEarlierMessages=async()=>{
  const container=messagesRef.value,cid=chatStore.currentConversation?.id;
  if(!ownsView()||!container||!cid||loadingHistory.value||!chatStore.hasOlderMessages)return;
  const height=container.scrollHeight,top=container.scrollTop;loadingHistory.value=true;historyLoadError.value=false;
  try{
    await chatStore.loadOlderMessages();await nextTick();
    if(ownsView()&&cid===chatStore.currentConversation?.id)container.scrollTop=top+container.scrollHeight-height;
  }catch{if(ownsView()&&cid===chatStore.currentConversation?.id)historyLoadError.value=true;}finally{loadingHistory.value=false;}
};
const loadEarlierOnScroll=()=>{
  if(!initializing&&!restoring&&messagesRef.value&&messagesRef.value.scrollTop<48&&!historyLoadError.value)void loadEarlierMessages();
};
const focusSourceMessage=async(messageId:number)=>{
  if(!ownsView()||!Number.isSafeInteger(messageId)||messageId<1)return;
  if(!await chatStore.loadAroundMessage(messageId))return;
  await nextTick();
  const container=messagesRef.value,target=container?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  if(container&&target)container.scrollTo({top:container.scrollTop+target.getBoundingClientRect().top-
    container.getBoundingClientRect().top-(container.clientHeight-target.clientHeight)/2,behavior:'instant'});
};
const showLatestMessages=async()=>{
  const conversation=chatStore.currentConversation;
  if(!ownsView()||!conversation||chatStore.isLoadingConversation)return;
  try{
    await chatStore.selectConversation(conversation);await nextTick();
    if(ownsView()&&chatStore.currentConversation?.id===conversation.id){
      await router.replace({path:'/chat',query:{...route.query,messageId:undefined}});
      messagesRef.value?.scrollTo({top:messagesRef.value.scrollHeight,behavior:'instant'});
    }
  }catch{if(ownsView())ElMessage.error('最新消息读取失败，请重试');}
};

// Restore navigation, not a new chat identity. Only IDs/positions go into tab-scoped storage.
function saveView(id = chatStore.currentConversation?.id) {
  if (!ownsView() || initializing || restoring || !id || !messagesRef.value || !chatStore.conversations.some(c => c.id === id)) return;
  chatStore.saveView(id, messagesRef.value.scrollTop, inputText.value);
}
async function restoreView() {
  const id = chatStore.currentConversation?.id;
  await nextTick();
  if (!ownsView() || id !== chatStore.currentConversation?.id || chatStore.isLoadingConversation) return;
  const container = messagesRef.value;
  if (container) container.scrollTo({ top: (id ? chatStore.navigation.scroll[id] : undefined) ?? container.scrollHeight, behavior: 'instant' });
  restoring = false;
}
watch(() => chatStore.isLoadingConversation, loading => {
  if (loading) { saveView(); restoring = true; }
  else if (!initializing) void restoreView();
}, { flush: 'sync' });

function openForumPost(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-forum-post-path]') : null;
  if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const path = forumPostPath(link.dataset.forumPostPath || '');
  if (!path || link.href !== new URL(router.resolve(path).href, location.href).href) return;
  event.preventDefault();
  saveView();
  void router.push(path);
}
const onPageHide = () => saveView();
onBeforeRouteLeave(() => { saveView(); });
onBeforeUnmount(() => { saveView(); viewActive = false; window.removeEventListener('pagehide', onPageHide); });

const renderMarkdown = (content: string) => {
  const safe = DOMPurify.sanitize(marked.parse(content, { async: false }) as string, { FORBID_TAGS: ['img', 'form', 'input'], FORBID_ATTR: ['style'] });
  return resolveForumLinks(safe, path => router.resolve(path).href);
};

const formatTime = (time: string) => {
  const now = dayjs();
  const date = dayjs(time);
  if (now.isSame(date, 'day')) {
    return date.format('HH:mm');
  } else if (now.subtract(1, 'day').isSame(date, 'day')) {
    return '昨天 ' + date.format('HH:mm');
  } else {
    return date.format('MM-DD HH:mm');
  }
};

const copyMessage = (content: string) => {
  navigator.clipboard.writeText(content).then(() => {
    ElMessage.success('已复制');
  });
};

const handleDeleteMessage = async (msg: any) => {
  try {
    await ElMessageBox.confirm('确定要删除这条消息吗？', '删除消息', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  // Temp messages (string ID from Date.now()) just remove locally
  if (typeof msg.id === 'string') {
    chatStore.messages = chatStore.messages.filter((m) => m.id !== msg.id);
  } else {
    try {
      await chatStore.deleteMessage(msg.id);
    } catch (e: any) {
      ElMessage.error(e.message || '删除失败');
    }
  }
};

const handleStopGeneration = () => {
  chatStore.stopGeneration();
};

// Parse tool results from message content
const TOOL_RESULT_MARKER = '\n\n---SKILL_RESULT_START---\n\n';

const hasToolResults = (content: string): boolean => {
  return content.includes(TOOL_RESULT_MARKER);
};

const getToolResults = (content: string): string[] => {
  const parts = content.split(TOOL_RESULT_MARKER);
  const results: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const endIdx = parts[i].indexOf('\n\n---SKILL_RESULT_END---\n\n');
    if (endIdx !== -1) {
      results.push(parts[i].substring(0, endIdx));
    } else {
      results.push(parts[i].replace(/\n\n$/, ''));
    }
  }
  return results;
};

const getCleanContent = (content: string): string => {
  // Remove tool result sections
  let clean = content;
  const marker = TOOL_RESULT_MARKER;
  let idx;
  while ((idx = clean.indexOf(marker)) !== -1) {
    const endMarker = '\n\n---SKILL_RESULT_END---\n\n';
    const endIdx = clean.indexOf(endMarker, idx);
    if (endIdx !== -1) {
      clean = clean.substring(0, idx) + clean.substring(endIdx + endMarker.length);
    } else {
      clean = clean.substring(0, idx);
    }
  }
  return clean.trim();
};

const handleNewChat = async () => {
  const role = activeSpace.value === 'ROLEPLAY' ? selectedPersona.value || 'kato_megumi_persona' : undefined;
  const conv = await chatStore.createConversation(undefined, { conversationType: role ? 'ROLEPLAY' : 'ASSISTANT', persona: role,
    ...(role === 'custom' ? { personaLabel: customPersonaName.value, customPersonaPrompt: buildCustomSystemPrompt() } : {}) });
  await chatStore.selectConversation(conv);
  inputText.value = '';
  scrollToBottom();
};

const sendingLocks = new Set<number | 'new'>();
const currentSendLocked = () => sendingLocks.has(chatStore.currentConversation?.id ?? 'new');
const recoverableFile = (message: any) => isAssistant.value && readRecoverableFileGeneration(message.ragMetadata?.generation);
const failureHeading = (message: any) => recoverableFile(message) ? '文件尚未完成' : message.failure.cancelled ? '已停止生成' : '回答未生成';
const failureDescription = (message: any) => recoverableFile(message) ? '文件草稿已保存，可以继续完成。' : message.failure.message === '已停止生成' ? '' : message.failure.message;
const retryFailedAnswer = async (message: any) => {
  if (currentSendLocked() || chatStore.isStreaming || uploadingFiles.value || message.conversationId !== chatStore.currentConversation?.id) return;
  if (recoverableFile(message)) { await continueAnswer(message); return; }
  const attempt = chatStore.failedAttempts[message.conversationId];
  if (!attempt?.question || attempt.reply.id !== message.id || !attempt.reply.failure?.retryable) return;
  const text = attempt.question.content, files: ChatFile[] = attempt.question.ragMetadata?.messageAttachments || [];
  if (inputText.value && inputText.value.trim() !== text || pendingFiles.value.length && !sameDraftFiles(pendingFiles.value, files)) {
    ElMessage.info('请先发送或清空当前草稿，再重新发送'); return;
  }
  inputText.value = text;
  chatStore.draftAttachments[message.conversationId] = files.map(file => ({ ...file }));
  const resumeFile = readFileResume(attempt.question.ragMetadata?.resumeFile);
  if (attempt.question.ragMetadata?.resumeFile && !resumeFile) { ElMessage.info('文件草稿信息无效，请刷新对话后重试'); return; }
  await handleSendMessage(resumeFile);
};
const continueAnswer = async (message: any) => {
  if (currentSendLocked() || uploadingFiles.value) return;
  const generation = message.ragMetadata?.generation;
  const resumeFile = generation?.fileIncomplete ? readFileResume(generation.resumeFile) : undefined;
  const failed = chatStore.failedAttempts[message.conversationId];
  const restoredFailureDraft = resumeFile && message.failure && failed?.reply.id === message.id &&
    (!inputText.value.trim() || inputText.value.trim() === failed.question?.content.trim()) &&
    sameDraftFiles(pendingFiles.value, failed.question?.ragMetadata?.messageAttachments || []);
  if (chatStore.isStreaming || !isAssistant.value || (inputText.value.trim() || pendingFiles.value.length) && !restoredFailureDraft) {
    if (!chatStore.isStreaming) ElMessage.info('请先发送或清空当前草稿，再继续生成');
    return;
  }
  if (!generation?.truncated || !generation?.canContinue) return;
  if (message.conversationId !== chatStore.currentConversation?.id) return;
  const answers = chatStore.messages.filter(m => m.role === 'assistant');
  if (!resumeFile && answers[answers.length - 1]?.id !== message.id) {
    ElMessage.info('请在输入框说明要续写哪条回答'); return;
  }
  if (restoredFailureDraft) chatStore.draftAttachments[message.conversationId] = [];
  inputText.value = resumeFile ? '继续完成文件' : generation.fileIncomplete
    ? '请根据原需求，重新生成一个完整、精简的可下载文件。'
    : '请继续上一条回答，从中断处接着写，不要重复已经输出的内容。';
  await handleSendMessage(resumeFile);
};
const handleSendMessage = async (resumeInput?: unknown) => {
  let resumeFile = readFileResume(resumeInput);
  if (currentSendLocked() || uploadingFiles.value || chatStore.isStreaming || isLegacy.value) return;
  const text = inputText.value.trim();
  // A restored resume action keeps its pointer when sent again from the composer.
  const priorAttempt = chatStore.currentConversation && chatStore.failedAttempts[chatStore.currentConversation.id];
  if (!resumeFile && !pendingFiles.value.length && text === priorAttempt?.question?.content)
    resumeFile = readFileResume(priorAttempt?.question?.ragMetadata?.resumeFile);
  if (!text && !pendingFiles.value.length) return;
  if (!selectedModel.value?.available) { ElMessage.warning('请选择可用模型'); return; }
  if (katoKnowledgeDefaultPending.value) {
    ElMessage.warning(knowledgeError.value || (knowledgeLoading.value ? '正在加载原作知识库，请稍后发送。' : selectedKnowledgeIssue.value)); return;
  }
  if (selectedKnowledgeBaseId.value && (knowledgeError.value || selectedKnowledgeIssue.value)) {
    ElMessage.warning(knowledgeError.value || selectedKnowledgeIssue.value); return;
  }

  const sendingSession = userStore.getAuthSession();
  const ownsSendingSession = () => sameDraftSession(sendingSession, userStore.getAuthSession(), chatStore.navigation.userId);
  let sendingLockKey: number | 'new' = chatStore.currentConversation?.id ?? 'new';
  sendingLocks.add(sendingLockKey);
  try {
    if (!chatStore.currentConversation && isAssistant.value) await ensureAssistantConversation();
    if (!ownsSendingSession() || !ownsView()) throw new Error('登录状态或页面已切换，请重新发送');
    if (sendingLockKey === 'new' && chatStore.currentConversation) {
      sendingLocks.delete(sendingLockKey); sendingLockKey = chatStore.currentConversation.id; sendingLocks.add(sendingLockKey);
    }
  }
  catch (e: any) { sendingLocks.delete(sendingLockKey); if (ownsSendingSession() && ownsView()) ElMessage.error(e.message || '创建会话失败'); return; }
  inputText.value = '';
  const sendingConversationId = chatStore.currentConversation?.id;
  const sendingFiles=isAssistant.value?[...pendingFiles.value]:[];
  const restoreDraft=()=>{
    if(!sendingConversationId)return;
    const recovered = recoverChatDraft({ expectedSession: sendingSession, currentSession: userStore.getAuthSession(),
      navigationUserId: chatStore.navigation.userId,
      conversationExists: chatStore.conversations.some(c => c.id === sendingConversationId && c.userId === sendingSession.userId),
      current: { text: chatStore.drafts[sendingConversationId] || '', files: chatStore.draftAttachments[sendingConversationId] || [] },
      failed: { text, files: sendingFiles } });
    if (!recovered) return;
    chatStore.drafts[sendingConversationId]=recovered.text;
    chatStore.draftAttachments[sendingConversationId]=recovered.files;
    if(ownsView()&&sendingConversationId===chatStore.currentConversation?.id&&!inputText.value)inputText.value=recovered.text;
  };
  try {
    const persona = hasPersonaActive.value ? selectedPersona.value : undefined;
    const systemPrompt = selectedPersona.value === 'custom' ?
      (chatStore.messages.length ? chatStore.currentConversation?.customPersonaPrompt || buildCustomSystemPrompt() : buildCustomSystemPrompt()) : undefined;
    if (selectedPersona.value === 'custom' && !chatStore.messages.length && chatStore.currentConversation)
      await chatStore.configureIdentity(chatStore.currentConversation.id, { conversationType: 'ROLEPLAY', persona: 'custom',
        personaLabel: customPersonaName.value, customPersonaPrompt: systemPrompt });
    if (chatStore.currentConversation?.id !== sendingConversationId) throw new Error('会话已切换，请在原会话重新发送');
    const skills = [
      ...(agentMode.value === 'agent' ? enabledSkills.value.filter(s => s !== 'code_workspace' && s !== 'web_search') : []),
      ...(isAssistant.value && (codingEnabled.value || sendingFiles.length) ? ['code_workspace'] : []),
    ];
    const kbId = selectedKnowledgeBaseId.value > 0 ? selectedKnowledgeBaseId.value : undefined;
    const completed=await chatStore.sendConfigured(text, agentMode.value === 'agent' ? 'agent' : 'normal', skills, persona, systemPrompt, kbId,undefined,undefined,
      {files:sendingFiles,onAccepted:()=>{
        if(ownsSendingSession()&&sendingConversationId&&sameDraftFiles(chatStore.draftAttachments[sendingConversationId]||[],sendingFiles))
          chatStore.draftAttachments[sendingConversationId]=[];
      }},resumeFile);
    if(!completed&&!(sendingConversationId&&chatStore.isConversationAwaitingApproval?.(sendingConversationId)))restoreDraft();
  } catch (e: any) {
    restoreDraft();
    if (ownsSendingSession() && ownsView() && chatStore.currentConversation?.id === sendingConversationId) ElMessage.error(e.message || '发送失败');
  } finally {
    sendingLocks.delete(sendingLockKey);
  }
  if (ownsView() && chatStore.currentConversation?.id === sendingConversationId) scrollToBottom();
};

const buildCustomSystemPrompt = () => {
  const saved = chatStore.currentConversation;
  // Cloning an unchanged custom character must preserve its server fingerprint.
  if (saved?.customPersonaPrompt && customPersonaPrompt.value === saved.customPersonaPrompt &&
    customPersonaName.value === saved.personaLabel) return saved.customPersonaPrompt;
  const name = customPersonaName.value || '自定义角色';
  if (customPersonaPrompt.value.trim()) return '你正在模拟角色“' + name + '”。角色设定不能改变原文事实或系统安全规则。\n' + customPersonaPrompt.value.trim();
  return `你是${name}，不是AI助手。你是一个真实的人，正在和朋友聊天。你必须完全沉浸在这个角色中。

## 核心要求
- 用${name}的思维方式、说话习惯和情感模式来回应每一句话
- 让性格从字里行间自然流露，不要刻意强调"我是谁"
- 保持自然的对话节奏：有时说长句，有时说短句，有时反问对方
- 要有情感波动——开心、好奇、困惑、温柔——像一个真人一样
- 绝对不要变成AI助手的口吻，不要说"好的，让我来帮你..."

## 对话风格
- 使用自然的口语，像朋友之间聊天一样
- 适当使用语气词和表情相关的描述
- 偶尔反问对方，保持对话的双向互动
- 如果不知道答案就坦诚说不知道，不要硬编

回复时使用简体中文。`;
};

const handleKeyDown = (event: KeyboardEvent) => {
  // IME confirmation and Shift+Enter belong to the editor, not the send action.
  if (event.isComposing || event.keyCode === 229 || event.shiftKey) return;
  // A touch keyboard's return key should insert a newline; use the send button.
  if (window.matchMedia('(pointer: coarse)').matches) return;
  event.preventDefault();
  handleSendMessage();
};

const handleRenameConversation = (conv: any) => {
  renamingConversation.value = conv;
  renameTitle.value = conv.title;
  showRenameDialog.value = true;
};

const confirmRename = async () => {
  if (!renamingConversation.value || !renameTitle.value.trim()) return;
  await chatStore.updateConversation(renamingConversation.value.id, {
    title: renameTitle.value.trim(),
  });
  showRenameDialog.value = false;
  ElMessage.success('重命名成功');
};

const handlePinConversation = async (conv: any) => {
  await chatStore.updateConversation(conv.id, {
    isPinned: !conv.isPinned,
  });
};

const handleDeleteConversation = async (conv: any) => {
  try {
    await ElMessageBox.confirm('确定要删除这个对话吗?', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    });
    await chatStore.deleteConversation(conv.id);
    ElMessage.success('删除成功');
  } catch {
    // User cancelled
  }
};

const loadSkills = async () => {
  try {
    const data = await request.get<any[]>('/chat/skills');
    skills.value = data;
    // Only auto-enable tool skills, not persona skills
    enabledSkills.value = data.filter(s => s.enabled && s.category !== '角色扮演' && s.name !== 'code_workspace' && s.name !== 'web_search').map(s => s.name);
  } catch {
    // Ignore
  }
};

const loadKnowledgeBases = async () => {
  if (knowledgeLoading.value) return;
  knowledgeLoading.value = true; knowledgeError.value = '';
  try {
    const data = await request.get<any[]>('/rag/knowledge-bases');
    if (!ownsView()) return;
    knowledgeBases.value = data || [];
    applyKatoKnowledgeDefault();
  } catch {
    knowledgeError.value = '知识库列表加载失败，请检查连接后重试。';
  } finally { knowledgeLoading.value = false; }
};
function applyKatoKnowledgeDefault() {
  const conv = chatStore.currentConversation;
  if (!ownsView() || !conv || !katoKnowledgeDefaultPending.value) return;
  const id = defaultKatoKnowledgeBaseId(knowledgeBases.value);
  if (id) chatStore.saveConversationSettings(conv.id, { knowledgeBaseId: id, katoDefaultKnowledgePending: false });
}
watch(() => [chatStore.currentConversation?.id, chatStore.currentConversation?.personaKey, knowledgeBases.value], applyKatoKnowledgeDefault, { flush: 'post' });
watch(() => [isAssistant.value, isLegacy.value], ([assistant, legacy]) => {
  if (!assistant && !legacy) void loadKnowledgeBases();
}, { immediate: true });

const toggleAllSkills = () => {
  if (enabledSkills.value.length === toolSkills.value.length) {
    enabledSkills.value = [];
  } else {
    enabledSkills.value = toolSkills.value.map(s => s.name);
  }
};

watch(
  () => chatStore.messages,
  () => {
    const container = messagesRef.value;
    if (ownsView() && !initializing && !restoring && !loadingHistory.value && !chatStore.isLoadingConversation && container &&
      container.scrollHeight - container.scrollTop - container.clientHeight < 100) scrollToBottom();
  },
  { deep: true }
);

onMounted(async () => {
  window.addEventListener('pagehide', onPageHide);
  try {
    await Promise.allSettled([chatStore.loadDefaultConfig(), loadSkills()]);
    if (!ownsView()) return;
    await chatStore.loadConversations();
    if (!ownsView()) return;
    const choice = initialChat(chatStore.conversations, chatStore.navigation);
    const requestedConversation=Number(route.query.conversationId),requestedMessage=Number(route.query.messageId);
    const sourceConversation=chatStore.conversations.find(conversation=>conversation.id===requestedConversation);
    activeSpace.value = sourceConversation?.conversationType || choice.space;
    if(sourceConversation)await chatStore.selectConversation(sourceConversation,{around:requestedMessage>0?requestedMessage:undefined});
    else if (choice.conversation) await chatStore.selectConversation(choice.conversation);
    else chatStore.clearSelection();
    if (!ownsView()) return;
    inputText.value = chatStore.currentConversation ? chatStore.drafts[chatStore.currentConversation.id] || '' : '';
    const requestedKb = Number(route.query.knowledgeBaseId);
    if (requestedKb > 0) {
      if (!isAssistant.value && !isLegacy.value) selectedKnowledgeBaseId.value = requestedKb;
      await router.replace({ path: '/chat', query: {} });
    }
  } catch (e: any) { if (ownsView()) ElMessage.error(e.message || '会话加载失败，请重试'); }
  finally { if (ownsView()) { initializing = false; await restoreView();if(Number(route.query.messageId)>0)await focusSourceMessage(Number(route.query.messageId)); } }
});
</script>

<style lang="scss" scoped>
.history-pagination { display: flex; justify-content: center; padding: 4px 0 16px; }
.chat-messages { overflow-anchor: none; }
.chat-messages.loading-history { scroll-behavior: auto; }
.approval-waiting { color: var(--el-text-color-secondary); font-size: 13px; }
.conversation-spaces { display: flex; gap: 4px; padding: 4px; margin-bottom: 12px; background: #f1f4f8; border-radius: 10px; }
.conversation-spaces button { flex: 1; min-width: 0; padding: 9px 3px; border: 0; border-radius: 7px; background: transparent; color: #677387; font: inherit; font-size: 13px; cursor: pointer; }
.conversation-spaces button.active { background: white; color: #245da8; box-shadow: 0 1px 5px #142c4714; font-weight: 600; }
.assistant-mode-bar { display: flex; align-items: center; gap: 10px; margin: 16px 20px 0; padding: 13px 18px; border: 1px solid #dce9f8; border-radius: 12px; background: #f5f9ff; color: #31577e; }
.assistant-mode-bar span { margin-left: auto; font-size: 12px; color: #71869b; }
.identity-notice { padding: 12px 20px; font-size: 13px; line-height: 1.6; color: #7e6040; background: #fff9ed; }
@media (max-width: 900px) { .assistant-mode-bar { display: none; } .identity-notice { padding: 10px 16px; } }
.knowledge-notice { padding: 8px 20px; color: #7e6040; font-size: 13px; background: #fff9ed; line-height: 1.6; }
.chat-layout {
  display: flex;
  height: 100%;
}

.chat-sidebar {
  width: 280px;
  background: #fff;
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 16px;
}

.btn-new-chat {
  width: 100%;
  border-radius: var(--radius-sm);
  height: 42px;
  font-weight: 500;
  box-shadow: 0 2px 8px rgba(22, 93, 255, 0.2);
  transition: all var(--transition);

  &:hover {
    box-shadow: 0 4px 14px rgba(22, 93, 255, 0.35);
    transform: translateY(-1px);
  }
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
}

.sidebar-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 16px;
  color: var(--text-secondary);

  p {
    margin: 12px 0 4px;
    font-size: 14px;
    color: var(--text-regular);
  }

  span {
    font-size: 12px;
  }
}

.conversation-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.conversation-item {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition);
  position: relative;

  &:hover {
    background: var(--bg-page);

    .conversation-more {
      opacity: 1;
    }
  }

  &.active {
    background: var(--primary-bg);

    .conversation-icon {
      background: var(--primary-color);
      box-shadow: 0 2px 8px rgba(22, 93, 255, 0.3);
    }

    .conversation-title {
      color: var(--primary-color);
      font-weight: 600;
    }
  }
}

.conversation-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: #86909C;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  margin-right: 10px;
  flex-shrink: 0;
  transition: all var(--transition);
}

.conversation-info {
  flex: 1;
  min-width: 0;
}

.conversation-title {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}

.conversation-time {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.conversation-more {
  color: var(--text-secondary);
  padding: 4px;
  opacity: 0;
  transition: all var(--transition);
  border-radius: 4px;

  &:hover {
    background: #E5E6EB;
    color: var(--text-primary);
  }
}

.sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--border-light);
}

.btn-settings {
  width: 100%;
  border-radius: var(--radius-sm);
  color: var(--text-regular);
  transition: all var(--transition);

  &:hover {
    color: var(--primary-color);
    border-color: var(--primary-color);
  }
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
  background: var(--bg-page);
}

.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;

  .empty-icon {
    width: 96px;
    height: 96px;
    border-radius: 50%;
    background: var(--primary-bg);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 20px;
  }

  h2 {
    margin: 0 0 8px;
    font-size: 22px;
    color: var(--text-primary);
    font-weight: 600;
  }

  p {
    color: var(--text-secondary);
    margin: 0 0 28px;
    font-size: 14px;
  }
}

.btn-start {
  border-radius: 24px;
  padding: 12px 32px;
  height: 44px;
  font-weight: 500;
  box-shadow: 0 4px 14px rgba(22, 93, 255, 0.3);
}

.chat-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  max-width: 900px;
  width: 100%;
  margin: 0 auto;
}

.persona-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  margin: 16px 20px 0;
  background: linear-gradient(135deg, #FFF5F9, #FEF0F5);
  border: 1px solid #F2BED1;
  border-radius: var(--radius-md);
}

.persona-bar-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  border: 2px solid #E8A0BF;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.persona-bar-text {
  flex: 1;
  font-size: 13px;
  color: var(--text-regular);
}

/* Chat Toolbar */
.chat-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  margin: 0 20px;
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-right: 6px;
  white-space: nowrap;
  line-height: 1;
  flex-shrink: 0;
}

.toolbar-item {
  display: flex;
  align-items: center;
  gap: 0;
}

.toolbar-select {
  width: 140px;
}

.toolbar-select.has-persona :deep(.el-input__wrapper) {
  border-color: #E8A0BF;
  box-shadow: 0 0 0 2px rgba(232, 160, 191, 0.15);
}

.custom-persona-inline {
  display: flex;
  gap: 8px;
  padding: 8px 20px;
  margin: 0 20px;
  background: #FFFBFC;
  border: 1px dashed #F2BED1;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
  border-top: none;
}

.custom-persona-inline .custom-name {
  width: 140px;
  flex-shrink: 0;
}

.custom-persona-inline .custom-prompt {
  flex: 1;
}

/* Pink theme overrides when persona is active */
.chat-main.persona-theme {
  --primary-color: #E8A0BF;
  --primary-light: #F2BED1;
  --primary-bg: #FFF5F9;
}

.chat-main.persona-theme .btn-start {
  background: linear-gradient(135deg, #E8A0BF, #F2BED1);
  box-shadow: 0 4px 14px rgba(232, 160, 191, 0.35);
}

.chat-main.persona-theme .btn-new-chat {
  background: linear-gradient(135deg, #E8A0BF, #F2BED1);
  border-color: #E8A0BF;
}

.chat-main.persona-theme .btn-send {
  background: linear-gradient(135deg, #E8A0BF, #F2BED1);
  box-shadow: 0 2px 8px rgba(232, 160, 191, 0.35);
}

.chat-main.persona-theme .btn-send:hover:not(:disabled) {
  box-shadow: 0 4px 14px rgba(232, 160, 191, 0.45);
}

.chat-main.persona-theme .chat-input-wrapper:focus-within {
  border-color: #E8A0BF;
  box-shadow: 0 0 0 3px rgba(232, 160, 191, 0.12);
}

.chat-main.persona-theme .conversation-item.active {
  background: #FFF5F9;
}

.chat-main.persona-theme .conversation-item.active .conversation-icon {
  background: linear-gradient(135deg, #E8A0BF, #F2BED1);
}

.chat-main.persona-theme .conversation-item.active .conversation-title {
  color: #E8A0BF;
}

.chat-main.persona-theme .typing-indicator > span {
  background: #E8A0BF;
}

.chat-main.persona-theme .assistant .message-bubble {
  border-left: 3px solid #F2BED1;
  background: rgba(255, 251, 252, .96);
}

.chat-main.persona-theme .user .message-bubble {
  background: linear-gradient(135deg, #f0c3d5, #f5d4df);
  color: #56384a;
}

.chat-main.persona-theme .user .message-bubble :deep(.markdown-body),
.chat-main.persona-theme .user .message-bubble :deep(.markdown-body a) {
  color: #56384a;
}

.chat-main.persona-theme .chat-input-area {
  background: linear-gradient(#fff8f700, #fff8f7d9);
}

.chat-main.persona-theme .user-avatar-bg {
  background: linear-gradient(135deg, #E8A0BF, #F2BED1);
}

/* Additional beautification */
.chat-messages {
  scroll-behavior: smooth;
  padding: 20px 24px;
}

.chat-messages::-webkit-scrollbar {
  width: 5px;
}

.chat-messages::-webkit-scrollbar-track {
  background: transparent;
}

.chat-messages::-webkit-scrollbar-thumb {
  background: #E5E6EB;
  border-radius: 10px;
}

.chat-messages::-webkit-scrollbar-thumb:hover {
  background: #C9CDD4;
}

.btn-send {
  transition: all 0.25s ease;
}

.chat-input-wrapper {
  transition: all 0.25s ease;
  border-radius: 12px;
}

.chat-input-wrapper:focus-within {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px rgba(22, 93, 255, 0.1);
}

.message-bubble {
  transition: all 0.2s ease;
}

.generation-failure { width: min(430px, 100%); box-sizing: border-box; padding: 14px 16px; border: 1px solid #e2c9bd; border-radius: 12px; background: #fffaf6; color: #674b3c; overflow-wrap: anywhere; }
.failure-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; font-size: 14px; }
.failure-heading span { flex: none; font-size: 12px; color: #8c7264; font-variant-numeric: tabular-nums; }
.generation-failure p { margin: 8px 0 12px; font-size: 13px; line-height: 1.65; }
.failure-actions { display: flex; gap: 8px; margin-top: 12px; }
.failure-actions .el-button + .el-button { margin-left: 0; }

.message-bubble:hover {
  transform: translateY(-1px);
}

.conversation-item {
  transition: all 0.2s ease;
  border-radius: 10px;
  margin: 1px 0;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px;
}

.chat-message {
  display: flex;
  gap: 12px;
  margin-bottom: 28px;
  animation: messageIn 0.3s ease-out;

  &.user {
    flex-direction: row-reverse;

    .message-body {
      align-items: flex-end;
    }

    .message-bubble {
      background: linear-gradient(135deg, var(--primary-color), var(--primary-light));
      color: #fff;
      border-radius: 16px 4px 16px 16px;

      :deep(.markdown-body) {
        color: rgba(255, 255, 255, 0.95);
        code {
          background: rgba(255, 255, 255, 0.2);
          color: #fff;
        }
        pre {
          background: rgba(0, 0, 0, 0.3);
        }
        a {
          color: #fff;
        }
      }
    }

    .message-actions {
      justify-content: flex-end;
    }
  }

  &.assistant {
    .message-bubble {
      background: #fff;
      border-radius: 4px 16px 16px 16px;
      box-shadow: var(--shadow-sm);
    }
  }
}

@keyframes messageIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message-avatar {
  flex-shrink: 0;
  padding-top: 4px;
}

.avatar-inner {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.user-avatar-bg {
  background: linear-gradient(135deg, var(--primary-color), var(--primary-light));
}

.ai-avatar-bg {
  background: linear-gradient(135deg, #10B981, #34D399);
}

.persona-avatar-bg {
  background: linear-gradient(135deg, #E8A0BF, #F2BED1);
  overflow: hidden;
  padding: 0;
}

.persona-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.persona-avatar-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  border-radius: 50%;
}

.persona-avatar-text {
  color: #fff;
  font-weight: 600;
  font-size: 14px;
}

.persona-avatar-megumi {
  background: linear-gradient(135deg, #E8A0BF, #F2BED1);
}

.persona-avatar-yukino {
  background: linear-gradient(135deg, #7B9EC7, #A8C5E2);
}

.persona-avatar-custom {
  background: linear-gradient(135deg, #C9B1FF, #E0D4FF);
}

.persona-selector {
  width: 100%;
}

.persona-selector :deep(.el-radio-group) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.custom-persona-section {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.custom-persona-name {
  width: 100%;
}

.custom-persona-prompt {
  width: 100%;
}

.message-body {
  max-width: 75%;
  display: flex;
  flex-direction: column;
}

.message-role {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  padding: 0 4px;
  font-weight: 500;
}

.tool-results {
  margin-bottom: 8px;
}

.tool-result-item {
  margin-bottom: 10px;
  padding: 10px 14px;
  background: linear-gradient(135deg, #f0fdf4, #dcfce7);
  border-radius: var(--radius-sm);
  border-left: 3px solid #10b981;
}

.tool-result-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #059669;
  font-weight: 600;
  margin-bottom: 6px;
}

.tool-icon {
  font-size: 14px;
}

.tool-result-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre-wrap;
}

.user .tool-result-item {
  background: linear-gradient(135deg, rgba(22, 93, 255, 0.08), rgba(22, 93, 255, 0.15));
  border-left-color: var(--primary-color);
}

.user .tool-result-header {
  color: var(--primary-color);
}

.message-bubble {
  padding: 12px 16px;
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
  transition: box-shadow var(--transition);

  &:hover {
    box-shadow: var(--shadow-md);
  }
}

.message-text {
  :deep(.markdown-body) {
    font-size: 14px;
    line-height: 1.7;

    p:first-child { margin-top: 0; }
    p:last-child { margin-bottom: 0; }
    pre { margin: 8px 0; }
    code { font-size: 0.88em; }
  }
}

.thinking-bubble {
  padding: 16px 20px;
  display: flex;
  align-items: center;
}

.typing-indicator {
  display: inline-flex;
  flex: none;
  gap: 8px;
  width: 40px;
  height: 8px;

  > span {
    flex: none;
    width: 8px;
    height: 8px;
    background: var(--primary-color);
    border-radius: 50%;
    animation: typing 1.4s infinite ease-in-out;
  }

  > span:first-child {
    animation-delay: -0.32s;
  }

  > span:last-child {
    animation-delay: 0.32s;
  }
}

@keyframes typing {
  0%, 80%, 100% {
    transform: scale(0.75);
    opacity: 0.4;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}

.message-actions {
  margin-top: 4px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px;
  position: relative;
  cursor: default;

  .actions-trigger {
    display: inline-block;
    font-size: 16px;
    font-weight: 700;
    color: var(--text-secondary, #909399);
    letter-spacing: 2px;
    padding: 0 6px;
    border-radius: 4px;
    transition: background 0.2s;
    user-select: none;
    line-height: 1.3;
    flex-shrink: 0;
  }

  .actions-menu {
    display: none;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }

  :deep(.el-button) {
    font-size: 12px;
  }

  // Hover → menu floats to left of …, … stays fixed
  &:hover .actions-menu {
    display: flex;
  }

  // Clicked/pinned → keep menu visible
  &.is-pinned .actions-menu {
    display: flex;
  }
}

// User (right): reverse flex so … stays at right, menu to its left
.chat-message.user .message-actions {
  justify-content: flex-end;
  flex-direction: row-reverse;
}

// Assistant (left): natural flex order — … then menu
// no override needed

.chat-input-area {
  padding: 16px 20px 20px;
}

.chat-input-wrapper {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: stretch;
  background: #fff;
  border-radius: var(--radius-md);
  padding: 10px 10px 10px 14px;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-color);
  transition: all var(--transition);

  &:focus-within {
    border-color: var(--primary-color);
    box-shadow: 0 0 0 3px rgba(22, 93, 255, 0.1);
  }
}

.response-settings { margin:16px 0 20px;padding:0 12px;border:1px solid #e1e7ef;border-radius:12px;background:#f8fafd; }
.persona-theme :deep(.generation-status) { color:#7d6d77; }
.persona-theme :deep(.process-body) { border-color:#eadde4;background:rgba(255,249,252,.95); }
.persona-theme :deep(.process-title),.persona-theme :deep(.phase-active .phase-label),.persona-theme :deep(.model-active) { color:#91677d; }
.persona-theme :deep(.is-pending .process-indicator) { background:#b77e99; }
.persona-theme :deep(.process-metrics) { border-top-color:#eee2e9; }
.response-setting-row { display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 0; }
.response-setting-row + .response-setting-row { border-top:1px solid #e5eaf1; }
.response-setting-row label { font-size:14px;font-weight:500;color:#2f4058; }
.roleplay-composer-bottom { display:flex;align-items:center;justify-content:flex-end;gap:10px; }
.roleplay-composer-bottom > .btn-send,.roleplay-composer-bottom > .btn-stop { margin-left:auto;flex-shrink:0; }

.chat-textarea {
  flex: 1;

  :deep(.el-textarea__inner) {
    border: none;
    box-shadow: none;
    resize: none;
    padding: 4px 0;
    font-size: 14px;
    line-height: 1.6;
    background: transparent;

    &:focus {
      box-shadow: none;
    }
  }
}

.btn-send {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(22, 93, 255, 0.3);
  transition: all var(--transition);

  :deep(.el-icon) {
    margin: 0;
  }

  &:not(:disabled):hover {
    transform: scale(1.05);
    box-shadow: 0 4px 14px rgba(22, 93, 255, 0.4);
  }
}

.btn-stop {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(245, 63, 63, 0.3);
  animation: pulse-stop 1.5s infinite ease-in-out;

  :deep(.el-icon) {
    margin: 0;
  }

  &:hover {
    transform: scale(1.05);
    box-shadow: 0 4px 14px rgba(245, 63, 63, 0.45);
  }
}

@keyframes pulse-stop {
  0%, 100% { box-shadow: 0 2px 8px rgba(245, 63, 63, 0.3); }
  50% { box-shadow: 0 2px 16px rgba(245, 63, 63, 0.55); }
}

.settings-drawer {
  :deep(.el-drawer__header) {
    margin-bottom: 0;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border-color);
  }

  :deep(.el-drawer__body) {
    padding: 24px;
  }
}

.temp-slider {
  width: 100%;
}

.skills-section {
  margin-bottom: 16px;
}

.skills-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.skills-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.skills-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skill-item {
  :deep(.el-checkbox) {
    width: 100%;
    height: auto;
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    margin: 0;

    .el-checkbox__label {
      width: 100%;
    }
  }

  :deep(.el-checkbox.is-checked) {
    background: var(--primary-bg);
    border-color: var(--primary-color);
  }
}

.skill-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  gap: 8px;
}

.skill-name {
  font-size: 13px;
  color: var(--text-regular);
  flex: 1;
}

.persona-skill {
  :deep(.el-checkbox) {
    border-color: #E8A0BF;
    background: linear-gradient(135deg, #FFF5F9, #FEF0F5);

    &.is-checked {
      background: linear-gradient(135deg, #FEF0F5, #FCE4EC);
      border-color: #E8A0BF;
    }
  }
}

.persona-tag {
  margin-left: 6px;
  font-size: 11px;
}

.mobile-chat-header, .sidebar-backdrop, .mobile-options-backdrop, .mobile-options-heading, .mobile-connection-button { display: none; }
@media (max-width: 900px) {
  .chat-layout { flex-direction: column; position: relative; background: #faf9f7; }
  .mobile-chat-header { display: flex; align-items: center; flex-shrink: 0; gap: 8px; height: 68px; padding: 8px 12px;
    background: #faf9f7; border-bottom: 1px solid #eeece9; }
  .mobile-icon-button { font-family: inherit; display: flex; align-items: center; justify-content: center; width: 42px; height: 42px; flex-shrink: 0;
    border: 0; border-radius: 14px; background: transparent; color: #464347; font-size: 21px; cursor: pointer; }
  .mobile-icon-button:active { background: #eeeae8; }
  .mobile-conversation-title { font-family: inherit; flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; border: 0; background: none; text-align: left; color: #302b30; cursor: pointer; }
  .mobile-conversation-title img { width: 38px; height: 38px; object-fit: cover; border-radius: 50%; border: 2px solid #f1dce5; }
  .mobile-conversation-title > span { min-width: 0; }
  .mobile-conversation-title strong { display: flex; align-items: center; gap: 7px; font-size: 16px; font-weight: 600; }
  .mobile-conversation-title strong .el-icon { font-size: 12px; color: #938b90; }
  .mobile-conversation-title small { display: block; color: #a2959d; font-size: 10px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-sidebar { position: absolute; left: 0; top: 0; bottom: 0; z-index: 30; border: 0; border-radius: 0 22px 22px 0;
    width: min(310px, 86vw); transform: translateX(-110%); transition: transform .2s; background: #fff; box-shadow: 8px 0 30px #302b3010; }
  .chat-sidebar.mobile-open { transform: translateX(0); }
  .sidebar-backdrop, .mobile-options-backdrop { display: block; position: absolute; inset: 0; z-index: 29; border: 0; background: #28212b45; backdrop-filter: blur(3px); }
  .mobile-options-backdrop { z-index: 40; }
  .mobile-connection-button { display: flex; width: 100%; margin: 6px 0 0; }
  .sidebar-header { padding: 22px 16px 14px; }
  .btn-new-chat { background: #f5e9ef; color: #97556f; border: 0; box-shadow: none; border-radius: 14px; }
  .conversation-item { min-height: 58px; }
  .chat-main, .chat-main.persona-theme { min-width: 0; min-height: 0; background: #faf9f7; }
  .chat-content { min-height: 0; }
  .persona-bar { display: none; }
  .chat-toolbar { display: none; position: absolute; z-index: 41; bottom: 12px; left: 12px; right: 12px; margin: 0; padding: 16px 20px 20px;
    gap: 16px; border: 1px solid #eee7eb; border-radius: 24px; box-shadow: 0 12px 48px #342a3926; max-height: calc(100% - 24px); overflow-y: auto; }
  .chat-toolbar.mobile-open { display: flex; }
  .mobile-options-heading { display: flex; align-items: center; justify-content: space-between; width: 100%; font-size: 17px; color: #3b333a; }
  .toolbar-left { display: flex; width: 100%; flex-direction: column; align-items: stretch; gap: 18px; }
  .toolbar-item { display: flex; justify-content: space-between; gap: 12px; }
  .toolbar-label { font-size: 13px; color: #807780; }
  .toolbar-select { width: min(200px, 65%); }
  .toolbar-select :deep(.el-select__wrapper) { min-height: 40px; border-radius: 11px; }
  .mode-toggle :deep(.el-radio-button__inner) { padding: 11px 18px; }
  .toolbar-right { width: 100%; border-top: 1px solid #f0edf0; padding-top: 14px; }
  .toolbar-right .el-button { width: 100%; min-height: 40px; border-radius: 12px; }
  .chat-messages { padding: 24px 20px 8px; scroll-padding-bottom: 16px; }
  .chat-message { margin-bottom: 30px; gap: 0; animation: none; }
  .message-avatar { display: none; }
  .message-body { max-width: 100%; min-width: 0; }
  .message-role { font-size: 11px; color: #a18391; padding: 0; margin-bottom: 8px; }
  .user .message-role { display: none; }
  .user .message-body { max-width: 88%; }
  .chat-message.assistant .message-bubble, .chat-main.persona-theme .assistant .message-bubble {
    padding: 0; border: 0; background: transparent; box-shadow: none; border-radius: 0; }
  .chat-message.user .message-bubble, .chat-main.persona-theme .user .message-bubble {
    padding: 12px 16px; background: #f1e9ed; color: #44363e; border: 0; border-radius: 20px 20px 5px 20px; box-shadow: none; }
  .message-bubble:hover { transform: none; }
  .message-text :deep(.markdown-body) { font-size: 15px; line-height: 1.9; color: #353136; }
  .chat-message.user .message-bubble :deep(.markdown-body) { color: #44363e; }
  .message-actions { margin-top: 8px; }
  .chat-input-area { padding: 10px 14px 12px; flex-shrink: 0; background: linear-gradient(#faf9f700, #faf9f7 20%); }
  .chat-input-area:focus-within { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
  .chat-input-wrapper, .chat-main.persona-theme .chat-input-wrapper { padding: 10px 10px 10px 16px; border-radius: 24px; border: 1px solid #e6e0e4; background: #fff; box-shadow: 0 3px 14px #382d3810; }
  .chat-input-wrapper:focus-within, .chat-main.persona-theme .chat-input-wrapper:focus-within { border-color: #c6a0b2; box-shadow: 0 3px 16px #a2647d12; }
  .chat-textarea { min-width: 0; }
  .chat-textarea :deep(.el-textarea__inner) { height: 52px; min-height: 52px !important; line-height: 1.5; }
  .chat-textarea :deep(.el-textarea__inner::placeholder) { font-size: 14px; color: #aaa0a6; }
  .btn-send, .btn-stop, .chat-main.persona-theme .btn-send { width: 40px; height: 40px; border: 0; border-radius: 50%; background: #a66b83; box-shadow: none; }
  .btn-send:disabled { background: #e9dfe4; color: #fff; }
  .chat-empty { padding: 24px; text-align: center; }
  .chat-empty .empty-icon { background: #f5e9ef; color: #a66b83; width: 72px; height: 72px; }
  .chat-empty h2 { font-size: 25px; font-weight: 500; color: #393239; }
  .chat-empty p { font-size: 13px; line-height: 1.8; }
  .btn-start { background: #a66b83; border: 0; box-shadow: none; }
}

/* One canvas color, with the artwork below the toolbar rather than behind it.
   The full dialogue region includes both the messages and the composer.
   Isolate only the message/composer surface: the mobile options sheet remains
   outside this stacking context and above its sibling backdrop. */
.chat-main.persona-theme {
  background: #fff8f7;
}

.dialogue-surface {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.chat-main.persona-theme .dialogue-surface {
  isolation: isolate;
}

.roleplay-wallpaper {
  position: absolute;
  z-index: -1;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: .2;
  pointer-events: none;
  user-select: none;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 20px, #000 calc(100% - 20px), transparent);
  mask-image: linear-gradient(90deg, transparent, #000 20px, #000 calc(100% - 20px), transparent);
}

.roleplay-wallpaper img {
  display: block;
  width: 100%;
  height: 100%;
  max-width: none;
  object-fit: cover;
  object-position: center;
  -webkit-mask-image: linear-gradient(transparent, #000 20px, #000 calc(100% - 20px), transparent);
  mask-image: linear-gradient(transparent, #000 20px, #000 calc(100% - 20px), transparent);
}

.chat-main.persona-theme .chat-input-area { background: transparent; }

/* No fixed attachment or GPU filters; quiet surfaces protect mobile reading. */
@media (max-width: 900px) {
  .roleplay-wallpaper img { object-position: 72% center; }
  .chat-main.persona-theme .chat-message.assistant .message-bubble {
    padding: 12px 14px;
    border-left: 2px solid #edc2d2;
    border-radius: 4px 16px 16px 16px;
    background: rgba(255, 252, 252, .94);
    box-shadow: 0 2px 8px #71465a08;
  }
}
/* Ordinary AI is a separate presentation layer; roleplay/legacy styling above is unchanged. */
.assistant-layout { --assistant-canvas: #f5f7fa; --assistant-sidebar: #e9edf3; --assistant-ink: #202733; --assistant-muted: #5d6879; --assistant-line: #cbd4e1; --text-primary: #202733; --text-regular: #394556; --text-secondary: #5d6879; }
.assistant-main { background: var(--assistant-canvas); min-width: 0; }
.assistant-page-heading { height: 54px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 15px; padding: 0 30px; color: #465366; font-size: 14px; border-bottom: 1px solid #e1e6ee; }
.assistant-page-heading span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assistant-page-heading button { display: grid; place-items: center; border: 0; background: none; width: 32px; height: 32px; border-radius: 9px; color: #5d6879; cursor: pointer; }
.assistant-page-heading button:hover { background: #e5eaf2; }
.assistant-welcome { min-height: 0; flex: 1; display: flex; flex-direction: column; align-items: center; overflow: auto; padding: 20px 32px 24px; }
.welcome-copy { margin-top: auto; text-align: center; padding: 30px 0 38px; }
.welcome-copy h1 { font-size: clamp(26px, 2.5vw, 36px); letter-spacing: -1px; font-weight: 600; color: #18212f; margin: 0 0 14px; }
.assistant-start { width: min(1060px, 100%); margin-top: auto; }
.assistant-suggestions { display: flex; flex-wrap: wrap; gap: 9px; margin-bottom: 22px; }
.assistant-suggestions button { display: flex; align-items: center; gap: 9px; padding: 12px 15px; background: #fff; border: 1px solid var(--assistant-line); border-radius: 14px; font-size: 14px; color: #394556; cursor: pointer; }
.assistant-suggestions button>span:last-child { margin-left: 9px; color: #62738a; }
.assistant-suggestions button:hover { border-color: #8ea5c6; background: #edf3fc; }
.assistant-main .chat-content { max-width: 1120px; height: auto; min-height: 0; }
.assistant-main .chat-messages { min-height: 0; padding: 18px 30px; }
.assistant-main .chat-message { animation: none; gap: 0; margin-bottom: 32px; }
.assistant-main .message-avatar, .assistant-main .message-role { display: none; }
.assistant-main .message-body { max-width: 100%; min-width: 0; }
.assistant-main .chat-message.assistant .message-body { width: 100%; }
.assistant-main .chat-message.assistant .message-bubble { padding: 5px 0; background: transparent; border: 0; box-shadow: none; border-radius: 0; font-size: 16px; color: var(--assistant-ink); }
.assistant-main .chat-message.user .message-body { max-width: 85%; }
.assistant-main .chat-message.user .message-bubble { background: #e3eaf5; color: #24344d; border: 1px solid #d3deed; border-radius: 20px 20px 5px 20px; box-shadow: none; padding: 12px 18px; font-size: 16px; }
.assistant-main .message-text { color: var(--assistant-ink); font-size: 16px; line-height: 1.85; }
.assistant-main .message-text :deep(a) { color: #235ea8; text-decoration-color: #8eaed3; text-underline-offset: 3px; }
.assistant-main .message-text :deep(a:visited) { color: #435d8a; }
.assistant-main .message-text :deep(a:hover) { color: #154379; text-decoration-color: currentColor; }
.assistant-main .message-actions { color: #626f82; }
.assistant-main .message-bubble:hover { transform: none; box-shadow: none; }
.assistant-main .chat-input-area { padding: 12px 30px 20px; background: var(--assistant-canvas); }
.assistant-layout .chat-sidebar { background: var(--assistant-sidebar); border-color: #d2dbe7; }
.assistant-layout .btn-new-chat { background: #f9fbff; border: 1px solid #bbc9dc; box-shadow: none; color: #29476e; border-radius: 12px; font-weight: 500; }
.assistant-layout .btn-new-chat:hover { transform: none; background: #dee8f7; border-color: #95aaca; }
.assistant-layout .conversation-item:hover { background: #dfe5ef; }
.assistant-layout .conversation-item.active { background: #d5e1f2; box-shadow: inset 3px 0 #5479ac; }
.assistant-layout .conversation-item.active .conversation-title { color: #243e63; }
.assistant-layout .conversation-title { font-size: 14px; color: #303e51; }
.assistant-layout .conversation-time { font-size: 12px; color: #56677f; }
.assistant-layout .conversation-icon, .assistant-layout .conversation-item.active .conversation-icon { background: #e1e7f0; color: #405d84; box-shadow: none; }
.assistant-layout .conversation-item.active .conversation-icon { background: #c3d3e9; color: #264971; }
.assistant-layout .conversation-spaces { background: #dce2eb; }
.assistant-layout .conversation-spaces button { color: #465569; }
.assistant-layout .conversation-spaces button.active { color: #213d63; background: #fff; box-shadow: 0 1px 4px #253f6220; }
.assistant-layout .sidebar-footer { border-color: #d2dbe7; }
.assistant-layout .btn-settings { color: #394b64; border-color: #becbdc; background: #f7f9fc; }
@media(max-width: 900px) {
  .assistant-layout { background: var(--assistant-canvas); }
  .assistant-layout .mobile-chat-header { height: 60px; background: var(--assistant-canvas); border-bottom-color: #e1e6ee; }
  .assistant-layout .mobile-conversation-title { color: #24344d; }
  .assistant-layout .mobile-conversation-title small { color: #5d6879; }
  .assistant-page-heading { display: none; }
  .assistant-welcome { padding: 0 16px 12px; }
  .welcome-copy { padding: 20px 0 38px; }
  .welcome-copy h1 { font-size: 24px; line-height: 1.4; }
  .assistant-suggestions { gap: 8px; margin-bottom: 16px; }
  .assistant-suggestions button { font-size: 13px; min-height: 40px; padding: 9px 12px; gap: 6px; border-radius: 12px; }
  .assistant-main .chat-input-area { padding: 9px 12px 10px; }
  .assistant-main .chat-messages { padding: 20px 19px 8px; }
  .assistant-main .chat-message.assistant .message-bubble { font-size: 16px; line-height: 1.85; }
}
@media (max-width: 900px) and (max-height: 600px) {
  // Keep the composer reachable when a phone keyboard or landscape viewport
  // leaves little room above it. This depends on viewport size, not focus.
  .assistant-welcome .welcome-copy, .assistant-welcome .assistant-suggestions { display: none; }
}
// Keep the entire waiting indicator inside the same content gutter as its status row.
.chat-main .chat-message.assistant .message-bubble.thinking-bubble {
  box-sizing: border-box; min-height: 32px; padding: 12px 8px; border: 0; background: transparent; box-shadow: none;
}
@media (prefers-reduced-motion: reduce) { .typing-indicator > span { animation: none; } }
</style>
