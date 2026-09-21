import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pngjs from 'pngjs';

import { comparePngs, loadJson, resolveImagePath } from '../src/compare-files.mjs';

const { PNG } = pngjs;

/**
 * Create a synthetic PNG buffer filled with a solid RGBA color.
 * @param {number} width
 * @param {number} height
 * @param {[number, number, number, number]} color
 * @returns {Buffer}
 */
function solidPng(width, height, color) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = color[0];
    png.data[i + 1] = color[1];
    png.data[i + 2] = color[2];
    png.data[i + 3] = color[3];
  }
  return PNG.sync.write(png);
}

function rowPng(rows, width = 2) {
  const png = new PNG({ width, height: rows.length });
  rows.forEach((value, y) => {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      png.data[index] = value;
      png.data[index + 1] = value;
      png.data[index + 2] = value;
      png.data[index + 3] = 255;
    }
  });
  return PNG.sync.write(png);
}

async function writePngFile(filePath, width, height, color) {
  const buffer = solidPng(width, height, color);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
}

describe('@snapdrift/adapter-fs — compare-files', () => {
  describe('comparePngs', () => {
    test('returns zero mismatch for identical files', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-cmp-'));
      const baselinePath = path.join(tmpDir, 'baseline.png');
      const currentPath = path.join(tmpDir, 'current.png');

      await writePngFile(baselinePath, 10, 10, [0, 0, 0, 255]);
      await writePngFile(currentPath, 10, 10, [0, 0, 0, 255]);

      const result = await comparePngs(baselinePath, currentPath);
      expect(result.differentPixels).toBe(0);
      expect(result.totalPixels).toBe(100);
      expect(result.mismatchRatio).toBe(0);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('returns full mismatch for different files', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-cmp-'));
      const baselinePath = path.join(tmpDir, 'baseline.png');
      const currentPath = path.join(tmpDir, 'current.png');

      await writePngFile(baselinePath, 10, 10, [0, 0, 0, 255]);
      await writePngFile(currentPath, 10, 10, [255, 255, 255, 255]);

      const result = await comparePngs(baselinePath, currentPath);
      expect(result.differentPixels).toBe(100);
      expect(result.mismatchRatio).toBe(1);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('throws on dimension mismatch', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-cmp-'));
      const baselinePath = path.join(tmpDir, 'baseline.png');
      const currentPath = path.join(tmpDir, 'current.png');

      await writePngFile(baselinePath, 10, 10, [0, 0, 0, 255]);
      await writePngFile(currentPath, 20, 20, [0, 0, 0, 255]);

      await expect(comparePngs(baselinePath, currentPath)).rejects.toThrow('Dimension mismatch');

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('uses compareImages only for an explicit v1 policy and returns its diff metadata', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-cmp-'));
      const baselinePath = path.join(tmpDir, 'baseline.png');
      const currentPath = path.join(tmpDir, 'current.png');

      await writePngFile(baselinePath, 2, 1, [0, 0, 0, 255]);
      await writePngFile(currentPath, 3, 1, [0, 0, 0, 255]);

      const result = await comparePngs(baselinePath, currentPath, {
        comparisonPolicy: { version: 1, threshold: 0.1 }
      });

      expect(result.comparison).toEqual({
        baseline: { width: 2, height: 1 },
        current: { width: 3, height: 1 },
        canvas: { width: 3, height: 1 },
        dimensionsChanged: true,
        totalPixels: 3
      });
      expect(result.differentPixels).toBe(1);
      expect(Buffer.isBuffer(result.diffImageBuffer)).toBe(true);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('omits the diff buffer when renderDiffImage is false', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-cmp-'));
      const baselinePath = path.join(tmpDir, 'baseline.png');
      const currentPath = path.join(tmpDir, 'current.png');

      await writePngFile(baselinePath, 2, 1, [0, 0, 0, 255]);
      await writePngFile(currentPath, 3, 1, [0, 0, 0, 255]);

      const result = await comparePngs(baselinePath, currentPath, {
        comparisonPolicy: { version: 1, threshold: 0.1 },
        renderDiffImage: false
      });

      expect(result.differentPixels).toBe(1);
      expect(result.diffImageBuffer).toBeUndefined();

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('routes v2 policies through vertical row alignment', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-cmp-'));
      const baselinePath = path.join(tmpDir, 'baseline.png');
      const currentPath = path.join(tmpDir, 'current.png');

      await fs.writeFile(baselinePath, rowPng([10, 20, 30, 40]));
      await fs.writeFile(currentPath, rowPng([10, 20, 200, 30, 40]));

      const result = await comparePngs(baselinePath, currentPath, {
        comparisonPolicy: { version: 2, threshold: 0.1 }
      });

      expect(result.comparison).toMatchObject({ policyVersion: 2, mode: 'vertical-aligned' });
      expect(result.differentPixels).toBe(2);
      expect(result.totalPixels).toBe(10);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('returns full-precision mismatchRatio', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-cmp-'));
      const baselinePath = path.join(tmpDir, 'baseline.png');
      const currentPath = path.join(tmpDir, 'current.png');

      // 7x1 image, 1 pixel different => 1/7 = 0.142857...
      const basePng = new PNG({ width: 7, height: 1 });
      for (let i = 0; i < basePng.data.length; i += 4) {
        basePng.data[i] = 0; basePng.data[i + 1] = 0; basePng.data[i + 2] = 0; basePng.data[i + 3] = 255;
      }
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(baselinePath, PNG.sync.write(basePng));

      const currentPng = new PNG({ width: 7, height: 1 });
      for (let i = 0; i < currentPng.data.length; i += 4) {
        currentPng.data[i] = 0; currentPng.data[i + 1] = 0; currentPng.data[i + 2] = 0; currentPng.data[i + 3] = 255;
      }
      currentPng.data[12] = 255; // Change pixel at (3,0)
      await fs.writeFile(currentPath, PNG.sync.write(currentPng));

      const result = await comparePngs(baselinePath, currentPath);
      expect(result.mismatchRatio).toBeCloseTo(1 / 7, 10);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('loadJson', () => {
    test('reads and parses a JSON file', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-json-'));
      const filePath = path.join(tmpDir, 'data.json');
      const data = { hello: 'world', count: 42 };
      await fs.writeFile(filePath, JSON.stringify(data));

      const result = await loadJson(filePath, 'test data');
      expect(result).toEqual(data);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('throws descriptive error on missing file', async () => {
      await expect(loadJson('/nonexistent/file.json', 'test data')).rejects.toThrow('Unable to load test data');
    });
  });

  describe('resolveImagePath', () => {
    test('resolves direct path when file exists', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-resolve-'));
      const imagePath = path.join(tmpDir, 'screenshots', 'home.png');
      await fs.mkdir(path.dirname(imagePath), { recursive: true });
      await fs.writeFile(imagePath, 'png-data');

      const result = await resolveImagePath(tmpDir, 'screenshots/home.png');
      expect(result).toBe(imagePath);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('throws when image not found', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-resolve-'));

      await expect(resolveImagePath(tmpDir, 'screenshots/missing.png')).rejects.toThrow('Unable to locate screenshot');

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('disambiguates duplicate basenames using the relative path suffix', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-resolve-'));
      const target = path.join(tmpDir, 'b', 'screenshots', 'home.png');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, 'png-data');
      const other = path.join(tmpDir, 'a', 'screenshots', 'home.png');
      await fs.mkdir(path.dirname(other), { recursive: true });
      await fs.writeFile(other, 'png-data');

      const result = await resolveImagePath(tmpDir, 'b/screenshots/home.png');
      expect(result).toBe(target);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('throws when duplicate basenames cannot be disambiguated', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-resolve-'));
      const first = path.join(tmpDir, 'a', 'screenshots', 'home.png');
      await fs.mkdir(path.dirname(first), { recursive: true });
      await fs.writeFile(first, 'png-data');
      const second = path.join(tmpDir, 'b', 'screenshots', 'home.png');
      await fs.mkdir(path.dirname(second), { recursive: true });
      await fs.writeFile(second, 'png-data');

      await expect(resolveImagePath(tmpDir, 'screenshots/home.png')).rejects.toThrow('Unable to locate screenshot');

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });
});
