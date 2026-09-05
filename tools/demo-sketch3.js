/**
 * Batch 3 through the real interface: the slot and polygon variants, a three
 * point rectangle, a conic, a control point spline, and an SVG traced in and
 * extruded.
 *
 * The import is driven past its file dialog on purpose: the dialog belongs to
 * the main process and cannot be clicked from here, so the parse and the insert
 * are exercised directly and the dialog is checked separately.
 *
 * Runs inside the page via --anvil-script.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const canvas = document.getElementById('view');
const report = {};

function planePoint(x, y) {
  const s = dev.state.sketcher.planeToScreen(x, y);
  const rect = canvas.getBoundingClientRect();
  return { clientX: rect.left + s.x, clientY: rect.top + s.y };
}

function fire(type, at) {
  canvas.dispatchEvent(
    new PointerEvent(type, {
      ...at,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      bubbles: true,
      cancelable: true
    })
  );
}

async function clickPlane(x, y) {
  const at = planePoint(x, y);
  fire('pointermove', at);
  await wait(15);
  fire('pointerdown', at);
  fire('pointerup', at);
  await wait(30);
}

async function openSketchOn(nodeName) {
  document.querySelector('[data-cmd="newSketch"]').click();
  await wait(120);
  const node = [...document.querySelectorAll('#tree .node')].find(
    (n) => n.textContent.trim() === nodeName
  );
  if (!node) throw new Error(`no ${nodeName} in the browser`);
  node.click();
  await wait(600);
}

await openSketchOn('XY plane');
const sk = dev.state.sketcher;
const countRegions = () => {
  sk.refreshRegions();
  return sk.regions.length;
};

/* ---- the slot variants ---- */

sk.setTool('slotOverall');
await clickPlane(-52, 30);
await clickPlane(-30, 30);
await clickPlane(-41, 34);
report.overallSlot = countRegions();
// Overall clicks the far ends, so the centres are a radius in from each: the
// stadium is 14 long between centres, 4 of half width.
report.overallArea = Number(Math.abs(sk.regions[0].area).toFixed(2));
report.overallWanted = Number((14 * 8 + Math.PI * 16).toFixed(2));

sk.setTool('slotCentre');
await clickPlane(-12, 30);
await clickPlane(-2, 30);
await clickPlane(-12, 34);
report.centreSlot = countRegions();

const beforeArc = new Set(sk.regions.map((r) => r.id));
sk.setTool('slotArcCentre');
await clickPlane(20, 22);
await clickPlane(20, 34);
await clickPlane(32, 22);
await clickPlane(20, 37);
report.arcSlot = countRegions();
{
  // An arc slot is an annular sector plus a semicircular cap at each end:
  // 2 * sweep * r * half + pi * half^2. Here r = 12, half = 3, sweep = 90.
  // Found by which region it added, not by which area is nearest the answer.
  const added = sk.regions.filter((r) => !beforeArc.has(r.id));
  report.arcSlotArea = added.length
    ? Number(Math.abs(added[0].area).toFixed(2))
    : null;
  report.arcSlotWanted = Number(
    (2 * (Math.PI / 2) * 12 * 3 + Math.PI * 9).toFixed(2)
  );
}

/* ---- the polygon variants ---- */

// Set through the ribbon control, the way a person would.
{
  const box = document.getElementById('polySides');
  box.value = '8';
  box.dispatchEvent(new Event('change', { bubbles: true }));
}
report.sidesFromUI = sk.polygonSides;
sk.setTool('polygonCirc');
await clickPlane(-45, 5);
await clickPlane(-38.5, 5);
report.circumscribed = countRegions();

sk.setTool('polygonEdge');
await clickPlane(-25, 0);
await clickPlane(-17, 0);
report.edgePolygon = countRegions();

/* ---- a three point rectangle, at an angle ---- */

