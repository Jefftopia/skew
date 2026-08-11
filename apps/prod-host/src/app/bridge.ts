/**
 * The host's end of a command channel to the remote.
 *
 * The guided walkthrough needs to drive steps that happen *inside the remote*
 * — "now write a v2 record" — without the user hunting for a button in the
 * other pane. But the host cannot call into the remote: they are separately
 * built applications, and the host has no type, no import, and no reference
 * to anything inside the remote's bundle.
 *
 * So they agree on a medium instead, exactly as `trace.ts` already does for
 * log entries: two string-named DOM events and a plain-object payload. The
 * host dispatches a command and waits for a reply keyed by id. Neither side
 * imports anything from the other, and the contract is small enough to read
 * in one screen — which is the same bargain the `{ v, payload }` envelope
 * makes everywhere else in this demo.
 *
 * Duplicated in `apps/prod-remote/src/app/commands.ts`, on purpose.
 */

export const COMMAND_EVENT = 'skew-demo:command';
export const RESULT_EVENT = 'skew-demo:command-result';

/** Actions the remote knows how to perform on the host's behalf. */
export type RemoteAction =
  | 'write-v2-record'
  | 'read-record-as-v2'
  | 'read-parked-draft'
  | 'clear-record'
  /** Ask the remote to share its migration chain via the page registry. */
  | 'register-schema';

export interface RemoteCommand {
  readonly id: string;
  readonly action: RemoteAction;
}

/**
 * One field's fate across a version boundary. This is what the Boundary
 * Inspector renders — the point is that "it migrated" is not one fact but
 * a per-field one, and some of those fields are honest guesses.
 */
export interface FieldChange {
  readonly name: string;
  readonly before: string;
  readonly after: string;
  readonly status: 'same' | 'migrated' | 'derived' | 'lost';
}

export interface RemoteResult {
  readonly id: string;
  readonly ok: boolean;
  readonly headline: string;
  readonly detail: string;
  /** Envelope version actually found on the wire/disk, when there was one. */
  readonly foundVersion?: number;
  readonly expectedVersion?: number;
  readonly fields?: readonly FieldChange[];
  readonly raw?: string;
}

const REPLY_TIMEOUT_MS = 4_000;

/**
 * Sends a command to the remote and resolves with its reply.
 *
 * Times out rather than hanging: if the remote failed to load, or is running
 * a build too old to know this action, nothing will ever answer — and a
 * walkthrough step stuck on "running…" forever is a worse failure than one
 * that says the remote didn't respond.
 */
export function sendToRemote(action: RemoteAction): Promise<RemoteResult> {
  const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<RemoteResult>((resolve) => {
    const timer = setTimeout(() => {
      globalThis.removeEventListener(RESULT_EVENT, onReply as EventListener);
      resolve({
        id,
        ok: false,
        headline: 'The remote did not answer',
        detail:
          'No reply within 4s. The remote may have failed to load, or may be running a build that does not know this command.',
      });
    }, REPLY_TIMEOUT_MS);

    function onReply(event: Event): void {
      const result = (event as CustomEvent<RemoteResult>).detail;
      if (!result || result.id !== id) return;
      clearTimeout(timer);
      globalThis.removeEventListener(RESULT_EVENT, onReply as EventListener);
      resolve(result);
    }

    globalThis.addEventListener(RESULT_EVENT, onReply as EventListener);
    globalThis.dispatchEvent(
      new CustomEvent<RemoteCommand>(COMMAND_EVENT, { detail: { id, action } }),
    );
  });
}
