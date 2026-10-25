<template>
  <el-container class="main-layout" :class="{ 'mobile-chat-page': route.path === '/chat' }" :style="mobileViewportStyle">
    <el-header class="header">
      <div class="header-left">
        <div class="logo" @click="$router.push('/')">
          <img :src="publicAsset('tju-logo.png')" alt="天大校徽" class="logo-img" />
          <span class="logo-text">天大论坛</span>
        </div>
      </div>
      <el-menu
        :default-active="activeMenu"
        mode="horizontal"
        :ellipsis="false"
        class="header-menu"
        @select="handleSelect"
      >
        <el-menu-item index="/chat">
          <el-icon><ChatDotRound /></el-icon>
          <span>AI 对话</span>
        </el-menu-item>
        <el-menu-item index="/forum">
          <el-icon><ChatLineSquare /></el-icon>
          <span>社区论坛</span>
        </el-menu-item>
        <el-menu-item index="/knowledge-bases">
          <el-icon><Collection /></el-icon>
          <span>小说库</span>
        </el-menu-item>
      </el-menu>
      <div class="header-right">
        <template v-if="userStore.user">
          <el-badge :value="directMessages.total" :hidden="!directMessages.total" :max="99" class="notification-badge"><el-button class="notification-button" circle text aria-label="社区私信" @click="$router.push('/messages')"><el-icon><Message /></el-icon></el-button></el-badge>
          <el-badge :value="notifications.unreadCount" :hidden="!notifications.unreadCount" :max="99" class="notification-badge"><el-button class="notification-button" circle text aria-label="消息通知" @click="$router.push('/notifications')"><el-icon><Bell /></el-icon></el-button></el-badge>
          <el-dropdown trigger="click">
            <button type="button" class="user-info" :aria-label="`账号菜单，${userStore.user.username}`" :title="userStore.user.username">
              <el-avatar :size="34" :src="userStore.user.avatar" class="user-avatar">
                {{ userStore.user.username.charAt(0).toUpperCase() }}
              </el-avatar>
              <span class="username">{{ userStore.user.username }}</span>
              <el-icon class="arrow-icon"><ArrowDown /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="$router.push('/user/profile')">
                  <el-icon><User /></el-icon>
                  个人中心
                </el-dropdown-item>
                <el-dropdown-item @click="$router.push('/user/profile?activity=favorites')">我的收藏</el-dropdown-item>
                <el-dropdown-item @click="$router.push('/user/' + userStore.user.id + '?people=following')">我的关注</el-dropdown-item>
                <el-dropdown-item @click="$router.push('/messages')">社区私信 {{ directMessages.total ? '(' + directMessages.total + ')' : '' }}</el-dropdown-item>
                <el-dropdown-item @click="$router.push('/notifications')">消息通知 {{ notifications.unreadCount ? '(' + notifications.unreadCount + ')' : '' }}</el-dropdown-item>
                <el-dropdown-item divided @click="handleLogout">
                  <el-icon><SwitchButton /></el-icon>
                  退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
        <template v-else>
          <el-button class="btn-login" @click="$router.push('/login')">登录</el-button>
          <el-button class="btn-register" type="primary" @click="$router.push('/register')">注册</el-button>
        </template>
      </div>
    </el-header>
    <el-main class="main-content">
      <router-view v-slot="{ Component }"><component :is="Component" :key="route.name === 'EditPost' || route.name === 'CreatePost' ? route.path : undefined" /></router-view>
    </el-main>
    <nav class="mobile-tabbar" aria-label="主要导航">
      <router-link to="/chat" :class="{ active: activeMenu === '/chat' }"><el-icon><ChatDotRound /></el-icon><span>对话</span></router-link>
      <router-link to="/forum" :class="{ active: activeMenu === '/forum' }"><el-icon><ChatLineSquare /></el-icon><span>社区</span></router-link>
      <router-link to="/knowledge-bases" :class="{ active: activeMenu === '/knowledge-bases' }"><el-icon><Collection /></el-icon><span>小说库</span></router-link>
      <router-link to="/user/profile" :class="{ active: activeMenu === '/user/profile' }"><el-icon><User /></el-icon><span>我的</span></router-link>
    </nav>
  </el-container>
</template>

<script setup lang="ts">
import { publicAsset } from '@/utils/api';
import { computed, watch, onMounted, onUnmounted } from 'vue';
import { Bell, Message } from '@element-plus/icons-vue';
import { useNotificationStore } from '@/stores/notifications';
import { useDirectMessageStore } from '@/stores/direct-messages';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useUserStore } from '@/stores/user';
import { useMobileViewport } from '@/composables/useMobileViewport';

const mobileViewportStyle = useMobileViewport();

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();
const notifications = useNotificationStore();
const directMessages = useDirectMessageStore();
let notificationTimer: ReturnType<typeof setInterval> | undefined;
const refreshNotifications = () => { if (!document.hidden) { void notifications.refresh(); void directMessages.refresh(); } };
watch(() => {
  const session = userStore.getAuthSession();
  // Token updates make the closure-only epoch observable on same-account re-login.
  // Rotating a token within the same epoch leaves this key unchanged.
  const authenticated = !!userStore.user && !!userStore.token;
  return `${authenticated ? session.userId : 'anonymous'}:${session.epoch}`;
}, () => { notifications.clear(); directMessages.clear(); if (userStore.user) refreshNotifications(); }, { immediate: true });
watch(() => route.path, refreshNotifications);
onMounted(() => { window.addEventListener('focus', refreshNotifications); notificationTimer = setInterval(refreshNotifications, 60000); });
onUnmounted(() => { window.removeEventListener('focus', refreshNotifications); clearInterval(notificationTimer); });

