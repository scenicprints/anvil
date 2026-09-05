/**
 * Batch 6 through the real interface: a fillet put on one of four identical
 * bosses stays on that boss when the spacing is edited, and Split Face divides
 * a face without changing the shape.
 *
 * Runs inside the page via --anvil-script.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};

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

/* ---- a plate with four bosses, driven by a parameter ---- */

dev.state.doc.parameters = [{ name: 'pitch', expr: '20' }];

dev.runCommand('primBox');
await wait(250);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no box dialog' };
  Object.assign(f.params, {
    width: 'pitch * 5', depth: '40', height: '10',
    centered: false, x: '-pitch * 2.5', y: '-20', z: '0'
  });
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(350);

for (let i = 0; i < 4; i++) {
  dev.runCommand('primCyl');
  await wait(220);
  const f = dev.state.editing?.feature;
  Object.assign(f.params, {
    diameter: '12', height: '8', centered: false,
    x: `pitch * ${i + 1} - pitch * 2.5`, y: '0', z: '10'
  });
  f.op = 'join';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
  await wait(280);
}
report.builtVolume = Number(dev.bodies[0]?.solid.volume().toFixed(1));

/** The top faces of the bosses, left to right. */
const bossTops = () => {
  const rec = dev.state.records[0];
  return rec.topology.faces
    .filter((f) => f.planar && f.normal[2] > 0.99 && Math.abs(f.centre[2] - 18) < 0.01)
    .sort((a, b) => a.centre[0] - b.centre[0]);
};

report.bosses = bossTops().length;
report.bossSourcesDistinct = new Set(bossTops().map((f) => f.src?.tag)).size;

/* ---- fillet the third boss, by clicking its edge ---- */

{
  const rec = dev.state.records[0];
  const edge = rec.topology.edges
    .filter((e) => e.kind === 'circle' && Math.abs(e.centre[2] - 18) < 0.01)
    .sort((a, b) => Math.abs(a.centre[0] - 10) - Math.abs(b.centre[0] - 10))[0];
  if (!edge) return { ...report, error: 'no boss edge found' };
  dev.state.selection.edges.add(`${rec.id}:${edge.id}`);
}
dev.runCommand('fillet');
await wait(280);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no fillet dialog' };
  f.sets[0].radius = '2';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(400);
dev.state.selection.edges.clear();

const filletFeature = dev.state.doc.features.find((f) => f.type === 'fillet');
report.filletRef = filletFeature?.sets?.[0]?.edges?.[0]?.between ?? null;

/**
 * Which boss got rounded: the one whose top has lost area against a full disc.
 * Picking the smallest face outright finds the slivers a blend leaves behind.
 */
function filletedBossIndex(pitch) {
  const rec = dev.state.records[0];
  const full = Math.PI * 36;
  let worst = 0;
  let which = null;
  for (let i = 0; i < 4; i++) {
    const x = pitch * (i + 1) - pitch * 2.5;
    const area = rec.topology.faces
      .filter(
        (f) =>
          f.planar &&
          f.normal[2] > 0.99 &&
          Math.abs(f.centre[2] - 18) < 0.01 &&
          Math.abs(f.centre[0] - x) < 6
      )
      .reduce((sum, f) => sum + f.area, 0);
    const lost = full - area;
    if (lost > worst) {
      worst = lost;
      which = i;
    }
  }
  return which;
}
report.filletedIndexAtStart = filletedBossIndex(20);

/* ---- now edit the parameter and watch it hold ---- */

const sweep = [];
for (const pitch of [24, 30, 44, 60]) {
  dev.state.doc.parameters[0].expr = String(pitch);
  dev.rebuildAll();
  await wait(300);
  sweep.push({
    pitch,
    filletedIndex: filletedBossIndex(pitch),
    errors: dev.state.result.errors.length
  });
}
report.sweep = sweep;
report.stayedOnTheThird = sweep.every((s) => s.filletedIndex === 2);

/* ---- Split Face, which this is what made possible ---- */

dev.state.doc.parameters[0].expr = '30';
dev.rebuildAll();
await wait(300);
const beforeSplit = {
  volume: Number(dev.bodies[0].solid.volume().toFixed(2)),
  faces: dev.state.records[0].topology.faces.length
};

dev.runCommand('splitFace');
await wait(280);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no split face dialog' };
  f.plane = 'YZ';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(400);

report.splitFace = {
  before: beforeSplit,
  afterVolume: Number(dev.bodies[0].solid.volume().toFixed(2)),
  afterFaces: dev.state.records[0].topology.faces.length,
  shapeUnchanged:
    Math.abs(dev.bodies[0].solid.volume() - beforeSplit.volume) < 0.01
};

dev.state.vp.setView([0.35, -0.75, 0.55], false);
dev.state.vp.fit(1.35);
dev.setStatus('A fillet that stays where it was put, and a split face.');
await wait(400);
report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
