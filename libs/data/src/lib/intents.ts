import type { VersionedSchema } from '@braidlabs/skew';

/**
 * Intents: "somebody handle this", and deciding who.
 *
 * The FDC3 shape, with the resolution question answered honestly. FDC3's answer is a resolver UI,
 * which is *one* policy — and the wrong one for most internal software, where two candidates usually
 * means one is a newer deployment of the other and nobody wants to be asked.
 *
 * The part that is ours rather than FDC3's: **a handler that cannot read the payload is not a
 * candidate.** Version eligibility is decided before resolution, not discovered during it, so a user
 * is never offered a handler that will fail — and an automatic policy never picks one.
 */

export interface IntentHandlerOptions<T = unknown> {
  /** The contract version this handler accepts. It is excluded if the payload cannot reach it. */
  as?: number;
  /** Ranks candidates for the `'first'` policy and for a resolver. Higher wins; defaults to 0. */
  priority?: number;
  signal?: AbortSignal;
  /** For diagnostics and for a chooser UI. Defaults to the bus's consumer name. */
  label?: string;
  handler: (payload: T) => unknown | Promise<unknown>;
}

export interface IntentCandidate {
  intent: string;
  /** Which application registered it. */
  consumer: string;
  label: string;
  priority: number;
  /** The contract version it reads the payload at. */
  as?: number;
}

/**
 * How to choose between handlers.
 *
 * `'first'` is the default because it is deterministic and it is what an internal deployment wants;
 * `'ask'` is FDC3's behaviour and needs the host to render something, so it arrives as a callback the
 * shell supplies rather than as UI this package owns.
 */
export type ResolvePolicy =
  | 'first'
  | 'all'
  | 'ask'
  | ((candidates: readonly IntentCandidate[], payload: unknown) => IntentCandidate | Promise<IntentCandidate>);

export interface RaiseOptions {
  resolve?: ResolvePolicy;
  /** Required when `resolve` is `'ask'`: the shell's chooser. */
  chooser?: (candidates: readonly IntentCandidate[], payload: unknown) => Promise<IntentCandidate>;
}

export interface IntentResult<R = unknown> {
  /** Every handler that ran, in the order it ran. */
  handled: { candidate: IntentCandidate; result: R }[];
  /** Candidates excluded because they could not read the payload at their declared version. */
  ineligible: { candidate: IntentCandidate; reason: string }[];
}

export class NoIntentHandlerError extends Error {
  constructor(
    readonly intent: string,
    readonly ineligible: readonly { candidate: IntentCandidate; reason: string }[],
  ) {
    const excluded = ineligible.length
      ? ` ${ineligible.length} handler(s) were excluded: ${ineligible.map((entry) => `${entry.candidate.consumer} (${entry.reason})`).join(', ')}`
      : '';
    super(`[skew/data] nothing can handle the intent "${intent}".${excluded}`);
    this.name = 'NoIntentHandlerError';
  }
}

interface Registration extends IntentCandidate {
  run: (payload: unknown) => unknown | Promise<unknown>;
}

export interface IntentRegistry {
  addIntentListener<T>(intent: string, options: IntentHandlerOptions<T>): () => void;
  raiseIntent<R = unknown>(intent: string, payload: unknown, options?: RaiseOptions): Promise<IntentResult<R>>;
  /** Who could handle this intent right now, for a launcher or a chooser. */
  candidates(intent: string, payload?: unknown): { eligible: IntentCandidate[]; ineligible: IntentCandidate[] };
}

export interface IntentRegistryOptions {
  consumer: string;
  /** Resolves the contract for an intent's payload, so eligibility can be decided. */
  schemaFor: (intent: string) => VersionedSchema<unknown> | undefined;
  onEventError?: (message: string, detail?: unknown) => void;
}

