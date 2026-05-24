// @ts-check

/** @typedef {import('../types/index.d.ts').ViewportDescriptor} ViewportDescriptor */
/** @typedef {import('../types/index.d.ts').VisualViewport} VisualViewport */

/**
 * Single source of truth for viewport presets.
 * Dimensions and flags must match exactly for a preset match —
 * partial matches (right dimensions, wrong flags) fall through to `custom:WxH`.
 * @type {Record<string, ViewportDescriptor & { width: number, height: number }>}
 */
export const VIEWPORT_PRESETS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
};

/**
 * Produce a stable string key for a viewport value.
 * Preset names pass through; custom dimensions get `custom:{w}x{h}`.
 *
 * @param {VisualViewport} viewport
 * @returns {string}
 */
export function viewportKey(viewport) {
  return typeof viewport === 'string' ? viewport : `custom:${viewport.width}x${viewport.height}`;
}

/**
 * Produce a stable hash for a normalised viewport descriptor.
 * All preset fields (dimensions + flags) must match exactly —
 * a descriptor with matching dimensions but missing or conflicting
 * flags falls through to `custom:WxH` rather than silently matching
 * a preset with different device characteristics.
 *
 * @param {ViewportDescriptor} descriptor
 * @returns {string}
 */
export function viewportHash(descriptor) {
  for (const [name, preset] of Object.entries(VIEWPORT_PRESETS)) {
    if (descriptor.width !== preset.width || descriptor.height !== preset.height) continue;
    if (descriptor.deviceScaleFactor !== undefined && descriptor.deviceScaleFactor !== preset.deviceScaleFactor) continue;
    if (descriptor.isMobile !== undefined && descriptor.isMobile !== preset.isMobile) continue;
    if (descriptor.hasTouch !== undefined && descriptor.hasTouch !== preset.hasTouch) continue;
    return name;
  }
  return `custom:${descriptor.width}x${descriptor.height}`;
}