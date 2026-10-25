import { createApp } from 'vue';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
// Template components/directives are imported by the Vite resolver. Services are
// called from TypeScript, so retain their styles without installing the full UI kit.
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/message-box/style/css';
import 'element-plus/es/components/notification/style/css';
import 'element-plus/es/components/loading/style/css';
import { ArrowDown, ChatDotRound, ChatLineSquare, Close, Collection, Connection, Delete, Document, DocumentCopy, Edit, EditPen, Expand,
  MagicStick, MoreFilled, Plus, Promotion, Service, Setting, Star, SwitchButton, Top, User, VideoPause, View } from '@element-plus/icons-vue';
import { marked } from 'marked';
import App from './App.vue';
import router from './router';
import './styles/index.scss';

marked.setOptions({
  breaks: true,
  gfm: true,
});

const app = createApp(App);
const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

app.use(pinia);
app.use(router);

for (const [key, component] of Object.entries({ ArrowDown, ChatDotRound, ChatLineSquare, Close, Collection, Connection, Delete, Document, DocumentCopy, Edit, EditPen, Expand,
  MagicStick, MoreFilled, Plus, Promotion, Service, Setting, Star, SwitchButton, Top, User, VideoPause, View })) {
  app.component(key, component);
}

app.mount('#app');
