import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/**
 * Unsaved-work tracking.
 *
 * A hard reload destroys in-memory state, so recovery must know whether that
 * matters. Angular already has a declaration for exactly this — `CanDeactivate`
 * — but the router exposes no way to ask "would a guard block here?", so a
 * library cannot reuse it.
 *
 * This registry is the workaround: components declare dirtiness explicitly and
 * the recovery service consults it. If Angular ever exposes guard
 * introspection, this whole file becomes deletable.
 */
@Injectable({ providedIn: 'root' })
export class UnsavedWorkRegistry {
  private readonly sources = signal<ReadonlyArray<() => boolean>>([]);

  /** Registers a predicate. Returns a disposer. */
  register(isDirty: () => boolean): () => void {
    this.sources.update((current) => [...current, isDirty]);
    return () => {
      this.sources.update((current) => current.filter((entry) => entry !== isDirty));
    };
  }

  /**
   * True when any registered source reports unsaved work.
   *
   * A throwing predicate is treated as *clean* rather than dirty: a broken
   * dirty-check should not permanently block recovery and strand the user.
   */
  isDirty(): boolean {
    return this.sources().some((isDirty) => {
      try {
        return isDirty();
      } catch {
        return false;
      }
    });
  }

  /** Count of registered sources. Diagnostics only. */
  get size(): number {
    return this.sources().length;
  }
}

/**
 * Declares that this component holds unsaved work, so automatic recovery will
 * not discard it. Unregisters automatically on destroy.
 *
 * ```ts
 * export class BulletinEditor {
 *   protected readonly form = …;
 *   constructor() {
 *     trackUnsavedWork(() => this.form.dirty);
 *   }
 * }
 * ```
 *
 * Must be called in an injection context.
 */
export function trackUnsavedWork(isDirty: () => boolean): void {
  const registry = inject(UnsavedWorkRegistry);
  const destroyRef = inject(DestroyRef);
  const dispose = registry.register(isDirty);
  destroyRef.onDestroy(dispose);
}
