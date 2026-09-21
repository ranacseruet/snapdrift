// @ts-check

export { compareBuffers } from './compare.mjs';
export { compareImages, ComparisonTooLargeError, MAX_COMPARISON_PIXELS } from './compare-images.mjs';
export { COMPARISON_FALLBACK_REASONS, COMPARISON_ROW_KINDS, MAX_ALIGNMENT_EDIT_LENGTH, MAX_ALIGNMENT_ROWS } from './vertical-align.mjs';
export { generateDiffImage } from './diff-image.mjs';
export { compareWithIgnoreRegions } from './ignore-regions.mjs';
