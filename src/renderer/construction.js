/**
 * Construction geometry: planes, axes and points that exist to be referenced.
 *
 * These are the stable things to hang a model on. A sketch attached to a model
 * face has to find that face again after every rebuild and can lose it; a
 * sketch on a plane defined as "thirty millimetres above XY" cannot. That is
 * why experienced modelling leans on construction geometry rather than on
 * picked faces wherever there is a choice.
 *
 * Everything here is derived, never stored as coordinates: each entry says how
 * to build itself from things earlier in the document, and is rebuilt in order.
 */

import { basisFor, dot, cross, sub, add, scale, norm, len } from './topology.js';
import { safeEval } from './expr.js';

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Work out every construction entry.
 *
 * @param entries  doc.construction
 * @param ctx      { scope, basePlane(name), sketchPoint(ref), edgeFor(ref),
 *                   faceFor(ref) }
 * @returns Map of id to a resolved plane, axis or point.
 */
export function resolveConstruction(entries, ctx) {
  const resolved = new Map();
  const errors = [];

  // Entries are built one at a time as the timeline reaches them, so anything
  // referenced was resolved on an earlier pass and lives in ctx.previous.
  const lookUp = (id) => resolved.get(id) || (ctx.previous && ctx.previous.get(id));

  const planeOf = (ref) => {
    if (!ref) return null;
    if (typeof ref === 'string') {
      if (ref.startsWith('c:')) {
        const r = lookUp(ref.slice(2));
        return r && r.kind === 'plane' ? r : null;
      }
      return ctx.basePlane(ref);
    }
    if (ref.construction) {
      const r = lookUp(ref.construction);
      return r && r.kind === 'plane' ? r : null;
    }
    if (ref.face) {
      const face = ctx.faceFor(ref.face);
      if (!face || !face.planar) return null;
      const basis = basisFor(face.normal);
      return { kind: 'plane', origin: face.centre, x: basis.x, y: basis.y, n: basis.n };
    }
    return null;
  };

  const axisOf = (ref) => {
    if (!ref) return null;
    if (typeof ref === 'string' && ref.startsWith('c:')) {
      const r = lookUp(ref.slice(2));
      return r && r.kind === 'axis' ? r : null;
    }
    if (ref.construction) {
      const r = lookUp(ref.construction);
      return r && r.kind === 'axis' ? r : null;
    }
    if (ref.edge) {
      const edge = ctx.edgeFor(ref.edge);
      if (!edge || edge.kind !== 'line') return null;
      return { kind: 'axis', origin: edge.start, dir: edge.dir };
    }
    if (ref.worldAxis) {
      const dirs = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
      const dir = dirs[ref.worldAxis];
      return dir ? { kind: 'axis', origin: [0, 0, 0], dir } : null;
    }
    return null;
  };

  /**
   * A curve to measure along, as a run of world points.
   *
   * A sketch chain or a model edge both serve, and both arrive already
   * tessellated, so "a fraction of the way along" is arc length over that run
   * rather than a parameter nobody can picture.
   */
  const pathOf = (ref) => {
    if (!ref) return null;
    if (ref.edge) {
      const edge = ctx.edgeFor(ref.edge);
      return edge?.points?.length > 1 ? edge.points : null;
    }
    if (ref.sketch !== undefined && ctx.sketchPath) {
      const pts = ctx.sketchPath(ref);
      return pts?.length > 1 ? pts : null;
    }
    return null;
  };

  const pointOf = (ref) => {
    if (!ref) return null;
    if (ref.construction) {
      const r = lookUp(ref.construction);
      return r && r.kind === 'point' ? r.p : null;
    }
    if (ref.sketch !== undefined) return ctx.sketchPoint(ref);
    if (ref.xyz) return ref.xyz;
    return null;
  };

  for (const entry of entries || []) {
    try {
      const built = buildEntry(entry, { ...ctx, planeOf, axisOf, pointOf, pathOf, resolved });
      if (built) {
        resolved.set(entry.id, { ...built, id: entry.id, name: entry.name });
        // A coordinate system is not one thing, it is seven, and every one of
        // them has to be referenceable or it is only a picture of a frame. They
        // go in under their own ids so a plane dropdown, a sketch, a mirror and
        // a measurement all find them without knowing a UCS exists.
        if (built.kind === 'ucs') {
          for (const [suffix, piece] of ucsParts(built, entry.name)) {
            resolved.set(`${entry.id}/${suffix}`, { ...piece, id: `${entry.id}/${suffix}` });
          }
        }
      } else {
        errors.push({ id: entry.id, message: `${entry.name || entry.type} could not be built` });
      }
    } catch (err) {
      errors.push({ id: entry.id, message: err.message });
    }
  }

  return { resolved, errors };
}

