/**
 * STEP geometry: entities in, a solid out.
 *
 * The parser hands back a graph of instances and knows nothing about what they
 * mean. This is where a CYLINDRICAL_SURFACE becomes a cylinder and an
 * ADVANCED_FACE becomes triangles the kernel can hold.
 *
 * The shape of the data is always the same, whatever surface a face sits on. A
 * closed shell holds faces; a face holds a surface and one or more bounds; a
 * bound is a loop of edges; an edge is a curve and two vertices. So the reader
 * walks that once, gets each face's boundary as a ring of points in the
 * surface's own two parameters, and triangulates there. Doing it in parameter
 * space rather than in the world is what lets one piece of code fill a face
 * whether it is flat, cylindrical or conical: the boundary is a polygon either
 * way, and only the mapping back out to three dimensions differs.
 *
 * What is not here yet: B-spline surfaces, which are the other half of a real
 * STEP file. A face on one of those is skipped and counted, so an import says
 * how much of the model it could not read rather than quietly losing it.
 */

import { parseSTEP, Ref, UNSET } from './stepfile.js';
import { earcut } from './sheet.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** How finely a curved surface is cut up. Smaller is smoother and heavier. */
const DEFAULT_TOLERANCE = 0.05;

/** A CARTESIAN_POINT, in file units. */
function pointOf(step, ref) {
  const p = step.get(ref) || ref;
  if (!p?.args) return null;
  const c = p.args[1];
  if (!Array.isArray(c)) return null;
  return [Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0];
}

function dirOf(step, ref) {
  const d = step.get(ref) || ref;
  if (!d?.args) return null;
  const c = d.args[1];
  if (!Array.isArray(c)) return null;
  return unit([Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0]);
}

/**
 * An AXIS2_PLACEMENT_3D: an origin, a z, and an x that fixes the roll.
 *
 * Both directions are optional in the schema. Where the x is missing any
 * perpendicular will do, because nothing downstream depends on which one; where
 * it is present it must be squared against z rather than trusted, since a file
 * is allowed to give an x that only approximately lies in the plane.
 */
function placementOf(step, ref) {
  const a = step.get(ref);
  if (!a?.args) return null;
  const origin = pointOf(step, a.args[1]);
  if (!origin) return null;
  let z = a.args[2] && a.args[2] !== UNSET ? dirOf(step, a.args[2]) : [0, 0, 1];
  if (!z || len(z) < 0.5) z = [0, 0, 1];
  let x = a.args[3] && a.args[3] !== UNSET ? dirOf(step, a.args[3]) : null;
  if (!x || len(x) < 0.5) {
    const seed = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    x = unit(cross(seed, z));
  } else {
    x = unit(sub(x, mul(z, dot(x, z))));
    if (len(x) < 0.5) {
      const seed = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      x = unit(cross(seed, z));
    }
  }
  const y = cross(z, x);
  return { origin, x, y, z };
}

/** Every vertex point on an edge loop, in order, following each edge's sense. */
function loopPoints(step, loopRef, tol) {
  const loop = step.get(loopRef);
  if (!loop) return null;

  if (loop.type === 'VERTEX_LOOP') return [];
  if (loop.type !== 'EDGE_LOOP') return null;

  const edges = loop.args[1];
  if (!Array.isArray(edges)) return null;

  const pts = [];
  for (const eRef of edges) {
    const orientedEdge = step.get(eRef);
    if (!orientedEdge) continue;
    const sense = orientedEdge.args[4];
    const forward = !(sense && sense.name === 'F');
    const edge = step.get(orientedEdge.args[3]);
    if (!edge) continue;

    const startRef = forward ? edge.args[1] : edge.args[2];
    const endRef = forward ? edge.args[2] : edge.args[1];
    const startV = step.get(startRef);
    const endV = step.get(endRef);
    const a = startV ? pointOf(step, startV.args[1]) : null;
    const b = endV ? pointOf(step, endV.args[1]) : null;
    if (!a) continue;

    const curve = step.get(edge.args[3]);
    const along = curvePoints(step, curve, a, b, forward, tol);
    // The last point of one edge is the first of the next, so it is dropped.
    for (const p of along.slice(0, -1)) pts.push(p);
  }
  return pts.length >= 3 ? pts : null;
}

