/**
 * Installs the page-wide skew devtools hook.
 *
 * `@skewkit/core` emits one trace event per `read()` / `write()` into
 * `globalThis.__SKEW_DEVTOOLS_HOOK__` when one is installed — and because the
 * host and the remote share a single `@skewkit/core` instance via federation's
 * `sharedMappings`, this one hook observes BOTH builds' schema activity: the
 * host's v1 reads, the remote's v2 writes, contract cures, outbox flushes.
 *
 * Runtime-import free on purpose (`import type` only): this module is loaded
 * from `main.ts` *before* `initFederation` resolves the import map, and a
 * static runtime import of a shared package there would bundle a second copy
 * of `@skewkit/core` into the host entry and break the singleton the whole demo
 * depends on. A hook is just an object with `emit`; it needs no library code.
 */
import type { SkewTraceEvent } from '@skewkit/core';

const BUFFER_LIMIT = 200;

export interface DemoDevtoolsHook {
  emit(event: SkewTraceEvent): void;
  readonly events: readonly SkewTraceEvent[];
  subscribe(listener: () => void): () => void;
  clear(): void;
}

export function installSkewDevtoolsHook(): DemoDevtoolsHook {
  const g = globalThis as Record<string, unknown>;
  const existing = g['__SKEW_DEVTOOLS_HOOK__'] as DemoDevtoolsHook | undefined;
  if (existing && typeof existing.subscribe === 'function') return existing;

  const events: SkewTraceEvent[] = [];
  const listeners = new Set<() => void>();

  const hook: DemoDevtoolsHook = {
    events,
    emit(event) {
      events.push(event);
      if (events.length > BUFFER_LIMIT) events.shift();
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      events.length = 0;
      for (const listener of listeners) listener();
    },
  };

  g['__SKEW_DEVTOOLS_HOOK__'] = hook;
  return hook;
}
