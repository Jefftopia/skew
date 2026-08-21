/**
 * ⚠️ NOT PUBLIC API. Undocumented on purpose. Do not use in an application.
 *
 * A process-wide switch that makes every `@braidlabs` package behave as though it
 * were not installed:
 *
 *   - stores write bare payloads and read them back with no envelope check,
 *     which is `JSON.parse(raw) as T` — an assertion, not a check
 *   - `versioned().read()` returns whatever it was handed, unmigrated
 *   - `lazy()` stops retrying
 *   - recovery stops classifying and takes no action
 *
 * ## Why this exists
 *
 * The demos need to show the failure modes these packages prevent, and the only
 * trustworthy way to show a failure is to actually produce one. A screenshot of
 * a hand-written "before" snippet proves nothing; running the same scenario
 * with the protections removed proves it exactly.
 *
 * ## Why it is not documented
 *
 * There is no legitimate production use. Every reason to reach for it — "just
 * while I debug this", "only in staging" — ends with a flag nobody remembers
 * set on a deployment nobody re-checks, and the failures it re-enables are
 * silent ones: a draft read at the wrong shape, a mutation replayed against a
 * contract that moved. Those surface as `undefined` in a renderer weeks later,
 * far from the switch that caused them.
 *
 * So it ships, because the demos are more valuable than the purity of the
 * export list, but it stays out of the README, out of the package docs, and out
 * of every example. If you found this by reading the source: that was the deal.
 * Turning it on logs a warning for the same reason.
 *
 * ## Why it is global mutable state
 *
 * `@braidlabs/skew` has no framework and no dependencies, so there is no injector to
 * read from. A module-level flag is the only mechanism available to it. The
 * Angular packages wrap this in `provideSkewDisabled()` so an application at
 * least *looks* like it is configuring something, but the state is here.
 *
 * One consequence worth knowing: under Module Federation this is per *bundle
 * instance*, so it only behaves as one switch when `@braidlabs/skew` is genuinely
 * shared as a singleton. Two copies of core means two flags.
 */

let disabled = false;

/** @internal Not public API — see the module comment. */
export function setSkewDisabled(next: boolean): void {
  if (next && !disabled) {
    console.warn(
      '[skew] PROTECTIONS DISABLED. Envelopes, migrations, retries and ' +
        'recovery are all inert. This is a demo/debugging switch and is not ' +
        'supported in production.',
    );
  }
  disabled = next;
}

/** @internal Not public API — see the module comment. */
export function isSkewDisabled(): boolean {
  return disabled;
}
