/**
 * Stress analysis, through the interface.
 *
 * A cantilever bracket: a bar held at one end and pushed down at the other, run
 * off the ribbon the way a person runs it. What is checked is the number, not
 * that a picture appeared: the deflection is compared against PL cubed over
 * three EI, which is arithmetic anybody can do on paper.
 *
 * Then the same part is run again at a finer grid, because a single run is not
 * a number to design to and the panel says so.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const FE = await import('./fea.js');
const status = () => document.getElementById('status').textContent;

function press(label) {
  const btn = [...document.querySelectorAll('#inspectorBody button')].find(
    (b) => b.textContent.trim() === label
  );
  btn?.click();
  return !!btn;
}
function setField(label, value) {
  const row = [...document.querySelectorAll('#inspectorBody .field')].find((f) =>
    f.querySelector('label')?.textContent.trim().startsWith(label)
  );
  const input = row?.querySelector('input, select');
  if (!input) return false;
  input.value = String(value);
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return true;
}

/* ---- a bar, 100 long, 10 by 10 ---- */
const L = 100;
const W = 10;
const H = 10;
dev.setTab('solid');
dev.runCommand('primBox');
await wait(400);
document.getElementById('inspectorOk').click();
await wait(600);
{
  const doc = dev.state.doc;
  doc.features[0].params = {
    ...doc.features[0].params,
    width: String(L),
    depth: String(W),
    height: String(H),
    centered: false
  };
  doc.materials = { byBody: {}, default: 'steel' };
  dev.rebuildAll();
  await wait(600);
}
const body = dev.bodies.find((b) => b.solid);
report.built = { volume: +body.solid.volume().toFixed(0), want: L * W * H };

/** Pick the face whose normal points along a given axis. */
function pickFace(test) {
  const rec = (dev.state.records || []).find((r) => r.id === body.id);
  const face = rec.topology.faces.find(test);
  dev.state.selection.faces.clear();
  if (face) dev.state.selection.faces.add(`${body.id}:${face.id}`);
  return !!face;
}

/* ---- hold one end, push the other ---- */
{
  dev.runCommand('simulate');
  await wait(400);
  report.panel = { opened: !document.getElementById('inspector').classList.contains('hidden') };

  pickFace((f) => f.normal[0] < -0.99);
  report.panel.held = press('Held');
  pickFace((f) => f.normal[0] > 0.99);
  report.panel.pushed = press('Pushed');

  setField('How hard', '100');
  setField('Which way', 'z-');
  setField('Cubes through', '4');
  document.getElementById('inspectorOk').click();
  await wait(4000);
  report.first = { said: status() };
}

/* ---- the numbers, against the beam formula ---- */
{
  const st = dev.state.stress;
  const I = (W * H * H * H) / 12;
  const exact = (100 * L * L * L) / (3 * st.material.modulus * I);
  const exactStress = (100 * L * (H / 2)) / I;
  report.answer = {
    through: st.through,
    cubes: st.grid.filled,
    throughTheSection: st.quality.across,
    volumeError: +st.fidelity.percent.toFixed(2),
    move: +st.result.maxMove.toFixed(4),
    moveWanted: +exact.toFixed(4),
    moveRatio: +(st.result.maxMove / exact).toFixed(3),
    stress: +st.result.maxStress.toFixed(1),
    stressWanted: +exactStress.toFixed(1),
    stressRatio: +(st.result.maxStress / exactStress).toFixed(3),
    safety: +st.result.factor.toFixed(2)
  };
  report.answer.deflectionIsRight = Math.abs(report.answer.moveRatio - 1) < 0.08;
  report.answer.stressIsRight = Math.abs(report.answer.stressRatio - 1) < 0.2;
}

/* ---- and the part is coloured by it ---- */
{
  const rec = (dev.state.records || []).find((r) => r.id === body.id);
  const entry = dev.state.vp.bodies.get(body.id);
  report.colours = {
    perVertex: !!rec.vertexColours,
    材: undefined,
    materialUsesThem: entry ? entry.mat.vertexColors === true : false
  };
  delete report.colours.材;
  if (rec.vertexColours) {
    // Hot at the root where the bending moment is, cool at the free end.
    const vp = rec.mesh.vertProperties;
    let atRoot = 0;
    let atTip = 0;
    let nRoot = 0;
    let nTip = 0;
    for (let v = 0; v < vp.length / 3; v++) {
      const x = vp[v * 3];
      const red = rec.vertexColours[v * 3];
      if (x < L * 0.1) {
        atRoot += red;
        nRoot++;
      } else if (x > L * 0.9) {
        atTip += red;
        nTip++;
      }
    }
    report.colours.redderAtTheRoot = atRoot / Math.max(1, nRoot) > atTip / Math.max(1, nTip);
  }
}

/* ---- run it again finer, which is the only honest way to use it ---- */
{
  dev.runCommand('simulate');
  await wait(400);
  setField('Cubes through', '6');
  document.getElementById('inspectorOk').click();
  await wait(9000);
  const st = dev.state.stress;
  const I = (W * H * H * H) / 12;
  const exact = (100 * L * L * L) / (3 * st.material.modulus * I);
  report.finer = {
    through: st.through,
    cubes: st.grid.filled,
    moveRatio: +(st.result.maxMove / exact).toFixed(3),
    settled: Math.abs(st.result.maxMove / exact - report.answer.moveRatio) < 0.05,
    said: status()
  };
}

/* ---- and it comes off again ---- */
{
  dev.runCommand('clearStress');
  await wait(600);
  const rec = (dev.state.records || []).find((r) => r.id === body.id);
  report.cleared = { noColours: !rec.vertexColours, said: status() };
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
