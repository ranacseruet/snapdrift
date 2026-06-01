# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm ci

# Run all tests
npm test

# Run a single test file
NODE_OPTIONS='--experimental-vm-modules' npx jest tests/compare-results.test.js

# Validate action YAML files (as CI does)
for f in actions/*/action.yml; do python3 -c "import sys, yaml; yaml.safe_load(open(sys.argv[1]))" "$f"; done
```

Tests require `--experimental-vm-modules` because the project uses ESM (`"type": "module"`). Node 22+ is required.

## Architecture

**SnapDrift** is a shared visual regression library and GitHub Actions composite action set for Node + Playwright projects.

### Three integration layers

1. **`packages/`** — Workspace packages. The actual implementation lives here. Each package is a standalone npm package with its own `package.json` and `tests/`. The root `snapdrift` package depends on these.
   - `@snapdrift/manifest` — Schema, validation, route-selection logic, viewport presets. Pure, zero I/O. (v1.1.0)
   - `@snapdrift/compare-core` — Pure pixel-comparison engine using `pngjs`. No I/O. (v1.0.0)
   - `@snapdrift/adapter-fs` — Filesystem I/O: config loading, capture, compare, staging, drift report generation, image resolution. (v1.0.0)
   - `@snapdrift/adapter-report-md` — Pure markdown and HTML report generators. Zero runtime dependencies. (v1.1.0)

2. **`lib/`** — Thin re-export shims over the workspace packages. Preserved for backward compatibility with downstream callers that import `lib/capture-routes.mjs` etc. directly. New consumers should import from the workspace packages or from the `package.json` `exports` map.
   - `snapdrift-config.mjs` — Re-exports from `@snapdrift/manifest` and `@snapdrift/adapter-fs`
   - `capture-routes.mjs` — Re-exports `runBaselineCapture` from `@snapdrift/adapter-fs`
   - `compare-results.mjs` — Re-exports diff helpers, drift report, and report generators
   - `stage-artifacts.mjs` — Re-exports `stageArtifacts` and `getDefaultArtifactBundleDir`
   - `drift-summary.mjs` — Re-exports `buildDriftSummary` and `writeDriftSummary`
   - `pr-comment.mjs` — Re-exports `buildReportCommentBody`, `PR_COMMENT_MARKER[S]`, `escapeMarkdown`
   - `report.mjs` — Wires the default filesystem `imageReader` for HTML reports
   - `cli.mjs` — CLI entry point: `parseArgs` + command dispatch for `capture`, `diff`, `migrate-baselines`, `init`
   - `provider.mjs` — `createProvider(name, config)` factory + `LocalProvider` implementation; re-exports `SnapProvider` and the four Snap error classes from `snap-provider.mjs`
   - `snap-provider.mjs` — `SnapProvider` (hosted `VisualProvider` with `capture`/`diff`/`publishBaseline`/`fetchLatestBaseline`/`buildCommentBody`) + migration methods (`migrateBaselineFromLocal`, `exportBaselines`, `checkBaselineExists`) + `SnapApiError` / `SnapUnavailableError` / `SnapFallbackError` / `SnapSkipError` / `isLocalBaseUrl`
   - `migrate-baselines.mjs` — `migrate-baselines` command handlers (`runMigrateToSnap`, `runMigrateToLocal`)
   - `init-from-action.mjs` — `init --from-snap-action` codemod: translates Snap action workflow YAML to `snapdrift.json`

3. **`actions/`** — GitHub composite actions. Two primary wrapper actions orchestrate the full pipeline:
   - `actions/baseline` — Reads config → installs deps → captures routes → publishes (via `provider.publishBaseline`) → stages bundle → uploads artifact
   - `actions/pr-diff` — Resolves PR scope → resolves baseline artifact → captures current routes → compares → stages → uploads → posts PR comment → enforces `diff.mode`

   Lower-level actions are still available for custom orchestration:
   - `actions/capture` — capture routes and emit `results.json` + `manifest.json`
   - `actions/compare` — diff current capture against a baseline
   - `actions/scope` — decide whether to run and which routes to select from changed files
   - `actions/resolve-baseline` — find and download the latest successful baseline artifact
   - `actions/stage` — assemble a baseline or diff bundle for upload
   - `actions/enforce` — evaluate the summary against `diff.mode` and fail when required
   - `actions/comment` — upsert a PR comment from a summary (provider-aware)

### Data flow

```
consumer repo app (running locally)
  → actions/capture (or provider.capture)   →  results.json + manifest.json + screenshots/
  → actions/compare (or provider.diff)      →  summary.json + summary.md
  → actions/stage (or stageArtifacts)       →  bundle dir
  → actions/upload-artifact                 →  GitHub Actions artifact
  → actions/comment (provider.buildCommentBody) →  upsert PR comment
  → actions/enforce                          →  enforces diff.mode
```

With `provider: "snap"`, `provider.capture` and `provider.diff` route to Snap's hosted `/v1/visual/*` API instead of the filesystem. When `baseUrl` is local (`isLocalBaseUrl` returns true), SnapDrift uses a local-capture hybrid: Playwright runs on the runner to render, and the resulting PNG is uploaded to Snap via `POST /v1/visual/captures/:id/local-result`.

### Config contract

Consumer repos provide `.github/snapdrift.json`. The schema is frozen at v1 — see `docs/contracts.md` for the full field reference. Key fields: `routes[]` (with `id`, `path`, `viewport`), `diff.threshold`, `diff.mode`, optional `selection.sharedPrefixes/sharedExact` and per-route `changePaths` for changed-file scoping. The `provider` field (`"local"` | `"snap"`) selects the backend.

### Action internals

Action steps load `lib/` modules at runtime using `node --input-type=module` with dynamic `import(pathToFileURL(...))`. The `ACTION_ROOT` env var is set at the top of each action so nested steps can resolve module paths regardless of the calling repo's working directory. `npm ci --prefix "$ACTION_ROOT"` runs in the wrapper actions to install the workspace packages.

### Viewport presets (fixed in v1)

| Preset | Width | Height |
|--------|------:|-------:|
| desktop | 1440 | 900 |
| mobile | 390 | 844 |

### Types

`types/visual-diff-types.d.ts` contains JSDoc-referenced TypeScript type definitions. All `lib/` files use `// @ts-check` with JSDoc annotations — there is no build step.

### Testing

Tests in `tests/` and `packages/*/tests/` use Jest with `"transform": {}` (no transpilation). Tests are unit/contract-level — they do not run Playwright or require a live app. CI runs the suite on Node 22.

| Test file | What it covers |
|-----------|---------------|
| `tests/snapdrift-smoke.test.js` | Config validation, enforcement modes, viewport/readiness contracts, lib exports, artifact bundle structure |
| `tests/capture-routes.test.js` | Baseline capture behavior, manifest shape, retry, error surfaces |
| `tests/compare-results.test.js` | Pixel diff logic, dimension mismatch, missing screenshots, file index cache, route scoping |
| `tests/stage-artifacts.test.js` | Baseline and diff bundle staging |
| `tests/drift-summary.test.js` | Skipped-summary generation for scope and missing-baseline cases |
| `tests/pr-comment.test.js` | PR comment body construction (local and snap link variants) |
| `tests/provider.test.js` | `createProvider` factory and `LocalProvider` |
| `tests/snap-provider.test.js` | `SnapProvider` capture/diff/publish paths, local-capture hybrid, retry, error classification |
| `tests/snapdrift-actions-contract.test.js` | Action YAML structure, wrapper action inputs/outputs, viewport preset contract, provider wiring |
| `tests/snapdrift-config.test.js` | `snapdrift-config` shim exports |
| `tests/report.test.js` | HTML report image embedding |
| `tests/migrate-baselines.test.js` | Migration command parsing, `runMigrateToSnap`, `runMigrateToLocal` engine validation |
| `tests/init-from-action.test.js` | Snap action YAML parsing, field translation, warning generation, idempotency |
| `tests/cli.test.js` | CLI `parseArgs` + command dispatch |
| `tests/integration/capture-compare-pipeline.test.js` | End-to-end capture → stage → compare pipeline with synthetic PNG fixtures |
