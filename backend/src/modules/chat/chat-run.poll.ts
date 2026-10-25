export const MIN_RUN_POLL_MS = 150;
export const MAX_IDLE_RUN_POLL_MS = 1000;

// Per SSE reader, not a shared response cache. Every subsequent read still
// revalidates ACTIVE/authVersion/ownership/ACL before anything is delivered.
export class RunPollPacer {
  private activity?: string;
  private waitMs = MIN_RUN_POLL_MS;

  observe(activity: string, hasText: boolean): number {
    this.waitMs = hasText || this.activity !== activity ? MIN_RUN_POLL_MS
      : Math.min(MAX_IDLE_RUN_POLL_MS, this.waitMs * 2);
    this.activity = activity;
    return this.waitMs;
  }
}
