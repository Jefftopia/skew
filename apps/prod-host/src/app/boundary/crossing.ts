import { Injectable, signal } from '@angular/core';
import type { FieldChange } from '../bridge';

export type Verdict =
  | 'migrated' // read succeeded, data was upgraded on the way out
  | 'current' // read succeeded, nothing to migrate
  | 'refused' // read failed on purpose, data left intact
  | 'corrupted' // protections off: read "succeeded" with a shape the reader cannot use
  | 'error'; // something else went wrong

export interface Party {
  readonly label: string;
  readonly build: string;
  readonly understands: number;
}

/**
 * One crossing of a version boundary, in the form the UI draws it.
 *
 * This is the model that replaced the scrolling text log. A log line saying
 * `refused: ahead — found v2` is accurate and tells a newcomer nothing; the
 * same fact drawn as *this build* → *this envelope* → *that build*, with the
 * verdict underneath and the per-field consequences below that, is the same
 * information arranged so the shape of the problem is the first thing you
 * see rather than something you reconstruct from timestamps.
 */
export interface Crossing {
  readonly at: number;
  readonly from: Party;
  readonly to: Party;
  /** Version stamped on the envelope that actually crossed, if there was one. */
  readonly envelopeVersion: number | null;
  readonly verdict: Verdict;
  readonly headline: string;
  readonly detail: string;
  readonly fields?: readonly FieldChange[];
  readonly raw?: string;
  /** True when this crossing happened with the protections switched off. */
  readonly unprotected: boolean;
}

/**
 * Holds the most recent boundary crossing for the inspector to draw.
 *
 * Deliberately "most recent" rather than a history: the inspector answers
 * "what just happened, and why", and a list of past crossings is the log this
 * is meant to replace.
 */
@Injectable({ providedIn: 'root' })
export class CrossingStore {
  private readonly current = signal<Crossing | null>(null);
  readonly latest = this.current.asReadonly();

  set(crossing: Omit<Crossing, 'at'>): void {
    this.current.set({ ...crossing, at: Date.now() });
  }

  clear(): void {
    this.current.set(null);
  }
}