function buildEntry(entry, ctx) {
  switch (entry.type) {
    case 'planeOffset': {
      const base = ctx.planeOf(entry.base || 'XY');
      if (!base) return null;
      const d = safeEval(entry.distance, ctx.scope, 0);
      return {
        kind: 'plane',
        origin: add(base.origin, scale(base.n, d)),
        x: base.x,
        y: base.y,
        n: base.n
      };
    }

    case 'planeAngle': {
      // Turn a plane about an axis lying in it.
      const base = ctx.planeOf(entry.base || 'XY');
      const axis = ctx.axisOf(entry.axis);
      if (!base || !axis) return null;
      const angle = (safeEval(entry.angle, ctx.scope, 45) * Math.PI) / 180;

      const rotate = (v) => {
        const k = axis.dir;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const kv = cross(k, v);
        const kd = dot(k, v);
        return [
          v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
          v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
          v[2] * c + kv[2] * s + k[2] * kd * (1 - c)
        ];
      };

      const n = norm(rotate(base.n));
      const basis = basisFor(n);
      return { kind: 'plane', origin: axis.origin, x: basis.x, y: basis.y, n };
    }

    case 'planeThreePoints': {
      const pts = (entry.points || []).map(ctx.pointOf).filter(Boolean);
      if (pts.length < 3) return null;
      const n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
      if (!Number.isFinite(n[0]) || len(n) < 0.5) return null;
      const basis = basisFor(n);
      return { kind: 'plane', origin: pts[0], x: basis.x, y: basis.y, n };
    }

    case 'planeMidplane': {
      const a = ctx.planeOf(entry.planeA);
      const b = ctx.planeOf(entry.planeB);
      if (!a || !b) return null;
      // Flip the second normal if the two face opposite ways, so the average
      // is the plane between them rather than a degenerate zero.
      const flip = dot(a.n, b.n) < 0;
      const bn = flip ? scale(b.n, -1) : b.n;
      const n = norm(add(a.n, bn));
      if (len(n) < 0.5) return null;
      const origin = scale(add(a.origin, b.origin), 0.5);
      const basis = basisFor(n);
      return { kind: 'plane', origin, x: basis.x, y: basis.y, n };
    }

    case 'planeTangent': {
      // A plane laid against a cylinder, square to a reference plane.
      const face = ctx.faceFor(entry.face);
      const guide = ctx.planeOf(entry.guide || 'XY');
      if (!face || face.planar || !guide) return null;
      const axis = cylinderAxis(face);
      if (!axis) return null;
      const outward = norm(
        sub(face.centre, add(axis.origin, scale(axis.dir, dot(sub(face.centre, axis.origin), axis.dir))))
      );
      const angle = (safeEval(entry.angle, ctx.scope, 0) * Math.PI) / 180;
      const k = axis.dir;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const kv = cross(k, outward);
      const kd = dot(k, outward);
      const n = norm([
        outward[0] * c + kv[0] * s + k[0] * kd * (1 - c),
        outward[1] * c + kv[1] * s + k[1] * kd * (1 - c),
        outward[2] * c + kv[2] * s + k[2] * kd * (1 - c)
      ]);
      const origin = add(
        add(axis.origin, scale(axis.dir, dot(sub(face.centre, axis.origin), axis.dir))),
        scale(n, axis.radius)
      );
      const basis = basisFor(n);
      return { kind: 'plane', origin, x: basis.x, y: basis.y, n };
    }

    case 'axisTwoPoints': {
      const a = ctx.pointOf(entry.pointA);
      const b = ctx.pointOf(entry.pointB);
      if (!a || !b) return null;
      const dir = norm(sub(b, a));
      if (len(dir) < 0.5) return null;
      return { kind: 'axis', origin: a, dir };
    }

    case 'axisEdge': {
      const edge = ctx.edgeFor(entry.edge);
      if (!edge || edge.kind !== 'line') return null;
      return { kind: 'axis', origin: edge.start, dir: edge.dir };
    }

    case 'axisCylinder': {
      const face = ctx.faceFor(entry.face);
      const axis = face ? cylinderAxis(face) : null;
      if (!axis) return null;
      return { kind: 'axis', origin: axis.origin, dir: axis.dir };
    }

    case 'axisPlanes': {
      const a = ctx.planeOf(entry.planeA);
      const b = ctx.planeOf(entry.planeB);
      if (!a || !b) return null;
      const dir = cross(a.n, b.n);
      const l = len(dir);
      if (l < 1e-6) return null;
      const unit = scale(dir, 1 / l);
      const origin = twoPlanePoint(a, b, unit);
      if (!origin) return null;
      return { kind: 'axis', origin, dir: unit };
    }

    case 'axisNormal': {
      const plane = ctx.planeOf(entry.plane);
      const p = entry.point ? ctx.pointOf(entry.point) : null;
      if (!plane) return null;
      return { kind: 'axis', origin: p || plane.origin, dir: plane.n };
    }

    case 'pointAt': {
      const p = ctx.pointOf(entry.point);
      return p ? { kind: 'point', p } : null;
    }

    case 'pointAxisPlane': {
      const axis = ctx.axisOf(entry.axis);
      const plane = ctx.planeOf(entry.plane);
      if (!axis || !plane) return null;
      const denom = dot(axis.dir, plane.n);
      if (Math.abs(denom) < 1e-9) return null;
      const t = dot(sub(plane.origin, axis.origin), plane.n) / denom;
      return { kind: 'point', p: add(axis.origin, scale(axis.dir, t)) };
    }

    case 'planeAlongPath': {
      const at = alongPath(ctx.pathOf(entry.path), safeEval(entry.t, ctx.scope, 0.5));
      if (!at) return null;
      // Square to the path, which is what makes it the right plane to sweep a
      // section on or to cut across a curve with.
      const basis = basisFor(at.dir);
      return { kind: 'plane', origin: at.p, x: basis.x, y: basis.y, n: at.dir };
    }

    case 'pointAlongPath': {
      const at = alongPath(ctx.pathOf(entry.path), safeEval(entry.t, ctx.scope, 0.5));
      return at ? { kind: 'point', p: at.p } : null;
    }

    case 'planePerpendicular': {
      // Square across an axis, at a point on it. What you want before cutting
      // a slot across a shaft: the plane the cut lies in is decided by the
      // shaft, not by the world.
      const axis = ctx.axisOf(entry.axis);
      const at = ctx.pointOf(entry.point);
      if (!axis) return null;
      // Without a point it sits where the axis starts, which is at least
      // somewhere on the axis rather than nowhere.
      const origin = at || axis.origin;
      const basis = basisFor(axis.dir);
      return { kind: 'plane', origin, x: basis.x, y: basis.y, n: axis.dir };
    }

    case 'planeTwoEdges': {
      // The plane two straight edges share. Two lines lie in one plane when
      // they meet or when they are parallel, and in neither case does the
      // plane need anything else said about it.
      const a = ctx.edgeFor(entry.edgeA);
      const b = ctx.edgeFor(entry.edgeB);
      if (!a || !b || a.kind !== 'line' || b.kind !== 'line') return null;

      let n = cross(a.dir, b.dir);
      if (len(n) < 1e-6) {
        // Parallel: the plane is the one holding both, so its normal is square
        // to the direction they share and to the gap between them.
        const across = sub(b.start, a.start);
        n = cross(a.dir, across);
        if (len(n) < 1e-6) return null;
      } else {
        // Crossing or skew. Skew lines share no plane, and saying so is better
        // than quietly building one through the middle of them.
        const gap = sub(b.start, a.start);
        const offAxis = Math.abs(dot(gap, norm(n)));
        const scale2 = Math.max(len(gap), 1);
        if (offAxis > 1e-4 * scale2) return null;
      }
      const unit = norm(n);
      const basis = basisFor(unit);
      return { kind: 'plane', origin: a.start, x: basis.x, y: basis.y, n: unit };
    }

    case 'pointTwoEdges': {
      // Where two straight edges meet. Where they only nearly meet, the point
      // halfway along the shortest line between them is the honest answer and
      // is what every measurement of a real part gives anyway.
      const a = ctx.edgeFor(entry.edgeA);
      const b = ctx.edgeFor(entry.edgeB);
      if (!a || !b || a.kind !== 'line' || b.kind !== 'line') return null;
      const w = sub(a.start, b.start);
      const dd = dot(a.dir, b.dir);
      const denom = 1 - dd * dd;
      if (Math.abs(denom) < 1e-9) return null;
      const sa = (dd * dot(w, b.dir) - dot(w, a.dir)) / denom;
      const sb = (dot(w, b.dir) - dd * dot(w, a.dir)) / denom;
      const pa = add(a.start, scale(a.dir, sa));
      const pb = add(b.start, scale(b.dir, sb));
      return { kind: 'point', p: scale(add(pa, pb), 0.5) };
    }

    case 'jointOrigin': {
      // Already captured when it was made, and deliberately not recomputed. The
      // whole use of one is that it goes on meaning the same place after the
      // face it came off has been replaced by a fillet, and a version that
      // re-derived itself every rebuild would lose exactly that.
      if (!entry.p || !entry.axis) return null;
      const axis = norm(entry.axis);
      if (len(axis) < 0.5) return null;
      const basis = basisFor(axis);
      return {
        kind: 'jointOrigin',
        p: entry.p.slice(),
        origin: entry.p.slice(),
        dir: axis,
        x: entry.axis2 ? norm(entry.axis2) : basis.x,
        y: basis.y,
        n: axis
      };
    }

    case 'ucs': {
      // A frame of its own to work in. Fusion's version is the one Construct
      // command that is not a single formula: it is an origin and three
      // directions, and what makes it useful is that its planes and axes can be
      // used anywhere the world's own can.
      //
      // The origin comes from a point, a face, or nothing, which is the world
      // origin. The first direction is taken as given and the second is squared
      // up against it rather than trusted, because two picked edges are almost
      // never exactly at right angles and a frame that is not square shears
      // every sketch drawn on it.
      const origin =
        ctx.pointOf(entry.origin) || ctx.planeOf(entry.origin)?.origin || [0, 0, 0];

      const primary = ctx.axisOf(entry.axisX);
      const secondary = ctx.axisOf(entry.axisY);
      let x = primary ? norm(primary.dir) : [1, 0, 0];
      if (len(x) < 0.5) x = [1, 0, 0];

      let y;
      if (secondary) {
        const raw = norm(secondary.dir);
        // Square it up: keep only the part of it across the first direction.
        const across = sub(raw, scale(x, dot(raw, x)));
        y = len(across) > 1e-6 ? norm(across) : null;
      }
      if (!y) {
        const fallback = basisFor(x);
        y = fallback.x;
      }
      const z = norm(cross(x, y));
      // And rebuild y from the other two, so the three really are square to
      // each other however the picks were rounded.
      y = norm(cross(z, x));

      const flip = entry.flip ? -1 : 1;
      return {
        kind: 'ucs',
        origin,
        x,
        y: scale(y, 1),
        z: scale(z, flip)
      };
    }

    case 'pointThreePlanes': {
      const a = ctx.planeOf(entry.planeA);
      const b = ctx.planeOf(entry.planeB);
      const c = ctx.planeOf(entry.planeC);
      if (!a || !b || !c) return null;
      const p = threePlanePoint(a, b, c);
      return p ? { kind: 'point', p } : null;
    }

    case 'planeTangentPoint': {
      // Laid against a cylinder where a point is, rather than at a stated
      // angle: the point says which way round, so nothing else has to.
      const face = ctx.faceFor(entry.face);
      const at = ctx.pointOf(entry.point);
      if (!face || face.planar || !at) return null;
      const axis = cylinderAxis(face);
      if (!axis) return null;
      const onAxis = add(
        axis.origin,
        scale(axis.dir, dot(sub(at, axis.origin), axis.dir))
      );
      const outward = sub(at, onAxis);
      if (len(outward) < 1e-9) return null;
      const n = norm(outward);
      const origin = add(onAxis, scale(n, axis.radius));
      const basis = basisFor(n);
      return { kind: 'plane', origin, x: basis.x, y: basis.y, n };
    }

    case 'pointCentre': {
      const edge = ctx.edgeFor(entry.edge);
      if (!edge || edge.kind !== 'circle') return null;
      return { kind: 'point', p: edge.centre };
    }

    default:
      return null;
  }
}

