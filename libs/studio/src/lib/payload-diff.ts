/**
 * A structural diff of one payload against another, in the vocabulary the
 * migration itself uses.
 *
 * This is the engine behind the demo's payload view and behind Studio's
 * drill-down: click a trace event, get the record it carried, before and
 * after. It is deliberately pure and framework-free — the renderer is a
 * dozen lines of template in whatever framework is asking, and every caller
 * should agree about what a change *is*.
 *
 * Two decisions worth knowing, because both are wrong in the obvious
 * implementation:
 *
 * **Structural, not textual.** Running an LCS over two pretty-printed JSON
 * strings produces plausible garbage exactly when migrations are most
 * interesting — a promotion (`author` from a string to `{ name, email }`, or
 * `cashPct` moving into `liquidity.cashPct`) shows up as several unrelated
 * line edits, and the one change the reader needs to see is the one the diff
 * has dismantled. Walking both values by key path pairs each line with its
 * genuine counterpart.
 *
 * **Lines carry migration semantics.** A generic diff can say a line was
 * added. It cannot say the value was *guessed* — that the writer never
 * recorded it and the migration filled in the best answer available from an
 * older shape. That distinction is the whole reason `derivedPaths` and
 * `lossyPaths` exist on a result, and a plain red/green diff erases it.
 */

export type DiffLineKind = 'same' | 'add' | 'del';

/** Why a line is worth more than its `+`/`−`. */
export type DiffLineTag =
  /** The migration invented this value; the writer never recorded it. */
  | 'derived'
  /** The target version has nowhere to carry this, so a downgrade drops it. */
  | 'lost';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Nesting depth, for the renderer to indent by. */
  readonly indent: number;
  /** The line's JSON text, without indentation. */
  readonly text: string;
  /** Dot/bracket path of the value this line belongs to. */
  readonly path: string;
  readonly tag?: DiffLineTag;
}

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
  readonly derived: number;
  readonly lost: number;
}

export interface PayloadDiff {
  readonly lines: readonly DiffLine[];
  readonly stats: DiffStats;
}

export interface DiffOptions {
  /** `derivedPaths` from a read result: values the migration guessed. */
  readonly derivedPaths?: readonly string[];
  /** `lossyPaths` from a read result: values a downgrade discarded. */
  readonly lossyPaths?: readonly string[];
}

/**
 * Diffs two payloads.
 *
 * `before`/`after` are plain JSON values — pass the payload, not the
 * envelope, so paths line up with the paths a result reports.
 */
export function diffPayloads(
  before: unknown,
  after: unknown,
  options: DiffOptions = {},
): PayloadDiff {
  const raw: DiffLine[] = [];
  walk(null, before, after, '', 0, true, raw);

  const derivedPaths = options.derivedPaths ?? [];
  const lossyPaths = options.lossyPaths ?? [];

  let added = 0;
  let removed = 0;
  let derived = 0;
  let lost = 0;

  const lines = raw.map((line) => {
    // `lost` only ever describes something being removed. `derived` can land
    // on either side, because "this value is a guess" is a claim about the
    // value, not about the direction it is travelling: a migration adds a
    // guessed field going up, and a reconciliation against an authoritative
    // record *removes* the guessed one it had been carrying.
    const tag: DiffLineTag | undefined =
      line.kind === 'del' && covers(lossyPaths, line.path)
        ? 'lost'
        : line.kind !== 'same' && covers(derivedPaths, line.path)
          ? 'derived'
          : undefined;

    if (line.kind === 'add') added++;
    if (line.kind === 'del') removed++;
    if (tag === 'derived') derived++;
    if (tag === 'lost') lost++;

    return tag ? { ...line, tag } : line;
  });

  return { lines, stats: { added, removed, derived, lost } };
}

/**
 * True when `path` is one of the tagged paths, or sits inside one.
 *
 * Deliberately one-directional. Tagging a parent because one of its children
 * is lossy reads as a lie: when `author` is promoted from `{ name, email }`
 * to a bare string, `author.email` is genuinely lost but `author` itself
 * survives — marking the whole object "cannot be carried" tells the reader
 * the opposite of what happened. A subtree that really is dropped whole
 * arrives with the parent path in the list, and every line under it is then
 * tagged by the `startsWith` case.
 */
function covers(paths: readonly string[], path: string): boolean {
  const line = normalizePath(path);
  return paths.some((raw) => {
    const tagged = normalizePath(raw);
    // A read of a *list* reports paths against the list
    // (`[].liquidity.hqlaPct`) while a diff often shows one element of it.
    // Try the path as given and with that leading hop removed, so one result
    // annotates either view without the caller rewriting its own paths.
    const candidates = tagged.startsWith('[].')
      ? [tagged, tagged.slice(3)]
      : [tagged];
    return candidates.some((p) => p === line || line.startsWith(`${p}.`));
  });
}

