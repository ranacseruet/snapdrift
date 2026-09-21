# Local CLI

The `snapdrift` CLI lets you run visual captures and diffs locally against a running app — no GitHub Actions required. Use it during development to validate UI changes before pushing.

## Prerequisites

- Node >= 22
- A running app reachable at the `baseUrl` in your config
- A `.github/snapdrift.json` config file (or pass `--config` to point to another path)

## Installation

The CLI ships with the `snapdrift` package. Install it globally or use `npx`:

```bash
# global
npm install -g snapdrift

# or without installing
npx snapdrift <command>
```

## Commands

### `snapdrift baseline`

Establishes the baseline for whichever provider the config selects. This is the command to reach for when seeding a project.

```
snapdrift baseline [options]
```

- **`provider: "local"`** — identical to `snapdrift capture`: the screenshots written to the baseline directory *are* the baseline.
- **`provider: "snap"`** — canonical baseline publication is CI-only. Run it on the Snap project's default branch; GitHub Actions supplies the publication metadata automatically, while another CI system may set `SNAPDRIFT_PUBLICATION_WORKFLOW_REF` and `SNAPDRIFT_PUBLICATION_SEQUENCE`. It captures every configured route, waits for the complete hosted run, then publishes a baseline referencing the stored objects. A local checkout without those metadata values fails before creating a hosted run, and partial `--routes` selection is rejected. `snapdrift capture` may still be used locally for non-publishing diagnostics.

`snap.onUnavailable` is honoured across both phases — the capture *and* the publish that follows it. `warn-and-skip` exits 0 without a baseline; `fallback-local` captures locally so you still end up with one.

**Baseline attribution.** A hosted publication records a 40-character commit and branch from GitHub Actions or the current git checkout, plus a publication workflow identity and sequence. Outside GitHub Actions, set `SNAPDRIFT_PUBLICATION_WORKFLOW_REF` and `SNAPDRIFT_PUBLICATION_SEQUENCE`; without them SnapDrift refuses to create a canonical hosted baseline.

**`snap.projectId` must be an explicit `prj_...` id** for local runs. `"auto"` derives the id from `GITHUB_REPOSITORY`, which is not set outside Actions — the command fails early telling you to set an explicit id.

**Options**

| Flag | Default | Description |
|:-----|:--------|:------------|
| `--config <path>` | `.github/snapdrift.json` | Path to the config file |
| `--routes <ids>` | all routes | Comma-separated route IDs for a local-provider baseline; hosted baselines require all configured routes |
| `--baseline-dir <path>` | `.snapdrift/baseline` | Directory to write baseline screenshots and metadata (local provider) |

**Example**

```bash
snapdrift baseline
# Scoped baseline capture remains available with provider: "local"
snapdrift baseline --routes home-desktop,home-mobile
```

---

### `snapdrift capture`

Captures full-page screenshots of all configured routes and saves them as a local baseline.

```
snapdrift capture [options]
```

Run this once to establish the baseline before making UI changes.

**Options**

| Flag | Default | Description |
|:-----|:--------|:------------|
| `--config <path>` | `.github/snapdrift.json` | Path to the config file |
| `--routes <ids>` | all routes | Comma-separated route IDs to capture |
| `--baseline-dir <path>` | `.snapdrift/baseline` | Directory to write baseline screenshots and metadata |

**Example**

```bash
snapdrift capture
snapdrift capture --routes home-desktop,home-mobile
snapdrift capture --baseline-dir snapshots/baseline
```

---

### `snapdrift diff`

Captures current screenshots, compares them against the local baseline, and writes a JSON summary, a markdown report, and a self-contained HTML report.

```
snapdrift diff [options]
```

**Options**

