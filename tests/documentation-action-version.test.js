/** @jest-environment node */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTION_REF_PATTERN = /uses:\s+ranacseruet\/snapdrift\/actions\/(?:baseline|pr-diff)@(\S+)/g;
const DOCUMENTATION_FILES = [
  'README.md',
  'docs/integration-guide.md',
  'docs/workflow-templates/refresh-baseline-on-merge.yml',
];

describe('documentation action versions', () => {
  it('pins every public action example to the root package version', async () => {
    const [documentation, packageJson] = await Promise.all([
      Promise.all(DOCUMENTATION_FILES.map((file) => fs.readFile(path.join(REPO_ROOT, file), 'utf8'))),
      fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8').then(JSON.parse),
    ]);
    const refs = documentation.flatMap((content) => [...content.matchAll(ACTION_REF_PATTERN)].map((match) => match[1]));

    expect(refs.length).toBeGreaterThan(0);
    expect(new Set(refs)).toEqual(new Set([`v${packageJson.version}`]));
  });
});
