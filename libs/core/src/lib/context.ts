/**
 * The context handed to every migration function.
 *
 * Migrations must be deterministic: the same input must produce the same
 * output, or replays, tests, memoization, and fingerprinting all quietly
 * break. Anything a migration needs from the outside world therefore arrives
 * through this context — never through `new Date()` or `Math.random()` inside
 * the migration body — so a test (or a replay) can pin it.
 */
export interface MigrationContext {
  /**
   * The clock. A migration that needs "now" (an `asOf` stamp, a derived
   * timestamp) must take it from here so two runs over the same input can be
   * made to agree.
   */
  now(): Date;
  /**
   * A stable seed for anything that must be unique-but-reproducible — a
   * derived idempotency key, a placeholder reference. Callers that retry a
   * migration (an outbox, a replay) pass the same seed each attempt so the
   * derived value stays identical across attempts.
   */
  readonly seed?: string;
}

/** The context used when a caller supplies none: the real clock, no seed. */
export const defaultMigrationContext: MigrationContext = {
  now: () => new Date(),
};
