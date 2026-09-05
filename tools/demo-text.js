/**
 * The new sketch tools through the real interface: text traced from a font,
 * an ellipse, and a circular sketch pattern, all built into one part.
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

/** Fill the generic inspector form by field order and accept it. */
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

/* ---- 1. a plate ---- */

await openSketchOn('XY plane');
const sk = dev.state.sketcher;
sk.setTool('centerRectangle');
await clickPlane(0, 0);
await clickPlane(35, 20);
sk.refreshRegions();
sk.selectedRegions.add(sk.regions[0].id);
dev.runCommand('finishSketch');
await wait(300);

dev.runCommand('extrude');
await wait(200);
dev.state.editing.feature.distance = '5';
dev.rebuildAll();
document.getElementById('inspectorOk').click();
await wait(400);
report.plate = Number(dev.bodies[0]?.solid.volume().toFixed(1));

/* ---- 2. text on the top face, raised ---- */

const rec = dev.state.records[0];
const top = rec.topology.faces.find((f) => f.planar && f.normal[2] > 0.99);
if (!top) return { ...report, error: 'no top face' };
dev.state.selection.faces.add(`${rec.id}:${top.id}`);
dev.runCommand('newSketch');
await wait(500);

const sk2 = dev.state.sketcher;
sk2.setTool('text');
await clickPlane(-26, -4);
// The tool asks for the wording after the click, in the ordinary field form.
await fillInspector(['ANVIL', 'Arial', '11', 'left', '0', true, false]);

report.textEntities = sk2.sketch.entities.filter((e) => e.type === 'text').length;
report.textLoops = sk2.sketch.entities
  .filter((e) => e.type === 'text')
  .reduce((n, e) => n + e.contours.length, 0);
sk2.refreshRegions();
report.textRegions = sk2.regions.length;
report.textRegionHoles = sk2.regions.map((r) => r.holes.length);
// Carry every letter out, so the extrude has something to work from.
for (const r of sk2.regions) sk2.selectedRegions.add(r.id);

dev.runCommand('finishSketch');
await wait(350);
dev.runCommand('extrude');
await wait(250);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no extrude dialog for the text' };
  f.distance = '1.2';
  f.op = 'join';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(500);
report.afterText = {
  bodies: dev.bodies.length,
  volume: Number(dev.bodies[0]?.solid.volume().toFixed(1)),
  genus: dev.bodies[0]?.solid.genus()
};

/* ---- 3. an ellipse and a circular sketch pattern, cut through ---- */

const rec2 = dev.state.records[0];
const top2 = rec2.topology.faces.find(
  (f) => f.planar && f.normal[2] > 0.99 && Math.abs(f.centre[2] - 5) < 0.01
);
dev.state.selection.faces.clear();
if (top2) dev.state.selection.faces.add(`${rec2.id}:${top2.id}`);
else dev.state.selection.bodies.add(rec2.id);
dev.runCommand('newSketch');
await wait(500);

const sk3 = dev.state.sketcher;
sk3.setTool('ellipse');
await clickPlane(0, 11);
await clickPlane(9, 11);
await clickPlane(0, 15);
report.ellipses = sk3.sketch.entities.filter((e) => e.type === 'ellipse').length;

// One small circle, then turned about the middle into a ring of six.
sk3.setTool('circle');
await clickPlane(-14, 0);
await clickPlane(-12, 0);
sk3.selection.clear();
const circ = sk3.sketch.entities.find((e) => e.type === 'circle');
sk3.selection.add(`e${circ.id}`);
dev.runCommand('sketchPatternCirc');
await fillInspector(['6', '360', '0', '0']);
report.circles = sk3.sketch.entities.filter((e) => e.type === 'circle').length;

sk3.refreshRegions();
for (const r of sk3.regions) sk3.selectedRegions.add(r.id);
dev.runCommand('finishSketch');
await wait(350);

dev.runCommand('extrude');
await wait(250);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no extrude dialog for the cut' };
  f.distance = '10';
  f.op = 'cut';
  f.flip = true;
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
}
await wait(600);

report.final = {
  bodies: dev.bodies.length,
  volume: Number(dev.bodies[0]?.solid.volume().toFixed(1)),
  genus: dev.bodies[0]?.solid.genus(),
  tris: dev.bodies[0]?.solid.numTri()
};
report.errors = dev.state.result.errors.map((e) => e.message);

dev.state.vp.setView([0.42, -0.72, 0.55], false);
dev.state.vp.fit(1.5);
dev.setStatus('Text, ellipse and a circular sketch pattern.');
await wait(500);
return report;
