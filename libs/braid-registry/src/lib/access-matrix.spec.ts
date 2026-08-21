import { describe, expect, it } from 'vitest';
import type { FragmentManifest } from '@braid/gateway';
import { accessMatrix, ANONYMOUS, parsePrincipal, type NamedPrincipal } from './access-matrix.js';

const trader: NamedPrincipal = { name: 'trader', roles: ['trader'] };
const ops: NamedPrincipal = { name: 'ops', roles: ['ops', 'admin'] };
const PRINCIPALS = [ANONYMOUS, trader, ops];

const open: FragmentManifest = { id: 'billing', endpoint: 'https://b.internal' };
const gatedFetch: FragmentManifest = { ...open, access: { fetch: { roles: ['trader'] } } };
const gatedList: FragmentManifest = { ...open, access: { list: { roles: ['ops'] } } };

const cell = (matrix: ReturnType<typeof accessMatrix>, id: string, action: string, principal: string) =>
  matrix.rows.find((row) => row.fragmentId === id && row.action === action)?.cells.find((c) => c.principal === principal);

describe('accessMatrix', () => {
  describe('current state', () => {
    it('reports everything allowed when nothing is restricted', () => {
      const matrix = accessMatrix([open], PRINCIPALS);

      expect(matrix.rows.every((row) => row.cells.every((c) => c.after === 'allowed'))).toBe(true);
      expect(matrix.unchanged).toBe(true);
    });

    it('separates list from fetch', () => {
      const matrix = accessMatrix([gatedFetch], PRINCIPALS);

      expect(cell(matrix, 'billing', 'list', 'anonymous')?.after).toBe('allowed');
      expect(cell(matrix, 'billing', 'fetch', 'anonymous')?.after).toBe('denied');
      expect(cell(matrix, 'billing', 'fetch', 'trader')?.after).toBe('allowed');
    });

    it('treats roles as any-of, matching the gateway', () => {
      const matrix = accessMatrix([{ ...open, access: { fetch: { roles: ['ops', 'nobody'] } } }], [ops]);

      expect(cell(matrix, 'billing', 'fetch', 'ops')?.after).toBe('allowed');
    });

    it('treats scopes as all-of, matching the gateway', () => {
      const partial: NamedPrincipal = { name: 'partial', scopes: ['billing:read'] };
      const manifest: FragmentManifest = {
        ...open,
        access: { fetch: { scopes: ['billing:read', 'billing:write'] } },
      };

      expect(cell(accessMatrix([manifest], [partial]), 'billing', 'fetch', 'partial')?.after).toBe('denied');
    });

    it('reports nothing changed when no before is given', () => {
      expect(accessMatrix([gatedFetch], PRINCIPALS).unchanged).toBe(true);
    });
  });

  describe('deltas', () => {
    it('reports a loss when a rule is tightened', () => {
      const matrix = accessMatrix([gatedFetch], PRINCIPALS, [open]);

      expect(matrix.losses).toEqual([
        { fragmentId: 'billing', action: 'fetch', principal: 'anonymous', from: 'allowed', to: 'denied' },
        { fragmentId: 'billing', action: 'fetch', principal: 'ops', from: 'allowed', to: 'denied' },
      ]);
      expect(matrix.gains).toEqual([]);
      expect(matrix.unchanged).toBe(false);
    });

    it('reports a gain when a rule is relaxed', () => {
      const matrix = accessMatrix([open], PRINCIPALS, [gatedFetch]);

      expect(matrix.losses).toEqual([]);
      expect(matrix.gains.map((g) => g.principal)).toEqual(['anonymous', 'ops']);
    });

    it('reports a removed fragment as a loss for everyone who could see it', () => {
      const matrix = accessMatrix([], PRINCIPALS, [open]);

      expect(matrix.losses).toHaveLength(6); // 3 principals x list + fetch
      expect(matrix.losses.every((loss) => loss.to === 'absent')).toBe(true);
    });

    it('keeps a row for a removed fragment rather than dropping it silently', () => {
      const matrix = accessMatrix([], PRINCIPALS, [open]);

      expect(cell(matrix, 'billing', 'list', 'trader')?.after).toBe('absent');
    });

    it('does not call removing a denied fragment a gain', () => {
      // `denied → absent` changed, but nobody could reach it before and nobody can now — reporting
      // it as a gain would announce that deleting a fragment granted access to it
      const restricted: FragmentManifest = { ...open, access: { fetch: { roles: ['nobody'] } } };
      const matrix = accessMatrix([], PRINCIPALS, [restricted]);

      expect(matrix.gains).toEqual([]);
      expect(matrix.losses.every((loss) => loss.action === 'list')).toBe(true);
    });

    it('reports an added fragment as a gain, not a loss', () => {
      const matrix = accessMatrix([open], PRINCIPALS, []);

      expect(matrix.losses).toEqual([]);
      expect(matrix.gains.every((gain) => gain.from === 'absent')).toBe(true);
    });

    it('distinguishes losing listing from losing loading', () => {
      const matrix = accessMatrix([gatedList], PRINCIPALS, [open]);

      expect(matrix.losses.map((loss) => loss.action)).toEqual(['list', 'list']);
      // still loadable by anyone holding a deep link — the two rules are independent
      expect(cell(matrix, 'billing', 'fetch', 'anonymous')?.after).toBe('allowed');
    });

    it('reports nothing when the change does not touch access', () => {
      const matrix = accessMatrix([{ ...open, title: 'Renamed' }], PRINCIPALS, [open]);

      expect(matrix.unchanged).toBe(true);
    });

    it('tolerates a half-written manifest, because it runs while someone is typing one', () => {
      const incomplete = [{ id: 'new-fragment', endpoint: '' }] as FragmentManifest[];

      expect(() => accessMatrix(incomplete, PRINCIPALS, [open])).not.toThrow();
      expect(accessMatrix(incomplete, PRINCIPALS)).toBeDefined();
    });

    it('defaults to checking anonymous, which every registry should be checked against', () => {
      expect(accessMatrix([open]).principals).toEqual(['anonymous']);
    });
  });
});

describe('parsePrincipal', () => {
  it('parses roles and scopes', () => {
    expect(parsePrincipal('trader:roles=trader,ops;scopes=orders:read')).toEqual({
      name: 'trader',
      roles: ['trader', 'ops'],
      scopes: ['orders:read'],
    });
  });

  it('treats a bare name as holding nothing', () => {
    expect(parsePrincipal('auditor')).toEqual({ name: 'auditor' });
  });

  it('falls back to anonymous for an empty name', () => {
    expect(parsePrincipal(':roles=x').name).toBe('anonymous');
  });

  it('ignores empty attribute lists rather than setting an empty array', () => {
    // an empty roles array would restrict nothing but read as though it restricted something
    expect(parsePrincipal('x:roles=')).toEqual({ name: 'x' });
  });
});
