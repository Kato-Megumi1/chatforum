import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (env.VITE_PAGES === 'true') {
    // Fail publication rather than ship a login page that asks visitors to configure it.
    let valid = false;
    try {
      const url = new URL(env.VITE_API_BASE_URL);
      valid = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
        url.pathname.replace(/\/+$/, '') === '/api';
    } catch { /* A missing/invalid deployment address is a build error. */ }
    if (!valid) throw new Error('Pages requires VITE_API_BASE_URL: a public HTTPS backend URL ending in /api. Set repository variable PUBLIC_API_BASE_URL.');
  }
  return {
  base: env.VITE_BASE_PATH || '/',
  plugins: [
    vue(),
    Components({
      dirs: [],
      dts: false,
      directives: true,
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/uploads': { target: 'http://localhost:3000', changeOrigin: true },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
      },
    },
  },
};
});