/**
 * The points along one edge.
 *
 * A line needs only its ends. A circle or an ellipse has to be walked, because
 * the boundary of a face is a polygon by the time it is triangulated and a
 * two point arc would cut the corner off. Anything else falls back to its ends,
 * which is wrong for a spline and is why splines are counted as unread.
 */
function curvePoints(step, curve, a, b, forward, tol) {
  if (!curve || !b) return [a, b].filter(Boolean);

  if (curve.type === 'CIRCLE' || curve.type === 'ELLIPSE') {
    const pl = placementOf(step, curve.args[1]);
    if (!pl) return [a, b];
    const r1 = Number(curve.args[2]) || 0;
    const r2 = curve.type === 'ELLIPSE' ? Number(curve.args[3]) || r1 : r1;
    if (!(r1 > 0)) return [a, b];

    const angleOf = (p) => {
      const rel = sub(p, pl.origin);
      return Math.atan2(dot(rel, pl.y) / (r2 || 1), dot(rel, pl.x) / (r1 || 1));
    };
    let a0 = angleOf(a);
    let a1 = angleOf(b);
    // A full circle arrives with both ends at the same place.
    let sweep = a1 - a0;
    while (sweep <= 1e-9) sweep += Math.PI * 2;
    if (Math.abs(sweep) < 1e-9) sweep = Math.PI * 2;
    if (!forward) {
      // Walked the other way round, which is the same arc read backwards.
      sweep = sweep - Math.PI * 2;
    }

    const steps = arcSteps(Math.max(r1, r2), Math.abs(sweep), tol);
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = a0 + (sweep * i) / steps;
      out.push(
        add(pl.origin, add(mul(pl.x, Math.cos(t) * r1), mul(pl.y, Math.sin(t) * r2)))
      );
    }
    return out;
  }

  return [a, b];
}

/** How many segments an arc of this radius needs to stay within tolerance. */
function arcSteps(radius, sweep, tol) {
  if (!(radius > 0)) return 1;
  const perStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / radius)));
  const n = Math.ceil(Math.abs(sweep) / Math.max(perStep, 1e-4));
  return Math.max(2, Math.min(256, n));
}

/**
 * A face's surface, as a map from the world into two parameters and back.
 *
 * Every surface here is one the schema names outright, so nothing is fitted or
 * guessed: the file says this is a cylinder of radius five about that axis, and
 * the map follows from the definition. Returning both directions is what lets
 * the boundary be flattened, triangulated as an ordinary polygon, and lifted
 * back onto the real surface afterwards.
 */
