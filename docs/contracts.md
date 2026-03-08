# Contracts — v1 (frozen)

> **Stability: v1 frozen.** These contracts are stable. Changes require a major version bump.

## Config

The shared layer reads runtime visual regression behavior from `.github/visual-regression.json`.

### Required fields

| Field | Type | Description |
|:------|:-----|:------------|
| `baselineArtifactName` | `string` | Name for the uploaded baseline artifact |
| `workingDirectory` | `string` | Root directory for resolving relative paths |
| `baseUrl` | `string` | Base URL the running app is reachable at |
| `readyUrl` | `string` | URL to poll for app readiness. Used by the reusable workflow templates; not read by the `lib/` modules themselves. |
| `readyTimeoutSeconds` | `number` | Max seconds to wait for the app to become ready. Used by the reusable workflow templates; not read by the `lib/` modules themselves. |
| `resultsFile` | `string` | Path (relative to `workingDirectory`) for capture results JSON |
| `manifestFile` | `string` | Path (relative to `workingDirectory`) for screenshot manifest JSON |
| `screenshotsRoot` | `string` | Parent directory for screenshot output (relative to `workingDirectory`); actual PNGs are written to `{screenshotsRoot}/screenshots/{id}.png` |
| `routes` | `array` | List of route entries to capture |
| `diff.threshold` | `number` | Max allowed mismatch ratio per screenshot (e.g. `0.01` = 1%) |
| `diff.mode` | `string` | One of: `report-only`, `fail-on-changes`, `fail-on-incomplete`, `strict` |

### Route entry

| Field | Type | Description |
|:------|:-----|:------------|
| `id` | `string` | Unique identifier for the route (used for matching across runs) |
| `path` | `string` | URL path appended to `baseUrl` |
| `viewport` | `string` | One of: `desktop`, `mobile` |
| `changePaths` | `string[]` | Optional. File prefixes that scope this route to specific changes |

### Optional fields

| Field | Type | Description |
|:------|:-----|:------------|
| `selection.sharedPrefixes` | `string[]` | File prefixes that trigger all routes |
| `selection.sharedExact` | `string[]` | Exact filenames that trigger all routes |

### Example

```json
{
  "baselineArtifactName": "ui-foundation-visual-baseline",
  "workingDirectory": ".",
  "baseUrl": "http://127.0.0.1:8080",
  "readyUrl": "http://127.0.0.1:8080",
  "readyTimeoutSeconds": 45,
  "resultsFile": "qa-artifacts/visual-baselines/current/visual-baseline-results.json",
  "manifestFile": "qa-artifacts/visual-baselines/current/visual-screenshot-manifest.json",
  "screenshotsRoot": "qa-artifacts/visual-baselines/current",
  "routes": [
    { "id": "root-index-desktop", "path": "/", "viewport": "desktop" },
    { "id": "root-index-mobile", "path": "/", "viewport": "mobile" }
  ],
  "diff": {
    "threshold": 0.01,
    "mode": "report-only"
  }
}
```

## Baseline artifact

The baseline artifact bundle contains:

| File | Description |
|:-----|:------------|
| `visual-baseline-results.json` | Capture results with per-route status and timing |
| `visual-screenshot-manifest.json` | Screenshot manifest with ids, paths, and dimensions |
| `screenshots/*.png` | Captured screenshot images |

## PR diff artifact

The diff artifact bundle contains:

| File | Description |
|:-----|:------------|
| `visual-diff-summary.json` | Structured diff summary |
| `visual-diff-summary.md` | Human-readable markdown summary |
| `baseline-results.json` | Baseline capture results |
| `current-results.json` | Current capture results |
| `baseline-screenshot-manifest.json` | Baseline screenshot manifest |
| `current-screenshot-manifest.json` | Current screenshot manifest |
| `baseline-screenshots/*.png` | Baseline screenshot images |
| `current-screenshots/*.png` | Current screenshot images |

## Screenshot manifest shape

```json
{
  "generatedAt": "2024-01-01T00:00:00.000Z",
  "baseUrl": "http://127.0.0.1:8080",
  "screenshots": [
    {
      "id": "root-index-desktop",
      "path": "/",
      "viewport": "desktop",
      "imagePath": "screenshots/root-index-desktop.png",
      "width": 1440,
      "height": 900
    }
  ]
}
```

## Diff summary shape

```json
{
  "startedAt": "2024-01-01T00:00:00.000Z",
  "finishedAt": "2024-01-01T00:00:01.000Z",
  "completed": true,
  "status": "clean",
  "diffMode": "report-only",
  "threshold": 0.01,
  "totalScreenshots": 1,
  "matchedScreenshots": 1,
  "changedScreenshots": 0,
  "missingInBaseline": 0,
  "missingInCurrent": 0,
  "selectedRoutes": ["root-index-desktop"],
  "changed": [],
  "missing": [],
  "errors": [],
  "dimensionChanges": [],
  "baselineResultsPath": "...",
  "currentResultsPath": "...",
  "baselineManifestPath": "...",
  "currentManifestPath": "...",
  "baselineArtifactName": "ui-foundation-visual-baseline",
  "baselineSourceSha": "abc1234"
}
```

