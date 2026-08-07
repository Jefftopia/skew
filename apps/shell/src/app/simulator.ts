import { Injectable, signal } from '@angular/core';

/**
 * The skew simulator.
 *
 * Every failure this library exists for requires a *deploy* to reproduce, which
 * makes them impossible to demonstrate and miserable to test. These flags fake
 * the deploy instead: break the next chunk, serve a stale manifest, write a
 * record from the "other" build.
 *
 * Flags live in localStorage because two of them must survive the page reload
 * they are provoking.
 */

const FAIL_CHUNK = 'skew-demo:fail-chunk';
const STALE_ORIGIN = 'skew-demo:stale-origin';

function read(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function write(key: string, value: boolean): void {
  try {
    if (value) globalThis.localStorage?.setItem(key, 'true');
    else globalThis.localStorage?.removeItem(key);
  } catch {
    /* private mode — the demo still runs, it just cannot persist a flag */
  }
}

/**
 * Read at module load so route definitions — which are evaluated before DI
 * exists — can consult it.
 */
export function shouldFailNextChunk(): boolean {
  return read(FAIL_CHUNK);
}

/** Which manifest to point the probe at. */
export function manifestUrl(): string {
  return read(STALE_ORIGIN) ? '/skew-manifest-stale.json' : '/skew-manifest.json';
}

@Injectable({ providedIn: 'root' })
export class Simulator {
  readonly failChunk = signal(read(FAIL_CHUNK));
  readonly staleOrigin = signal(read(STALE_ORIGIN));

  toggleFailChunk(): void {
    const next = !this.failChunk();
    this.failChunk.set(next);
    write(FAIL_CHUNK, next);
  }

  toggleStaleOrigin(): void {
    const next = !this.staleOrigin();
    this.staleOrigin.set(next);
    write(STALE_ORIGIN, next);
  }

  clearChunkFailure(): void {
    this.failChunk.set(false);
    write(FAIL_CHUNK, false);
  }

  /**
   * Clears the flags *and* the recovery counter.
   *
   * The counter lives in sessionStorage and is deliberately scoped to a build,
   * so it survives the reload it is counting. That is correct behaviour and
   * exactly what stops a bricked tab — but between demo runs it looks like the
   * library has stopped working, so the reset is worth surfacing.
   */
  reset(): void {
    this.failChunk.set(false);
    this.staleOrigin.set(false);
    write(FAIL_CHUNK, false);
    write(STALE_ORIGIN, false);
    try {
      globalThis.sessionStorage?.removeItem('skew:recoveries');
    } catch {
      /* ignore */
    }
  }
}

/** An error shaped like the one a purged chunk actually produces. */
export function fakeChunkError(): Error {
  const error = new Error('Failed to fetch dynamically imported module: /chunk-APP2XYZ.js');
  error.name = 'ChunkLoadError';
  return error;
}
