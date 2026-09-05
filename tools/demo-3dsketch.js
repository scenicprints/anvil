/**
 * Batch 7, the sketch that leaves its plane: Include 3D Geometry, Intersection
 * Curve, and a sweep along a path that climbs.
 *
 * Runs inside the page via --anvil-script.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};

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

/** The span of a sketch's points away from its own plane. */
function offPlaneSpan(sk) {
  const zs = sk.points.map((p) => p.z || 0);
  return Number((Math.max(...zs) - Math.min(...zs)).toFixed(2));
}

/* ---- 1. a plate with a shaft through it ---- */

dev.runCommand('primBox');
await wait(250);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no box dialog' };
  f.params.width = '60';
  f.params.depth = '60';
  f.params.height = '10';
  f.params.centered = true;
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(400);

dev.runCommand('primCyl');
await wait(250);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no cylinder dialog' };
  f.params.diameter = '26';
  f.params.height = '50';
  f.params.centered = true;
  f.op = 'new';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(400);
report.bodies = dev.bodies.length;

/* ---- 2. the curve where the two meet ---- */

await openSketchOn('XY plane');
{
  const sk = dev.state.sketcher;
  dev.state.selection.bodies.clear();
  for (const b of dev.bodies) dev.state.selection.bodies.add(b.id);
  dev.runCommand('intersectionCurve');
  await wait(400);

  report.intersectionMessage = document.getElementById('status').textContent;
  report.intersectionIs3d = !!sk.sketch.is3d;
  // The shaft enters at the plate's underside and leaves at its top, so the
  // curve is two circles 10 apart, which is the plate's thickness.
  report.intersectionSpan = offPlaneSpan(sk.sketch);
  const radii = sk.sketch.points.map((p) => Math.hypot(p.x, p.y));
  report.intersectionRadius = [
    Number(Math.min(...radii).toFixed(2)),
    Number(Math.max(...radii).toFixed(2))
  ];
  // Nothing that is not flat can bound an area, and it must not pretend to.
  sk.refreshRegions();
  report.regionsFromA3dSketch = sk.regions.length;
}
dev.runCommand('finishSketch');
await wait(300);

/* ---- 3. Include: a model edge taken as it is, not squashed flat ---- */

await openSketchOn('XY plane');
{
  const sk = dev.state.sketcher;
  const rec = dev.state.records[0];
  // A side face of the plate, whose edges run above and below the sketch plane.
  const side = rec.topology.faces.find((fc) => fc.planar && Math.abs(fc.normal[2]) < 0.01);
  dev.state.selection.bodies.clear();
  dev.state.selection.faces.clear();
  dev.state.selection.faces.add(`${rec.id}:${side.id}`);

  dev.runCommand('include3D');
  await wait(400);
  report.includeMessage = document.getElementById('status').textContent;
  report.includeIs3d = !!sk.sketch.is3d;
  // The plate is 10 thick about the origin, so its side edges sit at plus and
  // minus 5. Project would have brought them all in at zero.
  report.includeSpan = offPlaneSpan(sk.sketch);
}
dev.runCommand('finishSketch');
await wait(300);

/* ---- 4. a helix, and a rod swept along it ---- */

await openSketchOn('XY plane');
const pathSketchId = dev.state.sketcher.sketch.id;
{
  const sk = dev.state.sketcher;
  const run = [];
  const turns = 2;
  const radius = 22;
  const rise = 30;
  for (let i = 0; i <= 96; i++) {
    const t = (i / 96) * turns * Math.PI * 2;
    run.push([radius * Math.cos(t), radius * Math.sin(t), (rise * i) / 96]);
  }
  sk.insertWorldCurves([run], { asLines: false });
  await wait(200);
  report.helixIs3d = !!sk.sketch.is3d;
  report.helixSpan = offPlaneSpan(sk.sketch);
}
dev.runCommand('finishSketch');
await wait(300);

// The section: square to the way the helix sets off, and sitting where it
// starts. A section drawn away from the path is swept at that offset.
await openSketchOn('XZ plane');
const profSketchId = dev.state.sketcher.sketch.id;
{
  const sk = dev.state.sketcher;
  const c = sk.addPoint(22, 0);
  sk.addEntity({ type: 'circle', c, r: 3 });
  await wait(150);
}
dev.runCommand('finishSketch');
await wait(300);

{
  const doc = dev.state.doc;
  doc.features.push({
    id: `f${Date.now().toString(36)}`,
    type: 'sweep',
    name: 'Helical rod',
    sketch: profSketchId,
    path: { sketch: pathSketchId },
    op: 'new',
    targets: 'all'
  });
  dev.rebuildAll();
  await wait(600);
  report.sweepErrors = dev.state.result.errors.map((e) => e.message);
  const rod = dev.bodies[dev.bodies.length - 1];
  if (rod) {
    const bb = rod.solid.boundingBox();
    report.rodHeight = Number((bb.max[2] - bb.min[2]).toFixed(2));
    report.rodVolume = Number(rod.solid.volume().toFixed(1));
    // Pappus: the section's area along the length the helix actually runs.
    const len = 2 * Math.PI * 22 * 2 * Math.hypot(1, 30 / (2 * Math.PI * 22 * 2));
    report.rodExpected = Number((Math.PI * 9 * len).toFixed(1));
  }
}

/* ---- the picture ---- */

dev.state.hiddenSketches.clear();
{
  const box = document.getElementById('chkTransparent');
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}
await wait(200);
dev.state.vp.setView([0.55, -1, 0.5], false, [0, 0, 1]);
dev.state.vp.fit(1.2);
dev.setStatus('A sketch that leaves its plane: intersection curves, included edges, and a helical sweep.');
await wait(500);
return report;
