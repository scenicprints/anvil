'use strict';

/**
 * Profiles and the library index, checked in plain node.
 *
 * Neither needs a window: one is a store of names and folders, the other is a
 * cache of what documents are called. What they both need is to be exactly
 * right about the awkward cases, because the awkward cases here are somebody's
 * library going missing and somebody's search coming back empty.
 */

const P = require('../src/main/profiles.js');
const LIB = require('../src/main/library.js');

const failures = [];
let checks = 0;
const check = (what, got, want) => {
  checks++;
  if (got !== want) failures.push(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

/* ---------------------------------------------------------- profiles */

// The first run makes one, and it is the one in use: a profile nobody is
// working in is a question with no answer.
{
  const store = P.firstRun(null, { name: 'Kevin', root: null });
  check('a first run makes a profile', store.profiles.length, 1);
  check('and it is in use', P.active(store)?.name, 'Kevin');
}

/*
 * The upgrade matters more than the first run.
 *
 * Somebody already has a library folder set from before profiles existed.
 * Losing it looks exactly like losing the library: every derived link in every
 * document stops resolving by name on the next open, and there is nothing on
 * screen to say why.
 */
{
  const store = P.firstRun(null, { name: 'Kevin', root: 'D:/Parts' });
  check('the old library folder is inherited', P.active(store)?.root, 'D:/Parts');
}

// A store that is already there is left alone, however many profiles it holds.
{
  const before = P.firstRun(null, { name: 'Kevin', root: 'D:/Parts' });
  const after = P.firstRun(before, { name: 'Someone else', root: 'E:/Other' });
  check('an existing store is not overwritten', after.profiles.length, 1);
  check('nor its folder', P.active(after)?.root, 'D:/Parts');
}

{
  let store = P.firstRun(null, { name: 'Kevin' });
  const added = P.add(store, { name: 'Work' });
  store = added.store;
  check('a second profile can be added', store.profiles.length, 2);
  check('and it is the one in use', P.active(store)?.name, 'Work');
  check('two profiles cannot share a name', P.add(store, { name: 'work' }).error !== undefined, true);
  check('nor can one have no name', P.add(store, { name: '   ' }).error !== undefined, true);

  const back = P.use(store, store.profiles[0].id);
  check('switching switches', P.active(back)?.name, 'Kevin');
  check('switching to nothing changes nothing', P.active(P.use(back, 'nope'))?.name, 'Kevin');

  // Removing the one in use has to leave somebody in use, or the next question
  // asked of the store has no answer at all.
  const gone = P.remove(back, back.active);
  check('removing the active one picks another', gone.profiles.length, 1);
  check('and it is in use', P.active(gone) !== null, true);
  // The last one stays. A store with no profiles is a state nothing recovers
  // from without asking a question nobody was expecting.
  check('the last profile will not go', P.remove(gone, gone.active).profiles.length, 1);
}

/* ---------------------------------------------------------- recents */
{
  let store = P.firstRun(null, { name: 'Kevin' });
  const id = store.active;
  store = P.remember(store, id, { path: 'D:/Parts/a.anvil', name: 'a.anvil', title: 'A' });
  store = P.remember(store, id, { path: 'D:/Parts/b.anvil', name: 'b.anvil', title: 'B' });
  check('newest first', P.active(store).recents[0].title, 'B');

  // Opening something again moves it up rather than listing it twice, which is
  // the whole difference between a recents list and a log.
  store = P.remember(store, id, { path: 'D:/parts/A.ANVIL', name: 'a.anvil', title: 'A' });
  check('reopening does not duplicate', P.active(store).recents.length, 2);
  check('and moves it to the top', P.active(store).recents[0].title, 'A');

  for (let i = 0; i < 30; i++) {
    store = P.remember(store, id, { path: `D:/Parts/x${i}.anvil`, title: `X${i}` });
  }
  check('the list is capped', P.active(store).recents.length, P.RECENTS);

  store = P.forget(store, id, ['D:/PARTS/X29.anvil']);
  check('a file that has gone is dropped', P.active(store).recents[0].title, 'X28');
}

/* ---------------------------------------------------------- the index */

/*
 * The index is a cache and never the truth. The files are.
 *
 * So a merge is driven by what the walk found: a document that is on disk is in
 * the result whether the index knew about it or not, and one the index
 * remembers that is no longer there is gone.
 */
{
  const found = [
    { name: 'projects/clamp/Body.anvil', modified: 100, project: 'clamp', folder: null },
    { name: 'projects/clamp/Lid.anvil', modified: 200, project: 'clamp', folder: null }
  ];
  const first = LIB.mergeIndex(null, found);
  check('everything found is in the index', first.documents.length, 2);
  // Nothing has been opened, so nothing is known beyond the file name, and the
  // entries say so rather than pretending.
  check('and starts out stale', first.documents.every((d) => d.stale), true);
  check('with the file name standing in for the title', first.documents[0].title, 'Body');

  const known = LIB.noteDocument(first, {
    name: 'projects/clamp/Body.anvil',
    modified: 100,
    title: 'Clamp body',
    parameters: ['wall', 'bore']
  });
  check('opening one fills it in', known.documents.find((d) => d.name.endsWith('Body.anvil')).title, 'Clamp body');

  // An entry survives a walk that found the same file unchanged, and that is
  // the entire point: the next search does not have to open it again.
  const again = LIB.mergeIndex(known, found);
  const body = again.documents.find((d) => d.name.endsWith('Body.anvil'));
  check('an unchanged file keeps what was learned', body.title, 'Clamp body');
  check('and is no longer stale', !!body.stale, false);

  // A file that has changed loses it, because what was learned was about the
  // old one and there is no way to tell which parts still apply.
  const moved = LIB.mergeIndex(known, [{ ...found[0], modified: 999 }, found[1]]);
  check('a changed file goes back to being stale', moved.documents[0].stale, true);
  check('with the name standing in again', moved.documents[0].title, 'Body');

  // A deleted file leaves.
  check('and a file that has gone is gone', LIB.mergeIndex(known, [found[1]]).documents.length, 1);

  // An index written by a version that thought differently is thrown away
  // rather than read wrongly: it is a cache, so rebuilding costs nothing.
  check('an index from another version is discarded', LIB.normaliseIndex({ version: 99, documents: [{ name: 'x' }] }).documents.length, 0);
}

/* ---------------------------------------------------------- search */
{
  const index = LIB.noteDocument(
    LIB.mergeIndex(null, [
      { name: 'projects/clamp/Body.anvil', modified: 1, project: 'clamp', folder: null },
      { name: 'projects/press/Frame.anvil', modified: 1, project: 'press', folder: null }
    ]),
    { name: 'projects/clamp/Body.anvil', modified: 1, title: 'Clamp body', parameters: ['wallThickness'] }
  );

  check('search finds a title', LIB.searchIndex(index, 'clamp body').length, 1);
  check('and a project', LIB.searchIndex(index, 'press')[0].name, 'projects/press/Frame.anvil');
  // What somebody remembers about a part they cannot find is often what it was
  // measured in, which is the one thing a folder listing cannot tell them.
  check('and a parameter name', LIB.searchIndex(index, 'wallthickness')[0].title, 'Clamp body');
  // A document nothing has opened is still searchable on what is known of it.
  check('a stale entry is still findable', LIB.searchIndex(index, 'frame').length, 1);
  check('every term has to match', LIB.searchIndex(index, 'clamp press').length, 0);
  check('an empty search matches nothing rather than everything', LIB.searchIndex(index, '  ').length, 0);
}

/* ---------------------------------------------------------- where things live */
{
  check('a part in a project', LIB.placeOf('projects/clamp/Body.anvil').project, 'clamp');
  check('in a folder inside it', LIB.placeOf('projects/clamp/parts/Body.anvil').folder, 'parts');
  // Somebody dropping a file into the library with Explorer has not done
  // anything wrong, and it has to appear.
  check('and one loose in the library', LIB.placeOf('Body.anvil').project, null);
}

/* ------------------------------------------- saving on top of somebody else */

/*
 * The rule that turns silent loss into a choice.
 *
 * Every case here is an edge, which is why it is a function of its own rather
 * than three lines inside the save: a file that is not there, a document
 * written before there were counters at all, and the save that is deliberately
 * making a new file and so cannot be overwriting anything.
 */
{
  const them = (version, by) => ({ version, writtenBy: by });

  check('nobody has been here', LIB.savingWouldClobber(them(3), 3), null);
  check('nor has anyone if the file is older', LIB.savingWouldClobber(them(2), 3), null);
  check('a file that is not there is not a clash', LIB.savingWouldClobber(null, 3), null);

  const clash = LIB.savingWouldClobber(them(7, 'Kevin on the desktop'), 3);
  check('a higher version on disk is a clash', clash?.version, 7);
  check('and it says whose', clash?.by, 'Kevin on the desktop');
  check('and what we had', clash?.mine, 3);

  // Save As and a first save cannot overwrite anybody: the version in hand
  // belongs to whatever this was copied from, not to the file being made.
  check('a new file is never a clash', LIB.savingWouldClobber(them(99), 0, { fresh: true }), null);

  // A document written before counters existed has no version at all, which
  // reads as zero and must not be treated as newer than everything.
  check('a document from before counters', LIB.savingWouldClobber(them(undefined), 0), null);
  check('and one being saved over by a counted one', LIB.savingWouldClobber(them(undefined), 4), null);
}

if (failures.length) {
  for (const f of failures) process.stderr.write(`FAIL profiles: ${f}\n`);
  process.exit(1);
}
process.stdout.write(`profiles and index: ${checks} checks passed\n`);
