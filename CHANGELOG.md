# Changelog

## Unreleased

- `publish-visual-baseline` and `run-visual-pr-diff` now self-provision Node 22 via `actions/setup-node`; consumer workflows no longer need to set up Node for SnapDrift to work, enabling non-Node app stacks (Python, Go, Ruby, etc.) on Ubuntu runners

## v1.0.0

Initial stable release of the shared visual regression module.

### Actions

- `publish-visual-baseline` — wrapper for baseline capture, staging, and artifact upload
- `run-visual-pr-diff` — wrapper for end-to-end PR diff pipeline (scope, capture, compare, comment, enforce)
- `capture-visual-routes` — route-driven screenshot capture via Playwright
- `compare-visual-results` — pixel-level comparison with configurable threshold
- `determine-visual-diff-scope` — changed-file-based route scoping
- `evaluate-visual-diff-outcome` — enforcement mode evaluation
- `publish-visual-pr-comment` — PR comment publication with upsert behavior
- `resolve-baseline-artifact` — latest successful baseline artifact resolution
- `stage-visual-artifacts` — artifact bundle staging for upload

### Lib modules

- `lib/visual-regression-config.mjs` — config loading, route selection, viewport presets
- `lib/capture-visual-routes.mjs` — Playwright-based screenshot capture
- `lib/compare-visual-results.mjs` — pixel diff, summary generation, enforcement
- `lib/stage-visual-artifacts.mjs` — artifact bundle directory staging
- `lib/visual-diff-summary.mjs` — skipped-summary generation for non-diff paths
- `lib/visual-diff-pr-comment.mjs` — PR comment body generation (tabular format, upsert marker)

### Contracts

- Config: `.github/visual-regression.json` as single source of truth
- Baseline artifact: `visual-baseline-results.json` + `visual-screenshot-manifest.json` + `screenshots/*.png`
- Diff artifact: summary JSON/markdown + baseline/current results, manifests, and screenshots
- Enforcement modes: `report-only`, `fail-on-changes`, `fail-on-incomplete`, `strict`
- Viewport presets: `desktop` (1440x900) and `mobile` (390x844)
- Readiness defaults: `networkidle` wait, 30s timeout, 300ms settle delay

### Validated against

- [codesamplez-tools](https://github.com/ranacseruet/codesamplez-tools) as pilot consumer
- One additional consumer repo with non-root `workingDirectory`
