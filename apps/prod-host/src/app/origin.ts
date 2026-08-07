/**
 * Which manifest the version probe is pointed at.
 *
 * Both files are produced by real `skew-stamp` runs against real build output;
 * `skew-manifest-rollback.json` describes an *older* deployment of this same
 * app. Serving it is what a CDN does when it is still holding an entry document
 * from before the last deploy, and what a load balancer does mid-rollback while
 * some nodes have been reverted and others have not.
 *
 * The query parameter selects between two genuine artifacts. Nothing here fakes
 * a response — the probe performs a real fetch either way.
 */
export function manifestUrl(): string {
  const stale =
    new URLSearchParams(globalThis.location?.search ?? '').get('origin') ===
    'rollback';
  return stale ? '/skew-manifest-rollback.json' : '/skew-manifest.json';
}

export function originIsRolledBack(): boolean {
  return manifestUrl().includes('rollback');
}
