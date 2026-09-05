/**
 * Exercises the newer features and reports what the kernel measured.
 *
 * Half of this goes through the interface, clicking the ribbon and reading the
 * dialogs back, so the wiring is tested and not only the geometry.
 *
 * Runs inside the page via --anvil-script.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};
const mark = (m) => console.log('STEP ' + m);
const round = (v, n = 2) => Number(Number(v).toFixed(n));

function poly(planeSpec, pts, name) {
  const sk = {
    id: `sk_${name}`,
    name,
    plane: planeSpec,
    points: pts.map(([x, y]) => ({ x, y })),
    entities: pts.map((_, i) => ({ id: i + 1, type: 'line', p: [i, (i + 1) % pts.length] })),
    constraints: [],
    nextEntityId: pts.length + 1
  };
  dev.state.doc.sketches[sk.id] = sk;
  return sk;
}

function open(planeSpec, pts, name) {
  const sk = {
    id: `sk_${name}`,
    name,
    plane: planeSpec,
    points: pts.map(([x, y]) => ({ x, y })),
    entities: pts.slice(0, -1).map((_, i) => ({ id: i + 1, type: 'line', p: [i, i + 1] })),
    constraints: [],
    nextEntityId: pts.length
  };
  dev.state.doc.sketches[sk.id] = sk;
  return sk;
}

let n = 0;
const id = () => `f${++n}`;
const doc = dev.state.doc;

doc.parameters = [
  { name: 'stem_dia', expr: '12' },
  { name: 'stem_len', expr: '34' }
];

/* ---- a lofted body, a swept handle, a threaded stem ---- */

const base = poly('XY', [[-24, -16], [24, -16], [24, 16], [-24, 16]], 'Base');
const top = poly({ base: 'XY', offset: '18' }, [[-12, -9], [12, -9], [12, 9], [-12, 9]], 'Top');

const handleProfile = {
  id: 'sk_handle',
  name: 'Handle section',
  // The arch leaves its end going straight up, so the profile sits on a level
  // plane at that height, centred where the path starts.
  plane: { base: 'XY', offset: '14' },
  points: [{ x: -10, y: 0 }],
  entities: [{ id: 1, type: 'circle', c: 0, r: 3 }],
  constraints: [],
  nextEntityId: 2
};
doc.sketches[handleProfile.id] = handleProfile;

// An arch over the top, drawn as a spline so the sweep has something to bend on.
const arch = {
  id: 'sk_arch',
  name: 'Handle path',
  plane: 'XZ',
  points: [
    { x: -10, y: 14 },
    { x: -9, y: 30 },
    { x: 0, y: 36 },
    { x: 9, y: 30 },
    { x: 10, y: 14 }
  ],
  entities: [{ id: 1, type: 'spline', p: [0, 1, 2, 3, 4] }],
  constraints: [],
  nextEntityId: 2
};
doc.sketches[arch.id] = arch;

doc.features = [
  { id: id(), type: 'sketch', sketch: base.id },
  { id: id(), type: 'sketch', sketch: top.id },
  {
    id: id(),
    type: 'loft',
    sections: [{ sketch: base.id }, { sketch: top.id }],
    op: 'new',
    targets: 'all'
  },
  { id: id(), type: 'sketch', sketch: handleProfile.id },
  { id: id(), type: 'sketch', sketch: arch.id },
  {
    id: id(),
    type: 'sweep',
    sketch: handleProfile.id,
    path: { sketch: arch.id },
    twist: '0',
    scale: '1',
    op: 'join',
    targets: 'all'
  },
  {
    id: id(),
    type: 'primitive',
    shape: 'cylinder',
    op: 'join',
    targets: 'all',
    params: {
      diameter: 'stem_dia',
      height: 'stem_len',
      centered: false,
      x: '0',
      y: '0',
      z: '-stem_len'
    }
  },
  {
    id: id(),
    type: 'thread',
    bodies: 'all',
    diameter: 'stem_dia',
    pitch: '1.75',
    length: '20',
    clearance: '0.2',
    plane: { base: 'XY', offset: '-stem_len' }
  }
];

mark('build part');
dev.rebuildAll();
await wait(200);
mark('part built');

report.builtPart = {
  bodies: dev.bodies.length,
  volume_cm3: round(dev.bodies.reduce((s, b) => s + b.solid.volume(), 0) / 1000, 3),
  triangles: dev.bodies.reduce((s, b) => s + b.solid.numTri(), 0),
  genus: dev.bodies.map((b) => b.solid.genus()),
  errors: dev.state.result.errors.map((e) => e.message)
};

/* ---- a construction plane, then a sketch that follows it ---- */

mark('construction');
doc.features.push({
  id: id(),
  type: 'construction',
  entry: { id: 'cx_mid', type: 'planeOffset', base: 'XY', name: 'Mid', distance: '9' }
});
dev.rebuildAll();
await wait(100);
report.constructionPlane = dev.state.result.construction.get('cx_mid')
  ? { origin: dev.state.result.construction.get('cx_mid').origin.map((v) => round(v, 3)) }
  : 'not built';

/* ---- an assembly: the part, plus a lid on a hinge ---- */

mark('components');
dev.runCommand('newComponent');
await wait(80);
dev.runCommand('newComponent');
await wait(80);
const comps = doc.components;
report.components = comps.map((c) => `${c.name}${c.grounded ? ' (grounded)' : ''}`);

doc.features.push({
  id: id(),
  type: 'primitive',
  shape: 'box',
  op: 'new',
  targets: 'all',
  component: comps[1].id,
  params: {
    width: '48',
    depth: '32',
    height: '4',
    centered: false,
    x: '-24',
    y: '-16',
    z: '18'
  }
});

mark('joint');
doc.joints.push({
  id: 'j1',
  name: 'Lid hinge',
  type: 'revolute',
  parent: comps[0].id,
  child: comps[1].id,
  origin: { p: [-24, 0, 20], axis: [0, 1, 0] },
  angle: '0'
});

dev.rebuildAll();
await wait(150);
const closedBox = dev.bodies.map((b) => round(b.solid.boundingBox().max[2], 2));

mark('swing');
doc.joints[0].angle = '-55';
dev.rebuildAll();
await wait(150);
const openBox = dev.bodies.map((b) => round(b.solid.boundingBox().max[2], 2));

report.hinge = {
  topOfEachBodyClosed: closedBox,
  topOfEachBodyOpen: openBox,
  errors: dev.state.result.errors.map((e) => e.message)
};

/* ---- check the new ribbon buttons actually open something ---- */

const buttons = ['sweep', 'loft', 'rib', 'thread', 'draft', 'splitBody', 'construct'];
const opened = {};
for (const cmd of buttons) {
  mark('button ' + cmd);
  const btn = document.querySelector(`[data-cmd="${cmd}"]`);
  if (!btn) {
    opened[cmd] = 'no button';
    continue;
  }
  btn.click();
  await wait(120);
  const title = document.getElementById('inspectorTitle').textContent;
  const visible = !document.getElementById('inspector').classList.contains('hidden');
  opened[cmd] = visible ? title : document.getElementById('status').textContent;
  const cancel = document.getElementById('inspectorCancel');
  if (visible) cancel.click();
  await wait(80);
}
mark('dialogs done');
report.dialogs = opened;

dev.state.vp.fit(1.35);
dev.state.vp.setView([0.55, -0.78, 0.3]);
dev.setStatus('Advanced feature demo complete.');
await wait(400);

report.timeline = doc.features.map((f) => f.type);
report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
