/**
 * Batch 19: the four plastic part features, through the Plastic menu.
 *
 * A plate is made, its top face is picked in the viewport, and each command is
 * run off the menu with its dialog filled in. What is checked is the volume
 * before and after, because that is the one thing a picture of a boss cannot
 * tell you: whether it is the boss you asked for or one twice the size.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const K = await import('./kernel.js');

const solid = () => dev.bodies.find((b) => b.solid);
const volume = () => (solid() ? solid().solid.volume() : 0);
const status = () => document.getElementById('status').textContent;
const fieldNames = () =>
  [...document.querySelectorAll('#inspectorBody .field label')].map((n) => n.textContent.trim());

const menuPick = (menu, label) => {
  document.querySelector(`[data-menu="${menu}"]`).click();
  const item = [...document.querySelectorAll('#markmenu button')].find(
    (b) => b.textContent.trim() === label
  );
  if (item) item.click();
  return !!item;
};

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

/** Pick the top face of the current solid, the way a click would. */
function pickTop() {
  const b = solid();
  const rec = (dev.state.records || []).find((r) => r.id === b.id);
  let best = 0;
  for (let i = 1; i < rec.topology.faces.length; i++) {
    const f = rec.topology.faces[i];
    if (f.normal[2] > 0.99 && f.area > rec.topology.faces[best].area) best = i;
  }
  dev.state.selection.faces.clear();
  dev.state.selection.faces.add(`${b.id}:${rec.topology.faces[best].id}`);
  return rec.topology.faces[best];
}

/* ---- a plate to stand things on ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await fillDialog({ Width: '60', Depth: '60', Height: '5', 'Centre on origin': false });
report.plate = { volume: +volume().toFixed(1) };

report.menu = { opens: false, items: [] };
{
  document.querySelector('[data-menu="plastic"]').click();
  await wait(200);
  report.menu.items = [...document.querySelectorAll('#markmenu button')].map((b) =>
    b.textContent.trim()
  );
  report.menu.opens = report.menu.items.length > 0;
  document.body.click();
  await wait(150);
}

/* ---- a boss with ribs ---- */
{
  pickTop();
  const was = volume();
  menuPick('plastic', 'Boss');
  await wait(400);
  report.boss = { asks: fieldNames() };
  await fillDialog({
    'Outside diameter': '8',
    Bore: '3',
    Height: '10',
    'Bore depth': '8',
    'Fillet at the foot': '1.5',
    'How many ribs': '4',
    'Rib thickness': '1.5',
    'Rib height': '7',
    'How far a rib': '4',
    'Across the face': '-15',
    'And up it': '-15'
  });
  report.boss.added = +(volume() - was).toFixed(1);
  report.boss.said = status();
  report.boss.errors = (dev.state.result?.errors || []).map((e) => e.message);
}

/* ---- a rest, sunken ---- */
{
  pickTop();
  const was = volume();
  menuPick('plastic', 'Rest');
  await wait(400);
  report.rest = { asks: fieldNames() };
  await fillDialog({
    Shape: 'round',
    Diameter: '10',
    Height: '2',
    'Draft angle': '5',
    'Raised or sunken': 'cut',
    'Across the face': '15',
    'And up it': '-15'
  });
  report.rest.removed = +(was - volume()).toFixed(1);
  report.rest.said = status();
}

/* ---- a snap fit ---- */
{
  pickTop();
  const was = volume();
  menuPick('plastic', 'Snap Fit');
  await wait(400);
  report.snap = { asks: fieldNames() };
  await fillDialog({
    'Beam length': '12',
    'Beam thickness': '2',
    'Beam width': '6',
    'Hook height': '1.5',
    'Lead-in angle': '30',
    'Retention angle': '90',
    'Across the face': '15',
    'And up it': '15'
  });
  report.snap.added = +(volume() - was).toFixed(1);
  report.snap.said = status();
}

/* ---- a lip round the rim ---- */
{
  pickTop();
  const was = volume();
  menuPick('plastic', 'Lip');
  await wait(400);
  report.lip = { asks: fieldNames() };
  await fillDialog({
    'Lip width': '1.2',
    'In from the edge': '0.8',
    Height: '2',
    Clearance: '0.15',
    'Lip or groove': 'join'
  });
  report.lip.added = +(volume() - was).toFixed(1);
  // A band 1.2 wide and 2 high once round a 60 square, set in a little.
  report.lip.roughly = +(1.2 * 2 * 4 * (60 - 2 * 1.4)).toFixed(1);
  report.lip.said = status();
}

report.finalVolume = +volume().toFixed(1);
report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
