<template>
  <div class="profile-container">
    <div class="profile-wrapper">
      <el-page-header @back="$router.back()" title="返回" class="page-header" />
      <div class="profile-main" v-if="userStore.user">
        <el-button v-if="CONNECTION_SETTINGS_ENABLED" class="mobile-profile-connection" plain @click="openConnection"><el-icon><Connection /></el-icon>后端连接设置</el-button>
        <div class="profile-card">
          <div class="avatar-section">
            <input
              ref="avatarInput"
              type="file"
              accept=".jpg,.jpeg,.png,.gif,.webp"
              style="display:none"
              @change="handleAvatarFile"
            />
            <el-avatar :size="88" :src="userStore.user.avatar" :key="userStore.user.avatar" class="profile-avatar clickable" @click="avatarInput?.click()">
              {{ userStore.user.username.charAt(0).toUpperCase() }}
            </el-avatar>
            <button type="button" class="avatar-hint" @click="avatarInput?.click()">更换头像</button>
          </div>
          <div class="info-section">
            <h1 class="profile-name">{{ userStore.user.username }}</h1>
            <div class="user-badges">
              <el-tag type="primary" effect="plain" round>Lv.{{ userStore.user.level }}</el-tag>
              <el-tag type="success" effect="plain" round>{{ userStore.user.points }} 积分</el-tag>
            </div>
            <p class="profile-bio" v-if="userStore.user.bio">{{ userStore.user.bio }}</p>
          </div>
        </div>
        <el-tabs v-model="activeTab" class="profile-tabs">
          <el-tab-pane label="社区动态" name="community">
            <ForumActivity />
            <div class="profile-shortcuts">
              <el-button plain @click="$router.push('/notifications')">消息通知</el-button>
              <el-button plain @click="$router.push('/forum/create')">发布新帖</el-button>
              <el-button plain @click="$router.push('/user/memory')">我的记忆</el-button>
              <el-button plain @click="$router.push('/reports')">举报与申诉</el-button>
            </div>
          </el-tab-pane>
          <el-tab-pane label="编辑资料" name="info">
            <el-form :model="profileForm" label-position="top" class="profile-form">
              <el-form-item label="用户名">
                <el-input v-model="profileForm.username" size="large" />
              </el-form-item>
              <el-form-item label="邮箱">
                <el-input v-model="profileForm.email" disabled size="large" />
              </el-form-item>
              <el-form-item label="个人简介">
                <el-input
                  v-model="profileForm.bio"
                  type="textarea"
                  :rows="4"
                  placeholder="介绍一下自己..."
                  maxlength="200"
                  show-word-limit
                />
              </el-form-item>
              <el-form-item>
                <el-button type="primary" size="large" round @click="handleUpdateProfile" :loading="updating">
                  保存修改
                </el-button>
              </el-form-item>
            </el-form>
          </el-tab-pane>
          <el-tab-pane label="账号安全" name="security">
            <div class="security-section">
              <div class="security-item">
                <div class="security-info">
                  <div class="security-label">邮箱</div>
                  <div class="security-value">{{ userStore.user.email }}</div>
                </div>
                <el-tag type="success" effect="plain" size="small">已绑定</el-tag>
              </div>
              <div class="security-item">
                <div class="security-info">
                  <div class="security-label">密码</div>
                  <div class="security-value">········</div>
                </div>
                <el-button plain size="small" @click="openPasswordDialog">修改密码</el-button>
              </div>
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>
    </div>
    <el-dialog v-model="passwordDialog" title="修改密码" width="min(460px, calc(100vw - 32px))"
      :close-on-click-modal="!changingPassword" :close-on-press-escape="!changingPassword" :show-close="!changingPassword" @closed="resetPasswordForm">
      <el-form ref="passwordFormRef" :model="passwordForm" :rules="passwordRules" label-position="top" @submit.prevent="handleChangePassword">
        <el-form-item label="当前密码" prop="oldPassword">
          <el-input v-model="passwordForm.oldPassword" type="password" show-password autocomplete="current-password" aria-label="当前密码" />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input v-model="passwordForm.newPassword" type="password" show-password autocomplete="new-password" placeholder="至少6个字符" aria-label="新密码" />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input v-model="passwordForm.confirmPassword" type="password" show-password autocomplete="new-password" aria-label="确认新密码" />
        </el-form-item>
      </el-form>
      <p class="password-note">修改密码后，所有设备需重新登录。</p>
      <template #footer>
        <el-button :disabled="changingPassword" @click="passwordDialog = false">取消</el-button>
        <el-button type="primary" :loading="changingPassword" @click="handleChangePassword">确认修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
