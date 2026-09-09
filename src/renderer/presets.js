/**
 * Dialog presets: the settings of a feature, saved under a name.
 *
 * Fusion has this on every dialog, listed in its own reference pages as last
 * used, defaults, save, rename, delete, and set as default. The reason to want
 * it is repetition: a part gets the same 0.6 chamfer on every edge it has, and
 * typing 0.6 into a fresh dialog forty times is forty chances to type 0.8.
 *
 * The rules that matter are all about what a preset may NOT carry.
 *
 * A preset carries settings, never geometry. What was picked belongs to the
 * part it was picked on, and a preset that restored somebody else's edges would
 * be worse than no preset at all. So rows that are filled by clicking in the
 * canvas are left out, and so are the synthetic rows a dialog builds for
 * itself: buttons, notes, and the ones whose name begins with two underscores,
 * which by convention here means the row is a view of the feature rather than a
 * field on it.
 *
 * And a preset only fills rows the feature already has. A fillet preset saved
 * with three edge sets applied to a fillet with one must fill that one and stop,
 * not conjure two more sets out of the path names. Writing a value into a place
 * that does not exist yet is how a preset turns a working feature into a broken
 * one.
 */

/** Read a dotted path, or undefined if any step of it is missing. */
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Write a dotted path whose parents already exist. */
function setPath(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let target = obj;
  for (const k of parts) {
    if (target == null || typeof target !== 'object') return false;
    target = target[k];
  }
  if (target == null || typeof target !== 'object') return false;
  target[last] = value;
  return true;
}

/**
 * The rows of a dialog a preset is allowed to carry.
 *
 * Everything a person types or chooses, and nothing that was pointed at.
 */
export function presetKeys(fields) {
  return (fields || [])
    .filter((f) => ['expr', 'bool', 'select', 'text'].includes(f.type))
    .map((f) => f.key)
    .filter((k) => typeof k === 'string' && k && !k.startsWith('__'));
}

/** What this feature would save, as a plain object of path to value. */
export function captureValues(feature, fields) {
  const out = {};
  for (const key of presetKeys(fields)) {
    const v = getPath(feature, key);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Put saved values back, and say which ones landed.
 *
 * A value whose path does not already exist on this feature is skipped rather
 * than created, so a preset from a bigger feature fills what it can and leaves
 * the rest alone.
 */
export function applyValues(feature, values) {
  const applied = [];
  const skipped = [];
  for (const [key, v] of Object.entries(values || {})) {
    if (getPath(feature, key) === undefined) {
      skipped.push(key);
      continue;
    }
    if (setPath(feature, key, v)) applied.push(key);
    else skipped.push(key);
  }
  return { applied, skipped };
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

const STORE_KEY = 'anvil.presets';

/**
 * Everything saved, by feature type.
 *
 * `{ [type]: { default: name | null, lastUsed: values | null, saved: [{name, values}] } }`
 *
 * Storage can be missing or refuse to answer, and a preset list is a
 * convenience: losing it must never stop a dialog opening. So every read comes
 * back as an empty store rather than throwing, and every write is allowed to
 * fail quietly.
 */
export function loadPresets(storage) {
  try {
    const raw = storage?.getItem(STORE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function savePresets(storage, data) {
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(data || {}));
    return true;
  } catch {
    return false;
  }
}

/** The entry for one feature type, filled in so callers need not check. */
export function presetsFor(data, type) {
  const e = (data || {})[type] || {};
  return {
    default: e.default || null,
    lastUsed: e.lastUsed || null,
    saved: Array.isArray(e.saved) ? e.saved : []
  };
}

/**
 * Which preset a dialog should open with, or null for the feature's own
 * defaults.
 *
 * Only one marked as the default is applied. Last used is recorded and offered
 * in the list, but is never applied on its own: Extrude deliberately opens at a
 * distance of zero so that nothing appears until a length is given, and
 * quietly restoring the last distance would undo that for everyone who never
 * asked for a preset at all.
 */
export function openingPreset(data, type) {
  const e = presetsFor(data, type);
  if (!e.default) return null;
  if (e.default === '__lastUsed') return e.lastUsed ? { name: 'Last used', values: e.lastUsed } : null;
  return e.saved.find((p) => p.name === e.default) || null;
}

/** Save one under a name, replacing any of that name. */
export function putPreset(data, type, name, values) {
  const next = { ...(data || {}) };
  const e = presetsFor(next, type);
  const saved = e.saved.filter((p) => p.name !== name);
  saved.push({ name, values });
  next[type] = { ...e, saved };
  return next;
}

export function dropPreset(data, type, name) {
  const next = { ...(data || {}) };
  const e = presetsFor(next, type);
  next[type] = {
    ...e,
    saved: e.saved.filter((p) => p.name !== name),
    // A default that has just been deleted is not a default any more, and
    // leaving the name behind would open every later dialog looking for
    // something that is not there.
    default: e.default === name ? null : e.default
  };
  return next;
}

export function renamePreset(data, type, from, to) {
  const next = { ...(data || {}) };
  const e = presetsFor(next, type);
  next[type] = {
    ...e,
    saved: e.saved.map((p) => (p.name === from ? { ...p, name: to } : p)),
    default: e.default === from ? to : e.default
  };
  return next;
}

export function setDefaultPreset(data, type, name) {
  const next = { ...(data || {}) };
  next[type] = { ...presetsFor(next, type), default: name || null };
  return next;
}

export function rememberLastUsed(data, type, values) {
  const next = { ...(data || {}) };
  next[type] = { ...presetsFor(next, type), lastUsed: values };
  return next;
}
