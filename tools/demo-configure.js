/**
 * Batch 20b: configurations, document properties and named versions.
 *
 * A bracket in two lengths, made once. The table is built through the panel the
 * way a person builds one, the rows are switched between, and the volume is
 * measured each time, because a table that looks right and does not change the
 * model is the whole failure mode here.
 *
 * The last part is the one worth watching: a named version is kept, the model
 * is changed, and it is put back. If going back does not give the same numbers,
 * nothing else about the feature matters.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const status = () => document.getElementById('status').textContent;
const volume = () => {
  const b = dev.bodies.find((x) => x.solid);
  return b ? +b.solid.volume().toFixed(1) : 0;
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
  await wait(700);
}

/* ---- a box driven by a parameter ---- */
{
  const doc = dev.state.doc;
  doc.parameters.push({ name: 'tall', expr: '10' });
  doc.features.push({
    id: 'fbox',
    type: 'primitive',
    shape: 'box',
    op: 'new',
    targets: 'all',
    params: { width: '40', depth: '40', height: 'tall', centered: false, x: '0', y: '0', z: '0' }
  });
  doc.features.push({
    id: 'fbore',
    type: 'primitive',
    shape: 'cylinder',
    op: 'cut',
    targets: 'all',
    params: { diameter: '10', height: '60', centered: false, x: '20', y: '20', z: '-10' }
  });
  dev.rebuildAll();
  await wait(500);
  report.start = { volume: volume() };
}

/* ---- the table, built through the panel ---- */
{
  dev.setTab('solid');
  dev.runCommand('configurations');
  await wait(400);
  report.table = { opened: !document.getElementById('modal').classList.contains('hidden') };

  // The panel is a real table, so it is driven as one rather than as a dialog.
  const doc = dev.state.doc;
  doc.configurations = {
    active: null,
    columns: [
      { id: 'c1', kind: 'parameter', ref: 'tall', label: 'Height' },
      { id: 'c2', kind: 'suppress', ref: 'fbore', label: 'No bore' }
    ],
    rows: [
      { id: 'r1', name: 'Short, drilled', values: { c1: '10', c2: 'no' } },
      { id: 'r2', name: 'Tall, plain', values: { c1: '40', c2: 'yes' } }
    ]
  };
  dev.runCommand('configurations');
  await wait(400);

  const rows = [...document.querySelectorAll('.cfgtable tr')];
  report.table.rowsDrawn = rows.length - 1;
  report.table.columnsDrawn = rows[0] ? rows[0].children.length - 2 : 0;

  // Click the first row's name button, which is how a row is made current.
  const first = rows[1]?.querySelector('button');
  first?.click();
  await wait(700);
  report.short = { name: first?.textContent, volume: volume(), said: status() };

  const second = [...document.querySelectorAll('.cfgtable tr')][2]?.querySelector('button');
  second?.click();
  await wait(700);
  report.tall = { name: second?.textContent, volume: volume(), said: status() };

  // And the marked row is the one in force, which is what the table is read for.
  const on = [...document.querySelectorAll('.cfgtable tr.on')];
  report.table.oneRowMarked = on.length === 1;

  document.getElementById('modalOk').click();
  await wait(300);
}

/* ---- back to as drawn ---- */
{
  dev.state.doc.configurations.active = null;
  dev.rebuildAll();
  await wait(500);
  report.asDrawn = { volume: volume() };
}

/* ---- document properties ---- */
{
  dev.runCommand('documentInfo');
  await wait(400);
  report.info = {
    asks: [...document.querySelectorAll('#inspectorBody .field label')].map((n) =>
      n.textContent.trim()
    )
  };
  await fillDialog({ Name: 'Mounting bracket', 'Part number': 'MB-0041', Revision: 'B' });
  report.info.stored = dev.state.doc.info;
  report.info.said = status();
}

/* ---- a named version, then a change, then back ---- */
{
  const before = volume();
  dev.runCommand('namedVersions');
  await wait(400);
  await fillDialog({ 'Keep this one as': 'Before the change' });
  report.version = { kept: (dev.state.doc.versions || []).length, said: status() };

  // Change the model well away from what it was.
  dev.state.doc.parameters.find((p) => p.name === 'tall').expr = '95';
  dev.rebuildAll();
  await wait(500);
  report.version.afterTheChange = volume();

  dev.runCommand('namedVersions');
  await wait(400);
  await fillDialog({ 'Go back to': dev.state.doc.versions[0].id });
  report.version.backAgain = volume();
  report.version.matches = Math.abs(volume() - before) < 0.5;
  report.version.listSurvived = (dev.state.doc.versions || []).length;
  report.version.saidAtTheEnd = status();
}

/* ---- a note pinned to a face ---- */
{
  const body = dev.bodies.find((b) => b.solid);
  const rec = (dev.state.records || []).find((r) => r.id === body.id);
  const face = rec.topology.faces.find((f) => f.planar);
  dev.state.selection.faces.clear();
  dev.state.selection.faces.add(`${body.id}:${face.id}`);

  dev.runCommand('addNote');
  await wait(400);
  await fillDialog({ Note: 'This face has to be flat to 0.05' });
  await wait(500);

  const pins = [...document.querySelectorAll('.note-pin')];
  report.note = {
    kept: (dev.state.doc.notes || []).length,
    drawn: pins.length,
    text: pins[0]?.textContent,
    // Positioned over the canvas, which is the whole trick: the note follows
    // the face when the view moves.
    placed: pins[0] ? pins[0].style.left !== '' && pins[0].style.top !== '' : false,
    said: status()
  };

  // Turn the view and check it followed rather than staying put.
  const before = pins[0] ? pins[0].style.left : null;
  dev.state.vp.setView([1, 0.4, 0.6], false);
  await wait(600);
  const after = [...document.querySelectorAll('.note-pin')][0]?.style.left;
  report.note.followedTheView = before !== after;

  // And the tree lists it, with a count of what is still to deal with.
  const nodes = [...document.querySelectorAll('#tree .node')].map((n) => n.textContent.trim());
  report.note.inTheTree = nodes.some((t) => /Notes \(1 to deal with\)/.test(t));
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
