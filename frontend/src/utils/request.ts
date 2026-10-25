import axios from 'axios';
import { API_BASE, apiUrl, normalizeMedia } from './api';
import { ElMessage } from 'element-plus';
import { useUserStore } from '@/stores/user';
import { invalidateForumFeedCache } from './forum-feed-cache';

const http = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
});

type AuthSession = { userId: number | null; epoch: number };
const refreshes = new Map<string, Promise<string>>();
const sessionMatches = (session: AuthSession) => {
  const current = useUserStore().getAuthSession();
  return session.userId === current.userId && session.epoch === current.epoch;
};
const sessionChanged = () => Object.assign(new Error('登录账号已切换，请重新操作'), { code: 'AUTH_SESSION_CHANGED' });
function assertSession(session: AuthSession) { if (!sessionMatches(session)) throw sessionChanged(); }

function refreshSession(session: AuthSession) {
  const key = `${session.userId ?? 'anonymous'}:${session.epoch}`;
  const existing = refreshes.get(key);
  if (existing) return existing;
  const pending = (async () => {
    try {
      assertSession(session);
      const store = useUserStore(), refreshToken = store.refreshToken;
      if (!refreshToken) throw new Error('缺少登录刷新凭据');
      const response = await axios.post(apiUrl('/auth/refresh'), { refreshToken }, { timeout: 30000 });
      assertSession(session);
      if (!response.data.success) throw new Error('刷新登录状态失败');
      const { accessToken, refreshToken: nextRefreshToken, user } = response.data.data;
      if (typeof accessToken !== 'string' || typeof nextRefreshToken !== 'string' ||
        user && user.id !== session.userId) throw new Error('登录刷新返回了不匹配的账号');
      store.setToken(accessToken, nextRefreshToken);
      if (user) store.setUser(normalizeMedia(user));
      return accessToken;
    } catch (error) {
      // A late A refresh must not restore A over B, or clear B on failure.
      if (!sessionMatches(session)) throw sessionChanged();
      useUserStore().clearAuth();
      ElMessage.error('登录已过期，请重新登录');
      throw error;
    }
  })();
  refreshes.set(key, pending);
  const clear = () => { if (refreshes.get(key) === pending) refreshes.delete(key); };
  void pending.then(clear, clear);
  return pending;
}

http.interceptors.request.use(
  (config) => {
    const userStore = useUserStore();
    const scoped = config as typeof config & { _authSession?: AuthSession };
    if (scoped._authSession) assertSession(scoped._authSession);
    else scoped._authSession = userStore.getAuthSession();
    if (userStore.token) {
      config.headers.Authorization = `Bearer ${userStore.token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

http.interceptors.response.use(
  (response) => {
    const session = (response.config as any)?._authSession as AuthSession | undefined;
    if (session) assertSession(session);
    const res = response.data;
    if (response.config.responseType === 'blob') return res;
    if (res.success) {
      const method = (response.config.method || 'get').toLowerCase();
      const path = response.config.url?.split('?')[0] || '';
      if (!['get', 'head', 'options'].includes(method) &&
        (/^\/forum\/posts(?:\/|$)/.test(path) && !path.endsWith('/view') ||
          /^\/forum\/comments\/\d+$/.test(path) || /^\/users\/\d+\/follow$/.test(path))) {
        invalidateForumFeedCache();
      }
      return normalizeMedia(res.data);
    } else {
      if (!(response.config as any)._quiet) ElMessage.error(res.message || '请求失败');
      return Promise.reject(new Error(res.message || '请求失败'));
    }
  },
  async (error) => {
    const originalRequest = error.config;
    const session = originalRequest?._authSession as AuthSession | undefined;
    if (session && !sessionMatches(session)) return Promise.reject(sessionChanged());
    if (error.code === 'AUTH_SESSION_CHANGED') return Promise.reject(error);
    if (error.code === 'ERR_CANCELED' || axios.isCancel?.(error)) return Promise.reject(error);
    if (error.response?.data instanceof Blob) {
      try { error.response.data = JSON.parse(await error.response.data.text()); } catch { /* safe generic error below */ }
    }
    if (session && !sessionMatches(session)) return Promise.reject(sessionChanged());

    // A rejected password is not an expired protected session. Do not rotate or clear an
    // unrelated stored login, and do not expose whether the supplied mailbox exists.
    if (error.response?.status === 401 && originalRequest?.url?.split('?')[0] === '/auth/login') {
      ElMessage.error('邮箱或密码不正确');
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      // Every real request is stamped before dispatch. Never infer the identity
      // of an unstamped failed request from whichever account is logged in now.
      if (!session) return Promise.reject(sessionChanged());
      originalRequest._retry = true;
      try {
        const token = await refreshSession(session);
        assertSession(session);
        originalRequest.headers.Authorization = `Bearer ${token}`;
        return http(originalRequest);
      } catch (refreshError) { return Promise.reject(refreshError); }
    } else if (originalRequest?._quiet) {
      // Background reads own their inline recovery UI. Authentication handling above remains active.
    } else if (error.response?.data?.message) {
      ElMessage.error(error.response.data.message);
    } else {
      ElMessage.error(error.message || '请求失败');
    }
    return Promise.reject(error);
  }
);

// Type-safe wrapper: axios interceptors unwrap ApiResponse, return data directly
// Capture synchronously, before Axios schedules async request interceptors.
const scopeRequest = (config?: any) => ({ ...config, _authSession: useUserStore().getAuthSession() });
const request = {
  get<T = any>(url: string, config?: any): Promise<T> { return http.get(url, scopeRequest(config)) as any; },
  post<T = any>(url: string, data?: any, config?: any): Promise<T> { return http.post(url, data, scopeRequest(config)) as any; },
  put<T = any>(url: string, data?: any, config?: any): Promise<T> { return http.put(url, data, scopeRequest(config)) as any; },
  patch<T = any>(url: string, data?: any, config?: any): Promise<T> { return http.patch(url, data, scopeRequest(config)) as any; },
  delete<T = any>(url: string, config?: any): Promise<T> { return http.delete(url, scopeRequest(config)) as any; },
};

export default request;
