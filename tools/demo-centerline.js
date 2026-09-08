/**
 * Centreline, which the inventory said was there and was not.
 *
 * Fusion's centreline is a construction line that also says what the part is
 * about: it draws differently, a revolve reaches for it without being asked,
 * and a mirror offers it first. Anvil had construction geometry and nothing
 * that meant any of that, so every revolve opened on the sketch Y axis and had
 * to be corrected by hand even when the sketch said plainly what it turned
 * about.
 *
 * So: draw a section beside an axis, mark the axis, check it is construction
 * geometry underneath rather than a wall of the profile, and check the revolve
 * that follows opens already turning about it.
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
if (!dev.state.sketcher.active) return { ...report, stuckAt: 'the sketch did not open' };

const sk = dev.state.sketcher;
const plane = (x, y) => {
  const s = sk.planeToScreen(x, y);
  const r = canvas.getBoundingClientRect();
  return [r.left + s.x, r.top + s.y];
};

/* ---- a section standing off to one side ---- */
sk.setTool('rectangle');
await clickAt(...plane(10, 0));
await clickAt(...plane(14, 3));
sk.setTool('select');
await wait(300);
report.profilesBefore = Object.values(dev.state.result?.sketchRegions || {}).flat().length;

/* ---- the button puts the sketch into centreline mode ---- */
const btn = document.querySelector('[data-cmd="centerline"]');
report.buttonIsThere = !!btn;
if (!btn) return report;
btn.click();
await wait(200);
report.modeIsOn = !!sk.centerlineMode;
// Construction and centreline are two different modes, and being in one means
// not being in the other. Leaving both on would draw a line that is neither.
report.constructionModeIsOff = !sk.constructionMode;

/* ---- draw it down the Y axis, beside the section ---- */
sk.setTool('line');
await clickAt(...plane(0, -5));
await clickAt(...plane(0, 8));
sk.setTool('select');
sk.centerlineMode = false;
await wait(500);

{
  const lines = sk.sketch.entities.filter((e) => e.type === 'line');
  const marked = lines.filter((e) => e.centerline);
  report.centerlinesDrawn = marked.length;
  // Construction underneath, or it closes the profile it was drawn beside.
  report.centerlineIsConstruction = marked.every((e) => e.construction);
}

document.querySelector('[data-cmd="finishSketch"]').click();
await wait(900);

// The rectangle is still one region and the centreline has not carved it or
// made a second one of its own.
report.profilesAfter = Object.values(dev.state.result?.sketchRegions || {}).flat().length;
report.centerlineDidNotCutTheProfile =
  report.profilesAfter === report.profilesBefore && report.profilesAfter === 1;

/* ---- and the revolve that follows already turns about it ---- */
document.querySelector('[data-cmd="revolve"]').click();
await wait(800);
{
  const f = dev.state.editing?.feature;
  report.revolveOpened = !!f;
  report.revolveAxis = f?.axis ?? null;
  const row = [...document.querySelectorAll('#inspectorBody .field')].find((r) =>
    r.textContent.includes('Axis')
  );
  report.axisRowSays = row?.querySelector('.picksummary')?.textContent ?? null;
  // Was the sketch Y axis every time, which for a section drawn ten out from
  // the origin is the wrong answer and had to be corrected by hand.
  report.revolveTookTheCentreline =
    f?.axis?.type === 'entity' && report.axisRowSays === 'The sketch centreline';
}

document.getElementById('inspectorOk').click();
await wait(1200);
report.bodies = dev.bodies.length;
report.volume = dev.bodies[0]?.solid ? Number(dev.bodies[0].solid.volume().toFixed(0)) : null;
// Pappus again: area 12, centroid 12 out from the centreline.
report.sweptTheRing = Math.abs(report.volume - 4 * 3 * 2 * Math.PI * 12) < 40;
report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