const openConnection = () => window.dispatchEvent(new Event('chatforum:connection-settings'));
import { CONNECTION_SETTINGS_ENABLED } from '@/utils/api';
import { ref, reactive, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ForumActivity from '@/components/ForumActivity.vue';
import { ElMessage } from 'element-plus';
import { useUserStore } from '@/stores/user';
import request from '@/utils/request';
import { registrationPasswordError } from '@/utils/registration-validation';
import type { FormInstance, FormRules } from 'element-plus';

const userStore = useUserStore();
const isProfileSession = (session: ReturnType<typeof userStore.getAuthSession>) => {
  const current = userStore.getAuthSession();
  return current.userId === session.userId && current.epoch === session.epoch;
};

const route = useRoute();
const router = useRouter();
const activeTab = ref('community');
watch(() => route.query.activity, () => { if (route.query.activity) activeTab.value = 'community'; });
const updating = ref(false);

const avatarInput = ref<HTMLInputElement | null>(null);
const passwordDialog = ref(false), changingPassword = ref(false), passwordFormRef = ref<FormInstance>();
const passwordForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' });
const resetPasswordForm = () => {
  passwordForm.oldPassword = ''; passwordForm.newPassword = ''; passwordForm.confirmPassword = '';
  passwordFormRef.value?.clearValidate();
};
const openPasswordDialog = () => { resetPasswordForm(); passwordDialog.value = true; };
const passwordRules: FormRules = {
  oldPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }, { validator: (_rule, value, done) => {
    done(new TextEncoder().encode(value || '').length > 72 ? new Error('当前密码不能超过72字节') : undefined);
  }, trigger: 'blur' }],
  newPassword: [{ required: true, message: '请输入新密码', trigger: 'blur' }, { validator: (_rule, value, done) => {
    const error = registrationPasswordError(value || '') || (!(value || '').trim() ? '新密码不能全部为空格' : '') ||
      (value && value === passwordForm.oldPassword ? '新密码不能与当前密码相同' : '');
    done(error ? new Error(error) : undefined);
  }, trigger: ['blur', 'change'] }],
  confirmPassword: [{ required: true, message: '请再次输入新密码', trigger: 'blur' }, { validator: (_rule, value, done) => {
    done(value !== passwordForm.newPassword ? new Error('两次输入的新密码不一致') : undefined);
  }, trigger: ['blur', 'change'] }],
};
watch(() => passwordForm.newPassword, () => {
  if (passwordForm.confirmPassword) void passwordFormRef.value?.validateField('confirmPassword').catch(() => undefined);
});
const handleChangePassword = async () => {
  if (!passwordFormRef.value || changingPassword.value) return;
  const session = userStore.getAuthSession();
  changingPassword.value = true;
  try {
    await passwordFormRef.value.validate();
    if (!isProfileSession(session)) return;
    await request.post('/auth/password', { ...passwordForm });
    if (!isProfileSession(session)) return;
    resetPasswordForm(); passwordDialog.value = false;
    userStore.clearAuth();
    ElMessage.success('密码已修改，请使用新密码重新登录');
    await router.replace('/login');
  } catch { /* Form or request displays the precise error; preserve fields for correction. */ }
  finally { if (isProfileSession(session)) changingPassword.value = false; }
};

const handleAvatarFile = async (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowed.includes(file.type)) {
    ElMessage.error('仅支持 JPG/PNG/GIF/WebP 格式');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.error('头像不能超过 5MB');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  const session = userStore.getAuthSession();
  if (!session.userId) { input.value = ''; return; }

  try {
    // The shared client pins the original identity before Axios schedules a request.
    // Keep an explicit component boundary too: a stale upload must not start a new-account profile request.
    const data = await request.post<{ url: string }>('/users/avatar', formData);
    if (!isProfileSession(session)) return;
    if (!data?.url) { ElMessage.error('上传未返回头像地址，请重试'); return; }
    const profileData = await request.get<NonNullable<typeof userStore.user>>('/users/profile');
    if (!isProfileSession(session)) return;
    if (!profileData || profileData.id !== session.userId) return;
    userStore.setUser(profileData);
    if (!isProfileSession(session)) return;
    ElMessage.success('头像更新成功');
  } catch { /* Request errors are displayed once by the shared handler; a stale session stays silent. */ }
  finally { if (isProfileSession(session)) input.value = ''; }
};

