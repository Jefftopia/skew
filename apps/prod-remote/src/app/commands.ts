/**
 * The remote's end of the host's command channel.
 *
 * A near-copy of `apps/prod-host/src/app/bridge.ts`, duplicated for the same
 * reason `domain.ts` is: these are two independently built applications and
 * neither can import from the other. What they share is a string event name
 * and the shape of a plain object — small enough to keep in step by reading,
 * and the only kind of contract that survives the two being deployed weeks
 * apart.
 *
 * Note what this deliberately is *not*: a way for the host to reach into this
 * build's internals. The host names an intent ("write a v2 record"); this
 * build decides what that means under its own current schema. If this remote
 * later ships v3, the host asks for exactly the same thing and gets v3 — with
 * no host change, because the host never knew the version in the first place.
 */

export const COMMAND_EVENT = 'skew-demo:command';
export const RESULT_EVENT = 'skew-demo:command-result';

export type RemoteAction =
  | 'write-v2-record'
  | 'read-record-as-v2'
  | 'read-parked-draft'
  | 'clear-record'
  /**
   * Contribute this build's migration chain — including its down direction —
   * to the page-wide schema registry, so the older host can read the v2
   * record it refused a step ago. The host names the intent; how much this
   * build knows (and therefore shares) is this build's business.
   */
  | 'register-schema';

export interface RemoteCommand {
  readonly id: string;
  readonly action: RemoteAction;
}

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
  readonly foundVersion?: number;
  readonly expectedVersion?: number;
  readonly fields?: readonly FieldChange[];
  readonly raw?: string;
  /**
   * The payload on each side of the cast, for the host's diff view. Plain
   * JSON values: they ride a CustomEvent within one page, so no serialization
   * step stands between the remote's result and what the host renders.
   */
  readonly before?: unknown;
  readonly after?: unknown;
  readonly derivedPaths?: readonly string[];
  readonly lossyPaths?: readonly string[];
}

export type CommandHandler = (
  action: RemoteAction,
) => Promise<Omit<RemoteResult, 'id'>>;

/**
 * Subscribes to host commands. Returns an unsubscribe function for the
 * component's `DestroyRef` — a listener that outlives the component would
 * answer on behalf of a component that no longer exists.
 */
export function listenForCommands(handle: CommandHandler): () => void {
  const onCommand = (event: Event): void => {
    const command = (event as CustomEvent<RemoteCommand>).detail;
    if (!command?.id) return;

    void handle(command.action)
      .catch((error: unknown) => ({
        ok: false,
        headline: 'The command threw',
        detail: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        globalThis.dispatchEvent(
          new CustomEvent<RemoteResult>(RESULT_EVENT, {
            detail: { ...result, id: command.id },
          }),
        );
      });
  };

  globalThis.addEventListener(COMMAND_EVENT, onCommand as EventListener);
  return () =>
    globalThis.removeEventListener(COMMAND_EVENT, onCommand as EventListener);
}
