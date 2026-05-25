// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';

import { compareBuffers } from '@snapdrift/compare-core';

const fileIndexCache = new Map();

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @template T
 * @param {string} filePath
 * @param {string} label
 * @returns {Promise<T>}
 */
export async function loadJson(filePath, label) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Unable to load ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * @param {string} rootDir
 * @returns {Promise<Map<string, string[]>>}
 */
async function buildFileIndex(rootDir) {
  const cached = fileIndexCache.get(rootDir);
  if (cached) {
    return cached;
  }

  /** @type {Map<string, string[]>} */
  const filesByBasename = new Map();

  /**
   * @param {string} currentDir
   * @returns {Promise<void>}
   */
  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const list = filesByBasename.get(entry.name) || [];
      list.push(fullPath);
      filesByBasename.set(entry.name, list);
    }
  }

  if (await exists(rootDir)) {
    await visit(rootDir);
  }

  fileIndexCache.set(rootDir, filesByBasename);
  return filesByBasename;
}

/**
 * @param {string} runDir
 * @param {string} relativeImagePath
 * @returns {Promise<string>}
 */
export async function resolveImagePath(runDir, relativeImagePath) {
  const directPath = path.resolve(runDir, relativeImagePath);
  if (await exists(directPath)) {
    return directPath;
  }

  const fileIndex = await buildFileIndex(runDir);
  const basename = path.basename(relativeImagePath);
  const matches = fileIndex.get(basename) || [];

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    const normalizedRelativePath = relativeImagePath.replace(/\\/g, '/');
    const suffixMatches = matches.filter((candidate) => candidate.replace(/\\/g, '/').endsWith(normalizedRelativePath));
    if (suffixMatches.length === 1) {
      return suffixMatches[0];
    }
  }

  throw new Error(`Unable to locate screenshot ${relativeImagePath} under ${runDir}.`);
}

/**
 * Reads two PNG files from disk and compares them pixel-by-pixel.
 * Delegates pixel comparison to compareBuffers from @snapdrift/compare-core.
 *
 * @param {string} baselinePath
 * @param {string} currentPath
 * @returns {Promise<{ width: number, height: number, differentPixels: number, totalPixels: number, mismatchRatio: number }>}
 */
export async function comparePngs(baselinePath, currentPath) {
  const [baselineBuffer, currentBuffer] = await Promise.all([
    fs.readFile(baselinePath),
    fs.readFile(currentPath)
  ]);
  return compareBuffers(baselineBuffer, currentBuffer);
}

/**
 * Clears the internal file-index cache used by resolveImagePath.
 * Call at the start of each drift report run to avoid stale entries.
 */
export function clearFileIndexCache() {
  fileIndexCache.clear();
}