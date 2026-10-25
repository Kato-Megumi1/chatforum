import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import request from '@/utils/request';
import { createReadRefreshCache } from '@/utils/read-refresh-cache';
import { useUserStore } from './user';

export const useNotificationStore = defineStore('notifications', () => {
  const unreadCount = ref(0);
  const user = useUserStore();
  const scope = () => {
    // Reading token also observes same-account re-login; normal token renewal keeps its epoch.
    if (!user.user || !user.token) return null;
    const session = user.getAuthSession();
    return `${session.userId}:${session.epoch}`;
  };
  const cache = createReadRefreshCache({
    scope,
    load: () => request.get<{ unreadCount: number }>('/forum/notifications/unread-count'),
    apply(result) {
      unreadCount.value = Number.isSafeInteger(result.unreadCount) ? Math.max(0, result.unreadCount) : 0;
    },
    onError(error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 401 || status === 403) clear();
      // Badge failures remain non-blocking; the next refresh may retry immediately.
    },
  });
  function clear() {
    cache.clear();
    unreadCount.value = 0;
  }
  watch(scope, clear, { flush: 'sync' });
  const refresh = cache.refresh;
  return { unreadCount, refresh, clear };
});
