/**
 * Reading the boundary representation inside a Fusion archive.
 *
 * An `.f3d` is a zip. Its geometry sits in `Breps.BlobParts` as `.smb` files,
 * and those begin `ASM BinaryFile`: Autodesk ShapeManager, which is a fork of
 * ACIS and carries the same entity model. Body, lump, shell, face, loop,
 * coedge, edge, vertex, point, and a surface or a curve hanging off each.
 *
 * There is no published specification. What is here was worked out by reading
 * real files: the token tags first, then which record points at which by
 * looking at what each pointer lands on. Everything below says what it was
 * checked against, because the next person to touch it will have no other way
 * to know which parts are certain.
 *
 * What it does not do is the hard half of ACIS: spline surfaces and the
 * interpolated curves that trim them. Those are counted and named rather than
 * skipped in silence, because a part missing a face is a part you must not
 * print, and knowing that it was a spline is what tells you whether to go back
 * to Fusion and export a STEP instead.
 */

import { trimFace } from './stepread.js';

/* ------------------------------------------------------------------ */
/* The token stream                                                    */
/* ------------------------------------------------------------------ */

/*
 * The tags, read off real files rather than out of a document.
 *
 * A record is an identifier, then its fields, then an end marker. Everything is
 * little endian. The two that took finding are 0x13 and 0x14: three untagged
 * doubles each, a position and a direction, which is why a plane reads as an
 * origin and two directions and nothing else.
 */
const T_INT = 0x04;
const T_DOUBLE = 0x06;
const T_STRING = 0x07;
const T_FALSE = 0x0a;
const T_TRUE = 0x0b;
const T_POINTER = 0x0c;
const T_IDENT = 0x0d;
const T_IDENT2 = 0x0e;
const T_END = 0x11;
const T_LONGSTRING = 0x12;
const T_POSITION = 0x13;
const T_DIRECTION = 0x14;

/**
 * Every record in the file, in order, with its fields.
 *
 * A pointer is an index into this same list, and minus one is nothing. The
 * first identifier in a record is its type; a second one is the type it is a
 * kind of, so `plane` arrives followed by `surface`.
 */
export function readRecords(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder('latin1');

  // The header is prose and version numbers. The records start at the first
  // identifier after it, which in every file seen is `asmheader`.
  let i = findHeader(bytes);
  if (i < 0) throw new Error('That is not a ShapeManager file');

  const out = [];
  let cur = null;
  const n = bytes.length;

  while (i < n) {
    const tag = bytes[i++];
    if (tag === T_IDENT || tag === T_IDENT2) {
      const len = bytes[i++];
      const name = text.decode(bytes.subarray(i, i + len));
      i += len;
      if (!cur) cur = { name, kinds: [], fields: [] };
      else cur.kinds.push(name);
    } else if (tag === T_POINTER) {
      cur?.fields.push({ t: 'ptr', v: view.getInt32(i, true) });
      i += 4;
    } else if (tag === T_INT) {
      cur?.fields.push({ t: 'int', v: view.getInt32(i, true) });
      i += 4;
    } else if (tag === T_DOUBLE) {
      cur?.fields.push({ t: 'num', v: view.getFloat64(i, true) });
      i += 8;
    } else if (tag === T_POSITION || tag === T_DIRECTION) {
      cur?.fields.push({
        t: tag === T_POSITION ? 'pos' : 'dir',
        v: [view.getFloat64(i, true), view.getFloat64(i + 8, true), view.getFloat64(i + 16, true)]
      });
      i += 24;
    } else if (tag === T_STRING) {
      const len = bytes[i++];
      cur?.fields.push({ t: 'str', v: text.decode(bytes.subarray(i, i + len)) });
      i += len;
    } else if (tag === T_LONGSTRING) {
      const len = view.getInt32(i, true);
      i += 4;
      cur?.fields.push({ t: 'str', v: text.decode(bytes.subarray(i, i + len)) });
      i += len;
    } else if (tag === T_TRUE || tag === T_FALSE) {
      cur?.fields.push({ t: 'bool', v: tag === T_TRUE });
    } else if (tag === T_END) {
      if (cur) out.push(cur);
      cur = null;
    } else if (cur) {
      // An unknown tag inside a record. Recorded rather than guessed at: what
      // matters is that the stream is still in step, and the end marker is what
      // says it is.
      cur.fields.push({ t: 'unknown', v: tag });
    }
  }
  return out;
}

