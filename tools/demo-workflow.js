/**
 * Exercises the Fusion-shaped workflow end to end through the real interface:
 * sketch, extrude, pick a face, sketch on it, cut, fillet picked edges, shell.
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

function fire(type, at, opts = {}) {
  canvas.dispatchEvent(
    new PointerEvent(type, {
      ...at,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      bubbles: true,
      cancelable: true,
      ...opts
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

/* ---- 1. sketch a plate on XY and extrude it ---- */

// Create Sketch now asks which plane by pointing. The browser tree answers it
// as well as the viewport does, and naming the plane keeps this run repeatable.
document.querySelector('[data-cmd="newSketch"]').click();
await wait(120);
{
  const node = [...document.querySelectorAll('#tree .node')].find(
    (n) => n.textContent.trim() === 'XY plane'
  );
  if (!node) return { error: 'no XY plane in the browser' };
  node.click();
}
await wait(600);

const sketcher = dev.state.sketcher;
if (!sketcher.active) return { error: 'sketch did not start' };

sketcher.setTool('centerRectangle');
await clickPlane(0, 0);
await clickPlane(30, 20);

report.sketchEntities = sketcher.sketch.entities.length;
report.sketchDof = sketcher.solve().dof;
report.constrainedCount = [...sketcher.lastSolve.constrained.values()].filter(Boolean).length;

// Pick the region, then finish, which should carry the profile out.
sketcher.refreshRegions();
sketcher.selectedRegions.add(sketcher.regions[0].id);
dev.runCommand('finishSketch');
await wait(300);

report.profilesCarried = dev.state.selection.profiles.length;

dev.runCommand('extrude');
await wait(200);
const editing = dev.state.editing;
if (!editing) return { ...report, error: 'extrude dialog did not open' };

// Opening a side panel narrows the viewport without any window event, and the
// canvas used to keep its old width and cover the panel completely. It was
// laid out, focused and typeable the whole time, and invisible. Check that
// what is actually painted where the dialog is, is the dialog.
{
  const panel = document.getElementById('inspector');
  const r = panel.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + 40, r.top + 60);
  report.dialogOnTop = !!(at && panel.contains(at));
  report.dialogCovers = at ? at.tagName : 'nothing';
  const canvas = document.getElementById('view');
  const cr = canvas.getBoundingClientRect();
  report.canvasStopsAtPanel = Math.abs(cr.right - r.left) < 1.5;
}
editing.feature.distance = '12';
dev.rebuildAll();
document.getElementById('inspectorOk').click();
await wait(300);

report.afterExtrude = {
  bodies: dev.bodies.length,
  volume: Number(dev.bodies[0]?.solid.volume().toFixed(1))
};

/* ---- 2. select the top face and sketch on it ---- */

const rec = dev.state.records[0];
const topFace = rec.topology.faces.find(
  (f) => f.planar && f.normal[2] > 0.99
);
if (!topFace) return { ...report, error: 'no top face found' };

dev.state.selection.faces.add(`${rec.id}:${topFace.id}`);
dev.runCommand('newSketch');
await wait(400);

report.sketchOnFace = {
  active: dev.state.sketcher.active,
  planeOrigin: dev.state.sketcher.plane?.origin.map((n) => Number(n.toFixed(3))),
  planeNormal: dev.state.sketcher.plane?.n.map((n) => Number(n.toFixed(3)))
};

// A circle on the face, cut straight through.
dev.state.sketcher.setTool('circle');
await clickPlane(0, 0);
await clickPlane(7, 0);
dev.state.sketcher.refreshRegions();
dev.state.sketcher.selectedRegions.add(dev.state.sketcher.regions[0].id);
dev.runCommand('finishSketch');
await wait(250);

dev.runCommand('extrude');
await wait(200);
if (dev.state.editing) {
  dev.state.editing.feature.distance = '20';
  dev.state.editing.feature.op = 'cut';
  dev.state.editing.feature.flip = false;
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(300);

report.afterCut = {
  bodies: dev.bodies.length,
  volume: Number(dev.bodies[0]?.solid.volume().toFixed(1)),
  genus: dev.bodies[0]?.solid.genus()
};

/* ---- 3. fillet every outside edge ---- */

dev.runCommand('selectAllEdges');
await wait(100);
report.edgesSelected = dev.state.selection.edges.size;

dev.runCommand('fillet');
await wait(150);
if (dev.state.editing) {
  dev.state.editing.feature.radius = '3';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(400);

report.afterFillet = {
  volume: Number(dev.bodies[0]?.solid.volume().toFixed(1)),
  tris: dev.bodies[0]?.solid.numTri(),
  errors: dev.state.result.errors.map((e) => e.message)
};

/* ---- 4. undo it, then redo ---- */

dev.runCommand('undo');
await wait(300);
report.afterUndo = Number(dev.bodies[0]?.solid.volume().toFixed(1));
dev.runCommand('redo');
await wait(300);
report.afterRedo = Number(dev.bodies[0]?.solid.volume().toFixed(1));

dev.state.vp.fit(1.4);
dev.state.vp.setView([0.5, -0.8, 0.42]);
dev.setStatus('Workflow demo complete.');
await wait(400);

report.timeline = dev.state.doc.features.map((f) => f.type);
report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
