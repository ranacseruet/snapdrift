/** @jest-environment node */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { resolveGitRef } = await import('../lib/snap-provider.mjs');

const GITHUB_VARS = ['GITHUB_REF_NAME', 'GITHUB_HEAD_REF', 'GITHUB_SHA'];

let saved;
let cwd;

beforeEach(() => {
  saved = Object.fromEntries(GITHUB_VARS.map((k) => [k, process.env[k]]));
  for (const k of GITHUB_VARS) delete process.env[k];
  cwd = process.cwd();
});

afterEach(() => {
  process.chdir(cwd);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveGitRef', () => {
  it('prefers GitHub Actions env vars when present', () => {
    process.env.GITHUB_REF_NAME = 'feature/x';
    process.env.GITHUB_SHA = 'a'.repeat(40);

    expect(resolveGitRef()).toEqual({ refBranch: 'feature/x', refSha: 'a'.repeat(40) });
  });

  it('falls back to GITHUB_HEAD_REF for the branch', () => {
    process.env.GITHUB_HEAD_REF = 'pr-branch';
    process.env.GITHUB_SHA = 'b'.repeat(40);

    expect(resolveGitRef().refBranch).toBe('pr-branch');
  });

  // The reason this helper exists: outside Actions those vars are unset, and
  // every locally seeded baseline used to be recorded as main @ "unknown".
  it('resolves the real branch and SHA from git when the env vars are absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-gitref-'));
    try {
      const run = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
      run(['init', '--initial-branch=seed-branch']);
      run(['config', 'user.email', 'test@example.com']);
      run(['config', 'user.name', 'Test']);
      await fs.writeFile(path.join(dir, 'f.txt'), 'x');
      run(['add', '.']);
      run(['commit', '-m', 'init']);
      const expectedSha = String(run(['rev-parse', 'HEAD'])).trim();

      process.chdir(dir);
      const resolved = resolveGitRef();

      expect(resolved.refBranch).toBe('seed-branch');
      expect(resolved.refSha).toBe(expectedSha);
      expect(resolved.refSha).not.toBe('unknown');
    } finally {
      process.chdir(cwd);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to main/unknown outside a git repository', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-nogit-'));
    try {
      process.chdir(dir);
      // /tmp is not inside a repo, so git rev-parse fails and we take defaults.
      const resolved = resolveGitRef();
      expect(resolved.refBranch).toBe('main');
      expect(resolved.refSha).toBe('unknown');
    } finally {
      process.chdir(cwd);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
