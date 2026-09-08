/**
 * Move, and what point to point actually takes.
 *
 * It used to take the middle of whatever face was clicked, or the bare spot the
 * ray happened to land on. Neither is a place anybody means, and with nothing
 * on screen saying which of them had been taken the pick could not be checked
 * afterwards either. It reads as the app choosing points on its own.
 *
 * It snaps to a corner, the middle of an edge, or the centre of a hole now, in
 * that order of preference, and says which beside the cursor before the click
 * and in the status line after it.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const canvas = document.getElementById('view');
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

const at = (cx, cy) => ({
  clientX: cx,
  clientY: cy,
  pointerId: 1,
  bubbles: true,
  cancelable: true,
  isPrimary: true
});
const fire = (t, x, y, b) => canvas.dispatchEvent(new PointerEvent(t, { ...at(x, y), button: 0, buttons: b }));
async function clickAt(x, y) {
  fire('pointermove', x, y, 0);
  await wait(60);
  fire('pointerdown', x, y, 1);
  await wait(40);
  fire('pointerup', x, y, 0);
  await wait(250);
}
const hint = () => {
  const h = document.getElementById('snaphint');
  return h && h.style.display !== 'none' ? h.textContent : null;
};

/* ---- a box, 30 by 30 by 20 about the origin ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(400);
document.getElementById('inspectorOk').click();
await wait(700);
dev.state.vp.fit(1.7);
await wait(400);
const bb = dev.bodies[0].solid.boundingBox();
report.box = { min: bb.min.map((n) => +n.toFixed(2)), max: bb.max.map((n) => +n.toFixed(2)) };

/* ---- Move, point to point ---- */
dev.runCommand('move');
await wait(700);
report.dialog = document.getElementById('inspectorTitle')?.textContent;
if (!dev.state.editing?.feature) return { ...report, stuckAt: 'the move dialog did not open' };
// Through the dialog's own select, so the rows it decides to show are the rows
// that get shown. Setting the field on the feature changes nothing on screen.
{
  const row = [...document.querySelectorAll('#inspectorBody .field')].find((f) =>
    f.textContent.includes('Move type')
  );
  const sel = row?.querySelector('select');
  report.foundTheTypeRow = !!sel;
  if (!sel) return report;
  sel.value = 'points';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(400);
}
{
  const rows = [...document.querySelectorAll('#inspectorBody .field')];
  const from = rows.find((r) => r.textContent.includes('From'));
  const btn = from?.querySelector('button');
  report.foundTheFromRow = !!btn;
  if (!btn) return report;
  btn.click();
  await wait(300);
}
report.armed = dev.state.editing?.pickInto;

/* ---- aim a few pixels off a top corner of the box ---- */
const corner = [bb.max[0], bb.max[1], bb.max[2]];
const s = dev.state.vp.worldToScreen(corner[0], corner[1], corner[2]);
fire('pointermove', s.clientX + 5, s.clientY + 5, 0);
await wait(250);
report.hintNearACorner = hint();

await clickAt(s.clientX + 5, s.clientY + 5);
report.tookFrom = dev.state.editing?.feature?.fromPoint?.map((n) => +n.toFixed(3)) ?? null;
report.status = document.getElementById('status')?.textContent ?? null;

// Within a hair of the corner, not the middle of a face, which is where a
// click five pixels away from it used to land.
report.snappedToTheCorner =
  !!report.tookFrom &&
  Math.hypot(
    report.tookFrom[0] - corner[0],
    report.tookFrom[1] - corner[1],
    report.tookFrom[2] - corner[2]
  ) < 0.01;

