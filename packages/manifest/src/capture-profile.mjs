import { VIEWPORT_PRESETS } from './viewport.mjs';

export const CAPTURE_PROFILE_SCHEMA_VERSION = 2;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

export function validateCaptureProfile(value, sourceLabel = 'screenshot manifest') {
  if (value === undefined) return undefined;
  const label = `${sourceLabel}.captureProfile`;
  if (!isObject(value)) throw new Error(`${label} must be an object when present.`);
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== CAPTURE_PROFILE_SCHEMA_VERSION) {
    throw new Error(`${label}.schemaVersion is unsupported: ${String(value.schemaVersion)}. Refresh the baseline with a supported capture profile.`);
  }
  if (value.engine !== undefined) {
    if (!isObject(value.engine)) throw new Error(`${label}.engine must be an object.`);
    requireString(value.engine.name, `${label}.engine.name`);
    if (value.engine.version !== undefined) requireString(value.engine.version, `${label}.engine.version`);
  } else if (value.engineVersion === undefined) {
    throw new Error(`${label} must identify an engine.`);
  }
  for (const key of ['engineVersion', 'browser', 'browserRevision', 'fontsHash', 'timezone', 'locale']) {
    if (value[key] !== undefined) requireString(value[key], `${label}.${key}`);
  }
  if (value.schemaVersion !== CAPTURE_PROFILE_SCHEMA_VERSION) return value;
  if (!value.engine) throw new Error(`${label}.engine is required for a versioned profile.`);
  if (value.engine.name !== 'snapdrift-local') return value;

  for (const key of ['engineVersion', 'browser', 'browserRevision', 'playwrightVersion', 'locale', 'timezone']) {
    requireString(value[key], `${label}.${key}`);
  }
  requireString(value.engine.version, `${label}.engine.version`);
  if (value.engineVersion !== value.engine.version) {
    throw new Error(`${label}.engineVersion must equal engine.version.`);
  }
  for (const key of ['name', 'architecture', 'release', 'version']) {
    requireString(value.platform?.[key], `${label}.platform.${key}`);
  }
  const settings = value.settings;
  if (!isObject(settings)) throw new Error(`${label}.settings must be an object.`);
  for (const [group, keys] of Object.entries({
    screenshot: ['fullPage', 'animations', 'caret', 'scale', 'omitBackground', 'type'],
    readiness: ['waitUntil', 'settleDelayMs'],
    context: ['isolation', 'colorScheme', 'reducedMotion', 'forcedColors', 'javaScriptEnabled', 'serviceWorkers'],
    launch: ['headless', 'args']
  })) {
    if (!isObject(settings[group])) throw new Error(`${label}.settings.${group} must be an object.`);
    for (const key of keys) {
      const field = settings[group][key];
      const fieldLabel = `${label}.settings.${group}.${key}`;
      if (['fullPage', 'omitBackground', 'javaScriptEnabled', 'headless'].includes(key)) {
        if (typeof field !== 'boolean') throw new Error(`${fieldLabel} must be a boolean.`);
      } else if (key === 'settleDelayMs') {
        if (!Number.isFinite(field) || field < 0) throw new Error(`${fieldLabel} must be a non-negative number.`);
      } else if (key === 'args') {
        if (!Array.isArray(field) || field.some((arg) => typeof arg !== 'string')) throw new Error(`${fieldLabel} must be a string array.`);
      } else {
        requireString(field, fieldLabel);
        const allowed = {
          animations: ['disabled', 'allow'], caret: ['hide', 'initial'], scale: ['css', 'device'], type: ['png'],
          waitUntil: ['load', 'domcontentloaded', 'networkidle', 'commit'],
          colorScheme: ['light', 'dark', 'no-preference'], reducedMotion: ['reduce', 'no-preference'],
          forcedColors: ['active', 'none'], serviceWorkers: ['allow', 'block']
        }[key];
        if (allowed && !allowed.includes(field)) throw new Error(`${fieldLabel} is unsupported.`);
      }
    }
  }
  return value;
}

function firstDifference(baseline, current, prefix = 'captureProfile') {
  if (isObject(baseline) && isObject(current)) {
    for (const key of [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()) {
      const difference = firstDifference(baseline[key], current[key], `${prefix}.${key}`);
      if (difference) return difference;
    }
    return undefined;
  }
  return JSON.stringify(baseline) === JSON.stringify(current) ? undefined : prefix;
}

export function checkCaptureProfileCompatibility(baseline, current) {
  validateCaptureProfile(baseline, 'baseline screenshot manifest');
  validateCaptureProfile(current, 'current screenshot manifest');
  for (const [location, profile] of [['baseline', baseline], ['current', current]]) {
    if (profile?.engine && profile.engine.name !== 'snapdrift-local') {
      return { status: 'incompatible', reason: `${location} capture engine "${profile.engine.name}" is not snapdrift-local` };
    }
  }
  if (baseline?.schemaVersion === CAPTURE_PROFILE_SCHEMA_VERSION && current?.schemaVersion === CAPTURE_PROFILE_SCHEMA_VERSION) {
    const difference = firstDifference(baseline, current);
    return difference
      ? { status: 'incompatible', reason: `${difference} differs between baseline and current capture` }
      : { status: 'verified' };
  }
  if (baseline && current) {
    for (const key of ['browser', 'browserRevision', 'fontsHash', 'timezone', 'locale']) {
      if (baseline[key] !== undefined && current[key] !== undefined && baseline[key] !== current[key]) {
        return { status: 'incompatible', reason: `captureProfile.${key} differs between baseline and current capture` };
      }
    }
  }
  return { status: 'unverified', reason: 'Capture environment is unverified: a legacy manifest lacks a complete versioned local capture profile. Refresh the baseline to verify compatibility.' };
}

export function normalizedViewportIdentity(viewport) {
  const descriptor = typeof viewport === 'string' ? VIEWPORT_PRESETS[viewport] : {
    ...viewport, deviceScaleFactor: 1, isMobile: false, hasTouch: false
  };
  if (!descriptor || !Number.isInteger(descriptor.width) || descriptor.width <= 0 || !Number.isInteger(descriptor.height) || descriptor.height <= 0) {
    throw new Error('viewport must be desktop, mobile, or positive integer width and height.');
  }
  return JSON.stringify([descriptor.width, descriptor.height, descriptor.deviceScaleFactor, descriptor.isMobile, descriptor.hasTouch]);
}
