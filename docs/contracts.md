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
| `id` | `string` | Unique route identifier across runs. Its sanitized screenshot filename must also be unique across the full configured route set. |
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

Changed-file scoping treats a GitHub `renamed` record as both the current
`filename` and its nonempty `previous_filename`. This keeps a route selected
when a watched file moves out of its configured `changePaths`, and also detects
renames into watched or shared paths. Duplicate paths are ignored; other change
statuses use only their current filename. The `pr-diff` wrapper's explicit
`route-ids` and `force-run` inputs take precedence over this lookup; the
standalone `scope` action supports `force-run` and otherwise derives its
selection from the changed files. If GitHub returns the maximum 3,000 file
records, both actions run all configured routes with reason
`changed_files_truncated` because the list may be incomplete.

Route ids are sanitized before local captures and Snap baseline exports write
`screenshots/<route-id>.png`: `..` becomes `_`, path separators become `_`, and
control characters are removed. Distinct route ids that produce the same
sanitized filename are rejected before capture starts. Rename one of the route
ids and recapture the affected baseline; existing screenshot filenames remain
unchanged for noncolliding ids.

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

Every manifest entry must use a unique staged screenshot filename (the basename
of `imagePath`). Duplicate paths or paths that flatten to the same filename are
rejected before comparison, even when the run selects only one of the affected
route ids, because they can point two logical screenshots at the same pixels.
Rename the conflicting route ids and recapture the baseline and current bundle.

### Baseline resolution

The `actions/resolve-baseline` action and the `actions/pr-diff` wrapper distinguish three lookup
outcomes: `found` means a successful search selected a non-expired artifact, `missing` means a
successful search found no usable artifact, and `error` means GitHub returned an API, network, or
malformed-response failure. The boolean `found` output remains available for compatibility; use
`resolution-status` on `resolve-baseline` or `baseline-resolution-status` on `pr-diff` when the
reason matters. A missing baseline may produce the intentional first-run skipped summary. A lookup
error fails local comparisons and local Snap fallbacks, so infrastructure failures cannot be
reported as a clean or intentional missing-baseline result. Healthy hosted Snap diffs may continue
using their hosted baseline path after a GitHub artifact lookup error.
The standalone `actions/resolve-baseline` action fails its step for `error`; custom workflows
should branch on `resolution-status` rather than treating `found: false` as proof that no baseline
exists.

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

A summary with `status: "skipped"` — or any summary carrying no `diff.mode` —
never stops the run, whichever mode is configured. A skipped run has no diff
counters to enforce against, so `shouldFailDriftCheck` returns `false` for it
before any mode branch is reached. This holds for `actions/enforce` invoked
directly, not just for the guarded enforcement step inside `actions/pr-diff`.

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

- Downloads the project's export archive from Snap's export endpoint (`GET /v1/visual/projects/:id/export`, a tar containing every accepted baseline's screenshots, capture profile, and source manifest). Requires an API key with the `visual:export` scope.
- Imports the **most recent accepted baseline** (by `createdAt`) from the archive; older accepted baselines in the export are ignored.
- Writes `results.json`, `manifest.json`, and `screenshots/*.png` to the local baseline directory. Screenshot filenames are derived from the baseline's route ids (`screenshots/<routeId>.png`), matching what a local capture would produce.
- Writes `.migration-metadata.json` next to the baseline recording `source`, `migratedAt`, and the engine that produced the export.
- Without `--accept-cross-engine`: hard-errors if the exported baseline's engine name is not `snapdrift-local` (e.g. `snap-hosted` for baselines rendered by Snap's worker).
- With `--accept-cross-engine`: overrides the engine name to `snapdrift-local` in the imported manifest (visual differences may occur when the captures came from a different engine).
- Fails with an actionable message — instead of producing a partial baseline — when the project has no accepted baselines, when the selected baseline predates manifest tracking (no source manifest recorded at publish time), when the key lacks the `visual:export` scope (403), or when the export exceeds Snap's size caps (413).

### init

**Translate a Snap action workflow to snapdrift.json:**

```
snapdrift init --from-snap-action <workflow-yaml-path>
```

