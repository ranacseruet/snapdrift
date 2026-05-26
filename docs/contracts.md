# Contracts

## Config

SnapDrift reads runtime behavior from `.github/snapdrift.json` by default.

### Required fields

| Field | Type | Description |
|:------|:-----|:------------|
| `baselineArtifactName` | `string` | Uploaded baseline artifact name |
| `workingDirectory` | `string` | Root directory for resolving relative paths |
| `baseUrl` | `string` | URL where the running app is reachable |
| `resultsFile` | `string` | Path for capture results JSON |
| `manifestFile` | `string` | Path for screenshot manifest JSON |
| `screenshotsRoot` | `string` | Parent directory for screenshot output |
| `routes` | `array` | Route list to capture |
| `diff.threshold` | `number` | Max allowed mismatch ratio per screenshot |
| `diff.mode` | `string` | One of `report-only`, `fail-on-changes`, `fail-on-incomplete`, `strict` |

### Route entry

| Field | Type | Description |
|:------|:-----|:------------|
| `id` | `string` | Unique route identifier across runs |
| `path` | `string` | URL path appended to `baseUrl` |
| `viewport` | `string` or `object` | Preset name (`"desktop"`, `"mobile"`) or a custom object `{ "width": number, "height": number }` |
| `changePaths` | `string[]` | Optional prefixes used for changed-file scoping |
| `navigationTimeout` | `number` | Optional per-route navigation timeout in ms (overrides the 30 000 ms global default) |

### Optional fields

| Field | Type | Description |
|:------|:-----|:------------|
| `selection.sharedPrefixes` | `string[]` | Prefixes that force the full route set |
| `selection.sharedExact` | `string[]` | Exact files that force the full route set |
| `provider` | `string` | `"local"` (default) or `"snap"` for hosted backend |
| `snap.apiUrl` | `string` | Snap API base URL (default: `https://snap.i2dev.com`) |
| `snap.apiKeyEnv` | `string` | Env var name for API key (mutually exclusive with `snap.apiKey`) |
| `snap.apiKey` | `string` | Inline API key with `${VAR}` interpolation (mutually exclusive with `snap.apiKeyEnv`) |
| `snap.projectId` | `string` | Snap project ID or `"auto"` (default: `"auto"`, derives from `GITHUB_REPOSITORY`) |
| `snap.onUnavailable` | `string` | Behavior when Snap is unreachable: `"fail"` (default), `"warn-and-skip"`, or `"fallback-local"` |

### Example

