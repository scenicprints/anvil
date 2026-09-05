/**
 * Finishing batch 3 through the real interface: a tangent arc, a linked
 * projection that follows the model, a projection copied in as ordinary
 * geometry, and a section taken where a body crosses the sketch plane.
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

/* ---- 1. a tangent arc off the end of a line ---- */

await openSketchOn('XY plane');
{
  const sk = dev.state.sketcher;
  sk.setTool('line');
  await clickPlane(-40, 20);
  await clickPlane(-20, 20);
  sk.setTool('select');
  report.lines = sk.sketch.entities.filter((e) => e.type === 'line').length;

  sk.setTool('tangentArc');
  await clickPlane(-20, 20);
  await clickPlane(-8, 32);
  sk.setTool('select');

  const arcs = sk.sketch.entities.filter((e) => e.type === 'arc');
  report.tangentArcs = arcs.length;
  if (arcs.length) {
    const c = sk.sketch.points[arcs[0].c];
    const s = { x: -20, y: 20 };
    // The centre has to sit square to the line it left, which for a
    // horizontal line means straight above or below the start point.
    report.arcCentre = [Number(c.x.toFixed(3)), Number(c.y.toFixed(3))];
    report.centreIsSquareToLine = Math.abs(c.x - s.x) < 1e-6;
    const r = Math.hypot(c.x - s.x, c.y - s.y);
    const rEnd = Math.hypot(c.x - -8, c.y - 32);
    report.radiiMatch = Math.abs(r - rEnd) < 1e-6;
    report.tangentConstraints = sk.sketch.constraints.filter((k) => k.type === 'tangent').length;
  }
  // Starting one in mid air has nothing to be tangent to, and must say so.
  sk.setTool('tangentArc');
  await clickPlane(30, -30);
  report.refusedInMidAir = dev.state.sketcher.pending === null;
  report.refusalMessage = document.getElementById('status').textContent;
  sk.setTool('select');
}
dev.runCommand('finishSketch');
await wait(300);

/* ---- 2. a block to project from and section through ---- */

dev.runCommand('primBox');
await wait(250);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no box dialog' };
  f.params.width = '40';
  f.params.depth = '30';
  f.params.height = '20';
  f.params.centered = true;
  f.params.z = '0';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(400);
report.box = Number(dev.bodies[0]?.solid.volume().toFixed(1));

/* ---- 3. a sketch above it: project its top face, and section it ---- */

await openSketchOn('XY plane');
{
  const sk = dev.state.sketcher;
  const rec = dev.state.records[0];
  const top = rec.topology.faces.find((fc) => fc.planar && fc.normal[2] > 0.99);
  dev.state.selection.faces.clear();
  dev.state.selection.faces.add(`${rec.id}:${top.id}`);

  dev.runCommand('project');
  await wait(400);
  report.projections = sk.sketch.projections?.length ?? 0;
  report.derivedAfterProject = sk.derived?.entities?.length ?? 0;
  report.projectMessage = document.getElementById('status').textContent;

  // A linked projection has to follow the model, so change the box and look.
  const boxFeature = dev.state.doc.features.find((x) => x.type === 'primitive');
  boxFeature.params.width = '60';
  dev.rebuildAll();
  await wait(400);
  const D = sk.derived;
  const xs = D ? D.points.map((p) => p.x) : [];
  report.projectedSpanAfterChange = xs.length
    ? Number((Math.max(...xs) - Math.min(...xs)).toFixed(2))
    : null;

}

/* ---- 3b. a section, in its own sketch ---- */

// Deliberately not the same sketch as the projection above: that box's top
// face flattens onto exactly the rectangle its own section gives, and two
// runs of geometry lying on top of each other close no region between them.
dev.runCommand('finishSketch');
await wait(300);
await openSketchOn('XY plane');
{
  const sk = dev.state.sketcher;
  dev.state.selection.faces.clear();
  dev.state.selection.bodies.add(dev.bodies[0].id);
  dev.runCommand('intersect');
  await wait(400);
  report.intersections = sk.sketch.intersections?.length ?? 0;
  report.derivedAfterIntersect = sk.derived?.entities?.length ?? 0;
  report.intersectMessage = document.getElementById('status').textContent;

  sk.refreshRegions();
  report.regionsFromDerived = sk.regions.length;
  // The box is 60 by 30 by 20 about the origin, so the plane through its
  // middle cuts a 60 by 30 rectangle.
  report.regionAreas = sk.regions.map((r) => Number(Math.abs(r.area).toFixed(1)));
}

/* ---- 4. and the copy form, which makes real editable geometry ---- */

{
  const sk = dev.state.sketcher;
  const before = sk.sketch.entities.length;
  const rec = dev.state.records[0];
  dev.state.selection.bodies.clear();
  const top = rec.topology.faces.find((fc) => fc.planar && fc.normal[2] > 0.99);
  dev.state.selection.faces.clear();
  dev.state.selection.faces.add(`${rec.id}:${top.id}`);
  dev.runCommand('projectCopy');
  await wait(300);
  report.copiedEntities = sk.sketch.entities.length - before;
}

// Show every sketch: the tangent arc is in the first one, and the projected
// edges and the section are in the two after it.
dev.runCommand('finishSketch');
await wait(300);
dev.state.hiddenSketches.clear();
// A section lies inside the body, so it is behind the surface until the model
// is made see-through. That is what the Transparent tick box is for.
{
  const box = document.getElementById('chkTransparent');
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}
dev.rebuildAll();
await wait(300);
dev.state.vp.setHomeView();
await wait(200);
dev.state.vp.fit(1.35);
dev.setStatus('Tangent arc, linked projection, copy, and a section.');
await wait(400);
report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
