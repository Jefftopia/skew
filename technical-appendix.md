# Skew: Technical Appendix

This document outlines the design rationale, implementation details, and constraints that forced each API shape across the Skew packages.

## Architectural Principles

1. **Explicit negotiation at the boundary**: Two independently-deployed parties (e.g., client and origin, or past-self and present-self) must have a way to discover they disagree. Skew provides the primitive to stamp data crossing this boundary, detect disagreement, and safely migrate.
2. **Never swallow `ahead` errors**: Data from a newer build cannot be migrated downward. Collapsing this failure into `null` or silently discarding the data causes data loss. Skew requires consumers to surface this condition so the application can choose to refetch or update.
3. **No adoption backfill**: Un-enveloped data is treated as version 1 (`v1`), meaning adoption does not require backfilling legacy records.
4. **Decoupled packages**: Consumer packages (`@braid/angular-*`, `@braid/react-*`) depend on `@braid/skew`, but never on sibling packages.

## `@braid/build` Design

Identity is required to compare builds and understand skew. 
- The build identity is output as a **generated file** (e.g., `build-id.ts`) rather than relying on a bundler `define` plugin. This keeps it portable across Vite, Angular CLI, webpack, and test environments.
- Build timestamps (`builtAt`) are mandatory. Timestamps are the only reliable way to order builds and distinguish between "reloading will fix this" vs "reloading will loop forever."

## `@braid/angular-router` Constraints

- **`provideRouter` limitations**: Angular's `RouterFeature` type cannot be constructed by third-party libraries because the factory is internal. Skew integration exposes a public `provideSkewRecovery()` setup and a `lazy()` higher-order function instead of a single router feature.
- **Default recovery strategy (`reload-at-target`)**: Angular's default `urlUpdateStrategy: 'deferred'` means the address bar still shows the previous route after a failed navigation. A naïve `location.reload()` returns the user to where they started, silently discarding their intended navigation. `reload-at-target` preserves the user's intent.
- **`@defer` interception**: Angular's compiler-generated `@defer` blocks currently lack a global error interception hook.
- **Guard introspection**: The router does not expose whether a `CanDeactivate` guard would block, which requires components with unsaved work to manually opt-in (e.g., `trackUnsavedWork`).

## Bidirectional Steps, the Registry, and Contracts

- **Down-migrations are opt-in per step, never synthesized.** A step declared as `{ up, down }` (or as ops, where the inverse is computed) can travel both ways; a step declared as a bare function cannot, and `read()` refuses `ahead` exactly as before. The design rule: a lossy projection is acceptable only when it is *labeled* — hence `downgradedFrom` and `lossyPaths` on the result rather than a silent success.
- **Determinism via `MigrationContext`.** Migrations receive `{ now(), seed? }` instead of reaching for `new Date()`/`Math.random()`. This came out of two real defects in the demo itself: an `asOf` stamp that made the same read produce different bytes, and a clock-derived idempotency key that minted a fresh identity per retry — the one property an idempotency key must not have.
- **The registry is module-level, not DI.** In a federated page the boundary between host and remote must not require cooperation; both sides reach the same registry through the one shared `@braid/skew` instance. Registration is explicit (`registerSchema`) because tests declare throwaway schemas by the dozen and unrelated contracts can collide on short names.
- **Step fingerprints hash descriptions and ops, never function text.** Two builds minify the same source differently, so `Function.toString()` equality would report false conflicts between builds that agree. The description is the human-owned identity of a code step — which is why `next()` now requires one.
- **The lens op set is closed and non-Turing-complete.** Contract documents are fetched from the network; nothing in them is executed, only interpreted. Semantic transforms stay as named `code` steps a consumer must ship — absent, they degrade as `gap`, loudly. The op interpreter prunes intermediate objects its own inverses empty (so a v1 projection never contains a `liquidity: {}` that v1 never had).
- **Why contract resolution cures `ahead`.** An origin is always at least as new as the newest data it serves, so the party that produced the too-new payload can always explain it. `readResolving` fetches the document only after an actual `ahead`, registers what it learned, and re-reads — one HTTP request instead of a client redeploy.
- **HTTP carries versions in headers/URLs/media types; storage keeps the body envelope.** `envelopeFromResponse` normalizes either into the same read path, so servers adopt Skew with one header instead of reshaping response bodies.
- **`@nx/js:tsc` builds use a `bundler`-resolution build tsconfig** (`libs/contract/tsconfig.build.json`): Nx rewrites cross-lib paths to `dist/` directories, and nodenext ESM resolution refuses directory imports. Editor/typecheck configs keep `nodenext`, so the `.js`-specifier discipline still holds where humans write code.

## Data Normalization & Workflows

- **`@braid/angular-data`**: Angular's `resource()` API is excellent for reads but acts as a per-call cache lacking shared identity or mutation primitives (optimistic updates, rollbacks, durability). Skew's `query()` and `mutation()` provide these missing primitives alongside tag-based invalidation.
- **`@braid/angular-workflow`**: Workflows share a single `TData` shape for all steps rather than accumulating a per-step type. While a fully generic accumulation chain is expressible in TypeScript, it produces unreadable type errors. Validation libraries already own per-step shapes, making this a deliberate and practical trade-off.
