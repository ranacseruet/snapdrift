# Contributing

Thanks for your interest in contributing! This guide covers the basics.

## Reporting Bugs

Open a [bug report issue](../../issues/new?template=bug_report.md) with:

- Steps to reproduce
- Expected vs actual behavior
- Node version and OS

## Suggesting Features

Open a [feature request issue](../../issues/new?template=feature_request.md) describing the use case and proposed solution.

## Internal Testing Status

SnapDrift is still being exercised through internal testing. When you reference the actions from another repository, pin a tested commit SHA instead of a tag or moving branch.

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
# Run the full test suite
npm test

# Run a single test file
NODE_OPTIONS='--experimental-vm-modules' npx jest tests/visual-diff-smoke.test.js
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
