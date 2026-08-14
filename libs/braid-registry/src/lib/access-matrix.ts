import { canFetch, canList } from '@skewkit/braid-gateway';
import type { FragmentManifest, Principal, ResolvedFragmentManifest } from '@skewkit/braid-gateway';

/**
 * Who can see and load what, and what a proposed change would do to that.
 *
 * `satisfies()` is a pure function of a rule and a principal, so the effect of an access change is
 * *exactly* computable — no sampling, no observation. What is not available is a list of real
 * users: the gateway holds no principal directory, and inventing one would make this look
 * authoritative when it is not.
 *
 * So the operator names the principals to test against. That is honest about its inputs and still
 * catches the change that matters — a fragment quietly ceasing to be listed for the people who
 * use it.
 */
export interface NamedPrincipal extends Principal {
  /** How this principal is labelled in output. */
  name: string;
}

/** `absent` distinguishes "the fragment is not there" from "it is there and denied". */
export type AccessOutcome = 'allowed' | 'denied' | 'absent';

export type AccessAction = 'list' | 'fetch';

export interface AccessCell {
  principal: string;
  before: AccessOutcome;
  after: AccessOutcome;
  changed: boolean;
}

export interface AccessRow {
  fragmentId: string;
  action: AccessAction;
  cells: AccessCell[];
  changed: boolean;
}

/** One principal losing or gaining one capability on one fragment. */
export interface AccessTransition {
  fragmentId: string;
  action: AccessAction;
  principal: string;
  from: AccessOutcome;
  to: AccessOutcome;
}

export interface AccessMatrix {
  principals: string[];
  rows: AccessRow[];
  /**
   * Access that went away. **This is the output that matters** — the matrix is context for it.
   * A gain is usually intended and visible in the diff; a loss is how a fragment disappears for
   * the people who needed it, and it is invisible in a diff that shows one changed line.
   */
  losses: AccessTransition[];
  gains: AccessTransition[];
  /** True when no principal's access changed at all. */
  unchanged: boolean;
}

/** The principal every registry should be checked against, whatever else it is checked against. */
export const ANONYMOUS: NamedPrincipal = { name: 'anonymous' };

/**
 * Computes the access matrix for `manifests`, optionally as a delta against `before`.
 *
 * With no `before`, every cell's before and after are the same and nothing is reported as changed —
 * that is the "who can see what today" view. With a `before`, the interesting output is
 * {@link AccessMatrix.losses}.
 *
 * Rows cover the union of both sides, so a fragment that was *removed* still gets a row with
 * `after: 'absent'`. Losing access by deletion is still losing access, and an operator scanning
 * this should not have to cross-reference the diff to notice.
 */
export function accessMatrix(
  manifests: readonly FragmentManifest[],
  principals: readonly NamedPrincipal[] = [ANONYMOUS],
  before?: readonly FragmentManifest[],
): AccessMatrix {
  const afterById = index(manifests);
  const beforeById = before ? index(before) : afterById;

  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
  const rows: AccessRow[] = [];
  const losses: AccessTransition[] = [];
  const gains: AccessTransition[] = [];

  for (const fragmentId of ids) {
    for (const action of ['list', 'fetch'] as const) {
      const cells: AccessCell[] = principals.map((principal) => {
        const from = outcome(beforeById.get(fragmentId), action, principal);
        const to = outcome(afterById.get(fragmentId), action, principal);
        return { principal: principal.name, before: from, after: to, changed: from !== to };
      });

      for (const cell of cells) {
        if (!cell.changed) continue;
        const transition: AccessTransition = {
          fragmentId,
          action,
          principal: cell.principal,
          from: cell.before,
          to: cell.after,
        };

        // Classified by what happened to *access*, not merely by what changed. A cell moving
        // `denied → absent` changed, and is neither a gain nor a loss: nobody could do it before
        // and nobody can now. Treating "not previously allowed" as a gain would announce that
        // deleting a fragment granted people access to it.
        if (cell.before === 'allowed' && cell.after !== 'allowed') losses.push(transition);
        else if (cell.after === 'allowed' && cell.before !== 'allowed') gains.push(transition);
      }

      rows.push({ fragmentId, action, cells, changed: cells.some((cell) => cell.changed) });
    }
  }

  return {
    principals: principals.map((principal) => principal.name),
    rows,
    losses,
    gains,
    unchanged: losses.length === 0 && gains.length === 0,
  };
}

/**
 * Evaluates one capability, using the gateway's own predicates rather than a copy of them.
 *
 * `canList`/`canFetch` are what actually gate a request, so calling them is the difference between
 * reporting the rules and reporting the behavior. A reimplementation here would be correct until
 * the day the gateway's changed and this did not.
 *
 * Deliberately **not** normalized first. `normalizeManifest` rejects a manifest with no endpoint,
 * and this runs while someone is still typing one — an editor that crashed on a half-written
 * fragment would be useless exactly when it is being used. The predicates read only `access`, so
 * the defaults normalization would supply are irrelevant here; a manifest that is invalid for
 * other reasons is `validateRegistry`'s finding to report, not this one's to throw on.
 */
function outcome(
  manifest: FragmentManifest | undefined,
  action: AccessAction,
  principal: Principal,
): AccessOutcome {
  if (!manifest) return 'absent';

  const resolved = manifest as ResolvedFragmentManifest;
  const allowed = action === 'list' ? canList(resolved, principal) : canFetch(resolved, principal);
  return allowed ? 'allowed' : 'denied';
}

function index(manifests: readonly FragmentManifest[]): Map<string, FragmentManifest> {
  return new Map(manifests.filter((manifest) => manifest.id).map((manifest) => [manifest.id, manifest]));
}

/**
 * Parses `name:roles=a,b;scopes=c` into a principal.
 *
 * The shape a CLI flag can carry. `anonymous` (or a bare name) is a principal holding nothing,
 * which is the one every registry should be checked against.
 */
export function parsePrincipal(spec: string): NamedPrincipal {
  const [name, ...rest] = spec.split(':');
  const attributes = rest.join(':');
  const principal: NamedPrincipal = { name: (name ?? '').trim() || 'anonymous' };

  for (const part of attributes.split(';')) {
    const [key, value] = part.split('=');
    const values = (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (values.length === 0) continue;
    if (key?.trim() === 'roles') principal.roles = values;
    if (key?.trim() === 'scopes') principal.scopes = values;
  }

  return principal;
}