/**
 * A fraction of the way along a run of points, and the direction of travel
 * there. Measured by arc length, so half way is half the distance walked rather
 * than the middle point of the list.
 */
function alongPath(points, t) {
  if (!points || points.length < 2) return null;
  const steps = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const d = len(sub(points[i + 1], points[i]));
    steps.push(d);
    total += d;
  }
  if (total < 1e-12) return null;

  const want = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.5)) * total;
  let walked = 0;
  for (let i = 0; i < steps.length; i++) {
    if (walked + steps[i] >= want || i === steps.length - 1) {
      const f = steps[i] > 1e-12 ? (want - walked) / steps[i] : 0;
      const seg = sub(points[i + 1], points[i]);
      return {
        p: add(points[i], scale(seg, f)),
        dir: norm(seg)
      };
    }
    walked += steps[i];
  }
  return null;
}

/** Where three planes meet, by Cramer's rule on their normals. */
function threePlanePoint(a, b, c) {
  const n1 = a.n;
  const n2 = b.n;
  const n3 = c.n;
  const det =
    n1[0] * (n2[1] * n3[2] - n2[2] * n3[1]) -
    n1[1] * (n2[0] * n3[2] - n2[2] * n3[0]) +
    n1[2] * (n2[0] * n3[1] - n2[1] * n3[0]);
  // Two of them parallel, or all three through one line: no single point.
  if (Math.abs(det) < 1e-9) return null;

  const d1 = dot(n1, a.origin);
  const d2 = dot(n2, b.origin);
  const d3 = dot(n3, c.origin);
  const c23 = cross(n2, n3);
  const c31 = cross(n3, n1);
  const c12 = cross(n1, n2);
  return [
    (d1 * c23[0] + d2 * c31[0] + d3 * c12[0]) / det,
    (d1 * c23[1] + d2 * c31[1] + d3 * c12[1]) / det,
    (d1 * c23[2] + d2 * c31[2] + d3 * c12[2]) / det
  ];
}

