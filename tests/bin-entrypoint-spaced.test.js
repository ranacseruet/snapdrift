/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// bin/snapdrift.mjs entrypoint — spaced install (finding 3)
// ---------------------------------------------------------------------------

describe('bin/snapdrift.mjs entrypoint resolves from a spaced install', () => {
  let spaced;

  beforeAll(async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift spaced-'));
    spaced = path.join(parent, 'snapdrift app dir');
    await fs.mkdir(spaced);

    // Copy the entrypoint and lib so ../lib/cli.mjs resolves to a real path
    // *inside* the spaced directory (not the repo), exercising fileURLToPath.
    await fs.cp(path.join(REPO_ROOT, 'bin'), path.join(spaced, 'bin'), { recursive: true });
    await fs.cp(path.join(REPO_ROOT, 'lib'), path.join(spaced, 'lib'), { recursive: true });
    // Resolve workspace-package imports (@snapdrift/*) via the repo node_modules.
    await fs.symlink(path.join(REPO_ROOT, 'node_modules'), path.join(spaced, 'node_modules'), 'dir');
  }, 60000);

  afterAll(async () => {
    if (spaced) await fs.rm(spaced, { recursive: true, force: true });
  });

  it('imports cli.mjs from a spaced install without module-resolution failure', () => {
    const entry = path.join(spaced, 'bin', 'snapdrift.mjs');

    // No args -> defaults to `diff`, which then fails loading a config in the
    // (spaced) temp dir. The point is that it gets PAST the entrypoint import:
    // a broken .pathname resolution double-encodes the spaces and throws
    // ERR_MODULE_NOT_FOUND for cli.mjs.
    const result = spawnSync('node', [entry], { encoding: 'utf8' });

    const combined = `${result.stderr}\n${result.stdout}`;
    expect(result.error).toBeUndefined();
    expect(combined).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/i);
  });
});
