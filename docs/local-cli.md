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
- **`provider: "snap"`** — captures each route through Snap, waits for the hosted renders to finish, then publishes a baseline referencing the stored objects. `snapdrift capture` alone does **not** do this: it submits the run and stops, leaving the project with no baseline.

`snap.onUnavailable` is honoured across both phases — the capture *and* the publish that follows it. `warn-and-skip` exits 0 without a baseline; `fallback-local` captures locally so you still end up with one.

**Baseline attribution.** The published baseline records the branch and commit it was cut from. Inside GitHub Actions these come from `GITHUB_REF_NAME` / `GITHUB_HEAD_REF` and `GITHUB_SHA`; run locally, they are read from git (`rev-parse --abbrev-ref HEAD` and `rev-parse HEAD`). Outside a git repository they fall back to `main` and `unknown`, so run the command from your checkout if you want the baseline attributed correctly.

**`snap.projectId` must be an explicit `prj_...` id** for local runs. `"auto"` derives the id from `GITHUB_REPOSITORY`, which is not set outside Actions — the command fails early telling you to set an explicit id.

**Options**

| Flag | Default | Description |
|:-----|:--------|:------------|
| `--config <path>` | `.github/snapdrift.json` | Path to the config file |
| `--routes <ids>` | all routes | Comma-separated route IDs to capture |
| `--baseline-dir <path>` | `.snapdrift/baseline` | Directory to write baseline screenshots and metadata (local provider) |

**Example**

```bash
snapdrift baseline
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
```

Add `.snapdrift/` to your `.gitignore` to keep local run output out of version control.

---

## Exit codes

| Code | Meaning |
|:-----|:--------|
| `0` | Clean — no drift above threshold, `diff.mode` is `report-only`, the diff was intentionally skipped (e.g. `SnapSkipError` from `onUnavailable: "warn-and-skip"`), or the command was a `capture` / `migrate-baselines` / `init` that completed |
| `1` | Drift enforced — `diff.mode` caused the run to fail, a required command argument was missing, or the `--to local` engine-name check failed (see [Drift modes](../README.md#drift-modes)) |

Enforcement follows the same `diff.mode` rules as the GitHub Actions workflow. Set `"mode": "report-only"` during local development to always get a report without a failing exit code.

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

**Incomplete run** (errors, missing captures, or dimension shifts):

```
❌  SnapDrift — incomplete
   Routes:   4
   Matched:   2
   Changed:   0
   Missing:   1
   Errors:    1
   Dim diff:  1

Report: .snapdrift/diff/report.html
```

The `Missing`, `Errors`, and `Dim diff` lines only print when their count is greater than zero. `summary.status` is the unstyled value from the run (`clean`, `changes-detected`, `incomplete`, or `skipped`).

The `report.html` path is printed whenever the status is anything other than `clean`; pass `--open` to also launch it in your default browser.

---

## Environment variables

| Variable | Applies to | Description |
|:---------|:-----------|:------------|
| `SNAPDRIFT_CAPTURE_CONCURRENCY` | `capture`, `diff` | Max concurrent route captures per viewport context (positive integer, default `5`). Set to `1` to restore serial behavior for apps with shared session or auth state. |
| `SNAPDRIFT_CONFIG_PATH` | `capture`, `diff`, `migrate-baselines` | Override the config file path. Equivalent to `--config`. |
| `SNAPDRIFT_ROUTE_IDS` | `capture`, `diff` | Comma-separated route ids to scope to. Equivalent to `--routes`. |

`SNAPDRIFT_CAPTURE_CONCURRENCY` is the same env var consumed by the GitHub Actions wrapper; tweak it the same way for both environments.

---

## Tips

- **Partial runs**: use `--routes` to capture or compare only the routes you are actively changing.
- **Multiple baselines**: use `--baseline-dir` to maintain separate baselines per branch or feature.
- **CI parity**: the CLI uses the same capture and comparison engine as the GitHub Actions workflow, so results are comparable.
- **Self-contained HTML report**: `report.html` embeds baseline, current, and diff images as base64. Open it from any machine — no server required, and no relative-path resolution surprises. (The HTML report is a local-CLI feature; the GitHub Actions wrapper ships only `summary.json` + `summary.md` in its artifact bundle.)
- **Provider-aware behavior**: with `provider: "snap"`, the `capture` and `diff` commands will hit the Snap API. The `--open` flag still opens the locally generated `report.html`; the Snap dashboard link lives in the PR comment, not the local output.
