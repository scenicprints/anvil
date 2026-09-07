/**
 * Generative design, through the interface.
 *
 * A design space held at one end and pushed at the far bottom corner, which is
 * the case every topology optimisation paper opens with because the answer is
 * known: it should come out a truss.
 *
 * What is checked is the number that matters. Compliance is how much the part
 * gives under the load, and the claim is that the same material arranged by the
 * load gives far less than the same material spread evenly. If that ratio is
 * not well under one, nothing else about it is worth looking at.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

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

/* ---- the design space ---- */
const L = 60;
const W = 8;
const H = 30;
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
  doc.materials = { byBody: {}, default: 'pla' };
  dev.rebuildAll();
  await wait(600);
}
const body = dev.bodies.find((b) => b.solid);
report.space = { volume: +body.solid.volume().toFixed(0), want: L * W * H };

function pickFace(test) {
  const rec = (dev.state.records || []).find((r) => r.id === body.id);
  const face = rec.topology.faces.find(test);
  dev.state.selection.faces.clear();
  if (face) dev.state.selection.faces.add(`${body.id}:${face.id}`);
  return !!face;
}

/* ---- set it up as a stress problem, which is what it is ---- */
{
  dev.runCommand('simulate');
  await wait(400);
  pickFace((f) => f.normal[0] < -0.99);
  report.held = press('Held');
  pickFace((f) => f.normal[2] < -0.99);
  report.pushed = press('Pushed');
  setField('How hard', '50');
  setField('Which way', 'z-');
  document.getElementById('inspectorOk').click();
  await wait(6000);
  report.stressFirst = status();
}

/* ---- then let the load decide the shape ---- */
{
  dev.runCommand('generative');
  await wait(400);
  report.panel = {
    opened: !document.getElementById('inspector').classList.contains('hidden'),
    asks: [...document.querySelectorAll('#inspectorBody .field label')].map((n) =>
      n.textContent.trim()
    )
  };
  setField('How much material', '35');
  setField('Cubes through', '3');
  setField('Finest feature', '1.5');
  setField('How many rounds', '25');
  const bodiesBefore = dev.bodies.length;
  document.getElementById('inspectorOk').click();

  // It solves the part once per round, so this takes a while.
  for (let i = 0; i < 120; i++) {
    await wait(1000);
    if (dev.bodies.length > bodiesBefore) break;
    if (/Allow it more|not here|too coarse/.test(status())) break;
  }
  report.result = {
    said: status(),
    madeABody: dev.bodies.length > bodiesBefore,
    meshBodies: dev.bodies.filter((b) => b.mesh).length
  };
}

/* ---- and what it says about itself ---- */
{
  const said = report.result.said;
  const kept = /(\d+) in a hundred of the space kept/.exec(said);
  const stiffer = /([\d.]+) times stiffer/.exec(said);
  report.numbers = {
    keptPerCent: kept ? Number(kept[1]) : null,
    timesStiffer: stiffer ? Number(stiffer[1]) : null
  };
  report.numbers.spentItsAllowance =
    report.numbers.keptPerCent !== null && Math.abs(report.numbers.keptPerCent - 35) <= 3;
  report.numbers.reallyStiffer =
    report.numbers.timesStiffer !== null && report.numbers.timesStiffer > 1.5;
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
