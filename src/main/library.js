'use strict';

/**
 * Naming a document rather than pointing at it.
 *
 * A path is not a name. The same two files on a laptop and a desktop sit under
 * different roots, so a link recorded as an absolute path works on exactly one
 * machine and is dead weight on the other. Recorded against the library root it
 * is the same name in both places, and the root is the only thing each machine
 * has to know for itself.
 *
 * Its own module because it is the one piece of the library that is pure
 * arithmetic on strings, so it is the one piece that can be tested without a
 * window, a disk or a person answering a dialog.
 */

const path = require('path');

/**
 * A file's name within the library, or null when it is somewhere else.
 *
 * Forward slashes whatever the platform, because the name is written into a
 * document that the other machine will read and a backslash is not a separator
 * everywhere.
 */
function libraryNameFor(root, file) {
  if (!root || !file) return null;
  const rel = path.relative(root, file);
  // Empty means the file is the root itself, and leading dots mean it is
  // outside it. Neither is a name in the library.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Where a library name points on this machine, or null if it points nowhere it
 * is allowed to.
 *
 * The check after resolving is not ceremony. A name is read out of a document
 * that may have come from anywhere, and `../../` in it would reach any file on
 * the machine through something that looks like an ordinary link.
 */
function libraryPathFor(root, name) {
  if (!root || !name) return null;
  const full = path.resolve(root, String(name).split('/').join(path.sep));
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

/* ------------------------------------------------------------------ */
/* The index                                                           */
/* ------------------------------------------------------------------ */

/**
 * The index is a cache and never the truth. The files are.
 *
 * It can be deleted and it will be rebuilt, and nothing in the application may
 * behave differently because it was there. What it saves is opening every
 * document to answer a question about all of them: a library of three hundred
 * parts is three hundred JSON files to parse before a search box can show its
 * first result, and walking the folders instead is a few milliseconds.
 *
 * So the walk is the truth and the index only carries what the walk cannot see:
 * what a document calls itself inside, and what its parameters are named. Those
 * are keyed by the file's modified time, so an entry is used only while it is
 * still describing the file that is there now.
 */
const INDEX_VERSION = 1;
const INDEX_FILE = 'library.json';

/** An index that is definitely an index, whatever was on disk. */
function normaliseIndex(got) {
  if (!got || got.version !== INDEX_VERSION || !Array.isArray(got.documents)) {
    return { version: INDEX_VERSION, built: 0, documents: [] };
  }
  return {
    version: INDEX_VERSION,
    built: Number(got.built) || 0,
    documents: got.documents.filter((d) => d && typeof d.name === 'string')
  };
}

/**
 * Fold what the walk found together with what the index remembered.
 *
 * A document that has not changed since it was indexed keeps its entry. One
 * that has changed, or was never seen, comes back with `stale` set, and it is
 * the caller's business whether to open it now, later, or not at all.
 *
 * That last part is not fussiness. On a synced folder these files may be
 * placeholders that have never been downloaded, and reading one to find out its
 * title would pull the whole library down over somebody's connection because
 * they opened a list. So nothing here reads a file; the name on disk stands in
 * until the document is opened for its own sake.
 */
function mergeIndex(index, found) {
  const before = new Map(normaliseIndex(index).documents.map((d) => [d.name, d]));
  const documents = found.map((f) => {
    const had = before.get(f.name);
    const fresh = had && had.modified === f.modified && had.title;
    return fresh
      ? { ...had, project: f.project, folder: f.folder, modified: f.modified }
      : {
          name: f.name,
          project: f.project,
          folder: f.folder,
          modified: f.modified,
          title: titleFromName(f.name),
          parameters: had && had.modified === f.modified ? had.parameters || [] : [],
          stale: true
        };
  });
  documents.sort((a, b) => a.name.localeCompare(b.name));
  return { version: INDEX_VERSION, built: Date.now(), documents };
}

/** What to call a document before anything has opened it: its file name. */
function titleFromName(name) {
  return String(name).split('/').pop().replace(/\.anvil$/i, '');
}

/**
 * Put what opening a document taught us back into the index.
 *
 * Called when a document is opened or saved for its own reasons, so the index
 * fills in as the library is used and never on its own account.
 */
function noteDocument(index, entry) {
  const now = normaliseIndex(index);
  if (!entry?.name) return now;
  const rest = now.documents.filter((d) => d.name !== entry.name);
  const kept = now.documents.find((d) => d.name === entry.name) || {};
  rest.push({
    ...kept,
    name: entry.name,
    project: entry.project ?? kept.project ?? null,
    folder: entry.folder ?? kept.folder ?? null,
    modified: entry.modified ?? kept.modified ?? 0,
    title: entry.title || kept.title || titleFromName(entry.name),
    parameters: entry.parameters || kept.parameters || [],
    stale: false
  });
  rest.sort((a, b) => a.name.localeCompare(b.name));
  return { ...now, documents: rest };
}

/**
 * Which documents match a search.
 *
 * Over the title, the name, the project and the parameter names, because those
 * are the four things somebody actually remembers about a part they cannot
 * find: what it was called, where it was, and what it was measured in.
 *
 * A document whose entry is stale is still searched on what is known of it,
 * which is its file name. Leaving it out entirely would make search quietly
 * incomplete on exactly the library that has just been synced down.
 */
function searchIndex(index, query, limit = 40) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return [];
  const scored = [];
  for (const d of normaliseIndex(index).documents) {
    const hay = [d.title, d.name, d.project || '', ...(d.parameters || [])]
      .join(' ')
      .toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    // A hit in the title is what was meant more often than a hit in a folder
    // name three levels up.
    const title = String(d.title || '').toLowerCase();
    scored.push({ doc: d, score: terms.every((t) => title.includes(t)) ? 0 : 1 });
  }
  scored.sort((a, b) => a.score - b.score || a.doc.name.localeCompare(b.doc.name));
  return scored.slice(0, limit).map((s) => s.doc);
}

/**
 * Which project and folder a library name falls in.
 *
 * The layout is projects/<project>/<folders>/<part>.anvil, and a document that
 * is not under projects at all is simply loose in the library. That is allowed:
 * the folders are the truth and somebody dropping a file in with Explorer has
 * not done anything wrong.
 */
function placeOf(name) {
  const bits = String(name).split('/');
  if (bits.length >= 3 && bits[0] === 'projects') {
    return { project: bits[1], folder: bits.slice(2, -1).join('/') || null };
  }
  return { project: null, folder: bits.slice(0, -1).join('/') || null };
}

/* ------------------------------------------------------------------ */
/* Saving on top of somebody else                                      */
/* ------------------------------------------------------------------ */

/**
 * Would writing this file lose work somebody else has already done?
 *
 * The third of the three things that make two computers work, and the one that
 * actually prevents losing anything. Locks reduce the two-at-once case and do
 * not close it: the other machine may have been shut down untidily, or offline,
 * or simply not running Anvil when the sync brought the file down.
 *
 * A counter rather than a modified time, because the two machines' clocks do
 * not agree and nothing can make them. A file written on the desktop can arrive
 * on the laptop stamped a minute in the past, and a save here then looks like
 * the newer one and is not. A counter only ever goes up.
 *
 * Its own function because the cases it has to get right are all edges: a file
 * that is not there, a document written before there were counters, and the
 * save that is deliberately making a new file.
 */
function savingWouldClobber(onDisk, loadedVersion, opts = {}) {
  // A new file, or Save As. Neither can overwrite anybody's work, and the
  // version in hand belongs to whatever this was copied from rather than to the
  // file being made.
  if (opts.fresh) return null;
  // Nothing there to lose. A save onto a file that is not there is just a save.
  if (!onDisk) return null;
  const theirs = Number(onDisk.version) || 0;
  const mine = Number(loadedVersion) || 0;
  // Equal is the ordinary case: this window read it and nobody else has
  // written since. Lower than ours should not happen, and if it does the file
  // is older than what we already have, so writing is not a loss.
  if (theirs <= mine) return null;
  return { version: theirs, mine, by: onDisk.writtenBy || null };
}

module.exports = {
  savingWouldClobber,
  libraryNameFor,
  libraryPathFor,
  INDEX_VERSION,
  INDEX_FILE,
  normaliseIndex,
  mergeIndex,
  noteDocument,
  searchIndex,
  placeOf,
  titleFromName
};