```json
{
  "baselineArtifactName": "ui-foundation-snapdrift-baseline",
  "workingDirectory": ".",
  "baseUrl": "http://127.0.0.1:8080",
  "resultsFile": "qa-artifacts/snapdrift/baseline/current/results.json",
  "manifestFile": "qa-artifacts/snapdrift/baseline/current/manifest.json",
  "screenshotsRoot": "qa-artifacts/snapdrift/baseline/current",
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

The published baseline bundle contains:

| File | Description |
|:-----|:------------|
| `results.json` | Capture results with per-route status and timing |
| `manifest.json` | Screenshot manifest with ids, paths, and dimensions |
| `screenshots/*.png` | Captured screenshot images |

## Drift artifact

The pull request drift bundle contains:

| File | Description |
|:-----|:------------|
| `summary.json` | Structured SnapDrift summary |
| `summary.md` | Human-readable SnapDrift report |
| `baseline/results.json` | Baseline capture results |
| `baseline/manifest.json` | Baseline manifest |
| `baseline/screenshots/*.png` | Baseline images |
| `current/results.json` | Current capture results |
| `current/manifest.json` | Current manifest |
| `current/screenshots/*.png` | Current images |

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

## Summary shape

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
  "baselineArtifactName": "ui-foundation-snapdrift-baseline",
  "baselineSourceSha": "abc1234"
}
```

### Status values

| Status | Meaning |
|:-------|:--------|
| `clean` | All captures matched within threshold |
| `changes-detected` | One or more captures exceeded threshold |
| `incomplete` | Missing captures, dimension shifts, or comparison errors occurred |
| `skipped` | The report was intentionally skipped |

### Skipped summary

```json
{
  "status": "skipped",
  "reason": "no_snapdrift_relevant_changes",
  "message": "No drift-relevant changes were detected in this pull request.",
  "selectedRoutes": []
}
```

Additional missing-baseline fields: `baselineAvailable`, `currentResultsPath`.

## Drift semantics

- Screenshots are matched by `id`
- Mismatch ratio is `different_pixels / total_pixels`
- `diff.threshold` applies per screenshot
- Missing captures are counted separately from drift signals
- Dimension mismatches skip pixel comparison and land in `dimensionChanges[]`
- `diff.mode` controls enforcement, not summary generation

## Drift modes

| Mode | Stops the run when |
|:-----|:-------------------|
| `report-only` | Never |
| `fail-on-changes` | `changedScreenshots > 0` |
| `fail-on-incomplete` | Errors, dimension shifts, or missing captures occur |
| `strict` | Any drift or incomplete comparison appears |

## Viewport presets

| Preset | Width | Height | Scale factor | Mobile | Touch |
|:-------|------:|-------:|-------------:|:-------|:------|
| `desktop` | 1440 | 900 | 1 | No | No |
| `mobile` | 390 | 844 | 3 | Yes | Yes |

## Capture defaults

| Setting | Value |
|:--------|:------|
| Navigation wait | `load` |
| Navigation timeout | 30000ms |
| Settle delay | 300ms |
| Screenshot animations | `disabled` (Playwright finishes/cancels CSS animations before capture) |
| Capture concurrency | 5 routes per viewport (overridable via `SNAPDRIFT_CAPTURE_CONCURRENCY`)|

## Local CLI directory layout

When using the `snapdrift` CLI, outputs are written to `.snapdrift/` by default:

```
.snapdrift/
  baseline/             # written by: snapdrift capture
    results.json
    manifest.json
    screenshots/*.png
  current/              # written by: snapdrift diff
    results.json
    manifest.json
    screenshots/*.png
  diff/                 # written by: snapdrift diff
    summary.json
    summary.md
    report.html
```

All three directories can be overridden with `--baseline-dir`, `--current-dir`, and `--diff-dir`. See the [Local CLI guide](local-cli.md) for details.

## Migration commands

### migrate-baselines

Migrate baselines between local storage and Snap.

**Upload local baselines to Snap:**

```
snapdrift migrate-baselines --to snap [--config <path>] [--baseline-dir <dir>]
```

- Reads local manifest + baseline images from the baseline directory.
- Uploads as the initial accepted baseline on Snap via `POST /v1/visual/projects/:id/baselines`.
- Idempotent: skips upload if a baseline already exists with the matching commit SHA.
- Requires snapdrift.json with `provider: "snap"` (or snap config).

**Download Snap baselines to local:**

```
snapdrift migrate-baselines --to local --from snap [--accept-cross-engine] [--config <path>] [--baseline-dir <dir>]
```

- Downloads baselines from Snap's export endpoint.
- Writes to the local baseline directory.
- Without `--accept-cross-engine`: hard-errors if the exported baselines were captured by a different engine.
- With `--accept-cross-engine`: overrides the engine name to `snapdrift-local` in the imported manifest (visual differences may occur).

### init

**Translate a Snap action workflow to snapdrift.json:**

```
snapdrift init --from-snap-action <workflow-yaml-path>
```

- Reads an existing Snap `github-action/` workflow YAML.
- Translates Snap action inputs into `.github/snapdrift.json`.
- Emits `.github/MIGRATION_NOTES.md` listing warnings and deferred decisions.
- Idempotent: refuses to overwrite an existing `snapdrift.json`.

## Primary entrypoints

- `actions/baseline`
- `actions/pr-diff`
- `snapdrift` CLI (local development)

## Advanced environment variables

These are for custom orchestration only. Wrapper actions set them automatically.

| Variable | Module | Description |
|:---------|:-------|:------------|
| `SNAPDRIFT_CONFIG_PATH` | `snapdrift-config.mjs` | Override config path |
| `SNAPDRIFT_ROUTE_IDS` | `capture-routes.mjs`, `compare-results.mjs` | Comma-separated route ids |
| `SNAPDRIFT_BASELINE_RESULTS_PATH` | `compare-results.mjs` | Baseline results path |
| `SNAPDRIFT_BASELINE_MANIFEST_PATH` | `compare-results.mjs` | Baseline manifest path |
| `SNAPDRIFT_CURRENT_RESULTS_PATH` | `compare-results.mjs` | Current results path |
| `SNAPDRIFT_CURRENT_MANIFEST_PATH` | `compare-results.mjs` | Current manifest path |
| `SNAPDRIFT_BASELINE_RUN_DIR` | `compare-results.mjs` | Baseline screenshot root |
| `SNAPDRIFT_CURRENT_RUN_DIR` | `compare-results.mjs` | Current screenshot root |
| `SNAPDRIFT_DRIFT_OUT_DIR` | `compare-results.mjs` | Drift report output directory |
| `SNAPDRIFT_SUMMARY_PATH` | `compare-results.mjs` | Summary JSON path |
| `SNAPDRIFT_SUMMARY_MARKDOWN_PATH` | `compare-results.mjs` | Summary markdown path |
| `SNAPDRIFT_BASELINE_ARTIFACT_NAME` | `compare-results.mjs` | Baseline artifact label to embed in the report |
| `SNAPDRIFT_BASELINE_SOURCE_SHA` | `compare-results.mjs` | Baseline source SHA to embed in the report |
| `SNAPDRIFT_ENFORCE_OUTCOME` | `compare-results.mjs` | Set to `0` to disable enforcement in direct CLI usage |
| `SNAPDRIFT_CAPTURE_CONCURRENCY` | `capture-routes.mjs` | Max concurrent route captures per viewport context (positive integer, default `5`). Set to `1` to restore serial behaviour for apps with shared session/auth state. |

## PR comment markdown shape

The canonical PR comment is produced by `provider.buildCommentBody(summary, meta)` in `@snapdrift/adapter-report-md`. Both `LocalProvider` and `SnapProvider` emit byte-identical markdown for the same summary — the only provider-specific difference is the optional **"View in dashboard →"** link appended by `SnapProvider`.

Snap's server-side notification posting should render the same template from the run summary JSON so that reviewers see a consistent format regardless of which provider produced the run.

### Structure

```
<!-- snapdrift-report -->
## {status-icon} SnapDrift Report — {status-label}

| Signal | Count |
|:-------|------:|
| Drift signals | N |
| Missing in baseline | N |
| Missing in current capture | N |
| Dimension shifts | N |

> **Note:** {message}                           ← optional, when summary.message is set

<details><summary>Error details</summary>       ← collapsible, only when errors exist
| Route | Viewport | Error |
|:------|:---------|:------|
| route-id | viewport | error message |
*...and N more* — [View full report →]({runUrl})  ← when errors exceed maxErrorRows
</details>

<details><summary>Drift signals</summary>       ← collapsible, only when changed routes exist
| Route | Viewport | Mismatch |
|:------|:---------|:---------|
| route-id | viewport | X.XX% |
*...and N more* — [View full report →]({runUrl})  ← when routes exceed maxChangedRows
</details>

<details open><summary>Dimension shifts — comparison skipped</summary>  ← auto-expanded, only when dimension shifts exist
> SnapDrift detected a dimension shift …
| Route | Viewport | Baseline | Current |
|:------|:---------|:---------|:--------|
| route-id | viewport | WxH | WxH |
</details>

<sub>SnapDrift · artifact `name` · baseline `name` · sha `abc1234` · [View run](url) · [View in dashboard →](url)</sub>
                                                  ↑ LocalProvider omits "View in dashboard"

<div align="right"><sub>Powered by <a href="…">SnapDrift</a></sub></div>
```

### Meta parameters

| Field | Type | Description |
|:------|:-----|:------------|
| `artifactName` | `string?` | PR diff artifact label |
| `runUrl` | `string?` | GitHub Actions run URL (adds `[View run]` link) |
| `dashboardUrl` | `string?` | Snap dashboard URL (adds `[View in dashboard →]` link; SnapProvider only) |
| `maxChangedRows` | `number` | Max drift-signal rows before truncation (default 20) |
| `maxErrorRows` | `number` | Max error rows before truncation (default 10) |

### Update-in-place semantics

Comments are identified by the `<!-- snapdrift-report -->` HTML marker. On re-run, the action finds the most recent matching comment and updates it in place. Duplicate markers from earlier runs are deleted.

### Provider contract

The `VisualProvider` interface requires `buildCommentBody(summary, meta?)`:

- **`LocalProvider`** — delegates to `buildReportCommentBody` without a `dashboardUrl`.
- **`SnapProvider`** — constructs `dashboardUrl` from `{apiUrl}/projects/{projectId}/runs/{lastRunId}` and passes it through.
