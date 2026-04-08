# Contributing

Thanks for your interest in contributing! This guide covers the basics.

## Reporting Bugs

Open a [bug report issue](../../issues/new?template=bug_report.md) with:

- Steps to reproduce
- Expected vs actual behavior
- Node version and OS

## Suggesting Features

Open a [feature request issue](../../issues/new?template=feature_request.md) describing the use case and proposed solution.

## Releasing

Releases are cut by maintainers. The publish workflow fires automatically when a GitHub release is published.

**Prerequisites (one-time repo setup):**

1. Create an npm access token with publish permissions at [npmjs.com](https://www.npmjs.com).
2. Add it as a repository secret named `NPM_TOKEN` under **Settings → Secrets and variables → Actions**.

**Release steps:**

1. Merge all changes to `main` — CI must be green.
2. Move items from `## Unreleased` in `CHANGELOG.md` to a new `## x.y.z - YYYY-MM-DD` entry and commit.
3. Create a GitHub release:
   - Tag: `vx.y.z` (e.g. `v0.2.0`), targeting `main`
   - Title: `vx.y.z`
   - Body: paste the changelog entry for this version
4. Publishing the release triggers the `publish.yml` workflow, which runs the full quality gate and then publishes to npm with [provenance attestation](https://docs.npmjs.com/generating-provenance-statements).

**Verify:**

```bash
npm view snapdrift@x.y.z
```

## Release Usage

SnapDrift workflow examples reference public release tags for readability. If your organization requires immutable pins, resolve the tag to a commit SHA and pin that instead.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/ranacseruet/snapdrift.git
cd snapdrift

# Install dependencies
npm ci

# Install Playwright browsers (needed for capture tests)
npx playwright install --with-deps chromium
```

## Running Tests

```bash
# Run the main local quality gate
npm run ci

# Lint source and tests
npm run lint

# Type-check JSDoc-annotated production code
npm run typecheck

# Validate composite action metadata
npm run validate:actions

# Run the full test suite
npm test

# Run the suite with coverage enforcement
npm run test:coverage

# Run a single test file
NODE_OPTIONS='--experimental-vm-modules' npx jest tests/snapdrift-smoke.test.js
```

The six test files in `tests/` cover config validation, capture, compare, staging, PR comment generation, and action contract integrity. Tests are unit-level — they do not run Playwright or require a live app.

## Making Changes

1. Fork the repo and create a branch from `main`.
2. Make your changes.
3. Add or update tests to cover the change.
4. Run the test suite and confirm everything passes.
5. Update documentation if your change affects contracts, inputs/outputs, or behavior.
6. Update `CHANGELOG.md` under an `## Unreleased` section.
7. Open a pull request.

## Pull Request Guidelines

- Keep PRs focused — one concern per PR.
- Follow existing code style (ESM, no transpilation, JSDoc types).
- Keep docs, generated report copy, and action metadata aligned with the SnapDrift brand voice.
- Add a clear description of what changed and why.

## Code Style

- ESM modules (`.mjs`) with `type: "module"` in package.json
- JSDoc type annotations referencing `types/visual-diff-types.d.ts`
- No transpilation or bundling — runs directly on Node >= 22
- Composite GitHub Actions with inline shell or `actions/github-script`

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