const activeMenu = computed(() => {
  const path = route.path;
  if (path.startsWith('/forum')) return '/forum';
  if (path.startsWith('/user') || path === '/notifications' || path === '/messages') return '/user/profile';
  return path;
});

const handleSelect = (key: string) => {
  router.push(key);
};

const handleLogout = async () => {
  const session = userStore.getAuthSession();
  try {
    await ElMessageBox.confirm('确定要退出登录吗?', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    });
    const current = userStore.getAuthSession();
    if (current.userId !== session.userId || current.epoch !== session.epoch) return;
    await userStore.logout();
    if (userStore.user || userStore.token) return;
    ElMessage.success('已退出登录');
    router.push('/login');
  } catch (err: any) {
    if (err?.code === 'AUTH_SESSION_CHANGED' || userStore.user?.id !== session.userId && userStore.user) return;
    if (err !== 'cancel' && err?.message !== 'cancel') {
      // The store only clears the original session; a late logout never signs out a new account.
      if (userStore.user || userStore.token) return;
      router.push('/login');
    }
  }
};
</script>

<style lang="scss" scoped>
.main-layout {
  width: 100%;
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 28px;
  background: #fff;
  border-bottom: 2px solid var(--primary-bg);
  height: 60px;
  box-shadow: 0 1px 4px rgba(74, 158, 220, 0.08);
  position: relative;
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}

.logo-img {
  width: 36px;
  height: 36px;
  object-fit: contain;
}

.logo-text {
  font-size: 18px;
  font-weight: 700;
  color: var(--primary-dark);
  letter-spacing: 0.5px;
}

.header-menu {
  flex: 1;
  justify-content: center;
  border: none !important;
  height: 60px;

  :deep(.el-menu-item) {
    height: 60px;
    line-height: 60px;
    font-size: 14px;
    color: var(--text-regular);
    border-bottom: 2px solid transparent;
    transition: all var(--transition);

    &:hover {
      color: var(--primary-color);
      background: transparent;
    }

    &.is-active {
      color: var(--primary-color);
      font-weight: 600;
      border-bottom-color: var(--primary-color);
    }
  }
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.notification-button { color: var(--text-secondary); font-size: 18px; }
.notification-badge { margin-right: 4px; }

.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 44px;
  cursor: pointer;
  padding: 4px 14px;
  font: inherit;
  line-height: 1.5;
  text-align: left;
  background: transparent;
  border-radius: 24px;
  transition: all var(--transition);
  border: 1px solid transparent;

  &:hover {
    background: var(--bg-page);
    border-color: var(--border-color);
  }

  &:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: 2px;
  }
}

.user-avatar {
  flex-shrink: 0;
  border: 2px solid var(--primary-bg);
}

.username {
  display: block;
  font-size: 14px;
  // el-dropdown inherits line-height:1. Horizontal ellipsis needs overflow:hidden,
  // so provide a full font line box instead of clipping descenders such as g/p/y.
  line-height: 1.5;
  padding-block: 1px;
  min-width: 0;
  color: var(--text-primary);
  font-weight: 500;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.arrow-icon {
  color: var(--text-secondary);
  font-size: 12px;
  transition: transform var(--transition);
}

.user-info:hover .arrow-icon {
  transform: rotate(180deg);
}

.btn-login {
  border-radius: 20px;
  font-weight: 500;
}

.btn-register {
  border-radius: 20px;
  font-weight: 500;
  box-shadow: 0 2px 8px rgba(74, 158, 220, 0.3);
}

.main-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0;
}

.mobile-tabbar { display: none; }
@media (max-width: 900px) {
  // Browser/WebView chrome already owns the top system inset. Some embedded
  // browsers still report it through env(), which otherwise adds a second gap.
  .main-layout { background: #faf9f7; padding-top: 0; padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }
  .header { padding: 0 20px; gap: 12px; height: 60px; background: #faf9f7; box-shadow: none; border: 0; }
  .header-menu, .username, .arrow-icon, .btn-register { display: none; }
  .mobile-chat-page > .header { display: none; }
  .logo-img { width: 28px; height: 28px; }
  .logo-text { font-size: 17px; color: #303235; letter-spacing: -.4px; }
  .user-info { padding: 0; }
  .header-right { gap: 14px; flex-shrink: 0; }
  .mobile-tabbar { display: flex; flex-shrink: 0; justify-content: space-around; padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
    background: #fff; border-top: 1px solid #eeece9; }
  .mobile-tabbar a { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
    min-width: 64px; min-height: 44px; text-decoration: none; color: #91908f; font-size: 10px; font-weight: 500; border-radius: 14px; }
  .mobile-tabbar .el-icon { font-size: 21px; }
  .mobile-tabbar a.active { color: #a55d7a; background: #fcf0f5; }
}
@media (max-width: 900px) and (display-mode: standalone), (max-width: 900px) and (display-mode: fullscreen) {
  .main-layout { padding-top: env(safe-area-inset-top); }
}
</style>
