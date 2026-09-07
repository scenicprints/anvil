/**
 * Document model and the parametric rebuild.
 *
 * The document is a parameter table, a set of sketches, and an ordered feature
 * timeline. Nothing about the resulting solid is stored: a rebuild replays the
 * timeline from scratch every time, which is what makes editing an early
 * dimension propagate through everything downstream.
 *
 * Profiles are referenced by a seed point in sketch space rather than by index,
 * so a region survives edits that renumber the sketch's geometry.
 */

import * as THREE from './three.js';
import * as K from './kernel.js';
import { resolveParameters, safeEval } from './expr.js';
import {
  findRegions,
  regionToPolygons,
  pointInPolygon,
  tessellate,
  chainPath,
  entityEndpoints,
  entityLoops,
  thickenPolyline,
  materializeSketch
} from './profile.js';
import {
  loftLoops,
  sweepLoop,
  helicalSweep,
  variableSweep,
  pathFrames
} from './meshbuild.js';
import { resolveConstruction } from './construction.js';
import { solveAssembly } from './assembly.js';
import { solveSketch } from './solver.js';
import * as PL from './plastic.js';
import { buildTopology, basisFor } from './topology.js';
import {
  buildEdgeTools,
  buildFacePrism,
  resolveEdgeRefs,
  resolveFaceRefs
} from './edgefeature.js';
import * as SH from './sheet.js';
import * as SM from './sheetmetal.js';
import * as MT from './meshtools.js';
import * as FM from './form.js';

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

