// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';

/** @typedef {import('../../manifest/types/index').VisualRegressionConfig} SnapdriftConfig */
import { validateSnapdriftConfig } from '@snapdrift/manifest';

export const DEFAULT_CONFIG_PATH = path.resolve('.github', 'snapdrift.json');

export const SNAPDRIFT_CAPTURE_CONCURRENCY = (() => {
  const raw = process.env.SNAPDRIFT_CAPTURE_CONCURRENCY;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 5;
})();

/**
 * @param {string[]} names
 * @returns {string | undefined}
 */
export function readFirstDefinedEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * @param {string | undefined} [configPath]
 * @returns {Promise<{ config: SnapdriftConfig, configPath: string }>}
 */
export async function loadSnapdriftConfig(configPath = readFirstDefinedEnv(['SNAPDRIFT_CONFIG_PATH'])) {
  const resolvedConfigPath = configPath ? path.resolve(configPath) : DEFAULT_CONFIG_PATH;
  const raw = await fs.readFile(resolvedConfigPath, 'utf8');
  const parsed = JSON.parse(raw);

  return {
    config: validateSnapdriftConfig(parsed, resolvedConfigPath),
    configPath: resolvedConfigPath
  };
}