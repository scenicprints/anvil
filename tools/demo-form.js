/**
 * Batch 10, session one: the Form tab. Primitives, the topological edits, the
 * three display modes, symmetry, and turning a form into a solid, all through
 * the interface.
 *
 * Runs inside the page via --anvil-script.
 */

const [FM, TOPO] = await Promise.all([
  import('./form.js'),
  import('./topology.js')
]);

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};

async function fillDialog(values = {}) {
  await wait(250);
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
    await wait(150);
  }
  document.getElementById('inspectorOk').click();
  await wait(600);
}

const forms = () => dev.state.result.bodies.filter((b) => b.form);
const solids = () => dev.state.result.bodies.filter((b) => b.solid);
const errs = () => dev.state.result.errors.map((e) => e.message);
const only = (list) => {
  dev.state.selection.bodies.clear();
  for (const b of list) dev.state.selection.bodies.add(b.id);
};
const cageOf = (b) => dev.state.doc.forms[b.form];

/** Select some of a form's cage faces, the way a click in the viewport would. */
function pickFaces(body, howMany, choose) {
  const rec = (dev.state.records || []).find((r) => r.id === body.id);
  dev.state.selection.faces.clear();
  const wanted = (rec?.topology?.faces || []).filter(choose || (() => true));
  for (const f of wanted.slice(0, howMany)) {
    dev.state.selection.faces.add(`${rec.id}:${f.id}`);
  }
  return dev.state.selection.faces.size;
}

/** Select some of a form's cage edges. */
function pickEdges(body, howMany, choose) {
  const rec = (dev.state.records || []).find((r) => r.id === body.id);
  dev.state.selection.edges.clear();
  const wanted = (rec?.topology?.edges || []).filter(choose || (() => true));
  for (const e of wanted.slice(0, howMany)) {
    dev.state.selection.edges.add(`${rec.id}:${e.id}`);
  }
  return dev.state.selection.edges.size;
}

