/**
 * Anvil test suite.
 *
 * Runs inside a hidden Electron window because the kernel is WebAssembly and
 * the geometry code is written against browser modules. Checks are on measured
 * quantities, volume, bounding box, triangle counts, solved coordinates, so a
 * regression in the maths fails the run rather than only a thrown exception.
 */

import * as THREE from '../src/renderer/three.js';
import { initKernel } from '../src/renderer/kernel.js';
import * as K from '../src/renderer/kernel.js';
import { evaluate, resolveParameters } from '../src/renderer/expr.js';
import { solveSketch } from '../src/renderer/solver.js';
import {
  findRegions,
  materializeSketch,
  signedArea,
  circleSegments,
  entityLoops,
  entityRuns,
  ellipseFrame,
  tessellate
} from '../src/renderer/profile.js';
import { textContours } from '../src/renderer/textoutline.js';
import { parseSVG, parseDXF } from '../src/renderer/vectorimport.js';
import {
  massProperties,
  combinedMass,
  interferences,
  draftColours,
  intersectionRuns,
  densityOf,
  vertexCurvature,
  minimumRadiusColours,
  zebraColours,
  accessibilityColours,
  curvatureComb,
  meshExtent,
  designAdvice,
  thicknessAt,
  meshSize,
  spunProfile
} from '../src/renderer/analysis.js';
import { sectionedMesh } from '../src/renderer/features.js';
import { buildTopology } from '../src/renderer/topology.js';
import {
  faceReference,
  edgeReference,
  resolveFaceRefs,
  resolveEdgeRefs
} from '../src/renderer/edgefeature.js';
import { bakeBodies } from '../src/renderer/features.js';
import {
  solveAssembly,
  newComponent,
  captureJointOrigin,
  limitByContact,
  JOINT_TYPES
} from '../src/renderer/assembly.js';
import {
  newDocument,
  newSketch,
  rebuild,
  uid,
  resolvePlane,
  sketchToWorld,
  normalizeSheetRules,
  RebuildCache,
  topologyOptions,
  meshOf
} from '../src/renderer/features.js';
import {
  toBinarySTL,
  toOBJ,
  parseSTL,
  parseOBJ,
  parse3MFModel,
  parse3MF,
  meshReaderFor,
  buildGeometry,
  buildEdges,
  to3MF,
  zipStore
} from '../src/renderer/meshutil.js';
import * as RC from '../src/renderer/recognise.js';
import * as SEL from '../src/renderer/select.js';
import * as PL from '../src/renderer/plastic.js';
import * as AS from '../src/renderer/assembly.js';
import { parseSTEP, stepHeader, Ref, Enum, UNSET } from '../src/renderer/stepfile.js';
import * as BL from '../src/renderer/blend.js';
import { readSTEP } from '../src/renderer/stepread.js';
import * as SH from '../src/renderer/sheet.js';
import * as SM from '../src/renderer/sheetmetal.js';
import * as MT from '../src/renderer/meshtools.js';
import * as FM from '../src/renderer/form.js';
import { screenUpFor, rollTheta, ISO_VIEW } from '../src/renderer/viewport.js';
import { resolveDimensionExprs } from '../src/renderer/features.js';

/**
 * A zip holding one stored file.
 *
 * Stored rather than deflated, so the test needs no compressor of its own. What
 * it exercises is the archive walk, which is the part of reading a 3MF that can
 * be got wrong quietly.
 */
function storedZip(name, data) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const crc = crc32(data);
  const parts = [];

  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, 0, true); // stored
  lv.setUint32(14, crc, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  parts.push(local, data);

  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(10, 0, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + data.length, true);

  const total = local.length + data.length + central.length + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of [local, data, central, end]) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const results = [];
let failures = 0;

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    failures++;
    results.push({ name, ok: false, error: err.message || String(err) });
  }
}

/**
 * The same, for a check that has to wait for something.
 *
 * It has to be awaited at the call site. Handing an async function to `test`
 * would pass every time, because the promise it returns is not the failure and
 * the try block is long over by the time one happens.
 */
async function asyncTest(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    failures++;
    results.push({ name, ok: false, error: err.message || String(err) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function near(actual, expected, tol, what) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${what || 'value'}: expected ${expected} +/- ${tol}, got ${actual}`);
  }
}

/* ------------------------------------------------------------------ */

function rectSketch(w, h, plane = 'XY') {
  const sk = newSketch(plane, 'Rect');
  sk.points = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h }
  ];
  sk.entities = [
    { id: 1, type: 'line', p: [0, 1] },
    { id: 2, type: 'line', p: [1, 2] },
    { id: 3, type: 'line', p: [2, 3] },
    { id: 4, type: 'line', p: [3, 0] }
  ];
  sk.nextEntityId = 5;
  return sk;
}

function docWithExtrude(w, h, depth) {
  const doc = newDocument();
  const sk = rectSketch(w, h);
  doc.sketches[sk.id] = sk;
  const sf = { id: uid('f'), type: 'sketch', sketch: sk.id };
  const ef = {
    id: uid('f'),
    type: 'extrude',
    sketch: sk.id,
    seeds: null,
    distance: String(depth),
    direction: 'one',
    op: 'new',
    targets: 'all'
  };
  doc.features = [sf, ef];
  return { doc, sk, ef };
}

/** A primitive feature with sensible defaults, for brevity in the tests. */
function prim(shape, params = {}) {
  return {
    id: uid('f'),
    type: 'primitive',
    shape,
    op: 'new',
    targets: 'all',
    params: {
      width: '20',
      depth: '20',
      height: '20',
      diameter: '20',
      topDiameter: '0',
      centered: true,
      x: '0',
      y: '0',
      z: '0',
      ...params
    }
  };
}

/* ------------------------------------------------------------------ */

/** A closed polygon sketch, for the sweep and loft tests. */
function polySketch(plane, pts, name) {
  const sk = newSketch(plane, name || 'Poly');
  sk.points = pts.map(([x, y]) => ({ x, y }));
  sk.entities = pts.map((_, i) => ({
    id: i + 1,
    type: 'line',
    p: [i, (i + 1) % pts.length]
  }));
  sk.nextEntityId = pts.length + 1;
  return sk;
}

/** An open chain, for paths and ribs. */
function openSketch(plane, pts, name) {
  const sk = newSketch(plane, name || 'Path');
  sk.points = pts.map(([x, y]) => ({ x, y }));
  sk.entities = [];
  for (let i = 0; i < pts.length - 1; i++) {
    sk.entities.push({ id: i + 1, type: 'line', p: [i, i + 1] });
  }
  sk.nextEntityId = pts.length;
  return sk;
}

/* ------------------------------------------------------------------ */

async function run() {
  await initKernel();

  /* -------- expressions -------- */

  test('expression: arithmetic and precedence', () => {
    near(evaluate('2 + 3 * 4'), 14, 1e-12);
    near(evaluate('(2 + 3) * 4'), 20, 1e-12);
    near(evaluate('2 ^ 3 ^ 2'), 512, 1e-12, 'right associative power');
    near(evaluate('-5 + 2'), -3, 1e-12, 'unary minus');
    near(evaluate('10 / 4'), 2.5, 1e-12);
  });

  test('expression: functions work in degrees', () => {
    near(evaluate('sin(30)'), 0.5, 1e-12);
    near(evaluate('cos(60)'), 0.5, 1e-12);
    near(evaluate('sqrt(16)'), 4, 1e-12);
    near(evaluate('max(3, 7)'), 7, 1e-12);
  });

  test('expression: parameters resolve in any order', () => {
    const { scope, errors } = resolveParameters([
      { name: 'total', expr: 'wall * 3' },
      { name: 'wall', expr: '2.5' }
    ]);
    assert(Object.keys(errors).length === 0, `unexpected errors ${JSON.stringify(errors)}`);
    near(scope.total, 7.5, 1e-12, 'dependent parameter');
  });

  test('expression: circular references are reported not hung', () => {
    const { errors } = resolveParameters([
      { name: 'a', expr: 'b + 1' },
      { name: 'b', expr: 'a + 1' }
    ]);
    assert(Object.keys(errors).length > 0, 'expected a circular reference error');
  });

  test('expression: no code execution', () => {
    let threw = false;
    try {
      evaluate('globalThis');
    } catch {
      threw = true;
    }
    assert(threw, 'bare identifiers must not resolve to host objects');
  });

  /* -------- solver -------- */

  test('solver: distance constraint drives a point', () => {
    const sk = newSketch('XY');
    sk.points = [
      { x: 0, y: 0 },
      { x: 3, y: 0 }
    ];
    sk.entities = [{ id: 1, type: 'line', p: [0, 1] }];
    sk.constraints = [
      { id: 'c1', type: 'fixed', point: 0, x: 0, y: 0 },
      { id: 'c2', type: 'horizontal', entity: 1 },
      { id: 'c3', type: 'distance', points: [0, 1], value: 25 }
    ];
    const res = solveSketch(sk);
    near(Math.hypot(sk.points[1].x, sk.points[1].y), 25, 1e-6, 'solved length');
    near(sk.points[1].y, 0, 1e-6, 'horizontal held');
    assert(res.dof === 0, `expected fully constrained, got ${res.dof} dof`);
  });

  test('solver: rectangle stays a rectangle under dimensions', () => {
    const sk = rectSketch(10, 6);
    sk.constraints = [
      { id: 'c1', type: 'fixed', point: 0, x: 0, y: 0 },
      { id: 'c2', type: 'horizontal', entity: 1 },
      { id: 'c3', type: 'vertical', entity: 2 },
      { id: 'c4', type: 'horizontal', entity: 3 },
      { id: 'c5', type: 'vertical', entity: 4 },
      { id: 'c6', type: 'distance', points: [0, 1], value: 40 },
      { id: 'c7', type: 'distance', points: [1, 2], value: 25 }
    ];
    const res = solveSketch(sk);
    near(sk.points[1].x, 40, 1e-5, 'width');
    near(sk.points[2].y, 25, 1e-5, 'height');
    near(sk.points[2].x, 40, 1e-5, 'corner stays square');
    near(sk.points[3].x, 0, 1e-5, 'left edge vertical');
    assert(res.dof === 0, `expected fully constrained, got ${res.dof}`);
  });

  test('solver: perpendicular and equal hold together', () => {
    const sk = newSketch('XY');
    sk.points = [
      { x: 0, y: 0 },
      { x: 10, y: 1 },
      { x: 9, y: 8 }
    ];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] }
    ];
    sk.constraints = [
      { id: 'c1', type: 'fixed', point: 0, x: 0, y: 0 },
      { id: 'c2', type: 'perpendicular', entities: [1, 2] },
      { id: 'c3', type: 'equal', entities: [1, 2] }
    ];
    solveSketch(sk);
    const u = { x: sk.points[1].x - sk.points[0].x, y: sk.points[1].y - sk.points[0].y };
    const v = { x: sk.points[2].x - sk.points[1].x, y: sk.points[2].y - sk.points[1].y };
    near(u.x * v.x + u.y * v.y, 0, 1e-4, 'perpendicular dot product');
    near(Math.hypot(u.x, u.y), Math.hypot(v.x, v.y), 1e-4, 'equal lengths');
  });

  test('solver: collinear puts two lines on one line', () => {
    // Two separate lines, the second offset and turned. Collinear has to bring
    // it onto the first's line without joining them end to end: they stay two
    // lines with a gap, which is the whole point of the constraint.
    const sk = newSketch('XY');
    sk.points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 4 },
      { x: 32, y: 7 }
    ];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [2, 3] }
    ];
    sk.constraints = [
      { id: 'c1', type: 'fixed', point: 0, x: 0, y: 0 },
      { id: 'c2', type: 'fixed', point: 1, x: 10, y: 0 },
      { id: 'c3', type: 'collinear', entities: [1, 2] }
    ];
    solveSketch(sk);
    near(sk.points[2].y, 0, 1e-4, 'the far line came onto the near one');
    near(sk.points[3].y, 0, 1e-4, 'both ends of it');
    assert(sk.points[2].x > 12, 'and it did not slide along to meet it');
  });

  test('solver: parallel lines are not collinear', () => {
    // The check that the constraint is doing more than parallel does: two
    // parallel lines a long way apart satisfy parallel and must not satisfy
    // this.
    const sk = newSketch('XY');
    sk.points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 20 },
      { x: 10, y: 20 }
    ];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [2, 3] }
    ];
    sk.constraints = [
      { id: 'c1', type: 'fixed', point: 0, x: 0, y: 0 },
      { id: 'c2', type: 'fixed', point: 1, x: 10, y: 0 },
      { id: 'c3', type: 'parallel', entities: [1, 2] }
    ];
    solveSketch(sk);
    assert(Math.abs(sk.points[2].y - 20) < 1e-6, 'parallel leaves it where it was');

    sk.constraints.push({ id: 'c4', type: 'collinear', entities: [1, 2] });
    solveSketch(sk);
    near(sk.points[2].y, 0, 1e-4, 'and collinear brings it down');
    near(sk.points[3].y, 0, 1e-4, 'all of it');
  });

  /* -------- blend curve -------- */

  /**
   * Two arcs of the same radius, pointing at each other across a gap.
   *
   * Both turn the same way, so a blend between them has a real curvature to
   * match at each end rather than the trivial zero a pair of lines would give.
   */
  function facingArcs(radius = 20, gap = 40) {
    const sk = newSketch('XY');
    const put = (x, y) => sk.points.push({ x, y }) - 1;
    // Left arc: centre below the left end, running up to its top.
    const cL = put(0, 0);
    const lStart = put(-radius, 0);
    const lEnd = put(0, radius);
    // Right arc: mirror of it, so its loose end faces back across the gap.
    const cR = put(radius * 2 + gap, 0);
    const rEnd = put(radius + gap, radius);
    const rStart = put(radius * 2 + gap + radius, 0);
    sk.entities = [
      { id: 1, type: 'arc', c: cL, p: [lStart, lEnd], ccw: true },
      { id: 2, type: 'arc', c: cR, p: [rEnd, rStart], ccw: true }
    ];
    sk.nextEntityId = 3;
    return { sk, left: { ent: sk.entities[0], at: lEnd }, right: { ent: sk.entities[1], at: rEnd } };
  }

  test('blend: an end frame reads an arc exactly', () => {
    const { sk, left } = facingArcs(20);
    const f = BL.endFrame(sk, left.ent, left.at);
    assert(f, 'it read the end');
    near(f.p.x, 0, 1e-9, 'at the point that was asked for');
    near(f.p.y, 20, 1e-9, 'both of it');
    // Running anticlockwise about a centre below, the top of the arc heads
    // left, and the turn is towards the centre, so a fifth of a unit of
    // curvature at radius 20.
    near(f.t.x, -1, 1e-9, 'heading the way the arc leaves');
    near(f.t.y, 0, 1e-9, 'and only that way');
    near(Math.abs(f.k), 1 / 20, 1e-9, 'one over the radius');
  });

  test('blend: a line has direction and no curvature', () => {
    const sk = newSketch('XY');
    sk.points = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    sk.entities = [{ id: 1, type: 'line', p: [0, 1] }];
    const f = BL.endFrame(sk, sk.entities[0], 1);
    near(f.t.x, 1, 1e-9, 'out along the line');
    near(f.k, 0, 1e-12, 'and dead straight');
  });

  test('blend: tangent continuous leaves both ends the right way', () => {
    const { sk, left, right } = facingArcs();
    const a = BL.endFrame(sk, left.ent, left.at);
    const b = BL.endFrame(sk, right.ent, right.at);
    const ctrl = BL.blendControls(a, b, { continuity: 'G1' });
    assert(ctrl.length === 4, `a cubic, got ${ctrl.length} control points`);
    const r = BL.blendReport(ctrl, a, b);
    near(r.tangentA, 1, 1e-9, 'leaves the first curve along it');
    near(r.tangentB, 1, 1e-9, 'and meets the second along it');
    // And that is all it claims: the curvature jumps at the join.
    assert(Math.abs(r.curvatureA - r.wantA) > 0.01, 'tangent alone leaves a curvature step');
  });

  test('blend: curvature continuous matches the curvature at both ends', () => {
    const { sk, left, right } = facingArcs();
    const a = BL.endFrame(sk, left.ent, left.at);
    const b = BL.endFrame(sk, right.ent, right.at);
    const ctrl = BL.blendControls(a, b, { continuity: 'G2' });
    assert(ctrl.length === 6, `six control points, got ${ctrl.length}`);
    const r = BL.blendReport(ctrl, a, b);
    near(r.tangentA, 1, 1e-9, 'direction held at the first end');
    near(r.tangentB, 1, 1e-9, 'and at the second');
    // This is the whole claim of the command, so it is checked against the
    // finished curve rather than against how it was built.
    near(r.curvatureA, r.wantA, Math.abs(r.wantA) * 1e-3, 'curvature held at the first end');
    near(r.curvatureB, r.wantB, Math.abs(r.wantB) * 1e-3, 'and at the second');
  });

  test('blend: it starts and ends exactly on the two ends it was given', () => {
    const { sk, left, right } = facingArcs();
    const a = BL.endFrame(sk, left.ent, left.at);
    const b = BL.endFrame(sk, right.ent, right.at);
    for (const how of ['G1', 'G2']) {
      const ctrl = BL.blendControls(a, b, { continuity: how });
      near(ctrl[0].x, a.p.x, 1e-12, `${how} starts on the first end`);
      near(ctrl[0].y, a.p.y, 1e-12, `${how} starts on the first end`);
      near(ctrl[ctrl.length - 1].x, b.p.x, 1e-12, `${how} finishes on the second`);
      near(ctrl[ctrl.length - 1].y, b.p.y, 1e-12, `${how} finishes on the second`);
    }
  });

  test('blend: a longer reach makes a fuller curve, not a different join', () => {
    const { sk, left, right } = facingArcs();
    const a = BL.endFrame(sk, left.ent, left.at);
    const b = BL.endFrame(sk, right.ent, right.at);
    const tight = BL.blendControls(a, b, { continuity: 'G2', bias: 0.6 });
    const loose = BL.blendControls(a, b, { continuity: 'G2', bias: 1.6 });
    const reach = (c) => Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);
    assert(reach(loose) > reach(tight) * 2, 'the handle really does reach further');
    for (const ctrl of [tight, loose]) {
      const r = BL.blendReport(ctrl, a, b);
      near(r.curvatureA, r.wantA, Math.abs(r.wantA) * 1e-3, 'and the join still holds');
      near(r.curvatureB, r.wantB, Math.abs(r.wantB) * 1e-3, 'at both ends');
    }
  });

  test('blend: two ends at the same place have no blend between them', () => {
    const a = { p: { x: 5, y: 5 }, t: { x: 1, y: 0 }, k: 0 };
    const b = { p: { x: 5, y: 5 }, t: { x: -1, y: 0 }, k: 0 };
    assert(BL.blendControls(a, b) === null, 'it refuses rather than dividing by nothing');
  });

  test('solver: under-constrained sketch reports its freedom', () => {
    const sk = rectSketch(10, 6);
    const res = solveSketch(sk);
    assert(res.dof > 0, 'a rectangle with no constraints must have freedom left');
  });

  /* -------- profiles -------- */

  test('profile: closed rectangle is one region', () => {
    const sk = rectSketch(20, 10);
    const regions = findRegions(sk);
    assert(regions.length === 1, `expected 1 region, got ${regions.length}`);
    near(regions[0].area, 200, 1e-6, 'region area');
  });

  test('profile: circle inside a rectangle makes a hole and a disc', () => {
    const sk = rectSketch(40, 40);
    sk.points.push({ x: 20, y: 20 });
    sk.entities.push({ id: 5, type: 'circle', c: 4, r: 5 });
    sk.nextEntityId = 6;

    const regions = findRegions(sk);
    assert(regions.length === 2, `expected 2 regions, got ${regions.length}`);
    const plate = regions.find((r) => r.holes.length === 1);
    const disc = regions.find((r) => r.holes.length === 0);
    assert(plate, 'expected a region with a hole');
    assert(disc, 'expected the disc as its own region');
    near(plate.area, 1600, 1e-6, 'outer area');

    // A tessellated circle is an inscribed polygon, so its area is known
    // exactly from the segment count. Checking against that rather than
    // against pi r squared tests the thing that matters: that the polygon
    // follows the shared quality rule and is not silently coarser.
    const n = circleSegments(5);
    const exactPolygon = 0.5 * n * 25 * Math.sin((2 * Math.PI) / n);
    near(disc.area, exactPolygon, 1e-6, 'disc area matches the quality rule');

    // And that the rule is fine enough to print: the gap between the polygon
    // and the true circle has to be far below what a nozzle can resolve.
    const sagitta = 5 * (1 - Math.cos(Math.PI / n));
    assert(sagitta < 0.01, `curve error ${sagitta.toFixed(4)} mm is too coarse`);
  });

  test('profile: a divided rectangle yields two regions', () => {
    const sk = rectSketch(20, 10);
    // A vertical line at x = 10 splitting the rectangle in half.
    sk.points.push({ x: 10, y: 0 }, { x: 10, y: 10 });
    sk.entities.push({ id: 5, type: 'line', p: [4, 5] });
    // Split the bottom and top edges at the same coordinate so the graph joins.
    sk.entities = [
      { id: 1, type: 'line', p: [0, 4] },
      { id: 6, type: 'line', p: [4, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 5] },
      { id: 7, type: 'line', p: [5, 3] },
      { id: 4, type: 'line', p: [3, 0] },
      { id: 5, type: 'line', p: [4, 5] }
    ];
    sk.nextEntityId = 8;
    const regions = findRegions(sk);
    assert(regions.length === 2, `expected 2 regions, got ${regions.length}`);
    for (const r of regions) near(r.area, 100, 1e-6, 'half area');
  });

  test('profile: contour winding is normalised', () => {
    const sk = rectSketch(10, 10);
    const regions = findRegions(sk);
    assert(signedArea(regions[0].outer) > 0, 'outer contour must wind positive');
  });

  /* -------- modelling -------- */

  test('model: extruded rectangle has the right volume and extent', () => {
    const { doc } = docWithExtrude(40, 20, 5);
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    assert(res.bodies.length === 1, `expected 1 body, got ${res.bodies.length}`);
    const props = K.properties(res.bodies[0].solid);
    near(props.volume, 40 * 20 * 5, 1e-3, 'volume');
    const bb = K.boundingBox(res.bodies[0].solid);
    near(bb.min[0], 0, 1e-6, 'min x');
    near(bb.max[0], 40, 1e-6, 'max x');
    near(bb.max[1], 20, 1e-6, 'max y');
    near(bb.max[2], 5, 1e-6, 'max z');
    assert(props.genus === 0, `expected a solid block, genus ${props.genus}`);
    res.dispose();
  });

  test('model: a parameter change propagates through the timeline', () => {
    const { doc, ef } = docWithExtrude(40, 20, 5);
    doc.parameters = [{ name: 'thickness', expr: '3' }];
    ef.distance = 'thickness * 2';

    let res = rebuild(doc);
    near(K.properties(res.bodies[0].solid).volume, 40 * 20 * 6, 1e-3, 'initial volume');
    res.dispose();

    doc.parameters[0].expr = '4';
    res = rebuild(doc);
    near(K.properties(res.bodies[0].solid).volume, 40 * 20 * 8, 1e-3, 'volume after edit');
    res.dispose();
  });

  test('model: sketch plane places the solid correctly', () => {
    const doc = newDocument();
    const sk = rectSketch(10, 10, 'XZ');
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      {
        id: uid('f'),
        type: 'extrude',
        sketch: sk.id,
        distance: '4',
        direction: 'one',
        op: 'new',
        targets: 'all'
      }
    ];
    const res = rebuild(doc);
    const bb = K.boundingBox(res.bodies[0].solid);
    // The XZ plane's normal is -Y, so the solid grows in negative Y.
    near(bb.max[0], 10, 1e-6, 'x extent');
    near(bb.max[2], 10, 1e-6, 'z extent from sketch y');
    near(bb.min[1], -4, 1e-6, 'extruded along the plane normal');
    res.dispose();
  });

  test('model: cut removes material', () => {
    const doc = newDocument();
    doc.features = [
      {
        id: uid('f'),
        type: 'primitive',
        shape: 'box',
        op: 'new',
        targets: 'all',
        params: { width: '20', depth: '20', height: '20', centered: true, x: '0', y: '0', z: '0' }
      },
      {
        id: uid('f'),
        type: 'primitive',
        shape: 'cylinder',
        op: 'cut',
        targets: 'all',
        params: { diameter: '10', height: '40', centered: true, x: '0', y: '0', z: '0' }
      }
    ];
    const res = rebuild(doc);
    assert(res.bodies.length === 1, `expected 1 body, got ${res.bodies.length}`);
    const props = K.properties(res.bodies[0].solid);
    const expected = 8000 - Math.PI * 25 * 20;
    near(props.volume, expected, expected * 0.01, 'volume after cut');
    assert(props.genus === 1, `a through hole should give genus 1, got ${props.genus}`);
    res.dispose();
  });

  test('model: revolving a rectangle makes a ring of known volume', () => {
    const doc = newDocument();
    // A 2 x 10 rectangle sitting from x = 5 to x = 7, revolved about the Y axis.
    const sk = newSketch('XY', 'Profile');
    sk.points = [
      { x: 5, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 10 },
      { x: 5, y: 10 }
    ];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] },
      { id: 4, type: 'line', p: [3, 0] }
    ];
    sk.nextEntityId = 5;
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      {
        id: uid('f'),
        type: 'revolve',
        sketch: sk.id,
        angle: '360',
        axis: { type: 'y' },
        op: 'new',
        targets: 'all'
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const props = K.properties(res.bodies[0].solid);
    const expected = Math.PI * (49 - 25) * 10;
    near(props.volume, expected, expected * 0.02, 'tube volume');
    res.dispose();
  });

  test('model: hole feature drills through', () => {
    const doc = newDocument();
    const plate = rectSketch(40, 40);
    doc.sketches[plate.id] = plate;

    const holes = newSketch('XY', 'Holes');
    holes.points = [{ x: 20, y: 20 }];
    holes.entities = [{ id: 1, type: 'point', p: 0 }];
    holes.nextEntityId = 2;
    doc.sketches[holes.id] = holes;

    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: plate.id },
      {
        id: uid('f'),
        type: 'extrude',
        sketch: plate.id,
        distance: '10',
        direction: 'one',
        op: 'new',
        targets: 'all'
      },
      { id: uid('f'), type: 'sketch', sketch: holes.id },
      {
        id: uid('f'),
        type: 'hole',
        sketch: holes.id,
        points: [0],
        diameter: '8',
        through: true,
        counterbore: false,
        countersink: false
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const props = K.properties(res.bodies[0].solid);
    const expected = 40 * 40 * 10 - Math.PI * 16 * 10;
    near(props.volume, expected, expected * 0.01, 'volume after drilling');
    assert(props.genus === 1, `expected one through hole, genus ${props.genus}`);
    res.dispose();
  });

  test('model: rectangular pattern multiplies the body', () => {
    const doc = newDocument();
    doc.features = [
      {
        id: uid('f'),
        type: 'primitive',
        shape: 'box',
        op: 'new',
        targets: 'all',
        params: { width: '10', depth: '10', height: '10', centered: false, x: '0', y: '0', z: '0' }
      },
      {
        id: uid('f'),
        type: 'patternRect',
        bodies: 'all',
        dir1: [1, 0, 0],
        dir2: [0, 1, 0],
        count1: '3',
        spacing1: '20',
        count2: '2',
        spacing2: '20',
        op: 'join'
      }
    ];
    const res = rebuild(doc);
    const props = K.properties(res.bodies[0].solid);
    near(props.volume, 1000 * 6, 1, 'six copies');
    res.dispose();
  });

  test('model: mirror reflects across the chosen plane', () => {
    const doc = newDocument();
    doc.features = [
      {
        id: uid('f'),
        type: 'primitive',
        shape: 'box',
        op: 'new',
        targets: 'all',
        params: { width: '10', depth: '10', height: '10', centered: false, x: '5', y: '0', z: '0' }
      },
      { id: uid('f'), type: 'mirror', bodies: 'all', plane: 'YZ', op: 'join' }
    ];
    const res = rebuild(doc);
    const bb = K.boundingBox(res.bodies[0].solid);
    near(bb.min[0], -15, 1e-5, 'mirrored extent');
    near(bb.max[0], 15, 1e-5, 'original extent');
    near(K.properties(res.bodies[0].solid).volume, 2000, 1, 'both halves present');
    res.dispose();
  });

  test('model: rollback stops the timeline early', () => {
    const doc = newDocument();
    doc.features = [
      {
        id: uid('f'),
        type: 'primitive',
        shape: 'box',
        op: 'new',
        targets: 'all',
        params: { width: '10', depth: '10', height: '10', centered: true, x: '0', y: '0', z: '0' }
      },
      {
        id: uid('f'),
        type: 'primitive',
        shape: 'box',
        op: 'new',
        targets: 'all',
        params: { width: '10', depth: '10', height: '10', centered: true, x: '40', y: '0', z: '0' }
      }
    ];
    let res = rebuild(doc);
    assert(res.bodies.length === 2, 'both features build');
    res.dispose();

    doc.rollback = 0;
    res = rebuild(doc);
    assert(res.bodies.length === 1, `rolled back should give 1 body, got ${res.bodies.length}`);
    res.dispose();
  });

  test('model: a suppressed feature is skipped', () => {
    const { doc } = docWithExtrude(10, 10, 10);
    doc.features[1].suppressed = true;
    const res = rebuild(doc);
    assert(res.bodies.length === 0, 'suppressed extrude should produce nothing');
    res.dispose();
  });

  test('model: a broken feature is reported, not fatal', () => {
    const doc = newDocument();
    doc.features = [
      {
        id: uid('f'),
        type: 'extrude',
        sketch: 'missing-sketch',
        distance: '10',
        op: 'new'
      },
      {
        id: uid('f'),
        type: 'primitive',
        shape: 'box',
        op: 'new',
        targets: 'all',
        params: { width: '10', depth: '10', height: '10', centered: true, x: '0', y: '0', z: '0' }
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 1, `expected 1 error, got ${res.errors.length}`);
    assert(res.bodies.length === 1, 'later features must still build');
    res.dispose();
  });

  test('document: a saved and reloaded model rebuilds identically', () => {
    const { doc } = docWithExtrude(30, 18, 7);
    doc.parameters = [{ name: 'w', expr: '3' }];
    doc.features[1].distance = 'w * 2';

    const before = rebuild(doc);
    const volBefore = K.properties(before.bodies[0].solid).volume;
    before.dispose();

    // This is exactly what the save path writes and the open path reads.
    const roundTripped = JSON.parse(JSON.stringify(doc));
    const after = rebuild(roundTripped);
    assert(after.errors.length === 0, `errors after reload: ${JSON.stringify(after.errors)}`);
    assert(after.bodies.length === 1, 'reloaded model should have one body');
    near(K.properties(after.bodies[0].solid).volume, volBefore, 1e-6, 'volume after reload');
    after.dispose();
  });

  test('document: expressions survive the round trip as text, not as numbers', () => {
    const { doc } = docWithExtrude(30, 18, 7);
    doc.parameters = [{ name: 'w', expr: '3' }];
    doc.features[1].distance = 'w * 2';

    const reloaded = JSON.parse(JSON.stringify(doc));
    assert(
      reloaded.features[1].distance === 'w * 2',
      'a dimension must reload as its expression so it still tracks the parameter'
    );
    reloaded.parameters[0].expr = '5';
    const res = rebuild(reloaded);
    near(K.properties(res.bodies[0].solid).volume, 30 * 18 * 10, 1e-3, 'volume follows the parameter');
    res.dispose();
  });

  /* -------- topology -------- */

  test('topology: a box resolves to six faces and twelve convex edges', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '40', depth: '30', height: '20' })];
    const res = rebuild(doc);
    const topo = buildTopology(K.meshData(res.bodies[0].solid));
    assert(topo.faces.length === 6, `expected 6 faces, got ${topo.faces.length}`);
    assert(topo.edges.length === 12, `expected 12 edges, got ${topo.edges.length}`);
    assert(
      topo.edges.every((e) => e.kind === 'line'),
      'every edge of a box is straight'
    );
    assert(
      topo.edges.every((e) => e.convex),
      'every edge of a box is an outside corner'
    );
    assert(topo.faces.every((f) => f.planar), 'every face of a box is flat');
    res.dispose();
  });

  test('topology: a cylinder keeps its side as one curved face', () => {
    const doc = newDocument();
    doc.features = [prim('cylinder', { diameter: '20', height: '20' })];
    const res = rebuild(doc);
    const topo = buildTopology(K.meshData(res.bodies[0].solid));
    assert(topo.faces.length === 3, `expected 3 faces, got ${topo.faces.length}`);
    assert(
      topo.faces.filter((f) => f.planar).length === 2,
      'the two ends are flat and the side is not'
    );
    assert(topo.edges.length === 2, `expected 2 rim edges, got ${topo.edges.length}`);
    for (const e of topo.edges) {
      assert(e.kind === 'circle', `rim should be circular, got ${e.kind}`);
      near(e.radius, 10, 1e-3, 'rim radius');
      assert(e.convex, 'a cylinder rim is an outside corner');
    }
    res.dispose();
  });

  test('topology: an inside corner is reported concave', () => {
    // An L shape: a big block with a smaller one taken out of one corner.
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '40', height: '20', centered: false }),
      {
        ...prim('box', {
          width: '20',
          depth: '50',
          height: '20',
          centered: false,
          x: '20',
          y: '-5',
          z: '10'
        }),
        op: 'cut'
      }
    ];
    const res = rebuild(doc);
    const topo = buildTopology(K.meshData(res.bodies[0].solid));
    const concave = topo.edges.filter((e) => !e.convex);
    assert(concave.length >= 1, 'the step should create at least one inside corner');
    res.dispose();
  });

  /* -------- fillet, chamfer, shell -------- */

  test('fillet: rounding a box matches the reference construction', () => {
    // Independent check: a ball rolled around the inside of the shape, which
    // is what a fillet is, expressed as a morphological opening.
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '30', height: '20' }),
      { id: uid('f'), type: 'fillet', bodies: 'all', radius: '3' }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const volume = K.properties(res.bodies[0].solid).volume;

    const scope = new K.Scope();
    const box = K.box([40, 30, 20], true, scope);
    const ball = K.sphere(3, 40, scope);
    const opened = scope.track(box.minkowskiDifference(ball).minkowskiSum(ball));
    const reference = opened.volume();
    scope.dispose();

    near(volume, reference, reference * 0.005, 'filleted volume against a rolled ball');
    res.dispose();
  });

  test('fillet: a bigger radius removes more material', () => {
    const volumes = [];
    for (const r of ['1', '2', '4']) {
      const doc = newDocument();
      doc.features = [
        prim('box', { width: '40', depth: '30', height: '20' }),
        { id: uid('f'), type: 'fillet', bodies: 'all', radius: r }
      ];
      const res = rebuild(doc);
      volumes.push(K.properties(res.bodies[0].solid).volume);
      res.dispose();
    }
    assert(
      volumes[0] > volumes[1] && volumes[1] > volumes[2],
      `volume should fall as radius grows, got ${volumes.map((v) => v.toFixed(0))}`
    );
    assert(volumes[0] < 24000, 'a fillet must remove material, not add it');
  });

  test('fillet: rounds the rim of a cylinder', () => {
    const doc = newDocument();
    doc.features = [
      prim('cylinder', { diameter: '20', height: '20' }),
      { id: uid('f'), type: 'fillet', bodies: 'all', radius: '3' }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const props = K.properties(res.bodies[0].solid);
    const plain = Math.PI * 100 * 20;
    assert(props.volume < plain, 'rounding the rims should remove material');
    assert(props.volume > plain * 0.95, 'but not very much of it');
    assert(props.genus === 0, `still one solid lump, genus ${props.genus}`);
    res.dispose();
  });

  test('chamfer: cuts the expected wedge off each edge', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '30', height: '20' }),
      { id: uid('f'), type: 'chamfer', bodies: 'all', radius: '3' }
    ];
    const res = rebuild(doc);
    const volume = K.properties(res.bodies[0].solid).volume;

    // Each of the twelve edges loses a right-triangle prism of leg 3, so
    // 4.5 mm2 along its length. The cutters overlap where three meet at a
    // corner, so the true loss is a little less than the plain sum, bounded by
    // the corner cubes.
    const totalEdgeLength = 4 * (40 + 30 + 20);
    const naiveLoss = 4.5 * totalEdgeLength;
    const cornerRecovery = 8 * 27;
    assert(
      volume > 24000 - naiveLoss - 1,
      `chamfer removed ${(24000 - volume).toFixed(0)}, more than the ${naiveLoss} upper bound`
    );
    assert(
      volume < 24000 - naiveLoss + cornerRecovery,
      `chamfer removed too little: ${(24000 - volume).toFixed(0)}`
    );
    res.dispose();
  });

  test('shell: hollows a box to an even wall', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '30', height: '20' }),
      { id: uid('f'), type: 'shell', bodies: 'all', thickness: '2' }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const props = K.properties(res.bodies[0].solid);
    const expected = 24000 - 36 * 26 * 16;
    near(props.volume, expected, 1, 'shell wall volume');
    assert(props.genus < 0, `a sealed hollow encloses a void, genus ${props.genus}`);
    res.dispose();
  });

  test('shell: refuses a wall thicker than the part rather than emptying it', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '10', depth: '10', height: '10' }),
      { id: uid('f'), type: 'shell', bodies: 'all', thickness: '9' }
    ];
    const res = rebuild(doc);
    assert(res.bodies.length === 1, 'the body should survive');
    near(K.properties(res.bodies[0].solid).volume, 1000, 1e-3, 'left untouched');
    assert(res.errors.length === 1, 'and the reason should be reported');
    res.dispose();
  });

  test('press pull: offsetting a face moves exactly that face', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '40', depth: '30', height: '20' })];
    let res = rebuild(doc);
    const topo = buildTopology(K.meshData(res.bodies[0].solid));
    const top = topo.faces.find((f) => f.normal[2] > 0.99);
    assert(top, 'no top face');
    const ref = faceReference(top);
    res.dispose();

    doc.features.push({
      id: uid('f'),
      type: 'offsetFace',
      bodies: 'all',
      faces: [ref],
      distance: '5'
    });
    res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const props = K.properties(res.bodies[0].solid);
    near(props.volume, 40 * 30 * 25, 1e-3, 'volume after pulling the top face');
    const bb = K.boundingBox(res.bodies[0].solid);
    near(bb.max[2], 15, 1e-4, 'top moved up');
    near(bb.min[2], -10, 1e-4, 'bottom stayed put');
    res.dispose();
  });

  test('press pull: a negative offset pushes the face in', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '20', depth: '20', height: '20' })];
    let res = rebuild(doc);
    const topo = buildTopology(K.meshData(res.bodies[0].solid));
    const top = topo.faces.find((f) => f.normal[2] > 0.99);
    const ref = faceReference(top);
    res.dispose();

    doc.features.push({
      id: uid('f'),
      type: 'offsetFace',
      bodies: 'all',
      faces: [ref],
      distance: '-6'
    });
    res = rebuild(doc);
    near(K.properties(res.bodies[0].solid).volume, 20 * 20 * 14, 1e-3, 'volume after pushing in');
    res.dispose();
  });

  test('fillet: survives a change to the dimension underneath it', () => {
    // The point of a parametric model: pick edges, change an earlier size, and
    // the fillet should still be on the same edges rather than lost.
    const doc = newDocument();
    doc.parameters = [{ name: 'w', expr: '40' }];
    doc.features = [prim('box', { width: 'w', depth: '30', height: '20' })];

    let res = rebuild(doc);
    let topo = buildTopology(K.meshData(res.bodies[0].solid));
    const verticals = topo.edges
      .filter((e) => e.kind === 'line' && Math.abs(e.dir[2]) > 0.99)
      .map(edgeReference);
    assert(verticals.length === 4, `expected 4 upright edges, got ${verticals.length}`);
    res.dispose();

    doc.features.push({
      id: uid('f'),
      type: 'fillet',
      bodies: 'all',
      edges: verticals,
      radius: '4'
    });

    res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const before = K.properties(res.bodies[0].solid).volume;
    const lost = 40 * 30 * 20 - before;
    res.dispose();

    doc.parameters[0].expr = '70';
    res = rebuild(doc);
    assert(
      res.errors.length === 0,
      `the fillet lost its edges after the change: ${JSON.stringify(res.errors)}`
    );
    const after = K.properties(res.bodies[0].solid).volume;
    // Same four uprights, same radius, same height, so the same corner volume
    // disappears no matter how wide the box gets.
    near(70 * 30 * 20 - after, lost, lost * 0.02, 'material removed after widening');
    res.dispose();
  });

  /* -------- sketching on a face -------- */

  test('sketch on a face lands on that face and follows it', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '40', depth: '40', height: '10' })];
    doc.parameters = [{ name: 'h', expr: '10' }];
    doc.features[0].params.height = 'h';

    let res = rebuild(doc);
    let topo = buildTopology(K.meshData(res.bodies[0].solid));
    const top = topo.faces.find((f) => f.normal[2] > 0.99);
    const ref = faceReference(top);
    res.dispose();

    const sk = newSketch({ face: ref }, 'On face');
    doc.sketches[sk.id] = sk;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: sk.id });

    res = rebuild(doc);
    let plane = res.sketchPlanes[sk.id];
    near(plane.origin[2], 5, 1e-4, 'sketch sits on the top face');
    near(plane.n[2], 1, 1e-6, 'and faces the same way');
    res.dispose();

    // Make the box taller; the sketch must ride up with the face.
    doc.parameters[0].expr = '30';
    res = rebuild(doc);
    plane = res.sketchPlanes[sk.id];
    near(plane.origin[2], 15, 1e-4, 'sketch followed the face upward');
    res.dispose();
  });

  /* -------- solver reporting -------- */

  test('solver: reports which entities are pinned down', () => {
    const sk = newSketch('XY');
    sk.points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 8 }
    ];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] }
    ];
    sk.constraints = [
      { id: 'c1', type: 'fixed', point: 0, x: 0, y: 0 },
      { id: 'c2', type: 'horizontal', entity: 1 },
      { id: 'c3', type: 'distance', points: [0, 1], value: 10 }
    ];
    const res = solveSketch(sk);
    assert(res.constrained.get(1) === true, 'the dimensioned line is settled');
    assert(res.constrained.get(2) === false, 'the free line is not');
    assert(res.dof === 2, `the loose end has two ways to move, got ${res.dof}`);
  });

  test('solver: a driven dimension measures without pushing', () => {
    const sk = newSketch('XY');
    sk.points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 }
    ];
    sk.entities = [{ id: 1, type: 'line', p: [0, 1] }];
    sk.constraints = [
      { id: 'c1', type: 'fixed', point: 0, x: 0, y: 0 },
      { id: 'c2', type: 'fixed', point: 1, x: 10, y: 0 },
      // Asks for 25 but is only a reference, so nothing should move.
      { id: 'c3', type: 'distance', points: [0, 1], value: 25, driven: true }
    ];
    solveSketch(sk);
    near(sk.points[1].x, 10, 1e-6, 'geometry ignored the reference dimension');
  });


  /* -------- swept and blended solids -------- */

  test('loft: a square to a smaller square is a frustum of known volume', () => {
    const doc = newDocument();
    const a = polySketch('XY', [[-20, -20], [20, -20], [20, 20], [-20, 20]], 'A');
    const b = polySketch({ base: 'XY', offset: '30' }, [[-10, -10], [10, -10], [10, 10], [-10, 10]], 'B');
    doc.sketches[a.id] = a;
    doc.sketches[b.id] = b;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: a.id },
      { id: uid('f'), type: 'sketch', sketch: b.id },
      {
        id: uid('f'),
        type: 'loft',
        sections: [{ sketch: a.id }, { sketch: b.id }],
        op: 'new',
        targets: 'all'
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const props = K.properties(res.bodies[0].solid);
    // h/3 (A1 + A2 + root(A1 A2)) for a frustum.
    const exact = (30 / 3) * (1600 + 400 + Math.sqrt(1600 * 400));
    near(props.volume, exact, 1, 'frustum volume');
    assert(props.genus === 0, `expected a solid lump, genus ${props.genus}`);
    res.dispose();
  });

  test('loft: holes are carried through, not just capped', () => {
    const doc = newDocument();
    const ring = (plane, outer, inner, name) => {
      const sk = newSketch(plane, name);
      sk.points = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
      sk.entities = [
        { id: 1, type: 'circle', c: 0, r: outer },
        { id: 2, type: 'circle', c: 1, r: inner }
      ];
      sk.nextEntityId = 3;
      return sk;
    };
    const a = ring('XY', 20, 10, 'A');
    const b = ring({ base: 'XY', offset: '20' }, 10, 5, 'B');
    doc.sketches[a.id] = a;
    doc.sketches[b.id] = b;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: a.id },
      { id: uid('f'), type: 'sketch', sketch: b.id },
      {
        id: uid('f'),
        type: 'loft',
        sections: [
          { sketch: a.id, seed: { x: 15, y: 0 } },
          { sketch: b.id, seed: { x: 7.5, y: 0 } }
        ],
        op: 'new',
        targets: 'all'
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const props = K.properties(res.bodies[0].solid);
    assert(props.genus === 1, `a lofted tube should be open through, genus ${props.genus}`);
    const outer = (20 / 3) * (Math.PI * 400 + Math.PI * 100 + Math.PI * 200);
    const bore = (20 / 3) * (Math.PI * 100 + Math.PI * 25 + Math.PI * 50);
    near(props.volume, outer - bore, (outer - bore) * 0.01, 'wall volume');
    res.dispose();
  });

  test('sweep: a square along a straight path is a plain prism', () => {
    const doc = newDocument();
    const prof = polySketch('XY', [[-5, -5], [5, -5], [5, 5], [-5, 5]], 'Profile');
    const path = openSketch('XZ', [[0, 0], [0, 50]], 'Path');
    doc.sketches[prof.id] = prof;
    doc.sketches[path.id] = path;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: prof.id },
      { id: uid('f'), type: 'sketch', sketch: path.id },
      {
        id: uid('f'),
        type: 'sweep',
        sketch: prof.id,
        path: { sketch: path.id },
        op: 'new',
        targets: 'all'
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    near(K.properties(res.bodies[0].solid).volume, 100 * 50, 1e-3, 'prism volume');
    res.dispose();
  });

  test('sweep: an off-centre profile keeps its shape and its bearings', () => {
    // A square profile hides two mistakes at once: a swapped pair of axes and
    // a profile placed in the wrong spot. This one is 10 by 4 and sits away
    // from the origin, so both show up in the bounding box.
    const doc = newDocument();
    const prof = polySketch(
      'XY',
      [[-5, -2], [5, -2], [5, 2], [-5, 2]],
      'Profile'
    );
    const path = openSketch('XZ', [[0, 0], [0, 40]], 'Path');
    doc.sketches[prof.id] = prof;
    doc.sketches[path.id] = path;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: prof.id },
      { id: uid('f'), type: 'sketch', sketch: path.id },
      {
        id: uid('f'),
        type: 'sweep',
        sketch: prof.id,
        path: { sketch: path.id },
        op: 'new',
        targets: 'all'
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const props = K.properties(res.bodies[0].solid);
    near(props.volume, 10 * 4 * 40, 1e-3, 'prism volume');

    const bb = K.boundingBox(res.bodies[0].solid);
    near(bb.min[0], -5, 1e-4, 'the long side stayed along x');
    near(bb.max[0], 5, 1e-4, 'the long side stayed along x');
    near(bb.min[1], -2, 1e-4, 'the short side stayed along y');
    near(bb.max[1], 2, 1e-4, 'the short side stayed along y');
    near(bb.min[2], 0, 1e-4, 'swept from the path start');
    near(bb.max[2], 40, 1e-4, 'to the path end');
    res.dispose();
  });

  test('sweep: a profile drawn away from the path keeps that offset', () => {
    const doc = newDocument();
    const prof = polySketch('XY', [[-5, -5], [5, -5], [5, 5], [-5, 5]], 'Profile');
    // The path runs parallel to z but starts 30 mm along x.
    const path = openSketch('XZ', [[30, 0], [30, 40]], 'Path');
    doc.sketches[prof.id] = prof;
    doc.sketches[path.id] = path;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: prof.id },
      { id: uid('f'), type: 'sketch', sketch: path.id },
      {
        id: uid('f'),
        type: 'sweep',
        sketch: prof.id,
        path: { sketch: path.id },
        op: 'new',
        targets: 'all'
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const bb = K.boundingBox(res.bodies[0].solid);
    // The profile is swept where it was drawn, not dragged onto the path.
    near(bb.min[0], -5, 1e-4, 'stayed where it was drawn');
    near(bb.max[0], 5, 1e-4, 'stayed where it was drawn');
    near(K.properties(res.bodies[0].solid).volume, 100 * 40, 1e-3, 'volume');
    res.dispose();
  });

  test('sweep: round a quarter turn, the volume follows Pappus', () => {
    const doc = newDocument();
    // The path leaves the origin heading along x, so the profile has to sit on
    // a plane facing that way.
    const prof = newSketch('YZ', 'Profile');
    prof.points = [{ x: 0, y: 0 }];
    prof.entities = [{ id: 1, type: 'circle', c: 0, r: 3 }];
    prof.nextEntityId = 2;

    const path = newSketch('XZ', 'Path');
    path.points = [{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
    path.entities = [{ id: 1, type: 'arc', c: 2, p: [0, 1], ccw: true }];
    path.nextEntityId = 2;

    doc.sketches[prof.id] = prof;
    doc.sketches[path.id] = path;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: prof.id },
      { id: uid('f'), type: 'sketch', sketch: path.id },
      {
        id: uid('f'),
        type: 'sweep',
        sketch: prof.id,
        path: { sketch: path.id },
        op: 'new',
        targets: 'all'
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    // Pappus: the area times the distance its centroid travels.
    const exact = Math.PI * 9 * ((Math.PI / 2) * 20);
    near(K.properties(res.bodies[0].solid).volume, exact, exact * 0.02, 'quarter bend volume');
    res.dispose();
  });

  test('rib: an open curve becomes a wall of the right size', () => {
    const doc = newDocument();
    const sk = openSketch('XY', [[-20, 0], [0, 0], [0, 15]], 'Rib');
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      {
        id: uid('f'),
        type: 'rib',
        sketch: sk.id,
        thickness: '3',
        depth: '12',
        op: 'new',
        targets: 'all'
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const props = K.properties(res.bodies[0].solid);
    near(props.volume, (20 + 15) * 3 * 12, 1, 'wall volume');
    const bb = K.boundingBox(res.bodies[0].solid);
    near(bb.max[2], 12, 1e-4, 'wall depth');
    res.dispose();
  });

  /* -------- draft, split, thread -------- */

  test('draft: tapering a box gives the frustum the angle implies', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '40', height: '20', centered: false })
    ];
    let res = rebuild(doc);
    let topo = buildTopology(K.meshData(res.bodies[0].solid));
    const sides = topo.faces
      .filter((f) => f.planar && Math.abs(f.normal[2]) < 0.01)
      .map(faceReference);
    assert(sides.length === 4, `expected 4 side faces, got ${sides.length}`);
    res.dispose();

    doc.features.push({
      id: uid('f'),
      type: 'draft',
      bodies: 'all',
      faces: sides,
      angle: '5',
      neutral: 'XY'
    });
    res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);

    const top = 40 - 2 * 20 * Math.tan((5 * Math.PI) / 180);
    const exact = (20 / 3) * (1600 + top * top + Math.sqrt(1600 * top * top));
    near(K.properties(res.bodies[0].solid).volume, exact, 1, 'drafted volume');
    res.dispose();
  });

  test('split: a plane through a body gives two bodies that add back up', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '40', height: '20' }),
      { id: uid('f'), type: 'split', bodies: 'all', plane: { base: 'XY', offset: '5' } }
    ];
    const res = rebuild(doc);
    assert(res.bodies.length === 2, `expected 2 bodies, got ${res.bodies.length}`);
    const volumes = res.bodies.map((b) => K.properties(b.solid).volume).sort((a, b) => a - b);
    near(volumes[0], 40 * 40 * 5, 1e-3, 'the piece above the plane');
    near(volumes[1], 40 * 40 * 15, 1e-3, 'the piece below it');
    res.dispose();
  });

  test('thread: cuts a clean helical groove', () => {
    const doc = newDocument();
    doc.features = [
      prim('cylinder', { diameter: '8', height: '20', centered: false }),
      {
        id: uid('f'),
        type: 'thread',
        bodies: 'all',
        diameter: '8',
        pitch: '1.25',
        length: '20',
        clearance: '0.2',
        plane: 'XY'
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const props = K.properties(res.bodies[0].solid);
    const plain = Math.PI * 16 * 20;
    assert(props.volume < plain, 'a thread removes material');
    assert(props.volume > plain * 0.7, `too much removed: ${props.volume.toFixed(0)}`);
    // A rod with a groove cut round it is still topologically a ball. Anything
    // else means consecutive turns are touching and making tunnels.
    assert(props.genus === 0, `thread should leave genus 0, got ${props.genus}`);
    res.dispose();
  });

  test('fillet: a variable radius leaves one clean body', () => {
    for (const [r0, r1] of [['1', '6'], ['6', '1']]) {
      const doc = newDocument();
      doc.features = [prim('box', { width: '40', depth: '30', height: '30' })];
      let res = rebuild(doc);
      const topo = buildTopology(K.meshData(res.bodies[0].solid));
      const uprights = topo.edges
        .filter((e) => e.kind === 'line' && Math.abs(e.dir[2]) > 0.99)
        .map(edgeReference);
      res.dispose();

      doc.features.push({
        id: uid('f'),
        type: 'fillet',
        bodies: 'all',
        edges: uprights,
        radius: r0,
        endRadius: r1
      });
      res = rebuild(doc);
      const props = K.properties(res.bodies[0].solid);
      assert(props.volume < 36000, 'a fillet removes material');
      assert(
        props.genus === 0,
        `${r0} to ${r1} left debris behind: genus ${props.genus}`
      );
      res.dispose();
    }
  });

  /* -------- sketching -------- */

  test('sketch: a spline runs through the points it was given', () => {
    const sk = newSketch('XY', 'Spline');
    const pts = [[0, 0], [10, 8], [20, 0], [30, 8]];
    sk.points = pts.map(([x, y]) => ({ x, y }));
    sk.entities = [{ id: 1, type: 'spline', p: [0, 1, 2, 3] }];
    sk.nextEntityId = 2;

    const curve = tessellate(sk, sk.entities[0]);
    assert(curve.length > 20, `expected a smooth curve, got ${curve.length} points`);
    for (const [x, y] of pts) {
      const hit = curve.some((q) => Math.hypot(q.x - x, q.y - y) < 1e-6);
      assert(hit, `the curve misses its control point at ${x}, ${y}`);
    }
    // And it should stay inside the span of the points it passes through.
    const maxY = Math.max(...curve.map((q) => q.y));
    assert(maxY < 12, `the curve overshoots: peak ${maxY.toFixed(2)}`);
  });

  test('sketch: a closed spline encloses an area that can be extruded', () => {
    const doc = newDocument();
    const sk = newSketch('XY', 'Blob');
    const n = 8;
    sk.points = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      sk.points.push({ x: 20 * Math.cos(a), y: 14 * Math.sin(a) });
    }
    sk.entities = [
      { id: 1, type: 'spline', p: sk.points.map((_, i) => i), closed: true }
    ];
    sk.nextEntityId = 2;
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      {
        id: uid('f'),
        type: 'extrude',
        sketch: sk.id,
        distance: '5',
        op: 'new',
        targets: 'all'
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const props = K.properties(res.bodies[0].solid);
    // Near enough an ellipse of 20 by 14.
    const ellipse = Math.PI * 20 * 14 * 5;
    near(props.volume, ellipse, ellipse * 0.06, 'extruded blob volume');
    res.dispose();
  });

  /* -------- construction geometry -------- */

  test('construction: an offset plane can be sketched on and follows its parameter', () => {
    const doc = newDocument();
    doc.parameters = [{ name: 'lift', expr: '25' }];
    const planeId = 'cx1';
    doc.features = [
      {
        id: uid('f'),
        type: 'construction',
        entry: { id: planeId, type: 'planeOffset', base: 'XY', distance: 'lift' }
      }
    ];
    const sk = polySketch({ construction: planeId }, [[0, 0], [10, 0], [10, 10], [0, 10]], 'On plane');
    doc.sketches[sk.id] = sk;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: sk.id });

    let res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    near(res.sketchPlanes[sk.id].origin[2], 25, 1e-6, 'sketch sits on the offset plane');
    res.dispose();

    doc.parameters[0].expr = '40';
    res = rebuild(doc);
    near(res.sketchPlanes[sk.id].origin[2], 40, 1e-6, 'and moves with the parameter');
    res.dispose();
  });

  test('construction: a midplane lands between two planes', () => {
    const doc = newDocument();
    doc.features = [
      {
        id: uid('f'),
        type: 'construction',
        entry: { id: 'a', type: 'planeOffset', base: 'XY', distance: '10' }
      },
      {
        id: uid('f'),
        type: 'construction',
        entry: { id: 'b', type: 'planeOffset', base: 'XY', distance: '30' }
      },
      {
        id: uid('f'),
        type: 'construction',
        entry: {
          id: 'mid',
          type: 'planeMidplane',
          planeA: { construction: 'a' },
          planeB: { construction: 'b' }
        }
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    const mid = res.construction.get('mid');
    assert(mid, 'the midplane was not built');
    near(mid.origin[2], 20, 1e-6, 'midplane height');
    near(Math.abs(mid.n[2]), 1, 1e-6, 'midplane faces the same way');
    res.dispose();
  });

  test('construction: a cylinder gives up its axis', () => {
    const doc = newDocument();
    doc.features = [prim('cylinder', { diameter: '20', height: '30' })];
    let res = rebuild(doc);
    const topo = buildTopology(K.meshData(res.bodies[0].solid));
    const side = topo.faces.find((f) => !f.planar);
    assert(side && side.cylinder, 'the side was not recognised as a cylinder');
    near(side.cylinder.radius, 10, 1e-3, 'fitted radius');
    near(Math.abs(side.cylinder.dir[2]), 1, 1e-3, 'fitted axis');
    res.dispose();
  });

  /* -------- patterns -------- */

  test('pattern: copies along a path', () => {
    const doc = newDocument();
    const path = openSketch('XY', [[0, 0], [60, 0]], 'Path');
    doc.sketches[path.id] = path;
    doc.features = [
      prim('box', { width: '5', depth: '5', height: '5', centered: false }),
      { id: uid('f'), type: 'sketch', sketch: path.id },
      {
        id: uid('f'),
        type: 'patternPath',
        bodies: 'all',
        path: { sketch: path.id },
        count: '4',
        spacing: '0',
        follow: false,
        op: 'separate'
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    assert(res.bodies.length === 4, `expected 4 copies, got ${res.bodies.length}`);
    for (const b of res.bodies) near(K.properties(b.solid).volume, 125, 1e-6, 'copy volume');
    res.dispose();
  });

  test('pattern: repeating a feature repeats the cut, not the result', () => {
    // A plate with one hole. Patterning the body would give four plates; a
    // feature pattern has to give one plate with four holes.
    const doc = newDocument();
    const holes = newSketch('XY', 'Hole');
    holes.points = [{ x: -12, y: 0 }];
    holes.entities = [{ id: 1, type: 'point', p: 0 }];
    holes.nextEntityId = 2;
    doc.sketches[holes.id] = holes;

    const holeFeature = {
      id: uid('f'),
      type: 'hole',
      sketch: holes.id,
      points: [0],
      diameter: '4',
      through: true,
      counterbore: false,
      countersink: false
    };

    doc.features = [
      prim('box', { width: '60', depth: '20', height: '5' }),
      { id: uid('f'), type: 'sketch', sketch: holes.id },
      holeFeature,
      {
        id: uid('f'),
        type: 'patternFeature',
        features: [holeFeature.id],
        pattern: 'rectangular',
        count1: '4',
        spacing1: '8',
        count2: '1',
        spacing2: '0',
        dir1: [1, 0, 0],
        dir2: [0, 1, 0]
      }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, `errors: ${JSON.stringify(res.errors)}`);
    assert(res.bodies.length === 1, `expected one plate, got ${res.bodies.length}`);
    const props = K.properties(res.bodies[0].solid);
    assert(props.genus === 4, `expected four holes, genus ${props.genus}`);

    // A drilled hole is a polygon, not a circle, so compare against the area
    // the quality rule actually produces rather than against pi r squared.
    const seg = circleSegments(2);
    const boreArea = 0.5 * seg * 4 * Math.sin((2 * Math.PI) / seg);
    near(props.volume, 60 * 20 * 5 - 4 * boreArea * 5, 0.5, 'plate volume with four holes');
    res.dispose();
  });

  /* -------- assemblies -------- */

  test('assembly: a revolute joint swings the child about its origin', () => {
    const parent = newComponent('Base');
    parent.grounded = true;
    const child = newComponent('Arm');
    const joint = {
      id: 'j1',
      type: 'revolute',
      parent: parent.id,
      child: child.id,
      origin: { p: [0, 0, 0], axis: [0, 0, 1] },
      angle: '90'
    };

    const { transforms, errors } = solveAssembly([parent, child], [joint], {});
    assert(errors.length === 0, `errors: ${JSON.stringify(errors)}`);
    const m = transforms.get(child.id);
    assert(m, 'the arm has no placement');

    // A point out along X should end up out along Y.
    const v = new THREE.Vector3(10, 0, 0).applyMatrix4(m);
    near(v.x, 0, 1e-6, 'swung x');
    near(v.y, 10, 1e-6, 'swung y');
  });

  test('assembly: a slider moves along its axis and chains carry through', () => {
    const base = newComponent('Base');
    base.grounded = true;
    const mid = newComponent('Carriage');
    const tip = newComponent('Tool');

    const joints = [
      {
        id: 'j1',
        type: 'slider',
        parent: base.id,
        child: mid.id,
        origin: { p: [0, 0, 0], axis: [1, 0, 0] },
        offset: '25'
      },
      {
        id: 'j2',
        type: 'slider',
        parent: mid.id,
        child: tip.id,
        origin: { p: [0, 0, 0], axis: [0, 0, 1] },
        offset: '10'
      }
    ];

    const { transforms, errors } = solveAssembly([base, mid, tip], joints, {});
    assert(errors.length === 0, `errors: ${JSON.stringify(errors)}`);
    const v = new THREE.Vector3(0, 0, 0).applyMatrix4(transforms.get(tip.id));
    near(v.x, 25, 1e-6, 'the carriage carried the tool along');
    near(v.z, 10, 1e-6, 'and the tool moved on its own axis too');
  });

  test('assembly: a loop of joints is reported rather than half solved', () => {
    const a = newComponent('A');
    a.grounded = true;
    const b = newComponent('B');
    const c = newComponent('C');
    const joints = [
      { id: 'j1', type: 'rigid', parent: a.id, child: b.id, origin: { p: [0, 0, 0], axis: [0, 0, 1] } },
      { id: 'j2', type: 'rigid', parent: b.id, child: c.id, origin: { p: [0, 0, 0], axis: [0, 0, 1] } },
      { id: 'j3', type: 'rigid', parent: c.id, child: b.id, origin: { p: [0, 0, 0], axis: [0, 0, 1] } }
    ];
    const { errors } = solveAssembly([a, b, c], joints, {});
    assert(errors.length > 0, 'a closed loop should be reported');
  });

  test('assembly: a feature only cuts inside its own component', () => {
    const left = newComponent('Left');
    const right = newComponent('Right');
    const doc = newDocument();
    doc.components = [left, right];
    doc.features = [
      { ...prim('box', { width: '20', depth: '20', height: '20' }), component: left.id },
      {
        ...prim('box', { width: '20', depth: '20', height: '20' }),
        component: right.id,
        op: 'new'
      },
      {
        ...prim('cylinder', { diameter: '10', height: '40' }),
        component: left.id,
        op: 'cut'
      }
    ];
    const res = rebuild(doc);
    assert(res.bodies.length === 2, `expected 2 bodies, got ${res.bodies.length}`);
    const byComponent = new Map(res.bodies.map((b) => [b.component, b]));
    const drilled = K.properties(byComponent.get(left.id).solid);
    const untouched = K.properties(byComponent.get(right.id).solid);
    assert(drilled.genus === 1, 'the left part should be drilled');
    assert(untouched.genus === 0, 'the right part should be untouched');
    near(untouched.volume, 8000, 1e-3, 'the other component kept its volume');
    res.dispose();
  });

  /* -------- direct modelling -------- */

  test('direct modelling: baked geometry rebuilds to the same solid', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '30', depth: '20', height: '10' }),
      { ...prim('cylinder', { diameter: '8', height: '40' }), op: 'cut' }
    ];
    let res = rebuild(doc);
    const before = K.properties(res.bodies[0].solid);
    const baked = bakeBodies(res.bodies);
    res.dispose();

    assert(baked.length === 1, 'one body should have been frozen');
    assert(baked[0].verts.length > 0 && baked[0].tris.length > 0, 'the mesh is empty');

    const flat = newDocument();
    flat.captureHistory = false;
    flat.baseBodies = baked;
    res = rebuild(flat);
    assert(res.bodies.length === 1, 'the frozen body should come back');
    const after = K.properties(res.bodies[0].solid);
    near(after.volume, before.volume, before.volume * 1e-4, 'volume survived freezing');
    assert(after.genus === before.genus, 'so did the hole');
    res.dispose();
  });

  test('direct modelling: features still apply on top of baked geometry', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '20', depth: '20', height: '20' })];
    let res = rebuild(doc);
    const baked = bakeBodies(res.bodies);
    res.dispose();

    const flat = newDocument();
    flat.captureHistory = false;
    flat.baseBodies = baked;
    flat.features = [{ ...prim('cylinder', { diameter: '10', height: '40' }), op: 'cut' }];
    res = rebuild(flat);
    const props = K.properties(res.bodies[0].solid);
    assert(props.genus === 1, 'the cut should have gone through the frozen body');
    near(props.volume, 8000 - Math.PI * 25 * 20, 8000 * 0.01, 'volume after the cut');
    res.dispose();
  });

  /* -------- output -------- */

  test('output: binary STL has a correct header and triangle count', () => {
    const { doc } = docWithExtrude(10, 10, 10);
    const res = rebuild(doc);
    const mesh = K.meshData(res.bodies[0].solid);
    const stl = toBinarySTL([mesh]);
    const expectedTris = mesh.triVerts.length / 3;
    assert(stl.length === 84 + expectedTris * 50, `STL size ${stl.length} is wrong`);
    const view = new DataView(stl.buffer);
    assert(
      view.getUint32(80, true) === expectedTris,
      'triangle count in the header does not match the body'
    );
    assert(expectedTris === 12, `a box should be 12 triangles, got ${expectedTris}`);
    res.dispose();
  });

  test('output: the exported STL is watertight', () => {
    // The one property a slicer actually needs: every edge shared by exactly
    // two triangles, with no strays. Read back from the encoded bytes rather
    // than from the kernel, so an encoding mistake cannot hide here.
    const doc = newDocument();
    const plate = rectSketch(40, 40);
    doc.sketches[plate.id] = plate;
    const holes = newSketch('XY', 'Holes');
    holes.points = [{ x: 12, y: 12 }, { x: 28, y: 28 }];
    holes.entities = [
      { id: 1, type: 'point', p: 0 },
      { id: 2, type: 'point', p: 1 }
    ];
    holes.nextEntityId = 3;
    doc.sketches[holes.id] = holes;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: plate.id },
      {
        id: uid('f'),
        type: 'extrude',
        sketch: plate.id,
        distance: '6',
        direction: 'one',
        op: 'new',
        targets: 'all'
      },
      { id: uid('f'), type: 'sketch', sketch: holes.id },
      {
        id: uid('f'),
        type: 'hole',
        sketch: holes.id,
        points: [0, 1],
        diameter: '6',
        through: true,
        counterbore: false,
        countersink: false
      }
    ];
    const res = rebuild(doc);
    const stl = toBinarySTL([K.meshData(res.bodies[0].solid)]);
    res.dispose();

    const view = new DataView(stl.buffer);
    const count = view.getUint32(80, true);
    assert(count > 0, 'no triangles were written');

    const edges = new Map();
    const key = (a, b) => `${a}|${b}`;
    const q = (v) => Math.round(v * 1e4);

    for (let t = 0; t < count; t++) {
      const base = 84 + t * 50 + 12;
      const verts = [];
      for (let k = 0; k < 3; k++) {
        const o = base + k * 12;
        verts.push(
          `${q(view.getFloat32(o, true))},${q(view.getFloat32(o + 4, true))},${q(
            view.getFloat32(o + 8, true)
          )}`
        );
      }
      for (let k = 0; k < 3; k++) {
        const a = verts[k];
        const b = verts[(k + 1) % 3];
        const forward = key(a, b);
        const back = key(b, a);
        edges.set(forward, (edges.get(forward) || 0) + 1);
        edges.set(back, edges.get(back) || 0);
      }
    }

    let unmatched = 0;
    for (const [k, n] of edges) {
      const [a, b] = k.split('|');
      const opposite = edges.get(key(b, a)) || 0;
      if (n !== opposite) unmatched++;
    }
    assert(
      unmatched === 0,
      `${unmatched} edges are not paired; the mesh has holes or flipped faces`
    );
  });

  test('output: display mesh normals are unit length', () => {
    const { doc } = docWithExtrude(10, 10, 10);
    const res = rebuild(doc);
    const mesh = K.meshData(res.bodies[0].solid);
    const geom = buildGeometry(mesh);
    const n = geom.getAttribute('normal').array;
    for (let i = 0; i < n.length; i += 3) {
      near(Math.hypot(n[i], n[i + 1], n[i + 2]), 1, 1e-4, 'normal length');
    }
    res.dispose();
  });

  test('output: a box shows twelve sharp edges', () => {
    const { doc } = docWithExtrude(10, 10, 10);
    const res = rebuild(doc);
    const mesh = K.meshData(res.bodies[0].solid);
    const edges = buildEdges(mesh);
    const count = edges.getAttribute('position').count / 2;
    assert(count === 12, `a box has 12 edges, found ${count}`);
    res.dispose();
  });

  test('output: a cylinder keeps its side smooth but its rims sharp', () => {
    const doc = newDocument();
    doc.features = [
      {
        id: uid('f'),
        type: 'primitive',
        shape: 'cylinder',
        op: 'new',
        targets: 'all',
        params: { diameter: '20', height: '20', centered: true, x: '0', y: '0', z: '0' }
      }
    ];
    const res = rebuild(doc);
    const mesh = K.meshData(res.bodies[0].solid);
    const edges = buildEdges(mesh);
    const segments = edges.getAttribute('position').count / 2;
    // Two rims only: the vertical seams between side facets are below the
    // crease angle and must not be drawn.
    const props = K.properties(res.bodies[0].solid);
    assert(segments > 8, `expected rim edges, found ${segments}`);
    assert(
      segments < props.numTri,
      `too many edges drawn (${segments}); the curved side is not being smoothed`
    );
    res.dispose();
  });

  /* -------- geometry plumbing -------- */

  test('planes: sketch coordinates map into world space consistently', () => {
    const p = resolvePlane('YZ', {});
    const w = sketchToWorld(p, 3, 4, 0);
    near(w.x, 0, 1e-9, 'YZ plane has no x');
    near(w.y, 3, 1e-9, 'sketch u maps to world y');
    near(w.z, 4, 1e-9, 'sketch v maps to world z');
  });

  test('planes: an offset plane shifts along its normal', () => {
    const p = resolvePlane({ base: 'XY', offset: '12' }, {});
    near(p.origin[2], 12, 1e-9, 'offset along z');
  });

  /* -------- typed dimensions -------- */

  // A rectangle the way the rectangle tool lays one out: four corners, four
  // lines, and the horizontal and vertical constraints that keep it square.
  const looseRect = (name) => {
    const sk = newSketch('XY', name);
    sk.points = [
      { x: 0, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 3 },
      { x: 0, y: 3 }
    ];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] },
      { id: 4, type: 'line', p: [3, 0] }
    ];
    sk.constraints = [
      { id: 'c1', type: 'horizontal', entity: 1 },
      { id: 'c2', type: 'vertical', entity: 2 },
      { id: 'c3', type: 'horizontal', entity: 3 },
      { id: 'c4', type: 'vertical', entity: 4 },
      { id: 'c5', type: 'fixed', point: 0, x: 0, y: 0 }
    ];
    sk.nextEntityId = 5;
    return sk;
  };

  test('sketch: a size typed while drawing holds as a dimension', () => {
    // What the entry boxes add on commit. Drawn roughly at 7 by 3, told to be
    // 40 by 20, and the solver has to move it there rather than merely record
    // the number.
    const sk = looseRect('Typed');
    sk.constraints.push(
      { id: 'c6', type: 'distance', points: [0, 1], value: 40 },
      { id: 'c7', type: 'distance', points: [1, 2], value: 20 }
    );

    const res = solveSketch(sk, { maxIterations: 60 });
    near(res.error, 0, 1e-6, 'the sketch solves');
    near(res.dof, 0, 1e-9, 'a fully dimensioned rectangle has no freedom left');

    const P = sk.points;
    near(Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y), 40, 1e-6, 'width');
    near(Math.hypot(P[2].x - P[1].x, P[2].y - P[1].y), 20, 1e-6, 'height');
    // The opposite sides come along, which is the whole point of dimensioning
    // one edge rather than moving four corners.
    near(Math.hypot(P[2].x - P[3].x, P[2].y - P[3].y), 40, 1e-6, 'far side width');
  });

  test('sketch: dimensioning one side leaves the other free', () => {
    const sk = looseRect('Half typed');
    sk.constraints.push({ id: 'c6', type: 'distance', points: [0, 1], value: 45 });
    const res = solveSketch(sk, { maxIterations: 60 });
    near(res.error, 0, 1e-6, 'the sketch solves');
    assert(res.dof > 0, 'the undimensioned side should still be free');
    const P = sk.points;
    near(Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y), 45, 1e-6, 'the typed width');
  });

  test('sketch: a dimension written as an expression follows its parameter', () => {
    // Typing `wall * 2` has to keep the text, not just the number it came to,
    // or changing the parameter later moves nothing.
    const sk = looseRect('Expression');
    sk.constraints.push(
      { id: 'c6', type: 'distance', points: [0, 1], value: 0, expr: 'wall * 2' },
      { id: 'c7', type: 'distance', points: [1, 2], value: 0, expr: 'wall' }
    );

    resolveDimensionExprs(sk, { wall: 12 });
    solveSketch(sk, { maxIterations: 60 });
    let P = sk.points;
    near(Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y), 24, 1e-6, 'width at wall 12');
    near(Math.hypot(P[2].x - P[1].x, P[2].y - P[1].y), 12, 1e-6, 'height at wall 12');

    resolveDimensionExprs(sk, { wall: 20 });
    solveSketch(sk, { maxIterations: 60 });
    P = sk.points;
    near(Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y), 40, 1e-6, 'width follows to 40');
    near(Math.hypot(P[2].x - P[1].x, P[2].y - P[1].y), 20, 1e-6, 'height follows to 20');
  });

  test('sketch: a dimension with no expression keeps the number it was given', () => {
    const sk = looseRect('Plain');
    sk.constraints.push({ id: 'c6', type: 'distance', points: [0, 1], value: 33 });
    resolveDimensionExprs(sk, { wall: 999 });
    near(sk.constraints[5].value, 33, 1e-9, 'a plain value is left alone');
  });

  test('sketch: an unreadable expression leaves the last good value', () => {
    // A parameter that has been renamed or deleted must not collapse the
    // dimension to zero and turn the sketch inside out.
    const sk = looseRect('Broken');
    sk.constraints.push({
      id: 'c6',
      type: 'distance',
      points: [0, 1],
      value: 26,
      expr: 'missing * 2'
    });
    resolveDimensionExprs(sk, { wall: 12 });
    near(sk.constraints[5].value, 26, 1e-9, 'the last good value survives');
  });

  /* -------- extrude -------- */

  // A square sketch with nothing else on it, ready to be extruded every which
  // way. Returns the document and the extrude feature to fill in.
  const squareExtrude = (side, extra) => {
    const doc = newDocument();
    const sk = rectSketch(side, side);
    doc.sketches[sk.id] = sk;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: sk.id });
    const f = {
      id: uid('f'),
      type: 'extrude',
      sketch: sk.id,
      seeds: null,
      distance: '10',
      op: 'new',
      ...extra
    };
    doc.features.push(f);
    return { doc, f };
  };

  const volumeOf = (doc) => {
    const res = rebuild(doc);
    assert(res.bodies.length === 1, `expected one body, got ${res.bodies.length}`);
    return res.bodies[0].solid.volume();
  };

  test('extrude: one side goes the distance it was given', () => {
    const { doc } = squareExtrude(20, { distance: '10' });
    near(volumeOf(doc), 20 * 20 * 10, 1, 'a plain extrude');
  });

  test('extrude: symmetric measures whole or half length', () => {
    // Whole length is the distance across the finished extrusion; half length
    // is that distance on each side, so twice as much material.
    const whole = squareExtrude(10, {
      direction: 'symmetric',
      extent: 'distance',
      measure: 'whole',
      distance: '20'
    });
    near(volumeOf(whole.doc), 10 * 10 * 20, 1, 'whole length');

    const half = squareExtrude(10, {
      direction: 'symmetric',
      extent: 'distance',
      measure: 'half',
      distance: '20'
    });
    near(volumeOf(half.doc), 10 * 10 * 40, 1, 'half length is twice the material');
  });

  test('extrude: two sides take a distance each', () => {
    const { doc } = squareExtrude(10, {
      direction: 'two',
      extent: 'distance',
      distance: '10',
      distance2: '6'
    });
    const res = rebuild(doc);
    near(res.bodies[0].solid.volume(), 10 * 10 * 16, 1, 'the two sides add up');
    const bb = res.bodies[0].solid.boundingBox();
    near(bb.min[2], -6, 1e-3, 'reaches down the second distance');
    near(bb.max[2], 10, 1e-3, 'and up the first');
  });

  test('extrude: a start offset lifts the whole extrusion off the plane', () => {
    const { doc } = squareExtrude(10, { start: 'offset', startOffset: '5', distance: '10' });
    const res = rebuild(doc);
    const bb = res.bodies[0].solid.boundingBox();
    near(bb.min[2], 5, 1e-3, 'starts at the offset');
    near(bb.max[2], 15, 1e-3, 'and is still the stated length');
    near(res.bodies[0].solid.volume(), 10 * 10 * 10, 1, 'the offset is not extra material');
  });

  test('extrude: a thin extrude is a wall, not a slab', () => {
    // Mitred corners keep the arithmetic exact: offsetting a 40 square out by
    // 5 gives a 50 square, so the wall is the ring between them.
    const side1 = squareExtrude(40, {
      kind: 'thin',
      wall: '5',
      wallLocation: 'side1',
      distance: '10'
    });
    near(volumeOf(side1.doc), (50 * 50 - 40 * 40) * 10, 30, 'a wall outside the profile');

    const centred = squareExtrude(40, {
      kind: 'thin',
      wall: '5',
      wallLocation: 'center',
      distance: '10'
    });
    near(volumeOf(centred.doc), (45 * 45 - 35 * 35) * 10, 30, 'a wall centred on it');

    const side2 = squareExtrude(40, {
      kind: 'thin',
      wall: '5',
      wallLocation: 'side2',
      distance: '10'
    });
    // Offsetting a square inward by the wall thickness takes twice that off
    // each dimension, so a 40 square with a 5 wall inside it is 40 down to 30.
    near(volumeOf(side2.doc), (40 * 40 - 30 * 30) * 10, 30, 'a wall inside it');
  });

  test('extrude: a thin extrude is hollow all the way through', () => {
    const { doc } = squareExtrude(40, {
      kind: 'thin',
      wall: '5',
      wallLocation: 'center',
      distance: '10'
    });
    const res = rebuild(doc);
    // A tube has one hole through it, which is a genus of one. A slab has none.
    assert(res.bodies[0].solid.genus() === 1, 'a wall should be a tube');
  });

  test('extrude: an old document still opens', () => {
    // `extent` used to mean direction as well as distance. Files written that
    // way have to keep building the same solid.
    for (const [was, want] of [
      ['one', 10 * 10 * 10],
      ['symmetric', 10 * 10 * 10],
      ['two', 10 * 10 * 16]
    ]) {
      const { doc } = squareExtrude(10, { extent: was, distance: '10', distance2: '6' });
      near(volumeOf(doc), want, 1, `an old ${was} extrude`);
    }
  });

  test('extrude: nothing chosen extrudes nothing', () => {
    // No seeds at all still means the whole sketch, which is what picking the
    // sketch in the browser asks for and what older files mean. An empty list
    // means nothing has been pointed at, and must not quietly take everything.
    const all = squareExtrude(10, { seeds: null, distance: '10' });
    near(volumeOf(all.doc), 10 * 10 * 10, 1, 'no seeds is the whole sketch');

    const none = squareExtrude(10, { seeds: [], distance: '10' });
    const res = rebuild(none.doc);
    assert(res.bodies.length === 0, 'an empty choice should build nothing');
    assert(
      res.errors.some((e) => /profiles or planar faces/.test(e.message)),
      `expected a message asking for a profile, got ${JSON.stringify(res.errors)}`
    );
  });

  test('extrude: a planar face can be the profile', () => {
    // Extruding a face rather than a sketch. The boundary comes back out of the
    // topology as world points and has to be flattened into the plane, which is
    // the step that quietly produced nothing when it was wrong.
    const doc = newDocument();
    const base = rectSketch(30, 20);
    doc.sketches[base.id] = base;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: base.id });
    doc.features.push({
      id: uid('f'),
      type: 'extrude',
      sketch: base.id,
      distance: '10',
      op: 'new'
    });
    const first = rebuild(doc);
    const body = first.bodies[0];
    const topo = buildTopology(K.meshData(body.solid));
    const top = topo.faces.find((f) => f.planar && f.normal[2] > 0.99);
    assert(top, 'the box should have a top face');

    const onFace = {
      id: uid('f'),
      type: 'extrude',
      faces: [{ bodyId: body.id, face: faceReference(top) }],
      seeds: [],
      distance: '6',
      op: 'new'
    };
    doc.features.push(onFace);
    const res = rebuild(doc);
    const built = res.bodies.find((b) => b.createdBy === onFace.id);
    assert(built, 'extruding the face should make a body');
    near(built.solid.volume(), 30 * 20 * 6, 2, 'the face keeps its own outline');
    const bb = built.solid.boundingBox();
    near(bb.min[2], 10, 1e-3, 'and starts at the face it came from');
    near(bb.max[2], 16, 1e-3, 'going the distance asked for');
  });

  test('extrude: to object stops at what it was pointed at', () => {
    // A plate floating above the sketch plane, and a post extruded up to it.
    const doc = newDocument();
    const plate = rectSketch(60, 60);
    doc.sketches[plate.id] = plate;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: plate.id });
    doc.features.push({
      id: uid('f'),
      type: 'extrude',
      sketch: plate.id,
      distance: '5',
      start: 'offset',
      startOffset: '30',
      op: 'new'
    });

    const post = rectSketch(10, 10);
    doc.sketches[post.id] = post;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: post.id });
    const first = rebuild(doc);
    const plateBody = first.bodies[0];

    const upTo = {
      id: uid('f'),
      type: 'extrude',
      sketch: post.id,
      extent: 'object',
      direction: 'one',
      extend: 'body',
      toObject: { bodyId: plateBody.id },
      op: 'new'
    };
    doc.features.push(upTo);

    const res = rebuild(doc);
    assert(res.bodies.length === 2, `expected two bodies, got ${res.bodies.length}`);
    const built = res.bodies.find((b) => b.createdBy === upTo.id);
    const bb = built.solid.boundingBox();
    near(bb.min[2], 0, 1e-3, 'starts on the sketch plane');
    near(bb.max[2], 30, 0.05, 'and stops at the near face of the plate');

    // Through the body instead reaches past its far side.
    upTo.extend = 'through';
    const res2 = rebuild(doc);
    const through = res2.bodies.find((b) => b.createdBy === upTo.id);
    near(through.solid.boundingBox().max[2], 35, 0.05, 'through carries on past it');

    // And an offset shifts where it stops.
    upTo.extend = 'body';
    upTo.toOffset = '-4';
    const res3 = rebuild(doc);
    const shy = res3.bodies.find((b) => b.createdBy === upTo.id);
    near(shy.solid.boundingBox().max[2], 26, 0.05, 'stopping short by the offset');
  });

  /* -------- revolve -------- */

  /**
   * A rectangle sitting away from the Y axis, so revolving it about that axis
   * sweeps a ring whose volume Pappus gives exactly: the area times the
   * distance its centroid travels.
   */
  const ringRevolve = (extra) => {
    const doc = newDocument();
    const sk = newSketch('XY', 'Section');
    // From x = 10 to 14, y = 0 to 3.
    sk.points = [
      { x: 10, y: 0 },
      { x: 14, y: 0 },
      { x: 14, y: 3 },
      { x: 10, y: 3 }
    ];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] },
      { id: 4, type: 'line', p: [3, 0] }
    ];
    sk.nextEntityId = 5;
    doc.sketches[sk.id] = sk;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: sk.id });
    const f = {
      id: uid('f'),
      type: 'revolve',
      sketch: sk.id,
      axis: { type: 'y' },
      op: 'new',
      ...extra
    };
    doc.features.push(f);
    return { doc, f };
  };

  // Pappus: the swept volume is the area times how far the centroid travels.
  const pappus = (deg) => 4 * 3 * ((deg / 360) * 2 * Math.PI * 12);

  test('revolve: a full turn sweeps the whole ring', () => {
    const { doc } = ringRevolve({ extent: 'full' });
    const res = rebuild(doc);
    near(res.bodies[0].solid.volume(), pappus(360), pappus(360) * 0.01, 'a whole turn');
    assert(res.bodies[0].solid.genus() === 1, 'a closed ring has a hole through it');
  });

  test('revolve: an angle sweeps only that far', () => {
    for (const deg of [90, 120, 270]) {
      const { doc } = ringRevolve({ extent: 'angle', angle: String(deg) });
      const res = rebuild(doc);
      near(
        res.bodies[0].solid.volume(),
        pappus(deg),
        pappus(deg) * 0.01,
        `${deg} degrees`
      );
    }
  });

  test('revolve: two sides add up and sit either side of the profile', () => {
    const { doc } = ringRevolve({
      extent: 'angle',
      direction: 'two',
      angle: '60',
      angle2: '30'
    });
    const res = rebuild(doc);
    near(res.bodies[0].solid.volume(), pappus(90), pappus(90) * 0.01, 'sixty and thirty');
    // The profile lies in the XY plane, so a sweep that reaches to both sides
    // of it has to cross into negative Z as well as positive.
    const bb = res.bodies[0].solid.boundingBox();
    assert(bb.min[2] < -1, `expected the sweep to reach behind the profile, got ${bb.min[2]}`);
    assert(bb.max[2] > 1, `and in front of it, got ${bb.max[2]}`);
  });

  test('revolve: symmetric measures whole or half turn', () => {
    const whole = ringRevolve({
      extent: 'angle',
      direction: 'symmetric',
      measure: 'whole',
      angle: '90'
    });
    near(rebuild(whole.doc).bodies[0].solid.volume(), pappus(90), pappus(90) * 0.01, 'whole');

    const half = ringRevolve({
      extent: 'angle',
      direction: 'symmetric',
      measure: 'half',
      angle: '90'
    });
    near(
      rebuild(half.doc).bodies[0].solid.volume(),
      pappus(180),
      pappus(180) * 0.01,
      'half length is that much each way'
    );
  });

  test('revolve: the axis can be one of the sketch lines', () => {
    // The left edge of the section, which lies at x = 10, so the sweep is a
    // ring of inner radius nothing and the centroid travels a shorter way.
    const { doc } = ringRevolve({ extent: 'full', axis: { type: 'entity', entity: 4 } });
    const res = rebuild(doc);
    // Area 12, centroid 2 from that edge: 12 * 2 * pi * 2.
    near(res.bodies[0].solid.volume(), 4 * 3 * 2 * Math.PI * 2, 20, 'about a sketch line');
  });

  test('revolve: a world axis has to lie in the profile plane', () => {
    // Z is perpendicular to an XY sketch, so a profile cannot sweep about it.
    const bad = ringRevolve({ extent: 'full', axis: { type: 'world', worldAxis: 'z' } });
    const res = rebuild(bad.doc);
    assert(
      res.errors.some((e) => /same plane/.test(e.message)),
      `expected a message about the plane, got ${JSON.stringify(res.errors)}`
    );

    // Y lies in it, and is the same as the sketch's own Y axis.
    const good = ringRevolve({ extent: 'full', axis: { type: 'world', worldAxis: 'y' } });
    near(
      rebuild(good.doc).bodies[0].solid.volume(),
      pappus(360),
      pappus(360) * 0.01,
      'about the world Y axis'
    );
  });

  test('revolve: an old document still opens', () => {
    // A revolve used to carry only an angle, with a full turn written as 360.
    const full = ringRevolve({ angle: '360' });
    near(rebuild(full.doc).bodies[0].solid.volume(), pappus(360), pappus(360) * 0.01, 'an old full turn');

    const part = ringRevolve({ angle: '90' });
    near(rebuild(part.doc).bodies[0].solid.volume(), pappus(90), pappus(90) * 0.01, 'an old angle');
  });

  test('revolve: nothing chosen revolves nothing', () => {
    const { doc } = ringRevolve({ extent: 'full', seeds: [] });
    const res = rebuild(doc);
    assert(res.bodies.length === 0, 'an empty choice should build nothing');
    assert(
      res.errors.some((e) => /profiles or planar faces/.test(e.message)),
      `expected a message asking for a profile, got ${JSON.stringify(res.errors)}`
    );
  });

  /* -------- sweep and loft -------- */

  /** A square profile on XY and a straight path up Z, in one document. */
  const sweepDoc = (extra) => {
    const doc = newDocument();
    const prof = rectSketch(10, 10);
    doc.sketches[prof.id] = prof;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: prof.id });

    // The path is a line on XZ running from the origin up to z = 40.
    const path = newSketch('XZ', 'Path');
    path.points = [{ x: 0, y: 0 }, { x: 0, y: 40 }];
    path.entities = [{ id: 1, type: 'line', p: [0, 1] }];
    path.nextEntityId = 2;
    doc.sketches[path.id] = path;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: path.id });

    const f = {
      id: uid('f'),
      type: 'sweep',
      sketch: prof.id,
      seeds: null,
      path: { sketch: path.id, entities: [1] },
      op: 'new',
      ...extra
    };
    doc.features.push(f);
    return { doc, f, pathId: path.id };
  };

  test('sweep: a straight path is the same as an extrude', () => {
    const { doc } = sweepDoc({});
    const res = rebuild(doc);
    assert(res.bodies.length === 1, `expected one body: ${JSON.stringify(res.errors)}`);
    near(res.bodies[0].solid.volume(), 10 * 10 * 40, 40, 'ten by ten, forty long');
  });

  test('sweep: distance travels only part of the way', () => {
    const { doc } = sweepDoc({ distance: '0.25' });
    const res = rebuild(doc);
    near(res.bodies[0].solid.volume(), 10 * 10 * 10, 20, 'a quarter of the path');
    near(res.bodies[0].solid.boundingBox().max[2], 10, 0.2, 'and stops a quarter along');
  });

  test('sweep: a taper opens the section out along the way', () => {
    // Ten degrees over forty of path, against a mean radius of about 5.4 for a
    // ten by ten square, so the far end is a good deal larger than the near.
    const { doc } = sweepDoc({ taper: '10' });
    const res = rebuild(doc);
    const bb = res.bodies[0].solid.boundingBox();
    const wide = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);
    assert(wide > 12, `expected the far end to open out, widest was ${wide.toFixed(2)}`);
    assert(res.bodies[0].solid.volume() > 10 * 10 * 40, 'and to hold more than a straight sweep');
  });

  test('sweep: a guide rail drives how the section grows', () => {
    // A rail that leans away from the path, so the section has to grow to reach
    // it. Without the rail the sweep is a plain prism.
    const plain = sweepDoc({});
    const straight = rebuild(plain.doc).bodies[0].solid.volume();

    const railed = sweepDoc({ sweepType: 'rail', profileScaling: 'scale' });
    const rail = newSketch('XZ', 'Rail');
    rail.points = [{ x: 8, y: 0 }, { x: 24, y: 40 }];
    rail.entities = [{ id: 1, type: 'line', p: [0, 1] }];
    rail.nextEntityId = 2;
    railed.doc.sketches[rail.id] = rail;
    railed.doc.features.splice(2, 0, { id: uid('f'), type: 'sketch', sketch: rail.id });
    railed.f.rail = { sketch: rail.id, entities: [1] };

    const res = rebuild(railed.doc);
    assert(res.bodies.length === 1, `expected one body: ${JSON.stringify(res.errors)}`);
    const grown = res.bodies[0].solid.volume();
    assert(grown > straight * 1.5, `the rail should open it out: ${grown} against ${straight}`);
    const bb = res.bodies[0].solid.boundingBox();
    assert(bb.max[0] - bb.min[0] > 14, 'and the far end should be wider than the near');
  });

  /** Two squares on parallel planes, ready to loft between. */
  const loftDoc = (topSide, extra) => {
    const doc = newDocument();
    const a = rectSketch(20, 20);
    doc.sketches[a.id] = a;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: a.id });

    const b = newSketch({ base: 'XY', offset: '30' }, 'Top');
    const h = topSide / 2;
    b.points = [
      { x: -h, y: -h },
      { x: h, y: -h },
      { x: h, y: h },
      { x: -h, y: h }
    ];
    b.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] },
      { id: 4, type: 'line', p: [3, 0] }
    ];
    b.nextEntityId = 5;
    doc.sketches[b.id] = b;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: b.id });

    const f = {
      id: uid('f'),
      type: 'loft',
      sections: [{ sketch: a.id }, { sketch: b.id }],
      op: 'new',
      ...extra
    };
    doc.features.push(f);
    return { doc, f, bottom: a, top: b };
  };

  test('loft: between two squares is the frustum formula', () => {
    // A frustum's volume is h/3 times the two areas and the root of their
    // product, which is an independent check on the stitching.
    const { doc } = loftDoc(10);
    const res = rebuild(doc);
    const A = 20 * 20;
    const B = 10 * 10;
    const want = (30 / 3) * (A + B + Math.sqrt(A * B));
    near(res.bodies[0].solid.volume(), want, want * 0.02, 'the frustum formula');
  });

  test('loft: a point section brings it to a tip', () => {
    const { doc, top } = loftDoc(10);
    // Replace the top square with a single point on its plane.
    top.points = [{ x: 0, y: 0 }];
    top.entities = [{ id: 1, type: 'point', p: 0 }];
    top.nextEntityId = 2;
    const f = doc.features[doc.features.length - 1];
    f.sections[1] = { sketch: top.id, point: 0 };

    const res = rebuild(doc);
    assert(res.bodies.length === 1, `expected one body: ${JSON.stringify(res.errors)}`);
    // A pyramid on a twenty square, thirty tall.
    near(res.bodies[0].solid.volume(), (20 * 20 * 30) / 3, 40, 'a pyramid');
  });

  test('loft: a tangent end leaves square to its own profile', () => {
    const straight = loftDoc(10);
    const plain = rebuild(straight.doc).bodies[0].solid.volume();

    const tangent = loftDoc(10, { startCondition: 'tangent', startWeight: '1' });
    const res = rebuild(tangent.doc);
    assert(res.bodies.length === 1, `expected one body: ${JSON.stringify(res.errors)}`);
    const held = res.bodies[0].solid.volume();
    // Holding the bottom section's size for a while before narrowing leaves
    // more material than running straight to the top.
    assert(held > plain, `tangent should hold its size longer: ${held} against ${plain}`);
  });

  test('loft: still lofts when nothing extra is asked for', () => {
    // The plain path has to keep working with all the new settings absent,
    // which is what an older file looks like.
    const { doc, f } = loftDoc(14);
    delete f.startCondition;
    delete f.endCondition;
    const res = rebuild(doc);
    assert(res.bodies.length === 1, `expected one body: ${JSON.stringify(res.errors)}`);
    assert(res.errors.length === 0, JSON.stringify(res.errors));
  });

  /* -------- fillet, chamfer, shell -------- */

  /** A plain box body, ready for a modify feature to be added after it. */
  const boxDoc = (w, d, h) => {
    const doc = newDocument();
    doc.features.push({
      id: uid('f'),
      type: 'primitive',
      shape: 'box',
      params: { width: String(w), depth: String(d), height: String(h), centered: true },
      op: 'new'
    });
    return doc;
  };

  test('chamfer: two distances cut further into one face than the other', () => {
    // A chamfer along one edge. Equal takes a right triangle of d squared over
    // two; two distances take d1 times d2 over two, so twice the second
    // distance removes twice the material.
    const mk = (extra) => {
      const doc = boxDoc(40, 40, 40);
      const f = { id: uid('f'), type: 'chamfer', bodies: 'all', edges: [], radius: '4', ...extra };
      doc.features.push(f);
      return doc;
    };
    const solidVol = 40 * 40 * 40;

    const equal = rebuild(mk({})).bodies[0].solid.volume();
    const twice = rebuild(
      mk({ sets: [{ edges: [], radius: '4', chamferType: 'two', distance2: '8' }] })
    ).bodies[0].solid.volume();

    const cutEqual = solidVol - equal;
    const cutTwice = solidVol - twice;
    assert(cutEqual > 0, 'the equal chamfer should remove something');
    near(cutTwice / cutEqual, 2, 0.15, 'twice the second distance removes twice as much');
  });

  test('chamfer: an angle of forty five is the same as equal distances', () => {
    const mk = (sets) => {
      const doc = boxDoc(40, 40, 40);
      doc.features.push({ id: uid('f'), type: 'chamfer', bodies: 'all', edges: [], radius: '4', sets });
      return doc;
    };
    const equal = rebuild(mk([{ edges: [], radius: '4', chamferType: 'equal' }])).bodies[0].solid.volume();
    const at45 = rebuild(
      mk([{ edges: [], radius: '4', chamferType: 'angle', angle: '45' }])
    ).bodies[0].solid.volume();
    near(at45, equal, equal * 0.001, 'forty five degrees is the symmetric case');
  });

  test('fillet: several sets take their own radius in one feature', () => {
    // Two sets at different radii remove more than either alone and less than
    // twice the larger, which is what tells them apart from one set applied
    // twice at the same size.
    const doc = boxDoc(40, 40, 40);
    const first = rebuild(boxDoc(40, 40, 40)).bodies[0];
    const topo = buildTopology(K.meshData(first.solid));
    const verticals = topo.edges.filter(
      (e) => e.kind === 'line' && e.convex && Math.abs(e.dir[2]) > 0.99
    );
    assert(verticals.length === 4, `expected four upright edges, got ${verticals.length}`);

    doc.features.push({
      id: uid('f'),
      type: 'fillet',
      bodies: 'all',
      sets: [
        { edges: [edgeReference(verticals[0]), edgeReference(verticals[1])], radius: '8' },
        { edges: [edgeReference(verticals[2]), edgeReference(verticals[3])], radius: '2' }
      ]
    });
    const res = rebuild(doc);
    assert(res.bodies.length === 1, JSON.stringify(res.errors));
    const removed = 40 * 40 * 40 - res.bodies[0].solid.volume();

    // Two corners at eight and two: each corner loses (1 - pi/4) r squared of
    // section over the forty of height.
    const corner = (r) => (1 - Math.PI / 4) * r * r * 40;
    near(removed, 2 * corner(8) + 2 * corner(2), 40, 'two radii in one feature');
  });

  test('fillet: a chord length picks the radius that spans it', () => {
    // Asking for a chord is asking for how wide the blend reads across, and
    // letting the radius fall out of the angle. On a square corner that is
    // chord over root two, which is checked here two ways: against the closed
    // form for what a rounded corner removes, and against a constant radius
    // fillet of exactly that size, which must land on the same volume.
    const uprights = () => {
      const t = buildTopology(K.meshData(rebuild(boxDoc(40, 40, 40)).bodies[0].solid));
      return t.edges
        .filter((e) => e.kind === 'line' && e.convex && Math.abs(e.dir[2]) > 0.99)
        .map((e) => edgeReference(e));
    };
    const edges = uprights();
    assert(edges.length === 4, `expected four upright edges, got ${edges.length}`);

    const chordDoc = boxDoc(40, 40, 40);
    chordDoc.features.push({
      id: uid('f'),
      type: 'fillet',
      bodies: 'all',
      sets: [{ edges, filletType: 'chord', chord: '8' }]
    });
    const chord = rebuild(chordDoc);
    assert(chord.bodies.length === 1, JSON.stringify(chord.errors));

    const R = 8 / Math.SQRT2;
    const removed = 40 * 40 * 40 - chord.bodies[0].solid.volume();
    near(removed, 4 * (1 - Math.PI / 4) * R * R * 40, 40, 'a chord of eight is a radius of 5.657');

    const sameDoc = boxDoc(40, 40, 40);
    sameDoc.features.push({
      id: uid('f'),
      type: 'fillet',
      bodies: 'all',
      sets: [{ edges, radius: String(R) }]
    });
    const same = rebuild(sameDoc);
    near(
      chord.bodies[0].solid.volume(),
      same.bodies[0].solid.volume(),
      1,
      'the chord fillet is the constant fillet at the radius it worked out'
    );
  });

  test('fillet: a chord reads the angle rather than assuming a square corner', () => {
    // The rim of a truncated cone is not a right angle, so a chord there asks
    // for a different radius than the same chord on a box. If the rule were
    // written for square corners this is where it would show.
    const coneDoc = () => {
      const d = newDocument();
      d.features = [prim('cone', { diameter: '40', topDiameter: '24', height: '20' })];
      return d;
    };
    const first = rebuild(coneDoc());
    const topo = buildTopology(K.meshData(first.bodies[0].solid));
    const rim = topo.edges.find((e) => e.kind === 'circle' && e.radius < 13);
    assert(rim, 'expected the small rim of the cone');
    assert(Math.abs(rim.dihedral - 90) > 10, `the rim should not be square, it is ${rim.dihedral}`);

    const chord = 6;
    const expected = chord / (2 * Math.sin((rim.dihedral * Math.PI) / 360));
    assert(Math.abs(expected - chord / Math.SQRT2) > 0.2, 'this angle has to differ from a box');

    const byChord = coneDoc();
    byChord.features.push({
      id: uid('f'),
      type: 'fillet',
      bodies: 'all',
      sets: [{ edges: [edgeReference(rim)], filletType: 'chord', chord: String(chord) }]
    });
    const a = rebuild(byChord);
    assert(a.bodies.length === 1, JSON.stringify(a.errors));

    const byRadius = coneDoc();
    byRadius.features.push({
      id: uid('f'),
      type: 'fillet',
      bodies: 'all',
      sets: [{ edges: [edgeReference(rim)], radius: String(expected) }]
    });
    const b = rebuild(byRadius);
    assert(b.bodies.length === 1, JSON.stringify(b.errors));

    const va = a.bodies[0].solid.volume();
    near(va, b.bodies[0].solid.volume(), 1, 'the chord took the radius the angle asks for');

    // And it is not the square corner answer, which would remove a different
    // amount of material.
    const bySquare = coneDoc();
    bySquare.features.push({
      id: uid('f'),
      type: 'fillet',
      bodies: 'all',
      sets: [{ edges: [edgeReference(rim)], radius: String(chord / Math.SQRT2) }]
    });
    const c = rebuild(bySquare);
    assert(
      Math.abs(va - c.bodies[0].solid.volume()) > 5,
      'a square corner reading would have removed the same amount, so the angle was ignored'
    );
  });

  test('fillet: a hold line sets the radius from where it has to run out', () => {
    // A stepped block, so there is a face with a near edge to hold to rather
    // than one forty across. The convex edge round the back of the ledge is
    // filleted, and held first to the bottom of the back face, eight down,
    // then to the foot of the step, sixteen across. On a square corner the
    // radius is the distance itself, so those are a fillet of eight and a
    // fillet of sixteen out of the same pick.
    const stepDoc = () => {
      const d = newDocument();
      d.features = [
        prim('box', { width: '40', depth: '40', height: '8' }),
        { ...prim('box', { width: '40', depth: '24', height: '20', y: '-8', z: '14' }), op: 'join' }
      ];
      return d;
    };
    const base = rebuild(stepDoc());
    assert(base.bodies.length === 1, JSON.stringify(base.errors));
    const topo = buildTopology(K.meshData(base.bodies[0].solid));
    const along = (y, z, convex) =>
      topo.edges.find(
        (e) =>
          e.kind === 'line' &&
          e.convex === convex &&
          Math.abs(e.dir[0]) > 0.99 &&
          Math.abs(e.points[0][1] - y) < 0.01 &&
          Math.abs(e.points[0][2] - z) < 0.01
      );

    const target = along(20, 4, true);
    const lowBack = along(20, -4, true);
    const stepFoot = along(4, 4, false);
    assert(target && lowBack && stepFoot, 'expected the three edges of the step');

    const held = (hold) => {
      const d = stepDoc();
      d.features.push({
        id: uid('f'),
        type: 'fillet',
        bodies: 'all',
        sets: [
          {
            edges: [edgeReference(target)],
            filletType: 'hold',
            holdEdges: [edgeReference(hold)]
          }
        ]
      });
      const res = rebuild(d);
      assert(res.bodies.length === 1, JSON.stringify(res.errors));
      return res.bodies[0].solid.volume();
    };
    const constant = (r) => {
      const d = stepDoc();
      d.features.push({
        id: uid('f'),
        type: 'fillet',
        bodies: 'all',
        sets: [{ edges: [edgeReference(target)], radius: String(r) }]
      });
      const res = rebuild(d);
      assert(res.bodies.length === 1, JSON.stringify(res.errors));
      return res.bodies[0].solid.volume();
    };

    near(held(lowBack), constant(8), 1, 'held eight down is a fillet of eight');
    near(held(stepFoot), constant(16), 1, 'held sixteen across is a fillet of sixteen');
    assert(
      held(lowBack) > held(stepFoot),
      'the further hold has to take more material, or the distance was not read'
    );
  });

  test('fillet: a hold line with nothing picked says so', () => {
    const doc = boxDoc(40, 40, 40);
    doc.features.push({
      id: uid('f'),
      type: 'fillet',
      bodies: 'all',
      sets: [{ edges: [], filletType: 'hold', holdEdges: [] }]
    });
    const res = rebuild(doc);
    assert(
      res.errors.some((e) => /held/i.test(e.message)),
      `expected a complaint about the hold line, got ${JSON.stringify(res.errors)}`
    );
    near(res.bodies[0].solid.volume(), 40 * 40 * 40, 1, 'and it left the box alone');
  });

  test('fillet: an older set with an end radius is still a variable one', () => {
    // The type used to be implied by whether an end radius was filled in.
    // A document written then has to read back the same way.
    const doc = boxDoc(40, 40, 40);
    const set = { edges: [], radius: '6', endRadius: '2' };
    doc.features.push({ id: uid('f'), type: 'fillet', bodies: 'all', sets: [set] });
    const res = rebuild(doc);
    assert(set.filletType === 'variable', `read back as ${set.filletType}`);
    assert(res.bodies.length === 1, JSON.stringify(res.errors));
    assert(res.bodies[0].solid.volume() < 40 * 40 * 40, 'and it still removed material');
  });

  test('shell: which side the wall goes changes the outside size', () => {
    const shell = (side) => {
      const doc = boxDoc(30, 30, 30);
      doc.features.push({ id: uid('f'), type: 'shell', bodies: 'all', thickness: '3', side, openFaces: [] });
      const res = rebuild(doc);
      assert(res.bodies.length === 1, `${side}: ${JSON.stringify(res.errors)}`);
      const bb = res.bodies[0].solid.boundingBox();
      return { size: bb.max[0] - bb.min[0], volume: res.bodies[0].solid.volume() };
    };

    const inside = shell('inside');
    near(inside.size, 30, 0.6, 'inside keeps the outside where it was');

    const outside = shell('outside');
    near(outside.size, 36, 1.2, 'outside grows by the wall on each side');

    const both = shell('both');
    near(both.size, 33, 1.2, 'both straddles it');

    // A wall is hollow whichever way it went.
    for (const s of [inside, outside, both]) {
      assert(s.volume < 30 * 30 * 30, 'a shell should hold less than the solid');
    }
  });

  test('shell: an old document still shells inside', () => {
    const doc = boxDoc(30, 30, 30);
    doc.features.push({ id: uid('f'), type: 'shell', bodies: 'all', thickness: '3', openFaces: [] });
    const res = rebuild(doc);
    const bb = res.bodies[0].solid.boundingBox();
    near(bb.max[0] - bb.min[0], 30, 0.6, 'no side setting means inside');
  });

  /* -------- holes and patterns -------- */

  /** A plate with one hole position on it, ready for a hole feature. */
  const holeDoc = (extra) => {
    const doc = newDocument();
    const plate = rectSketch(60, 60);
    doc.sketches[plate.id] = plate;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: plate.id });
    doc.features.push({
      id: uid('f'),
      type: 'extrude',
      sketch: plate.id,
      distance: '20',
      op: 'new'
    });

    const marks = newSketch('XY', 'Marks');
    // rectSketch runs from the origin to w by h, so the centre is at half of
    // each. A mark at the origin would sit on the plate's corner.
    marks.points = [{ x: 30, y: 30 }];
    marks.entities = [{ id: 1, type: 'point', p: 0 }];
    marks.nextEntityId = 2;
    doc.sketches[marks.id] = marks;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: marks.id });

    const f = {
      id: uid('f'),
      type: 'hole',
      sketch: marks.id,
      points: [0],
      diameter: '10',
      depth: '8',
      ...extra
    };
    doc.features.push(f);
    return { doc, f };
  };

  test('hole: a blind hole takes only its own depth', () => {
    const { doc } = holeDoc({ extent: 'distance', depth: '8' });
    const res = rebuild(doc);
    const plate = 60 * 60 * 20;
    near(res.bodies[0].solid.volume(), plate - Math.PI * 25 * 8, 30, 'a blind hole');
  });

  test('hole: through all goes right through', () => {
    const { doc } = holeDoc({ extent: 'all' });
    const res = rebuild(doc);
    const plate = 60 * 60 * 20;
    near(res.bodies[0].solid.volume(), plate - Math.PI * 25 * 20, 40, 'all the way');
    assert(res.bodies[0].solid.genus() === 1, 'and leaves a hole through the plate');
  });

  test('hole: up to an object stops where that object is', () => {
    // The plate is twenty thick, so drilling up to a plane twenty above the
    // sketch is a hole right through it.
    const { doc } = holeDoc({
      extent: 'object',
      toObject: { plane: { base: 'XY', offset: '20' } }
    });
    const res = rebuild(doc);
    const plate = 60 * 60 * 20;
    near(res.bodies[0].solid.volume(), plate - Math.PI * 25 * 20, 40, 'down to the plane');

    // Half as far gives half the hole.
    doc.features[doc.features.length - 1].toObject = { plane: { base: 'XY', offset: '10' } };
    const half = rebuild(doc);
    near(half.bodies[0].solid.volume(), plate - Math.PI * 25 * 10, 40, 'and half as deep');
  });

  test('hole: a counterbore is wider at the mouth than the bore', () => {
    const { doc } = holeDoc({
      extent: 'all',
      holeType: 'counterbore',
      cbDiameter: '18',
      cbDepth: '5'
    });
    const res = rebuild(doc);
    const plate = 60 * 60 * 20;
    const bore = Math.PI * 25 * 20;
    const seat = Math.PI * 81 * 5 - Math.PI * 25 * 5;
    near(res.bodies[0].solid.volume(), plate - bore - seat, 60, 'bore plus the seat');
  });

  test('hole: a tapped hole cuts a thread into the bore', () => {
    const plain = rebuild(holeDoc({ extent: 'all' }).doc).bodies[0].solid.volume();
    const { doc } = holeDoc({ extent: 'all', tapped: true, pitch: '1.5', clearance: '0.2' });
    const res = rebuild(doc);
    assert(res.bodies.length === 1, JSON.stringify(res.errors));
    const tapped = res.bodies[0].solid.volume();
    assert(tapped < plain, `a thread should remove more, ${tapped} against ${plain}`);
    assert(
      plain - tapped < Math.PI * 25 * 20 * 0.5,
      'but nothing like as much as the bore itself'
    );
  });

  test('pattern: extent spreads the row over the distance given', () => {
    const mk = (extra) => {
      const doc = newDocument();
      doc.features.push({
        id: uid('f'),
        type: 'primitive',
        shape: 'box',
        params: { width: '4', depth: '4', height: '4', centered: true },
        op: 'new'
      });
      doc.features.push({
        id: uid('f'),
        type: 'patternRect',
        bodies: 'all',
        count1: '5',
        count2: '1',
        spacing1: '40',
        spacing2: '0',
        op: 'separate',
        ...extra
      });
      return rebuild(doc);
    };

    // Spacing of forty, five of them: the last sits a hundred and sixty out.
    const spaced = mk({ spacingType: 'spacing' });
    near(spaced.bodies.length, 5, 0, 'five bodies');
    near(Math.max(...spaced.bodies.map((b) => b.solid.boundingBox().max[0])), 162, 0.5, 'spacing');

    // Extent of forty, five of them: the last sits forty out.
    const spread = mk({ spacingType: 'extent' });
    near(Math.max(...spread.bodies.map((b) => b.solid.boundingBox().max[0])), 42, 0.5, 'extent');
  });

  test('pattern: symmetric spreads either side of the original', () => {
    const doc = newDocument();
    doc.features.push({
      id: uid('f'),
      type: 'primitive',
      shape: 'box',
      params: { width: '4', depth: '4', height: '4', centered: true },
      op: 'new'
    });
    doc.features.push({
      id: uid('f'),
      type: 'patternRect',
      bodies: 'all',
      count1: '3',
      count2: '1',
      spacing1: '20',
      spacing2: '0',
      symmetry: 'yes',
      op: 'separate'
    });
    const res = rebuild(doc);
    const xs = res.bodies.map((b) => b.solid.boundingBox().max[0]);
    assert(Math.min(...xs) < -15, `expected a copy to the left, got ${Math.min(...xs)}`);
    assert(Math.max(...xs) > 15, `and one to the right, got ${Math.max(...xs)}`);
  });

  test('pattern: a suppressed instance is left out', () => {
    const mk = (skipInstances) => {
      const doc = newDocument();
      doc.features.push({
        id: uid('f'),
        type: 'primitive',
        shape: 'box',
        params: { width: '4', depth: '4', height: '4', centered: true },
        op: 'new'
      });
      doc.features.push({
        id: uid('f'),
        type: 'patternRect',
        bodies: 'all',
        count1: '4',
        count2: '1',
        spacing1: '20',
        spacing2: '0',
        skipInstances,
        op: 'separate'
      });
      return rebuild(doc).bodies.length;
    };
    near(mk([]), 4, 0, 'four to begin with');
    near(mk(['2,0']), 3, 0, 'one left out');
  });

  /* -------- the rest of the modify group -------- */

  const primDoc = (shape, params) => {
    const doc = newDocument();
    doc.features.push({ id: uid('f'), type: 'primitive', shape, params, op: 'new' });
    return doc;
  };

  test('primitive: a torus holds what Pappus says it holds', () => {
    // A ring of section area pi r squared whose centroid travels 2 pi R.
    const R = 20;
    const r = 5;
    const doc = primDoc('torus', { diameter: String(R * 2), tubeDiameter: String(r * 2) });
    const res = rebuild(doc);
    assert(res.bodies.length === 1, JSON.stringify(res.errors));
    const want = Math.PI * r * r * 2 * Math.PI * R;
    near(res.bodies[0].solid.volume(), want, want * 0.02, 'a torus');
    assert(res.bodies[0].solid.genus() === 1, 'and it has a hole through it');
  });

  test('primitive: a pipe is a tube of the wall it was given', () => {
    const od = 20;
    const wall = 3;
    const h = 40;
    const doc = primDoc('pipe', {
      diameter: String(od),
      wall: String(wall),
      height: String(h),
      centered: true
    });
    const res = rebuild(doc);
    assert(res.bodies.length === 1, JSON.stringify(res.errors));
    const ro = od / 2;
    const ri = ro - wall;
    const want = Math.PI * (ro * ro - ri * ri) * h;
    near(res.bodies[0].solid.volume(), want, want * 0.03, 'a pipe wall');
    assert(res.bodies[0].solid.genus() === 1, 'open at both ends');
  });

  test('primitive: a pipe refuses a wall thicker than itself', () => {
    const doc = primDoc('pipe', { diameter: '20', wall: '15', height: '40' });
    const res = rebuild(doc);
    assert(res.bodies.length === 0, 'nothing should be built');
    assert(
      res.errors.some((e) => /wall thinner/.test(e.message)),
      `expected a message about the wall, got ${JSON.stringify(res.errors)}`
    );
  });

  test('move: rotating turns about a stated point, not the origin', () => {
    // A box sitting away from the origin. Turned about its own middle it stays
    // put; turned about the origin it swings across.
    const mk = (extra) => {
      const doc = newDocument();
      doc.features.push({
        id: uid('f'),
        type: 'primitive',
        shape: 'box',
        params: { width: '10', depth: '10', height: '10', x: '40', y: '0', z: '0', centered: true },
        op: 'new'
      });
      doc.features.push({
        id: uid('f'),
        type: 'move',
        bodies: 'all',
        moveType: 'rotate',
        rotAxis: [0, 0, 1],
        rotAngle: '90',
        ...extra
      });
      return rebuild(doc).bodies[0].solid.boundingBox();
    };

    const aboutItself = mk({});
    near((aboutItself.min[0] + aboutItself.max[0]) / 2, 40, 0.5, 'stays where it was');

    const aboutOrigin = mk({ pivot: [0, 0, 0] });
    near((aboutOrigin.min[0] + aboutOrigin.max[0]) / 2, 0, 0.5, 'swings round to the Y axis');
    near((aboutOrigin.min[1] + aboutOrigin.max[1]) / 2, 40, 0.5, 'a quarter turn away');
  });

  test('move: point to point shifts by the gap between them', () => {
    const doc = newDocument();
    doc.features.push({
      id: uid('f'),
      type: 'primitive',
      shape: 'box',
      params: { width: '10', depth: '10', height: '10', centered: true },
      op: 'new'
    });
    doc.features.push({
      id: uid('f'),
      type: 'move',
      bodies: 'all',
      moveType: 'points',
      fromPoint: [0, 0, 0],
      toPoint: [12, -4, 7]
    });
    const bb = rebuild(doc).bodies[0].solid.boundingBox();
    near((bb.min[0] + bb.max[0]) / 2, 12, 1e-3, 'along x');
    near((bb.min[1] + bb.max[1]) / 2, -4, 1e-3, 'along y');
    near((bb.min[2] + bb.max[2]) / 2, 7, 1e-3, 'along z');
  });

  test('scale: growing about the middle keeps a part where it was', () => {
    const mk = (extra) => {
      const doc = newDocument();
      doc.features.push({
        id: uid('f'),
        type: 'primitive',
        shape: 'box',
        params: { width: '10', depth: '10', height: '10', x: '40', y: '0', z: '0', centered: true },
        op: 'new'
      });
      doc.features.push({ id: uid('f'), type: 'scale', bodies: 'all', factor: '2', ...extra });
      return rebuild(doc).bodies[0].solid.boundingBox();
    };

    const middle = mk({});
    near((middle.min[0] + middle.max[0]) / 2, 40, 0.01, 'stays put');
    near(middle.max[0] - middle.min[0], 20, 0.01, 'and doubles in size');

    const origin = mk({ pivotMode: 'origin' });
    near((origin.min[0] + origin.max[0]) / 2, 80, 0.01, 'about the origin it moves out too');
  });

  /* -------- moving sketch geometry -------- */

  test('sketch: a drag can pull several points at once', () => {
    // What moving a selection does: every point is told where it went and the
    // solver settles the constraints around all of them together.
    const sk = looseRect('Drag many');
    sk.constraints = sk.constraints.filter((c) => c.type !== 'fixed');
    const pulls = sk.points.map((p, i) => ({ point: i, x: p.x + 12, y: p.y - 5 }));
    for (const g of pulls) {
      sk.points[g.point].x = g.x;
      sk.points[g.point].y = g.y;
    }
    const res = solveSketch(sk, { dragging: pulls, maxIterations: 40 });
    near(res.error, 0, 1e-6, 'the sketch still solves');
    near(sk.points[0].x, 12, 1e-4, 'moved along x');
    near(sk.points[0].y, -5, 1e-4, 'moved along y');
    // Still a rectangle: the move was rigid, not a stretch.
    near(sk.points[1].x - sk.points[0].x, 7, 1e-4, 'width unchanged');
    near(sk.points[2].y - sk.points[1].y, 3, 1e-4, 'height unchanged');
  });

  test('sketch: moving pinned geometry brings its anchor along', () => {
    // A fixed constraint holds absolute coordinates. Left where it was it
    // fights the move, and since the drag pull is deliberately soft the
    // geometry ends up somewhere between the two rather than where it was told.
    const move = (sk, dx, dy, carryAnchor) => {
      if (carryAnchor) {
        const anchor = sk.constraints.find((c) => c.type === 'fixed');
        anchor.x += dx;
        anchor.y += dy;
      }
      const pulls = sk.points.map((p, i) => ({ point: i, x: p.x + dx, y: p.y + dy }));
      for (const g of pulls) {
        sk.points[g.point].x = g.x;
        sk.points[g.point].y = g.y;
      }
      solveSketch(sk, { dragging: pulls, maxIterations: 40 });
    };

    const left = looseRect('Anchor left behind');
    move(left, 10, 5, false);
    assert(
      Math.hypot(left.points[0].x - 10, left.points[0].y - 5) > 1,
      `the anchor should have held it back, but it landed at ` +
        `${left.points[0].x.toFixed(2)}, ${left.points[0].y.toFixed(2)}`
    );

    const carried = looseRect('Anchor carried');
    move(carried, 10, 5, true);
    near(carried.points[0].x, 10, 1e-4, 'carried along, the move lands exactly');
    near(carried.points[0].y, 5, 1e-4, 'in both directions');
    near(carried.points[1].x - carried.points[0].x, 7, 1e-4, 'and the shape is unchanged');
    near(carried.points[2].y - carried.points[1].y, 3, 1e-4, 'in both directions');
  });

  /* -------- units -------- */

  test('units: a length carries its unit into millimetres', () => {
    const cases = [
      ['50', 50],
      ['50mm', 50],
      ['2in', 50.8],
      ['1.5 in', 38.1],
      ['2"', 50.8],
      ["1'", 304.8],
      ['5 ft', 1524],
      ['3cm', 30],
      ['0.5m', 500],
      ['10 thou', 0.254],
      ['1 inch', 25.4],
      ['2 IN', 50.8]
    ];
    for (const [text, want] of cases) {
      near(evaluate(text, {}), want, 1e-9, `${text} in millimetres`);
    }
  });

  test('units: an angle carries its unit into degrees', () => {
    near(evaluate('90deg', {}), 90, 1e-9, 'degrees');
    near(evaluate('1rad', {}), 180 / Math.PI, 1e-9, 'radians');
    near(evaluate('0.25turn', {}), 90, 1e-9, 'turns');
  });

  test('units: a unit is just a number, so it mixes with the arithmetic', () => {
    near(evaluate('25.4mm + 1in', {}), 50.8, 1e-9, 'two units added');
    near(evaluate('2in * 3', {}), 152.4, 1e-9, 'scaled after the unit');
    near(evaluate('(1in + 5mm) / 2', {}), 15.2, 1e-9, 'inside brackets');
    near(evaluate('wall * 2mm', { wall: 10 }), 20, 1e-9, 'alongside a parameter');
  });

  test('units: a word that is not a unit is still a parameter', () => {
    // Reading a suffix as a unit must not swallow names that mean something.
    near(evaluate('wall', { wall: 7 }), 7, 1e-9, 'a bare parameter');
    let threw = false;
    try {
      evaluate('3 banana', {});
    } catch {
      threw = true;
    }
    assert(threw, 'an unknown word after a number should still be an error');
  });

  test('units: a dimension keeps the text it was typed as', () => {
    // The number alone is not enough. A dimension entered as `2in` has to read
    // back as `2in`, or reopening it offers millimetres and the parameter link
    // in `wall * 2` is lost on the next solve.
    const sk = looseRect('Units');
    sk.constraints.push(
      { id: 'c6', type: 'distance', points: [0, 1], value: 0, expr: '2in' },
      { id: 'c7', type: 'distance', points: [1, 2], value: 0, expr: 'wall / 2' }
    );
    resolveDimensionExprs(sk, { wall: 30 });
    solveSketch(sk, { maxIterations: 60 });
    const P = sk.points;
    near(Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y), 50.8, 1e-6, 'two inches wide');
    near(Math.hypot(P[2].x - P[1].x, P[2].y - P[1].y), 15, 1e-6, 'half of wall high');

    // And it survives the round trip through the saved file, which is plain JSON.
    const reloaded = JSON.parse(JSON.stringify(sk));
    resolveDimensionExprs(reloaded, { wall: 30 });
    near(reloaded.constraints[5].value, 50.8, 1e-9, 'the unit survives a reload');
    near(reloaded.constraints[6].value, 15, 1e-9, 'the expression survives a reload');
  });

  test('units: a feature distance takes a unit too', () => {
    // Feature dialogs store text and evaluate it at rebuild, so the same
    // tokenizer change has to reach an extrude.
    const doc = newDocument();
    const sk = looseRect('Plate');
    sk.constraints.push(
      { id: 'c6', type: 'distance', points: [0, 1], value: 0, expr: '1in' },
      { id: 'c7', type: 'distance', points: [1, 2], value: 0, expr: '1in' }
    );
    doc.sketches[sk.id] = sk;
    doc.features.push({ id: uid('f'), type: 'sketch', sketch: sk.id });
    doc.features.push({
      id: uid('f'),
      type: 'extrude',
      sketch: sk.id,
      regions: null,
      distance: '0.5in',
      op: 'new'
    });

    const res = rebuild(doc);
    assert(res.bodies.length === 1, `expected one body, got ${res.bodies.length}`);
    // 25.4 by 25.4 by 12.7 millimetres.
    near(res.bodies[0].solid.volume(), 25.4 * 25.4 * 12.7, 1, 'an inch square, half an inch thick');
  });

  /* -------- camera orientation -------- */

  // The basis a camera ends up with for a given orbit. Written the way three
  // builds it, so a change to either side shows up here rather than as a sketch
  // that draws at ninety degrees to the mouse.
  const basisFor = (dir, up) => {
    const n = new THREE.Vector3(...dir).normalize();
    const sph = new THREE.Spherical().setFromVector3(
      new THREE.Vector3(n.x, n.z, n.y)
    );
    if (Math.abs(n.z) > 0.999) sph.theta = rollTheta(n.z > 0 ? 1 : -1, up || [0, 1, 0]);
    const u = new THREE.Vector3(...screenUpFor(sph.phi, sph.theta));
    const right = new THREE.Vector3().crossVectors(u, n).normalize();
    const screenUp = new THREE.Vector3().crossVectors(n, right).normalize();
    return { right, up: screenUp };
  };

  const axisNear = (v, want, what) => {
    near(v.x, want[0], 1e-6, `${what} x`);
    near(v.y, want[1], 1e-6, `${what} y`);
    near(v.z, want[2], 1e-6, `${what} z`);
  };

  test('view: top and bottom land at a chosen roll, not the last orbit', () => {
    // Looking down the world up axis, theta does not move the camera, so
    // nothing pins the roll. Left unchosen it kept whatever the last orbit
    // ended on and a sketch on XY came out turned ninety degrees.
    const top = basisFor([0, 0, 1]);
    axisNear(top.right, [1, 0, 0], 'top screen right is world X');
    axisNear(top.up, [0, 1, 0], 'top screen up is world Y');

    const bottom = basisFor([0, 0, -1]);
    axisNear(bottom.right, [-1, 0, 0], 'bottom screen right is mirrored');
    axisNear(bottom.up, [0, 1, 0], 'bottom screen up is world Y');
  });

  test('view: the standard views put Z up the screen', () => {
    const cases = [
      ['front', [0, -1, 0], [1, 0, 0]],
      ['back', [0, 1, 0], [-1, 0, 0]],
      ['right', [1, 0, 0], [0, 1, 0]],
      ['left', [-1, 0, 0], [0, -1, 0]]
    ];
    for (const [name, dir, right] of cases) {
      const b = basisFor(dir);
      axisNear(b.right, right, `${name} screen right`);
      axisNear(b.up, [0, 0, 1], `${name} screen up`);
    }
  });

  test('view: a sketch plane puts its own axes on the screen axes', () => {
    // What makes a line drawn rightwards a horizontal in sketch coordinates,
    // so the constraint inferred from it matches what is on screen.
    for (const name of ['XY', 'XZ', 'YZ']) {
      const p = resolvePlane(name, {});
      const b = basisFor(p.n, p.y);
      axisNear(b.right, p.x, `${name} screen right is the plane X`);
      axisNear(b.up, p.y, `${name} screen up is the plane Y`);
    }
  });

  test('view: home is the standard isometric', () => {
    // Equal parts front, right and above. The view used to open on angles that
    // were merely near this, so the home button did not return anywhere exact.
    const n = new THREE.Vector3(...ISO_VIEW).normalize();
    near(Math.abs(n.x), Math.abs(n.y), 1e-9, 'front and side in equal measure');
    near(Math.abs(n.x), Math.abs(n.z), 1e-9, 'and the same again from above');

    const b = basisFor(ISO_VIEW);
    near(b.up.z, Math.sqrt(2 / 3), 1e-6, 'up leans back by the isometric amount');
    near(b.right.z, 0, 1e-9, 'and across the screen stays level');
    // The three axes that lean towards the viewer come to the screen a hundred
    // and twenty degrees apart, which is what makes a view isometric rather
    // than merely oblique. Looking along [1, -1, 1] those are +X, -Y and +Z.
    const onScreen = (v) => {
      const w = new THREE.Vector3(...v);
      return Math.atan2(w.dot(b.up), w.dot(b.right));
    };
    const gap = (a, c) => {
      const d = Math.abs(((onScreen(a) - onScreen(c)) * 180) / Math.PI) % 360;
      return d > 180 ? 360 - d : d;
    };
    near(gap([1, 0, 0], [0, -1, 0]), 120, 1e-4, 'X to Y');
    near(gap([0, -1, 0], [0, 0, 1]), 120, 1e-4, 'Y to Z');
    near(gap([0, 0, 1], [1, 0, 0]), 120, 1e-4, 'Z to X');
    // And all three foreshorten by the same amount, which is the other half of
    // what isometric means.
    const len = (v) => {
      const w = new THREE.Vector3(...v);
      return Math.hypot(w.dot(b.right), w.dot(b.up));
    };
    near(len([1, 0, 0]), len([0, 1, 0]), 1e-9, 'X and Y foreshorten alike');
    near(len([0, 1, 0]), len([0, 0, 1]), 1e-9, 'and Z with them');
  });

  test('view: the screen up stays continuous walking over the pole', () => {
    // The old fallback jumped to an arbitrary basis at the pole, so an orbit
    // through the top of the model snapped sideways.
    let prev = null;
    for (let phi = 0.9; phi >= 0.0005; phi -= 0.05) {
      const u = screenUpFor(phi, Math.PI);
      near(Math.hypot(u[0], u[1], u[2]), 1, 1e-9, 'screen up is a unit vector');
      if (prev) {
        const step = Math.hypot(u[0] - prev[0], u[1] - prev[1], u[2] - prev[2]);
        if (step > 0.1) throw new Error(`screen up jumped by ${step.toFixed(3)} at phi ${phi}`);
      }
      prev = u;
    }
    axisNear(new THREE.Vector3(...screenUpFor(0, Math.PI)), [0, 1, 0], 'at the pole');
  });

  /* -------- ellipse, text and the sketch patterns -------- */

  /** A sketch holding one ellipse, centred, with the major axis along X. */
  function ellipseSketch(rx, ry) {
    const sk = newSketch('XY', 'Ellipse');
    sk.points = [
      { x: 0, y: 0 },
      { x: rx, y: 0 },
      { x: 0, y: ry }
    ];
    sk.entities = [{ id: 1, type: 'ellipse', c: 0, a: 1, b: 2 }];
    sk.nextEntityId = 2;
    return sk;
  }

  test('ellipse: the frame comes from the three points that carry it', () => {
    const sk = ellipseSketch(12, 5);
    const f = ellipseFrame(sk, sk.entities[0]);
    near(f.rx, 12, 1e-9, 'major radius');
    near(f.ry, 5, 1e-9, 'minor radius');
    near(f.nx, 1, 1e-9, 'major axis along X');
  });

  test('ellipse: only the square part of the minor point counts', () => {
    // Sliding the minor point along the major axis must not change the shape,
    // or dragging it would shear the ellipse instead of resizing it.
    const sk = ellipseSketch(12, 5);
    sk.points[2] = { x: 9, y: 5 };
    const f = ellipseFrame(sk, sk.entities[0]);
    near(f.ry, 5, 1e-9, 'minor radius ignores the along-axis part');
  });

  test('ellipse: its area is pi a b', () => {
    const sk = ellipseSketch(12, 5);
    const regions = findRegions(sk);
    assert(regions.length === 1, 'expected one region, got ' + regions.length);
    // Tessellated, so a little under the true area. Half a percent is the
    // shared curve quality rule doing its job.
    const want = Math.PI * 12 * 5;
    near(Math.abs(signedArea(regions[0].outer)), want, want * 0.005, 'area');
  });

  test('ellipse: extruded, its volume is pi a b h', () => {
    const doc = newDocument();
    const sk = ellipseSketch(12, 5);
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      {
        id: uid('f'),
        type: 'extrude',
        sketch: sk.id,
        seeds: null,
        distance: '4',
        direction: 'one',
        op: 'new',
        targets: 'all'
      }
    ];
    const out = rebuild(doc);
    assert(out.bodies.length === 1, 'one body');
    const want = Math.PI * 12 * 5 * 4;
    near(out.bodies[0].solid.volume(), want, want * 0.01, 'volume');
  });

  test('text: a letter with a counter traces an outer loop and a hole', () => {
    const contours = textContours('O', { font: 'Arial', height: 10 });
    assert(contours.length === 2, 'expected 2 loops for O, got ' + contours.length);
    const areas = contours.map((c) => Math.abs(signedArea(c))).sort((a, b) => b - a);
    assert(areas[0] > areas[1], 'the outer loop is the larger');
    // A capital O at 10 mm has a wall around a millimetre thick, so the
    // counter carries a real share of the outline rather than a sliver.
    assert(areas[1] / areas[0] > 0.25, 'counter is only ' + (areas[1] / areas[0]).toFixed(2));
  });

  test('text: the run sits on its baseline at the origin', () => {
    const contours = textContours('H', { font: 'Arial', height: 10 });
    assert(contours.length === 1, 'H is one loop');
    const ys = contours[0].map((p) => p.y);
    const xs = contours[0].map((p) => p.x);
    // A capital H sits on the baseline and runs up to the cap height, which
    // for Arial is a little over seven tenths of the size.
    near(Math.min(...ys), 0, 0.2, 'bottom on the baseline');
    near(Math.max(...ys), 7.16, 0.4, 'cap height');
    // The pen origin is at zero, and the ink starts a side bearing to the
    // right of it. That is the font's own spacing, not an offset to correct.
    assert(Math.min(...xs) > 0, 'ink starts right of the pen origin');
    near(Math.min(...xs), 0.76, 0.3, 'left side bearing');
  });

  test('text: height scales the outline linearly', () => {
    const a = textContours('E', { font: 'Arial', height: 10 });
    const b = textContours('E', { font: 'Arial', height: 20 });
    const span = (c) => Math.max(...c[0].map((p) => p.y)) - Math.min(...c[0].map((p) => p.y));
    near(span(b) / span(a), 2, 0.02, 'twice the height');
  });

  test('text: extruded, it is a solid of the traced area', () => {
    const sk = newSketch('XY', 'Label');
    sk.points = [{ x: 0, y: 0 }];
    const contours = textContours('8', { font: 'Arial', height: 12 });
    sk.entities = [
      { id: 1, type: 'text', p: 0, text: '8', font: 'Arial', height: 12, angle: 0, contours }
    ];
    sk.nextEntityId = 2;

    const regions = findRegions(sk);
    assert(regions.length === 1, 'a figure 8 is one region, got ' + regions.length);
    assert(regions[0].holes.length === 2, 'with two holes, got ' + regions[0].holes.length);

    const doc = newDocument();
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      {
        id: uid('f'),
        type: 'extrude',
        sketch: sk.id,
        seeds: null,
        distance: '2',
        direction: 'one',
        op: 'new',
        targets: 'all'
      }
    ];
    const out = rebuild(doc);
    assert(out.bodies.length === 1, 'one body');
    // Two counters punched through, so the solid has genus two.
    assert(out.bodies[0].solid.genus() === 2, 'genus ' + out.bodies[0].solid.genus());
    const area =
      Math.abs(signedArea(regions[0].outer)) -
      regions[0].holes.reduce((t, h) => t + Math.abs(signedArea(h)), 0);
    near(out.bodies[0].solid.volume(), area * 2, area * 2 * 0.02, 'volume');
  });

  test('text: it moves with the point that places it', () => {
    const contours = textContours('I', { font: 'Arial', height: 10 });
    const sk = newSketch('XY', 'Label');
    sk.points = [{ x: 5, y: 3 }];
    sk.entities = [{ id: 1, type: 'text', p: 0, contours, height: 10, angle: 0 }];
    const before = entityLoops(sk, sk.entities[0])[0][0];
    sk.points[0] = { x: 15, y: 3 };
    const after = entityLoops(sk, sk.entities[0])[0][0];
    near(after.x - before.x, 10, 1e-9, 'carried along X');
    near(after.y - before.y, 0, 1e-9, 'and not along Y');
  });

  test('text: an angle turns the whole run about its placing point', () => {
    const contours = textContours('I', { font: 'Arial', height: 10 });
    const sk = newSketch('XY', 'Label');
    sk.points = [{ x: 0, y: 0 }];
    sk.entities = [{ id: 1, type: 'text', p: 0, contours, height: 10, angle: 90 }];
    const flat = { ...sk.entities[0], angle: 0 };
    const a = entityLoops(sk, flat)[0][0];
    const b = entityLoops(sk, sk.entities[0])[0][0];
    near(b.x, -a.y, 1e-9, 'x becomes minus y');
    near(b.y, a.x, 1e-9, 'y becomes x');
  });

  test('runs: an ordinary curve is one run, text is one per loop', () => {
    const sk = ellipseSketch(6, 3);
    assert(entityRuns(sk, sk.entities[0]).length === 1, 'an ellipse is one run');
    const contours = textContours('O', { font: 'Arial', height: 10 });
    const t = { id: 9, type: 'text', p: 0, contours, height: 10, angle: 0 };
    const sk2 = newSketch('XY', 'T');
    sk2.points = [{ x: 0, y: 0 }];
    sk2.entities = [t];
    assert(entityRuns(sk2, t).length === 2, 'an O is two runs');
  });

  /* -------- batch 2: the Solid tab -------- */

  /** A document holding one feature, for the commands that need no sketch. */
  function docWith(...features) {
    const doc = newDocument();
    doc.features = features;
    return doc;
  }

  test('coil: its volume is the section area times the path length', () => {
    // Pappus: a solid of revolution-like sweep has the volume of its section
    // times the distance the section's centroid travels. For a helix of radius
    // R, pitch p and n turns that distance is n * hypot(2 pi R, p).
    const R = 15;
    const pitch = 6;
    const turns = 4;
    const d = 3;
    const doc = docWith({
      id: uid('f'),
      type: 'coil',
      plane: 'XY',
      coilType: 'revPitch',
      rotation: 'ccw',
      diameter: String(R * 2),
      revolutions: String(turns),
      pitch: String(pitch),
      angle: '0',
      section: 'circular',
      sectionPosition: 'center',
      sectionSize: String(d),
      op: 'new',
      targets: 'all'
    });
    const out = rebuild(doc);
    assert(out.bodies.length === 1, `one body, got ${out.bodies.length}`);
    const area = Math.PI * (d / 2) * (d / 2);
    const path = turns * Math.hypot(2 * Math.PI * R, pitch);
    near(out.bodies[0].solid.volume(), area * path, area * path * 0.03, 'coil volume');
  });

  test('coil: a square section is inscribed in the size given', () => {
    // Fusion measures a section across the circle it is inscribed in, so a
    // square of size 4 is 4 / sqrt(2) across its flats, not 4.
    const R = 15;
    const pitch = 6;
    const turns = 3;
    const size = 4;
    const doc = docWith({
      id: uid('f'),
      type: 'coil',
      plane: 'XY',
      coilType: 'revPitch',
      rotation: 'ccw',
      diameter: String(R * 2),
      revolutions: String(turns),
      pitch: String(pitch),
      angle: '0',
      section: 'square',
      sectionPosition: 'center',
      sectionSize: String(size),
      op: 'new',
      targets: 'all'
    });
    const out = rebuild(doc);
    const side = size * Math.SQRT1_2;
    const path = turns * Math.hypot(2 * Math.PI * R, pitch);
    near(out.bodies[0].solid.volume(), side * side * path, side * side * path * 0.03, 'square coil');
  });

  test('coil: a spiral lies flat and winds outward', () => {
    const doc = docWith({
      id: uid('f'),
      type: 'coil',
      plane: 'XY',
      coilType: 'spiral',
      rotation: 'ccw',
      diameter: '20',
      revolutions: '3',
      pitch: '4',
      section: 'circular',
      sectionPosition: 'center',
      sectionSize: '2',
      op: 'new',
      targets: 'all'
    });
    const out = rebuild(doc);
    const bb = out.bodies[0].solid.boundingBox();
    // Only the section's own diameter in Z, because the spiral does not climb.
    near(bb.max[2] - bb.min[2], 2, 0.05, 'a spiral has no height');
    // It starts at radius 10 and gains 4 per turn over three turns.
    near(bb.max[0], 10 + 3 * 4 + 1, 0.6, 'it winds out to the last turn');
  });

  test('coil: a taper opens it into a cone', () => {
    const straight = docWith({
      id: uid('f'), type: 'coil', plane: 'XY', coilType: 'revPitch', rotation: 'ccw',
      diameter: '20', revolutions: '4', pitch: '5', angle: '0',
      section: 'circular', sectionPosition: 'center', sectionSize: '2',
      op: 'new', targets: 'all'
    });
    const tapered = docWith({
      id: uid('f'), type: 'coil', plane: 'XY', coilType: 'revPitch', rotation: 'ccw',
      diameter: '20', revolutions: '4', pitch: '5', angle: '10',
      section: 'circular', sectionPosition: 'center', sectionSize: '2',
      op: 'new', targets: 'all'
    });
    const a = rebuild(straight).bodies[0].solid.boundingBox();
    const b = rebuild(tapered).bodies[0].solid.boundingBox();
    // Over 20 mm of climb at 10 degrees the radius grows by 20 tan 10.
    near(b.max[0] - a.max[0], 20 * Math.tan((10 * Math.PI) / 180), 0.6, 'taper grows the radius');
  });

  test('emboss: raised text adds the traced area times the depth', () => {
    const plate = rectSketch(60, 30);
    const label = newSketch('XY', 'Label');
    label.points = [{ x: 10, y: 10 }];
    const contours = textContours('AV', { font: 'Arial', height: 8 });
    label.entities = [{ id: 1, type: 'text', p: 0, contours, height: 8, angle: 0 }];
    label.nextEntityId = 2;

    const doc = newDocument();
    doc.sketches[plate.id] = plate;
    doc.sketches[label.id] = label;
    const ef = {
      id: uid('f'), type: 'extrude', sketch: plate.id, seeds: null,
      distance: '5', direction: 'one', op: 'new', targets: 'all'
    };
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: plate.id },
      ef,
      { id: uid('f'), type: 'sketch', sketch: label.id }
    ];
    const base = rebuild(doc);
    const baseVolume = base.bodies[0].solid.volume();
    const topFace = buildTopology(K.meshData(base.bodies[0].solid)).faces.find(
      (f) => f.planar && f.normal[2] > 0.99
    );
    assert(topFace, 'a top face to emboss onto');

    doc.features.push({
      id: uid('f'),
      type: 'emboss',
      sketch: label.id,
      seeds: null,
      faces: [{ bodyId: base.bodies[0].id, face: faceReference(topFace) }],
      effect: 'emboss',
      depth: '1.5',
      alignX: '0',
      alignY: '0',
      alignAngle: '0'
    });
    const out = rebuild(doc);
    assert(out.bodies.length === 1, 'still one body');

    const regions = findRegions(label);
    const area = regions.reduce(
      (t, r) =>
        t +
        Math.abs(signedArea(r.outer)) -
        r.holes.reduce((h, x) => h + Math.abs(signedArea(x)), 0),
      0
    );
    near(out.bodies[0].solid.volume() - baseVolume, area * 1.5, area * 1.5 * 0.05, 'raised volume');
  });

  test('emboss: a deboss takes the same material away', () => {
    const plate = rectSketch(60, 30);
    const label = newSketch('XY', 'Label');
    label.points = [{ x: 20, y: 12 }];
    label.entities = [{ id: 1, type: 'circle', c: 0, r: 5 }];
    label.nextEntityId = 2;

    const doc = newDocument();
    doc.sketches[plate.id] = plate;
    doc.sketches[label.id] = label;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: plate.id },
      { id: uid('f'), type: 'extrude', sketch: plate.id, seeds: null,
        distance: '5', direction: 'one', op: 'new', targets: 'all' },
      { id: uid('f'), type: 'sketch', sketch: label.id }
    ];
    const base = rebuild(doc);
    const topFace = buildTopology(K.meshData(base.bodies[0].solid)).faces.find(
      (f) => f.planar && f.normal[2] > 0.99
    );
    doc.features.push({
      id: uid('f'), type: 'emboss', sketch: label.id, seeds: null,
      faces: [{ bodyId: base.bodies[0].id, face: faceReference(topFace) }],
      effect: 'deboss', depth: '2', alignX: '0', alignY: '0', alignAngle: '0'
    });
    const out = rebuild(doc);
    const pocket = Math.PI * 25 * 2;
    near(out.bodies[0].solid.volume(), 60 * 30 * 5 - pocket, pocket * 0.05, 'debossed volume');
  });

  test('emboss: alignment moves the profile on the face', () => {
    const build = (dx) => {
      const plate = rectSketch(60, 30);
      const mark = newSketch('XY', 'Mark');
      mark.points = [{ x: 10, y: 15 }];
      mark.entities = [{ id: 1, type: 'circle', c: 0, r: 3 }];
      mark.nextEntityId = 2;
      const doc = newDocument();
      doc.sketches[plate.id] = plate;
      doc.sketches[mark.id] = mark;
      doc.features = [
        { id: uid('f'), type: 'sketch', sketch: plate.id },
        { id: uid('f'), type: 'extrude', sketch: plate.id, seeds: null,
          distance: '5', direction: 'one', op: 'new', targets: 'all' },
        { id: uid('f'), type: 'sketch', sketch: mark.id }
      ];
      const base = rebuild(doc);
      const top = buildTopology(K.meshData(base.bodies[0].solid)).faces.find(
        (f) => f.planar && f.normal[2] > 0.99
      );
      doc.features.push({
        id: uid('f'), type: 'emboss', sketch: mark.id, seeds: null,
        faces: [{ bodyId: base.bodies[0].id, face: faceReference(top) }],
        effect: 'deboss', depth: '2',
        alignX: String(dx), alignY: '0', alignAngle: '0'
      });
      return rebuild(doc);
    };
    // The same pocket either way, so only its position changed.
    near(build(0).bodies[0].solid.volume(), build(12).bodies[0].solid.volume(), 1, 'same volume');
  });

  test('web: walls are thickness by length by depth, joined where they cross', () => {
    // A cross of two lines, so the walls share material where they meet.
    const plate = rectSketch(40, 40);
    const wall = newSketch({ base: 'XY', offset: '4' }, 'Walls');
    wall.points = [
      { x: 4, y: 20 }, { x: 36, y: 20 },
      { x: 20, y: 4 }, { x: 20, y: 36 }
    ];
    wall.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [2, 3] }
    ];
    wall.nextEntityId = 3;

    const doc = newDocument();
    doc.sketches[plate.id] = plate;
    doc.sketches[wall.id] = wall;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: plate.id },
      { id: uid('f'), type: 'extrude', sketch: plate.id, seeds: null,
        distance: '4', direction: 'one', op: 'new', targets: 'all' },
      { id: uid('f'), type: 'sketch', sketch: wall.id },
      { id: uid('f'), type: 'web', sketch: wall.id, thickness: '2',
        extentType: 'depth', depth: '6', flip: false, draftAngle: '0',
        extendCurves: false, op: 'join', bodies: 'all', targets: 'all' }
    ];
    const out = rebuild(doc);
    assert(out.bodies.length === 1, 'joined into one body');

    // Two 32 by 2 walls 6 deep, less the 2 by 2 column they share, plus the
    // rounded ends the thickener puts on each run.
    const plateV = 40 * 40 * 4;
    const walls = 2 * 32 * 2 * 6 - 2 * 2 * 6;
    const caps = 4 * (Math.PI * 1 * 1 / 2) * 6;
    near(out.bodies[0].solid.volume(), plateV + walls + caps, walls * 0.06, 'web volume');
  });

  test('web: extending the curves reaches further than not', () => {
    const make = (extend) => {
      const wall = newSketch('XY', 'Walls');
      wall.points = [{ x: -10, y: 0 }, { x: 10, y: 0 }];
      wall.entities = [{ id: 1, type: 'line', p: [0, 1] }];
      wall.nextEntityId = 2;
      const doc = newDocument();
      doc.sketches[wall.id] = wall;
      doc.features = [
        { id: uid('f'), type: 'sketch', sketch: wall.id },
        { id: uid('f'), type: 'web', sketch: wall.id, thickness: '2',
          extentType: 'depth', depth: '5', flip: false, draftAngle: '0',
          extendCurves: extend, op: 'new', bodies: 'all', targets: 'all' }
      ];
      return rebuild(doc).bodies[0].solid.boundingBox();
    };
    const plain = make(false);
    const longer = make(true);
    assert(
      longer.max[0] > plain.max[0] + 10,
      `extended should reach further, got ${longer.max[0]} vs ${plain.max[0]}`
    );
  });

  test('align: a face lands flat on the face it was pointed at', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '20', depth: '20', height: '20', centered: false, x: '0', y: '0', z: '0' }),
      prim('box', { width: '10', depth: '10', height: '10', centered: false, x: '60', y: '0', z: '0' })
    ];
    doc.features[1].op = 'new';
    const before = rebuild(doc);
    assert(before.bodies.length === 2, 'two bodies to start');

    const topoA = buildTopology(K.meshData(before.bodies[0].solid));
    const topoB = buildTopology(K.meshData(before.bodies[1].solid));
    const topOfA = topoA.faces.find((f) => f.planar && f.normal[2] > 0.99);
    const bottomOfB = topoB.faces.find((f) => f.planar && f.normal[2] < -0.99);

    doc.features.push({
      id: uid('f'),
      type: 'align',
      bodies: [before.bodies[1].id],
      from: { bodyId: before.bodies[1].id, face: faceReference(bottomOfB) },
      to: { bodyId: before.bodies[0].id, face: faceReference(topOfA) },
      flip: false,
      angle: '0'
    });
    const out = rebuild(doc);
    const moved = out.bodies.find((b) => b.id === before.bodies[1].id);
    const bb = moved.solid.boundingBox();
    // Its underside now sits on the top of the first box, and its centre is
    // over that face's centre.
    near(bb.min[2], 20, 1e-3, 'sitting on the top face');
    near((bb.min[0] + bb.max[0]) / 2, 10, 1e-3, 'centred over it in X');
    near((bb.min[1] + bb.max[1]) / 2, 10, 1e-3, 'centred over it in Y');
    near(moved.solid.volume(), 1000, 1e-3, 'align moves, it does not resize');
  });

  test('delete face: a through bore is filled back in', () => {
    const doc = newDocument();
    const plate = rectSketch(40, 40);
    const hole = newSketch('XY', 'Hole');
    hole.points = [{ x: 20, y: 20 }];
    hole.entities = [{ id: 1, type: 'circle', c: 0, r: 6 }];
    hole.nextEntityId = 2;
    doc.sketches[plate.id] = plate;
    doc.sketches[hole.id] = hole;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: plate.id },
      { id: uid('f'), type: 'extrude', sketch: plate.id, seeds: null,
        distance: '10', direction: 'one', op: 'new', targets: 'all' },
      { id: uid('f'), type: 'sketch', sketch: hole.id },
      { id: uid('f'), type: 'extrude', sketch: hole.id, seeds: null,
        distance: '10', direction: 'one', op: 'cut', targets: 'all' }
    ];
    const drilled = rebuild(doc);
    assert(drilled.bodies[0].solid.genus() === 1, 'drilled first');

    const bore = buildTopology(K.meshData(drilled.bodies[0].solid)).faces.find(
      (f) => f.cylinder
    );
    assert(bore, 'found the bore');

    doc.features.push({
      id: uid('f'),
      type: 'deleteFace',
      faces: [{ bodyId: drilled.bodies[0].id, face: faceReference(bore) }]
    });
    const out = rebuild(doc);
    assert(out.bodies[0].solid.genus() === 0, `hole gone, genus ${out.bodies[0].solid.genus()}`);
    near(out.bodies[0].solid.volume(), 40 * 40 * 10, 1, 'back to a solid plate');
  });

  test('silhouette split: a cylinder parts at its widest line', () => {
    const doc = newDocument();
    doc.features = [
      prim('sphere', { diameter: '30', centered: true, x: '0', y: '0', z: '0' })
    ];
    const before = rebuild(doc);
    const whole = before.bodies[0].solid.volume();

    doc.features.push({
      id: uid('f'),
      type: 'silhouetteSplit',
      direction: { plane: 'XY' },
      bodies: 'all'
    });
    const out = rebuild(doc);
    assert(out.bodies.length === 2, `two halves, got ${out.bodies.length}`);
    // The silhouette of a sphere seen down Z is its equator, so the halves are
    // equal and together they are the whole.
    const vols = out.bodies.map((b) => b.solid.volume()).sort((a, b) => a - b);
    near(vols[0] + vols[1], whole, whole * 0.01, 'the halves make the whole');
    near(vols[0], vols[1], whole * 0.02, 'and they are equal');
  });

  test('silhouette split: a bumpy silhouette is refused, not guessed at', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '20', depth: '20', height: '20', centered: true, x: '0', y: '0', z: '0' })
    ];
    doc.features.push({
      id: uid('f'),
      type: 'silhouetteSplit',
      direction: { plane: 'YZ' },
      bodies: 'all'
    });
    const out = rebuild(doc);
    // A box seen down X has no single flat parting line, so it says so rather
    // than cutting somewhere arbitrary.
    assert(out.bodies.length === 1, `left alone, got ${out.bodies.length} bodies`);
    assert(out.errors.length > 0, 'and reported why');
  });

  test('references: a cylindrical face can be matched back at all', () => {
    // A bore's facet normals point every way round and average to nothing, so
    // a reference that stores only a normal can never align with anything. It
    // silently lost every reference to a round face until the axis and the
    // radius were written down instead.
    const doc = newDocument();
    const plate = rectSketch(40, 40);
    const hole = newSketch('XY', 'Hole');
    hole.points = [{ x: 20, y: 20 }];
    hole.entities = [{ id: 1, type: 'circle', c: 0, r: 6 }];
    hole.nextEntityId = 2;
    doc.sketches[plate.id] = plate;
    doc.sketches[hole.id] = hole;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: plate.id },
      { id: uid('f'), type: 'extrude', sketch: plate.id, seeds: null,
        distance: '10', direction: 'one', op: 'new', targets: 'all' },
      { id: uid('f'), type: 'sketch', sketch: hole.id },
      { id: uid('f'), type: 'extrude', sketch: hole.id, seeds: null,
        distance: '10', direction: 'one', op: 'cut', targets: 'all' }
    ];
    const out = rebuild(doc);
    const topo = buildTopology(K.meshData(out.bodies[0].solid));
    const bore = topo.faces.find((f) => f.cylinder);
    assert(bore, 'a bore to reference');

    const ref = faceReference(bore);
    assert(ref.axis, 'the reference carries an axis');
    near(ref.radius, 6, 0.05, 'and the radius');

    const [found] = resolveFaceRefs(topo, [ref]);
    assert(found, 'and it matches back');
    assert(found.id === bore.id, `matched the same face, got ${found?.id} not ${bore.id}`);
  });

  test('references: a bore still matches after the plate gets thicker', () => {
    const build = (thickness) => {
      const doc = newDocument();
      const plate = rectSketch(40, 40);
      const hole = newSketch('XY', 'Hole');
      hole.points = [{ x: 20, y: 20 }];
      hole.entities = [{ id: 1, type: 'circle', c: 0, r: 6 }];
      hole.nextEntityId = 2;
      doc.sketches[plate.id] = plate;
      doc.sketches[hole.id] = hole;
      doc.features = [
        { id: uid('f'), type: 'sketch', sketch: plate.id },
        { id: uid('f'), type: 'extrude', sketch: plate.id, seeds: null,
          distance: String(thickness), direction: 'one', op: 'new', targets: 'all' },
        { id: uid('f'), type: 'sketch', sketch: hole.id },
        { id: uid('f'), type: 'extrude', sketch: hole.id, seeds: null,
          distance: String(thickness), direction: 'one', op: 'cut', targets: 'all' }
      ];
      return buildTopology(K.meshData(rebuild(doc).bodies[0].solid));
    };
    const thin = build(10);
    const ref = faceReference(thin.faces.find((f) => f.cylinder));
    // The dimension change is the case a reference has to survive, so this is
    // the one worth testing rather than matching a shape against itself.
    const [found] = resolveFaceRefs(build(25), [ref]);
    assert(found && found.cylinder, 'the bore is still found in a thicker plate');
    near(found.cylinder.radius, 6, 0.05, 'and it is the same bore');
  });

  /* -------- batch 3: the rest of the Sketch tab, and Insert -------- */

  test('conic: rho of a half is the parabola through the same three points', () => {
    const sk = newSketch('XY', 'Conic');
    sk.points = [
      { x: -10, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 }
    ];
    sk.entities = [{ id: 1, type: 'conic', p: [0, 1], v: 2, rho: 0.5 }];
    sk.nextEntityId = 2;

    const pts = tessellate(sk, sk.entities[0]);
    // The vertex is where the end tangents meet, so at rho a half the curve
    // passes exactly halfway to it: y = 5 at the middle, not 10.
    const mid = pts[Math.floor(pts.length / 2)];
    near(mid.x, 0, 1e-6, 'symmetric about the middle');
    near(mid.y, 5, 1e-6, 'halfway to the vertex');

    // And it really is a parabola: y = 5(1 - (x/10)^2).
    for (const q of pts) {
      near(q.y, 5 * (1 - (q.x / 10) ** 2), 1e-6, `parabola at x=${q.x.toFixed(2)}`);
    }
  });

  test('conic: rho below a half is flatter, above it is fuller', () => {
    const make = (rho) => {
      const sk = newSketch('XY', 'Conic');
      sk.points = [{ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
      sk.entities = [{ id: 1, type: 'conic', p: [0, 1], v: 2, rho }];
      const pts = tessellate(sk, sk.entities[0]);
      return pts[Math.floor(pts.length / 2)].y;
    };
    near(make(0.25), 2.5, 1e-6, 'an ellipse sits a quarter of the way up');
    near(make(0.5), 5, 1e-6, 'a parabola halfway');
    near(make(0.75), 7.5, 1e-6, 'a hyperbola three quarters');
  });

  test('control point spline: it is pinned at its ends and pulled between them', () => {
    const sk = newSketch('XY', 'CP');
    sk.points = [
      { x: 0, y: 0 },
      { x: 10, y: 20 },
      { x: 20, y: -20 },
      { x: 30, y: 0 }
    ];
    sk.entities = [{ id: 1, type: 'bspline', p: [0, 1, 2, 3] }];
    sk.nextEntityId = 2;

    const pts = tessellate(sk, sk.entities[0]);
    near(pts[0].x, 0, 1e-6, 'starts on the first control point');
    near(pts[0].y, 0, 1e-6, 'starts on the first control point');
    near(pts[pts.length - 1].x, 30, 1e-6, 'ends on the last');
    near(pts[pts.length - 1].y, 0, 1e-6, 'ends on the last');

    // Pulled towards the middle control points, never reaching them, which is
    // the whole difference from the fit point spline.
    const highest = Math.max(...pts.map((q) => q.y));
    assert(highest > 0.5, `should bulge upward, peaked at ${highest.toFixed(2)}`);
    assert(highest < 20, `must not reach its control point, got ${highest.toFixed(2)}`);
  });

  test('circumscribed polygon: the flats land on the size asked for', () => {
    const sk = newSketch('XY', 'Hex');
    // Across the flats is what a spanner and a nut pocket are measured by.
    const n = 6;
    const acrossFlats = 13;
    const rFlat = acrossFlats / 2;
    const rCorner = rFlat / Math.cos(Math.PI / n);
    sk.points = [];
    const idx = [];
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.PI / n;
      sk.points.push({ x: rCorner * Math.cos(a), y: rCorner * Math.sin(a) });
      idx.push(i);
    }
    sk.entities = [];
    for (let i = 0; i < n; i++) {
      sk.entities.push({ id: i + 1, type: 'line', p: [idx[i], idx[(i + 1) % n]] });
    }
    sk.nextEntityId = n + 1;

    const regions = findRegions(sk);
    assert(regions.length === 1, 'one region');
    // Area of a regular polygon from its apothem.
    near(
      Math.abs(signedArea(regions[0].outer)),
      n * rFlat * rFlat * Math.tan(Math.PI / n),
      1e-6,
      'area from the apothem'
    );
  });

  test('svg: a rectangle comes in at its stated size', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">' +
      '<rect x="5" y="5" width="30" height="10"/></svg>';
    const out = parseSVG(svg);
    assert(out.entities.length === 4, `four sides, got ${out.entities.length}`);
    near(out.width, 40, 1e-6, 'document width');
    const xs = out.entities.flatMap((e) => e.points.map((p) => p.x));
    const ys = out.entities.flatMap((e) => e.points.map((p) => p.y));
    near(Math.min(...xs), 5, 1e-6, 'left edge');
    near(Math.max(...xs), 35, 1e-6, 'right edge');
    // Y is flipped on the way in, so the rect that sat 5 below the top of a
    // 20 tall document sits 5 above the bottom.
    near(Math.min(...ys), 5, 1e-6, 'bottom edge');
    near(Math.max(...ys), 15, 1e-6, 'top edge');
  });

  test('svg: pixels are turned into millimetres', () => {
    // 96 user units wide declared as one inch, so a 96 unit line is 25.4 mm.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1in" height="1in" viewBox="0 0 96 96">' +
      '<line x1="0" y1="0" x2="96" y2="0"/></svg>';
    const out = parseSVG(svg);
    const [a, b] = out.entities[0].points;
    near(Math.abs(b.x - a.x), 25.4, 1e-4, 'an inch of user units is an inch');
  });

  test('svg: a nested transform is carried down to the shape', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<g transform="translate(10,0)"><g transform="translate(0,20)">' +
      '<line x1="0" y1="0" x2="0" y2="0"/></g></g></svg>';
    const out = parseSVG(svg);
    const p = out.entities[0].points[0];
    near(p.x, 10, 1e-6, 'both translations applied in x');
    near(p.y, 100 - 20, 1e-6, 'and in y, after the flip');
  });

  test('svg: a circle keeps its kind, a path does not', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<circle cx="50" cy="50" r="20"/>' +
      '<path d="M 10 10 C 20 0 30 20 40 10"/></svg>';
    const out = parseSVG(svg);
    const circle = out.entities.find((e) => e.kind === 'circle');
    assert(circle, 'the circle stayed a circle');
    near(circle.r, 20, 1e-6, 'with its radius');
    const poly = out.entities.find((e) => e.kind === 'poly');
    assert(poly && poly.points.length > 4, 'the bezier came in as a polyline');
  });

  test('svg: a closed path closes', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<path d="M 10 10 L 30 10 L 30 30 Z"/></svg>';
    const out = parseSVG(svg);
    const poly = out.entities.find((e) => e.kind === 'poly');
    assert(poly?.closed, 'the Z made it closed');
    assert(poly.points.length === 3, `three corners, got ${poly.points.length}`);
  });

  test('dxf: lines, circles and arcs come through with their kinds', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '10', '0', '20', '0', '11', '10', '21', '0',
      '0', 'CIRCLE', '10', '5', '20', '5', '40', '3',
      '0', 'ARC', '10', '0', '20', '0', '40', '7', '50', '0', '51', '90',
      '0', 'ENDSEC', '0', 'EOF'
    ].join('\n');
    const out = parseDXF(dxf);
    assert(out.entities.length === 3, `three entities, got ${out.entities.length}`);
    const line = out.entities.find((e) => e.kind === 'line');
    near(line.points[1].x, 10, 1e-9, 'line runs to x = 10');
    const circle = out.entities.find((e) => e.kind === 'circle');
    near(circle.r, 3, 1e-9, 'circle radius');
    const arc = out.entities.find((e) => e.kind === 'arc');
    near(arc.end, Math.PI / 2, 1e-9, 'arc end angle in radians');
    // DXF already counts Y upwards, so nothing is flipped.
    near(circle.centre.y, 5, 1e-9, 'y is left alone');
  });

  test('dxf: a closed polyline keeps every vertex and its closed flag', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LWPOLYLINE', '70', '1',
      '10', '0', '20', '0',
      '10', '10', '20', '0',
      '10', '10', '20', '5',
      '0', 'ENDSEC', '0', 'EOF'
    ].join('\n');
    const out = parseDXF(dxf);
    const poly = out.entities[0];
    assert(poly.kind === 'poly', 'a polyline');
    assert(poly.closed, 'flagged closed');
    assert(poly.points.length === 3, `three vertices, got ${poly.points.length}`);
    near(poly.points[2].y, 5, 1e-9, 'the last vertex kept its y');
  });

  test('import: traced geometry closes a region and extrudes', () => {
    // The whole point of importing: it has to become a solid.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">' +
      '<rect x="0" y="0" width="40" height="20"/></svg>';
    const parsed = parseSVG(svg);
    const sk = newSketch('XY', 'Traced');
    sk.points = [];
    sk.entities = [];
    let next = 1;
    for (const e of parsed.entities) {
      const a = sk.points.push({ x: e.points[0].x, y: e.points[0].y }) - 1;
      const b = sk.points.push({ x: e.points[1].x, y: e.points[1].y }) - 1;
      sk.entities.push({ id: next++, type: 'line', p: [a, b] });
    }
    sk.nextEntityId = next;

    const doc = newDocument();
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: uid('f'), type: 'extrude', sketch: sk.id, seeds: null,
        distance: '3', direction: 'one', op: 'new', targets: 'all' }
    ];
    const out = rebuild(doc);
    assert(out.bodies.length === 1, 'one body from the traced outline');
    near(out.bodies[0].solid.volume(), 40 * 20 * 3, 1, 'and it is the size the file said');
  });

  test('slot: a stadium is the rectangle plus a full circle of caps', () => {
    // A slot whose caps bulge outward has area L*2r + pi r^2. If the end arcs
    // are wound the wrong way the caps bite inward instead and the area comes
    // out L*2r - pi r^2, which is the same shape to the eye at a glance and
    // wrong by two round ends.
    const L = 20;
    const r = 4;
    const sk = newSketch('XY', 'Slot');
    sk.points = [
      { x: 0, y: 0 },
      { x: L, y: 0 },
      { x: 0, y: r },
      { x: 0, y: -r },
      { x: L, y: r },
      { x: L, y: -r }
    ];
    // Laid out exactly as buildSlot does: two flanks and an arc at each end.
    sk.entities = [
      { id: 1, type: 'line', p: [2, 4] },
      { id: 2, type: 'line', p: [5, 3] },
      { id: 3, type: 'arc', c: 1, p: [4, 5], ccw: false },
      { id: 4, type: 'arc', c: 0, p: [3, 2], ccw: false }
    ];
    sk.nextEntityId = 5;

    const regions = findRegions(sk);
    assert(regions.length === 1, `one region, got ${regions.length}`);
    const area = Math.abs(signedArea(regions[0].outer));
    const want = L * 2 * r + Math.PI * r * r;
    near(area, want, want * 0.01, 'stadium area');
  });

  test('slot: an arc slot is a sector plus a round cap at each end', () => {
    const R = 12;
    const half = 3;
    const sweep = Math.PI / 2;
    const sk = newSketch('XY', 'ArcSlot');
    const at = (rad, ang) => ({ x: rad * Math.cos(ang), y: rad * Math.sin(ang) });
    sk.points = [
      { x: 0, y: 0 },
      at(R, 0),
      at(R, sweep),
      at(R - half, 0),
      at(R + half, 0),
      at(R - half, sweep),
      at(R + half, sweep)
    ];
    sk.entities = [
      { id: 1, type: 'arc', c: 0, p: [3, 5], ccw: true },
      { id: 2, type: 'arc', c: 0, p: [6, 4], ccw: false },
      { id: 3, type: 'arc', c: 2, p: [5, 6], ccw: false },
      { id: 4, type: 'arc', c: 1, p: [4, 3], ccw: false }
    ];
    sk.nextEntityId = 5;

    const regions = findRegions(sk);
    assert(regions.length === 1, `one region, got ${regions.length}`);
    const want = 2 * sweep * R * half + Math.PI * half * half;
    near(Math.abs(signedArea(regions[0].outer)), want, want * 0.01, 'arc slot area');
  });

  /* -------- project and intersect -------- */

  /** A document with one primitive and a sketch that sections it. */
  function sectionDoc(shape, params, plane = 'XY') {
    const doc = newDocument();
    const sk = newSketch(plane, 'Section');
    sk.points = [];
    sk.entities = [];
    sk.nextEntityId = 1;
    doc.sketches[sk.id] = sk;
    doc.features = [
      {
        id: uid('f'),
        type: 'primitive',
        shape,
        op: 'new',
        targets: 'all',
        params: {
          width: '20', depth: '20', height: '20',
          diameter: '20', topDiameter: '0', tubeDiameter: '5', wall: '2',
          centered: true, x: '0', y: '0', z: '0',
          ...params
        }
      },
      { id: uid('f'), type: 'sketch', sketch: sk.id }
    ];
    // The body's id is only known once it has been built once.
    const first = rebuild(doc);
    sk.intersections = [{ bodyId: first.bodies[0].id }];
    return { doc, sk };
  }

  test('intersect: a box sectioned through its middle is its cross section', () => {
    const { doc, sk } = sectionDoc('box', { width: '60', depth: '30', height: '20' });
    const res = rebuild(doc);
    const derived = res.sketchProjections[sk.id];
    assert(derived, 'the section produced geometry');

    const regions = findRegions(materializeSketch(sk, derived));
    assert(regions.length === 1, `one region, got ${regions.length}`);
    near(Math.abs(signedArea(regions[0].outer)), 60 * 30, 1e-6, 'the cross section');
  });

  test('intersect: a cylinder sections to a circle of its own radius', () => {
    const { doc, sk } = sectionDoc('cylinder', { diameter: '24', height: '30' });
    const res = rebuild(doc);
    const derived = res.sketchProjections[sk.id];
    const regions = findRegions(materializeSketch(sk, derived));
    assert(regions.length === 1, `one region, got ${regions.length}`);
    const want = Math.PI * 12 * 12;
    // Faceted, so a little under the true circle.
    near(Math.abs(signedArea(regions[0].outer)), want, want * 0.01, 'the circle');
  });

  test('intersect: the section follows the model rather than remembering it', () => {
    const { doc, sk } = sectionDoc('box', { width: '40', depth: '30', height: '20' });
    const before = findRegions(materializeSketch(sk, rebuild(doc).sketchProjections[sk.id]));
    near(Math.abs(signedArea(before[0].outer)), 40 * 30, 1e-6, 'as first built');

    // The whole reason to take a section rather than to draw one.
    doc.features[0].params.width = '90';
    const after = findRegions(materializeSketch(sk, rebuild(doc).sketchProjections[sk.id]));
    near(Math.abs(signedArea(after[0].outer)), 90 * 30, 1e-6, 'after the box grew');
  });

  test('intersect: a body that misses the plane says so rather than pretending', () => {
    const { doc, sk } = sectionDoc('box', {
      width: '20', depth: '20', height: '10', centered: false, z: '40'
    });
    const res = rebuild(doc);
    assert(!res.sketchProjections[sk.id], 'no geometry from a body it does not reach');
    assert(res.errors.length > 0, 'and it is reported');
  });

  test('project: a linked edge is flattened onto the sketch plane every rebuild', () => {
    const doc = newDocument();
    const sk = newSketch('XY', 'Proj');
    sk.points = [];
    sk.entities = [];
    sk.nextEntityId = 1;
    doc.sketches[sk.id] = sk;
    doc.features = [
      {
        id: uid('f'),
        type: 'primitive',
        shape: 'box',
        op: 'new',
        targets: 'all',
        params: {
          width: '40', depth: '30', height: '20', diameter: '20', topDiameter: '0',
          centered: true, x: '0', y: '0', z: '0'
        }
      },
      { id: uid('f'), type: 'sketch', sketch: sk.id }
    ];
    const first = rebuild(doc);
    const topo = buildTopology(K.meshData(first.bodies[0].solid));
    // The four edges around the top face, which flatten to the box's outline.
    const top = topo.faces.find((f) => f.planar && f.normal[2] > 0.99);
    sk.projections = topo.edges
      .filter((e) => e.faceA === top.id || e.faceB === top.id)
      .map(edgeReference);
    assert(sk.projections.length === 4, `four edges, got ${sk.projections.length}`);

    const span = (res) => {
      const d = res.sketchProjections[sk.id];
      const xs = d.points.map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    near(span(rebuild(doc)), 40, 1e-6, 'as first projected');

    doc.features[0].params.width = '70';
    near(span(rebuild(doc)), 70, 1e-6, 'and again after the box changed');
  });

  /* -------- batch 4: construct and inspect -------- */

  test('mass: an off centre box balances at its own middle', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', {
        width: '20', depth: '10', height: '4',
        centered: false, x: '30', y: '5', z: '2'
      })
    ];
    const out = rebuild(doc);
    const mesh = K.meshData(out.bodies[0].solid);
    const { volume, centroid } = massProperties(mesh);
    near(volume, 20 * 10 * 4, 1e-6, 'volume from the tetrahedra');
    near(centroid[0], 40, 1e-6, 'centre in x');
    near(centroid[1], 10, 1e-6, 'centre in y');
    near(centroid[2], 4, 1e-6, 'centre in z');
  });

  test('mass: a hollow shape balances where the material is, not the box', () => {
    // A plate with a hole off to one side: the centre of mass shifts away from
    // the hole, which a bounding box would never show.
    const doc = newDocument();
    const plate = rectSketch(40, 20);
    const hole = newSketch('XY', 'Hole');
    hole.points = [{ x: 8, y: 10 }];
    hole.entities = [{ id: 1, type: 'circle', c: 0, r: 5 }];
    hole.nextEntityId = 2;
    doc.sketches[plate.id] = plate;
    doc.sketches[hole.id] = hole;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: plate.id },
      { id: uid('f'), type: 'extrude', sketch: plate.id, seeds: null,
        distance: '5', direction: 'one', op: 'new', targets: 'all' },
      { id: uid('f'), type: 'sketch', sketch: hole.id },
      { id: uid('f'), type: 'extrude', sketch: hole.id, seeds: null,
        distance: '5', direction: 'one', op: 'cut', targets: 'all' }
    ];
    const out = rebuild(doc);
    const { volume, centroid } = massProperties(K.meshData(out.bodies[0].solid));

    // Solved by hand: a 40 by 20 plate centred at x = 20, less a circle of
    // radius 5 centred at x = 8.
    const plateArea = 40 * 20;
    const holeArea = Math.PI * 25;
    const wantX = (plateArea * 20 - holeArea * 8) / (plateArea - holeArea);
    near(volume, (plateArea - holeArea) * 5, volume * 0.01, 'volume less the hole');
    near(centroid[0], wantX, 0.05, 'pulled away from the hole');
    near(centroid[1], 10, 0.02, 'still centred across');
  });

  test('mass: density turns a volume into grams', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '100', depth: '100', height: '100', centered: true })
    ];
    const out = rebuild(doc);
    const mesh = K.meshData(out.bodies[0].solid);
    // A litre of PLA: a million cubic millimetres is a thousand cc.
    const props = combinedMass([{ id: 'b', name: 'Body', mesh, material: 'pla' }]);
    near(props.mass, 1000 * densityOf('pla'), 0.5, 'grams of PLA');

    const steel = combinedMass([{ id: 'b', name: 'Body', mesh, material: 'steel' }]);
    assert(steel.mass > props.mass * 6, 'steel is a great deal heavier');
  });

  test('mass: two bodies balance towards the heavier one', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '10', depth: '10', height: '10', centered: true, x: '0' }),
      { ...prim('box', { width: '10', depth: '10', height: '10', centered: true }), op: 'new' }
    ];
    doc.features[1].params.x = '100';
    const out = rebuild(doc);
    assert(out.bodies.length === 2, 'two bodies');

    const meshes = out.bodies.map((b) => K.meshData(b.solid));
    const same = combinedMass([
      { id: 'a', name: 'A', mesh: meshes[0], material: 'pla' },
      { id: 'b', name: 'B', mesh: meshes[1], material: 'pla' }
    ]);
    near(same.centre[0], 50, 0.05, 'equal materials balance in the middle');

    const mixed = combinedMass([
      { id: 'a', name: 'A', mesh: meshes[0], material: 'pla' },
      { id: 'b', name: 'B', mesh: meshes[1], material: 'steel' }
    ]);
    // Weighted by mass, not by volume.
    const wantX =
      (0 * densityOf('pla') + 100 * densityOf('steel')) / (densityOf('pla') + densityOf('steel'));
    near(mixed.centre[0], wantX, 0.2, 'the steel one pulls it over');
  });

  test('interference: overlapping boxes report the shared volume', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '20', depth: '20', height: '20', centered: false, x: '0', y: '0', z: '0' }),
      { ...prim('box', { width: '20', depth: '20', height: '20', centered: false }), op: 'new' }
    ];
    Object.assign(doc.features[1].params, { x: '15', y: '0', z: '0' });
    const out = rebuild(doc);
    assert(out.bodies.length === 2, 'two bodies');

    const scope = new K.Scope();
    const hits = interferences(out.bodies, scope);
    scope.dispose();
    assert(hits.length === 1, `one overlap, got ${hits.length}`);
    // They share a 5 by 20 by 20 slab.
    near(hits[0].volume, 5 * 20 * 20, 1, 'the shared slab');
  });

  test('interference: bodies that only touch are not an overlap', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '20', depth: '20', height: '20', centered: false, x: '0', y: '0', z: '0' }),
      { ...prim('box', { width: '20', depth: '20', height: '20', centered: false }), op: 'new' }
    ];
    Object.assign(doc.features[1].params, { x: '20', y: '0', z: '0' });
    const out = rebuild(doc);
    const scope = new K.Scope();
    const hits = interferences(out.bodies, scope);
    scope.dispose();
    assert(hits.length === 0, `face to face contact is not interference, got ${hits.length}`);
  });

  test('section: the cut is a real solid, capped, not a hidden half', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '20', depth: '20', height: '20', centered: true })
    ];
    const out = rebuild(doc);
    const scope = new K.Scope();
    // Keep the half below z = 0, so the normal points at what goes.
    const mesh = sectionedMesh(out.bodies[0].solid, { origin: [0, 0, 0], n: [0, 0, 1] }, scope);
    assert(mesh, 'the cut produced geometry');

    const { volume } = massProperties(mesh);
    // Half the box, and closed: an unclosed shell has no enclosed volume worth
    // the name, so measuring it is what proves the cut was capped.
    near(volume, 20 * 20 * 20 / 2, 1, 'half the box, closed');
    scope.dispose();
  });

  test('section: the model itself is untouched by taking one', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '20', depth: '20', height: '20', centered: true })];
    const out = rebuild(doc);
    const before = out.bodies[0].solid.volume();
    const scope = new K.Scope();
    sectionedMesh(out.bodies[0].solid, { origin: [0, 0, 0], n: [0, 0, 1] }, scope);
    scope.dispose();
    near(out.bodies[0].solid.volume(), before, 1e-9, 'the body is the same afterwards');
  });

  test('draft: faces are coloured by which way they lie against the pull', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '20', depth: '20', height: '20', centered: true })
    ];
    const out = rebuild(doc);
    const mesh = K.meshData(out.bodies[0].solid);
    const colours = draftColours(mesh, [0, 0, 1], 3);
    assert(colours.length === mesh.vertProperties.length, 'a colour per vertex');

    // A box pulled up the Z axis: the top draws out, the bottom is undercut,
    // and the four sides are vertical, so one of each must appear.
    const seen = new Set();
    for (let i = 0; i < colours.length; i += 3) {
      seen.add(`${colours[i].toFixed(2)},${colours[i + 1].toFixed(2)}`);
    }
    assert(seen.size === 3, `three readings on a box, got ${seen.size}`);
  });

  test('construct: a point along a path lands at that fraction of its length', () => {
    const doc = newDocument();
    const sk = newSketch('XY', 'Path');
    sk.points = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    sk.entities = [{ id: 1, type: 'line', p: [0, 1] }];
    sk.nextEntityId = 2;
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      {
        id: uid('f'),
        type: 'construction',
        entry: {
          id: 'cx1',
          type: 'pointAlongPath',
          path: { sketch: sk.id },
          t: '0.25'
        }
      }
    ];
    const out = rebuild(doc);
    const built = out.construction?.get('cx1');
    assert(built && built.kind === 'point', 'a point was built');
    near(built.p[0], 25, 1e-6, 'a quarter of the way along');
    near(built.p[1], 0, 1e-6, 'and on the line');
  });

  test('construct: a plane along a path stands square to it', () => {
    const doc = newDocument();
    const sk = newSketch('XY', 'Path');
    sk.points = [{ x: 0, y: 0 }, { x: 0, y: 60 }];
    sk.entities = [{ id: 1, type: 'line', p: [0, 1] }];
    sk.nextEntityId = 2;
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      {
        id: uid('f'),
        type: 'construction',
        entry: { id: 'cx1', type: 'planeAlongPath', path: { sketch: sk.id }, t: '0.5' }
      }
    ];
    const out = rebuild(doc);
    const built = out.construction?.get('cx1');
    assert(built && built.kind === 'plane', 'a plane was built');
    near(built.origin[1], 30, 1e-6, 'half way up');
    // The path runs along Y, so the plane faces along Y.
    near(Math.abs(built.n[1]), 1, 1e-6, 'square to the path');
  });

  test('construct: three planes meet at one point', () => {
    const doc = newDocument();
    doc.features = [
      {
        id: uid('f'),
        type: 'construction',
        entry: { id: 'a', type: 'planeOffset', base: 'YZ', distance: '7' }
      },
      {
        id: uid('f'),
        type: 'construction',
        entry: { id: 'b', type: 'planeOffset', base: 'XZ', distance: '11' }
      },
      {
        id: uid('f'),
        type: 'construction',
        entry: { id: 'c', type: 'planeOffset', base: 'XY', distance: '13' }
      },
      {
        id: uid('f'),
        type: 'construction',
        entry: {
          id: 'p',
          type: 'pointThreePlanes',
          planeA: 'c:a',
          planeB: 'c:b',
          planeC: 'c:c'
        }
      }
    ];
    const out = rebuild(doc);
    const built = out.construction?.get('p');
    assert(built && built.kind === 'point', 'a point was built');
    near(built.p[0], 7, 1e-6, 'x from the first');
    // XZ's normal is minus Y, which is the ordinary convention because X
    // crossed with Z points that way. Offsetting along it goes negative.
    near(built.p[1], -11, 1e-6, 'y from the second');
    near(built.p[2], 13, 1e-6, 'z from the third');
  });

  test('construct: three planes through one line have no single point', () => {
    const doc = newDocument();
    doc.features = [
      {
        id: uid('f'),
        type: 'construction',
        entry: { id: 'a', type: 'planeOffset', base: 'XY', distance: '0' }
      },
      {
        id: uid('f'),
        type: 'construction',
        entry: { id: 'b', type: 'planeOffset', base: 'XY', distance: '10' }
      },
      {
        id: uid('f'),
        type: 'construction',
        entry: { id: 'c', type: 'planeOffset', base: 'XZ', distance: '0' }
      },
      {
        id: uid('f'),
        type: 'construction',
        entry: { id: 'p', type: 'pointThreePlanes', planeA: 'c:a', planeB: 'c:b', planeC: 'c:c' }
      }
    ];
    const out = rebuild(doc);
    assert(!out.construction?.get('p'), 'two parallel planes give no point');
    assert(out.errors.length > 0, 'and it is reported');
  });

  /* -------- batch 5: assembly -------- */

  /** Where a component's own origin ends up once the assembly is solved. */
  function placeOf(out, id) {
    const m = out.transforms.get(id);
    assert(m, `component ${id} was placed`);
    const v = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
    return [v.x, v.y, v.z];
  }

  function comp(name, p = [0, 0, 0], grounded = false) {
    const c = newComponent(name);
    c.transform = { p, q: [0, 0, 0, 1] };
    c.grounded = grounded;
    return c;
  }

  test('joints: all seven types are offered', () => {
    const want = ['rigid', 'revolute', 'slider', 'cylindrical', 'pinSlot', 'planar', 'ball'];
    for (const t of want) assert(JOINT_TYPES[t], `${t} is a joint type`);
    assert(Object.keys(JOINT_TYPES).length === 7, 'and there are seven of them');
  });

  test('joint: a revolute turns the child about the captured origin', () => {
    const a = comp('Base', [0, 0, 0], true);
    const b = comp('Arm', [10, 0, 0]);
    const out = solveAssembly(
      [a, b],
      [
        {
          id: 'j1',
          type: 'revolute',
          parent: a.id,
          child: b.id,
          origin: captureJointOrigin([0, 0, 0], [0, 0, 1]),
          angle: '90'
        }
      ],
      {}
    );
    const p = placeOf(out, b.id);
    // Ten along X, turned a quarter turn about Z, lands ten along Y.
    near(p[0], 0, 1e-6, 'x');
    near(p[1], 10, 1e-6, 'y');
  });

  test('joint: a ball turns about three axes at once', () => {
    const a = comp('Socket', [0, 0, 0], true);
    const b = comp('Ball', [10, 0, 0]);
    const out = solveAssembly(
      [a, b],
      [
        {
          id: 'j1',
          type: 'ball',
          parent: a.id,
          child: b.id,
          origin: captureJointOrigin([0, 0, 0], [0, 0, 1], [1, 0, 0]),
          pitch: '0',
          yaw: '90',
          roll: '0'
        }
      ],
      {}
    );
    const p = placeOf(out, b.id);
    // Yaw turns about the axis square to both, which swings X onto Z.
    near(Math.hypot(p[0], p[1], p[2]), 10, 1e-6, 'the arm keeps its length');
    assert(Math.abs(p[2]) > 9, `it swung out of the plane, got z ${p[2].toFixed(2)}`);
  });

  test('joint: a pin slot turns about one axis and slides along another', () => {
    const a = comp('Frame', [0, 0, 0], true);
    const b = comp('Pin', [0, 0, 0]);
    const out = solveAssembly(
      [a, b],
      [
        {
          id: 'j1',
          type: 'pinSlot',
          parent: a.id,
          child: b.id,
          origin: captureJointOrigin([0, 0, 0], [0, 0, 1], [1, 0, 0]),
          angle: '0',
          offset: '7'
        }
      ],
      {}
    );
    const p = placeOf(out, b.id);
    // No rotation asked for, so it is pure travel along the second axis.
    near(p[0], 7, 1e-6, 'slid along the slot');
    near(p[1], 0, 1e-6, 'and nowhere else');
  });

  test('joint: a planar joint slides in its plane and turns about the normal', () => {
    const a = comp('Table', [0, 0, 0], true);
    const b = comp('Puck', [0, 0, 0]);
    const out = solveAssembly(
      [a, b],
      [
        {
          id: 'j1',
          type: 'planar',
          parent: a.id,
          child: b.id,
          origin: captureJointOrigin([0, 0, 0], [0, 0, 1], [1, 0, 0]),
          angle: '0',
          offset: '4',
          offset2: '3'
        }
      ],
      {}
    );
    const p = placeOf(out, b.id);
    near(p[0], 4, 1e-6, 'along the first in plane axis');
    near(p[1], 3, 1e-6, 'and the second');
    near(p[2], 0, 1e-6, 'never off the plane');
  });

  test('joint: limits hold a joint inside its travel', () => {
    const a = comp('Base', [0, 0, 0], true);
    const b = comp('Slide', [0, 0, 0]);
    const out = solveAssembly(
      [a, b],
      [
        {
          id: 'j1',
          type: 'slider',
          parent: a.id,
          child: b.id,
          origin: captureJointOrigin([0, 0, 0], [1, 0, 0]),
          offset: '100',
          limits: { offsetMin: -5, offsetMax: 20 }
        }
      ],
      {}
    );
    near(placeOf(out, b.id)[0], 20, 1e-6, 'stopped at the end of its travel');
  });

  test('rigid group: members move together without a joint each', () => {
    const a = comp('Base', [0, 0, 0], true);
    const b = comp('Plate', [10, 0, 0]);
    const c = comp('Boss', [20, 0, 0]);
    const out = solveAssembly(
      [a, b, c],
      [
        {
          id: 'j1',
          type: 'slider',
          parent: a.id,
          child: b.id,
          origin: captureJointOrigin([0, 0, 0], [0, 1, 0]),
          offset: '15'
        }
      ],
      {},
      { rigidGroups: [{ id: 'g1', name: 'Head', components: [b.id, c.id] }] }
    );
    // The boss was never jointed, but it is grouped with the plate, so it goes
    // exactly where the plate goes.
    near(placeOf(out, b.id)[1], 15, 1e-6, 'the plate slid');
    near(placeOf(out, c.id)[1], 15, 1e-6, 'and the boss came with it');
    near(placeOf(out, c.id)[0], 20, 1e-6, 'keeping its own place in the group');
  });

  test('motion link: one joint drives another through a ratio', () => {
    const a = comp('Frame', [0, 0, 0], true);
    const b = comp('Big', [10, 0, 0]);
    const c = comp('Small', [0, 10, 0]);
    const joints = [
      {
        id: 'drive',
        type: 'revolute',
        parent: a.id,
        child: b.id,
        origin: captureJointOrigin([0, 0, 0], [0, 0, 1]),
        angle: '30'
      },
      {
        id: 'driven',
        type: 'revolute',
        parent: a.id,
        child: c.id,
        origin: captureJointOrigin([0, 0, 0], [0, 0, 1]),
        angle: '0'
      }
    ];
    const out = solveAssembly([a, b, c], joints, {}, {
      motionLinks: [{ id: 'l1', from: 'drive', to: 'driven', ratio: '2' }]
    });
    const p = placeOf(out, c.id);
    // Started at ninety degrees, driven sixty more.
    const angle = (Math.atan2(p[1], p[0]) * 180) / Math.PI;
    near(angle, 150, 1e-4, 'twice the drive angle, on top of where it started');
  });

  test('loop: a four bar closes instead of being reported', () => {
    // The classic test. Ground and rocker pivots 60 apart, a 20 crank, a 60
    // coupler and a 40 rocker: a crank rocker that turns right round.
    const ground = comp('Ground', [0, 0, 0], true);
    const crank = comp('Crank', [0, 0, 0]);
    const coupler = comp('Coupler', [20, 0, 0]);
    const rocker = comp('Rocker', [60, 0, 0]);

    const joints = [
      {
        id: 'a', type: 'revolute', parent: ground.id, child: crank.id,
        origin: captureJointOrigin([0, 0, 0], [0, 0, 1]), angle: '35', driven: true
      },
      {
        id: 'b', type: 'revolute', parent: crank.id, child: coupler.id,
        origin: captureJointOrigin([20, 0, 0], [0, 0, 1]), angle: '0'
      },
      {
        id: 'c', type: 'revolute', parent: coupler.id, child: rocker.id,
        origin: captureJointOrigin([80, 0, 0], [0, 0, 1]), angle: '0'
      },
      {
        id: 'd', type: 'revolute', parent: rocker.id, child: ground.id,
        origin: captureJointOrigin([60, 0, 0], [0, 0, 1]), angle: '0'
      }
    ];

    const out = solveAssembly([ground, crank, coupler, rocker], joints, {});
    assert(out.loops === 1, `one closing joint, got ${out.loops}`);
    assert(
      !out.errors.length,
      `it should close, not report: ${out.errors.map((e) => e.message).join('; ')}`
    );
    assert(out.residual < 1e-4, `closed to ${out.residual}`);
  });

  test('loop: the closed four bar really is consistent', () => {
    // Not just "no error": the joint that closes the loop has to put the two
    // sides of itself in the same place. Check the coupler's far pivot lands on
    // the rocker's, measured from both directions round the linkage.
    const ground = comp('Ground', [0, 0, 0], true);
    const crank = comp('Crank', [0, 0, 0]);
    const coupler = comp('Coupler', [20, 0, 0]);
    const rocker = comp('Rocker', [60, 0, 0]);
    const joints = [
      {
        id: 'a', type: 'revolute', parent: ground.id, child: crank.id,
        origin: captureJointOrigin([0, 0, 0], [0, 0, 1]), angle: '50', driven: true
      },
      {
        id: 'b', type: 'revolute', parent: crank.id, child: coupler.id,
        origin: captureJointOrigin([20, 0, 0], [0, 0, 1]), angle: '0'
      },
      {
        id: 'c', type: 'revolute', parent: coupler.id, child: rocker.id,
        origin: captureJointOrigin([80, 0, 0], [0, 0, 1]), angle: '0'
      },
      {
        id: 'd', type: 'revolute', parent: rocker.id, child: ground.id,
        origin: captureJointOrigin([60, 0, 0], [0, 0, 1]), angle: '0'
      }
    ];
    const out = solveAssembly([ground, crank, coupler, rocker], joints, {});
    assert(!out.errors.length, 'it closed');

    // The ground pivot of the rocker must not have moved: it is jointed to the
    // ground, which is fixed.
    const at = (id, local) =>
      new THREE.Vector3(local[0], local[1], local[2]).applyMatrix4(out.transforms.get(id));
    const rockerPivot = at(rocker.id, [0, 0, 0]);
    near(rockerPivot.x, 60, 1e-3, 'the rocker still hangs off its own ground pivot in x');
    near(rockerPivot.y, 0, 1e-3, 'and in y');
  });

  test('loop: a linkage asked for the impossible says so', () => {
    // A crank far too long to ever close against the others.
    const ground = comp('Ground', [0, 0, 0], true);
    const crank = comp('Crank', [0, 0, 0]);
    const coupler = comp('Coupler', [500, 0, 0]);
    const rocker = comp('Rocker', [10, 0, 0]);
    const joints = [
      {
        id: 'a', type: 'revolute', parent: ground.id, child: crank.id,
        origin: captureJointOrigin([0, 0, 0], [0, 0, 1]), angle: '90', driven: true
      },
      {
        id: 'b', type: 'revolute', parent: crank.id, child: coupler.id,
        origin: captureJointOrigin([500, 0, 0], [0, 0, 1]), angle: '0'
      },
      {
        id: 'c', type: 'rigid', parent: coupler.id, child: rocker.id,
        origin: captureJointOrigin([505, 0, 0], [0, 0, 1])
      },
      {
        id: 'd', type: 'rigid', parent: rocker.id, child: ground.id,
        origin: captureJointOrigin([10, 0, 0], [0, 0, 1])
      }
    ];
    const out = solveAssembly([ground, crank, coupler, rocker], joints, {});
    assert(out.loops === 1, 'there is a loop');
    assert(out.errors.length > 0, 'and it is reported rather than half solved');
  });

  test('loop: a tree with no loop is untouched by the solver', () => {
    const a = comp('Base', [0, 0, 0], true);
    const b = comp('Arm', [10, 0, 0]);
    const c = comp('Hand', [20, 0, 0]);
    const out = solveAssembly(
      [a, b, c],
      [
        {
          id: 'j1', type: 'revolute', parent: a.id, child: b.id,
          origin: captureJointOrigin([0, 0, 0], [0, 0, 1]), angle: '90'
        },
        {
          id: 'j2', type: 'slider', parent: b.id, child: c.id,
          origin: captureJointOrigin([10, 0, 0], [1, 0, 0]), offset: '5'
        }
      ],
      {}
    );
    assert(out.loops === 0, 'no loop');
    assert(!out.errors.length, 'and nothing to report');
    // The arm swings to (0, 10); the hand rides it and slides five along the
    // arm's own X, which after the swing points up the world Y.
    near(placeOf(out, b.id)[1], 10, 1e-6, 'the arm swung');
    near(placeOf(out, c.id)[1], 25, 1e-6, 'the hand came round and slid on');
  });

  test('contact: driving stops at the last position that does not overlap', () => {
    // Standing in for the geometry, a lid that fouls past sixty degrees.
    const overlapsAt = (angle) => angle > 60;
    const stopped = limitByContact(0, 120, overlapsAt);
    near(stopped, 60, 0.01, 'it stopped where they touch');

    // Nothing in the way means it goes all the way.
    near(limitByContact(0, 45, () => false), 45, 1e-9, 'a clear path is not shortened');

    // Already touching means it does not move at all.
    near(limitByContact(0, 45, () => true), 0, 1e-9, 'no room to start with');
  });

  /* -------- the surface analyses -------- */

  test('curvature: a sphere has the curvature its radius implies', () => {
    const doc = newDocument();
    doc.features = [prim('sphere', { diameter: '40', centered: true })];
    const out = rebuild(doc);
    const mesh = K.meshData(out.bodies[0].solid);
    const { mean, gauss } = vertexCurvature(mesh);

    // A sphere of radius 20 has mean curvature 1/20 and Gaussian 1/400
    // everywhere. A faceted sphere only approximates it, so this is a loose
    // check that the estimate is the right size and not, say, ten times out.
    const avgMean = mean.reduce((a, b) => a + b, 0) / mean.length;
    const avgGauss = gauss.reduce((a, b) => a + b, 0) / gauss.length;
    near(avgMean, 1 / 20, 0.02, 'mean curvature of a sphere');
    near(avgGauss, 1 / 400, 0.004, 'Gaussian curvature of a sphere');
  });

  test('curvature: a flat face is not curved', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '40', depth: '40', height: '40', centered: true })];
    const out = rebuild(doc);
    const { mean } = vertexCurvature(K.meshData(out.bodies[0].solid));
    // A box's curvature lives entirely on its edges and corners, so the
    // typical vertex reading has to stay small next to a sphere's.
    const median = [...mean].sort((a, b) => a - b)[Math.floor(mean.length / 2)];
    assert(Math.abs(median) < 0.5, `a box should read flat, got ${median}`);
  });

  test('minimum radius: a tight inside corner is flagged, a loose one is not', () => {
    // A shelled box has an inside corner at every wall junction.
    const build = (tool) => {
      const doc = newDocument();
      doc.features = [prim('box', { width: '40', depth: '40', height: '40', centered: true })];
      const out = rebuild(doc);
      return minimumRadiusColours(K.meshData(out.bodies[0].solid), tool);
    };
    const strict = build(50);
    const loose = build(0.01);
    const red = (c) => {
      let n = 0;
      for (let i = 0; i < c.length; i += 3) if (c[i] > 0.7 && c[i + 1] < 0.35) n++;
      return n;
    };
    assert(red(strict) >= red(loose), 'a bigger tool flags at least as much');
  });

  test('zebra: the stripes actually stripe', () => {
    const doc = newDocument();
    doc.features = [prim('sphere', { diameter: '40', centered: true })];
    const out = rebuild(doc);
    const colours = zebraColours(K.meshData(out.bodies[0].solid), [0, 0, 1], 12);
    const dark = [];
    const light = [];
    for (let i = 0; i < colours.length; i += 3) {
      (colours[i] > 0.5 ? light : dark).push(i);
    }
    assert(dark.length > 0 && light.length > 0, 'both bands appear');
    // Only two tones, which is what makes a stripe readable.
    const tones = new Set();
    for (let i = 0; i < colours.length; i += 3) tones.add(colours[i].toFixed(3));
    assert(tones.size === 2, `two tones, got ${tones.size}`);
  });

  test('accessibility: an overhang is in its own shadow', () => {
    // An L, so the underside of the overhanging arm cannot be reached from
    // below while the rest of the part can.
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '10', depth: '10', height: '40', centered: false, x: '0', y: '0', z: '0' }),
      {
        ...prim('box', { width: '40', depth: '10', height: '10', centered: false }),
        op: 'join'
      }
    ];
    Object.assign(doc.features[1].params, { x: '0', y: '0', z: '30' });
    const out = rebuild(doc);
    const colours = accessibilityColours(K.meshData(out.bodies[0].solid), [0, 0, -1]);
    let blocked = 0;
    for (let i = 0; i < colours.length; i += 3) if (colours[i] > 0.6) blocked++;
    assert(blocked > 0, 'the overhang is in shadow from below');

    // From the side there is nothing above anything, so far less is blocked.
    const fromSide = accessibilityColours(K.meshData(out.bodies[0].solid), [0, 1, 0]);
    let sideBlocked = 0;
    for (let i = 0; i < fromSide.length; i += 3) if (fromSide[i] > 0.6) sideBlocked++;
    assert(sideBlocked < blocked, 'less is hidden from a direction with no overhang');
  });

  test('curvature comb: a circle combs evenly, a straight line not at all', () => {
    const circle = [];
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      circle.push([20 * Math.cos(t), 20 * Math.sin(t), 0]);
    }
    const comb = curvatureComb(circle, 100, 1);
    assert(comb.length > 10, `a circle has a comb, got ${comb.length}`);
    // Every spike on a circle is the same length, because the curvature is.
    const lengths = comb.map((c) =>
      Math.hypot(c.to[0] - c.at[0], c.to[1] - c.at[1], c.to[2] - c.at[2])
    );
    const lo = Math.min(...lengths);
    const hi = Math.max(...lengths);
    near(hi / lo, 1, 0.05, 'every spike the same on a circle');
    near(lo, 100 / 20, 0.05, 'and as long as the curvature times the scale');

    const line = [];
    for (let i = 0; i <= 20; i++) line.push([i, 0, 0]);
    assert(curvatureComb(line, 100, 1).length === 0, 'a straight line has no comb');
  });

  test('extent: a mesh knows its own size', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '30', depth: '40', height: '120', centered: true })];
    const out = rebuild(doc);
    near(
      meshExtent(K.meshData(out.bodies[0].solid)),
      Math.hypot(30, 40, 120),
      1e-6,
      'the diagonal of its box'
    );
  });

  /* -------- batch 6: persistent identity -------- */

  /** A plate carrying four identical bosses, spaced across it. */
  function bossDoc(spacing) {
    const doc = newDocument();
    doc.features = [
      {
        id: 'plate', type: 'primitive', shape: 'box', op: 'new', targets: 'all',
        params: {
          width: String(spacing * 5), depth: '40', height: '10',
          diameter: '20', topDiameter: '0', centered: false, x: '0', y: '0', z: '0'
        }
      }
    ];
    for (let i = 0; i < 4; i++) {
      doc.features.push({
        id: `boss${i}`, type: 'primitive', shape: 'cylinder', op: 'join', targets: 'all',
        params: {
          diameter: '12', height: '8', topDiameter: '0', width: '10', depth: '10',
          centered: false, x: String(spacing * (i + 1)), y: '20', z: '10'
        }
      });
    }
    return doc;
  }

  const bossTops = (topo) =>
    topo.faces.filter(
      (f) => f.planar && f.normal[2] > 0.99 && Math.abs(f.centre[2] - 18) < 0.01
    );

  test('identity: a face says which feature made it', () => {
    const out = rebuild(bossDoc(20));
    const topo = buildTopology(K.meshData(out.bodies[0].solid));
    const tops = bossTops(topo);
    assert(tops.length === 4, `four boss tops, got ${tops.length}`);

    const tags = tops.map((f) => f.src?.tag).sort();
    assert(
      tags.join(',') === 'boss0,boss1,boss2,boss3',
      `each names its own feature, got ${tags.join(',')}`
    );
    // And the plate's own top is the plate's.
    const plateTop = topo.faces.find(
      (f) => f.planar && f.normal[2] > 0.99 && Math.abs(f.centre[2] - 10) < 0.01
    );
    assert(plateTop?.src?.tag === 'plate', `the plate top is the plate's, got ${plateTop?.src?.tag}`);
  });

  test('identity: a face reference survives a change that moves everything', () => {
    // The case that used to fail. Four faces that look exactly alike, told
    // apart only by position, and then the position changes.
    const first = rebuild(bossDoc(20));
    const topo = buildTopology(K.meshData(first.bodies[0].solid));
    const target = bossTops(topo).find((f) => Math.abs(f.centre[0] - 60) < 0.01);
    assert(target, 'the third boss');
    const ref = faceReference(target);

    for (const spacing of [24, 30, 44, 60]) {
      const res = rebuild(bossDoc(spacing));
      const t2 = buildTopology(K.meshData(res.bodies[0].solid));
      const [found] = resolveFaceRefs(t2, [ref]);
      assert(found, `still found at spacing ${spacing}`);
      near(
        found.centre[0],
        spacing * 3,
        0.5,
        `it is still the third boss at spacing ${spacing}`
      );
    }
  });

  test('identity: an edge is named by the two faces it lies between', () => {
    const first = rebuild(bossDoc(20));
    const topo = buildTopology(K.meshData(first.bodies[0].solid));
    const edge = topo.edges
      .filter((e) => e.kind === 'circle' && Math.abs(e.centre[2] - 18) < 0.01)
      .find((e) => Math.abs(e.centre[0] - 60) < 0.01);
    assert(edge, 'the top edge of the third boss');

    const ref = edgeReference(edge, topo);
    assert(ref.between, 'the reference carries the pair of faces');
    assert(
      ref.between.every((x) => x && x.tag === 'boss2'),
      'both of them belong to that boss'
    );

    for (const spacing of [24, 30, 44, 60]) {
      const res = rebuild(bossDoc(spacing));
      const t2 = buildTopology(K.meshData(res.bodies[0].solid));
      const [found] = resolveEdgeRefs(t2, [ref]);
      assert(found, `still found at spacing ${spacing}`);
      near(found.centre[0], spacing * 3, 0.5, `on the right boss at spacing ${spacing}`);
    }
  });

  test('identity: a fillet stays on the boss it was put on', () => {
    // What the reference is actually for. Round the third boss, then move
    // every boss, and check the material came off the third one each time.
    const first = rebuild(bossDoc(20));
    const topo = buildTopology(K.meshData(first.bodies[0].solid));
    const edge = topo.edges
      .filter((e) => e.kind === 'circle' && Math.abs(e.centre[2] - 18) < 0.01)
      .find((e) => Math.abs(e.centre[0] - 60) < 0.01);
    const ref = edgeReference(edge, topo);

    const topArea = (topo2, x) =>
      topo2.faces
        .filter(
          (f) =>
            f.planar &&
            f.normal[2] > 0.99 &&
            Math.abs(f.centre[2] - 18) < 0.01 &&
            Math.abs(f.centre[0] - x) < 6
        )
        .reduce((sum, f) => sum + f.area, 0);

    for (const spacing of [24, 30, 44]) {
      const plain = buildTopology(K.meshData(rebuild(bossDoc(spacing)).bodies[0].solid));
      const doc = bossDoc(spacing);
      doc.features.push({
        id: 'ffil', type: 'fillet', bodies: 'all',
        sets: [{ edges: [ref], radius: '2' }]
      });
      const res = rebuild(doc);
      assert(
        !res.errors.some((e) => e.feature === 'ffil'),
        `the fillet built at spacing ${spacing}`
      );
      const after = buildTopology(K.meshData(res.bodies[0].solid));

      let worst = 0;
      let landedOn = null;
      for (let i = 1; i <= 4; i++) {
        const x = spacing * i;
        const shrank = topArea(plain, x) - topArea(after, x);
        if (shrank > worst) {
          worst = shrank;
          landedOn = x;
        }
      }
      assert(
        landedOn !== null && Math.abs(landedOn - spacing * 3) < 1,
        `the material came off the third boss at spacing ${spacing}, not x=${landedOn}`
      );
    }
  });

  test('split face: the shape is unchanged and the face becomes two', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '20', height: '20', centered: true })
    ];
    const before = rebuild(doc);
    const beforeVolume = before.bodies[0].solid.volume();
    const beforeTopo = buildTopology(K.meshData(before.bodies[0].solid));
    const beforeFront = beforeTopo.faces.filter((f) => f.planar && f.normal[1] < -0.99);
    assert(beforeFront.length === 1, `one front face to start, got ${beforeFront.length}`);

    doc.features.push({
      id: 'fsplit', type: 'splitFace', bodies: 'all', plane: 'YZ', faceRef: null
    });
    const after = rebuild(doc);
    assert(after.bodies.length === 1, 'still one body');
    near(after.bodies[0].solid.volume(), beforeVolume, 1e-6, 'and exactly the same size');

    const afterTopo = buildTopology(K.meshData(after.bodies[0].solid));
    const afterFront = afterTopo.faces.filter((f) => f.planar && f.normal[1] < -0.99);
    assert(afterFront.length === 2, `the front face is now two, got ${afterFront.length}`);
    // Split down the middle, so the halves are equal.
    near(afterFront[0].area, afterFront[1].area, 1e-6, 'and the halves are equal');
  });

  test('split face: a plane that misses the body says so', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '10', depth: '10', height: '10', centered: false, x: '50', y: '0', z: '0' }),
      { id: 'fsplit', type: 'splitFace', bodies: 'all', plane: 'YZ', faceRef: null }
    ];
    const out = rebuild(doc);
    assert(out.errors.length > 0, 'it is reported');
    near(out.bodies[0].solid.volume(), 1000, 1e-6, 'and the body is untouched');
  });

  /* -------- batch 7: the 3D sketch -------- */

  /** A sketch whose curve climbs out of its own plane. */
  function helixSketch(turns = 1.5, radius = 15, rise = 24) {
    const sk = newSketch('XY', 'Path', { is3d: true });
    const n = 48;
    sk.points = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * turns * Math.PI * 2;
      sk.points.push({
        x: radius * Math.cos(t),
        y: radius * Math.sin(t),
        z: (rise * i) / n
      });
    }
    sk.entities = [{ id: 1, type: 'spline', p: sk.points.map((_, i) => i) }];
    sk.nextEntityId = 2;
    return sk;
  }

  test('3d sketch: a curve keeps its third coordinate through tessellation', () => {
    const sk = helixSketch();
    const pts = tessellate(sk, sk.entities[0]);
    assert(pts.length > 40, 'it tessellated');
    assert(
      pts.every((p) => typeof p.z === 'number'),
      'every point carries a z'
    );
    const zs = pts.map((p) => p.z);
    near(Math.min(...zs), 0, 0.01, 'starts at the bottom');
    near(Math.max(...zs), 24, 0.01, 'and climbs to the top');
  });

  test('3d sketch: a flat sketch is untouched by any of it', () => {
    const sk = newSketch('XY', 'Flat');
    sk.points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] },
      { id: 4, type: 'line', p: [3, 0] }
    ];
    sk.nextEntityId = 5;
    const regions = findRegions(sk);
    assert(regions.length === 1, 'it still closes a region');
    near(Math.abs(signedArea(regions[0].outer)), 80, 1e-9, 'of the right size');
    const pts = tessellate(sk, sk.entities[0]);
    assert(pts.every((p) => p.z === 0), 'and its points sit on the plane');
  });

  test('3d sketch: a curve that leaves the plane closes no region', () => {
    // A loop that does not lie flat bounds nothing, and treating its points as
    // flat would invent a profile that is not there.
    const sk = newSketch('XY', 'Loop', { is3d: true });
    sk.points = [
      { x: 0, y: 0, z: 0 },
      { x: 20, y: 0, z: 0 },
      { x: 20, y: 20, z: 15 },
      { x: 0, y: 20, z: 15 }
    ];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] },
      { id: 4, type: 'line', p: [3, 0] }
    ];
    sk.nextEntityId = 5;
    assert(findRegions(sk).length === 0, 'no region from a loop that is not flat');
  });

  test('3d sketch: a sweep follows a path that climbs', () => {
    const doc = newDocument();
    const path = helixSketch(1.5, 15, 24);
    // The helix leaves its start heading along Y, so the section has to be on
    // the plane square to that. A sweep refuses a profile edge on to its path.
    // It also has to sit where the path begins: a section drawn away from the
    // path is swept at that offset, which on a turning path is a different
    // shape entirely.
    const prof = newSketch('XZ', 'Section');
    prof.points = [{ x: 15, y: 0 }];
    prof.entities = [{ id: 1, type: 'circle', c: 0, r: 2 }];
    prof.nextEntityId = 2;
    doc.sketches[path.id] = path;
    doc.sketches[prof.id] = prof;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: path.id },
      { id: uid('f'), type: 'sketch', sketch: prof.id },
      {
        id: uid('f'),
        type: 'sweep',
        sketch: prof.id,
        path: { sketch: path.id },
        op: 'new',
        targets: 'all'
      }
    ];
    const out = rebuild(doc);
    assert(out.bodies.length === 1, `one body, got ${out.bodies.length}`);

    const bb = out.bodies[0].solid.boundingBox();
    // A path that rises 24 gives a tube that spans that plus its own diameter.
    const tall = bb.max[2] - bb.min[2];
    assert(tall > 20, `it climbed, spanning ${tall.toFixed(1)} in z`);

    // Pappus again: the section's area times the length of the path it walked.
    const pts = tessellate(path, path.entities[0]);
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(
        pts[i].x - pts[i - 1].x,
        pts[i].y - pts[i - 1].y,
        pts[i].z - pts[i - 1].z
      );
    }
    const want = Math.PI * 4 * len;
    near(out.bodies[0].solid.volume(), want, want * 0.06, 'volume along the real path');
  });

  test('3d sketch: the solver leaves its points where they were put', () => {
    // Every residual in the solver is written in two variables per point, so a
    // third would be quietly flattened. A 3D sketch is reference geometry.
    const doc = newDocument();
    const sk = helixSketch();
    const before = sk.points.map((p) => p.z);
    doc.sketches[sk.id] = sk;
    doc.features = [{ id: uid('f'), type: 'sketch', sketch: sk.id }];
    rebuild(doc);
    const after = doc.sketches[sk.id].points.map((p) => p.z);
    assert(
      before.every((z, i) => Math.abs(z - after[i]) < 1e-9),
      'nothing moved out of the third dimension'
    );
  });

  test('intersection curve: two crossing cylinders meet on a real curve', () => {
    const doc = newDocument();
    doc.features = [
      prim('cylinder', { diameter: '20', height: '60', centered: true }),
      { ...prim('cylinder', { diameter: '20', height: '60', centered: true }), op: 'new' }
    ];
    // The second lying across the first.
    doc.features[1].rotate = null;
    const out = rebuild(doc);
    assert(out.bodies.length === 2, 'two bodies');

    const scope = new K.Scope();
    const runs = intersectionRuns(out.bodies[0].solid, out.bodies[1].solid, scope);
    scope.dispose();
    // Two identical coaxial cylinders share their whole surface, so the only
    // edges between different sources are none: this is the degenerate case,
    // and it must not invent a curve.
    assert(Array.isArray(runs), 'it answers rather than throwing');
  });

  test('intersection curve: a box and a cylinder cross on a closed loop', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '40', height: '10', centered: true }),
      {
        ...prim('cylinder', { diameter: '20', height: '60', centered: true }),
        op: 'new'
      }
    ];
    const out = rebuild(doc);
    assert(out.bodies.length === 2, 'two bodies');

    const scope = new K.Scope();
    const runs = intersectionRuns(out.bodies[0].solid, out.bodies[1].solid, scope);
    scope.dispose();
    assert(runs.length > 0, 'they cross on something');

    // The cylinder passes through the plate, so the curves are the two circles
    // where it enters and leaves, at the plate's own top and bottom.
    const zs = runs.flat().map((p) => p[2]);
    const lo = Math.min(...zs);
    const hi = Math.max(...zs);
    near(lo, -5, 0.01, 'one circle on the underside');
    near(hi, 5, 0.01, 'and one on the top');

    // And each really is a circle of the cylinder's radius.
    for (const run of runs) {
      for (const p of run) {
        near(Math.hypot(p[0], p[1]), 10, 0.3, 'on the cylinder wall');
      }
    }
  });

  test('intersection curve: bodies that miss each other give nothing', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '10', depth: '10', height: '10', centered: false, x: '0' }),
      { ...prim('box', { width: '10', depth: '10', height: '10', centered: false }), op: 'new' }
    ];
    doc.features[1].params.x = '80';
    const out = rebuild(doc);
    const scope = new K.Scope();
    const runs = intersectionRuns(out.bodies[0].solid, out.bodies[1].solid, scope);
    scope.dispose();
    assert(runs.length === 0, 'nothing where they do not meet');
  });

  /* -------- batch 7: surfaces -------- */

  /** A sketch holding one open curve, three sides of a square. */
  function openCurveSketch(plane = 'XY') {
    const sk = newSketch(plane, 'Curve');
    sk.points = [
      { x: -10, y: 0 },
      { x: -10, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 0 }
    ];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] }
    ];
    sk.nextEntityId = 4;
    return sk;
  }

  /** A flat square sheet, 20 by 20 about the origin, facing up. */
  function squareSheet(z = 0, n = 4) {
    const pts = [];
    for (let r = 0; r <= n; r++) {
      const row = [];
      for (let c = 0; c <= n; c++) {
        row.push([-10 + (20 * c) / n, -10 + (20 * r) / n, z]);
      }
      pts.push(row);
    }
    return SH.gridSheet(pts, {});
  }

  test('sheet: a grid surface knows its own boundary', () => {
    const sheet = squareSheet();
    assert(sheet, 'it built');
    const loops = SH.boundaryLoops(sheet);
    assert(loops.length === 1, `one boundary loop, got ${loops.length}`);
    // Four sides of four segments each, and the corners are not counted twice.
    assert(loops[0].length === 16, `16 points round the rim, got ${loops[0].length}`);
    near(SH.sheetArea(sheet), 400, 1e-6, 'and it is 20 by 20');
  });

  test('sheet: a closed mesh has no boundary at all', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '10', depth: '10', height: '10' })];
    const out = rebuild(doc);
    const mesh = K.meshData(out.bodies[0].solid);
    assert(SH.boundaryLoops(mesh).length === 0, 'a solid has no open edge');
  });

  test('sheet: ear clipping fills a square and a square with a hole', () => {
    const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const solid = SH.earcut(outer);
    assert(solid.length === 2, `two triangles, got ${solid.length}`);

    // A hole is wound the other way so it stays a hole.
    const hole = [[3, 3], [3, 7], [7, 7], [7, 3]];
    const withHole = SH.earcut(outer, [hole]);
    const pts = [...outer, ...hole];
    let area = 0;
    for (const [i, j, k] of withHole) {
      const a = pts[i];
      const b = pts[j];
      const c = pts[k];
      area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }
    // 100 outside, 16 in the hole, so 84 of material.
    near(area, 84, 0.01, 'the hole is not filled in');
  });

  test('sheet: a patch fills a boundary and nothing more', () => {
    const loop = [];
    for (let i = 0; i < 32; i++) {
      const t = (i / 32) * Math.PI * 2;
      loop.push([12 * Math.cos(t), 12 * Math.sin(t), 5]);
    }
    const patch = SH.patchLoops([loop]);
    assert(patch, 'it patched');
    // A 32 sided polygon in a circle of 12, not the circle itself.
    const want = 0.5 * 32 * 144 * Math.sin((2 * Math.PI) / 32);
    near(SH.sheetArea(patch), want, want * 0.001, 'the area the loop encloses');
    assert(SH.boundaryLoops(patch).length === 1, 'and the loop is still its edge');
  });

  test('sheet: an offset holds its distance off the original', () => {
    const sheet = squareSheet(0);
    const up = SH.offsetSheet(sheet, 3);
    const P = SH.sheetPoints(up);
    assert(
      P.every((p) => Math.abs(p[2] - 3) < 1e-5),
      'every point moved by three along the normal'
    );
    near(SH.sheetArea(up), 400, 1e-4, 'and a flat sheet keeps its area');
  });

  test('sheet: reversing turns every triangle round', () => {
    const sheet = squareSheet();
    const back = SH.reverseSheet(sheet);
    const a = SH.sheetTris(sheet)[0];
    const b = SH.sheetTris(back)[0];
    assert(a[0] === b[0] && a[1] === b[2] && a[2] === b[1], 'wound the other way');
  });

  test('sheet: thicken closes a flat sheet into a solid of the right volume', () => {
    const sheet = squareSheet();
    const { sheet: shell, closed } = SH.thickenSheet(sheet, 2);
    assert(closed, 'it closed');
    const scope = new K.Scope();
    const solid = K.ofMesh(shell.vertProperties, shell.triVerts, scope);
    assert(K.status(solid) === 'NoError', `a real solid, got ${K.status(solid)}`);
    near(solid.volume(), 800, 0.5, '20 by 20 by 2');
    assert(solid.genus() === 0, 'and it is a plain block');
    scope.dispose();
  });

  test('sheet: stitch says so when the surfaces do not close', () => {
    // Five faces of a box, which is a box with the lid off.
    const doc = newDocument();
    doc.features = [prim('box', { width: '20', depth: '20', height: '20', centered: true })];
    const out = rebuild(doc);
    const mesh = K.meshData(out.bodies[0].solid);
    const topo = buildTopology(mesh);
    const pieces = SH.unstitchMesh(mesh, topo);
    assert(pieces.length === 6, `six faces, got ${pieces.length}`);

    const all = SH.stitchSheets(pieces.map((p) => p.sheet), 1e-4);
    assert(all.closed, 'all six close back into a solid');
    assert(all.openEdges === 0, 'with nothing left open');

    const five = SH.stitchSheets(pieces.slice(1).map((p) => p.sheet), 1e-4);
    assert(!five.closed, 'five of them do not');
    assert(five.openEdges > 0, `and it says how many edges are open: ${five.openEdges}`);
  });

  test('sheet: an unstitched box gives six flat pieces that add up', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '20', depth: '20', height: '20', centered: true })];
    const out = rebuild(doc);
    const mesh = K.meshData(out.bodies[0].solid);
    const pieces = SH.unstitchMesh(mesh, buildTopology(mesh));
    const total = pieces.reduce((a, p) => a + SH.sheetArea(p.sheet), 0);
    near(total, 2400, 0.01, 'six faces of 400');
    for (const p of pieces) {
      assert(SH.boundaryLoops(p.sheet).length === 1, 'each is an open sheet');
    }
  });

  test('sheet: extend grows a surface without moving what was there', () => {
    const sheet = squareSheet();
    const bigger = SH.extendSheet(sheet, 5);
    const P = SH.sheetPoints(bigger);
    const xs = P.map((p) => p[0]);
    near(Math.min(...xs), -15, 0.01, 'five further out one way');
    near(Math.max(...xs), 15, 0.01, 'and five the other');
    assert(
      P.every((p) => Math.abs(p[2]) < 1e-5),
      'and it stayed in its own plane'
    );
    assert(SH.sheetArea(bigger) > 400, 'it did get bigger');
  });

  test('sheet: a trim keeps the side that was picked', () => {
    const flat = squareSheet(0, 8);
    // A wall standing across the middle of it at x = 0.
    const wall = SH.gridSheet(
      [
        [[0, -20, -10], [0, 20, -10]],
        [[0, -20, 10], [0, 20, 10]]
      ],
      {}
    );
    const right = SH.trimSheet(flat, [wall], [5, 0, 0]);
    near(SH.sheetArea(right), 200, 1, 'half the square is left');
    const P = SH.sheetPoints(right);
    assert(
      P.every((p) => p[0] > -1e-4),
      'and it is the half the pick was in'
    );

    const left = SH.trimSheet(flat, [wall], [-5, 0, 0]);
    const Q = SH.sheetPoints(left);
    assert(
      Q.every((p) => p[0] < 1e-4),
      'picking the other side keeps the other half'
    );
  });

  test('sheet: two triangles that miss each other cross nowhere', () => {
    const a = [[0, 0, 0], [10, 0, 0], [0, 10, 0]];
    const b = [[0, 0, 5], [10, 0, 5], [0, 10, 5]];
    assert(SH.triangleIntersection(a, b) === null, 'parallel and apart');

    const c = [[2, 2, -5], [2, 2, 5], [8, 2, 0]];
    const seg = SH.triangleIntersection(a, c);
    assert(seg, 'one standing through the other does cross');
    assert(
      seg.every((p) => Math.abs(p[2]) < 1e-6),
      'and the crossing is in the first triangle plane'
    );
  });

  test('sheet: isoparametric curves come off a surface that has a u and a v', () => {
    const sheet = squareSheet(0, 8);
    const rows = SH.isoCurves(sheet, 'u', 3);
    assert(rows?.length === 3, 'three curves across');
    for (const run of rows) {
      const ys = run.map((p) => p[1]);
      near(Math.max(...ys) - Math.min(...ys), 0, 1e-6, 'each holds v steady');
    }
    const cols = SH.isoCurves(sheet, 'v', 3);
    for (const run of cols) {
      const xs = run.map((p) => p[0]);
      near(Math.max(...xs) - Math.min(...xs), 0, 1e-6, 'and the others hold u');
    }
    // A face lifted off a solid has no parameterisation to read.
    const doc = newDocument();
    doc.features = [prim('box', {})];
    const out = rebuild(doc);
    const mesh = K.meshData(out.bodies[0].solid);
    const piece = SH.unstitchMesh(mesh, buildTopology(mesh))[0];
    assert(SH.isoCurves(piece.sheet, 'u', 3) === null, 'and a solid face has none');
  });

  test('sheet: a curve projected onto a surface lands on it', () => {
    // A dome, and a straight line above it.
    const rows = [];
    for (let r = 0; r <= 12; r++) {
      const row = [];
      for (let c = 0; c <= 12; c++) {
        const x = -10 + (20 * c) / 12;
        const y = -10 + (20 * r) / 12;
        row.push([x, y, 20 - (x * x + y * y) / 20]);
      }
      rows.push(row);
    }
    const dome = SH.gridSheet(rows, {});
    const line = [];
    for (let i = 0; i <= 20; i++) line.push([-8 + (16 * i) / 20, 0, 50]);

    const runs = SH.projectRunOnto(line, [0, 0, 1], dome);
    assert(runs.length === 1, `one unbroken run, got ${runs.length}`);
    for (const p of runs[0]) {
      // On the dome, within the error of a triangle chord.
      const want = 20 - (p[0] * p[0] + p[1] * p[1]) / 20;
      near(p[2], want, 0.06, 'every point sits on the surface');
    }

    // A curve that runs off the edge comes back only where it landed.
    const past = [];
    for (let i = 0; i <= 20; i++) past.push([-30 + (60 * i) / 20, 0, 50]);
    const partial = SH.projectRunOnto(past, [0, 0, 1], dome);
    assert(partial.length >= 1, 'the part over the dome still lands');
    const xs = partial.flat().map((p) => p[0]);
    assert(Math.min(...xs) > -10.5 && Math.max(...xs) < 10.5, 'and nothing beyond it');
  });

  /* -------- surfaces through the timeline -------- */

  test('surface extrude: an open curve becomes an open surface', () => {
    const doc = newDocument();
    const sk = openCurveSketch('XY');
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: uid('f'), type: 'surfaceExtrude', sketch: sk.id, edges: [], distance: '10', direction: 'one' }
    ];
    const out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    assert(out.bodies.length === 1, `one body, got ${out.bodies.length}`);
    const body = out.bodies[0];
    assert(!body.solid && body.sheet, 'and it is a surface, not a solid');
    // Three sides of 10, 20, 10, dragged 10 up.
    near(SH.sheetArea(body.sheet), 400, 0.01, '40 of curve by 10 of drag');
  });

  test('surface extrude: a solid feature will not touch a surface body', () => {
    const doc = newDocument();
    const sk = openCurveSketch('XY');
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: uid('f'), type: 'surfaceExtrude', sketch: sk.id, distance: '10', direction: 'one' },
      { ...prim('box', { width: '60', depth: '60', height: '60', centered: true }), op: 'cut', targets: 'all' }
    ];
    const out = rebuild(doc);
    // The cut has nothing solid to cut, so it makes a new body rather than
    // reaching into the surface and producing nonsense.
    const sheets = out.bodies.filter((b) => !b.solid);
    assert(sheets.length === 1, 'the surface is still there');
    near(SH.sheetArea(sheets[0].sheet), 400, 0.01, 'and untouched');
  });

  test('surface revolve: a line turned about an axis is a cylinder wall', () => {
    const doc = newDocument();
    const sk = newSketch('XZ', 'Line');
    sk.points = [{ x: 10, y: 0 }, { x: 10, y: 15 }];
    sk.entities = [{ id: 1, type: 'line', p: [0, 1] }];
    sk.nextEntityId = 2;
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      {
        id: uid('f'),
        type: 'surfaceRevolve',
        sketch: sk.id,
        axis: { type: 'world', worldAxis: 'z' },
        angle: '360'
      }
    ];
    const out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    const body = out.bodies[0];
    assert(body && !body.solid, 'a surface');
    // A faceted cylinder wall, a little under the true 2 pi r h.
    const want = 2 * Math.PI * 10 * 15;
    near(SH.sheetArea(body.sheet), want, want * 0.02, 'the wall of a cylinder');
    assert(SH.boundaryLoops(body.sheet).length === 2, 'open at both ends');
  });

  test('patch and stitch: a walled tube plus two caps is a solid', () => {
    const doc = newDocument();
    const sk = newSketch('XZ', 'Line');
    sk.points = [{ x: 10, y: -10 }, { x: 10, y: 10 }];
    sk.entities = [{ id: 1, type: 'line', p: [0, 1] }];
    sk.nextEntityId = 2;
    doc.sketches[sk.id] = sk;
    // The revolve is named, so the patch can be pointed at the surface it makes
    // rather than at every surface in the model.
    const revolveId = uid('f');
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      {
        id: revolveId,
        type: 'surfaceRevolve',
        sketch: sk.id,
        axis: { type: 'world', worldAxis: 'z' },
        angle: '360'
      },
      {
        id: uid('f'),
        type: 'patch',
        surfaces: [`${revolveId}:0`],
        edges: [],
        together: false
      },
      { id: uid('f'), type: 'stitch', surfaces: [], tolerance: '0.01' }
    ];
    const out = rebuild(doc);
    const solids = out.bodies.filter((b) => b.solid);
    assert(solids.length === 1, `one solid, got ${solids.length} (${out.errors.map((e) => e.message).join('; ')})`);
    const want = Math.PI * 100 * 20;
    near(solids[0].solid.volume(), want, want * 0.03, 'a closed cylinder');
    assert(out.bodies.filter((b) => !b.solid).length === 0, 'and the surfaces are used up');
  });

  test('thicken: a flat surface becomes a solid of exactly that thickness', () => {
    // One straight line, so the answer is a plain block and there are no
    // corners for the offset to mitre. Anything else and the right answer is
    // not a number this test could state.
    const doc = newDocument();
    const sk = newSketch('XY', 'Line');
    sk.points = [{ x: -10, y: 0 }, { x: 10, y: 0 }];
    sk.entities = [{ id: 1, type: 'line', p: [0, 1] }];
    sk.nextEntityId = 2;
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: uid('f'), type: 'surfaceExtrude', sketch: sk.id, distance: '10', direction: 'one' },
      { id: uid('f'), type: 'thicken', surfaces: [], distance: '2', symmetric: false }
    ];
    const out = rebuild(doc);
    const solids = out.bodies.filter((b) => b.solid);
    assert(solids.length === 1, `one solid, got ${solids.length} (${out.errors.map((e) => e.message).join('; ')})`);
    near(solids[0].solid.volume(), 400, 0.5, '20 by 10 of surface, 2 thick');
    assert(out.bodies.filter((b) => !b.solid).length === 0, 'and the surface is used up');
  });

  test('thicken: a mitred corner keeps its full thickness', () => {
    // Two walls meeting at a right angle. Offsetting along the average normal
    // without mitring would make the corner 1.41 thick instead of 2, and the
    // volume would come out short of the walls it was made from.
    const doc = newDocument();
    const sk = openCurveSketch('XY');
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: uid('f'), type: 'surfaceExtrude', sketch: sk.id, distance: '10', direction: 'one' },
      { id: uid('f'), type: 'thicken', surfaces: [], distance: '2', symmetric: false }
    ];
    const out = rebuild(doc);
    const solids = out.bodies.filter((b) => b.solid);
    assert(solids.length === 1, `one solid, got ${solids.length} (${out.errors.map((e) => e.message).join('; ')})`);

    // 40 of curve, 10 tall, 2 thick is 800 before the corners are counted.
    // Each of the two corners is offset to the inside, which takes a 2 by 2
    // square off over the full height: 800 less 2 lots of 40 is 720.
    near(solids[0].solid.volume(), 720, 8, 'the walls, less what the corners share');

    // The walls face into the U, so the thickness is taken out of the inside
    // and the outline is exactly the curve that was drawn.
    const bb = solids[0].solid.boundingBox();
    near(bb.max[1] - bb.min[1], 10, 0.02, 'no wider than the sketch');
    near(bb.max[0] - bb.min[0], 20, 0.02, 'nor longer');
    near(bb.max[2] - bb.min[2], 10, 0.02, 'and as tall as it was extruded');
  });

  test('boundary fill: a surface divides a block into two cells', () => {
    const doc = newDocument();
    const sk = newSketch('XZ', 'Cut');
    sk.points = [{ x: -40, y: 0 }, { x: 40, y: 0 }];
    sk.entities = [{ id: 1, type: 'line', p: [0, 1] }];
    sk.nextEntityId = 2;
    doc.sketches[sk.id] = sk;
    const box = prim('box', { width: '20', depth: '20', height: '20', centered: true });
    doc.features = [
      box,
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      {
        id: uid('f'),
        type: 'surfaceExtrude',
        sketch: sk.id,
        distance: '80',
        direction: 'symmetric'
      },
      { id: uid('f'), type: 'boundaryFill', bodies: [], tools: [], cells: '' }
    ];
    // Point the fill at the block and at whatever surface came before it.
    const out0 = rebuild(doc);
    const boxBody = out0.bodies.find((b) => b.solid);
    const sheetBody = out0.bodies.find((b) => !b.solid);
    doc.features[3].bodies = [boxBody.id];
    doc.features[3].tools = [sheetBody.id];

    const out = rebuild(doc);
    const solids = out.bodies.filter((b) => b.solid);
    assert(solids.length === 2, `two cells, got ${solids.length} (${out.errors.map((e) => e.message).join('; ')})`);
    const total = solids.reduce((a, b) => a + b.solid.volume(), 0);
    near(total, 8000, 20, 'and together they are the block again');
    for (const s of solids) near(s.solid.volume(), 4000, 40, 'cut through the middle');
  });

  test('delete face: a face that is not a bore is healed by closing the hole', () => {
    const doc = newDocument();
    const box = prim('box', { width: '20', depth: '20', height: '20', centered: true });
    doc.features = [box];
    const first = rebuild(doc);
    const topo = buildTopology(K.meshData(first.bodies[0].solid));
    const top = topo.faces.find((f) => f.planar && f.normal[2] > 0.99);

    doc.features.push({
      id: uid('f'),
      type: 'deleteFace',
      faces: [{ bodyId: first.bodies[0].id, face: faceReference(top) }]
    });
    const out = rebuild(doc);
    const solids = out.bodies.filter((b) => b.solid);
    assert(solids.length === 1, `still one body (${out.errors.map((e) => e.message).join('; ')})`);
    // The lid is flat, so closing the hole puts back exactly what was removed.
    near(solids[0].solid.volume(), 8000, 1, 'and the block is unchanged');
  });

  /* -------- untrim and merge -------- */

  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  /** A 40 square plate with a 10 square hole and a bite out of one corner. */
  function trimmedPlate(bend = 0) {
    const outer = [[-20, -20], [20, -20], [20, 20], [5, 20], [5, 12], [-20, 12]];
    const hole = [[-5, -5], [-5, 5], [5, 5], [5, -5]];
    const tris = SH.fillLoops(outer, [hole]);
    const points = [...outer, ...hole].map((q) => [q[0], q[1], bend * q[0] * q[0]]);
    return SH.makeSheet(points, tris);
  }

  test('untrim: filling the holes puts back exactly what was cut out', () => {
    const plate = trimmedPlate();
    // 40 by 40 is 1600, less 200 for the corner bite, less 100 for the hole.
    near(SH.sheetArea(plate), 1300, 1e-6, 'the plate starts trimmed');
    assert(SH.boundaryLoops(plate).length === 2, 'an outside and a hole');

    const out = SH.untrimSheet(plate, { outer: false });
    assert(out.holes === 1, `one hole filled, got ${out.holes}`);
    assert(out.exact, 'and on a flat surface the fill is the surface itself');
    near(SH.sheetArea(out.sheet), 1400, 1e-6, 'the hole is back');
    assert(SH.boundaryLoops(out.sheet).length === 1, 'and it is one boundary now');
    assert(!out.squared, 'the outside was left where it was');
  });

  test('untrim: squaring the outside off gives the whole rectangle back', () => {
    const out = SH.untrimSheet(trimmedPlate(), { outer: true });
    assert(out.squared, 'it squared off');
    near(SH.sheetArea(out.sheet), 1600, 1e-6, 'the full 40 by 40');
    assert(SH.boundaryLoops(out.sheet).length === 1, 'one rim, no holes');
    // And it still faces the way it did, or a thicken after this goes the
    // wrong way.
    const before = SH.sheetPlane(trimmedPlate());
    const after = SH.sheetPlane(out.sheet);
    assert(dot3(before.n, after.n) > 0.99, 'facing the way it faced');
  });

  test('untrim: extra all round goes on outside the rectangle', () => {
    const out = SH.untrimSheet(trimmedPlate(), { outer: true, margin: 5 });
    near(SH.sheetArea(out.sheet), 50 * 50, 1e-6, '5 more on every side');
  });

  test('untrim: a curved surface says the outside was left alone', () => {
    // The same plate, bowed. There is no rectangle for a bowed surface to go
    // back to, so squaring it off would be an invention.
    const bowed = trimmedPlate(0.01);
    const out = SH.untrimSheet(bowed, { outer: true });
    assert(!out.flat, 'it knows the surface is curved');
    assert(!out.squared, 'so it does not square anything off');
    assert(out.holes === 1, 'but the hole is still filled');
    assert(!out.exact, 'and it says the fill is a patch, not the curve carried on');
    assert(SH.boundaryLoops(out.sheet).length === 1, 'one boundary left');
    assert(SH.sheetArea(out.sheet) > SH.sheetArea(bowed) + 90, 'about a hole bigger');
  });

  test('untrim: a surface with nothing trimmed out of it is left alone', () => {
    const square = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    const flat = SH.makeSheet(square.map((q) => [q[0], q[1], 0]), SH.fillLoops(square));
    const out = SH.untrimSheet(flat, { outer: false });
    assert(out.holes === 0 && !out.squared, 'nothing to do');
    near(SH.sheetArea(out.sheet), 400, 1e-6, 'and nothing done');
  });

  /** A plate 40 by 40 by 10 with a 10 bore through it, broken into faces. */
  function boredPlateSheets() {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '40', height: '10', centered: true }),
      { ...prim('cylinder', { diameter: '20', height: '40', centered: true }), op: 'cut', targets: 'all' },
      { id: 'unst', type: 'unstitch', bodies: 'all' }
    ];
    return { doc, out: rebuild(doc) };
  }

  test('untrim through the timeline: the bored face comes back solid', () => {
    const { doc, out } = boredPlateSheets();
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    const sheets = out.bodies.filter((b) => !b.solid);
    assert(sheets.length >= 3, `unstitched into faces, got ${sheets.length}`);

    // The top of the plate: flat, facing up, and 1600 less the bore.
    const bore = Math.PI * 100;
    const top = sheets.find((b) => Math.abs(SH.sheetArea(b.sheet) - (1600 - bore)) < bore * 0.05);
    assert(top, 'found the bored face');
    const was = SH.sheetArea(top.sheet);
    out.dispose();

    doc.features.push({
      id: 'untr',
      type: 'untrimSurface',
      surfaces: [top.id],
      outer: false
    });
    const after = rebuild(doc);
    assert(after.errors.length === 0, after.errors.map((e) => e.message).join('; '));
    const now = after.bodies.find((b) => b.id === top.id);
    assert(now && !now.solid, 'it is still that surface');
    near(SH.sheetArea(now.sheet), was + bore, bore * 0.03, 'with the bore filled in');
    assert(SH.boundaryLoops(now.sheet).length === 1, 'and no hole left');
    after.dispose();
  });

  test('merge: several surfaces become one, and stay a surface', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '40', height: '10', centered: true }),
      { id: 'unst', type: 'unstitch', bodies: 'all' }
    ];
    const first = rebuild(doc);
    const sheets = first.bodies.filter((b) => !b.solid);
    assert(sheets.length === 6, `six faces, got ${sheets.length}`);
    const total = sheets.reduce((a, b) => a + SH.sheetArea(b.sheet), 0);
    first.dispose();

    doc.features.push({
      id: 'mrg',
      type: 'mergeSurface',
      surfaces: sheets.map((b) => b.id),
      tolerance: '0.01'
    });
    const out = rebuild(doc);
    const left = out.bodies.filter((b) => !b.solid);
    assert(left.length === 1, `one surface body, got ${left.length}`);
    assert(!out.bodies.some((b) => b.solid), 'and no solid: merge is not stitch');
    near(SH.sheetArea(left[0].sheet), total, 1e-6, 'the whole area came across');
    // It did close, so it says so rather than leaving that a surprise.
    assert(
      out.errors.some((e) => /Stitch/.test(e.message)),
      'and it points at Stitch for the solid'
    );
    out.dispose();
  });

  test('merge: one surface on its own is refused', () => {
    const doc = newDocument();
    const sk = openCurveSketch('XY');
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: 'sx', type: 'surfaceExtrude', sketch: sk.id, distance: '10' },
      { id: 'mrg', type: 'mergeSurface', surfaces: ['sx:0'], tolerance: '0.01' }
    ];
    const out = rebuild(doc);
    assert(
      out.errors.some((e) => /two or more/.test(e.message)),
      `it says what it needs, got ${out.errors.map((e) => e.message).join('; ')}`
    );
    assert(out.bodies.filter((b) => !b.solid).length === 1, 'and the surface survives');
    out.dispose();
  });

  /* -------- design advice and printing -------- */

  /** A body, its mesh and its topology, in the shape the advice wants. */
  function adviceEntry(doc, name = 'part') {
    const out = rebuild(doc);
    const body = out.bodies.find((b) => b.solid);
    const mesh = K.meshData(body.solid);
    return { out, entry: { id: body.id, name, mesh, topo: buildTopology(mesh) } };
  }

  test('advice: a thin wall is measured through the material', () => {
    // A plate 40 by 40 by 1. Every reading through it is 1, so the thinnest
    // wall is 1 and nothing else is.
    const doc = newDocument();
    doc.features = [prim('box', { width: '40', depth: '40', height: '1', centered: true })];
    const { out, entry } = adviceEntry(doc, 'plate');
    const top = entry.topo.faces.reduce((b, f, i) =>
      f.centre[2] > entry.topo.faces[b].centre[2] ? i : b, 0);
    const face = entry.topo.faces[top];
    near(thicknessAt(entry.mesh, face.centre, face.normal), 1, 0.01, 'straight through the plate');

    const found = designAdvice([entry], { minWall: 2, minFeature: 0.4 });
    const thin = found.find((f) => f.kind === 'thinWall');
    assert(thin, `it flagged the wall, got ${found.map((f) => f.kind).join(', ') || 'nothing'}`);
    near(thin.value, 1, 0.02, 'and said how thin');
    out.dispose();
  });

  test('advice: a wall thick enough is not flagged', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '40', depth: '40', height: '20', centered: true })];
    const { out, entry } = adviceEntry(doc, 'block');
    const found = designAdvice([entry], { minWall: 2, minFeature: 0.4 });
    assert(!found.some((f) => f.kind === 'thinWall'), 'a 20 thick block is not a thin wall');
    out.dispose();
  });

  test('advice: a bore too narrow to print is called out, faceted or not', () => {
    // A 0.6 bore comes out of the kernel as a ring of flats rather than a
    // cylinder, which is exactly why this is measured by looking across the
    // hole rather than by recognising it as one.
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '40', height: '10', centered: true }),
      { ...prim('cylinder', { diameter: '0.6', height: '40', centered: true }), op: 'cut', targets: 'all' }
    ];
    const { out, entry } = adviceEntry(doc, 'plate');
    assert(
      !entry.topo.faces.some((f) => f.cylinder),
      'the bore really is too small to read as a cylinder'
    );
    const found = designAdvice([entry], { minWall: 0.5, minFeature: 0.8 });
    const small = found.find((f) => f.kind === 'narrowGap');
    assert(small, `it found the bore, got ${found.map((f) => f.kind).join(', ') || 'nothing'}`);
    assert(small.value < 0.62, `and measured it across, got ${small.value.toFixed(3)}`);
    out.dispose();
  });

  test('advice: a bore wide enough is left alone', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '40', depth: '40', height: '10', centered: true }),
      { ...prim('cylinder', { diameter: '8', height: '40', centered: true }), op: 'cut', targets: 'all' }
    ];
    const { out, entry } = adviceEntry(doc, 'plate');
    const found = designAdvice([entry], { minWall: 0.5, minFeature: 0.8 });
    assert(!found.some((f) => f.kind === 'narrowGap'), 'an 8 bore is not a narrow gap');
    out.dispose();
  });

  test('advice: a box sitting on the plate has nothing to say about contact', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '40', depth: '40', height: '20', centered: false })];
    const { out, entry } = adviceEntry(doc, 'block');
    const found = designAdvice([entry], { minWall: 1, minFeature: 0.4 });
    assert(!found.some((f) => f.kind === 'contact'), 'a flat bottom is a flat bottom');
    assert(!found.some((f) => f.kind === 'overhang'), 'and a box has no overhang');
    out.dispose();
  });

  test('advice: a sphere is all overhang and touches nothing', () => {
    const doc = newDocument();
    doc.features = [prim('sphere', { diameter: '30' })];
    const { out, entry } = adviceEntry(doc, 'ball');
    const found = designAdvice([entry], { minWall: 1, minFeature: 0.4 });
    assert(found.some((f) => f.kind === 'overhang'), 'the underside overhangs');
    assert(found.some((f) => f.kind === 'contact'), 'and it balances on a point');
    out.dispose();
  });

  test('advice: a part bigger than the bed says so, with the numbers', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '400', depth: '40', height: '20', centered: true })];
    const { out, entry } = adviceEntry(doc, 'beam');
    const size = meshSize(entry.mesh);
    near(size[0], 400, 1e-3, 'four hundred long');
    const found = designAdvice([entry], { minWall: 1, minFeature: 0.4, bed: [256, 256, 256] });
    const bed = found.find((f) => f.kind === 'bed');
    assert(bed, 'it will not fit');
    assert(/400/.test(bed.message), `and the message says how big: ${bed.message}`);

    const fits = designAdvice([entry], { minWall: 1, minFeature: 0.4, bed: [500, 500, 500] });
    assert(!fits.some((f) => f.kind === 'bed'), 'on a bigger bed it is not mentioned');
    out.dispose();
  });

  test('advice: a turned box still fits a bed it fits diagonally along', () => {
    // 300 by 40 does not fit 256 by 256 either way round, but 200 by 300 does
    // once it is turned, and saying otherwise sends someone to cut a model up
    // for no reason.
    const doc = newDocument();
    doc.features = [prim('box', { width: '200', depth: '300', height: '20', centered: true })];
    const { out, entry } = adviceEntry(doc, 'panel');
    const found = designAdvice([entry], { minWall: 1, minFeature: 0.4, bed: [320, 220, 300] });
    assert(!found.some((f) => f.kind === 'bed'), 'turned round, it fits');
    out.dispose();
  });

  await asyncTest('3MF: what is written comes back the same', async () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '20', depth: '30', height: '40', centered: true })];
    const out = rebuild(doc);
    const mesh = K.meshData(out.bodies[0].solid);
    const bytes = to3MF([mesh], ['Block']);
    assert(bytes[0] === 0x50 && bytes[1] === 0x4b, 'it is a zip');

    const back = await parse3MF(bytes);
    assert(
      back.triVerts.length === mesh.triVerts.length,
      `same triangles, ${back.triVerts.length / 3} against ${mesh.triVerts.length / 3}`
    );
    const size = meshSize(back);
    near(size[0], 20, 1e-3, 'and the same size in x');
    near(size[1], 30, 1e-3, 'y');
    near(size[2], 40, 1e-3, 'z');
    out.dispose();
  });

  await asyncTest('3MF: two bodies stay two objects with their own names', async () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '10', depth: '10', height: '10', centered: true }),
      prim('sphere', { diameter: '10' })
    ];
    const out = rebuild(doc);
    const solids = out.bodies.filter((b) => b.solid);
    assert(solids.length === 2, `two bodies, got ${solids.length}`);
    const bytes = to3MF(solids.map((b) => K.meshData(b.solid)), ['Cube', 'Ball']);
    const text = new TextDecoder().decode(bytes);
    assert(text.includes('name="Cube"'), 'the first name went in');
    assert(text.includes('name="Ball"'), 'and the second');
    assert(text.includes('unit="millimeter"'), 'and it says what unit it is in');
    out.dispose();
  });

  await asyncTest('3MF: a name with an ampersand in it does not break the file', async () => {
    const mesh = {
      numProp: 3,
      vertProperties: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      triVerts: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3])
    };
    const bytes = to3MF([mesh], ['Bracket & Pin <left>']);
    const text = new TextDecoder().decode(bytes);
    assert(!/name="[^"]*&(?!amp;|lt;|gt;|quot;|apos;)/.test(text), 'the ampersand was escaped');
    const back = await parse3MF(bytes);
    assert(back.triVerts.length === 12, 'and it still reads back');
  });

  test('zip: a stored archive has the sizes and the checksum in it', () => {
    const bytes = zipStore([{ name: 'a.txt', data: 'hello' }]);
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    assert(dv.getUint32(0, true) === 0x04034b50, 'a local header first');
    assert(dv.getUint16(8, true) === 0, 'stored, not deflated');
    assert(dv.getUint32(18, true) === 5, 'five bytes compressed');
    assert(dv.getUint32(22, true) === 5, 'and five uncompressed');
    // The CRC32 of "hello" is a fixed number, so a wrong table shows up here.
    assert(dv.getUint32(14, true) === 0x3610a686, 'and the checksum is right');
  });

  test('surfaces are listed apart from solids', () => {
    const doc = newDocument();
    const sk = openCurveSketch('XY');
    doc.sketches[sk.id] = sk;
    doc.features = [
      prim('box', {}),
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: uid('f'), type: 'surfaceExtrude', sketch: sk.id, distance: '10' }
    ];
    const out = rebuild(doc);
    assert(out.bodies.filter((b) => b.solid).length === 1, 'one solid');
    assert(out.bodies.filter((b) => !b.solid).length === 1, 'and one surface');
    // Nothing about a sheet should have reached the kernel.
    assert(out.bodies.find((b) => !b.solid).sheet.numProp === 3, 'the surface is a mesh');
  });

  test('topology: an open surface has selectable rim edges', () => {
    const doc = newDocument();
    const sk = openCurveSketch('XY');
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: uid('f'), type: 'surfaceExtrude', sketch: sk.id, distance: '10' }
    ];
    const out = rebuild(doc);
    const topo = buildTopology(out.bodies[0].sheet);
    assert(topo.open, 'the topology says it is open');
    const rim = topo.edges.filter((e) => e.boundary);
    assert(rim.length > 0, `and the rim edges are there, ${rim.length} of them`);
    assert(
      rim.every((e) => e.faceB === -1),
      'each with nothing on the far side'
    );
  });

  /* -------- batch 8: sheet metal -------- */

  const SM_T = 2;
  const SM_R = 2;
  const SM_K = 0.44;
  const SM_XY = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };

  /** A plate with one flange folded up off its far edge. */
  function bracketPart(angleDeg = 90, height = 20) {
    const part = SM.newPart({});
    SM.addBasePanel(part, [[0, 0], [60, 0], [60, 40], [0, 40]], [], SM_XY, 'p0');
    SM.addFlangePanel(
      part,
      'p0',
      { a: [60, 0], b: [60, 40] },
      {
        angle: (angleDeg * Math.PI) / 180,
        radius: SM_R,
        height,
        panelId: 'p1',
        bendId: 'b0',
        relief: false
      }
    );
    return part;
  }

  test('sheet metal: the bend allowance is the neutral axis arc', () => {
    // A quarter turn of a 2 mm radius in 2 mm stock at K 0.44.
    const want = (Math.PI / 2) * (2 + 0.44 * 2);
    near(SM.bendAllowance(Math.PI / 2, 2, 2, 0.44), want, 1e-12, 'a right angle');
    near(SM.bendAllowance(Math.PI, 2, 2, 0.44), 2 * want, 1e-12, 'twice for twice the turn');
    // A sharper radius eats less material, which is the whole reason it matters.
    assert(
      SM.bendAllowance(Math.PI / 2, 1, 2, 0.44) < SM.bendAllowance(Math.PI / 2, 3, 2, 0.44),
      'a tighter radius takes less flat'
    );
    // K is what the number turns on, so it has to reach the answer.
    assert(
      SM.bendAllowance(Math.PI / 2, 2, 2, 0.5) > SM.bendAllowance(Math.PI / 2, 2, 2, 0.3),
      'and the K factor moves it'
    );
  });

  test('sheet metal: bend deduction agrees with the allowance', () => {
    // The two are the same fact from either end: the deduction is what the
    // folded legs are short by once the allowance is taken out.
    const a = Math.PI / 2;
    const setback = (SM_R + SM_T) * Math.tan(a / 2);
    near(
      SM.bendDeduction(a, SM_R, SM_T, SM_K),
      2 * setback - SM.bendAllowance(a, SM_R, SM_T, SM_K),
      1e-12,
      'two setbacks less the allowance'
    );
  });

  test('sheet metal: a folded bracket measures what it should', () => {
    const part = bracketPart();
    const scope = new K.Scope();
    const solid = SM.buildPart(part, scope, { thickness: SM_T, kFactor: SM_K });
    assert(solid, 'it built');
    assert(K.status(solid) === 'NoError', `a real solid, got ${K.status(solid)}`);
    assert(solid.genus() === 0, 'and a plain one');

    // Plate, plus a quarter annulus of the bend, plus the flange.
    const plate = 60 * 40 * SM_T;
    const arc = (Math.PI / 4) * ((SM_R + SM_T) ** 2 - SM_R ** 2) * 40;
    const flange = 20 * 40 * SM_T;
    near(solid.volume(), plate + arc + flange, 2, 'plate plus bend plus flange');

    // The flange folds up, and its outside face lands a radius and a thickness
    // past the edge it came off: 60 plus 2 plus 2.
    const bb = solid.boundingBox();
    near(bb.max[0], 64, 0.01, 'the flange stands just past the plate');
    near(bb.max[1], 40, 0.01, 'and is as wide as the edge it grew from');
    // Bend centre at 4 up, then 20 of flange from the end of the arc.
    near(bb.max[2], 24, 0.01, 'and reaches the flange height above the bend');
    near(bb.min[2], 0, 0.01, 'with the plate still on the plane it was drawn on');
    scope.dispose();
  });

  test('sheet metal: a negative angle folds the other way', () => {
    const part = bracketPart(-90);
    const scope = new K.Scope();
    const solid = SM.buildPart(part, scope, { thickness: SM_T, kFactor: SM_K });
    // The bend centre sits a radius below the plate, and the flange runs its
    // full height on from the end of the arc, so the reach is 2 plus 20 and
    // not 20. It is the mirror of the fold upward, which reaches 4 plus 20.
    const bb = solid.boundingBox();
    near(bb.min[2], -22, 0.05, 'the flange hangs below the plate');
    near(bb.max[2], 2, 0.01, 'and the plate is still where it was');
    scope.dispose();
  });

  test('sheet metal: the flat is the legs plus the allowance, and no more', () => {
    const part = bracketPart();
    const scope = new K.Scope();
    const flat = SM.buildPart(part, scope, {
      thickness: SM_T,
      kFactor: SM_K,
      flat: true
    });
    assert(flat, 'it laid out');
    const ba = SM.bendAllowance(Math.PI / 2, SM_R, SM_T, SM_K);
    near(flat.volume(), (60 + ba + 20) * 40 * SM_T, 0.01, 'one flat sheet');

    const bb = flat.boundingBox();
    near(bb.max[0] - bb.min[0], 60 + ba + 20, 0.01, 'as long as the stock has to be');
    near(bb.max[2] - bb.min[2], SM_T, 1e-6, 'and one thickness, since it is flat');
    scope.dispose();
  });

  test('sheet metal: unfolding one bend is the flat, folding it back is not', () => {
    const part = bracketPart();
    const scope = new K.Scope();
    const folded = SM.buildPart(part, scope, { thickness: SM_T, kFactor: SM_K });
    const tall = folded.boundingBox().max[2];

    part.bends[0].unfolded = true;
    const open = SM.buildPart(part, scope, { thickness: SM_T, kFactor: SM_K });
    const flat = SM.buildPart(part, scope, { thickness: SM_T, kFactor: SM_K, flat: true });
    near(open.volume(), flat.volume(), 0.01, 'an unfolded bend is the flat');
    near(open.boundingBox().max[2], SM_T, 1e-6, 'and it lies down');

    part.bends[0].unfolded = false;
    const again = SM.buildPart(part, scope, { thickness: SM_T, kFactor: SM_K });
    near(again.boundingBox().max[2], tall, 1e-6, 'refolding puts it back exactly');
    scope.dispose();
  });

  test('sheet metal: a contour section folds into a channel', () => {
    // Three legs, two right angles: a channel, which is the shape a contour
    // flange is for.
    const part = SM.newPart({});
    SM.addBasePanel(part, [[0, 0], [30, 0], [30, 50], [0, 50]], [], SM_XY, 'p0');
    SM.addFlangePanel(part, 'p0', { a: [30, 0], b: [30, 50] }, {
      angle: Math.PI / 2, radius: SM_R, height: 25,
      panelId: 'p1', bendId: 'b0', relief: false
    });
    const scope = new K.Scope();
    const solid = SM.buildPart(part, scope, { thickness: SM_T, kFactor: SM_K });
    assert(K.status(solid) === 'NoError', 'a real solid');
    // Both legs and the bend between them, all 50 wide.
    const arc = (Math.PI / 4) * ((SM_R + SM_T) ** 2 - SM_R ** 2) * 50;
    near(solid.volume(), 30 * 50 * SM_T + arc + 25 * 50 * SM_T, 2, 'two legs and a bend');
    scope.dispose();
  });

  test('sheet metal: a fold splits a panel and turns half of it', () => {
    const part = SM.newPart({});
    SM.addBasePanel(part, [[0, 0], [80, 0], [80, 40], [0, 40]], [], SM_XY, 'p0');
    const made = SM.foldPanel(part, 'p0', { a: [50, 0], b: [50, 40] }, {
      angle: Math.PI / 2,
      radius: SM_R,
      thickness: SM_T,
      k: SM_K,
      flip: false,
      bendLinePosition: 'center',
      panelId: 'p1',
      bendId: 'b0'
    });
    assert(made, 'it folded');
    assert(part.panels.length === 2, 'into two panels');

    const scope = new K.Scope();
    const flat = SM.buildPart(part, scope, { thickness: SM_T, kFactor: SM_K, flat: true });
    // Centred on the line, the flat is the same 80 long it started as: the
    // allowance replaces exactly the material the bend was centred over.
    near(flat.boundingBox().max[0] - flat.boundingBox().min[0], 80, 0.01, 'no stock gained or lost');

    const folded = SM.buildPart(part, scope, { thickness: SM_T, kFactor: SM_K });
    assert(folded.boundingBox().max[2] > 20, 'and the far half stands up');
    scope.dispose();
  });

  test('sheet metal: the flat outline carries the cut and the bend lines', () => {
    const part = bracketPart();
    const outline = SM.flatOutline(part, SM_T, SM_K);
    assert(outline.panels.length === 2, 'both panels');
    assert(outline.bendLines.length === 2, 'and both edges of the one bend zone');

    const xs = outline.panels.flat().map((p) => p[0]);
    const ba = SM.bendAllowance(Math.PI / 2, SM_R, SM_T, SM_K);
    near(Math.max(...xs), 60 + ba + 20, 0.01, 'as long as the stock');

    // The bend zone is exactly the allowance wide, and starts at the plate.
    const bx = outline.bendLines.map((l) => l[0][0]).sort((a, b) => a - b);
    near(bx[0], 60, 0.01, 'the bend starts where the plate ends');
    near(bx[1], 60 + ba, 0.01, 'and ends an allowance later');
  });

  test('sheet metal: the DXF reads back through the app own DXF reader', () => {
    // The strongest check available: written by one half of the app and parsed
    // by the other, so a DXF that is wrong in a way a machine would notice is
    // wrong here too.
    const part = bracketPart();
    const outline = SM.flatOutline(part, SM_T, SM_K);
    const text = SM.flatToDXF(outline);
    const back = parseDXF(text).entities;

    const polys = back.filter((e) => e.kind === 'poly');
    assert(polys.length >= 3, `the cuts and the bend lines came back, got ${polys.length}`);
    const closed = polys.filter((e) => e.closed);
    assert(closed.length === 2, `two closed cut outlines, got ${closed.length}`);

    const xs = closed.flatMap((e) => e.points.map((q) => q.x));
    const ba = SM.bendAllowance(Math.PI / 2, SM_R, SM_T, SM_K);
    near(Math.min(...xs), 0, 0.01, 'and it measures from where it should');
    near(Math.max(...xs), 60 + ba + 20, 0.01, 'to the full length of the stock');

    const ys = closed.flatMap((e) => e.points.map((q) => q.y));
    near(Math.max(...ys) - Math.min(...ys), 40, 0.01, 'and is the right width');
  });

  test('sheet metal: relief notches are cut where a flange is narrower', () => {
    const part = SM.newPart({});
    SM.addBasePanel(part, [[0, 0], [60, 0], [60, 40], [0, 40]], [], SM_XY, 'p0');
    // A flange over the middle 20 of a 40 wide edge, so both ends need relief.
    SM.addFlangePanel(part, 'p0', { a: [60, 0], b: [60, 40] }, {
      angle: Math.PI / 2, radius: SM_R, height: 15,
      v0: 10, v1: 30,
      panelId: 'p1', bendId: 'b0', relief: true
    });
    const rule = {
      reliefShape: 'square',
      reliefWidth: SM_T,
      reliefDepth: SM_T + SM_R
    };
    const cuts = SM.reliefCuts(part, part.bends[0], SM_T, rule);
    assert(cuts.length === 2, `a notch at each end, got ${cuts.length}`);
    for (const poly of cuts) assert(poly.length >= 4, 'each with a real outline');

    // A flange that spans the whole edge needs none.
    const full = SM.newPart({});
    SM.addBasePanel(full, [[0, 0], [60, 0], [60, 40], [0, 40]], [], SM_XY, 'q0');
    SM.addFlangePanel(full, 'q0', { a: [60, 0], b: [60, 40] }, {
      angle: Math.PI / 2, radius: SM_R, height: 15,
      panelId: 'q1', bendId: 'c0', relief: true
    });
    assert(SM.reliefCuts(full, full.bends[0], SM_T, rule).length === 0, 'and none when it does not');
  });

  /** A plate with a flange off two adjoining edges, which is one corner. */
  function trayPart(height = 15) {
    const part = SM.newPart({ thickness: SM_T, bendRadius: SM_R });
    SM.addBasePanel(part, [[0, 0], [60, 0], [60, 40], [0, 40]], [], SM_XY, 'p0');
    SM.addFlangePanel(part, 'p0', { a: [60, 0], b: [60, 40] }, {
      angle: Math.PI / 2, radius: SM_R, height, panelId: 'p1', bendId: 'b0'
    });
    SM.addFlangePanel(part, 'p0', { a: [0, 40], b: [60, 40] }, {
      angle: Math.PI / 2, radius: SM_R, height, panelId: 'p2', bendId: 'b1'
    });
    return part;
  }

  /* -------- construction, the new kinds -------- */


  /** Build one construction entry against a box and hand back what it made. */
  function builtConstruction(entry, size = 40) {
    const doc = boxDoc(size, size, size);
    doc.features.push({ id: uid('f'), type: 'construction', entry });
    const res = rebuild(doc);
    const got = res.construction?.get(entry.id) || null;
    return { got, res, topo: buildTopology(K.meshData(res.bodies[0].solid)) };
  }

  test('construct: a plane square across an axis faces along it', () => {
    const { got, res } = builtConstruction({
      id: 'cx1',
      type: 'planePerpendicular',
      axis: { worldAxis: 'z' },
      point: null
    });
    assert(got, 'it built');
    assert(got.kind === 'plane', `a plane, got ${got.kind}`);
    // Square across Z means its normal is Z, whatever else is true of it.
    near(Math.abs(got.n[2]), 1, 1e-9, 'facing along the axis');
    near(got.n[0], 0, 1e-9, 'and along nothing else');
    near(got.n[1], 0, 1e-9, 'in either direction');
    // The two in-plane directions have to be square to it and to each other,
    // or a sketch on this plane comes out sheared.
    near(dot3(got.x, got.n), 0, 1e-9, 'x lies in the plane');
    near(dot3(got.y, got.n), 0, 1e-9, 'y lies in the plane');
    near(dot3(got.x, got.y), 0, 1e-9, 'and they are square to each other');
    res.dispose();
  });

  test('construct: a plane through two edges holds both of them', () => {
    // Two edges of the box top. They meet at a corner, so there is exactly one
    // plane through them and it is the top face's own.
    const first = rebuild(boxDoc(40, 40, 40)).bodies[0];
    const topo0 = buildTopology(K.meshData(first.solid));
    const top = topo0.faces.reduce((b, f, i) => (f.centre[2] > topo0.faces[b].centre[2] ? i : b), 0);
    const rim = topo0.edges.filter((e) => e.faceA === top || e.faceB === top);
    assert(rim.length >= 2, 'the top has edges');

    const { got, res } = builtConstruction({
      id: 'cx2',
      type: 'planeTwoEdges',
      edgeA: edgeReference(rim[0], topo0),
      edgeB: edgeReference(rim[1], topo0)
    });
    assert(got, 'it built');
    assert(got.kind === 'plane', `a plane, got ${got.kind}`);
    // Both edges lie in it, which is the whole claim.
    for (const e of [rim[0], rim[1]]) {
      for (const p of e.points) {
        const off = dot3([p[0] - got.origin[0], p[1] - got.origin[1], p[2] - got.origin[2]], got.n);
        near(off, 0, 1e-4, 'the edge lies in the plane');
      }
    }
    res.dispose();
  });

  test('construct: skew edges share no plane, and it says so', () => {
    // The top front edge and the bottom right edge of a box never meet and are
    // not parallel. Any plane through both would be a lie.
    const first = rebuild(boxDoc(40, 40, 40)).bodies[0];
    const topo0 = buildTopology(K.meshData(first.solid));
    const lines = topo0.edges.filter((e) => e.kind === 'line');
    let a = null;
    let b = null;
    for (const x of lines) {
      for (const y of lines) {
        if (x === y) continue;
        const par = Math.abs(dot3(x.dir, y.dir));
        if (par > 0.99) continue;
        // Not touching: every end of one is far from every end of the other.
        const ends = (e) => [e.points[0], e.points[e.points.length - 1]];
        const far = ends(x).every((p) =>
          ends(y).every((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1)
        );
        if (far) {
          a = x;
          b = y;
          break;
        }
      }
      if (a) break;
    }
    assert(a && b, 'found two edges that neither meet nor run parallel');

    const { got, res } = builtConstruction({
      id: 'cx3',
      type: 'planeTwoEdges',
      edgeA: edgeReference(a, topo0),
      edgeB: edgeReference(b, topo0)
    });
    assert(!got, 'skew edges are refused rather than averaged');
    res.dispose();
  });

  test('construct: a point where two edges meet is the corner', () => {
    // Two edges of one face share a corner, and that corner is a vertex of the
    // box, so the answer is known to the millimetre before the test runs.
    const first = rebuild(boxDoc(40, 40, 40)).bodies[0];
    const topo0 = buildTopology(K.meshData(first.solid));
    const lines = topo0.edges.filter((e) => e.kind === 'line');
    const endsOf = (e) => [e.points[0], e.points[e.points.length - 1]];

    let a = null;
    let b = null;
    let corner = null;
    for (const x of lines) {
      for (const y of lines) {
        if (x === y || Math.abs(dot3(x.dir, y.dir)) > 0.01) continue;
        for (const p of endsOf(x)) {
          for (const q of endsOf(y)) {
            if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6) {
              a = x;
              b = y;
              corner = p;
            }
          }
        }
        if (a) break;
      }
      if (a) break;
    }
    assert(a && b, 'found two edges meeting at a corner');

    const { got, res } = builtConstruction({
      id: 'cx4',
      type: 'pointTwoEdges',
      edgeA: edgeReference(a, topo0),
      edgeB: edgeReference(b, topo0)
    });
    assert(got && got.kind === 'point', 'it built a point');
    for (let i = 0; i < 3; i++) {
      near(got.p[i], corner[i], 1e-4, `on the corner, axis ${i}`);
    }
    res.dispose();
  });

  /* -------- spun profile -------- */

  /** One body from a document, with its mesh, ready to measure. */
  function oneMesh(doc) {
    const out = rebuild(doc);
    const body = out.bodies.find((b) => b.solid);
    return { out, mesh: K.meshData(body.solid) };
  }

  test('spun: a bar reads as solid to the axis, at the corner radius', () => {
    // A six sided prism 10 across the flats. Spun, it is a bar as wide as its
    // corners, which is 10 over the cosine of thirty degrees.
    const doc = newDocument();
    const sk = newSketch('XY', 'Hex');
    const R = 5 / Math.cos(Math.PI / 6);
    sk.points = [];
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      sk.points.push({ x: R * Math.cos(a), y: R * Math.sin(a) });
    }
    sk.entities = [];
    for (let i = 0; i < 6; i++) {
      sk.entities.push({ id: i + 1, type: 'line', p: [i, (i + 1) % 6] });
    }
    sk.nextEntityId = 7;
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: uid('f'), type: 'extrude', sketch: sk.id, distance: '30', direction: 'one' }
    ];
    const { out, mesh } = oneMesh(doc);

    const got = spunProfile(mesh, { origin: [0, 0, 0], dir: [0, 0, 1] });
    assert(got, 'it measured something');
    // The whole point of measuring through the material: a hexagon's corners
    // are all at one radius, so reading the points alone would call a solid bar
    // a hollow tube.
    assert(!got.hollow, 'a solid bar, not a tube');
    near(got.maxRadius, R, R * 0.01, 'as wide as the corners');
    near(got.length, 30, 0.01, 'and as long as it is');
    out.dispose();
  });

  test('spun: a tube reads as a tube, with both radii', () => {
    const doc = newDocument();
    doc.features = [
      prim('pipe', { diameter: '20', wall: '3', height: '25', centered: true })
    ];
    const { out, mesh } = oneMesh(doc);
    const got = spunProfile(mesh, { origin: [0, 0, 0], dir: [0, 0, 1] });
    assert(got && got.hollow, 'it is hollow');
    near(got.maxRadius, 10, 0.2, 'ten out');
    near(got.minRadius, 7, 0.2, 'and seven in');
    near(got.length, 25, 0.01, 'the length it was made');
    out.dispose();
  });

  test('spun: a bar off to one side spins out to a ring, not a bar', () => {
    // A block sitting away from the axis sweeps an annulus. This is the check
    // that the reading is about the axis given rather than about the shape's
    // own middle.
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '4', depth: '4', height: '10', centered: true, x: '20' })
    ];
    const { out, mesh } = oneMesh(doc);
    const got = spunProfile(mesh, { origin: [0, 0, 0], dir: [0, 0, 1] }, { spokes: 24 });
    assert(got && got.hollow, 'it sweeps a ring');
    assert(got.minRadius > 16 && got.minRadius < 19, `inner about 18, got ${got.minRadius.toFixed(2)}`);
    assert(got.maxRadius > 21 && got.maxRadius < 23, `outer about 22, got ${got.maxRadius.toFixed(2)}`);
    out.dispose();
  });

  test('spun: the outline closes, and closes onto the axis when it is solid', () => {
    const doc = newDocument();
    doc.features = [prim('cylinder', { diameter: '20', height: '30', centered: true })];
    const { out, mesh } = oneMesh(doc);
    const got = spunProfile(mesh, { origin: [0, 0, 0], dir: [0, 0, 1] });
    assert(!got.hollow, 'a solid cylinder is solid');
    near(got.loop[0][1], 0, 1e-9, 'the outline starts on the axis');
    near(got.loop[got.loop.length - 1][1], 0, 1e-9, 'and finishes on it');
    // Every reading is the same radius, because a cylinder is the one shape
    // whose spun profile is itself.
    const radii = got.outer.map((pt) => pt[1]);
    near(Math.max(...radii) - Math.min(...radii), 0, 0.01, 'and it is straight along its length');
    out.dispose();
  });

  /* -------- coordinate systems -------- */

  test('ucs: a frame is square even when the picks are not', () => {
    // X along the world X, and a second direction deliberately off at a slant.
    // Y has to come out square to X, not where it was pointed.
    const doc = boxDoc(40, 40, 40);
    doc.features.push({
      id: uid('f'),
      type: 'construction',
      entry: {
        id: 'ucs1',
        name: 'Fixture',
        type: 'ucs',
        axisX: { worldAxis: 'x' },
        axisY: { worldAxis: 'y' }
      }
    });
    const res = rebuild(doc);
    const got = res.construction.get('ucs1');
    assert(got && got.kind === 'ucs', `it built, got ${got && got.kind}`);
    near(dot3(got.x, got.y), 0, 1e-9, 'x and y are square');
    near(dot3(got.y, got.z), 0, 1e-9, 'y and z are square');
    near(dot3(got.z, got.x), 0, 1e-9, 'z and x are square');
    for (const v of [got.x, got.y, got.z]) {
      near(Math.hypot(v[0], v[1], v[2]), 1, 1e-9, 'and every one of them is a unit');
    }
    // Right handed, so a rotation about z takes x towards y the way it does in
    // the world.
    const xy = [
      got.x[1] * got.y[2] - got.x[2] * got.y[1],
      got.x[2] * got.y[0] - got.x[0] * got.y[2],
      got.x[0] * got.y[1] - got.x[1] * got.y[0]
    ];
    near(dot3(xy, got.z), 1, 1e-9, 'and it is right handed');
    res.dispose();
  });

  test('ucs: its three planes and three axes can be referenced', () => {
    const doc = boxDoc(40, 40, 40);
    doc.features.push({
      id: uid('f'),
      type: 'construction',
      entry: {
        id: 'ucs2',
        name: 'Fixture',
        type: 'ucs',
        axisX: { worldAxis: 'y' },
        axisY: { worldAxis: 'z' }
      }
    });
    const res = rebuild(doc);
    for (const part of ['xy', 'xz', 'yz']) {
      const got = res.construction.get(`ucs2/${part}`);
      assert(got && got.kind === 'plane', `${part} is a plane`);
      near(dot3(got.x, got.y), 0, 1e-9, `${part} is not sheared`);
      near(dot3(got.n, got.x), 0, 1e-9, `${part}'s normal is square to it`);
    }
    for (const part of ['x', 'y', 'z']) {
      const got = res.construction.get(`ucs2/${part}`);
      assert(got && got.kind === 'axis', `${part} is an axis`);
    }
    const at = res.construction.get('ucs2/origin');
    assert(at && at.kind === 'point', 'and there is a point at its origin');
    // Named for the frame, so a dropdown reads "Fixture XY" and not an id.
    assert(/Fixture/.test(res.construction.get('ucs2/xy').name), 'the planes carry its name');
    res.dispose();
  });

  test('ucs: a sketch can be drawn on one of its planes', () => {
    // The whole reason to have one: a rectangle drawn on the frame's own XY
    // comes out where the frame is, not where the world is.
    const doc = newDocument();
    doc.features.push({
      id: uid('f'),
      type: 'construction',
      entry: {
        id: 'ucs3',
        name: 'Tilted',
        type: 'ucs',
        axisX: { worldAxis: 'y' },
        axisY: { worldAxis: 'z' }
      }
    });
    const sk = rectSketch(20, 10);
    sk.plane = { construction: 'ucs3/xy' };
    doc.sketches[sk.id] = sk;
    doc.features.push(
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: uid('f'), type: 'extrude', sketch: sk.id, distance: '5', direction: 'one' }
    );
    const out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    const body = out.bodies.find((b) => b.solid);
    assert(body, 'it made something');
    near(body.solid.volume(), 20 * 10 * 5, 1, 'the right size');
    // The frame's z is the world x, so the extrude went along world x.
    const mesh = K.meshData(body.solid);
    const size = meshSize(mesh);
    near(size[0], 5, 0.01, 'pushed along the frame, which here is world x');
    out.dispose();
  });

  /* -------- hems -------- */

  const SM_FRAME = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };

  /** A flat plate as a sheet metal part, ready to have an edge folded. */
  function hemPart(thickness = 1.5) {
    const part = SM.newPart({ thickness, bendRadius: thickness, kFactor: 0.4 });
    SM.addBasePanel(part, [[0, 0], [60, 0], [60, 40], [0, 40]], [], SM_FRAME, 'p0');
    return part;
  }

  test('hem: each kind folds the number of times it should', () => {
    const counts = { single: 1, teardrop: 2, rolled: 1, double: 2 };
    for (const [kind, folds] of Object.entries(counts)) {
      const part = hemPart();
      const made = SM.addHem(part, 'p0', { a: [0, 40], b: [60, 40] }, {
        kind,
        thickness: 1.5,
        radius: 1.5,
        length: 6,
        id: 'h'
      });
      assert(made && made.length === folds, `${kind} folds ${folds} times, got ${made?.length}`);
      assert(part.panels.length === folds + 1, `${kind} leaves the right panels`);
      assert(part.bends.length === folds, `${kind} leaves the right bends`);
    }
  });

  test('hem: a single hem is folded right back on itself', () => {
    const part = hemPart();
    SM.addHem(part, 'p0', { a: [0, 40], b: [60, 40] }, {
      kind: 'single',
      thickness: 1.5,
      radius: 1.5,
      length: 6,
      id: 'h'
    });
    near(part.bends[0].angle, Math.PI, 1e-9, 'half a turn is what makes it a hem');
    const frames = SM.resolveFrames(part, 1.5, 0.4, {});
    assert(frames.size === 2, 'and both panels are placed');
    // Folded back means the hem lies parallel to the panel it came off, facing
    // the other way.
    const base = frames.get('p0');
    const hem = frames.get('h:p0');
    const dot = base.n[0] * hem.n[0] + base.n[1] * hem.n[1] + base.n[2] * hem.n[2];
    near(dot, -1, 1e-6, 'the hem faces back at the panel');
  });

  test('hem: relief is cut where it leaves the panel, and only there', () => {
    const part = hemPart();
    SM.addHem(part, 'p0', { a: [0, 40], b: [60, 40] }, {
      kind: 'double',
      thickness: 1.5,
      radius: 1.5,
      length: 6,
      relief: true,
      id: 'h'
    });
    assert(part.bends[0].relief === true, 'the first fold gets relief');
    assert(part.bends[1].relief === false, 'and the second does not, or it cuts the fold in half');
  });

  test('hem: a rolled hem turns further than a flat one', () => {
    const part = hemPart();
    SM.addHem(part, 'p0', { a: [0, 40], b: [60, 40] }, {
      kind: 'rolled',
      thickness: 1.5,
      radius: 2,
      length: 6,
      angle: 270,
      id: 'h'
    });
    near(part.bends[0].angle, (270 * Math.PI) / 180, 1e-9, 'three quarters of a turn');
  });

  test('hem: it flattens, which is the point of keeping it in the fold tree', () => {
    const part = hemPart();
    SM.addHem(part, 'p0', { a: [0, 40], b: [60, 40] }, {
      kind: 'single',
      thickness: 1.5,
      radius: 1.5,
      length: 6,
      id: 'h'
    });
    const flat = SM.flatOutline(part, 1.5, 0.4);
    assert(flat && flat.panels.length === 2, 'both panels are in the flat');
    // Two lines for one fold, not one: a bend takes up a width of flat, and
    // what is marked is where it starts and where it stops. A press brake needs
    // both, and a single line down the middle is the commonest way a flat
    // pattern gets folded in the wrong place.
    assert(flat.bendLines.length === 2, `the fold is marked at both ends, got ${flat.bendLines.length}`);
    const apart = Math.abs(flat.bendLines[1][0][1] - flat.bendLines[0][0][1]);
    near(apart, SM.bendAllowance(Math.PI, 1.5, 1.5, 0.4), 1e-6, 'and they are the allowance apart');
    // The flat is longer than the folded part by the hem, less what the bend
    // eats, which is the whole reason a flat pattern is worked out rather than
    // measured off the model.
    const allow = SM.bendAllowance(Math.PI, 1.5, 1.5, 0.4);
    assert(allow > 0 && allow < 12, `a sensible allowance, got ${allow.toFixed(3)}`);
  });

  test('lofted flange: a transition between two sections is a real solid', () => {
    // Square at the bottom, smaller square at the top: a duct transition, which
    // is the shape this feature exists for.
    const doc = newDocument();
    const square = (name, plane, half, z) => {
      const sk = newSketch(plane, name);
      sk.points = [
        { x: -half, y: -half },
        { x: half, y: -half },
        { x: half, y: half },
        { x: -half, y: half }
      ];
      sk.entities = [
        { id: 1, type: 'line', p: [0, 1] },
        { id: 2, type: 'line', p: [1, 2] },
        { id: 3, type: 'line', p: [2, 3] },
        { id: 4, type: 'line', p: [3, 0] }
      ];
      sk.nextEntityId = 5;
      sk.plane = { base: 'XY', offset: String(z) };
      return sk;
    };
    const low = square('Low', 'XY', 20, 0);
    const high = square('High', 'XY', 10, 40);
    doc.sketches[low.id] = low;
    doc.sketches[high.id] = high;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: low.id },
      { id: uid('f'), type: 'sketch', sketch: high.id },
      {
        id: 'flf',
        type: 'loftedFlange',
        sketch: low.id,
        sketchTo: high.id,
        around: '24',
        thickness: '1.5'
      }
    ];
    const out = rebuild(doc);
    const body = out.bodies.find((b) => b.solid);
    assert(body, `it built something, errors: ${out.errors.map((e) => e.message).join('; ')}`);
    const v = body.solid.volume();

    // The wall area is roughly the average perimeter times the slant length,
    // and the volume is that times the thickness. Near enough that a transition
    // built at the wrong size or the wrong thickness would show.
    const perimeter = (40 * 4 + 20 * 4) / 2;
    const slant = Math.hypot(40, 10);
    const want = perimeter * slant * 1.5;
    assert(
      Math.abs(v - want) < want * 0.25,
      `about a wall of that area, got ${v.toFixed(0)} against ${want.toFixed(0)}`
    );

    // And it says out loud that it cannot be unfolded, rather than leaving
    // somebody to find out at the press brake.
    assert(
      out.errors.some((e) => /no flat pattern/.test(e.message)),
      'it says there is no flat pattern for it'
    );
    out.dispose();
  });

  /* -------- assembly constraints -------- */

  test('constrain: mate turns a face to look at the one it meets', () => {
    const child = { p: [0, 0, 0], axis: [0, 0, 1] };
    const parent = { p: [10, 5, 20], axis: [0, 0, -1] };
    const step = AS.constraintTransform('mate', child, parent, {});
    assert(step, 'it worked one out');
    const facing = AS.applyRotation(step.rotation, child.axis);
    near(facing[2], 1, 1e-9, 'the child ends up facing into the parent');
    // And its own point lands on the parent's.
    const landed = AS.applyRotation(step.rotation, child.p).map((v, i) => v + step.translation[i]);
    for (let i = 0; i < 3; i++) near(landed[i], parent.p[i], 1e-9, 'the faces touch');
  });

  test('constrain: flush leaves the two facing the same way', () => {
    const child = { p: [0, 0, 0], axis: [0, 0, 1] };
    const parent = { p: [0, 0, 0], axis: [0, 0, -1] };
    const mate = AS.applyRotation(
      AS.constraintTransform('mate', child, parent, {}).rotation,
      child.axis
    );
    const flush = AS.applyRotation(
      AS.constraintTransform('flush', child, parent, {}).rotation,
      child.axis
    );
    near(mate[2], 1, 1e-9, 'mate turns it to face back');
    near(flush[2], -1, 1e-9, 'and flush leaves it facing the same way');
  });

  test('constrain: an offset holds the two apart along the parent normal', () => {
    const child = { p: [0, 0, 0], axis: [0, 0, 1] };
    const parent = { p: [0, 0, 0], axis: [0, 0, 1] };
    const step = AS.constraintTransform('mate', child, parent, { offset: 3 });
    const landed = AS.applyRotation(step.rotation, child.p).map((v, i) => v + step.translation[i]);
    near(landed[2], 3, 1e-9, 'three clear of the face, along its own normal');
  });

  test('constrain: concentric puts it on the axis and says nothing about where along', () => {
    const child = { p: [3, 4, 7], axis: [1, 0, 0] };
    const parent = { p: [0, 0, 0], axis: [0, 0, 1] };
    const step = AS.constraintTransform('concentric', child, parent, {});
    const landed = AS.applyRotation(step.rotation, child.p).map((v, i) => v + step.translation[i]);
    near(Math.hypot(landed[0], landed[1]), 0, 1e-9, 'it is on the axis');
    // How far along is left alone, which is what makes it a shaft in a bore
    // rather than a shaft pushed home.
    const facing = AS.applyRotation(step.rotation, child.axis);
    near(Math.abs(facing[2]), 1, 1e-9, 'and pointing along it');
  });

  test('constrain: a face against itself is refused rather than turned inside out', () => {
    assert(AS.constraintTransform('mate', null, { p: [0, 0, 0], axis: [0, 0, 1] }) === null, 'no child, no move');
    assert(AS.constraintTransform('mate', { p: [0, 0, 0], axis: [0, 0, 0] }, { p: [0, 0, 0], axis: [0, 0, 1] }) === null, 'a face with no direction is refused');
  });

  test('constrain: turning a direction onto its opposite is a half turn about something square to it', () => {
    const turn = AS.rotationBetween([0, 0, 1], [0, 0, -1]);
    near(turn.angle, Math.PI, 1e-9, 'half a turn');
    near(turn.axis[2], 0, 1e-9, 'about an axis square to the direction');
    const back = AS.applyRotation(turn, [0, 0, 1]);
    near(back[2], -1, 1e-9, 'and it really does land on the opposite');
  });

  test('constrain: a direction already right is no turn at all', () => {
    const turn = AS.rotationBetween([0, 1, 0], [0, 1, 0]);
    near(turn.angle, 0, 1e-12, 'nothing to do');
    const same = AS.applyRotation(turn, [3, 4, 5]);
    near(same[0], 3, 1e-12, 'and nothing is moved');
  });

  /* -------- plastic parts -------- */

  /** A face reference for the top of the first body of a document. */
  function topFaceOf(out) {
    const body = out.bodies.find((b) => b.solid);
    const topo = buildTopology(K.meshData(body.solid));
    let best = 0;
    for (let i = 1; i < topo.faces.length; i++) {
      if (topo.faces[i].normal[2] > 0.99 && topo.faces[i].area > topo.faces[best].area) best = i;
    }
    return { body, topo, face: topo.faces[best], ref: faceReference(topo.faces[best], topo) };
  }

  /** A plate 60 by 60 by 5, sitting on the origin, to stand things on. */
  function plateDoc() {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '60', depth: '60', height: '5', centered: false })
    ];
    return doc;
  }

  test('plastic: a boss profile is a post with a hole and a foot', () => {
    const p = PL.bossProfile({ diameter: 8, height: 10, bore: 3, boreDepth: 8, fillet: 1.5 });
    assert(p, 'it drew one');
    assert(PL.signedArea(p) > 0, 'and it runs the way a revolve wants');
    const r = p.map((q) => q[0]);
    const z = p.map((q) => q[1]);
    // The widest point is the foot of the fillet, not the wall.
    near(Math.max(...r), 4 + 1.5, 1e-9, 'the fillet reaches a radius and a half past the wall');
    near(Math.min(...z), 0, 1e-9, 'it sits on the face');
    near(Math.max(...z), 10, 1e-9, 'and stands the height it was given');
    // A blind bore leaves material under it, so the outline touches the axis.
    assert(Math.min(...r) === 0, 'a blind bore closes on the axis');
  });

  test('plastic: a bore right through leaves a ring, not a cup', () => {
    const p = PL.bossProfile({ diameter: 8, height: 10, bore: 3, boreDepth: 10, fillet: 1 });
    near(Math.min(...p.map((q) => q[0])), 1.5, 1e-9, 'nothing reaches the axis');
  });

  test('plastic: a bore as wide as the boss is refused', () => {
    assert(PL.bossProfile({ diameter: 8, bore: 8 }) === null, 'it will not draw a boss with no wall');
  });

  test('plastic: a snap fit has the lead-in and the retention it was given', () => {
    const p = PL.snapProfile({ length: 12, thickness: 2, hook: 1.5, leadIn: 30, retention: 90 });
    assert(p.length === 5, `five corners, got ${p.length}`);
    const tip = p[2];
    const back = p[3];
    near(tip[0], 12, 1e-9, 'the retention face is square at the tip');
    near(tip[1], 3.5, 1e-9, 'and the hook stands its height above the beam');
    // The lead-in slope really is the angle asked for.
    const rise = tip[1] - back[1];
    const run = tip[0] - back[0];
    near((Math.atan2(rise, run) * 180) / Math.PI, 30, 1e-6, 'thirty degrees of lead-in');
  });

  test('plastic: a retention angle under square undercuts the tip', () => {
    const square = PL.snapProfile({ length: 12, thickness: 2, hook: 1.5, retention: 90 });
    const under = PL.snapProfile({ length: 12, thickness: 2, hook: 1.5, retention: 60 });
    near(square[2][0], 12, 1e-9, 'square is square');
    assert(under[2][0] > 12, `and under square leans out past the tip, got ${under[2][0].toFixed(3)}`);
  });

  test('plastic: a lead-in longer than the beam is refused', () => {
    assert(
      PL.snapProfile({ length: 2, thickness: 2, hook: 5, leadIn: 10 }) === null,
      'it says so rather than drawing a beam that folds back on itself'
    );
  });

  test('plastic: a groove is wider than the lip by the clearance, both sides', () => {
    const lip = PL.lipBand({ width: 1.2, inset: 0.8, clearance: 0.15 });
    const groove = PL.lipBand({ width: 1.2, inset: 0.8, clearance: 0.15, groove: true });
    near(lip.outer - lip.inner, 1.2, 1e-9, 'the lip is the width asked for');
    near(groove.outer - groove.inner, 1.2 + 0.3, 1e-9, 'and the groove is wider by the clearance both sides');
    assert(groove.outer > lip.outer, 'and it starts sooner');
  });

  test('plastic: a rest drafts inwards as it rises', () => {
    const round = PL.restProfile({ shape: 'round', diameter: 10, height: 2, draft: 10 });
    assert(round.kind === 'turn', 'a round one is turned');
    const top = round.contour.find((p) => Math.abs(p[1] - 2) < 1e-9 && p[0] > 0);
    assert(top[0] < 5, `the top is narrower than the bottom, got ${top[0].toFixed(3)}`);
    near(top[0], 5 - Math.tan((10 * Math.PI) / 180) * 2, 1e-9, 'by exactly the draft');
  });

  test('plastic: a draft that runs out before the top is refused', () => {
    assert(
      PL.restProfile({ shape: 'round', diameter: 4, height: 20, draft: 45 }) === null,
      'it will not draw a pad that comes to nothing halfway up'
    );
  });

  test('plastic: a rounded rectangle really is rounded and the right size', () => {
    const r = PL.roundedRect(5, 4, 1);
    assert(PL.signedArea(r) > 0, 'anticlockwise');
    const xs = r.map((p) => p[0]);
    const ys = r.map((p) => p[1]);
    near(Math.max(...xs), 5, 1e-9, 'ten wide');
    near(Math.max(...ys), 4, 1e-9, 'and eight deep');
    // A rounded corner is a rectangle less four bites of the same size.
    const full = 10 * 8;
    const bite = 4 * (1 - Math.PI / 4) * 1;
    assert(Math.abs(PL.signedArea(r) - (full - bite)) < 0.3, 'and the corners really are taken off');
  });

  test('plastic: a boss on a plate adds material and stands where it was put', () => {
    const doc = plateDoc();
    const first = rebuild(doc);
    const { ref } = topFaceOf(first);
    const was = first.bodies[0].solid.volume();
    first.dispose();

    doc.features.push({
      id: 'fboss',
      type: 'boss',
      face: ref,
      diameter: '8',
      bore: '3',
      height: '10',
      boreDepth: '8',
      fillet: '1.5',
      ribs: '0',
      x: '0',
      y: '0'
    });
    const out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    const now = out.bodies.find((b) => b.solid).solid.volume();
    assert(now > was, 'it added material');
    // A post of 8 across and 10 tall, less a bore of 3 across and 8 deep, plus
    // the fillet at the foot. Near enough that a wrong profile would show.
    const post = Math.PI * 16 * 10;
    const bore = Math.PI * 2.25 * 8;
    assert(
      Math.abs(now - was - (post - bore)) < post * 0.15,
      `about a post less a bore, added ${(now - was).toFixed(1)} against ${(post - bore).toFixed(1)}`
    );
    out.dispose();
  });

  test('plastic: a boss with ribs is heavier than one without', () => {
    const doc = plateDoc();
    const first = rebuild(doc);
    const { ref } = topFaceOf(first);
    first.dispose();

    const boss = (ribs) => ({
      id: `fb${ribs}`,
      type: 'boss',
      face: ref,
      diameter: '8',
      bore: '3',
      height: '10',
      boreDepth: '8',
      fillet: '1.5',
      ribs: String(ribs),
      ribThickness: '1.5',
      ribHeight: '7',
      ribReach: '4',
      x: '0',
      y: '0'
    });

    const plain = rebuild({ ...doc, features: [...doc.features, boss(0)] });
    const ribbed = rebuild({ ...doc, features: [...doc.features, boss(4)] });
    assert(ribbed.errors.length === 0, ribbed.errors.map((e) => e.message).join('; '));
    const a = plain.bodies.find((b) => b.solid).solid.volume();
    const b = ribbed.bodies.find((b2) => b2.solid).solid.volume();
    assert(b > a, `ribs add material, ${b.toFixed(1)} against ${a.toFixed(1)}`);

    // Where the ribs went, not just that there are some. Tipping the profile
    // by swapping two axes instead of turning it puts them on their sides,
    // which adds the same volume and is completely wrong.
    const box = K.boundingBox(ribbed.bodies.find((x) => x.solid).solid);
    near(box.max[2], 5 + 10, 0.01, 'nothing stands above the boss');
    // The plate is 60 across from the origin, so the ribs are well inside it
    // and cannot be what sets the width. The reach is what has to show.
    const grew = [0, 1].every((d) => box.max[d] <= 60.001 && box.min[d] >= -0.001);
    assert(grew, 'and nothing hangs off the plate');
    const four = 4 * 1.5 * ((4 * 7) / 2);
    assert(
      b - a > four * 0.6 && b - a < four * 1.2,
      `about four gussets of material, got ${(b - a).toFixed(1)} against ${four.toFixed(1)}`
    );
    plain.dispose();
    ribbed.dispose();
  });

  test('plastic: a sunken rest takes material away', () => {
    const doc = plateDoc();
    const first = rebuild(doc);
    const { ref } = topFaceOf(first);
    const was = first.bodies[0].solid.volume();
    first.dispose();

    doc.features.push({
      id: 'frest',
      type: 'rest',
      face: ref,
      shape: 'round',
      diameter: '10',
      height: '2',
      draft: '5',
      op: 'cut',
      x: '0',
      y: '0'
    });
    const out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    const now = out.bodies.find((b) => b.solid).solid.volume();
    assert(now < was, `it took material out, ${now.toFixed(1)} from ${was.toFixed(1)}`);
    assert(was - now < Math.PI * 25 * 2 * 1.05, 'and no more than the pad it was');
    out.dispose();
  });

  test('plastic: a lip follows the face and a groove is bigger than it', () => {
    const doc = plateDoc();
    const first = rebuild(doc);
    const { ref } = topFaceOf(first);
    const was = first.bodies[0].solid.volume();
    first.dispose();

    const lip = {
      id: 'flip',
      type: 'lip',
      face: ref,
      width: '1.2',
      inset: '0.8',
      height: '2',
      clearance: '0.15',
      op: 'join'
    };
    const raised = rebuild({ ...doc, features: [...doc.features, lip] });
    assert(raised.errors.length === 0, raised.errors.map((e) => e.message).join('; '));
    const added = raised.bodies.find((b) => b.solid).solid.volume() - was;
    // A band 1.2 wide and 2 high, once round a 60 square set in by 0.8 or so.
    const roughly = 1.2 * 2 * 4 * (60 - 2 * 1.4);
    assert(Math.abs(added - roughly) < roughly * 0.2, `about a band round the rim, got ${added.toFixed(1)} against ${roughly.toFixed(1)}`);
    raised.dispose();

    const grooved = rebuild({
      ...doc,
      features: [...doc.features, { ...lip, id: 'fgroove', op: 'cut' }]
    });
    const removed = was - grooved.bodies.find((b) => b.solid).solid.volume();
    assert(removed > added, `the groove is bigger than the lip, ${removed.toFixed(1)} against ${added.toFixed(1)}`);
    grooved.dispose();
  });

  test('plastic: a snap fit and its catch are the same shape, the catch bigger', () => {
    const doc = plateDoc();
    const first = rebuild(doc);
    const { ref } = topFaceOf(first);
    const was = first.bodies[0].solid.volume();
    first.dispose();

    const snap = {
      id: 'fsnap',
      type: 'snapFit',
      face: ref,
      length: '12',
      thickness: '2',
      width: '6',
      hook: '1.5',
      leadIn: '30',
      retention: '90',
      clearance: '0.2',
      facing: '0',
      op: 'join',
      x: '0',
      y: '0'
    };
    const hook = rebuild({ ...doc, features: [...doc.features, snap] });
    assert(hook.errors.length === 0, hook.errors.map((e) => e.message).join('; '));
    const added = hook.bodies.find((b) => b.solid).solid.volume() - was;
    assert(added > 100, `a beam of some size, got ${added.toFixed(1)}`);
    hook.dispose();

    const catchIt = rebuild({
      ...doc,
      features: [...doc.features, { ...snap, id: 'fcatch', op: 'cut' }]
    });
    const removed = was - catchIt.bodies.find((b) => b.solid).solid.volume();
    // The catch is the same shape grown by the clearance, so it cannot be
    // smaller than the hook it has to take.
    assert(removed > 0, 'the catch took material out');
    catchIt.dispose();
  });

  test('plastic: a face that is no longer there is reported, not guessed at', () => {
    const doc = plateDoc();
    const out = rebuild({
      ...doc,
      features: [
        ...doc.features,
        { id: 'fb', type: 'boss', face: { src: { tag: 'nothing', face: 99 } }, diameter: '8', bore: '3', height: '10' }
      ]
    });
    assert(
      out.errors.some((e) => /no longer on the model/.test(e.message)),
      `it says so, got ${out.errors.map((e) => e.message).join('; ') || 'nothing'}`
    );
    out.dispose();
  });

  /* -------- mesh stitch, patch and direct edit -------- */

  /**
   * A box written the way a bad exporter writes one: every triangle with its
   * own three corners, so nothing is joined to anything.
   */
  function looseBox(size = 20, jitter = 0) {
    const h = size / 2;
    const corner = [
      [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
      [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]
    ];
    const quads = [
      [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
      [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]
    ];
    const P = [];
    const T = [];
    // A jitter puts every copy of a corner its own small distance from the
    // others, which is what a scan gives and what a weld tolerance is for.
    // Counted per corner so no two copies of one ever land in the same place.
    const seen = new Map();
    for (const [a, b, c, d] of quads) {
      for (const tri of [[a, b, c], [a, c, d]]) {
        const base = P.length;
        for (const v of tri) {
          const k = seen.get(v) || 0;
          seen.set(v, k + 1);
          P.push(corner[v].map((x, axis) => x + jitter * k * (axis === 1 ? -1 : 1)));
        }
        T.push([base, base + 1, base + 2]);
      }
    }
    return {
      numProp: 3,
      vertProperties: new Float32Array(P.flat()),
      triVerts: new Uint32Array(T.flat())
    };
  }

  test('mesh stitch: a mesh with no shared corners becomes one surface', () => {
    const mesh = looseBox(20);
    const before = MT.meshHealth(mesh);
    assert(before.vertices === 36, `every triangle its own corners, got ${before.vertices}`);
    assert(before.duplicated === 28, `28 of them sit on top of another, got ${before.duplicated}`);

    const out = MT.stitchMesh(mesh, 1e-4);
    assert(out.joined === 28, `28 points joined into 8, got ${out.joined}`);
    assert(out.openAfter === 0, `and nothing left open, got ${out.openAfter}`);
    assert(out.closed, 'so it is a closed surface now');
  });

  test('mesh stitch: a tolerance too small joins nothing', () => {
    // Corners that nearly meet rather than exactly, which is what a scan gives.
    // Under the gap between them, welding cannot do anything, and the count of
    // open edges is what says so.
    const scanned = looseBox(20, 0.05);
    const tight = MT.stitchMesh(scanned, 0.001);
    assert(tight.joined === 0, `nothing joined, got ${tight.joined}`);
    assert(tight.openAfter > 0, 'and it is still in pieces');

    const loose = MT.stitchMesh(scanned, 0.5);
    assert(loose.joined > 0, `raising it joins them, got ${loose.joined}`);
    assert(loose.openAfter < tight.openAfter, 'and closes the gaps');
  });

  test('mesh patch: a hole is filled and the body closes', () => {
    // A box with one triangle taken out of it.
    const stitched = MT.stitchMesh(looseBox(20), 1e-4).mesh;
    const tris = [];
    const src = stitched.triVerts;
    for (let t = 3; t < src.length / 3; t++) {
      tris.push([src[t * 3], src[t * 3 + 1], src[t * 3 + 2]]);
    }
    const holed = {
      numProp: 3,
      vertProperties: stitched.vertProperties,
      triVerts: new Uint32Array(tris.flat())
    };
    assert(MT.meshHealth(holed).openEdges > 0, 'it has a hole in it');

    const out = MT.patchMesh(holed);
    assert(out.filled >= 1, `at least one hole filled, got ${out.filled}`);
    assert(MT.meshHealth(out.mesh).openEdges === 0, 'and it is shut');
  });

  test('mesh patch: a hole too big to be a fault is left alone', () => {
    // The whole top off a box. That is where the part was cut, not a fault, and
    // filling it turns the part into a bag.
    const stitched = MT.stitchMesh(looseBox(20), 1e-4).mesh;
    const tris = [];
    const src = stitched.triVerts;
    for (let t = 2; t < src.length / 3; t++) {
      tris.push([src[t * 3], src[t * 3 + 1], src[t * 3 + 2]]);
    }
    const holed = {
      numProp: 3,
      vertProperties: stitched.vertProperties,
      triVerts: new Uint32Array(tris.flat())
    };
    const rim = MT.patchMesh(holed).sizes[0];
    assert(rim > 0, 'the hole has a perimeter');

    const out = MT.patchMesh(holed, { maxPerimeter: rim / 2 });
    assert(out.filled === 0, 'nothing filled');
    assert(out.left === 1, 'and it says one was left');
    assert(MT.meshHealth(out.mesh).openEdges > 0, 'so the mesh is still open');
  });

  test('mesh direct edit: what moves falls off with distance', () => {
    const mesh = MT.stitchMesh(looseBox(20), 1e-4).mesh;
    const P = [];
    for (let i = 0; i < mesh.vertProperties.length; i += 3) {
      P.push([mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]]);
    }
    // One corner, and everything within 25 of it follows a little.
    const weights = MT.meshVertexWeights(mesh, [0], 25);
    assert(weights.get(0) === 1, 'the chosen one moves fully');
    assert(weights.size > 1, 'and its neighbours follow');
    for (const [v, w] of weights) {
      if (v === 0) continue;
      assert(w > 0 && w < 1, 'every follower moves less than the whole way');
    }

    const out = MT.shiftMeshPoints(mesh, weights, [0, 0, 10]);
    const moved = [];
    for (let i = 0; i < out.vertProperties.length; i += 3) {
      moved.push(out.vertProperties[i + 2] - P[i / 3][2]);
    }
    near(moved[0], 10, 1e-5, 'the chosen corner went the whole way');
    // The far corner of a 20 box is 34.6 away, past the 25 asked for, so it
    // must not have moved at all.
    const far = P.findIndex((p) => Math.hypot(p[0] - P[0][0], p[1] - P[0][1], p[2] - P[0][2]) > 25);
    assert(far > 0, 'there is a corner out of reach');
    near(moved[far], 0, 1e-9, 'and it stayed where it was');
  });

  test('mesh direct edit: with no reach, only what was picked moves', () => {
    const mesh = MT.stitchMesh(looseBox(20), 1e-4).mesh;
    const weights = MT.meshVertexWeights(mesh, [0, 1], 0);
    assert(weights.size === 2, `only the two, got ${weights.size}`);
    const out = MT.shiftMeshPoints(mesh, weights, [5, 0, 0]);
    let moved = 0;
    for (let i = 0; i < out.vertProperties.length; i += 3) {
      if (Math.abs(out.vertProperties[i] - mesh.vertProperties[i]) > 1e-9) moved++;
    }
    assert(moved === 2, `two points moved, got ${moved}`);
  });

  /* -------- building a form from curves -------- */

  /** A square of side `w` in the XY plane, as a closed run with no repeat. */
  function squareRun(w = 20) {
    const h = w / 2;
    return [
      [-h, -h, 0],
      [h, -h, 0],
      [h, h, 0],
      [-h, h, 0]
    ];
  }

  test('form from curves: a grid needs every row the same length', () => {
    assert(FM.gridCage([[[0, 0, 0], [1, 0, 0]], [[0, 1, 0]]]) === null, 'ragged rows are refused');
    assert(FM.gridCage([]) === null, 'and nothing is nothing');
    const ok = FM.gridCage([
      [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
      [[0, 1, 0], [1, 1, 0], [2, 1, 0]]
    ]);
    assert(ok.points.length === 6 && ok.faces.length === 2, 'two quads from two rows of three');
  });

  test('form from curves: coarsening keeps the ends and spaces the rest evenly', () => {
    // A run bunched up at one end. Cut to five points it has to space them by
    // length, not by how many segments happen to be where.
    const run = [];
    for (let i = 0; i <= 10; i++) run.push([i * 0.1, 0, 0]);
    for (let i = 1; i <= 4; i++) run.push([1 + i * 4, 0, 0]);
    const out = FM.coarsenRun(run, 5);
    assert(out.length === 5, `five points, got ${out.length}`);
    near(out[0][0], 0, 1e-9, 'the first end is kept');
    near(out[4][0], 17, 1e-6, 'and the last');
    const gaps = out.slice(1).map((p, i) => p[0] - out[i][0]);
    near(Math.max(...gaps) - Math.min(...gaps), 0, 1e-6, 'and the spacing is even along the length');
  });

  test('form from curves: extruding a closed run makes a tube with two open ends', () => {
    const cage = FM.extrudeRunCage(squareRun(20), [0, 0, 30], { rows: 3, points: 4, closed: true });
    assert(cage, 'it built');
    assert(cage.points.length === 16, `four rows of four, got ${cage.points.length}`);
    assert(cage.faces.length === 12, `twelve quads, got ${cage.faces.length}`);
    assert(FM.boundaryLoops(cage).length === 2, 'open at both ends');
    // It really went the distance asked for.
    const zs = cage.points.map((p) => p[2]);
    near(Math.max(...zs) - Math.min(...zs), 30, 1e-6, 'thirty tall');
  });

  test('form from curves: an open run extrudes to a sheet, not a tube', () => {
    const run = [[-10, 0, 0], [0, 0, 0], [10, 0, 0]];
    const cage = FM.extrudeRunCage(run, [0, 0, 20], { rows: 2, points: 3, closed: false });
    assert(cage.faces.length === 4, `two by two quads, got ${cage.faces.length}`);
    assert(FM.boundaryLoops(cage).length === 1, 'and it is one open sheet');
  });

  test('form from curves: a full revolve wraps round and joins up', () => {
    const profile = [[10, 0, 0], [10, 0, 10], [6, 0, 20]];
    const cage = FM.revolveRunCage(profile, [0, 0, 0], [0, 0, 1], 360, {
      sides: 8,
      points: 3
    });
    assert(cage, 'it built');
    assert(cage.points.length === 24, `eight rings of three, got ${cage.points.length}`);
    // Wrapped: no seam, so the only open edges are the two ends of the profile.
    assert(FM.boundaryLoops(cage).length === 2, 'open at the ends, closed round');
    // And every point is where the profile says it should be, at its own radius.
    const radii = cage.points.map((p) => Math.hypot(p[0], p[1]));
    near(Math.max(...radii), 10, 1e-6, 'the widest is the widest of the profile');
    near(Math.min(...radii), 6, 1e-6, 'and the narrowest the narrowest');
  });

  test('form from curves: a part revolve leaves a seam', () => {
    const profile = [[10, 0, 0], [10, 0, 10]];
    const half = FM.revolveRunCage(profile, [0, 0, 0], [0, 0, 1], 180, { sides: 6, points: 2 });
    assert(half, 'it built');
    assert(FM.boundaryLoops(half).length === 1, 'half a turn is one open sheet, not a tube');
  });

  test('form from curves: a sweep carries the shape without rolling it', () => {
    // A profile carried along a path that climbs. Carried rather than turned
    // with the path: a profile that rolls as it goes twists the surface.
    const profile = squareRun(10);
    const path = [[0, 0, 0], [0, 20, 5], [0, 40, 20]];
    const cage = FM.sweepRunCage(profile, path, { rows: 3, points: 4, closed: true });
    assert(cage, 'it built');
    assert(cage.points.length === 16, `four rings of four, got ${cage.points.length}`);
    // Every ring is the same shape as the one before, moved.
    const ring = (k) => cage.points.slice(k * 4, k * 4 + 4);
    for (let k = 1; k < 4; k++) {
      const a = ring(0);
      const b = ring(k);
      const shift = [b[0][0] - a[0][0], b[0][1] - a[0][1], b[0][2] - a[0][2]];
      for (let i = 0; i < 4; i++) {
        for (let d = 0; d < 3; d++) {
          near(b[i][d] - a[i][d], shift[d], 1e-6, 'the shape was carried, not turned');
        }
      }
    }
  });

  test('form from curves: a loft runs between two sketches', () => {
    const cage = FM.loftRunsCage([squareRun(20), squareRun(8).map((p) => [p[0], p[1], 30])], {
      points: 4,
      closed: true
    });
    assert(cage, 'it built');
    assert(cage.faces.length === 4, `one band of four, got ${cage.faces.length}`);
    assert(FM.boundaryLoops(cage).length === 2, 'open at both ends');
    const low = cage.points.filter((p) => p[2] === 0);
    const high = cage.points.filter((p) => p[2] === 30);
    assert(low.length === 4 && high.length === 4, 'four corners at each end');
  });

  test('form from curves: a pipe holds its radius all the way round a bend', () => {
    const path = [];
    for (let i = 0; i <= 12; i++) {
      const a = (Math.PI / 2) * (i / 12);
      path.push([30 * Math.sin(a), 0, 30 - 30 * Math.cos(a)]);
    }
    const cage = FM.pipeRunCage(path, 5, { rows: 7, sides: 8 });
    assert(cage, 'it built');
    assert(cage.points.length === 64, `eight rings of eight, got ${cage.points.length}`);
    assert(FM.boundaryLoops(cage).length === 2, 'a tube open at both ends');

    // Every ring is a real circle of the radius asked for, about its own centre.
    for (let k = 0; k < 8; k++) {
      const ring = cage.points.slice(k * 8, k * 8 + 8);
      const centre = [0, 1, 2].map((d) => ring.reduce((a, p) => a + p[d], 0) / 8);
      for (const p of ring) {
        near(
          Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]),
          5,
          1e-6,
          'every point of the ring is the radius out'
        );
      }
    }
  });

  test('form from curves: a pipe does not flip its ring part way along', () => {
    // The frame is carried from one station to the next rather than rebuilt.
    // Rebuilt, it turns over wherever the path passes through vertical and the
    // tube pinches into an hourglass.
    const path = [];
    for (let i = 0; i <= 16; i++) {
      const a = (2 * Math.PI * i) / 16;
      path.push([0, i * 4, 0]);
    }
    path[8] = [0, 32, 0.001];
    const cage = FM.pipeRunCage(path, 4, { rows: 9, sides: 6 });
    const ringAt = (k) => cage.points.slice(k * 6, k * 6 + 6);
    for (let k = 1; k < 10; k++) {
      const a = ringAt(k - 1);
      const b = ringAt(k);
      // Point 0 of each ring should still be roughly beside point 0 of the last.
      const step = Math.hypot(b[0][0] - a[0][0], b[0][1] - a[0][1], b[0][2] - a[0][2]);
      assert(step < 12, `ring ${k} did not jump round, step ${step.toFixed(2)}`);
    }
  });

  test('form from curves: a built cage subdivides into a real surface', () => {
    // The end of the road for all of these: whatever was built has to be
    // something the subdivision can work on and the kernel can take.
    const cage = FM.extrudeRunCage(squareRun(20), [0, 0, 30], { rows: 2, points: 4, closed: true });
    let capped = cage;
    for (let i = 0; i < 4 && FM.boundaryLoops(capped).length; i++) {
      capped = FM.fillHole(capped, FM.boundaryLoops(capped)[0], 'single');
      assert(capped, 'a cap went on');
    }
    capped = FM.orientCage(capped);
    assert(FM.boundaryLoops(capped).length === 0, 'and it is shut');
    const mesh = FM.formMesh(capped, 2);
    const scope = new K.Scope();
    const solid = K.ofMesh(mesh.vertProperties, mesh.triVerts, scope);
    assert(solid && !K.isEmpty(solid), 'the kernel took it');
    assert(solid.volume() > 0, `and it has a volume, got ${solid.volume().toFixed(1)}`);
    scope.dispose();
  });

  /* -------- sculpting a form -------- */

  const CAGE_XY = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };
  const cageBox = (div = [1, 1, 1]) => FM.boxCage(CAGE_XY, [40, 40, 40], div);
  const moved = (a, b) =>
    a.points.filter((p, i) => p.some((c, k) => Math.abs(c - b.points[i][k]) > 1e-9)).length;

  test('sculpt: smooth pulls a spike back towards its neighbours', () => {
    const cage = cageBox([2, 2, 2]);
    // Pick a point with neighbours all round it and yank it out.
    const adj = FM.adjacency(cage);
    const v = cage.points.findIndex((_, i) => (adj.edgesAt[i] || []).length >= 3);
    assert(v >= 0, 'found a point with neighbours');
    const was = cage.points[v].slice();
    cage.points[v] = [was[0] * 3, was[1] * 3, was[2] * 3];
    const outBefore = Math.hypot(...cage.points[v]);

    const out = FM.smoothPoints(cage, [v], { strength: 0.5, iterations: 1 });
    const outAfter = Math.hypot(...out.points[v]);
    assert(outAfter < outBefore, `it came back in, ${outAfter.toFixed(2)} from ${outBefore.toFixed(2)}`);
    assert(moved(out, cage) === 1, 'and nothing else moved');
  });

  test('sculpt: smoothing does not depend on which point is numbered first', () => {
    // Every step has to be worked out from the positions before that step. Done
    // as it goes, a point relaxed after its neighbour sees a neighbour that has
    // already moved, and the answer changes with the order of the list.
    const cage = cageBox([2, 2, 2]);
    const adj = FM.adjacency(cage);
    const chosen = cage.points.map((_, i) => i).filter((i) => (adj.edgesAt[i] || []).length >= 3);
    assert(chosen.length > 4, `enough points to shuffle, got ${chosen.length}`);
    for (const v of chosen) cage.points[v] = cage.points[v].map((c) => c * 1.4);

    const forward = FM.smoothPoints(cage, chosen, { strength: 0.7, iterations: 3 });
    const backward = FM.smoothPoints(cage, chosen.slice().reverse(), { strength: 0.7, iterations: 3 });
    for (const v of chosen) {
      for (let k = 0; k < 3; k++) {
        near(forward.points[v][k], backward.points[v][k], 1e-12, 'the same either way round');
      }
    }
    assert(moved(forward, cage) === chosen.length, 'and every chosen point did move');
  });

  test('sculpt: straighten puts points on one line', () => {
    const cage = cageBox([2, 2, 2]);
    // A run along one edge of the box, nudged off line.
    const run = cage.points
      .map((p, i) => [p, i])
      .filter(([p]) => Math.abs(p[1] + 20) < 1e-6 && Math.abs(p[2] + 20) < 1e-6)
      .map(([, i]) => i);
    assert(run.length >= 3, `a run of at least three, got ${run.length}`);
    cage.points[run[1]] = [cage.points[run[1]][0], -14, -20];

    const out = FM.straightenPoints(cage, run);
    const pts = run.map((i) => out.points[i]);
    // Every point on the line through the first and last of them.
    const a = pts[0];
    const b = pts[pts.length - 1];
    const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...dir);
    for (const p of pts) {
      const d = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
      const cross = Math.hypot(
        d[1] * dir[2] - d[2] * dir[1],
        d[2] * dir[0] - d[0] * dir[2],
        d[0] * dir[1] - d[1] * dir[0]
      );
      near(cross / l, 0, 1e-6, 'on the line');
    }
  });

  /** One ring of a cylinder cage's wall, at the level nearest the height given. */
  function wallRing(cage, height) {
    const levels = [...new Set(cage.points.map((p) => Math.round(p[2] * 1e4) / 1e4))];
    let want = levels[0];
    for (const z of levels) if (Math.abs(z - height) < Math.abs(want - height)) want = z;
    return cage.points
      .map((p, i) => [p, i])
      .filter(([p]) => Math.abs(p[2] - want) < 1e-3 && Math.hypot(p[0], p[1]) > 1)
      .map(([, i]) => i);
  }

  test('sculpt: cylindrify puts points at one radius about the axis', () => {
    const cage = FM.cylinderCage(CAGE_XY, 20, 40, 8, 2, true);
    const ring = wallRing(cage, 0);
    assert(ring.length >= 4, `a ring, got ${ring.length}`);
    // Push them in and out, then bring them back onto a cylinder.
    ring.forEach((i, k) => {
      const f = 1 + 0.3 * ((k % 3) - 1);
      cage.points[i] = [cage.points[i][0] * f, cage.points[i][1] * f, cage.points[i][2]];
    });
    const wobbled = ring.map((i) => Math.hypot(cage.points[i][0], cage.points[i][1]));
    const mean = wobbled.reduce((a, b) => a + b, 0) / wobbled.length;
    assert(Math.max(...wobbled) - Math.min(...wobbled) > 1, 'they really are all over the place');

    const out = FM.cylindrifyPoints(cage, ring, { dir: [0, 0, 1], origin: [0, 0, 0] });
    const radii = ring.map((i) => Math.hypot(out.points[i][0], out.points[i][1]));
    near(Math.max(...radii) - Math.min(...radii), 0, 1e-6, 'all at one radius');
    // The radius kept is the one they averaged, so a ring that wobbles about a
    // bore lands on the bore and not on some new size.
    near(radii[0], mean, 1e-6, 'and it is the size they already were');
  });

  test('sculpt: a frozen point is not moved by anything', () => {
    const cage = FM.setFrozen(cageBox([2, 2, 2]), [0], true);
    const all = cage.points.map((_, i) => i);
    const was = cage.points[0].slice();

    const smoothed = FM.smoothPoints(cage, all, { strength: 1, iterations: 3 });
    for (let k = 0; k < 3; k++) near(smoothed.points[0][k], was[k], 1e-12, 'smooth left it alone');

    const straight = FM.straightenPoints(cage, all);
    for (let k = 0; k < 3; k++) near(straight.points[0][k], was[k], 1e-12, 'straighten too');

    // And a drag through the weights cannot reach it either.
    const w = FM.softWeights(cage, [0, 1], { extent: 'faces', faces: 2 });
    assert(!w.has(0), 'the drag has no weight on it');
    assert(w.has(1), 'but does on its neighbour');

    const freed = FM.setFrozen(cage, [0], false);
    assert(FM.softWeights(freed, [0], {}).has(0), 'and unfreezing gives it back');
  });

  test('sculpt: erase and fill takes an edge out and leaves one face', () => {
    const cage = cageBox([2, 2, 2]);
    const faces = cage.faces.length;
    const adj = FM.adjacency(cage);
    const inner = [...adj.edges.values()].find((e) => e.faces.length === 2);
    assert(inner, 'found an edge with a face either side');

    const out = FM.eraseAndFill(cage, [[inner.a, inner.b]]);
    assert(out, 'it did something');
    assert(out.faces.length === faces - 1, `one fewer face, got ${out.faces.length} from ${faces}`);
    // The merged face is a real face: no corner visited twice, and it has the
    // corners of both the faces it came from.
    for (const face of out.faces) {
      assert(new Set(face).size === face.length, 'no face visits a point twice');
    }
    const six = out.faces.find((f) => f.length === 6);
    assert(six, 'and two quads made a six sided face');
  });

  test('sculpt: an edge on the rim has nothing to merge into', () => {
    const open = FM.deleteFaces(cageBox([2, 2, 2]), [0]);
    const adj = FM.adjacency(open);
    const rim = [...adj.edges.values()].find((e) => e.faces.length === 1);
    assert(rim, 'found a rim edge');
    assert(FM.eraseAndFill(open, [[rim.a, rim.b]]) === null, 'it refuses rather than deleting a face');
  });

  test('sculpt: bevel puts an edge either side of the one picked', () => {
    const cage = cageBox([2, 2, 2]);
    const points = cage.points.length;
    const adj = FM.adjacency(cage);
    const e = [...adj.edges.values()].find((x) => x.faces.length === 2);
    const out = FM.bevelEdge(cage, e.a, e.b, 0.2);
    assert(out, 'it bevelled');
    assert(out.points.length > points, `more points than before, ${out.points.length} from ${points}`);
    // The original edge is still there: a bevel adds edges, it does not replace
    // the one it was given.
    const after = FM.adjacency(out);
    assert(after.edges.has(`${Math.min(e.a, e.b)}_${Math.max(e.a, e.b)}`), 'the edge itself survives');
    for (const face of out.faces) {
      assert(new Set(face).size === face.length, 'and every face is still a face');
    }
  });

  test('sculpt: slide moves an edge along the surface, not off it', () => {
    const cage = FM.cylinderCage(CAGE_XY, 20, 40, 8, 3, true);
    const ring = wallRing(cage, 0);
    assert(ring.length >= 4, `a ring to slide, got ${ring.length}`);
    const radius = Math.hypot(cage.points[ring[0]][0], cage.points[ring[0]][1]);
    const wasZ = ring.map((i) => cage.points[i][2]);

    const out = FM.slideEdges(cage, ring, 0.5);
    assert(out, 'it slid');
    const nowZ = ring.map((i) => out.points[i][2]);
    // The whole ring went the same way, which is the thing that is easy to get
    // wrong: choosing a side per point shears the ring instead of sliding it.
    const steps = nowZ.map((z, i) => z - wasZ[i]);
    assert(steps.every((d) => Math.abs(d) > 1e-6), 'every point moved');
    assert(steps.every((d) => Math.sign(d) === Math.sign(steps[0])), 'and all the same way');
    // And they stayed at the radius they were, because they ran along an edge
    // of the surface rather than through the air.
    for (const i of ring) {
      near(Math.hypot(out.points[i][0], out.points[i][1]), radius, 1e-6, 'still on the wall');
    }
  });

  test('sculpt: merging two rims joins them point for point', () => {
    // Two flat grids side by side, welded along the seam they share.
    const left = FM.planeCage(CAGE_XY, 20, 20, 2, 2);
    const right = FM.planeCage(
      { origin: [20, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
      20,
      20,
      2,
      2
    );
    const joined = {
      points: [...left.points, ...right.points.map((p) => p.slice())],
      faces: [
        ...left.faces.map((f) => f.slice()),
        ...right.faces.map((f) => f.map((v) => v + left.points.length))
      ],
      creases: {},
      corners: {}
    };
    const before = joined.points.length;

    const near10 = (v, x) => Math.abs(joined.points[v][0] - x) < 1e-6;
    const runA = joined.points
      .map((_, i) => i)
      .filter((i) => i < left.points.length && near10(i, 10))
      .sort((a, b) => joined.points[a][1] - joined.points[b][1]);
    const runB = joined.points
      .map((_, i) => i)
      .filter((i) => i >= left.points.length && near10(i, 10))
      .sort((a, b) => joined.points[a][1] - joined.points[b][1]);
    assert(runA.length === runB.length && runA.length >= 2, `matching rims, ${runA.length} each`);

    const out = FM.mergeEdgeRuns(joined, runA, runB);
    assert(out, 'they merged');
    assert(out.points.length === before - runA.length, 'one point per pair went away');
    assert(FM.boundaryLoops(out).length === 1, 'and the seam is closed: one rim, not two');
  });

  test('sculpt: rims of different lengths are refused', () => {
    const cage = cageBox([2, 2, 2]);
    assert(FM.mergeEdgeRuns(cage, [0, 1, 2], [3, 4]) === null, 'it will not guess a pairing');
  });

  test('sculpt: an interpolated point is one the surface passes through', () => {
    const cage = cageBox([2, 2, 2]);
    const v = 0;
    const plain = FM.formMesh(cage, 3);
    const marked = FM.setInterpolated(cage, [v], true);
    const sharp = FM.formMesh(marked, 3);

    const nearest = (mesh, p) => {
      let best = Infinity;
      for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp) {
        const d = Math.hypot(
          mesh.vertProperties[i] - p[0],
          mesh.vertProperties[i + 1] - p[1],
          mesh.vertProperties[i + 2] - p[2]
        );
        if (d < best) best = d;
      }
      return best;
    };
    const was = nearest(plain, cage.points[v]);
    const now = nearest(sharp, cage.points[v]);
    assert(now < was, `the surface came to the point, ${now.toFixed(4)} from ${was.toFixed(4)}`);
    near(now, 0, 1e-6, 'and reached it');

    const back = FM.setInterpolated(marked, [v], false);
    near(nearest(FM.formMesh(back, 3), cage.points[v]), was, 1e-6, 'and it goes back to smooth');
  });

  /**
   * An arc bulging out past the rim of a 40 square plane cage.
   *
   * Held clear of x = 20 by two, so no point of that rim starts on it: a point
   * already in the right place does not move, and a count of what moved would
   * then be counting the curve's shape rather than the command's work.
   */
  function bulgeCurve(bulge = 6, steps = 20) {
    const run = [];
    for (let i = 0; i <= steps; i++) {
      const t = -20 + (40 * i) / steps;
      run.push([22 + bulge * Math.sin((Math.PI * i) / steps), t, 0]);
    }
    return run;
  }

  test('sculpt: match brings a rim onto the nearest place on a curve', () => {
    const cage = FM.planeCage(CAGE_XY, 40, 40, 3, 3);
    const rim = cage.points
      .map((p, i) => [p, i])
      .filter(([p]) => Math.abs(p[0] - 20) < 1e-6)
      .map(([, i]) => i);
    assert(rim.length >= 3, `a rim to match, got ${rim.length}`);
    const target = bulgeCurve();

    const out = FM.matchPoints(cage, rim, target, { mode: 'nearest' });
    assert(out, 'it matched');
    for (const v of rim) {
      const hit = FM.closestOnRun(target, out.points[v]);
      near(hit.distance, 0, 1e-6, 'every point landed on the curve');
    }
    // Nearest means nearest: they did not shuffle along it, so each stayed
    // beside where it was.
    for (const v of rim) {
      assert(
        Math.abs(out.points[v][1] - cage.points[v][1]) < 6,
        'and none of them slid far along it'
      );
    }
    assert(moved(out, cage) === rim.length, 'and nothing else moved');
  });

  test('sculpt: by curve lays the points out evenly from one end to the other', () => {
    const cage = FM.planeCage(CAGE_XY, 40, 40, 3, 3);
    const rim = cage.points
      .map((p, i) => [p, i])
      .filter(([p]) => Math.abs(p[0] - 20) < 1e-6)
      .map(([, i]) => i);
    const target = bulgeCurve();
    const total = FM.arcLengths(target).pop();

    const out = FM.matchPoints(cage, rim, target, { mode: 'spread' });
    const along = rim
      .map((v) => FM.closestOnRun(target, out.points[v]).along)
      .sort((a, b) => a - b);
    near(along[0], 0, 1e-4, 'the first is at the start of the curve');
    near(along[along.length - 1], total, 1e-4, 'and the last is at the end');
    const gaps = along.slice(1).map((s, i) => s - along[i]);
    near(Math.max(...gaps) - Math.min(...gaps), 0, 1e-4, 'and the spacing is even');
  });

  test('sculpt: by curve can carry the rows behind it along too', () => {
    const cage = FM.planeCage(CAGE_XY, 40, 40, 4, 4);
    const rim = cage.points
      .map((p, i) => [p, i])
      .filter(([p]) => Math.abs(p[0] - 20) < 1e-6)
      .map(([, i]) => i);
    const target = bulgeCurve(10);

    const alone = FM.matchPoints(cage, rim, target, { mode: 'spread' });
    assert(moved(alone, cage) === rim.length, 'on its own only the rim moves');

    const adj = FM.adjacency(cage);
    const following = FM.matchPoints(cage, rim, target, {
      mode: 'spread',
      adjacency: adj,
      weights: FM.softWeights(cage, rim, { extent: 'faces', faces: 2 }, adj)
    });
    assert(moved(following, cage) > rim.length, 'with a falloff the rows behind come too');
    // And they come less far than the rim did, or it is a translation and not a
    // falloff. Against the furthest the rim went, because in this mode each rim
    // point goes its own distance.
    const step = (v, from) => Math.hypot(...following.points[v].map((c, k) => c - from.points[v][k]));
    const rimStep = Math.max(...rim.map((v) => step(v, cage)));
    const behind = [...FM.softWeights(cage, rim, { extent: 'faces', faces: 2 }, adj)]
      .filter(([v, w]) => w > 0 && w < 1)
      .map(([v]) => v);
    assert(behind.length, 'there are points behind the rim');
    for (const v of behind) {
      assert(step(v, cage) < rimStep + 1e-9, 'and each moved less than the rim');
    }
  });

  test('sculpt: matching needs somewhere to match to', () => {
    const cage = FM.planeCage(CAGE_XY, 40, 40, 3, 3);
    assert(FM.matchPoints(cage, [0, 1], [], {}) === null, 'no curve, no match');
    assert(FM.matchPoints(cage, [], bulgeCurve(), {}) === null, 'no points, no match');
  });

  test('sculpt: a frozen point stays put even when the rest is matched', () => {
    const cage = FM.planeCage(CAGE_XY, 40, 40, 3, 3);
    const rim = cage.points
      .map((p, i) => [p, i])
      .filter(([p]) => Math.abs(p[0] - 20) < 1e-6)
      .map(([, i]) => i);
    const held = FM.setFrozen(cage, [rim[0]], true);
    const out = FM.matchPoints(held, rim, bulgeCurve(), { mode: 'nearest' });
    for (let k = 0; k < 3; k++) {
      near(out.points[rim[0]][k], cage.points[rim[0]][k], 1e-12, 'the pinned one did not move');
    }
    assert(moved(out, cage) === rim.length - 1, 'and the rest did');
  });

  /* -------- repairing a form -------- */

  const PLANE_XY = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };

  test('repair: a form with nothing wrong with it is left alone', () => {
    const cage = FM.boxCage(PLANE_XY, [40, 40, 40], [1, 1, 1]);
    const { fixed } = FM.repairCage(cage);
    assert(!fixed.changed, `nothing to do, got ${JSON.stringify(fixed)}`);
  });

  test('repair: two points in the same place become one', () => {
    const cage = FM.boxCage(PLANE_XY, [40, 40, 40], [1, 1, 1]);
    const points = cage.points.length;
    // Drag one corner exactly onto its neighbour, which is what a snap that
    // went too far leaves behind.
    cage.points[1] = cage.points[0].slice();
    const { cage: out, fixed } = FM.repairCage(cage, { tolerance: 1e-4 });
    assert(fixed.welded === 1, `one point joined, got ${fixed.welded}`);
    assert(out.points.length < points, 'and the cage got smaller');
    // The faces that had both corners are now triangles, not faces with a
    // corner visited twice.
    for (const face of out.faces) {
      assert(new Set(face).size === face.length, 'no face visits a point twice');
      assert(face.length >= 3, 'and none is under three corners');
    }
  });

  test('repair: the same face made twice is made once', () => {
    const cage = FM.boxCage(PLANE_XY, [40, 40, 40], [1, 1, 1]);
    const faces = cage.faces.length;
    // The same face again, started from a different corner and running the
    // other way, which is how a duplicate really turns up.
    cage.faces.push(cage.faces[0].slice().reverse());
    const { cage: out, fixed } = FM.repairCage(cage);
    assert(fixed.duplicate === 1, `one duplicate found, got ${fixed.duplicate}`);
    assert(out.faces.length === faces, 'and the count is back where it was');
  });

  test('repair: a face folded on itself is dropped', () => {
    const cage = FM.boxCage(PLANE_XY, [40, 40, 40], [1, 1, 1]);
    const faces = cage.faces.length;
    const [a, b] = cage.faces[0];
    cage.faces.push([a, b, a, b]);
    const { cage: out, fixed } = FM.repairCage(cage);
    assert(fixed.degenerate === 1, `one dropped, got ${fixed.degenerate}`);
    assert(out.faces.length === faces, 'leaving the cage as it was');
  });

  test('repair: holes are only closed when asked for', () => {
    const cage = FM.boxCage(PLANE_XY, [40, 40, 40], [1, 1, 1]);
    const open = FM.deleteFaces(cage, [0]);
    assert(FM.boundaryLoops(open).length === 1, 'it has a hole in it');

    const left = FM.repairCage(open);
    assert(FM.boundaryLoops(left.cage).length === 1, 'and repair leaves it open');
    assert(!left.fixed.filled, 'and says it closed nothing');

    const closed = FM.repairCage(open, { fillHoles: true });
    assert(closed.fixed.filled === 1, `one hole closed, got ${closed.fixed.filled}`);
    assert(FM.boundaryLoops(closed.cage).length === 0, 'and now it is shut');
  });

  test('repair: a crease across a joined pair does not survive as an edge', () => {
    const cage = FM.boxCage(PLANE_XY, [40, 40, 40], [1, 1, 1]);
    const [a, b] = cage.faces[0];
    cage.creases[`${Math.min(a, b)}_${Math.max(a, b)}`] = 1;
    cage.points[b] = cage.points[a].slice();
    const { cage: out } = FM.repairCage(cage);
    for (const key of Object.keys(out.creases)) {
      const [x, y] = key.split('_').map(Number);
      assert(x !== y, 'no crease runs from a point to itself');
    }
  });

  /* -------- selection -------- */

  test('select: by size picks the small faces and leaves the big ones', () => {
    // A plate with two bores. The six flats and the two bores are large; the
    // question is whether asking for everything under a threshold answers with
    // exactly the faces under it, which is the whole of what the tool is.
    const doc = boxDoc(80, 60, 10);
    doc.features.push({
      ...prim('cylinder', { diameter: '6', height: '40', x: '-20' }), op: 'cut', targets: 'all'
    });
    const res = rebuild(doc);
    const topo = buildTopology(K.meshData(res.bodies[0].solid));

    const range = SEL.sizeRange(topo);
    assert(range.max > range.min, 'the faces are not all one size');

    const small = SEL.facesBySize(topo, { max: range.min * 1.001 });
    assert(small.length >= 1, 'at least the smallest');
    for (const i of small) {
      assert(topo.faces[i].area <= range.min * 1.001, 'and nothing above the line');
    }

    // Everything, when the range is everything.
    assert(
      SEL.facesBySize(topo, { min: 0, max: Infinity }).length === topo.faces.length,
      'no bound excludes nothing'
    );
    res.dispose();
  });

  test('select: invert is what was not chosen', () => {
    const doc = rebuild(boxDoc(40, 40, 40));
    const topo = buildTopology(K.meshData(doc.bodies[0].solid));
    const some = [0, 2];
    const rest = SEL.invert(topo.faces.length, some);
    assert(rest.length === topo.faces.length - 2, `four left, got ${rest.length}`);
    assert(!rest.includes(0) && !rest.includes(2), 'and not the two it started with');
    assert(
      SEL.invert(topo.faces.length, rest).sort().join() === some.sort().join(),
      'inverting twice is where you began'
    );
    doc.dispose();
  });

  test('select: grow takes the ring around, shrink gives it back', () => {
    const doc = rebuild(boxDoc(40, 40, 40));
    const topo = buildTopology(K.meshData(doc.bodies[0].solid));
    // Every face of a box touches four others, so one ring out from any face
    // is five, and the sixth is the one opposite it.
    const one = SEL.grow(topo, [0], 1);
    assert(one.length === 5, `five after one ring, got ${one.length}`);
    const two = SEL.grow(topo, [0], 2);
    assert(two.length === 6, `the whole box after two, got ${two.length}`);
    // Shrinking the whole box drops nothing, because nothing is on a border.
    assert(SEL.shrink(topo, two).length === 6, 'a closed set has no border');
    assert(SEL.shrink(topo, one).length < one.length, 'and an open one does');
    doc.dispose();
  });

  test('select: seed and boundary fills to the rim and stops', () => {
    // A box with a step cut into it. Seeded on the top and bounded by the
    // edges around it, the fill must not run down the sides.
    const doc = rebuild(boxDoc(40, 40, 20));
    const topo = buildTopology(K.meshData(doc.bodies[0].solid));
    const top = topo.faces.reduce(
      (best, f, i) => (f.centre[2] > topo.faces[best].centre[2] ? i : best),
      0
    );
    const rim = topo.edges.filter((e) => e.faceA === top || e.faceB === top).map((e) => e.id);

    const held = SEL.seedAndBoundary(topo, [top], rim);
    assert(held.length === 1, `the rim held it to one face, got ${held.length}`);

    // With no boundary at all it runs over the whole body, which is the same
    // walk with nothing stopping it.
    const all = SEL.seedAndBoundary(topo, [top], []);
    assert(all.length === topo.faces.length, `all six with no rim, got ${all.length}`);
    doc.dispose();
  });

  test('select: a tangent run is the whole of one smooth surface', () => {
    // Four upright edges rounded. Seeded on a flat, the run should take the
    // fillets either side of it, because those meet it without a crease, and
    // stop at the top and bottom faces, which do not.
    const first = rebuild(boxDoc(40, 40, 40)).bodies[0];
    const uprights = buildTopology(K.meshData(first.solid))
      .edges.filter((e) => e.kind === 'line' && e.convex && Math.abs(e.dir[2]) > 0.99)
      .map((e) => edgeReference(e));
    const doc = boxDoc(40, 40, 40);
    doc.features.push({
      id: uid('f'), type: 'fillet', bodies: 'all', sets: [{ edges: uprights, radius: '4' }]
    });
    const res = rebuild(doc);
    const topo = buildTopology(K.meshData(res.bodies[0].solid));

    const side = topo.faces.findIndex(
      (f) => f.planar && Math.abs(f.normal[2]) < 0.01
    );
    assert(side >= 0, 'found an upright flat');

    const run = SEL.tangentRun(topo, [side]);
    // The four walls and the four fillets between them: the whole band round
    // the box, and neither the top nor the bottom.
    assert(run.length === 8, `the band is eight faces, got ${run.length}`);
    for (const i of run) {
      assert(Math.abs(topo.faces[i].normal[2]) < 0.5, 'nothing facing up or down');
    }
    res.dispose();
  });

  test('select: similar finds the faces that match the one picked', () => {
    // Four bores of one size and one of another. Picking one of the four
    // should offer the other three and not the odd one.
    const doc = boxDoc(80, 80, 10);
    for (const [x, y] of [[-25, -25], [25, -25], [-25, 25], [25, 25]]) {
      doc.features.push({
        ...prim('cylinder', { diameter: '6', height: '40', x: String(x), y: String(y) }),
        op: 'cut', targets: 'all'
      });
    }
    doc.features.push({
      ...prim('cylinder', { diameter: '16', height: '40' }), op: 'cut', targets: 'all'
    });
    const res = rebuild(doc);
    const topo = buildTopology(K.meshData(res.bodies[0].solid));

    const smallBore = topo.faces.findIndex(
      (f) => f.cylinder && Math.abs(f.cylinder.radius - 3) < 0.3
    );
    assert(smallBore >= 0, 'found one of the small bores');

    const like = SEL.similarFaces(topo, [smallBore]);
    assert(like.length === 4, `the four that match, got ${like.length}`);
    for (const i of like) {
      near(topo.faces[i].cylinder.radius, 3, 0.3, 'all of them three across');
    }
    res.dispose();
  });

  /* -------- STEP -------- */

  /**
   * A valid STEP file for an axis aligned box, written out entity by entity.
   *
   * Generated rather than pasted so the numbers in the assertions come from the
   * same place as the geometry: a box of 40 by 30 by 20 has to read back as
   * 24000, and if it does not, one of the two is wrong in a way worth finding.
   */
  function stepBox(w, d, h) {
    const lines = [];
    let n = 0;
    const put = (text) => {
      n += 1;
      lines.push(`#${n}=${text};`);
      return n;
    };
    const pt = (x, y, z) => put(`CARTESIAN_POINT('',(${x},${y},${z}))`);
    const dir = (x, y, z) => put(`DIRECTION('',(${x},${y},${z}))`);

    const hx = w / 2;
    const hy = d / 2;
    const hz = h / 2;
    const corner = {};
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1])
          corner[`${sx},${sy},${sz}`] = pt(sx * hx, sy * hy, sz * hz);

    const vert = {};
    for (const k of Object.keys(corner)) vert[k] = put(`VERTEX_POINT('',#${corner[k]})`);

    const faces = [];
    // Each face: the outward normal, the in-plane x, and its four corners in
    // order round the ring.
    const specs = [
      { nrm: [1, 0, 0], x: [0, 1, 0], ring: ['1,-1,-1', '1,1,-1', '1,1,1', '1,-1,1'] },
      { nrm: [-1, 0, 0], x: [0, 0, 1], ring: ['-1,-1,-1', '-1,-1,1', '-1,1,1', '-1,1,-1'] },
      { nrm: [0, 1, 0], x: [0, 0, 1], ring: ['-1,1,-1', '-1,1,1', '1,1,1', '1,1,-1'] },
      { nrm: [0, -1, 0], x: [1, 0, 0], ring: ['-1,-1,-1', '1,-1,-1', '1,-1,1', '-1,-1,1'] },
      { nrm: [0, 0, 1], x: [1, 0, 0], ring: ['-1,-1,1', '1,-1,1', '1,1,1', '-1,1,1'] },
      { nrm: [0, 0, -1], x: [0, 1, 0], ring: ['-1,-1,-1', '-1,1,-1', '1,1,-1', '1,-1,-1'] }
    ];

    for (const f of specs) {
      const o = pt(f.nrm[0] * hx, f.nrm[1] * hy, f.nrm[2] * hz);
      const z = dir(...f.nrm);
      const xd = dir(...f.x);
      const place = put(`AXIS2_PLACEMENT_3D('',#${o},#${z},#${xd})`);
      const plane = put(`PLANE('',#${place})`);

      const oriented = [];
      for (let i = 0; i < f.ring.length; i++) {
        const a = vert[f.ring[i]];
        const b = vert[f.ring[(i + 1) % f.ring.length]];
        const lp = pt(0, 0, 0);
        const ld = dir(1, 0, 0);
        const vec = put(`VECTOR('',#${ld},1.)`);
        const line = put(`LINE('',#${lp},#${vec})`);
        const edge = put(`EDGE_CURVE('',#${a},#${b},#${line},.T.)`);
        oriented.push(put(`ORIENTED_EDGE('',*,*,#${edge},.T.)`));
      }
      const loop = put(`EDGE_LOOP('',(${oriented.map((i) => `#${i}`).join(',')}))`);
      const bound = put(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      faces.push(put(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`));
    }

    const shell = put(`CLOSED_SHELL('',(${faces.map((i) => `#${i}`).join(',')}))`);
    put(`MANIFOLD_SOLID_BREP('box',#${shell})`);

    return [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION((''),'2;1');",
      "FILE_NAME('box.step','2026-09-06T00:00:00',(''),(''),'','','');",
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
      'ENDSEC;',
      'DATA;',
      ...lines,
      'ENDSEC;',
      'END-ISO-10303-21;'
    ].join('\n');
  }

  test('step: the parser reads the shapes the grammar allows', () => {
    const text = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_NAME('a''b.step','',(''),(''),'','','');",
      'ENDSEC;',
      'DATA;',
      "#1=CARTESIAN_POINT('origin',(0.,1.5,-2.));",
      '/* a comment, with a ) and a , in it */',
      "#2=DIRECTION('',(0.,0.,1.));",
      '#3=AXIS2_PLACEMENT_3D($,#1,#2,*);',
      "#4=ADVANCED_FACE('',(#3),#1,.F.);",
      '#5=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#1)));',
      'ENDSEC;',
      'END-ISO-10303-21;'
    ].join('\n');

    const step = parseSTEP(text);
    assert(step.instances.size === 5, `five instances, got ${step.instances.size}`);

    const p = step.instances.get(1);
    assert(p.type === 'CARTESIAN_POINT', p.type);
    assert(p.args[0] === 'origin', 'the name is a string');
    near(p.args[1][1], 1.5, 1e-9, 'and the coordinates are numbers');
    near(p.args[1][2], -2, 1e-9, 'negative ones included');

    const a = step.instances.get(3);
    assert(a.args[0] === UNSET, '$ is absent, not the string "$"');
    assert(a.args[1] instanceof Ref && a.args[1].id === 1, 'a reference resolves by id');
    assert(step.get(a.args[1]).type === 'CARTESIAN_POINT', 'and points at the right thing');

    const f = step.instances.get(4);
    assert(f.args[3] instanceof Enum && f.args[3].name === 'F', 'an enumeration is its own kind');
    assert(Array.isArray(f.args[1]) && f.args[1][0] instanceof Ref, 'a list of references');

    // A complex instance is several types at once, and each is findable.
    assert(step.all('GLOBAL_UNIT_ASSIGNED_CONTEXT').length === 1, 'the complex instance is indexed');
    assert(step.all('GEOMETRIC_REPRESENTATION_CONTEXT').length === 1, 'under each of its types');

    // The comment did not eat the entity after it.
    assert(step.instances.get(2).type === 'DIRECTION', 'the comment was skipped whole');

    // A doubled quote inside a string is one quote, not the end of it.
    const head = stepHeader(text);
    assert(head.FILE_NAME[0] === "a'b.step", `unescaped to ${head.FILE_NAME[0]}`);
  });

  test('step: a box reads back at the size it was written', () => {
    const out = readSTEP(stepBox(40, 30, 20));
    assert(out.bodies.length === 1, `one solid, got ${out.bodies.length}`);
    assert(out.faces === 6, `six faces, got ${out.faces}`);
    assert(out.unreadFaces === 0, `all six understood, ${out.unreadFaces} were not`);

    const body = out.bodies[0];
    {
      const vp = body.mesh.vertProperties;
      const bad = [];
      for (let i = 0; i < vp.length; i++) if (!Number.isFinite(vp[i])) bad.push(i);
      const tv = body.mesh.triVerts;
      let maxIdx = -1;
      for (let i = 0; i < tv.length; i++) maxIdx = Math.max(maxIdx, tv[i]);
      assert(
        bad.length === 0 && maxIdx < vp.length / 3,
        `verts=${vp.length / 3} tris=${tv.length / 3} maxIdx=${maxIdx} nonFinite=${bad.length} ` +
          `first=${[...vp.slice(0, 9)].map((n) => Number(n.toFixed(2)))}`
      );
    }
    assert(body.closed, 'and the shell is closed');
    assert(body.mesh.triVerts.length / 3 === 12, `two triangles a face, got ${body.mesh.triVerts.length / 3}`);

    // The measurement that matters: it is the box it said it was.
    const scope = new K.Scope();
    let solid;
    try {
      solid = K.ofMesh(body.mesh.vertProperties, body.mesh.triVerts, scope);
    } catch (err) {
      const vp = body.mesh.vertProperties;
      const tv = body.mesh.triVerts;
      let bad = -1;
      for (let i = 0; i < vp.length; i++) if (!Number.isFinite(vp[i])) { bad = i; break; }
      assert(false, `${err.message} :: verts=${vp.length / 3} tris=${tv.length / 3} ` +
        `firstBad=${bad} sample=${[...vp.slice(0, 9)]} tri0=${[...tv.slice(0, 3)]}`);
    }
    assert(K.status(solid) === 'NoError', `a real solid, got ${K.status(solid)}`);
    near(solid.volume(), 40 * 30 * 20, 1e-6, 'forty by thirty by twenty');
    assert(solid.genus() === 0, 'and a plain one');

    // Facing outwards, not inwards: a solid built inside out has negative
    // volume, and manifold would have told us, but the faces are worth
    // checking directly too.
    const topo = buildTopology(K.meshData(solid));
    assert(topo.faces.length === 6, `six faces after the round trip, got ${topo.faces.length}`);
    scope.dispose();
  });

  test('step: a cylindrical face lands on its own cylinder', () => {
    // Half a pipe: one face on a cylindrical surface, bounded by two straight
    // edges and two arcs. A full revolution has a seam and is its own problem;
    // this is the mapping itself, which is what a curved face turns on.
    const r = 10;
    const hHalf = 15;
    const lines = [];
    let n = 0;
    const put = (t) => {
      n += 1;
      lines.push(`#${n}=${t};`);
      return n;
    };
    const pt = (x, y, z) => put(`CARTESIAN_POINT('',(${x},${y},${z}))`);
    const dir = (x, y, z) => put(`DIRECTION('',(${x},${y},${z}))`);

    const axisO = pt(0, 0, 0);
    const axisZ = dir(0, 0, 1);
    const axisX = dir(1, 0, 0);
    const place = put(`AXIS2_PLACEMENT_3D('',#${axisO},#${axisZ},#${axisX})`);
    const surf = put(`CYLINDRICAL_SURFACE('',#${place},${r}.)`);

    const v = (x, y, z) => put(`VERTEX_POINT('',#${pt(x, y, z)})`);
    const a0 = v(r, 0, -hHalf);
    const a1 = v(-r, 0, -hHalf);
    const b1 = v(-r, 0, hHalf);
    const b0 = v(r, 0, hHalf);

    const circAt = (z) => {
      const o = pt(0, 0, z);
      const zz = dir(0, 0, 1);
      const xx = dir(1, 0, 0);
      const pl = put(`AXIS2_PLACEMENT_3D('',#${o},#${zz},#${xx})`);
      return put(`CIRCLE('',#${pl},${r}.)`);
    };
    const lineThrough = () => {
      const o = pt(0, 0, 0);
      const d0 = dir(0, 0, 1);
      const vec = put(`VECTOR('',#${d0},1.)`);
      return put(`LINE('',#${o},#${vec})`);
    };

    const eBottom = put(`EDGE_CURVE('',#${a0},#${a1},#${circAt(-hHalf)},.T.)`);
    const eLeft = put(`EDGE_CURVE('',#${a1},#${b1},#${lineThrough()},.T.)`);
    const eTop = put(`EDGE_CURVE('',#${b1},#${b0},#${circAt(hHalf)},.T.)`);
    const eRight = put(`EDGE_CURVE('',#${b0},#${a0},#${lineThrough()},.T.)`);

    const oe = [eBottom, eLeft, eTop, eRight].map((e) =>
      put(`ORIENTED_EDGE('',*,*,#${e},.T.)`)
    );
    const loop = put(`EDGE_LOOP('',(${oe.map((i) => `#${i}`).join(',')}))`);
    const bound = put(`FACE_OUTER_BOUND('',#${loop},.T.)`);
    const face = put(`ADVANCED_FACE('',(#${bound}),#${surf},.T.)`);
    put(`OPEN_SHELL('',(#${face}))`);

    const text = ['ISO-10303-21;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
    const out = readSTEP(text, { tolerance: 0.02 });

    assert(out.bodies.length === 1, `one patch, got ${out.bodies.length}`);
    assert(out.unreadFaces === 0, 'the cylindrical surface was understood');

    const mesh = out.bodies[0].mesh;
    const count = mesh.vertProperties.length / 3;
    assert(count > 20, `arcs were walked, not chorded: ${count} points`);

    // Every point sits on the cylinder it was defined on, which is the whole
    // claim a parametric surface makes.
    let worst = 0;
    let zLo = Infinity;
    let zHi = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = mesh.vertProperties[i * 3];
      const y = mesh.vertProperties[i * 3 + 1];
      const z = mesh.vertProperties[i * 3 + 2];
      worst = Math.max(worst, Math.abs(Math.hypot(x, y) - r));
      zLo = Math.min(zLo, z);
      zHi = Math.max(zHi, z);
    }
    near(worst, 0, 1e-4, 'every point is exactly one radius from the axis');
    near(zLo, -hHalf, 1e-4, 'and it runs the height it was given');
    near(zHi, hHalf, 1e-4, 'at both ends');
  });

  test('step: a surface it cannot read is counted, not lost', () => {
    // A face on a B-spline. Reading it is a later job; pretending the part is
    // complete without it is how something gets printed with a hole in it.
    const text = [
      'ISO-10303-21;',
      'DATA;',
      "#1=CARTESIAN_POINT('',(0.,0.,0.));",
      "#2=DIRECTION('',(0.,0.,1.));",
      "#3=DIRECTION('',(1.,0.,0.));",
      "#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);",
      "#5=B_SPLINE_SURFACE_WITH_KNOTS('',3,3,((#1)),.UNSPECIFIED.,.F.,.F.,.F.,(4),(4),(0.),(1.),.UNSPECIFIED.);",
      "#6=VERTEX_POINT('',#1);",
      "#7=EDGE_LOOP('',());",
      "#8=FACE_OUTER_BOUND('',#7,.T.);",
      "#9=ADVANCED_FACE('',(#8),#5,.T.);",
      "#10=CLOSED_SHELL('',(#9));",
      'ENDSEC;',
      'END-ISO-10303-21;'
    ].join('\n');

    const out = readSTEP(text);
    assert(out.faces === 1, 'one face was seen');
    assert(out.unreadFaces === 1, 'and it is reported as unread');
    assert(
      out.unread.includes('B_SPLINE_SURFACE_WITH_KNOTS'),
      `naming the surface kind, got ${JSON.stringify(out.unread)}`
    );
    assert(out.bodies.length === 0, 'and nothing was invented in its place');
  });

  /* -------- recognition -------- */

  /** A plate with holes drilled through it, at two sizes. */
  function drilledPlate(holes) {
    const doc = newDocument();
    doc.features = [prim('box', { width: '80', depth: '60', height: '10' })];
    for (const h of holes) {
      doc.features.push({
        ...prim('cylinder', { diameter: String(h.d), height: '40', x: String(h.x), y: String(h.y) }),
        op: 'cut',
        targets: 'all'
      });
    }
    return doc;
  }

  test('recognise: finds every hole and measures it', () => {
    // Four bores through a plate, two at six and two at ten. Nothing about the
    // model says "hole": they are the shape left behind by a cut.
    const doc = drilledPlate([
      { d: 6, x: -25, y: -15 },
      { d: 6, x: 25, y: -15 },
      { d: 10, x: -25, y: 15 },
      { d: 10, x: 25, y: 15 }
    ]);
    const res = rebuild(doc);
    assert(res.errors.length === 0, JSON.stringify(res.errors));
    const mesh = K.meshData(res.bodies[0].solid);
    const found = RC.recognise(mesh, buildTopology(mesh));

    assert(found.counts.holes === 4, `four holes, got ${found.counts.holes}`);
    assert(found.counts.through === 4, `all four go through, got ${found.counts.through}`);

    // Two sizes, two of each, measured rather than assumed.
    assert(found.holeSizes.length === 2, `two sizes, got ${found.holeSizes.length}`);
    near(found.holeSizes[0].size, 6, 0.15, 'the small ones');
    near(found.holeSizes[1].size, 10, 0.2, 'the large ones');
    assert(found.holeSizes[0].items.length === 2, 'two of the small');
    assert(found.holeSizes[1].items.length === 2, 'two of the large');

    // Each runs the full thickness of the plate, along Z.
    for (const h of found.holes) {
      near(h.depth, 10, 0.2, 'through the ten of plate');
      near(Math.abs(h.axis[2]), 1, 1e-6, 'and along Z');
    }
    res.dispose();
  });

  test('recognise: a blind hole is not a through one', () => {
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '60', depth: '60', height: '20' }),
      // Down from the top face, stopping short of the bottom.
      { ...prim('cylinder', { diameter: '8', height: '12', z: '4' }), op: 'cut', targets: 'all' }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, JSON.stringify(res.errors));
    const mesh = K.meshData(res.bodies[0].solid);
    const found = RC.recognise(mesh, buildTopology(mesh));

    assert(found.counts.holes === 1, `one hole, got ${found.counts.holes}`);
    assert(found.counts.through === 0, 'and it does not go through');
    near(found.holes[0].diameter, 8, 0.15, 'eight across');
    // The plate runs z = -10 to 10 and the cut runs -2 to 10, so the bore is
    // twelve deep and stops eight short of the far face.
    near(found.holes[0].depth, 12, 0.3, 'twelve deep');
    res.dispose();
  });

  test('recognise: a peg is not a hole', () => {
    // The same cylinder, joined instead of cut. Every measurement is identical
    // except which way the surface faces, which is the whole test.
    const doc = newDocument();
    doc.features = [
      prim('box', { width: '60', depth: '60', height: '10' }),
      { ...prim('cylinder', { diameter: '8', height: '30', z: '15' }), op: 'join', targets: 'all' }
    ];
    const res = rebuild(doc);
    assert(res.errors.length === 0, JSON.stringify(res.errors));
    const mesh = K.meshData(res.bodies[0].solid);
    const topo = buildTopology(mesh);
    const found = RC.recognise(mesh, topo);

    assert(found.counts.holes === 0, `a boss is not a hole, got ${found.counts.holes}`);
    // But it is there, as a cylinder the topology fitted.
    assert(
      topo.faces.some((f) => f.cylinder && Math.abs(f.cylinder.radius - 4) < 0.2),
      'the peg is still found as a cylinder'
    );
    res.dispose();
  });

  test('recognise: tells a fillet from a wall', () => {
    // The four upright edges rounded, which leaves four separate strips: the
    // flats above and below keep them apart. A blend that runs into another
    // blend is one continuous surface and is dealt with below.
    const first = rebuild(boxDoc(40, 40, 40)).bodies[0];
    const uprights = buildTopology(K.meshData(first.solid))
      .edges.filter((e) => e.kind === 'line' && e.convex && Math.abs(e.dir[2]) > 0.99)
      .map((e) => edgeReference(e));

    const doc = boxDoc(40, 40, 40);
    doc.features.push({
      id: uid('f'),
      type: 'fillet',
      bodies: 'all',
      sets: [{ edges: uprights, radius: '4' }]
    });
    const res = rebuild(doc);
    assert(res.bodies.length === 1, JSON.stringify(res.errors));
    const mesh = K.meshData(res.bodies[0].solid);
    const found = RC.recognise(mesh, buildTopology(mesh));

    assert(found.fillets.length === 4, `four fillets, got ${found.fillets.length}`);
    for (const f of found.fillets) {
      assert(f.convex, 'rounding an outside edge is a convex blend');
      near(f.radius, 4, 0.05, 'measured at the radius it was given');
      near(f.length, 40, 0.5, 'and running the height of the box');
    }
    assert(found.filletSizes.length === 1, 'all one size');
    // None of them is a hole, which is the same sign read the other way.
    assert(found.holes.length === 0, `and none is a bore, got ${found.holes.length}`);

    // A plain box has none, which is what makes the test above mean anything.
    const plain = rebuild(boxDoc(40, 40, 40));
    const plainMesh = K.meshData(plain.bodies[0].solid);
    const none = RC.recognise(plainMesh, buildTopology(plainMesh));
    assert(none.fillets.length === 0, `a box has no fillets, got ${none.fillets.length}`);
    res.dispose();
    plain.dispose();
  });

  test('recognise: blends that run together are one surface, and it says so', () => {
    // Rounding every edge of a box leaves no flat between one blend and the
    // next, so they are a single continuous surface rather than twelve
    // fillets. Reporting one curved face here is the honest answer; claiming
    // twelve would mean inventing boundaries the geometry does not have.
    const doc = boxDoc(40, 40, 40);
    doc.features.push({
      id: uid('f'), type: 'fillet', bodies: 'all', sets: [{ edges: [], radius: '4' }]
    });
    const res = rebuild(doc);
    const mesh = K.meshData(res.bodies[0].solid);
    const topo = buildTopology(mesh);
    assert(topo.faces.length === 7, `six flats and one blend shell, got ${topo.faces.length}`);
    const found = RC.recognise(mesh, topo);
    assert(found.fillets.length === 0, 'and not one of them fits a cylinder on its own');
    res.dispose();
  });

  test('recognise: works the same on a body that arrived as a mesh', () => {
    // The point of the exercise. A model that came in from outside has no
    // history and no features, and it still reads as four holes in a plate.
    const doc = drilledPlate([
      { d: 6, x: -20, y: 0 },
      { d: 6, x: 20, y: 0 },
      { d: 12, x: 0, y: 20 },
      { d: 12, x: 0, y: -20 }
    ]);
    const solid = rebuild(doc);
    const asBuilt = RC.recognise(
      K.meshData(solid.bodies[0].solid),
      buildTopology(K.meshData(solid.bodies[0].solid))
    );

    // Round trip it through STL, which keeps nothing but triangles.
    const stl = toBinarySTL([K.meshData(solid.bodies[0].solid)]);
    const back = parseSTL(stl);
    const imported = RC.recognise(back, buildTopology(back));

    assert(
      imported.counts.holes === asBuilt.counts.holes,
      `the same holes after a round trip: ${imported.counts.holes} against ${asBuilt.counts.holes}`
    );
    assert(imported.holeSizes.length === 2, `two sizes, got ${imported.holeSizes.length}`);
    near(imported.holeSizes[0].size, 6, 0.2, 'still six');
    near(imported.holeSizes[1].size, 12, 0.3, 'still twelve');
    solid.dispose();
  });

  /* -------- rebuild cache -------- */

  /** A part with enough in front of the last feature to be worth skipping. */
  function stackDoc(topRadius = '3') {
    const doc = newDocument();
    doc.parameters = [{ name: 'wall', expr: '4' }];
    doc.features = [
      prim('box', { width: '40', depth: '30', height: '20' }),
      { ...prim('cylinder', { diameter: '10', height: '40' }), op: 'cut', targets: 'all' },
      { id: uid('f'), type: 'fillet', bodies: 'all', radius: topRadius }
    ];
    return doc;
  }

  test('cache: a second rebuild of the same document does no work', () => {
    const cache = new RebuildCache();
    const doc = stackDoc();

    const first = rebuild(doc, { cache });
    assert(first.errors.length === 0, JSON.stringify(first.errors));
    const built = cache.replayed;
    assert(built === 3, `three features built, got ${built}`);

    const again = rebuild(doc, { cache });
    assert(cache.replayed === built, `nothing rebuilt, got ${cache.replayed - built} more`);
    near(
      again.bodies[0].solid.volume(),
      first.bodies[0].solid.volume(),
      1e-6,
      'and it is the same part'
    );
    again.dispose();
    first.dispose();
    cache.dispose();
  });

  test('cache: editing the last feature replays only that one', () => {
    const cache = new RebuildCache();
    const doc = stackDoc('3');
    const before = rebuild(doc, { cache });
    const built = cache.replayed;
    before.dispose();

    // Through the sets, because the first build brought the fillet up to date
    // and that is where its radius lives now.
    doc.features[2].sets[0].radius = '5';
    const after = rebuild(doc, { cache });
    assert(cache.replayed - built === 1, `one feature replayed, got ${cache.replayed - built}`);

    // And the answer is the one a run from nothing gives.
    const plainDoc = stackDoc('5');
    const plain = rebuild(plainDoc);
    near(
      after.bodies[0].solid.volume(),
      plain.bodies[0].solid.volume(),
      1e-6,
      'the cached answer matches the full replay'
    );
    after.dispose();
    plain.dispose();
    cache.dispose();
  });

  test('cache: editing the first feature replays all of them', () => {
    const cache = new RebuildCache();
    const doc = stackDoc();
    const before = rebuild(doc, { cache });
    const built = cache.replayed;
    before.dispose();

    doc.features[0].params.width = '60';
    const after = rebuild(doc, { cache });
    assert(cache.replayed - built === 3, `all three, got ${cache.replayed - built}`);

    const plain = stackDoc();
    plain.features[0].params.width = '60';
    const full = rebuild(plain);
    near(after.bodies[0].solid.volume(), full.bodies[0].solid.volume(), 1e-6, 'same part');
    after.dispose();
    full.dispose();
    cache.dispose();
  });

  test('cache: a parameter is outside the features, so it invalidates all of them', () => {
    // The fillet reads `wall` and nothing about the fillet itself changes when
    // `wall` does. A cache that only watched the feature would miss it.
    const cache = new RebuildCache();
    const doc = stackDoc('wall');
    const before = rebuild(doc, { cache });
    const built = cache.replayed;
    const wasVolume = before.bodies[0].solid.volume();
    before.dispose();

    doc.parameters[0].expr = '2';
    const after = rebuild(doc, { cache });
    assert(cache.replayed - built === 3, `all three, got ${cache.replayed - built}`);
    assert(
      Math.abs(after.bodies[0].solid.volume() - wasVolume) > 1,
      'and the part actually changed'
    );
    after.dispose();
    cache.dispose();
  });

  test('cache: a sketch edit invalidates the feature built on it', () => {
    const mk = (width) => {
      const doc = newDocument();
      const sk = newSketch('XY', 'Plate');
      sk.points = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: 30 }, { x: 0, y: 30 }];
      sk.entities = [
        { id: 1, type: 'line', p: [0, 1] },
        { id: 2, type: 'line', p: [1, 2] },
        { id: 3, type: 'line', p: [2, 3] },
        { id: 4, type: 'line', p: [3, 0] }
      ];
      sk.nextEntityId = 5;
      sk.id = 'sk1';
      doc.sketches.sk1 = sk;
      doc.features = [
        { id: 'fsk', type: 'sketch', sketch: 'sk1' },
        { id: 'fex', type: 'extrude', sketch: 'sk1', seeds: null, distance: '10', op: 'new', targets: 'all' }
      ];
      return doc;
    };

    const cache = new RebuildCache();
    const doc = mk(40);
    const first = rebuild(doc, { cache });
    near(first.bodies[0].solid.volume(), 40 * 30 * 10, 1, 'the plate it was drawn as');
    const built = cache.replayed;
    first.dispose();

    // Nothing in the extrude changed, and nothing in the sketch feature either.
    // Only the sketch it names, which is where a cache that watched the
    // features alone would hand back the old plate.
    doc.sketches.sk1.points[1].x = 60;
    doc.sketches.sk1.points[2].x = 60;
    const after = rebuild(doc, { cache });
    assert(cache.replayed - built === 2, `both replayed, got ${cache.replayed - built}`);
    near(after.bodies[0].solid.volume(), 60 * 30 * 10, 1, 'and it is the wider plate');
    after.dispose();
    cache.dispose();
  });

  test('cache: a face reference into the part before the edit still resolves', () => {
    // The cached geometry carries provenance ids from the run that built it.
    // Without putting those back, every face of the untouched part becomes
    // anonymous the moment a later feature is edited.
    const cache = new RebuildCache();
    const doc = newDocument();
    doc.features = [prim('box', { width: '40', depth: '30', height: '20' })];
    const first = rebuild(doc, { cache });
    const topo = buildTopology(K.meshData(first.bodies[0].solid));
    const top = topo.faces.reduce((a, b) => (b.centre[2] > a.centre[2] ? b : a));
    const ref = faceReference(top);
    assert(ref.src?.tag, 'the face knows which feature made it');
    first.dispose();

    doc.features.push({
      id: uid('f'),
      type: 'fillet',
      bodies: 'all',
      sets: [{ edges: [], radius: '2' }]
    });
    const after = rebuild(doc, { cache });
    assert(cache.hits >= 1, 'the box was reused');
    const back = buildTopology(K.meshData(after.bodies[0].solid));
    const [found] = resolveFaceRefs(back, [ref]);
    assert(found, 'and the face reference into it still lands');
    after.dispose();
    cache.dispose();
  });

  test('cache: rolling back and forward again keeps the answer', () => {
    const cache = new RebuildCache();
    const doc = stackDoc();
    const full = rebuild(doc, { cache });
    const whole = full.bodies[0].solid.volume();
    full.dispose();

    const rolled = rebuild(doc, { cache, upTo: 1 });
    assert(rolled.bodies.length === 1, 'the part as it stood two features in');
    const partial = rolled.bodies[0].solid.volume();
    assert(partial > whole, 'with the fillet not yet cut');
    rolled.dispose();

    const back = rebuild(doc, { cache });
    near(back.bodies[0].solid.volume(), whole, 1e-6, 'and the whole part comes back');
    back.dispose();
    cache.dispose();
  });

  test('face groups: two faces set by hand become one', () => {
    // A box has six faces at any sensible angle. Combining two of them leaves
    // five, and the one that is left holds the triangles of both.
    const box = rebuild(boxDoc(40, 30, 20)).bodies[0];
    const mesh = K.meshData(box.solid);
    const plain = buildTopology(mesh);
    assert(plain.faces.length === 6, `six to start, got ${plain.faces.length}`);

    const top = plain.faces.reduce((a, b) => (b.centre[2] > a.centre[2] ? b : a));
    const side = plain.faces.find((f) => Math.abs(f.normal[0] - 1) < 1e-6);
    assert(top && side && top !== side, 'a top and a side to join');

    const labels = new Int32Array(mesh.triVerts.length / 3).fill(-1);
    for (const t of top.tris) labels[t] = 0;
    for (const t of side.tris) labels[t] = 0;

    const joined = buildTopology(mesh, { labels });
    assert(joined.faces.length === 5, `five after, got ${joined.faces.length}`);

    const both = joined.faces.find((f) => f.tris.includes(top.tris[0]));
    assert(both, 'the joined face is there');
    for (const t of side.tris) {
      assert(both.tris.includes(t), 'and it took the side in with it');
    }
  });

  test('face groups: a hand set group holds against the angle', () => {
    // The top of a box is flat, so any angle keeps it whole. Pinning half of
    // its triangles splits it in two, which nothing the angle can say would
    // ever do, and that is the point: the answer is pointed at, not derived.
    const box = rebuild(boxDoc(40, 30, 20)).bodies[0];
    const mesh = K.meshData(box.solid);
    const plain = buildTopology(mesh);
    const top = plain.faces.reduce((a, b) => (b.centre[2] > a.centre[2] ? b : a));
    assert(top.tris.length >= 2, `the top is more than one triangle`);

    const labels = new Int32Array(mesh.triVerts.length / 3).fill(-1);
    labels[top.tris[0]] = 7;

    const split = buildTopology(mesh, { labels });
    assert(split.faces.length === 7, `the top came apart, got ${split.faces.length}`);

    const own = split.faces.find((f) => f.tris.length === 1 && f.tris[0] === top.tris[0]);
    assert(own, 'the pinned triangle is a face of its own');

    // And everything else is untouched: the five other sides are still whole.
    const whole = split.faces.filter((f) => f.tris.length === top.tris.length);
    assert(whole.length === 5, `five sides left alone, got ${whole.length}`);
  });

  test('face groups: through the timeline, combine and then release', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '40', depth: '30', height: '20' })];
    const solidOnly = rebuild(doc);
    const mesh = K.meshData(solidOnly.bodies[0].solid);
    const topo = buildTopology(mesh);
    const top = topo.faces.reduce((a, b) => (b.centre[2] > a.centre[2] ? b : a));
    const side = topo.faces.find((f) => Math.abs(f.normal[0] - 1) < 1e-6);

    // A mesh body, because face groups are a mesh idea.
    doc.features.push({ id: uid('f'), type: 'tessellate', bodies: 'all' });
    const meshed = rebuild(doc);
    const body = meshed.bodies.find((b) => b.mesh);
    assert(body, 'there is a mesh body to group');

    const refs = [
      { bodyId: body.id, face: faceReference(top) },
      { bodyId: body.id, face: faceReference(side) }
    ];
    const editId = uid('f');
    doc.features.push({
      id: editId,
      type: 'faceGroupEdit',
      op: 'combine',
      bodies: [body.id],
      faces: refs
    });
    const joined = rebuild(doc);
    assert(joined.errors.length === 0, joined.errors.map((e) => e.message).join('; '));
    const grouped = joined.bodies.find((b) => b.mesh);
    assert(grouped.groupLabels, 'the body carries the group it was given');
    assert(
      buildTopology(meshOf(grouped), topologyOptions(grouped)).faces.length === 5,
      'and it reads as five faces'
    );

    // Generating again is the way back.
    doc.features.push({ id: uid('f'), type: 'faceGroups', bodies: [body.id], angle: '30' });
    const back = rebuild(doc);
    const plain = back.bodies.find((b) => b.mesh);
    assert(!plain.groupLabels, 'regenerating throws the hand set groups away');
    assert(
      buildTopology(meshOf(plain), topologyOptions(plain)).faces.length === 6,
      'and the box is six faces again'
    );
  });

  test('sheet metal: a miter closes the corner between two flanges', () => {
    // Two flanges off adjoining edges leave a notch: each stands outside its
    // own edge, so between them is a square of nothing the width of the
    // material. The miter runs both into it and cuts them on the bisector.
    //
    // For a square corner the answer is in closed form. The two flange planes
    // meet at x = 64 and y = 44, one thickness and one bend radius out from the
    // sixty by forty plate. Each flange is square cut through its thickness, so
    // it has to clear that line by the thickness as well as by its share of the
    // gap, which lands the end at the corner less T + gap/root two.
    const part = trayPart();
    const frames = SM.resolveFrames(part, SM_T, SM_K, {});
    const gap = 0.2;
    assert(SM.miterCorners(part, frames, gap, { thickness: SM_T }) === 1, 'one corner');

    const back = SM_T + gap / Math.SQRT2;
    const p1 = SM.panelById(part, 'p1');
    const p2 = SM.panelById(part, 'p2');
    const vs = (p) => p.contour.map((q) => q[1]);

    // p1 runs along y and had reached the plate edge at 40. The corner line is
    // at y = 44, so it now stops short of that by T + gap/root two.
    near(Math.max(...vs(p1)), 44 - back, 1e-6, 'the first flange reaches the corner');
    // p2 runs the other way, from x = 60 back to 0, so its corner is at v = -4.
    near(Math.min(...vs(p2)), -4 + back, 1e-6, 'and the second one meets it');

    // Which leaves exactly the gap between them, square to the miter.
    const f1 = frames.get('p1');
    const f2 = frames.get('p2');
    const endOf = (f, v, w) => SM.panelPointToWorld(f, 0, v, w);
    // The nearest corners of the two ends, which is where they would touch.
    const a = endOf(f1, 44 - back, SM_T);
    const b = endOf(f2, -4 + back, SM_T);
    near(Math.hypot(a[0] - b[0], a[1] - b[1]), gap, 1e-6, 'and the gap the rule asked for');
  });

  test('sheet metal: a mitred corner holds more material and grows no bigger', () => {
    const scope = new K.Scope();
    const plain = SM.buildPart(trayPart(), scope, { thickness: SM_T, kFactor: SM_K });
    const part = trayPart();
    SM.miterCorners(part, SM.resolveFrames(part, SM_T, SM_K, {}), 0.2, { thickness: SM_T });
    const mitred = SM.buildPart(part, scope, { thickness: SM_T, kFactor: SM_K });

    assert(mitred.volume() > plain.volume(), 'the notch was filled, not opened');
    const a = plain.boundingBox();
    const b = mitred.boundingBox();
    for (let i = 0; i < 3; i++) {
      near(b.max[i], a.max[i], 1e-3, `it grew along axis ${i}`);
      near(b.min[i], a.min[i], 1e-3, `it grew back along axis ${i}`);
    }
    scope.dispose();
  });

  test('sheet metal: flanges on opposite edges have no corner to miter', () => {
    const part = SM.newPart({ thickness: SM_T, bendRadius: SM_R });
    SM.addBasePanel(part, [[0, 0], [60, 0], [60, 40], [0, 40]], [], SM_XY, 'p0');
    SM.addFlangePanel(part, 'p0', { a: [60, 0], b: [60, 40] }, {
      angle: Math.PI / 2, radius: SM_R, height: 15, panelId: 'p1', bendId: 'b0'
    });
    SM.addFlangePanel(part, 'p0', { a: [0, 0], b: [0, 40] }, {
      angle: Math.PI / 2, radius: SM_R, height: 15, panelId: 'p2', bendId: 'b1'
    });
    const before = JSON.stringify(part.panels.map((p) => p.contour));
    const frames = SM.resolveFrames(part, SM_T, SM_K, {});
    assert(SM.miterCorners(part, frames, 0.2, { thickness: SM_T }) === 0, 'nothing to cut');
    assert(
      JSON.stringify(part.panels.map((p) => p.contour)) === before,
      'and it left the flanges where they were'
    );
  });

  test('sheet metal: three bends meeting at a point read as one corner', () => {
    // Two flanges off the plate, and a third off one of those, all reaching
    // the same vertex. That corner exists only in the folded part, because the
    // third bend belongs to a panel that has been folded away, and it is the
    // one a corner relief worked out flat cannot see.
    const part = trayPart();
    // A tab folded across the end of the first flange, at the corner: the
    // closed corner of a tray, and the one that has three bends in it.
    SM.addFlangePanel(part, 'p1', { a: [0, 40], b: [15, 40] }, {
      angle: Math.PI / 2, radius: SM_R, height: 10, panelId: 'p3', bendId: 'b2'
    });
    const frames = SM.resolveFrames(part, SM_T, SM_K, {});
    const corners = SM.bendCorners(part, frames, SM_T);

    const deep = corners.filter((c) => c.bends.length >= 3);
    assert(deep.length === 1, `one corner of three bends, got ${deep.length}`);
    assert(
      ['b0', 'b1', 'b2'].every((id) => deep[0].bends.includes(id)),
      `all three meet there, got ${JSON.stringify(deep[0].bends)}`
    );

    // Big enough to clear the bends that fold into it.
    assert(deep[0].reach >= SM_R + SM_T - 1e-9, `a reach of ${deep[0].reach}`);

    // The plain part has the same two bends meeting and nothing deeper.
    const flat = trayPart();
    const only = SM.bendCorners(flat, SM.resolveFrames(flat, SM_T, SM_K, {}), SM_T);
    assert(only.length === 1 && only[0].bends.length === 2, 'two bends and no more');

    // And a tab at the far end of the same flange is not this corner. It is a
    // bend on the same panel with the same shape, so nothing but where it sits
    // tells the two apart.
    const away = trayPart();
    SM.addFlangePanel(away, 'p1', { a: [0, 0], b: [15, 0] }, {
      angle: Math.PI / 2, radius: SM_R, height: 10, panelId: 'p3', bendId: 'b2'
    });
    const none = SM.bendCorners(away, SM.resolveFrames(away, SM_T, SM_K, {}), SM_T);
    assert(
      none.every((c) => c.bends.length === 2),
      'a tab at the other end is not part of the corner'
    );
  });

  test('sheet metal: a document keeps a library of rules, not one rule', () => {
    const doc = newDocument();
    assert(doc.sheetMetalRules.length > 1, 'more than one to choose from');
    assert(typeof doc.sheetMetalRule === 'string', 'and the active one is named');
    assert(
      doc.sheetMetalRules.some((r) => r.name === doc.sheetMetalRule),
      'by a name the library actually holds'
    );

    // A document written when there was one rule keeps the numbers it was made
    // to rather than picking up whatever the first stock rule says.
    const old = newDocument();
    old.sheetMetalRules = null;
    old.sheetMetalRule = { name: 'Brass 0.8', thickness: '0.8', bendRadius: '1', kFactor: '0.4' };
    normalizeSheetRules(old);
    assert(old.sheetMetalRule === 'Brass 0.8', `read back as ${old.sheetMetalRule}`);
    const back = old.sheetMetalRules.find((r) => r.name === 'Brass 0.8');
    assert(back && back.thickness === '0.8', 'with its own thickness');
  });

  test('sheet metal: one part per rule, in the same document', () => {
    const doc = newDocument();
    doc.sheetMetalRules = [
      { ...SM.DEFAULT_RULE, name: 'Thin', thickness: '1' },
      { ...SM.DEFAULT_RULE, name: 'Thick', thickness: '4' }
    ];
    doc.sheetMetalRule = 'Thin';

    const sk = newSketch('XY', 'Plate');
    sk.points = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] },
      { id: 4, type: 'line', p: [3, 0] }
    ];
    sk.nextEntityId = 5;
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: uid('f'), type: 'baseFlange', sketch: sk.id, seeds: null, faces: [] },
      { id: uid('f'), type: 'baseFlange', sketch: sk.id, seeds: null, faces: [], rule: 'Thick' }
    ];
    const out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    assert(out.bodies.length === 2, `two plates, got ${out.bodies.length}`);

    const volumes = out.bodies.map((b) => b.solid.volume()).sort((a, b) => a - b);
    near(volumes[0], 40 * 30 * 1, 1, 'the one made to the thin rule');
    near(volumes[1], 40 * 30 * 4, 1, 'and the one made to the thick one');
  });

  test('sheet metal: reading a solid as sheet needs it to be that thick', () => {
    const doc = newDocument();
    doc.features = [prim('box', { width: '60', depth: '40', height: '2', centered: true })];
    const out = rebuild(doc);
    const mesh = K.meshData(out.bodies[0].solid);
    const topo = buildTopology(mesh);

    const right = SM.readSheetMetal(mesh, topo, 2);
    assert(right, 'a 2 mm plate reads as 2 mm sheet');
    assert(right.pairs.length >= 1, 'with a pair of faces one thickness apart');

    // The same body is not 5 mm sheet, and saying so is the whole point.
    assert(SM.readSheetMetal(mesh, topo, 5) === null, 'and is not 5 mm sheet');
  });

  test('sheet metal: through the timeline, a base flange and a flange', () => {
    const doc = newDocument();
    doc.sheetMetalRule = { thickness: '2', bendRadius: '2', kFactor: '0.44' };
    const sk = newSketch('XY', 'Plate');
    sk.points = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] },
      { id: 4, type: 'line', p: [3, 0] }
    ];
    sk.nextEntityId = 5;
    doc.sketches[sk.id] = sk;
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: uid('f'), type: 'baseFlange', sketch: sk.id, seeds: null, faces: [] }
    ];
    const out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    assert(out.bodies.length === 1, `one body, got ${out.bodies.length}`);
    const body = out.bodies[0];
    assert(body.sheetMetal, 'and it knows it is sheet metal');
    near(body.solid.volume(), 60 * 40 * 2, 1, 'a plate of the rule thickness');
    assert(body.sheetMetal.panels.length === 1, 'with one panel so far');
  });

  test('sheet metal: a flat pattern is its own body, laid flat', () => {
    const doc = newDocument();
    doc.sheetMetalRule = { thickness: '2', bendRadius: '2', kFactor: '0.44' };
    const sk = newSketch('XY', 'Plate');
    sk.points = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }];
    sk.entities = [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] },
      { id: 4, type: 'line', p: [3, 0] }
    ];
    sk.nextEntityId = 5;
    doc.sketches[sk.id] = sk;

    const baseId = uid('f');
    doc.features = [
      { id: uid('f'), type: 'sketch', sketch: sk.id },
      { id: baseId, type: 'baseFlange', sketch: sk.id, seeds: null, faces: [] },
      { id: uid('f'), type: 'flatPattern', bodies: 'all', at: [0, 80, 0] }
    ];
    const out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    assert(out.bodies.length === 2, `the part and its flat, got ${out.bodies.length}`);

    const flat = out.bodies.find((b) => b.flatOf);
    assert(flat, 'the flat knows which part it came from');
    assert(flat.outline, 'and carries the outline the DXF is written from');
    // Moved clear of the part, which is the whole reason it takes a position.
    near(flat.solid.boundingBox().min[1], 80, 0.01, 'laid out where it was asked for');
  });

  /* -------- batch 9: the mesh tab -------- */

  /** A sphere's mesh, which is the honest test for anything touching curvature. */
  function sphereMesh(scope, r = 20, segs = 64) {
    return K.meshData(K.sphere(r, segs, scope));
  }

  test('mesh: health tells a closed mesh from one with a hole in it', () => {
    const scope = new K.Scope();
    const box = K.meshData(K.box([40, 40, 40], true, scope));
    const whole = MT.meshHealth(box);
    assert(whole.closed, 'a box is closed');
    assert(whole.openEdges === 0, 'with no open edges');
    assert(whole.nonManifold === 0, 'and nothing non manifold');

    // The same box with its lid taken off.
    const P = SH.sheetPoints(box);
    const tris = SH.sheetTris(box).filter((t) => {
      const z = (P[t[0]][2] + P[t[1]][2] + P[t[2]][2]) / 3;
      return z < 19.9;
    });
    const holed = MT.meshHealth(SH.makeSheet(P, tris));
    assert(!holed.closed, 'and one with a face missing is not');
    assert(holed.holes === 1, `one hole, got ${holed.holes}`);
    assert(holed.openEdges === 4, `four open edges, got ${holed.openEdges}`);
    scope.dispose();
  });

  test('mesh: repair closes a hole and gives back exactly what was there', () => {
    const scope = new K.Scope();
    const box = K.meshData(K.box([40, 40, 40], true, scope));
    const P = SH.sheetPoints(box);
    const tris = SH.sheetTris(box).filter((t) => {
      const z = (P[t[0]][2] + P[t[1]][2] + P[t[2]][2]) / 3;
      return z < 19.9;
    });

    const fixed = MT.repairMesh(SH.makeSheet(P, tris), { fillHoles: true });
    assert(MT.meshHealth(fixed).closed, 'closed again');
    const solid = K.ofMesh(fixed.vertProperties, fixed.triVerts, scope);
    assert(K.status(solid) === 'NoError', `a real solid, got ${K.status(solid)}`);
    // The lid was flat, so closing the hole puts back exactly what was removed.
    near(solid.volume(), 64000, 1, 'and the box is the size it was');
    scope.dispose();
  });

  test('mesh: repair drops degenerate and duplicated triangles', () => {
    // A square, plus the same two triangles again, plus one with no area.
    const pts = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [5, 0, 0]];
    const dirty = SH.makeSheet(pts, [
      [0, 1, 2],
      [0, 2, 3],
      [0, 1, 2],
      [0, 1, 4]
    ]);
    assert(MT.meshHealth(dirty).degenerate === 1, 'the flat one is spotted');
    const clean = MT.repairMesh(dirty, { fillHoles: false, orient: false });
    assert(SH.sheetTris(clean).length === 2, `two left, got ${SH.sheetTris(clean).length}`);
    near(SH.sheetArea(clean), 100, 1e-6, 'and the square is still a square');
  });

  test('mesh: reduce keeps the shape while dropping the triangles', () => {
    const scope = new K.Scope();
    const sphere = K.sphere(20, 64, scope);
    const mesh = K.meshData(sphere);
    const before = mesh.triVerts.length / 3;

    const small = MT.reduceMesh(mesh, { ratio: 0.25 });
    const after = small.triVerts.length / 3;
    assert(after < before * 0.35, `down to about a quarter, got ${after} from ${before}`);
    assert(after > 8, 'and not to nothing');

    const solid = K.ofMesh(small.vertProperties, small.triVerts, scope);
    assert(K.status(solid) === 'NoError', 'still a solid');
    // A quarter of the triangles on a sphere costs a couple of per cent, no more.
    const kept = solid.volume() / sphere.volume();
    assert(kept > 0.94, `it kept its size, ${(kept * 100).toFixed(1)} per cent`);
    scope.dispose();
  });

  test('mesh: reduce to a triangle count hits the count', () => {
    const scope = new K.Scope();
    const mesh = sphereMesh(scope);
    const small = MT.reduceMesh(mesh, { triangles: 200 });
    const n = small.triVerts.length / 3;
    assert(n <= 260 && n >= 140, `about two hundred, got ${n}`);
    scope.dispose();
  });

  test('mesh: reduce holds the outline of an open mesh', () => {
    // A flat square, finely divided. Every triangle inside is disposable and
    // every one on the rim is not, so a reduce that loses the outline is
    // obvious in the area.
    const rows = [];
    for (let r = 0; r <= 12; r++) {
      const row = [];
      for (let c = 0; c <= 12; c++) row.push([(20 * c) / 12, (20 * r) / 12, 0]);
      rows.push(row);
    }
    const grid = SH.gridSheet(rows, {});
    const small = MT.reduceMesh(grid, { ratio: 0.2 });
    assert(small.triVerts.length < grid.triVerts.length, 'it did reduce');
    near(SH.sheetArea(small), 400, 1, 'and the square is still 20 by 20');
  });

  test('mesh: remesh makes the triangles one size and keeps the shape', () => {
    const scope = new K.Scope();
    const mesh = sphereMesh(scope);
    const even = MT.remesh(mesh, { edgeLength: 4, iterations: 3 });

    const P = SH.sheetPoints(even);
    const lens = [];
    for (const [i, j, k] of SH.sheetTris(even)) {
      for (const [a, b] of [[i, j], [j, k], [k, i]]) {
        lens.push(Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1], P[a][2] - P[b][2]));
      }
    }
    const min = Math.min(...lens);
    const max = Math.max(...lens);
    assert(min > 4 * 0.4, `nothing tiny left, shortest ${min.toFixed(2)}`);
    assert(max < 4 * 1.8, `nothing long left, longest ${max.toFixed(2)}`);

    // And it is still a sphere of 20, because every vertex went back onto it.
    const radii = P.map((p) => Math.hypot(p[0], p[1], p[2]));
    near(Math.min(...radii), 20, 0.4, 'the surface held');
    near(Math.max(...radii), 20, 0.4, 'both ways');
    scope.dispose();
  });

  test('mesh: smoothing does not shrink unless it is allowed to', () => {
    const scope = new K.Scope();
    const sphere = K.sphere(20, 48, scope);
    const mesh = K.meshData(sphere);

    const held = MT.smoothMesh(mesh, { iterations: 8, strength: 0.5, shrink: false });
    const a = K.ofMesh(held.vertProperties, held.triVerts, scope);
    const keptRatio = a.volume() / sphere.volume();
    assert(keptRatio > 0.98, `it kept its size, ${(keptRatio * 100).toFixed(1)} per cent`);

    // Plain Laplacian, which is what the other setting is, does shrink.
    const shrunk = MT.smoothMesh(mesh, { iterations: 8, strength: 0.5, shrink: true });
    const b = K.ofMesh(shrunk.vertProperties, shrunk.triVerts, scope);
    assert(b.volume() < a.volume(), 'and letting it shrink does');
    scope.dispose();
  });

  test('mesh: a plane cut splits a box into two halves that add up', () => {
    const scope = new K.Scope();
    const box = K.meshData(K.box([40, 40, 40], true, scope));
    const plane = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };

    const halves = MT.planeCut(box, plane, { mode: 'split', fill: true });
    assert(halves.length === 2, `two pieces, got ${halves.length}`);
    let total = 0;
    for (const h of halves) {
      assert(MT.meshHealth(h).closed, 'each capped and closed');
      const s = K.ofMesh(h.vertProperties, h.triVerts, scope);
      assert(K.status(s) === 'NoError', 'and a real solid');
      near(s.volume(), 32000, 1, 'exactly half the box');
      total += s.volume();
    }
    near(total, 64000, 1, 'and together the whole of it');
    scope.dispose();
  });

  test('mesh: trimming keeps the side asked for, and caps it', () => {
    const scope = new K.Scope();
    const box = K.meshData(K.box([40, 40, 40], true, scope));
    const plane = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };

    const near0 = MT.planeCut(box, plane, { mode: 'trim', keep: 'near', fill: true })[0];
    const P0 = SH.sheetPoints(near0);
    assert(P0.every((p) => p[2] <= 1e-6), 'the near side is below the plane');
    assert(MT.meshHealth(near0).closed, 'and it was capped');

    const far0 = MT.planeCut(box, plane, { mode: 'trim', keep: 'far', fill: true })[0];
    const P1 = SH.sheetPoints(far0);
    assert(P1.every((p) => p[2] >= -1e-6), 'and the other side is above it');

    // Without a cap it is a shell, and says so.
    const open = MT.planeCut(box, plane, { mode: 'trim', keep: 'near', fill: false })[0];
    assert(!MT.meshHealth(open).closed, 'uncapped it is open');
    scope.dispose();
  });

  test('mesh: a section is a closed loop at the right size', () => {
    const scope = new K.Scope();
    const cyl = K.meshData(K.cylinder(60, 15, 15, 64, true, scope));
    const runs = MT.sectionCurves(cyl, {
      origin: [0, 0, 0],
      x: [1, 0, 0],
      y: [0, 1, 0],
      n: [0, 0, 1]
    });
    assert(runs.length === 1, `one loop, got ${runs.length}`);
    const run = runs[0];
    for (const p of run) near(Math.hypot(p[0], p[1]), 15, 0.05, 'on the cylinder wall');
    const gap = Math.hypot(run[0][0] - run[run.length - 1][0], run[0][1] - run[run.length - 1][1]);
    near(gap, 0, 1e-4, 'and it closes on itself');

    // A plane that misses the body gives nothing rather than a stray segment.
    assert(
      MT.sectionCurves(cyl, {
        origin: [0, 0, 100],
        x: [1, 0, 0],
        y: [0, 1, 0],
        n: [0, 0, 1]
      }).length === 0,
      'and a plane that misses gives nothing'
    );
    scope.dispose();
  });

  test('mesh: separate finds the pieces that do not touch', () => {
    const scope = new K.Scope();
    const a = K.meshData(K.translate(K.box([10, 10, 10], true, scope), [-30, 0, 0], scope));
    const b = K.meshData(K.translate(K.box([10, 10, 10], true, scope), [30, 0, 0], scope));
    const both = MT.mergeMeshes([a, b]);
    const pieces = MT.separateMesh(both);
    assert(pieces.length === 2, `two pieces, got ${pieces.length}`);
    for (const p of pieces) {
      assert(MT.meshHealth(p).closed, 'each closed in its own right');
      near(SH.sheetArea(p), 600, 1e-6, 'and each a 10 mm cube');
    }
    // One box on its own is one piece, not two.
    assert(MT.separateMesh(a).length === 1, 'and one body stays one');
    scope.dispose();
  });

  test('mesh: the nearest point of a triangle is found in every region', () => {
    const a = [0, 0, 0];
    const b = [10, 0, 0];
    const c = [0, 10, 0];
    // Straight above the middle.
    const inside = MT.closestOnTriangle([2, 2, 5], a, b, c);
    near(inside[0], 2, 1e-9, 'inside stays put in x');
    near(inside[2], 0, 1e-9, 'and drops onto the plane');
    // Past a corner.
    const corner = MT.closestOnTriangle([-5, -5, 0], a, b, c);
    near(Math.hypot(corner[0], corner[1], corner[2]), 0, 1e-9, 'past a corner is the corner');
    // Past an edge.
    const edge = MT.closestOnTriangle([5, -5, 0], a, b, c);
    near(edge[0], 5, 1e-9, 'past an edge is on the edge');
    near(edge[1], 0, 1e-9, 'at the edge itself');
  });

  test('mesh: an STL written by the app reads back as the same body', () => {
    const scope = new K.Scope();
    const box = K.meshData(K.box([40, 40, 40], true, scope));
    const back = parseSTL(toBinarySTL([box]));
    assert(back.triVerts.length === box.triVerts.length, 'the same triangles');

    // STL has no vertex sharing, so it needs welding before it is a solid.
    const fixed = MT.repairMesh(back, {});
    const solid = K.ofMesh(fixed.vertProperties, fixed.triVerts, scope);
    assert(K.status(solid) === 'NoError', `a real solid, got ${K.status(solid)}`);
    near(solid.volume(), 64000, 0.01, 'and the size it was written at');
    scope.dispose();
  });

  test('mesh: an ASCII STL reads too, and is told from a binary one', () => {
    const text = [
      'solid box',
      'facet normal 0 0 1',
      '  outer loop',
      '    vertex 0 0 0',
      '    vertex 10 0 0',
      '    vertex 0 10 0',
      '  endloop',
      'endfacet',
      'endsolid box'
    ].join('\n');
    const mesh = parseSTL(new TextEncoder().encode(text));
    assert(mesh.triVerts.length === 3, 'one triangle');
    near(SH.sheetArea(mesh), 50, 1e-6, 'of the right size');
  });

  test('mesh: an OBJ round trips, including its negative indices', () => {
    const scope = new K.Scope();
    const box = K.meshData(K.box([40, 40, 40], true, scope));
    const back = parseOBJ(toOBJ([box]));
    assert(back.triVerts.length === box.triVerts.length, 'the same triangles');
    const solid = K.ofMesh(back.vertProperties, back.triVerts, scope);
    near(solid.volume(), 64000, 0.01, 'and the same body');

    // A quad face is fanned, and an index counted back from the end still works.
    const quad = parseOBJ(
      ['v 0 0 0', 'v 10 0 0', 'v 10 10 0', 'v 0 10 0', 'f -4 -3 -2 -1'].join('\n')
    );
    assert(quad.triVerts.length === 6, 'a quad comes in as two triangles');
    near(SH.sheetArea(quad), 100, 1e-6, 'covering the whole of it');
    scope.dispose();
  });

  await asyncTest('mesh: a 3MF model reads, and a real zipped one does too', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter"><resources><object id="1" type="model"><mesh>
<vertices>
<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>
<vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>
</vertices>
<triangles>
<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
<triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
</triangles>
</mesh></object></resources></model>`;
    const mesh = parse3MFModel(xml);
    assert(mesh.triVerts.length === 12, 'four triangles');

    const scope = new K.Scope();
    const solid = K.ofMesh(mesh.vertProperties, mesh.triVerts, scope);
    assert(K.status(solid) === 'NoError', 'a closed tetrahedron');
    near(solid.volume(), 1000 / 6, 0.01, 'of the volume a tetrahedron has');
    scope.dispose();

    // And through the zip, which is the part that has to work on a real file.
    const zip = storedZip('3D/3dmodel.model', new TextEncoder().encode(xml));
    const fromZip = await parse3MF(zip);
    assert(fromZip.triVerts.length === 12, 'the same out of the archive');
  });

  test('mesh: a file name says which reader it needs', () => {
    assert(meshReaderFor('scan.STL') === 'stl', 'stl whatever the case');
    assert(meshReaderFor('part.obj') === 'obj', 'obj');
    assert(meshReaderFor('thing.3mf') === '3mf', '3mf');
    assert(meshReaderFor('notes.txt') === null, 'and nothing for anything else');
  });

  test('mesh: face groups follow the angle they are given', () => {
    const scope = new K.Scope();
    // A cylinder: at a tight angle its wall is many faces, at a loose one it is
    // one. That is the whole of what the setting does.
    const mesh = K.meshData(K.cylinder(40, 20, 20, 64, true, scope));
    const tight = buildTopology(mesh, { smoothDeg: 2 });
    const loose = buildTopology(mesh, { smoothDeg: 40 });
    assert(
      tight.faces.length > loose.faces.length,
      `a tighter angle finds more faces: ${tight.faces.length} against ${loose.faces.length}`
    );
    assert(loose.faces.length === 3, `loose reads it as a wall and two ends, got ${loose.faces.length}`);
    scope.dispose();
  });

  test('mesh: texture extrude moves the surface by the picture', () => {
    // A flat grid, and an image that is white everywhere: every vertex should
    // move by the full depth, along the normal.
    const rows = [];
    for (let r = 0; r <= 8; r++) {
      const row = [];
      for (let c = 0; c <= 8; c++) row.push([-10 + (20 * c) / 8, -10 + (20 * r) / 8, 0]);
      rows.push(row);
    }
    const grid = SH.gridSheet(rows, {});
    const plane = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };

    const white = MT.displaceByImage(grid, () => 1, { plane, height: 3, width: 20 });
    const zs = SH.sheetPoints(white).map((p) => p[2]);
    near(Math.min(...zs), 3, 1e-5, 'all of it moved');
    near(Math.max(...zs), 3, 1e-5, 'by the depth asked for');

    // Black leaves it alone, which is the other half of the same statement.
    const black = MT.displaceByImage(grid, () => 0, { plane, height: 3, width: 20 });
    assert(
      SH.sheetPoints(black).every((p) => Math.abs(p[2]) < 1e-9),
      'and black stays put'
    );
  });

  test('mesh: through the timeline, insert, repair and convert', () => {
    const scope = new K.Scope();
    const box = K.meshData(K.box([40, 40, 40], true, scope));
    // Stored the way an inserted mesh is: unwelded, the way an STL arrives.
    const loose = parseSTL(toBinarySTL([box]));
    scope.dispose();

    const doc = newDocument();
    const key = 'm1';
    doc.meshData[key] = {
      verts: Array.from(loose.vertProperties),
      tris: Array.from(loose.triVerts)
    };
    doc.features = [
      { id: uid('f'), type: 'insertMesh', data: key, label: 'Box', scale: '1', at: [0, 0, 0] }
    ];
    let out = rebuild(doc);
    assert(out.bodies.length === 1, 'the mesh came in');
    assert(out.bodies[0].mesh, 'and it knows it is a mesh');
    assert(!out.bodies[0].solid, 'and has not reached the kernel');

    // An STL shares no vertices, and it converts anyway: the kernel merges by
    // position when it takes a mesh, so unwelded is not the same as open.
    doc.features.push({ id: uid('f'), type: 'convertMesh', bodies: 'all', repair: false });
    out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    assert(out.bodies[0].solid, 'it is a solid');
    near(out.bodies[0].solid.volume(), 64000, 1, 'of the size it came in at');
  });

  test('mesh: convert refuses a mesh with a hole, and says how big', () => {
    const scope = new K.Scope();
    const box = K.meshData(K.box([40, 40, 40], true, scope));
    const P = SH.sheetPoints(box);
    const tris = SH.sheetTris(box).filter((t) => {
      const z = (P[t[0]][2] + P[t[1]][2] + P[t[2]][2]) / 3;
      return z < 19.9;
    });
    const holed = SH.makeSheet(P, tris);
    scope.dispose();

    const doc = newDocument();
    doc.meshData.m1 = {
      verts: Array.from(holed.vertProperties),
      tris: Array.from(holed.triVerts)
    };
    doc.features = [
      { id: uid('f'), type: 'insertMesh', data: 'm1', label: 'Open', scale: '1', at: [0, 0, 0] },
      { id: uid('f'), type: 'convertMesh', bodies: 'all', repair: false }
    ];
    let out = rebuild(doc);
    assert(out.errors.length === 1, `it refuses it, got ${out.errors.length} problems`);
    assert(/open edge/.test(out.errors[0].message), out.errors[0].message);
    assert(!out.bodies[0].solid, 'and leaves it a mesh');

    // Repairing first is what makes it work, which is the point of the setting.
    doc.features[1].repair = true;
    out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    assert(out.bodies[0].solid, 'now it is a solid');
    near(out.bodies[0].solid.volume(), 64000, 1, 'and the hole is closed');
  });

  test('mesh: insert honours the scale it was given', () => {
    const scope = new K.Scope();
    const box = K.meshData(K.box([10, 10, 10], true, scope));
    scope.dispose();

    const doc = newDocument();
    doc.meshData.m1 = {
      verts: Array.from(box.vertProperties),
      tris: Array.from(box.triVerts)
    };
    doc.features = [
      { id: uid('f'), type: 'insertMesh', data: 'm1', label: 'Box', scale: '25.4', at: [0, 0, 0] }
    ];
    const out = rebuild(doc);
    const P = SH.sheetPoints(out.bodies[0].sheet);
    const xs = P.map((p) => p[0]);
    near(Math.max(...xs) - Math.min(...xs), 254, 0.01, 'ten inches across');
  });

  /* -------- batch 10: form -------- */

  const FXY = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };

  /** A cage as a solid, so it can be measured rather than eyeballed. */
  function formSolid(cage, levels, scope) {
    const m = FM.formMesh(cage, levels);
    return K.ofMesh(m.vertProperties, m.triVerts, scope);
  }

  test('form: every face becomes four, at every level', () => {
    // The one thing about Catmull-Clark that is exactly true whatever the shape.
    const box = FM.boxCage(FXY, [20, 20, 20], [1, 1, 1]);
    assert(box.faces.length === 6, `six to start, got ${box.faces.length}`);
    const counts = [0, 1, 2, 3].map((n) => FM.subdivided(box, n).faces.length);
    assert(
      counts.join(',') === '6,24,96,384',
      `four times each step, got ${counts.join(',')}`
    );
    // And every one of them is a quad after the first step, whatever it was.
    const tri = FM.faceCage([[0, 0, 0], [10, 0, 0], [5, 8, 0]]);
    const once = FM.subdivide(tri);
    assert(once.faces.length === 3, 'a triangle becomes three faces');
    assert(once.faces.every((f) => f.length === 4), 'and all of them are quads');
  });

  test('form: a fully creased cage is exactly the cage', () => {
    // The exact test. With every edge and corner held sharp, Catmull-Clark
    // reproduces the control mesh, so a box of 20 stays a box of 20 for ever.
    const box = FM.boxCage(FXY, [20, 20, 20], [1, 1, 1]);
    const hard = FM.cloneCage(box);
    for (const e of FM.adjacency(box).edges.values()) hard.creases[e.key] = 9;
    for (let v = 0; v < box.points.length; v++) hard.corners[v] = 9;

    const scope = new K.Scope();
    for (const level of [0, 1, 2, 3]) {
      const solid = formSolid(hard, level, scope);
      assert(K.status(solid) === 'NoError', `a real solid at level ${level}`);
      near(solid.volume(), 8000, 1e-6, `exactly the box at level ${level}`);
    }
    scope.dispose();
  });

  test('form: without creases it rounds off, and settles', () => {
    const box = FM.boxCage(FXY, [20, 20, 20], [1, 1, 1]);
    const scope = new K.Scope();
    const vols = [0, 1, 2, 3, 4].map((n) => formSolid(box, n, scope).volume());
    for (let i = 1; i < vols.length; i++) {
      assert(vols[i] < vols[i - 1], `it shrinks at every level, ${vols[i].toFixed(1)}`);
    }
    // And converges: the last step moves it far less than the first.
    const first = vols[0] - vols[1];
    const last = vols[3] - vols[4];
    assert(last < first / 20, `it settles, ${last.toFixed(1)} against ${first.toFixed(1)}`);
    scope.dispose();
  });

  test('form: a quadball really is the radius it was asked for', () => {
    // Subdivision does not pass through its own cage, so a cage of points all
    // exactly 20 out gives a surface nearer 17. The primitive is fitted to its
    // own limit, and this is the check that the fitting works.
    const scope = new K.Scope();
    const ball = FM.quadballCage(FXY, 20, 2);
    const solid = formSolid(ball, 2, scope);
    assert(K.status(solid) === 'NoError', 'a real solid');
    assert(solid.genus() === 0, 'and a plain ball');
    const want = (4 / 3) * Math.PI * 8000;
    near(solid.volume(), want, want * 0.02, 'a sphere of twenty');

    // Twice the size is eight times the volume, which the fitting must not
    // quietly break.
    const big = formSolid(FM.quadballCage(FXY, 40, 2), 2, scope);
    near(big.volume() / solid.volume(), 8, 0.15, 'and it scales');
    scope.dispose();
  });

  test('form: every primitive closes, and the flat one does not', () => {
    const scope = new K.Scope();
    for (const [name, cage] of [
      ['box', FM.boxCage(FXY, [20, 20, 20], [2, 2, 2])],
      ['cylinder', FM.cylinderCage(FXY, 15, 40, 8, 2, true)],
      ['sphere', FM.sphereCage(FXY, 15, 8, 6)],
      ['torus', FM.torusCage(FXY, 20, 6, 12, 8)],
      ['quadball', FM.quadballCage(FXY, 20, 2)]
    ]) {
      assert(FM.boundaryLoops(cage).length === 0, `${name} has no open edge`);
      const solid = formSolid(cage, 2, scope);
      assert(K.status(solid) === 'NoError', `${name} is a real solid`);
      assert(solid.volume() > 0, `${name} is not inside out, ${solid.volume().toFixed(0)}`);
    }
    // A torus has a hole through it, which is the one place genus is not zero.
    const torus = formSolid(FM.torusCage(FXY, 20, 6, 12, 8), 2, scope);
    assert(torus.genus() === 1, `a torus has one hole, got ${torus.genus()}`);

    const flat = FM.planeCage(FXY, 30, 30, 3, 3);
    assert(FM.boundaryLoops(flat).length === 1, 'and a plane is open all round');
    scope.dispose();
  });

  test('form: an uncapped cylinder is open at both ends', () => {
    const open = FM.cylinderCage(FXY, 15, 40, 8, 2, false);
    assert(FM.boundaryLoops(open).length === 2, 'two rims');
    const capped = FM.cylinderCage(FXY, 15, 40, 8, 2, true);
    assert(FM.boundaryLoops(capped).length === 0, 'and none when it is closed');
  });

  test('form: subdividing chosen faces leaves no crack', () => {
    // The neighbour that was not subdivided has to take the new point into its
    // own boundary, or the two disagree about the edge and the cage is torn.
    const box = FM.boxCage(FXY, [20, 20, 20], [1, 1, 1]);
    const one = FM.subdivideFaces(box, [0]);
    assert(one.faces.length === 9, `six less one plus four, got ${one.faces.length}`);
    assert(FM.boundaryLoops(one).length === 0, 'and it is still closed');

    const scope = new K.Scope();
    const solid = formSolid(one, 2, scope);
    assert(K.status(solid) === 'NoError', 'and still a solid');
    scope.dispose();
  });

  test('form: an edge loop runs all the way round a ring of quads', () => {
    const grid = FM.planeCage(FXY, 40, 40, 4, 4);
    const ring = FM.edgeRing(grid, FM.adjacency(grid), 0, 1);
    assert(ring.length === 4, `four quads across, got ${ring.length}`);

    const looped = FM.insertEdgeLoop(grid, 0, 1, 0.5);
    assert(looped, 'it inserted');
    assert(looped.faces.length === 20, `sixteen plus four, got ${looped.faces.length}`);
    assert(looped.points.length === 30, `twenty five plus five, got ${looped.points.length}`);
    // The loop does not change the shape, only what there is to grab.
    assert(FM.boundaryLoops(looped).length === 1, 'still one rim');
  });

  test('form: delete a face, then fill the hole it left', () => {
    const box = FM.boxCage(FXY, [20, 20, 20], [1, 1, 1]);
    const holed = FM.deleteFaces(box, [0]);
    assert(holed.faces.length === 5, 'five faces left');
    assert(FM.boundaryLoops(holed).length === 1, 'and one hole');

    const filled = FM.fillHole(holed, FM.boundaryLoops(holed)[0], 'single');
    assert(filled.faces.length === 6, 'six again');
    assert(FM.boundaryLoops(filled).length === 0, 'and closed again');

    const fanned = FM.fillHole(holed, FM.boundaryLoops(holed)[0], 'fan');
    assert(fanned.faces.length === 9, 'a fan puts four triangles in instead');
    assert(FM.boundaryLoops(fanned).length === 0, 'and closes it too');
  });

  test('form: a crease holds an edge and then lets go', () => {
    // Sharpness counts down a level each subdivision, so two holds it for two
    // and the third rounds it off. That is what makes it a dial, not a switch.
    const box = FM.boxCage(FXY, [20, 20, 20], [1, 1, 1]);
    const adj = FM.adjacency(box);
    const first = [...adj.edges.values()][0];

    const creased = FM.creaseEdges(box, [[first.a, first.b]], 2);
    assert(creased.creases[first.key] === 2, 'it took the crease');
    const once = FM.subdivide(creased);
    const left = Object.values(once.creases);
    assert(left.length === 2 && left.every((w) => w === 1), 'a level down, and split in two');
    const twice = FM.subdivide(once);
    assert(Object.keys(twice.creases).length === 0, 'and gone by the third');

    const cleared = FM.creaseEdges(creased, [[first.a, first.b]], 0);
    assert(!cleared.creases[first.key], 'and it can be taken off again');
  });

  test('form: mirror internal makes one half of it, twice', () => {
    const ball = FM.quadballCage(FXY, 20, 2);
    const mirrored = FM.mirrorInternal(ball, { origin: [0, 0, 0], n: [1, 0, 0] });
    assert(mirrored, 'it mirrored');
    assert(FM.boundaryLoops(mirrored).length === 0, 'and stayed closed');
    assert(mirrored.symmetry?.kind === 'mirror', 'and remembers that it is symmetric');

    // Exactly symmetric: every point has a twin at minus its own x.
    const xs = mirrored.points.map((p) => +p[0].toFixed(6));
    for (const x of xs) {
      assert(xs.includes(-x), `every point has a twin, ${x} does not`);
    }
    // And it did not simply double the faces of a shape that straddled.
    assert(
      mirrored.faces.length === ball.faces.length,
      `the same face count, got ${mirrored.faces.length} against ${ball.faces.length}`
    );
  });

  test('form: circular internal repeats one wedge', () => {
    const ring = FM.torusCage(FXY, 20, 6, 12, 8);
    const six = FM.circularInternal(ring, { origin: [0, 0, 0], dir: [0, 0, 1] }, 6);
    assert(six, 'it repeated');
    assert(six.symmetry?.kind === 'circular', 'and remembers it');
    assert(six.symmetry.count === 6, 'six of them');
    assert(FM.boundaryLoops(six).length === 0, 'and it closed up');
  });

  test('form: welding joins points and unwelding gives them back', () => {
    const cage = FM.newCage();
    // Two squares that meet along an edge, but with their own points there.
    cage.points = [
      [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
      [10, 0, 0], [20, 0, 0], [20, 10, 0], [10, 10, 0]
    ];
    cage.faces = [[0, 1, 2, 3], [4, 5, 6, 7]];
    assert(FM.boundaryLoops(cage).length === 2, 'two separate squares');

    const welded = FM.weldVertices(cage, null, 1e-4);
    assert(welded.points.length === 6, `six points left, got ${welded.points.length}`);
    assert(FM.boundaryLoops(welded).length === 1, 'and one outline round both');

    const apart = FM.unweldVertices(welded, [1, 2]);
    assert(apart.points.length === 8, `and unwelding gives them back, got ${apart.points.length}`);
  });

  test('form: flatten pulls points onto a plane and nothing else moves', () => {
    const box = FM.boxCage(FXY, [20, 20, 20], [1, 1, 1]);
    const top = box.points.map((p, i) => (p[2] > 0 ? i : -1)).filter((i) => i >= 0);
    const flat = FM.flatten(box, top, { origin: [0, 0, 5], n: [0, 0, 1] });
    for (const i of top) near(flat.points[i][2], 5, 1e-9, 'the chosen points landed');
    for (let i = 0; i < box.points.length; i++) {
      if (top.includes(i)) continue;
      near(flat.points[i][2], box.points[i][2], 1e-9, 'and nothing else moved');
    }
  });

  test('form: through the timeline, a form and then a solid', () => {
    const doc = newDocument();
    const cage = FM.quadballCage(FXY, 20, 2);
    doc.forms.f1 = cage;
    const formId = uid('f');
    doc.features = [
      { id: formId, type: 'form', form: 'f1', levels: '2', display: 'control' }
    ];
    let out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    assert(out.bodies.length === 1, 'the form is a body');
    assert(out.bodies[0].form === 'f1', 'and it knows which cage it is');
    assert(!out.bodies[0].solid, 'and has not reached the kernel');
    assert(out.bodies[0].overlayMesh, 'and carries the surface to draw behind it');

    doc.features.push({
      id: uid('f'),
      type: 'finishForm',
      bodies: 'all',
      levels: '3',
      op: 'new',
      targets: 'all'
    });
    out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    assert(out.bodies.length === 1, `one body, got ${out.bodies.length}`);
    assert(out.bodies[0].solid, 'now it is a solid');
    const want = (4 / 3) * Math.PI * 8000;
    near(out.bodies[0].solid.volume(), want, want * 0.02, 'a ball of twenty');
  });

  test('form: finishing an open form is refused, thickening it is not', () => {
    const doc = newDocument();
    doc.forms.f1 = FM.planeCage(FXY, 40, 40, 3, 3);
    doc.features = [
      { id: uid('f'), type: 'form', form: 'f1', levels: '2', display: 'box' },
      { id: uid('f'), type: 'finishForm', bodies: 'all', levels: '2', op: 'new' }
    ];
    let out = rebuild(doc);
    assert(out.errors.length === 1, `it refuses an open form, got ${out.errors.length}`);
    assert(/not closed/.test(out.errors[0].message), out.errors[0].message);

    doc.features[1] = {
      id: uid('f'),
      type: 'formThicken',
      bodies: 'all',
      levels: '2',
      distance: '3',
      op: 'new'
    };
    out = rebuild(doc);
    assert(out.errors.length === 0, out.errors.map((e) => e.message).join('; '));
    const solid = out.bodies.find((b) => b.solid);
    assert(solid, 'thickening gives a solid');
    // A flat sheet, so the volume is its area times the thickness, near enough:
    // the smooth surface is a little smaller than the cage it came from.
    assert(solid.solid.volume() > 2000, `and it has some size to it, ${solid.solid.volume().toFixed(0)}`);
  });

  test('form: one cage face is one selectable face', () => {
    // The cage mesh tags each triangle with the face it came from, and the
    // topology is told to keep those apart. Without that a flat cage is a
    // single face and there is nothing at all to point at.
    const grid = FM.planeCage(FXY, 40, 40, 3, 3);
    const mesh = FM.cageToMesh(grid);
    const topo = buildTopology(mesh);
    assert(topo.faces.length === 9, `nine faces, got ${topo.faces.length}`);
    const sources = topo.faces.map((f) => f.src?.face);
    assert(new Set(sources).size === 9, 'each from its own cage face');

    // And a solid is not affected: there, merging by angle is the whole point.
    const scope = new K.Scope();
    const box = K.meshData(K.box([20, 20, 20], true, scope));
    assert(buildTopology(box).faces.length === 6, 'a box is still six faces');
    scope.dispose();
  });

  /* -------- batch 10, session two: edit form -------- */

  test('edit form: pulling a face out adds a wall and keeps it closed', () => {
    const box = FM.boxCage(FXY, [20, 20, 20], [1, 1, 1]);
    const made = FM.extrudeFaces(box, [0], 10);
    assert(made, 'it pulled');
    const cage = made.cage;
    assert(FM.boundaryLoops(cage).length === 0, 'and the cage is still closed');
    // The face that was lifted, plus four walls, in place of the one it left.
    assert(cage.faces.length === box.faces.length + 4, `six plus four walls, got ${cage.faces.length}`);
    assert(made.lifted.length === 4, `the four corners came back, got ${made.lifted.length}`);

    // It really moved: the lifted face is ten further along its own normal.
    const before = box.points.map((p) => p[2]);
    const after = made.lifted.map((v) => cage.points[v][2]);
    assert(
      Math.max(...after) > Math.max(...before) + 5 ||
        Math.min(...after) < Math.min(...before) - 5,
      'and it stands clear of the face it came off'
    );

    const scope = new K.Scope();
    const solid = formSolid(cage, 2, scope);
    assert(K.status(solid) === 'NoError', 'and it is still a real solid');
    scope.dispose();
  });

  test('edit form: two faces pulled together come out as one limb', () => {
    // Side by side, they share an edge, and the wall must not be built down
    // the middle of the pair or the limb comes out as two stubs.
    const grid = FM.boxCage(FXY, [30, 30, 30], [3, 1, 1]);
    const top = grid.faces
      .map((f, i) => i)
      .filter((i) => grid.faces[i].every((v) => grid.points[v][2] > 14));
    assert(top.length === 3, `three faces across the top, got ${top.length}`);

    const made = FM.extrudeFaces(grid, top.slice(0, 2), 8);
    assert(made, 'it pulled');
    assert(FM.boundaryLoops(made.cage).length === 0, 'and stayed closed');
    // Six points lifted, not eight: the shared edge is not doubled.
    assert(made.lifted.length === 6, `six points lifted, got ${made.lifted.length}`);
  });

  test('edit form: grow takes in the ring around, shrink gives it back', () => {
    const box = FM.boxCage(FXY, [30, 30, 30], [3, 3, 3]);
    const adj = FM.adjacency(box);
    const one = [0];
    const grown = FM.growFaces(box, one, adj);
    assert(grown.length > 1, `it grew, ${grown.length} faces`);
    assert(grown.includes(0), 'and kept what it started with');

    const back = FM.shrinkFaces(box, grown, adj);
    assert(back.length < grown.length, `and shrank again, ${back.length}`);
    assert(back.length >= 1, 'without vanishing');
  });

  test('edit form: a loop runs across the quads and a ring runs along them', () => {
    const cyl = FM.cylinderCage(FXY, 15, 40, 8, 3, false);
    const adj = FM.adjacency(cyl);
    // An edge running up the side of the tube.
    const up = [...adj.edges.values()].find((e) => {
      const a = cyl.points[e.a];
      const b = cyl.points[e.b];
      return Math.abs(a[2] - b[2]) > 1;
    });
    assert(up, 'found an edge up the side');

    // The loop runs up the side of the tube, so it is as long as the tube has
    // rows: three. The ring runs round it, so it is one edge per side: eight.
    const loop = FM.edgeLoop(cyl, up.a, up.b, adj);
    const ring = FM.edgeRingSet(cyl, up.a, up.b, adj);
    assert(loop.length === 3, `three up the side, got ${loop.length}`);
    assert(ring.length === 8, `eight round the tube, got ${ring.length}`);

    // And they only share the edge they both started from.
    const key = ([x, y]) => `${Math.min(x, y)}_${Math.max(x, y)}`;
    const inLoop = new Set(loop.map(key));
    const shared = ring.filter((e) => inLoop.has(key(e)));
    assert(shared.length === 1, `they cross once, got ${shared.length}`);
  });

  test('edit form: soft weights fall off, and hard ones do not', () => {
    const grid = FM.planeCage(FXY, 60, 60, 6, 6);
    const middle = grid.points
      .map((p, i) => i)
      .filter((i) => Math.hypot(grid.points[i][0], grid.points[i][1]) < 1e-6);
    assert(middle.length === 1, 'one point in the middle');

    const hard = FM.softWeights(grid, middle, { extent: 'none' });
    assert(hard.size === 1, 'nothing else moves with it');

    const soft = FM.softWeights(grid, middle, {
      extent: 'distance',
      distance: 25,
      transition: 'linear',
      weight: 1
    });
    assert(soft.size > 1, `and with soft on, ${soft.size} points share the move`);
    assert(soft.get(middle[0]) === 1, 'the chosen one takes all of it');

    // Further away is less, which is the whole of what soft modification means.
    const byDistance = [...soft.entries()]
      .map(([v, w]) => ({ d: Math.hypot(grid.points[v][0], grid.points[v][1]), w }))
      .sort((a, b) => a.d - b.d);
    for (let i = 1; i < byDistance.length; i++) {
      assert(
        byDistance[i].w <= byDistance[i - 1].w + 1e-9,
        `weight never rises with distance, ${byDistance[i].w} at ${byDistance[i].d}`
      );
    }
    assert(byDistance[byDistance.length - 1].w < 0.5, 'and the far ones barely move');
  });

  test('edit form: a face count reaches exactly that many rings out', () => {
    const grid = FM.planeCage(FXY, 60, 60, 6, 6);
    const corner = [0];
    const one = FM.softWeights(grid, corner, { extent: 'faces', faces: 1, weight: 1 });
    const two = FM.softWeights(grid, corner, { extent: 'faces', faces: 2, weight: 1 });
    assert(two.size > one.size, `two rings reach further than one, ${two.size} against ${one.size}`);
    assert(one.size === 3, `a corner has two neighbours plus itself, got ${one.size}`);
  });

  test('edit form: moving points moves only what was weighted', () => {
    const grid = FM.planeCage(FXY, 40, 40, 4, 4);
    const chosen = [0, 1];
    const weights = FM.softWeights(grid, chosen, { extent: 'none' });
    const moved = FM.transformPoints(grid, weights, FM.translation([0, 0, 5]));

    for (let v = 0; v < grid.points.length; v++) {
      const want = chosen.includes(v) ? 5 : 0;
      near(moved.points[v][2], want, 1e-9, `point ${v}`);
    }
  });

  test('edit form: a turn about an axis is a turn, not a shift', () => {
    const grid = FM.planeCage(FXY, 40, 40, 2, 2);
    const all = grid.points.map((_, i) => i);
    const weights = FM.softWeights(grid, all, { extent: 'none' });
    const turned = FM.transformPoints(
      grid,
      weights,
      FM.rotation([0, 0, 0], [0, 0, 1], Math.PI / 2)
    );
    // A quarter turn about Z takes (20, 20) to (-20, 20).
    const corner = grid.points.findIndex((p) => p[0] > 19 && p[1] > 19);
    near(turned.points[corner][0], -20, 1e-9, 'x came from y');
    near(turned.points[corner][1], 20, 1e-9, 'and y from x');
    // And nothing changed size.
    const before = Math.hypot(...grid.points[corner]);
    const after = Math.hypot(...turned.points[corner]);
    near(after, before, 1e-9, 'a turn keeps its distance');
  });

  test('edit form: scaling along one axis stretches rather than swells', () => {
    const grid = FM.planeCage(FXY, 40, 40, 2, 2);
    const all = grid.points.map((_, i) => i);
    const weights = FM.softWeights(grid, all, { extent: 'none' });
    const frame = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const wide = FM.transformPoints(
      grid,
      weights,
      FM.scaling([0, 0, 0], frame, [2, 1, 1])
    );
    const corner = grid.points.findIndex((p) => p[0] > 19 && p[1] > 19);
    near(wide.points[corner][0], 40, 1e-9, 'twice as wide');
    near(wide.points[corner][1], 20, 1e-9, 'and the same the other way');
  });

  test('edit form: a symmetric form moves both halves at once', () => {
    const ball = FM.quadballCage(FXY, 20, 2);
    const sym = FM.mirrorInternal(ball, { origin: [0, 0, 0], n: [1, 0, 0] });
    assert(sym.symmetry?.kind === 'mirror', 'it is symmetric');

    // One point well off the seam, moved outward.
    const v = sym.points.findIndex((p) => p[0] > 5);
    assert(v >= 0, 'found a point on the near side');
    const weights = FM.softWeights(sym, [v], { extent: 'none' });
    const moved = FM.transformPoints(sym, weights, FM.translation([0, 0, 8]));

    // Its twin at minus x moved with it, and by the mirrored amount.
    const before = sym.points[v];
    const twin = sym.points.findIndex(
      (p, i) =>
        i !== v &&
        Math.abs(p[0] + before[0]) < 1e-6 &&
        Math.abs(p[1] - before[1]) < 1e-6 &&
        Math.abs(p[2] - before[2]) < 1e-6
    );
    assert(twin >= 0, 'the twin exists');
    near(moved.points[v][2], before[2] + 8, 1e-6, 'the one that was dragged moved');
    near(moved.points[twin][2], before[2] + 8, 1e-6, 'and so did its twin');
    near(moved.points[twin][0], -moved.points[v][0], 1e-6, 'and they are still a mirror pair');
  });

  test('edit form: without symmetry only what was picked moves', () => {
    const ball = FM.quadballCage(FXY, 20, 2);
    const v = ball.points.findIndex((p) => p[0] > 5);
    const weights = FM.softWeights(ball, [v], { extent: 'none' });
    const moved = FM.transformPoints(ball, weights, FM.translation([0, 0, 8]));
    let changed = 0;
    for (let i = 0; i < ball.points.length; i++) {
      if (Math.abs(moved.points[i][2] - ball.points[i][2]) > 1e-9) changed++;
    }
    assert(changed === 1, `one point moved, got ${changed}`);
  });

  test('edit form: the selection frame follows what it is told to', () => {
    const grid = FM.planeCage(FXY, 40, 40, 2, 2);
    const face = grid.faces[0];

    const world = FM.selectionFrame(grid, face, 'world');
    assert(world.z.join(',') === '0,0,1', 'world space is the model own');

    // Selection space points out of the surface, which for a flat grid on XY
    // is straight up whatever the face happens to be.
    const sel = FM.selectionFrame(grid, face, 'selection');
    near(Math.abs(sel.z[2]), 1, 1e-9, 'selection space follows the surface');
    near(FM.formDot(sel.x, sel.z), 0, 1e-9, 'and its axes are square to each other');

    // And it sits at the middle of what was picked.
    const middle = FM.centroidOf(grid, face);
    near(sel.origin[0], middle[0], 1e-9, 'at the middle of the selection');
  });

  /* -------- report -------- */

  const summary = {
    total: results.length,
    failed: failures,
    results
  };
  document.getElementById('out').textContent = JSON.stringify(summary, null, 2);
  if (window.anvilTest) window.anvilTest.done(summary);
}

run().catch((err) => {
  const summary = {
    total: results.length,
    failed: failures + 1,
    results: [...results, { name: 'suite', ok: false, error: err.message || String(err) }]
  };
  document.getElementById('out').textContent = JSON.stringify(summary, null, 2);
  if (window.anvilTest) window.anvilTest.done(summary);
});
