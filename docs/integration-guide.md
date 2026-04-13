# Integration Guide

This guide covers integrating SnapDrift into a consumer repository from a public GitHub release.

Examples use the public release tag for readability. If your organization requires immutable pins, resolve the tag to a commit SHA and pin that instead.

## Prerequisites

- SnapDrift provisions Node 22 internally.
- The consumer app can use any stack as long as it can be started and reached at `baseUrl`.
- The runner must be Ubuntu-compatible because Playwright Chromium is installed with system dependencies.
- The runner must have outbound network access to fetch Playwright Chromium.

Your repository still owns:

- Checkout
- Dependency installation
- App build
- App startup and readiness
- App shutdown

SnapDrift owns route selection, capture, comparison, skipped-report generation, artifact staging, artifact upload, PR reporting, and drift enforcement.

## Step 1: Add `.github/snapdrift.json`

```json
{
  "baselineArtifactName": "my-app-snapdrift-baseline",
  "workingDirectory": ".",
  "baseUrl": "http://127.0.0.1:8080",
  "resultsFile": "qa-artifacts/snapdrift/baseline/current/results.json",
  "manifestFile": "qa-artifacts/snapdrift/baseline/current/manifest.json",
  "screenshotsRoot": "qa-artifacts/snapdrift/baseline/current",
  "routes": [
    { "id": "home-desktop", "path": "/", "viewport": "desktop" },
    { "id": "home-mobile", "path": "/", "viewport": "mobile" }
  ],
  "diff": {
    "threshold": 0.01,
    "mode": "report-only"
  }
}
```

## Step 2: Publish a baseline on `main`

```yaml
- name: SnapDrift Baseline
  uses: ranacseruet/snapdrift/actions/baseline@v0.2.1
  with:
    repo-config-path: .github/snapdrift.json
    artifact-retention-days: '30'
```

If you want only part of the route set, pass `route-ids`.

## Step 3: Run the pull request report

The PR workflow needs permission to download baselines and upsert the report comment:

```yaml
permissions:
  contents: read
  actions: read
  issues: write
  pull-requests: write
```

Then add SnapDrift after the app is running:

```yaml
- name: SnapDrift Report
  uses: ranacseruet/snapdrift/actions/pr-diff@v0.2.1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    repo-config-path: .github/snapdrift.json
```

## Example workflow (Node app)

```yaml
name: SnapDrift Pull Request

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  actions: read
  issues: write
  pull-requests: write

jobs:
  snapdrift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm run build

      - name: Start app
        run: |
          npm start &
          for i in $(seq 1 45); do
            curl -sf http://127.0.0.1:8080 && break || sleep 1
          done

      - name: SnapDrift Report
        uses: ranacseruet/snapdrift/actions/pr-diff@v0.2.1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          repo-config-path: .github/snapdrift.json
```

## Example workflow (Python app)

```yaml
name: SnapDrift Pull Request

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  actions: read
  issues: write
  pull-requests: write

jobs:
  snapdrift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -r requirements.txt

      - name: Start app
        run: |
          gunicorn myapp:app --bind 127.0.0.1:8080 &
          for i in $(seq 1 45); do
            curl -sf http://127.0.0.1:8080 && break || sleep 1
          done

      - name: SnapDrift Report
        uses: ranacseruet/snapdrift/actions/pr-diff@v0.2.1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          repo-config-path: .github/snapdrift.json
```

## What the wrapper does

- Resolves route scope unless `route-ids` is passed explicitly
- Downloads the latest successful `main` baseline
- Captures current frames
- Writes a skipped report when scope is irrelevant or the baseline is missing
- Stages and uploads the drift artifact
- Publishes the workflow summary
- Upserts the PR report
- Enforces `diff.mode` after publication completes

## Useful overrides

| Input | Purpose |
|-------|---------|
| `pr-number` | Explicit PR number override |
| `route-ids` | Bypass scope detection and capture named routes |
| `force-run` | Run the full route set |
| `baseline-repository` | Read baselines from another repo |
| `baseline-workflow-id` | Override the baseline workflow id |
| `baseline-branch` | Override the baseline branch |
| `comment-on-pr` | Set to `false` to suppress the PR report |
| `max-changed-rows` | Max changed-route rows shown before truncation (default: `20`) |
| `max-error-rows` | Max error rows shown before truncation (default: `10`) |

## Low-level actions

For custom orchestration:

- `actions/capture`
- `actions/compare`
- `actions/scope`
- `actions/enforce`
- `actions/comment`
- `actions/resolve-baseline`
- `actions/stage`

## Local development

The `snapdrift` CLI lets you run captures and diffs locally against a running app. Use it to validate UI changes on your machine before pushing — the same capture and comparison engine is used in both contexts.

```bash
# Establish a baseline before making UI changes
snapdrift capture

# After making changes, compare and open the HTML report
snapdrift diff --open
```

The CLI reads the same `.github/snapdrift.json` config used by the Actions workflow. Local outputs land in `.snapdrift/` by default and can be overridden with `--baseline-dir`, `--current-dir`, and `--diff-dir`.

See the [Local CLI guide](local-cli.md) for full command reference, flags, directory layout, and examples.

## Refresh the baseline automatically

After an intentional layout change or dimension shift merges, the baseline must be republished before SnapDrift can compare like-for-like frames again. Without automation, this is a manual step.

Use the provided workflow template to refresh the baseline automatically on every push to your default branch (i.e. every merge):

**`docs/workflow-templates/refresh-baseline-on-merge.yml`**

Drop a copy into your repo at `.github/workflows/snapdrift-refresh-baseline.yml`, then fill in the `TODO` blocks with your app's build and start steps — the same steps you use in your PR workflow. The template uses a `push` trigger on the default branch so published artifacts are discoverable by the baseline resolver in `actions/pr-diff`.

### Label-gated refreshes

If you don't want to republish the baseline on every push, the template includes a commented `if` condition that gates on a label (e.g. `snapdrift:refresh-baseline`). A preceding job can check the most recent merged PR for the label and set an output to control whether the baseline refresh runs.

## Troubleshooting

**"No non-expired SnapDrift baseline artifact was found"**  
The baseline workflow has not completed successfully on `main`, or the artifact expired.

**403 when posting the PR report**  
Grant `issues: write` and `pull-requests: write` to the job.

**Screenshots have different dimensions**  
SnapDrift reports this as a dimension shift and skips pixel comparison for that route. Refresh the baseline after the change lands.

**A route appears in `errors[]`**  
Capture failed before comparison. Confirm the app is fully ready and reachable before SnapDrift runs.
