/**
 * A texture that is really there.
 *
 * Not a picture of one. The surface is pushed in and out until the pattern is
 * geometry, so it survives slicing and you can feel it on the printed part.
 * Fusion has nothing like this: its appearances and its decals are both
 * pictures, and neither reaches the geometry.
 *
 * The unit tests cover the arithmetic. What this covers is the thing they
 * cannot: that a feature in the timeline turns a plain solid into a textured
 * one that is still a solid. A displaced mesh that is no longer watertight is
 * refused by the kernel with two words and no clue which triangle was at fault,
 * so "did it still come out a solid" is the question worth asking of the whole
 * path.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

/** A picture of ridges, which is the plainest thing you can feel. */
function ridges(n) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const x = c.getContext('2d');
  const img = x.createImageData(n, n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = Math.round((Math.sin((i / n) * Math.PI * 6) * 0.5 + 0.5) * 255);
      const k = (j * n + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
      img.data[k + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  const out = c.getContext('2d').getImageData(0, 0, n, n).data;
  const gray = new Array(n * n);
  for (let i = 0; i < gray.length; i++) gray[i] = out[i * 4];
  return { width: n, height: n, gray };
}

dev.setTab('solid');
dev.state.doc.features = [
  { id: 'f1', type: 'primitive', shape: 'box',
    params: { width: '30', depth: '30', height: '30', centered: true }, op: 'new' }
];
dev.rebuildAll();
await wait(1500);
report.builtPlain = dev.bodies.length === 1 && !!dev.bodies[0].solid;
if (!report.builtPlain) return { ...report, stuckAt: 'the test part did not build' };

const plainTris = dev.state.records[0].mesh.triVerts.length / 3;
const plainVolume = dev.bodies[0].solid.volume();
report.plainTriangles = plainTris;

/* ---- put a texture on it ---- */
dev.state.doc.imageData = dev.state.doc.imageData || {};
dev.state.doc.imageData.imgridges = ridges(64);
dev.state.doc.features.push({
  id: 'f2', type: 'textureRelief', bodies: 'all', faces: [],
  image: 'imgridges', depth: '1.2', size: '10', angle: '0', detail: '1',
  sharpness: '4', mode: 'both'
});
dev.rebuildAll();
await wait(6000);

report.buildErrors = (dev.state.result?.errors || []).map((e) => e.message);
report.builtWithoutComplaint = report.buildErrors.length === 0;

const rec = dev.state.records[0];
report.texturedTriangles = rec?.mesh ? rec.mesh.triVerts.length / 3 : 0;
// A surface can only carry as much detail as it has vertices, so the whole
// feature begins by making many more of them. A box has twelve triangles and
// there is nowhere for a picture to land on twelve triangles.
report.theSurfaceWasDivided = report.texturedTriangles > plainTris * 50;

// Still a solid, which is what says the displaced mesh stayed watertight. This
// is the check that would have caught the pentagon filled with a triangle of
// three points in a line.
report.stillASolid = !!dev.bodies[0]?.solid;

/* ---- and the geometry really moved ---- */
{
  const mesh = rec.mesh;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp) {
    lo = Math.min(lo, mesh.vertProperties[i + 2]);
    hi = Math.max(hi, mesh.vertProperties[i + 2]);
  }
  report.reach = [Number(lo.toFixed(2)), Number(hi.toFixed(2))];
  // The box was 30 tall with its faces at plus and minus 15, and a texture of
  // 1.2 deep moves the surface up to 0.6 either way.
  report.itStandsOutAndCutsIn = hi > 15.05 && lo < -15.05 && hi < 15.7 && lo > -15.7;

  // Mid grey is the surface as it was and the pattern is balanced about it, so
  // the part is the size it was to within a fraction of a per cent.
  const volume = dev.bodies[0].solid.volume();
  report.volumeBarelyMoved = Math.abs(volume - plainVolume) / plainVolume < 0.02;
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
