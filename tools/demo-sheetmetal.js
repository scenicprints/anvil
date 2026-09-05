/**
 * Batch 8, sheet metal: the rule, a base flange, flanges off its edges, a fold,
 * unfold and refold, corner relief, a contour flange, a flat pattern and the
 * DXF that comes off it, all through the interface.
 *
 * Runs inside the page via --anvil-script.
 */

const [SM, VEC] = await Promise.all([
  import('./sheetmetal.js'),
  import('./vectorimport.js')
]);

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
  if (dev.state.sketcher.active) {
    dev.runCommand('finishSketch');
    await wait(250);
  }
  dev.state.selection.bodies.clear();
  dev.state.selection.faces.clear();
  dev.state.selection.edges.clear();
  dev.setTab('solid');
  await wait(120);
  dev.runCommand('newSketch');
  await wait(200);
  const node = [...document.querySelectorAll('#tree .node')].find(
    (n) => n.textContent.trim() === nodeName
  );
  if (!node) throw new Error(`no ${nodeName} in the browser`);
  node.click();
  await wait(600);
}

async function chooseSketch(name) {
  const node = [...document.querySelectorAll('#tree .node')].find((n) =>
    n.textContent.trim().startsWith(name)
  );
  if (!node) {
    const all = [...document.querySelectorAll('#tree .node')].map((n) => n.textContent.trim());
    throw new Error(`no ${name} in the browser; there is ${all.join(' / ')}`);
  }
  node.click();
  await wait(250);
}

/** Set the dialog's fields by label, then accept it. */
async function fillDialog(values = {}) {
  await wait(200);
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
    await wait(120);
  }
  document.getElementById('inspectorOk').click();
  await wait(500);
}

const parts = () => dev.state.result.bodies.filter((b) => b.sheetMetal);
const flats = () => dev.state.result.bodies.filter((b) => b.outline);
const errs = () => dev.state.result.errors.map((e) => e.message);
const only = (list) => {
  dev.state.selection.bodies.clear();
  for (const b of list) dev.state.selection.bodies.add(b.id);
};
const vol = (b) => Math.round(b.solid.volume());
const bbox = (b) => {
  const t = b.solid.boundingBox();
  return [t.min.map((v) => +v.toFixed(1)), t.max.map((v) => +v.toFixed(1))];
};

/* ---- 1. the tab, and the rule ---- */

dev.setTab('sheet');
await wait(300);
{
  const panel = document.querySelector('[data-panel="sheet"]');
  report.sheetTabShows = panel?.classList.contains('active') || false;
  report.sheetButtons = [...panel.querySelectorAll('button[data-cmd]')].map(
    (b) => b.dataset.cmd
  );
  report.groupHeights = [...panel.querySelectorAll('.group')].map((g) =>
    Math.round(g.getBoundingClientRect().height)
  );
  report.ribbonHeight = Math.round(
    document.getElementById('ribbon').getBoundingClientRect().height
  );
}

dev.runCommand('smRule');
await fillDialog({ Thickness: '2', 'Bend radius': '2', 'K factor': '0.44' });
report.rule = {
  thickness: dev.state.doc.sheetMetalRule.thickness,
  bendRadius: dev.state.doc.sheetMetalRule.bendRadius,
  kFactor: dev.state.doc.sheetMetalRule.kFactor
};

/* ---- 2. a base flange from a rectangle ---- */

await openSketchOn('XY plane');
{
  const sk = dev.state.sketcher;
  sk.setTool('rectangle');
  await clickPlane(0, 0);
  await clickPlane(80, 50);
  sk.setTool('select');
}
dev.runCommand('finishSketch');
await wait(300);

await chooseSketch('Sketch 1');
dev.setTab('sheet');
dev.runCommand('baseFlange');
await fillDialog();
report.baseErrors = errs();
report.afterBase = { parts: parts().length };
if (parts().length) {
  report.plateVolume = vol(parts()[0]);
  report.plateWanted = 80 * 50 * 2;
}

/* ---- 3. a flange off two opposite edges ---- */

{
  const part = parts()[0];
  const rec = (dev.state.records || []).find((r) => r.id === part.id);
  // Two adjoining top edges, so the flanges meet at a corner and there is
  // something for corner relief to do.
  const top = rec.topology.edges.filter((e) => {
    const a = e.points[0];
    const b = e.points[e.points.length - 1];
    return Math.abs(a[2] - 2) < 0.01 && Math.abs(b[2] - 2) < 0.01;
  });
  const atX80 = top.find((e) =>
    e.points.every((p) => Math.abs(p[0] - 80) < 0.01)
  );
  const atY50 = top.find((e) =>
    e.points.every((p) => Math.abs(p[1] - 50) < 0.01)
  );
  const along = [atX80, atY50].filter(Boolean);
  report.edgeCandidates = along.length;

  dev.state.selection.edges.clear();
  for (const e of along) dev.state.selection.edges.add(`${rec.id}:${e.id}`);
  only([part]);

  dev.runCommand('flange');
  await fillDialog({ Height: '25', Angle: '90', 'Bend position': 'inside' });
  report.flangeErrors = errs();
  dev.state.selection.edges.clear();
}
if (parts().length) {
  report.afterFlange = { volume: vol(parts()[0]), box: bbox(parts()[0]) };
}

