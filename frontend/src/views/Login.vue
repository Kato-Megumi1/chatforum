<template>
  <div class="login-container" :style="{ backgroundImage: 'url(' + publicAsset('auth-bg-optimized.jpg') + ')' }">
    <div class="login-card">
      <div class="login-header">
        <el-icon :size="48" color="#165DFF">
          <ChatDotRound />
        </el-icon>
        <h1>ChatForum</h1>
      </div>
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        size="large"
      >
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="form.email" placeholder="请输入邮箱" prefix-icon="Message" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            prefix-icon="Lock"
            show-password
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <div v-if="loginRejected" class="recovery-entry">
          <button type="button" class="recovery-link" @click="openRecovery">忘记密码？</button>
        </div>
        <el-form-item>
          <el-button
            type="primary"
            :loading="loading"
            @click="handleLogin"
            style="width: 100%"
          >
            登录
          </el-button>
        </el-form-item>
      </el-form>
      <div class="login-footer">
        <span>还没有账号?</span>
        <router-link to="/register">立即注册</router-link>
      </div>
    </div>
    <el-dialog v-model="recoveryVisible" title="找回密码" class="recovery-dialog" width="min(460px, calc(100vw - 32px))"
      :close-on-click-modal="false" :close-on-press-escape="!resetting" :show-close="!resetting" @closed="clearRecoverySecrets">
      <el-form ref="recoveryRef" :model="recovery" :rules="recoveryRules" label-position="top" size="large" :disabled="resetting">
        <el-form-item label="注册邮箱" prop="email">
          <el-input v-model="recovery.email" placeholder="请输入注册邮箱" autocomplete="email" maxlength="191" @input="recovery.code = ''" />
        </el-form-item>
        <el-form-item label="邮箱验证码" prop="code">
          <div class="recovery-code-row">
            <el-input v-model="recovery.code" placeholder="6位验证码" inputmode="numeric" autocomplete="one-time-code" maxlength="6" />
            <el-button :loading="sendingCode" :disabled="resendSeconds > 0 || resetting" @click="sendRecoveryCode">{{ resendSeconds ? `${resendSeconds}秒后重发` : '获取验证码' }}</el-button>
          </div>
        </el-form-item>
        <el-alert v-if="recoveryNotice" :title="recoveryNotice" type="info" :closable="false" class="recovery-notice" />
        <el-form-item label="新密码" prop="newPassword">
          <el-input v-model="recovery.newPassword" type="password" show-password autocomplete="new-password" placeholder="至少6个字符" />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input v-model="recovery.confirmPassword" type="password" show-password autocomplete="new-password" placeholder="再次输入新密码" @keyup.enter="resetRecoveredPassword" />
        </el-form-item>
      </el-form>
      <template #footer><el-button :disabled="resetting" @click="recoveryVisible = false">取消</el-button><el-button type="primary" :loading="resetting" :disabled="sendingCode" @click="resetRecoveredPassword">重置密码</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { publicAsset } from '@/utils/api';
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { useUserStore } from '@/stores/user';
import request from '@/utils/request';
import { registrationPasswordError } from '@/utils/registration-validation';

