/**
 * Batch 4 through the real interface: a section cut open, the centre of mass,
 * an interference check, and draft colouring, on a part with a bore and a
 * pocket so there is an inside worth seeing.
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
  await wait(150);
  const rows = [...document.querySelectorAll('#inspectorBody .field')].map((f) =>
    f.querySelector('input, select')
  );
  values.forEach((v, i) => {
    const el = rows[i];
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
  await wait(300);
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

/* ---- a shelled box with a bore, so a section shows something ---- */

dev.runCommand('primBox');
await wait(250);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no box dialog' };
  Object.assign(f.params, {
    width: '50', depth: '34', height: '22', centered: true, x: '0', y: '0', z: '0'
  });
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(400);

// Hollow it, leaving the top open.
{
  const rec = dev.state.records[0];
  const top = rec.topology.faces.find((fc) => fc.planar && fc.normal[2] > 0.99);
  dev.state.selection.faces.add(`${rec.id}:${top.id}`);
}
dev.runCommand('shell');
await wait(250);
{
  const f = dev.state.editing?.feature;
  if (f) {
    f.thickness = '3';
    dev.rebuildAll();
    document.getElementById('inspectorOk').click();
  }
}
await wait(400);
report.shelled = Number(dev.bodies[0]?.solid.volume().toFixed(1));

/* ---- centre of mass, and what it weighs ---- */

dev.state.selection.faces.clear();
dev.runCommand('centreOfMass');
await wait(250);
report.massDialog = document.getElementById('inspectorTitle').textContent;
report.massNote = [...document.querySelectorAll('#inspectorBody .hint')].map((n) => n.textContent);
await fillInspector(['pla']);
report.massStatus = document.getElementById('status').textContent;
report.massCentre = dev.state.massMarker?.map((n) => Number(n.toFixed(2)));

/* ---- interference: drop a peg through the wall ---- */

dev.runCommand('primCyl');
await wait(250);
{
  const f = dev.state.editing?.feature;
  Object.assign(f.params, {
    diameter: '10', height: '40', centered: true, x: '25', y: '0', z: '0'
  });
  f.op = 'new';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(400);
report.bodies = dev.bodies.length;

dev.runCommand('interference');
await wait(300);
report.interferenceTitle = document.getElementById('inspectorTitle').textContent;
report.interferenceNotes = [...document.querySelectorAll('#inspectorBody .hint')].map(
  (n) => n.textContent
);
report.interferenceStatus = document.getElementById('status').textContent;
document.getElementById('inspectorOk').click();
await wait(200);

/* ---- draft analysis ---- */

dev.runCommand('draftAnalysis');
await wait(250);
await fillInspector([null, '3', false]);
report.draftOn = !!dev.state.draft;
report.colouredBodies = dev.state.records.filter((r) => r.vertexColours).length;

// Off again, and the ordinary colour must come back.
dev.runCommand('clearAnalysis');
await wait(300);
report.colouredAfterClear = dev.state.records.filter((r) => r.vertexColours).length;

/* ---- the surface analyses ---- */

const faceAnalyses = {};
for (const [cmd, values] of [
  ['curvatureMap', []],
  ['minimumRadius', ['1']],
  ['zebraAnalysis', [null, '14']],
  ['accessibility', [null, false]],
  ['environmentMap', []]
]) {
  dev.runCommand(cmd);
  await wait(250);
  const title = document.getElementById('inspectorTitle').textContent;
  await fillInspector(values);
  faceAnalyses[cmd] = {
    title,
    kind: dev.state.faceAnalysis?.kind ?? null,
    coloured: dev.state.records.filter((r) => r.vertexColours).length,
    chrome: dev.state.records.filter((r) => r.chrome).length
  };
}
report.faceAnalyses = faceAnalyses;

// A comb along the model's own edges.
dev.runCommand('selectAllEdges');
await wait(200);
dev.runCommand('curvatureComb');
await wait(250);
await fillInspector(['40', '1']);
report.comb = {
  edges: dev.state.comb?.length ?? 0,
  status: document.getElementById('status').textContent
};

report.combDrawn = dev.state.analysisGroup?.children.length ?? 0;

dev.runCommand('clearAnalysis');
await wait(300);
report.combDrawnAfterClear = dev.state.analysisGroup?.children.length ?? 0;
report.clearedEverything =
  !dev.state.faceAnalysis && !dev.state.comb && !dev.state.draft && !dev.state.section;
dev.state.selection.edges.clear();

/* ---- and the section, which is what the shot is for ---- */

dev.runCommand('sectionAnalysis');
await wait(250);
// Flipped, so the half kept is the one with the floor in it and the shot
// shows the wall thickness and the base rather than an open frame.
await fillInspector([null, '0', true]);
report.sectionOn = !!dev.state.section;
report.sectionedBodies = dev.state.records.filter((r) => r.displayMesh).length;

// The cut is a view, so the real body has to be the same size as before.
report.volumeUnderSection = Number(dev.bodies[0]?.solid.volume().toFixed(1));
report.modelUnchanged = report.volumeUnderSection === report.shelled;

dev.state.vp.setView([0.42, -0.72, 0.55], false);
dev.state.vp.fit(1.5);
dev.setStatus('Section, mass, interference and draft.');
await wait(400);
report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
