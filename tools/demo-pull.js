/**
 * Pulling straight off the selection, both ways.
 *
 * Click a face, drag the arrow that appears, watch the body follow, then type
 * the exact number over the one you dragged to. The same gesture on a sketch
 * profile extrudes it. Both have to work in both directions, which is the part
 * that was wrong first: an extrude has no negative length, it is a length one
 * way and a flag that turns it round.
 *
 * This drives real pointer events at real screen positions and measures what
 * came back, rather than calling the functions behind the gesture. That
 * distinction is the whole reason the file is written this way. An earlier
 * version of it pressed buttons with `element.click()`, which dispatches no
 * pointer events at all, and while it passed every run three separate things
 * were broken in the app: a face in the middle of a part could not be picked,
 * the arrow came up as a zero-length dot after finishing a sketch, and the
 * value box stayed on screen for the rest of the session once the feature it
 * belonged to was gone. None of the three is visible from inside. All three are
 * obvious from out here.
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
const fire = (type, cx, cy, buttons) =>
  canvas.dispatchEvent(new PointerEvent(type, { ...at(cx, cy), button: 0, buttons }));

/** A click where a person would make one: hover first, then press and let go. */
async function clickAt(cx, cy) {
  fire('pointermove', cx, cy, 0);
  await wait(40);
  fire('pointerdown', cx, cy, 1);
  await wait(40);
  fire('pointerup', cx, cy, 0);
  await wait(200);
}

const screen = (p) => dev.state.vp.worldToScreen(p[0], p[1], p[2]);

/** Where the arrow sits on screen, and which way it runs there. */
function arrow() {
  const f = dev.state.pullHandle?.frame;
  if (!f) return null;
  const size = dev.state.vp.pixelSize() * 95;
  const o = screen(f.origin);
  const tip = screen([
    f.origin[0] + f.z[0] * size,
    f.origin[1] + f.z[1] * size,
    f.origin[2] + f.z[2] * size
  ]);
  if (!o || !tip || o.behind || tip.behind) return null;
  const dx = tip.clientX - o.clientX;
  const dy = tip.clientY - o.clientY;
  const len = Math.hypot(dx, dy);
  return {
    gx: o.clientX + dx * 0.45,
    gy: o.clientY + dy * 0.45,
    ux: dx / (len || 1),
    uy: dy / (len || 1),
    len: Number(len.toFixed(1))
  };
}

const valueBox = () => document.querySelector('.pull-entry input');

/** Everything the pull interaction could have left on screen, or not. */
const leftOnScreen = () =>
  [...document.querySelectorAll('.sk-entry, .pull-entry, .sk-hint, #hint')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => el.className || el.id);

/**
 * Drag the arrow `px` pixels along itself, or against itself when negative.
 *
 * The direction is asked again after the press, because grabbing an arrow that
 * points at the camera turns the view so there is something to drag along.
 */
