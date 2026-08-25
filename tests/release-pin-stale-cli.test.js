/** @jest-environment node */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkPinStale, runMainIfCalled } from '../scripts/check-pin-stale.mjs';

function git(dir, ...args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function head(dir) {
  return git(dir, 'rev-parse', 'HEAD').stdout.trim();
}

// Write the root dispatcher action.yml (the file the check reads for the pin).
function writeRootAction(dir, pinSha) {
  fs.writeFileSync(path.join(dir, 'action.yml'), [
    'name: SnapDrift',
    'runs:',
    '  using: composite',
    '  steps:',
    `    - uses: ranacseruet/snapdrift/actions/baseline@${pinSha} # v0.8.2`,
    `    - uses: ranacseruet/snapdrift/actions/pr-diff@${pinSha} # v0.8.2`
  ].join('\n') + '\n');
}

// Build a repo that mimics SnapDrift's layout: a root dispatcher action.yml plus wrapper actions
// under actions/. Both commits touch actions/, so the newest commit touching actions/ is shaC2, and
// root action.yml pins at shaC1 (shaC2's parent) after setup.
function setupRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdrift-pin-stale-'));
  git(dir, 'init');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'SnapDrift Test');

  const baseline = path.join(dir, 'actions', 'baseline', 'action.yml');
  const prDiff = path.join(dir, 'actions', 'pr-diff', 'action.yml');
  fs.mkdirSync(path.dirname(baseline), { recursive: true });
  fs.mkdirSync(path.dirname(prDiff), { recursive: true });
  fs.writeFileSync(baseline, 'name: baseline\n');
  fs.writeFileSync(prDiff, 'name: pr-diff\n');
  writeRootAction(dir, '0'.repeat(40));
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial wrapper change', '--quiet');
  const shaC1 = head(dir);

  fs.writeFileSync(baseline, 'name: baseline\n# updated\n');
  writeRootAction(dir, shaC1);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'second wrapper change', '--quiet');

  return { dir, shaC1, shaC2: head(dir) };
}

describe('check:pin-stale', () => {
  let dir, shaC2;
  beforeEach(() => {
    const { dir: newDir, shaC2: newShaC2 } = setupRepo();
    dir = newDir;
    shaC2 = newShaC2;
    process.exitCode = undefined;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('reports fresh when the pin equals the newest commit touching actions/', async () => {
    writeRootAction(dir, shaC2);

    const { stale } = await checkPinStale({ repoRoot: dir, actionPath: path.join(dir, 'action.yml') });
    expect(stale).toBe(false);
  });

  it('reports stale when the pin predates the newest commit touching actions/', async () => {
    // root action.yml still pins at shaC1, but the newest commit touching actions/ is shaC2.
    const { stale } = await checkPinStale({ repoRoot: dir, actionPath: path.join(dir, 'action.yml') });
    expect(stale).toBe(true);
  });

  it('skips when the pin delegates to a mutable tag', async () => {
    writeRootAction(dir, 'v0.8.2');

    const { stale } = await checkPinStale({ repoRoot: dir, actionPath: path.join(dir, 'action.yml') });
    expect(stale).toBe(false);
  });

  it('exits 1 when the pin is stale', async () => {
    await runMainIfCalled({ repoRoot: dir, actionPath: path.join(dir, 'action.yml') });
    expect(process.exitCode).toBe(1);
  });

  it('skips when git has no commits touching actions/', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdrift-pin-stale-empty-'));
    git(empty, 'init');
    git(empty, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    fs.writeFileSync(path.join(empty, 'action.yml'), 'name: SnapDrift\n');
    try {
      const { stale } = await checkPinStale({ repoRoot: empty, actionPath: path.join(empty, 'action.yml') });
      expect(stale).toBe(false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
