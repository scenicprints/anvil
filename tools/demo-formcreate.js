/**
 * Batch 16: building a form from curves that are already drawn.
 *
 * Two sketches go into the document, a square on XY and a path on XZ, and then
 * each of the From Curves commands is run off the menu the way a person runs
 * it. What is checked afterwards is the cage that came out: how many points, how
 * many faces, and whether it is open at the ends it should be open at.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const FM = await import('./form.js');

const forms = () => dev.bodies.filter((b) => b.form);
const cageOf = (body) => dev.state.doc.forms[body.form];
const status = () => document.getElementById('status').textContent;

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
    if (input.tagName === 'SELECT') {
      input.value = String(value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await wait(120);
  }
  document.getElementById('inspectorOk').click();
  await wait(800);
}

/* ---- a square and a path to build on ---- */
{
  const doc = dev.state.doc;
  const square = {
    id: 'skSquare',
    name: 'Square',
    plane: 'XY',
    points: [
      { x: -10, y: -10 },
      { x: 10, y: -10 },
      { x: 10, y: 10 },
      { x: -10, y: 10 }
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
  const path = {
    id: 'skPath',
    name: 'Path',
    plane: 'XZ',
    points: [
      { x: 0, y: 0 },
      { x: 0, y: 30 },
      { x: 25, y: 50 }
    ],
    entities: [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] }
    ],
    constraints: [],
    nextEntityId: 3
  };
  doc.sketches[square.id] = square;
  doc.sketches[path.id] = path;
  doc.features.push(
    { id: 'fsq', type: 'sketch', sketch: square.id },
    { id: 'fpa', type: 'sketch', sketch: path.id }
  );
  dev.rebuildAll();
  await wait(600);
}

dev.setTab('form');
await wait(200);

report.menu = { opens: false, items: [] };
{
  document.querySelector('[data-menu="formCreate"]').click();
  await wait(200);
  report.menu.items = [...document.querySelectorAll('#markmenu button')].map((b) =>
    b.textContent.trim()
  );
  report.menu.opens = report.menu.items.length > 0;
  document.body.click();
  await wait(150);
}

const took = (label) => {
  const body = forms()[forms().length - 1];
  if (!body) return { built: false, said: status() };
  const cage = cageOf(body);
  return {
    built: true,
    points: cage.points.length,
    faces: cage.faces.length,
    openEnds: FM.boundaryLoops(cage).length,
    said: status()
  };
};

/* ---- extrude the square ---- */
{
  const before = forms().length;
  menuPick('formCreate', 'Extrude a curve');
  await fillDialog({ Shape: 'skSquare', 'How far': '40', 'Points along': '4', 'Rows along': '3' });
  report.extrude = forms().length > before ? took() : { built: false, said: status() };
}

/* ---- revolve it ---- */
{
  const before = forms().length;
  menuPick('formCreate', 'Revolve a curve');
  await fillDialog({
    Shape: 'skPath',
    'About which': 'w:z',
    'How far round': '360',
    'Faces round': '8',
    'Points along': '3',
    'Rows along': '3'
  });
  report.revolve = forms().length > before ? took() : { built: false, said: status() };
}

/* ---- sweep the square along the path ---- */
{
  const before = forms().length;
  menuPick('formCreate', 'Sweep a curve along a path');
  await fillDialog({
    Shape: 'skSquare',
    Path: 'skPath',
    'Points along': '4',
    'Rows along': '4'
  });
  report.sweep = forms().length > before ? took() : { built: false, said: status() };
}

/* ---- pipe along the path ---- */
{
  const before = forms().length;
  menuPick('formCreate', 'Pipe along a path');
  await fillDialog({
    Path: 'skPath',
    Radius: '6',
    'Faces round': '8',
    'Rows along': '6'
  });
  report.pipe = forms().length > before ? took() : { built: false, said: status() };
}

/* ---- loft between the two ---- */
{
  const before = forms().length;
  menuPick('formCreate', 'Loft between sketches');
  await fillDialog({
    'First sketch': 'skSquare',
    'Second sketch': 'skPath',
    'Points along': '4',
    'Rows along': '2'
  });
  report.loft = forms().length > before ? took() : { built: false, said: status() };
}

report.formsMade = forms().length;
report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
