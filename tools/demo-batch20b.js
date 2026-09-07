/**
 * Batch 20, second half: inserting a part from another document, a canvas to
 * trace over, and a decal on a face.
 *
 * All three commands begin with a native file dialog, which would stop a demo
 * dead, so what is driven here is everything after that: the feature that turns
 * another document's bodies into this one's, and the two image things once the
 * image is in hand. The menu itself is opened and read the way a person opens
 * it.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const K = await import('./kernel.js');
const DC = await import('./decal.js');

const status = () => document.getElementById('status').textContent;
const solids = () => dev.bodies.filter((b) => b.solid);

/** A small image, made here rather than read off a disk. */
function swatch(colour) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32">` +
    `<rect width="64" height="32" fill="${colour}"/>` +
    `<circle cx="16" cy="16" r="10" fill="white"/></svg>`;
  return { url: `data:image/svg+xml;base64,${btoa(svg)}`, width: 64, height: 32 };
}

/* ---- the menu ---- */
dev.setTab('mesh');
await wait(200);
report.menu = { opens: false, items: [] };
{
  document.querySelector('[data-menu="insertParts"]').click();
  await wait(200);
  report.menu.items = [...document.querySelectorAll('#markmenu button')].map((b) =>
    b.textContent.trim()
  );
  report.menu.opens = report.menu.items.length > 0;
  document.body.click();
  await wait(150);
}

/* ---- a part inserted from another document's bodies ---- */
{
  // What another document would have handed over: a box, as triangles.
  dev.setTab('solid');
  dev.runCommand('primBox');
  await wait(400);
  document.getElementById('inspectorOk').click();
  await wait(600);
  const box = solids()[0];
  const mesh = K.meshData(box.solid);
  const was = box.solid.volume();

  const doc = dev.state.doc;
  const key = 'meshFromElsewhere';
  doc.meshData[key] = {
    verts: Array.from(mesh.vertProperties),
    tris: Array.from(mesh.triVerts)
  };
  doc.components = doc.components || [];
  doc.components.push({ id: 'compIn', name: 'Bought part', transform: null });
  doc.features.push({
    id: 'fin',
    type: 'insertComponent',
    component: 'compIn',
    data: [key],
    label: 'Bought part',
    scale: '1',
    at: [40, 0, 0],
    source: { path: 'C:/elsewhere/bought.anvil', modified: 0, bodies: 1 }
  });
  dev.rebuildAll();
  await wait(600);

  const inserted = solids().find((b) => b.component === 'compIn');
  report.insert = {
    cameAcross: !!inserted,
    isASolid: !!inserted?.solid,
    sameVolume: inserted ? Math.abs(inserted.solid.volume() - was) < 1 : false,
    // It went in where it was told to, not on top of what was already there.
    movedTo: inserted ? +K.boundingBox(inserted.solid).min[0].toFixed(1) : null,
    errors: (dev.state.result?.errors || []).map((e) => e.message)
  };
}

/* ---- a canvas on a plane ---- */
{
  const img = swatch('#4a7fb8');
  const doc = dev.state.doc;
  const key = 'imgCanvas';
  doc.imageData[key] = img;
  doc.canvases = doc.canvases || {};
  doc.canvases.cv1 = {
    id: 'cv1',
    name: 'Traced photo',
    image: key,
    plane: 'XY',
    width: 120,
    height: (120 * img.height) / img.width,
    x: 0,
    y: 0,
    turn: 30,
    opacity: 0.5,
    behind: true
  };
  dev.rebuildAll();
  await wait(500);

  const held = dev.state.vp._canvases;
  const entry = held?.get('cv1');
  report.canvas = {
    drawn: !!entry,
    // The real width, not the pixel width: an image has pixels and a part has
    // millimetres, and the point of the panel is to say which is which.
    width: entry ? +entry.mesh.scale.x.toFixed(1) : null,
    height: entry ? +entry.mesh.scale.y.toFixed(1) : null,
    opacity: entry ? +entry.mat.opacity.toFixed(2) : null,
    behindTheModel: entry ? entry.mesh.renderOrder < 0 : null,
    // A canvas must never be what a click lands on.
    notPickable: entry ? entry.mesh.userData.pickable == null : null
  };
}

/* ---- a decal on a face ---- */
{
  const box = solids()[0];
  const rec = (dev.state.records || []).find((r) => r.id === box.id);
  const top = rec.topology.faces.reduce(
    (best, f, i) => (f.normal[2] > 0.99 && f.area > (rec.topology.faces[best]?.area ?? 0) ? i : best),
    0
  );
  const face = rec.topology.faces[top];
  const img = swatch('#b8564a');
  const doc = dev.state.doc;
  doc.imageData.imgDecal = img;
  doc.decals = doc.decals || {};
  doc.decals.dc1 = {
    id: 'dc1',
    name: 'Badge',
    image: 'imgDecal',
    face: dev.faceReference(face, rec.topology),
    frame: {
      origin: [0, 1, 2].map((i) => face.centre[i] + face.normal[i]),
      x: [1, 0, 0],
      y: [0, 1, 0],
      n: face.normal.map((v) => -v)
    },
    width: 12,
    height: (12 * img.height) / img.width,
    x: 0,
    y: 0,
    turn: 0,
    opacity: 1
  };
  dev.rebuildAll();
  await wait(600);

  const held = dev.state.vp._decals;
  const entry = [...(held || new Map()).values()][0];
  report.decal = {
    drawn: !!entry,
    triangles: entry ? entry.mesh.geometry.getIndex().count / 3 : 0,
    notPickable: entry ? entry.mesh.userData.pickable == null : null,
    // Cut to the image, so it is exactly the size asked for and no bigger.
    ...(entry
      ? (() => {
          const pos = entry.mesh.geometry.getAttribute('position');
          const xs = [];
          for (let i = 0; i < pos.count; i++) xs.push(pos.getX(i));
          return { widthOnThePart: +(Math.max(...xs) - Math.min(...xs)).toFixed(3) };
        })()
      : {})
  };
  report.decal.askedFor = 12;
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
