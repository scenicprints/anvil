/**
 * Builds a representative printed part through the document model, the same
 * structures the interface writes, then reports what the kernel measured.
 *
 * Runs inside the page via --anvil-script.
 */

const dev = window.anvilDev;
const doc = dev.state.doc;

let n = 0;
const id = (p) => `${p}${++n}`;

doc.parameters = [
  { name: 'plate_len', expr: '80' },
  { name: 'plate_wid', expr: '50' },
  { name: 'thick', expr: '6' },
  { name: 'hole_dia', expr: '5' },
  { name: 'edge', expr: '9' },
  { name: 'boss_dia', expr: '22' },
  { name: 'boss_h', expr: '14' }
];

/* ---- the plate outline, a rectangle with rounded corners ---- */

const plate = {
  id: 'sk_plate',
  name: 'Plate',
  plane: 'XY',
  points: [],
  entities: [],
  constraints: [],
  nextEntityId: 1
};

const L = 80;
const W = 50;
const R = 10;
const addPt = (x, y) => (plate.points.push({ x, y }), plate.points.length - 1);

// Corner centres, then the four straight runs and four arcs between them.
const corners = [
  { cx: L / 2 - R, cy: W / 2 - R, a0: 0, a1: 90 },
  { cx: -L / 2 + R, cy: W / 2 - R, a0: 90, a1: 180 },
  { cx: -L / 2 + R, cy: -W / 2 + R, a0: 180, a1: 270 },
  { cx: L / 2 - R, cy: -W / 2 + R, a0: 270, a1: 360 }
];

const rad = (d) => (d * Math.PI) / 180;
const ring = [];
for (const c of corners) {
  const centre = addPt(c.cx, c.cy);
  const start = addPt(c.cx + R * Math.cos(rad(c.a0)), c.cy + R * Math.sin(rad(c.a0)));
  const end = addPt(c.cx + R * Math.cos(rad(c.a1)), c.cy + R * Math.sin(rad(c.a1)));
  ring.push({ centre, start, end });
}

for (let i = 0; i < ring.length; i++) {
  const cur = ring[i];
  const next = ring[(i + 1) % ring.length];
  plate.entities.push({
    id: plate.nextEntityId++,
    type: 'arc',
    c: cur.centre,
    p: [cur.start, cur.end],
    ccw: true
  });
  plate.entities.push({
    id: plate.nextEntityId++,
    type: 'line',
    p: [cur.end, next.start]
  });
}

doc.sketches[plate.id] = plate;

/* ---- fixing holes ---- */

const holes = {
  id: 'sk_holes',
  name: 'Fixing holes',
  plane: 'XY',
  points: [],
  entities: [],
  constraints: [],
  nextEntityId: 1
};
for (const [sx, sy] of [
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1]
]) {
  holes.points.push({ x: sx * (L / 2 - 9), y: sy * (W / 2 - 9) });
  holes.entities.push({
    id: holes.nextEntityId++,
    type: 'point',
    p: holes.points.length - 1
  });
}
doc.sketches[holes.id] = holes;

/* ---- timeline ---- */

doc.features = [
  { id: id('f'), type: 'sketch', sketch: plate.id },
  {
    id: id('f'),
    type: 'extrude',
    sketch: plate.id,
    seeds: null,
    distance: 'thick',
    direction: 'one',
    taper: '0',
    op: 'new',
    targets: 'all'
  },
  {
    id: id('f'),
    type: 'primitive',
    shape: 'cylinder',
    op: 'join',
    targets: 'all',
    params: {
      diameter: 'boss_dia',
      height: 'boss_h',
      centered: false,
      x: '0',
      y: '0',
      z: '0'
    }
  },
  { id: id('f'), type: 'sketch', sketch: holes.id },
  {
    id: id('f'),
    type: 'hole',
    sketch: holes.id,
    points: [0, 1, 2, 3],
    diameter: 'hole_dia',
    through: true,
    counterbore: true,
    cbDiameter: 'hole_dia * 2',
    cbDepth: '2.5',
    countersink: false
  },
  {
    id: id('f'),
    type: 'primitive',
    shape: 'cylinder',
    op: 'cut',
    targets: 'all',
    params: {
      diameter: '10',
      height: 'boss_h * 3',
      centered: true,
      x: '0',
      y: '0',
      z: '0'
    }
  }
];

doc.rollback = null;
dev.rebuildAll();
dev.state.vp.fit(1.5);
dev.state.vp.setView([0.55, -0.75, 0.42]);
dev.setStatus('Bracket built from the demo script.');

await new Promise((r) => setTimeout(r, 500));

const bodies = dev.bodies;

return {
  bodies: bodies.length,
  bodyNames: bodies.map((b) => b.name),
  errors: dev.state.result.errors,
  paramErrors: dev.state.result.paramErrors,
  triangles: bodies.reduce((s, b) => s + b.solid.numTri(), 0),
  volume_cm3: Number((bodies.reduce((s, b) => s + b.solid.volume(), 0) / 1000).toFixed(3)),
  genus: bodies.map((b) => b.solid.genus()),
  boundingBox: bodies.map((b) => b.solid.boundingBox())
};