### Status values

| Status | Meaning |
|:-------|:--------|
| `clean` | All screenshots matched within threshold |
| `changes-detected` | One or more screenshots exceeded the mismatch threshold |
| `incomplete` | Missing screenshots, dimension changes, or comparison errors |
| `skipped` | Diff was intentionally skipped (no relevant changes, missing baseline) |

### Skipped summary

When a PR diff is intentionally skipped, the summary is a partial object:

```json
{
  "status": "skipped",
  "reason": "no_visual_relevant_changes",
  "message": "No visual-relevant changes were detected in this pull request.",
  "selectedRoutes": []
}
```

Additional fields for missing-baseline skips: `baselineAvailable`, `currentResultsPath`.

## Diff semantics

- Screenshots are matched by `id` (must be unique within a run)
- Mismatch ratio = `different_pixels / total_pixels`
- `diff.threshold` is per-screenshot (e.g. `0.01` means 1% pixel mismatch allowed)
- Screenshots at or below threshold are counted as matched
- Screenshots above threshold are counted as changed
- Missing screenshots are counted separately (not as changed)
- Viewport dimension mismatches skip pixel diff and record in `dimensionChanges[]`
- `diff.mode` controls enforcement, not summary generation

## Enforcement modes

| Mode | Fails when |
|:-----|:-----------|
| `report-only` | Never |
| `fail-on-changes` | `changedScreenshots > 0` |
| `fail-on-incomplete` | Errors, dimension changes, or missing screenshots |
| `strict` | Any of the above |

## Viewport presets (fixed in v1)

| Preset | Width | Height | Scale factor | Mobile | Touch |
|:-------|------:|-------:|-----------:|:-------|:------|
| `desktop` | 1440 | 900 | 1 | No | No |
| `mobile` | 390 | 844 | 3 | Yes | Yes |

## Readiness defaults (fixed in v1)

| Setting | Value |
|:--------|:------|
| Navigation wait | `networkidle` |
| Navigation timeout | 30000ms |
| Settle delay | 300ms |

## Wrapper entrypoints

Primary integration path:

- `actions/publish-visual-baseline` — baseline capture, staging, and upload
- `actions/run-visual-pr-diff` — end-to-end PR diff pipeline

The lower-level actions remain available for advanced consumers, but new consumers should prefer the wrapper actions.

## Environment variables (advanced / low-level usage)

The `lib/` modules read the following environment variables as fallbacks when options are not passed programmatically. These are set automatically by the wrapper actions and do not need to be set manually when using `publish-visual-baseline` or `run-visual-pr-diff`. They are documented here for consumers building custom orchestration on top of the low-level actions.

| Variable | Module | Description |
|:---------|:-------|:------------|
| `QA_VISUAL_CONFIG_PATH` | `visual-regression-config.mjs` | Override path to `visual-regression.json` |
| `QA_VISUAL_ROUTE_IDS` | `capture-visual-routes.mjs`, `compare-visual-results.mjs` | Comma-separated route ids to capture/compare |
| `QA_VISUAL_BASELINE_RESULTS_PATH` | `compare-visual-results.mjs` | Path to baseline `visual-baseline-results.json` |
| `QA_VISUAL_BASELINE_MANIFEST_PATH` | `compare-visual-results.mjs` | Path to baseline `visual-screenshot-manifest.json` |
| `QA_VISUAL_CURRENT_RESULTS_PATH` | `compare-visual-results.mjs` | Path to current `visual-baseline-results.json` |
| `QA_VISUAL_CURRENT_MANIFEST_PATH` | `compare-visual-results.mjs` | Path to current `visual-screenshot-manifest.json` |
| `QA_VISUAL_BASELINE_RUN_DIR` | `compare-visual-results.mjs` | Root directory for resolving baseline screenshot paths (default: `baseline`) |
| `QA_VISUAL_CURRENT_RUN_DIR` | `compare-visual-results.mjs` | Root directory for resolving current screenshot paths |
| `QA_VISUAL_DIFF_OUT_DIR` | `compare-visual-results.mjs` | Output directory for diff summary files (default: `qa-artifacts/visual-diffs/current`) |
| `QA_VISUAL_DIFF_SUMMARY_PATH` | `compare-visual-results.mjs` | Override path for `visual-diff-summary.json` |
| `QA_VISUAL_DIFF_SUMMARY_MARKDOWN` | `compare-visual-results.mjs` | Override path for `visual-diff-summary.md` |
| `QA_VISUAL_BASELINE_ARTIFACT_NAME` | `compare-visual-results.mjs` | Baseline artifact name to embed in the summary |
| `QA_VISUAL_BASELINE_SOURCE_SHA` | `compare-visual-results.mjs` | Baseline source SHA to embed in the summary |
| `QA_VISUAL_ENFORCE_OUTCOME` | `compare-visual-results.mjs` | Set to `0` to disable enforcement when running `runVisualDiffCli` directly (default: enforces) |
