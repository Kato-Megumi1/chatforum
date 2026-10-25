<template>
  <div v-if="pending || progress || generation?.truncated" class="generation-status">
    <details v-if="view.phases.length" class="generation-process" :class="{ 'is-pending': pending }">
      <summary aria-label="处理过程">
        <span class="process-indicator" aria-hidden="true"></span>
        <span class="process-current">{{ statusLabel }}</span>
        <span v-if="view.elapsedMs !== null" class="process-elapsed">总用时 {{ seconds(view.elapsedMs) }} 秒</span>
        <span class="process-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div class="process-body">
        <p v-if="view.summary" class="process-summary">{{ view.summary }}</p>
        <p v-if="view.lastDataAgeMs !== null" class="process-receiving">{{ view.lastDataAgeMs < 3000 ? '正在接收模型数据' : `${seconds(view.lastDataAgeMs)} 秒前收到模型数据` }}</p>
        <div class="process-table-heading">阶段累计用时</div>
        <ol v-if="view.phases.length" class="process-phases" aria-label="已收到的处理阶段">
          <li v-for="phase in view.phases" :key="phase.phase" :class="{ 'phase-active': phase.active }">
            <span class="phase-copy">
              <span class="phase-label">{{ phase.label }}<span v-if="phase.active" class="phase-state">进行中</span></span>
            </span>
            <span v-if="phase.durationMs !== null" class="phase-metrics">{{ seconds(phase.durationMs) }} 秒</span>
          </li>
        </ol>
      </div>
    </details>
    <span v-else class="process-compact" :class="{ 'is-pending': pending }">
      <span class="process-indicator" aria-hidden="true"></span>
      <span class="process-current">{{ statusLabel }}</span>
      <span v-if="view.elapsedMs !== null" class="process-elapsed">总用时 {{ seconds(view.elapsedMs) }} 秒</span>
    </span>
    <span v-if="pending" class="process-announcement" role="status">{{ view.label }}</span>
    <button v-if="!pending && generation?.truncated && generation?.canContinue" class="continue-generation" :disabled="busy" @click="$emit('continue')">{{ continuationLabel }}</button>
    <p v-if="!pending && generation?.fileIncomplete && !resumeFile" class="file-resume-unavailable">此回答未保留草稿，无法接着完成。</p>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { GenerationProgress } from '@/utils/chat-stream';
import { generationProcessView, generationSeconds as seconds } from '@/utils/generation-process';
import { readFileResume, type FileResumePointer, type FileFailureReason } from '@/utils/file-resume';
const props = defineProps<{ pending?: boolean; busy?: boolean; progress?: GenerationProgress;
  generation?: {truncated: boolean; canContinue: boolean; fileIncomplete?: boolean; filePaths?: string[];
    fileFailureReason?: FileFailureReason; resumeFile?: FileResumePointer}; allowThinking?: boolean }>();
const resumeFile = computed(() => readFileResume(props.generation?.resumeFile));
const continuationLabel = computed(() => props.generation?.fileIncomplete ? resumeFile.value ? '继续完成文件' : '重新生成文件' : '继续生成');
const statusLabel = computed(() => !props.pending && props.generation?.fileIncomplete ? '文件未完成' : view.value.label);
defineEmits<{ continue: [] }>();
const sampledAt = ref(Date.now()), now = ref(sampledAt.value), frozenExtension = ref(0);
let mounted = false, timer: ReturnType<typeof setInterval> | undefined;
const stopClock = () => { if (timer !== undefined) clearInterval(timer); timer = undefined; };
const syncClock = () => {
  stopClock();
  if (mounted && props.pending && generationProcessView(props.progress, true, 0, !!props.allowThinking).phase !== 'completed')
    timer = setInterval(() => { now.value = Date.now(); }, 250);
};
watch([() => props.pending, () => props.progress], ([pending, snapshot], previous) => {
  const changed = !previous || previous[1] !== snapshot;
  const observedAt = Date.now();
  if (changed || pending && !previous?.[0]) {
    sampledAt.value = observedAt; frozenExtension.value = 0;
  } else if (!pending && previous?.[0]) {
    frozenExtension.value = Math.max(0, observedAt - sampledAt.value);
  }
  now.value = observedAt;
  syncClock();
}, { immediate: true });
const view = computed(() => generationProcessView(props.progress, !!props.pending,
  props.pending ? Math.max(0, now.value - sampledAt.value) : frozenExtension.value, !!props.allowThinking));
onMounted(() => { mounted = true; syncClock(); });
onUnmounted(() => { mounted = false; stopClock(); });
</script>
<style scoped>
.generation-status { display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 12px;margin-top:8px;font-size:12px;color:#64758d;line-height:1.7; }
.generation-process { max-width:100%;min-width:0; }
.process-compact { display:flex;align-items:center;gap:7px;min-height:32px;padding:3px 7px; }
.generation-process summary { display:flex;flex-wrap:wrap;align-items:center;gap:3px 7px;min-height:32px;padding:3px 7px;border:1px solid transparent;border-radius:8px;cursor:pointer;list-style:none;user-select:none; }
.generation-process summary::-webkit-details-marker { display:none; }
.generation-process summary:hover { background:rgba(100,130,170,.07); }
.generation-process summary:focus-visible { outline:2px solid #4b80b8;outline-offset:2px; }
.process-current { min-width:0;color:#456487; }
.process-elapsed,.phase-metrics { font-variant-numeric:tabular-nums; }
.process-chevron { display:inline-block;font-size:16px;line-height:1;transition:transform .15s ease; }
.generation-process[open] .process-chevron { transform:rotate(180deg); }
.process-indicator { width:6px;height:6px;border-radius:50%;background:#90a3b7;flex:none; }
.is-pending .process-indicator { background:#5b91c4;animation:process-pulse 1.6s ease-in-out infinite; }
.process-body { width:430px;max-width:100%;box-sizing:border-box;margin-top:3px;padding:10px 12px;border:1px solid #dce5ef;border-radius:10px;background:rgba(248,250,253,.94); }
.process-summary { margin:0 0 4px;color:#456487;font-size:13px;line-height:1.65; }
.process-receiving { margin:0 0 10px;color:#7b8b9d; }
.process-table-heading { margin:0 0 3px;color:#7b8b9d;font-size:11px; }
.process-phases { margin:0;padding:0;list-style:none; }
.process-phases li { display:flex;align-items:flex-start;justify-content:space-between;gap:8px 16px;padding:6px 0; }
.phase-copy { display:flex;min-width:0;flex-direction:column;gap:1px; }
.phase-label { color:#53667e; }
.phase-active .phase-label { color:#346d9e; }
.phase-state { margin-left:6px;font-size:11px;color:#527d9d; }
.phase-metrics { flex:none;color:#7b8b9d; }
.process-announcement { position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0; }
.continue-generation { border:1px solid #cbd7e8;border-radius:14px;background:#fff;padding:3px 11px;min-height:32px;color:#3b638e;cursor:pointer; }
.continue-generation:disabled { opacity:.5;cursor:default; }
.file-resume-unavailable { flex-basis:100%;margin:0;color:#7b8b9d;font-size:12px;line-height:1.6; }
@keyframes process-pulse { 50% { opacity:.35; } }
@media (max-width:900px) {
  .generation-process summary { min-height:36px; }
  .process-body { width:min(430px,calc(100vw - 48px)); }
}
@media (prefers-reduced-motion:reduce) {
  .is-pending .process-indicator { animation:none; }
  .process-chevron { transition:none; }
}
</style>
