import { onMounted, onUnmounted, ref } from 'vue';

// iOS resizes the visual viewport for its keyboard without resizing 100dvh.
export function useMobileViewport() {
  const viewportStyle = ref<Record<string, string>>({});
  let frame = 0;
  const viewport = window.visualViewport;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      viewportStyle.value = window.innerWidth <= 900 && viewport && Math.abs(viewport.scale - 1) < 0.01
        ? { height: `${viewport.height}px` }
        : {};
    });
  };
  onMounted(() => {
    update();
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
  });
  onUnmounted(() => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', update);
    viewport?.removeEventListener('resize', update);
  });
  return viewportStyle;
}
