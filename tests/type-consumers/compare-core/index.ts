import { Buffer } from 'node:buffer';
import { compareBuffers, compareWithIgnoreRegions, generateDiffImage } from '@snapdrift/compare-core';
import type { CompareResult, CompareBuffersResult, DiffImageOptions, IgnoreRegion } from '@snapdrift/compare-core';

const image = Buffer.alloc(0);
const region: IgnoreRegion = { x: 0, y: 0, width: 1, height: 1 };
const options: DiffImageOptions = { highlightColor: [255, 0, 0, 255], ignoreRegions: [region] };
const result: CompareBuffersResult = compareBuffers(image, image);
const compatible: CompareResult = result;
compatible.mismatchRatio.toFixed(2);
result.pct.toFixed();
result.pixelsChanged.toFixed();
compareWithIgnoreRegions(image, image, [region]).differentPixels.toFixed();
const diff: Buffer = generateDiffImage(image, image, options);
diff.toString('base64');
// @ts-expect-error only buffers are accepted
compareBuffers('baseline.png', image);
// @ts-expect-error region dimensions must be numeric
compareWithIgnoreRegions(image, image, [{ x: 0, y: 0, width: '1', height: 1 }]);
// @ts-expect-error highlight requires four channels
 generateDiffImage(image, image, { highlightColor: [255, 0, 0] });
// @ts-expect-error comparison results are not buffers
const wrongResult: Buffer = compareBuffers(image, image);
