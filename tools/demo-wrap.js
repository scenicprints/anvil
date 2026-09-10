/**
 * An image wrapped over a whole body, and wood grain cut through one.
 *
 * Both are the same trick: what a point looks like is worked out from where it
 * is in the world, not from coordinates painted onto the surface. A solid built
 * from features has no natural unwrapping, and every attempt to give it one puts
 * a seam somewhere and stretches the pattern where the surface curves.
 *
 * So what has to be checked is that the pattern is actually *there*, and the
 * only way to know is to measure the pixels. Building this the first time,
 * every intermediate wrong version looked identical from the outside: one flat
 * colour on the part. A texture that never uploaded, a shader that failed to
 * compile, a sampler that was not bound, and in the end a test image whose
 * gradients were drawn from a point to itself and painted nothing at all. Four
 * different faults, one symptom.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

/** A checker, which is the plainest thing whose absence is unmistakable. */
function checker(n) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, n, n);
  x.fillStyle = '#000000';
  x.fillRect(0, 0, n / 2, n / 2);
  x.fillRect(n / 2, n / 2, n / 2, n / 2);
  return c.toDataURL('image/png');
}

/* ---- a knob: a cylinder, a dome and a bore ---- */
dev.setTab('solid');
dev.state.doc.features = [
  { id: 'f1', type: 'primitive', shape: 'cylinder',
    params: { diameter: '46', height: '26', centered: false, x: '0', y: '0', z: '0' }, op: 'new' },
  { id: 'f2', type: 'primitive', shape: 'sphere',
    params: { diameter: '46', centered: false, x: '0', y: '0', z: '26' }, op: 'join', targets: 'all' }
];
dev.rebuildAll();
await wait(2000);
report.partBuilt = dev.bodies.length === 1;
if (!report.partBuilt) return { ...report, stuckAt: 'the test part did not build' };

const id = dev.bodies[0].id;
dev.state.vp.setCameraState({
  target: [0, 0, 20], radius: 150, phi: 1.1, theta: 0.7, perspective: true, zoom: 120
});
await wait(400);

/** What the viewport is showing, as pixels. */
function shot() {
  const src = dev.state.vp.canvas;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
}
/** How much the picture varies: a flat part has almost none. */
function variation(px) {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 250) continue;
    sum += px[i];
    sum2 += px[i] * px[i];
    n++;
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

dev.state.vp.render?.();
await wait(400);
const plain = shot();
report.plainVariation = +variation(plain).toFixed(1);

/* ---- wrap a checker over it ---- */
dev.state.doc.imageData = dev.state.doc.imageData || {};
dev.state.doc.imageData.imgcheck = { url: checker(64), width: 64, height: 64 };
dev.state.doc.wraps = { byBody: { [id]: {
  image: 'imgcheck', size: '12', angle: '0', x: '0', y: '0',
  strength: 1, sharpness: '4', mode: 'replace', tile: true
} } };
dev.rebuildAll();
await wait(1600);

const wrapped = shot();
report.wrappedVariation = +variation(wrapped).toFixed(1);
// A checker is the loudest thing an image can be. If the pattern arrived, the
// spread of brightness across the part goes up a long way; if anything in the
// chain quietly failed, the part is one flat colour and this barely moves.
report.thePatternIsThere = variation(wrapped) > variation(plain) * 2 + 8;

/* ---- and it is on every side, which is the whole point ---- */
{
  // Turned right round, the far side has to carry it too. A planar decal would
  // have nothing here at all.
  dev.state.vp.setCameraState({
    target: [0, 0, 20], radius: 150, phi: 1.1, theta: 0.7 + Math.PI, perspective: true, zoom: 120
  });
  await wait(600);
  const behind = shot();
  report.behindVariation = +variation(behind).toFixed(1);
  report.itIsOnTheOtherSideToo = variation(behind) > variation(plain) * 2 + 8;
}

/* ---- taking it off puts the body back ---- */
{
  dev.state.doc.wraps = { byBody: {} };
  dev.rebuildAll();
  await wait(1000);
  dev.state.vp.setCameraState({
    target: [0, 0, 20], radius: 150, phi: 1.1, theta: 0.7, perspective: true, zoom: 120
  });
  await wait(500);
  report.afterVariation = +variation(shot()).toFixed(1);
  report.takenOffAgain = Math.abs(variation(shot()) - variation(plain)) < 6;
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