| Flag | Default | Description |
|:-----|:--------|:------------|
| `--config <path>` | `.github/snapdrift.json` | Path to the config file |
| `--routes <ids>` | all routes | Comma-separated route IDs to compare |
| `--baseline-dir <path>` | `.snapdrift/baseline` | Directory containing the baseline |
| `--current-dir <path>` | `.snapdrift/current` | Directory to write current screenshots |
| `--diff-dir <path>` | `.snapdrift/diff` | Directory to write the diff report |
| `--open` | off | Open the HTML report automatically after the diff |

**Example**

```bash
snapdrift diff
snapdrift diff --open
snapdrift diff --routes home-desktop --open
snapdrift diff --baseline-dir snapshots/baseline --diff-dir snapshots/diff
```

---

### `snapdrift migrate-baselines`

Export baselines from the hosted Snap backend to the local filesystem. Requires a config with `provider: "snap"` (or a `snap` block).

**`--to snap` is not supported (removed in 0.7.0).**

```bash
snapdrift migrate-baselines --to snap   # always fails
```

Snap cannot accept a pre-built local baseline bundle: the screenshots it carries are never uploaded to Snap storage, and its manifest references local filenames rather than Snap object keys, so the result would be a baseline with no pixels behind it. The endpoint rejects the request with `400 unsupported_baseline_body`. Use [`snapdrift baseline`](#snapdrift-baseline) instead — it captures each route through Snap so the images actually land in storage, then publishes a manifest that points at them.

**Download Snap baselines to a local directory:**

```bash
snapdrift migrate-baselines --to local --from snap
```

Snap must expose its export endpoint for this direction to succeed. If it doesn't, the command fails with an actionable error. By default the engine name on the exported manifest must be `snapdrift-local`; pass `--accept-cross-engine` to override the engine name in the imported manifest (visual differences may occur).

**Options**

| Flag | Default | Description |
|:-----|:--------|:------------|
| `--to <snap\|local>` | — | Migration target (required) |
| `--from <snap>` | — | Migration source (required when `--to local`) |
| `--accept-cross-engine` | off | Override the engine-name check when importing from Snap |
| `--config <path>` | `.github/snapdrift.json` | Path to the config file |
| `--baseline-dir <path>` | `.snapdrift/baseline` | Local baseline directory to read from or write to |

**Side effects**

A `.migration-metadata.json` file is written next to the local baseline after a successful download — it records the source engine, the migration timestamp, and a stable id used for idempotency on re-runs.

---

### `snapdrift init`

Translate an existing `snap/github-action` workflow into `snapdrift.json` with `provider: "snap"`. Use this when migrating an existing consumer repo from the upstream Snap action to SnapDrift.

```
snapdrift init --from-snap-action <workflow-yaml-path>
```

Reads the workflow YAML, locates the step that uses the Snap action, and translates its inputs:

| Snap action input | snapdrift config |
|:------------------|:-----------------|
| `threshold` / `diff-threshold` | `diff.threshold` |
| `fail-on-changes` | `diff.mode` (`"fail-on-changes"`) |
| `fail-on-incomplete` | `diff.mode` (`"fail-on-incomplete"`) |
| (none of the above) | `diff.mode` (`"report-only"`) |
| `snap-api-key-env` | `snap.apiKeyEnv` |
| `snap-api-url` | `snap.apiUrl` |
| `snap-project-id` | `snap.projectId` |
| `format` | (warning — PNG-only, format dropped) |
| `baseline_tag` | (warning — commit-based only) |
| `routes` / page list | (warning — fill in `routes[]` manually) |
| `baseUrl` | placeholder `http://localhost:3000` (warning — update to your real app) |

The codemod writes two files:

- `.github/snapdrift.json` — the translated config
- `.github/MIGRATION_NOTES.md` — every warning and deferred decision, grouped by severity

The command is **idempotent against `snapdrift.json`**: if the file already exists, the command refuses to overwrite and tells you to remove it manually.

---

## Typical local workflow

```bash
# 1. Start your app
npm start

# 2. Capture a baseline (once, before making changes)
snapdrift capture

# 3. Make your UI changes

# 4. Run a diff to see what changed
snapdrift diff --open
```

The `--open` flag opens the HTML report in your default browser when the diff is complete.

---

## Refreshing or acknowledging local baselines

New local manifests record a [v2 capture profile](contracts.md#local-capture-profile-v2)
with exact engine, Playwright/browser, OS, locale/timezone, and rendering settings.
Manifests are validated after loading; then, before resolving PNGs, comparison
checks the profiles and each selected route's id, exact configured path, and
normalized viewport. A mismatch produces an
`incompatible_capture` error and an `incomplete` summary, not a pixel drift
signal. Matching profiles can still have route-identity errors:
`summary.captureCompatibility.status` describes profiles only.

To refresh, serve the intended accepted application state using the same capture
environment and route config as future diffs. With `provider: "local"`, run:

```bash
snapdrift baseline --config .github/snapdrift.json --baseline-dir .snapdrift/baseline
```

This overwrites baseline metadata and captured screenshots; `snapdrift capture`
with the same options is equivalent for the local provider. Capture all routes
for a complete replacement, without `--routes` or `SNAPDRIFT_ROUTE_IDS` scoping.
Then serve the candidate application state and run:

```bash
snapdrift diff --config .github/snapdrift.json --baseline-dir .snapdrift/baseline --open
```

In CI, run the existing default-branch baseline workflow using the root action's
`mode: baseline` ([Quickstart](../README.md#quickstart)) or `actions/baseline`.
Use the same upgraded SnapDrift/action revision and runner environment for
baseline and PR captures, with artifact upload enabled; then rerun the PR diff.
A baseline captured on a different OS is not interchangeable merely because
both commands use Playwright.

For intentional nonblocking acknowledgement, set `diff.mode` to `report-only`
in the config and rerun `snapdrift diff --open`. This keeps the incompatibility
errors visible and **never overrides compatibility to compare pixels**; there
is no diff acceptance flag. `fail-on-incomplete` and `strict` fail on these
errors; `fail-on-changes` fails only if other comparable routes changed. Once
identity is compatible, a changed full-page PNG size is normal product drift,
not incompatibility, and fails `fail-on-changes` / `strict` even below threshold.

Legacy manifests with missing profiles or omitted/v1 profile schema remain
pixel-comparable after route checks, but report `unverified` with a warning.
Conflicting shared browser/revision, fonts hash, locale, or timezone fields, or
an explicit foreign engine on either side, are still incompatible. Malformed
manifests/profiles and unsupported profile schema versions abort comparison,
even in `report-only`; refresh rather than editing metadata to force a match.

Local capture now explicitly uses `en-US` and `UTC`; localized text/date changes
may require recapture after upgrading. Fonts are not fingerprinted, so keep
installed fonts consistent even when profiles are verified.

---

## Local directory layout

After running `capture` and `diff` with default paths:

```
.snapdrift/
  baseline/
    results.json          # capture metadata (status, dimensions, timing)
    manifest.json         # screenshot manifest (ids, paths, dimensions)
    screenshots/
      home-desktop.png
      home-mobile.png
  current/
    results.json
    manifest.json
    screenshots/
      home-desktop.png
      home-mobile.png
  diff/
    summary.json          # structured drift summary
    summary.md            # human-readable markdown report
    report.html           # self-contained HTML report with side-by-side images
    diffs/                # generated diff PNGs for changed routes
```

Add `.snapdrift/` to your `.gitignore` to keep local run output out of version control.

---

## Exit codes

| Code | Meaning |
|:-----|:--------|
| `0` | Clean — no drift above threshold, `diff.mode` is `report-only`, the command was intentionally skipped under `onUnavailable: "warn-and-skip"` (`diff`, `capture` and `baseline` all exit 0 in that case), or the command was a `capture` / `baseline` / `migrate-baselines --to local` / `init` that completed |
| `1` | Drift enforced — `diff.mode` caused the run to fail, a required command argument was missing, or the `--to local` engine-name check failed (see [Drift modes](../README.md#drift-modes)) |

Enforcement follows the same `diff.mode` rules as the GitHub Actions workflow. Set `"mode": "report-only"` for nonblocking report inspection; capture, input-validation, and other command failures still exit 1 and can prevent report generation.

---

## Console output

`snapdrift diff` prints a summary to stdout.

**Clean run:**

```
Capturing current screenshots to .snapdrift/current ...
Comparing against baseline ...

✅  SnapDrift — Clean
   Routes:   2
   Matched:  2
```

**Drift detected** (one or more routes changed):

```
🟡  SnapDrift — Drift detected
   Routes:   3
   Matched:  2
   Changed:  1

   Changed routes:
     • home-desktop (2.47% diff)

Report: .snapdrift/diff/report.html
```

**Incomplete run** (errors or missing captures):

```
❌  SnapDrift — incomplete
   Routes:   4
   Matched:   2
   Changed:   0
   Missing:   1
   Errors:    1
   Dim diff:  0

Report: .snapdrift/diff/report.html
```

The `Missing`, `Errors`, and `Dim diff` lines only print when their count is greater than zero. `summary.status` is the unstyled value from the run (`clean`, `changes-detected`, `incomplete`, or `skipped`).

The `report.html` path is printed whenever the status is anything other than `clean`; pass `--open` to also launch it in your default browser.

SnapDrift always applies comparison policy v1 unless an explicit v2 policy is
configured. It synthesizes v1 from `diff.threshold` when `diff` does not declare
one:

```json
"comparisonPolicy": { "version": 1, "threshold": 0.01 }
```

Set `version` to `2` to enable bounded vertical row alignment for equal-width
captures. Reports record aligned results and conservative coordinate fallbacks:

```json
"comparisonPolicy": { "version": 2, "threshold": 0.01 }
```

The report includes the baseline, current, and union-canvas dimensions in
`summary.md` and `report.html`, and stores changed-route diff PNGs under
`.snapdrift/diff/diffs/`. A completed dimension comparison is a normal changed
signal, so `fail-on-incomplete` does not fail solely because its dimensions
differ; `fail-on-changes` and `strict` still enforce it.

---

## Environment variables

| Variable | Applies to | Description |
|:---------|:-----------|:------------|
| `SNAPDRIFT_CAPTURE_CONCURRENCY` | `capture`, `diff` | Max concurrent route operations (positive integer, default `5`): route captures per viewport group, and per-route resolve/compare during `diff`. Each local capture attempt uses isolated browser storage. Set to `1` to serialize captures within each viewport group, without sharing storage. |
| `SNAPDRIFT_CONFIG_PATH` | `capture`, `diff`, `migrate-baselines` | Override the config file path. Equivalent to `--config`. |
| `SNAPDRIFT_ROUTE_IDS` | `capture`, `baseline`, `diff` | Comma-separated route ids to scope to. Equivalent to `--routes`; it may not reduce a hosted baseline's complete route set. |

`SNAPDRIFT_CAPTURE_CONCURRENCY` is the same env var consumed by the GitHub Actions wrapper; tweak it the same way for both environments.

---

## Tips

- **Partial runs**: use `--routes` to capture or compare only the routes you are actively changing. A hosted baseline is the exception: its GitHub Actions run always requires the complete configured route set.
- **Multiple baselines**: use `--baseline-dir` to maintain separate baselines per branch or feature.
- **CI parity**: the CLI uses the same capture and comparison engine as the GitHub Actions workflow, so results are comparable.
- **Self-contained HTML report**: `report.html` embeds baseline, current, and diff images as base64. Open it from any machine — no server required, and no relative-path resolution surprises. (The HTML report is a local-CLI feature; the GitHub Actions wrapper ships only `summary.json` + `summary.md` in its artifact bundle.)
- **Provider-aware behavior**: with `provider: "snap"`, the `capture` and `diff` commands will hit the Snap API. The `--open` flag still opens the locally generated `report.html`; the Snap dashboard link lives in the PR comment, not the local output.