function surfaceOf(step, ref) {
  const s = step.get(ref);
  if (!s) return null;

  if (s.type === 'PLANE') {
    const pl = placementOf(step, s.args[1]);
    if (!pl) return null;
    return {
      kind: 'plane',
      curved: false,
      to2d: (p) => {
        const rel = sub(p, pl.origin);
        return [dot(rel, pl.x), dot(rel, pl.y)];
      },
      to3d: ([u, v]) => add(pl.origin, add(mul(pl.x, u), mul(pl.y, v)))
    };
  }

  if (s.type === 'CYLINDRICAL_SURFACE') {
    const pl = placementOf(step, s.args[1]);
    const r = Number(s.args[2]) || 0;
    if (!pl || !(r > 0)) return null;
    return {
      kind: 'cylinder',
      curved: true,
      radius: r,
      // Round the axis and along it: the surface unrolled, which is a plane.
      to2d: (p) => {
        const rel = sub(p, pl.origin);
        const ang = Math.atan2(dot(rel, pl.y), dot(rel, pl.x));
        return [ang * r, dot(rel, pl.z)];
      },
      to3d: ([u, v]) => {
        const ang = u / r;
        return add(
          pl.origin,
          add(add(mul(pl.x, Math.cos(ang) * r), mul(pl.y, Math.sin(ang) * r)), mul(pl.z, v))
        );
      }
    };
  }

  if (s.type === 'CONICAL_SURFACE') {
    const pl = placementOf(step, s.args[1]);
    const r = Number(s.args[2]) || 0;
    const half = Number(s.args[3]) || 0;
    if (!pl) return null;
    const tan = Math.tan(half);
    return {
      kind: 'cone',
      curved: true,
      to2d: (p) => {
        const rel = sub(p, pl.origin);
        const ang = Math.atan2(dot(rel, pl.y), dot(rel, pl.x));
        const h = dot(rel, pl.z);
        // Scaled by the radius at that height so the unrolled boundary keeps
        // its proportions and the triangulation does not go slivery.
        return [ang * Math.max(r + h * tan, 1e-6), h];
      },
      to3d: ([u, v]) => {
        const rr = Math.max(r + v * tan, 0);
        const ang = u / Math.max(rr, 1e-6);
        return add(
          pl.origin,
          add(add(mul(pl.x, Math.cos(ang) * rr), mul(pl.y, Math.sin(ang) * rr)), mul(pl.z, v))
        );
      }
    };
  }

  if (s.type === 'SPHERICAL_SURFACE') {
    const pl = placementOf(step, s.args[1]);
    const r = Number(s.args[2]) || 0;
    if (!pl || !(r > 0)) return null;
    return {
      kind: 'sphere',
      curved: true,
      to2d: (p) => {
        const rel = sub(p, pl.origin);
        const ang = Math.atan2(dot(rel, pl.y), dot(rel, pl.x));
        const lat = Math.asin(Math.max(-1, Math.min(1, dot(rel, pl.z) / r)));
        return [ang * r, lat * r];
      },
      to3d: ([u, v]) => {
        const ang = u / r;
        const lat = v / r;
        const c = Math.cos(lat) * r;
        return add(
          pl.origin,
          add(add(mul(pl.x, Math.cos(ang) * c), mul(pl.y, Math.sin(ang) * c)), mul(pl.z, Math.sin(lat) * r))
        );
      }
    };
  }

  if (s.type === 'TOROIDAL_SURFACE') {
    const pl = placementOf(step, s.args[1]);
    const major = Number(s.args[2]) || 0;
    const minor = Number(s.args[3]) || 0;
    if (!pl || !(major > 0) || !(minor > 0)) return null;
    return {
      kind: 'torus',
      curved: true,
      to2d: (p) => {
        const rel = sub(p, pl.origin);
        const ang = Math.atan2(dot(rel, pl.y), dot(rel, pl.x));
        const inPlane = Math.hypot(dot(rel, pl.x), dot(rel, pl.y)) - major;
        const tube = Math.atan2(dot(rel, pl.z), inPlane);
        return [ang * major, tube * minor];
      },
      to3d: ([u, v]) => {
        const ang = u / major;
        const tube = v / minor;
        const rr = major + Math.cos(tube) * minor;
        return add(
          pl.origin,
          add(
            add(mul(pl.x, Math.cos(ang) * rr), mul(pl.y, Math.sin(ang) * rr)),
            mul(pl.z, Math.sin(tube) * minor)
          )
        );
      }
    };
  }

  return null;
}

/** Signed area of a ring in the surface's own two parameters. */
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * One face, triangulated.
 *
 * The outer bound and any holes are flattened into the surface's parameters,
 * ear clipped there as an ordinary polygon with holes, and lifted back out. The
 * winding is then checked against the face's own normal rather than assumed,
 * because a STEP face carries a flag saying whether its surface normal agrees
 * with the face and a file is entitled to say either.
 */
