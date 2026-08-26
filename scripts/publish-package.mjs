import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

// The only idempotent-skip case is npm's "version already exists" response. Authentication
// failures (E403 "you must log in"), network failures, package-validation failures, and
// dependency-resolution failures carry different messages and must fail the job.
const ALREADY_EXISTS_PATTERN = /already\s+exists/i;

/**
 * Build the registry URL for a specific version of a (possibly scoped) package. The slash inside a
 * scope segment is percent-encoded (`@scope/name` -> `@scope%2Fname`) to match how the registry
 * addresses individual versions.
 * @param {string} registry
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
export function registryVersionUrl(registry, name, version) {
  const base = registry.replace(/\/+$/, '');
  const scoped = name.startsWith('@') ? `@${name.slice(1).replace('/', '%2F')}` : name;
  return `${base}/${scoped}/${encodeURIComponent(version)}`;
}

/**
 * Decide whether a preflight registry lookup means the version is already published. A 200 means
 * the version exists on the registry and publishing can be skipped idempotently; anything else
 * (notably 404) means the version is new and publish should be attempted.
 * @param {{ status: number }} response
 * @returns {boolean}
 */
export function isVersionPublished({ status }) {
  return status === 200;
}

/**
 * Classify an npm publish failure. Returns true only for the supported "version already exists"
 * duplicate response; every other failure (authentication, network, package validation, or
 * dependency publication) must fail the release job.
 * @param {{ message: string }} failure
 * @returns {boolean}
 */
export function isDuplicateVersionFailure({ message }) {
  return ALREADY_EXISTS_PATTERN.test(message ?? '');
}

/**
 * Default publish implementation: run `npm` with the resolved arguments in the working directory.
 * Throws on a non-zero exit so the caller can classify the failure.
 * @param {string} cwd
 * @param {string[]} publishArgs
 */
function defaultPublish(cwd, publishArgs) {
  execFileSync('npm', publishArgs, { cwd, stdio: 'pipe' });
}

/**
 * Read the local package name and version from the working directory's package.json.
 * @param {string} cwd
 * @returns {Promise<{ name: string; version: string }>}
 */
async function readPackageMeta(cwd) {
  const source = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
  /** @type {{ name: string, version: string }} */
  const meta = JSON.parse(source);
  return meta;
}

/**
 * Publish a single workspace package to npm and fail the job on any error except the supported
 * "version already exists" duplicate. A preflight registry lookup skips publishing when the version
 * is already published; otherwise publish is attempted and its failure is narrowly classified so
 * authentication, network, package-validation, and dependency errors fail the release job while a
 * duplicate version is treated as idempotent.
 *
 * @param {{
 *   cwd?: string,
 *   registry?: string,
 *   publishArgs?: string[],
 *   fetchImpl?: typeof fetch,
 *   publishImpl?: (cwd: string, publishArgs: string[]) => void
 * }} [options]
 * @returns {Promise<{ skipped: boolean, published: boolean }>}
 */
export async function publishPackage({
  cwd = process.cwd(),
  registry = DEFAULT_REGISTRY,
  publishArgs = ['publish', '--provenance', '--access', 'public'],
  fetchImpl = globalThis.fetch,
  publishImpl = defaultPublish
} = {}) {
  const { name, version } = await readPackageMeta(cwd);
  const url = registryVersionUrl(registry, name, version);

  // Preflight: skip when the version already exists on the registry (idempotent publish).
  try {
    const response = await fetchImpl(url);
    if (isVersionPublished(response)) {
      process.stdout.write(`Skipping ${name}@${version}: already published on the registry.\n`);
      return { skipped: true, published: false };
    }
  } catch (error) {
    // A preflight network failure must not mask a real publish problem; fall through and let the
    // publish attempt surface it.
    process.stderr.write(
      `Preflight for ${url} failed (${error.message}); attempting publish.\n`
    );
  }

  // Attempt the publish. Any failure is captured and narrowly classified below.
  try {
    await publishImpl(cwd, publishArgs);
  } catch (error) {
    const message = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n');
    if (isDuplicateVersionFailure({ message })) {
      process.stdout.write(`Skipping ${name}@${version}: version already exists.\n`);
      return { skipped: true, published: false };
    }
    const failure = new Error(message);
    throw failure;
  }

  return { skipped: false, published: true };
}

/**
 * Read the environment overrides the release workflow (and shell tests) use to point publish at a
 * different registry and, for local registries, drop trusted-publishing provenance.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ registry: string, publishArgs: string[] }}
 */
export function readEnvOverrides(env) {
  const registry = env.SNAPDRIFT_REGISTRY ?? DEFAULT_REGISTRY;
  if (env.SNAPDRIFT_SKIP_PROVENANCE === '1') {
    return { registry, publishArgs: ['publish', '--registry', registry] };
  }
  return { registry, publishArgs: ['publish', '--provenance', '--access', 'public'] };
}

/**
 * Entry point for the release workflow: publish the package in the current working directory and
 * translate any non-duplicate failure into a non-zero exit code so the release job fails. Optional
 * env overrides (`SNAPDRIFT_REGISTRY`, `SNAPDRIFT_SKIP_PROVENANCE`) allow the helper to run against
 * a local registry (for example, in shell tests).
 * @param {Record<string, string | undefined>} [env]
 * @param {{ cwd?: string, publishImpl?: (cwd: string, publishArgs: string[]) => void }} [options]
 * @returns {Promise<void>}
 */
export async function runMainIfCalled(env = process.env, { cwd = process.cwd(), publishImpl } = {}) {
  const { registry, publishArgs } = readEnvOverrides(env);
  try {
    await publishPackage({ cwd, registry, publishArgs, publishImpl });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    // publishPackage only throws for real failures (authentication, network, package-validation, or
    // dependency errors); every failure fails the release job with a non-zero exit code.
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  await runMainIfCalled();
}
