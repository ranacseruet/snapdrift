# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm ci

# Run all tests
npm test

# Run a single test file
NODE_OPTIONS='--experimental-vm-modules' npx jest tests/compare-visual-results.test.js

# Validate action YAML files (as CI does)
for f in actions/*/action.yml; do python3 -c "import sys, yaml; yaml.safe_load(open(sys.argv[1]))" "$f"; done
```

Tests require `--experimental-vm-modules` because the project uses ESM (`"type": "module"`). Node 22+ is required.

## Architecture

**SnapDrift** is a shared visual regression library and GitHub Actions composite action set for Node + Playwright projects.

### Two integration layers

1. **`lib/`** — Pure ESM modules consumed directly by action steps via dynamic `import()` at runtime. All modules are exported via `package.json` `exports`.
   - `visual-regression-config.mjs` — Loads and validates `.github/visual-regression.json`; exports viewport presets, route selection logic, and `splitCommaList`
   - `capture-visual-routes.mjs` — Launches headless Chromium via Playwright, captures full-page screenshots per route, writes results JSON + manifest JSON
   - `compare-visual-results.mjs` — Pixel-level diff using `pngjs`; produces `visual-diff-summary.json` + `.md`; contains enforcement logic (`shouldFailVisualDiff`)
   - `stage-visual-artifacts.mjs` — Assembles baseline or diff artifact bundles into a temp directory for upload
   - `visual-diff-summary.mjs` — Writes skipped-summary JSON/markdown when diff is intentionally skipped
   - `visual-diff-pr-comment.mjs` — Builds and upserts the PR comment body from a diff summary

2. **`actions/`** — GitHub composite actions. Two primary wrapper actions orchestrate the full pipeline:
   - `publish-visual-baseline` — Reads config → installs deps → captures routes → stages bundle → uploads artifact
   - `run-visual-pr-diff` — Resolves PR scope → resolves baseline artifact → captures current routes → compares → stages → uploads → posts PR comment → enforces diff mode

   Lower-level actions (e.g. `capture-visual-routes`, `compare-visual-results`) remain available for custom orchestration but are not the primary integration path.

### Data flow

```
consumer repo app (running locally)
  → capture-visual-routes  →  results.json + manifest.json + screenshots/
  → compare-visual-results →  visual-diff-summary.json + .md
  → stage-visual-artifacts →  bundle dir
  → upload-artifact        →  GitHub Actions artifact
  → publish-visual-pr-comment (upserts PR comment)
  → evaluate-visual-diff-outcome (enforces diff.mode)
```

### Config contract

Consumer repos provide `.github/visual-regression.json`. The schema is frozen at v1 — see `docs/contracts.md` for the full field reference. Key fields: `routes[]` (with `id`, `path`, `viewport`), `diff.threshold`, `diff.mode`, optional `selection.sharedPrefixes/sharedExact` and per-route `changePaths` for changed-file scoping.

### Action internals

Action steps load `lib/` modules at runtime using `node --input-type=module` with dynamic `import(pathToFileURL(...))`. The `ACTION_ROOT` env var is set at the top of each action so nested steps can resolve module paths regardless of the calling repo's working directory.

### Viewport presets (fixed in v1)

| Preset | Width | Height |
|--------|------:|-------:|
| desktop | 1440 | 900 |
| mobile | 390 | 844 |

### Types

`types/visual-diff-types.d.ts` contains JSDoc-referenced TypeScript type definitions. All `lib/` files use `// @ts-check` with JSDoc annotations — there is no build step.

### Testing

Tests in `tests/` use Jest with `"transform": {}` (no transpilation). Tests are unit/contract-level — they do not run Playwright or require a live app. CI runs the suite on Node 22.

| Test file | What it covers |
|-----------|---------------|
| `visual-diff-smoke.test.js` | Config validation, enforcement modes, viewport/readiness contracts, lib exports, artifact bundle structure |
| `compare-visual-results.test.js` | Pixel diff logic, dimension mismatch, missing screenshots, file index cache, route scoping |
| `stage-visual-artifacts.test.js` | Baseline and diff bundle staging |
| `visual-diff-summary.test.js` | Skipped-summary generation for scope and missing-baseline cases |
| `visual-diff-pr-comment.test.js` | PR comment body construction |
| `visual-diff-actions-contract.test.js` | Action YAML structure, wrapper action inputs/outputs, viewport preset contract |
