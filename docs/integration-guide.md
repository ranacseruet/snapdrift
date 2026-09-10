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
  uses: ranacseruet/snapdrift@v0.10.0
  with:
    mode: baseline
    repo-config-path: .github/snapdrift.json
    artifact-retention-days: '30'
```

For a local-provider baseline, `route-ids` may select part of the route set. A hosted Snap baseline is authoritative and must run in GitHub Actions on the project default branch with every configured route, so a partial `route-ids` value or unresolved CI commit fails before a run is created. Route scoping remains supported in `pr-diff` mode. If you don't want to upload the artifact (for example when using the Snap provider, which uploads via its own API), set `upload-artifact: 'false'`.

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
  uses: ranacseruet/snapdrift@v0.10.0
  with:
    mode: pr-diff
    github-token: ${{ secrets.GITHUB_TOKEN }}
    repo-config-path: .github/snapdrift.json
```

## Choosing an entry point

`ranacseruet/snapdrift` is the GitHub Marketplace entry point. It is a thin dispatcher: `mode: baseline` runs the baseline pipeline and `mode: pr-diff` runs the pull request pipeline, forwarding every input and output of the underlying wrapper action.

The wrappers remain published in their own right, and are equivalent to the dispatcher:

| Entry point | Equivalent to |
|-------------|---------------|
| `ranacseruet/snapdrift@v0.10.0` with `mode: baseline` | `ranacseruet/snapdrift/actions/baseline@v0.10.0` |
| `ranacseruet/snapdrift@v0.10.0` with `mode: pr-diff` | `ranacseruet/snapdrift/actions/pr-diff@v0.10.0` |

Use the wrappers directly when you want to skip the dispatcher's input indirection, and the lower-level `capture`, `compare`, `scope`, `resolve-baseline`, `stage`, `comment`, and `enforce` actions when you need to orchestrate the stages yourself.

### Pinning

The dispatcher loads its wrapper from a pinned ref of this same repository. Released versions pin that ref to a commit SHA, so resolving `ranacseruet/snapdrift` to a SHA freezes the whole chain. If you are consuming an unreleased ref (`@main`, or a branch), the inner ref is a tag instead, and a SHA pin on the dispatcher does not freeze what it delegates to — pin the wrapper actions directly if that matters to you.

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
        uses: ranacseruet/snapdrift@v0.10.0
        with:
          mode: pr-diff
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
        uses: ranacseruet/snapdrift@v0.10.0
        with:
          mode: pr-diff
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

When the wrapper scopes a pull request from GitHub's changed-file list, a
renamed file contributes both its new and previous paths. A move out of a
watched directory therefore still selects the route that owned the old path,
while a move into a watched or shared path selects the new scope as well.
Repeated paths are deduplicated, and `route-ids` or `force-run` keep their
existing precedence. GitHub caps this file listing at 3,000 records; if that
limit is reached, the actions run all configured routes with scope reason
`changed_files_truncated` instead of trusting a potentially incomplete list.

## Useful overrides

| Input | Default | Purpose |
|-------|---------|---------|
| `repo-config-path` | `.github/snapdrift.json` | Override the config file path |
| `pr-number` | inferred from event | Explicit PR number override |
| `route-ids` | scope-derived | Bypass scope detection and capture named routes (comma-separated) |
| `force-run` | `false` | Run the full route set instead of using changed-file scope |
| `force-run-reason` | `forced` | Reason string emitted to scope outputs when `force-run: true` |
| `baseline-repository` | current repo | Read baselines from another repo (`owner/name`) |
| `baseline-workflow-id` | `ci.yml` | Override the baseline workflow id or filename |
| `baseline-branch` | `main` | Override the branch the baseline was published from |
| `artifact-retention-days` | `30` | Retention period for the uploaded diff artifact |
| `comment-on-pr` | `true` | Set to `false` to suppress the PR report upsert |
| `max-changed-rows` | `20` | Max changed-route rows shown in the PR comment before truncation |
| `max-error-rows` | `10` | Max error rows shown in the PR comment before truncation |