/* ---- and the middle of an edge, which is the other thing people mean ---- */
{
  const rows = [...document.querySelectorAll('#inspectorBody .field')];
  const to = rows.find((r) => r.textContent.includes('To'));
  to?.querySelector('button')?.click();
  await wait(300);
}
const mid = [bb.max[0], (bb.min[1] + bb.max[1]) / 2, bb.max[2]];
const m = dev.state.vp.worldToScreen(mid[0], mid[1], mid[2]);
fire('pointermove', m.clientX + 4, m.clientY, 0);
await wait(250);
report.hintNearAnEdgeMiddle = hint();
await clickAt(m.clientX + 4, m.clientY);
report.tookTo = dev.state.editing?.feature?.toPoint?.map((n) => +n.toFixed(3)) ?? null;
report.snappedToTheEdgeMiddle =
  !!report.tookTo &&
  Math.hypot(report.tookTo[0] - mid[0], report.tookTo[1] - mid[1], report.tookTo[2] - mid[2]) < 0.01;

/* ---- and it moves the body by exactly that ---- */
document.getElementById('inspectorOk').click();
await wait(900);
const after = dev.bodies[0].solid.boundingBox();
report.movedBy = [0, 1, 2].map((i) => +(after.min[i] - bb.min[i]).toFixed(3));
report.wanted = [0, 1, 2].map((i) => +(mid[i] - corner[i]).toFixed(3));
report.movedByWhatWasAsked = report.movedBy.every(
  (v, i) => Math.abs(v - report.wanted[i]) < 0.01
);

/* ---- along a direction taken off the model, and a copy of it ---- */
// The two Fusion rows that were missing: pick something in the model to go
// along, and leave the original behind. Both are driven through the dialog,
// because a field set on the feature by hand proves nothing about whether
// there is a row on screen to set it with.
const rows = () => [...document.querySelectorAll('#inspectorBody .field')];
const rowFor = (text) => rows().find((r) => r.textContent.includes(text));
const setSelect = async (text, value) => {
  const sel = rowFor(text)?.querySelector('select');
  if (!sel) return false;
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(400);
  return true;
};

const before = dev.bodies[0].solid.boundingBox();
dev.runCommand('move');
await wait(700);
report.directionRowIsThere = { asType: false, hidden: false };
{
  // Hidden until the move type asks for it, the same as every other row that
  // belongs to one type.
  report.directionRowIsThere.hidden = !rowFor('Direction');
  report.directionRowIsThere.asType = await setSelect('Move type', 'direction');
  report.directionRowAppears = !!rowFor('Direction');
  report.copyRowIsThere = !!rowFor('Create a copy');
}

if (report.directionRowAppears) {
  // Point at the top face of the box, which faces straight up, and go along
  // the way it faces.
  rowFor('Direction')?.querySelector('button')?.click();
  await wait(300);
  report.armedForDirection = dev.state.editing?.pickInto;
  // The middle of the top face as it is now, not as it was: the point to point
  // move above has already carried the box off its old place, and aiming at
  // where it used to be lands on an edge.
  const top = dev.state.vp.worldToScreen(
    (before.min[0] + before.max[0]) / 2,
    (before.min[1] + before.max[1]) / 2,
    before.max[2]
  );
  await clickAt(top.clientX, top.clientY);
  report.tookDirection = dev.state.editing?.feature?.direction?.map((n) => +n.toFixed(3)) ?? null;
  report.directionLabel = dev.state.editing?.feature?.directionLabel ?? null;
  report.tookTheFaceNormal =
    !!report.tookDirection && Math.abs(report.tookDirection[2] - 1) < 0.01;

  const dist = rowFor('Distance')?.querySelector('input');
  if (dist) {
    dist.value = '25';
    dist.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(500);
  }
  const copyBox = rowFor('Create a copy')?.querySelector('input[type="checkbox"]');
  if (copyBox) {
    copyBox.checked = true;
    copyBox.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500);
  }
  document.getElementById('inspectorOk').click();
  await wait(1000);

  report.bodiesAfterCopy = dev.bodies.length;
  const tops = dev.bodies.map((b) => +b.solid.boundingBox().max[2].toFixed(2)).sort((a, b) => a - b);
  report.topsAfterCopy = tops;
  // One left where it was, one twenty five higher, and two bodies to show for
  // it rather than one moved one.
  report.copyLeftTheOriginal =
    report.bodiesAfterCopy === 2 &&
    Math.abs(tops[0] - before.max[2]) < 0.01 &&
    Math.abs(tops[1] - (before.max[2] + 25)) < 0.01;
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
