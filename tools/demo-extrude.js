/**
 * Extrude the other way round: from the ribbon, on an empty document.
 *
 * `demo-pull.js` covers the gesture that starts from a selection. This covers
 * the one that starts from the command, which is what somebody reaches for the
 * first time, and which was a dead end.
 *
 * The dialog opens with a distance of zero on purpose, so nothing appears
 * before a length is given. But there was nothing to give a length with. An
 * open dialog took the arrow away, and the value box belongs to a drag, so
 * there was no drag to have one. The profile got chosen, the callout said "1
 * chosen", and the screen never changed again. Typing into the dialog's own
 * distance field worked, and nothing on screen said that was the only thing
 * left that would.
 *
 * So: press the button, check it took the one profile on screen without being
 * asked, drag the arrow that appears, type the exact size over what was dragged
 * to, and check the solid measures what was asked for and that nothing is left
 * floating afterwards.
 *
 * The auto-selection is Fusion's, quoted from its Extrude reference: "When you
 * invoke the Extrude tool, and there is only one profile visible in your
 * design, it is automatically selected."
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
  await wait(40);
  fire('pointerdown', x, y, 1);
  await wait(40);
  fire('pointerup', x, y, 0);
  await wait(250);
}

const hidden = (id) => document.getElementById(id)?.classList.contains('hidden') !== false;
const onScreen = () => ({
  callout: !hidden('pickcallout'),
  calloutCount: document.getElementById('pcCount')?.textContent,
  dialog: !hidden('inspector'),
  valueBox: !!document.querySelector('.pull-entry')
});
const model = () => ({
  bodies: dev.bodies.length,
  volume: dev.bodies[0]?.solid ? Number(dev.bodies[0].solid.volume().toFixed(1)) : null,
  chosen: dev.state.editing?.feature?.seeds?.length ?? null,
  distance: dev.state.editing?.feature?.distance ?? null,
  errors: (dev.state.result?.errors || []).map((e) => e.message)
});

/** Where the arrow is on screen, and how long it is there. */
function arrow() {
  const f = dev.state.pullHandle?.frame;
  if (!f) return null;
  const ref = dev.state.vp.pixelSize() * 95;
  const o = dev.state.vp.worldToScreen(f.origin[0], f.origin[1], f.origin[2]);
  const tip = dev.state.vp.worldToScreen(
    f.origin[0] + f.z[0] * ref,
    f.origin[1] + f.z[1] * ref,
    f.origin[2] + f.z[2] * ref
  );
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

/* ---- a rectangle on the ground, from nothing ---- */
dev.setTab('solid');
document.querySelector('[data-cmd="newSketch"]').click();
await wait(200);
{
  // With no body on the table there is no face to sketch on, so it asks which
  // plane, the same as Fusion does.
  const node = [...document.querySelectorAll('#tree .node')].find(
    (n) => n.textContent.trim() === 'XY plane'
  );
  if (!node) return { ...report, stuckAt: 'no XY plane in the browser' };
  node.click();
}
await wait(1000);
report.sketchStarted = !!dev.state.sketcher.active;
if (!report.sketchStarted) return report;

const sk = dev.state.sketcher;
const plane = (x, y) => {
  const s = sk.planeToScreen(x, y);
  const r = canvas.getBoundingClientRect();
  return [r.left + s.x, r.top + s.y];
};
sk.setTool('rectangle');
await clickAt(...plane(-20, -12));
await clickAt(...plane(20, 12));
sk.setTool('select');
await wait(300);
document.querySelector('[data-cmd="finishSketch"]').click();
await wait(900);

/* ---- the ribbon button, with nothing chosen ---- */
document.querySelector('[data-cmd="extrude"]').click();
await wait(800);
report.afterButton = { ...onScreen(), ...model(), arrow: arrow()?.len ?? 0 };
// "When you invoke the Extrude tool, and there is only one profile visible in
// your design, it is automatically selected." Fusion's Extrude reference. There
// is one rectangle on screen, so the command should not be asking which of the
// one things it is, and the arrow should already be standing on it.
report.tookTheOnlyProfile =
  report.afterButton.dialog && report.afterButton.chosen === 1 && report.afterButton.arrow > 40;

/* ---- clicking it lets go, clicking again takes it back ---- */
const centre = dev.state.vp.worldToScreen(0, 0, 0);
await clickAt(centre.clientX, centre.clientY);
report.letGoAtOnce = dev.state.editing?.feature?.seeds?.length ?? null;
await clickAt(centre.clientX, centre.clientY);
await wait(500);
report.afterPointing = { ...onScreen(), ...model(), arrow: arrow()?.len ?? 0 };

// The callout follows the pointer, and the pointer is where the arrow has just
// stood up, so it covered the arrow completely. It passes clicks through, so
// the arrow could still be grabbed the whole time, which is worse rather than
// better: a panel saying "click the profiles to use", sitting on top of the one
// thing on screen that would have said what to do next.
{
  const f = dev.state.pullHandle?.frame;
  const box = document.getElementById('pickcallout')?.getBoundingClientRect();
  const ref = dev.state.vp.pixelSize() * 95;
  const a = f && dev.state.vp.worldToScreen(f.origin[0], f.origin[1], f.origin[2]);
  const b =
    f && dev.state.vp.worldToScreen(f.origin[0] + f.z[0] * ref, f.origin[1] + f.z[1] * ref, f.origin[2] + f.z[2] * ref);
  report.calloutClearsTheArrow =
    !!a &&
    !!b &&
    !!box &&
    (box.left > Math.max(a.clientX, b.clientX) ||
      box.right < Math.min(a.clientX, b.clientX) ||
      box.top > Math.max(a.clientY, b.clientY) ||
      box.bottom < Math.min(a.clientY, b.clientY));
}
// The arrow is the point. Chosen but with nothing to drag is where this dead
// ended: a dialog holding a zero and no way on screen to change it.
report.pointingStandsAnArrowUp = report.afterPointing.chosen === 1 && report.afterPointing.arrow > 40;

// A press on the arrow that never moved is a click on what is under it. Without
// that, the arrow covers the profile and it can be chosen but never let go of.
report.profileStillTogglesUnderTheArrow =
  report.letGoAtOnce === 0 && report.afterPointing.chosen === 1;

/* ---- drag the arrow, then type the size over what was dragged to ---- */
{
  const a = arrow();
  report.arrowToDrag = a?.len ?? 0;
  if (!a) return report;
  fire('pointermove', a.gx, a.gy, 0);
  await wait(60);
  fire('pointerdown', a.gx, a.gy, 1);
  await wait(200);
  report.pressStartedADrag = !!dev.state.pullDrag;
  for (let i = 1; i <= 6; i++) {
    fire('pointermove', a.gx + a.ux * 10 * i, a.gy + a.uy * 10 * i, 1);
    await wait(60);
  }
  report.whileDragging = { ...onScreen(), ...model(), typed: document.querySelector('.pull-entry input')?.value };
  // The body is there while the drag is happening, at the size the box says.
  report.bodyFollowsTheDrag =
    report.whileDragging.bodies === 1 &&
    report.whileDragging.valueBox &&
    Number(report.whileDragging.typed) > 1;

  fire('pointerup', a.gx + a.ux * 60, a.gy + a.uy * 60, 0);
  await wait(300);
  report.boxTookFocus = document.activeElement === document.querySelector('.pull-entry input');

  const input = document.querySelector('.pull-entry input');
  input.value = '12';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(400);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await wait(900);
}

report.atTheEnd = { ...onScreen(), ...model() };
// 40 by 24 by 12.
report.exactlyWhatWasTyped = Math.abs(report.atTheEnd.volume - 11520) < 1;
// The callout belongs to the dialog. OK used to leave it behind, so it hung by
// the pointer saying EXTRUDE with nothing behind it for the rest of the session.
report.nothingLeftOnScreen =
  !report.atTheEnd.callout && !report.atTheEnd.dialog && !report.atTheEnd.valueBox;
report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