const profileForm = reactive({
  username: '',
  email: '',
  bio: '',
});

const handleUpdateProfile = async () => {
  if (!profileForm.username.trim()) {
    ElMessage.warning('用户名不能为空');
    return;
  }
  updating.value = true;
  const session = userStore.getAuthSession();
  try {
    await userStore.updateProfile({
      username: profileForm.username.trim(),
      bio: profileForm.bio.trim(),
    });
    if (isProfileSession(session)) ElMessage.success('保存成功');
  } finally {
    if (isProfileSession(session)) updating.value = false;
  }
};

watch(() => userStore.getAuthSession(), (session, previous) => {
  if (previous && session.userId === previous.userId && session.epoch === previous.epoch) return;
  profileForm.username = userStore.user?.username || '';
  profileForm.email = userStore.user?.email || '';
  profileForm.bio = userStore.user?.bio || '';
  passwordDialog.value = false; resetPasswordForm();
  changingPassword.value = false; updating.value = false;
  if (avatarInput.value) avatarInput.value.value = '';
}, { immediate: true, flush: 'sync' });
</script>

<style lang="scss" scoped>
.profile-container {
  height: 100%;
  overflow-y: auto;
  background: var(--bg-page);
}
.profile-wrapper {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px 20px;
}

.page-header {
  margin-bottom: 16px;
}

.profile-main {
  background: #fff;
  border-radius: var(--radius-lg);
  padding: 36px;
  box-shadow: var(--shadow-sm);
}

.profile-card {
  display: flex;
  gap: 24px;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--border-light);
}

.avatar-section {
  flex-shrink: 0;
}

.profile-avatar {
  border: 3px solid var(--primary-bg);
  box-shadow: var(--shadow-sm);

  &.clickable {
    cursor: pointer;
    transition: opacity 0.2s;

    &:hover {
      opacity: 0.8;
    }
  }
}

.avatar-hint {
  border: 0;
  padding: 4px 0;
  background: transparent;
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 6px;
  cursor: pointer;
}
.avatar-hint:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }

.info-section {
  flex: 1;
  min-width: 0;
}

.profile-name {
  margin: 0 0 10px;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
}

.user-badges {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.profile-bio {
  font-size: 14px;
  color: var(--text-regular);
  margin: 0;
  line-height: 1.6;

  &.placeholder {
    color: var(--text-placeholder);
    font-style: italic;
  }
}

.profile-tabs {
  margin-top: 20px;

  :deep(.el-tabs__header) {
    margin-bottom: 24px;
  }
}
.profile-shortcuts { display:flex; flex-wrap:wrap; gap:12px; margin-top:24px; }

.profile-form {
  max-width: 480px;

  :deep(.el-form-item__label) {
    font-weight: 600;
    color: var(--text-primary);
  }

  :deep(.el-input__wrapper) {
    border-radius: var(--radius-sm);
  }
}

.security-section {
  max-width: 480px;
}

.security-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 0;
  border-bottom: 1px solid var(--border-light);

  &:last-child {
    border-bottom: none;
  }
}

.security-info {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.security-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.security-value {
  font-size: 14px;
  color: var(--text-secondary);
}
.password-note { color: var(--text-secondary); font-size: 13px; line-height: 1.6; margin: 4px 0 0; }
.mobile-profile-connection { display: none; }
@media (max-width: 900px) {
  .profile-container { background: #faf9f7; }
  .profile-main { border: 1px solid #eee7eb; border-radius: 20px; box-shadow: none; }
  .mobile-profile-connection { display: flex; margin-bottom: 20px; border-radius: 12px; }
  .profile-wrapper { padding: 16px 12px 48px; }
  .profile-main { padding: 20px 16px; }
  .profile-card { flex-wrap: wrap; gap: 16px; }
  .info-section { flex-basis: 150px; overflow-wrap: anywhere; }
  .user-badges { flex-wrap: wrap; }
  .security-item { gap: 12px; }
}
</style>
