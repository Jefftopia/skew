# @braidlabs/studio

Inspection tooling for version skew. Framework-free, no dependencies.

This package is being built incrementally alongside the web debugger
described in [`docs/skew-studio-plan.md`](../../docs/plans/skew-studio-plan.md).
What ships today is its most reusable piece.

## `diffPayloads`

A structural diff of one payload against another, in the vocabulary the
migration itself uses.

```ts
import { diffPayloads } from '@braidlabs/studio';

const result = FundSchemaV1.read(body);           // or readResolving, or a store get

const { lines, stats } = diffPayloads(sentByServer, result.value, {
  derivedPaths: result.derivedPaths,              // values the migration guessed
  lossyPaths: result.lossyPaths,                  // values the target shape cannot carry
});
```

`lines` is a flat list of `{ kind, indent, text, path, tag? }` — render it
however you like; a `<pre>` and thirty lines of CSS is enough. `stats` gives
`{ added, removed, derived, lost }` for a header.

### Why not a text diff

Running an LCS over two pretty-printed JSON strings produces plausible
garbage exactly when migrations are most interesting. A promotion — `nav`
going from `128450000` to `{ amount, asOf }`, or `cashPct` moving into
`liquidity.cashPct` — comes out as several unrelated line edits, and the one
change the reader needed to see has been dismantled. Pairing lines by key
path keeps a promotion legible as a promotion.

### Why the tags matter

A generic diff can say a line was added. It cannot say the value was
*guessed*: that the writer never recorded it and the migration filled in the
best answer available from an older shape. That is the distinction
`derivedPaths` and `lossyPaths` exist to carry, and rendering them as
ordinary green and red throws it away.

- **`derived`** — the value is the migration's invention. It can appear on
  either side: a migration *adds* a guessed field going up, and a
  reconciliation against an authoritative record *removes* the guess it had
  been carrying.
- **`lost`** — only ever on a removed line: the older shape has nowhere to
  put this, so a downgrade drops it.

### Path matching

Two vantage points always disagree, and both are handled:

- A read of a **list** reports paths against the list
  (`[].liquidity.hqlaPct`) while a drill-down usually shows one element. The
  leading hop is optional when matching.
- A result says "every holding loses its tier" (`holdings[].liquidityTier`)
  while a line is about one holding (`holdings[3].liquidityTier`). Indices
  collapse to `[]` on both sides.

Tags propagate **parent → child only**. A subtree that was dropped whole
marks every line inside it; a parent whose child alone was lost is *not*
marked, because saying `author` "cannot be carried" when it survives as a
bare string tells the reader the opposite of what happened.
