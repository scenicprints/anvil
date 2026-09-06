/**
 * Reading a body back as features.
 *
 * A plate with four bores at two sizes and rounded uprights, put through the
 * Recognise command the way a person would: select the body, run it, and click
 * a row to select what it names. The point of the exercise is the last step of
 * the script, where the same body is exported to STL, brought back in with no
 * history at all, and reads the same.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const rows = () =>
  [...document.querySelectorAll('#inspectorBody button')].map((b) => b.textContent.trim());

/* ---- a plate, drilled ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(400);
document.getElementById('inspectorOk').click();
await wait(500);

const doc = dev.state.doc;
const bore = (d, x, y) => ({
  id: dev.uid ? dev.uid('f') : `f${Math.random().toString(36).slice(2)}`,
  type: 'primitive',
  shape: 'cylinder',
  op: 'cut',
  targets: 'all',
  params: {
    width: '20', depth: '20', height: '60', diameter: String(d), topDiameter: '0',
    centered: true, x: String(x), y: String(y), z: '0'
  }
});
doc.features[0].params.width = '80';
doc.features[0].params.depth = '60';
doc.features[0].params.height = '10';
doc.features.push(bore(6, -25, -15), bore(6, 25, -15), bore(10, -25, 15), bore(10, 25, 15));
dev.rebuildAll();
await wait(700);
report.built = { bodies: dev.bodies.length, errors: dev.state.result.errors.map((e) => e.message) };

/* ---- read it ---- */
dev.setTab('mesh');
await wait(200);
dev.runCommand('recognise');
await wait(500);
report.title = document.getElementById('inspectorTitle')?.textContent;
report.rows = rows();

/* ---- clicking a row selects what it names ---- */
{
  const btns = [...document.querySelectorAll('#inspectorBody button')];
  const six = btns.find((b) => b.textContent.includes('6'));
  six?.click();
  await wait(300);
  report.selectedBySize = dev.state.selection.faces.size;
  report.status = document.getElementById('status')?.textContent;
}
document.getElementById('inspectorOk')?.click();
await wait(300);

/* ---- and it reads the same with no history at all ---- */
{
  const RC = await import('./recognise.js');
  const MU = await import('./meshutil.js');
  const K = await import('./kernel.js');
  const TP = await import('./topology.js');
  const solid = dev.bodies[0].solid;
  const mesh = K.meshData(solid);
  const asBuilt = RC.recognise(mesh, TP.buildTopology(mesh));
  const back = MU.parseSTL(MU.toBinarySTL([mesh]));
  const imported = RC.recognise(back, TP.buildTopology(back));
  report.asBuilt = asBuilt.counts;
  report.imported = imported.counts;
  report.sameAfterRoundTrip =
    asBuilt.counts.holes === imported.counts.holes &&
    asBuilt.holeSizes.length === imported.holeSizes.length;
  report.importedSizes = imported.holeSizes.map((g) => [g.size, g.items.length]);
}

report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
