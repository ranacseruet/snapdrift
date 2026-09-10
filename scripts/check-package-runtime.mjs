// @ts-check

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtimeExportNames } from './package-type-helpers.mjs';

const root = resolve(import.meta.dirname, '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'snapdrift-package-runtime-'));
const packDir = join(tempRoot, 'packs');
const unpackDir = join(tempRoot, 'unpacked');
const cacheDir = join(tempRoot, 'npm-cache');
const packageNames = ['manifest', 'compare-core', 'adapter-fs', 'adapter-report-md'];
const smokeSource = join(root, 'scripts', 'package-runtime-smoke.mjs');

/** @param {string} command @param {string[]} args @param {string} cwd */
function runResult(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, NODE_PATH: '' }
  });
  if (result.error) throw result.error;
  return result;
}

/** @param {string} command @param {string[]} args @param {string} cwd */
function run(command, args, cwd) {
  const result = runResult(command, args, cwd);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** @param {string} packageName */
function packagePath(packageName) {
  return join(...packageName.split('/'));
}

/** @param {string} packageName @param {Map<string, PackageInfo>} packages */
function workspaceClosure(packageName, packages) {
  const closure = new Set();
  const queue = [packageName];
  while (queue.length > 0) {
    const current = queue.shift();
    const packageInfo = packages.get(current);
    assert(packageInfo, `No packed workspace package for ${current}`);
    for (const dependency of Object.keys(packageInfo.manifest.dependencies || {})) {
      if (!dependency.startsWith('@snapdrift/') || closure.has(dependency)) continue;
      assert(packages.has(dependency), `${packageName}: missing packed dependency ${dependency}`);
      closure.add(dependency);
      queue.push(dependency);
    }
  }
  closure.delete(packageName);
  return [...closure];
}

/**
 * @typedef {{ archive: string, expectedDir: string, exports: string[], manifest: { dependencies?: Record<string, string> } }} PackageInfo
 */

try {
  mkdirSync(packDir);
  mkdirSync(unpackDir);
  /** @type {Map<string, PackageInfo>} */
  const packages = new Map();

  for (const name of packageNames) {
    const packageDir = join(root, 'packages', name);
    const [pack] = JSON.parse(run('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', packDir,
      '--cache', cacheDir
    ], packageDir));
    assert(pack.files.some((file) => file.path === 'src/index.mjs'), `${name}: runtime entrypoint absent from tarball`);
    const archive = join(packDir, pack.filename);
    const packageUnpackDir = join(unpackDir, name.replaceAll('/', '-'));
    mkdirSync(packageUnpackDir);
    run('tar', ['-xzf', archive, '-C', packageUnpackDir], root);
    const expectedDir = join(packageUnpackDir, 'package');
    const manifest = readJson(join(expectedDir, 'package.json'));
    const sourceIndex = readFileSync(join(root, 'packages', name, 'src', 'index.mjs'), 'utf8');
    packages.set(`@snapdrift/${name}`, {
      archive,
      expectedDir,
      manifest,
      exports: runtimeExportNames(sourceIndex, name)
    });
  }

  const adapterFs = packages.get('@snapdrift/adapter-fs');
  assert(adapterFs, 'adapter-fs package was not packed');

  /**
   * @param {{ label: string, targetName: string, target: PackageInfo, workspaceNames: string[] }} options
   * @returns {string}
   */
  function installConsumer(options) {
    const consumerDir = join(tempRoot, options.label);
    mkdirSync(consumerDir);
    /** @type {Record<string, string>} */
    const dependencies = {
      [options.targetName]: `file:${relative(consumerDir, options.target.archive)}`
    };
    for (const dependency of options.workspaceNames) {
      const packageInfo = packages.get(dependency);
      assert(packageInfo, `No packed workspace dependency for ${dependency}`);
      dependencies[dependency] = `file:${relative(consumerDir, packageInfo.archive)}`;
    }
    writeJson(join(consumerDir, 'package.json'), { private: true, type: 'module', dependencies });
    run('npm', [
      'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--cache', cacheDir
    ], consumerDir);

    const installedNames = [options.targetName, ...options.workspaceNames];
    for (const name of installedNames) {
      const packageInfo = name === options.targetName ? options.target : packages.get(name);
      assert(packageInfo, `Missing expected package ${name}`);
      const installedDir = join(consumerDir, 'node_modules', packagePath(name));
      assert(existsSync(join(installedDir, 'package.json')), `${options.label}: ${name} was not installed`);
      assert(!lstatSync(installedDir).isSymbolicLink(), `${options.label}: ${name} was linked instead of packed`);
      assert.equal(
        readFileSync(join(installedDir, 'package.json'), 'utf8'),
        readFileSync(join(packageInfo.expectedDir, 'package.json'), 'utf8'),
        `${options.label}: ${name} did not resolve to the packed manifest`
      );
      assert.equal(
        readFileSync(join(installedDir, 'src', 'index.mjs'), 'utf8'),
        readFileSync(join(packageInfo.expectedDir, 'src', 'index.mjs'), 'utf8'),
        `${options.label}: ${name} did not resolve to the packed runtime entrypoint`
      );
      const resolved = createRequire(join(consumerDir, 'package.json')).resolve(name);
      assert(
        realpathSync(resolved).startsWith(`${realpathSync(installedDir)}${sep}`),
        `${options.label}: ${name} resolved outside the consumer (${resolved}; expected ${installedDir})`
      );
    }
    return consumerDir;
  }

  for (const name of packageNames.map((value) => `@snapdrift/${value}`)) {
    const packageInfo = packages.get(name);
    assert(packageInfo, `No packed target for ${name}`);
    const consumerDir = installConsumer({
      label: name.replaceAll('/', '-').replace('@', ''),
      targetName: name,
      target: packageInfo,
      workspaceNames: workspaceClosure(name, packages)
    });
    cpSync(smokeSource, join(consumerDir, 'smoke.mjs'));
    run('node', ['smoke.mjs', name, JSON.stringify(packageInfo.exports)], consumerDir);
    process.stdout.write(`${name}: isolated runtime consumer passed\n`);
  }

  assert.equal(
    adapterFs.manifest.dependencies?.['@snapdrift/adapter-report-md'],
    '^1.2.0',
    'adapter-fs must directly declare @snapdrift/adapter-report-md'
  );

  // Regression proof: removing the direct dependency from a packed adapter-fs copy must make its
  // eagerly re-exported public entrypoint fail in a consumer with no reporting package installed.
  const brokenDir = join(tempRoot, 'broken-adapter-fs');
  cpSync(adapterFs.expectedDir, brokenDir, { recursive: true });
  const brokenManifest = readJson(join(brokenDir, 'package.json'));
  delete brokenManifest.dependencies['@snapdrift/adapter-report-md'];
  writeJson(join(brokenDir, 'package.json'), brokenManifest);
  const [brokenPack] = JSON.parse(run('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', packDir, '--cache', cacheDir
  ], brokenDir));
  const brokenTarget = {
    archive: join(packDir, brokenPack.filename),
    expectedDir: brokenDir,
    manifest: brokenManifest,
    exports: adapterFs.exports
  };
  const brokenWorkspaceNames = Object.keys(brokenManifest.dependencies)
    .filter((dependency) => dependency.startsWith('@snapdrift/'));
  const negativeConsumer = installConsumer({
    label: 'missing-reporting-dependency',
    targetName: '@snapdrift/adapter-fs',
    target: brokenTarget,
    workspaceNames: brokenWorkspaceNames
  });
  const failedImport = runResult('node', ['--input-type=module', '-e', 'await import(process.argv[1])', '@snapdrift/adapter-fs'], negativeConsumer);
  assert.notEqual(failedImport.status, 0, 'adapter-fs without its reporting dependency unexpectedly imported');
  assert.match(
    `${failedImport.stdout}\n${failedImport.stderr}`,
    /ERR_MODULE_NOT_FOUND|Cannot find package.*@snapdrift\/adapter-report-md/,
    'missing reporting dependency did not produce the expected import failure'
  );
  process.stdout.write('adapter-fs: missing direct reporting dependency regression reproduced\n');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