- Reads an existing `snap/github-action` workflow YAML.
- Locates the step that uses `snap/github-action` (or any action whose `uses:` matches `snap/.../action`).
- Translates known inputs into `.github/snapdrift.json`. Sets `provider: "snap"` (and the `snap` block) only when the source workflow declared `snap-api-key-env` or `snap-project-id`; workflows without Snap-specific inputs produce a local-provider config.
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

### Complete hosted baseline publication

A hosted baseline is an authoritative complete snapshot. For `purpose: "baseline"`, `SnapProvider.capture()` requires the selected route ids to equal the complete configured route set; `route-ids`, `--routes`, and `SNAPDRIFT_ROUTE_IDS` may not reduce it. It requires a resolved branch, 40-character commit SHA, publication workflow ref, and positive publication sequence. GitHub Actions provides these as `GITHUB_REF_NAME`, `GITHUB_SHA`, `GITHUB_WORKFLOW_REF`, and `GITHUB_RUN_NUMBER`; other CI systems may set `SNAPDRIFT_PUBLICATION_WORKFLOW_REF` and `SNAPDRIFT_PUBLICATION_SEQUENCE`. Local-provider baselines, non-publishing hosted captures, and hosted PR-diff runs retain scoped behavior.

The capture `results.json` records `configuredRouteIds`, `selectedRouteIds`, and `expectedCaptures` (route id, path, and viewport descriptor), plus one resolved `refBranch` / `refSha`, publication workflow ref, and publication sequence. The run-creation request sends the same immutable set and sequence as `capturePlan` and sends the ref as `branch` / `prHeadSha`. Before publication, SnapDrift requires the source run to belong to the configured project, settle to terminal `new`, and contain exactly one successful `new` capture with a non-empty `currentObjectKey` for every expected route/viewport identity. It keeps polling while any expected capture remains non-terminal, even when an older server reports the run itself as terminal, but fails fast after a stable incomplete capture set. Failed, missing, duplicate, extra, path-mismatched, or malformed captures abort before the baseline request. If another default-branch baseline wins first, Snap returns `409 baseline_stale_source`; rerun the current baseline job.

Hosted PR diffs use the same persisted `expectedCaptures` identities. `SnapProvider.diff()` requires `purpose: "diff"` plus a nonempty, unique expected set consistent with `selectedRouteIds`; results written by older SnapDrift versions without that set must be recaptured. It polls until the expected capture count is available, verifies the returned run id, and reconciles every returned capture by route id, path, and normalized viewport descriptor. Missing expected captures, duplicate or unexpected identities, pending or unknown statuses, run or capture errors, missing current objects, and invalid `diffPct` values produce an `incomplete` summary and are never counted as clean matches. A valid comparison requires a current object, a baseline object, and a finite numeric mismatch ratio from 0 through 1. The `diff.mode` setting then controls whether that incomplete summary fails the check.

Publication sends `publicationMode: "complete"` and the source run id both as top-level `sourceRunId` and as `manifest.sourceRunId`. The baseline id is deterministically derived from the run id, and manifest routes are sorted, so a retry sends the same identity and payload. Reusing that id with different persisted fields is rejected; rerun the baseline job to obtain a new source run. `refBranch` / `refSha` come from the persisted capture metadata rather than resolving git a second time. Snap accepts complete publication only from the project's default branch (effective default `main`).

### Local-capture hybrid

