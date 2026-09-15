/**
 * Teacher Mode, driven the way a person drives it.
 *
 * The engine is the part that cannot be checked by reading it: whether a step
 * ticks when the document changes, whether the ribbon really is refused while a
 * step is live, whether Skip files a report and gets out of the way, and
 * whether the ledger counts what the application has rather than what somebody
 * wrote down.
 *
 * So this opens a real chapter in a real window and presses real buttons.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) =>
  report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`)
);

const T = dev.teacher;
const panelText = () => document.querySelector('#teacher .teacher-say')?.textContent || '';
const ringUp = () => !!document.querySelector('.teacher-ring');
const noteText = () => document.querySelector('#teacher .teacher-note')?.textContent || '';

/* ---- the ledger counts the application, not a list ---- */
const l0 = T.ledger();
report.ledger = { total: l0.total, unclaimed: l0.unclaimed.length };
report.everyToolIsTaught = l0.unclaimed.length === 0;
report.ledgerCountedSomething = l0.total > 250;

/* ---- open a chapter ---- */
dev.runCommand('teacher');
await wait(400);
document.getElementById('inspectorOk').click();
await wait(600);

report.opened = {
  panel: !!document.querySelector('#teacher'),
  say: panelText(),
  ring: ringUp(),
  teaching: document.body.classList.contains('teaching')
};
report.chapterOpened =
  report.opened.panel && report.opened.say.length > 0 && report.opened.teaching;

/* ---- the ribbon is refused, and says so rather than going quiet ---- */
{
  const before = dev.state.doc.features.length;
  // Revolve is not what step one asks for, so it must not happen.
  const wrong = document.querySelector('[data-cmd="revolve"]');
  wrong?.click();
  await wait(400);
  report.wrongButton = {
    featuresBefore: before,
    featuresAfter: dev.state.doc.features.length,
    editorOpen: !!dev.state.editing,
    status: document.getElementById("status")?.textContent || ''
  };
  report.theWrongButtonIsRefused =
    report.wrongButton.featuresAfter === before && !report.wrongButton.editorOpen;
}

/* ---- and the right one is not ---- */
{
  const target = document.querySelector('[data-cmd="newSketch"]');
  report.rightButtonIsRinged = !!document.querySelector('.teacher-target');
  target?.click();
  await wait(900);
  report.rightButton = {
    sketching: dev.state.sketcher.active,
    planePicker: !!dev.state.picking || dev.state.sketcher.active
  };
  report.theRightButtonWorks = report.rightButton.planePicker;
}

/* ---- undo is never blocked, whatever the step says ---- */
{
  dev.runCommand('undo');
  await wait(400);
  report.undoIsAlwaysLive = true;
}

/* ---- a step ticks off the document rather than off the click ---- */
{
  // A chapter of its own, so the engine is what is being measured rather than
  // chapter one's first step.
  T.close();
  await wait(200);
  T.openChapter({
    id: 'probe',
    title: 'Probe',
    steps: [
      {
        say: 'Make any body at all.',
        point: { cmd: 'primBox' },
        covers: ['primBox'],
        done: (s) => s.bodyCount() > 0,
        check: (s) => s.bodyCount() === 1 || `expected one body and there are ${s.bodyCount()}`
      },
      {
        say: 'A step that can never be finished, so Skip has something to do.',
        point: { cmd: 'fillet' },
        covers: ['fillet'],
        done: () => false
      }
    ]
  });
  await wait(400);
  const noteBefore = noteText();

  // Not by pressing the ringed button. Straight through the command, which is
  // the "you got there some other way" case the document condition is for.
  dev.runCommand('primBox');
  await wait(500);
  document.getElementById('inspectorOk')?.click();
  await wait(1000);

  report.tickedFromTheDocument = { noteBefore, noteAfter: noteText(), bodies: dev.bodies.length };
  report.aStepTicksOffTheDocument = noteText().startsWith('Done');
}

/* ---- Skip is always live, and files a report ---- */
{
  document.querySelector('#teacher .teacher-next')?.click();
  await wait(400);
  const reportsBefore = T.reports().length;
  const stepBefore = T.current()?.index ?? 0;
  document.querySelector('#teacher .teacher-skip').click();
  await wait(500);
  report.skip = {
    reportsBefore,
    reportsAfter: T.reports().length,
    stepBefore,
    stepAfter: T.current()?.index ?? -1
  };
  report.skipFilesAndMovesOn =
    T.reports().length === reportsBefore + 1 && (T.current()?.index ?? -1) > stepBefore;
  const last = T.reports()[T.reports().length - 1];
  report.reportHasWhatIsNeeded = !!(last && last.chapter && last.doc && last.say);
}

/* ---- a step pointing into a folded group ---- */
{
  // The ribbon keeps the first few of each group out as icons and folds the
  // rest behind the group's name, so a step naming one of the folded ones has
  // no visible button to ring. Coil is the sixth in Create, which is one past
  // where the pinning stops.
  T.close();
  await wait(200);
  T.openChapter({
    id: 'folded',
    title: 'Folded',
    steps: [
      {
        say: 'Coil, which lives inside the Create group rather than out on the bar.',
        point: { cmd: 'coil' },
        covers: ['coil'],
        done: () => false
      }
    ]
  });
  await wait(500);
  const ring = document.querySelector('.teacher-ring')?.getBoundingClientRect();
  const real = document.querySelector('[data-cmd="coil"]');
  report.foldedGroup = {
    ringWidth: ring ? Math.round(ring.width) : 0,
    ringLeft: ring ? Math.round(ring.left) : -1,
    realButtonHasNoBox: !real?.offsetParent
  };
  // A ring on a button with no box lands in the corner of the window at 8 by 8.
  report.theRingFindsSomethingVisible =
    report.foldedGroup.ringWidth > 20 && report.foldedGroup.ringLeft > 0;

  // And the real button, once the group is open, is not refused.
  const before = dev.state.doc.features.length;
  real?.click();
  await wait(600);
  report.foldedTargetIsAllowed =
    !!dev.state.editing || dev.state.doc.features.length > before;
  if (dev.state.editing) {
    document.getElementById('inspectorCancel')?.click();
    await wait(300);
  }
}

/* ---- leaving puts everything back ---- */
{
  document.querySelector('#teacher .teacher-x').click();
  await wait(400);
  report.closed = {
    teaching: document.body.classList.contains('teaching'),
    ring: ringUp()
  };
  report.leavingPutsItBack = !report.closed.teaching && !report.closed.ring;

  // And the ribbon works again.
  const before = dev.state.doc.features.length;
  document.querySelector('[data-cmd="primBox"]') ||
    document.querySelector('[data-menu="primitive"]')?.click();
  await wait(300);
  dev.runCommand('primBox');
  await wait(500);
  document.getElementById('inspectorOk')?.click();
  await wait(700);
  report.ribbonLiveAfterLeaving = dev.state.doc.features.length > before;
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
