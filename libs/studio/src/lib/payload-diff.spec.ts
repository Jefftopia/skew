import { describe, expect, it } from 'vitest';
import { diffPayloads, normalizePath } from './payload-diff.js';

/** The rendered shape of a line, for readable assertions. */
const render = (before: unknown, after: unknown, options = {}) =>
  diffPayloads(before, after, options).lines.map(
    (l) =>
      `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${'  '.repeat(l.indent)}${l.text}${
        l.tag ? ` «${l.tag}»` : ''
      }`,
  );

describe('diffPayloads', () => {
  it('leaves an unchanged payload entirely as context', () => {
    const value = { id: 'a', nested: { n: 1 } };
    const { lines, stats } = diffPayloads(value, structuredClone(value));

    expect(lines.every((l) => l.kind === 'same')).toBe(true);
    expect(stats).toEqual({ added: 0, removed: 0, derived: 0, lost: 0 });
  });

  it('pairs a promoted scalar with the structure that replaced it', () => {
    // The case a text diff gets wrong: one change, not four line edits.
    expect(
      render({ author: 'Ada' }, { author: { name: 'Ada', email: '' } }),
    ).toEqual([
      ' {',
      '-  "author": "Ada"',
      '+  "author": {',
      '+    "name": "Ada",',
      '+    "email": ""',
      '+  }',
      ' }',
    ]);
  });

  it('keeps keys in the order the writer used, with additions where introduced', () => {
    const lines = render({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 });
    expect(lines).toEqual([' {', '   "a": 1,', '   "b": 2,', '+  "c": 3', ' }']);
  });

  it('marks values the migration guessed rather than carried', () => {
    const { lines, stats } = diffPayloads(
      { body: 'text' },
      { body: 'text', summary: 'text' },
      { derivedPaths: ['summary'] },
    );

    expect(lines.find((l) => l.path === 'summary')?.tag).toBe('derived');
    expect(stats.derived).toBe(1);
  });

  it('marks a guessed value on the removed side too', () => {
    // Reconciling a migrated record against an authoritative one: the guess
    // is the thing being replaced, and saying so is the entire point of the
    // comparison.
    const { lines } = diffPayloads(
      { hqlaPct: 0 },
      { hqlaPct: 62.5 },
      { derivedPaths: ['hqlaPct'] },
    );

    expect(lines.find((l) => l.kind === 'del')?.tag).toBe('derived');
    expect(lines.find((l) => l.kind === 'add')?.tag).toBe('derived');
  });

  it('prefers "lost" over "derived" when a removed path is both', () => {
    const { lines } = diffPayloads(
      { gone: 1 },
      {},
      { derivedPaths: ['gone'], lossyPaths: ['gone'] },
    );
    expect(lines.find((l) => l.path === 'gone')?.tag).toBe('lost');
  });

  it('marks values a downgrade could not carry', () => {
    const { stats, lines } = diffPayloads(
      { keep: 1, drop: 2 },
      { keep: 1 },
      { lossyPaths: ['drop'] },
    );

    expect(lines.find((l) => l.path === 'drop')?.tag).toBe('lost');
    expect(stats.lost).toBe(1);
  });

  it('tags every line inside a subtree that was dropped whole', () => {
    const { lines } = diffPayloads(
      { classification: { assetClass: 'Equity', strategy: 'Growth' } },
      {},
      { lossyPaths: ['classification'] },
    );

    const removed = lines.filter((l) => l.kind === 'del');
    expect(removed.length).toBeGreaterThan(1);
    expect(removed.every((l) => l.tag === 'lost')).toBe(true);
  });

  it('does NOT tag a parent whose child alone was lost', () => {
    // `author` survives as a bare string; only `author.email` is dropped.
    // Marking the object "cannot be carried" would tell the reader the
    // opposite of what happened.
    const { lines } = diffPayloads(
      { author: { name: 'Ada', email: 'ada@example.org' } },
      { author: 'Ada' },
      { lossyPaths: ['author.email'] },
    );

    const open = lines.find((l) => l.kind === 'del' && l.text.includes('"author": {'));
    const email = lines.find((l) => l.path === 'author.email');

    expect(open?.tag).toBeUndefined();
    expect(email?.tag).toBe('lost');
  });

  it('matches list-relative paths against a diff of one element', () => {
    // A list read reports `[].liquidity.hqlaPct`; the drill-down shows one
    // item. Same claim, different vantage point.
    const { lines, stats } = diffPayloads(
      { liquidity: { cashPct: 4.2, hqlaPct: 62.5 } },
      { cashPct: 4.2 },
      { lossyPaths: ['[].liquidity.hqlaPct'] },
    );

    expect(lines.find((l) => l.path === 'liquidity.hqlaPct')?.tag).toBe('lost');
    // cashPct survives (hoisted), so it must not be marked lost.
    expect(lines.find((l) => l.path === 'liquidity.cashPct')?.tag).toBeUndefined();
    expect(stats.lost).toBe(1);
  });

  it('matches a wildcard element path against every concrete index', () => {
    const before = { holdings: [{ t: 'AAPL', tier: 'T1' }, { t: 'MSFT', tier: 'T1' }] };
    const after = { holdings: [{ t: 'AAPL' }, { t: 'MSFT' }] };

    const { stats } = diffPayloads(before, after, {
      lossyPaths: ['holdings[].tier'],
    });

    expect(stats.lost).toBe(2);
  });

  it('diffs array elements positionally', () => {
    const { stats } = diffPayloads({ xs: [1, 2] }, { xs: [1, 3] });
    expect(stats).toMatchObject({ added: 1, removed: 1 });
  });

  it('handles a value appearing from nothing', () => {
    expect(render(undefined, { a: 1 })).toEqual(['+{', '+  "a": 1', '+}']);
  });
});

describe('normalizePath', () => {
  it('collapses concrete indices to the wildcard form', () => {
    expect(normalizePath('holdings[12].marketValue.currency')).toBe(
      'holdings[].marketValue.currency',
    );
  });

  it('leaves paths without indices alone', () => {
    expect(normalizePath('liquidity.hqlaPct')).toBe('liquidity.hqlaPct');
  });
});
