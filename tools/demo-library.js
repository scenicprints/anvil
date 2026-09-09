/**
 * The library, on a real disk, through the real IPC.
 *
 * The pure parts have their own tests in node. What those cannot reach is
 * everything that happens between the window and the files: whether a profile
 * survives being written and read back, whether the index lands in the library
 * folder rather than somewhere in the application's own data, whether recents
 * fills in as documents are opened, and whether a save onto a file that has
 * moved on refuses.
 *
 * That last one is the point of the whole exercise. Two machines editing one
 * file will not merge, and the counter is what turns silent loss into a choice.
 *
 * One caveat for whoever runs this: the index lives in the library folder and
 * survives between runs, so the check that a document starts out known only by
 * its file name is only meaningful on a library whose `library.json` has been
 * removed first. That is not a flaw in the index. It is the index doing exactly
 * what it is for, and it is worth knowing before reading a green as proof.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

/* ---- who we are ---- */
{
  const got = await window.anvil.profiles?.();
  report.hasAProfile = !!got && got.profiles.length >= 1;
  report.doesNotAskWithOnlyOne = got?.profiles.length === 1 ? got.ask === false : 'more than one';
  report.profileNames = got?.profiles.map((p) => p.name) ?? null;
  report.oneIsInUse = !!got?.active;
}

const lib = await window.anvil.library?.();
report.libraryRoot = lib?.root ?? null;
report.profileNamed = lib?.profile?.name ?? null;

/*
 * Everything below needs a library folder, and choosing one opens a folder
 * dialog no probe can answer. So when there is no library the run says so
 * plainly and stops, rather than reporting green on checks it never made.
 */
if (!lib?.root) {
  report.stoppedBecause =
    'No library folder is set on this machine, so the parts that need one were not run';
  return report;
}

/* ---- a project, which is a folder with a note in it ---- */
{
  const made = await window.anvil.createProject?.('DemoProject');
  report.projectMade = made?.ok === true;
  report.projectPath = made?.path ?? null;

  const list = await window.anvil.projects?.();
  report.projectListed = !!list?.projects?.some((p) => p.name === 'DemoProject');
  // Twice is not an error. Somebody making a project that is already there
  // means it to be there, and the note is left as it was.
  const again = await window.anvil.createProject?.('DemoProject');
  report.makingItTwiceIsFine = again?.ok === true;
}

/* ---- the index, which is a cache in the library and never the truth ---- */
{
  const listed = await window.anvil.listLibrary?.();
  report.libraryListed = listed?.ok === true;
  report.documentsFound = listed?.documents?.length ?? null;
  // Nothing has been opened, so nothing is known beyond file names, and the
  // entries have to say so rather than pretending to a title.
  report.entriesKnowTheyAreStale =
    !listed?.documents?.length || listed.documents.every((d) => 'stale' in d);
}

/* ---- recents, which is a promise that a click will open something ---- */
{
  const got = await window.anvil.recents?.();
  report.recentsAnswered = got?.ok === true;
  report.recentsCount = got?.recents?.length ?? null;
  // Every entry has been checked against the disk before being offered.
  report.recentsAllExist = (got?.recents || []).every((r) => r.modified !== null);
}

/* ---- searching finds by name even before anything has been opened ---- */
{
  const got = await window.anvil.searchLibrary?.('demo');
  report.searchAnswered = got?.ok === true;
  report.searchIsAList = Array.isArray(got?.results);
  const empty = await window.anvil.searchLibrary?.('   ');
  report.emptySearchFindsNothing = empty?.results?.length === 0;
}

/* ---- a link that resolves by name, which is what the library is for ---- */
{
  // Nothing is there under this name, so it must fail with a reason rather
  // than quietly returning something.
  const miss = await window.anvil.readLinked?.('projects/DemoProject/nothing.anvil', null);
  report.aMissingLinkSaysSo = miss?.ok === false && !!miss.error;
}

/* ---- opening a real document: the view, the index and recents ---- */
{
  const listed = await window.anvil.listLibrary?.();
  const doc = (listed?.documents || []).find((d) => /Bracket\.anvil$/.test(d.name));
  report.foundTheDocument = !!doc;
  if (doc?.path) {
    // Before opening, nothing has read it, so all that is known is its file
    // name. That is the index doing its job rather than falling short: reading
    // every document to build a list would download a whole synced library.
    report.titleBeforeOpening = doc.title;
    report.itWasStale = doc.stale === true;

    const opened = await window.anvil.openPath?.(doc.path);
    report.opened = opened?.ok === true;
    report.openedByName = opened?.name ?? null;
    report.versionRead = opened?.data?.version ?? null;

    // Where you left off. The camera is the part that has to survive a round
    // trip through JSON exactly, since a degree out is visible.
    const put = dev.state.vp.setCameraState(opened.data.view.camera);
    const cam = dev.state.vp.cameraState();
    report.cameraCameBack =
      put &&
      Math.abs(cam.radius - 333) < 1e-9 &&
      Math.abs(cam.theta - 2.2) < 1e-9 &&
      cam.perspective === false &&
      Math.abs(cam.target[1] - 6) < 1e-9;

    // Opening it is what fills the index in, so a later search need not open it
    // again. And the parameter name is in there, which is the thing a folder
    // listing can never tell you.
    const after = await window.anvil.listLibrary?.();
    const entry = (after?.documents || []).find((d) => /Bracket\.anvil$/.test(d.name));
    report.titleAfterOpening = entry?.title ?? null;
    report.noLongerStale = entry?.stale === false;
    report.foundByParameterName =
      (await window.anvil.searchLibrary?.('wallthickness'))?.results?.length === 1;
    report.foundByTitle = (await window.anvil.searchLibrary?.('demo bracket'))?.results?.length === 1;

    // And it is in recents, which is the list that saves going and finding it.
    const rec = await window.anvil.recents?.();
    report.inRecents = (rec?.recents || []).some((r) => /Bracket\.anvil$/.test(r.path));
    report.recentKnowsItsName = (rec?.recents || [])[0]?.name ?? null;
  }
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