/* ---- 4. corner relief where the two bends meet ---- */

only([parts()[0]]);
dev.runCommand('cornerRelief');
await fillDialog();
report.cornerReliefMessage = document.getElementById('status').textContent;

/* ---- 5. unfold, then refold ---- */

only([parts()[0]]);
dev.runCommand('unfold');
await fillDialog();
report.unfoldErrors = errs();
report.unfoldedBox = parts().length ? bbox(parts()[0]) : null;

only([parts()[0]]);
dev.runCommand('refold');
await fillDialog();
report.refoldErrors = errs();
report.refoldedBox = parts().length ? bbox(parts()[0]) : null;

/* ---- 6. the flat pattern, and the DXF off it ---- */

only([parts()[0]]);
dev.runCommand('flatPattern');
await fillDialog();
report.flatErrors = errs();
report.flatCount = flats().length;
if (flats().length) {
  const f = flats()[0];
  report.flatBox = bbox(f);
  report.flatVolume = vol(f);
  report.outlinePanels = f.outline.panels.length;
  report.outlineBendLines = f.outline.bendLines.length;

  // The DXF itself, checked by reading it back with the app's own reader.
  const text = SM.flatToDXF(f.outline);
  report.dxfBytes = text.length;
  const back = VEC.parseDXF(text).entities;
  report.dxfEntities = back.length;
  report.dxfClosed = back.filter((e) => e.kind === 'poly' && e.closed).length;
  const xs = back.flatMap((e) => e.points.map((p) => p.x));
  report.dxfSpan = +(Math.max(...xs) - Math.min(...xs)).toFixed(2);
}

/* ---- 7. a contour flange: a channel from its own section ---- */

await openSketchOn('XZ plane');
{
  const sk = dev.state.sketcher;
  sk.setTool('line');
  await clickPlane(-100, 30);
  await clickPlane(-100, 0);
  await clickPlane(-60, 0);
  await clickPlane(-60, 30);
  sk.setTool('select');
  report.sectionEntities = sk.sketch.entities.length;
}
dev.runCommand('finishSketch');
await wait(300);
await chooseSketch('Sketch 2');
dev.setTab('sheet');
dev.runCommand('contourFlange');
await fillDialog({ Width: '40' });
report.contourErrors = errs();
report.afterContour = { parts: parts().length };

/* ---- 8. and a fold on a fresh plate ---- */

await openSketchOn('XY plane');
{
  const sk = dev.state.sketcher;
  sk.setTool('rectangle');
  await clickPlane(0, -90);
  await clickPlane(70, -50);
  sk.setTool('select');
}
dev.runCommand('finishSketch');
await wait(300);
await chooseSketch('Sketch 3');
dev.setTab('sheet');
dev.runCommand('baseFlange');
await fillDialog();

const foldTarget = parts()[parts().length - 1];
await openSketchOn('XY plane');
{
  const sk = dev.state.sketcher;
  sk.setTool('line');
  await clickPlane(45, -95);
  await clickPlane(45, -45);
  sk.setTool('select');
}
dev.runCommand('finishSketch');
await wait(300);
await chooseSketch('Sketch 4');
dev.setTab('sheet');
only([foldTarget]);
dev.runCommand('sheetFold');
await fillDialog({ 'Bend angle': '90', 'Bend line position': 'center' });
report.foldErrors = errs();
{
  const p = dev.state.result.bodies.find((b) => b.id === foldTarget.id);
  report.foldedPanels = p?.sheetMetal?.panels.length ?? 0;
  report.foldedBox = p ? bbox(p) : null;
}

/* ---- the picture ---- */

dev.state.hiddenSketches.clear();
only([]);
dev.state.vp.setSelection(dev.state.selection.bodies);
await wait(200);
dev.state.vp.setView([0.5, -1, 0.55], false, [0, 0, 1]);
dev.state.vp.fit(1.15);
dev.setStatus('Sheet metal: base flange, flanges, a fold, and the flat pattern it all lays out to.');
await wait(500);
report.finalErrors = errs();
report.finalBodies = dev.state.result.bodies.length;
return report;
