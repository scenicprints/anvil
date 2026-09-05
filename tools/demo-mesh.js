/**
 * Batch 9, the Mesh tab: tessellate, face groups, repair, reduce, remesh,
 * smooth, plane cut, separate, merge, erase and fill, reverse, texture, the
 * section sketch, and convert to a solid, all through the interface.
 *
 * Three spheres side by side, each taken somewhere different, so the picture
 * shows what the tab is for rather than one ball with a lot of history.
 *
 * Runs inside the page via --anvil-script.
 */

const [MT, SH] = await Promise.all([
  import('./meshtools.js'),
  import('./sheet.js')
]);

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};

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
  await wait(600);
}

const meshes = () => dev.state.result.bodies.filter((b) => b.mesh);
const solids = () => dev.state.result.bodies.filter((b) => b.solid);
const errs = () => dev.state.result.errors.map((e) => e.message);
const only = (list) => {
  dev.state.selection.bodies.clear();
  for (const b of list) dev.state.selection.bodies.add(b.id);
};
const tris = (b) => b.sheet.triVerts.length / 3;
const byId = (id) => dev.state.result.bodies.find((b) => b.id === id);

/** A sphere of 40 at x, as a solid. */
async function sphereAt(x) {
  dev.setTab('solid');
  dev.runCommand('primSphere');
  await wait(250);
  const f = dev.state.editing?.feature;
  if (!f) throw new Error('no sphere dialog');
  f.params.diameter = '40';
  f.params.x = String(x);
  // Its own body: the default joins, and three spheres joined are one body
  // however far apart they are.
  f.op = 'new';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
  await wait(400);
  return solids()[solids().length - 1];
}

try {

/* ---- 1. the tab, and that the ribbon still fits ---- */

dev.setTab('mesh');
await wait(300);
{
  const panel = document.querySelector('[data-panel="mesh"]');
  report.meshTabShows = panel?.classList.contains('active') || false;
  report.meshButtons = [...panel.querySelectorAll('button[data-cmd]')].map(
    (b) => b.dataset.cmd
  );
  report.groupHeights = [...panel.querySelectorAll('.group')].map((g) =>
    Math.round(g.getBoundingClientRect().height)
  );
  report.ribbonHeight = Math.round(
    document.getElementById('ribbon').getBoundingClientRect().height
  );
  report.tabs = [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim());
}

/* ---- 2. three spheres, taken as triangles ---- */

// Ids, not bodies: every rebuild frees the last result's solids, so a handle
// kept across one is a pointer to something that has been let go.
const seeds = [];
for (const x of [-60, 0, 60]) {
  const made = await sphereAt(x);
  if (!seeds.length) report.sphereVolume = Math.round(made.solid.volume());
  seeds.push(made.id);
}

dev.setTab('mesh');
only(seeds.map(byId));
dev.runCommand('tessellate');
await fillDialog();
report.tessellateErrors = errs();
report.afterTessellate = { meshes: meshes().length, solids: solids().length };
report.meshTris = tris(meshes()[0]);

// The solids they came from are done with; hide them so the meshes are what
// the picture shows.
for (const id of seeds) dev.state.hiddenBodies.add(id);

const left = meshes()[0].id;
const middle = meshes()[1].id;
const right = meshes()[2].id;

/* ---- 3. face groups on the first one ---- */

only([byId(left)]);
dev.runCommand('faceGroups');
await fillDialog({ Angle: '40' });
report.faceGroupErrors = errs();
{
  const rec = (dev.state.records || []).find((r) => r.id === left);
  report.facesAtForty = rec?.topology?.faces.length ?? null;
}

/* ---- 4. the left one, reduced hard so the facets show ---- */

only([byId(left)]);
dev.runCommand('meshReduce');
await fillDialog({ 'Reduce by': 'ratio', 'Keep, per cent': '6' });
report.reduceErrors = errs();
report.afterReduce = tris(byId(left));
{
  // Reduced hard and still the size it was, which is the whole claim.
  const P = SH.sheetPoints(byId(left).sheet);
  const radii = P.map((p) => Math.hypot(p[0] + 60, p[1], p[2]));
  report.reducedRadius = [
    +Math.min(...radii).toFixed(2),
    +Math.max(...radii).toFixed(2)
  ];
}

/* ---- 5. the middle one, remeshed evenly then given a texture ---- */

only([byId(middle)]);
dev.runCommand('meshRemesh');
await fillDialog({ 'Edge length': '2', Passes: '3' });
report.remeshErrors = errs();
report.afterRemesh = tris(byId(middle));
{
  const P = SH.sheetPoints(byId(middle).sheet);
  const radii = P.map((p) => Math.hypot(p[0], p[1], p[2]));
  report.remeshRadius = [
    +Math.min(...radii).toFixed(2),
    +Math.max(...radii).toFixed(2)
  ];
}

only([byId(middle)]);
dev.runCommand('meshSmooth');
await fillDialog({ Passes: '3', Strength: '0.4' });
report.smoothErrors = errs();

{
  // Rings, so the displacement reads at a glance rather than as noise.
  const w = 128;
  const h = 128;
  const gray = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - w / 2, y - h / 2);
      gray[y * w + x] = Math.floor(r / 7) % 2 ? 255 : 0;
    }
  }
  dev.state.doc.imageData.rings = { width: w, height: h, gray };
  dev.state.doc.features.push({
    id: `f${Date.now().toString(36)}`,
    type: 'textureExtrude',
    bodies: [middle],
    image: 'rings',
    plane: 'XY',
    height: '2',
    size: '44',
    invert: false
  });
  dev.rebuildAll();
  await wait(700);
  report.textureErrors = errs();
  const P = SH.sheetPoints(byId(middle).sheet);
  const radii = P.map((p) => Math.hypot(p[0], p[1], p[2]));
  report.textureRadius = [
    +Math.min(...radii).toFixed(2),
    +Math.max(...radii).toFixed(2)
  ];
}

