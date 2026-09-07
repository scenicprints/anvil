/**
 * Design Advice, Untrim, Merge, and the print dialog.
 *
 * A plate with a bore too small to print and a wall too thin to print is put
 * through the advice the way a person runs it: open the Analyse menu, pick the
 * command, fill the panel in, read what comes back. Then a surface is trimmed
 * and untrimmed and the area is checked against what was taken out, because
 * "it looks right" is not a measurement.
 *
 * The print dialog is opened and left alone. Pressing its button would put a
 * save dialog on screen, and a demo that needs someone to click Save is not a
 * demo.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const SH = await import('./sheet.js');

const notes = () =>
  [...document.querySelectorAll('#inspectorBody .hint')].map((n) => n.textContent.trim());
const fieldNames = () =>
  [...document.querySelectorAll('#inspectorBody .field label')].map((n) => n.textContent.trim());
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
const menuPick = (menu, label) => {
  document.querySelector(`[data-menu="${menu}"]`).click();
  const item = [...document.querySelectorAll('#markmenu button')].find(
    (b) => b.textContent.trim() === label
  );
  if (item) item.click();
  return !!item;
};

/* ---- a part with two things wrong with it ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(400);
document.getElementById('inspectorOk').click();
await wait(500);

const doc = dev.state.doc;
doc.features[0].params.width = '40';
doc.features[0].params.depth = '40';
doc.features[0].params.height = '1';
doc.features.push({
  id: 'bore',
  type: 'primitive',
  shape: 'cylinder',
  op: 'cut',
  targets: 'all',
  params: { diameter: '0.6', height: '20', centered: true, x: '10', y: '10', z: '0' }
});
dev.rebuildAll();
await wait(600);
report.built = { bodies: dev.bodies.length, errors: dev.state.result.errors.map((e) => e.message) };

/* ---- design advice, through the menu ---- */
report.foundTheCommand = menuPick('inspect', 'Design Advice');
await wait(400);
report.adviceAsks = fieldNames();
setField('Thinnest wall to allow', '2');
setField('Nozzle, or smallest feature', '0.8');
setField('Bed, X Y Z, blank for none', '256, 256, 256');
document.getElementById('inspectorOk').click();
await wait(1500);
report.adviceSaid = notes();
report.selectedAfterAdvice = dev.state.selection.faces.size;
document.getElementById('inspectorOk').click();
await wait(200);

/* ---- the print dialog, opened and read ---- */
dev.runCommand('print3D');
await wait(400);
report.printAsks = fieldNames();
report.printSays = notes();
dev.runCommand('escape');
await wait(200);
document.getElementById('inspector').classList.add('hidden');

/* ---- untrim, on a surface with a hole cut in it ---- */
{
  const d = dev.state.doc;
  d.features.length = 0;
  d.features.push(
    {
      id: 'plate',
      type: 'primitive',
      shape: 'box',
      params: { width: '40', depth: '40', height: '10', centered: true }
    },
    {
      id: 'drill',
      type: 'primitive',
      shape: 'cylinder',
      op: 'cut',
      targets: 'all',
      params: { diameter: '12', height: '40', centered: true, x: '0', y: '0', z: '0' }
    },
    { id: 'unst', type: 'unstitch', bodies: 'all' }
  );
  dev.rebuildAll();
  await wait(700);

  const sheets = dev.bodies.filter((b) => !b.solid);
  const bore = Math.PI * 36;
  const top = sheets.find((b) => Math.abs(SH.sheetArea(b.sheet) - (1600 - bore)) < bore * 0.05);
  report.untrim = { faces: sheets.length, foundTheBoredFace: !!top };

  if (top) {
    const was = SH.sheetArea(top.sheet);
    d.features.push({ id: 'untr', type: 'untrimSurface', surfaces: [top.id], outer: false });
    dev.rebuildAll();
    await wait(500);
    const now = dev.bodies.find((b) => b.id === top.id);
    report.untrim.areaBefore = +was.toFixed(1);
    report.untrim.areaAfter = +SH.sheetArea(now.sheet).toFixed(1);
    report.untrim.boreWas = +bore.toFixed(1);
    report.untrim.holesLeft = SH.boundaryLoops(now.sheet).length - 1;
    report.untrim.errors = dev.state.result.errors.map((e) => e.message);
  }
}

/* ---- merge, on the faces that are left ---- */
{
  const d = dev.state.doc;
  const sheets = dev.bodies.filter((b) => !b.solid);
  const total = sheets.reduce((a, b) => a + SH.sheetArea(b.sheet), 0);
  d.features.push({
    id: 'mrg',
    type: 'mergeSurface',
    surfaces: sheets.map((b) => b.id),
    tolerance: '0.01'
  });
  dev.rebuildAll();
  await wait(600);
  const left = dev.bodies.filter((b) => !b.solid);
  report.merge = {
    from: sheets.length,
    to: left.length,
    stillASurface: !dev.bodies.some((b) => b.solid),
    areaKept: Math.abs(SH.sheetArea(left[0].sheet) - total) < 1e-6,
    said: dev.state.result.errors.map((e) => e.message)
  };
}

return report;