export function createIntentRegistry(options: IntentRegistryOptions): IntentRegistry {
  const registrations = new Map<string, Set<Registration>>();

  /**
   * Whether a handler can be handed this payload.
   *
   * Decided from the declared chain rather than by attempting the projection, so the answer does not
   * depend on a payload being present — `candidates()` has to work for a launcher with nothing in
   * hand.
   */
  function eligibility(registration: Registration): { ok: true } | { ok: false; reason: string } {
    const schema = options.schemaFor(registration.intent);
    if (!schema || registration.as === undefined || registration.as === schema.version) return { ok: true };

    if (registration.as > schema.version) {
      return { ok: false, reason: `reads v${registration.as}, the payload is v${schema.version}` };
    }

    const missing = schema.steps
      .filter((step) => step.to > registration.as! && step.to <= schema.version && !step.down)
      .map((step) => `v${step.to}`);

    return missing.length === 0
      ? { ok: true }
      : { ok: false, reason: `v${registration.as} is unreachable — ${missing.join(', ')} declare no down migration` };
  }

  function project(intent: string, payload: unknown, as: number | undefined): unknown {
    const schema = options.schemaFor(intent);
    if (!schema || as === undefined || as === schema.version) return payload;
    return schema.write(payload, { as }).payload;
  }

  return {
    addIntentListener<T>(intent: string, handlerOptions: IntentHandlerOptions<T>): () => void {
      let forIntent = registrations.get(intent);
      if (!forIntent) {
        forIntent = new Set();
        registrations.set(intent, forIntent);
      }

      const registration: Registration = {
        intent,
        consumer: options.consumer,
        label: handlerOptions.label ?? options.consumer,
        priority: handlerOptions.priority ?? 0,
        ...(handlerOptions.as === undefined ? {} : { as: handlerOptions.as }),
        run: handlerOptions.handler as (payload: unknown) => unknown,
      };
      forIntent.add(registration);

      const unsubscribe = () => void forIntent.delete(registration);
      handlerOptions.signal?.addEventListener('abort', unsubscribe, { once: true });
      return unsubscribe;
    },

    candidates(intent: string) {
      const eligible: IntentCandidate[] = [];
      const ineligible: IntentCandidate[] = [];

      for (const registration of registrations.get(intent) ?? []) {
        (eligibility(registration).ok ? eligible : ineligible).push(strip(registration));
      }

      // Ranked here so every policy — and every chooser the host renders — sees one order.
      eligible.sort((a, b) => b.priority - a.priority);
      return { eligible, ineligible };
    },

    async raiseIntent<R>(intent: string, payload: unknown, raiseOptions?: RaiseOptions): Promise<IntentResult<R>> {
      const policy = raiseOptions?.resolve ?? 'first';
      const all = [...(registrations.get(intent) ?? [])];

      const eligible: Registration[] = [];
      const ineligible: { candidate: IntentCandidate; reason: string }[] = [];

      for (const registration of all) {
        const verdict = eligibility(registration);
        if (verdict.ok) eligible.push(registration);
        else ineligible.push({ candidate: strip(registration), reason: verdict.reason });
      }

      eligible.sort((a, b) => b.priority - a.priority);

      if (eligible.length === 0) throw new NoIntentHandlerError(intent, ineligible);

      const run = async (registration: Registration) => ({
        candidate: strip(registration),
        result: (await registration.run(project(intent, payload, registration.as))) as R,
      });

      if (policy === 'all') {
        // Sequential, so handlers that touch the same records do so in a defined order — the same
        // reason the outbox drains one at a time.
        const handled: { candidate: IntentCandidate; result: R }[] = [];
        for (const registration of eligible) handled.push(await run(registration));
        return { handled, ineligible };
      }

      let chosen: Registration | undefined;

      if (policy === 'first') {
        chosen = eligible[0];
      } else if (policy === 'ask') {
        if (!raiseOptions?.chooser) {
          throw new TypeError(
            "[skew/data] resolve: 'ask' needs a `chooser` — which handler a user picks is a question " +
              'for the shell that can render it, not for this package.',
          );
        }
        const picked = await raiseOptions.chooser(eligible.map(strip), payload);
        chosen = eligible.find((candidate) => matches(candidate, picked));
      } else {
        const picked = await policy(eligible.map(strip), payload);
        chosen = eligible.find((candidate) => matches(candidate, picked));
      }

      if (!chosen) {
        // A resolver that returns something not in the list is a bug in the resolver, and guessing
        // would run a handler nobody selected.
        throw new Error(`[skew/data] the resolver for "${intent}" returned a candidate that is not eligible`);
      }

      return { handled: [await run(chosen)], ineligible };
    },
  };
}

const strip = (registration: Registration): IntentCandidate => ({
  intent: registration.intent,
  consumer: registration.consumer,
  label: registration.label,
  priority: registration.priority,
  ...(registration.as === undefined ? {} : { as: registration.as }),
});

const matches = (registration: Registration, candidate: IntentCandidate): boolean =>
  registration.consumer === candidate.consumer &&
  registration.label === candidate.label &&
  registration.priority === candidate.priority &&
  registration.as === candidate.as;
