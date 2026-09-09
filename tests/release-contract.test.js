/** @jest-environment node */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'js-yaml';

import { validateReleaseContract } from '../scripts/validate-release.mjs';

const VERSION = '0.8.2';
const SHA = 'a'.repeat(40);
const CHANGELOG = `# Changelog\n\n## ${VERSION} - 2026-08-24\n`;

function actionSource(ref = SHA, label = `v${VERSION}`) {
  const suffix = label ? ` # ${label}` : '';
  return [
    `uses: ranacseruet/snapdrift/actions/baseline@${ref}${suffix}`,
    `uses: ranacseruet/snapdrift/actions/pr-diff@${ref}${suffix}`
  ].join('\n');
}

describe('release contract', () => {
  it('accepts immutable, version-labelled inner action pins', () => {
    expect(() => validateReleaseContract({
      actionSource: actionSource(),
      changelogSource: CHANGELOG,
      version: VERSION
    })).not.toThrow();
  });

  it('rejects mutable tag delegation and stale version labels', () => {
    expect(() => validateReleaseContract({
      actionSource: actionSource(`v${VERSION}`, ''),
      changelogSource: CHANGELOG,
      version: VERSION
    })).toThrow(/immutable commit SHA/);
    expect(() => validateReleaseContract({
      actionSource: actionSource(SHA, 'v0.8.1'),
      changelogSource: CHANGELOG,
      version: VERSION
    })).toThrow(/label.*v0\.8\.2/);
  });

  it('keeps the publish workflow and release guide wired to the strict preflight', async () => {
    const [workflow, contributing] = await Promise.all([
      fs.readFile('.github/workflows/publish.yml', 'utf8'),
      fs.readFile('CONTRIBUTING.md', 'utf8')
    ]);
    expect(workflow).toMatch(/run: npm run validate:release/);
    expect(contributing).toMatch(/npm run validate:release/);
    expect(contributing).toMatch(/immutable implementation commit SHA/);
  });

  it('points every publish step at a helper that resolves from its working directory', async () => {
    // Regression guard: the root "Publish snapdrift" step once ran
    // `node ../../scripts/publish-package.mjs` with no `working-directory`, so the
    // helper resolved outside the checkout and the v0.9.0 release published every
    // workspace package but not the root package.
    const source = await fs.readFile('.github/workflows/publish.yml', 'utf8');
    const steps = yaml.load(source).jobs.publish.steps;
    const publishSteps = steps.filter((step) => /publish-package\.mjs/.test(step.run ?? ''));

    expect(publishSteps).toHaveLength(5);
    for (const step of publishSteps) {
      const helper = step.run.match(/(\S*publish-package\.mjs)/)[1];
      const resolved = path.posix.join(step['working-directory'] ?? '.', helper);
      await expect(fs.access(resolved)).resolves.toBeUndefined();
    }
  });
});
