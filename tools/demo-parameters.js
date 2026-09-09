/**
 * Naming a parameter where it is used, and the star beside it.
 *
 * Fusion lets you type `Width = 50` into any dimension field: the parameter is
 * made there and then, the field is left reading its name, and it goes into
 * favourites. Anvil's fields already evaluated expressions, so the only thing
 * missing was noticing the equals sign, and without it every named dimension
 * meant a trip to the Parameters dialog and back.
 *
 * So: make a box, type a named value into one of its fields, and check the
 * parameter exists, that the field now reads the name rather than a copy of
 * the number, that the model actually took the value, and that changing the
 * parameter afterwards moves the part. Then check the two things that would
 * make it worse than nothing: a name already in use must not be redefined, and
 * an expression that does not evaluate must not leave a broken row behind.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

const rows = () => [...document.querySelectorAll('#inspectorBody .field')];
const rowFor = (text) => rows().find((r) => r.textContent.includes(text));
const params = () => dev.state.doc.parameters.map((p) => `${p.name}=${p.expr}${p.favourite ? '*' : ''}`);

dev.setTab('solid');
dev.runCommand('primBox');
await wait(600);
report.dialogOpen = !dev.state.editing ? false : true;
if (!report.dialogOpen) return { ...report, stuckAt: 'the box dialog did not open' };

/* ---- Width = 50 into the width field ---- */
{
  const input = rowFor('Width')?.querySelector('input');
  report.foundTheWidthRow = !!input;
  if (!input) return report;
  input.value = 'Width = 50';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(250);
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(700);

  report.paramsAfterTyping = params();
  report.fieldNowReads = input.value;
  report.madeTheParameter = dev.state.doc.parameters.some(
    (p) => p.name === 'Width' && p.expr === '50'
  );
  // The field has to end up referring to the parameter. Leaving the number in
  // it would make a parameter nothing uses, which is worse than not making one.
  report.fieldRefersToIt = input.value === 'Width';
  report.itIsAFavourite = !!dev.state.doc.parameters.find((p) => p.name === 'Width')?.favourite;
  report.status = document.getElementById('status')?.textContent ?? null;
}

/* ---- a name already in use is read, not redefined ---- */
{
  const input = rowFor('Depth')?.querySelector('input');
  input.value = 'Width = 999';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(200);
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(600);
  report.widthAfterSecondTry = dev.state.doc.parameters.find((p) => p.name === 'Width')?.expr;
  report.didNotRedefine = report.widthAfterSecondTry === '50';
  report.depthFieldReads = input.value;
  report.onlyOneWidth = dev.state.doc.parameters.filter((p) => p.name === 'Width').length === 1;
}

/* ---- and one that does not evaluate leaves nothing behind ---- */
{
  const before = dev.state.doc.parameters.length;
  const input = rowFor('Height')?.querySelector('input');
  input.value = 'Tall = nosuchthing * 2';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(200);
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(600);
  report.noBrokenRowAdded = dev.state.doc.parameters.length === before;
  report.brokenFieldLeftAsTyped = input.value === 'Tall = nosuchthing * 2';
  report.brokenStatus = document.getElementById('status')?.textContent ?? null;
  // Put it back so the box builds.
  input.value = '20';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(400);
}

document.getElementById('inspectorOk').click();
await wait(900);
{
  const bb = dev.bodies[0]?.solid?.boundingBox();
  report.builtWidth = bb ? Number((bb.max[0] - bb.min[0]).toFixed(2)) : null;
  report.builtDepth = bb ? Number((bb.max[1] - bb.min[1]).toFixed(2)) : null;
  // Fifty in both, because Depth was left reading Width.
  report.modelTookTheParameter = report.builtWidth === 50 && report.builtDepth === 50;
}

/* ---- changing the parameter moves the part ---- */
{
  dev.state.doc.parameters.find((p) => p.name === 'Width').expr = '80';
  dev.rebuildAll();
  await wait(900);
  const bb = dev.bodies[0]?.solid?.boundingBox();
  report.widthAfterEdit = bb ? Number((bb.max[0] - bb.min[0]).toFixed(2)) : null;
  report.parameterDrivesTheModel = report.widthAfterEdit === 80;
}

/* ---- the table shows the star, and favourites come first ---- */
{
  dev.state.doc.parameters.push({ name: 'plain', expr: '3' });
  dev.runCommand('parameters');
  await wait(500);
  const names = [...document.querySelectorAll('#inspectorBody table.params tbody tr')].map(
    (tr) => tr.querySelectorAll('input')[0]?.value
  );
  report.tableOrder = names;
  report.favouritesComeFirst = names[0] === 'Width';
  const stars = [...document.querySelectorAll('#inspectorBody table.params .starbtn')].map(
    (b) => b.textContent
  );
  report.stars = stars;
  report.starMarksTheFavourite = stars[0] === '★' && stars.includes('☆');
}

/* ---- and the CSV goes round the houses and comes back the same ---- */
{
  const text = dev.expr.parametersToCsv(dev.state.doc.parameters);
  report.csv = text.trim().split('\n');
  const back = dev.expr.parametersFromCsv(text);
  report.readBack = back.taken.map((p) => `${p.name}=${p.expr}`);
  report.roundTripped =
    back.taken.length === dev.state.doc.parameters.length &&
    back.taken.every((p, i) => p.expr === dev.state.doc.parameters[i].expr);
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
