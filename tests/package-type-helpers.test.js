import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimeExportNames, installedPackageDirectory } from '../scripts/package-type-helpers.mjs';

it('inventories re-exports including aliases and comments', () => {
  expect(runtimeExportNames(`// @ts-check
    export { first, /* documented */ second as alias,
      // trailing comment
      third } from './module.mjs';`, 'fixture')).toEqual(['first', 'alias', 'third']);
});

it.each([
  'export const newValue = 1;',
  'export function newFunction() {}',
  'export class NewClass {}',
  'export { localValue };',
  "export * from './module.mjs';"
])('rejects unsupported export forms instead of silently missing them: %s', (addition) => {
  expect(() => runtimeExportNames(`export { known } from './module.mjs';\n${addition}`, 'fixture'))
    .toThrow(/fixture: unsupported index syntax/);
});

it('resolves fixture dependencies from their importer before a hoisted version', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-nested-types-'));
  try {
    const importer = path.join(root, 'node_modules', '@types', 'example');
    const nested = path.join(importer, 'node_modules', 'nested-types');
    const hoisted = path.join(root, 'node_modules', 'nested-types');
    for (const directory of [importer, nested, hoisted]) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'package.json'), '{}');
    }
    expect(installedPackageDirectory('nested-types', importer)).toBe(await fs.realpath(nested));
    expect(() => installedPackageDirectory('missing-fixture-types', importer))
      .toThrow(/Cannot locate fixture dependency missing-fixture-types/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
