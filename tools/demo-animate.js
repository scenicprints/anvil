/**
 * Animation: taking an assembly apart on a timeline.
 *
 * Three components are made, exploded automatically, and the playhead is moved
 * from together to apart. What is checked is that the bodies move on screen and
 * that the model underneath does not: an animation that edited the assembly
 * would leave the parts wherever the playhead stopped, which is the one thing
 * that must not happen.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const AN = await import('./animation.js');
const K = await import('./kernel.js');

const status = () => document.getElementById('status').textContent;

async function fillDialog(values = {}) {
  await wait(250);
  document.getElementById('inspectorOk').click();
  await wait(500);
}

/** Run a labelled button in the open panel. */
function press(label) {
  const btn = [...document.querySelectorAll('#inspectorBody button')].find(
    (b) => b.textContent.trim() === label
  );
  btn?.click();
  return !!btn;
}

/* ---- three parts, each its own component ---- */
{
  const doc = dev.state.doc;
  doc.components = doc.components || [];
  ['A', 'B', 'C'].forEach((name, i) => {
    doc.components.push({ id: `c${name}`, name: `Part ${name}`, transform: null });
    doc.features.push({
      id: `f${name}`,
      type: 'primitive',
      shape: 'box',
      op: 'new',
      targets: 'all',
      component: `c${name}`,
      params: {
        width: '20',
        depth: '20',
        height: '10',
        centered: true,
        x: '0',
        y: '0',
        z: String(i * 10)
      }
    });
  });
  dev.rebuildAll();
  await wait(700);
  report.built = dev.bodies.filter((b) => b.solid).length;
}

/* ---- where the model really is, before anything is animated ---- */
const before = dev.bodies
  .filter((b) => b.solid)
  .map((b) => +K.boundingBox(b.solid).min[2].toFixed(3));

/* ---- explode it ---- */
{
  dev.runCommand('animate');
  await wait(400);
  report.panel = { opened: !document.getElementById('inspector').classList.contains('hidden') };
  report.panel.exploded = press('Take it apart automatically');
  await wait(700);

  const story = dev.state.doc.animation;
  report.story = {
    steps: story?.steps?.length || 0,
    seconds: +AN.lengthOf(story).toFixed(2),
    // Furthest out first, which is the order things come off.
    startsInOrder: (story?.steps || []).every((s, i, all) => i === 0 || s.start >= all[i - 1].start)
  };
}

/* ---- apart, then together, reading the drawn positions ---- */
const drawn = () =>
  [...dev.state.vp.bodies.values()].map((e) => +e.mesh.position.length().toFixed(3));

{
  dev.state.anim.time = AN.lengthOf(dev.state.doc.animation);
  const apply = dev.state.vp.setBodyOffsets.bind(dev.state.vp);
  // The app does this for us on rebuild; here the panel's own scrub is used.
  dev.runCommand('animate');
  await wait(300);
  const row = [...document.querySelectorAll('#inspectorBody .field')].find((f) =>
    f.querySelector('label')?.textContent.trim().startsWith('Where the playhead')
  );
  const input = row?.querySelector('input');
  if (input) {
    input.value = String(AN.lengthOf(dev.state.doc.animation));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await wait(500);
  report.apart = { drawnDistances: drawn() };
  report.apart.everythingMoved = drawn().every((d) => d > 1);

  if (input) {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await wait(500);
  report.together = { drawnDistances: drawn() };
  report.together.everythingBack = drawn().every((d) => d < 1e-6);
}

/* ---- and the model itself never moved ---- */
{
  const after = dev.bodies
    .filter((b) => b.solid)
    .map((b) => +K.boundingBox(b.solid).min[2].toFixed(3));
  report.modelUntouched =
    before.length === after.length && before.every((v, i) => Math.abs(v - after[i]) < 1e-6);
  report.modelZ = { before, after };
}

report.caption = {
  atZero: AN.captionAt(dev.state.doc.animation, 0),
  atTheEnd: AN.captionAt(dev.state.doc.animation, AN.lengthOf(dev.state.doc.animation))
};
report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
