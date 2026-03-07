# Repo Promotion Checklist

Step-by-step guide for extracting `snapdrift` from the `codesamplez-tools` monorepo into its own standalone GitHub repository.

---

## Pre-extraction (in `codesamplez-tools`)

Before touching the new repo, verify the module is in a clean, shippable state.

- [ ] All tests pass: `npm test --prefix snapdrift`
- [ ] No parent-directory escapes: no `../../` references in `lib/`, `tests/`, or `actions/`
- [ ] Template workflow paths use `./actions/...` (not `./snapdrift/actions/...`)
- [ ] `CHANGELOG.md` is up to date with anything notable since v1.0.0

---

## Step 1 — Create the new GitHub repo

- [ ] Create `<org>/snapdrift` on GitHub
- [ ] Set description: `Shared visual regression capture, compare, and reporting for GitHub Actions workflows`
- [ ] Add topics: `github-actions`, `visual-regression`, `playwright`, `screenshot-testing`, `visual-diff`
- [ ] Default branch: `main`
- [ ] Visibility: set to match intended audience (public for cross-org use)
- [ ] Disable "Projects" and "Wiki" unless needed; keep "Issues" enabled

---

## Step 2 — Extract the directory

Copy the directory contents into the new repo and start with a clean initial commit:

```bash
# Copy the module contents into the new repo root
cp -r /path/to/codesamplez-tools/snapdrift/. /path/to/snapdrift/

# In the new repo
git init
git add .
git commit -m "Initial commit: promote snapdrift v1"
git remote add origin https://github.com/<org>/snapdrift.git
git push -u origin main
```

---

## Step 3 — Update placeholders in the new repo

All `user/snapdrift` placeholders need to be replaced with the real `<org>/snapdrift`.

- [ ] `package.json` — `repository.url`, `homepage`, `bugs.url`
- [ ] `CONTRIBUTING.md` — `git clone` URL
- [ ] `README.md` — all `uses: user/snapdrift/actions/...@v1` references
- [ ] `SECURITY.md` — verify security contact email is correct
- [ ] `docs/promotion-checklist.md` — `<org>` placeholder references (or delete this file from the new repo; it is not needed there)

---

## Step 4 — Tidy up internal CI in the new repo

Minor inconsistencies noted during audit that are worth fixing at promotion time:

- [ ] `snapdrift/.github/workflows/ci.yml`: remove `--passWithNoTests` from the test step (tests exist, the flag is misleading)
- [ ] `snapdrift/.github/workflows/ci.yml`: align test command — use `npm test` instead of `NODE_OPTIONS='--experimental-vm-modules' npx jest` directly, since the `package.json` `test` script already sets `NODE_OPTIONS`

---

## Step 5 — GitHub repo settings

- [ ] Branch protection on `main`:
  - Require pull request before merging
  - Require status checks to pass (CI job)
  - Dismiss stale reviews on new pushes
- [ ] Allow GitHub Actions to create and approve pull requests: off (unless needed for automation)
- [ ] Add `CODEOWNERS` if multiple maintainers are expected
- [ ] Confirm Actions are enabled and the internal `ci.yml` runs on the first push

---

## Step 5a — Verify standalone CI before tagging

Do not cut the tag until the new repo's CI is confirmed clean in isolation.

- [ ] Confirm `ci.yml` runs and passes on the initial push (no monorepo `node_modules` bleed)
- [ ] Confirm `npm test` passes from a fresh `npm ci` in the new repo root
- [ ] Confirm `package.json` `version` is `1.0.0`

---

## Step 6 — Cut the v1 tag and release

- [ ] `git tag v1 && git push origin v1`
- [ ] Create a GitHub Release from the `v1` tag
- [ ] Use `CHANGELOG.md` v1.0.0 entry as the release notes body

---

## Step 7 — Update all consumers

With the new repo live and tagged, update every reference in each consumer repo.

### `codesamplez-tools` — workflow files

| File | Old path | New path |
|:-----|:---------|:---------|
| `.github/workflows/ci.yml` | `./snapdrift/actions/publish-visual-baseline` | `<org>/snapdrift/actions/publish-visual-baseline@v1` |
| `.github/workflows/pr-visual-diff.yml` | `./snapdrift/actions/run-visual-pr-diff` | `<org>/snapdrift/actions/run-visual-pr-diff@v1` |
| `.github/workflows/health-monitoring.yml` | `./snapdrift/actions/publish-visual-baseline` | `<org>/snapdrift/actions/publish-visual-baseline@v1` |

### Second consumer repo — workflow files

Update every `uses:` reference that currently points to the local module path, replacing with `<org>/snapdrift/actions/...@v1`. The exact files and paths depend on how that repo was wired during Phase 4.

### `codesamplez-tools` — CI step: remove the local test run

In `.github/workflows/ci.yml`, remove:

```yaml
- name: Run shared visual diff action tests
  run: npm test --prefix snapdrift
```

### `codesamplez-tools` — `package.json`: remove the ignore pattern

Remove `/snapdrift/` from `jest.testPathIgnorePatterns` (it becomes a no-op once the directory is gone, but clean it up).

### `codesamplez-tools` — `tsconfig.json`: remove the include glob

Remove `"snapdrift/**/*.mjs"` from the `include` array.

### `codesamplez-tools` — delete the directory

```bash
git rm -r snapdrift/
git commit -m "Remove snapdrift: promoted to <org>/snapdrift"
```

---

## Step 8 — Validate end-to-end

- [ ] Push the consumer changes and verify `ci.yml` passes on `main`
- [ ] Open a test PR in `codesamplez-tools` and confirm the `pr-visual-diff.yml` workflow runs, resolves the baseline, and posts a PR comment
- [ ] Verify the scheduled `health-monitoring.yml` baseline capture step succeeds (or trigger it manually via `workflow_dispatch`)

---

## Post-promotion

- [ ] Update `docs/reusable-visual-diff-actions-plan.md` in `codesamplez-tools` to mark the promotion item as complete
- [ ] Archive or close any open issues/branches in `codesamplez-tools` that were specific to the local module phase
- [ ] Pin `uses:` references in all consumer workflows to the commit SHA behind the `v1` tag (supply-chain safety). Replace `@v1` with `@<sha>  # v1` in each `uses:` line once the initial end-to-end validation in Step 8 is confirmed working.
