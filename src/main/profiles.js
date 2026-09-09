'use strict';

/**
 * Profiles: a name and a library folder, and nothing else.
 *
 * Not an account. No password, no server, nothing to reset, no way to be locked
 * out of your own parts. What a profile is for is that one machine can hold more
 * than one body of work, and that a lock file can say who has a part open in a
 * word a person recognises rather than only by machine name.
 *
 * Pure on purpose. Everything here takes a store and gives back a new one, so
 * the awkward parts, which are the first run and the upgrade from a single
 * remembered folder, can be checked without a disk.
 */

const EMPTY = { active: null, profiles: [] };

/**
 * An id nothing else will have.
 *
 * The time alone is not enough, and the case is not far-fetched: the first run
 * makes a profile and somebody adding a second one straight away can land in
 * the same millisecond. Two profiles with one id is worse than it sounds, since
 * every lookup is a find and a find takes the first: switching does nothing,
 * and removing one removes both.
 */
function newId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** A store that is definitely a store, whatever was on disk. */
function normalise(store) {
  const profiles = Array.isArray(store?.profiles)
    ? store.profiles.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
    : [];
  const active = profiles.some((p) => p.id === store?.active) ? store.active : null;
  return {
    active: active || (profiles.length === 1 ? profiles[0].id : null),
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      root: typeof p.root === 'string' ? p.root : null,
      recents: Array.isArray(p.recents) ? p.recents.filter((r) => r && r.path) : [],
      prefs: p.prefs && typeof p.prefs === 'object' ? p.prefs : {}
    }))
  };
}

/**
 * What to start with when there is nothing, or only the old single folder.
 *
 * The upgrade matters more than the first run. Somebody already has a library
 * folder set from before profiles existed, and losing it would look exactly
 * like losing the library: every derived link in every document would stop
 * resolving by name on the next open.
 */
function firstRun(store, opts = {}) {
  const now = normalise(store);
  if (now.profiles.length) return now;
  const name = opts.name || 'Me';
  const made = {
    id: opts.id || newId(),
    name,
    root: opts.root || null,
    recents: [],
    prefs: {}
  };
  return { active: made.id, profiles: [made] };
}

/** Add one, and make it the one in use: nobody makes a profile to ignore it. */
function add(store, { id, name, root }) {
  const now = normalise(store);
  const clean = String(name || '').trim();
  if (!clean) return { store: now, error: 'A profile needs a name' };
  if (now.profiles.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
    return { store: now, error: `There is already a profile called ${clean}` };
  }
  const made = { id: id || newId(), name: clean, root: root || null, recents: [], prefs: {} };
  return { store: { active: made.id, profiles: [...now.profiles, made] }, profile: made };
}

/** Switch, if there is anything to switch to. */
function use(store, id) {
  const now = normalise(store);
  if (!now.profiles.some((p) => p.id === id)) return now;
  return { ...now, active: id };
}

/**
 * Remove one.
 *
 * The folder is left alone. A profile is a way of naming a library, not the
 * library, and deleting somebody's parts because they tidied up a name would be
 * unforgivable.
 */
function remove(store, id) {
  const now = normalise(store);
  const left = now.profiles.filter((p) => p.id !== id);
  if (!left.length) return now;
  return { active: now.active === id ? left[0].id : now.active, profiles: left };
}

/** Change a profile's own settings, leaving the rest of the store alone. */
function update(store, id, patch) {
  const now = normalise(store);
  return {
    ...now,
    profiles: now.profiles.map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p))
  };
}

/** Whichever profile is in use, or nothing when the answer is still to come. */
function active(store) {
  const now = normalise(store);
  return now.profiles.find((p) => p.id === now.active) || null;
}

const RECENTS = 12;

/**
 * Note that a document was opened or saved.
 *
 * Kept by path and by library name both. The name is what makes the list mean
 * the same thing on the other machine; the path is what opens it on this one,
 * and for a document outside the library it is all there is.
 */
function remember(store, id, entry) {
  const now = normalise(store);
  if (!entry?.path) return now;
  const item = {
    path: entry.path,
    name: entry.name || null,
    title: entry.title || String(entry.path).split(/[\\/]/).pop(),
    at: entry.at || Date.now()
  };
  return update(now, id, {
    recents: [
      item,
      ...(active({ ...now, active: id })?.recents || []).filter(
        (r) => String(r.path).toLowerCase() !== String(item.path).toLowerCase()
      )
    ].slice(0, RECENTS)
  });
}

/** Drop entries whose files are gone, once somebody has checked which. */
function forget(store, id, paths) {
  const gone = new Set((paths || []).map((p) => String(p).toLowerCase()));
  if (!gone.size) return normalise(store);
  const now = normalise(store);
  const p = now.profiles.find((q) => q.id === id);
  if (!p) return now;
  return update(now, id, {
    recents: p.recents.filter((r) => !gone.has(String(r.path).toLowerCase()))
  });
}

module.exports = { EMPTY, normalise, firstRun, add, use, remove, update, active, remember, forget, RECENTS };
