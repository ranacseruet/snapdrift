import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(modulePath), '..');

/**
 * @param {{ actionSource: string, changelogSource: string, version: string }} input
 */
export function validateReleaseContract({ actionSource, changelogSource, version }) {
  const expectedLabel = `v${version}`;
  const refs = [...actionSource.matchAll(
    /uses:\s+ranacseruet\/snapdrift\/actions\/(baseline|pr-diff)@([^\s#]+)(?:\s+#\s+(v\S+))?/g
  )];

  if (refs.length !== 2 || new Set(refs.map((match) => match[1])).size !== 2) {
    throw new Error('Release action.yml must delegate exactly once to baseline and pr-diff.');
  }
  for (const [, action, ref, label] of refs) {
    if (!/^[0-9a-f]{40}$/.test(ref)) {
      throw new Error(
        `Release action.yml must pin actions/${action} to an immutable commit SHA; found @${ref}.`
      );
    }
    if (label !== expectedLabel) {
      throw new Error(
        `Release action.yml must label actions/${action} as ${expectedLabel}; found ${label || 'no version label'}.`
      );
    }
  }

  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelogSource)) {
    throw new Error(`CHANGELOG.md must contain a dated ${version} release heading.`);
  }
}

async function main() {
  const [packageSource, actionSource, changelogSource] = await Promise.all([
    fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'action.yml'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8')
  ]);
  const { version } = JSON.parse(packageSource);
  validateReleaseContract({ actionSource, changelogSource, version });
  process.stdout.write(`Validated immutable SnapDrift release contract for v${version}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  await main();
}
