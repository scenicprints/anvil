/**
 * Batch 7, surfaces: every command on the Surface tab driven through the
 * interface, plus the two the Solid tab gains and the two the Sketch tab does.
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
  // New Sketch finishes the one in hand rather than starting another, and a
  // selected face answers the where without asking, so both are cleared first.
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

/** Select a sketch in the browser, which is how a surface command finds one. */
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

const sheets = () => dev.state.result.bodies.filter((b) => !b.solid);
const solids = () => dev.state.result.bodies.filter((b) => b.solid);
const errs = () => dev.state.result.errors.map((e) => e.message);
const only = (list) => {
  dev.state.selection.bodies.clear();
  for (const b of list) dev.state.selection.bodies.add(b.id);
};

/** A straight line in a fresh sketch on the named plane. */
async function lineSketch(plane, a, b) {
  await openSketchOn(plane);
  const sk = dev.state.sketcher;
  sk.setTool('line');
  await clickPlane(a[0], a[1]);
  await clickPlane(b[0], b[1]);
  sk.setTool('select');
  dev.runCommand('finishSketch');
  await wait(300);
}

/* ---- 1. the tab is there and the ribbon still fits on two rows ---- */

dev.setTab('surface');
await wait(300);
{
  const panel = document.querySelector('[data-panel="surface"]');
  report.surfaceTabShows = panel?.classList.contains('active') || false;
  report.surfaceButtons = [...panel.querySelectorAll('button[data-cmd]')].map(
    (b) => b.dataset.cmd
  );
  report.groupHeights = [...panel.querySelectorAll('.group')].map((g) =>
    Math.round(g.getBoundingClientRect().height)
  );
  report.ribbonHeight = Math.round(
    document.getElementById('ribbon').getBoundingClientRect().height
  );
}

/* ---- 2. an open curve extruded into a surface ---- */

dev.setTab('solid');
await openSketchOn('XY plane');
{
  const sk = dev.state.sketcher;
  sk.setTool('line');
  await clickPlane(-20, 0);
  await clickPlane(-20, 20);
  await clickPlane(20, 20);
  await clickPlane(20, 0);
  sk.setTool('select');
  report.curveEntities = sk.sketch.entities.length;
}
dev.runCommand('finishSketch');
await wait(300);

await chooseSketch('Sketch 1');
dev.setTab('surface');
dev.runCommand('surfaceExtrude');
await fillDialog({ Distance: '25' });
report.afterExtrude = { surfaces: sheets().length, solids: solids().length };
report.extrudeErrors = errs();

/* ---- 3. offset, extend, reverse ---- */

only([sheets()[0]]);
dev.runCommand('offsetSurface');
await fillDialog({ Offset: '6' });
report.offsetErrors = errs();
{
  const [a, b] = sheets();
  const near = (m, i) => [m.vertProperties[i], m.vertProperties[i + 1], m.vertProperties[i + 2]];
  const pa = near(a.sheet, 0);
  const pb = near(b.sheet, 0);
  report.offsetGap =
    Math.round(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) * 100) / 100;
}

only([sheets()[1]]);
dev.runCommand('extendSurface');
await fillDialog({ Distance: '4' });
report.extendErrors = errs();

only([sheets()[1]]);
dev.runCommand('reverseNormal');
await fillDialog();
report.reverseErrors = errs();

/* ---- 4. a lidded tube: revolve, patch, stitch ---- */

await lineSketch('XZ plane', [30, -12], [30, 12]);
await chooseSketch('Sketch 2');

const beforeTube = sheets().length;
dev.runCommand('surfaceRevolve');
await fillDialog({ Axis: 'world', 'World axis': 'z', Angle: '360' });
report.revolveErrors = errs();

const tube = sheets()[sheets().length - 1];
report.tubeIsOpen = !!tube;
only([tube]);
dev.runCommand('patch');
await fillDialog();
report.patchErrors = errs();
report.patchesMade = sheets().length - beforeTube - 1;

only(sheets().slice(beforeTube));
dev.runCommand('stitch');
await fillDialog({ 'Gap to close': '0.05' });
report.stitchErrors = errs();
report.afterStitch = { surfaces: sheets().length, solids: solids().length };
if (solids().length) {
  report.tubeVolume = Math.round(solids()[solids().length - 1].solid.volume());
  report.tubeWanted = Math.round(Math.PI * 900 * 24);
}

/* ---- 5. thicken the walls that are left ---- */

only([sheets()[0]]);
dev.runCommand('thicken');
await fillDialog({ Thickness: '2' });
report.thickenErrors = errs();
report.afterThicken = { surfaces: sheets().length, solids: solids().length };

/* ---- 6. ruled and trim ---- */

await lineSketch('XY plane', [-40, -40], [40, -40]);
await chooseSketch('Sketch 3');
dev.runCommand('ruled');
await fillDialog({ Shape: 'direction', Width: '20' });
report.ruledErrors = errs();
report.ruledMade = sheets().length;

