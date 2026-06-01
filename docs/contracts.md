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

When `provider: "snap"` is set, the `snap` block is required. Exactly one of `snap.apiKeyEnv` or `snap.apiKey` must be present. `snap.apiKey` accepts `${VAR}` interpolation (for example `"${SNAP_API_KEY}"`); the referenced environment variable must be set at runtime or the config loader throws.

### Example (local provider)

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

### Example (Snap provider)

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
  },
  "provider": "snap",
  "snap": {
    "apiKeyEnv": "SNAP_API_KEY",
    "projectId": "auto",
    "onUnavailable": "fail"
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

### Optional summary fields

| Field | Type | Description |
|:------|:-----|:------------|
| `dashboardUrl` | `string?` | Snap dashboard URL for the run (set by `SnapProvider`; omitted by `LocalProvider`) |

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

Migrate baselines between local storage and Snap. Both directions require a `snap` block in `snapdrift.json` (or `--to local` for the `snap → local` direction, since the export call still talks to Snap first).

**Upload local baselines to Snap:**

```
snapdrift migrate-baselines --to snap [--config <path>] [--baseline-dir <dir>]
```

- Reads `results.json`, `manifest.json`, and `screenshots/*.png` from the local baseline directory.
- Uploads as the initial accepted baseline on Snap via `POST /v1/visual/projects/:id/baselines`.
- Idempotent: if a baseline already exists for the same commit SHA (derived from `GITHUB_SHA` or `git rev-parse HEAD`), the upload is skipped.
- Screenshots are base64-encoded in the request body; very large suites may want to migrate per-route.

**Download Snap baselines to local:**

```
snapdrift migrate-baselines --to local --from snap [--accept-cross-engine] [--config <path>] [--baseline-dir <dir>]
```

- Downloads baselines from Snap's export endpoint.
- Writes `results.json`, `manifest.json`, and `screenshots/*.png` to the local baseline directory.
- Writes `.migration-metadata.json` next to the baseline recording `source`, `migratedAt`, and the engine that produced the export.
- Without `--accept-cross-engine`: hard-errors if the exported manifest's engine name is not `snapdrift-local`.
- With `--accept-cross-engine`: overrides the engine name to `snapdrift-local` in the imported manifest (visual differences may occur when the captures came from a different engine).
- Requires the Snap export endpoint to be available; if it is not yet wired up, the command fails with an actionable message instead of producing a partial baseline.

### init

**Translate a Snap action workflow to snapdrift.json:**

```
snapdrift init --from-snap-action <workflow-yaml-path>
```

- Reads an existing `snap/github-action` workflow YAML.
- Locates the step that uses `snap/github-action` (or any action whose `uses:` matches `snap/.../action`).
- Translates known inputs into `.github/snapdrift.json` and sets `provider: "snap"`.
- Emits `.github/MIGRATION_NOTES.md` grouped by severity (warnings first, then notes).
- Idempotent against `snapdrift.json`: refuses to overwrite an existing file.

The codemod maps fields one-to-one when it can. The full mapping is:

| Snap action input | snapdrift config |
|:------------------|:-----------------|
| `threshold` / `diff-threshold` | `diff.threshold` |
| `fail-on-changes` | `diff.mode: "fail-on-changes"` |
| `fail-on-incomplete` | `diff.mode: "fail-on-incomplete"` |
| (no enforcement flag) | `diff.mode: "report-only"` |
| `snap-api-key-env` | `snap.apiKeyEnv` |
| `snap-api-url` | `snap.apiUrl` |
| `snap-project-id` | `snap.projectId` |
| `format` | dropped (warning — SnapDrift is PNG-only) |
| `baseline_tag` | dropped (warning — SnapDrift uses commit-based baselines) |
| `routes` / page list | left empty (warning — fill in `routes[]` manually) |
| `baseUrl` | placeholder `http://localhost:3000` (warning — update to your real app) |

Two files are written: `.github/snapdrift.json` and `.github/MIGRATION_NOTES.md`.

## Snap provider

When `provider: "snap"`, every `capture` / `diff` / `publishBaseline` call goes through `SnapProvider`, which talks to Snap's hosted `/v1/visual/*` API instead of writing to the runner filesystem. The local provider keeps working exactly as before.

### Local-capture hybrid

If `baseUrl` resolves to a local address (see [`isLocalBaseUrl`](#islocalbaseurl-detection) below), SnapDrift runs Playwright on the runner to render the page and uploads the resulting screenshots to Snap. This is necessary whenever your `baseUrl` is a server only the runner can reach (the common case) — Snap's render worker cannot reach a `127.0.0.1` or `localhost` server.

The hybrid path is transparent to the user: the same provider factory picks it, and the output `results.json` carries `provider: "snap"` plus `captureMode: "local-upload"` so downstream consumers can tell which path produced the run. The action's `Install Playwright Chromium` step is gated on this hybrid, so a `provider: "snap"` config with a remote `baseUrl` will not download Playwright Chromium.

### API contract

SnapDrift uses a small, stable subset of the Snap API:

| Endpoint | Used by |
|:---------|:--------|
| `POST /v1/visual/projects/:id/runs` | Create a run; client passes `baseUrl`, `trigger`, optional `baselineId` and `branch` |
| `POST /v1/visual/runs/:run_id/captures` | Submit each route as a capture; client passes `routeId`, `routePath`, `viewportDescriptorJson` |
| `POST /v1/visual/captures/:capture_id/local-result` | Hybrid path: upload the locally rendered PNG and its dimensions |
| `POST /v1/visual/projects/:id/baselines` | Publish a baseline from a run's rendered captures (primary path) or upload a pre-built local baseline (migration path) |
| `GET /v1/visual/projects/:id/baselines/latest` | Resolve the latest accepted baseline for diff runs |
| `GET /v1/visual/runs/:run_id` | Poll a run until it reaches a terminal state (`pass`, `fail`, `error`, or `new`) |

`new` is a terminal state for baseline runs: a fresh capture with no baseline to diff against settles to `new` and `publishBaseline` harvests its object keys. Treating `new` as in-flight (the natural reading) would have the client poll forever.

### Retry and fallback

The Snap HTTP client classifies responses and applies the following rules:

- **2xx** — success, return the parsed body.
- **4xx** — non-retryable. The client throws `SnapApiError(status, message, path)` immediately. `onUnavailable` is **not** consulted for 4xx — a 404 from `/baselines/latest` is a "no baseline yet" signal, but a 4xx from `/runs` is a configuration error that retrying won't fix.
- **5xx** — retryable up to 3 attempts with exponential backoff (`1 s` → `2 s` → `4 s`, capped at `30 s` total). If the final attempt still returns 5xx, the client falls through to the `onUnavailable` handler.
- **Network errors** — same retry/backoff behavior as 5xx. After exhaustion, falls through to the `onUnavailable` handler.

`onUnavailable` is consulted once retries are exhausted:

- `"fail"` (default) — throw the underlying error to fail the action.
- `"warn-and-skip"` — log a warning, throw `SnapSkipError`. The wrapper actions catch this and write a skipped summary, exiting 0.
- `"fallback-local"` — log a warning, throw `SnapFallbackError`. The wrapper actions catch this and continue the pipeline with `LocalProvider`.

### `isLocalBaseUrl` detection

`isLocalBaseUrl(baseUrl)` returns `true` when the URL hostname is:

- `localhost` or any subdomain ending in `.localhost`
- `0.0.0.0`
- `::1`
- Any IPv4 address in `127.0.0.0/8` (for example `127.0.0.1`)

The function is intentionally permissive about bracketed IPv6 (`[::1]`) and case (`LocalHost`). It returns `false` on any URL that fails to parse.

### Error classes

All four error classes are exported from `lib/provider.mjs` (and re-exported by the underlying `@snapdrift/manifest` package). They are the contract for "Snap cannot proceed" — wrapper actions and CLI commands handle them as a group.

| Class | Thrown when | Typical handler |
|:------|:------------|:----------------|
| `SnapApiError` | A 4xx response was received, or a 5xx/network error was retried to exhaustion. Carries `status` and `path` properties. | Surface the message; do not retry. |
| `SnapUnavailableError` | A network error or 5xx was retried to exhaustion (used internally; usually re-wrapped as `SnapApiError`). | Treat as a temporary outage. |
| `SnapFallbackError` | `onUnavailable: "fallback-local"` is set and Snap could not be reached. | Catch and switch to `LocalProvider` for the rest of the pipeline. |
| `SnapSkipError` | `onUnavailable: "warn-and-skip"` is set and Snap could not be reached. | Catch and exit cleanly with a skipped summary. |

The wrapper actions (`actions/baseline`, `actions/pr-diff`) catch `SnapSkipError` and `SnapFallbackError` themselves. Custom orchestrations that call `provider.capture()` or `provider.diff()` directly should do the same.

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
