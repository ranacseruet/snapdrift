// @ts-check

/** @typedef {import('../types/index.d.ts').ViewportDescriptor} ViewportDescriptor */
/** @typedef {import('../types/index.d.ts').VisualViewport} VisualViewport */

/**
 * Produce a stable string key for a viewport value.
 * Matches existing snapdrift behavior: preset names pass through,
 * custom dimensions get `custom:{w}x{h}`.
 *
 * @param {VisualViewport} viewport
 * @returns {string}
 */
export function viewportKey(viewport) {
  return typeof viewport === 'string' ? viewport : `custom:${viewport.width}x${viewport.height}`;
}

/**
 * Produce a stable hash for a normalised viewport descriptor.
 * Uses the compact format `viewportHash` format from the ADR:
 * preset presets map to their name, custom viewports to `custom:WxH`.
 *
 * @param {ViewportDescriptor} descriptor
 * @returns {string}
 */
export function viewportHash(descriptor) {
  // Check known presets first
  if (
    descriptor.width === 1440 && descriptor.height === 900 &&
    (descriptor.deviceScaleFactor === undefined || descriptor.deviceScaleFactor === 1) &&
    (descriptor.isMobile === undefined || descriptor.isMobile === false)
  ) {
    return 'desktop';
  }
  if (
    descriptor.width === 390 && descriptor.height === 844 &&
    (descriptor.deviceScaleFactor === undefined || descriptor.deviceScaleFactor === 3) &&
    (descriptor.isMobile === undefined || descriptor.isMobile === true)
  ) {
    return 'mobile';
  }
  return `custom:${descriptor.width}x${descriptor.height}`;
}