try {

/* ---- 1. the tab, and that the ribbon still fits ---- */

dev.setTab('form');
await wait(300);
{
  const panel = document.querySelector('[data-panel="form"]');
  report.formTabShows = panel?.classList.contains('active') || false;
  report.formButtons = [...panel.querySelectorAll('button[data-cmd]')].map(
    (b) => b.dataset.cmd
  );
  report.formMenus = [...panel.querySelectorAll('button[data-menu]')].map(
    (b) => b.dataset.menu
  );
  report.groupHeights = [...panel.querySelectorAll('.group')].map((g) =>
    Math.round(g.getBoundingClientRect().height)
  );
  report.ribbonHeight = Math.round(
    document.getElementById('ribbon').getBoundingClientRect().height
  );
  report.tabs = [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim());
}

/* ---- 2. a quadball, which is the one to start round shapes from ---- */

dev.runCommand('formQuadball');
await fillDialog({ Radius: '25', 'Faces per side': '2', X: '-70', Display: 'smooth' });
report.quadballErrors = errs();
report.afterQuadball = { forms: forms().length };
if (forms().length) {
  const cage = cageOf(forms()[0]);
  report.cage = { points: cage.points.length, faces: cage.faces.length };
  report.hasOverlay = !!forms()[0].overlayMesh;
}

/* ---- 3. one cage face is one selectable face ---- */

{
  const body = forms()[0];
  const rec = (dev.state.records || []).find((r) => r.id === body.id);
  report.selectableFaces = rec?.topology?.faces.length ?? null;
  report.cageFaces = cageOf(body).faces.length;
}

/* ---- 4. subdivide some faces, then insert an edge loop ---- */

{
  const body = forms()[0];
  only([body]);
  report.picked = pickFaces(body, 2);
  dev.runCommand('formSubdivide');
  await wait(500);
  report.subdivideMessage = document.getElementById('status').textContent;
  report.afterSubdivide = cageOf(forms()[0]).faces.length;
  report.stillClosed = FM.boundaryLoops(cageOf(forms()[0])).length === 0;
}

{
  const body = forms()[0];
  only([body]);
  report.pickedEdge = pickEdges(body, 1);
  dev.runCommand('formInsertEdge');
  await wait(500);
  report.insertEdgeMessage = document.getElementById('status').textContent;
  report.afterInsertEdge = cageOf(forms()[0]).faces.length;
}

/* ---- 5. crease a few edges ---- */

{
  const body = forms()[0];
  only([body]);
  report.pickedCrease = pickEdges(body, 4);
  dev.runCommand('formCrease');
  await wait(500);
  report.creaseMessage = document.getElementById('status').textContent;
  report.creases = Object.keys(cageOf(forms()[0]).creases).length;
}

/* ---- 6. the three display modes ---- */

{
  const modes = {};
  for (const [cmd, name] of [
    ['formDisplayBox', 'box'],
    ['formDisplaySmooth', 'smooth'],
    ['formDisplayControl', 'control']
  ]) {
    only([forms()[0]]);
    dev.runCommand(cmd);
    await wait(500);
    const b = forms()[0];
    modes[name] = {
      tris: b.sheet.triVerts.length / 3,
      overlay: !!b.overlayMesh
    };
  }
  report.displayModes = modes;
}

/* ---- 7. a second form: a box, made symmetric, with a hole cut and filled --- */

dev.setTab('form');
dev.runCommand('formBox');
await fillDialog({ Width: '40', Depth: '40', Height: '40', 'Faces across X': '2', Display: 'control' });
report.boxErrors = errs();
report.formCount = forms().length;

{
  const box = forms()[forms().length - 1];
  only([box]);
  report.deletePicked = pickFaces(box, 1);
  dev.runCommand('formDelete');
  await wait(500);
  const after = forms().find((b) => b.form === box.form);
  report.afterDelete = {
    faces: cageOf(after).faces.length,
    holes: FM.boundaryLoops(cageOf(after)).length
  };

  only([after]);
  dev.runCommand('formFillHole');
  await wait(500);
  const filled = forms().find((b) => b.form === box.form);
  report.afterFill = {
    faces: cageOf(filled).faces.length,
    holes: FM.boundaryLoops(cageOf(filled)).length
  };

  only([filled]);
  dev.runCommand('formMirror');
  await wait(600);
  report.mirrorMessage = document.getElementById('status').textContent;
  const mirrored = forms().find((b) => b.form === box.form);
  report.symmetry = cageOf(mirrored).symmetry?.kind ?? null;
  {
    const xs = cageOf(mirrored).points.map((p) => +p[0].toFixed(5));
    report.symmetric = xs.every((x) => xs.includes(-x));
  }

  only([mirrored]);
  dev.runCommand('formUniform');
  await wait(500);
  report.uniformMessage = document.getElementById('status').textContent;
}

/* ---- 8. finish the quadball into a solid ---- */

{
  const ball = forms()[0];
  only([ball]);
  dev.runCommand('finishForm');
  await fillDialog({ Smoothness: '3' });
  report.finishErrors = errs();
  report.afterFinish = { forms: forms().length, solids: solids().length };
  if (solids().length) {
    report.solidVolume = Math.round(solids()[0].solid.volume());
    report.solidGenus = solids()[0].solid.genus();
  }
}

/* ---- 9. and an open form, thickened rather than finished ---- */

dev.setTab('form');
dev.runCommand('formPlane');
await fillDialog({ Width: '50', Depth: '50', 'Faces across': '3', 'Faces along': '3', X: '70', Display: 'smooth' });
{
  const sheet = forms()[forms().length - 1];
  only([sheet]);
  dev.runCommand('formThicken');
  await fillDialog({ Thickness: '3' });
  report.thickenErrors = errs();
  report.afterThicken = { forms: forms().length, solids: solids().length };
}

/* ---- the picture ---- */

dev.setTab('form');
only([]);
dev.state.vp.setSelection(dev.state.selection.bodies);
await wait(200);
dev.state.vp.setView([0.45, -1, 0.4], false, [0, 0, 1]);
dev.state.vp.fit(1.2);
dev.setStatus('Form: a quadball shaped and finished, a mirrored box, and a thickened sheet.');
await wait(500);
report.finalErrors = errs();
report.finalBodies = { forms: forms().length, solids: solids().length };
void TOPO;
} catch (err) {
  report.threw = String(err && err.message);
  report.where = String(err && err.stack).split(/\n/).slice(0, 4).join(' | ');
}
return report;
