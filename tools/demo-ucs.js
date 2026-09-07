/**
 * The rest of Batch 18, through the interface.
 *
 * A coordinate system built from two world axes, a sketch drawn on one of its
 * planes and extruded to prove the frame is really where it says it is, a spun
 * profile taken off a hex bar, and a form cage broken on purpose and repaired.
 *
 * The spun profile is the one worth watching. A hexagon's corners all sit at
 * one radius, so a profile read off the points would call a solid bar a hollow
 * tube; the check here is that it comes back solid.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const AN = await import('./analysis.js');
const FM = await import('./form.js');
const K = await import('./kernel.js');

const notes = () =>
  [...document.querySelectorAll('#inspectorBody .hint')].map((n) => n.textContent.trim());
const fieldNames = () =>
  [...document.querySelectorAll('#inspectorBody .field label')].map((n) => n.textContent.trim());
const options = (label) => {
  const rows = [...document.querySelectorAll('#inspectorBody .field')];
  const row = rows.find((r) => r.querySelector('label')?.textContent.trim() === label);
  return [...(row?.querySelectorAll('option') || [])].map((o) => o.textContent.trim());
};
const setField = (label, value) => {
  const rows = [...document.querySelectorAll('#inspectorBody .field')];
  const row = rows.find((r) => r.querySelector('label')?.textContent.trim() === label);
  const input = row?.querySelector('input, select');
  if (!input) return false;
  if (input.type === 'checkbox') input.checked = !!value;
  else input.value = String(value);
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return true;
};

/* ---- a coordinate system, and its planes in the dropdowns ---- */
dev.setTab('solid');
{
  const doc = dev.state.doc;
  doc.features.push({
    id: 'fucs',
    type: 'construction',
    entry: {
      id: 'ucs1',
      name: 'Fixture',
      type: 'ucs',
      axisX: { worldAxis: 'y' },
      axisY: { worldAxis: 'z' }
    }
  });
  dev.rebuildAll();
  await wait(500);

  const built = dev.state.result.construction.get('ucs1');
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  report.ucs = built
    ? {
        square: [
          +dot(built.x, built.y).toFixed(9),
          +dot(built.y, built.z).toFixed(9),
          +dot(built.z, built.x).toFixed(9)
        ],
        planes: ['xy', 'xz', 'yz'].map((k) => dev.state.result.construction.get(`ucs1/${k}`)?.name),
        axes: ['x', 'y', 'z'].map((k) => dev.state.result.construction.get(`ucs1/${k}`)?.kind)
      }
    : null;
}

/* ---- a hex bar, and its spun profile ---- */
{
  const doc = dev.state.doc;
  const R = 5 / Math.cos(Math.PI / 6);
  const sk = {
    id: 'skhex',
    name: 'Hex',
    plane: 'XY',
    points: [],
    entities: [],
    constraints: [],
    nextEntityId: 7
  };
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    sk.points.push({ x: R * Math.cos(a), y: R * Math.sin(a) });
  }
  for (let i = 0; i < 6; i++) sk.entities.push({ id: i + 1, type: 'line', p: [i, (i + 1) % 6] });
  doc.sketches[sk.id] = sk;
  doc.features.push(
    { id: 'fsk', type: 'sketch', sketch: sk.id },
    { id: 'fex', type: 'extrude', sketch: sk.id, distance: '30', direction: 'one' }
  );
  dev.rebuildAll();
  await wait(600);

  const body = dev.bodies.find((b) => b.solid);
  const got = body
    ? AN.spunProfile(K.meshData(body.solid), { origin: [0, 0, 0], dir: [0, 0, 1] })
    : null;
  report.spun = got
    ? {
        hollow: got.hollow,
        maxRadius: +got.maxRadius.toFixed(4),
        acrossCorners: +R.toFixed(4),
        length: +got.length.toFixed(3),
        outlineClosesOnTheAxis: got.loop[0][1] === 0 && got.loop[got.loop.length - 1][1] === 0
      }
    : null;
}

/* ---- the same thing through the sketch command ---- */
{
  const canvas = document.getElementById('view');
  dev.setTab('sketch');
  document.querySelector('[data-cmd="newSketch"]').click();
  await wait(150);
  {
    // XZ, so the axis of the bar lies in the sketch and there is something to
    // draw the profile on.
    const at = dev.state.vp.worldToScreen(20, 0, 20);
    const send = (type, buttons) =>
      canvas.dispatchEvent(
        new PointerEvent(type, { ...at, button: 0, buttons, pointerId: 1, bubbles: true, cancelable: true })
      );
    send('pointermove', 0);
    await wait(30);
    send('pointerdown', 1);
    send('pointerup', 0);
  }
  await wait(700);
  report.sketchForProfile = dev.state.sketcher.active
    ? dev.state.sketcher.plane.n.map((n) => +n.toFixed(3))
    : null;

  if (dev.state.sketcher.active) {
    const before = dev.state.sketcher.sketch.entities.length;
    dev.runCommand('spunProfile');
    await wait(400);
    report.spunAsks = fieldNames();
    report.spunOffersTheFrame = options('Spun about').filter((o) => /Fixture/.test(o));
    setField('Spun about', 'w:z');
    document.getElementById('inspectorOk').click();
    await wait(900);
    report.spunDrew = dev.state.sketcher.active
      ? dev.state.sketcher.sketch.entities.length - before
      : 'sketch closed';
    dev.finishSketch();
    await wait(400);
  }
}

/* ---- a form cage broken on purpose, then repaired ---- */
{
  dev.setTab('form');
  dev.runCommand('formBox');
  await wait(400);
  document.getElementById('inspectorOk').click();
  await wait(600);

  const form = dev.bodies.find((b) => b.form);
  report.repair = { madeAForm: !!form };
  if (form) {
    const cage = dev.state.doc.forms[form.form];
    const points = cage.points.length;
    const faces = cage.faces.length;
    // Two faults a person really makes: a point dragged onto its neighbour, and
    // the same face made twice.
    cage.points[1] = cage.points[0].slice();
    cage.faces.push(cage.faces[0].slice().reverse());
    dev.rebuildAll();
    await wait(400);

    dev.state.selection.bodies.add(form.id);
    dev.runCommand('formRepair');
    await wait(400);
    report.repair.asks = fieldNames();
    document.getElementById('inspectorOk').click();
    await wait(800);
    report.repair.said = notes();

    const after = dev.state.doc.forms[form.form];
    report.repair.pointsWas = points;
    report.repair.pointsNow = after.points.length;
    report.repair.facesWas = faces;
    report.repair.facesNow = after.faces.length;
    report.repair.noFaceVisitsAPointTwice = after.faces.every(
      (f) => new Set(f).size === f.length && f.length >= 3
    );
    document.getElementById('inspectorOk').click();
    await wait(200);

    // Run again: a cage with nothing wrong with it must come back untouched.
    dev.runCommand('formRepair');
    await wait(300);
    document.getElementById('inspectorOk').click();
    await wait(600);
    report.repair.secondRun = dev.state.status || document.getElementById('status')?.textContent;
  }
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
