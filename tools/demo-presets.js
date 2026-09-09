/**
 * Saving a dialog's settings under a name, and opening the next one with them.
 *
 * Fusion has this on every dialog and the inventory had it missing app-wide.
 * The reason to want it is repetition: a part gets the same 0.6 chamfer on
 * every edge it has, and typing 0.6 into a fresh dialog forty times is forty
 * chances to type 0.8.
 *
 * The two things worth checking are the two that would make it harmful. A
 * preset must never carry geometry, because restoring somebody else's edges is
 * worse than no preset at all. And nothing may be applied on open unless it was
 * marked as the default: Extrude opens at a distance of zero on purpose so that
 * nothing appears until a length is given, and quietly restoring the last
 * distance would undo that for someone who never asked for a preset.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

const rows = () => [...document.querySelectorAll('#inspectorBody .field')];
const rowFor = (t) => rows().find((r) => r.textContent.includes(t));
const presetRow = () => document.querySelector('#inspectorBody .field.presetrow');
const btn = (text) =>
  [...(presetRow()?.querySelectorAll('button') || [])].find((b) => b.textContent === text);

// A clean store, so the run does not depend on what a previous one left.
window.localStorage.removeItem('anvil.presets');
dev.state.presets = null;

/* ---- a box to chamfer ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(500);
document.getElementById('inspectorOk').click();
await wait(900);

/* ---- chamfer at 0.6, saved as a preset ---- */
{
  const rec = dev.state.records[0];
  for (const e of rec.topology.edges) {
    dev.state.selection.edges.add(`${rec.id}:${rec.topology.edges.indexOf(e)}`);
  }
  report.edgesPicked = dev.state.selection.edges.size;
}
dev.runCommand('chamfer');
await wait(700);
report.dialog = document.getElementById('inspectorTitle')?.textContent;
report.presetRowIsThere = !!presetRow();
report.buttonsOnAFreshStore = [...(presetRow()?.querySelectorAll('button') || [])].map(
  (b) => b.textContent
);

{
  // The distance field, not the preset dropdown, is what gets focus. A dialog
  // opened to type a number into must not swallow the digits in a select.
  report.focusIsNotTheDropdown =
    document.activeElement !== presetRow()?.querySelector('select');

  const input = rowFor('Set 1 distance')?.querySelector('input');
  report.foundTheDistance = !!input;
  if (!input) return report;
  input.value = '0.6';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(400);
}

{
  btn('Save')?.click();
  await wait(300);
  const name = document.querySelector('#modalBody input');
  report.savePrompted = !!name;
  if (name) name.value = 'Print 0.6';
  document.getElementById('modalOk').click();
  await wait(400);
}

{
  const store = JSON.parse(window.localStorage.getItem('anvil.presets') || '{}');
  report.savedUnder = Object.keys(store);
  const saved = store.chamfer?.saved?.[0];
  report.savedName = saved?.name ?? null;
  report.savedValues = saved?.values ?? null;
  report.carriedTheDistance = saved?.values?.['sets.0.radius'] === '0.6';
  // The whole point. A preset that restored somebody else's edges would put
  // geometry from one part into another.
  report.carriedNoGeometry =
    !!saved && !JSON.stringify(saved.values).includes('edges') &&
    !JSON.stringify(saved.values).includes('bodyId');
}

document.getElementById('inspectorOk').click();
await wait(1200);
report.chamferBuilt = dev.bodies.length === 1;

/* ---- a second chamfer opens at its own defaults, not the last ones ---- */
dev.runCommand('chamfer');
await wait(700);
{
  const input = rowFor('Set 1 distance')?.querySelector('input');
  report.secondOpensAt = input?.value ?? null;
  // Last used is recorded and offered in the list, and deliberately not applied.
  report.lastUsedIsOffered = [...(presetRow()?.querySelectorAll('option') || [])].some(
    (o) => o.textContent === 'Last used'
  );
  report.didNotApplyLastUsed = report.secondOpensAt === '1';
}
document.getElementById('inspectorCancel').click();
await wait(500);

/* ---- mark it the default, and then it does ---- */
dev.runCommand('chamfer');
await wait(700);
{
  btn('Default')?.click();
  await wait(300);
  const sel = document.querySelector('#modalBody select');
  report.defaultPrompted = !!sel;
  if (sel) sel.value = 'Print 0.6';
  document.getElementById('modalOk').click();
  await wait(400);
  report.defaultInStore = JSON.parse(window.localStorage.getItem('anvil.presets')).chamfer.default;
}
document.getElementById('inspectorCancel').click();
await wait(500);

dev.runCommand('chamfer');
await wait(800);
{
  const input = rowFor('Set 1 distance')?.querySelector('input');
  report.thirdOpensAt = input?.value ?? null;
  report.defaultIsApplied = report.thirdOpensAt === '0.6';
  report.markedInTheList = [...(presetRow()?.querySelectorAll('option') || [])].map(
    (o) => o.textContent
  );
}
document.getElementById('inspectorCancel').click();
await wait(400);

/* ---- and a fillet is untouched by a chamfer preset ---- */
dev.runCommand('fillet');
await wait(700);
{
  const input = rowFor('Set 1 radius')?.querySelector('input');
  report.filletOpensAt = input?.value ?? null;
  report.presetsArePerFeatureType = report.filletOpensAt === '2';
}
document.getElementById('inspectorCancel').click();
await wait(400);

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