function faceTriangles(step, face, tol, stats) {
  const surf = surfaceOf(step, face.args[2]);
  if (!surf) {
    stats.unreadFaces++;
    const s = step.get(face.args[2]);
    if (s) stats.unreadKinds.add(s.type);
    return null;
  }

  const bounds = face.args[1];
  if (!Array.isArray(bounds)) return null;

  const rings = [];
  for (const bRef of bounds) {
    const bound = step.get(bRef);
    if (!bound) continue;
    const pts = loopPoints(step, bound.args[1], tol);
    if (!pts || pts.length < 3) continue;
    const outer = bound.type === 'FACE_OUTER_BOUND';
    // A bound carries its own orientation flag, the same as an edge does.
    const flag = bound.args[2];
    const positive = !(flag && flag.name === 'F');
    rings.push({ pts, outer, positive });
  }
  if (!rings.length) return null;

  // The outer ring is the one the file says is outer, or failing that the one
  // enclosing the most area once flattened.
  const flat = rings.map((r) => ({ ...r, uv: r.pts.map(surf.to2d) }));
  let outerAt = flat.findIndex((r) => r.outer);
  if (outerAt < 0) {
    outerAt = 0;
    let best = -Infinity;
    flat.forEach((r, i) => {
      const a = Math.abs(ringArea(r.uv));
      if (a > best) {
        best = a;
        outerAt = i;
      }
    });
  }

  const outer = flat[outerAt];
  const holes = flat.filter((_, i) => i !== outerAt);

  // Ear clipping wants the outer ring one way round and every hole the other.
  const outerRing = ringArea(outer.uv) < 0 ? [...outer.uv].reverse() : outer.uv;
  const holeRings = holes.map((h) => (ringArea(h.uv) > 0 ? [...h.uv].reverse() : h.uv));

  // The clipper takes the rings as points and hands back index triples into
  // the outer ring followed by each hole in turn, so the vertex list is built
  // in exactly that order.
  const uvs = [...outerRing, ...holeRings.flat()];

  let indices;
  try {
    indices = earcut(outerRing, holeRings);
  } catch {
    stats.unreadFaces++;
    return null;
  }
  if (!indices || !indices.length) {
    stats.unreadFaces++;
    return null;
  }

  const verts = uvs.map(surf.to3d);

  // Which way the face actually faces. `same_sense` says whether the surface
  // normal agrees with the face; the winding has to be made to match, or the
  // solid comes out inside out in patches.
  const sameSense = !(face.args[3] && face.args[3].name === 'F');

  const tris = [];
  for (const t of indices) {
    if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue;
    tris.push(sameSense ? t : [t[0], t[2], t[1]]);
  }
  if (!tris.length) {
    stats.unreadFaces++;
    return null;
  }

  return { verts, tris, curved: surf.curved };
}

/**
 * Read a STEP file as one mesh per solid.
 *
 * Faces the reader does not understand are counted rather than dropped in
 * silence, because a part that is missing a face is a part you must not print,
 * and knowing which surface kind was refused is what tells you whether it is
 * worth asking for.
 */
export function readSTEP(text, opts = {}) {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const step = parseSTEP(text);
  const stats = { unreadFaces: 0, unreadKinds: new Set(), faces: 0 };

  const shells = [
    ...step.all('CLOSED_SHELL'),
    ...(opts.openShells === false ? [] : step.all('OPEN_SHELL'))
  ];

  const bodies = [];
  for (const shell of shells) {
    const faceRefs = shell.args[1];
    if (!Array.isArray(faceRefs)) continue;

    const verts = [];
    const tris = [];
    for (const fRef of faceRefs) {
      const face = step.get(fRef);
      if (!face) continue;
      stats.faces++;
      const got = faceTriangles(step, face, tol, stats);
      if (!got) continue;
      const base = verts.length / 3;
      for (const v of got.verts) verts.push(v[0], v[1], v[2]);
      for (const t of got.tris) tris.push(base + t[0], base + t[1], base + t[2]);
    }
    if (!tris.length) continue;

    bodies.push({
      name: shell.args[0] && typeof shell.args[0] === 'string' ? shell.args[0] : '',
      closed: shell.type === 'CLOSED_SHELL',
      mesh: {
        numProp: 3,
        vertProperties: new Float32Array(verts),
        triVerts: new Uint32Array(tris)
      }
    });
  }

  return {
    bodies,
    faces: stats.faces,
    unreadFaces: stats.unreadFaces,
    unread: [...stats.unreadKinds],
    // What the file says it is, which is worth showing when nothing reads.
    schema: (step.all('APPLICATION_PROTOCOL_DEFINITION')[0]?.args?.[1] || '') || ''
  };
}
