<template>
  <BackendConnection v-if="CONNECTION_SETTINGS_ENABLED" />
  <el-config-provider :locale="zhCn">
    <router-view />
  </el-config-provider>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import { CONNECTION_SETTINGS_ENABLED } from '@/utils/api';
// The connection editor is a development tool, not a production route or chunk.
const BackendConnection = import.meta.env.DEV
  ? defineAsyncComponent(() => import('@/components/BackendConnection.vue')) : undefined;
import { zhCn } from 'element-plus/es/locales.mjs';
</script>

<style lang="scss">
#app {
  width: 100%;
  height: 100vh;
  overflow: hidden;
}
</style>
