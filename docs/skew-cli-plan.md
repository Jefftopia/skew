# Plan: `skew` CLI — migration codegen for servers and web apps

## Goal

A single CLI, `skew`, that generates the code both sides of a versioned
boundary need: the server that owns a contract (publish endpoint, registry,
header carriage) and the web apps that consume it (frozen types, pinned
schemas, resolver wiring) — plus an Angular schematics collection
(`ng add` / `ng generate`) so Angular apps get the wiring applied to their
source rather than pasted from a README.

Today `@skewkit/build` ships two narrow bins (`skew-stamp`, `skew-contract gen`).
This plan grows that into a coherent generator without breaking either.

## Non-goals

- No runtime behavior changes to `@skewkit/core` / `@skewkit/contract`.
- No framework lock-in: generated server code targets NestJS, Express, or a
  framework-agnostic handler (covers Firebase Functions, Lambda, etc.).
- No React generators yet (`@skewkit/react-*` doesn't exist); the target model
  below leaves room for them.

## Package layout

```
libs/
├── build/                      # @skewkit/build — grows the unified `skew` bin
│   └── src/
│       ├── bin/skew.ts         # new: `skew <command>`; skew-stamp/skew-contract stay as aliases
│       ├── lib/config.ts       # skew.config.json loader + validation
│       ├── lib/contract-scaffold.ts   # `contract new` / `contract bump`
│       ├── lib/contract-check.ts      # `contract check` (CI validator)
│       └── lib/gen/
│           ├── server-nest.ts
│           ├── server-express.ts
│           ├── server-handler.ts      # framework-agnostic (req → {status,headers,body})
│           └── client.ts              # pinned schemas + resolver wiring
└── schematics/                 # @skewkit/schematics — Angular collection (new lib)
    └── src/
        ├── collection.json
        ├── ng-add/
        ├── store/
        ├── workflow/
        └── contract-client/
```

Rationale: codegen that emits *text* lives in `@skewkit/build` (no Angular
dependency, usable from any repo); codegen that must *edit existing Angular
source* (app.config.ts, angular.json) lives in `@skewkit/schematics` on the
`@angular-devkit/schematics` runtime, which owns AST-safe edits, `ng add`
package installation, and dry-run semantics. The schematics call into
`@skewkit/build`'s generator functions for file contents so templates exist once.

## Workspace config: `skew.config.json`

Generation must be re-runnable and CI-checkable, so inputs live in a config
at the repo root rather than in flags someone has to remember:

```jsonc
{
  "contracts": [
    {
      "name": "portfolio-fund",
      "document": "contracts/portfolio-fund.json",
      "generate": {
        "types":  { "out": "src/generated/portfolio-fund.contract.ts" },
        "server": { "framework": "nest", "out": "apps/api/src/app/skew/" },
        "clients": [
          { "out": "apps/shell/src/app/generated/", "at": 1 }
        ]
      }
    }
  ],
  "stamp": { "out": "src/generated/build-id.ts", "manifest": "dist/browser/skew-manifest.json" }
}
```

`skew gen` with no args regenerates everything the config declares;
`skew gen --check` diffs instead of writing (CI mode).

## Command surface

| Command | What it generates / does |
|---|---|
| `skew init` | Detects project shape (Angular app, Nest/Express server, both), writes `skew.config.json`, creates `contracts/`, adds npm scripts (`skew:gen`, `skew:check`), prints next steps |
| `skew contract new <name>` | Scaffolds a v1 contract document. `--from-type <file>#<Interface>` infers the v1 JSON Schema from a TS interface (via the TS compiler API); `--from-sample <json>` infers from sample data |
| `skew contract bump <name>` | Appends a `from: N → to: N+1` step from op flags (`--rename a=b --default p=v …`), bumps `current`, stubs the new JSON Schema by applying the ops to the previous schema. Refuses to touch existing steps |
| `skew contract check` | CI gate: document schema-valid; ops on the whitelist; every step's `to` schema consistent with applying its ops to the `from` schema; `code` steps enumerated in output so reviewers see them; **past-step immutability** — compares step fingerprints against the git baseline (`--base origin/main`) and fails if any pre-existing step changed |
| `skew contract gen` | Existing frozen-types codegen, extended: `--all` from config, `--watch`, multi-contract |
| `skew gen server` | Server publish wiring (per framework, below) |
| `skew gen client` | Framework-neutral consumer module: `versionedFromContract` schemas (current + pinned `at` versions), `registerSchema` calls, `createContractResolver` singleton, `wellKnownContractUrl` constants, a typed `fetchResolving()` helper that applies `envelopeFromResponse` + the `skew-contract` header |
| `skew stamp` | Existing `skew-stamp` behavior, unchanged |
| `skew gen --check` | Regenerate-and-diff for CI |

### Server generation (`skew gen server`)

Three targets, one shared core. Generated code mirrors the proven
`apps/api` pattern (see `apps/api/src/app/portfolio/contracts.controller.ts`):

- **`handler`** (framework-agnostic, default): a pure
  `handleContractRequest(name, ifNoneMatch) → { status, headers, body }`
  plus a contract registry module (`Map` of documents). This is what
  Express/Fastify/Firebase-Functions adapters wrap, and it's trivially
  unit-testable.
- **`express`**: a `Router` mounting `/.well-known/skew/contracts/:name`
  over the handler.
- **`nest`**: a `SkewContractsModule` + controller, `@Res({ passthrough })`
  style, matching the demo controller.

All targets emit: ETag from `contractFingerprint(doc)`,
`cache-control: no-cache`, 304 on `if-none-match` match, 404 for unknown
names, and a `withSkewContractHeader(res, ref)` helper (from
`formatSkewContractHeader`) for stamping data responses with the contract
pointer. Also generated: a `serveManifest` handler for `skew-manifest.json`
with `Cache-Control: no-store`.

### Client generation (`skew gen client`)

Per contract, per consuming app:

```
generated/
├── <name>.contract.ts    # frozen types + typed document const (skew-contract gen)
└── <name>.client.ts      # schemas, resolver, fetch helper
```

`<name>.client.ts` exports `FundSchema` (current), `FundSchemaAtV1` (each
pinned `at` from config), and `readFund(res, body)` which resolves `ahead`
via `readResolving()` against the origin's well-known URL. Pinning exists so
an app that deliberately stays on an older shape still registers newer steps
into the shared registry (that's what makes downgraded reads possible).

## Angular schematics (`@skewkit/schematics`)

The "plugin": an Angular CLI collection, published so `ng add` works.

### `ng add @skewkit/schematics`

1. Installs chosen packages (`--packages router,data,workflow,core` prompt,
   defaults to `core,router`).
2. Adds `skew-stamp` to the app: `prebuild`/`prestart` npm scripts writing
   `src/generated/build-id.ts`, and a `postbuild` emitting the manifest into
   the browser output dir. (Option B, documented in the schematic's output:
   a thin builder `@skewkit/schematics:application` that wraps
   `@angular/build:application` and stamps before/after — offered behind
   `--use-builder` for teams that dislike npm-script hooks.)
3. AST-edits `app.config.ts`: inserts `provideSkewRecovery({ identity:
   BUILD_IDENTITY, manifestUrl: '/skew-manifest.json' })` and the import of
   the generated identity.
4. Adds `src/generated/` handling to `.gitignore` (with a comment offering
   the commit-it alternative) and prints the hosting note: serve
   `skew-manifest.json` with `Cache-Control: no-store`.

### Generators

- `ng g @skewkit/schematics:store <Name>` — frozen snapshot interface file, a
  `versioned<V1>('<name>')` schema, `createSkewStoreToken` +
  `provideSkewStore` provider function, and registration in `app.config.ts`.
- `ng g @skewkit/schematics:workflow <name> --steps a,b,c` — `defineWorkflow`
  scaffold with validated step map, one standalone component per step,
  `workflowRoutes` wiring into the target routes file, versioned draft
  schema stub, and a headless `testWorkflow` spec.
- `ng g @skewkit/schematics:contract-client <name> --url <api-base>` — fetches
  the live contract (or reads a local document), writes it to `contracts/`,
  runs the `skew gen client` generators, and wires the output into an
  injectable data service using `httpResource`/`HttpClient` +
  `readResolving`.
- `ng g @skewkit/schematics:lazy-route <path>` — converts a `loadChildren`
  entry to the `lazy('<id>', …)` wrapper and adds the module id (assist for
  adopting `@skewkit/angular-router` across a large routes file).

Schematics are the right vehicle here precisely because these edits touch
user source: schematics give dry-run (`--dry-run`), idempotent re-runs, and
merge strategies that raw file emission can't.

## Implementation phases

Each phase lands independently shippable (repo rule: lint + test + build per
lib; vitest throughout).

**Phase 1 — CLI consolidation + config (small).**
Unified `skew` bin in `@skewkit/build` dispatching to existing `stamp` and
`contract gen`; `skew.config.json` loader; `skew gen --check` diff mode.
Old bins delegate to the new entry. Risk: none, pure refactor + additive.

**Phase 2 — contract authoring & CI safety (`contract new/bump/check`).**
The TS-interface → JSON Schema inference uses the TypeScript compiler API
(already a dependency of the workspace, but becomes a peer/optional dep of
`@skewkit/build` — inference degrades gracefully to `--from-sample` when TS
isn't installed). Past-step immutability check reuses
`contractFingerprint` per step against `git show <base>:<path>`.

**Phase 3 — server + client generators (`skew gen server|client`).**
Text emission from shared templates; golden-file tests (generate into a temp
dir, compile with `tsc --noEmit` in the test to prove output typechecks
against the real `@skewkit/*` types). The `handler` target ships first; Express
and Nest are thin wrappers over it.

**Phase 4 — `@skewkit/schematics`.**
New Nx lib built with `@angular-devkit/schematics` + `@schematics/angular`
utilities (both already in devDependencies). `ng-add` first, then `store`,
`contract-client`, `workflow`, `lazy-route`. Test with
`SchematicTestRunner` against a generated host app tree.

**Phase 5 — dogfood + docs.**
Run `skew init` + `ng add` against the demo `shell`/`api` apps, replacing
their hand-written wiring where the generated output is equivalent; README
per new command; update the `using-skew` agent skill (skills/using-skew) with
the CLI workflow.

## Workspace gotchas to respect (learned Aug 2026)

- Buildable libs that import sibling libs need `tsconfig.build.json` with
  `moduleResolution: "bundler"` — `@nx/js:tsc` rewrites cross-lib paths to
  `dist/`, which nodenext ESM refuses (see `libs/contract` for the pattern).
- `nx.json` has the `@nx/js:tsc` targetDefault with `dependsOn: ["^build"]`;
  the new `schematics` lib must keep that.
- Strict TS with nodenext: all relative imports in lib sources use explicit
  `.js` specifiers.
- Schematics run on CommonJS-friendly toolchains in some hosts; keep
  `@skewkit/schematics` compiled output compatible (`module: commonjs` for the
  collection is the safe conventional choice, matching `@schematics/angular`).

## Testing strategy

- **Unit**: op scaffolding, schema inference, config validation (vitest).
- **Golden files + typecheck**: every generator's output committed as
  fixtures and compiled against real lib types in tests, so an API change in
  `@skewkit/contract` breaks the generator's tests, not users.
- **Schematics**: `SchematicTestRunner` snapshot tests for tree diffs;
  ng-add idempotency (running twice changes nothing).
- **E2E (Phase 5)**: `skew gen --check` green on the demo apps in CI.

## Open questions (defaults chosen, revisit if wrong)

1. Unified bin lives in `@skewkit/build` vs a new `@skewkit/cli`: **`@skewkit/build`**
   — it already owns both existing bins and has no runtime deps; a rename to
   `@skewkit/cli` can be an alias later without breaking `bin` users.
2. Should `ng add` default to the wrapper builder or npm scripts for
   stamping: **npm scripts** — least magic, easiest to audit; builder behind
   a flag.
3. Firebase Functions adapter as a named target: **not separately** — the
   `handler` target plus a three-line `onRequest` wrapper in docs covers it.
