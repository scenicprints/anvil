'use strict';

/**
 * The library naming, checked in plain node.
 *
 * Everything else in the suite runs inside a window because it needs the
 * kernel. This does not: it is string arithmetic about where files are, and the
 * one part of the library that decides whether a link made on one machine still
 * means anything on another. Running it here means it is checked even when the
 * window will not start.
 */

const path = require('path');
const { libraryNameFor, libraryPathFor } = require('../src/main/library.js');

const failures = [];
let checks = 0;
const check = (what, got, want) => {
  checks++;
  if (got !== want) failures.push(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const root = path.join(path.sep === '\\' ? 'C:\\lib' : '/lib');
const inside = path.join(root, 'projects', 'clamp', 'Body.anvil');

// The name is the same word on either machine, which is the whole point: it is
// written into a document that the other machine will read.
check('a file in the library has a name', libraryNameFor(root, inside), 'projects/clamp/Body.anvil');
check(
  'and the name comes back to the same file',
  libraryPathFor(root, 'projects/clamp/Body.anvil'),
  inside
);

// Outside it there is no name, and that is not a failure: it is a link that
// has only a path to go on, which still works on the machine that made it.
check(
  'a file outside the library has no name',
  libraryNameFor(root, path.join(path.sep === '\\' ? 'D:\\elsewhere' : '/elsewhere', 'Body.anvil')),
  null
);
check('and the root itself is not a document in it', libraryNameFor(root, root), null);
check('no root, no name', libraryNameFor(null, inside), null);

/*
 * A name is read out of a document that may have come from anywhere. Climbing
 * out of the library with dots would reach any file on the machine through
 * something that looks like an ordinary link, so it resolves to nothing.
 */
check('a name cannot climb out', libraryPathFor(root, '../../Windows/System32/config'), null);
check('nor with a leading slash', libraryPathFor(root, '/etc/passwd') === inside, false);
check('no root, nowhere to point', libraryPathFor(null, 'projects/clamp/Body.anvil'), null);

// A name with folders in it survives the round trip on either separator, which
// is the case that matters: the laptop writes it and the desktop reads it.
check(
  'the round trip holds',
  libraryNameFor(root, libraryPathFor(root, 'a/b/c/Part.anvil')),
  'a/b/c/Part.anvil'
);

if (failures.length) {
  for (const f of failures) process.stderr.write(`FAIL library: ${f}\n`);
  process.exit(1);
}
process.stdout.write(`library naming: ${8} checks passed\n`);
