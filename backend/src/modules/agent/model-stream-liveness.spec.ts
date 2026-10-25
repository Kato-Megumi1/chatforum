import { meteredFetch, performanceSnapshot, withModelRuntime } from './model-runtime';
import { ModelRequestTimeoutError, publicRunFailure } from './model-output.error';

describe('provider streaming inactivity timeout', () => {
  const originalFetch = global.fetch;
  let upstream: ReadableStreamDefaultController<Uint8Array>;
  const frame = () => new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'synthetic private reasoning' } }] }) + '\n\n');
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn(async (_url, init) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      upstream = controller;
      init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
    } }))) as any;
  });
  afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });
  const request = (signal?: AbortSignal) => meteredFetch(undefined, signal, 180000)('https://fixture.invalid/chat', {
    method: 'POST', body: JSON.stringify({ model: 'fixture', messages: [], stream: true, enable_thinking: true, max_tokens: 10000 }),
  });
  test('active reasoning continues beyond the old whole-request deadline and exposes only counts', async () => {
    await withModelRuntime(new AbortController().signal, async () => {
      const response = await request(); const reader = response.body!.getReader();
      for (let i = 0; i < 4; i++) {
        const read = reader.read(); await jest.advanceTimersByTimeAsync(150000); upstream.enqueue(frame());
        expect((await read).done).toBe(false);
      }
      expect(performanceSnapshot()?.elapsedMs).toBeGreaterThan(180000);
      expect(performanceSnapshot()?.modelOutput?.thinkingChars).toBe(4 * 'synthetic private reasoning'.length);
      expect(JSON.stringify(performanceSnapshot())).not.toContain('synthetic private reasoning');
      upstream.close(); expect((await reader.read()).done).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    });
  });
  test('an actually silent stream times out with a useful fixed public error', async () => {
    await withModelRuntime(new AbortController().signal, async () => {
      const response = await request(); const read = response.body!.getReader().read().catch(error => error);
      await jest.advanceTimersByTimeAsync(180001);
      const error = await read; expect(error).toBeInstanceOf(ModelRequestTimeoutError);
      expect(publicRunFailure(error)).toMatchObject({ code: 'MODEL_REQUEST_TIMEOUT' });
      expect(jest.getTimerCount()).toBe(0);
    });
  });
  test('user cancellation interrupts immediately and releases the idle timer', async () => {
    const cancel = new AbortController();
    await withModelRuntime(cancel.signal, async () => {
      const response = await request(cancel.signal); const read = response.body!.getReader().read().catch(error => error);
      cancel.abort(); expect((await read).name).toBe('AbortError'); expect(jest.getTimerCount()).toBe(0);
    });
  });
  test('SDK connection/header cancellation is preserved rather than discarded', async () => {
    const cancel = new AbortController();
    await withModelRuntime(new AbortController().signal, async () => {
      const response = await meteredFetch(undefined, undefined, 1000)('https://fixture.invalid/chat', {
        signal: cancel.signal, method: 'POST', body: JSON.stringify({ model: 'fixture', messages: [], stream: true, max_tokens: 10000 }),
      });
      const read = response.body!.getReader().read().catch(error => error); cancel.abort();
      expect((await read).name).toBe('AbortError'); expect(jest.getTimerCount()).toBe(0);
    });
  });
});
