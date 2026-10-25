import { defineStore } from 'pinia';
import { ref } from 'vue';
import request from '@/utils/request';
import { useChatStore } from './chat';

interface User {
  id: number;
  email: string;
  username: string;
  avatar?: string;
  bio?: string;
  role: string;
  level: number;
  points: number;
  createdAt: string;
}

interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export const useUserStore = defineStore(
  'user',
  () => {
    const user = ref<User | null>(null);
    const token = ref<string>('');
    const refreshToken = ref<string>('');
    // Runtime identity boundary only. Never return this as state or persist it.
    let authEpoch = 0;
    const getAuthSession = () => ({ userId: user.value?.id ?? null, epoch: authEpoch });
    const isAuthSession = (session: ReturnType<typeof getAuthSession>) => {
      const current = getAuthSession();
      return session.userId === current.userId && session.epoch === current.epoch;
    };
    const assertAuthSession = (session: ReturnType<typeof getAuthSession>) => {
      if (!isAuthSession(session)) throw Object.assign(new Error('登录账号已切换，请重新操作'), { code: 'AUTH_SESSION_CHANGED' });
    };

    const setUser = (userData: User) => {
      if (user.value?.id !== userData.id) { authEpoch++; useChatStore().resetForUser(); }
      user.value = userData;
    };

    const setToken = (accessToken: string, refresh: string) => {
      token.value = accessToken;
      refreshToken.value = refresh;
    };

    const login = async (email: string, password: string) => {
      const session = getAuthSession();
      const data = await request.post<AuthResponse>('/auth/login', {
        email,
        password,
      });
      assertAuthSession(session);
      authEpoch++;
      setUser(data.user);
      setToken(data.accessToken, data.refreshToken);
      return data;
    };

    const register = async (email: string, username: string, password: string, phone?: string) => {
      const session = getAuthSession();
      const data = await request.post<AuthResponse>('/auth/register', {
        email,
        username,
        password,
        phone,
      });
      assertAuthSession(session);
      authEpoch++;
      setUser(data.user);
      setToken(data.accessToken, data.refreshToken);
      return data;
    };

    const clearAuth = () => {
      authEpoch++;
      useChatStore().resetForUser();
      user.value = null;
      token.value = '';
      refreshToken.value = '';
    };

    const logout = async () => {
      const session = getAuthSession();
      try {
        await request.post('/auth/logout', {
          refreshToken: refreshToken.value,
        });
      } finally {
        if (isAuthSession(session)) clearAuth();
      }
    };

    const refresh = async () => {
      const session = getAuthSession();
      const data = await request.post<AuthResponse>('/auth/refresh', {
        refreshToken: refreshToken.value,
      });
      assertAuthSession(session);
      setUser(data.user);
      setToken(data.accessToken, data.refreshToken);
      return data;
    };

    const updateProfile = async (data: any) => {
      const session = getAuthSession();
      const userData = await request.put<User>('/users/profile', data);
      assertAuthSession(session);
      setUser(userData);
      return userData;
    };

    return {
      user,
      token,
      refreshToken,
      getAuthSession,
      setUser,
      setToken,
      login,
      register,
      clearAuth,
      logout,
      refresh,
      updateProfile,
    };
  },
  {
    persist: {
      key: 'chatforum-user',
      storage: localStorage,
    },
  }
);
