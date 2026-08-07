# Skew: Technical Appendix

This document outlines the design rationale, implementation details, and constraints that forced each API shape across the Skew packages.

## Architectural Principles

1. **Explicit negotiation at the boundary**: Two independently-deployed parties (e.g., client and origin, or past-self and present-self) must have a way to discover they disagree. Skew provides the primitive to stamp data crossing this boundary, detect disagreement, and safely migrate.
2. **Never swallow `ahead` errors**: Data from a newer build cannot be migrated downward. Collapsing this failure into `null` or silently discarding the data causes data loss. Skew requires consumers to surface this condition so the application can choose to refetch or update.
3. **No adoption backfill**: Un-enveloped data is treated as version 1 (`v1`), meaning adoption does not require backfilling legacy records.
4. **Decoupled packages**: Consumer packages (`@skew/angular-*`, `@skew/react-*`) depend on `@skew/core`, but never on sibling packages.

## `@skew/build` Design

Identity is required to compare builds and understand skew. 
- The build identity is output as a **generated file** (e.g., `build-id.ts`) rather than relying on a bundler `define` plugin. This keeps it portable across Vite, Angular CLI, webpack, and test environments.
- Build timestamps (`builtAt`) are mandatory. Timestamps are the only reliable way to order builds and distinguish between "reloading will fix this" vs "reloading will loop forever."

## `@skew/angular-router` Constraints

- **`provideRouter` limitations**: Angular's `RouterFeature` type cannot be constructed by third-party libraries because the factory is internal. Skew integration exposes a public `provideSkewRecovery()` setup and a `lazy()` higher-order function instead of a single router feature.
- **Default recovery strategy (`reload-at-target`)**: Angular's default `urlUpdateStrategy: 'deferred'` means the address bar still shows the previous route after a failed navigation. A naïve `location.reload()` returns the user to where they started, silently discarding their intended navigation. `reload-at-target` preserves the user's intent.
- **`@defer` interception**: Angular's compiler-generated `@defer` blocks currently lack a global error interception hook.
- **Guard introspection**: The router does not expose whether a `CanDeactivate` guard would block, which requires components with unsaved work to manually opt-in (e.g., `trackUnsavedWork`).

## Data Normalization & Workflows

- **`@skew/angular-data`**: Angular's `resource()` API is excellent for reads but acts as a per-call cache lacking shared identity or mutation primitives (optimistic updates, rollbacks, durability). Skew's `query()` and `mutation()` provide these missing primitives alongside tag-based invalidation.
- **`@skew/angular-workflow`**: Workflows share a single `TData` shape for all steps rather than accumulating a per-step type. While a fully generic accumulation chain is expressible in TypeScript, it produces unreadable type errors. Validation libraries already own per-step shapes, making this a deliberate and practical trade-off.