The `pr-diff` action also exposes outputs you can use in subsequent steps: `should-run`, `scope-reason`, `selected-route-ids`, `baseline-found`, `baseline-resolution-status`, `status`, `summary-path`, `markdown-path`, `artifact-name`, `bundle-dir`. `baseline-resolution-status` is `found`, `missing`, or `error`; `missing` is the intentional first-baseline case, while `error` means the GitHub lookup failed and causes local comparisons or local Snap fallbacks to fail. Healthy hosted Snap diffs can continue without the downloaded GitHub artifact. See the wrapper action's `outputs:` block for the canonical list.

## Hosted Snap provider

By default SnapDrift writes baselines and reports to the runner filesystem (`provider: "local"`). For a hosted backend with a shared baseline store and a run-detail dashboard, configure `provider: "snap"` in `snapdrift.json`:

```json
{
  "provider": "snap",
  "snap": {
    "apiKeyEnv": "SNAP_API_KEY",
    "projectId": "auto",
    "onUnavailable": "fail"
  }
}
```

- `apiKeyEnv` — name of an environment variable holding the Snap API key. Mutually exclusive with `apiKey`. Exactly one of `apiKeyEnv` or `apiKey` is required.
- `apiKey` — inline API key with `${VAR}` interpolation (e.g. `"${SNAP_API_KEY}"`). Mutually exclusive with `apiKeyEnv`.
- `projectId` — Snap project id, or `"auto"` to derive it from `GITHUB_REPOSITORY` (default).
- `onUnavailable` — behavior when the Snap API cannot be reached:
  - `"fail"` (default) — fail the action with a non-retryable error.
  - `"warn-and-skip"` — log a warning, write a skipped summary, and exit 0.
  - `"fallback-local"` — log a warning and run the rest of the pipeline with `LocalProvider`.