/** Axis and radius of a cylindrical face, fitted when the topology was built. */
function cylinderAxis(face) {
  return face && face.cylinder ? face.cylinder : null;
}

/** A point on the line where two planes meet, nearest their origins. */
function twoPlanePoint(a, b, dir) {
  const n1 = a.n;
  const n2 = b.n;
  const d1 = dot(n1, a.origin);
  const d2 = dot(n2, b.origin);
  const mid = scale(add(a.origin, b.origin), 0.5);
  const rows = [
    [n1[0], n1[1], n1[2], d1],
    [n2[0], n2[1], n2[2], d2],
    [dir[0], dir[1], dir[2], dot(dir, mid)]
  ];
  const det =
    rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1]) -
    rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0]) +
    rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0]);
  if (Math.abs(det) < 1e-9) return null;
  const solve = (col) => {
    const m = rows.map((r) => r.slice(0, 3));
    for (let i = 0; i < 3; i++) m[i][col] = rows[i][3];
    return (
      (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])) /
      det
    );
  };
  return [solve(0), solve(1), solve(2)];
}

/**
 * The planes, axes and point a coordinate system stands for.
 *
 * Named the way someone reading a tree would name them: the frame's own name
 * and then which part of it, so "Fixture XY" rather than an id.
 */
export function ucsParts(ucs, name) {
  const stem = name || 'UCS';
  const plane = (a, b, n) => ({ kind: 'plane', origin: ucs.origin, x: a, y: b, n });
  const axis = (dir) => ({ kind: 'axis', origin: ucs.origin, dir });
  return [
    ['xy', { ...plane(ucs.x, ucs.y, ucs.z), name: `${stem} XY` }],
    ['xz', { ...plane(ucs.x, ucs.z, scale(ucs.y, -1)), name: `${stem} XZ` }],
    ['yz', { ...plane(ucs.y, ucs.z, ucs.x), name: `${stem} YZ` }],
    ['x', { ...axis(ucs.x), name: `${stem} X` }],
    ['y', { ...axis(ucs.y), name: `${stem} Y` }],
    ['z', { ...axis(ucs.z), name: `${stem} Z` }],
    ['origin', { kind: 'point', p: ucs.origin, name: `${stem} origin` }]
  ];
}

export const CONSTRUCTION_LABELS = {
  jointOrigin: 'Joint Origin',
  ucs: 'Coordinate System',
  planePerpendicular: 'Plane Square Across an Axis',
  planeTwoEdges: 'Plane Through 2 Edges',
  pointTwoEdges: 'Point Where 2 Edges Meet',
  planeOffset: 'Offset Plane',
  planeAngle: 'Plane at Angle',
  planeThreePoints: 'Plane Through 3 Points',
  planeMidplane: 'Midplane',
  planeTangent: 'Tangent Plane',
  axisTwoPoints: 'Axis Through 2 Points',
  axisEdge: 'Axis Along Edge',
  axisCylinder: 'Cylinder Axis',
  axisPlanes: 'Axis At Plane Intersection',
  axisNormal: 'Axis Normal To Plane',
  pointAt: 'Point',
  pointAxisPlane: 'Point At Axis And Plane',
  pointCentre: 'Point At Circle Centre',
  planeAlongPath: 'Plane Along Path',
  planeTangentPoint: 'Plane Tangent At Point',
  pointAlongPath: 'Point Along Path',
  pointThreePlanes: 'Point At 3 Planes'
};
