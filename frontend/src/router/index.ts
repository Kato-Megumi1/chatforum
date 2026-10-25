import { createRouter, createWebHistory, createWebHashHistory, RouteRecordRaw } from 'vue-router';
import { useUserStore } from '@/stores/user';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('@/views/Register.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        redirect: '/forum',
      },
      {
        path: 'chat',
        name: 'Chat',
        component: () => import('@/views/Chat.vue'),
        meta: { requiresAuth: true },
      },
      {
        path: 'forum',
        name: 'Forum',
        component: () => import('@/views/Forum.vue'),
        meta: { requiresAuth: false },
      },
      {
        path: 'forum/post/:id',
        name: 'PostDetail',
        component: () => import('@/views/PostDetail.vue'),
        meta: { requiresAuth: false },
      },
      {
        path: 'forum/create',
        name: 'CreatePost',
        component: () => import('@/views/CreatePost.vue'),
        meta: { requiresAuth: true },
      },
      {
        path: 'forum/post/:id/edit',
        name: 'EditPost',
        component: () => import('@/views/CreatePost.vue'),
        meta: { requiresAuth: true },
      },
      {
        path: 'notifications',
        name: 'Notifications',
        component: () => import('@/views/Notifications.vue'),
        meta: { requiresAuth: true },
      },
      {
        path: 'messages',
        name: 'DirectMessages',
        component: () => import('@/views/Messages.vue'),
        meta: { requiresAuth: true },
      },
      {
        path: 'user/profile',
        name: 'UserProfile',
        component: () => import('@/views/UserProfile.vue'),
        meta: { requiresAuth: true },
      },
      {
        path: 'user/memory',
        name: 'MyMemory',
        component: () => import('@/views/MyMemory.vue'),
        meta: { requiresAuth: true },
      },
      {
        path: 'reports',
        name: 'Reports',
        component: () => import('@/views/Reports.vue'),
        meta: { requiresAuth: true },
      },
      {
        path: 'user/:id',
        name: 'UserSpace',
        component: () => import('@/views/UserSpace.vue'),
        meta: { requiresAuth: false },
      },
      {
        path: 'knowledge-bases',
        name: 'KnowledgeBase',
        component: () => import('@/views/KnowledgeBase.vue'),
        meta: { requiresAuth: true },
      },
    ],
  },
];

const router = createRouter({
  history: import.meta.env.VITE_PAGES === 'true' ? createWebHashHistory(import.meta.env.BASE_URL) : createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.beforeEach((to, _from, next) => {
  const userStore = useUserStore();
  const isAuthenticated = !!userStore.token;

  if (to.meta.requiresAuth && !isAuthenticated) {
    next('/login');
  } else if ((to.path === '/login' || to.path === '/register') && isAuthenticated) {
    next('/forum');
  } else {
    next();
  }
});

export default router;