Both behaviors apply at every phase of a run — capture, diff, and baseline publish. `fallback-local` switches the whole remainder of the pipeline to local artifacts and the local pixel engine; if Snap had already rendered the current capture server-side, the routes are recaptured on the runner first, so `actions/pr-diff` needs Playwright available (the wrapper installs it whenever `onUnavailable` is `fallback-local`). Nothing is published to Snap on a fallback run. See [Outage policy](contracts.md#outage-policy) for the full matrix.

Hosted baseline publication is complete and default-branch-only. SnapDrift rejects scoped baseline capture before creating the run, records the configured/selected route ids and exact route/viewport identities, and publishes only when every expected capture finishes successfully with a stored image. The run records one resolved branch and commit (`branch` / `prHeadSha`) plus a publication workflow ref and monotonic sequence. GitHub Actions provides these automatically; other CI systems may set `SNAPDRIFT_PUBLICATION_WORKFLOW_REF` and `SNAPDRIFT_PUBLICATION_SEQUENCE`. Snap uses the sequence for same-workflow ordering and source-run timestamps for cross-workflow freshness. Missing, failed, duplicate, or unexpected captures abort publication without replacing the accepted baseline. If a source run loses the race to a newer candidate, the API returns `409 baseline_stale_source`; an inconsistent manifest/source workflow identity returns `409 baseline_source_run_mismatch` with `details.reason = "workflow_mismatch"`. Workflow-ref rotation itself is supported. This restriction does not apply to non-publishing hosted captures, hosted PR-diff runs, or local-provider baselines.

The Snap API client retries 5xx, network errors, and transport timeouts with exponential backoff (3 attempts, 1 s → 2 s → 4 s, with each delay capped at 30 s). JSON request attempts are limited to 30 seconds and binary baseline exports to 120 seconds. Each Snap operation has a 10-minute deadline covering its requests, retries, backoff, and polling; stalled headers and response bodies are aborted and cannot keep the workflow waiting indefinitely. Retry and poll waits are clipped to the remaining operation time. Received 4xx errors never retry or fall back; if a 4xx diagnostic body stalls, the response remains a non-retryable error with its HTTP status and timeout diagnostic. When a deadline or other retryable transport failure is exhausted, `onUnavailable` controls fail, warn-and-skip, or fallback-local behavior.

When `provider: "snap"` and `baseUrl` points to a local address (localhost, `127.0.0.0/8`, `::1`, or `0.0.0.0`), SnapDrift uses a **local-capture hybrid**: Playwright runs on the runner to render the page, then SnapDrift uploads the resulting screenshots to Snap. This makes it possible to point SnapDrift at a server that only the runner can reach (a typical case) without exposing the server to Snap's render worker.

With the Snap provider, the PR comment includes a **"View in dashboard →"** link that points to `${apiUrl}/dashboard/visual/${projectId}/runs/${runId}`. The local provider omits the link.

Migrating an existing local repo to the Snap provider is a one-shot CLI command:

```bash
snapdrift migrate-baselines --to snap
```

Conversely, downloading a Snap baseline back to a local directory (useful for reproducible local debugging) is:

```bash
snapdrift migrate-baselines --to local --from snap
```

The reverse direction downloads the project's export archive from Snap (`GET /v1/visual/projects/:id/export`, which requires an API key with the `visual:export` scope) and imports the most recent accepted baseline into the local baseline directory. See the [Contracts reference](contracts.md#migration-commands) for the full flag set, the engine-compatibility check, and the metadata file written for idempotency.

If you're adopting SnapDrift as a replacement for the upstream `snap/github-action`, the `init` codemod translates the workflow YAML and emits a `MIGRATION_NOTES.md` with everything that couldn't be auto-translated:

```bash
snapdrift init --from-snap-action .github/workflows/snap.yml
```

## Low-level actions

The `pr-diff` wrapper composes the following low-level steps. They're still available for custom orchestration but most consumers don't need to reach for them:

- `actions/capture` — capture routes and emit `results.json` + `manifest.json`
- `actions/compare` — diff current capture against a baseline
- `actions/scope` — decide whether to run and which routes to select from changed files
- `actions/resolve-baseline` — find and download the latest successful baseline artifact; its
  `resolution-status` output distinguishes `found`, `missing`, and `error`; the action fails for
  `error`, while `missing` remains the intentional first-baseline result
- `actions/stage` — assemble the baseline or diff bundle for upload
- `actions/enforce` — evaluate the summary against `diff.mode` and fail when required
- `actions/comment` — upsert a PR comment from a summary (provider-aware)

The two wrapper actions that orchestrate the full pipeline are `actions/baseline` (publish) and `actions/pr-diff` (drift detection). They are the primary integration points.

## Local development

The `snapdrift` CLI lets you run captures, diffs, migrations, and config initialization locally against a running app. Use it to validate UI changes on your machine before pushing — the same capture and comparison engine is used in both contexts.

```bash
# Establish a baseline before making UI changes
snapdrift capture

# After making changes, compare and open the HTML report
snapdrift diff --open

# Migrate an established local baseline to the hosted Snap backend
snapdrift migrate-baselines --to snap

# Translate a snap/github-action workflow into snapdrift.json
snapdrift init --from-snap-action .github/workflows/snap.yml
```

The CLI reads the same `.github/snapdrift.json` config used by the Actions workflow. Local outputs land in `.snapdrift/` by default and can be overridden with `--baseline-dir`, `--current-dir`, and `--diff-dir`.

See the [Local CLI guide](local-cli.md) for full command reference, flags, directory layout, and examples.

## Refresh the baseline automatically

After an intentional layout change merges, the baseline can be republished as
usual. Legacy local comparisons still require like-for-like dimensions; an
updated local client may opt into the exact
`diff.comparisonPolicy: { "version": 1, "threshold": number }` contract to
compare unequal frames on a union canvas and keep the dimension metadata in the
report.

Use the provided workflow template to refresh the baseline automatically on every push to your default branch (i.e. every merge):

**`docs/workflow-templates/refresh-baseline-on-merge.yml`**

Drop a copy into your repo at `.github/workflows/snapdrift-refresh-baseline.yml`, then fill in the `TODO` blocks with your app's build and start steps — the same steps you use in your PR workflow. The template uses a `push` trigger on the default branch so published artifacts are discoverable by the baseline resolver in `actions/pr-diff`.

Run this job after every successful default-branch build. Hosted publication is the only operation that may intentionally remove a configured route from the canonical baseline, so skipping merges can leave later PRs comparing against stale route configuration.

## Troubleshooting

**"No non-expired SnapDrift baseline artifact was found"**  
The baseline workflow has not completed successfully on `main`, or the artifact expired. With the Snap provider, the equivalent situation is a 404 from `/v1/visual/projects/:id/baselines/latest`; `SnapProvider` swallows that 404 and proceeds without a baseline — `onUnavailable` is **not** consulted for this case (a 404 is the legitimate "no baseline yet" signal, not a Snap outage). If you want the PR pipeline to tolerate the first-run case, set `diff.mode: "report-only"`; `onUnavailable: "warn-and-skip"` will not help here.

**"Unable to resolve the SnapDrift baseline artifact"**
GitHub failed while listing workflow runs or artifacts. Check the job's `actions: read` permission,
repository/workflow/branch inputs, and GitHub API availability. Snap hosted diffs can still use the
hosted comparison path, but local comparisons and `fallback-local` require a successful GitHub
artifact lookup.

**403 when posting the PR report**  
Grant `issues: write` and `pull-requests: write` to the job.

**Snap API request keeps failing with 4xx**  
The Snap client never retries 4xx and never falls back, even when `onUnavailable` is set. Inspect the response body — the most common cause is a project-id mismatch between `GITHUB_REPOSITORY` (auto-derived) and the project's id on Snap.

**Screenshots have different dimensions**  
Without `diff.comparisonPolicy`, SnapDrift reports this as a legacy dimension
shift and skips pixel comparison. With the exact v1 policy, it compares the
top-left-aligned union canvas, records the route in `changed[]`, and writes a
local diff PNG; refresh the baseline after an intentional change when you want
future runs to return to equal-size comparisons.

**A route appears in `errors[]`**  
Capture failed before comparison. Confirm the app is fully ready and reachable before SnapDrift runs.

**Playwright install runs even though `provider: "snap"`**  
That's expected for the Snap local-capture hybrid. Playwright runs locally to render the page, then the resulting screenshot is uploaded to Snap. The hybrid kicks in only when `baseUrl` points to a local address; for remote `baseUrl` Snap's render worker captures directly.


## TypeScript package consumers

Import APIs and types from the public `@snapdrift/*` package names. Their export
maps support Bundler, Node16, and NodeNext resolution; enable `strict: true` and
`skipLibCheck: false` to validate the contracts in your project. For Node16 or
NodeNext, use `"type": "module"` or an `.mts` entrypoint. Install `typescript` and
`@types/node` as development dependencies when using the Node buffer APIs.

No TypeScript path aliases or imports into workspace source directories are
needed. Root `snapdrift/lib/*` subpath typing is separate from these workspace
contracts. The fixes become available to registry consumers after the packages
are released and their installed versions are updated.

The workspace packages are independently installable runtime packages. Install
the package you use from the registry and let npm resolve its declared runtime
dependencies; do not rely on a repository checkout or workspace links. The
filesystem adapter includes its reporting dependency, so `@snapdrift/adapter-fs`
can load config, capture, comparison, and report entrypoints from an isolated
consumer. Release a new adapter version before expecting an existing registry
installation to include a dependency correction.