let idCounter = 1;
export function uid(prefix = 'id') {
  return `${prefix}${(idCounter++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function newDocument() {
  return {
    version: 1,
    units: 'mm',
    parameters: [],
    sketches: {},
    features: [],
    construction: [],
    // How lengths are written and read in the interface. The model itself is
    // always millimetres.
    units: 'mm',
    components: [],
    joints: [],
    captureHistory: true,
    baseBodies: [],
    rollback: null,
    bodyNames: {},
    // Triangles read off the disk, and images used as textures. They live here
    // rather than in a feature because nothing in the timeline can reproduce
    // them: the file they came from may not be there next time.
    meshData: {},
    imageData: {},
    // Control cages, beside the sketches and for the same reason: a form is
    // drawn rather than derived, so nothing in the timeline can rebuild it.
    forms: {},
    // A small library of sheet metal rules, and the name of the one in force.
    // A part that is aluminium at the bracket and steel at its mount is two
    // rules, and swapping the whole document over to make the second is how
    // the first one gets lost.
    sheetMetalRules: SM.STOCK_RULES.map((r) => ({ ...r })),
    sheetMetalRule: SM.STOCK_RULES[0].name
  };
}

/**
 * Freeze the current bodies into the document as stored geometry.
 *
 * This is what turning design history off does: the shape is kept, the recipe
 * for it is not. Everything afterwards works on the geometry directly, which is
 * the right trade for an imported part that never had a history to inherit, and
 * the wrong one for anything you still want to change by dimension.
 */
/**
 * A body cut back to one side of a plane, for Section Analysis.
 *
 * Really cut, not clipped: hiding the triangles in front of a plane leaves the
 * solid looking hollow, because the inside of a closed surface is what is
 * behind them. Taking the boolean costs a rebuild's worth of work and shows a
 * capped face, which is the whole point of asking for a section.
 *
 * The model is never touched. This runs on a copy for display only.
 */
export function sectionedMesh(solid, plane, scope) {
  const bb = K.boundingBox(solid);
  const span =
    Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) + 20;
  const keep = halfSpace(plane.origin, plane.n, span, scope);
  const cut = K.intersection(solid, keep, scope);
  if (K.isEmpty(cut)) return null;
  return K.meshData(cut);
}

/**
 * A body's triangles, whichever kind of body it is.
 *
 * A sheet is already a mesh; a solid has to be asked for one. Everything that
 * only wants triangles, which is topology, picking, projection and export, goes
 * through here and never has to know which it was handed.
 */
/** Move a sheet's points by a 4x4, since it has no kernel transform to use. */
export function transformSheet(sheet, el) {
  const pts = SH.sheetPoints(sheet).map(([x, y, z]) => [
    el[0] * x + el[4] * y + el[8] * z + el[12],
    el[1] * x + el[5] * y + el[9] * z + el[13],
    el[2] * x + el[6] * y + el[10] * z + el[14]
  ]);
  const out = SH.makeSheet(pts, SH.sheetTris(sheet));
  if (sheet.grid) out.grid = sheet.grid;
  return out;
}

export function meshOf(body) {
  return body.solid ? K.meshData(body.solid) : body.sheet;
}

/** A sheet body carries no solid, so this is what tells the two apart. */
export function isSheet(body) {
  return !body.solid && !!body.sheet;
}

export function bakeBodies(bodies) {
  return bodies.map((b, i) => {
    const mesh = meshOf(b);
    const stride = mesh.numProp;
    const verts = [];
    for (let v = 0; v < mesh.vertProperties.length / stride; v++) {
      const o = v * stride;
      verts.push(
        Math.round(mesh.vertProperties[o] * 1e5) / 1e5,
        Math.round(mesh.vertProperties[o + 1] * 1e5) / 1e5,
        Math.round(mesh.vertProperties[o + 2] * 1e5) / 1e5
      );
    }
    return {
      id: b.id || `baked${i}`,
      name: b.name || `Body ${i + 1}`,
      component: b.component || null,
      verts,
      tris: Array.from(mesh.triVerts)
    };
  });
}

export function newSketch(plane, name, opts = {}) {
  const sk = {
    id: uid('sk'),
    name: name || 'Sketch',
    plane: plane || 'XY',
    points: [],
    entities: [],
    constraints: [],
    nextEntityId: 1
  };
  // A three dimensional sketch keeps a plane, because a click has to land
  // somewhere and that plane is where. Its points may then carry a third
  // coordinate away from it, and its curves need not stay flat.
  if (opts.is3d) sk.is3d = true;
  return sk;
}

/* ------------------------------------------------------------------ */
/* Planes                                                              */
/* ------------------------------------------------------------------ */

const BASE_PLANES = {
  XY: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  XZ: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], n: [1, 0, 0] }
};

/** Dimension constraints that carry an expression, as opposed to a plain value. */
const DIMENSION_TYPES = new Set([
  'distance',
  'distanceX',
  'distanceY',
  'radius',
  'diameter',
  'angle'
]);

/**
 * Work each dimension's expression out against the parameters before the sketch
 * is solved, so a length given as `wall * 2` follows the parameter rather than
 * being frozen at whatever it measured when it was typed.
 */
/**
 * Bring an extrude up to the shape the dialog now works in.
 *
 * `extent` used to carry both which way the material goes and how far, as one
 * of one / two / symmetric / all. Fusion keeps those apart, so Direction is now
 * its own field and Extent is only about how far. Old documents are upgraded
 * here rather than at load, so a file written by an older build still opens.
 */
export function normalizeExtrude(f) {
  if (!f.direction) {
    const was = f.extent || 'one';
    f.direction = was === 'two' ? 'two' : was === 'symmetric' ? 'symmetric' : 'one';
    f.extent = was === 'all' ? 'all' : 'distance';
  }
  if (!f.kind) f.kind = 'solid';
  if (!f.start) f.start = 'profile';
  if (!f.measure) f.measure = 'whole';
  if (!f.extend) f.extend = 'face';
  if (!f.wallLocation) f.wallLocation = 'side1';
  return f;
}

/** Bring a revolve up to the shape the dialog now works in. */
export function normalizeRevolve(f) {
  if (!f.direction) f.direction = 'one';
  if (!f.measure) f.measure = 'whole';
  if (!f.extent) {
    // An angle of a full turn used to be the only way to say "all the way".
    const a = String(f.angle ?? '360').trim();
    f.extent = a === '360' ? 'full' : 'angle';
  }
  return f;
}

/** Bring a sweep up to the shape the dialog now works in. */
export function normalizeSweep(f) {
  if (!f.sweepType) f.sweepType = f.rail ? 'rail' : 'path';
  if (!f.orientation) f.orientation = 'perpendicular';
  if (!f.profileScaling) f.profileScaling = 'scale';
  if (f.distance === undefined) f.distance = '1';
  return f;
}

/** Bring a loft up to the shape the dialog now works in. */
export function normalizeLoft(f) {
  if (!f.startCondition) f.startCondition = 'connected';
  if (!f.endCondition) f.endCondition = 'connected';
  if (f.startWeight === undefined) f.startWeight = '1';
  if (f.endWeight === undefined) f.endWeight = '1';
  return f;
}

/**
 * Bring a fillet or chamfer up to the shape the dialog now works in.
 *
 * A blend used to carry one list of edges and one size. Fusion keeps several
 * sets, each with its own, so a part can be filleted in one step at three
 * different radii. Old documents become a single set.
 */
export function normalizeBlend(f) {
  if (!f.sets) {
    f.sets = [
      {
        edges: f.edges || [],
        radius: f.radius ?? '2',
        endRadius: f.endRadius ?? null,
        chamferType: 'equal',
        distance2: f.radius ?? '1',
        angle: '45'
      }
    ];
  }
  for (const set of f.sets) {
    if (!set.chamferType) set.chamferType = 'equal';
    if (set.distance2 === undefined) set.distance2 = set.radius;
    if (set.angle === undefined) set.angle = '45';
    // A variable radius used to be implied by an end radius being filled in.
    // It is a named type now, so an older document is read back the way it
    // behaved rather than quietly turning constant.
    if (!set.filletType) set.filletType = set.endRadius ? 'variable' : 'constant';
    if (set.chord === undefined) set.chord = set.radius;
    if (!set.holdEdges) set.holdEdges = [];
  }
  return f;
}

/**
 * Bring a document's sheet metal rules up to the library it now keeps.
 *
 * A document written when there was one rule stored it as an object under
 * `sheetMetalRule`. That becomes an entry in the library, and the field becomes
 * the name of the one in force, so an old part keeps the numbers it was made
 * to rather than quietly picking up whatever the first stock rule says.
 */
export function normalizeSheetRules(doc) {
  if (!doc) return doc;
  const carried =
    doc.sheetMetalRule && typeof doc.sheetMetalRule === 'object'
      ? { ...SM.DEFAULT_RULE, ...doc.sheetMetalRule }
      : null;

  if (!Array.isArray(doc.sheetMetalRules) || !doc.sheetMetalRules.length) {
    doc.sheetMetalRules = SM.STOCK_RULES.map((r) => ({ ...r }));
  }
  if (carried) {
    if (!carried.name) carried.name = 'Sheet metal rule';
    const at = doc.sheetMetalRules.findIndex((r) => r.name === carried.name);
    if (at >= 0) doc.sheetMetalRules[at] = carried;
    else doc.sheetMetalRules.unshift(carried);
    doc.sheetMetalRule = carried.name;
  }
  if (typeof doc.sheetMetalRule !== 'string' || !doc.sheetMetalRule) {
    doc.sheetMetalRule = doc.sheetMetalRules[0].name;
  }
  return doc;
}

/**
 * How a body's faces are to be worked out.
 *
 * Shared rather than written out at each call site, because the topology the
 * pointer picks from and the topology a feature resolves a reference against
 * have to be the same one. Where they are not, a face reference lands on a face
 * that was never on screen.
 */
export function topologyOptions(body) {
  const out = {};
  if (body?.groupAngle) out.smoothDeg = body.groupAngle;
  if (body?.groupLabels) out.labels = body.groupLabels;
  return out;
}

/** Bring a hole up to the shape the dialog now works in. */
export function normalizeHole(f) {
  if (!f.holeType) f.holeType = f.counterbore ? 'counterbore' : f.countersink ? 'countersink' : 'simple';
  if (!f.extent) f.extent = f.through ? 'all' : 'distance';
  if (!f.op) f.op = 'cut';
  return f;
}

/** Bring a pattern up to the shape the dialog now works in. */
export function normalizePattern(f) {
  if (!f.spacingType) f.spacingType = 'spacing';
  if (!f.symmetry) f.symmetry = 'no';
  // Named skipInstances, not suppressed: a feature's own `suppressed` flag
  // already means the whole feature is switched off, and an empty array is
  // truthy, so sharing the name turns every pattern off.
  if (!f.skipInstances) f.skipInstances = [];
  return f;
}

/** Bring a move up to the shape the dialog now works in. */
export function normalizeMove(f) {
  if (!f.moveType) f.moveType = 'translate';
  return f;
}

export function normalizeSplit(f) {
  if (!f.splitType) f.splitType = 'body';
  return f;
}

export function normalizeShell(f) {
  if (!f.side) f.side = 'inside';
  return f;
}

export function normalizeDraft(f) {
  if (!f.sides) f.sides = 'one';
  return f;
}

export function resolveDimensionExprs(sketch, scope) {
  if (!sketch?.constraints) return;
  for (const c of sketch.constraints) {
    if (!c.expr || !DIMENSION_TYPES.has(c.type)) continue;
    c.value = safeEval(c.expr, scope || {}, c.value);
  }
}

export function resolvePlane(spec, scope, built) {
  if (!spec) return BASE_PLANES.XY;
  if (typeof spec === 'string') {
    // Dialogs name construction planes as "c:<id>" so one dropdown can offer
    // the base planes and the made ones together.
    if (spec.startsWith('c:')) {
      const found = built && built.get(spec.slice(2));
      if (found && found.kind === 'plane') {
        return { origin: found.origin, x: found.x, y: found.y, n: found.n };
      }
      return BASE_PLANES.XY;
    }
    return BASE_PLANES[spec] || BASE_PLANES.XY;
  }

  // A plane made earlier in the timeline, referenced by id.
  if (spec.construction) {
    const found = built && built.get(spec.construction);
    if (found && found.kind === 'plane') {
      return { origin: found.origin, x: found.x, y: found.y, n: found.n };
    }
    return BASE_PLANES.XY;
  }

  if (spec.base) {
    const base = BASE_PLANES[spec.base] || BASE_PLANES.XY;
    const d = safeEval(spec.offset, scope, 0);
    return {
      origin: [
        base.origin[0] + base.n[0] * d,
        base.origin[1] + base.n[1] * d,
        base.origin[2] + base.n[2] * d
      ],
      x: base.x,
      y: base.y,
      n: base.n
    };
  }

  if (spec.origin && spec.x && spec.y) {
    const n = cross(spec.x, spec.y);
    return { origin: spec.origin, x: spec.x, y: spec.y, n };
  }
  return BASE_PLANES.XY;
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

/** Angular step used when tessellating a thread helix, in degrees. */
const MIN_THREAD_STEP = 7.5;

/**
 * A big slab covering everything on the near side of a plane, used wherever a
 * feature needs "the half of space behind this face".
 */
function halfSpace(origin, normal, span, ks) {
  const basis = basisFor(normal);
  const box = K.box([span * 3, span * 3, span * 2], true, ks);
  const m = new THREE.Matrix4();
  const o = [
    origin[0] - normal[0] * span,
    origin[1] - normal[1] * span,
    origin[2] - normal[2] * span
  ];
  m.set(
    basis.x[0], basis.y[0], basis.n[0], o[0],
    basis.x[1], basis.y[1], basis.n[1], o[1],
    basis.x[2], basis.y[2], basis.n[2], o[2],
    0, 0, 0, 1
  );
  return K.transform(box, m.elements, ks);
}

/** A point on the line where a face's plane meets another plane. */
function planeIntersectionPoint(face, other, axisDir) {
  const n = face.normal;
  const m = other.n;
  const d1 = n[0] * face.centre[0] + n[1] * face.centre[1] + n[2] * face.centre[2];
  const d2 = m[0] * other.origin[0] + m[1] * other.origin[1] + m[2] * other.origin[2];

  // Three equations: on both planes, and nearest the face centre along the line.
  const rows = [
    [n[0], n[1], n[2], d1],
    [m[0], m[1], m[2], d2],
    [
      axisDir[0],
      axisDir[1],
      axisDir[2],
      axisDir[0] * face.centre[0] + axisDir[1] * face.centre[1] + axisDir[2] * face.centre[2]
    ]
  ];
  const det =
    rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1]) -
    rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0]) +
    rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0]);
  if (Math.abs(det) < 1e-9) return null;

  const solve = (col) => {
    const m2 = rows.map((r) => r.slice(0, 3));
    for (let i = 0; i < 3; i++) m2[i][col] = rows[i][3];
    return (
      (m2[0][0] * (m2[1][1] * m2[2][2] - m2[1][2] * m2[2][1]) -
        m2[0][1] * (m2[1][0] * m2[2][2] - m2[1][2] * m2[2][0]) +
        m2[0][2] * (m2[1][0] * m2[2][1] - m2[1][1] * m2[2][0])) /
      det
    );
  };
  return [solve(0), solve(1), solve(2)];
}

/** Matrix taking sketch-local (u, v, w) to world coordinates. */
export function planeMatrix(plane) {
  const m = new THREE.Matrix4();
  m.set(
    plane.x[0], plane.y[0], plane.n[0], plane.origin[0],
    plane.x[1], plane.y[1], plane.n[1], plane.origin[1],
    plane.x[2], plane.y[2], plane.n[2], plane.origin[2],
    0, 0, 0, 1
  );
  return m;
}

export function sketchToWorld(plane, u, v, w = 0) {
  return new THREE.Vector3(
    plane.origin[0] + plane.x[0] * u + plane.y[0] * v + plane.n[0] * w,
    plane.origin[1] + plane.x[1] * u + plane.y[1] * v + plane.n[1] * w,
    plane.origin[2] + plane.x[2] * u + plane.y[2] * v + plane.n[2] * w
  );
}

export function worldToSketch(plane, p) {
  const dx = p.x - plane.origin[0];
  const dy = p.y - plane.origin[1];
  const dz = p.z - plane.origin[2];
  return {
    u: dx * plane.x[0] + dy * plane.x[1] + dz * plane.x[2],
    v: dx * plane.y[0] + dy * plane.y[1] + dz * plane.y[2],
    w: dx * plane.n[0] + dy * plane.n[1] + dz * plane.n[2]
  };
}

/* ------------------------------------------------------------------ */
/* Profile selection                                                   */
/* ------------------------------------------------------------------ */

/** Match stored seed points back to freshly computed regions. */
function regionsForSeeds(regions, seeds) {
  if (!seeds || !seeds.length) return [];
  const picked = [];
  const taken = new Set();
  for (const seed of seeds) {
    let best = null;
    let bestArea = Infinity;
    for (const r of regions) {
      if (taken.has(r)) continue;
      if (!pointInPolygon(seed, r.outer)) continue;
      let inHole = false;
      for (const h of r.holes) {
        if (pointInPolygon(seed, h)) {
          inHole = true;
          break;
        }
      }
      if (inHole) continue;
      if (r.area < bestArea) {
        bestArea = r.area;
        best = r;
      }
    }
    if (best) {
      taken.add(best);
      picked.push(best);
    }
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* Rebuild                                                             */
/* ------------------------------------------------------------------ */

/**
 * Replay the timeline.
 * Returns { bodies, errors, scope, sketchRegions, paramErrors }.
 * Every body carries a live kernel handle; call result.dispose() when replaced.
 */
/* ---------------------------------------------------------------- */
/* Rebuild cache                                                     */
/* ---------------------------------------------------------------- */

/**
 * What the last rebuild left behind, so the next one can start part way in.
 *
 * The timeline is replayed from nothing on every rebuild, which is what makes
 * it honest: there is one path to any state and no way for the model to drift
 * from the features that describe it. It is also why editing the last feature
 * of a long part costs the same as editing the first.
 *
 * The cache keeps that honesty and only skips work that would have produced
 * exactly what it already has. Every feature gets a key covering itself and
 * everything outside it that it reads, and the keys are compared in order. The
 * run starts again at the first one that differs, which is the same answer the
 * full replay would give, arrived at without repeating the part before it.
 *
 * The geometry a checkpoint holds is owned by the cache rather than by the
 * rebuild that made it, because it has to outlive that rebuild's scope. That is
 * the whole reason this is a class rather than a plain object: something has to
 * be answerable for freeing it.
 */
export class RebuildCache {
  constructor() {
    this.globalKey = null;
    this.steps = [];
    this.owned = new Set();
    this.hits = 0;
    this.replayed = 0;
  }

  /** Does this solid belong to the cache rather than to a rebuild? */
  owns(solid) {
    return this.owned.has(solid);
  }

  /** Take ownership of a kernel object, off whatever scope was holding it. */
  keep(solid, scope) {
    if (!solid || typeof solid.delete !== 'function') return solid;
    if (scope) scope.release(solid);
    this.owned.add(solid);
    return solid;
  }

  /** Throw away everything from a given feature on. */
  trimFrom(index) {
    if (index >= this.steps.length) return;
    this.steps.length = Math.max(0, index);
    this.sweep();
  }

  /** Free anything no surviving checkpoint still refers to. */
  sweep() {
    const live = new Set();
    for (const step of this.steps) {
      for (const b of step.bodies) if (b.solid) live.add(b.solid);
      for (const entry of step.toolOf.values()) if (entry.tool) live.add(entry.tool);
    }
    for (const solid of [...this.owned]) {
      if (live.has(solid)) continue;
      this.owned.delete(solid);
      try {
        solid.delete();
      } catch {
        /* already gone */
      }
    }
  }

  dispose() {
    this.steps.length = 0;
    this.sweep();
    this.globalKey = null;
  }
}

/**
 * Everything outside the features that every one of them can see.
 *
 * A change here invalidates the whole run, because there is no telling which
 * feature was reading it. Parameters are the usual one: a dimension driven by
 * `wall` moves when `wall` does, and nothing in the feature itself says so.
 */
function globalRebuildKey(doc, scope) {
  const params = {};
  for (const key of Object.keys(scope || {})) {
    const v = scope[key];
    if (typeof v === 'number') params[key] = v;
  }
  return JSON.stringify({
    params,
    base: (doc.baseBodies || []).map((b) => [b.id, b.verts?.length, b.tris?.length]),
    names: doc.bodyNames,
    components: doc.components,
    rules: doc.sheetMetalRules,
    rule: doc.sheetMetalRule
  });
}

/**
 * A feature, and the parts of the document it reads that are not inside it.
 *
 * A sketch is the big one: an extrude carries the sketch's id and nothing else,
 * so moving a line in that sketch changes what the extrude builds without
 * changing a character of the extrude. The same goes for a form's cage and for
 * the triangles behind a mesh. Anything measured rather than copied is measured
 * cheaply, because this runs for every feature on every rebuild.
 */
function featureRebuildKey(doc, feature) {
  const extra = {};
  if (feature.sketch && doc.sketches?.[feature.sketch]) {
    extra.sketch = doc.sketches[feature.sketch];
  }
  if (feature.form && doc.forms?.[feature.form]) {
    extra.form = doc.forms[feature.form];
  }
  if (feature.mesh && doc.meshData?.[feature.mesh]) {
    const m = doc.meshData[feature.mesh];
    extra.mesh = [feature.mesh, m.verts?.length, m.tris?.length];
  }
  if (feature.image && doc.imageData?.[feature.image]) {
    extra.image = [feature.image, doc.imageData[feature.image].length];
  }
  // Sections and profiles can name a second sketch, and a joint names two
  // components, both of which live outside the feature.
  if (feature.sections) {
    extra.sections = feature.sections.map((sec) =>
      sec?.sketch && doc.sketches?.[sec.sketch] ? doc.sketches[sec.sketch] : sec
    );
  }
  return JSON.stringify(feature) + '|' + JSON.stringify(extra);
}

export function rebuild(doc, options = {}) {
  const scopeObj = new K.Scope();
  // Provenance ids start again every rebuild, so the map from them to feature
  // ids has to as well.
  K.resetOriginalTags();
  const { scope, errors: paramErrors } = resolveParameters(doc.parameters || []);
  const errors = [];
  const sketchRegions = {};
  const sketchPlanes = {};
  const sketchProjections = {};
  const builtConstruction = new Map();
  let bodies = [];

  const limit =
    options.upTo !== undefined && options.upTo !== null
      ? options.upTo
      : doc.rollback !== null && doc.rollback !== undefined
        ? doc.rollback
        : doc.features.length - 1;

  // How much of the last run still stands. The keys are compared in order and
  // the first difference is where this one has to start, which is exactly the
  // point a full replay would begin to differ.
  const cache = options.cache || null;
  const keys = doc.features.map((f) => (f ? featureRebuildKey(doc, f) : 'null'));
  let start = 0;
  if (cache) {
    const gk = globalRebuildKey(doc, scope);
    if (cache.globalKey !== gk) {
      cache.dispose();
      cache.globalKey = gk;
    } else {
      while (
        start < cache.steps.length &&
        start < keys.length &&
        start <= limit &&
        cache.steps[start].key === keys[start]
      ) {
        start++;
      }
      cache.trimFrom(start);
    }
  }

  // Anything baked by direct modelling is the starting point the timeline
  // builds on, so it goes in before the first feature runs. A run that starts
  // part way in already has them, inside the checkpoint it starts from.
  for (const baked of start > 0 ? [] : doc.baseBodies || []) {
    try {
      const solid = K.ofMesh(
        new Float32Array(baked.verts),
        new Uint32Array(baked.tris),
        scopeObj
      );
      if (!K.isEmpty(solid)) {
        bodies.push({
          id: baked.id,
          name: baked.name || `Body ${bodies.length + 1}`,
          solid,
          createdBy: null,
          component: baked.component || null
        });
      }
    } catch (err) {
      errors.push({ feature: null, message: `Stored body: ${err.message}` });
    }
  }

  const nameBody = (feature, index) => {
    const key = `${feature.id}:${index}`;
    return doc.bodyNames?.[key] || `Body ${bodies.length + 1}`;
  };

  // The tool each feature produced, so a pattern can replay it elsewhere
  // instead of only copying the finished body.
  const toolOf = new Map();

  const applyBoolean = (feature, tool, opName) => {
    if (!tool || K.isEmpty(tool)) return;
    // Mark it as this feature's own geometry before it goes anywhere. After
    // this every triangle of it, and of anything later cut or joined out of
    // it, still says which feature it belongs to, which is what lets a
    // reference to a face survive a dimension change rather than be guessed at.
    tool = K.tagOriginal(tool, feature.id, scopeObj);
    toolOf.set(feature.id, { tool, op: opName, targets: feature.targets });
    // A feature only ever touches bodies in its own component, so cutting one
    // part cannot reach into the part sitting next to it.
    // Only solids. A sheet has no inside, so there is nothing for a boolean to
    // join to or cut out of, and handing one to the kernel produces nonsense
    // rather than an error.
    const inScope = bodies.filter(
      (b) => b.solid && (b.component || null) === (feature.component || null)
    );
    const targets =
      feature.targets && feature.targets !== 'all'
        ? inScope.filter((b) => feature.targets.includes(b.id))
        : inScope;

    if (opName === 'new' || opName === 'component' || targets.length === 0) {
      bodies.push({
        id: `${feature.id}:${bodies.length}`,
        name: nameBody(feature, bodies.length),
        solid: tool,
        createdBy: feature.id,
        // A new component puts the body in one of its own, which is what keeps
        // a later feature in another component from reaching into it.
        component: opName === 'component' ? `${feature.id}:c` : feature.component || null
      });
      return;
    }

    if (opName === 'join') {
      let acc = tool;
      const kept = [];
      for (const b of bodies) {
        if (targets.includes(b)) acc = K.union(acc, b.solid, scopeObj);
        else kept.push(b);
      }
      const first = targets[0];
      kept.push({ ...first, solid: acc });
      bodies = kept;
      return;
    }

    if (opName === 'cut') {
      const next = [];
      for (const b of bodies) {
        if (!targets.includes(b)) {
          next.push(b);
          continue;
        }
        const cutSolid = K.difference(b.solid, tool, scopeObj);
        if (!K.isEmpty(cutSolid)) next.push({ ...b, solid: cutSolid });
      }
      bodies = next;
      return;
    }

    if (opName === 'intersect') {
      const next = [];
      for (const b of bodies) {
        if (!targets.includes(b)) {
          next.push(b);
          continue;
        }
        const s = K.intersection(b.solid, tool, scopeObj);
        if (!K.isEmpty(s)) next.push({ ...b, solid: s });
      }
      bodies = next;
    }
  };

  if (cache && start > 0) {
    const at = cache.steps[start - 1];
    bodies = at.bodies.slice();
    Object.assign(sketchRegions, at.sketchRegions);
    Object.assign(sketchPlanes, at.sketchPlanes);
    Object.assign(sketchProjections, at.sketchProjections);
    for (const [k, v] of at.construction) builtConstruction.set(k, v);
    for (const [k, v] of at.toolOf) toolOf.set(k, v);
    // Where the geometry came from has to come back with it, or every face
    // reference into the part before the edit is suddenly anonymous.
    K.restoreOriginalTags(at.tags);
    cache.hits += start;
  }

  /**
   * Put this point of the run away, so the next rebuild can start from it.
   *
   * The geometry passes to the cache rather than being copied, because a
   * manifold is immutable once built: every feature after this one produces a
   * new object and leaves this one exactly as it is. What that costs is one
   * rebuild's worth of intermediates staying alive, and what it buys is not
   * building them again.
   */
  const checkpoint = (i) => {
    if (!cache) return;
    for (const b of bodies) if (b.solid) cache.keep(b.solid, scopeObj);
    for (const entry of toolOf.values()) if (entry.tool) cache.keep(entry.tool, scopeObj);
    cache.steps[i] = {
      // Worked out again here rather than reused from before the run, because
      // a feature is brought up to date as it is built: a fillet written
      // before it had sets grows them the first time it runs. Keyed on what it
      // says now, the next rebuild sees no change, which is the truth.
      key: featureRebuildKey(doc, doc.features[i]),
      bodies: bodies.slice(),
      sketchRegions: { ...sketchRegions },
      sketchPlanes: { ...sketchPlanes },
      sketchProjections: { ...sketchProjections },
      construction: new Map(builtConstruction),
      toolOf: new Map(toolOf),
      tags: K.originalTagsSnapshot()
    };
    cache.replayed++;
  };

  for (let i = start; i <= limit && i < doc.features.length; i++) {
    const feature = doc.features[i];
    if (!feature || feature.suppressed) {
      checkpoint(i);
      continue;
    }

    try {
      switch (feature.type) {
        case 'jointEdit':
          break;

        case 'construction': {
          buildConstruction(feature, scope, bodies, errors);
          break;
        }

        case 'sketch': {
          const sk = doc.sketches[feature.sketch];
          if (!sk) break;
          // A sketch on a face is re-attached here, while the bodies are in
          // the state this point of the timeline produced. That is what lets
          // it ride along when an earlier dimension moves the face.
          const plane = planeForSketch(sk, scope, bodies, errors, feature);
          sketchPlanes[sk.id] = plane;
          resolveDimensionExprs(sk, scope);
          // A three dimensional sketch is reference geometry, not a solved
          // one. Every residual in the solver is written in two variables per
          // point, so running it on points that carry a third would quietly
          // flatten them; the points are placed where they were put instead.
          if (!sk.is3d) solveSketch(sk, { maxIterations: 40 });

          // Projected geometry is rebuilt from the model as it stands now, so
          // it tracks what it was traced from.
          const projected = projectInto(sk, plane, bodies, errors, feature);
          sketchProjections[sk.id] = projected;
          sketchRegions[sk.id] = findRegions(materializeSketch(sk, projected));
          break;
        }

        case 'extrude':
          doExtrude(feature, doc, scope, scopeObj, sketchRegions, applyBoolean, errors);
          break;

        case 'revolve':
          doRevolve(feature, doc, scope, scopeObj, sketchRegions, applyBoolean, errors);
          break;

        case 'primitive':
          doPrimitive(feature, scope, scopeObj, applyBoolean);
          break;

        case 'hole':
          doHole(feature, doc, scope, scopeObj, applyBoolean, errors);
          break;

        case 'mirror':
          bodies = doMirror(feature, bodies, scope, scopeObj);
          break;

        case 'patternRect':
          bodies = doPatternRect(feature, bodies, scope, scopeObj);
          break;

        case 'patternCircular':
          bodies = doPatternCircular(feature, bodies, scope, scopeObj);
          break;

        case 'patternPath':
          bodies = doPatternPath(feature, doc, bodies, scope, scopeObj, errors);
          break;

        case 'patternFeature':
          bodies = doPatternFeature(feature, bodies, scope, scopeObj, errors);
          break;

        case 'move':
          bodies = doMove(feature, bodies, scope, scopeObj);
          break;

        case 'scale':
          bodies = doScale(feature, bodies, scope, scopeObj);
          break;

        case 'combine':
          bodies = doCombine(feature, bodies, scopeObj);
          break;

        case 'fillet':
        case 'chamfer':
          bodies = doEdgeBlend(feature, bodies, scope, scopeObj, errors);
          break;

        case 'shell':
          bodies = doShell(feature, bodies, scope, scopeObj, errors);
          break;

        case 'offsetFace':
          bodies = doOffsetFace(feature, bodies, scope, scopeObj, errors);
          break;

        case 'loft':
          doLoft(feature, doc, scope, scopeObj, sketchRegions, applyBoolean, errors);
          break;

        case 'sweep':
          doSweep(feature, doc, scope, scopeObj, sketchRegions, applyBoolean, errors);
          break;

        case 'rib':
          doRib(feature, doc, scope, scopeObj, applyBoolean, errors);
          break;

        case 'draft':
          bodies = doDraft(feature, bodies, scope, scopeObj, errors);
          break;

        case 'split':
          bodies = doSplit(feature, bodies, scope, scopeObj, errors);
          break;

        case 'thread':
          bodies = doThread(feature, bodies, scope, scopeObj, errors);
          break;

        case 'coil':
          doCoil(feature, scope, scopeObj, applyBoolean, errors);
          break;

        case 'emboss':
          bodies = doEmboss(feature, doc, bodies, scope, scopeObj, sketchRegions, errors);
          break;

        case 'web':
          doWeb(feature, doc, bodies, scope, scopeObj, applyBoolean, errors);
          break;

        case 'align':
          bodies = doAlign(feature, bodies, scope, scopeObj, errors);
          break;

        case 'deleteFace':
          bodies = doDeleteFace(feature, bodies, scope, scopeObj, errors);
          break;

        case 'silhouetteSplit':
          bodies = doSilhouetteSplit(feature, bodies, scope, scopeObj, errors);
          break;

        case 'splitFace':
          bodies = doSplitFace(feature, bodies, scope, scopeObj, errors);
          break;

        case 'surfaceExtrude':
          doSurfaceExtrude(feature, doc, scope, scopeObj, errors);
          break;

        case 'surfaceRevolve':
          doSurfaceRevolve(feature, doc, scope, scopeObj, errors);
          break;

        case 'surfaceSweep':
          doSurfaceSweep(feature, doc, scope, scopeObj, errors);
          break;

        case 'surfaceLoft':
          doSurfaceLoft(feature, doc, scope, scopeObj, errors);
          break;

        case 'patch':
          doPatch(feature, doc, scope, scopeObj, errors);
          break;

        case 'ruled':
          doRuled(feature, doc, scope, scopeObj, errors);
          break;

        case 'offsetSurface':
          doOffsetSurface(feature, doc, scope, scopeObj, errors);
          break;

        case 'trimSurface':
          doTrimSurface(feature, doc, scope, scopeObj, errors);
          break;

        case 'extendSurface':
          doExtendSurface(feature, doc, scope, scopeObj, errors);
          break;

        case 'untrimSurface':
          doUntrimSurface(feature, doc, scope, scopeObj, errors);
          break;

        case 'mergeSurface':
          doMergeSurface(feature, doc, scope, scopeObj, errors);
          break;

        case 'stitch':
          doStitch(feature, doc, scope, scopeObj, errors);
          break;

        case 'unstitch':
          doUnstitch(feature, doc, scope, scopeObj, errors);
          break;

        case 'reverseNormal':
          doReverseNormal(feature, doc, scope, scopeObj, errors);
          break;

        case 'thicken':
          doThicken(feature, doc, scope, scopeObj, errors);
          break;

        case 'boundaryFill':
          doBoundaryFill(feature, doc, scope, scopeObj, errors);
          break;

        case 'replaceFace':
          doReplaceFace(feature, doc, scope, scopeObj, errors);
          break;

        case 'boss':
          doBoss(feature, doc, scope, scopeObj, applyBoolean, errors);
          break;

        case 'rest':
          doRest(feature, doc, scope, scopeObj, applyBoolean, errors);
          break;

        case 'snapFit':
          doSnapFit(feature, doc, scope, scopeObj, applyBoolean, errors);
          break;

        case 'lip':
          doLip(feature, doc, scope, scopeObj, applyBoolean, errors);
          break;

        case 'baseFlange':
          doBaseFlange(feature, doc, scope, scopeObj, sketchRegions, errors);
          break;

        case 'flange':
          doFlange(feature, scope, scopeObj, errors);
          break;

        case 'hem':
          doHem(feature, scope, scopeObj, errors);
          break;

        case 'loftedFlange':
          doLoftedFlange(feature, doc, scope, scopeObj, errors);
          break;

        case 'contourFlange':
          doContourFlange(feature, doc, scope, scopeObj, errors);
          break;

        case 'sheetFold':
          doSheetFold(feature, doc, scope, scopeObj, errors);
          break;

        case 'unfold':
          doUnfold(feature, scope, scopeObj, errors, false);
          break;

        case 'refold':
          doUnfold(feature, scope, scopeObj, errors, true);
          break;

        case 'rip':
          doRip(feature, scope, scopeObj, errors);
          break;

        case 'cornerRelief':
          doCornerRelief(feature, scope, scopeObj, errors);
          break;

        case 'miter':
          doMiter(feature, scope, scopeObj, errors);
          break;

        case 'convertToSheetMetal':
          doConvertToSheetMetal(feature, scope, scopeObj, errors);
          break;

        case 'flatPattern':
          doFlatPattern(feature, scope, scopeObj, errors);
          break;

        case 'insertMesh':
          doInsertMesh(feature, scope, scopeObj, errors);
          break;

        case 'tessellate':
          doTessellate(feature, scope, scopeObj, errors);
          break;

        case 'meshRepair':
          doMeshRepair(feature, scope, scopeObj, errors);
          break;

        case 'meshStitch':
          doMeshStitch(feature, scope, scopeObj, errors);
          break;

        case 'meshPatch':
          doMeshPatch(feature, scope, scopeObj, errors);
          break;

        case 'meshDirectEdit':
          doMeshDirectEdit(feature, scope, scopeObj, errors);
          break;

        case 'meshReduce':
          doMeshReduce(feature, scope, scopeObj, errors);
          break;

        case 'meshRemesh':
          doMeshRemesh(feature, scope, scopeObj, errors);
          break;

        case 'meshSmooth':
          doMeshSmooth(feature, scope, scopeObj, errors);
          break;

        case 'meshPlaneCut':
          doMeshPlaneCut(feature, scope, scopeObj, errors);
          break;

        case 'meshSeparate':
          doMeshSeparate(feature, scope, scopeObj, errors);
          break;

        case 'meshMerge':
          doMeshMerge(feature, scope, scopeObj, errors);
          break;

        case 'meshErase':
          doMeshErase(feature, scope, scopeObj, errors);
          break;

        case 'meshReverse':
          doMeshReverse(feature, scope, scopeObj, errors);
          break;

        case 'convertMesh':
          doConvertMesh(feature, scope, scopeObj, errors);
          break;

        case 'textureExtrude':
          doTextureExtrude(feature, scope, scopeObj, errors);
          break;

        case 'faceGroups':
          doFaceGroups(feature, scope, scopeObj, errors);
          break;

        case 'faceGroupEdit':
          doFaceGroupEdit(feature, scope, scopeObj, errors);
          break;

        case 'form':
          doForm(feature, doc, scope, scopeObj, errors);
          break;

        case 'finishForm':
          doFinishForm(feature, doc, scope, scopeObj, applyBoolean, errors);
          break;

        case 'formThicken':
          doFormThicken(feature, doc, scope, scopeObj, applyBoolean, errors);
          break;

        default:
          break;
      }
    } catch (err) {
      errors.push({ feature: feature.id, message: err.message || String(err) });
    }
    checkpoint(i);
  }

  // Any sketch not yet reached by the timeline still needs its regions for the
  // sketch editor to work while rolled back.
  for (const id of Object.keys(doc.sketches)) {
    if (!sketchRegions[id]) {
      const sk = doc.sketches[id];
      if (!sketchPlanes[id]) {
        sketchPlanes[id] = planeForSketch(sk, scope, bodies, [], null);
      }
      if (!sk.is3d) solveSketch(sk, { maxIterations: 40 });
      const projected = projectInto(sk, sketchPlanes[id], bodies, [], null);
      sketchProjections[id] = projected;
      sketchRegions[id] = findRegions(materializeSketch(sk, projected));
    }
  }

  // Components and joints last: they place finished parts, they do not change
  // their shape.
  const assembly = solveAssembly(doc.components, doc.joints, scope, {
    rigidGroups: doc.rigidGroups,
    motionLinks: doc.motionLinks,
    constraints: doc.constraints
  });
  for (const e of assembly.errors) errors.push({ feature: e.id, message: e.message });
  if (assembly.transforms.size) {
    bodies = bodies.map((b) => {
      const m = b.component && assembly.transforms.get(b.component);
      if (!m) return b;
      const el = m.elements;
      const moved =
        Math.abs(el[12]) > 1e-9 ||
        Math.abs(el[13]) > 1e-9 ||
        Math.abs(el[14]) > 1e-9 ||
        Math.abs(el[0] - 1) > 1e-9 ||
        Math.abs(el[5] - 1) > 1e-9 ||
        Math.abs(el[10] - 1) > 1e-9;
      if (!moved) return b;
      if (isSheet(b)) return { ...b, sheet: transformSheet(b.sheet, el) };
      return { ...b, solid: K.transform(b.solid, el, scopeObj) };
    });
  }

  for (const b of bodies) if (b.solid) scopeObj.release(b.solid);

  return {
    bodies,
    errors,
    paramErrors,
    scope,
    sketchRegions,
    sketchPlanes,
    sketchProjections,
    construction: builtConstruction,
    dispose() {
      scopeObj.dispose();
      for (const b of bodies) {
        // Geometry the cache is holding outlives this result on purpose, so
        // freeing it here would pull it out from under the next rebuild.
        if (!b.solid || cache?.owns(b.solid)) continue;
        try {
          b.solid.delete();
        } catch {
          /* already gone */
        }
      }
    },
    disposeIntermediates() {
      scopeObj.dispose();
    }
  };

  /* -------------------------------------------------------------- */

  /**
   * Where a sketch lives. A base plane or an offset from one is fixed, but a
   * sketch attached to a face has to find that face again on every rebuild.
   * If the face is gone the stored frame is used instead, so the sketch stays
   * put and the model keeps building rather than collapsing.
   */
  function planeForSketch(sk, scope, currentBodies, errs, feature) {
    const spec = sk.plane;
    if (!spec || typeof spec === 'string' || !spec.face) {
      return resolvePlane(spec, scope, builtConstruction);
    }

    for (const b of currentBodies) {
      let topo;
      try {
        topo = buildTopology(meshOf(b));
      } catch {
        continue;
      }
      const [face] = resolveFaceRefs(topo, [spec.face]);
      if (!face || !face.planar) continue;

      // Anchor the origin at the model origin projected onto the face, not at
      // the face centre, so resizing the face does not slide the sketch.
      const basis = basisFor(face.normal);
      const d = face.normal[0] * face.centre[0] +
        face.normal[1] * face.centre[1] +
        face.normal[2] * face.centre[2];
      return {
        origin: [face.normal[0] * d, face.normal[1] * d, face.normal[2] * d],
        x: basis.x,
        y: basis.y,
        n: basis.n
      };
    }

    if (spec.frame) return spec.frame;
    if (errs && feature) {
      errs.push({
        feature: feature.id,
        message: `${sk.name} lost the face it was drawn on`
      });
    }
    return resolvePlane('XY', scope, builtConstruction);
  }

  function doExtrude(feature, doc, scope, ks, regionsById, apply, errs) {
    normalizeExtrude(feature);

    const { contours, plane } = extrudeProfiles(feature, doc, scope, regionsById);
    if (!contours.length) {
      throw new Error('Select one or more profiles or planar faces to extrude.');
    }

    // Where the extrusion begins. Fusion lets that be somewhere other than the
    // profile itself, so the plane is moved before anything is built on it.
    const startAt = extrudeStart(feature, scope, plane);
    const base = startAt === 0 ? plane : offsetPlane(plane, startAt);

    // Thin extrude turns the profile into a wall of its own before any of the
    // depth settings apply, so everything after this is the same either way.
    const walls =
      feature.kind === 'thin' ? thinWallContours(feature, contours, scope, ks) : contours;

    const side = (which) => {
      const extent = (which === 2 ? feature.extent2 : feature.extent) || 'distance';
      const dist = safeEval(which === 2 ? feature.distance2 : feature.distance, scope, 0);
      const taper = safeEval(which === 2 ? feature.taper2 : feature.taper, scope, 0);
      const twist = safeEval(feature.twist, scope, 0);
      const reach = extentReach(feature, extent, dist, base, which);
      if (!(Math.abs(reach) > 1e-9)) return null;
      let solid = K.extrudeContours(
        walls,
        { height: Math.abs(reach), taperDeg: taper, twistDeg: twist },
        ks
      );
      if (reach < 0) solid = flipZ(solid, ks);
      return solid;
    };

    let solid;
    if (feature.direction === 'symmetric') {
      const d = safeEval(feature.distance, scope, 0);
      // Half length reaches the stated distance on each side; whole length is
      // that distance measured across the whole extrusion.
      const total = feature.measure === 'half' ? Math.abs(d) * 2 : Math.abs(d);
      if (!(total > 1e-9)) throw new Error('Extrude distance is zero');
      solid = K.extrudeContours(
        walls,
        {
          height: total,
          taperDeg: safeEval(feature.taper, scope, 0),
          twistDeg: safeEval(feature.twist, scope, 0),
          center: true
        },
        ks
      );
    } else if (feature.direction === 'two') {
      const up = side(1);
      const downRaw = side(2);
      const down = downRaw ? flipZ(downRaw, ks) : null;
      if (!up && !down) throw new Error('Extrude distance is zero');
      solid = up && down ? K.union(up, down, ks) : up || down;
    } else {
      solid = side(1);
      if (!solid) throw new Error('Extrude distance is zero');
    }

    if (feature.flip && feature.direction === 'one') solid = flipZ(solid, ks);

    let world = K.transform(solid, planeMatrix(base).elements, ks);

    // Extending to an object is a trim rather than a length: the prism is built
    // long above and then cut back to where the object is.
    if (feature.extent === 'object' && feature.direction !== 'symmetric') {
      world = trimToObject(feature, world, base, scope, ks, errs);
    }

    const op = feature.op || 'new';

    // A cut that removes nothing is almost always pointed the wrong way: the
    // sketch sits on a face and the material is behind it. Turning it round is
    // what the person meant, and doing nothing at all never is.
    if (
      op === 'cut' &&
      feature.autoFlip !== false &&
      feature.direction === 'one' &&
      feature.extent === 'distance'
    ) {
      const targets = (
        feature.targets && feature.targets !== 'all'
          ? bodies.filter((b) => feature.targets.includes(b.id))
          : bodies
      ).filter((b) => b.solid);
      const touches = targets.some(
        (b) => !K.isEmpty(K.intersection(b.solid, world, ks))
      );
      if (!touches && targets.length) {
        world = K.transform(flipZ(solid, ks), planeMatrix(base).elements, ks);
      }
    }

    apply(feature, world, op);
  }

  function flipZ(solid, ks) {
    return K.transform(solid, new THREE.Matrix4().makeScale(1, 1, -1).elements, ks);
  }

  function offsetPlane(plane, d) {
    return {
      ...plane,
      origin: [
        plane.origin[0] + plane.n[0] * d,
        plane.origin[1] + plane.n[1] * d,
        plane.origin[2] + plane.n[2] * d
      ]
    };
  }

  /** How far along the normal the extrusion starts. */
  function extrudeStart(feature, scope, plane) {
    if (feature.start === 'offset') return safeEval(feature.startOffset, scope, 0);
    if (feature.start === 'object') {
      const at = objectPlane(feature.startObject, scope);
      if (!at) return 0;
      return (
        (at.origin[0] - plane.origin[0]) * plane.n[0] +
        (at.origin[1] - plane.origin[1]) * plane.n[1] +
        (at.origin[2] - plane.origin[2]) * plane.n[2]
      );
    }
    return 0;
  }

  /**
   * The contours to extrude: the chosen sketch profiles, planar faces of a
   * body, or both. A face comes in through its boundary edges, flattened into
   * the plane it lies in.
   */
  function extrudeProfiles(feature, doc, scope, regionsById) {
    const contours = [];
    let plane = null;

    if (feature.sketch) {
      const sk = doc.sketches[feature.sketch];
      if (sk) {
        let regions = regionsById[sk.id];
        if (!regions) {
          solveSketch(sk, { maxIterations: 40 });
          regions = findRegions(materializeSketch(sk, sketchProjections[sk.id]));
          regionsById[sk.id] = regions;
        }
        // No seeds at all means the whole sketch, which is what an older file
        // and the browser's "extrude this sketch" both mean. An empty list is
        // different: it means nothing has been pointed at yet.
        const picked =
          feature.seeds === null || feature.seeds === undefined
            ? regions
            : regionsForSeeds(regions, feature.seeds);
        plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);
        for (const r of picked) contours.push(...regionToPolygons(r));
      }
    }

    for (const ref of feature.faces || []) {
      const found = faceContour(ref);
      if (!found) continue;
      if (!plane) plane = found.plane;
      // Faces have to be coplanar with whatever is already being extruded,
      // because one extrusion has one direction.
      const along = dot3(found.plane.n, plane.n);
      if (Math.abs(Math.abs(along) - 1) > 1e-3) continue;
      // Boundary points arrive as world triples and contours are pairs in the
      // plane, so they go through the conversion rather than straight across.
      for (const loop of found.loops) {
        contours.push(
          loop.map((pt) => {
            const q = worldToSketch(plane, { x: pt[0], y: pt[1], z: pt[2] });
            return [q.u, q.v];
          })
        );
      }
    }

    if (!plane) throw new Error('Extrude has nothing to work from');
    return { contours, plane };
  }

  function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  /**
   * Find the face a stored reference points at, in whichever body it belongs
   * to. References are matched back by shape and position rather than by index,
   * because the kernel has no stable face identities across a rebuild.
   */
  function findFace(ref) {
    if (!ref || !ref.face) return null;
    const pool = ref.bodyId ? bodies.filter((b) => b.id === ref.bodyId) : bodies;
    for (const b of pool.length ? pool : bodies) {
      let topo;
      try {
        topo = buildTopology(meshOf(b));
      } catch {
        continue;
      }
      const [face] = resolveFaceRefs(topo, [ref.face]);
      if (face) return { body: b, topo, face };
    }
    return null;
  }

  /** A planar face's boundary loops, in world space, with the plane it lies in. */
  function faceContour(ref) {
    const found = findFace(ref);
    if (!found || !found.face.planar) return null;
    const { topo, face } = found;

    const segs = [];
    for (const e of topo.edges) {
      if (e.faceA !== face.id && e.faceB !== face.id) continue;
      for (let i = 0; i < e.points.length - 1; i++) segs.push([e.points[i], e.points[i + 1]]);
    }
    const loops = chainWorldSegments(segs).filter((c) => c.length > 2);
    if (!loops.length) return null;

    const b = basisFor(face.normal);
    return { loops, plane: { origin: face.centre, x: b.x, y: b.y, n: b.n } };
  }

  /** Where a face or plane reference sits, as a plane. */
  function objectPlane(ref, scope) {
    if (!ref) return null;
    if (ref.plane) return resolvePlane(ref.plane, scope, builtConstruction);
    const found = findFace(ref);
    if (!found) return null;
    const b = basisFor(found.face.normal);
    return { origin: found.face.centre, x: b.x, y: b.y, n: b.n };
  }

  /**
   * Join loose segments into closed loops by their end points. Positions are
   * quantised first, because a boundary shared by two faces arrives twice and
   * the two copies agree only to floating point.
   */
  function chainWorldSegments(segs, allowOpen) {
    const key = (p) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)},${Math.round(p[2] * 1e6)}`;
    const at = new Map();
    for (const [a, b] of segs) {
      for (const [from, to] of [[a, b], [b, a]]) {
        const k = key(from);
        if (!at.has(k)) at.set(k, []);
        at.get(k).push(to);
      }
    }
    const used = new Set();
    const loops = [];
    for (const [a, b] of segs) {
      const seed = `${key(a)}|${key(b)}`;
      if (used.has(seed)) continue;
      const loop = [a];
      let prev = a;
      let cur = b;
      used.add(seed);
      used.add(`${key(b)}|${key(a)}`);
      for (let guard = 0; guard < 100000; guard++) {
        loop.push(cur);
        const next = (at.get(key(cur)) || []).find(
          (n) => !used.has(`${key(cur)}|${key(n)}`) && key(n) !== key(prev)
        );
        if (!next) break;
        used.add(`${key(cur)}|${key(next)}`);
        used.add(`${key(next)}|${key(cur)}`);
        prev = cur;
        cur = next;
        if (key(cur) === key(a)) break;
      }
      if (loop.length > 2 || (allowOpen && loop.length > 1)) loops.push(loop);
    }
    // An open chain can be walked into from the middle, so the longest run is
    // the one worth keeping.
    if (allowOpen) loops.sort((a, b) => b.length - a.length);
    return loops;
  }

  /** How far this side reaches, signed along the plane normal. */
  function extentReach(feature, extent, dist, base, which) {
    if (extent === 'all') return throughAllDepth(bodies, base);
    if (extent === 'object') {
      // Built long here and trimmed afterwards, because how far is decided by
      // geometry rather than by a number.
      return throughAllDepth(bodies, base);
    }
    return which === 2 ? Math.abs(dist) : dist;
  }

  /**
   * Cut a long prism back to the object it was told to reach.
   *
   * The cut is a half space at a plane along the extrude direction. Which plane
   * depends on the extend setting: the face itself, or the near or far side of
   * a whole body.
   */
  function trimToObject(feature, world, base, scope, ks, errs) {
    const target = feature.toObject;
    const n = base.n;
    const at = extendPlaneDistance(feature, base, scope);
    if (at === null) {
      errs.push({ feature: feature.id, message: 'Extrude has nothing to reach to.' });
      return world;
    }
    const cutAt = at + safeEval(feature.toOffset, scope, 0);

    // A half space, big enough to swallow anything, whose face sits at cutAt
    // along the direction of travel.
    const span = throughAllDepth(bodies, base) * 4 + 200;
    let slab = K.box([span, span, span], true, ks);
    const m = new THREE.Matrix4();
    const dir = new THREE.Vector3(n[0], n[1], n[2]);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    const centre = new THREE.Vector3(
      base.origin[0] + n[0] * (cutAt - span / 2),
      base.origin[1] + n[1] * (cutAt - span / 2),
      base.origin[2] + n[2] * (cutAt - span / 2)
    );
    m.compose(centre, q, new THREE.Vector3(1, 1, 1));
    slab = K.transform(slab, m.elements, ks);
    const trimmed = K.intersection(world, slab, ks);
    if (K.isEmpty(trimmed)) {
      errs.push({ feature: feature.id, message: 'Extrude to object reached nothing.' });
      return world;
    }
    return trimmed;
  }

  /** Distance along the normal at which an extend setting says to stop. */
  function extendPlaneDistance(feature, base, scope) {
    const ref = feature.toObject;
    if (!ref) return null;
    const n = base.n;
    const along = (p) =>
      (p[0] - base.origin[0]) * n[0] +
      (p[1] - base.origin[1]) * n[1] +
      (p[2] - base.origin[2]) * n[2];

    if (ref.plane) {
      const pl = resolvePlane(ref.plane, scope, builtConstruction);
      return along(pl.origin);
    }

    const found = ref.face ? findFace(ref) : null;
    const body = found ? found.body : bodies.find((b) => b.id === ref.bodyId);
    if (!body) return null;

    // A whole body is measured by its extent along the direction of travel;
    // through means past its far side, to means up to its near one.
    if (!found || feature.extend === 'body' || feature.extend === 'through') {
      const bb = K.boundingBox(body.solid);
      const corners = [];
      for (const x of [bb.min[0], bb.max[0]]) {
        for (const y of [bb.min[1], bb.max[1]]) {
          for (const z of [bb.min[2], bb.max[2]]) corners.push(along([x, y, z]));
        }
      }
      const ahead = corners.filter((d) => d > 1e-9);
      if (!ahead.length) return null;
      return feature.extend === 'through' ? Math.max(...ahead) : Math.min(...ahead);
    }

    // To the selected face, or to it and whatever runs alongside it. Both stop
    // at the plane the face lies in; adjacent faces that are not coplanar with
    // it are not followed, which is the one place this falls short of Fusion.
    return along(found.face.centre);
  }

  /**
   * A closed profile turned into a wall of the given thickness. Which side the
   * wall lands on is the wall location; the region between the two offsets is
   * what gets extruded.
   */
  function thinWallContours(feature, contours, scope, ks) {
    const t = Math.abs(safeEval(feature.wall, scope, 1));
    if (!(t > 1e-9)) throw new Error('Thin extrude needs a wall thickness');
    const loc = feature.wallLocation || 'side1';
    const outer = loc === 'side2' ? 0 : loc === 'center' ? t / 2 : t;
    const inner = loc === 'side2' ? -t : loc === 'center' ? -t / 2 : 0;

    const cs = (d) =>
      d === 0 ? K.crossSection(contours, ks) : K.offsetContours(contours, d, 'Miter', ks);
    const ring = cs(outer).subtract(cs(inner));
    return ks.track(ring).toPolygons();
  }

  /**
   * Loft between profiles on different planes.
   * Holes are lofted separately and taken back out, which keeps a lofted tube
   * hollow all the way through instead of only at its ends.
   */
  /**
   * Loft between two or more sections.
   *
   * A section is a sketch profile, a planar face, or a single sketch point,
   * which is how a loft comes to a tip. Ends can leave their own plane rather
   * than heading straight for the next section, and guide rails pull the
   * intermediate sections out to meet them.
   */
  function doLoft(feature, doc, scope, ks, regionsById, apply, errs) {
    normalizeLoft(feature);
    const sections = feature.sections || [];
    if (sections.length < 2) throw new Error('Loft needs at least two profiles');

    const picked = sections.map((section) => loftSection(section, doc, scope, regionsById));

    const rails = (feature.rails || [])
      .map((r) => curvePoints(r, doc, scope))
      .filter((r) => r && r.length > 1);

    const build = (loops) => {
      let list = loops;
      // Tangency is expressed as an extra section a short way off the end,
      // still the same size, so the surface leaves square to the profile
      // before it starts heading for the next one.
      list = withEndConditions(feature, scope, list);
      if (rails.length) list = pulledToRails(list, rails);
      return loftLoops(list, ks, { closed: !!feature.closed });
    };

    const outer = build(picked.map((p) => ({ contour: p.outer, plane: p.plane })));
    if (!outer) throw new Error('Loft could not be built from those profiles');

    let solid = outer;
    const holeCount = Math.min(...picked.map((p) => p.holes.length));
    for (let h = 0; h < holeCount; h++) {
      const tube = build(picked.map((p) => ({ contour: p.holes[h], plane: p.plane })));
      if (tube) solid = K.difference(solid, tube, ks);
    }

    apply(feature, solid, feature.op || 'new');
  }

  /** One loft section: a sketch profile, a planar face, or a point. */
  function loftSection(section, doc, scope, regionsById) {
    if (section.face) {
      const found = faceContour(section.face);
      if (!found) throw new Error('Loft has lost one of its faces');
      const flat = found.loops.map((loop) =>
        loop.map((pt) => {
          const q = worldToSketch(found.plane, { x: pt[0], y: pt[1], z: pt[2] });
          return [q.u, q.v];
        })
      );
      const [first, ...rest] = groupRings(flat);
      return { outer: first.outer, holes: first.holes.concat(rest.map((g) => g.outer)), plane: found.plane };
    }

    const sk = doc.sketches[section.sketch];
    if (!sk) throw new Error('Loft has lost one of its sketches');
    const plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);

    if (section.point !== undefined) {
      // A point section: every vertex of the ring in the same place, which is
      // what brings a loft to a tip.
      const p = sk.points[section.point];
      if (!p) throw new Error('Loft has lost one of its points');
      const ring = [];
      for (let i = 0; i < 8; i++) ring.push([p.x, p.y]);
      return { outer: ring, holes: [], plane, degenerate: true };
    }

    let regions = regionsById[sk.id];
    if (!regions) {
      solveSketch(sk, { maxIterations: 40 });
      regions = findRegions(materializeSketch(sk, sketchProjections[sk.id]));
      regionsById[sk.id] = regions;
    }
    const [region] = section.seed ? regionsForSeeds(regions, [section.seed]) : regions.slice(0, 1);
    if (!region) throw new Error('Loft has lost one of its profiles');
    return {
      outer: region.outer.map((q) => [q.x, q.y]),
      holes: region.holes.map((h) => h.map((q) => [q.x, q.y])),
      plane
    };
  }

  /**
   * Add a section just off each end so the loft leaves that end square to its
   * own plane instead of setting off straight for the next one. The weight is
   * how far off, as a fraction of the gap to the neighbouring section.
   */
  function withEndConditions(feature, scope, loops) {
    if (loops.length < 2) return loops;
    const out = loops.slice();

    const gap = (a, b) =>
      Math.hypot(
        a.plane.origin[0] - b.plane.origin[0],
        a.plane.origin[1] - b.plane.origin[1],
        a.plane.origin[2] - b.plane.origin[2]
      ) || 1;

    const shifted = (sec, towards, dist) => {
      const n = sec.plane.n;
      // Off along the section's own normal, towards its neighbour.
      const sign =
        (towards.plane.origin[0] - sec.plane.origin[0]) * n[0] +
        (towards.plane.origin[1] - sec.plane.origin[1]) * n[1] +
        (towards.plane.origin[2] - sec.plane.origin[2]) * n[2] >= 0
          ? 1
          : -1;
      return {
        contour: sec.contour,
        plane: {
          ...sec.plane,
          origin: [
            sec.plane.origin[0] + n[0] * dist * sign,
            sec.plane.origin[1] + n[1] * dist * sign,
            sec.plane.origin[2] + n[2] * dist * sign
          ]
        }
      };
    };

    if (feature.endCondition === 'tangent') {
      const w = Math.max(0.01, Math.min(0.9, safeEval(feature.endWeight, scope, 1) * 0.25));
      const last = out[out.length - 1];
      out.splice(out.length - 1, 0, shifted(last, out[out.length - 2], gap(last, out[out.length - 2]) * w));
    }
    if (feature.startCondition === 'tangent') {
      const w = Math.max(0.01, Math.min(0.9, safeEval(feature.startWeight, scope, 1) * 0.25));
      out.splice(1, 0, shifted(out[0], out[1], gap(out[0], out[1]) * w));
    }
    return out;
  }

  /**
   * Pull each section out so its outline reaches the rails. The rail says how
   * wide the loft should be where that section sits, and the section is scaled
   * about its own centre to match.
   */
  function pulledToRails(loops, rails) {
    const centreOf = (sec) => {
      let cx = 0;
      let cy = 0;
      for (const [x, y] of sec.contour) {
        cx += x / sec.contour.length;
        cy += y / sec.contour.length;
      }
      return { cx, cy };
    };

    const reach = (sec, cx, cy) => {
      let far = 0;
      for (const [x, y] of sec.contour) far = Math.max(far, Math.hypot(x - cx, y - cy));
      return far;
    };

    // How far the rails sit from each section's centre, in that section's plane.
    const wanted = loops.map((sec) => {
      const { cx, cy } = centreOf(sec);
      const world = sketchToWorld(sec.plane, cx, cy, 0);
      let best = Infinity;
      for (const rail of rails) {
        for (const r of rail) {
          const q = worldToSketch(sec.plane, { x: r[0], y: r[1], z: r[2] });
          // Only rail points that pass near this section's plane count.
          if (Math.abs(q.w) > reach(sec, cx, cy) * 2 + 1) continue;
          const d = Math.hypot(q.u - cx, q.v - cy);
          if (d < best) best = d;
        }
      }
      void world;
      return Number.isFinite(best) ? best : null;
    });

    const base = wanted.findIndex((w) => w !== null);
    if (base < 0) return loops;
    const ref = reach(loops[base], centreOf(loops[base]).cx, centreOf(loops[base]).cy) || 1;
    const refWanted = wanted[base] || ref;

    return loops.map((sec, i) => {
      const want = wanted[i];
      if (want === null) return sec;
      const { cx, cy } = centreOf(sec);
      const now = reach(sec, cx, cy) || 1;
      const target = (want / refWanted) * ref;
      const k = target / now;
      if (!(k > 0.01) || Math.abs(k - 1) < 1e-6) return sec;
      return {
        ...sec,
        contour: sec.contour.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k])
      };
    });
  }

  /**
   * Sweep a profile along a path.
   *
   * The path can be a chain of sketch curves or a chain of model edges, and an
   * optional guide rail alongside it drives how the section grows as it goes.
   */
  function doSweep(feature, doc, scope, ks, regionsById, apply, errs) {
    normalizeSweep(feature);

    const { contours, plane: profilePlane } = extrudeProfiles(feature, doc, scope, regionsById);
    if (!contours.length) {
      throw new Error('Select one or more profiles or planar faces to sweep.');
    }

    let world = curvePoints(feature.path, doc, scope);
    if (!world || world.length < 2) throw new Error('Sweep has no path');
    const closedPath = !!feature.path?.closed;

    // How far along to travel, as a fraction of the whole path.
    const frac = Math.max(0.001, Math.min(1, safeEval(feature.distance, scope, 1)));
    if (frac < 0.999) {
      world = trimPolyline(world, frac);
      if (world.length < 2) throw new Error('The sweep distance is too short');
    }
    const partial = frac < 0.999;

    const twist = safeEval(feature.twist, scope, 0);
    let frames = pathFrames(world, {
      closed: closedPath && !partial,
      twistDegrees: twist
    });
    if (frames.length < 2) throw new Error('The sweep path is too short');

    // Parallel keeps every section facing the way the first one does, rather
    // than turning to stay square to the path.
    if (feature.orientation === 'parallel') {
      const f0 = frames[0];
      frames = frames.map((f) => ({ ...f, x: f0.x, y: f0.y, z: f0.z }));
    }

    const f0 = frames[0];
    const facing = Math.abs(
      profilePlane.n[0] * f0.z[0] + profilePlane.n[1] * f0.z[1] + profilePlane.n[2] * f0.z[2]
    );
    if (facing < 0.2) {
      throw new Error(
        'The profile is almost edge on to the path. Draw it on a plane facing along the path.'
      );
    }

    // Into the frame that travels along the path. The profile's own plane and
    // the first frame rarely share axes and the path rarely starts at the
    // sketch origin, so each point goes out to world space and back in against
    // the frame rather than being shifted in two dimensions.
    const toRing = (pts) =>
      pts.map(([x, y]) => {
        const w = sketchToWorld(profilePlane, x, y, 0);
        const d = [w.x - world[0][0], w.y - world[0][1], w.z - world[0][2]];
        return [
          d[0] * f0.x[0] + d[1] * f0.x[1] + d[2] * f0.x[2],
          d[0] * f0.y[0] + d[1] * f0.y[1] + d[2] * f0.y[2]
        ];
      });

    const rings = contours.map(toRing);

    // How the section changes size along the way: from a guide rail if there is
    // one, otherwise from a taper angle or a plain end scale.
    const profile = { rings, frames, world };
    const scaleAt = sweepScaling(feature, scope, profile, doc);

    let solid = null;
    for (const region of groupRings(rings)) {
      const body = sweepLoop(region.outer, world, ks, {
        closed: closedPath && !partial,
        twistDegrees: twist,
        frames,
        scaleAt
      });
      if (!body) continue;
      let piece = body;
      for (const hole of region.holes) {
        const tube = sweepLoop(hole, world, ks, {
          closed: closedPath && !partial,
          twistDegrees: twist,
          frames,
          scaleAt
        });
        if (tube) piece = K.difference(piece, tube, ks);
      }
      solid = solid ? K.union(solid, piece, ks) : piece;
    }
    if (!solid) throw new Error('Sweep produced nothing');

    apply(feature, solid, feature.op || 'new');
  }

  /**
   * Split a flat list of contours into outers and the holes inside them, by
   * area and containment. extrudeProfiles hands back everything at one level.
   */
  function groupRings(rings) {
    const withArea = rings.map((r) => ({ r, a: Math.abs(polyArea(r)) }));
    withArea.sort((p, q) => q.a - p.a);
    const out = [];
    for (const { r } of withArea) {
      const host = out.find((g) => ringInside(r, g.outer));
      if (host) host.holes.push(r);
      else out.push({ outer: r, holes: [] });
    }
    return out;
  }

  function polyArea(ring) {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      a += x1 * y2 - x2 * y1;
    }
    return a / 2;
  }

  function ringInside(inner, outer) {
    const [px, py] = inner[0];
    let hit = false;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const [xi, yi] = outer[i];
      const [xj, yj] = outer[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }

  /** Keep the first `frac` of a polyline, by arc length. */
  function trimPolyline(pts, frac) {
    let total = 0;
    const seg = [];
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(
        pts[i][0] - pts[i - 1][0],
        pts[i][1] - pts[i - 1][1],
        pts[i][2] - pts[i - 1][2]
      );
      seg.push(d);
      total += d;
    }
    const want = total * frac;
    const out = [pts[0]];
    let run = 0;
    for (let i = 0; i < seg.length; i++) {
      if (run + seg[i] >= want) {
        const t = seg[i] > 1e-12 ? (want - run) / seg[i] : 0;
        const a = pts[i];
        const b = pts[i + 1];
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
        break;
      }
      run += seg[i];
      out.push(pts[i + 1]);
    }
    return out;
  }

  /**
   * A function from position along the path to how much the section is scaled
   * there. A guide rail measures the distance from path to rail and scales by
   * how that changes; otherwise a taper angle or an end scale drives it.
   */
  function sweepScaling(feature, scope, profile, doc) {
    const { frames, world, rings } = profile;

    if (feature.sweepType === 'rail' && feature.rail) {
      if (feature.profileScaling === 'none') return null;
      const rail = curvePoints(feature.rail, doc, scope);
      if (!rail || rail.length < 2) {
        throw new Error('The sweep guide rail is not a connected chain');
      }
      const gap = (i) => {
        const at = world[Math.min(i, world.length - 1)];
        let best = Infinity;
        for (const r of rail) {
          const d = Math.hypot(r[0] - at[0], r[1] - at[1], r[2] - at[2]);
          if (d < best) best = d;
        }
        return best;
      };
      const first = gap(0);
      if (!(first > 1e-9)) throw new Error('The guide rail starts on the path');
      const along = frames.map((_, i) => gap(Math.round((i / (frames.length - 1)) * (world.length - 1))) / first);
      // Stretch grows the section only towards the rail; scale grows it evenly.
      return { by: along, mode: feature.profileScaling === 'stretch' ? 'stretch' : 'scale' };
    }

    const taper = safeEval(feature.taper, scope, 0);
    if (Math.abs(taper) > 1e-9) {
      // A taper on a section that is not round is read as the angle its outline
      // leans out by, taken against the profile's mean radius.
      let length = 0;
      for (let i = 1; i < world.length; i++) {
        length += Math.hypot(
          world[i][0] - world[i - 1][0],
          world[i][1] - world[i - 1][1],
          world[i][2] - world[i - 1][2]
        );
      }
      const radius = meanRadius(rings);
      if (radius > 1e-9) {
        const end = 1 + (length * Math.tan((taper * Math.PI) / 180)) / radius;
        return linearScale(frames.length, Math.max(0.001, end), 'scale');
      }
    }

    const end = safeEval(feature.scale, scope, 1);
    if (Math.abs(end - 1) > 1e-9) return linearScale(frames.length, end, 'scale');
    return null;
  }

  function linearScale(n, end, mode) {
    const by = [];
    for (let i = 0; i < n; i++) by.push(1 + (end - 1) * (n > 1 ? i / (n - 1) : 0));
    return { by, mode };
  }

  function meanRadius(rings) {
    let sum = 0;
    let count = 0;
    for (const ring of rings) {
      let cx = 0;
      let cy = 0;
      for (const [x, y] of ring) {
        cx += x / ring.length;
        cy += y / ring.length;
      }
      for (const [x, y] of ring) {
        sum += Math.hypot(x - cx, y - cy);
        count++;
      }
    }
    return count ? sum / count : 0;
  }

  /**
   * World points for a path or rail reference: a chain of sketch curves, or a
   * chain of model edges.
   */
  function curvePoints(ref, doc, scope) {
    if (!ref) return null;
    if (ref.sketch) {
      const sk = doc.sketches[ref.sketch];
      if (!sk) return null;
      if (!sk.is3d) solveSketch(sk, { maxIterations: 40 });
      const plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);
      const chain = chainPath(sk, { entities: ref.entities });
      if (!chain) throw new Error('The sweep path is not a connected chain');
      ref.closed = chain.closed;
      // The third coordinate comes through, so a sweep can follow a path that
      // leaves the plane it was drawn on.
      return chain.points.map((p) => {
        const v = sketchToWorld(plane, p.x, p.y, p.z || 0);
        return [v.x, v.y, v.z];
      });
    }
    if (ref.edges) {
      const segs = [];
      for (const b of bodies) {
        let topo;
        try {
          topo = buildTopology(meshOf(b));
        } catch {
          continue;
        }
        for (const e of resolveEdgeRefs(topo, ref.edges)) {
          if (e) for (let i = 0; i < e.points.length - 1; i++) segs.push([e.points[i], e.points[i + 1]]);
        }
        if (segs.length) break;
      }
      if (!segs.length) return null;
      const [chain] = chainWorldSegments(segs, true);
      return chain || null;
    }
    return null;
  }

  /**
   * Rib: an open sketch curve thickened into a wall and grown down onto the
   * body below it. Web is the same with several curves at once.
   */
  function doRib(feature, doc, scope, ks, apply, errs) {
    const sk = doc.sketches[feature.sketch];
    if (!sk) throw new Error('Rib has no sketch');
    solveSketch(sk, { maxIterations: 40 });
    const plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);

    const thickness = safeEval(feature.thickness, scope, 2);
    const depth = safeEval(feature.depth, scope, 10);
    if (thickness <= 0 || depth <= 0) return;

    const chains = [];
    const remaining = sk.entities
      .filter((e) => (e.type === 'line' || e.type === 'arc') && !e.construction)
      .map((e) => e.id);
    // Each connected run of curves becomes its own wall.
    let pool = remaining.slice();
    let guard = 0;
    while (pool.length && guard++ < 64) {
      const chain = chainPath(sk, { entities: pool });
      if (!chain) break;
      chains.push(chain);
      const used = new Set();
      for (const id of pool) {
        const ent = sk.entities.find((e) => e.id === id);
        if (!ent) continue;
        const pts = tessellate(sk, ent);
        const onChain = pts.every((p) =>
          chain.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6)
        );
        if (onChain) used.add(id);
      }
      if (!used.size) break;
      pool = pool.filter((id) => !used.has(id));
    }
    if (!chains.length) throw new Error('Rib needs an open sketch curve');

    let solid = null;
    for (const chain of chains) {
      const contours = thickenPolyline(chain.points, thickness / 2, chain.closed);
      if (!contours) continue;
      let wall = K.extrudeContours(contours, { height: depth, center: false }, ks);
      // The wall grows away from the sketch plane; flipped, it grows the other
      // way, which is what you want when the sketch sits above the part.
      if (feature.flip) {
        wall = K.transform(wall, new THREE.Matrix4().makeScale(1, 1, -1).elements, ks);
      }
      const placed = K.transform(wall, planeMatrix(plane).elements, ks);
      solid = solid ? K.union(solid, placed, ks) : placed;
    }
    if (!solid) throw new Error('Rib produced nothing');

    apply(feature, solid, feature.op || 'join');
  }

  /**
   * Draft: tilt selected faces relative to a pull direction.
   *
   * Each face turns about the line where it meets the neutral plane, so the
   * part keeps its size there and tapers away from it. The material between the
   * old face and the new one is added on one side of that line and taken away
   * on the other, both clipped to the face's own footprint so nothing else on
   * the body is disturbed.
   */
  function doDraft(feature, bodies, scope, ks, errs) {
    normalizeDraft(feature);
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;

    const angle = safeEval(feature.angle, scope, 3);
    if (Math.abs(angle) < 1e-9) return bodies;

    const neutral = resolvePlane(feature.neutral || 'XY', scope, builtConstruction);
    const pull = neutral.n;

    const out = bodies.slice();
    for (const b of targets) {
      const mesh = K.meshData(b.solid);
      const topo = buildTopology(mesh);
      const faces = resolveFaceRefs(topo, feature.faces);
      if (!faces.length) {
        errs.push({
          feature: feature.id,
          message: 'Draft has lost the faces it was applied to'
        });
        continue;
      }

      const bb = K.boundingBox(b.solid);
      const span =
        Math.hypot(
          bb.max[0] - bb.min[0],
          bb.max[1] - bb.min[1],
          bb.max[2] - bb.min[2]
        ) + 20;

      let solid = b.solid;
      for (const face of faces) {
        if (!face.planar) continue;
        const n = face.normal;

        // A face square to the pull direction cannot be drafted.
        const axis = cross(n, pull);
        const axisLen = Math.hypot(axis[0], axis[1], axis[2]);
        if (axisLen < 0.15) {
          errs.push({
            feature: feature.id,
            message: 'A face facing along the pull direction cannot be drafted'
          });
          continue;
        }
        const d = [axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen];

        // A point on the line where the face meets the neutral plane.
        const pivot = planeIntersectionPoint(face, neutral, d);
        if (!pivot) continue;

        const prism = buildFacePrism(mesh, face, span, ks);
        const prismBack = buildFacePrism(mesh, face, -span, ks);
        if (!prism || !prismBack) continue;
        const footprint = K.union(prism, prismBack, ks);
        const oldSide = halfSpace(face.centre, n, span, ks);

        /*
         * Lean the face by `deg` about where it meets the neutral plane, and
         * keep the change to `clip` if one is given. Two sided draft is this
         * done twice, leaning opposite ways either side of the plane, which is
         * the shape a moulded part has about its parting line.
         */
        const lean = (deg, clip) => {
          const rot = new THREE.Matrix4().makeRotationAxis(
            new THREE.Vector3(d[0], d[1], d[2]),
            (deg * Math.PI) / 180
          );
          const tilted = new THREE.Vector3(n[0], n[1], n[2]).applyMatrix4(rot);
          const newSide = halfSpace(
            [pivot[0], pivot[1], pivot[2]],
            [tilted.x, tilted.y, tilted.z],
            span,
            ks
          );

          // Beyond the new plane, inside the footprint: material to take away.
          let remove = K.intersection(K.difference(footprint, newSide, ks), solid, ks);
          // Past the old face but inside the new plane: material to put on.
          let addOn = K.intersection(footprint, K.difference(newSide, oldSide, ks), ks);
          if (clip) {
            remove = K.intersection(remove, clip, ks);
            addOn = K.intersection(addOn, clip, ks);
          }

          solid = K.difference(solid, remove, ks);
          if (!K.isEmpty(addOn)) solid = K.union(solid, addOn, ks);
        };

        if (feature.sides === 'two') {
          const above = halfSpace(neutral.origin, neutral.n, span, ks);
          const below = halfSpace(
            neutral.origin,
            [-neutral.n[0], -neutral.n[1], -neutral.n[2]],
            span,
            ks
          );
          lean(angle, above);
          lean(-angle, below);
        } else {
          lean(angle, null);
        }
      }
      out[out.indexOf(b)] = { ...b, solid };
    }
    return out;
  }

  /** Split a body in two with a plane. */
  function doSplit(feature, bodies, scope, ks, errs) {
    normalizeSplit(feature);
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;
    // The cutting tool can be an origin or construction plane, or the plane a
    // face of the model lies in.
    const plane = feature.faceRef
      ? objectPlane(feature.faceRef, scope) || resolvePlane(feature.plane || 'XY', scope, builtConstruction)
      : resolvePlane(feature.plane || 'XY', scope, builtConstruction);

    const out = [];
    for (const b of bodies) {
      if (!targets.includes(b)) {
        out.push(b);
        continue;
      }
      const bb = K.boundingBox(b.solid);
      const span =
        Math.hypot(
          bb.max[0] - bb.min[0],
          bb.max[1] - bb.min[1],
          bb.max[2] - bb.min[2]
        ) + 20;
      const below = halfSpace(plane.origin, plane.n, span, ks);

      const keep = K.intersection(b.solid, below, ks);
      const rest = K.difference(b.solid, below, ks);

      if (K.isEmpty(keep) || K.isEmpty(rest)) {
        errs.push({
          feature: feature.id,
          message: 'The split plane does not pass through this body'
        });
        out.push(b);
        continue;
      }
      out.push({ ...b, solid: keep });
      // Keeping only the near side is a trim rather than a split, and is what
      // you want when the far half was only ever in the way.
      if (feature.splitType !== 'keep') {
        out.push({
          id: `${feature.id}:${out.length}`,
          name: `${b.name} split`,
          solid: rest,
          createdBy: feature.id
        });
      }
    }
    return out;
  }

  /**
   * A modelled 60 degree thread, cut as a helical groove.
   *
   * Cosmetic threads are only a texture, which is no use for a printed part, so
   * this is the real geometry. The profile is the standard triangle truncated
   * at the crest and root, with an allowance so the two halves actually screw
   * together once printed.
   */
  function doThread(feature, bodies, scope, ks, errs) {
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;

    const diameter = safeEval(feature.diameter, scope, 8);
    const pitch = safeEval(feature.pitch, scope, 1.25);
    const length = safeEval(feature.length, scope, 10);
    const clearance = safeEval(feature.clearance, scope, 0.2);
    const internal = !!feature.internal;
    if (pitch <= 0 || length <= 0 || diameter <= 0) return bodies;

    const plane = resolvePlane(feature.plane || 'XY', scope, builtConstruction);
    const turns = length / pitch;

    // The ISO metric profile: a 60 degree V truncated to a flat of an eighth
    // of the pitch at both crest and root. The flats matter, and not only for
    // realism: cut the groove a full pitch wide and consecutive turns meet
    // exactly, which the boolean resolves into hundreds of tiny tunnels.
    const depth = 0.5413 * pitch;
    const outerHalf = 0.4375 * pitch;
    const rootHalf = 0.125 * pitch;

    // For an external thread the groove bites inward from the surface; for an
    // internal one it bites outward from the bore.
    const dir = internal ? 1 : -1;
    // The cutter always breaks the surface by a little, whatever the clearance.
    // Landing exactly on it is a tangential boolean, and the kernel resolves
    // that into a mess of tiny tunnels rather than a clean groove.
    const OVERSHOOT = Math.max(0.02, pitch * 0.02);
    const surface = dir * -(clearance + OVERSHOOT);
    const root = surface + dir * (depth + clearance + OVERSHOOT);
    const flare = clearance * 0.5;
    const profile = [
      [surface, -(outerHalf + flare)],
      [root, -rootHalf],
      [root, rootHalf],
      [surface, outerHalf + flare]
    ];

    const radius = diameter / 2;
    // Run past both ends so the thread does not stop short inside the part.
    const tool = helicalSweep(
      profile,
      {
        radius,
        pitch,
        turns: turns + 2,
        startZ: -pitch,
        stepsPerTurn: Math.max(24, Math.round(360 / MIN_THREAD_STEP)),
        handed: feature.leftHanded ? -1 : 1
      },
      ks
    );
    if (!tool) {
      errs.push({ feature: feature.id, message: 'Thread could not be built' });
      return bodies;
    }

    const placed = K.transform(tool, planeMatrix(plane).elements, ks);
    const out = bodies.slice();
    for (const b of targets) {
      out[out.indexOf(b)] = { ...b, solid: K.difference(b.solid, placed, ks) };
    }
    return out;
  }

  /**
   * Rebuild a sketch's projected geometry from the model.
   *
   * Returns loose points and entities to be merged into a copy of the sketch,
   * never into the sketch itself: its own points are addressed by index and
   * inserting into that list would renumber every constraint.
   */
  function projectInto(sk, plane, currentBodies, errs, feature) {
    const projected = projectEdgesInto(sk, plane, currentBodies, errs, feature);
    const sectioned = sectionInto(sk, plane, currentBodies, errs, feature);
    if (!projected) return sectioned;
    if (!sectioned) return projected;

    // Both kinds are merged into one set of loose geometry, so everything
    // downstream, region finding included, sees one list rather than two.
    const base = projected.points.length;
    return {
      points: [...projected.points, ...sectioned.points],
      entities: [
        ...projected.entities,
        ...sectioned.entities.map((e) => ({
          ...e,
          ...(e.p !== undefined
            ? { p: Array.isArray(e.p) ? e.p.map((i) => i + base) : e.p + base }
            : {}),
          ...(e.c !== undefined ? { c: e.c + base } : {})
        }))
      ]
    };
  }

  /**
   * Where the chosen bodies cross the sketch plane.
   *
   * Fusion's Intersect. Every triangle that straddles the plane contributes the
   * segment where it crosses, and the segments are chained into loops the same
   * way a face's boundary is. The loops come out as ordinary straight runs
   * rather than as one smoothed curve, because the section of a box is a
   * rectangle and a curve fitted through its corners would round them off.
   */
  function sectionInto(sk, plane, currentBodies, errs, feature) {
    const refs = sk.intersections || [];
    if (!refs.length || !currentBodies.length) return null;

    const points = [];
    const entities = [];
    let nextId = 200000;
    let lost = 0;

    for (const ref of refs) {
      const body = currentBodies.find((b) => b.id === ref.bodyId);
      if (!body) {
        lost++;
        continue;
      }
      let loops;
      try {
        loops = sectionLoops(body, plane);
      } catch {
        lost++;
        continue;
      }
      if (!loops.length) {
        lost++;
        continue;
      }

      for (const raw of loops) {
        // The chainer closes a loop by repeating its first point at the end.
        // Kept, that last point welds onto the first and the edge between them
        // is a zero length self loop, which the region walk cannot get past.
        const loop = raw.slice();
        const first = loop[0];
        const last = loop[loop.length - 1];
        if (
          loop.length > 1 &&
          Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]) < 1e-9
        ) {
          loop.pop();
        }
        const start = points.length;
        for (const w of loop) {
          const local = worldToSketch(plane, { x: w[0], y: w[1], z: w[2] });
          points.push({ x: local.u, y: local.v });
        }
        const n = points.length - start;
        if (n < 2) continue;
        for (let i = 0; i < n; i++) {
          const a = start + i;
          const b = start + ((i + 1) % n);
          if (a === b) continue;
          entities.push({ id: nextId++, type: 'line', p: [a, b] });
        }
      }
    }

    if (lost && errs && feature) {
      errs.push({
        feature: feature.id,
        message: `${sk.name}: ${lost} body no longer meets this sketch plane`
      });
    }
    return points.length ? { points, entities } : null;
  }

  /** The closed loops where a body's surface crosses a plane. */
  function sectionLoops(body, plane) {
    const mesh = K.meshData(body.solid);
    const vp = mesh.vertProperties;
    const tris = mesh.triVerts;
    const n = plane.n;
    const o = plane.origin;
    const distOf = (i) =>
      (vp[i * 3] - o[0]) * n[0] + (vp[i * 3 + 1] - o[1]) * n[1] + (vp[i * 3 + 2] - o[2]) * n[2];

    const lerp = (i, j, di, dj) => {
      const t = di / (di - dj);
      return [
        vp[i * 3] + (vp[j * 3] - vp[i * 3]) * t,
        vp[i * 3 + 1] + (vp[j * 3 + 1] - vp[i * 3 + 1]) * t,
        vp[i * 3 + 2] + (vp[j * 3 + 2] - vp[i * 3 + 2]) * t
      ];
    };

    const EPS = 1e-9;
    const segs = [];
    for (let t = 0; t < tris.length; t += 3) {
      const idx = [tris[t], tris[t + 1], tris[t + 2]];
      const d = idx.map(distOf);
      // A triangle lying in the plane contributes nothing: its own edges are
      // already carried by the neighbours that cross it.
      if (d.every((x) => Math.abs(x) < EPS)) continue;

      const hits = [];
      for (let e = 0; e < 3; e++) {
        const i = idx[e];
        const j = idx[(e + 1) % 3];
        const di = d[e];
        const dj = d[(e + 1) % 3];
        if (Math.abs(di) < EPS) hits.push([vp[i * 3], vp[i * 3 + 1], vp[i * 3 + 2]]);
        if ((di > EPS && dj < -EPS) || (di < -EPS && dj > EPS)) hits.push(lerp(i, j, di, dj));
      }
      if (hits.length >= 2) segs.push([hits[0], hits[1]]);
    }
    if (!segs.length) return [];
    return chainWorldSegments(segs).filter((c) => c.length > 2);
  }

  function projectEdgesInto(sk, plane, currentBodies, errs, feature) {
    const refs = sk.projections || [];
    if (!refs.length || !currentBodies.length) return null;

    const topos = currentBodies.map((b) => {
      try {
        return buildTopology(meshOf(b));
      } catch {
        return null;
      }
    });

    const points = [];
    const entities = [];
    let nextId = 100000;
    let lost = 0;

    const toLocal = (p) => {
      const local = worldToSketch(plane, { x: p[0], y: p[1], z: p[2] });
      return { x: local.u, y: local.v, w: local.w };
    };

    for (const ref of refs) {
      let edge = null;
      for (const topo of topos) {
        if (!topo) continue;
        const [found] = resolveEdgeRefs(topo, [ref]);
        if (found) {
          edge = found;
          break;
        }
      }
      if (!edge) {
        lost++;
        continue;
      }

      if (edge.kind === 'line') {
        const a = toLocal(edge.start);
        const b = toLocal(edge.end);
        points.push({ x: a.x, y: a.y }, { x: b.x, y: b.y });
        entities.push({
          id: nextId++,
          type: 'line',
          p: [points.length - 2, points.length - 1]
        });
      } else if (edge.kind === 'circle') {
        const axisDot = Math.abs(
          edge.axis[0] * plane.n[0] + edge.axis[1] * plane.n[1] + edge.axis[2] * plane.n[2]
        );
        // Only a circle facing the sketch stays a circle when flattened.
        if (axisDot < 0.999) {
          lost++;
          continue;
        }
        const c = toLocal(edge.centre);
        points.push({ x: c.x, y: c.y });
        entities.push({
          id: nextId++,
          type: 'circle',
          c: points.length - 1,
          r: edge.radius
        });
      } else {
        // Anything else keeps its shape as a polyline through its own points.
        const start = points.length;
        for (const p of edge.points) {
          const q = toLocal(p);
          points.push({ x: q.x, y: q.y });
        }
        entities.push({
          id: nextId++,
          type: 'spline',
          p: Array.from({ length: points.length - start }, (_, i) => start + i)
        });
      }
    }

    if (lost && errs && feature) {
      errs.push({
        feature: feature.id,
        message: `${sk.name}: ${lost} projected edge${lost === 1 ? '' : 's'} no longer exist`
      });
    }
    return points.length ? { points, entities } : null;
  }

  /**
   * Work out one piece of construction geometry, using the model as it stands
   * at this point in the timeline.
   */
  function buildConstruction(feature, scope, currentBodies, errs) {
    const topoCache = new Map();
    const topoFor = (bodyId) => {
      if (!topoCache.has(bodyId)) {
        const body = currentBodies.find((b) => b.id === bodyId) || currentBodies[0];
        topoCache.set(bodyId, body ? buildTopology(meshOf(body)) : null);
      }
      return topoCache.get(bodyId);
    };
    const anyTopo = () => (currentBodies.length ? topoFor(currentBodies[0].id) : null);

    const { resolved, errors: cerrs } = resolveConstruction([feature.entry], {
      scope,
      previous: builtConstruction,
      basePlane: (name) => {
        const p = BASE_PLANES[name];
        return p ? { kind: 'plane', ...p } : null;
      },
      sketchPoint: (ref) => {
        const sk = doc.sketches[ref.sketch];
        const pt = sk?.points?.[ref.index];
        if (!pt) return null;
        const plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);
        const w = sketchToWorld(plane, pt.x, pt.y, 0);
        return [w.x, w.y, w.z];
      },
      /**
       * A sketch's curves as one run of world points, for the constructions
       * that measure along a path. The chain is the sketch's own, so an open
       * run of lines and arcs comes back in the order it was drawn.
       */
      sketchPath: (ref) => {
        const sk = doc.sketches[ref.sketch];
        if (!sk) return null;
        const plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);
        const chain = chainPath(sk, {});
        if (!chain?.points?.length) return null;
        return chain.points.map((q) => {
          const w = sketchToWorld(plane, q.x, q.y, q.z || 0);
          return [w.x, w.y, w.z];
        });
      },
      faceFor: (ref) => {
        const topo = anyTopo();
        if (!topo) return null;
        const [face] = resolveFaceRefs(topo, [ref]);
        return face || null;
      },
      edgeFor: (ref) => {
        const topo = anyTopo();
        if (!topo) return null;
        const [edge] = resolveEdgeRefs(topo, [ref]);
        return edge || null;
      }
    });

    for (const [id, value] of resolved) builtConstruction.set(id, value);
    for (const e of cerrs) errs.push({ feature: feature.id, message: e.message });
  }

  /** How far a "through all" extrusion has to reach to clear every body. */
  function throughAllDepth(currentBodies, plane) {
    let reach = 20;
    for (const b of currentBodies) {
      const bb = K.boundingBox(b.solid);
      for (const corner of [bb.min, bb.max]) {
        const d = Math.abs(
          (corner[0] - plane.origin[0]) * plane.n[0] +
            (corner[1] - plane.origin[1]) * plane.n[1] +
            (corner[2] - plane.origin[2]) * plane.n[2]
        );
        reach = Math.max(reach, d);
      }
    }
    return reach * 2 + 20;
  }

  function doRevolve(feature, doc, scope, ks, regionsById, apply, errs) {
    normalizeRevolve(feature);

    const { contours: flat, plane } = extrudeProfiles(feature, doc, scope, regionsById);
    if (!flat.length) {
      throw new Error('Select one or more profiles or planar faces to revolve.');
    }

    const axis = revolveAxis(feature, doc, scope, plane, flat);
    let ad = axis.dir;
    let ax = axis.at;
    let perp = { x: ad.y, y: -ad.x };

    // Keep the profile on the positive side of the axis; the kernel discards
    // the other half. Reversing the axis direction preserves handedness.
    let signSum = 0;
    for (const c of flat) for (const [x, y] of c) signSum += (x - ax.x) * perp.x + (y - ax.y) * perp.y;
    if (signSum < 0) {
      ad = { x: -ad.x, y: -ad.y };
      perp = { x: ad.y, y: -ad.x };
    }

    const contours = flat.map((c) =>
      c.map(([x, y]) => [
        (x - ax.x) * perp.x + (y - ax.y) * perp.y,
        (x - ax.x) * ad.x + (y - ax.y) * ad.y
      ])
    );

    // How far round, and where that sweep starts. The kernel always revolves
    // from zero, so a second side or a symmetric sweep is built as one turn and
    // then rotated back to sit where it belongs.
    const a1 = safeEval(feature.angle, scope, 360);
    const span = revolveSpan(feature, scope, plane, ax, ad, perp, a1);
    if (!(Math.abs(span.total) > 1e-9)) throw new Error('Revolve angle is zero');
    const total = Math.min(360, Math.abs(span.total));

    const solid = K.revolveContours(contours, total, 0, ks);

    // Local frame: X along the radial direction, Z along the axis.
    const P3 = axisWorld(plane, perp);
    const D3 = axisWorld(plane, ad);
    const N3 = [-plane.n[0], -plane.n[1], -plane.n[2]];
    const origin = sketchToWorld(plane, ax.x, ax.y, 0);

    const m = new THREE.Matrix4();
    m.set(
      P3[0], N3[0], D3[0], origin.x,
      P3[1], N3[1], D3[1], origin.y,
      P3[2], N3[2], D3[2], origin.z,
      0, 0, 0, 1
    );

    let local = solid;
    if (Math.abs(span.start) > 1e-9) {
      // Turn the finished sweep back about its own axis, which here is Z.
      const spin = new THREE.Matrix4().makeRotationZ((span.start * Math.PI) / 180);
      local = K.transform(local, spin.elements, ks);
    }

    const world = K.transform(local, m.elements, ks);
    apply(feature, world, feature.op || 'new');
  }

  function axisWorld(plane, d) {
    return [
      plane.x[0] * d.x + plane.y[0] * d.y,
      plane.x[1] * d.x + plane.y[1] * d.y,
      plane.x[2] * d.x + plane.y[2] * d.y
    ];
  }

  /**
   * How far round to sweep, and how far back to turn it afterwards, in degrees.
   *
   * One side starts at zero. Two sides build the pair as one sweep and turn it
   * back by the second angle. Symmetric is centred, measured either across the
   * whole sweep or as that much to each side.
   */
  function revolveSpan(feature, scope, plane, ax, ad, perp, a1) {
    if (feature.extent === 'full') return { total: 360, start: 0 };

    if (feature.extent === 'object') {
      const to = revolveToAngle(feature, scope, plane, ax, ad, perp);
      if (to === null) throw new Error('Revolve has nothing to turn up to.');
      const off = safeEval(feature.toOffset, scope, 0);
      return { total: to + off, start: 0 };
    }

    if (feature.direction === 'symmetric') {
      const t = feature.measure === 'half' ? Math.abs(a1) * 2 : Math.abs(a1);
      return { total: t, start: -t / 2 };
    }
    if (feature.direction === 'two') {
      const a2 = Math.abs(safeEval(feature.angle2, scope, 0));
      return { total: Math.abs(a1) + a2, start: -a2 };
    }
    return { total: a1, start: 0 };
  }

  /**
   * The angle about the axis at which the chosen object sits, measured from
   * where the profile starts. Fusion sweeps until the profile meets the object;
   * this measures where the object is and turns that far, which agrees for the
   * planes and faces people actually pick and is predictable when it does not.
   */
  function revolveToAngle(feature, scope, plane, ax, ad, perp) {
    const ref = feature.toObject;
    if (!ref) return null;
    let at = null;
    if (ref.plane) {
      const pl = resolvePlane(ref.plane, scope, builtConstruction);
      at = pl.origin;
    } else if (ref.face) {
      const found = findFace(ref);
      if (found) at = found.face.centre;
    } else if (ref.bodyId) {
      const body = bodies.find((b) => b.id === ref.bodyId);
      if (body) {
        const bb = K.boundingBox(body.solid);
        at = [
          (bb.min[0] + bb.max[0]) / 2,
          (bb.min[1] + bb.max[1]) / 2,
          (bb.min[2] + bb.max[2]) / 2
        ];
      }
    }
    if (!at) return null;

    // Into the frame the revolve turns in: radial across, plane normal up.
    const q = worldToSketch(plane, { x: at[0], y: at[1], z: at[2] });
    const radial = (q.u - ax.x) * perp.x + (q.v - ax.y) * perp.y;
    const outOfPlane = -q.w;
    let deg = (Math.atan2(outOfPlane, radial) * 180) / Math.PI;
    if (deg <= 0.001) deg += 360;
    return deg;
  }

  /**
   * The axis to turn about, as a point and a direction in sketch coordinates.
   * A sketch line, one of the sketch's own axes, a world axis, a construction
   * axis, or a straight model edge; anything from outside the sketch has to lie
   * in its plane, because a profile cannot sweep through its own axis.
   */
  function revolveAxis(feature, doc, scope, plane, contours) {
    const spec = feature.axis || { type: 'y' };
    const sk = doc.sketches[feature.sketch];

    if (spec.type === 'entity') {
      const ent = sk?.entities.find((e) => e.id === spec.entity);
      if (!ent || ent.type !== 'line') throw new Error('Revolve axis is not a line');
      const a = sk.points[ent.p[0]];
      const b = sk.points[ent.p[1]];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { at: { x: a.x, y: a.y }, dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } };
    }
    if (spec.type === 'x') return { at: { x: 0, y: 0 }, dir: { x: 1, y: 0 } };
    if (spec.type === 'y') return { at: { x: 0, y: 0 }, dir: { x: 0, y: 1 } };

    const line = worldAxisFor(spec, scope);
    if (!line) throw new Error('Revolve has no axis to turn about');

    const a = worldToSketch(plane, { x: line.origin[0], y: line.origin[1], z: line.origin[2] });
    const b = worldToSketch(plane, {
      x: line.origin[0] + line.dir[0],
      y: line.origin[1] + line.dir[1],
      z: line.origin[2] + line.dir[2]
    });
    if (Math.abs(a.w) > 1e-4 || Math.abs(b.w - a.w) > 1e-4) {
      throw new Error('The revolve axis has to lie in the same plane as the profile');
    }
    const dx = b.u - a.u;
    const dy = b.v - a.v;
    const len = Math.hypot(dx, dy) || 1;
    return { at: { x: a.u, y: a.v }, dir: { x: dx / len, y: dy / len } };
  }

  /** A world-space line for an axis reference that is not part of the sketch. */
  function worldAxisFor(spec, scope) {
    if (spec.type === 'world') {
      const dirs = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
      const dir = dirs[spec.worldAxis];
      return dir ? { origin: [0, 0, 0], dir } : null;
    }
    if (spec.type === 'construction') {
      const built = builtConstruction?.get(spec.id);
      return built && built.kind === 'axis' ? built : null;
    }
    if (spec.type === 'edge') {
      for (const b of bodies) {
        let topo;
        try {
          topo = buildTopology(meshOf(b));
        } catch {
          continue;
        }
        const [edge] = resolveEdgeRefs(topo, [spec.edge]);
        if (edge && edge.kind === 'line') return { origin: edge.start, dir: edge.dir };
      }
      return null;
    }
    return null;
  }

  function doPrimitive(feature, scope, ks, apply) {
    const p = feature.params || {};
    let solid;
    if (feature.shape === 'box') {
      solid = K.box(
        [
          safeEval(p.width, scope, 20),
          safeEval(p.depth, scope, 20),
          safeEval(p.height, scope, 20)
        ],
        p.centered !== false,
        ks
      );
    } else if (feature.shape === 'cylinder') {
      const r = safeEval(p.diameter, scope, 20) / 2;
      solid = K.cylinder(safeEval(p.height, scope, 20), r, r, 0, p.centered !== false, ks);
    } else if (feature.shape === 'cone') {
      solid = K.cylinder(
        safeEval(p.height, scope, 20),
        safeEval(p.diameter, scope, 20) / 2,
        safeEval(p.topDiameter, scope, 0) / 2,
        0,
        p.centered !== false,
        ks
      );
    } else if (feature.shape === 'torus') {
      // A circle turned about the Z axis. Revolving a section is exactly how
      // the Revolve feature builds one, so the same call does it here.
      const R = safeEval(p.diameter, scope, 40) / 2;
      const r = safeEval(p.tubeDiameter, scope, 10) / 2;
      if (!(R > r && r > 0)) throw new Error('A torus needs a tube smaller than its ring');
      const n = Math.max(16, K.circularSegments(r));
      const section = [];
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        section.push([R + r * Math.cos(t), r * Math.sin(t)]);
      }
      solid = K.revolveContours([section], 360, 0, ks);
    } else if (feature.shape === 'pipe') {
      // A tube: the bore taken out of the outside, both about the same axis.
      const od = safeEval(p.diameter, scope, 20) / 2;
      const wall = safeEval(p.wall, scope, 2);
      const h = safeEval(p.height, scope, 40);
      if (!(wall > 0 && wall < od)) throw new Error('A pipe needs a wall thinner than its radius');
      const centred = p.centered !== false;
      const outside = K.cylinder(h, od, od, 0, centred, ks);
      // The bore runs past both ends so the ends come out open.
      const bore = K.cylinder(h + 2, od - wall, od - wall, 0, centred, ks);
      solid = K.difference(outside, centred ? bore : K.translate(bore, [0, 0, -1], ks), ks);
    } else {
      solid = K.sphere(safeEval(p.diameter, scope, 20) / 2, 0, ks);
    }

    const tx = safeEval(p.x, scope, 0);
    const ty = safeEval(p.y, scope, 0);
    const tz = safeEval(p.z, scope, 0);
    if (tx || ty || tz) solid = K.translate(solid, [tx, ty, tz], ks);
    apply(feature, solid, feature.op || 'new');
  }

  function doHole(feature, doc, scope, ks, apply, errs) {
    const sk = doc.sketches[feature.sketch];
    if (!sk) throw new Error('Hole has no sketch');
    solveSketch(sk, { maxIterations: 40 });
    const plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);

    normalizeHole(feature);
    const dia = safeEval(feature.diameter, scope, 5);
    const through = feature.extent === 'all';
    let depth = through ? 1e5 : safeEval(feature.depth, scope, 10);

    // Up to an object: drill as far as that object sits from the sketch plane.
    if (feature.extent === 'object') {
      const reach = holeReach(feature, scope, plane);
      if (reach === null) {
        throw new Error('The hole has nothing to reach down to.');
      }
      depth = Math.abs(reach) + safeEval(feature.toOffset, scope, 0);
      if (!(depth > 1e-9)) throw new Error('The hole reaches nothing.');
    }
    const tipAngle = safeEval(feature.tipAngle, scope, 0);

    const positions = (feature.points || [])
      .map((idx) => sk.points[idx])
      .filter(Boolean);
    if (!positions.length) throw new Error('Hole has no positions');

    // Everything is built drilling along +Z from the sketch plane, with the
    // entry face at z = 0, then mirrored as one piece if the hole runs the
    // other way. Sketching on a base plane gives no clue which side the metal
    // is on, so the direction is the modeller's to state.
    const parts = [];
    for (const p of positions) {
      const shaft = K.cylinder(depth, dia / 2, dia / 2, 0, false, ks);
      // A through hole must clear the entry face too, so start it below zero.
      const shaftZ = through ? -depth / 2 : 0;
      parts.push(K.translate(shaft, [p.x, p.y, shaftZ], ks));

      if (tipAngle > 0 && !through) {
        // A twist drill leaves a cone at the bottom of a blind hole.
        const tipH = dia / 2 / Math.tan((tipAngle * Math.PI) / 360);
        const tip = K.cylinder(tipH, dia / 2, 0.0001, 0, false, ks);
        parts.push(K.translate(tip, [p.x, p.y, depth], ks));
      }

      if (feature.holeType === 'counterbore') {
        const cbD = safeEval(feature.cbDiameter, scope, dia * 2);
        const cbDepth = safeEval(feature.cbDepth, scope, dia / 2);
        const cb = K.cylinder(cbDepth, cbD / 2, cbD / 2, 0, false, ks);
        parts.push(K.translate(cb, [p.x, p.y, 0], ks));
      } else if (feature.holeType === 'countersink') {
        const csD = safeEval(feature.csDiameter, scope, dia * 2);
        const csAngle = safeEval(feature.csAngle, scope, 90);
        const csDepth = (csD - dia) / 2 / Math.tan((csAngle * Math.PI) / 360);
        // Widest at the face, narrowing to the shaft.
        const cs = K.cylinder(csDepth, csD / 2, dia / 2, 0, false, ks);
        parts.push(K.translate(cs, [p.x, p.y, 0], ks));
      }
    }

    let merged = K.unionAll(parts, ks);
    if (feature.flip) {
      merged = K.transform(merged, new THREE.Matrix4().makeScale(1, 1, -1).elements, ks);
    }
    const world = K.transform(merged, planeMatrix(plane).elements, ks);
    apply(feature, world, feature.op || 'cut');

    // A tapped hole gets the thread cut into the bore it just made. The bore is
    // drilled at the tapping size, so the thread's crests land on the nominal
    // diameter the way a real tap leaves them.
    if (feature.tapped) {
      const pitch = safeEval(feature.pitch, scope, Math.max(0.4, dia * 0.15));
      const clearance = safeEval(feature.clearance, scope, 0.2);
      const threadLen = Math.min(Math.abs(depth), 200);
      const cutters = [];
      for (const p of positions) {
        const tool = internalThreadTool(
          { diameter: dia, pitch, clearance, leftHanded: feature.leftHanded },
          threadLen,
          ks
        );
        if (!tool) continue;
        cutters.push(K.translate(tool, [p.x, p.y, 0], ks));
      }
      if (cutters.length) {
        let threads = K.unionAll(cutters, ks);
        if (feature.flip) {
          threads = K.transform(threads, new THREE.Matrix4().makeScale(1, 1, -1).elements, ks);
        }
        apply(feature, K.transform(threads, planeMatrix(plane).elements, ks), 'cut');
      }
    }
  }

  /**
   * How far below the sketch plane the object a hole is drilled up to sits.
   * Positive means along the plane's normal, which is the way the hole travels
   * before any flip.
   */
  function holeReach(feature, scope, plane) {
    const ref = feature.toObject;
    if (!ref) return null;
    const along = (q) =>
      (q[0] - plane.origin[0]) * plane.n[0] +
      (q[1] - plane.origin[1]) * plane.n[1] +
      (q[2] - plane.origin[2]) * plane.n[2];

    if (ref.plane) return along(resolvePlane(ref.plane, scope, builtConstruction).origin);
    const found = ref.face ? findFace(ref) : null;
    if (found) return along(found.face.centre);
    const body = bodies.find((b) => b.id === ref.bodyId);
    if (!body) return null;
    const bb = K.boundingBox(body.solid);
    const corners = [];
    for (const x of [bb.min[0], bb.max[0]]) {
      for (const y of [bb.min[1], bb.max[1]]) {
        for (const z of [bb.min[2], bb.max[2]]) corners.push(Math.abs(along([x, y, z])));
      }
    }
    return Math.max(...corners);
  }

  /** The cutter for an internal thread of a given nominal size. */
  function internalThreadTool(spec, length, ks) {
    const pitch = spec.pitch;
    const depth = 0.6134 * pitch;
    const outerHalf = 0.4375 * pitch;
    const rootHalf = 0.125 * pitch;
    const clearance = spec.clearance;
    const OVERSHOOT = Math.max(0.02, pitch * 0.02);
    const surface = clearance + OVERSHOOT;
    const root = surface + (depth + clearance + OVERSHOOT);
    const flare = clearance * 0.5;
    const profile = [
      [surface, -(outerHalf + flare)],
      [root, -rootHalf],
      [root, rootHalf],
      [surface, outerHalf + flare]
    ];
    const turns = Math.max(1, Math.ceil(length / pitch));
    return helicalSweep(
      profile,
      {
        radius: spec.diameter / 2,
        pitch,
        turns: turns + 2,
        startZ: -pitch,
        stepsPerTurn: 48,
        handed: spec.leftHanded ? -1 : 1
      },
      ks
    );
  }

  function doMirror(feature, bodies, scope, ks) {
    const plane = resolvePlane(feature.plane || 'XY', scope, builtConstruction);
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;

    const out = bodies.slice();
    for (const b of targets) {
      const o = plane.origin;
      const toOrigin = new THREE.Matrix4().makeTranslation(-o[0], -o[1], -o[2]);
      let s = K.transform(b.solid, toOrigin.elements, ks);
      s = K.mirrorAcross(s, plane.n, ks);
      const back = new THREE.Matrix4().makeTranslation(o[0], o[1], o[2]);
      s = K.transform(s, back.elements, ks);

      if (feature.op === 'join') {
        const merged = K.union(b.solid, s, ks);
        const idx = out.indexOf(b);
        out[idx] = { ...b, solid: merged };
      } else {
        out.push({
          id: `${feature.id}:${out.length}`,
          name: `${b.name} mirrored`,
          solid: s,
          createdBy: feature.id
        });
      }
    }
    return out;
  }

  function doPatternRect(feature, bodies, scope, ks) {
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;

    normalizePattern(feature);
    const c1 = Math.max(1, Math.round(safeEval(feature.count1, scope, 2)));
    const c2 = Math.max(1, Math.round(safeEval(feature.count2, scope, 1)));
    const raw1 = safeEval(feature.spacing1, scope, 20);
    const raw2 = safeEval(feature.spacing2, scope, 20);
    // Spacing is the gap between neighbours; extent is the whole distance the
    // row covers, so the gap falls out of the count.
    const s1 = feature.spacingType === 'extent' ? raw1 / Math.max(1, c1 - 1) : raw1;
    const s2 = feature.spacingType === 'extent' ? raw2 / Math.max(1, c2 - 1) : raw2;
    const d1 = normalizeVec(feature.dir1 || [1, 0, 0]);
    const d2 = normalizeVec(feature.dir2 || [0, 1, 0]);
    // Symmetric spreads the row either side of the original rather than
    // starting from it.
    const o1 = feature.symmetry === 'yes' ? -((c1 - 1) / 2) : 0;
    const o2 = feature.symmetry === 'yes' ? -((c2 - 1) / 2) : 0;
    const skip = new Set(feature.skipInstances || []);

    const out = bodies.slice();
    for (const b of targets) {
      const copies = [];
      for (let i = 0; i < c1; i++) {
        for (let j = 0; j < c2; j++) {
          if (i === 0 && j === 0 && !feature.symmetry) continue;
          if (skip.has(`${i},${j}`)) continue;
          const u = i + o1;
          const v = j + o2;
          if (Math.abs(u) < 1e-9 && Math.abs(v) < 1e-9) continue;
          const dx = d1[0] * s1 * u + d2[0] * s2 * v;
          const dy = d1[1] * s1 * u + d2[1] * s2 * v;
          const dz = d1[2] * s1 * u + d2[2] * s2 * v;
          copies.push(K.translate(b.solid, [dx, dy, dz], ks));
        }
      }
      if (!copies.length) continue;
      if (feature.op === 'separate') {
        for (const c of copies) {
          out.push({
            id: `${feature.id}:${out.length}`,
            name: `${b.name} copy`,
            solid: c,
            createdBy: feature.id
          });
        }
      } else {
        let acc = b.solid;
        for (const c of copies) acc = K.union(acc, c, ks);
        out[out.indexOf(b)] = { ...b, solid: acc };
      }
    }
    return out;
  }

  function doPatternCircular(feature, bodies, scope, ks) {
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;

    normalizePattern(feature);
    const count = Math.max(1, Math.round(safeEval(feature.count, scope, 4)));
    const total = safeEval(feature.angle, scope, 360);
    const axis = normalizeVec(feature.axis || [0, 0, 1]);
    const center = feature.center || [0, 0, 0];
    const full = Math.abs(total - 360) < 1e-6;
    const step = (total / (full ? count : Math.max(1, count - 1))) * (Math.PI / 180);
    // Symmetric turns half the copies each way instead of all one way.
    const spin = feature.symmetry === 'yes' && !full ? -((count - 1) / 2) : 0;
    const skip = new Set(feature.skipInstances || []);

    const out = bodies.slice();
    for (const b of targets) {
      const copies = [];
      for (let i = spin ? 0 : 1; i < count; i++) {
        if (skip.has(String(i))) continue;
        if (Math.abs(i + spin) < 1e-9) continue;
        const m = new THREE.Matrix4();
        m.makeTranslation(center[0], center[1], center[2]);
        m.multiply(
          new THREE.Matrix4().makeRotationAxis(
            new THREE.Vector3(axis[0], axis[1], axis[2]),
            step * (i + spin)
          )
        );
        m.multiply(new THREE.Matrix4().makeTranslation(-center[0], -center[1], -center[2]));
        copies.push(K.transform(b.solid, m.elements, ks));
      }
      if (!copies.length) continue;
      if (feature.op === 'separate') {
        for (const c of copies) {
          out.push({
            id: `${feature.id}:${out.length}`,
            name: `${b.name} copy`,
            solid: c,
            createdBy: feature.id
          });
        }
      } else {
        let acc = b.solid;
        for (const c of copies) acc = K.union(acc, c, ks);
        out[out.indexOf(b)] = { ...b, solid: acc };
      }
    }
    return out;
  }

  /** Copies spaced along a sketch path, optionally turning to follow it. */
  function doPatternPath(feature, doc, bodies, scope, ks, errs) {
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;

    const pathSketch = doc.sketches[feature.path && feature.path.sketch];
    if (!pathSketch) throw new Error('Path pattern has no path');
    solveSketch(pathSketch, { maxIterations: 40 });
    const plane =
      sketchPlanes[pathSketch.id] ||
      resolvePlane(pathSketch.plane, scope, builtConstruction);
    const chain = chainPath(pathSketch, { entities: feature.path.entities });
    if (!chain) throw new Error('The pattern path is not a connected chain');

    const world = chain.points.map((p) => {
      const v = sketchToWorld(plane, p.x, p.y, p.z || 0);
      return [v.x, v.y, v.z];
    });

    // Walk the path by arc length, so copies are evenly spaced along the curve
    // rather than evenly spaced through the polyline's own points.
    const cum = [0];
    for (let i = 1; i < world.length; i++) {
      cum.push(
        cum[i - 1] +
          Math.hypot(
            world[i][0] - world[i - 1][0],
            world[i][1] - world[i - 1][1],
            world[i][2] - world[i - 1][2]
          )
      );
    }
    const total = cum[cum.length - 1];
    if (total < 1e-6) return bodies;

    const count = Math.max(1, Math.round(safeEval(feature.count, scope, 4)));
    const spacing = feature.spacing ? safeEval(feature.spacing, scope, 0) : 0;
    const span = spacing > 0 ? Math.min(spacing * (count - 1), total) : total;

    const sampleAt = (d) => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const t = (d - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
      const a = world[i - 1];
      const b = world[i];
      return {
        p: [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t
        ],
        dir: [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      };
    };

    const start = sampleAt(0);
    const out = bodies.slice();
    for (const b of targets) {
      const copies = [];
      for (let i = 1; i < count; i++) {
        const d = (span * i) / Math.max(1, count - 1);
        const here = sampleAt(d);
        let m = new THREE.Matrix4().makeTranslation(
          here.p[0] - start.p[0],
          here.p[1] - start.p[1],
          here.p[2] - start.p[2]
        );
        if (feature.follow) {
          // Turn each copy by however much the path has turned.
          const a = new THREE.Vector3(start.dir[0], start.dir[1], start.dir[2]).normalize();
          const c = new THREE.Vector3(here.dir[0], here.dir[1], here.dir[2]).normalize();
          const q = new THREE.Quaternion().setFromUnitVectors(a, c);
          m = new THREE.Matrix4()
            .makeTranslation(here.p[0], here.p[1], here.p[2])
            .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
            .multiply(
              new THREE.Matrix4().makeTranslation(-start.p[0], -start.p[1], -start.p[2])
            );
        }
        copies.push(K.transform(b.solid, m.elements, ks));
      }
      if (!copies.length) continue;
      if (feature.op === 'separate') {
        for (const c of copies) {
          out.push({
            id: feature.id + ':' + out.length,
            name: b.name + ' copy',
            solid: c,
            createdBy: feature.id
          });
        }
      } else {
        let acc = b.solid;
        for (const c of copies) acc = K.union(acc, c, ks);
        out[out.indexOf(b)] = Object.assign({}, b, { solid: acc });
      }
    }
    return out;
  }

  /**
   * Repeat a feature rather than a body.
   *
   * A body pattern copies the finished lump; a feature pattern replays what the
   * feature did. For a cut that is the difference between four holes and four
   * copies of a plate that already had one.
   */
  function doPatternFeature(feature, bodies, scope, ks, errs) {
    const sources = (feature.features || [])
      .map((id) => toolOf.get(id))
      .filter(Boolean);
    if (!sources.length) {
      errs.push({
        feature: feature.id,
        message:
          'Nothing to repeat: those features do not produce a tool that can be patterned'
      });
      return bodies;
    }

    const transforms = patternTransforms(feature, scope);
    if (!transforms.length) return bodies;

    let current = bodies;
    for (const rec of sources) {
      for (const m of transforms) {
        const moved = K.transform(rec.tool, m.elements, ks);
        current = applyToolTo(current, moved, rec.op, feature, ks);
      }
    }
    return current;
  }

  /** Apply a tool to a list of bodies outside the main dispatch. */
  function applyToolTo(list, tool, opName, feature, ks) {
    if (!tool || K.isEmpty(tool)) return list;
    if (opName === 'new' || opName === 'join') {
      if (!list.length) {
        return [
          {
            id: feature.id + ':0',
            name: 'Body 1',
            solid: tool,
            createdBy: feature.id
          }
        ];
      }
      const out = list.slice();
      out[0] = Object.assign({}, out[0], {
        solid: K.union(out[0].solid, tool, ks)
      });
      return out;
    }
    if (opName === 'cut') {
      return list
        .map((b) => Object.assign({}, b, { solid: K.difference(b.solid, tool, ks) }))
        .filter((b) => !K.isEmpty(b.solid));
    }
    if (opName === 'intersect') {
      return list
        .map((b) => Object.assign({}, b, { solid: K.intersection(b.solid, tool, ks) }))
        .filter((b) => !K.isEmpty(b.solid));
    }
    return list;
  }

  /** The transforms a pattern asks for, not counting the original. */
  function patternTransforms(feature, scope) {
    const out = [];
    if (feature.pattern === 'circular') {
      const count = Math.max(1, Math.round(safeEval(feature.count, scope, 4)));
      const total = safeEval(feature.angle, scope, 360);
      const axis = normalizeVec(feature.axis || [0, 0, 1]);
      const centre = feature.center || [0, 0, 0];
      const full = Math.abs(total - 360) < 1e-6;
      const step = (total / (full ? count : Math.max(1, count - 1))) * (Math.PI / 180);
      for (let i = 1; i < count; i++) {
        const m = new THREE.Matrix4();
        m.makeTranslation(centre[0], centre[1], centre[2]);
        m.multiply(
          new THREE.Matrix4().makeRotationAxis(
            new THREE.Vector3(axis[0], axis[1], axis[2]),
            step * i
          )
        );
        m.multiply(
          new THREE.Matrix4().makeTranslation(-centre[0], -centre[1], -centre[2])
        );
        out.push(m);
      }
      return out;
    }

    const c1 = Math.max(1, Math.round(safeEval(feature.count1, scope, 2)));
    const c2 = Math.max(1, Math.round(safeEval(feature.count2, scope, 1)));
    const s1 = safeEval(feature.spacing1, scope, 20);
    const s2 = safeEval(feature.spacing2, scope, 20);
    const d1 = normalizeVec(feature.dir1 || [1, 0, 0]);
    const d2 = normalizeVec(feature.dir2 || [0, 1, 0]);
    for (let i = 0; i < c1; i++) {
      for (let j = 0; j < c2; j++) {
        if (i === 0 && j === 0) continue;
        out.push(
          new THREE.Matrix4().makeTranslation(
            d1[0] * s1 * i + d2[0] * s2 * j,
            d1[1] * s1 * i + d2[1] * s2 * j,
            d1[2] * s1 * i + d2[2] * s2 * j
          )
        );
      }
    }
    return out;
  }

  function doMove(feature, bodies, scope, ks) {
    normalizeMove(feature);
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;
    const m = moveMatrix(feature, scope, targets);

    const out = bodies.slice();
    for (const b of targets) {
      out[out.indexOf(b)] = { ...b, solid: K.transform(b.solid, m.elements, ks) };
    }
    return out;
  }

  /**
   * The transform a move applies.
   *
   * Translate takes three distances; rotate turns about a stated axis through a
   * stated point rather than about the world origin; point to point measures
   * the shift from one place to another, which is how a part is dropped onto a
   * face without working out the numbers.
   */
  function moveMatrix(feature, scope, targets) {
    const m = new THREE.Matrix4();

    if (feature.moveType === 'rotate') {
      const axis = normalizeVec(feature.rotAxis || [0, 0, 1]);
      const at = feature.pivot || centreOfBodies(targets);
      const deg = safeEval(feature.rotAngle, scope, 0);
      m.makeTranslation(at[0], at[1], at[2]);
      m.multiply(
        new THREE.Matrix4().makeRotationAxis(
          new THREE.Vector3(axis[0], axis[1], axis[2]),
          (deg * Math.PI) / 180
        )
      );
      m.multiply(new THREE.Matrix4().makeTranslation(-at[0], -at[1], -at[2]));
      return m;
    }

    if (feature.moveType === 'points') {
      const a = feature.fromPoint || [0, 0, 0];
      const b = feature.toPoint || [0, 0, 0];
      return m.makeTranslation(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }

    const pos = new THREE.Vector3(
      safeEval(feature.dx, scope, 0),
      safeEval(feature.dy, scope, 0),
      safeEval(feature.dz, scope, 0)
    );
    const euler = new THREE.Euler(
      (safeEval(feature.rx, scope, 0) * Math.PI) / 180,
      (safeEval(feature.ry, scope, 0) * Math.PI) / 180,
      (safeEval(feature.rz, scope, 0) * Math.PI) / 180
    );
    m.makeRotationFromEuler(euler);
    m.setPosition(pos);
    return m;
  }

  /** The middle of a set of bodies, by their bounding boxes. */
  function centreOfBodies(list) {
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (const b of list) {
      const bb = K.boundingBox(b.solid);
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], bb.min[i]);
        hi[i] = Math.max(hi[i], bb.max[i]);
      }
    }
    if (!Number.isFinite(lo[0])) return [0, 0, 0];
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  }

  function doScale(feature, bodies, scope, ks) {
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;
    const uniform = safeEval(feature.factor, scope, 1);
    const sx = feature.nonUniform ? safeEval(feature.sx, scope, 1) : uniform;
    const sy = feature.nonUniform ? safeEval(feature.sy, scope, 1) : uniform;
    const sz = feature.nonUniform ? safeEval(feature.sz, scope, 1) : uniform;

    // Scaling about a point rather than the world origin, so a part that is
    // not centred does not fly off as it grows.
    const at =
      feature.pivotMode === 'origin' ? [0, 0, 0] : feature.pivot || centreOfBodies(targets);
    const m = new THREE.Matrix4().makeTranslation(at[0], at[1], at[2]);
    m.multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
    m.multiply(new THREE.Matrix4().makeTranslation(-at[0], -at[1], -at[2]));

    const out = bodies.slice();
    for (const b of targets) {
      out[out.indexOf(b)] = { ...b, solid: K.transform(b.solid, m.elements, ks) };
    }
    return out;
  }

  function doEdgeBlend(feature, bodies, scope, ks, errs) {
    normalizeBlend(feature);
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;
    const kind = feature.type === 'chamfer' ? 'chamfer' : 'fillet';

    const out = bodies.slice();
    for (const b of targets) {
      let solid = b.solid;
      let anything = false;
      let skipped = 0;

      // Each set is cut in turn, against the body as it stands after the last,
      // so several radii on one part are one feature rather than three.
      for (const set of feature.sets) {
        const topo = buildTopology(K.meshData(solid));
        const edges = set.edges?.length
          ? resolveEdgeRefs(topo, set.edges)
          : topo.edges.filter((e) => e.convex);
        if (!edges.length) continue;

        const type = kind === 'fillet' ? set.filletType || 'constant' : 'constant';
        let size = 0;
        let sizeFor;

        if (type === 'chord') {
          // The chord is what the fillet measures across, so the radius falls
          // out of the angle each edge happens to sit at. Two edges at
          // different angles take different radii and the same width of blend,
          // which is the whole point of asking for a chord.
          const chord = Math.abs(safeEval(set.chord, scope, 2));
          if (!(chord > 0)) continue;
          size = chord;
          sizeFor = (e) => radiusForChord(e, chord);
        } else if (type === 'hold') {
          // A hold line pins where the blend has to run out. The radius is
          // whatever puts the tangent point on that line.
          const holds = resolveEdgeRefs(topo, set.holdEdges || []);
          if (!holds.length) {
            errs.push({
              feature: feature.id,
              message: 'Pick the edge the fillet should be held to'
            });
            continue;
          }
          size = 1;
          sizeFor = (e) => radiusForHoldLine(e, holds);
        } else {
          size = safeEval(set.radius, scope, 2);
          if (!(size > 0)) continue;
        }

        const endSize =
          type === 'variable' && set.endRadius ? safeEval(set.endRadius, scope, size) : undefined;
        const tools = buildEdgeTools(topo, edges, size, kind, ks, {
          endSize,
          sizeFor,
          size2: chamferSecondDistance(kind, set, size, scope)
        });
        if (!tools.applied) continue;

        if (tools.cut) solid = K.difference(solid, tools.cut, ks);
        if (tools.addBack) solid = K.union(solid, tools.addBack, ks);
        if (tools.blends) solid = K.union(solid, tools.blends, ks);
        anything = true;
        skipped += tools.skipped.length;
      }

      if (!anything) {
        errs.push({
          feature: feature.id,
          message: `No edge could take that ${kind}`
        });
        continue;
      }
      out[out.indexOf(b)] = { ...b, solid };

      if (skipped) {
        errs.push({
          feature: feature.id,
          message: `${skipped} edge${skipped === 1 ? '' : 's'} could not be blended and were left sharp`
        });
      }
    }
    return out;
  }

  /**
   * Half the angle the two faces turn through at an edge, in radians.
   *
   * `dihedral` is the angle between the outward normals, so a square corner
   * reads 90 and a flat one reads 0. Both rules below are written in terms of
   * that half angle, so it is worked out once.
   */
  function halfTurn(edge) {
    const d = Number(edge.dihedral);
    if (!Number.isFinite(d) || d <= 1e-6 || d >= 180) return 0;
    return (d * Math.PI) / 360;
  }

  /**
   * The radius that gives a fillet a chord of the width asked for.
   *
   * The two tangent points sit R/tan(t) from the edge along each face, where t
   * is half the interior angle, and the straight line between them is
   * 2R*cos(t). Written against the dihedral that is 2R*sin(half), so
   * R = chord / (2 sin(half)).
   */
  function radiusForChord(edge, chord) {
    const half = halfTurn(edge);
    const s = Math.sin(half);
    return s > 1e-6 ? chord / (2 * s) : 0;
  }

  /**
   * The radius that runs a fillet out exactly on a held edge.
   *
   * The tangent point lies R/tan(t) from the edge across the face, so holding
   * it a distance d away asks for R = d*tan(t), which against the dihedral is
   * d / tan(half). An edge that shares a face with the hold line is measured
   * against that one; otherwise the nearest hold line wins, because a hold line
   * on neither face is a mistake rather than a rule.
   */
  function radiusForHoldLine(edge, holds) {
    const half = halfTurn(edge);
    const t = Math.tan(half);
    if (!(t > 1e-6)) return 0;

    const onSameFace = holds.filter(
      (h) => h.faceA === edge.faceA || h.faceB === edge.faceA ||
             h.faceA === edge.faceB || h.faceB === edge.faceB
    );
    const use = onSameFace.length ? onSameFace : holds;

    let best = Infinity;
    for (const h of use) {
      const d = distanceToEdgeLine(edge, h);
      if (d > 1e-6 && d < best) best = d;
    }
    return Number.isFinite(best) ? best / t : 0;
  }

  /** How far a second edge sits, on average, off the line of the first. */
  function distanceToEdgeLine(edge, other) {
    const a = edge.points[0];
    const b = edge.points[edge.points.length - 1];
    let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-9)) return 0;
    dx /= len; dy /= len; dz /= len;

    let total = 0;
    for (const p of other.points) {
      const wx = p[0] - a[0], wy = p[1] - a[1], wz = p[2] - a[2];
      const along = wx * dx + wy * dy + wz * dz;
      total += Math.hypot(wx - along * dx, wy - along * dy, wz - along * dz);
    }
    return other.points.length ? total / other.points.length : 0;
  }

  /**
   * How far a chamfer cuts into the second face. Equal is the same both ways;
   * two distances says so outright; an angle is measured from the first face,
   * which is exact where the two faces meet square.
   */
  function chamferSecondDistance(kind, set, size, scope) {
    if (kind !== 'chamfer') return undefined;
    if (set.chamferType === 'two') return Math.abs(safeEval(set.distance2, scope, size));
    if (set.chamferType === 'angle') {
      const deg = safeEval(set.angle, scope, 45);
      const t = Math.tan((deg * Math.PI) / 180);
      return Number.isFinite(t) && t > 1e-6 ? size * t : size;
    }
    return undefined;
  }

  /**
   * Push or pull selected faces along their own normals.
   */
  function doOffsetFace(feature, bodies, scope, ks, errs) {
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;
    const distance = safeEval(feature.distance, scope, 0);
    if (Math.abs(distance) < 1e-9) return bodies;

    const out = bodies.slice();
    for (const b of targets) {
      const mesh = K.meshData(b.solid);
      const topo = buildTopology(mesh);
      const faces = resolveFaceRefs(topo, feature.faces);
      if (!faces.length) {
        errs.push({
          feature: feature.id,
          message: 'The face this was applied to is no longer on the model'
        });
        continue;
      }

      let solid = b.solid;
      for (const face of faces) {
        const prism = buildFacePrism(mesh, face, distance, ks);
        if (!prism || K.isEmpty(prism)) continue;
        solid = distance > 0
          ? K.union(solid, prism, ks)
          : K.difference(solid, prism, ks);
      }
      out[out.indexOf(b)] = { ...b, solid };
    }
    return out;
  }

  function doShell(feature, bodies, scope, ks, errs) {
    normalizeShell(feature);
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;
    const thickness = safeEval(feature.thickness, scope, 2);
    if (thickness <= 0) return bodies;
    // Inside keeps the outer surface where it is and eats inwards. Outside
    // keeps the inner surface and grows out. Both straddles the original.
    const side = feature.side || 'inside';
    const grow = side === 'outside' ? thickness : side === 'both' ? thickness / 2 : 0;
    const eat = side === 'outside' ? 0 : side === 'both' ? thickness / 2 : thickness;

    const out = bodies.slice();
    for (const b of targets) {
      // Eroding with a ball is what gives a wall of even thickness everywhere,
      // including around curves. It is also the expensive part, so bodies past
      // a sensible size are refused rather than left to hang the app.
      const props = K.properties(b.solid);
      if (props.numTri > 4000) {
        errs.push({
          feature: feature.id,
          message: `Shell skipped: this body has ${props.numTri} triangles, past what the hollowing step can do quickly. Shell earlier in the timeline.`
        });
        continue;
      }

      // The outer surface: the body itself, or the body grown outwards.
      let outer = b.solid;
      if (grow > 1e-9) {
        const out = K.sphere(grow, feature.quality || 16, ks);
        outer = ks.track(b.solid.minkowskiSum(out));
      }

      // The inner surface: the body eaten inwards, or the body itself.
      let cavityBase = b.solid;
      if (eat > 1e-9) {
        const ball = K.sphere(eat, feature.quality || 16, ks);
        cavityBase = ks.track(b.solid.minkowskiDifference(ball));
      }
      if (K.isEmpty(cavityBase)) {
        errs.push({
          feature: feature.id,
          message: `Shell skipped: ${thickness} mm is thicker than the body`
        });
        continue;
      }

      let cavity = cavityBase;

      // Opening a face means also taking away the wall that covers it.
      if (feature.openFaces?.length) {
        const topo = buildTopology(meshOf(b));
        const faces = resolveFaceRefs(topo, feature.openFaces);
        const bb = K.boundingBox(b.solid);
        const span =
          Math.hypot(
            bb.max[0] - bb.min[0],
            bb.max[1] - bb.min[1],
            bb.max[2] - bb.min[2]
          ) + 10;

        for (const face of faces) {
          if (!face.planar) continue;
          // A slab lying just inside the face, thick enough to remove the wall.
          const slab = K.box([span, span, thickness * 2], true, ks);
          const basis = basisFor(face.normal);
          const m = new THREE.Matrix4();
          const o = [
            face.centre[0] - face.normal[0] * (thickness - 0.001),
            face.centre[1] - face.normal[1] * (thickness - 0.001),
            face.centre[2] - face.normal[2] * (thickness - 0.001)
          ];
          m.set(
            basis.x[0], basis.y[0], basis.n[0], o[0],
            basis.x[1], basis.y[1], basis.n[1], o[1],
            basis.x[2], basis.y[2], basis.n[2], o[2],
            0, 0, 0, 1
          );
          const placed = K.transform(slab, m.elements, ks);
          const clipped = K.intersection(placed, outer, ks);
          cavity = K.union(cavity, clipped, ks);
        }
      }

      // The wall is what lies between the outer surface and the cavity.
      const shelled = K.difference(outer, cavity, ks);
      if (K.isEmpty(shelled)) {
        errs.push({ feature: feature.id, message: 'Shell produced nothing' });
        continue;
      }
      out[out.indexOf(b)] = { ...b, solid: shelled };
    }
    return out;
  }

  function doCombine(feature, bodies, ks) {
    const target = bodies.find((b) => b.id === feature.target);
    const tools = bodies.filter((b) => (feature.tools || []).includes(b.id));
    if (!target || !tools.length) return bodies;

    let acc = target.solid;
    for (const t of tools) {
      if (feature.op === 'cut') acc = K.difference(acc, t.solid, ks);
      else if (feature.op === 'intersect') acc = K.intersection(acc, t.solid, ks);
      else acc = K.union(acc, t.solid, ks);
    }

    const out = [];
    for (const b of bodies) {
      if (b === target) {
        // A result in its own component keeps a later feature in another one
        // from reaching into it.
        const kept = { ...b, solid: acc };
        if (feature.newComponent) kept.component = `${feature.id}:c`;
        out.push(kept);
      } else if (tools.includes(b) && !feature.keepTools) continue;
      else out.push(b);
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Coil                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * A section swept along a helix. A spring, a worm, a flat spiral.
   *
   * The section is written in the sweep's own (radial, axial) frame, the same
   * one a thread's groove uses, so the two share `helicalSweep` and its
   * handedness fix rather than each carrying a copy.
   */
  function doCoil(feature, scope, ks, apply, errs) {
    const plane = resolvePlane(feature.plane || 'XY', scope, builtConstruction);
    const diameter = safeEval(feature.diameter, scope, 20);
    const sectionSize = safeEval(feature.sectionSize, scope, 3);
    const angle = safeEval(feature.angle, scope, 0);
    const spiral = feature.coilType === 'spiral';

    if (diameter <= 0 || sectionSize <= 0) {
      throw new Error('A coil needs a diameter and a section size');
    }

    // Fusion asks for two of revolutions, height and pitch, and works out the
    // third. Which two depends on the type, and a spiral has no height at all.
    let turns = safeEval(feature.revolutions, scope, 4);
    let pitch = safeEval(feature.pitch, scope, 5);
    const height = safeEval(feature.height, scope, 20);
    if (!spiral) {
      if (feature.coilType === 'revHeight') {
        if (turns <= 0) throw new Error('A coil needs at least one revolution');
        pitch = height / turns;
      } else if (feature.coilType === 'heightPitch') {
        if (pitch <= 0) throw new Error('A coil needs a pitch above zero');
        turns = height / pitch;
      }
    }
    if (turns <= 0) throw new Error('A coil needs at least part of a revolution');
    if (!spiral && pitch <= 0) throw new Error('A coil needs a pitch above zero');

    const r = sectionSize / 2;
    const half =
      feature.section === 'square' ? r * Math.SQRT1_2 : r;
    // Fusion measures the section across a circle it is inscribed in, so a
    // square of "size 4" is 2.83 across the flats, not 4.
    const offset =
      feature.sectionPosition === 'inside'
        ? -half
        : feature.sectionPosition === 'outside'
          ? half
          : 0;

    const profile = coilSection(feature.section || 'circular', r, offset);
    const tool = helicalSweep(
      profile,
      {
        radius: diameter / 2,
        pitch: spiral ? pitch : pitch,
        turns,
        spiral,
        taperDeg: spiral ? 0 : angle,
        stepsPerTurn: Math.max(24, K.circularSegments(diameter / 2)),
        handed: feature.rotation === 'cw' ? -1 : 1
      },
      ks
    );
    if (!tool) throw new Error('Coil could not be built');

    apply(feature, K.transform(tool, planeMatrix(plane).elements, ks), feature.op || 'new');
  }

  /* ---------------------------------------------------------------- */
  /* Emboss                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * A sketch raised out of a face, or sunk into it.
   *
   * A planar face is an extrusion from that face's own plane. A cylindrical one
   * is the same extrusion bent afterwards: the flat solid is built first, its
   * contours pre-subdivided along the direction that is about to become an arc,
   * then every vertex is mapped into the cylinder's frame. Bending a finished
   * solid rather than stitching a curved one keeps the hole handling, which is
   * what makes text with counters in it work at all.
   */
  function doEmboss(feature, doc, bodies, scope, ks, regionsById, errs) {
    const sk = doc.sketches[feature.sketch];
    if (!sk) throw new Error('Emboss has no sketch');
    const plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);
    const regions = regionsById[sk.id] || [];
    const chosen =
      feature.seeds === null || feature.seeds === undefined
        ? regions
        : regionsForSeeds(regions, feature.seeds);
    if (!chosen.length) throw new Error('Emboss has no profile');

    const depth = safeEval(feature.depth, scope, 1);
    if (depth <= 0) throw new Error('Emboss depth is zero');

    const refs = feature.faces || [];
    if (!refs.length) throw new Error('Emboss has no face to work on');

    const dx = safeEval(feature.alignX, scope, 0);
    const dy = safeEval(feature.alignY, scope, 0);
    const rot = (safeEval(feature.alignAngle, scope, 0) * Math.PI) / 180;
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const place = (q) => ({
      x: q.x * cs - q.y * sn + dx,
      y: q.x * sn + q.y * cs + dy
    });

    const contours = [];
    for (const region of chosen) {
      for (const loop of regionToPolygons(region)) {
        contours.push(loop.map(([x, y]) => place({ x, y })).map((q) => [q.x, q.y]));
      }
    }

    const deboss = feature.effect === 'deboss';
    const out = bodies.slice();

    for (const ref of refs) {
      const found = findFace(ref);
      if (!found) {
        errs.push({ feature: feature.id, message: 'Emboss lost the face it was on' });
        continue;
      }
      const idx = out.findIndex((b) => b.id === found.body.id);
      if (idx < 0) continue;
      const face = found.face;

      let tool = null;
      if (face.planar) {
        tool = embossPrismOnPlane(contours, face, plane, depth, deboss, feature, errs, ks);
      } else if (face.cylinder) {
        tool = embossPrismOnCylinder(contours, face, depth, deboss, feature, ks);
      } else {
        errs.push({
          feature: feature.id,
          message: 'Emboss works on a flat or a cylindrical face'
        });
        continue;
      }
      if (!tool) continue;

      const b = out[idx];
      out[idx] = {
        ...b,
        solid: deboss ? K.difference(b.solid, tool, ks) : K.union(b.solid, tool, ks)
      };
    }
    return out;
  }

  /**
   * The emboss tool for a flat face.
   *
   * The profile keeps the sketch's own axes and its own position, and only
   * slides along the normal until it sits on the face. Rebuilding the frame
   * from the face instead puts the shape at the face's centre in whatever
   * basis happened to be derived from its normal, which lands the drawing
   * somewhere nobody asked for and half off the part.
   */
  function embossPrismOnPlane(contours, face, sketchPlane, depth, deboss, feature, errs, ks) {
    const n = face.normal;
    const along = sketchPlane.n[0] * n[0] + sketchPlane.n[1] * n[1] + sketchPlane.n[2] * n[2];
    if (Math.abs(along) < 0.999) {
      errs.push({
        feature: feature.id,
        message: 'Emboss needs the sketch parallel to the face it goes on'
      });
      return null;
    }

    // How far the sketch plane is from the face's, measured along the normal.
    const gap =
      (face.centre[0] - sketchPlane.origin[0]) * n[0] +
      (face.centre[1] - sketchPlane.origin[1]) * n[1] +
      (face.centre[2] - sketchPlane.origin[2]) * n[2];

    const onFace = {
      origin: [
        sketchPlane.origin[0] + n[0] * gap,
        sketchPlane.origin[1] + n[1] * gap,
        sketchPlane.origin[2] + n[2] * gap
      ],
      x: sketchPlane.x,
      y: sketchPlane.y,
      n: along > 0 ? sketchPlane.n : [-sketchPlane.n[0], -sketchPlane.n[1], -sketchPlane.n[2]]
    };

    // A deboss bites in and an emboss stands out, and either way the tool has
    // to break the surface rather than land exactly on it, or the boolean has
    // a tangency to resolve and leaves slivers.
    const bite = Math.max(0.01, depth * 0.02);
    const solid = K.extrudeContours(
      contours,
      { height: depth + bite, center: false },
      ks
    );
    const flip = deboss !== !!feature.flipNormal;
    const m = planeMatrix(onFace).clone();
    if (flip) m.multiply(new THREE.Matrix4().makeScale(1, 1, -1));
    else m.multiply(new THREE.Matrix4().makeTranslation(0, 0, -bite));
    return K.transform(solid, m.elements, ks);
  }

  /**
   * The emboss tool for a cylindrical face.
   *
   * Built flat and then bent. The sketch's X becomes arc length round the
   * cylinder, so it has to be resampled first: a straight run of the outline
   * that spans thirty degrees would otherwise bend into a chord and leave the
   * letter sitting under the surface in the middle.
   */
  function embossPrismOnCylinder(contours, face, depth, deboss, feature, ks) {
    const cyl = face.cylinder;
    const radius = cyl.radius;
    if (!(radius > 0)) return null;

    // No more than a facet's worth of arc between points.
    const maxArc = (radius * 2 * Math.PI) / Math.max(24, K.circularSegments(radius));
    const dense = contours.map((loop) => resampleAlongX(loop, maxArc));

    const bite = Math.max(0.01, depth * 0.02);
    const flat = K.extrudeContours(dense, { height: depth + bite, center: false }, ks);
    const mesh = K.meshData(flat);

    // The cylinder's own frame: its axis, and a pair of axes across it.
    const axis = normalizeVec(cyl.dir);
    const b = basisFor(axis);
    const o = cyl.origin;
    const inward = deboss !== !!feature.flipNormal;

    const verts = new Float32Array(mesh.vertProperties.length);
    for (let i = 0; i < mesh.vertProperties.length; i += 3) {
      const x = mesh.vertProperties[i];
      const y = mesh.vertProperties[i + 1];
      const z = mesh.vertProperties[i + 2];
      const theta = x / radius;
      // z runs out of the sketch plane and becomes depth through the wall.
      const r = inward ? radius + bite - z : radius - bite + z;
      const cx = Math.cos(theta) * r;
      const cy = Math.sin(theta) * r;
      verts[i] = o[0] + b.x[0] * cx + b.y[0] * cy + axis[0] * y;
      verts[i + 1] = o[1] + b.x[1] * cx + b.y[1] * cy + axis[1] * y;
      verts[i + 2] = o[2] + b.x[2] * cx + b.y[2] * cy + axis[2] * y;
    }
    return K.ofMesh(verts, mesh.triVerts, ks);
  }

  /* ---------------------------------------------------------------- */
  /* Web                                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Open sketch curves thickened into internal walls.
   *
   * A rib is one wall from one curve; a web is the same thing for a whole set
   * of intersecting curves, which is how a moulded part is stiffened. The walls
   * are unioned before they touch the part, so where two of them cross there is
   * one piece of material rather than a seam.
   */
  function doWeb(feature, doc, bodies, scope, ks, apply, errs) {
    const sk = doc.sketches[feature.sketch];
    if (!sk) throw new Error('Web has no sketch');
    solveSketch(sk, { maxIterations: 40 });
    const plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);

    const thickness = safeEval(feature.thickness, scope, 2);
    if (thickness <= 0) throw new Error('Web thickness is zero');

    const targets = pickBodies(feature, bodies);
    const span = targets.length ? bodySpan(targets) : 100;
    const toNext = (feature.extentType || 'toNext') === 'toNext';
    const depth = toNext ? span : safeEval(feature.depth, scope, 10);
    if (depth <= 0) throw new Error('Web depth is zero');

    const chains = openChains(sk);
    if (!chains.length) throw new Error('Web needs open sketch curves');

    const draft = safeEval(feature.draftAngle, scope, 0);
    // A drafted wall is thinner at the far end, which is what lets it come out
    // of a mould. Expressed as the scale of the top relative to the bottom.
    const topScale =
      draft !== 0
        ? Math.max(
            0.02,
            (thickness - 2 * depth * Math.tan((draft * Math.PI) / 180)) / thickness
          )
        : 1;

    let walls = null;
    for (const chain of chains) {
      const points = feature.extendCurves ? extendChain(chain, span) : chain.points;
      const contours = thickenPolyline(points, thickness / 2, chain.closed);
      if (!contours) continue;
      let wall = K.extrudeContours(
        contours,
        { height: depth, center: false, scaleTop: [topScale, topScale] },
        ks
      );
      if (feature.flip) {
        wall = K.transform(wall, new THREE.Matrix4().makeScale(1, 1, -1).elements, ks);
      }
      const placed = K.transform(wall, planeMatrix(plane).elements, ks);
      walls = walls ? K.union(walls, placed, ks) : placed;
    }
    if (!walls) throw new Error('Web produced nothing');

    // Symmetric splits the thickness either side of the curve. The thickener
    // already centres it, so "one direction" is the case that has to shift.
    apply(feature, walls, feature.op || 'join');
  }

  /** Every open run of curves in a sketch, as its own chain. */
  function openChains(sk) {
    const chains = [];
    let pool = sk.entities
      .filter((e) => (e.type === 'line' || e.type === 'arc') && !e.construction)
      .map((e) => e.id);
    let guard = 0;
    while (pool.length && guard++ < 64) {
      const chain = chainPath(sk, { entities: pool });
      if (!chain) break;
      chains.push(chain);
      const used = new Set();
      for (const id of pool) {
        const ent = sk.entities.find((e) => e.id === id);
        if (!ent) continue;
        const pts = tessellate(sk, ent);
        const onChain = pts.every((p) =>
          chain.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6)
        );
        if (onChain) used.add(id);
      }
      if (!used.size) break;
      pool = pool.filter((id) => !used.has(id));
    }
    return chains;
  }

  /**
   * Run both ends of an open chain on along their own direction.
   *
   * Fusion's Extend Curves option, and the reason it exists: a web drawn to the
   * inside of a shell stops a hair short of the wall and leaves a gap that no
   * slicer will bridge.
   */
  function extendChain(chain, by) {
    const pts = chain.points;
    if (chain.closed || pts.length < 2) return pts;
    const out = pts.slice();
    const lead = (a, b) => {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const l = Math.hypot(dx, dy) || 1;
      return { x: a.x + (dx / l) * by, y: a.y + (dy / l) * by };
    };
    out.unshift(lead(pts[0], pts[1]));
    out.push(lead(pts[pts.length - 1], pts[pts.length - 2]));
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Align                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Put one face of a body flat against another face.
   *
   * Unlike a joint this records no relationship: it works out the transform
   * once and applies it, which is what Fusion's Align does and why it lives in
   * Modify rather than in Assemble.
   */
  function doAlign(feature, bodies, scope, ks, errs) {
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;

    const from = alignFrame(feature.from);
    const to = alignFrame(feature.to);
    if (!from || !to) {
      errs.push({ feature: feature.id, message: 'Align needs a face to move and a face to meet' });
      return bodies;
    }

    // The two faces meet, so the moving face ends up looking the opposite way
    // from the one it lands on.
    const want = feature.flip
      ? new THREE.Vector3(to.n[0], to.n[1], to.n[2])
      : new THREE.Vector3(-to.n[0], -to.n[1], -to.n[2]);
    const have = new THREE.Vector3(from.n[0], from.n[1], from.n[2]);

    const q = new THREE.Quaternion().setFromUnitVectors(have.normalize(), want.normalize());
    const spin = safeEval(feature.angle, scope, 0);
    if (spin) {
      q.premultiply(
        new THREE.Quaternion().setFromAxisAngle(want.clone().normalize(), (spin * Math.PI) / 180)
      );
    }

    const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const moved = new THREE.Vector3(from.o[0], from.o[1], from.o[2]).applyMatrix4(m);
    m.premultiply(
      new THREE.Matrix4().makeTranslation(
        to.o[0] - moved.x,
        to.o[1] - moved.y,
        to.o[2] - moved.z
      )
    );

    const out = bodies.slice();
    for (const b of targets) {
      out[out.indexOf(b)] = { ...b, solid: K.transform(b.solid, m.elements, ks) };
    }
    return out;
  }

  /** A named plane or a face of the model, as an origin and a normal. */
  function alignFrame(ref) {
    if (!ref) return null;
    if (ref.plane) {
      const pl = resolvePlane(ref.plane, scope, builtConstruction);
      return pl ? { o: pl.origin, n: pl.n } : null;
    }
    const found = findFace(ref);
    if (!found || !found.face.planar) return null;
    return { o: found.face.centre, n: found.face.normal };
  }

  /* ---------------------------------------------------------------- */
  /* Delete Face                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Fill a round hole back in.
   *
   * Fusion's Delete removes a face and heals whatever is left, which in general
   * needs the neighbouring surfaces extended and intersected. There are no
   * surfaces here, so this does the one case that is exact and is also the one
   * anybody actually reaches for: a cylindrical bore, filled with its own
   * cylinder. Anything else is refused rather than guessed at, because a body
   * that comes back with a gap in it is worse than a command that says no.
   */
  function doDeleteFace(feature, bodies, scope, ks, errs) {
    const refs = feature.faces || [];
    if (!refs.length) return bodies;

    const out = bodies.slice();
    let filled = 0;
    for (const ref of refs) {
      const found = findFace(ref);
      if (!found) {
        errs.push({ feature: feature.id, message: 'Delete Face lost the face it was on' });
        continue;
      }
      const face = found.face;
      const idx = out.findIndex((b) => b.id === found.body.id);
      if (idx < 0) continue;

      // A round hole is plugged along its own axis, which keeps the surface it
      // was bored into exactly as it was. Anything else is healed by taking the
      // body as a surface, dropping the face, and closing what it leaves.
      if (!face.cylinder) {
        const healed = deleteFacesByPatching(
          feature, out[idx], [face.id], found.topo, ks, errs
        );
        if (healed) {
          out[idx] = { ...out[idx], solid: healed };
          filled++;
        }
        continue;
      }

      const b = out[idx];
      const axis = normalizeVec(face.cylinder.dir);
      const o = face.cylinder.origin;

      // How far the bore's own face runs along its axis. That span is exactly
      // the material the hole took out, so a plug of that length fills a
      // through hole and stops on the floor of a blind one. A plug run any
      // longer stands proud of the surface it was meant to close.
      const mesh = K.meshData(b.solid);
      let lo = Infinity;
      let hi = -Infinity;
      let widest = 0;
      for (const t of face.tris) {
        for (let k = 0; k < 3; k++) {
          const vi = mesh.triVerts[t * 3 + k] * 3;
          const px = mesh.vertProperties[vi] - o[0];
          const py = mesh.vertProperties[vi + 1] - o[1];
          const pz = mesh.vertProperties[vi + 2] - o[2];
          const d = px * axis[0] + py * axis[1] + pz * axis[2];
          if (d < lo) lo = d;
          if (d > hi) hi = d;
          // How far out the bore's own facets reach, which is not the fitted
          // radius: a bore cut with a polygon has its corners further out than
          // the circle through its middles.
          const rr = Math.hypot(px - axis[0] * d, py - axis[1] * d, pz - axis[2] * d);
          if (rr > widest) widest = rr;
        }
      }
      const length = hi - lo;
      if (!(length > 1e-6)) {
        errs.push({ feature: feature.id, message: 'That bore has no length to fill' });
        continue;
      }

      const basis = basisFor(axis);
      const mid = [
        o[0] + axis[0] * (lo + hi) / 2,
        o[1] + axis[1] * (lo + hi) / 2,
        o[2] + axis[2] * (lo + hi) / 2
      ];
      // The plug has to strictly contain the void, or the two polygons cut
      // across each other and the union leaves a ring of slivers with the hole
      // still counted in the genus. Grown so the plug's own flats sit outside
      // the bore's corners.
      const segs = Math.max(12, K.circularSegments(widest));
      const plugRadius = (widest || face.cylinder.radius) / Math.cos(Math.PI / segs) + 1e-3;
      const plug = K.cylinder(length, plugRadius, plugRadius, segs, true, ks);
      const m = new THREE.Matrix4();
      m.set(
        basis.x[0], basis.y[0], axis[0], mid[0],
        basis.x[1], basis.y[1], axis[1], mid[1],
        basis.x[2], basis.y[2], axis[2], mid[2],
        0, 0, 0, 1
      );

      out[idx] = { ...b, solid: K.union(b.solid, K.transform(plug, m.elements, ks), ks) };
      filled++;
    }
    if (!filled && refs.length) return bodies;
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Split Face                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Divide a face in two without changing the shape.
   *
   * Nothing is added or taken away: the body is cut in two by a plane and put
   * straight back together, which leaves the seam behind as a real edge. What
   * used to be one face is then two, each selectable and draftable on its own,
   * which is the whole point.
   *
   * This only became worth having once a face could keep its name across a
   * rebuild. Before that the two halves were indistinguishable from each other
   * the moment anything upstream moved, so a draft applied to one of them was
   * as likely to land on the other.
   */
  function doSplitFace(feature, bodies, scope, ks, errs) {
    // A surface tool takes a different route: there is no plane to cut with.
    if (feature.tool) {
      const bySurface = doSplitFaceBySurface(feature, bodies, scope, ks, errs);
      if (bySurface) return bySurface;
      errs.push({ feature: feature.id, message: 'Split Face lost the surface it was cutting with' });
      return bodies;
    }
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;

    const plane = feature.faceRef
      ? objectPlane(feature.faceRef, scope) ||
        resolvePlane(feature.plane || 'XY', scope, builtConstruction)
      : resolvePlane(feature.plane || 'XY', scope, builtConstruction);
    if (!plane) {
      errs.push({ feature: feature.id, message: 'Split Face needs a plane to cut with' });
      return bodies;
    }

    const out = bodies.slice();
    let split = 0;
    for (const b of targets) {
      const bb = K.boundingBox(b.solid);
      const span =
        Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) + 20;
      const below = halfSpace(plane.origin, plane.n, span, ks);

      const near = K.intersection(b.solid, below, ks);
      const far = K.difference(b.solid, below, ks);
      if (K.isEmpty(near) || K.isEmpty(far)) {
        errs.push({
          feature: feature.id,
          message: 'That plane does not pass through this body, so there is nothing to split'
        });
        continue;
      }

      // Each half is marked as its own geometry before they are put back
      // together, so the faces either side of the seam carry different names
      // and are not welded into one again.
      const nearSide = K.tagOriginal(near, `${feature.id}:near`, ks);
      const farSide = K.tagOriginal(far, `${feature.id}:far`, ks);
      const rejoined = K.union(nearSide, farSide, ks);
      out[out.indexOf(b)] = { ...b, solid: rejoined };
      split++;
    }
    if (!split) return bodies;
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Silhouette Split                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Split a body at its outline as seen from a direction.
   *
   * This is the parting line of a moulded part. The silhouette is the set of
   * edges whose two triangles face opposite ways along the pull direction, and
   * Fusion requires that line to be planar before it will split a solid at it.
   * So does this: the loop is fitted with a plane, and if it is not flat the
   * command says so rather than cutting somewhere arbitrary.
   */
  function doSilhouetteSplit(feature, bodies, scope, ks, errs) {
    const targets = pickBodies(feature, bodies);
    if (!targets.length) return bodies;

    const dirPlane = feature.direction
      ? objectPlane(feature.direction, scope)
      : resolvePlane('XY', scope, builtConstruction);
    if (!dirPlane) {
      errs.push({ feature: feature.id, message: 'Silhouette Split needs a view direction' });
      return bodies;
    }
    const dir = normalizeVec(dirPlane.n);

    const out = [];
    for (const b of bodies) {
      if (!targets.includes(b)) {
        out.push(b);
        continue;
      }

      const pts = silhouettePoints(b, dir);
      if (pts.length < 3) {
        errs.push({ feature: feature.id, message: 'No silhouette in that direction' });
        out.push(b);
        continue;
      }

      const fit = fitPlane(pts);
      if (!fit || fit.spread > 1e-3) {
        errs.push({
          feature: feature.id,
          message: 'That silhouette is not flat, so there is no plane to split at'
        });
        out.push(b);
        continue;
      }

      const bb = K.boundingBox(b.solid);
      const span =
        Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) + 20;
      const below = halfSpace(fit.origin, fit.normal, span, ks);
      const keep = K.intersection(b.solid, below, ks);
      const rest = K.difference(b.solid, below, ks);
      if (K.isEmpty(keep) || K.isEmpty(rest)) {
        errs.push({ feature: feature.id, message: 'The parting plane does not divide this body' });
        out.push(b);
        continue;
      }
      out.push({ ...b, solid: keep });
      out.push({
        id: `${feature.id}:${out.length}`,
        name: `${b.name} parted`,
        solid: rest,
        createdBy: feature.id
      });
    }
    return out;
  }

  /** Points on the silhouette of a body seen along `dir`. */
  function silhouettePoints(body, dir) {
    const mesh = K.meshData(body.solid);
    const tris = mesh.triVerts;
    const vp = mesh.vertProperties;
    const sideOf = new Float64Array(tris.length / 3);
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3;
      const bIdx = tris[t + 1] * 3;
      const c = tris[t + 2] * 3;
      const ux = vp[bIdx] - vp[a];
      const uy = vp[bIdx + 1] - vp[a + 1];
      const uz = vp[bIdx + 2] - vp[a + 2];
      const vx = vp[c] - vp[a];
      const vy = vp[c + 1] - vp[a + 1];
      const vz = vp[c + 2] - vp[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      sideOf[t / 3] = nx * dir[0] + ny * dir[1] + nz * dir[2];
    }

    // An edge is on the silhouette when its two triangles face opposite ways.
    const seen = new Map();
    const pts = [];
    for (let t = 0; t < tris.length; t += 3) {
      const f = t / 3;
      for (let e = 0; e < 3; e++) {
        const i = tris[t + e];
        const j = tris[t + ((e + 1) % 3)];
        const key = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (!seen.has(key)) {
          seen.set(key, { f, i, j });
          continue;
        }
        const other = seen.get(key);
        seen.delete(key);
        if (sideOf[f] === 0 || sideOf[other.f] === 0) continue;
        if (sideOf[f] > 0 === sideOf[other.f] > 0) continue;
        pts.push([vp[i * 3], vp[i * 3 + 1], vp[i * 3 + 2]]);
        pts.push([vp[j * 3], vp[j * 3 + 1], vp[j * 3 + 2]]);
      }
    }
    return pts;
  }

  /**
   * The best plane through a cloud of points, and how far off it they are.
   *
   * The spread is what decides whether a silhouette counts as flat, so it is
   * returned relative to the size of the cloud rather than in millimetres: a
   * hundred millimetre part and a five millimetre one should answer the same.
   */
  function fitPlane(pts) {
    const n = pts.length;
    if (n < 3) return null;
    const c = [0, 0, 0];
    for (const p of pts) {
      c[0] += p[0];
      c[1] += p[1];
      c[2] += p[2];
    }
    c[0] /= n;
    c[1] /= n;
    c[2] /= n;

    // The covariance matrix's smallest eigenvector is the normal. Three points
    // at a time is enough here: take the largest cross product found, which is
    // the most reliably oriented triple in the cloud.
    let best = null;
    let bestLen = 0;
    let extent = 0;
    for (const p of pts) {
      extent = Math.max(extent, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
    }
    for (let i = 1; i < n; i++) {
      const ux = pts[i][0] - c[0];
      const uy = pts[i][1] - c[1];
      const uz = pts[i][2] - c[2];
      for (let j = i + 1; j < n; j += Math.max(1, Math.floor(n / 64))) {
        const vx = pts[j][0] - c[0];
        const vy = pts[j][1] - c[1];
        const vz = pts[j][2] - c[2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        if (l > bestLen) {
          bestLen = l;
          best = [nx / l, ny / l, nz / l];
        }
      }
      if (bestLen > 0 && i > 64) break;
    }
    if (!best) return null;

    let spread = 0;
    for (const p of pts) {
      const d = (p[0] - c[0]) * best[0] + (p[1] - c[1]) * best[1] + (p[2] - c[2]) * best[2];
      spread = Math.max(spread, Math.abs(d));
    }
    return { origin: c, normal: best, spread: extent > 0 ? spread / extent : spread };
  }

  /** The diagonal of a set of bodies, used where a feature needs "far enough". */
  function bodySpan(list) {
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (const b of list) {
      const bb = K.boundingBox(b.solid);
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], bb.min[i]);
        hi[i] = Math.max(hi[i], bb.max[i]);
      }
    }
    if (!Number.isFinite(lo[0])) return 100;
    return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 10;
  }

  /* ---------------------------------------------------------------- */
  /* Surfaces                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Put a sheet into the model as a body of its own.
   *
   * A surface is always its own body. There is nothing to join it to or cut it
   * out of, because it has no inside, so the operation field a solid feature
   * carries would have nothing to mean here.
   */
  function addSheetBody(feature, sheet, label) {
    if (!sheet || !sheet.triVerts?.length) return null;
    const key = `${feature.id}:${bodies.length}`;
    const body = {
      id: key,
      name: doc.bodyNames?.[key] || label || `Surface ${bodies.length + 1}`,
      sheet,
      createdBy: feature.id,
      component: feature.component || null
    };
    bodies.push(body);
    return body;
  }

  /** Add a solid a surface feature produced, keeping the usual naming. */
  function addSolidBody(feature, solid) {
    const key = `${feature.id}:${bodies.length}`;
    bodies.push({
      id: key,
      name: doc.bodyNames?.[key] || `Body ${bodies.length + 1}`,
      solid,
      createdBy: feature.id,
      component: feature.component || null
    });
  }

  /** Replace a body in place, keeping its id and its name. */
  function replaceBody(list, body, next) {
    const idx = list.indexOf(body);
    if (idx < 0) return;
    list[idx] = { ...body, ...next };
  }

  /**
   * The curves a surface feature is built from, in world space.
   *
   * Open runs matter here in a way they never did for a solid: a surface
   * extruded off a single line is a perfectly good result, where a solid
   * extruded off one is nothing at all. So this walks entities into chains
   * rather than looking for closed regions, and a circle or an ellipse, which
   * has no ends to chain by, comes through as its own closed run.
   */
  function profileRuns(feature, doc, scope) {
    const runs = [];
    let plane = null;

    if (feature.sketch) {
      const sk = doc.sketches[feature.sketch];
      if (sk) {
        if (!sk.is3d) solveSketch(sk, { maxIterations: 40 });
        plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);
        const toWorld = (p) => {
          const w = sketchToWorld(plane, p.x, p.y, p.z || 0);
          return [w.x, w.y, w.z];
        };
        const wanted = feature.entities?.length ? feature.entities : null;
        const list = sk.entities.filter(
          (e) => !e.construction && (!wanted || wanted.includes(e.id))
        );

        const chainable = [];
        for (const ent of list) {
          if (entityEndpoints(ent)) {
            chainable.push(ent.id);
            continue;
          }
          // A circle, an ellipse or a piece of text has no ends to chain by.
          for (const loop of entityLoops(sk, ent)) {
            if (loop.length > 2) runs.push({ points: loop.map(toWorld), closed: true });
          }
        }

        let pool = chainable.slice();
        let guard = 0;
        while (pool.length && guard++ < 200) {
          const chain = chainPath(sk, { entities: pool });
          if (!chain) break;
          runs.push({ points: chain.points.map(toWorld), closed: chain.closed });
          const before = pool.length;
          pool = pool.filter((id) => {
            const ent = sk.entities.find((x) => x.id === id);
            if (!ent) return false;
            const pts = tessellate(sk, ent);
            return !pts.every((p) =>
              chain.points.some(
                (q) => Math.hypot(q.x - p.x, q.y - p.y, (q.z || 0) - (p.z || 0)) < 1e-6
              )
            );
          });
          if (pool.length === before) break;
        }
      }
    }

    for (const ref of feature.edges || []) {
      const segs = [];
      for (const b of bodies) {
        let topo;
        try {
          topo = buildTopology(meshOf(b));
        } catch {
          continue;
        }
        for (const e of resolveEdgeRefs(topo, [ref])) {
          if (!e) continue;
          for (let i = 0; i < e.points.length - 1; i++) {
            segs.push([e.points[i], e.points[i + 1]]);
          }
        }
        if (segs.length) break;
      }
      for (const chain of chainWorldSegments(segs, true)) {
        if (!chain || chain.length < 2) continue;
        const closed = SH.len(SH.sub(chain[0], chain[chain.length - 1])) < 1e-6;
        runs.push({ points: closed ? chain.slice(0, -1) : chain, closed });
      }
    }

    for (const ref of feature.faces || []) {
      const found = faceContour(ref);
      if (!found) continue;
      if (!plane) plane = found.plane;
      for (const loop of found.loops) runs.push({ points: loop, closed: true });
    }

    return { runs, plane };
  }

  /** Every sheet body a surface feature was pointed at. */
  function pickSheets(feature) {
    const wanted = feature.surfaces?.length ? feature.surfaces : null;
    return bodies.filter((b) => isSheet(b) && (!wanted || wanted.includes(b.id)));
  }

  /** A world space axis for a surface revolve. */
  function surfaceAxis(feature, doc, scope, plane) {
    const spec = feature.axis || { type: 'y' };
    if (plane && (spec.type === 'x' || spec.type === 'y')) {
      const dir = spec.type === 'x' ? plane.x : plane.y;
      return { origin: plane.origin.slice(), dir: dir.slice() };
    }
    if (spec.type === 'entity' && plane) {
      const sk = doc.sketches[feature.sketch];
      const ent = sk?.entities.find((e) => e.id === spec.entity);
      if (!ent || ent.type !== 'line') return null;
      const a = sk.points[ent.p[0]];
      const b = sk.points[ent.p[1]];
      const wa = sketchToWorld(plane, a.x, a.y, a.z || 0);
      const wb = sketchToWorld(plane, b.x, b.y, b.z || 0);
      return {
        origin: [wa.x, wa.y, wa.z],
        dir: SH.unit([wb.x - wa.x, wb.y - wa.y, wb.z - wa.z])
      };
    }
    return worldAxisFor(spec, scope);
  }

  /**
   * A solid filling everything on one side of a surface.
   *
   * This is how a surface cuts a solid at all. The sheet is stretched out past
   * the body it is cutting and then given the thickness of the whole model, so
   * what comes back is a lump the size of a half space with that surface as its
   * face, and an ordinary boolean does the rest. A surface curved tightly
   * enough to fold back on itself over that distance cannot be used this way,
   * and says so rather than producing a quiet mess.
   */
  function sheetHalfSpace(sheet, span, ks) {
    const grown = SH.extendSheet(sheet, span * 0.25);
    const { sheet: shell, closed } = SH.thickenSheet(grown, span * 2);
    if (!closed) return null;
    let solid;
    try {
      solid = K.ofMesh(shell.vertProperties, shell.triVerts, ks);
    } catch {
      return null;
    }
    if (K.isEmpty(solid) || K.status(solid) !== 'NoError') return null;
    return solid;
  }

  /** How big the whole thing is, which is how far a cutting surface must reach. */
  function spanOfBody(body) {
    if (body.solid) {
      const bb = K.boundingBox(body.solid);
      return Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
    }
    return SH.spanOf(SH.sheetPoints(body.sheet));
  }

  /** Is a point inside a solid? Asked by cutting a speck out at that point. */
  function pointInside(solid, point, ks) {
    const speck = K.translate(K.box([0.05, 0.05, 0.05], true, ks), point, ks);
    return !K.isEmpty(K.intersection(solid, speck, ks));
  }

  /* --------------------------------------------------------- create */

  /** A curve dragged in a straight line, as a surface rather than a solid. */
  function doSurfaceExtrude(feature, doc, scope, ks, errs) {
    const { runs, plane } = profileRuns(feature, doc, scope);
    if (!runs.length) throw new Error('Extrude a surface from sketch curves or model edges');
    if (!plane) throw new Error('Surface extrude has no direction to go in');

    const distance = safeEval(feature.distance, scope, 10);
    if (Math.abs(distance) < 1e-9) throw new Error('A surface extrude of nothing is nothing');
    const dir = [plane.n[0] * distance, plane.n[1] * distance, plane.n[2] * distance];
    const symmetric = feature.direction === 'symmetric';

    let made = 0;
    for (const run of runs) {
      const pts = run.closed ? [...run.points, run.points[0]] : run.points;
      const sheet = SH.extrudeRunSheet(pts, dir, {
        from: symmetric ? -0.5 : 0,
        to: symmetric ? 0.5 : 1
      });
      if (sheet && addSheetBody(feature, sheet)) made++;
    }
    if (!made) errs.push({ feature: feature.id, message: 'Surface extrude produced nothing' });
  }

  /** A curve turned about an axis, as a surface. */
  function doSurfaceRevolve(feature, doc, scope, ks, errs) {
    const { runs, plane } = profileRuns(feature, doc, scope);
    if (!runs.length) throw new Error('Revolve a surface from sketch curves or model edges');
    const axis = surfaceAxis(feature, doc, scope, plane);
    if (!axis) throw new Error('Surface revolve needs an axis to turn about');

    const angle = safeEval(feature.angle, scope, 360);
    let made = 0;
    for (const run of runs) {
      const pts = run.closed ? [...run.points, run.points[0]] : run.points;
      const sheet = SH.revolveRunSheet(
        pts,
        axis.origin,
        axis.dir,
        angle,
        K.circularSegments(Math.max(1, SH.spanOf(pts)))
      );
      if (sheet && addSheetBody(feature, sheet)) made++;
    }
    if (!made) errs.push({ feature: feature.id, message: 'Surface revolve produced nothing' });
  }

  /** A curve carried along a path, as a surface. */
  function doSurfaceSweep(feature, doc, scope, ks, errs) {
    const { runs } = profileRuns(feature, doc, scope);
    if (!runs.length) throw new Error('Sweep a surface from sketch curves or model edges');
    const path = curvePoints(feature.path, doc, scope);
    if (!path || path.length < 2) throw new Error('Surface sweep has no path');

    const frames = pathFrames(path, {
      closed: !!feature.path?.closed,
      twistDegrees: safeEval(feature.twist, scope, 0)
    });
    if (frames.length < 2) throw new Error('The sweep path is too short');

    let made = 0;
    for (const run of runs) {
      const pts = run.closed ? [...run.points, run.points[0]] : run.points;
      const sheet = SH.sweepRunSheet(pts, frames, { closedPath: !!feature.path?.closed });
      if (sheet && addSheetBody(feature, sheet)) made++;
    }
    if (!made) errs.push({ feature: feature.id, message: 'Surface sweep produced nothing' });
  }

  /** A surface through a run of sections. */
  function doSurfaceLoft(feature, doc, scope, ks, errs) {
    const sections = [];
    for (const spec of feature.sections || []) {
      const { runs } = profileRuns({ ...spec, id: feature.id }, doc, scope);
      if (runs.length) sections.push(runs[0]);
    }
    if (sections.length < 2) throw new Error('A lofted surface needs at least two sections');

    const closed = sections.every((s) => s.closed);
    const sheet = SH.loftRunsSheet(
      sections.map((s) => s.points),
      { closed, closedLoft: !!feature.closed }
    );
    if (!sheet) throw new Error('Those sections do not loft');
    if (!addSheetBody(feature, sheet)) {
      errs.push({ feature: feature.id, message: 'Surface loft produced nothing' });
    }
  }

  /** Fill a boundary. */
  function doPatch(feature, doc, scope, ks, errs) {
    const { runs } = profileRuns(feature, doc, scope);
    // A boundary picked as a whole surface's rim, rather than curve by curve.
    // Only the surfaces actually named: falling back to all of them would fill
    // the rim of every surface in the model, which is never what was asked.
    for (const b of feature.surfaces?.length ? pickSheets(feature) : []) {
      const P = SH.sheetPoints(b.sheet);
      for (const loop of SH.boundaryLoops(b.sheet)) {
        runs.push({ points: loop.map((v) => P[v]), closed: true });
      }
    }
    const loops = runs.filter((r) => r.closed && r.points.length > 2).map((r) => r.points);
    if (!loops.length) throw new Error('Patch needs a closed boundary to fill');

    let made = 0;
    if (feature.together && loops.length > 1) {
      // The first loop is the outside and the rest are holes in it.
      const sheet = SH.patchLoops(loops);
      if (sheet && addSheetBody(feature, sheet)) made++;
    } else {
      for (const loop of loops) {
        const sheet = SH.patchLoops([loop]);
        if (sheet && addSheetBody(feature, sheet)) made++;
      }
    }
    if (!made) errs.push({ feature: feature.id, message: 'Patch produced nothing' });
  }

  /**
   * A band of surface off a set of curves, or the surface between two of them.
   *
   * Two curves give the surface running straight from one to the other. A
   * single curve gives a band of the given width laid along a direction, which
   * is what Fusion's alignment setting picks between.
   */
  function doRuled(feature, doc, scope, ks, errs) {
    const { runs } = profileRuns(feature, doc, scope);
    if (!runs.length) throw new Error('Ruled needs curves or model edges to work from');

    if (runs.length >= 2 && feature.alignment !== 'direction') {
      let made = 0;
      for (let i = 0; i + 1 < runs.length; i += 2) {
        const sheet = SH.ruledSheet(runs[i].points, runs[i + 1].points, {
          closed: runs[i].closed && runs[i + 1].closed
        });
        if (sheet && addSheetBody(feature, sheet)) made++;
      }
      if (made) return;
    }

    const distance = safeEval(feature.distance, scope, 10);
    const along = SH.unit(feature.dir || [0, 0, 1]);
    if (!SH.len(along)) throw new Error('Ruled has no direction to grow in');

    let made = 0;
    for (const run of runs) {
      const pts = run.closed ? [...run.points, run.points[0]] : run.points;
      const sheet = SH.extrudeRunSheet(pts, SH.mul(along, distance), {});
      if (sheet && addSheetBody(feature, sheet)) made++;
    }
    if (!made) errs.push({ feature: feature.id, message: 'Ruled produced nothing' });
  }

  /** The same surface, held a set distance off the original. */
  function doOffsetSurface(feature, doc, scope, ks, errs) {
    const distance = safeEval(feature.distance, scope, 2);
    const sources = [];

    for (const b of pickSheets(feature)) sources.push(b.sheet);
    // Faces of a solid can be offset too, which is how most offsets start.
    const byBody = new Map();
    for (const ref of feature.faces || []) {
      const found = findFace(ref);
      if (!found) continue;
      if (!byBody.has(found.body.id)) byBody.set(found.body.id, { found, ids: [] });
      byBody.get(found.body.id).ids.push(found.face.id);
    }
    for (const { found, ids } of byBody.values()) {
      const sheet = SH.sheetFromFaces(meshOf(found.body), found.topo, ids);
      if (sheet) sources.push(sheet);
    }
    if (!sources.length) throw new Error('Offset needs faces or a surface to work from');

    let made = 0;
    for (const src of sources) {
      const sheet = SH.offsetSheet(src, distance);
      if (sheet && addSheetBody(feature, sheet)) made++;
    }
    if (!made) errs.push({ feature: feature.id, message: 'Offset produced nothing' });
  }

  /* --------------------------------------------------------- modify */

  /** Cut a surface where another crosses it, and keep the side that was picked. */
  function doTrimSurface(feature, doc, scope, ks, errs) {
    const targets = pickSheets(feature);
    if (!targets.length) throw new Error('Trim needs a surface to cut');
    const cutters = bodies
      .filter((b) => (feature.cutters || []).includes(b.id))
      .map((b) => (isSheet(b) ? b.sheet : meshOf(b)));
    if (!cutters.length) throw new Error('Trim needs something to cut with');

    for (const t of targets) {
      const trimmed = SH.trimSheet(t.sheet, cutters, feature.keep || null);
      if (!trimmed?.triVerts.length) {
        errs.push({ feature: feature.id, message: 'Trim removed the whole surface' });
        continue;
      }
      replaceBody(bodies, t, { sheet: trimmed });
    }
  }

  /** Carry a surface further out past its own edge. */
  function doExtendSurface(feature, doc, scope, ks, errs) {
    const targets = pickSheets(feature);
    if (!targets.length) throw new Error('Extend needs a surface');
    const distance = safeEval(feature.distance, scope, 5);
    if (distance <= 0) throw new Error('Extend needs a distance to go');
    for (const t of targets) {
      replaceBody(bodies, t, { sheet: SH.extendSheet(t.sheet, distance) });
    }
  }

  /**
   * Put back what a trim took away.
   *
   * The common case on an imported surface is a hole cut through it by
   * something that is no longer in the document, so there is no trim in the
   * timeline to suppress and the hole has to be filled rather than undone.
   * Squaring the outer edge off is the second half of the same job, and it only
   * means anything on a flat surface, so on a curved one it says so instead of
   * quietly doing nothing.
   */
  function doUntrimSurface(feature, doc, scope, ks, errs) {
    const targets = pickSheets(feature);
    if (!targets.length) throw new Error('Untrim needs a surface');
    const wantOuter = feature.outer !== false;
    const margin = safeEval(feature.margin, scope, 0);

    let changed = 0;
    for (const t of targets) {
      const out = SH.untrimSheet(t.sheet, { outer: wantOuter, margin });
      if (!out.sheet?.triVerts?.length) {
        errs.push({ feature: feature.id, message: 'Untrim produced nothing' });
        continue;
      }
      if (!out.holes && !out.squared) {
        errs.push({
          feature: feature.id,
          message: 'That surface has nothing trimmed out of it to put back.'
        });
        continue;
      }
      if (wantOuter && !out.flat) {
        errs.push({
          feature: feature.id,
          message: `Holes filled, but ${
            out.holes ? 'the' : 'that'
          } surface is curved, so its outer edge was left where it is.`
        });
      } else if (!out.exact) {
        errs.push({
          feature: feature.id,
          message: 'That surface is curved, so the fill is a patch across the hole rather than the curve carried on.'
        });
      }
      replaceBody(bodies, t, { sheet: out.sheet });
      changed++;
    }
    if (!changed) errs.push({ feature: feature.id, message: 'Untrim changed nothing' });
  }

  /**
   * Make several surfaces into one, and leave it a surface.
   *
   * Stitch asks whether the result closed and hands back a solid when it did.
   * Merge does not ask. Sometimes what is wanted is one surface body to offset
   * or thicken or trim as a piece, and being handed a solid halfway through
   * that is the wrong answer.
   */
  function doMergeSurface(feature, doc, scope, ks, errs) {
    const targets = pickSheets(feature);
    if (targets.length < 2) throw new Error('Merge needs two or more surfaces');
    const tol = safeEval(feature.tolerance, scope, 0.01);

    const { sheet, openEdges } = SH.stitchSheets(
      targets.map((b) => b.sheet),
      Math.max(1e-6, tol)
    );
    if (!sheet?.triVerts?.length) throw new Error('Merge produced nothing');

    const name = targets[0].name;
    for (const t of targets) bodies.splice(bodies.indexOf(t), 1);
    addSheetBody(feature, sheet, name);
    if (openEdges === 0) {
      errs.push({
        feature: feature.id,
        message: 'Those surfaces close on themselves. Stitch would make a solid out of them.'
      });
    }
  }

  /**
   * Weld surfaces together, and make a solid if they closed.
   *
   * Whether they closed is the whole question, and it is answered here before
   * anything reaches the kernel. A set of sheets that leaves a gap stays a set
   * of sheets and says where the gap is, rather than becoming a body that looks
   * right and is not watertight.
   */
  function doStitch(feature, doc, scope, ks, errs) {
    const targets = pickSheets(feature);
    if (!targets.length) throw new Error('Stitch needs surfaces to join');

    const tol = safeEval(feature.tolerance, scope, 0.01);
    const { sheet, closed, openEdges } = SH.stitchSheets(
      targets.map((b) => b.sheet),
      Math.max(1e-6, tol)
    );
    for (const t of targets) bodies.splice(bodies.indexOf(t), 1);

    if (!closed) {
      addSheetBody(feature, sheet, 'Stitched surface');
      errs.push({
        feature: feature.id,
        message: `Stitched, but ${openEdges} edges are still open, so this is a surface and not a solid. Raise the tolerance or fill the gap.`
      });
      return;
    }

    let solid = null;
    try {
      solid = K.ofMesh(sheet.vertProperties, sheet.triVerts, ks);
    } catch {
      solid = null;
    }
    if (!solid || K.isEmpty(solid) || K.status(solid) !== 'NoError') {
      addSheetBody(feature, sheet, 'Stitched surface');
      errs.push({
        feature: feature.id,
        message: 'Those surfaces close but run into each other, so they are not a solid.'
      });
      return;
    }
    addSolidBody(feature, solid);
  }

  /** Break a body back into one surface per face. */
  function doUnstitch(feature, doc, scope, ks, errs) {
    const targets = pickBodies(feature, bodies, { sheets: 'either' });
    if (!targets.length) throw new Error('Unstitch needs a body');

    let made = 0;
    for (const b of targets) {
      let topo;
      try {
        topo = buildTopology(meshOf(b));
      } catch (err) {
        errs.push({ feature: feature.id, message: `Unstitch: ${err.message}` });
        continue;
      }
      const pieces = SH.unstitchMesh(meshOf(b), topo);
      if (!pieces.length) continue;
      bodies.splice(bodies.indexOf(b), 1);
      for (const piece of pieces) if (addSheetBody(feature, piece.sheet)) made++;
    }
    if (!made) errs.push({ feature: feature.id, message: 'Unstitch produced nothing' });
  }

  /** Turn a surface inside out, which is what decides where a thicken goes. */
  function doReverseNormal(feature, doc, scope, ks, errs) {
    const targets = pickSheets(feature);
    if (!targets.length) throw new Error('Reverse Normal needs a surface');
    for (const t of targets) replaceBody(bodies, t, { sheet: SH.reverseSheet(t.sheet) });
  }

  /** Give a surface thickness, and so turn it into a solid. */
  function doThicken(feature, doc, scope, ks, errs) {
    const targets = pickSheets(feature);
    if (!targets.length) throw new Error('Thicken needs a surface');
    const distance = safeEval(feature.distance, scope, 2);
    if (Math.abs(distance) < 1e-9) throw new Error('Thicken needs a thickness');

    for (const t of targets) {
      const { sheet, closed } = SH.thickenSheet(t.sheet, distance, !!feature.symmetric);
      if (!closed) {
        errs.push({
          feature: feature.id,
          message: 'That surface did not close when thickened, so it cannot become a solid.'
        });
        continue;
      }
      let solid = null;
      try {
        solid = K.ofMesh(sheet.vertProperties, sheet.triVerts, ks);
      } catch {
        solid = null;
      }
      if (!solid || K.isEmpty(solid) || K.status(solid) !== 'NoError') {
        errs.push({
          feature: feature.id,
          message: 'Thickening that surface made it run into itself. Try a smaller thickness.'
        });
        continue;
      }
      if (!feature.keepSurface) bodies.splice(bodies.indexOf(t), 1);
      addSolidBody(feature, solid);
    }
  }

  /* --------------------------------------------------- plastic parts */

  /**
   * The face a plastic feature stands on, as a plane to build in.
   *
   * Everything in this section is built lying on the XY plane with its own
   * origin at zero and then moved onto the face, which means each shape is
   * written once in the frame it is easiest to think about.
   */
  function faceStand(feature, errs) {
    const ref = feature.face;
    if (!ref) throw new Error('Pick the face it stands on');
    for (const b of bodies) {
      if (!b.solid) continue;
      let topo;
      try {
        topo = buildTopology(K.meshData(b.solid));
      } catch {
        continue;
      }
      const [face] = resolveFaceRefs(topo, [ref]);
      if (!face) continue;
      if (!face.planar) throw new Error('That face is curved, so nothing can stand square on it');
      const basis = basisFor(face.normal);
      return {
        body: b,
        face,
        topo,
        mesh: K.meshData(b.solid),
        plane: {
          origin: face.centre.slice(),
          x: basis.x,
          y: basis.y,
          n: face.normal.slice()
        }
      };
    }
    errs.push({ feature: feature.id, message: 'The face this stands on is no longer on the model' });
    return null;
  }

  /** Put a solid built at the origin onto a face, offset within it. */
  function ontoFace(solid, stand, dx, dy, ks) {
    const shifted = dx || dy ? K.translate(solid, [dx, dy, 0], ks) : solid;
    return K.transform(shifted, planeMatrix(stand.plane).elements, ks);
  }

  /**
   * A screw boss: a post with a hole down it, standing on a face.
   *
   * The fillet at the foot is not decoration. A boss without one snaps off at
   * the base, which is where the whole load is, and on a printed part that is
   * also where the layers run straight across the stress.
   */
  function doBoss(feature, doc, scope, ks, apply, errs) {
    const stand = faceStand(feature, errs);
    if (!stand) return;

    const height = safeEval(feature.height, scope, 10);
    const profile = PL.bossProfile({
      diameter: safeEval(feature.diameter, scope, 8),
      height,
      bore: safeEval(feature.bore, scope, 3),
      boreDepth: feature.through ? height : safeEval(feature.boreDepth, scope, height * 0.8),
      fillet: safeEval(feature.fillet, scope, 1.5)
    });
    if (!profile) throw new Error('A boss needs a bore smaller than its outside');

    const parts = [K.revolveContours([profile], 360, 0, ks)];

    const ribs = Math.max(0, Math.round(safeEval(feature.ribs, scope, 0)));
    if (ribs > 0) {
      const rib = PL.bossRibProfile({
        diameter: safeEval(feature.diameter, scope, 8),
        reach: safeEval(feature.ribReach, scope, safeEval(feature.diameter, scope, 8) / 2),
        height: safeEval(feature.ribHeight, scope, height * 0.7),
        fillet: safeEval(feature.fillet, scope, 1.5)
      });
      const thickness = Math.max(0.1, safeEval(feature.ribThickness, scope, 1.5));
      // Drawn in the same radius and height frame as the boss, so it is pushed
      // across its thickness and then stood up, rather than being written out
      // a second time in a frame of its own.
      const flat = K.extrudeContours([rib], { height: thickness, center: true }, ks);
      // Drawn flat with radius across and height up the page, then tipped so
      // the height stands up the boss and the thickness lies across it. A
      // quarter turn about X, which is a rotation: swapping two axes instead
      // would turn the rib inside out.
      const upright = K.transform(
        flat,
        new THREE.Matrix4().makeRotationX(Math.PI / 2).elements,
        ks
      );
      for (let i = 0; i < ribs; i++) {
        const turn = new THREE.Matrix4().makeRotationZ((i * Math.PI * 2) / ribs);
        parts.push(K.transform(K.copy(upright, ks), turn.elements, ks));
      }
    }

    const built = K.unionAll(parts, ks);
    const dx = safeEval(feature.x, scope, 0);
    const dy = safeEval(feature.y, scope, 0);
    apply(feature, ontoFace(built, stand, dx, dy, ks), 'join');
  }

  /**
   * A rest: a small pad two parts meet on.
   *
   * Three small pads touch properly. One big face never does, because nothing
   * is flat enough, so it rocks on whichever two high spots it happens to have.
   */
  function doRest(feature, doc, scope, ks, apply, errs) {
    const stand = faceStand(feature, errs);
    if (!stand) return;

    const spec = PL.restProfile({
      shape: feature.shape || 'round',
      diameter: safeEval(feature.diameter, scope, 10),
      width: safeEval(feature.width, scope, 10),
      depth: safeEval(feature.depth, scope, 10),
      corner: safeEval(feature.corner, scope, 1),
      height: safeEval(feature.height, scope, 2),
      draft: safeEval(feature.draft, scope, 5)
    });
    if (!spec) throw new Error('That draft angle takes the rest to nothing before it reaches its height');

    const cut = feature.op === 'cut';
    let built =
      spec.kind === 'turn'
        ? K.revolveContours([spec.contour], 360, 0, ks)
        : K.extrudeContours([spec.contour], { height: spec.height, taperDeg: spec.taper }, ks);
    // A sunken rest is the same shape taken out of the face rather than a
    // different shape, so it is built the same way and pushed under.
    if (cut) built = K.translate(built, [0, 0, -spec.height], ks);

    const dx = safeEval(feature.x, scope, 0);
    const dy = safeEval(feature.y, scope, 0);
    apply(feature, ontoFace(built, stand, dx, dy, ks), cut ? 'cut' : 'join');
  }

  /**
   * A cantilever snap fit, or the catch it clicks into.
   *
   * Two angles decide whether it works. The lead-in is the shallow face the
   * hook rides over going in, and a shallow one is the difference between a
   * part that clicks together with a thumb and one that needs a mallet. The
   * retention face is what holds it there.
   */
  function doSnapFit(feature, doc, scope, ks, apply, errs) {
    const stand = faceStand(feature, errs);
    if (!stand) return;

    const cut = feature.op === 'cut';
    const clearance = Math.max(0, safeEval(feature.clearance, scope, 0.2));
    const grow = cut ? clearance : 0;
    const profile = PL.snapProfile({
      length: safeEval(feature.length, scope, 12),
      thickness: safeEval(feature.thickness, scope, 2) + grow * 2,
      hook: safeEval(feature.hook, scope, 1.5) + grow,
      leadIn: safeEval(feature.leadIn, scope, 30),
      retention: safeEval(feature.retention, scope, 90)
    });
    if (!profile) throw new Error('That lead-in angle needs a longer beam than this one');

    const width = Math.max(0.1, safeEval(feature.width, scope, 6) + grow * 2);
    const flat = K.extrudeContours([profile], { height: width, center: true }, ks);
    // Drawn lying down, along the beam and up the hook. Stood up so the beam
    // runs out of the face and the hook points across it.
    const stand90 = new THREE.Matrix4().set(
      0, 1, 0, 0,
      0, 0, 1, 0,
      1, 0, 0, 0,
      0, 0, 0, 1
    );
    let built = K.transform(flat, stand90.elements, ks);
    // The hook stands out of the face it was put on. The catch is the same
    // shape going the other way, into the material, because the face to pick
    // for a catch is the one the hook comes through.
    if (cut) {
      built = K.transform(built, new THREE.Matrix4().makeScale(1, 1, -1).elements, ks);
    }
    const facing = safeEval(feature.facing, scope, 0);
    if (facing) {
      built = K.transform(built, new THREE.Matrix4().makeRotationZ((facing * Math.PI) / 180).elements, ks);
    }

    const dx = safeEval(feature.x, scope, 0);
    const dy = safeEval(feature.y, scope, 0);
    apply(feature, ontoFace(built, stand, dx, dy, ks), cut ? 'cut' : 'join');
  }

  /**
   * A lip round the rim of a mating face, or the groove it drops into.
   *
   * Two halves of a printed box that meet on a flat face will not stay lined
   * up. This is what lines them up, and the clearance between the two is the
   * number that decides whether they click together or have to be forced.
   *
   * The band follows the face's own outer edge rather than a shape drawn by
   * hand, so it fits a rounded rectangle and an odd outline equally well and
   * cannot drift out of step with the wall it belongs to.
   */
  function doLip(feature, doc, scope, ks, apply, errs) {
    const stand = faceStand(feature, errs);
    if (!stand) return;

    const band = PL.lipBand({
      width: safeEval(feature.width, scope, 1.2),
      inset: safeEval(feature.inset, scope, 0.8),
      height: safeEval(feature.height, scope, 2),
      clearance: safeEval(feature.clearance, scope, 0.15),
      groove: feature.op === 'cut'
    });

    const loop = outerLoopOf(stand);
    if (!loop) throw new Error('That face has no outline to follow');
    const outer = K.offsetContours([loop], band.outer, 'Miter', ks);
    const inner = K.offsetContours([loop], band.inner, 'Miter', ks);

    // The band itself: the inner offset taken out of the outer one. Done on the
    // cross sections rather than on two solids, so what is extruded is already
    // the ring and there is no boolean of two prisms to go wrong.
    const ring = ks.track(outer.subtract(inner));
    const solid = ks.track(ring.extrude(band.height, 0, 0, [1, 1], false));

    const cut = feature.op === 'cut';
    // A groove is cut down into the face; a lip stands up out of it.
    const placed = cut ? K.translate(solid, [0, 0, -band.height], ks) : solid;
    apply(feature, K.transform(placed, planeMatrix(stand.plane).elements, ks), cut ? 'cut' : 'join');
  }

  /**
   * The outer edge of a face, in that face's own plane.
   *
   * Taken from the triangles the face is made of rather than from a sketch, so
   * it is whatever the face really is. A face with holes in it has more than
   * one boundary and the outer one is simply the biggest.
   */
  function outerLoopOf(stand) {
    const sheet = SH.sheetFromFaces(stand.mesh, stand.topo, [stand.face.id]);
    if (!sheet) return null;
    const loops = SH.boundaryLoops(sheet);
    if (!loops.length) return null;
    const P = SH.sheetPoints(sheet);
    const flat = (v) => {
      const d = [
        P[v][0] - stand.plane.origin[0],
        P[v][1] - stand.plane.origin[1],
        P[v][2] - stand.plane.origin[2]
      ];
      return [
        d[0] * stand.plane.x[0] + d[1] * stand.plane.x[1] + d[2] * stand.plane.x[2],
        d[0] * stand.plane.y[0] + d[1] * stand.plane.y[1] + d[2] * stand.plane.y[2]
      ];
    };
    const rings = loops.map((l) => l.map(flat));
    let best = 0;
    for (let i = 1; i < rings.length; i++) {
      if (Math.abs(PL.signedArea(rings[i])) > Math.abs(PL.signedArea(rings[best]))) best = i;
    }
    const ring = rings[best];
    // The kernel offsets inwards on an anticlockwise ring, which is the sign
    // this feature is written in terms of.
    return PL.signedArea(ring) < 0 ? ring.slice().reverse() : ring;
  }

  /* ------------------------------------------ what surfaces unlock */

  /**
   * Cut solids with surfaces and keep the pieces that were ticked.
   *
   * Fusion calls this Boundary Fill: everything the tools divide the bodies
   * into becomes a cell, and the cells that are wanted are kept. Here a cell is
   * simply what falls out of cutting each body by each tool in turn.
   */
  function doBoundaryFill(feature, doc, scope, ks, errs) {
    const targets = pickBodies(feature, bodies);
    if (!targets.length) throw new Error('Boundary Fill needs solid bodies to divide');

    const tools = [];
    for (const id of feature.tools || []) {
      const b = bodies.find((x) => x.id === id);
      if (b && isSheet(b)) tools.push(b);
    }
    for (const spec of feature.planes || []) {
      const pl = resolvePlane(spec, scope, builtConstruction);
      if (pl) tools.push({ plane: pl });
    }
    if (!tools.length) throw new Error('Boundary Fill needs surfaces or planes to divide with');

    for (const target of targets) {
      const span = spanOfBody(target) + 20;
      let cells = [target.solid];
      for (const tool of tools) {
        const half = tool.plane
          ? halfSpace(tool.plane.origin, tool.plane.n, span, ks)
          : sheetHalfSpace(tool.sheet, span, ks);
        if (!half) {
          errs.push({
            feature: feature.id,
            message: 'That surface curves back on itself, so it cannot divide a body.'
          });
          continue;
        }
        const next = [];
        for (const cell of cells) {
          const near = K.intersection(cell, half, ks);
          const far = K.difference(cell, half, ks);
          if (!K.isEmpty(near)) next.push(near);
          if (!K.isEmpty(far)) next.push(far);
        }
        if (next.length) cells = next;
      }
      if (cells.length < 2) {
        errs.push({
          feature: feature.id,
          message: 'Nothing divided that body, so there are no cells to choose from'
        });
        continue;
      }

      // Nothing named yet means every cell, so the result is the divided body
      // rather than an empty model. It is typed rather than ticked, because
      // which cell is which only becomes clear once the cut has happened.
      const wanted = String(feature.cells ?? '')
        .split(/[\s,]+/)
        .filter((t) => t !== '')
        .map((t) => Number(t))
        .filter((v) => Number.isInteger(v) && v >= 0);
      bodies.splice(bodies.indexOf(target), 1);
      cells.forEach((cell, i) => {
        if (wanted.length && !wanted.includes(i)) return;
        addSolidBody(feature, cell);
      });
    }
  }

  /**
   * Swap a face of a solid for a surface.
   *
   * The surface cuts the body, and the piece the old face was on is thrown
   * away, which is exactly what replacing that face means: everything beyond
   * the new surface goes.
   */
  function doReplaceFace(feature, doc, scope, ks, errs) {
    const refs = feature.faces || [];
    if (!refs.length) throw new Error('Replace Face needs a face to replace');
    const tool = bodies.find((b) => b.id === feature.tool && isSheet(b));
    if (!tool) throw new Error('Replace Face needs a surface to replace it with');

    for (const ref of refs) {
      const found = findFace(ref);
      if (!found) {
        errs.push({ feature: feature.id, message: 'Replace Face lost the face it was on' });
        continue;
      }
      const body = bodies.find((b) => b.id === found.body.id);
      if (!body?.solid) continue;

      const span = spanOfBody(body) + 20;
      const half = sheetHalfSpace(tool.sheet, span, ks);
      if (!half) {
        errs.push({
          feature: feature.id,
          message: 'That surface curves back on itself, so it cannot replace a face.'
        });
        continue;
      }

      const near = K.intersection(body.solid, half, ks);
      const far = K.difference(body.solid, half, ks);
      if (K.isEmpty(near) || K.isEmpty(far)) {
        errs.push({
          feature: feature.id,
          message: 'That surface does not cross the body, so there is no face to replace'
        });
        continue;
      }

      // A speck just under the old face says which piece that face belongs to,
      // and that is the piece the new surface stands in for.
      const n = found.face.normal || [0, 0, 1];
      const probe = [
        found.face.centre[0] - n[0] * 0.05,
        found.face.centre[1] - n[1] * 0.05,
        found.face.centre[2] - n[2] * 0.05
      ];
      const keep = pointInside(near, probe, ks) ? far : near;
      replaceBody(bodies, body, { solid: keep });
    }
  }

  /**
   * Split a face along a surface, without changing the shape at all.
   *
   * The body is cut and put straight back together, which leaves the geometry
   * exactly as it was and the seam where the cut ran, so the two halves of the
   * face can be selected and treated separately from then on.
   */
  function doSplitFaceBySurface(feature, list, scope, ks, errs) {
    const tool = list.find((b) => b.id === feature.tool && isSheet(b));
    if (!tool) return null;
    const targets = pickBodies(feature, list);
    if (!targets.length) return list;

    const out = list.slice();
    for (const b of targets) {
      const span = spanOfBody(b) + 20;
      const half = sheetHalfSpace(tool.sheet, span, ks);
      if (!half) {
        errs.push({
          feature: feature.id,
          message: 'That surface curves back on itself, so it cannot split a face.'
        });
        continue;
      }
      const near = K.intersection(b.solid, half, ks);
      const far = K.difference(b.solid, half, ks);
      if (K.isEmpty(near) || K.isEmpty(far)) {
        errs.push({
          feature: feature.id,
          message: 'That surface does not cross this body, so there is nothing to split'
        });
        continue;
      }
      out[out.indexOf(b)] = { ...b, solid: K.union(near, far, ks) };
    }
    return out;
  }

  /**
   * Remove faces and close the hole they leave.
   *
   * The rest of the body is taken as a surface with a hole in it, the hole is
   * patched, and the result is stitched back into a solid. A hole whose rim is
   * flat closes exactly; one whose rim is not gets the simplest surface that
   * meets it.
   */
  function deleteFacesByPatching(feature, body, faceIds, topo, ks, errs) {
    const mesh = meshOf(body);
    const rest = SH.sheetWithoutFaces(mesh, topo, faceIds);
    if (!rest) {
      errs.push({ feature: feature.id, message: 'That would delete the whole body' });
      return null;
    }
    const P = SH.sheetPoints(rest);
    const patches = [];
    for (const loop of SH.boundaryLoops(rest)) {
      const patch = SH.patchLoops([loop.map((v) => P[v])]);
      if (patch) patches.push(patch);
    }
    if (!patches.length) {
      errs.push({ feature: feature.id, message: 'Nothing could close the hole those faces left' });
      return null;
    }

    const { sheet, closed, openEdges } = SH.stitchSheets([rest, ...patches], 1e-5);
    if (!closed) {
      errs.push({
        feature: feature.id,
        message: `Deleting those faces left ${openEdges} edges open, so the body would not be solid.`
      });
      return null;
    }
    let solid = null;
    try {
      solid = K.ofMesh(sheet.vertProperties, sheet.triVerts, ks);
    } catch {
      solid = null;
    }
    if (!solid || K.isEmpty(solid) || K.status(solid) !== 'NoError') {
      errs.push({
        feature: feature.id,
        message: 'The healed body runs into itself. Delete fewer faces at once.'
      });
      return null;
    }
    return solid;
  }

  /* ---------------------------------------------------------------- */
  /* Sheet metal                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * The rule a feature is made to, with every expression already worked out.
   *
   * A feature that names a rule uses that one; anything else uses the
   * document's active rule. Every field is an expression like any other, so a
   * thickness can be driven by a parameter and every part made to it follows.
   */
  function sheetRule(scope, feature) {
    normalizeSheetRules(doc);
    const wanted = feature?.rule || doc.sheetMetalRule;
    const r = { ...SM.DEFAULT_RULE, ...SM.ruleByName(doc.sheetMetalRules, wanted) };
    const num = (v, d) => (v === '' || v === null || v === undefined ? d : safeEval(v, scope, d));
    return {
      name: r.name,
      thickness: Math.max(1e-4, num(r.thickness, 1.5)),
      bendRadius: Math.max(0, num(r.bendRadius, 1.5)),
      kFactor: Math.min(0.5, Math.max(0, num(r.kFactor, 0.44))),
      gap: Math.max(0, num(r.gap, 0.2)),
      reliefShape: r.reliefShape || 'round',
      reliefWidth: num(r.reliefWidth, 0),
      reliefDepth: num(r.reliefDepth, 0),
      cornerShape: r.cornerShape || 'round',
      cornerSize: num(r.cornerSize, 0)
    };
  }

  /**
   * The rule a body already carries, rather than whatever is active now.
   *
   * A part records the rule it was built to. A later feature working on that
   * part has to cut at that thickness or the cut misses the material, which is
   * what would happen the moment a second rule entered the document.
   */
  function ruleOfBody(body, scope, feature) {
    const carried = body?.sheetMetal?.rule;
    if (carried && typeof carried.thickness === 'number') return carried;
    return sheetRule(scope, feature);
  }

  /** Every sheet metal body a feature was pointed at. */
  function pickSheetMetal(feature) {
    const wanted =
      feature.bodies && feature.bodies !== 'all' ? feature.bodies : null;
    return bodies.filter(
      (b) => b.sheetMetal && (!wanted || wanted.includes(b.id))
    );
  }

  /**
   * Build a part's solid, cut its bend reliefs, and put it in the model.
   *
   * Reliefs are cut rather than modelled into the panel outline, because a
   * relief is a notch taken out of the material after the fact and that is what
   * it has to look like on the flat as well as on the folded part.
   */
  function materialiseSheetPart(feature, part, rule, ks, existing, errs) {
    let solid;
    try {
      solid = SM.buildPart(part, ks, {
        thickness: rule.thickness,
        kFactor: rule.kFactor
      });
    } catch (err) {
      errs.push({ feature: feature.id, message: `Sheet metal: ${err.message}` });
      return null;
    }
    if (!solid || K.isEmpty(solid)) {
      errs.push({ feature: feature.id, message: 'That sheet metal part came to nothing' });
      return null;
    }
    solid = cutReliefs(part, rule, solid, ks);

    if (existing) {
      replaceBody(bodies, existing, { solid, sheetMetal: part });
      return existing;
    }
    const key = `${feature.id}:${bodies.length}`;
    const body = {
      id: key,
      name: doc.bodyNames?.[key] || `Sheet ${bodies.length + 1}`,
      solid,
      sheetMetal: part,
      createdBy: feature.id,
      component: feature.component || null
    };
    bodies.push(body);
    return body;
  }

  /** Take the relief notches out of the folded part. */
  function cutReliefs(part, rule, solid, ks) {
    const frames = SM.resolveFrames(part, rule.thickness, rule.kFactor, {});
    let out = solid;
    for (const bend of part.bends) {
      const pf = frames.get(bend.from);
      if (!pf) continue;
      const cuts = SM.reliefCuts(part, bend, rule.thickness, rule);
      for (const poly of cuts) {
        if (poly.length < 3) continue;
        try {
          // Through the material and a little past it, so the cut is clean at
          // both faces rather than leaving a film of a few microns.
          const prism = K.extrudeContours(
            [poly],
            { height: rule.thickness + 0.02 },
            ks
          );
          const placed = K.transform(
            prism,
            planeMatrix({
              origin: sketchToWorld(pf, 0, 0, -0.01).toArray(),
              x: pf.x,
              y: pf.y,
              n: pf.n
            }).elements,
            ks
          );
          out = K.difference(out, placed, ks);
        } catch {
          /* a relief that will not build is not worth losing the part over */
        }
      }
    }
    return out;
  }

  /**
   * The panel edge a picked model edge belongs to.
   *
   * A flange is taken off an edge of the folded part, but it has to be recorded
   * against the flat panel that edge belongs to, in that panel's own
   * coordinates. So every panel's boundary is walked in world space and the one
   * that lands on the picked edge is the answer.
   */
  function panelEdgeAt(part, frames, thickness, points) {
    if (!points || points.length < 2) return null;
    const mid = [
      (points[0][0] + points[points.length - 1][0]) / 2,
      (points[0][1] + points[points.length - 1][1]) / 2,
      (points[0][2] + points[points.length - 1][2]) / 2
    ];
    let best = null;
    for (const panel of part.panels) {
      const f = frames.get(panel.id);
      if (!f) continue;
      const c = panel.contour;
      for (let i = 0; i < c.length; i++) {
        const a = c[i];
        const b = c[(i + 1) % c.length];
        for (const w of [0, thickness]) {
          const A = SM.panelPointToWorld(f, a[0], a[1], w);
          const B = SM.panelPointToWorld(f, b[0], b[1], w);
          const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
          const d = Math.hypot(m[0] - mid[0], m[1] - mid[1], m[2] - mid[2]);
          if (!best || d < best.d) best = { d, panel, a, b };
        }
      }
    }
    return best && best.d < 1 ? best : null;
  }

  /**
   * Start a sheet metal part from a closed profile.
   *
   * Fusion's base flange: a flat sheet of the rule's thickness, in the plane
   * the profile was drawn on, and the root everything later hangs off.
   */
  function doBaseFlange(feature, doc, scope, ks, regionsById, errs) {
    const rule = sheetRule(scope, feature);
    const { contours, plane } = extrudeProfiles(feature, doc, scope, regionsById);
    if (!contours.length) throw new Error('Select a closed profile to make a sheet from');

    const part = SM.newPart(rule);
    let made = 0;
    for (const region of groupRings(contours)) {
      SM.addBasePanel(
        part,
        region.outer,
        region.holes,
        plane,
        `${feature.id}:p${made}`
      );
      made++;
      // One base panel per feature. A second profile is a second base flange,
      // which is a different part, not a second root of this one.
      break;
    }
    if (!made) throw new Error('Base flange found no closed profile');
    materialiseSheetPart(feature, part, rule, ks, null, errs);
  }

  /** A flange off one or more edges of a sheet metal part. */
  function doFlange(feature, scope, ks, errs) {
    const rule = sheetRule(scope, feature);
    const targets = pickSheetMetal(feature);
    if (!targets.length) throw new Error('Flange works on a sheet metal body');

    const angle = (safeEval(feature.angle, scope, 90) * Math.PI) / 180;
    const height = safeEval(feature.height, scope, 20);
    const radius = feature.radius ? safeEval(feature.radius, scope, rule.bendRadius) : rule.bendRadius;
    if (!(height > 1e-6)) throw new Error('A flange of no height is nothing');

    for (const body of targets) {
      const part = SM.clonePart(body.sheetMetal);
      const frames = SM.resolveFrames(part, rule.thickness, rule.kFactor, {});
      let n = 0;

      const mesh = meshOf(body);
      let topo;
      try {
        topo = buildTopology(mesh);
      } catch (err) {
        errs.push({ feature: feature.id, message: `Flange: ${err.message}` });
        continue;
      }

      for (const ref of feature.edges || []) {
        const [edge] = resolveEdgeRefs(topo, [ref]);
        if (!edge) {
          errs.push({ feature: feature.id, message: 'Flange lost the edge it was on' });
          continue;
        }
        const found = panelEdgeAt(part, frames, rule.thickness, edge.points);
        if (!found) {
          errs.push({
            feature: feature.id,
            message: 'That edge is not the boundary of a flat face, so no flange can grow from it'
          });
          continue;
        }

        // Where the bend sits relative to the edge that was picked. Each of
        // these is a real position of the arc, named for what lines up with the
        // edge: the flange's inner face, its outer face, the start of the bend,
        // or the point the arc is tangent at.
        const back =
          feature.bendPosition === 'outside'
            ? radius + rule.thickness
            : feature.bendPosition === 'inside'
              ? radius
              : feature.bendPosition === 'tangent'
                ? radius * Math.tan(Math.min(Math.abs(angle), Math.PI / 2) / 2)
                : 0;

        const line = SM.orientBendLine(found.panel.contour, { a: found.a, b: found.b });
        const shifted = shiftLineInto(found.panel.contour, line, back);

        const res = SM.addFlangePanel(part, found.panel.id, shifted, {
          angle,
          radius,
          height,
          panelId: `${feature.id}:p${n}`,
          bendId: `${feature.id}:b${n}`,
          relief: feature.relief !== false
        });
        if (res) n++;
      }
      if (!n) continue;
      materialiseSheetPart(feature, part, rule, ks, body, errs);
    }
  }

  /**
   * An edge folded back on itself.
   *
   * The same shape of work as a flange, and deliberately so: it finds the edge
   * the same way, backs the bend line off the same way, and hands the folding
   * to the part tree. What differs is only that a hem is one or two folds of
   * standard proportion rather than one fold of a stated height, which is why
   * it is worth a command instead of two flanges by hand.
   */
  function doHem(feature, scope, ks, errs) {
    const rule = sheetRule(scope, feature);
    const targets = pickSheetMetal(feature);
    if (!targets.length) throw new Error('Hem works on a sheet metal body');

    const length = safeEval(feature.length, scope, rule.thickness * 4);
    const radius = feature.radius
      ? safeEval(feature.radius, scope, rule.thickness)
      : rule.thickness;
    if (!(length > 1e-6)) throw new Error('A hem of no length is nothing');

    for (const body of targets) {
      const part = SM.clonePart(body.sheetMetal);
      const frames = SM.resolveFrames(part, rule.thickness, rule.kFactor, {});
      let n = 0;

      const mesh = meshOf(body);
      let topo;
      try {
        topo = buildTopology(mesh);
      } catch (err) {
        errs.push({ feature: feature.id, message: `Hem: ${err.message}` });
        continue;
      }

      for (const ref of feature.edges || []) {
        const [edge] = resolveEdgeRefs(topo, [ref]);
        if (!edge) {
          errs.push({ feature: feature.id, message: 'Hem lost the edge it was on' });
          continue;
        }
        const found = panelEdgeAt(part, frames, rule.thickness, edge.points);
        if (!found) {
          errs.push({
            feature: feature.id,
            message: 'That edge is not the boundary of a flat face, so nothing can be folded from it'
          });
          continue;
        }
        const line = SM.orientBendLine(found.panel.contour, { a: found.a, b: found.b });
        const shifted = shiftLineInto(found.panel.contour, line, radius);
        const made = SM.addHem(part, found.panel.id, shifted, {
          kind: feature.kind || 'single',
          thickness: rule.thickness,
          radius,
          length,
          angle: safeEval(feature.angle, scope, 270),
          angle1: safeEval(feature.angle1, scope, 135),
          angle2: safeEval(feature.angle2, scope, 90),
          relief: feature.relief !== false,
          id: `${feature.id}:${n}`
        });
        if (made) n++;
      }
      if (!n) continue;
      materialiseSheetPart(feature, part, rule, ks, body, errs);
    }
  }

  /**
   * A flange that changes shape as it goes, from one section to another.
   *
   * This is the one sheet metal feature that is not a fold. A transition from a
   * square duct to a round one has no bend line anywhere on it, so it cannot go
   * in the panel and bend tree and it has no flat pattern here. That is said
   * out loud rather than left to be discovered: the part is real and correct as
   * a solid, and it is not something this can unfold.
   */
  function doLoftedFlange(feature, doc, scope, ks, errs) {
    const rule = sheetRule(scope, feature);
    const runs = [];
    for (const id of [feature.sketch, feature.sketchTo]) {
      const sk = doc.sketches[id];
      if (!sk) throw new Error('A lofted flange needs two sketches');
      solveSketch(sk, { maxIterations: 40 });
      const plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);
      const chain = chainPath(sk, {});
      if (!chain?.points?.length) throw new Error(`${sk.name} has no chain of curves in it`);
      const pts = chain.points.map((q) => {
        const w = sketchToWorld(plane, q.x, q.y, q.z || 0);
        return [w.x, w.y, w.z];
      });
      // A closed section repeats its first point at the end. Left in, the loft
      // has a zero width face down one side of it.
      const first = pts[0];
      const last = pts[pts.length - 1];
      const meets =
        Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]) < 1e-6;
      runs.push({ points: meets && pts.length > 3 ? pts.slice(0, -1) : pts, closed: !!chain.closed || meets });
    }

    const around = Math.max(2, Math.round(safeEval(feature.around, scope, 24)));
    const resampled = runs.map((r) => SH.resampleRun(r.points, around, r.closed));
    if (resampled.some((r) => !r)) throw new Error('Those sections could not be read');

    const sheet = SH.loftRunsSheet(resampled, { closed: runs.every((r) => r.closed) });
    if (!sheet?.triVerts?.length) throw new Error('Nothing lofted between those sections');

    const thickness = feature.thickness
      ? safeEval(feature.thickness, scope, rule.thickness)
      : rule.thickness;
    const { sheet: solidMesh, closed } = SH.thickenSheet(sheet, thickness, false);
    if (!closed) {
      errs.push({
        feature: feature.id,
        message: 'That transition did not close when it was given thickness. Try fewer sections, or sections that face the same way.'
      });
      return;
    }

    let solid = null;
    try {
      solid = K.ofMesh(solidMesh.vertProperties, solidMesh.triVerts, ks);
    } catch {
      solid = null;
    }
    if (!solid || K.isEmpty(solid) || K.status(solid) !== 'NoError') {
      throw new Error('That transition runs into itself when it is given thickness');
    }

    const key = `${feature.id}:${bodies.length}`;
    bodies.push({
      id: key,
      name: doc.bodyNames?.[key] || feature.name || `Transition ${bodies.length + 1}`,
      solid,
      createdBy: feature.id,
      component: feature.component || null
    });
    errs.push({
      feature: feature.id,
      message: 'A lofted flange has no bend lines, so it has no flat pattern here.'
    });
  }

  /** Move a bend line back into the panel, square to itself. */
  function shiftLineInto(contour, line, distance) {
    if (!(Math.abs(distance) > 1e-9)) return line;
    const dx = line.b[0] - line.a[0];
    const dy = line.b[1] - line.a[1];
    const l = Math.hypot(dx, dy) || 1;
    // The panel is on the side the outward normal points away from.
    const into = [dy / l, -dx / l];
    const c = [0, 0];
    for (const p of contour) {
      c[0] += p[0] / contour.length;
      c[1] += p[1] / contour.length;
    }
    const sign =
      (c[0] - line.a[0]) * into[0] + (c[1] - line.a[1]) * into[1] > 0 ? 1 : -1;
    return {
      a: [line.a[0] + into[0] * sign * distance, line.a[1] + into[1] * sign * distance],
      b: [line.b[0] + into[0] * sign * distance, line.b[1] + into[1] * sign * distance]
    };
  }

  /**
   * A whole folded part from one open section, swept a width.
   *
   * Every straight run of the section is a panel and every corner between two
   * of them is a bend, which is exactly the model this file already keeps. So a
   * contour flange is not a special case: it is the general case, built in one
   * go from a drawing of the part's cross section.
   */
  function doContourFlange(feature, doc, scope, ks, errs) {
    const rule = sheetRule(scope, feature);
    const sk = doc.sketches[feature.sketch];
    if (!sk) throw new Error('Contour flange has no sketch');
    solveSketch(sk, { maxIterations: 40 });
    const plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);

    // An empty list means nothing was picked, so the whole sketch is the
    // section. Passing it straight through would filter every entity out,
    // because an empty array is truthy and chainPath believes it.
    const chain = chainPath(sk, {
      entities: feature.entities?.length ? feature.entities : undefined
    });
    if (!chain || chain.points.length < 2) {
      throw new Error('Contour flange needs one connected run of lines');
    }
    if (chain.closed) {
      throw new Error('Contour flange takes an open section. A closed one is a base flange.');
    }

    const width = safeEval(feature.width, scope, 40);
    if (!(width > 1e-6)) throw new Error('A contour flange of no width is nothing');
    const radius = feature.radius ? safeEval(feature.radius, scope, rule.bendRadius) : rule.bendRadius;

    // The section, thinned to its corners: a run of straight legs.
    const pts = [];
    for (const p of chain.points) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-7) pts.push(p);
    }
    const legs = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      const l = Math.hypot(dx, dy);
      if (l > 1e-7) legs.push({ from: pts[i - 1], to: pts[i], dir: [dx / l, dy / l], length: l });
    }
    if (!legs.length) throw new Error('That section has no length to it');

    // The first leg becomes the base panel. Its own frame runs along the leg,
    // across the width, and out of the section, which is the material's normal.
    const part = SM.newPart(rule);
    const start = sketchToWorld(plane, legs[0].from.x, legs[0].from.y, 0);
    const along = [
      plane.x[0] * legs[0].dir[0] + plane.y[0] * legs[0].dir[1],
      plane.x[1] * legs[0].dir[0] + plane.y[1] * legs[0].dir[1],
      plane.x[2] * legs[0].dir[0] + plane.y[2] * legs[0].dir[1]
    ];
    const wide = [plane.n[0], plane.n[1], plane.n[2]];
    const face = [
      along[1] * wide[2] - along[2] * wide[1],
      along[2] * wide[0] - along[0] * wide[2],
      along[0] * wide[1] - along[1] * wide[0]
    ];
    const baseFrame = {
      origin: [start.x, start.y, start.z],
      x: along,
      y: wide,
      n: face
    };

    SM.addBasePanel(
      part,
      [[0, 0], [legs[0].length, 0], [legs[0].length, width], [0, width]],
      [],
      baseFrame,
      `${feature.id}:p0`
    );

    let parentId = `${feature.id}:p0`;
    let reach = legs[0].length;
    for (let i = 1; i < legs.length; i++) {
      // How far the section turns at this corner, about the width direction.
      const a = legs[i - 1].dir;
      const b = legs[i].dir;
      const turn = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
      if (Math.abs(turn) < 1e-6) continue;

      const res = SM.addFlangePanel(
        part,
        parentId,
        { a: [reach, 0], b: [reach, width] },
        {
          angle: turn,
          radius,
          height: legs[i].length,
          panelId: `${feature.id}:p${i}`,
          bendId: `${feature.id}:b${i}`,
          relief: false
        }
      );
      if (!res) break;
      parentId = res.panel.id;
      reach = legs[i].length;
    }

    materialiseSheetPart(feature, part, rule, ks, null, errs);
  }

  /**
   * Fold a flat face along a sketched line.
   *
   * The side that stays keeps the panel and its frame; the side that moves
   * becomes a panel of its own, joined by a bend. Which side moves is the
   * stationary side turned round, so picking it is the whole of the input.
   */
  function doSheetFold(feature, doc, scope, ks, errs) {
    const rule = sheetRule(scope, feature);
    const targets = pickSheetMetal(feature);
    if (!targets.length) throw new Error('Fold works on a sheet metal body');

    const sk = doc.sketches[feature.sketch];
    if (!sk) throw new Error('Fold needs a sketch line to fold along');
    solveSketch(sk, { maxIterations: 40 });
    const plane = sketchPlanes[sk.id] || resolvePlane(sk.plane, scope, builtConstruction);

    const lines = sk.entities.filter(
      (e) => e.type === 'line' && !e.construction &&
        (!feature.entities?.length || feature.entities.includes(e.id))
    );
    if (!lines.length) throw new Error('Fold needs a straight sketch line');

    const angle = (safeEval(feature.angle, scope, 90) * Math.PI) / 180;
    const radius = feature.radius ? safeEval(feature.radius, scope, rule.bendRadius) : rule.bendRadius;

    for (const body of targets) {
      const part = SM.clonePart(body.sheetMetal);
      const frames = SM.resolveFrames(part, rule.thickness, rule.kFactor, {});
      let n = 0;

      for (const ent of lines) {
        const p0 = sk.points[ent.p[0]];
        const p1 = sk.points[ent.p[1]];
        const w0 = sketchToWorld(plane, p0.x, p0.y, 0);
        const w1 = sketchToWorld(plane, p1.x, p1.y, 0);

        // Which panel the line crosses, and where it lies in that panel.
        const hit = panelUnderLine(part, frames, [w0.x, w0.y, w0.z], [w1.x, w1.y, w1.z]);
        if (!hit) {
          errs.push({
            feature: feature.id,
            message: 'That line does not cross a flat face of this part'
          });
          continue;
        }
        const res = SM.foldPanel(part, hit.panel.id, hit.line, {
          angle,
          radius,
          thickness: rule.thickness,
          k: rule.kFactor,
          flip: !!feature.flip,
          bendLinePosition: feature.bendLinePosition || 'center',
          panelId: `${feature.id}:p${n}`,
          bendId: `${feature.id}:b${n}`
        });
        if (res) n++;
      }
      if (!n) continue;
      materialiseSheetPart(feature, part, rule, ks, body, errs);
    }
  }

  /** Which panel a world-space line lies on, and where in its own frame. */
  function panelUnderLine(part, frames, a, b) {
    let best = null;
    for (const panel of part.panels) {
      const f = frames.get(panel.id);
      if (!f) continue;
      const toLocal = (p) => {
        const d = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]];
        return {
          u: d[0] * f.x[0] + d[1] * f.x[1] + d[2] * f.x[2],
          v: d[0] * f.y[0] + d[1] * f.y[1] + d[2] * f.y[2],
          w: d[0] * f.n[0] + d[1] * f.n[1] + d[2] * f.n[2]
        };
      };
      const la = toLocal(a);
      const lb = toLocal(b);
      const off = Math.max(Math.abs(la.w), Math.abs(lb.w));
      if (!best || off < best.off) {
        best = { off, panel, line: { a: [la.u, la.v], b: [lb.u, lb.v] } };
      }
    }
    return best && best.off < 5 ? best : null;
  }

  /**
   * Flatten some or all of a part's bends, without making a new body.
   *
   * Unfold is a working state, not a result: it is how a hole gets drilled
   * across a bend. The flat pattern is the separate thing, and it has its own
   * body and its own place in the browser.
   */
  function doUnfold(feature, scope, ks, errs, refold) {
    const rule = sheetRule(scope, feature);
    const targets = pickSheetMetal(feature);
    if (!targets.length) throw new Error(`${refold ? 'Refold' : 'Unfold'} works on a sheet metal body`);

    for (const body of targets) {
      const part = SM.clonePart(body.sheetMetal);
      // Typed rather than picked, because a bend only gets a name once it
      // exists and the list has to survive a rebuild that renames nothing.
      const named = Array.isArray(feature.bends)
        ? feature.bends
        : String(feature.bends ?? '')
            .split(/[\s,]+/)
            .filter((t) => t !== '');
      const wanted = named.length ? named : null;
      let n = 0;
      for (const bend of part.bends) {
        if (wanted && !wanted.includes(bend.id)) continue;
        bend.unfolded = !refold;
        n++;
      }
      if (!n) {
        errs.push({ feature: feature.id, message: 'There are no bends to work on here' });
        continue;
      }
      materialiseSheetPart(feature, part, rule, ks, body, errs);
    }
  }

  /**
   * Cut a part so it can be unfolded.
   *
   * A shape that closes on itself has no flat, because there is no way to lay
   * it out without tearing it somewhere. Rip is choosing where that tear goes.
   */
  function doRip(feature, scope, ks, errs) {
    const targets = pickSheetMetal(feature);
    if (!targets.length) throw new Error('Rip works on a sheet metal body');

    for (const body of targets) {
      const rule = ruleOfBody(body, scope, feature);
      const gap = feature.gap ? safeEval(feature.gap, scope, rule.gap) : rule.gap;
      const mesh = meshOf(body);
      let topo;
      try {
        topo = buildTopology(mesh);
      } catch (err) {
        errs.push({ feature: feature.id, message: `Rip: ${err.message}` });
        continue;
      }
      let solid = body.solid;
      let n = 0;
      for (const ref of feature.edges || []) {
        const [edge] = resolveEdgeRefs(topo, [ref]);
        if (!edge || edge.points.length < 2) continue;
        const a = edge.points[0];
        const b = edge.points[edge.points.length - 1];
        const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const l = Math.hypot(dir[0], dir[1], dir[2]);
        if (!(l > 1e-6)) continue;
        // A slot of the rule's gap, run along the edge and through the sheet.
        const cutter = K.box([gap, l + gap, rule.thickness * 4], true, ks);
        const basis = basisFor([dir[0] / l, dir[1] / l, dir[2] / l]);
        const m = new THREE.Matrix4();
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        m.set(
          basis.x[0], basis.n[0], basis.y[0], mid[0],
          basis.x[1], basis.n[1], basis.y[1], mid[1],
          basis.x[2], basis.n[2], basis.y[2], mid[2],
          0, 0, 0, 1
        );
        solid = K.difference(solid, K.transform(cutter, m.elements, ks), ks);
        n++;
      }
      if (!n) {
        errs.push({ feature: feature.id, message: 'Rip needs an edge to tear along' });
        continue;
      }
      replaceBody(bodies, body, { solid });
    }
  }

  /**
   * The relief where two bends meet at a corner.
   *
   * Two flanges off adjoining edges collide at the corner between them, and
   * something has to give. The shape is the rule's, and it is cut through the
   * material at the point the two bend lines cross.
   */
  function doCornerRelief(feature, scope, ks, errs) {
    const targets = pickSheetMetal(feature);
    if (!targets.length) throw new Error('Corner Relief works on a sheet metal body');

    for (const body of targets) {
      const rule = ruleOfBody(body, scope, feature);
      if (rule.cornerShape === 'none') {
        errs.push({ feature: feature.id, message: 'The rule has corner relief turned off' });
        continue;
      }
      const size = rule.cornerSize > 0 ? rule.cornerSize : rule.thickness * 2;
      const part = body.sheetMetal;
      const frames = SM.resolveFrames(part, rule.thickness, rule.kFactor, {});
      let solid = body.solid;
      let n = 0;

      // Corners where three or more bends come together. These live in the
      // folded part rather than in any one panel, because the third bend
      // belongs to a panel that has already been folded away, so they are cut
      // in the world with a ball or a cube rather than flat with a polygon.
      const deep = SM.bendCorners(part, frames, rule.thickness).filter(
        (c) => c.bends.length >= 3
      );
      for (const corner of deep) {
        try {
          // Big enough to clear every bend zone that converges here, because
          // three thicknesses of material fold into this one point and a notch
          // that only clears two of them still tears.
          const r = Math.max(size / 2, corner.reach);
          const tool =
            rule.cornerShape === 'square'
              ? K.box([r * 2, r * 2, r * 2], true, ks)
              : K.sphere(r, circleSegments(r), ks);
          solid = K.difference(solid, K.translate(tool, corner.point, ks), ks);
          n++;
        } catch {
          /* a relief that will not build is not worth losing the part */
        }
      }
      const atDeepCorner = (world) =>
        deep.some(
          (c) =>
            Math.hypot(
              c.point[0] - world[0],
              c.point[1] - world[1],
              c.point[2] - world[2]
            ) < 1e-6
        );

      // Every pair of bends leaving the same panel that meet within the panel,
      // less the ones already taken care of as a deeper corner.
      for (const panel of part.panels) {
        const outgoing = SM.bendsFrom(part, panel.id);
        const f = frames.get(panel.id);
        if (!f || outgoing.length < 2) continue;
        for (let i = 0; i < outgoing.length; i++) {
          for (let j = i + 1; j < outgoing.length; j++) {
            const at = lineCross(outgoing[i], outgoing[j]);
            if (!at) continue;
            if (atDeepCorner(sketchToWorld(f, at[0], at[1], 0).toArray())) continue;
            const poly =
              rule.cornerShape === 'square'
                ? squareAt(at, size)
                : circleAt(at, size / 2);
            try {
              const prism = K.extrudeContours(
                [poly],
                { height: rule.thickness + 0.02 },
                ks
              );
              const placed = K.transform(
                prism,
                planeMatrix({
                  origin: sketchToWorld(f, 0, 0, -0.01).toArray(),
                  x: f.x,
                  y: f.y,
                  n: f.n
                }).elements,
                ks
              );
              solid = K.difference(solid, placed, ks);
              n++;
            } catch {
              /* a relief that will not build is not worth losing the part */
            }
          }
        }
      }
      if (!n) {
        errs.push({
          feature: feature.id,
          message: 'No two bends meet at a corner on this part'
        });
        continue;
      }
      replaceBody(bodies, body, { solid });
    }
  }

  /**
   * Cut the corners where two flanges run into each other.
   *
   * The part is rebuilt from its panels rather than cut as a solid, so the
   * miter shows on the flat pattern as well as on the folded part. A blank
   * that folds up with its corners fighting is a blank that was cut wrong, and
   * that is a thing the flat has to say.
   */
  function doMiter(feature, scope, ks, errs) {
    const targets = pickSheetMetal(feature);
    if (!targets.length) throw new Error('Miter works on a sheet metal body');

    for (const body of targets) {
      const rule = ruleOfBody(body, scope, feature);
      const gap = feature.gap ? safeEval(feature.gap, scope, rule.gap) : rule.gap;
      const part = SM.clonePart(body.sheetMetal);
      const frames = SM.resolveFrames(part, rule.thickness, rule.kFactor, {});
      const cut = SM.miterCorners(part, frames, Math.max(0, gap), {
        thickness: rule.thickness
      });
      if (!cut) {
        errs.push({
          feature: feature.id,
          message: 'No two flanges run into each other on this part'
        });
        continue;
      }
      materialiseSheetPart(feature, part, rule, ks, body, errs);
    }
  }

  /** Where two bend lines cross, in the panel they both leave. */
  function lineCross(p, q) {
    const r = [p.b[0] - p.a[0], p.b[1] - p.a[1]];
    const s = [q.b[0] - q.a[0], q.b[1] - q.a[1]];
    const denom = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((q.a[0] - p.a[0]) * s[1] - (q.a[1] - p.a[1]) * s[0]) / denom;
    return [p.a[0] + r[0] * t, p.a[1] + r[1] * t];
  }

  function squareAt(c, size) {
    const h = size / 2;
    return [
      [c[0] - h, c[1] - h],
      [c[0] + h, c[1] - h],
      [c[0] + h, c[1] + h],
      [c[0] - h, c[1] + h]
    ];
  }

  function circleAt(c, r) {
    const n = Math.max(12, K.circularSegments(r));
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
    return out;
  }

  /**
   * Read an ordinary solid as a folded sheet.
   *
   * What can be recovered is the flat faces and the bends between them, which
   * the topology already works out. What cannot be guessed is the thickness, so
   * the rule supplies it and a body that is not that thick is refused rather
   * than quietly converted into something a brake cannot make.
   */
  function doConvertToSheetMetal(feature, scope, ks, errs) {
    const rule = sheetRule(scope, feature);
    const targets = pickBodies(feature, bodies);
    if (!targets.length) throw new Error('Convert needs a solid body');

    for (const body of targets) {
      if (body.sheetMetal) continue;
      let topo;
      try {
        topo = buildTopology(meshOf(body));
      } catch (err) {
        errs.push({ feature: feature.id, message: `Convert: ${err.message}` });
        continue;
      }
      const read = SM.readSheetMetal(meshOf(body), topo, rule.thickness);
      if (!read) {
        errs.push({
          feature: feature.id,
          message: `Nothing in that body is ${rule.thickness} thick, which is what the rule says sheet is. Change the rule or the body.`
        });
        continue;
      }
      // The body keeps its shape; what it gains is a rule and the faces read as
      // panels, which is what every later sheet metal command needs from it.
      replaceBody(bodies, body, {
        sheetMetal: {
          rule,
          panels: [],
          bends: [],
          baseId: null,
          converted: read
        }
      });
    }
  }

  /**
   * The flat pattern, as a body of its own.
   *
   * Not a view of the folded part and not a state of it: a separate body with
   * its own place in the browser, which is what a drawing and a DXF are made
   * from. Fusion draws the same line and for the same reason.
   */
  function doFlatPattern(feature, scope, ks, errs) {
    const rule = sheetRule(scope, feature);
    const targets = pickSheetMetal(feature);
    if (!targets.length) throw new Error('Flat Pattern works on a sheet metal body');

    for (const body of targets) {
      const part = body.sheetMetal;
      if (!part.panels.length) {
        errs.push({
          feature: feature.id,
          message: 'That part has no panels to lay out. A converted body has to be given its bends first.'
        });
        continue;
      }
      let solid;
      try {
        solid = SM.buildPart(part, ks, {
          thickness: rule.thickness,
          kFactor: rule.kFactor,
          flat: true
        });
      } catch (err) {
        errs.push({ feature: feature.id, message: `Flat pattern: ${err.message}` });
        continue;
      }
      if (!solid || K.isEmpty(solid)) continue;

      // Laid where it was asked for, so the flat does not sit inside the part
      // it came from.
      const at = feature.at ? feature.at : [0, 0, 0];
      solid = K.translate(solid, at, ks);

      const key = `${feature.id}:${bodies.length}`;
      bodies.push({
        id: key,
        name: doc.bodyNames?.[key] || `${body.name} flat`,
        solid,
        flatOf: body.id,
        outline: SM.flatOutline(part, rule.thickness, rule.kFactor),
        createdBy: feature.id,
        component: feature.component || null
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Meshes                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Put a mesh into the model as a body.
   *
   * A mesh body is a sheet that has been told it is a mesh. Being a sheet is
   * what makes topology, display, picking and export work on it already; being
   * told is what keeps it out of the kernel until somebody asks for that, which
   * matters when it is a two million triangle scan.
   */
  function addMeshBody(feature, mesh, label, existing) {
    if (!mesh?.triVerts?.length) return null;
    if (existing) {
      replaceBody(bodies, existing, { sheet: mesh });
      return existing;
    }
    const key = `${feature.id}:${bodies.length}`;
    const body = {
      id: key,
      name: doc.bodyNames?.[key] || label || `Mesh ${bodies.length + 1}`,
      sheet: mesh,
      mesh: true,
      createdBy: feature.id,
      component: feature.component || null
    };
    bodies.push(body);
    return body;
  }

  /** Every mesh body a feature was pointed at. */
  function pickMeshes(feature) {
    const wanted = feature.bodies && feature.bodies !== 'all' ? feature.bodies : null;
    return bodies.filter((b) => b.mesh && (!wanted || wanted.includes(b.id)));
  }

  /** A stored mesh, back out of the document as typed arrays. */
  function storedMesh(key) {
    const held = doc.meshData?.[key];
    if (!held) return null;
    return {
      numProp: 3,
      vertProperties: new Float32Array(held.verts),
      triVerts: new Uint32Array(held.tris)
    };
  }

  /**
   * A mesh read off the disk, placed in the model.
   *
   * The triangles live in the document rather than in the feature, because
   * nothing in the timeline can reproduce them: they came from a file that may
   * not be there next time. That is the same reason a sketch is stored rather
   * than replayed.
   */
  function doInsertMesh(feature, scope, ks, errs) {
    const mesh = storedMesh(feature.data);
    if (!mesh) throw new Error('That inserted mesh is not in this document any more');

    let placed = mesh;
    const s = feature.scale ? safeEval(feature.scale, scope, 1) : 1;
    const at = feature.at || [0, 0, 0];
    if (Math.abs(s - 1) > 1e-9 || at.some((v) => Math.abs(v) > 1e-9)) {
      const P = MT.meshPoints(mesh).map((p) => [
        p[0] * s + at[0],
        p[1] * s + at[1],
        p[2] * s + at[2]
      ]);
      placed = SH.makeSheet(P, MT.meshTris(mesh));
    }
    addMeshBody(feature, placed, feature.label || 'Mesh');
  }

  /** A solid or a surface, taken as triangles so the mesh tools reach it. */
  function doTessellate(feature, scope, ks, errs) {
    const targets = pickBodies(feature, bodies, { sheets: 'either' });
    if (!targets.length) throw new Error('Tessellate needs a body');
    let made = 0;
    for (const b of targets) {
      if (b.mesh) continue;
      const mesh = meshOf(b);
      if (!mesh?.triVerts?.length) continue;
      // A copy, because the body it came from stays where it is: tessellating
      // is taking a mesh from something, not turning it into one.
      const copy = SH.makeSheet(MT.meshPoints(mesh), MT.meshTris(mesh));
      if (addMeshBody(feature, copy, `${b.name} mesh`)) made++;
    }
    if (!made) errs.push({ feature: feature.id, message: 'Tessellate produced nothing' });
  }

  /** Weld, drop what is degenerate, agree on which way is out, close the holes. */
  /**
   * Join triangles that only nearly meet, and nothing else.
   *
   * The half of Repair that closes gaps, on its own, because the tolerance is a
   * real decision and doing it apart from hole filling is what lets it be
   * raised and looked at again.
   */
  function doMeshStitch(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Stitch works on a mesh body');
    const tol = feature.tolerance ? safeEval(feature.tolerance, scope, 1e-4) : 1e-4;
    for (const b of targets) {
      const out = MT.stitchMesh(b.sheet, tol);
      replaceBody(bodies, b, { sheet: out.mesh });
      if (out.openAfter) {
        errs.push({
          feature: feature.id,
          message: `${b.name}: ${out.joined} points joined, ${out.openAfter} edges still open. Raise the tolerance, or use Patch.`
        });
      }
    }
  }

  /**
   * Fill the holes in a mesh, or only the ones small enough to be faults.
   *
   * Filling every hole is wrong as often as it is right: a scan has a hundred
   * pinholes worth closing and one big opening where the part was cut off, and
   * closing that one turns the part into a bag.
   */
  function doMeshPatch(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Patch works on a mesh body');
    const limit = feature.maxPerimeter ? safeEval(feature.maxPerimeter, scope, 0) : 0;
    for (const b of targets) {
      const out = MT.patchMesh(b.sheet, { maxPerimeter: limit });
      if (!out.filled && !out.left) continue;
      replaceBody(bodies, b, { sheet: out.mesh });
      if (out.left) {
        errs.push({
          feature: feature.id,
          message: `${b.name}: ${out.filled} filled, ${out.left} left open as too big to be a fault.`
        });
      }
    }
  }

  /**
   * Move part of a mesh, without history and without recognising anything.
   *
   * What an imported mesh actually needs: a boss in the wrong place moved a
   * millimetre, without converting the whole thing to a solid first. The
   * falloff is what keeps the surface continuous, so what moves is a region
   * rather than a plate with torn edges.
   */
  function doMeshDirectEdit(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Direct Edit works on a mesh body');
    const distance = safeEval(feature.distance, scope, 0);
    if (Math.abs(distance) < 1e-9) return;
    const reach = Math.max(0, safeEval(feature.falloff, scope, 0));

    for (const b of targets) {
      const chosen = (feature.faces || [])
        .filter((f) => f.body === b.id)
        .map((f) => f.face);
      if (!chosen.length) continue;

      let topo;
      try {
        topo = buildTopology(b.sheet);
      } catch (err) {
        errs.push({ feature: feature.id, message: `Direct Edit: ${err.message}` });
        continue;
      }
      const tris = [];
      let normal = [0, 0, 1];
      let found = 0;
      for (const id of chosen) {
        const face = topo.faces[id];
        if (!face) continue;
        tris.push(...face.tris);
        normal = found === 0 ? face.normal.slice() : normal;
        found++;
      }
      if (!tris.length) continue;

      const dir = feature.direction === 'z'
        ? [0, 0, 1]
        : feature.direction === 'y'
          ? [0, 1, 0]
          : feature.direction === 'x'
            ? [1, 0, 0]
            : normal;
      const verts = MT.vertsOfTriangles(b.sheet, tris);
      const weights = MT.meshVertexWeights(b.sheet, verts, reach);
      const shift = [dir[0] * distance, dir[1] * distance, dir[2] * distance];
      replaceBody(bodies, b, { sheet: MT.shiftMeshPoints(b.sheet, weights, shift) });
    }
  }

  function doMeshRepair(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Repair works on a mesh body');
    for (const b of targets) {
      const fixed = MT.repairMesh(b.sheet, {
        tolerance: feature.tolerance ? safeEval(feature.tolerance, scope, 1e-4) : 1e-4,
        fillHoles: feature.fillHoles !== false,
        orient: feature.orient !== false
      });
      replaceBody(bodies, b, { sheet: fixed });
    }
  }

  /** Fewer triangles, in the places that cost the least shape. */
  function doMeshReduce(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Reduce works on a mesh body');
    for (const b of targets) {
      const opts =
        feature.by === 'count'
          ? { triangles: safeEval(feature.triangles, scope, 1000) }
          : { ratio: Math.min(1, Math.max(0.01, safeEval(feature.ratio, scope, 50) / 100)) };
      replaceBody(bodies, b, { sheet: MT.reduceMesh(b.sheet, opts) });
    }
  }

  /** Triangles of one size, everywhere. */
  function doMeshRemesh(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Remesh works on a mesh body');
    for (const b of targets) {
      const edge = feature.edgeLength ? safeEval(feature.edgeLength, scope, 0) : 0;
      replaceBody(bodies, b, {
        sheet: MT.remesh(b.sheet, {
          edgeLength: edge > 0 ? edge : undefined,
          divisions: safeEval(feature.density, scope, 40),
          iterations: Math.round(safeEval(feature.iterations, scope, 4)),
          project: feature.project !== false
        })
      });
    }
  }

  /** Take the roughness out, without taking the size out with it. */
  function doMeshSmooth(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Smooth works on a mesh body');
    for (const b of targets) {
      replaceBody(bodies, b, {
        sheet: MT.smoothMesh(b.sheet, {
          iterations: Math.round(safeEval(feature.iterations, scope, 5)),
          strength: Math.min(1, Math.max(0, safeEval(feature.strength, scope, 0.5))),
          shrink: !!feature.allowShrink,
          holdBoundary: feature.holdBoundary !== false
        })
      });
    }
  }

  /** Cut a mesh with a plane: keep one side, keep both, or only mark the cut. */
  function doMeshPlaneCut(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Plane Cut works on a mesh body');
    const plane = resolvePlane(feature.plane || 'XY', scope, builtConstruction);
    if (!plane) throw new Error('Plane Cut needs a plane to cut with');

    for (const b of targets) {
      const pieces = MT.planeCut(b.sheet, plane, {
        mode: feature.mode || 'trim',
        keep: feature.flip ? 'far' : 'near',
        fill: feature.fill !== false
      });
      if (!pieces.length) {
        errs.push({
          feature: feature.id,
          message: 'That plane does not cross the mesh, so there is nothing to cut'
        });
        continue;
      }
      replaceBody(bodies, b, { sheet: pieces[0] });
      for (let i = 1; i < pieces.length; i++) {
        addMeshBody(feature, pieces[i], `${b.name} ${i + 1}`);
      }
    }
  }

  /** The pieces of a mesh that do not touch each other, each as its own body. */
  function doMeshSeparate(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Separate works on a mesh body');
    for (const b of targets) {
      const pieces = MT.separateMesh(b.sheet);
      if (pieces.length < 2) {
        errs.push({
          feature: feature.id,
          message: `${b.name} is all one piece, so there is nothing to separate`
        });
        continue;
      }
      replaceBody(bodies, b, { sheet: pieces[0] });
      for (let i = 1; i < pieces.length; i++) {
        addMeshBody(feature, pieces[i], `${b.name} ${i + 1}`);
      }
    }
  }

  /** Several mesh bodies as one. */
  function doMeshMerge(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (targets.length < 2) throw new Error('Merge needs two or more mesh bodies');
    const merged = MT.mergeMeshes(targets.map((b) => b.sheet));
    const first = targets[0];
    for (let i = 1; i < targets.length; i++) {
      bodies.splice(bodies.indexOf(targets[i]), 1);
    }
    replaceBody(bodies, first, { sheet: merged });
  }

  /**
   * Take faces out, and either leave the hole or close it.
   *
   * Erase and Fill is the second of those, and it is the one that earns its
   * keep: a scan with a lump of noise in it is fixed by deleting the lump and
   * letting the surface close over where it was.
   */
  function doMeshErase(feature, scope, ks, errs) {
    const refs = feature.faces || [];
    if (!refs.length) throw new Error('Pick the faces to remove');

    const byBody = new Map();
    for (const ref of refs) {
      const found = findFace(ref);
      if (!found?.body?.mesh) continue;
      if (!byBody.has(found.body.id)) byBody.set(found.body.id, { found, ids: [] });
      byBody.get(found.body.id).ids.push(found.face.id);
    }
    if (!byBody.size) throw new Error('None of those faces are on a mesh body');

    for (const { found, ids } of byBody.values()) {
      const body = bodies.find((b) => b.id === found.body.id);
      if (!body) continue;
      const rest = SH.sheetWithoutFaces(meshOf(body), found.topo, ids);
      if (!rest) {
        errs.push({ feature: feature.id, message: 'That would remove the whole mesh' });
        continue;
      }
      replaceBody(bodies, body, {
        sheet: feature.fill === false ? rest : MT.repairMesh(rest, { fillHoles: true, orient: false })
      });
    }
  }

  /** Turn a mesh inside out. */
  function doMeshReverse(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Reverse Normal works on a mesh body');
    for (const b of targets) replaceBody(bodies, b, { sheet: SH.reverseSheet(b.sheet) });
  }

  /**
   * A mesh as a solid, if it is closed enough to be one.
   *
   * The check is not a formality. manifold will take a mesh with holes in it
   * and hand back something that looks right and is not watertight, and by the
   * time that shows up it is in a printed part. So the mesh is repaired first
   * if asked, measured, and only then handed over.
   */
  function doConvertMesh(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Convert Mesh works on a mesh body');

    for (const b of targets) {
      let mesh = b.sheet;
      if (feature.repair !== false) mesh = MT.repairMesh(mesh, { fillHoles: true });

      const health = MT.meshHealth(mesh);
      if (!health.closed) {
        errs.push({
          feature: feature.id,
          message: `${b.name} is not closed: ${health.openEdges} open edge${
            health.openEdges === 1 ? '' : 's'
          }${health.nonManifold ? ` and ${health.nonManifold} edges with three or more faces` : ''}. Repair it first.`
        });
        continue;
      }

      let solid = null;
      try {
        solid = K.ofMesh(mesh.vertProperties, mesh.triVerts, ks);
      } catch (err) {
        errs.push({ feature: feature.id, message: `Convert Mesh: ${err.message}` });
        continue;
      }
      if (!solid || K.isEmpty(solid) || K.status(solid) !== 'NoError') {
        errs.push({
          feature: feature.id,
          message: `${b.name} closes but runs into itself, so it is not a solid.`
        });
        continue;
      }
      const idx = bodies.indexOf(b);
      bodies[idx] = {
        id: b.id,
        name: b.name,
        solid,
        createdBy: feature.id,
        component: b.component || null
      };
    }
  }

  /**
   * Push a mesh's surface in and out by the brightness of an image.
   *
   * A texture that is really there, in the geometry, so it survives being
   * sliced and printed. The image is laid over the mesh along a plane and each
   * vertex moves along its own normal.
   */
  function doTextureExtrude(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Texture Extrude works on a mesh body');
    const held = doc.imageData?.[feature.image];
    if (!held) throw new Error('That image is not in this document any more');

    const plane = resolvePlane(feature.plane || 'XY', scope, builtConstruction);
    if (!plane) throw new Error('Texture Extrude needs a plane to lay the image on');

    const { width: iw, height: ih, gray } = held;
    const sample = (u, v) => {
      const x = Math.min(iw - 1, Math.max(0, Math.round(u * (iw - 1))));
      // Image rows run down the picture and v runs up the plane.
      const y = Math.min(ih - 1, Math.max(0, Math.round((1 - v) * (ih - 1))));
      return gray[y * iw + x] / 255;
    };

    for (const b of targets) {
      replaceBody(bodies, b, {
        sheet: MT.displaceByImage(b.sheet, sample, {
          plane,
          height: safeEval(feature.height, scope, 1),
          width: safeEval(feature.size, scope, 50),
          invert: !!feature.invert
        })
      });
    }
  }

  /**
   * Regroup a mesh's triangles into faces at a chosen angle.
   *
   * A face group is what makes a scan selectable: without one every triangle is
   * its own face and nothing can be pointed at. Anvil works these out on every
   * rebuild anyway, so this is a matter of saying at what angle two triangles
   * stop being the same surface, and remembering the answer.
   */
  function doFaceGroups(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Face groups are worked out on a mesh body');
    const angle = safeEval(feature.angle, scope, 30);
    for (const b of targets) {
      // Regenerating throws the hand set groups away, which is what it is for:
      // it is the way back to letting the angle decide.
      replaceBody(bodies, b, { groupAngle: angle, groupLabels: null });
    }
  }

  /**
   * Face groups set by hand rather than worked out from the angle.
   *
   * The angle is a good first guess and a poor last word. On a scan there is no
   * angle that keeps a moulded corner whole and still separates the two flats
   * beside it, so at some point the answer has to be pointed at rather than
   * calculated. A group set here holds whatever the angle says, and Generate
   * Face Groups is the way back.
   *
   * Pinning keeps each picked face as it stands. Combining makes one face of
   * them all. Releasing hands them back to the angle.
   */
  function doFaceGroupEdit(feature, scope, ks, errs) {
    const targets = pickMeshes(feature);
    if (!targets.length) throw new Error('Face groups are set on a mesh body');
    const op = feature.op || 'combine';

    for (const b of targets) {
      const mesh = meshOf(b);
      const triCount = mesh.triVerts.length / 3;
      let topo;
      try {
        topo = buildTopology(
          mesh,
          topologyOptions(b)
        );
      } catch (err) {
        errs.push({ feature: feature.id, message: `Face groups: ${err.message}` });
        continue;
      }

      const wanted = (feature.faces || [])
        .filter((r) => r.bodyId === b.id || !r.bodyId)
        .map((r) => r.face || r);
      const faces = resolveFaceRefs(topo, wanted);
      if (!faces.length) {
        errs.push({ feature: feature.id, message: 'No face on that body to group' });
        continue;
      }

      const labels = new Int32Array(triCount).fill(-1);
      if (b.groupLabels && b.groupLabels.length === triCount) labels.set(b.groupLabels);
      let next = 0;
      for (let t = 0; t < triCount; t++) next = Math.max(next, labels[t] + 1);

      if (op === 'release') {
        for (const face of faces) for (const t of face.tris) labels[t] = -1;
      } else if (op === 'pin') {
        for (const face of faces) {
          const id = next++;
          for (const t of face.tris) labels[t] = id;
        }
      } else {
        const id = next++;
        for (const face of faces) for (const t of face.tris) labels[t] = id;
      }

      let any = false;
      for (let t = 0; t < triCount; t++) if (labels[t] >= 0) any = true;
      replaceBody(bodies, b, { groupLabels: any ? labels : null });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Forms                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * A form in the model.
   *
   * One timeline entry per form, the way Fusion does it: the cage is edited in
   * place rather than through a feature per change, because a hundred pushes
   * and pulls on a cage are one act of shaping and not a hundred features. The
   * cage lives in the document beside the sketches, for the same reason a sketch
   * does: nothing in the timeline can reproduce it.
   */
  function doForm(feature, doc, scope, ks, errs) {
    const cage = doc.forms?.[feature.form];
    if (!cage) throw new Error('That form is not in this document any more');
    if (!cage.faces?.length) throw new Error('That form has no faces yet');

    const levels = Math.max(0, Math.min(4, Math.round(safeEval(feature.levels, scope, 2))));
    const display = feature.display || 'control';

    // Box and Control Frame show the cage, because that is what is being
    // worked on and what has to be pointed at. Smooth shows the surface it
    // stands for, and nothing on it is selectable, which is the honest state
    // of affairs rather than a limitation to apologise for.
    const cageMesh = FM.cageToMesh(cage);
    const smooth = FM.formMesh(cage, levels);

    const key = `${feature.id}:${bodies.length}`;
    bodies.push({
      id: key,
      name: doc.bodyNames?.[key] || feature.name || `Form ${bodies.length + 1}`,
      sheet: display === 'smooth' ? smooth : cageMesh,
      form: feature.form,
      cage,
      levels,
      display,
      // What the viewport draws over the top: the smooth surface while the cage
      // is the thing being picked.
      overlayMesh: display === 'control' ? smooth : null,
      createdBy: feature.id,
      component: feature.component || null
    });
  }

  /** Every form body a feature was pointed at. */
  function pickForms(feature) {
    const wanted = feature.bodies && feature.bodies !== 'all' ? feature.bodies : null;
    return bodies.filter((b) => b.form && (!wanted || wanted.includes(b.id)));
  }

  /**
   * Turn a form into a solid the rest of the app can work with.
   *
   * Up to this point a form is a surface: you can shape it, but you cannot cut
   * a hole in it or measure what it weighs. Finishing is where it crosses over,
   * and a form that does not close is refused rather than handed to the kernel,
   * for the same reason an open mesh is.
   */
  function doFinishForm(feature, doc, scope, ks, apply, errs) {
    const targets = pickForms(feature);
    if (!targets.length) throw new Error('Finish Form works on a form body');

    for (const body of targets) {
      const levels = Math.max(
        0,
        Math.min(4, Math.round(safeEval(feature.levels, scope, body.levels ?? 2)))
      );
      const mesh = FM.formMesh(body.cage, levels);
      const health = MT.meshHealth(mesh);
      if (!health.closed) {
        errs.push({
          feature: feature.id,
          message: `${body.name} is not closed: ${health.openEdges} open edge${
            health.openEdges === 1 ? '' : 's'
          }. Fill the holes, or thicken it instead of finishing it.`
        });
        continue;
      }

      let solid = null;
      try {
        solid = K.ofMesh(mesh.vertProperties, mesh.triVerts, ks);
      } catch (err) {
        errs.push({ feature: feature.id, message: `Finish Form: ${err.message}` });
        continue;
      }
      if (!solid || K.isEmpty(solid) || K.status(solid) !== 'NoError') {
        errs.push({
          feature: feature.id,
          message: `${body.name} closes but runs into itself, so it is not a solid.`
        });
        continue;
      }
      bodies.splice(bodies.indexOf(body), 1);
      apply(feature, solid, feature.op || 'new');
    }
  }

  /**
   * Give an open form thickness, and so a solid.
   *
   * A form that is a sheet rather than a shell has no inside to fill, so this
   * is how it becomes something printable: the same offset both ways and a wall
   * round the rim, which is what Thicken does everywhere else in the app.
   */
  function doFormThicken(feature, doc, scope, ks, apply, errs) {
    const targets = pickForms(feature);
    if (!targets.length) throw new Error('Thicken works on a form body');
    const distance = safeEval(feature.distance, scope, 2);
    if (Math.abs(distance) < 1e-9) throw new Error('Thicken needs a thickness');

    for (const body of targets) {
      const levels = Math.max(
        0,
        Math.min(4, Math.round(safeEval(feature.levels, scope, body.levels ?? 2)))
      );
      const mesh = FM.formMesh(body.cage, levels);
      const { sheet, closed } = SH.thickenSheet(mesh, distance, !!feature.symmetric);
      if (!closed) {
        errs.push({
          feature: feature.id,
          message: `${body.name} did not close when thickened, so it cannot become a solid.`
        });
        continue;
      }
      let solid = null;
      try {
        solid = K.ofMesh(sheet.vertProperties, sheet.triVerts, ks);
      } catch {
        solid = null;
      }
      if (!solid || K.isEmpty(solid) || K.status(solid) !== 'NoError') {
        errs.push({
          feature: feature.id,
          message: `Thickening ${body.name} made it run into itself. Try a smaller thickness.`
        });
        continue;
      }
      if (!feature.keepForm) bodies.splice(bodies.indexOf(body), 1);
      apply(feature, solid, feature.op || 'new');
    }
  }

  function pickBodies(feature, bodies, opts = {}) {
    // Solid features must never be handed a sheet. Surface features say so.
    const kind = opts.sheets === true
      ? (b) => isSheet(b)
      : opts.sheets === 'either'
        ? () => true
        : (b) => !!b.solid;
    const pool = bodies.filter(kind);
    if (!feature.bodies || feature.bodies === 'all') return pool;
    return pool.filter((b) => feature.bodies.includes(b.id));
  }
}

/**
 * A coil's section, in the sweep's own (radial, axial) frame.
 *
 * Fusion measures a section across the circle it is inscribed in, so a square
 * of "size 4" is 2.83 across its flats. The triangles point outward or inward
 * from the coil axis, which is what makes an internal one usable as a cutter.
 */
function coilSection(kind, r, offset) {
  if (kind === 'square') {
    const h = r * Math.SQRT1_2;
    return [
      [offset - h, -h],
      [offset + h, -h],
      [offset + h, h],
      [offset - h, h]
    ];
  }
  if (kind === 'triExt' || kind === 'triInt') {
    const s = kind === 'triExt' ? 1 : -1;
    const pts = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      pts.push([offset + s * r * Math.cos(a), r * Math.sin(a)]);
    }
    return pts;
  }
  const n = Math.max(12, K.circularSegments(r));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([offset + r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

/**
 * Put extra points along a contour so no segment spans more than `maxStep` in
 * X. Only X matters: it is the axis about to be wrapped into an arc, and a long
 * straight run across it would bend into a chord that sinks under the surface.
 */
function resampleAlongX(loop, maxStep) {
  const out = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    out.push(a);
    const dx = Math.abs(b[0] - a[0]);
    const steps = Math.floor(dx / maxStep);
    for (let k = 1; k <= steps; k++) {
      const t = k / (steps + 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function normalizeVec(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/* ------------------------------------------------------------------ */
/* Feature descriptions for the timeline                               */
/* ------------------------------------------------------------------ */

export const FEATURE_LABELS = {
  sketch: 'Sketch',
  form: 'Form',
  finishForm: 'Finish Form',
  formThicken: 'Thicken Form',
  insertMesh: 'Insert Mesh',
  tessellate: 'Tessellate',
  meshRepair: 'Repair',
  meshStitch: 'Stitch Mesh',
  meshPatch: 'Patch Mesh',
  meshDirectEdit: 'Direct Edit',
  meshReduce: 'Reduce',
  meshRemesh: 'Remesh',
  meshSmooth: 'Smooth',
  meshPlaneCut: 'Plane Cut',
  meshSeparate: 'Separate',
  meshMerge: 'Merge Bodies',
  meshErase: 'Erase And Fill',
  meshReverse: 'Reverse Normal',
  convertMesh: 'Convert Mesh',
  textureExtrude: 'Texture Extrude',
  faceGroups: 'Face Groups',
  faceGroupEdit: 'Face Group',
  baseFlange: 'Base Flange',
  flange: 'Flange',
  contourFlange: 'Contour Flange',
  sheetFold: 'Fold',
  unfold: 'Unfold',
  refold: 'Refold',
  rip: 'Rip',
  cornerRelief: 'Corner Relief',
  miter: 'Miter',
  convertToSheetMetal: 'Convert To Sheet Metal',
  flatPattern: 'Flat Pattern',
  hem: 'Hem',
  loftedFlange: 'Lofted Flange',
  surfaceExtrude: 'Extrude Surface',
  surfaceRevolve: 'Revolve Surface',
  surfaceSweep: 'Sweep Surface',
  surfaceLoft: 'Loft Surface',
  patch: 'Patch',
  ruled: 'Ruled Surface',
  offsetSurface: 'Offset Surface',
  trimSurface: 'Trim Surface',
  extendSurface: 'Extend Surface',
  untrimSurface: 'Untrim Surface',
  mergeSurface: 'Merge Surfaces',
  stitch: 'Stitch',
  unstitch: 'Unstitch',
  reverseNormal: 'Reverse Normal',
  thicken: 'Thicken',
  boundaryFill: 'Boundary Fill',
  replaceFace: 'Replace Face',
  boss: 'Boss',
  rest: 'Rest',
  snapFit: 'Snap Fit',
  lip: 'Lip',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  shell: 'Shell',
  offsetFace: 'Press Pull',
  loft: 'Loft',
  sweep: 'Sweep',
  rib: 'Rib',
  draft: 'Draft',
  split: 'Split Body',
  thread: 'Thread',
  construction: 'Construction',
  patternPath: 'Path Pattern',
  patternFeature: 'Feature Pattern',
  extrude: 'Extrude',
  revolve: 'Revolve',
  primitive: 'Primitive',
  hole: 'Hole',
  mirror: 'Mirror',
  patternRect: 'Rectangular Pattern',
  patternCircular: 'Circular Pattern',
  move: 'Move',
  scale: 'Scale',
  combine: 'Combine',
  coil: 'Coil',
  emboss: 'Emboss',
  web: 'Web',
  align: 'Align',
  deleteFace: 'Delete Face',
  silhouetteSplit: 'Silhouette Split',
  splitFace: 'Split Face'
};

export function featureLabel(doc, feature) {
  if (feature.name) return feature.name;
  if (feature.type === 'sketch') {
    return doc.sketches[feature.sketch]?.name || 'Sketch';
  }
  if (feature.type === 'form') {
    return doc.forms[feature.form]?.name || 'Form';
  }
  if (feature.type === 'primitive') {
    const s = feature.shape || 'box';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return FEATURE_LABELS[feature.type] || feature.type;
}

export { BASE_PLANES, tessellate };
