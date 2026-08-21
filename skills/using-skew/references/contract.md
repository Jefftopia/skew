# @braid/contract — data-driven contract documents

The `ahead` failure — data written by a newer build than the reader — is the
one failure a code-shipped migration chain can never fix: the reader was built
before the knowledge existed. But **an API is always at least as new as the
newest data it serves**, so the origin publishes its migration history as a
*document*, and consumers — including ones built before the newest version
existed — fetch it, interpret it, and migrate in either direction. No client
redeploy.

## The document

Served at `GET /.well-known/skew/contracts/:name`:

```jsonc
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
whitelist — `rename`, `move`, `wrap`, `hoist`, `map`, `default`, `drop`,
`convert`, `const` — and **each op knows its inverse**, so declaring the up
migration buys the down migration. `derivedPaths` (guessed fields) and
`lossyPaths` (discarded fields) are *computed* from the ops, not
hand-annotated.

Steps a document cannot express are declared `"code": "derive-summary"` — the
*name* of an implementation the consuming bundle supplies via `codeSteps`. A
consumer without the implementation degrades loudly with `gap`, never a guess.
**A contract accumulating `code` steps is a signal the change wanted a new
resource, not a new version.**

## Consuming

```ts
import {
  versionedFromContract,
  createContractResolver,
  wellKnownContractUrl,
} from '@braid/contract';

// Drop-in replacement for a hand-maintained versioned().next() chain:
const FundSchema = versionedFromContract<FundV2>(fundContract);

// A build pinned below current still learns the newer steps — they feed the
// shared registry, which read() consults to downgrade newer data:
const FundSchemaV1 = versionedFromContract<FundV1>(fundContract, { at: 1 });

// Reads exactly like schema.read(); the difference only appears on `ahead`:
// fetch the contract, learn the newer steps, read a downgraded projection.
const resolver = createContractResolver();
const url = wellKnownContractUrl(API_BASE, 'portfolio-fund');
const result = await resolver.readResolving(FundSchemaV1, body, url);

if (result.ok && result.downgradedFrom) {
  // honest, lossy, and labeled: result.lossyPaths names what v1 cannot carry
}
```

Type parameters (`FundV1`, `FundV2`) come from generated frozen types — see
"Codegen" below. Never hand-write them against live app interfaces.

## Serving (any Node server)

`@braid/contract` is framework-free; serving is a tiny controller. Use the
contract fingerprint as the ETag so unchanged contracts cost a 304:

```ts
import { contractFingerprint } from '@braid/contract';

// NestJS shown; the same logic is a few lines of Express.
@Controller('.well-known/skew/contracts')
export class ContractsController {
  private readonly documents = new Map([[FUND_CONTRACT.name, FUND_CONTRACT]]);

  @Get(':name')
  one(@Param('name') name: string, @Headers('if-none-match') inm: string | undefined,
      @Res({ passthrough: true }) res: Response) {
    const doc = this.documents.get(name);
    if (!doc) throw new NotFoundException(`no contract "${name}" published here`);
    const etag = `"${contractFingerprint(doc)}"`;
    res.setHeader('etag', etag);
    res.setHeader('cache-control', 'no-cache');
    if (inm === etag) { res.status(304); return undefined; }
    return doc;
  }
}
```

Responses that carry versioned bodies should also send the `skew-contract`
header (`formatSkewContractHeader` from `@braid/skew`) pointing at the
contract, so clients discover the URL without hardcoding it.

## Codegen — frozen types from the document

```sh
skew-contract gen --in contracts/portfolio-fund.json \
                  --out src/generated/portfolio-fund.contract.ts
```

Emits one frozen interface per documented version plus the document as a typed
const. This retires the hardest rule in schema versioning — "never edit a past
version's interface" — by making the document the only source. Regenerate on
every contract change; check the output in. Flags: `--type-prefix`,
`--const-name`. See build.md.

## Trust model

- Fetched from the same origin whose data you already trust.
- Carries no executable code (closed op whitelist).
- Cached with ETag revalidation — a stale copy still beats none when the
  origin is unreachable.
- Pin by content fingerprint (`pinnedFingerprints`) when the deployment
  pipeline knows exactly which contract it was built against.

## Evolving a contract safely

1. Append a new step (`from: N, to: N+1`); bump `current`; add the new
   version's JSON Schema under `schemas`.
2. Never edit or reorder existing steps or past schemas — data written under
   them decodes through them forever. A wrong past step gets a *correcting*
   appended step.
3. Prefer whitelist ops; reach for a `code` step only for genuinely semantic
   transforms, and ship its implementation in every consumer that must cross
   that step.
4. Regenerate frozen types (`skew-contract gen`) and commit them together with
   the document.