/**
 * Array indices collapse to `[]` on both sides before matching, because the
 * two sides count differently on purpose: a result says "every holding loses
 * its liquidityTier" (`holdings[].liquidityTier`) while a diff line is about
 * one specific holding (`holdings[3].liquidityTier`). Same claim, and only
 * one of them can be written per element.
 */
export function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

// --- walking ---------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function format(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function label(key: string | null): string {
  return key === null ? '' : `${JSON.stringify(key)}: `;
}

function child(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/** Emits an entire value as one-sided lines — a wholly added or removed key. */
function emit(
  kind: Exclude<DiffLineKind, 'same'>,
  key: string | null,
  value: unknown,
  path: string,
  indent: number,
  last: boolean,
  out: DiffLine[],
): void {
  const comma = last ? '' : ',';
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    out.push({ kind, indent, text: `${label(key)}{`, path });
    keys.forEach((k, i) =>
      emit(kind, k, value[k], child(path, k), indent + 1, i === keys.length - 1, out),
    );
    out.push({ kind, indent, text: `}${comma}`, path });
    return;
  }
  if (Array.isArray(value)) {
    out.push({ kind, indent, text: `${label(key)}[`, path });
    value.forEach((v, i) =>
      emit(kind, null, v, `${path}[${i}]`, indent + 1, i === value.length - 1, out),
    );
    out.push({ kind, indent, text: `]${comma}`, path });
    return;
  }
  out.push({ kind, indent, text: `${label(key)}${format(value)}${comma}`, path });
}

function emitSame(
  key: string | null,
  value: unknown,
  path: string,
  indent: number,
  last: boolean,
  out: DiffLine[],
): void {
  const comma = last ? '' : ',';
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    out.push({ kind: 'same', indent, text: `${label(key)}{`, path });
    keys.forEach((k, i) =>
      emitSame(k, value[k], child(path, k), indent + 1, i === keys.length - 1, out),
    );
    out.push({ kind: 'same', indent, text: `}${comma}`, path });
    return;
  }
  if (Array.isArray(value)) {
    out.push({ kind: 'same', indent, text: `${label(key)}[`, path });
    value.forEach((v, i) =>
      emitSame(null, v, `${path}[${i}]`, indent + 1, i === value.length - 1, out),
    );
    out.push({ kind: 'same', indent, text: `]${comma}`, path });
    return;
  }
  out.push({ kind: 'same', indent, text: `${label(key)}${format(value)}${comma}`, path });
}

/**
 * Walks both values in parallel, pairing by key rather than by line number.
 *
 * `undefined` marks "absent on this side", which is safe because JSON has no
 * undefined — a key that exists with an undefined value did not survive
 * serialization in the first place.
 */
function walk(
  key: string | null,
  before: unknown,
  after: unknown,
  path: string,
  indent: number,
  last: boolean,
  out: DiffLine[],
): void {
  const comma = last ? '' : ',';

  if (before === undefined && after === undefined) return;
  if (before === undefined) {
    emit('add', key, after, path, indent, last, out);
    return;
  }
  if (after === undefined) {
    emit('del', key, before, path, indent, last, out);
    return;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    // Before's key order first, then keys only after has — an unchanged
    // record reads in its original order, and additions land where they were
    // introduced rather than being alphabetised into the middle of it.
    const keys = [
      ...Object.keys(before),
      ...Object.keys(after).filter((k) => !(k in before)),
    ];
    out.push({ kind: 'same', indent, text: `${label(key)}{`, path });
    keys.forEach((k, i) =>
      walk(k, before[k], after[k], child(path, k), indent + 1, i === keys.length - 1, out),
    );
    out.push({ kind: 'same', indent, text: `}${comma}`, path });
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    out.push({ kind: 'same', indent, text: `${label(key)}[`, path });
    for (let i = 0; i < length; i++) {
      walk(null, before[i], after[i], `${path}[${i}]`, indent + 1, i === length - 1, out);
    }
    out.push({ kind: 'same', indent, text: `]${comma}`, path });
    return;
  }

  if (JSON.stringify(before) === JSON.stringify(after)) {
    // Unchanged, but possibly a whole subtree that moved wholesale, so print
    // it rather than collapsing it to one line.
    emitSame(key, after, path, indent, last, out);
    return;
  }

  // Both sides describe the same key, so they share its position: a replaced
  // final key must not sprout a trailing comma on the removed line only.
  emit('del', key, before, path, indent, last, out);
  emit('add', key, after, path, indent, last, out);
}
