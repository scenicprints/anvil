/**
 * Pulling straight off the selection.
 *
 * Click a face, drag the arrow that appears, watch the body follow, then type
 * the exact number over the one you dragged to. The same gesture on a sketch
 * profile extrudes it. This is the path that used to be a command, a second
 * pick of the thing already pointed at, and a dialog.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const canvas = document.getElementById('view');
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

function at(cx, cy) {
  return { clientX: cx, clientY: cy, pointerId: 1, bubbles: true, cancelable: true };
}
async function clickAt(cx, cy) {
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at(cx, cy), button: 0, buttons: 1 }));
  await wait(40);
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...at(cx, cy), button: 0, buttons: 0 }));
  await wait(150);
}
/** The arrow shaft on screen, which is where a pull is grabbed. */
function handlePoint() {
  const f = dev.state.pullHandle?.frame;
  if (!f) return null;
  // The gizmo is drawn at a constant size on screen, ninety five pixels for
  // its unit length, so the shaft's middle is about half of that out.
  const size = dev.state.vp.pixelSize() * 95;
  const p = [0, 1, 2].map((i) => f.origin[i] + f.z[i] * 0.45 * size);
  const s = dev.state.vp.worldToScreen(p[0], p[1], p[2]);
  return s && !s.behind ? s : null;
}

/* ---- a box to pull on ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(400);
document.getElementById('inspectorOk').click();
await wait(600);
dev.state.vp.fit(1.7);
await wait(300);
report.startVolume = Number(dev.bodies[0].solid.volume().toFixed(1));

/* ---- click the top face ---- */
const rect = canvas.getBoundingClientRect();
const cx = rect.left + rect.width / 2;
const cy = rect.top + rect.height / 2;
// Straight at the middle of the body, which lands on a face rather than
// through the gap above it.
await clickAt(cx, cy);
report.selectedFaces = dev.state.selection.faces.size;
report.selectedEdges = dev.state.selection.edges.size;
report.handleAppeared = !!dev.state.pullHandle;
report.handleKind = dev.state.pullHandle?.kind ?? null;

/* ---- grab the arrow and drag it ---- */
const grab = handlePoint();
report.foundArrow = !!grab;
if (grab) {
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at(grab.clientX, grab.clientY), button: 0, buttons: 1 }));
  await wait(120);
  report.startedDrag = !!dev.state.pullDrag;
  report.dialogTitle = document.getElementById('inspectorTitle')?.textContent;

  for (let i = 1; i <= 6; i++) {
    canvas.dispatchEvent(
      new PointerEvent('pointermove', { ...at(grab.clientX, grab.clientY - i * 9), buttons: 1 })
    );
    await wait(70);
  }
  report.valueBoxShowing = !!document.querySelector('.pull-entry');
  report.valueWhileDragging = document.querySelector('.pull-entry input')?.value;
  report.volumeWhileDragging = Number(dev.bodies[0].solid.volume().toFixed(1));
  report.grewWhileDragging = report.volumeWhileDragging > report.startVolume;

  canvas.dispatchEvent(new PointerEvent('pointerup', { ...at(grab.clientX, grab.clientY - 54), button: 0, buttons: 0 }));
  await wait(200);
  report.boxStaysAfterRelease = !!document.querySelector('.pull-entry');
  report.boxFocused = document.activeElement === document.querySelector('.pull-entry input');
}

/* ---- type the exact number over what was dragged ---- */
{
  const input = document.querySelector('.pull-entry input');
  if (input) {
    input.value = '12';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
await wait(400);
report.afterTyping = {
  distance: dev.state.editing?.feature?.distance,
  volume: Number(dev.bodies[0].solid.volume().toFixed(1))
};

/* ---- Enter commits ---- */
{
  const input = document.querySelector('.pull-entry input');
  input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}
await wait(600);
report.committed = {
  dialogClosed: document.getElementById('inspector')?.classList.contains('hidden'),
  boxGone: !document.querySelector('.pull-entry'),
  features: dev.state.doc.features.map((f) => f.type),
  volume: Number(dev.bodies[0].solid.volume().toFixed(1))
};

/* ---- and the same gesture on a sketch profile, which extrudes ---- */
{
  dev.runCommand('newSketch');
  await wait(200);
  [...document.querySelectorAll('#tree .node')]
    .find((n) => n.textContent.trim() === 'XY plane')?.click();
  await wait(900);

  const sk = dev.state.sketcher;
  const planeClick = async (x, y) => {
    const s = sk.planeToScreen(x, y);
    const r = canvas.getBoundingClientRect();
    await clickAt(r.left + s.x, r.top + s.y);
  };
  sk.setTool('rectangle');
  await planeClick(40, 40);
  await planeClick(70, 60);
  sk.setTool('select');
  dev.runCommand('finishSketch');
  await wait(600);
  dev.state.vp.fit(1.7);
  await wait(300);

  // Click the profile itself, the way you would look at it and click it.
  const s = dev.state.result.sketchPlanes;
  const mid = dev.state.sketcher.active ? null : { x: 55, y: 50 };
  const plane = s[Object.keys(s)[0]];
  const w = dev.state.vp.worldToScreen(
    plane.origin[0] + plane.x[0] * mid.x + plane.y[0] * mid.y,
    plane.origin[1] + plane.x[1] * mid.x + plane.y[1] * mid.y,
    plane.origin[2] + plane.x[2] * mid.x + plane.y[2] * mid.y
  );
  await clickAt(w.clientX, w.clientY);
  report.profile = {
    chosen: dev.state.selection.profiles.length,
    handle: !!dev.state.pullHandle,
    kind: dev.state.pullHandle?.kind ?? null
  };

  const g = handlePoint();
  report.profile.foundArrow = !!g;
  if (g) {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at(g.clientX, g.clientY), button: 0, buttons: 1 }));
    await wait(120);
    report.profile.dialogTitle = document.getElementById('inspectorTitle')?.textContent;
    for (let i = 1; i <= 5; i++) {
      canvas.dispatchEvent(new PointerEvent('pointermove', { ...at(g.clientX, g.clientY - i * 10), buttons: 1 }));
      await wait(70);
    }
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...at(g.clientX, g.clientY - 50), button: 0, buttons: 0 }));
    await wait(200);
    const input = document.querySelector('.pull-entry input');
    if (input) {
      input.value = '9';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(300);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    await wait(700);
    report.profile.after = {
      features: dev.state.doc.features.map((f) => f.type),
      bodies: dev.bodies.length,
      errors: dev.state.result.errors.map((e) => e.message)
    };
  }
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
