import fs from 'node:fs/promises';
import path from 'node:path';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);

test('adapter-fs declares its reporting package as a direct runtime dependency', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'packages/adapter-fs/package.json'), 'utf8'));
  expect(packageJson.dependencies['@snapdrift/adapter-report-md']).toBe('^1.1.0');
});