sk.setTool('rectangle3');
await clickPlane(0, 0);
await clickPlane(14, 6);
await clickPlane(11, 12);
report.rect3 = countRegions();

/* ---- a conic and a control point spline ---- */

sk.conicRho = 0.6;
sk.setTool('conic');
await clickPlane(30, 0);
await clickPlane(50, 0);
await clickPlane(40, 10);
report.conics = sk.sketch.entities.filter((e) => e.type === 'conic').length;

sk.setTool('splineCP');
await clickPlane(-52, -18);
await clickPlane(-40, -6);
await clickPlane(-26, -26);
await clickPlane(-12, -14);
sk.setTool('select');
// A sketch holding a spline, a point, a conic or a piece of text used to throw
// inside the snapper on the very next click, silently, because a pointer
// handler swallows what it throws. Anything drawn after one of those is the
// regression test.
const errorsSeen = [];
window.addEventListener('error', (e) => errorsSeen.push(e.message));
sk.setTool('point');
await clickPlane(-40, -30);
sk.setTool('select');
report.pointsAfterSpline = sk.sketch.entities.filter((e) => e.type === 'point').length;
report.snapErrors = errorsSeen;
report.bsplines = sk.sketch.entities.filter((e) => e.type === 'bspline').length;

/* ---- an SVG traced in ---- */

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="30mm" height="18mm" viewBox="0 0 30 18">' +
  '<path d="M 2 2 L 28 2 L 28 16 L 2 16 Z"/>' +
  '<circle cx="8" cy="9" r="3"/>' +
  '<circle cx="22" cy="9" r="3"/>' +
  '</svg>';
const mod = await import('./vectorimport.js');
const parsed = mod.parseSVG(svg);
report.svgShapes = parsed.entities.length;
report.svgSize = [Number(parsed.width.toFixed(2)), Number(parsed.height.toFixed(2))];
report.svgKinds = parsed.entities.map((e) => e.kind);

const made = sk.insertVector(parsed.entities, { scale: 1, x: 10, y: -22 });
report.svgCurves = made;
report.regionsAfterImport = countRegions();

// The dialog the button opens has to exist even though its file picker cannot
// be driven from in here.
report.insertMenu = (() => {
  const btn = document.querySelector('[data-menu="insert"]');
  if (!btn) return null;
  btn.click();
  const menu = document.getElementById('markmenu');
  const labels = menu ? [...menu.querySelectorAll('button')].map((b) => b.textContent) : null;
  document.getElementById('markmenu')?.remove();
  return labels;
})();

/* ---- extrude the lot ---- */

sk.refreshRegions();
for (const r of sk.regions) sk.selectedRegions.add(r.id);
dev.runCommand('finishSketch');
await wait(400);

dev.runCommand('extrude');
await wait(250);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no extrude dialog' };
  f.distance = '3';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(500);

report.solid = {
  bodies: dev.bodies.length,
  volume: Number(dev.bodies[0]?.solid.volume().toFixed(1)),
  genus: dev.bodies[0]?.solid.genus()
};

/* ---- the sketch ribbon still fits ---- */

dev.setTab('sketch');
await wait(200);
report.sketchRibbon = [...document.querySelectorAll('[data-panel="sketch"] .group')].map((g) => ({
  label: g.querySelector('.glabel')?.textContent,
  rows: new Set(
    [...g.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top))
  ).size
}));
report.ribbonHeight = Math.round(document.getElementById('ribbon').getBoundingClientRect().height);
dev.setTab('solid');
await wait(150);

// An extrude hides the sketch it consumed. Show it again so the open curves,
// the conic and the control point spline, are in the picture too.
dev.state.hiddenSketches.clear();
dev.rebuildAll();
await wait(200);

dev.state.vp.setView([0.3, -0.8, 0.5], false);
dev.state.vp.fit(1.4);
dev.setStatus('Slots, polygons, a conic, a control point spline and a traced SVG.');
await wait(400);
report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
