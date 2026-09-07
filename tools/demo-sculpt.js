/**
 * Batch 15: the Form tab's sculpting verbs, run through the Shape menu.
 *
 * A box cage is picked at, the command is chosen from the menu the way a person
 * chooses it, its dialog is filled in, and the cage is read back afterwards. The
 * point of doing it this way rather than calling the functions is that half the
 * work of one of these commands is turning what is picked in the viewport into
 * cage points, and that half only runs here.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const FM = await import('./form.js');

const forms = () => dev.bodies.filter((b) => b.form);
const cageOf = (body) => dev.state.doc.forms[body.form];
const recOf = (body) => (dev.state.records || []).find((r) => r.id === body.id);
const status = () => document.getElementById('status').textContent;

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
  await wait(700);
}

const menuPick = (menu, label) => {
  document.querySelector(`[data-menu="${menu}"]`).click();
  const item = [...document.querySelectorAll('#markmenu button')].find(
    (b) => b.textContent.trim() === label
  );
  if (item) item.click();
  return !!item;
};

/** Pick the topology edges of a form that lie along one plane of the cage. */
function pickEdgesWhere(body, test) {
  const rec = recOf(body);
  dev.state.selection.edges.clear();
  dev.state.selection.faces.clear();
  let n = 0;
  for (const e of rec.topology.edges) {
    if (!e.points?.length) continue;
    if (!test(e)) continue;
    dev.state.selection.edges.add(`${rec.id}:${e.id}`);
    n++;
  }
  return n;
}

/* ---- a box to work on ---- */
dev.setTab('form');
dev.runCommand('formBox');
await fillDialog({ Width: '40', Depth: '40', Height: '40', Display: 'control' });
let box = forms()[0];
report.started = box ? { points: cageOf(box).points.length, faces: cageOf(box).faces.length } : null;
if (!box) return report;
dev.state.selection.bodies.clear();
dev.state.selection.bodies.add(box.id);

report.menu = { opens: false, items: [] };
{
  document.querySelector('[data-menu="formShape"]').click();
  await wait(200);
  report.menu.items = [...document.querySelectorAll('#markmenu button')].map((b) =>
    b.textContent.trim()
  );
  report.menu.opens = report.menu.items.length > 0;
  document.body.click();
  await wait(150);
}

/* ---- smooth ---- */
{
  const was = cageOf(box).points.map((p) => p.slice());
  report.smooth = { picked: pickEdgesWhere(box, (e) => e.points[0][2] > 19.9) };
  menuPick('formShape', 'Smooth');
  await fillDialog({ 'How far': '0.6', Passes: '2' });
  box = forms()[0];
  const now = cageOf(box).points;
  report.smooth.moved = now.filter((p, i) =>
    p.some((c, k) => Math.abs(c - was[i][k]) > 1e-9)
  ).length;
  report.smooth.said = status();
}

/* ---- bevel one edge ---- */
{
  const before = cageOf(box).points.length;
  report.bevel = { picked: 0 };
  const rec = recOf(box);
  const edge = rec.topology.edges.find((e) => e.points?.length);
  if (edge) {
    dev.state.selection.edges.clear();
    dev.state.selection.edges.add(`${rec.id}:${edge.id}`);
    report.bevel.picked = 1;
    menuPick('formShape', 'Bevel Edge');
    await fillDialog({ 'How tight': '0.2' });
    box = forms()[0];
    report.bevel.pointsBefore = before;
    report.bevel.pointsAfter = cageOf(box).points.length;
    report.bevel.said = status();
  }
}

/* ---- freeze, then try to smooth through it ---- */
{
  const rec = recOf(box);
  const edge = rec.topology.edges.find((e) => e.points?.length);
  dev.state.selection.edges.clear();
  dev.state.selection.edges.add(`${rec.id}:${edge.id}`);
  menuPick('formShape', 'Freeze');
  await wait(600);
  box = forms()[0];
  const cage = cageOf(box);
  const held = Object.keys(cage.frozen || {}).map(Number);
  report.freeze = { pinned: held.length, said: status() };

  if (held.length) {
    const was = held.map((v) => cage.points[v].slice());
    pickEdgesWhere(box, () => true);
    menuPick('formShape', 'Smooth');
    await fillDialog({ 'How far': '1', Passes: '3' });
    const after = cageOf(forms()[0]);
    report.freeze.stayedPut = held.every((v, i) =>
      after.points[v].every((c, k) => Math.abs(c - was[i][k]) < 1e-9)
    );
    report.freeze.othersMoved = after.points.filter((p, i) => !held.includes(i)).length > 0;
  }
}

/* ---- erase and fill ---- */
{
  const before = cageOf(forms()[0]).faces.length;
  box = forms()[0];
  const rec = recOf(box);
  const cage = cageOf(box);
  // An edge with a face either side, which is the only kind there is anything
  // to merge across.
  const adj = FM.adjacency(cage);
  const inner = [...adj.edges.values()].find((e) => e.faces.length === 2);
  const wanted = inner
    ? rec.topology.edges.find((e) => {
        const ends = [e.points[0], e.points[e.points.length - 1]];
        const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-3;
        return (
          (near(ends[0], cage.points[inner.a]) && near(ends[1], cage.points[inner.b])) ||
          (near(ends[0], cage.points[inner.b]) && near(ends[1], cage.points[inner.a]))
        );
      })
    : null;
  report.erase = { foundAnInnerEdge: !!wanted };
  if (wanted) {
    dev.state.selection.edges.clear();
    dev.state.selection.edges.add(`${rec.id}:${wanted.id}`);
    menuPick('formShape', 'Erase And Fill');
    await wait(700);
    report.erase.facesBefore = before;
    report.erase.facesAfter = cageOf(forms()[0]).faces.length;
    report.erase.said = status();
  }
}

/* ---- interpolate ---- */
{
  box = forms()[0];
  const rec = recOf(box);
  const edge = rec.topology.edges.find((e) => e.points?.length);
  dev.state.selection.edges.clear();
  dev.state.selection.edges.add(`${rec.id}:${edge.id}`);
  menuPick('formShape', 'Interpolate');
  await wait(700);
  const cage = cageOf(forms()[0]);
  report.interpolate = {
    marked: Object.keys(cage.corners || {}).length,
    said: status()
  };
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
