// @ts-check

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runtimeExportNames, installedPackageDirectory } from './package-type-helpers.mjs';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const fixtureRoot = join(root, 'tests', 'type-consumers');
const tempRoot = mkdtempSync(join(tmpdir(), 'snapdrift-package-types-'));
const packageNames = ['manifest', 'compare-core', 'adapter-fs', 'adapter-report-md'];
const modes = ['Bundler', 'Node16', 'NodeNext'];

/** @param {string} command @param {string[]} args @param {string} cwd */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, NODE_PATH: '' }
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** @param {string} destination @param {unknown} value */
function writeJson(destination, value) {
  writeFileSync(destination, JSON.stringify(value, null, 2));
}

try {
  const packDir = join(tempRoot, 'packs');
  mkdirSync(packDir);
  /** @type {Map<string, { archive: string, exports: string[] }>} */
  const packages = new Map();
  for (const name of packageNames) {
    const packageDir = join(root, 'packages', name);
    const [pack] = JSON.parse(run('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', packDir,
      '--cache', join(tempRoot, 'npm-cache')
    ], packageDir));
    assert(pack.files.some((file) => file.path === 'types/index.d.ts'), `${name}: declarations absent from tarball`);
    // Public indices are explicit re-export lists. Verify each runtime name is
    // present and typed in the consumer, without loading runtime dependencies.
    const index = readFileSync(join(packageDir, 'src/index.mjs'), 'utf8');
    const exports = runtimeExportNames(index, name);
    packages.set(`@snapdrift/${name}`, { archive: join(packDir, pack.filename), exports });
  }

  for (const name of packageNames) {
    const consumerDir = join(tempRoot, name);
    const modulesDir = join(consumerDir, 'node_modules');
    mkdirSync(modulesDir, { recursive: true });
    const installed = new Set();
    /** Install packed workspace declaration dependencies, never all siblings.
     * Runtime-only external dependencies are irrelevant to declaration resolution.
     * @param {string} packageName
     */
    function installPacked(packageName) {
      if (installed.has(packageName)) return;
      installed.add(packageName);
      const packed = packages.get(packageName);
      assert(packed, `Missing local tarball for ${packageName}`);
      const destination = join(modulesDir, packageName);
      mkdirSync(destination, { recursive: true });
      run('tar', ['-xzf', packed.archive, '-C', destination, '--strip-components=1'], consumerDir);
      const manifest = readJson(join(destination, 'package.json'));
      assert.equal(Object.keys(manifest.exports['.'])[0], 'types', `${packageName}: types must be the first export condition`);
      assert.equal(manifest.exports['.'].types, './types/index.d.ts');
      assert.equal(manifest.exports['.'].default, './src/index.mjs');
      assert.equal(manifest.types, 'types/index.d.ts');
      assert(existsSync(join(destination, manifest.exports['.'].default)));
      for (const dependency of Object.keys(manifest.dependencies || {})) {
        if (dependency.startsWith('@snapdrift/')) installPacked(dependency);
      }
    }
    installPacked(`@snapdrift/${name}`);

    // These are explicit consumer dev dependencies, copied (not linked) from
    // the lockfile installation. No ancestor workspace resolution is available.
    /** @param {string} dependency @param {string} importer @param {string} targetModules */
    function installFixtureTypes(dependency, importer, targetModules) {
      const source = installedPackageDirectory(dependency, importer);
      const destination = join(targetModules, dependency);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      cpSync(source, destination, {
        recursive: true, dereference: true,
        filter: (sourcePath) => sourcePath !== join(source, 'node_modules')
      });
      for (const child of Object.keys(readJson(join(source, 'package.json')).dependencies || {})) {
        installFixtureTypes(child, source, join(destination, 'node_modules'));
      }
    }
    installFixtureTypes('@types/node', root, modulesDir);
    writeJson(join(consumerDir, 'package.json'), { private: true, type: 'module' });
    const fixture = join(fixtureRoot, name, 'index.ts');
    assert(existsSync(fixture), `${name}: consumer fixture missing at ${fixture}`);
    cpSync(fixture, join(consumerDir, 'index.ts'));
    const names = packages.get(`@snapdrift/${name}`).exports;
    writeFileSync(join(consumerDir, 'exports.ts'), [
      `import * as api from '@snapdrift/${name}';`,
      'type Assert<T extends true> = T;',
      'type IsAny<T> = 0 extends (1 & T) ? true : false;',
      'type Result<T> = T extends (...args: never[]) => infer R ? Awaited<R> : T;',
      ...names.map((symbol) => `type Check_${symbol} = Assert<IsAny<Result<typeof api.${symbol}>> extends false ? true : false>;`)
    ].join('\n'));
    for (const mode of modes) {
      writeJson(join(consumerDir, 'tsconfig.json'), {
        compilerOptions: {
          target: 'ES2023', module: mode === 'Bundler' ? 'ESNext' : mode,
          moduleResolution: mode, strict: true, skipLibCheck: false,
          noEmit: true, types: ['node'], typeRoots: ['./node_modules/@types']
        },
        files: ['index.ts', 'exports.ts']
      });
      run(join(root, 'node_modules', '.bin', 'tsc'), ['--project', 'tsconfig.json'], consumerDir);
      process.stdout.write(`${name}: ${mode} consumer passed (${names.length} public exports)\n`);
    }
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
