// @ts-check
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Explicit re-export indices only; unfamiliar syntax must never pass silently.
 * @param {string} source @param {string} packageName @returns {string[]}
 */
export function runtimeExportNames(source, packageName) {
  const clean = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const clause = /export\s*\{([^}]+)\}\s*from\s*(['"])[^'"]+\2\s*;?/g;
  assert.equal(clean.replace(clause, '').trim(), '', `${packageName}: unsupported index syntax; extend the runtime export inventory`);
  const names = [...clean.matchAll(clause)].flatMap((match) => match[1].split(',')
    .map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const symbol = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(entry);
      assert(symbol, `${packageName}: unsupported export specifier ${entry}`);
      return symbol[2] || symbol[1];
    }));
  assert(names.length, `${packageName}: empty runtime export inventory`);
  return names;
}

/** Resolve each fixture dependency from its importer, including nested installs.
 * @param {string} dependency @param {string} importer @returns {string}
 */
export function installedPackageDirectory(dependency, importer) {
  try {
    return dirname(createRequire(join(importer, 'package.json')).resolve(`${dependency}/package.json`));
  } catch (cause) {
    throw new Error(`Cannot locate fixture dependency ${dependency} from ${importer}; run npm ci.`, { cause });
  }
}
