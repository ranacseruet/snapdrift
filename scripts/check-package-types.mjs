// @ts-check

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    assert(!/export\s+\*/.test(index), `${name}: extend the export inventory for star exports`);
    const exports = [...index.matchAll(/export\s*\{([^}]+)\}\s*from/g)].flatMap((match) =>
      match[1].split(',').map((entry) => entry.trim().split(/\s+as\s+/).pop()).filter(Boolean)
    );
    assert(exports.length, `${name}: empty runtime export inventory`);
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
      assert.deepEqual(Object.keys(manifest.exports['.']), ['types', 'default']);
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
    const copied = new Set();
    /** @param {string} dependency */
    function installFixtureTypes(dependency) {
      if (copied.has(dependency)) return;
      copied.add(dependency);
      const source = join(root, 'node_modules', dependency);
      const destination = join(modulesDir, dependency);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      cpSync(source, destination, { recursive: true, dereference: true });
      for (const child of Object.keys(readJson(join(source, 'package.json')).dependencies || {})) {
        installFixtureTypes(child);
      }
    }
    installFixtureTypes('@types/node');
    writeJson(join(consumerDir, 'package.json'), { private: true, type: 'module' });
    cpSync(join(fixtureRoot, name, 'index.ts'), join(consumerDir, 'index.ts'));
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
