<template>
  <div v-if="view.visible" class="web-search-sources">
    <details v-if="view.sources.length" class="web-source-details">
      <summary><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.4"/><path d="M2.8 10h14.4M10 2.6c2 2 3 4.5 3 7.4s-1 5.4-3 7.4c-2-2-3-4.5-3-7.4s1-5.4 3-7.4Z"/></svg><span>联网来源 {{ view.sources.length }}</span><span class="source-chevron" aria-hidden="true">⌄</span></summary>
      <p v-if="view.failed" class="source-failure" role="status">部分联网搜索失败</p>
      <ol class="web-source-list">
        <li v-for="source in view.sources" :key="source.url">
          <a :href="source.url" target="_blank" rel="noopener noreferrer"><span class="source-title">{{ source.title }}</span><span aria-hidden="true"> ↗</span></a>
          <div class="source-meta">{{ source.host }}</div>
          <p v-if="source.snippet" class="source-snippet">{{ source.snippet }}</p>
        </li>
      </ol>
    </details>
    <p v-else-if="view.failed" class="source-failure" role="status">联网搜索暂不可用</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { webSearchSourceView } from '@/utils/web-search-sources';
const props = defineProps<{ metadata?: unknown }>();
const view = computed(() => webSearchSourceView(props.metadata));
</script>

<style scoped>
.web-search-sources { max-width:100%;margin-top:12px;font-size:12px;line-height:1.6;color:#66778e; }
.web-source-details summary { display:flex;align-items:center;gap:6px;min-height:32px;width:fit-content;padding:3px 7px;border-radius:7px;list-style:none;cursor:pointer;color:#416b9d; }
.web-source-details summary::-webkit-details-marker { display:none; }
.web-source-details summary:hover { background:#5b7da20d; }
.web-source-details summary:focus-visible,.web-source-list a:focus-visible { outline:2px solid #4b80b8;outline-offset:2px; }
.web-source-details summary svg { width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.4; }
.source-chevron { font-size:15px;line-height:1;transition:transform .15s ease; }
.web-source-details[open] .source-chevron { transform:rotate(180deg); }
.web-source-list { margin:5px 0 0;padding:0 0 0 23px;border-left:2px solid #e0e8f1;max-height:380px;overflow:auto;overscroll-behavior:contain; }
.web-source-list li { padding:7px 8px 8px 0;overflow-wrap:anywhere; }
.web-source-list a { color:#376baf;text-decoration:none; }
.web-source-list a:hover { text-decoration:underline; }
.source-title { font-weight:500; }
.source-meta { margin-top:2px;color:#7b8797;font-size:11px; }
.source-snippet { margin:4px 0 0;color:#65758b;white-space:pre-wrap; }
.source-failure { margin:5px 0;color:#8b7354; }
@media(max-width:900px) { .web-source-details summary { min-height:36px; }.web-source-list { max-height:300px; } }
@media(prefers-reduced-motion:reduce) { .source-chevron { transition:none; } }
</style>
