/**
 * Batch 2 through the real interface: a coil, a web, an embossed label, an
 * aligned block and a filled bore, then every new dialog opened and checked.
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

async function fillInspector(values) {
  await wait(120);
  const inputs = [...document.querySelectorAll('#inspectorBody .field')].map((f) =>
    f.querySelector('input, select')
  );
  values.forEach((v, i) => {
    const el = inputs[i];
    if (!el || v === null) return;
    if (el.type === 'checkbox') {
      el.checked = !!v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'SELECT') {
      el.value = String(v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  document.getElementById('inspectorOk').click();
  await wait(250);
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

const topFaceOf = (rec, z) =>
  rec.topology.faces.find(
    (f) => f.planar && f.normal[2] > 0.99 && (z === undefined || Math.abs(f.centre[2] - z) < 0.01)
  );

/* ---- 1. a shallow tray, so a web has somewhere to live ---- */

await openSketchOn('XY plane');
const sk = dev.state.sketcher;
sk.setTool('centerRectangle');
await clickPlane(0, 0);
await clickPlane(30, 22);
sk.refreshRegions();
sk.selectedRegions.add(sk.regions[0].id);
dev.runCommand('finishSketch');
await wait(300);

dev.runCommand('extrude');
await wait(200);
dev.state.editing.feature.distance = '6';
dev.rebuildAll();
document.getElementById('inspectorOk').click();
await wait(400);
report.tray = Number(dev.bodies[0]?.solid.volume().toFixed(1));
// Remembered by id: once the coil exists, records[0] is no longer the tray.
const trayId = dev.state.records[0].id;
const trayRec = () => dev.state.records.find((r) => r.id === trayId) || dev.state.records[0];

/* ---- 2. a web of two crossing walls on top of it ---- */

{
  const rec = trayRec();
  const top = topFaceOf(rec, 6);
  if (!top) return { ...report, error: 'no top face for the web' };
  dev.state.selection.faces.add(`${rec.id}:${top.id}`);
}
dev.runCommand('newSketch');
await wait(500);
{
  const s2 = dev.state.sketcher;
  s2.setTool('line');
  await clickPlane(-24, 0);
  await clickPlane(24, 0);
  s2.setTool('select');
  s2.setTool('line');
  await clickPlane(0, -16);
  await clickPlane(0, 16);
  s2.setTool('select');
  report.webLines = s2.sketch.entities.filter((e) => e.type === 'line').length;
}
dev.runCommand('finishSketch');
await wait(350);

dev.runCommand('web');
await wait(250);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no web dialog' };
  f.thickness = '2.5';
  f.extentType = 'depth';
  f.depth = '7';
  f.extendCurves = false;
  f.op = 'join';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(500);
report.afterWeb = {
  bodies: dev.bodies.length,
  volume: Number(dev.bodies[0]?.solid.volume().toFixed(1))
};

/* ---- 3. an embossed label on the side wall ---- */

await openSketchOn('XZ plane');
{
  const s3 = dev.state.sketcher;
  s3.setTool('text');
  await clickPlane(-22, 1.5);
  await fillInspector(['ANVIL', 'Arial', '4', 'left', '0', true, false]);
  report.labelLoops = s3.sketch.entities
    .filter((e) => e.type === 'text')
    .reduce((n, e) => n + e.contours.length, 0);
}
dev.runCommand('finishSketch');
await wait(350);

dev.runCommand('emboss');
await wait(300);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no emboss dialog' };
  report.embossArmed = dev.state.editing.pickInto;
  report.embossCallout = document.getElementById('pcMsg').textContent;

  // Point it at the front wall, the one the XZ sketch is parallel to.
  const rec = trayRec();
  const front = rec.topology.faces.find(
    (fc) => fc.planar && fc.normal[1] < -0.99
  );
  if (!front) return { ...report, error: 'no front face' };
  f.seeds = null;
  f.faces = [{ bodyId: rec.id, face: dev.faceReference(front) }];
  f.depth = '0.8';
  f.effect = 'emboss';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(600);
report.afterEmboss = {
  bodies: dev.bodies.length,
  volume: Number(dev.bodies[0]?.solid.volume().toFixed(1)),
  errors: dev.state.result.errors.map((e) => e.message)
};

/* ---- 4. a coil standing beside it ---- */

