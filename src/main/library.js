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

module.exports = { libraryNameFor, libraryPathFor };
