# @skew/build — build-time stamping and codegen

Two CLIs, installed via the package's `bin` entries: `skew-stamp` and
`skew-contract`. Both are plain Node executables — wire them into npm scripts,
Nx targets, or CI steps.

## skew-stamp — build identity + manifest

Writes the build identity module and the skew manifest that
`createVersionProbe` / `provideSkewRecovery` compare against.

```sh
skew-stamp --out src/generated/build-id.ts \
           --manifest dist/app/browser/skew-manifest.json \
           --assets   dist/app/browser
```

| Flag | Meaning | Default |
|---|---|---|
| `--out` | TypeScript file to generate (`BUILD_IDENTITY`, `BUILD_ID`, `BUILT_AT`) | `src/generated/build-id.ts` |
| `--manifest` | JSON manifest to emit — required for probing | none |
| `--assets` | dist dir to scan for chunks; enriches the manifest's `modules` map | none |
| `--build-id` | override the derived id | git SHA, else `SKEW_BUILD_ID` env |
| `--built-at` | override the timestamp | now |

Wiring pattern for an Angular app:

1. **Prebuild** (and predev): `skew-stamp --out src/generated/build-id.ts`
   so `BUILD_IDENTITY` exists before `ng build`/`ng serve` compiles.
2. **Postbuild**: run again with `--manifest` + `--assets` pointing at the
   browser output dir so the manifest lists the actual chunk files.
3. Serve `skew-manifest.json` with `Cache-Control: no-store` — a cached
   manifest defeats the entire purpose (the probe would compare against a
   stale snapshot).
4. `builtAt` matters: it's what makes `staleOrigin` detectable (timestamps
   order builds; ids alone can't).
5. Check `src/generated/` into `.gitignore` or commit it — either works, but
   CI must run the stamp before build either way.

## skew-contract — frozen types from contract documents

```sh
skew-contract gen --in contracts/portfolio-fund.json \
                  --out src/generated/portfolio-fund.contract.ts \
                  [--type-prefix FundContract] [--const-name FUND_CONTRACT]
```

Emits one frozen interface per documented version (`FundV1`, `FundV2`, …
derived from the contract name unless `--type-prefix` overrides) plus the
document itself as a typed const. These generated types are the snapshot
types that `versionedFromContract<T>()` and migration steps close over —
generation is what enforces "never edit a past version's interface."

Conventions:

- Keep contract JSON documents in a `contracts/` directory at the project
  root; generated output under `src/generated/`.
- Regenerate whenever the contract changes and commit document + generated
  file in the same change.
- Both server (owner of the contract) and clients (consumers) run `gen`
  against the same document — the document is the single source of truth.