{
  // Cut that band with the tall wall standing across it.
  const band = sheets()[sheets().length - 1];
  const knife = sheets()[0];
  only([band]);
  dev.runCommand('trimSurface');
  if (dev.state.editing) {
    dev.state.editing.feature.cutters = [knife.id];
    dev.state.editing.feature.keep = [30, -40, 10];
    dev.rebuildAll();
  }
  await fillDialog();
  report.trimErrors = errs();
}

/* ---- 7. a swept and a lofted surface ---- */

await lineSketch('XZ plane', [-50, 0], [-50, 30]);
await lineSketch('YZ plane', [-50, 0], [50, 0]);
await chooseSketch('Sketch 4');
dev.runCommand('surfaceSweep');
{
  const sketchNames = Object.values(dev.state.doc.sketches).map((s) => s.name);
  const five = Object.values(dev.state.doc.sketches).find((s) => s.name === 'Sketch 5');
  if (dev.state.editing && five) {
    dev.state.editing.feature.path = { sketch: five.id };
    dev.rebuildAll();
  }
  report.sketchNames = sketchNames;
}
await fillDialog();
report.sweepErrors = errs();

// A second line parallel to Sketch 3, so the loft between them is a band and
// not a twist between two curves that happen to be at right angles.
await lineSketch('XY plane', [-40, -60], [40, -60]);
dev.setTab('surface');
dev.runCommand('surfaceLoft');
{
  const list = Object.values(dev.state.doc.sketches);
  const a = list.find((s) => s.name === 'Sketch 3');
  const b = list.find((s) => s.name === 'Sketch 6');
  if (dev.state.editing && a && b) {
    dev.state.editing.feature.sections = [{ sketch: a.id }, { sketch: b.id }];
    dev.rebuildAll();
  }
}
await fillDialog();
report.loftErrors = errs();
report.afterLoft = { surfaces: sheets().length, solids: solids().length };

/* ---- 8. boundary fill and replace face ---- */

await lineSketch('XZ plane', [-60, 4], [60, 4]);
await chooseSketch('Sketch 7');
dev.runCommand('surfaceExtrude');
await fillDialog({ Distance: '160', Direction: 'symmetric' });

{
  const knife = sheets()[sheets().length - 1];
  const target = solids()[0];
  only([target]);
  const before = solids().length;
  dev.runCommand('boundaryFill');
  if (dev.state.editing) {
    dev.state.editing.feature.tools = [knife.id];
    dev.rebuildAll();
  }
  await fillDialog();
  report.boundaryFillErrors = errs();
  report.cellsMade = solids().length - before + 1;
}

{
  // Replace the top face of a body with the same knife surface.
  const target = solids()[0];
  const rec = (dev.state.records || []).find((r) => r.id === target.id);
  const top = rec?.topology?.faces.find((f) => f.planar && f.normal[2] > 0.99);
  const knife = sheets()[sheets().length - 1];
  if (top) {
    only([]);
    dev.state.selection.faces.clear();
    dev.state.selection.faces.add(`${rec.id}:${top.id}`);
    dev.runCommand('replaceFace');
    if (dev.state.editing) {
      dev.state.editing.feature.tool = knife.id;
      dev.rebuildAll();
    }
    await fillDialog();
    report.replaceFaceErrors = errs();
  }
  dev.state.selection.faces.clear();
}

/* ---- 9. unstitch, and the two commands the sketch tab gains ---- */

{
  const target = solids()[0];
  only([target]);
  const before = sheets().length;
  dev.runCommand('unstitch');
  await fillDialog();
  report.unstitchErrors = errs();
  report.facesFromUnstitch = sheets().length - before;
}

await openSketchOn('XY plane');
{
  const sk = dev.state.sketcher;
  // Isoparametric lines off a surface that was built from a curve, so it has
  // a u and a v to hold constant.
  const gridded = dev.state.result.bodies.find((b) => b.sheet?.grid);
  if (gridded) {
    only([gridded]);
    dev.runCommand('isoCurve');
    await wait(400);
    report.isoMessage = document.getElementById('status').textContent;
    report.isoIs3d = !!sk.sketch.is3d;
    report.isoEntities = sk.sketch.entities.length;
  }

  // And a line dropped onto whatever is underneath it.
  sk.setTool('line');
  await clickPlane(-15, -15);
  await clickPlane(15, -15);
  sk.setTool('select');
  const solid = solids()[0];
  if (solid) {
    only([solid]);
    dev.runCommand('projectToSurface');
    await wait(400);
    report.projectMessage = document.getElementById('status').textContent;
  }
}
dev.runCommand('finishSketch');
await wait(300);

/* ---- the picture ---- */

dev.setTab('surface');
dev.state.hiddenSketches.clear();
only([]);
dev.state.vp.setSelection(dev.state.selection.bodies);
await wait(200);
dev.state.vp.setView([0.6, -1, 0.45], false, [0, 0, 1]);
dev.state.vp.fit(1.15);
dev.setStatus('Surfaces: extruded, revolved, patched, stitched, thickened and unstitched.');
await wait(500);
report.finalBodies = { surfaces: sheets().length, solids: solids().length };
report.finalErrors = errs();
return report;
