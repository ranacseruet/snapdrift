// @ts-check

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MIN_PNG_HEADER_LENGTH = 24;

/**
 * @param {import('../types/index.d.ts').IgnoreRegion[]} regions
 * @returns {void}
 */
export function validateIgnoreRegions(regions) {
  if (!Array.isArray(regions)) {
    throw new Error('ignoreRegions must be an array.');
  }

  for (const [index, region] of regions.entries()) {
    if (!region || typeof region !== 'object') {
      throw new Error(`ignoreRegions[${index}] must be an object with x, y, width, height.`);
    }
    for (const field of ['x', 'y', 'width', 'height']) {
      if (!Number.isSafeInteger(region[field])) {
        throw new Error(`ignoreRegions[${index}].${field} must be a safe integer.`);
      }
    }
    if (region.width < 0 || region.height < 0) {
      throw new Error(`ignoreRegions[${index}].width and .height must be non-negative.`);
    }
  }
}

/**
 * @param {readonly number[]} color
 * @param {string} [fieldName] - Option name used in the validation error.
 * @returns {[number, number, number, number]}
 */
export function parseHighlightColor(color, fieldName = 'highlightColor') {
  if (!Array.isArray(color) || color.length !== 4 || !color.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
    throw new Error(`${fieldName} must be an array of four integers between 0 and 255.`);
  }
  return /** @type {[number, number, number, number]} */ (color);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {import('../types/index.d.ts').IgnoreRegion[]} regions
 * @returns {Uint8Array | undefined}
 */
export function buildIgnoreMask(width, height, regions) {
  if (regions.length === 0) return undefined;

  const ignored = new Uint8Array(width * height);
  for (const region of regions) {
    const xStart = Math.max(0, region.x);
    const yStart = Math.max(0, region.y);
    const xEnd = Math.min(width, region.x + region.width);
    const yEnd = Math.min(height, region.y + region.height);
    for (let y = yStart; y < yEnd; y++) {
      for (let x = xStart; x < xEnd; x++) {
        ignored[y * width + x] = 1;
      }
    }
  }
  return ignored;
}

/**
 * @param {{ width: number, height: number }} baselinePng
 * @param {{ width: number, height: number }} currentPng
 * @returns {Error}
 */
export function createDimensionMismatchError(baselinePng, currentPng) {
  return new Error(
    `Dimension mismatch: baseline ${baselinePng.width}x${baselinePng.height}, current ${currentPng.width}x${currentPng.height}.`
  );
}

/**
 * Parse the IHDR dimensions from a PNG buffer without decoding the image.
 * Returns undefined when the buffer is not a complete PNG header, so callers
 * can fall back to the decoder's own validation errors.
 *
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number } | undefined}
 */
export function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_PNG_HEADER_LENGTH) {
    return undefined;
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index++) {
    if (buffer[index] !== PNG_SIGNATURE[index]) {
      return undefined;
    }
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    return undefined;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}
