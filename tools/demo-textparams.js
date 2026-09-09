/**
 * Sketch text driven by a text parameter.
 *
 * A text parameter on its own would be a feature with nowhere to go. The point
 * of it is that the words on a part come from somewhere you can change: a mark
 * number cut into forty brackets, changed once.
 *
 * The hard part is that text is stored as traced outlines, because that is what
 * a profile can be cut from, and the outlines are made when the text is typed.
 * So changing the parameter afterwards has to make them again, or the part goes
 * on saying what it used to while the parameter says otherwise.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const canvas = document.getElementById('view');
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

const at = (cx, cy) => ({
  clientX: cx,
  clientY: cy,
  pointerId: 1,
  bubbles: true,
  cancelable: true,
  isPrimary: true
});
const fire = (t, x, y, b) => canvas.dispatchEvent(new PointerEvent(t, { ...at(x, y), button: 0, buttons: b }));
async function clickAt(x, y) {
  fire('pointermove', x, y, 0);
  await wait(40);
  fire('pointerdown', x, y, 1);
  await wait(40);
  fire('pointerup', x, y, 0);
  await wait(250);
}

const rowFor = (t) =>
  [...document.querySelectorAll('#inspectorBody .field')].find((r) => r.textContent.includes(t));

/* ---- a text parameter to drive it ---- */
dev.state.doc.parameters.push({ name: 'mark', kind: 'text', expr: '"Mk 3"' });

/* ---- a sketch with text in it ---- */
dev.setTab('solid');
document.querySelector('[data-cmd="newSketch"]').click();
await wait(200);
{
  const node = [...document.querySelectorAll('#tree .node')].find(
    (n) => n.textContent.trim() === 'XY plane'
  );
  if (!node) return { ...report, stuckAt: 'no XY plane in the browser' };
  node.click();
}
await wait(1000);
if (!dev.state.sketcher.active) return { ...report, stuckAt: 'the sketch did not open' };

const sk = dev.state.sketcher;
const plane = (x, y) => {
  const s = sk.planeToScreen(x, y);
  const r = canvas.getBoundingClientRect();
  return [r.left + s.x, r.top + s.y];
};

sk.setTool('text');
await clickAt(...plane(-30, 0));
await wait(600);
report.textDialogOpened = !!rowFor('Text');
if (!report.textDialogOpened) return report;

{
  const input = rowFor('Text')?.querySelector('input');
  // An expression, not plain words: quoted literal joined to the parameter.
  input.value = '"Bracket " + mark';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(200);
  const h = rowFor('Height')?.querySelector('input');
  if (h) {
    h.value = '12';
    h.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
  }
  document.getElementById('inspectorOk').click();
  await wait(900);
}

{
  const ent = sk.sketch.entities.find((e) => e.type === 'text');
  report.entityMade = !!ent;
  report.keptTheExpression = ent?.textExpr ?? null;
  report.resolvedTo = ent?.text ?? null;
  report.outlinesFirst = ent?.contours?.length ?? 0;
  // The stored words are the answer, not the expression: what gets traced has
  // to be the resolved string or the part says "Bracket " + mark.
  report.resolvedNotLiteral = ent?.text === 'Bracket Mk 3';
}

document.querySelector('[data-cmd="finishSketch"]').click();
await wait(900);

/* ---- change the parameter, and the outlines have to be made again ---- */
{
  const ent = dev.state.doc.sketches[Object.keys(dev.state.doc.sketches)[0]].entities.find(
    (e) => e.type === 'text'
  );
  const before = JSON.stringify(ent.contours).length;

  dev.state.doc.parameters.find((p) => p.name === 'mark').expr = '"Mk 11"';
  dev.rebuildAll();
  await wait(1500);

  report.textAfterEdit = ent.text;
  report.followedTheParameter = ent.text === 'Bracket Mk 11';
  report.outlinesAfter = ent.contours.length;
  // Different words, different outlines. Same length would mean the contours
  // were left as they were and only the label changed, which is the failure
  // this whole thing exists to avoid.
  report.outlinesWereRemade = JSON.stringify(ent.contours).length !== before;
}

/* ---- and plain words are left alone, not treated as a broken expression ---- */
{
  dev.setTab('solid');
  document.querySelector('[data-cmd="newSketch"]').click();
  await wait(200);
  const node = [...document.querySelectorAll('#tree .node')].find(
    (n) => n.textContent.trim() === 'XZ plane'
  );
  if (node) node.click();
  await wait(900);
  const sk2 = dev.state.sketcher;
  sk2.setTool('text');
  const r = canvas.getBoundingClientRect();
  const s = sk2.planeToScreen(-20, 0);
  await clickAt(r.left + s.x, r.top + s.y);
  await wait(600);
  const input = rowFor('Text')?.querySelector('input');
  if (input) {
    input.value = 'Just words';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    document.getElementById('inspectorOk').click();
    await wait(900);
  }
  const ent = sk2.sketch.entities.find((e) => e.type === 'text');
  report.plainWords = ent?.text ?? null;
  report.plainKeptNoExpression = ent?.textExpr === null || ent?.textExpr === undefined;
  report.plainWordsSurvived = ent?.text === 'Just words' && (ent?.contours?.length ?? 0) > 0;
  document.querySelector('[data-cmd="finishSketch"]').click();
  await wait(700);
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
