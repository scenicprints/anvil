/**
 * Drawing a chain without stopping: an arc swept out of the end of a line, and
 * a radius typed instead of aimed.
 *
 * Both come from a screenshot of Fusion mid-sketch: a line running into an arc,
 * all one unbroken green chain, with a length and an angle in boxes beside the
 * cursor. Anvil had the boxes on lines, rectangles and circles and nothing else,
 * and its tangent arc was a separate tool: stop, switch, click the end, click
 * the finish, switch back. Four actions where Fusion has one drag, and the
 * chain broken in the middle of it.
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
  await wait(200);
}
/** Press at one place, move, release at another: the gesture, not two clicks. */
async function dragFrom(x0, y0, x1, y1) {
  fire('pointermove', x0, y0, 0);
  await wait(40);
  fire('pointerdown', x0, y0, 1);
  await wait(60);
  for (let i = 1; i <= 5; i++) {
    fire('pointermove', x0 + ((x1 - x0) * i) / 5, y0 + ((y1 - y0) * i) / 5, 1);
    await wait(40);
  }
  fire('pointerup', x1, y1, 0);
  await wait(250);
}

/* ---- a sketch on XY ---- */
dev.setTab('solid');
document.querySelector('[data-cmd="newSketch"]').click();
await wait(200);
{
  const node = [...document.querySelectorAll('#tree .node')].find(
    (n) => n.textContent.trim() === 'XY plane'
  );
  if (!node) return { ...report, stuckAt: 'no XY plane in the browser' };
  node.click();
}
await wait(1000);
const sk = dev.state.sketcher;
if (!sk.active) return { ...report, stuckAt: 'the sketch did not open' };

const plane = (x, y) => {
  const s = sk.planeToScreen(x, y);
  const r = canvas.getBoundingClientRect();
  return [r.left + s.x, r.top + s.y];
};
const kinds = () => sk.sketch.entities.map((e) => e.type);

/* ---- a line, then an arc swept out of its end, then a line again ---- */
sk.setTool('line');
await clickAt(...plane(-30, 0));
await clickAt(...plane(-10, 0));
report.afterTwoClicks = kinds();
report.chainIsOpen = !!sk.pending;

{
  // Press on the end of the chain and drag away: that is the whole gesture.
  const from = plane(-10, 0);
  const to = plane(0, 10);
  await dragFrom(from[0], from[1], to[0], to[1]);
  report.afterTheDrag = kinds();
  report.sweptAnArc = kinds().filter((k) => k === 'arc').length === 1;
  // Tangent to the line it left, which is the point of doing it this way
  // rather than placing an arc that happens to touch.
  report.tangentConstraintAdded = sk.sketch.constraints.some((c) => c.type === 'tangent');
  // And still drawing lines, from where the arc finished.
  report.chainCarriedOn = !!sk.pending && sk.pending.tool === 'line';
}

await clickAt(...plane(20, 10));
report.afterOneMoreClick = kinds();
report.lineAfterArc = kinds().filter((k) => k === 'line').length === 2;

// A press that does not move must not become an arc, or every second click on
// the end of a chain would draw one.
{
  const before = kinds().length;
  const spot = plane(20, 10);
  fire('pointermove', spot[0], spot[1], 0);
  await wait(40);
  fire('pointerdown', spot[0], spot[1], 1);
  await wait(120);
  fire('pointerup', spot[0], spot[1], 0);
  await wait(250);
  report.stillPressMakesNoArc = kinds().length === before;
}

sk.setTool('select');
sk.pending = null;
await wait(300);

/* ---- an arc whose radius is typed rather than aimed ---- */
{
  sk.setTool('arc');
  await clickAt(...plane(0, -40));
  await wait(300);
  const box = document.querySelector('.sk-entry');
  report.arcHasEntryBoxes = !!box;
  report.arcFieldLabels = box
    ? [...box.querySelectorAll('.sk-entry-field span')].map((s) => s.textContent)
    : null;

  const radius = box?.querySelector('input[data-key="radius"]');
  report.foundTheRadiusBox = !!radius;
  if (radius) {
    radius.value = '15';
    radius.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(250);
  }
  // Second click sets the start point: the typed radius has to win over where
  // the click landed, which is the whole reason for typing it.
  await clickAt(...plane(40, -40));
  await clickAt(...plane(0, -25));
  await wait(400);

  const arc = sk.sketch.entities.filter((e) => e.type === 'arc').at(-1);
  const c = sk.sketch.points[arc.c];
  const s0 = sk.sketch.points[arc.p[0]];
  report.typedRadius = Number(Math.hypot(s0.x - c.x, s0.y - c.y).toFixed(2));
  report.radiusWasObeyed = Math.abs(report.typedRadius - 15) < 0.05;
  // The boxes come down once the radius is settled: what is left is how far
  // round it goes, and that is aimed.
  report.boxesGoneAfterRadius = !document.querySelector('.sk-entry');
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
