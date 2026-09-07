/**
 * Choosing things, through the interface.
 *
 * A plate with four small bores and one large one, which is the shape an
 * imported part has: a handful of faces worth caring about among many that are
 * not. Each rule is run the way a person would run it and checked against what
 * the topology actually holds.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const K = await import('./kernel.js');
const TP = await import('./topology.js');

const faces = () => dev.state.selection.faces.size;
const record = () => (dev.state.records || [])[0];

/* ---- a plate with five bores, four alike ---- */
const doc = dev.state.doc;
const bore = (d, x, y) => ({
  id: `b${x}_${y}_${d}`, type: 'primitive', shape: 'cylinder', op: 'cut', targets: 'all',
  params: { width: '20', depth: '20', height: '60', diameter: String(d), topDiameter: '0',
    centered: true, x: String(x), y: String(y), z: '0' }
});
doc.features = [
  { id: 'plate', type: 'primitive', shape: 'box', op: 'new', targets: 'all',
    params: { width: '80', depth: '80', height: '10', diameter: '20', topDiameter: '0',
      centered: true, x: '0', y: '0', z: '0' } },
  bore(6, -25, -25), bore(6, 25, -25), bore(6, -25, 25), bore(6, 25, 25),
  bore(16, 0, 0)
];
dev.rebuildAll();
await wait(900);
report.built = { bodies: dev.bodies.length, errors: dev.state.result.errors.map((e) => e.message) };
report.faceCount = record().topology.faces.length;

const bores = record().topology.faces
  .map((f, i) => ({ f, i }))
  .filter(({ f }) => f.cylinder);
report.boreCount = bores.length;

/* ---- select similar: one small bore should offer the other three ---- */
{
  const small = bores.find(({ f }) => Math.abs(f.cylinder.radius - 3) < 0.4);
  dev.state.selection.faces.clear();
  dev.state.selection.faces.add(`${record().id}:${small.i}`);
  dev.runCommand('selectSimilar');
  await wait(300);
  report.similar = { chosen: faces(), status: document.getElementById('status')?.textContent };
}

/* ---- grow and shrink ---- */
{
  dev.state.selection.faces.clear();
  dev.state.selection.faces.add(`${record().id}:0`);
  dev.runCommand('selectGrow');
  await wait(250);
  const grown = faces();
  dev.runCommand('selectShrink');
  await wait(250);
  report.growShrink = { grown, shrunk: faces() };
}

/* ---- invert ---- */
{
  dev.state.selection.faces.clear();
  dev.state.selection.faces.add(`${record().id}:0`);
  dev.runCommand('selectInvert');
  await wait(250);
  report.invert = { chosen: faces(), of: report.faceCount };
}

/* ---- by size, through its dialog ---- */
{
  dev.state.selection.faces.clear();
  dev.state.selection.bodies.clear();
  dev.state.selection.bodies.add(record().id);
  dev.runCommand('selectBySize');
  await wait(400);
  report.bySizeDialog = document.getElementById('inspectorTitle')?.textContent;
  const inputs = [...document.querySelectorAll('#inspectorBody input')];
  if (inputs.length >= 2) {
    inputs[0].value = '0';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = '200';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
  }
  document.getElementById('inspectorOk').click();
  await wait(400);
  report.bySize = { chosen: faces(), status: document.getElementById('status')?.textContent };
}

/* ---- priority stops a click landing on the wrong kind ---- */
{
  dev.runCommand('priorityEdge');
  await wait(150);
  report.priority = dev.state.selectPriority;
  dev.runCommand('priorityAuto');
  await wait(150);
}

/* ---- isolate and back ---- */
{
  dev.state.selection.bodies.clear();
  dev.state.selection.bodies.add(record().id);
  dev.runCommand('isolate');
  await wait(400);
  report.isolatedHidden = dev.state.hiddenBodies.size;
  dev.runCommand('unisolate');
  await wait(400);
  report.afterUnisolate = dev.state.hiddenBodies.size;
}

/* ---- dragging a box over the model takes what is in it ---- */
{
  const canvas = document.getElementById('view');
  dev.state.selection.faces.clear();
  dev.state.selection.edges.clear();
  dev.state.vp.fit(1.5);
  await wait(400);

  const r = canvas.getBoundingClientRect();
  const at = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, bubbles: true, cancelable: true });
  // From well outside the model, rightwards and down across the whole of it,
  // which is the window case: everything wholly inside.
  const x0 = r.left + 8;
  const y0 = r.top + 8;
  const x1 = r.right - 8;
  const y1 = r.bottom - 8;
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at(x0, y0), button: 0, buttons: 1 }));
  await wait(120);
  report.bandStarted = !!dev.state.band;
  for (let i = 1; i <= 4; i++) {
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      ...at(x0 + ((x1 - x0) * i) / 4, y0 + ((y1 - y0) * i) / 4), buttons: 1
    }));
    await wait(60);
  }
  report.bandBox = document.querySelector('.sk-band') ? 'drawn' : 'missing';
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...at(x1, y1), button: 0, buttons: 0 }));
  await wait(300);
  report.window = {
    faces: dev.state.selection.faces.size,
    edges: dev.state.selection.edges.size,
    status: document.getElementById('status')?.textContent,
    bandGone: !document.querySelector('.sk-band')
  };

  // The same drag the other way is the crossing case, and takes at least as
  // much because touching is a weaker test than containing.
  dev.state.selection.faces.clear();
  dev.state.selection.edges.clear();
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at(x1, y1), button: 0, buttons: 1 }));
  await wait(120);
  for (let i = 1; i <= 4; i++) {
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      ...at(x1 - ((x1 - x0) * i) / 4, y1 - ((y1 - y0) * i) / 4), buttons: 1
    }));
    await wait(60);
  }
  report.crossingDashed = !!document.querySelector('.sk-band.crossing');
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...at(x0, y0), button: 0, buttons: 0 }));
  await wait(300);
  report.crossing = {
    faces: dev.state.selection.faces.size,
    status: document.getElementById('status')?.textContent
  };
}

report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
