/**
 * Naming a selection so it survives the rebuild that renumbers everything.
 *
 * The reason to have these is a thirty edge fillet. Picking those edges once is
 * a chore; picking them again after an earlier dimension has changed is why
 * people stop editing parts. What is stored is references, not indices: an
 * index is a position in this rebuild's topology and means nothing after the
 * next one.
 *
 * So: pick some edges, save them, change a dimension underneath so the whole
 * topology is rebuilt, and check the set still brings back the same edges. Then
 * check the honest half of it, which is that a set whose geometry has gone says
 * how much it lost rather than quietly coming back short.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const canvas = document.getElementById('view');
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

const sel = () => dev.state.selection;
const edgeKeys = () => [...sel().edges].sort();

/** The world midpoint of every selected edge, which is what actually has to come back. */
function selectedEdgeMidpoints() {
  return edgeKeys()
    .map((k) => {
      const i = k.lastIndexOf(':');
      const rec = (dev.state.records || []).find((r) => r.id === k.slice(0, i));
      const e = rec?.topology?.edges[Number(k.slice(i + 1))];
      return e?.refPoint ? e.refPoint.map((n) => +n.toFixed(2)).join(',') : null;
    })
    .filter(Boolean)
    .sort();
}

/* ---- a box, and the four edges round its top ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(500);
{
  // Through the dialog, so the box is the size this demo expects.
  const rowFor = (t) =>
    [...document.querySelectorAll('#inspectorBody .field')].find((r) => r.textContent.includes(t));
  for (const [label, value] of [['Width', '40'], ['Depth', '40'], ['Height', '20']]) {
    const input = rowFor(label)?.querySelector('input');
    if (!input) return { ...report, stuckAt: `no ${label} row` };
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(150);
  }
}
document.getElementById('inspectorOk').click();
await wait(900);
dev.state.vp.fit(1.7);
await wait(300);

// A record carries the mesh and the topology; the kernel solid is on the body.
const topOfPart = () => dev.bodies[0].solid.boundingBox().max[2];
const topEdges = () => {
  const top = topOfPart();
  return dev.state.records[0].topology.edges.filter(
    (e) => e.kind === 'line' && Math.abs(e.refPoint[2] - top) < 0.01
  );
};

{
  const rec = dev.state.records[0];
  for (const e of topEdges()) {
    sel().edges.add(`${rec.id}:${rec.topology.edges.indexOf(e)}`);
  }
  report.pickedCount = sel().edges.size;
  report.pickedMidpoints = selectedEdgeMidpoints();
}

/* ---- save it ---- */
dev.runCommand('createSelectionSet');
await wait(400);
report.promptOpened = !document.getElementById('modal').classList.contains('hidden');
{
  const input = document.querySelector('#modalBody input');
  report.promptHasAName = input?.value ?? null;
  if (input) input.value = 'Top rim';
  document.getElementById('modalOk').click();
  await wait(400);
}
report.setsInDoc = (dev.state.doc.selectionSets || []).map((s) => s.name);
report.savedByReference = (dev.state.doc.selectionSets?.[0]?.edges || []).every(
  (x) => !!x.edge && typeof x.edge === 'object'
);
report.treeShowsIt = [...document.querySelectorAll('#tree .node')].some((n) =>
  n.textContent.includes('Top rim')
);

/* ---- change a dimension underneath, which renumbers the whole topology ---- */
{
  const rec = dev.state.records[0];
  const before = rec.topology.edges.length;

  // A fillet on the four uprights: the corners of the top rim are rounded off,
  // so every edge in the model is renumbered and there are more of them than
  // there were. The top rim itself stays four straight edges, shorter than
  // before, which is the case worth testing. Rounding every edge instead would
  // delete the rim outright, and a set cannot bring back what is not there.
  const uprights = rec.topology.edges
    .filter((e) => e.kind === 'line' && Math.abs(e.dir?.[2] ?? 0) > 0.99)
    .map((e) => dev.edgeReference(e, rec.topology));
  dev.state.doc.features.push({
    id: 'f_demo_fillet',
    type: 'fillet',
    bodies: 'all',
    sets: [{ edges: uprights, all: false, radius: '4', filletType: 'constant' }]
  });
  // And taller, so the rim is not where it was either.
  dev.state.doc.features.find((f) => f.type === 'primitive').params.height = '35';

  dev.rebuildAll();
  await wait(1800);
  report.edgesBefore = before;
  report.edgesAfter = dev.state.records[0]?.topology?.edges.length ?? null;
  report.topologyReallyChanged = report.edgesAfter !== report.edgesBefore;
  report.rimIsStillThere = topEdges().length;
}

/* ---- and the set still finds the same places ---- */
{
  sel().edges.clear();
  const set = dev.state.doc.selectionSets[0];
  // Through the tree row, because that is the only way a person reaches it.
  const node = [...document.querySelectorAll('#tree .node')].find((n) =>
    n.textContent.includes('Top rim')
  );
  report.foundTheRow = !!node;
  if (node) node.click();
  await wait(500);
  report.restoredCount = sel().edges.size;
  report.restoredMidpoints = selectedEdgeMidpoints();
  report.statusAfterRestore = document.getElementById('status')?.textContent ?? null;
  report.setNameKept = set.name === 'Top rim';
}

// The box grew taller and got rounded corners, so the top rim is at a new
// height and there are more edges in the model than there were. Four edges
// should still come back, and they should be the ones round the top.
report.foundFourAgain = report.restoredCount === 4;
{
  const rec = dev.state.records[0];
  const top = topOfPart();
  report.allAtTheTop = [...sel().edges].every((k) => {
    const i = k.lastIndexOf(':');
    const e = rec.topology.edges[Number(k.slice(i + 1))];
    return e && Math.abs(e.refPoint[2] - top) < 0.01;
  });
  report.topIsWhereItMovedTo = Number(top.toFixed(2));
}

/* ---- a set pointing at a body that is gone says so ---- */
{
  dev.state.doc.selectionSets.push({
    id: 's_ghost',
    name: 'Ghost',
    bodies: ['no-such-body'],
    faces: [],
    edges: [{ bodyId: 'no-such-body', edge: { kind: 'line', length: 999 } }]
  });
  // The tree is only redrawn when something changes it, so save a throwaway set
  // to get a redraw the way a person would.
  dev.runCommand('createSelectionSet');
  await wait(300);
  document.getElementById('modalOk').click();
  await wait(400);
  dev.state.selection.edges.clear();
  const ghostRow = [...document.querySelectorAll('#tree .node')].find((n) =>
    n.textContent.includes('Ghost')
  );
  if (ghostRow) ghostRow.click();
  await wait(400);
  report.ghostStatus = document.getElementById('status')?.textContent ?? null;
  report.saysWhatItLost = /no longer in the model/.test(report.ghostStatus || '');
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
