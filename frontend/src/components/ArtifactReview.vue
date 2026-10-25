<template>
  <details v-if="canView" ref="disclosure" class="artifact-review" :class="`review-${status}`" @toggle="onToggle">
    <summary><span class="review-dot" aria-hidden="true"></span>{{ label }}<span class="review-chevron" aria-hidden="true">⌄</span></summary>
    <div class="review-body">
      <p v-if="loading" class="review-note" role="status">正在加载验收记录…</p>
      <p v-if="loadError" class="review-error" role="status">验收记录暂不可查看。<button :disabled="loading" @click="load(true)">重试</button></p>
      <ul v-if="visibleIssues.length" class="review-issue-list"><li v-for="(issue, index) in visibleIssues" :key="index">{{ issue }}</li></ul>
      <p v-if="!summary.reviewId && !loading && !visibleIssues.length" class="review-note">暂无验收记录</p>
      <div v-if="images.length" class="review-images">
        <figure v-for="image in images" :key="image.index">
          <figcaption>{{ image.index === 0 ? '手机' : '桌面' }} · {{ image.width }} × {{ image.height }}</figcaption>
          <img v-if="image.url && image.state === 'ready'" :src="image.url" :alt="`${image.index === 0 ? '手机' : '桌面'}离线验收截图`" @error="failImage(image.index)" />
          <p v-else-if="image.state === 'loading'" class="review-note">正在加载截图…</p>
          <p v-else class="review-error">此截图暂不可查看。<button :disabled="loading" @click="load(true)">重试</button></p>
        </figure>
      </div>
      <p v-else-if="report && !loading && !visibleIssues.length" class="review-note">暂无截图</p>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import request from '@/utils/request';
import { useUserStore } from '@/stores/user';
import { artifactReviewLabel, artifactReviewReport, artifactReviewSummary, isHtmlArtifact, isReviewPng,
  type ArtifactReviewReport, type ArtifactReviewSummary, type ArtifactReviewView } from '@/utils/artifact-review';
const props = defineProps<{ conversationId: number; changeId: number; path: string; review?: ArtifactReviewSummary }>();
const user = useUserStore(), owner = user.getAuthSession();
const disclosure = ref<HTMLDetailsElement>();
const summary = computed(() => artifactReviewSummary(props.review));
const report = ref<ArtifactReviewReport>();
const loading = ref(false), loadError = ref(false);
type ReviewImage = ArtifactReviewView & { url: string; state: 'loading' | 'ready' | 'error' };
const images = ref<ReviewImage[]>([]);
let active = true, version = 0, controller: AbortController | undefined;
const ownsSession = () => {
  const current = user.getAuthSession();
  return !!user.token && owner.userId !== null && current.userId === owner.userId && current.epoch === owner.epoch;
};
const identity = computed(() => {
  const session = user.getAuthSession();
  const authenticated = !!user.token;
  return JSON.stringify([props.conversationId, props.changeId, props.path, summary.value, session.userId, session.epoch, authenticated]);
});
const canView = computed(() => ownsSession() && isHtmlArtifact(props.path) && Number.isSafeInteger(props.conversationId) && props.conversationId > 0 &&
  Number.isSafeInteger(props.changeId) && props.changeId > 0);
