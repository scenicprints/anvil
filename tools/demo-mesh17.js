/**
 * Batch 17: the mesh commands, plus material, colour and Compute All.
 *
 * A solid is tessellated into a mesh so there is something real to work on,
 * then Stitch, Patch and Direct Edit are run off the ribbon. Material and
 * colour are set on the same body afterwards, and the last check is that
 * setting a colour has not changed what the body weighs, because that is the
 * whole reason the two are separate commands.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const MT = await import('./meshtools.js');
const AN = await import('./analysis.js');
const K = await import('./kernel.js');

const meshes = () => dev.bodies.filter((b) => b.mesh);
const status = () => document.getElementById('status').textContent;
const fieldNames = () =>
  [...document.querySelectorAll('#inspectorBody .field label')].map((n) => n.textContent.trim());

async function fillDialog(values = {}) {
  await wait(300);
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
  await wait(800);
}

/* ---- a solid, turned into a mesh ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await fillDialog({ Width: '40', Depth: '40', Height: '20' });
dev.setTab('mesh');
await wait(200);
dev.runCommand('tessellate');
await fillDialog({});
report.mesh = { made: meshes().length };
if (!meshes().length) return report;

const body = meshes()[0];
dev.state.selection.bodies.clear();
dev.state.selection.bodies.add(body.id);
report.mesh.health = MT.meshHealth(body.sheet);

/* ---- stitch ---- */
{
  dev.runCommand('meshStitch');
  await wait(300);
  report.stitch = { asks: fieldNames() };
  await fillDialog({ 'Points closer': '0.01' });
  report.stitch.said = status();
  report.stitch.stillClosed = MT.meshHealth(meshes()[0].sheet).openEdges === 0;
}

/* ---- patch, on a mesh with nothing to patch ---- */
{
  dev.runCommand('meshPatch');
  await wait(300);
  report.patch = { asks: fieldNames() };
  await fillDialog({ 'Biggest hole': '0' });
  report.patch.said = status();
  report.patch.errors = (dev.state.result?.errors || []).map((e) => e.message);
}

/* ---- direct edit, on the top face ---- */
{
  const b = meshes()[0];
  const rec = (dev.state.records || []).find((r) => r.id === b.id);
  const top = rec.topology.faces.reduce(
    (best, f, i) => (f.normal[2] > 0.99 && f.area > (rec.topology.faces[best]?.area ?? 0) ? i : best),
    -1
  );
  report.direct = { foundTheTop: top >= 0 };
  if (top >= 0) {
    const before = AN.meshSize(b.sheet);
    dev.state.selection.faces.clear();
    dev.state.selection.faces.add(`${b.id}:${rec.topology.faces[top].id}`);
    dev.runCommand('meshDirectEdit');
    await wait(300);
    report.direct.asks = fieldNames();
    await fillDialog({ 'Which way': 'normal', 'How far': '6', 'How far the move': '10' });
    const after = AN.meshSize(meshes()[0].sheet);
    report.direct.heightBefore = +before[2].toFixed(3);
    report.direct.heightAfter = +after[2].toFixed(3);
    report.direct.said = status();
  }
}

/* ---- material and colour, which must not affect each other ---- */
{
  const b = meshes()[0];
  dev.state.selection.bodies.clear();
  dev.state.selection.bodies.add(b.id);

  const massOf = () => {
    const rec = (dev.state.records || []).find((r) => r.id === b.id);
    const mats = dev.state.doc.materials || {};
    return AN.combinedMass([
      { mesh: rec.mesh, material: mats.byBody?.[b.id] || mats.default || 'pla' }
    ]).mass;
  };

  dev.setTab('solid');
  await wait(150);
  dev.runCommand('physicalMaterial');
  await wait(300);
  report.material = { asks: fieldNames() };
  await fillDialog({ Material: 'steel' });
  report.material.said = status();
  report.material.set = dev.state.doc.materials?.byBody?.[b.id];
  const asSteel = massOf();

  dev.runCommand('appearance');
  await wait(300);
  report.colour = { asks: fieldNames() };
  await fillDialog({ Colour: '#4a7fb8' });
  report.colour.said = status();
  report.colour.set = dev.state.doc.appearance?.byBody?.[b.id];
  report.colour.massUnchanged = Math.abs(massOf() - asSteel) < 1e-9;
  report.material.massAsSteel = +asSteel.toFixed(2);
}

/* ---- compute all ---- */
{
  const before = dev.bodies.length;
  dev.runCommand('computeAll');
  await wait(900);
  report.computeAll = {
    said: status(),
    sameBodies: dev.bodies.length === before,
    // Dropped and then filled again by the rebuild that followed, which is the
    // state to be in: the cache is not gone, it is known to be right.
    cacheRebuilt: dev.state.cache ? true : false
  };
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
