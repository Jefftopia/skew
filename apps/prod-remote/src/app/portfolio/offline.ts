/**
 * Simulated offline mode for the order-outbox scenario.
 *
 * Kept in `sessionStorage` (not a signal) for the same reason the protections
 * switch is: the flag must survive reloads mid-scenario, and both builds on
 * the page must agree about it. Only the demo's own `postOrder` consults it —
 * this does not intercept anything else's network traffic.
 */
const KEY = 'skew-demo:offline';

export function isSimulatedOffline(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setSimulatedOffline(offline: boolean): void {
  try {
    if (offline) sessionStorage.setItem(KEY, '1');
    else sessionStorage.removeItem(KEY);
  } catch {
    // sessionStorage unavailable — the toggle simply doesn't persist.
  }
}