const status = computed(() => loadError.value ? 'unavailable' : report.value?.status || summary.value.status);
const label = computed(() => artifactReviewLabel(status.value));
const visibleIssues = computed(() => loadError.value ? [] : report.value?.issues || summary.value.issues || []);
function revokeImages() {
  for (const image of images.value) if (image.url) URL.revokeObjectURL(image.url);
  images.value = [];
}
function reset() {
  version++; controller?.abort(); controller = undefined;
  revokeImages(); report.value = undefined; loading.value = false; loadError.value = false;
  if (disclosure.value) disclosure.value.open = false;
}
watch(identity, reset, { immediate: true, flush: 'sync' });
onUnmounted(() => { active = false; reset(); });
function onToggle(event: Event) { if ((event.target as HTMLDetailsElement).open) void load(); }
function failImage(index: number) {
  const image = images.value.find(item => item.index === index);
  if (!image) return;
  if (image.url) URL.revokeObjectURL(image.url);
  image.url = ''; image.state = 'error';
}
async function load(force = false) {
  if (!active || !canView.value || loading.value || !summary.value.reviewId || report.value && !force) return;
  controller?.abort(); revokeImages(); report.value = undefined; loadError.value = false;
  const stamp = ++version, key = identity.value, reviewId = summary.value.reviewId, expectedHash = summary.value.sourceHash;
  const base = `/coding/${props.conversationId}/changes/${props.changeId}/review/${reviewId}`;
  const connection = controller = new AbortController();
  const current = () => active && stamp === version && ownsSession() && key === identity.value;
  loading.value = true;
  try {
    const data = await request.get(base, { signal: connection.signal, _quiet: true });
    if (!current()) return;
    const saved = artifactReviewReport(data, reviewId, expectedHash);
    report.value = saved;
    images.value = saved.views.map(view => ({ ...view, url: '', state: 'loading' }));
    await Promise.all(saved.views.map(async view => {
      try {
        const blob = await request.get<Blob>(`${base}/images/${view.index}`, { responseType: 'blob', timeout: 30000, signal: connection.signal, _quiet: true });
        if (!current()) return;
        if (!await isReviewPng(blob)) throw Error('Invalid review image');
        if (!current()) return;
        const image = images.value.find(item => item.index === view.index);
        if (image) { image.url = URL.createObjectURL(blob); image.state = 'ready'; }
      } catch (error: any) {
        if (!current()) return;
        if ([401, 403, 404, 409].includes(error?.response?.status)) {
          loadError.value = true; revokeImages(); report.value = undefined; connection.abort();
        } else failImage(view.index);
      }
    }));
  } catch { if (current() && !connection.signal.aborted) { loadError.value = true; revokeImages(); report.value = undefined; } }
  finally { if (current()) loading.value = false; }
}
</script>

<style scoped>
.artifact-review { margin-top:9px;font-size:12px;line-height:1.6;color:#738299; }
.artifact-review summary { display:flex;align-items:center;gap:6px;width:fit-content;min-height:30px;cursor:pointer;list-style:none;border-radius:6px; }
.artifact-review summary::-webkit-details-marker { display:none; }.artifact-review summary:focus-visible,.review-body button:focus-visible { outline:2px solid #668bdf;outline-offset:2px; }
.review-dot { width:5px;height:5px;border-radius:50%;background:#93a0b2; }.review-passed .review-dot { background:#5d9977; }.review-issues .review-dot { background:#be9160; }
.review-chevron { font-size:14px; }.artifact-review[open] .review-chevron { transform:rotate(180deg); }
.review-body { padding:8px 0 0;border-top:1px solid #e0e7ef; }.review-note,.review-error { margin:0 0 7px; }
.review-error { color:#9b7056; }.review-body button { border:0;background:transparent;color:#426da3;text-decoration:underline;text-underline-offset:2px;font:inherit;cursor:pointer;padding:2px 4px; }
.review-body button:disabled { opacity:.5;cursor:default; }.review-issue-list { margin:0 0 8px;padding-left:18px;overflow-wrap:anywhere; }
.review-images { display:grid;gap:10px; }.review-images figure { margin:0;min-width:0; }.review-images figcaption { margin-bottom:5px;color:#64758c;font-size:11px; }
.review-images img { display:block;width:auto;max-width:100%;max-height:330px;object-fit:contain;object-position:top left;border:1px solid #dce4ee;border-radius:6px;background:#fff; }
@media(max-width:900px) { .artifact-review summary { min-height:36px; }.review-images img { max-height:280px; } }
</style>
