export type ReadRefreshOptions = { force?: boolean };

/** A volatile, identity-scoped refresh gate. It retains no response bodies. */
export function createReadRefreshCache<T>(options: {
  scope: () => string | null;
  load: () => Promise<T>;
  apply: (result: T) => void;
  maxAgeMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}) {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 12_000;
  let scope: string | null = null;
  let generation = 0;
  let freshUntil = 0;
  let pending: Promise<void> | undefined;

  function clear() {
    generation++;
    scope = null;
    freshUntil = 0;
    pending = undefined;
  }

  function refresh({ force = false }: ReadRefreshOptions = {}): Promise<void> {
    const currentScope = options.scope();
    if (currentScope !== scope || force) {
      clear();
      scope = currentScope;
    }
    if (!currentScope) return Promise.resolve();
    if (pending) return pending;
    if (now() < freshUntil) return Promise.resolve();

    const stamp = generation;
    const isCurrent = () => stamp === generation && currentScope === options.scope();
    const work = Promise.resolve().then(async () => {
      // A synchronous logout/force refresh can invalidate a queued read before dispatch.
      if (!isCurrent()) return;
      try {
        const result = await options.load();
        if (!isCurrent()) return;
        options.apply(result);
        freshUntil = now() + maxAgeMs;
      } catch (error) {
        // A failed read never starts the success TTL. Late errors cannot alter a new session.
        if (!isCurrent()) return;
        if (options.onError) options.onError(error);
        else throw error;
      }
    }).finally(() => {
      if (pending === work) pending = undefined;
    });
    pending = work;
    return work;
  }

  return { refresh, clear };
}
