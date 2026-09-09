/**
 * The photoreal render.
 *
 * What makes a render of a part look real is almost never the lights, it is
 * what the surfaces have to reflect. A steel bracket lit by three lamps in an
 * empty void reads as grey plastic, because a mirror with nothing in front of
 * it is grey.
 *
 * So what is checked here is that the three things that matter actually
 * happened: there is an environment to reflect, there is a shadow on the ground
 * under the part, and the highlights roll off instead of clipping to white. All
 * three are measured off the pixels, because every one of them can be wired up
 * correctly and still produce nothing, and a render that quietly comes out flat
 * looks exactly like a render that came out right until you look at it.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

/* ---- a part with something to catch the light: a boss, a bore, a fillet ---- */
dev.setTab('solid');
dev.state.doc.features = [
  { id: 'f1', type: 'primitive', shape: 'box',
    params: { width: '60', depth: '40', height: '8', centered: true }, op: 'new' },
  { id: 'f2', type: 'primitive', shape: 'cylinder',
    params: { diameter: '22', height: '18', centered: false, x: '0', y: '0', z: '4' },
    op: 'join', targets: 'all' },
  { id: 'f3', type: 'primitive', shape: 'cylinder',
    params: { diameter: '10', height: '40', centered: false, x: '0', y: '0', z: '-10' },
    op: 'cut', targets: 'all' },
  { id: 'f4', type: 'fillet', bodies: 'all', sets: [{ radius: '2', all: true }] }
];
dev.state.doc.materials = { default: 'aluminium' };
dev.rebuildAll();
await wait(2500);
report.partBuilt = dev.bodies.length === 1;
if (!report.partBuilt) return { ...report, stuckAt: 'the test part did not build' };

dev.state.vp.setCameraState({
  target: [0, 0, 4], radius: 150, phi: 1.05, theta: 0.9, perspective: true, zoom: 120
});
await wait(300);

/** Every pixel of a render, so it can be measured rather than looked at. */
async function pixelsOf(opts) {
  const canvas = await dev.renderNow({
    width: 480, height: 360, samples: 12, softness: 0.06,
    background: '#f2f0ec', ...opts
  });
  const ctx = canvas.getContext('2d');
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** How many distinct greys there are: a picture that drew nothing has one. */
function shades(px) {
  const seen = new Set();
  for (let i = 0; i < px.length; i += 4) seen.add(px[i] >> 2);
  return seen.size;
}

/** How far two renders differ, per pixel, on average. */
function difference(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length / 4);
}

/**
 * How much of the lower half is in soft shadow.
 *
 * A shadow is neither the background nor the part: it is a band of greys a
 * little darker than the paper. Counting that band is what separates a real
 * shadow from the dark edge of the part, which the flat render has too.
 */
function shadowed(px, w, h, bg) {
  let n = 0;
  for (let y = Math.floor(h * 0.55); y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = px[(y * w + x) * 4];
      if (v < bg - 8 && v > bg - 70) n++;
    }
  }
  return n;
}
/** How much of the picture is pure white, which is what a clipped highlight is. */
function clipped(px) {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 253 && px[i + 1] > 253) n++;
  return n / (px.length / 4);
}
/** How dark the darkest thing in the lower half is: the shadow on the ground. */
function darkestBelow(px, w, h) {
  let darkest = 255;
  for (let y = Math.floor(h * 0.55); y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      darkest = Math.min(darkest, px[i]);
    }
  }
  return darkest;
}

const W = 480;
const H = 360;

/* ---- flat: what the working view looks like ---- */
const flat = await pixelsOf({ photoreal: false });
report.flatDrewSomething = shades(flat) > 3;

/* ---- and the photograph ---- */
const photo = await pixelsOf({ photoreal: true, ground: true, exposure: 1, environment: 1 });
report.photoDrewSomething = shades(photo) > 3;

/*
 * The two are not the same picture.
 *
 * Counting distinct shades was the first thing tried here and it is the wrong
 * measure: tone mapping compresses the range, so a richer picture can hold
 * fewer quantised values than a flat one. What actually says the studio was
 * built and applied is how far the pixels moved.
 */
report.flatShades = shades(flat);
report.photoShades = shades(photo);
report.howFarApart = +difference(flat, photo).toFixed(1);
report.itIsADifferentPicture = difference(flat, photo) > 8;

/*
 * The shadow. The part sits on a plane and the light is off to one side, so
 * somewhere in the lower half of the picture there has to be something
 * markedly darker than the background it is falling on.
 */
const bg = 0xf2;
report.darkestBelowPhoto = darkestBelow(photo, W, H);
report.shadowPixelsFlat = shadowed(flat, W, H, bg);
report.shadowPixelsPhoto = shadowed(photo, W, H, bg);
// Not "is there anything dark", which the flat render satisfies with the near
// edge of the part. A shadow is a broad band of soft grey on the paper.
report.thereIsAShadow = shadowed(photo, W, H, bg) > shadowed(flat, W, H, bg) + 2000;

/*
 * And the highlights roll off rather than clipping. ACES is what stops a lit
 * edge on metal going flat white and taking the shape of the part with it, so
 * the photograph must not have more blown-out pixels than the flat render.
 */
report.clippedFlat = +(clipped(flat) * 100).toFixed(2);
report.clippedPhoto = +(clipped(photo) * 100).toFixed(2);
report.highlightsRollOff = clipped(photo) <= clipped(flat) + 0.005;

/* ---- and none of it stayed behind ---- */
{
  // A render must not leave the working view changed. Every one of these is
  // something the studio turns on, and every one has to be off again.
  const vp = dev.state.vp;
  report.shadowsOffAgain = vp.renderer.shadowMap.enabled === false;
  report.toneMappingOffAgain = vp.renderer.toneMapping === 0;
  report.environmentOffAgain = !vp.scene.environment;
  const stray = [];
  vp.scene.traverse((o) => {
    if (o.material && o.material.isShadowMaterial) stray.push(o.name || 'a shadow plane');
  });
  report.groundTakenAway = stray.length === 0;
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
