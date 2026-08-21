# `@braid/contract`

Data-driven schema migrations: the API that owns a contract **publishes its
history as a document**, and consumers — including consumers built before the
newest version existed — fetch it, interpret it, and migrate in either
direction. No client redeploy required.

```jsonc
// GET /.well-known/skew/contracts/portfolio-fund
{
  "skewContract": "1",
  "name": "portfolio-fund",
  "current": 2,
  "steps": [
    {
      "from": 1, "to": 2,
      "description": "promote scalars to structure; add liquidity fields",
      "ops": [
        { "rename": { "from": "currency", "to": "baseCurrency" } },
        { "wrap": { "path": "nav", "key": "amount", "also": { "asOf": { "$now": true } } } },
        { "move": { "from": "cashPct", "to": "liquidity.cashPct" } },
        { "default": { "path": "liquidity.hqlaPct", "value": 0 } }
      ]
    }
  ],
  "schemas": { "1": { /* JSON Schema */ }, "2": { /* JSON Schema */ } }
}
```

Nothing in a document is executable. Ops are interpreted against a closed
whitelist (`rename`, `move`, `wrap`, `hoist`, `map`, `default`, `drop`,
`convert`, `const`), and each op knows its inverse — so declaring the up
migration buys the down migration, with the guessed fields (`derivedPaths`)
and the discarded ones (`lossyPaths`) computed rather than hand-annotated.

## Why this exists

The `ahead` failure — data written by a newer build than the reader — is the
one failure a code-shipped migration chain can never fix: the reader was built
before the knowledge existed. But **an API is always at least as new as the
newest data it serves.** So the origin that produced the too-new data can also
serve the document that explains it:

```ts
import { createContractResolver, wellKnownContractUrl } from '@braid/contract';

const resolver = createContractResolver();
const url = wellKnownContractUrl(API_BASE, 'portfolio-fund');

// Reads exactly like schema.read(); the difference only appears on `ahead`:
// fetch the contract, learn the newer steps, read a downgraded projection.
const result = await resolver.readResolving(FundSchemaV1, body, url);
if (result.ok && result.downgradedFrom) {
  // honest, lossy, and labeled: result.lossyPaths names what v1 cannot carry
}
```

## Building schemas from a document

```ts
import { versionedFromContract } from '@braid/contract';

// Drop-in replacement for a hand-maintained versioned().next() chain:
const FundSchema = versionedFromContract<FundV2>(fundContract);

// A build pinned below current still learns the newer steps — they feed the
// shared registry, which is what read() consults to downgrade newer data:
const FundSchemaV1 = versionedFromContract<FundV1>(fundContract, { at: 1 });
```

Steps a document cannot express (semantic transforms) are declared as
`"code": "derive-summary"` — the *name* of an implementation the consuming
bundle ships via `codeSteps`. A consumer without the implementation degrades
loudly with `gap`, never with a guess. A contract accumulating `code` steps is
a signal the change wanted a new resource, not a new version.

## Frozen types, generated

`skew-contract gen` (in `@braid/build`) emits one frozen interface per
documented version plus the document as a typed const, which retires the
hardest rule in schema versioning — "never edit a past version's interface" —
by making the document the only source:

```sh
skew-contract gen --in contracts/portfolio-fund.json \
                  --out src/generated/portfolio-fund.contract.ts
```

## Trust model

A contract document is fetched from the same origin whose data you already
trust, carries no executable code, is cached with ETag revalidation (a stale
copy still beats none when the origin is unreachable), and can be pinned by
content fingerprint (`pinnedFingerprints`) when the deployment pipeline knows
exactly which contract it was built against.
