/**
 * Opening a Fusion archive.
 *
 * An .f3d is a zip, and the geometry inside it is Autodesk ShapeManager: a fork
 * of ACIS with the same entity model and no published specification. The tags
 * and the record graph in asmread.js were worked out by reading real files, so
 * real files are what this checks against: a synthetic one would only prove the
 * reader agrees with my guesses.
 *
 * What is being checked is the honest boundary. A part made of planes,
 * cylinders, cones, spheres and tori comes in whole. One made of sculpted
 * surfaces comes in partly, and has to say which parts it could not read rather
 * than handing over something with faces missing and no warning, because a part
 * missing a face is a part you must not print.
 */

const dev = window.anvilDev;
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

const files = [
  'C:/Users/jkevi/Downloads/Diamond+Ore.f3d',
  'C:/Users/jkevi/Downloads/iPhone+15+Pro+Standby+Mode+Dock.f3d'
];

report.read = [];
for (const path of files) {
  const res = await window.anvil.readFileBytes?.(path);
  if (!res?.ok) {
    report.read.push({ path: path.split('/').pop(), missing: true, why: res?.error ?? null });
    continue;
  }
  const bytes = res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes);

  const archive = await dev.mesh.unzip(bytes);
  const blobs = Object.keys(archive).filter((n) => /\.smb$/i.test(n));

  let faces = 0;
  let unreadFaces = 0;
  let bodies = 0;
  let tris = 0;
  const unread = new Set();
  for (const blob of blobs) {
    const got = dev.asm.readASM(archive[blob]);
    faces += got.faces;
    unreadFaces += got.unreadFaces;
    bodies += got.bodies.length;
    for (const b of got.bodies) tris += b.mesh.triVerts.length / 3;
    for (const u of got.unread) unread.add(u);
  }
  report.read.push({
    file: path.split('/').pop(),
    brepBlobs: blobs.length,
    faces,
    unreadFaces,
    bodies,
    triangles: tris,
    couldNotRead: [...unread]
  });
}

const solid = report.read.find((r) => r.file && /Diamond/.test(r.file));
if (solid) {
  // A part built entirely from planes reads completely. If this ever stops
  // being true, the tag table has moved and everything below it is guesswork.
  report.analyticPartReadsWhole = solid.unreadFaces === 0 && solid.faces > 1000;
  report.andHasRealGeometry = solid.triangles > 1000 && solid.bodies > 0;
}
const sculpted = report.read.find((r) => r.file && /iPhone/.test(r.file));
if (sculpted) {
  report.sculptedPartReadsPartly = sculpted.faces > 0 && sculpted.unreadFaces > 0;
  // And says what it could not read, which is what tells somebody whether to
  // go back to Fusion and export a STEP instead.
  report.andSaysWhatItCouldNotRead = sculpted.couldNotRead.length > 0;
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
