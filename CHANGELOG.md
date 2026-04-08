# Changelog

## Unreleased

## 0.2.0 - 2026-04-08

### Features

- **Local CLI** (`snapdrift capture` / `snapdrift diff`) — run visual captures and diffs locally against a running app without GitHub Actions. Outputs land in `.snapdrift/` by default; all paths are overridable via flags. Exits non-zero when `diff.mode` enforces failure.
- **Self-contained HTML diff report** — the drift artifact now includes a single `report.html` with baseline/current screenshots and diff images embedded as base64, viewable without any server.
- **Custom viewport support** — route `viewport` now accepts an object `{ "width": number, "height": number }` in addition to the `"desktop"` and `"mobile"` presets.
- **Parallel capture by viewport** — routes are now captured concurrently per viewport group, roughly halving capture time on multi-route configurations.
- **Route ID sanitization** — route IDs are sanitised before use as filenames, preventing path-traversal sequences from escaping the screenshots directory.
- **Capture retry logic** — failed route captures are retried once before being recorded as errors.
- **Progress logging** — capture and comparison steps now emit per-route progress to stdout.

### Fixes

- HTML report image embedding now falls back correctly when a resolved image path is missing.
- Custom viewport values are formatted correctly in PR comment reports and dimension-shift entries.
- Viewport width/height are cast to numbers before comparison to prevent type-mismatch false positives.
- Dimension shifts section in PR comment reports is auto-expanded by default.

### Dependencies

- `playwright` 1.58.2 → 1.59.1
- `eslint` 9.x → 10.x, `@eslint/js` 9.x → 10.x
- `typescript` 5.x → 6.x
- `jest` 30.2.0 → 30.3.0
- `actions/upload-artifact` v4 → v7

### Infrastructure

- Added npm publish workflow (`.github/workflows/publish.yml`) triggered on GitHub release, with provenance attestation.
- Added `publishConfig` to `package.json` to make public access and registry explicit.

## 0.1.0 - 2026-03-09

- Prepared SnapDrift for the first public GitHub release under version `0.1.0`.
- Fixed capture metadata to record actual full-page PNG dimensions so dimension shifts stay classified separately from comparison errors.
- Standardized the public contract on SnapDrift-only config paths, environment variables, report markers, and artifact filenames.
- Added Node 22 self-provisioning to the standalone actions that shell out to `node` or `npm`.
- Updated README, contracts, and integration docs to reference public release tags, with commit SHA pinning as an optional hardening step.