If `baseUrl` resolves to a local address (see [`isLocalBaseUrl`](#islocalbaseurl-detection) below), SnapDrift runs Playwright on the runner to render the page and uploads the resulting screenshots to Snap. This is necessary whenever your `baseUrl` is a server only the runner can reach (the common case) — Snap's render worker cannot reach a `127.0.0.1` or `localhost` server.

The hybrid path is transparent to the user: the same provider factory picks it, and the output `results.json` carries `provider: "snap"` plus `captureMode: "local-upload"` so downstream consumers can tell which path produced the run. The action's `Install Playwright Chromium` step is gated on this hybrid, so a `provider: "snap"` config with a remote `baseUrl` will not download Playwright Chromium.

### API contract

SnapDrift uses a small, stable subset of the Snap API:

| Endpoint | Used by |
|:---------|:--------|
| `POST /v1/visual/projects/:id/runs` | Create a run; client passes `baseUrl`, `trigger`, optional `baselineId` and `branch`, plus the immutable configured/selected route and expected-capture plan; baseline runs also pass the resolved commit as `prHeadSha` |
| `POST /v1/visual/runs/:run_id/captures` | Submit each route as a capture; client passes `routeId`, `routePath`, `viewportDescriptorJson` |
| `POST /v1/visual/captures/:capture_id/local-result` | Hybrid path: upload the locally rendered PNG and its dimensions |
| `POST /v1/visual/projects/:id/baselines` | Publish a complete default-branch baseline from a source run's validated captures |
| `GET /v1/visual/projects/:id/baselines/latest` | Resolve the latest accepted baseline for diff runs |
| `GET /v1/visual/runs/:run_id` | Poll a run until it reaches a terminal state (`pass`, `fail`, `error`, or `new`) |

`new` is a terminal state for baseline runs: a fresh capture with no baseline to diff against settles to `new` and `publishBaseline` harvests its object keys. Treating `new` as in-flight (the natural reading) would have the client poll forever.

### Retry and fallback

The Snap HTTP client classifies responses and applies the following rules:

- **2xx** — success, return the parsed body.
- **4xx** — non-retryable. The client throws `SnapApiError(status, message, path)` immediately. `onUnavailable` is **not** consulted for 4xx — a 404 from `/baselines/latest` is a "no baseline yet" signal, but a 4xx from `/runs` is a configuration error that retrying won't fix. If the diagnostic body itself stalls or is unavailable, the same `SnapApiError` retains the HTTP status and includes that diagnostic failure.
- **5xx** — retryable up to 3 attempts with exponential backoff (`1 s` → `2 s` → `4 s`, with each delay capped at `30 s`). If the final attempt still returns 5xx, the client falls through to the `onUnavailable` handler.
- **Network errors and transport timeouts** — same retry/backoff behavior as 5xx. After exhaustion, falls through to the `onUnavailable` handler.

Every JSON request attempt has a 30-second limit; binary export attempts have a
120-second limit. Headers and response bodies share the applicable attempt
limit, and each public Snap operation has one 10-minute deadline covering all
of its requests, retries, backoff, and polling. The client passes an
`AbortSignal` to fetch and aborts/cancels stalled bodies; injected transports
that ignore cancellation are still released by the client-side deadline.
Retry and poll waits are clipped to the remaining operation time, so no new
request starts after the operation deadline. Deadline exhaustion is treated as
Snap unavailability and follows `onUnavailable`; received 4xx responses keep
their immediate non-retryable behavior, and a stalled 4xx diagnostic body
retains its HTTP status with a timeout diagnostic.

`onUnavailable` is consulted once retries are exhausted:

- `"fail"` (default) — throw the underlying error to fail the action.
- `"warn-and-skip"` — log a warning, throw `SnapSkipError`. The wrapper actions catch this and write a skipped summary, exiting 0.
- `"fallback-local"` — log a warning, throw `SnapFallbackError`. The wrapper actions catch this and continue the pipeline with `LocalProvider`.

### Outage policy

Snap can go down at any phase of a run, and the configured `onUnavailable`
behavior has to hold for all of them. `lib/outage-policy.mjs` is the single
implementation, used by `lib/cli.mjs`, `actions/baseline` and `actions/pr-diff`
alike:

| Phase | `warn-and-skip` | `fallback-local` |
|:------|:----------------|:-----------------|
| Capture | Write a skipped `summary.json`/`summary.md` with reason `snap_unavailable`, expose the summary outputs, stage the report, exit 0. | Capture with `LocalProvider` and report the **effective** provider (`local`) so the rest of the pipeline uses local artifacts and the local pixel engine. |
| Diff | Same skipped summary, exit 0. | Diff with `LocalProvider`. A capture that Snap rendered server-side has no PNGs on the runner, so the routes are **recaptured locally first**; the recaptured paths replace the Snap ones in the staged bundle. If baseline resolution succeeded but no artifact was found, the run reports `missing_main_baseline_artifact`; a lookup error fails instead of entering the missing-baseline path. |
| Baseline publish | Skip the publish and exit 0 without an artifact. | Capture locally and stage/upload that bundle, so the run still leaves a usable baseline. |

Enforcement of `diff.mode` never runs against a skipped summary — a skipped run
carries no diff counters, and `warn-and-skip` means "do not fail my build".

A `fallback-local` capture leaves nothing on Snap: no run is published and no
baseline is created. The fallback is a local run, not a deferred hosted one.

### `isLocalBaseUrl` detection

`isLocalBaseUrl(baseUrl)` returns `true` when the URL hostname is:

- `localhost` or any subdomain ending in `.localhost`
- `0.0.0.0`
- `::1`
- Any IPv4 address in `127.0.0.0/8` (for example `127.0.0.1`)

The function is intentionally permissive about bracketed IPv6 (`[::1]`) and case (`LocalHost`). It returns `false` on any URL that fails to parse.

### Error classes

All four error classes are exported from `lib/provider.mjs` and `lib/snap-provider.mjs`. They are the contract for "Snap cannot proceed" — wrapper actions and CLI commands handle them as a group.

| Class | Thrown when | Typical handler |
|:------|:------------|:----------------|
| `SnapApiError` | A 4xx response was received, including a response whose diagnostic body stalled. Carries `status` and `path` properties. A final 5xx response also retains its status when it reaches the outage handler. | Surface the message; do not retry. |
| `SnapUnavailableError` | A retryable network error, transport timeout, or operation deadline was exhausted. In fail mode this may be surfaced directly; skip and fallback modes wrap it in their policy error. | Treat as a temporary outage. |
| `SnapFallbackError` | `onUnavailable: "fallback-local"` is set and Snap could not be reached. | Catch and switch to `LocalProvider` for the rest of the pipeline. |
| `SnapSkipError` | `onUnavailable: "warn-and-skip"` is set and Snap could not be reached. | Catch and exit cleanly with a skipped summary. |

The wrapper actions (`actions/baseline`, `actions/pr-diff`) and the CLI both handle `SnapSkipError` and `SnapFallbackError` through `lib/outage-policy.mjs` (`captureWithPolicy`, `diffWithPolicy`, `publishBaselineWithPolicy`). Custom orchestrations that call `provider.capture()`, `provider.diff()` or `provider.publishBaseline()` directly should use those helpers rather than re-implementing the matrix.

`SnapTransportTimeoutError` is an internal diagnostic name used while a
request or response body is being bounded. It is not an additional public
error class; callers should handle the exported error classes above.

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


## Workspace TypeScript contracts

The four `@snapdrift/*` workspace packages expose their declarations through a
`types` export condition before the existing JavaScript entrypoint. ESM consumers
can use Bundler, Node16, or NodeNext module resolution with `strict: true` and
`skipLibCheck: false`; Node16/NodeNext consumers should use an ESM package or an
`.mts` entrypoint. The top-level `types` field remains for older tooling.

Install `typescript` and `@types/node` in the consuming development environment
for APIs that use Node buffers. Cross-package declaration dependencies are
declared by the package that needs them. `npm run check:package-types` packs the
workspace packages and checks isolated consumers in all three resolution modes,
including rejected invalid calls. `npm run typecheck` also checks declaration
bodies without skipping library checks.

These guarantees cover the workspace package entrypoints. They do not add type
entrypoints for the root `snapdrift` package's JavaScript subpaths. Package release
publication is required before existing registry consumers receive these fixes.

Comment renderers accept `VisualReportSummary`: a complete comparison summary or
a `VisualDriftStatusSummary` with a required status and reason. `buildDriftSummary`
and `writeDriftSummary` return the latter, preserving their supported non-skipped
statuses as well as intentional skips. Unrelated object literals are rejected.
Known viewport presets have complete descriptors; arbitrary string lookups may
return `undefined` and must be checked by consumers.

The packed type gate runs in PR CI and before release publication. It validates
the candidate workspace tarballs together, not already-published registry
versions. Release preparation must bump every changed published package and
raise sibling dependency floors to the versions that contain these type fixes
before publication; the gate alone does not validate that release-version step.
