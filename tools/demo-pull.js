/**
 * Pulling straight off the selection, both ways.
 *
 * Click a face, drag the arrow that appears, watch the body follow, then type
 * the exact number over the one you dragged to. The same gesture on a sketch
 * profile extrudes it. Both have to work in both directions, which is the part
 * that was wrong first: an extrude has no negative length, it is a length one
 * way and a flag that turns it round.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const canvas = document.getElementById('view');
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

const at = (cx, cy) => ({ clientX: cx, clientY: cy, pointerId: 1, bubbles: true, cancelable: true });
async function clickAt(cx, cy) {
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at(cx, cy), button: 0, buttons: 1 }));
  await wait(40);
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...at(cx, cy), button: 0, buttons: 0 }));
  await wait(200);
}

/** Where the arrow sits on screen, and which way it runs there. */
function arrow() {
  const f = dev.state.pullHandle?.frame;
  if (!f) return null;
  const size = dev.state.vp.pixelSize() * 95;
  const o = dev.state.vp.worldToScreen(f.origin[0], f.origin[1], f.origin[2]);
  const tip = dev.state.vp.worldToScreen(
    f.origin[0] + f.z[0] * size,
    f.origin[1] + f.z[1] * size,
    f.origin[2] + f.z[2] * size
  );
  if (!o || !tip || o.behind || tip.behind) return null;
  const dx = tip.clientX - o.clientX;
  const dy = tip.clientY - o.clientY;
  const len = Math.hypot(dx, dy);
  return { gx: o.clientX + dx * 0.45, gy: o.clientY + dy * 0.45, ux: dx / (len || 1), uy: dy / (len || 1), len };
}

/**
 * Drag the arrow `px` pixels along itself, or against itself when negative.
 *
 * The direction is asked again after the press, because grabbing an arrow that
 * points at the camera turns the view so there is something to drag along.
 */
async function pull(px, { commit = null } = {}) {
  const before = arrow();
  if (!before) return { grabbed: false };
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at(before.gx, before.gy), button: 0, buttons: 1 }));
  await wait(150);
  if (!dev.state.pullDrag) return { grabbed: false, missedArrow: true };
  const a = arrow() || before;

  for (let i = 1; i <= 5; i++) {
    const k = (px * i) / 5;
    canvas.dispatchEvent(
      new PointerEvent('pointermove', { ...at(before.gx + a.ux * k, before.gy + a.uy * k), buttons: 1 })
    );
    await wait(80);
  }
  const out = {
    grabbed: true,
    valueBox: document.querySelector('.pull-entry input')?.value,
    distance: dev.state.editing?.feature?.distance,
    flip: dev.state.editing?.feature?.flip,
    errors: dev.state.result.errors.map((e) => e.message)
  };
  canvas.dispatchEvent(
    new PointerEvent('pointerup', { ...at(before.gx + a.ux * px, before.gy + a.uy * px), button: 0, buttons: 0 })
  );
  await wait(250);
  out.boxKeptFocus = document.activeElement === document.querySelector('.pull-entry input');

  const input = document.querySelector('.pull-entry input');
  if (commit !== null && input) {
    input.value = String(commit);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(350);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(600);
    out.boxGoneAfterCommit = !document.querySelector('.pull-entry');
  }
  const b = dev.bodies[0];
  if (b) {
    const bb = b.solid.boundingBox();
    out.volume = Number(b.solid.volume().toFixed(1));
    out.zMin = Number(bb.min[2].toFixed(2));
    out.zMax = Number(bb.max[2].toFixed(2));
  }
  return out;
}

async function undo() {
  dev.runCommand('undo');
  await wait(600);
}

/* ---- a box, and its top face pulled each way ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(400);
document.getElementById('inspectorOk').click();
await wait(600);
dev.state.vp.fit(1.7);
await wait(300);
const rect = canvas.getBoundingClientRect();
const cx = rect.left + rect.width / 2;
const cy = rect.top + rect.height / 2;
report.boxVolume = Number(dev.bodies[0].solid.volume().toFixed(1));

await clickAt(cx, cy);
report.handleOnFace = !!dev.state.pullHandle;
report.faceOut = await pull(70, { commit: 8 });
await undo();

await clickAt(cx, cy);
report.faceIn = await pull(-70, { commit: -8 });
await undo();

// Out and in are the same size of change in opposite directions, which is the
// check that matters: one of them used to do nothing at all.
report.faceSymmetric =
  Math.abs(report.faceOut.volume - report.boxVolume) > 1 &&
  Math.abs(
    report.faceOut.volume - report.boxVolume + (report.faceIn.volume - report.boxVolume)
  ) < 1;

/* ---- a profile on the same body's top face, pulled each way ---- */
await clickAt(cx, cy);
dev.runCommand('newSketch');
await wait(900);
{
  const sk = dev.state.sketcher;
  const pc = async (x, y) => {
    const s = sk.planeToScreen(x, y);
    const r = canvas.getBoundingClientRect();
    await clickAt(r.left + s.x, r.top + s.y);
  };
  sk.setTool('rectangle');
  await pc(-6, -6);
  await pc(6, 6);
  sk.setTool('select');
}
dev.runCommand('finishSketch');
await wait(700);

// The view is square to the sketch now, so the arrow points at the camera.
// Grabbing it has to turn the view rather than refuse to move.
const pl = dev.state.result.sketchPlanes[Object.keys(dev.state.result.sketchPlanes)[0]];
const clickProfile = async () => {
  const w = dev.state.vp.worldToScreen(pl.origin[0], pl.origin[1], pl.origin[2]);
  await clickAt(w.clientX, w.clientY);
};
await clickProfile();
report.profileChosen = dev.state.selection.profiles.length;
report.viewWasSquareOn = (arrow()?.len ?? 0) < 25;

// The reverse first, because it is the one that used to do nothing, and the
// first click on a fresh sketch is the one that reliably lands on the profile.
report.profileIn = await pull(-70, { commit: 10 });
await undo();
await clickProfile();
report.profileChosenAgain = dev.state.selection.profiles.length;
report.profileOut = await pull(70, { commit: 10 });

// Pulled against the arrow, the material goes the other way: below the face it
// was drawn on rather than above it.
report.profileWentBothWays =
  report.profileIn.flip === true && report.profileIn.zMax <= 10.01;

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
