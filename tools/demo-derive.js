/**
 * Deriving from another document, and letting go of it.
 *
 * Fusion's Derive takes what you choose out of another design and keeps
 * pointing at it, so a change over there arrives here when you ask for it. The
 * part that goes wrong is not the taking, it is the second taking: a refresh
 * that added to what was already here would double the sketches every time, and
 * a parameter dropped over there would linger here for ever.
 *
 * So this derives, changes the source, derives again, and counts. Then it
 * breaks the link and checks that what came through it stayed.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

const D = dev.derive;
report.hasTheParts = !!D?.contentsOfDocument && !!D?.applyDerived;
if (!report.hasTheParts) return { ...report, stuckAt: 'the derive helpers are not exposed' };

/** A small document to derive from, as the text a file would hold. */
const sourceDoc = (width) => ({
  name: 'Bracket',
  parameters: [{ name: 'wall', expr: String(width), comment: 'How thick' }],
  sketches: {
    sk1: {
      id: 'sk1',
      name: 'Footprint',
      plane: 'XY',
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 }
      ],
      entities: [
        { id: 1, type: 'line', p: [0, 1] },
        { id: 2, type: 'line', p: [1, 2] },
        { id: 3, type: 'line', p: [2, 3] },
        { id: 4, type: 'line', p: [3, 0] }
      ],
      constraints: [],
      nextEntityId: 5
    }
  },
  features: [
    {
      id: 'fbox',
      type: 'primitive',
      shape: 'box',
      params: { width: String(width), depth: '20', height: '10', centered: true },
      op: 'new'
    }
  ],
  meshData: {},
  components: []
});

/* ---- what the other document has to offer ---- */
const got = await D.contentsOfDocument(JSON.stringify(sourceDoc(30)));
report.readTheOtherDocument = !!got;
if (!got) return { ...report, stuckAt: 'the source document did not rebuild' };
report.offered = {
  bodies: got.bodies.map((b) => b.name),
  sketches: got.sketches.map((s) => s.name),
  parameters: got.parameters.map((p) => p.name)
};

/* ---- derive all three kinds ---- */
const feature = {
  id: 'fderive',
  type: 'insertComponent',
  component: null,
  data: [],
  label: got.name,
  scale: '1',
  at: [0, 0, 0],
  source: { name: 'parts/Bracket.anvil', path: 'C:/nowhere/Bracket.anvil', take: null }
};
const take = {
  bodies: got.bodies.map((b) => b.name),
  sketches: got.sketches.map((s) => s.name),
  parameters: got.parameters.map((p) => p.name)
};
feature.source.take = take;
dev.state.doc.features.push(feature);
D.applyDerived(feature, got, take);
dev.rebuildAll();
await wait(900);

report.took = D.describeTaken(feature);
report.bodiesLanded = feature.data.length === 1;
report.sketchLanded =
  feature.derivedSketches.length === 1 &&
  !!dev.state.doc.sketches[feature.derivedSketches[0]];
report.parameterLanded = (dev.state.doc.parameters || []).some((p) => p.name === 'wall');
// A derived sketch is not this document's to edit, and it says so, or the next
// refresh would throw an edit away without a word.
report.sketchKnowsWhereItCameFrom =
  dev.state.doc.sketches[feature.derivedSketches[0]]?.derivedFrom === feature.id;
report.sketchHasAFeature = (dev.state.doc.features || []).some(
  (f) => f.type === 'sketch' && f.derivedFrom === feature.id
);
report.oneBodyBuilt = dev.bodies.length === 1;
report.widthBefore = dev.bodies.length
  ? Number(
      (
        dev.bodies[0].solid.boundingBox().max[0] - dev.bodies[0].solid.boundingBox().min[0]
      ).toFixed(2)
    )
  : null;

/* ---- the source changes, and the derive is taken again ---- */
{
  const again = await D.contentsOfDocument(JSON.stringify(sourceDoc(50)));
  D.applyDerived(feature, again, take);
  dev.rebuildAll();
  await wait(900);

  report.stillOneBody = feature.data.length === 1;
  report.stillOneSketch = feature.derivedSketches.length === 1;
  report.parametersNotDoubled =
    (dev.state.doc.parameters || []).filter((p) => p.derivedFrom === feature.id).length === 1;
  report.sketchesNotDoubled =
    Object.values(dev.state.doc.sketches).filter((sk) => sk.derivedFrom === feature.id).length === 1;
  report.sketchFeaturesNotDoubled =
    (dev.state.doc.features || []).filter(
      (f) => f.type === 'sketch' && f.derivedFrom === feature.id
    ).length === 1;
  // And the meshes from last time went with it rather than piling up.
  report.meshDataNotPilingUp = Object.keys(dev.state.doc.meshData).length === 1;

  report.widthAfter = dev.bodies.length
    ? Number(
        (
          dev.bodies[0].solid.boundingBox().max[0] - dev.bodies[0].solid.boundingBox().min[0]
        ).toFixed(2)
      )
    : null;
  report.theChangeCameThrough = report.widthAfter === 50 && report.widthBefore === 30;
  report.parameterFollowed = (dev.state.doc.parameters || []).find((p) => p.name === 'wall')?.expr === '50';
}

/* ---- a name collision keeps the two apart ---- */
{
  dev.state.doc.parameters.push({ name: 'gap', expr: '3' });
  const other = await D.contentsOfDocument(
    JSON.stringify({ ...sourceDoc(30), name: 'Lid', parameters: [{ name: 'gap', expr: '9' }] })
  );
  const second = {
    id: 'fderive2',
    type: 'insertComponent',
    data: [],
    label: 'Lid',
    scale: '1',
    at: [0, 0, 0],
    source: { name: 'parts/Lid.anvil', path: null, take: { bodies: [], sketches: [], parameters: ['gap'] } }
  };
  dev.state.doc.features.push(second);
  D.applyDerived(second, other, second.source.take);

  const ours = dev.state.doc.parameters.find((p) => p.name === 'gap');
  report.ourGapUntouched = ours?.expr === '3';
  report.theirGapRenamed = dev.state.doc.parameters.some(
    (p) => p.name === 'Lid_gap' && p.expr === '9'
  );
}

/* ---- what is linked, and what happens when the link goes ---- */
{
  report.linkedCount = D.derivedFeatures().length;
  const before = Object.keys(dev.state.doc.meshData).length;
  for (const f of D.derivedFeatures()) f.source = null;
  report.nothingLinkedNow = D.derivedFeatures().length === 0;
  // Breaking a link keeps the geometry. That is the whole difference between
  // breaking it and deleting the feature.
  report.geometryStayed = Object.keys(dev.state.doc.meshData).length === before;
}

/* ---- and the library, which is what a link is named against ---- */
{
  const lib = await window.anvil.library?.();
  report.libraryAsked = !!lib;
  report.libraryRoot = lib?.root ?? null;
  // A name that is not in the library and a path that is not there either has
  // to fail with a reason, not silently.
  const miss = await window.anvil.readLinked?.('nowhere/nothing.anvil', 'C:/nowhere/nothing.anvil');
  report.missingLinkSaysSo = miss?.ok === false && !!miss.error;
  report.whatItSaid = miss?.error ?? null;
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
