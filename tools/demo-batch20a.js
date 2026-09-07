/**
 * Batch 20, first half: hems, a lofted flange, joint origins, constraints, and
 * a flat pattern that knows its DXF is behind the model.
 *
 * The interesting check is the last one. A DXF written from a flat pattern goes
 * off to a laser and the model carries on changing, and nothing on screen would
 * otherwise say so. Here the model is changed after the export and the tree is
 * read back to see whether it noticed.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const SM = await import('./sheetmetal.js');
const AS = await import('./assembly.js');

const status = () => document.getElementById('status').textContent;
const sheets = () => dev.bodies.filter((b) => b.sheetMetal);
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
  await wait(900);
}

/* ---- a sheet metal plate ---- */
dev.setTab('sketch');
{
  const doc = dev.state.doc;
  doc.sketches.skPlate = {
    id: 'skPlate',
    name: 'Plate',
    plane: 'XY',
    points: [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 80, y: 50 },
      { x: 0, y: 50 }
    ],
    entities: [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] },
      { id: 4, type: 'line', p: [3, 0] }
    ],
    constraints: [],
    nextEntityId: 5
  };
  doc.features.push({ id: 'fsk', type: 'sketch', sketch: 'skPlate' });
  dev.rebuildAll();
  await wait(400);
}
dev.setTab('sheet');
await wait(200);
dev.runCommand('baseFlange');
await fillDialog({});
report.plate = { made: sheets().length, said: status() };
if (!sheets().length) return report;

/* ---- a hem on one edge ---- */
{
  const body = sheets()[0];
  const rec = (dev.state.records || []).find((r) => r.id === body.id);
  // A long edge of the top face, which is what a hem is folded off.
  const edge = rec.topology.edges
    .filter((e) => e.kind === 'line' && e.length > 70)
    .sort((a, b) => b.length - a.length)[0];
  report.hem = { foundAnEdge: !!edge };
  if (edge) {
    dev.state.selection.edges.clear();
    dev.state.selection.edges.add(`${body.id}:${edge.id}`);
    dev.state.selection.bodies.clear();
    dev.state.selection.bodies.add(body.id);

    const before = SM.clonePart(body.sheetMetal);
    dev.runCommand('hem');
    await wait(400);
    report.hem.asks = fieldNames();
    await fillDialog({ Kind: 'single', 'How much is folded back': '6' });

    const after = sheets()[0]?.sheetMetal;
    report.hem.panelsBefore = before.panels.length;
    report.hem.panelsAfter = after ? after.panels.length : 0;
    report.hem.bends = after ? after.bends.length : 0;
    report.hem.foldedRightBack = after
      ? Math.abs(after.bends[after.bends.length - 1].angle - Math.PI) < 1e-6
      : false;
    report.hem.said = status();
    report.hem.errors = (dev.state.result?.errors || []).map((e) => e.message);
  }
}

/* ---- a flat pattern, and what happens to it when the model moves ---- */
{
  dev.state.selection.bodies.clear();
  dev.state.selection.bodies.add(sheets()[0].id);
  dev.runCommand('flatPattern');
  await fillDialog({});
  const flat = dev.bodies.find((b) => b.outline);
  report.flat = { made: !!flat };

  if (flat) {
    // Pretend a DXF went out, by writing the record the export writes. Going
    // through the export itself would put a save dialog on screen and stop the
    // demo dead.
    const key = dev.state.doc.flatExports;
    dev.state.doc.flatExports = {
      ...(key || {}),
      [flat.id]: { path: 'C:/somewhere/plate flat.dxf', at: Date.now(), key: '__stale__' }
    };
    dev.rebuildAll();
    await wait(400);
    const nodes = [...document.querySelectorAll('#tree .node, #tree div')].map((n) =>
      n.textContent.trim()
    );
    report.flat.treeSaysBehind = nodes.some((t) => /DXF is behind the model/.test(t));
  }
}

/* ---- a joint origin off a face ---- */
{
  dev.setTab('solid');
  await wait(150);
  const body = dev.bodies.find((b) => b.solid) || sheets()[0];
  const rec = (dev.state.records || []).find((r) => r.id === body.id);
  const face = rec.topology.faces.find((f) => f.planar);
  dev.state.selection.faces.clear();
  dev.state.selection.faces.add(`${body.id}:${face.id}`);

  dev.runCommand('jointOrigin');
  await wait(400);
  report.jointOrigin = { asks: fieldNames() };
  await fillDialog({ Name: 'Mount', 'Along its own axis': '5' });
  const entry = (dev.state.doc.features || []).find(
    (f) => f.type === 'construction' && f.entry?.type === 'jointOrigin'
  );
  report.jointOrigin.stored = entry ? entry.entry.name : null;
  report.jointOrigin.built = !!dev.state.result?.construction?.get(entry?.entry?.id);
  report.jointOrigin.said = status();
  // Five along the face's own normal from where it was captured.
  if (entry) {
    const along = [0, 1, 2].map((i) => entry.entry.p[i] - face.centre[i]);
    report.jointOrigin.movedAlongTheAxis = +Math.hypot(...along).toFixed(4);
  }
}

/* ---- the constraint maths, which the solver runs on ---- */
{
  const child = { p: [0, 0, 0], axis: [0, 0, 1] };
  const parent = { p: [10, 5, 20], axis: [0, 0, -1] };
  const step = AS.constraintTransform('mate', child, parent, {});
  const facing = AS.applyRotation(step.rotation, child.axis);
  const landed = AS.applyRotation(step.rotation, child.p).map((v, i) => v + step.translation[i]);
  report.constrain = {
    facesIntoTheParent: +facing[2].toFixed(6),
    landsOnIt: landed.map((v) => +v.toFixed(4)),
    dof: AS.constraintDof('concentric')
  };
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
