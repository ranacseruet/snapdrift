/** @jest-environment node */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPinStale, readPinnedSha } from '../scripts/check-pin-stale.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('dispatcher pin staleness', () => {
  it('is fresh when the pin equals the newest commit touching actions/', () => {
    expect(
      isPinStale({ pinnedSha: SHA_A, newestActionsCommit: SHA_A, pinContainsNewestActions: true })
    ).toBe(false);
  });

  it('is fresh when the pin is newer than the newest commit touching actions/', () => {
    expect(
      isPinStale({ pinnedSha: SHA_B, newestActionsCommit: SHA_A, pinContainsNewestActions: true })
    ).toBe(false);
  });

  it('is stale when the pin predates the newest commit touching actions/', () => {
    expect(
      isPinStale({ pinnedSha: SHA_A, newestActionsCommit: SHA_B, pinContainsNewestActions: false })
    ).toBe(true);
  });

  it('is a no-op without an immutable SHA pin', () => {
    expect(
      isPinStale({ pinnedSha: null, newestActionsCommit: SHA_A, pinContainsNewestActions: true })
    ).toBe(false);
  });

  it('is a no-op without any commits touching actions/', () => {
    expect(
      isPinStale({ pinnedSha: SHA_A, newestActionsCommit: null, pinContainsNewestActions: false })
    ).toBe(false);
  });
});

describe('readPinnedSha', () => {
  it('extracts the immutable SHA from a real action.yml', async () => {
    const actionSource = await fs.readFile(path.join(REPO_ROOT, 'action.yml'), 'utf8');
    const pinnedSha = readPinnedSha(actionSource);

    expect(pinnedSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns null when the pin delegates to a mutable tag', () => {
    const source = [
      'uses: ranacseruet/snapdrift/actions/baseline@v0.8.2',
      'uses: ranacseruet/snapdrift/actions/pr-diff@v0.8.2'
    ].join('\n');

    expect(readPinnedSha(source)).toBeNull();
  });
});