/* ---- 6. the right one, cut in half and one half converted ---- */

only([byId(right)]);
dev.runCommand('meshPlaneCut');
if (dev.state.editing) {
  dev.state.editing.feature.plane = 'XZ';
  dev.rebuildAll();
}
await fillDialog({ 'Cut type': 'split', 'Cap the cut': true });
report.cutErrors = errs();
report.afterCut = meshes().length;
report.cutHealth = meshes()
  .filter((b) => b.id === right || b.createdBy === byId(right)?.createdBy)
  .map((b) => MT.meshHealth(b.sheet).closed);

// Merge the two halves back and separate them again, which has to be a round
// trip or one of the two is wrong.
{
  const halves = meshes().filter((b) => b.id !== left && b.id !== middle);
  report.halves = halves.length;
  only(halves);
  dev.runCommand('meshMerge');
  await fillDialog();
  report.mergeErrors = errs();
  report.afterMerge = meshes().length;

  only(meshes().filter((b) => b.id !== left && b.id !== middle));
  dev.runCommand('meshSeparate');
  await fillDialog();
  report.separateErrors = errs();
  report.afterSeparate = meshes().length;
}

/* ---- 7. erase a face off one half, and let repair close it ---- */

{
  const target = meshes().find((b) => b.id !== left && b.id !== middle);
  const rec = (dev.state.records || []).find((r) => r.id === target.id);
  const face = rec?.topology?.faces.find((f) => f.planar);
  report.erasePicked = !!face;
  if (face) {
    dev.state.selection.faces.clear();
    dev.state.selection.faces.add(`${rec.id}:${face.id}`);
    only([]);
    dev.runCommand('meshErase');
    await fillDialog({ 'Close the hole': true });
    report.eraseErrors = errs();
    dev.state.selection.faces.clear();
    report.afterErase = MT.meshHealth(byId(target.id).sheet).closed;
  }

  only([byId(target.id)]);
  dev.runCommand('meshRepair');
  await fillDialog({ 'Fill holes': true });
  report.repairErrors = errs();
  report.repairedHealth = MT.meshHealth(byId(target.id).sheet).closed;

  only([byId(target.id)]);
  dev.runCommand('convertMesh');
  await fillDialog({ 'Repair first': true });
  report.convertErrors = errs();
  report.afterConvert = { meshes: meshes().length, solids: solids().length };
}

/* ---- 8. a section sketch off the textured one ---- */

await openSketchOn('XY plane');
only([byId(middle)]);
dev.runCommand('meshSection');
await wait(600);
report.sectionMessage = document.getElementById('status').textContent;
dev.runCommand('finishSketch');
await wait(300);

/* ---- the picture ---- */

dev.setTab('mesh');
dev.state.hiddenSketches.clear();
only([]);
dev.state.vp.setSelection(dev.state.selection.bodies);
await wait(200);
dev.state.vp.setView([0.35, -1, 0.4], false, [0, 0, 1]);
dev.state.vp.fit(1.15);
dev.setStatus('Mesh: reduced, remeshed and textured, cut and converted.');
await wait(500);
report.finalErrors = errs();
report.finalBodies = { meshes: meshes().length, solids: solids().length };
} catch (err) {
  report.threw = String(err && err.message);
  report.where = String(err && err.stack).split(/\n/).slice(0, 4).join(' | ');
}
return report;