dev.runCommand('coil');
await wait(300);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no coil dialog' };
  f.plane = 'XY';
  f.coilType = 'revPitch';
  f.diameter = '14';
  f.revolutions = '5';
  f.pitch = '5';
  f.sectionSize = '2.5';
  f.op = 'new';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(600);
report.afterCoil = {
  bodies: dev.bodies.length,
  coilVolume: Number(dev.bodies[dev.bodies.length - 1]?.solid.volume().toFixed(1))
};

/* ---- 5. drill the tray, then fill it back in with Delete Face ---- */

{
  const rec = trayRec();
  const top = topFaceOf(rec, 6);
  dev.state.selection.faces.clear();
  if (top) dev.state.selection.faces.add(`${rec.id}:${top.id}`);
}
dev.runCommand('newSketch');
await wait(500);
{
  const s5 = dev.state.sketcher;
  s5.setTool('circle');
  await clickPlane(20, 14);
  await clickPlane(23, 14);
  s5.refreshRegions();
  for (const r of s5.regions) s5.selectedRegions.add(r.id);
}
dev.runCommand('finishSketch');
await wait(300);
dev.runCommand('extrude');
await wait(250);
{
  const f = dev.state.editing?.feature;
  f.distance = '20';
  f.op = 'cut';
  f.flip = true;
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(500);
const trayBody = () => dev.bodies.find((b) => b.id === trayId) || dev.bodies[0];
report.drilled = { genus: trayBody()?.solid.genus() };

dev.runCommand('deleteFace');
await wait(250);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no delete face dialog' };
  // Search every record: a coil is all curved faces, so the bore is not
  // simply "the round face on body zero".
  let rec = null;
  let bore = null;
  for (const r of dev.state.records) {
    const hit = (r.topology?.faces || []).find(
      (fc) => fc.cylinder && Math.abs(fc.cylinder.radius - 3) < 0.3
    );
    if (hit) {
      rec = r;
      bore = hit;
      break;
    }
  }
  report.boreSearch = dev.state.records.map((r) => ({
    id: r.id,
    faces: r.topology?.faces.length ?? null,
    cylinders: (r.topology?.faces || []).filter((fc) => fc.cylinder).length
  }));
  if (!bore) return { ...report, error: 'no bore found to delete' };
  f.faces = [{ bodyId: rec.id, face: dev.faceReference(bore) }];
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(500);
report.afterDeleteFace = {
  genus: trayBody()?.solid.genus(),
  errors: dev.state.result.errors.map((e) => e.message)
};

/* ---- 6. every new dialog opens ---- */

const dialogs = {};
for (const cmd of ['coil', 'emboss', 'web', 'align', 'deleteFace', 'silhouetteSplit']) {
  dev.runCommand(cmd);
  await wait(200);
  dialogs[cmd] = dev.state.editing
    ? document.getElementById('inspectorTitle').textContent
    : `no dialog (${document.getElementById('status').textContent})`;
  if (dev.state.editing) document.getElementById('inspectorCancel').click();
  await wait(150);
}
report.dialogs = dialogs;

dev.state.vp.setView([0.44, -0.74, 0.5], false);
dev.state.vp.fit(1.5);
dev.setStatus('Coil, web, emboss, delete face.');
await wait(400);


// The ribbon must still fold onto two rows, and a cancelled dialog must not
// leave the origin planes drawn over the model.
report.ribbon = [...document.querySelectorAll('[data-panel="solid"] .group')].map((g) => ({
  label: g.querySelector('.glabel')?.textContent,
  rows: new Set(
    [...g.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top))
  ).size
}));
report.ribbonHeight = Math.round(document.getElementById('ribbon').getBoundingClientRect().height);
// The grouped buttons have to actually open their menu.
{
  const btn = document.querySelector('[data-menu="primitive"]');
  btn.click();
  await wait(120);
  const menu = document.getElementById('markmenu');
  report.primitiveMenu = menu ? [...menu.querySelectorAll('button')].map((b) => b.textContent) : null;
  document.getElementById('markmenu')?.remove();
}
report.planesLeftOn = dev.state.vp.originPlanes
  ? dev.state.vp.originPlanes.visible
  : null;

report.timeline = dev.state.doc.features.map((f) => f.type);
report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
