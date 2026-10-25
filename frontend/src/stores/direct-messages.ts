import { defineStore } from "pinia";
import { ref, watch } from "vue";
import request from "@/utils/request";
import { createReadRefreshCache } from "@/utils/read-refresh-cache";
import { useUserStore } from "./user";

// Counts only: no message text, contacts, drafts or thread history in persistent state.
export const useDirectMessageStore = defineStore(
  "direct-message-counts",
  () => {
    const inbox = ref(0),
      requests = ref(0),
      total = ref(0);
    const user = useUserStore();
    const scope = () => {
      if (!user.user || !user.token) return null;
      const session = user.getAuthSession();
      return `${session.userId}:${session.epoch}`;
    };
    const cache = createReadRefreshCache({
      scope,
      load: () => request.get<{
          inbox: number;
          requests: number;
          total: number;
        }>("/direct-messages/unread-count"),
      apply(data) {
        inbox.value = Number.isSafeInteger(data.inbox)
          ? Math.max(0, data.inbox)
          : 0;
        requests.value = Number.isSafeInteger(data.requests)
          ? Math.max(0, data.requests)
          : 0;
        total.value = Number.isSafeInteger(data.total)
          ? Math.max(0, data.total)
          : 0;
      },
      onError(error) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status === 401 || status === 403) clear();
        /* A count failure must not block navigation or expose stale text. */
      },
    });
    function clear() {
      cache.clear();
      inbox.value = requests.value = total.value = 0;
    }
    watch(scope, clear, { flush: "sync" });
    const refresh = cache.refresh;
    return { inbox, requests, total, clear, refresh };
  },
);