async function pull(px, { commit = null } = {}) {
  const before = arrow();
  if (!before) return { grabbed: false };
  // How long the arrow is on screen before it is pressed. This is the number
  // that says whether there is anything to aim at: an arrow pointing straight
  // at the eye is a dot, and no drag along a dot moves anything.
  const out = { arrowLength: before.len };
  fire('pointermove', before.gx, before.gy, 0);
  await wait(60);
  fire('pointerdown', before.gx, before.gy, 1);
  await wait(150);
  if (!dev.state.pullDrag) return { ...out, grabbed: false, missedArrow: true };
  const a = arrow() || before;
  out.grabbed = true;

  for (let i = 1; i <= 5; i++) {
    const k = (px * i) / 5;
    fire('pointermove', before.gx + a.ux * k, before.gy + a.uy * k, 1);
    await wait(80);
  }
  out.valueBox = valueBox()?.value;
  out.distance = dev.state.editing?.feature?.distance;
  out.flip = dev.state.editing?.feature?.flip;
  out.errors = dev.state.result.errors.map((e) => e.message);

  fire('pointerup', before.gx + a.ux * px, before.gy + a.uy * px, 0);
  await wait(250);
  out.boxKeptFocus = document.activeElement === valueBox();

  const input = valueBox();
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

/** Escape, meaning let go of whatever is chosen and take its arrow away. */
async function dropSelection() {
  document.body.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(150);
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
const top = Number(dev.bodies[0].solid.boundingBox().max[2].toFixed(3));

/*
 * Every part of the top face picks that face.
 *
 * The ray carries on through the solid, and every edge on the far side of the
 * box lies somewhere along it. Taken without asking how far away they are, one
 * of those hidden edges wins over the face in front of it, so clicking the
 * middle of a face selects something behind the part and stands no arrow up.
 * That is what "extruding doesn't work at all" looked like from the outside.
 */
report.acrossTheFace = [];
for (const [x, y] of [[0, 0], [-9, -9], [9, -9], [9, 9], [-9, 9], [0, -6], [6, 0]]) {
  // Let go of the last one first. Otherwise its arrow is standing on the face,
  // and half of these points land on the arrow rather than on the face under
  // it, which is the arrow doing its job and tells us nothing about picking.
  await dropSelection();
  const s = screen([x, y, top]);
  await clickAt(s.clientX, s.clientY);
  report.acrossTheFace.push({
    at: [x, y],
    faces: dev.state.selection.faces.size,
    edges: dev.state.selection.edges.size,
    arrow: arrow()?.len ?? 0
  });
}
report.everyPointPickedTheFace = report.acrossTheFace.every(
  (p) => p.faces === 1 && p.edges === 0 && p.arrow > 40
);

await dropSelection();
await clickAt(cx, cy);
report.handleOnFace = !!dev.state.pullHandle;
report.faceOut = await pull(70, { commit: 8 });
await undo();

await dropSelection();
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

/* ---- typing the size without dragging at all ---- */
// The box used to exist only during a drag, so the only way to give a size was
// to drag out a wrong one and type over it. The number is usually already
// known, and typing it is quicker than dragging to it. Nothing on screen said
// the arrow could be typed at, because there was nothing on screen to type in.
await dropSelection();
await clickAt(cx, cy);
{
  const input = document.querySelector('.pull-entry input');
  report.boxIsThereBeforeAnyDrag = !!input;
  if (input) {
    input.focus();
    input.value = '5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(500);
    report.typedWithoutDragging = {
      volume: Number(dev.bodies[0].solid.volume().toFixed(1)),
      zMax: Number(dev.bodies[0].solid.boundingBox().max[2].toFixed(2))
    };
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(700);
  }
  report.afterTyping = {
    volume: Number(dev.bodies[0].solid.volume().toFixed(1)),
    onScreen: leftOnScreen()
  };
  // 30 by 30 by 25.
  report.typingAloneBuiltIt = Math.abs(report.afterTyping.volume - 22500) < 1;
}
await undo();

/* ---- an edge pulls a fillet, which is the third thing Press Pull routes ---- */
// A profile opens Extrude and a face opens Offset Face, and both already
// worked. Clicking an edge used to do nothing at all.
await dropSelection();
{
  const mid = dev.state.vp.worldToScreen(15, 0, 10);
  await clickAt(mid.clientX, mid.clientY);
  report.edgePick = {
    edges: dev.state.selection.edges.size,
    faces: dev.state.selection.faces.size,
    arrow: arrow()?.len ?? 0,
    box: !!valueBox()
  };
  const input = valueBox();
  if (input) {
    input.focus();
    input.value = '3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(600);
    report.filletWhileTyping = {
      title: document.getElementById('inspectorTitle')?.textContent,
      radius: dev.state.editing?.feature?.sets?.[0]?.radius,
      volume: Number(dev.bodies[0].solid.volume().toFixed(1))
    };
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(800);
  }
  const after = Number(dev.bodies[0].solid.volume().toFixed(1));
  // A 3 mm round along a 30 mm square corner takes r^2(1 - pi/4) off per unit
  // of length, so about 58 mm^3 off an 18000 box.
  const expected = 18000 - 30 * 9 * (1 - Math.PI / 4);
  report.edgeFillet = { volume: after, expected: Number(expected.toFixed(1)) };
  report.edgeRoundedTheCorner = Math.abs(after - expected) < expected * 0.02;
}
await undo();

/* ---- escaping out of a pull leaves nothing behind ---- */
await dropSelection();
await clickAt(cx, cy);
{
  const a = arrow();
  report.escapeHadAnArrow = !!a;
  if (!a) return report;
  fire('pointermove', a.gx, a.gy, 0);
  await wait(60);
  fire('pointerdown', a.gx, a.gy, 1);
  await wait(150);
  for (let i = 1; i <= 5; i++) {
    fire('pointermove', a.gx + a.ux * 12 * i, a.gy + a.uy * 12 * i, 1);
    await wait(60);
  }
  fire('pointerup', a.gx + a.ux * 60, a.gy + a.uy * 60, 0);
  await wait(300);
  report.beforeEscape = { box: !!valueBox(), focused: document.activeElement === valueBox() };

  // The box is left focused on purpose, so the exact size can be typed over the
  // one that was dragged to. That puts Escape inside a text box rather than on
  // the model, and merely blurring it leaves the extrude open and the box
  // floating beside the pointer for the rest of the session.
  document.activeElement.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  await wait(500);
  report.afterEscape = {
    editorOpen: !!dev.state.editing,
    boxStillThere: !!document.querySelector('.pull-entry'),
    onScreen: leftOnScreen(),
    volume: Number(dev.bodies[0].solid.volume().toFixed(1))
  };
  report.escapeLeftNothing =
    !report.afterEscape.editorOpen &&
    !report.afterEscape.boxStillThere &&
    report.afterEscape.onScreen.length === 0 &&
    Math.abs(report.afterEscape.volume - report.boxVolume) < 1;
}

/* ---- a profile on the same body's top face, pulled each way ---- */
await dropSelection();
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

// The view is square to the sketch now, so the arrow would point straight at
// the camera. Picking the profile has to turn the view rather than stand up a
// dot, and it has to turn on the way in, before anything is pressed, so that
// what gets pressed is what was being looked at.
const pl = dev.state.result.sketchPlanes[Object.keys(dev.state.result.sketchPlanes)[0]];
const clickProfile = async () => {
  const w = screen(pl.origin);
  await clickAt(w.clientX, w.clientY);
};
await clickProfile();
report.profileChosen = dev.state.selection.profiles.length;
report.arrowOnAFreshProfile = arrow()?.len ?? 0;
report.freshProfileHasAnArrowToAimAt = report.arrowOnAFreshProfile > 40;

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
