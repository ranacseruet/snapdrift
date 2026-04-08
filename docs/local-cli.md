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
| `0` | Clean — no drift above threshold, or `diff.mode` is `report-only` |
| `1` | Drift enforced — `diff.mode` caused the run to fail (see [Drift modes](../README.md#drift-modes)) |

Enforcement follows the same `diff.mode` rules as the GitHub Actions workflow. Set `"mode": "report-only"` during local development to always get a report without a failing exit code.

---

## Console output

`snapdrift diff` prints a summary to stdout:

```
Capturing current screenshots to .snapdrift/current ...
Comparing against baseline ...

✅  SnapDrift — Clean
   Routes:   2
   Matched:  2
```

When drift is detected:

```
🟡  SnapDrift — Drift detected
   Routes:   3
   Matched:  2
   Changed:  1

   Changed routes:
     • home-desktop (2.47% diff)

Report: .snapdrift/diff/report.html
```

---

## Tips

- **Partial runs**: use `--routes` to capture or compare only the routes you are actively changing.
- **Multiple baselines**: use `--baseline-dir` to maintain separate baselines per branch or feature.
- **CI parity**: the CLI uses the same capture and comparison engine as the GitHub Actions workflow, so results are comparable.
