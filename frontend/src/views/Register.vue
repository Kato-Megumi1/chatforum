<template>
  <div class="register-container" :style="{ backgroundImage: 'url(' + publicAsset('auth-bg-optimized.jpg') + ')' }">
    <div class="register-card">
      <div class="register-header">
        <el-icon :size="48" color="#165DFF">
          <ChatDotRound />
        </el-icon>
        <h1>创建账号</h1>
      </div>
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        size="large"
        @submit.prevent="handleRegister"
      >
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="form.email" placeholder="请输入邮箱" prefix-icon="Message" />
        </el-form-item>
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" placeholder="请输入用户名" prefix-icon="User" />
        </el-form-item>
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="form.phone" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="请输入11位手机号（可选）" prefix-icon="Phone" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码（至少6位）"
            prefix-icon="Lock"
            show-password
            autocomplete="new-password"
          />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            placeholder="请再次输入密码"
            prefix-icon="Lock"
            show-password
            autocomplete="new-password"
          />
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            :loading="loading"
            native-type="submit"
            style="width: 100%"
          >
            注册
          </el-button>
        </el-form-item>
      </el-form>
      <div class="register-footer">
        <span>已有账号?</span>
        <router-link to="/login">立即登录</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { publicAsset } from '@/utils/api';
import { reactive, ref, watch } from 'vue';
import { normalizeRegistrationPhone, registrationPhoneError, registrationPasswordError } from '@/utils/registration-validation';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { useUserStore } from '@/stores/user';

const router = useRouter();
const userStore = useUserStore();
const formRef = ref<FormInstance>();
const loading = ref(false);

const form = reactive({
  email: '',
  username: '',
  phone: '',
  password: '',
  confirmPassword: '',
});

const validateConfirmPassword = (_rule: any, value: any, callback: any) => {
  if (value !== form.password) {
    callback(new Error('两次输入的密码不一致'));
  } else {
    callback();
  }
};

watch(() => form.password, () => {
  if (form.confirmPassword) void formRef.value?.validateField('confirmPassword').catch(() => undefined);
});

const rules: FormRules = {
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '请输入正确的邮箱格式', trigger: 'blur' },
    { max: 191, message: '邮箱不能超过191个字符', trigger: 'blur' },
  ],
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, message: '用户名至少3个字符', trigger: 'blur' },
    { max: 30, message: '用户名不能超过30个字符', trigger: 'blur' },
  ],
  phone: [{ validator: (_rule, value, callback) => {
    const error = registrationPhoneError(value || '');
    callback(error ? new Error(error) : undefined);
  }, trigger: ['blur', 'change'] }],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { validator: (_rule, value, callback) => {
      const error = registrationPasswordError(value || '');
      callback(error ? new Error(error) : undefined);
    }, trigger: ['blur', 'change'] },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    { validator: validateConfirmPassword, trigger: ['blur', 'change'] },
  ],
};

const handleRegister = async () => {
  if (!formRef.value || loading.value) return;
  // Lock before validation too: Enter and a rapid click must not create two requests.
  loading.value = true;
  try {
    await formRef.value.validate();
    await userStore.register(form.email, form.username, form.password, normalizeRegistrationPhone(form.phone));
    ElMessage.success('注册成功');
    router.replace('/forum');
  } catch (error) {
    // Error already handled
  } finally {
    loading.value = false;
  }
};
</script>

<style lang="scss" scoped>
.register-container {
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
  .register-card {
    position: relative;
    z-index: 1;
  }
}

.register-card {
  width: 420px;
  padding: 40px 36px;
  background-color: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
}

.register-header {
  text-align: center;
  margin-bottom: 28px;

  h1 {
    margin: 16px 0 8px;
    font-size: 22px;
    color: #303133;
  }

}

.register-footer {
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
@media (max-width: 640px) {
  .register-container { min-height: 100svh; height: auto; padding: 24px 16px 56px; justify-content: center; }
  .register-card { width: min(420px, 100%); padding: 28px 24px; }
  :deep(.el-input__inner) { font-size: 16px; }
  .register-card { border-radius: 26px; box-shadow: 0 12px 50px #38253626; }
  .register-card :deep(.el-input__wrapper) { min-height: 44px; border-radius: 12px; }
  .register-card :deep(.el-button--primary) { min-height: 46px; border-radius: 14px; background: #a66b83; border: 0; }
  .register-footer a { color: #a66b83; }
}
</style>