function findHeader(bytes) {
  const want = 'asmheader';
  for (let i = 0; i < bytes.length - want.length; i++) {
    if (bytes[i] !== want.charCodeAt(0)) continue;
    let ok = true;
    for (let k = 1; k < want.length; k++) {
      if (bytes[i + k] !== want.charCodeAt(k)) {
        ok = false;
        break;
      }
    }
    // Back up over the length byte and the identifier tag.
    if (ok) return i - 2;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* The entity graph                                                    */
/* ------------------------------------------------------------------ */

/**
 * Follow a pointer to whatever it lands on.
 *
 * Resolving by what a pointer *points at* rather than by its position in the
 * record is the one decision this file rests on. The field order differs
 * between ShapeManager versions and there is no specification to check against,
 * so a reader written to "the fourth field is the lump" is a reader that breaks
 * on the next file. A reader written to "the field that lands on a lump is the
 * lump" does not.
 */
function targets(records, rec, kind) {
  const out = [];
  for (const f of rec.fields) {
    if (f.t !== 'ptr' || f.v < 0 || f.v >= records.length) continue;
    const to = records[f.v];
    if (to && (!kind || to.name === kind || to.kinds.includes(kind))) out.push(to);
  }
  return out;
}

const first = (records, rec, kind) => targets(records, rec, kind)[0] || null;

/** The positions and directions of a record, in the order they were written. */
const positions = (rec) => rec.fields.filter((f) => f.t === 'pos').map((f) => f.v);
const directions = (rec) => rec.fields.filter((f) => f.t === 'dir').map((f) => f.v);
const numbers = (rec) => rec.fields.filter((f) => f.t === 'num').map((f) => f.v);

/* ---------------------------------------------------------- geometry */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
function unit(a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
}

/** A frame from an origin, a normal and a reference direction. */
function frameOf(origin, n, ref) {
  const z = unit(n) || [0, 0, 1];
  let x = ref && unit(sub(ref, mul(z, dot(ref, z))));
  if (!x) {
    const away = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    x = unit(cross(away, z));
  }
  return { origin, x, y: cross(z, x), z };
}

/**
 * The surface a face sits on, in the same shape the STEP reader uses.
 *
 * Which is what makes the rest of this file short: once a surface can turn a
 * point into a pair of parameters and back, the trimming and the triangulating
 * are already written.
 */
function surfaceOf(rec, stats) {
  if (!rec) return null;
  const pos = positions(rec);
  const dirs = directions(rec);
  const nums = numbers(rec);

  if (rec.name === 'plane') {
    if (!pos.length || !dirs.length) return null;
    const f = frameOf(pos[0], dirs[0], dirs[1]);
    return {
      kind: 'plane',
      curved: false,
      to2d: (p) => {
        const rel = sub(p, f.origin);
        return [dot(rel, f.x), dot(rel, f.y)];
      },
      to3d: ([u, v]) => add(f.origin, add(mul(f.x, u), mul(f.y, v)))
    };
  }

  /*
   * A cone in ShapeManager covers the cylinder as well, the same way it does in
   * STEP: a cylinder is a cone whose half angle is zero. The record carries the
   * base radius and the two numbers of the angle, sine and cosine.
   */
  if (rec.name === 'cone') {
    if (!pos.length || !dirs.length || nums.length < 1) return null;
    const f = frameOf(pos[0], dirs[0], dirs[1]);
    const r = Math.abs(nums[0]);
    // Sine and cosine of the half angle, when they are there. A cylinder has a
    // sine of zero, which is also what a missing pair reads as.
    const sinA = nums.length > 2 ? nums[nums.length - 2] : 0;
    const cosA = nums.length > 2 ? nums[nums.length - 1] : 1;
    const slope = Math.abs(cosA) > 1e-9 ? sinA / cosA : 0;
    if (!(r > 0) && !slope) return null;
    return {
      kind: slope ? 'cone' : 'cylinder',
      curved: true,
      radius: r,
      // Round the axis and along it: the surface unrolled, which is a plane.
      to2d: (p) => {
        const rel = sub(p, f.origin);
        const h = dot(rel, f.z);
        const ang = Math.atan2(dot(rel, f.y), dot(rel, f.x));
        return [ang * Math.max(r, 1e-6), h];
      },
      to3d: ([u, v]) => {
        const ang = u / Math.max(r, 1e-6);
        const rad = r + slope * v;
        return add(
          f.origin,
          add(add(mul(f.x, Math.cos(ang) * rad), mul(f.y, Math.sin(ang) * rad)), mul(f.z, v))
        );
      }
    };
  }

  if (rec.name === 'sphere') {
    if (!pos.length || nums.length < 1) return null;
    const f = frameOf(pos[0], dirs[0] || [0, 0, 1], dirs[1]);
    const r = Math.abs(nums[0]);
    if (!(r > 0)) return null;
    return {
      kind: 'sphere',
      curved: true,
      to2d: (p) => {
        const rel = sub(p, f.origin);
        const h = Math.max(-1, Math.min(1, dot(rel, f.z) / r));
        return [Math.atan2(dot(rel, f.y), dot(rel, f.x)) * r, Math.asin(h) * r];
      },
      to3d: ([u, v]) => {
        const lat = v / r;
        const lon = u / r;
        const ring = Math.cos(lat) * r;
        return add(
          f.origin,
          add(
            add(mul(f.x, Math.cos(lon) * ring), mul(f.y, Math.sin(lon) * ring)),
            mul(f.z, Math.sin(lat) * r)
          )
        );
      }
    };
  }

  if (rec.name === 'torus') {
    if (!pos.length || nums.length < 2) return null;
    const f = frameOf(pos[0], dirs[0] || [0, 0, 1], dirs[1]);
    const major = Math.abs(nums[0]);
    const minor = Math.abs(nums[1]);
    if (!(major > 0) || !(minor > 0)) return null;
    return {
      kind: 'torus',
      curved: true,
      to2d: (p) => {
        const rel = sub(p, f.origin);
        const lon = Math.atan2(dot(rel, f.y), dot(rel, f.x));
        const ring = Math.hypot(dot(rel, f.x), dot(rel, f.y)) - major;
        const lat = Math.atan2(dot(rel, f.z), ring);
        return [lon * major, lat * minor];
      },
      to3d: ([u, v]) => {
        const lon = u / major;
        const lat = v / minor;
        const rad = major + Math.cos(lat) * minor;
        return add(
          f.origin,
          add(
            add(mul(f.x, Math.cos(lon) * rad), mul(f.y, Math.sin(lon) * rad)),
            mul(f.z, Math.sin(lat) * minor)
          )
        );
      }
    };
  }

  // Everything else is a spline of one kind or another. Counted and named.
  stats.unreadKinds.add(rec.name);
  return null;
}

/**
 * The points along one edge, from one vertex to the other.
 *
 * A straight edge is its two ends. A circle or an ellipse is walked round in
 * steps small enough that the chord never sags further from the true curve than
 * the tolerance allows, which is the same rule the STEP reader uses and the
 * same reason: a cylinder drawn in eight facets is not a cylinder.
 */
function edgePoints(records, edge, tol, stats) {
  const vertices = targets(records, edge, 'vertex');
  const ends = vertices
    .map((v) => {
      const pt = first(records, v, 'point');
      return pt ? positions(pt)[0] : null;
    })
    .filter(Boolean);
  if (ends.length < 2) return null;

  const curve = targets(records, edge, 'curve')[0] || null;
  if (!curve || curve.name === 'straight') return [ends[0], ends[1]];

  if (curve.name === 'ellipse') {
    const pos = positions(curve);
    const dirs = directions(curve);
    const nums = numbers(curve);
    if (!pos.length || dirs.length < 2) return sampleFallback(ends);
    const centre = pos[0];
    const f = frameOf(centre, dirs[0], dirs[1]);
    const major = Math.hypot(...sub(add(centre, dirs[1]), centre)) || 1;
    // The record carries the major axis as a vector and the ratio of minor to
    // major as a number.
    const majorVec = dirs[1];
    const a = Math.hypot(majorVec[0], majorVec[1], majorVec[2]) || major;
    const ratio = nums.length ? Math.abs(nums[0]) : 1;
    const b = a * (ratio > 0 ? ratio : 1);

    const angleOf = (p) => {
      const rel = sub(p, centre);
      return Math.atan2(dot(rel, f.y) / (b || 1), dot(rel, f.x) / (a || 1));
    };
    let a0 = angleOf(ends[0]);
    let a1 = angleOf(ends[1]);
    // A full circle comes back with both ends at the same angle, which has to
    // read as all the way round rather than as nothing.
    let sweep = a1 - a0;
    while (sweep <= 1e-9) sweep += Math.PI * 2;
    const steps = arcSteps(Math.max(a, b), sweep, tol);
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = a0 + (sweep * i) / steps;
      out.push(add(centre, add(mul(f.x, Math.cos(t) * a), mul(f.y, Math.sin(t) * b))));
    }
    return out;
  }

  // An interpolated curve: the trim of a spline. Its ends are known and its
  // middle is not, so the face it belongs to is reported rather than drawn with
  // a straight line pretending to be a curve.
  stats.unreadKinds.add(curve.name);
  return null;
}

function sampleFallback(ends) {
  return [ends[0], ends[1]];
}

/** How many steps an arc needs so the chord never sags past the tolerance. */
function arcSteps(radius, sweep, tol) {
  if (!(radius > 0)) return 8;
  const perStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / radius)));
  return Math.max(2, Math.min(360, Math.ceil(Math.abs(sweep) / Math.max(perStep, 1e-6))));
}

