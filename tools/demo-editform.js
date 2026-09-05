/**
 * Batch 10, session two: Edit Form. The manipulator dragged for real, through
 * pointer events on the canvas, plus soft modification, live symmetry, pulling
 * a face out, and the selection helpers.
 *
 * Runs inside the page via --anvil-script.
 */

const FM = await import('./form.js');

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const canvas = document.getElementById('view');
const report = {};

function fire(type, at, extra = {}) {
  canvas.dispatchEvent(
    new PointerEvent(type, {
      clientX: at.x,
      clientY: at.y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      bubbles: true,
      cancelable: true,
      ...extra
    })
  );
}

async function fillDialog(values = {}) {
  await wait(250);
  for (const [label, value] of Object.entries(values)) {
    const row = [...document.querySelectorAll('#inspectorBody .field')].find((f) =>
      f.querySelector('label')?.textContent.trim().startsWith(label)
    );
    const input = row?.querySelector('input, select');
    if (!input) continue;
    if (input.type === 'checkbox') {
      input.checked = !!value;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (input.tagName === 'SELECT') {
      input.value = String(value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await wait(150);
  }
  document.getElementById('inspectorOk').click();
  await wait(600);
}

/** Set a live row of the Edit Form panel, which reads and writes as you go. */
async function setPanel(label, value) {
  const row = [...document.querySelectorAll('#inspectorBody .field')].find((f) =>
    f.querySelector('label')?.textContent.trim().startsWith(label)
  );
  const input = row?.querySelector('input, select');
  if (!input) return false;
  if (input.tagName === 'SELECT') {
    input.value = String(value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await wait(250);
  return true;
}

const forms = () => dev.state.result.bodies.filter((b) => b.form);
const errs = () => dev.state.result.errors.map((e) => e.message);
const cageOf = (b) => dev.state.doc.forms[b.form];
const ed = () => dev.state.editForm;

const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** Where a world point lands on screen, as the pointer events want it. */
const screenOf = (p) => {
  const s = dev.state.vp.worldToScreen(p[0], p[1], p[2]);
  return { x: s.clientX, y: s.clientY };
};
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

/**
 * Drag one of the manipulator's handles.
 *
 * The handle is found by projecting it onto the screen, and the pointer is
 * moved along the direction that handle's own axis projects to, so the drag
 * pulls along the axis rather than across it.
 */
async function dragHandle(kind, axis, amount) {
  const frame = dev.state.vp.gizmoFrame;
  if (!frame) return null;
  const size = dev.state.vp.pixelSize() * 95;
  const dir = [frame.x, frame.y, frame.z][axis];

  // Where to press: partway along the arrow, or on the ring for a turn.
  const grabAt =
    kind === 'rotate'
      ? add3(frame.origin, mul3([frame.x, frame.y, frame.z][(axis + 1) % 3], size * 0.62))
      : add3(frame.origin, mul3(dir, size * (kind === 'scale' ? 1.05 : 0.5)));

  const from = screenOf(grabAt);
  // Which way the axis runs on screen, so the drag goes along it.
  const ahead = screenOf(add3(grabAt, mul3(dir, size)));
  let vx = ahead.x - from.x;
  let vy = ahead.y - from.y;
  const l = Math.hypot(vx, vy) || 1;
  vx /= l;
  vy /= l;

  if (kind === 'rotate') {
    // Round the ring: at right angles to the radius the grab is on.
    const t = vx;
    vx = -vy;
    vy = t;
  }

  fire('pointerdown', from);
  await wait(60);
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    fire('pointermove', {
      x: from.x + vx * amount * (i / steps),
      y: from.y + vy * amount * (i / steps)
    });
    await wait(45);
  }
  fire('pointerup', { x: from.x + vx * amount, y: from.y + vy * amount });
  await wait(350);
  return { from, vx, vy };
}

/** The bounding box of a cage, for measuring what a drag did. */
function cageBox(cage) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of cage.points) {
    for (let d = 0; d < 3; d++) {
      lo[d] = Math.min(lo[d], p[d]);
      hi[d] = Math.max(hi[d], p[d]);
    }
  }
  return { lo: lo.map((v) => +v.toFixed(2)), hi: hi.map((v) => +v.toFixed(2)) };
}

try {

/* ---- 1. a quadball to shape ---- */

dev.setTab('form');
await wait(300);
dev.runCommand('formQuadball');
await fillDialog({ Radius: '25', 'Faces per side': '2', Display: 'control' });
report.made = forms().length;
report.startBox = cageBox(cageOf(forms()[0]));

/* ---- 2. enter Edit Form, and check the manipulator appears ---- */

dev.state.selection.bodies.clear();
dev.state.selection.bodies.add(forms()[0].id);
dev.runCommand('editForm');
await wait(400);
report.editing = !!ed();
report.panelRows = [...document.querySelectorAll('#inspectorBody .field label')].map((l) =>
  l.textContent.trim()
);
report.cageMarksDrawn = !!dev.state.vp.cageMarks?.visible;
report.gizmoBeforePick = !!dev.state.vp.gizmo?.visible;

/* ---- 3. pick a face by clicking it, and the manipulator arrives ---- */

{
  // Click the topmost cage face, found by projecting its middle to the screen.
  const cage = cageOf(forms()[0]);
  let best = null;
  cage.faces.forEach((face, i) => {
    let c = [0, 0, 0];
    for (const v of face) c = add3(c, cage.points[v]);
    c = mul3(c, 1 / face.length);
    if (!best || c[2] > best.c[2]) best = { i, c };
  });
  const at = screenOf(best.c);
  report.clickAt = { x: Math.round(at.x), y: Math.round(at.y) };
  report.canvasRect = (() => {
    const r = canvas.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })();
  report.rawPick = dev.state.vp.pickEntity(at.x, at.y, { edges: true });
  report.rawPick = report.rawPick
    ? { kind: report.rawPick.kind, bodyId: report.rawPick.bodyId, faceId: report.rawPick.faceId }
    : null;
  report.edBodyId = ed()?.bodyId;
  report.bodyIds = forms().map((b) => b.id);
  fire('pointermove', at);
  await wait(60);
  fire('pointerdown', at);
  fire('pointerup', at);
  await wait(400);
  report.pickedByClick = ed()?.vertices.size ?? 0;
  report.gizmoAfterPick = !!dev.state.vp.gizmo?.visible;
}

/* ---- 4. drag the up arrow, for real ---- */

{
  const before = cageBox(cageOf(forms()[0]));
  const picked = [...ed().vertices];
  const zBefore = picked.map((v) => cageOf(forms()[0]).points[v][2]);
  report.dragged = !!(await dragHandle('move', 2, 120));
  await wait(200);
  const after = cageBox(cageOf(forms()[0]));
  const zAfter = picked.map((v) => cageOf(forms()[0]).points[v][2]);
  report.movedUpBy = +(Math.max(...zAfter) - Math.max(...zBefore)).toFixed(2);
  report.boxGrew = after.hi[2] > before.hi[2];
  report.dragErrors = errs();
  // Only the picked points moved: the bottom of the ball stayed put.
  report.bottomHeld = Math.abs(after.lo[2] - before.lo[2]) < 0.01;
}

/* ---- 5. undo puts it back in one step, not one per frame ---- */

{
  const before = cageBox(cageOf(forms()[0]));
  dev.runCommand('undo');
  await wait(500);
  const after = cageBox(cageOf(forms()[0]));
  // One drag, one undo: the whole box is back where it started, not part way.
  report.undoneInOneStep =
    JSON.stringify(after) === JSON.stringify(report.startBox) &&
    JSON.stringify(before) !== JSON.stringify(report.startBox);
  report.afterUndo = after;
}

/* ---- 6. soft modification spreads the move ---- */

{
  await setPanel('Soft modification', 'distance');
  await setPanel('Reach', '30');
  report.softRows = [...document.querySelectorAll('#inspectorBody .field label')].map((l) =>
    l.textContent.trim()
  );
  const cage = cageOf(forms()[0]);
  const before = cage.points.map((p) => p[2]);
  await dragHandle('move', 2, 90);
  await wait(200);
  const after = cageOf(forms()[0]).points.map((p) => p[2]);
  let moved = 0;
  for (let i = 0; i < before.length; i++) if (Math.abs(after[i] - before[i]) > 0.01) moved++;
  report.softMoved = moved;
  report.softPicked = ed().vertices.size;
  report.softSpread = moved > ed().vertices.size;
  await setPanel('Soft modification', 'none');
}

/* ---- 7. the other handles: turn and scale ---- */

{
  // Everything picked, so a turn and a scale are visible in the box.
  dev.runCommand('formSelectAll');
  await wait(300);

  const before = cageBox(cageOf(forms()[0]));
  await setPanel('Transform mode', 'rotation');
  report.rotateGrabbed = !!(await dragHandle('rotate', 2, 90));
  await wait(200);
  const turned = cageBox(cageOf(forms()[0]));
  report.turnedBox = turned;
  // A turn about Z keeps the height and moves things round.
  report.turned =
    Math.abs(turned.hi[2] - before.hi[2]) < 0.5 &&
    (Math.abs(turned.hi[0] - before.hi[0]) > 0.3 || Math.abs(turned.lo[0] - before.lo[0]) > 0.3);

  await setPanel('Transform mode', 'scale');
  const beforeScale = cageBox(cageOf(forms()[0]));
  report.scaleGrabbed = !!(await dragHandle('scale', 0, 70));
  await wait(200);
  const afterScale = cageBox(cageOf(forms()[0]));
  report.scaleBefore = beforeScale.hi[0];
  report.scaleAfter = afterScale.hi[0];
  report.scaled = Math.abs(afterScale.hi[0] - beforeScale.hi[0]) > 0.5;
  await setPanel('Transform mode', 'multi');
}

/* ---- 8. the selection helpers ---- */

{
  // Back to one face: grow, shrink and invert all say nothing when everything
  // is already picked, which is what the block above leaves behind.
  {
    const cage = cageOf(forms()[0]);
    let top = null;
    cage.faces.forEach((face, i) => {
      let c = [0, 0, 0];
      for (const v of face) c = add3(c, cage.points[v]);
      c = mul3(c, 1 / face.length);
      if (!top || c[2] > top.c[2]) top = { i, c };
    });
    ed().vertices = new Set(cage.faces[top.i]);
    await wait(150);
  }

  const was = ed().vertices.size;
  dev.runCommand('formGrow');
  await wait(300);
  report.grew = ed().vertices.size > was;
  const grown = ed().vertices.size;
  dev.runCommand('formShrink');
  await wait(300);
  report.shrank = ed().vertices.size < grown;
  dev.runCommand('formInvert');
  await wait(300);
  report.inverted = ed().vertices.size > 0;
  dev.runCommand('formSelectAll');
  await wait(300);
  report.selectedAll = ed().vertices.size === cageOf(forms()[0]).points.length;
}

/* ---- 9. pull a face out, and drag the limb ---- */

dev.runCommand('editForm');
await wait(300);
report.leftEditing = !ed();

{
  // A fresh box, one face pulled out and dragged into a limb.
  dev.setTab('form');
  dev.runCommand('formBox');
  await fillDialog({ Width: '40', Depth: '40', Height: '40', X: '80', Display: 'control' });
  const box = forms()[forms().length - 1];
  dev.state.selection.bodies.clear();
  dev.state.selection.bodies.add(box.id);

  // The top face of that box.
  const rec = (dev.state.records || []).find((r) => r.id === box.id);
  const top = rec.topology.faces.find((f) => f.normal[2] > 0.99);
  dev.state.selection.faces.clear();
  dev.state.selection.faces.add(`${rec.id}:${top.id}`);

  dev.runCommand('editForm');
  await wait(400);
  report.pullPicked = ed()?.vertices.size ?? 0;

  const beforePull = cageOf(forms().find((b) => b.form === box.form)).faces.length;
  dev.runCommand('formPull');
  await wait(500);
  const pulled = forms().find((b) => b.form === box.form);
  report.pullMessage = document.getElementById('status').textContent;
  report.facesAfterPull = cageOf(pulled).faces.length;
  report.pullAddedWalls = cageOf(pulled).faces.length === beforePull + 4;
  report.pullSelection = ed().vertices.size;

  const before = cageBox(cageOf(pulled));
  await dragHandle('move', 2, 110);
  await wait(200);
  const after = cageBox(cageOf(forms().find((b) => b.form === box.form)));
  report.limbGrew = after.hi[2] > before.hi[2] + 2;
  report.limbHeight = +(after.hi[2] - before.hi[2]).toFixed(1);
}

/* ---- 10. live symmetry: drag one half, both move ---- */

{
  const box = forms().find((b) => b.form);
  dev.runCommand('editForm');
  await wait(300);
  dev.state.selection.bodies.clear();
  dev.state.selection.bodies.add(box.id);
  dev.runCommand('formMirror');
  await wait(500);
  report.symmetric = cageOf(forms().find((b) => b.id === box.id) || forms()[0])?.symmetry?.kind;

  const body = forms().find((b) => b.form === box.form) || forms()[0];
  dev.state.selection.bodies.clear();
  dev.state.selection.bodies.add(body.id);
  dev.runCommand('editForm');
  await wait(400);

  // One point well off the seam.
  const cage = cageOf(body);
  const v = cage.points.findIndex((p) => p[0] > cage.points[0][0] + 5);
  if (v >= 0 && ed()) {
    ed().vertices = new Set([v]);
    const twin = cage.points.findIndex(
      (p, i) =>
        i !== v &&
        Math.abs(p[1] - cage.points[v][1]) < 1e-4 &&
        Math.abs(p[2] - cage.points[v][2]) < 1e-4 &&
        Math.abs(p[0] - cage.points[v][0]) > 1e-4
    );
    report.twinFound = twin >= 0;
    if (twin >= 0) {
      const zBefore = cage.points[twin][2];
      // Refresh so the manipulator sits on the one point.
      dev.runCommand('formSelectAll');
      await wait(100);
      ed().vertices = new Set([v]);
      await wait(200);
      await dragHandle('move', 2, 80);
      await wait(200);
      const now = cageOf(forms().find((b) => b.form === box.form) || forms()[0]);
      report.twinMoved = Math.abs(now.points[twin][2] - zBefore) > 0.5;
      report.bothMovedSame =
        Math.abs(
          now.points[twin][2] - zBefore - (now.points[v][2] - cage.points[v][2])
        ) < 0.01;
    }
  }
  dev.runCommand('editForm');
  await wait(200);
}

/* ---- the picture ---- */

dev.setTab('form');
dev.state.selection.bodies.clear();
dev.state.vp.setSelection(dev.state.selection.bodies);
await wait(200);
dev.state.vp.setView([0.45, -1, 0.4], false, [0, 0, 1]);
dev.state.vp.fit(1.2);
dev.setStatus('Edit Form: a ball pulled about by its cage, and a box with a limb drawn out of it.');
await wait(500);
report.finalErrors = errs();
report.finalForms = forms().length;
void FM;
} catch (err) {
  report.threw = String(err && err.message);
  report.where = String(err && err.stack).split(/\n/).slice(0, 4).join(' | ');
}
return report;
