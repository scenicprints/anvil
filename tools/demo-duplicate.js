/**
 * Copying a component, and the joints coming with it.
 *
 * Fusion calls it Duplicate With Joints and the joints are the point. A copy
 * without them is a second part sitting in space that has to be jointed up
 * again by hand, which for a bracket that took four joints is most of the work
 * done twice.
 *
 * The thing worth checking is that the copy is a copy and not a second name for
 * the same thing. Everything is cloned: new feature ids, new sketch ids, and
 * every reference to an old one rewritten, because a body is named after the
 * feature that made it and those names turn up in other features' target lists.
 * Get that wrong and editing the copy moves the original, which is the kind of
 * fault that only shows up an hour later.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

const doc = () => dev.state.doc;
const rowFor = (t) =>
  [...document.querySelectorAll('#inspectorBody .field')].find((r) => r.textContent.includes(t));

/* ---- a part in a component of its own ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(600);
{
  const sel = rowFor('Operation')?.querySelector('select');
  if (!sel) return { ...report, stuckAt: 'no operation row on the box' };
  sel.value = 'component';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(400);
  const w = rowFor('Width')?.querySelector('input');
  if (w) {
    w.value = '30';
    w.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(300);
  }
}
document.getElementById('inspectorOk').click();
await wait(900);

report.componentsAfterBox = doc().components.map((c) => c.name);
report.bodiesAfterBox = dev.bodies.length;
const source = doc().components[0];
report.madeOne = !!source;
if (!source) return report;

/* ---- and a second feature inside it, so the copy has a history to carry ---- */
{
  // Features go into whichever component is active, the same as Fusion.
  dev.state.activeComponent = source.id;
  const rec = dev.state.records[0];
  if (!rec) return { ...report, stuckAt: 'the box did not build', bodies: dev.bodies.length };
  for (const e of rec.topology.edges) {
    dev.state.selection.edges.add(`${rec.id}:${rec.topology.edges.indexOf(e)}`);
  }
  dev.runCommand('chamfer');
  await wait(700);
  const input = rowFor('Set 1 distance')?.querySelector('input');
  if (input) {
    input.value = '2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(300);
  }
  document.getElementById('inspectorOk').click();
  await wait(1000);
}
report.featuresInSource = doc().features.filter((f) => f.component === source.id).length;
report.volumeBefore = Number(dev.bodies[0].solid.volume().toFixed(1));

/* ---- duplicate it ---- */
{
  dev.state.activeComponent = source.id;
  dev.runCommand('duplicateComponent');
  await wait(1500);
}

report.status = document.getElementById('status')?.textContent ?? null;
report.componentsAfter = doc().components.map((c) => c.name);
report.madeACopy = doc().components.length === 2;
report.bodiesAfter = dev.bodies.length;
report.twoBodies = dev.bodies.length === 2;

{
  const copy = doc().components[1];
  const theirs = doc().features.filter((f) => f.component === copy.id);
  report.featuresInCopy = theirs.length;
  report.sameHistory = theirs.length === report.featuresInSource;

  // Nothing shared. A single id in common means editing one moves the other.
  const mineIds = doc()
    .features.filter((f) => f.component === source.id)
    .map((f) => f.id);
  report.noSharedFeatureIds = theirs.every((f) => !mineIds.includes(f.id));

  const mineSketches = new Set(
    doc().features.filter((f) => f.component === source.id).map((f) => f.sketch).filter(Boolean)
  );
  report.noSharedSketches = theirs.every((f) => !f.sketch || !mineSketches.has(f.sketch));

  // The copy is the same shape, which is what says the references were rewritten
  // rather than merely renumbered: a chamfer whose body reference was left
  // pointing at the original would have built nothing.
  const vols = dev.bodies.map((b) => Number(b.solid.volume().toFixed(1)));
  report.volumes = vols;
  report.copyIsTheSameShape =
    vols.length === 2 && Math.abs(vols[0] - vols[1]) < 0.1 &&
    Math.abs(vols[0] - report.volumeBefore) < 0.1;

  // And the copy is not grounded: two parts grounded in the same place cannot
  // be told apart or moved.
  report.copyIsFree = copy.grounded !== true;
}

/* ---- and editing the copy leaves the original alone ---- */
{
  const copy = doc().components[1];
  const box = doc().features.find((f) => f.component === copy.id && f.type === 'primitive');
  report.foundTheCopysBox = !!box;
  if (box) {
    box.params.width = '80';
    dev.rebuildAll();
    await wait(1200);
    const widths = dev.bodies
      .map((b) => Number((b.solid.boundingBox().max[0] - b.solid.boundingBox().min[0]).toFixed(1)))
      .sort((a, b) => a - b);
    report.widthsAfterEdit = widths;
    report.onlyTheCopyMoved = widths.length === 2 && widths[0] === 30 && widths[1] === 80;
  }
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