/**
 * One face, as triangles.
 *
 * The loops come off the face and each one is walked coedge by coedge. A coedge
 * is an edge seen from one side, and which side decides which way round its
 * points go: taken the wrong way the ring closes back on itself and the
 * triangulator quite reasonably refuses it.
 */
function faceTriangles(records, face, tol, stats) {
  const surf = surfaceOf(targets(records, face, 'surface')[0] || null, stats);
  if (!surf) {
    stats.unreadFaces++;
    return null;
  }

  const rings = [];
  for (const loop of targets(records, face, 'loop')) {
    const pts = loopPoints(records, loop, tol, stats);
    if (pts && pts.length >= 3) rings.push({ pts, outer: false });
  }
  if (!rings.length) {
    stats.unreadFaces++;
    return null;
  }

  // Which way the face faces. ShapeManager writes the sense as a flag on the
  // face; where it cannot be told, the outward normal of the shell sorts it out
  // later, and a patch the wrong way round is visible at once.
  const sense = face.fields.find((f) => f.t === 'bool');
  return trimFace(surf, rings, sense ? sense.v : true, stats);
}

/** A loop walked into a ring of points. */
function loopPoints(records, loop, tol, stats) {
  const start = first(records, loop, 'coedge');
  if (!start) return null;

  const out = [];
  let at = start;
  const seen = new Set();
  let guard = 0;
  while (at && !seen.has(at) && guard++ < 10000) {
    seen.add(at);
    const edge = first(records, at, 'edge');
    if (!edge) return null;
    const pts = edgePoints(records, edge, tol, stats);
    if (!pts) return null;

    // The coedge's own sense says whether this edge runs with the loop or
    // against it. Against it, the points come in backwards.
    const sense = at.fields.find((f) => f.t === 'bool');
    const run = sense && sense.v === false ? [...pts].reverse() : pts;
    for (const p of run) {
      const last = out[out.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > 1e-9) out.push(p);
    }

    // The next coedge round the loop. Which of the pointers that is cannot be
    // taken from its position, so it is the one that is a coedge, is not this
    // one, and has not been used yet.
    const next = targets(records, at, 'coedge').find((c) => c !== at && !seen.has(c));
    at = next || null;
  }

  if (out.length > 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9) out.pop();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The whole file                                                      */
/* ------------------------------------------------------------------ */

const DEFAULT_TOLERANCE = 0.05;

/**
 * Read a ShapeManager blob as one mesh per lump.
 *
 * Per lump rather than per body: a Fusion archive writes a great many bodies,
 * most of which are the intermediate steps of the timeline, and what somebody
 * wants when they open one is the parts, which are the lumps that have shells
 * with faces on them.
 */
export function readASM(bytes, opts = {}) {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const records = readRecords(bytes);
  const stats = { faces: 0, unreadFaces: 0, unreadKinds: new Set() };

  /*
   * Which lumps are the part, out of all the lumps in the file.
   *
   * An archive holds the timeline, not just the answer: the same body appears
   * once per state it passed through, so a model with three bodies can arrive
   * as four hundred and fifty. Two things tell the live ones apart.
   *
   * A body that is placed in the scene has a transform on it, and one that is
   * only a step along the way does not. That alone takes this file from 451 to
   * 133. What is left is the same shape written more than once, which is caught
   * by measuring it: same triangle count, same box, same corner. Keeping the
   * last of each is keeping the state it ended in.
   */
  const placed = new Set();
  for (const rec of records) {
    if (rec.name !== 'body') continue;
    if (!targets(records, rec, 'transform').length) continue;
    for (const lump of targets(records, rec, 'lump')) placed.add(lump);
  }
  const wanted = placed.size ? placed : null;

  const bodies = [];
  const seen = new Map();
  for (const rec of records) {
    if (rec.name !== 'lump') continue;
    if (wanted && !wanted.has(rec)) continue;
    const verts = [];
    const tris = [];

    for (const shell of targets(records, rec, 'shell')) {
      for (const face of facesOfShell(records, shell)) {
        stats.faces++;
        const got = faceTriangles(records, face, tol, stats);
        if (!got) continue;
        const base = verts.length / 3;
        for (const v of got.verts) verts.push(v[0], v[1], v[2]);
        for (const t of got.tris) tris.push(base + t[0], base + t[1], base + t[2]);
      }
    }
    if (!tris.length) continue;

    // The same shape written twice is the same shape. Measured rather than
    // compared point by point: a signature of how many triangles and where the
    // corners of its box are separates two real bodies and joins two copies of
    // one, which is all that is being asked.
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < verts.length; i += 3) {
      for (let d = 0; d < 3; d++) {
        lo[d] = Math.min(lo[d], verts[i + d]);
        hi[d] = Math.max(hi[d], verts[i + d]);
      }
    }
    const key = [tris.length, ...lo, ...hi].map((v) => Number(v).toFixed(4)).join('_');

    const body = {
      mesh: {
        numProp: 3,
        vertProperties: new Float32Array(verts),
        triVerts: new Uint32Array(tris)
      }
    };
    // The last of each, which is the state it ended in.
    if (seen.has(key)) bodies[seen.get(key)] = body;
    else {
      seen.set(key, bodies.length);
      bodies.push(body);
    }
  }

  return {
    bodies,
    faces: stats.faces,
    unreadFaces: stats.unreadFaces,
    unread: [...stats.unreadKinds]
  };
}

/**
 * Every face on a shell.
 *
 * A shell names one face and the faces are chained from there, the same way
 * coedges are chained round a loop. Following the chain rather than trusting
 * one pointer is what picks up the other ninety-nine faces of a part.
 */
function facesOfShell(records, shell) {
  const out = [];
  const seen = new Set();
  let at = first(records, shell, 'face');
  let guard = 0;
  while (at && !seen.has(at) && guard++ < 100000) {
    seen.add(at);
    out.push(at);
    at = targets(records, at, 'face').find((f) => f !== at && !seen.has(f)) || null;
  }
  return out;
}
