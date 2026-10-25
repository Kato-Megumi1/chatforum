import { MAX_IDLE_RUN_POLL_MS, MIN_RUN_POLL_MS, RunPollPacer } from './chat-run.poll';

describe('per-reader durable run polling', () => {
  test('idle readers back off to at most one second, without a task deadline', () => {
    const pacer = new RunPollPacer();
    expect(Array.from({ length: 7 }, () => pacer.observe('RUNNING/thinking', false)))
      .toEqual([150, 300, 600, 1000, 1000, 1000, 1000]);
    expect(pacer.observe('RUNNING/thinking', false)).toBe(MAX_IDLE_RUN_POLL_MS);
  });
  test('new text and genuine activity changes reset latency, not another reader', () => {
    const first = new RunPollPacer(), second = new RunPollPacer();
    for (let i=0; i<8; i++) first.observe('RUNNING/thinking', false);
    expect(second.observe('RUNNING/thinking', false)).toBe(MIN_RUN_POLL_MS);
    expect(first.observe('RUNNING/thinking', true)).toBe(MIN_RUN_POLL_MS);
    expect(first.observe('RUNNING/thinking', false)).toBe(300);
    expect(first.observe('RUNNING/generating', false)).toBe(MIN_RUN_POLL_MS);
    expect(first.observe('COMPLETED', false)).toBe(MIN_RUN_POLL_MS);
  });
  test('sixty seconds of idle waiting requires far fewer reads than fixed 150ms polling', () => {
    const pacer = new RunPollPacer(); let elapsed=0, reads=0;
    while(elapsed<60000) { elapsed+=pacer.observe('RUNNING/thinking', false); reads++; }
    expect(reads).toBeLessThanOrEqual(65);
    expect(reads).toBeLessThan(Math.floor(60000/MIN_RUN_POLL_MS)/5);
  });
});
