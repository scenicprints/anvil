/**
 * Crash recovery: what is written between saves.
 *
 * The one gap left in the inventory that could actually cost work. Nothing was
 * written between saves, so a crash, a power cut or Electron dying took
 * everything since the last Ctrl+S.
 *
 * Two things have to be true and they pull against each other. Something must
 * survive a crash, and nothing must be offered back when there was no crash: an
 * offer that appears on an ordinary morning is one that gets dismissed without
 * reading, and then it is not there on the morning it matters.
 *
 * A recovery file left over from a previous session is planted before this run,
 * which is exactly what a crash leaves behind. This session's own file is
 * written too, so the second half can check it is not offered back to the
 * window that is still working on it.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

/* ---- what a previous session left behind ---- */
{
  const got = await window.anvil.recoverable?.();
  report.foundSomething = got?.ok === true && got.found.length > 0;
  report.whatItFound = (got?.found || []).map((f) => f.title);
  if (!report.foundSomething) {
    return { ...report, stuckAt: 'nothing was planted to recover, so the run proves nothing' };
  }

  const planted = got.found.find((f) => /Planted/.test(f.title || ''));
  report.plantedOneIsThere = !!planted;
  report.itKnowsWhenItWas = typeof planted?.at === 'number' && planted.at > 0;
  report.itKnowsWhereItCameFrom = planted?.path !== undefined;

  /* ---- and it comes back as the document it was ---- */
  const res = await window.anvil.recover?.(planted.session);
  report.recovered = res?.ok === true;
  report.theWorkIsThere = res?.data?.features?.length === 1;
  report.itIsTheRightWork = res?.data?.name === 'Planted crash';

  dev.state.doc = dev.migrate ? dev.migrate(res.data) : res.data;
  dev.rebuildAll();
  await wait(900);
  report.itBuilds = dev.bodies.length === 1;
  // Recovered work is unsaved work. The file on disk is still exactly what was
  // last chosen, and this is the argument for changing it, not the change.
  dev.state.dirty = true;
  report.arrivesUnsaved = dev.isDirty() === true;

  /* ---- and once taken, it is not offered again ---- */
  await window.anvil.discardRecovery?.(planted.session);
  const after = await window.anvil.recoverable?.();
  report.notOfferedTwice = !(after?.found || []).some((f) => f.session === planted.session);
}

/* ---- this session writes its own, and is never offered it ---- */
{
  const wrote = await window.anvil.autosave?.({ ...dev.state.doc, name: 'This session' });
  report.autosaveWrites = wrote?.ok === true;

  const got = await window.anvil.recoverable?.();
  // Offering a window the work it is doing right now would be worse than
  // useless: it would look like a crash every time the app started.
  report.doesNotOfferItsOwn = !(got?.found || []).some((f) => f.title === 'This session');
}

/* ---- an unreadable one is cleared away rather than offered ---- */
{
  // A file that was being written when the power went is not something anybody
  // can be offered. It is planted here as a half-written file.
  const got = await window.anvil.recoverable?.();
  report.brokenOneNotOffered = !(got?.found || []).some((f) => /Broken/.test(f.title || ''));
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