const router = useRouter();
const userStore = useUserStore();
const formRef = ref<FormInstance>();
const loading = ref(false);
const loginRejected = ref(false);
const recoveryVisible = ref(false), recoveryRef = ref<FormInstance>();
const sendingCode = ref(false), resetting = ref(false), recoveryNotice = ref('');
const recovery = reactive({ email: '', code: '', newPassword: '', confirmPassword: '' });
const clock = ref(Date.now()), resendAt = ref(0);
const resendSeconds = computed(() => Math.max(0, Math.ceil((resendAt.value - clock.value) / 1000)));
const timer = window.setInterval(() => { clock.value = Date.now(); }, 1000);
onBeforeUnmount(() => { window.clearInterval(timer); clearRecoverySecrets(); });
const recoveryRules: FormRules = {
  email: [{ required: true, message: '请输入注册邮箱', trigger: 'blur' }, { type: 'email', message: '请输入正确的邮箱格式', trigger: 'blur' }],
  code: [{ required: true, message: '请输入邮箱验证码', trigger: 'blur' }, { pattern: /^\d{6}$/, message: '请输入6位邮箱验证码', trigger: 'blur' }],
  newPassword: [{ validator: (_rule, value, callback) => {
    const error = registrationPasswordError(value) || (!/\S/u.test(value || '') ? '新密码不能全部为空格' : undefined);
    callback(error ? new Error(error) : undefined);
  }, trigger: 'blur' }],
  confirmPassword: [{ validator: (_rule, value, callback) => callback(value && value === recovery.newPassword ? undefined : new Error('两次输入的新密码不一致')), trigger: 'blur' }],
};
function clearRecoverySecrets() { recovery.code = ''; recovery.newPassword = ''; recovery.confirmPassword = ''; recoveryRef.value?.clearValidate(); }
function openRecovery() { clearRecoverySecrets(); recovery.email = form.email.trim(); recoveryNotice.value = ''; recoveryVisible.value = true; }
async function sendRecoveryCode() {
  if (sendingCode.value || resetting.value || resendSeconds.value > 0) return;
  try {
    await recoveryRef.value?.validateField('email'); sendingCode.value = true;
    const result = await request.post<{message:string;retryAfterSeconds:number}>('/auth/password-recovery/code', { email: recovery.email.trim().toLowerCase() });
    recoveryNotice.value = result.message; clock.value = Date.now(); resendAt.value = clock.value + result.retryAfterSeconds * 1000;
  } catch { /* The shared API handler displays only server-safe errors; a failure starts no false countdown. */ }
  finally { sendingCode.value = false; }
}
async function resetRecoveredPassword() {
  if (resetting.value || sendingCode.value) return;
  try {
    await recoveryRef.value?.validate(); resetting.value = true;
    const result = await request.post<{message:string}>('/auth/password-recovery/reset', { ...recovery, email: recovery.email.trim().toLowerCase() });
    form.email = recovery.email.trim(); form.password = ''; loginRejected.value = false; userStore.clearAuth();
    recoveryVisible.value = false; clearRecoverySecrets(); ElMessage.success(result.message || '密码已重置，请使用新密码登录');
  } catch { /* Never retain a reset proof outside this open form or auto-login after reset. */ }
  finally { resetting.value = false; }
}

const form = reactive({
  email: '',
  password: '',
});

const rules: FormRules = {
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '请输入正确的邮箱格式', trigger: 'blur' },
  ],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};

const handleLogin = async () => {
  if (loading.value) return;
  loading.value = true;
  // A local validation error is not a rejected password attempt.
  try {
    await formRef.value?.validate();
  } catch { loading.value = false; return; }
  try {
    await userStore.login(form.email, form.password);
    loginRejected.value = false;
    ElMessage.success('登录成功');
    router.replace('/forum');
  } catch (error) {
    // The shared handler displays the safe login error. Only an actual rejected
    // login reveals recovery; connection errors and unavailable services do not.
    if ((error as { response?: { status?: number } })?.response?.status === 401) loginRejected.value = true;
  } finally {
    loading.value = false;
  }
};
</script>

<style lang="scss" scoped>
.login-container {
  width: 100%;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 10%;
  background: center / cover no-repeat;
  position: relative;
  &::before {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 0;
  }
  .login-card {
    position: relative;
    z-index: 1;
  }
}

.login-card {
  width: 400px;
  padding: 48px 36px;
  background-color: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
}

.login-header {
  text-align: center;
  margin-bottom: 32px;

  h1 {
    margin: 16px 0 8px;
    font-size: 24px;
    color: #303133;
  }

}

.login-footer {
  text-align: center;
  font-size: 14px;
  color: #909399;

  a {
    color: #165DFF;
    text-decoration: none;
    margin-left: 4px;

    &:hover {
      text-decoration: underline;
    }
  }
}
.recovery-entry { display: flex; justify-content: flex-end; margin: -8px 0 16px; }
.recovery-link {
  appearance: none; border: 0; background: transparent; padding: 8px 0;
  color: #165dff; font: inherit; font-size: 14px; line-height: 1.4; cursor: pointer;
  &:hover { text-decoration: underline; }
  &:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; border-radius: 3px; }
}
.recovery-code-row { display: flex; gap: 10px; width: 100%; .el-input { min-width: 0; flex: 1; } .el-button { flex: 0 0 auto; margin: 0; } }
.recovery-notice { margin: -4px 0 18px; }
@media (max-width: 640px) {
  .login-container { min-height: 100svh; height: auto; padding: 24px 16px 56px; justify-content: center; }
  .login-card { width: min(400px, 100%); padding: 30px 24px; }
  :deep(.el-input__inner) { font-size: 16px; }
  .login-card { border-radius: 26px; box-shadow: 0 12px 50px #38253626; }
  .login-card :deep(.el-input__wrapper) { min-height: 46px; border-radius: 12px; }
  .login-card :deep(.el-button--primary) { min-height: 46px; border-radius: 14px; background: #a66b83; border: 0; }
  .login-footer a { color: #a66b83; }
  .recovery-link { color: #93536f; min-height: 44px; }
}
</style>
