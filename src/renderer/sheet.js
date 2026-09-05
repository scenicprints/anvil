/**
 * Sheet bodies: open surfaces, which the solid kernel cannot hold.
 *
 * manifold is a solid kernel. Every body it makes is watertight by
 * construction, which is exactly the property a slicer needs and the reason it
 * was chosen. A surface is a sheet with a boundary, so it lives here instead,
 * as a plain triangle mesh in the same shape a solid's mesh arrives in. That
 * shape is deliberate: topology, display, picking and export all work on a
 * sheet without knowing it is one.
 *
 * The rule that keeps this safe is that a sheet never reaches the kernel. It is
 * stitched into a closed mesh first, or thickened into one, and the check that
 * it really did close happens here, once.
 */

const EPS = 1e-9;

/* ---------------------------------------------------------------- vectors */

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
  return l > EPS ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/* ----------------------------------------------------------------- basics */

/**
 * A sheet from a list of points and triangles.
 *
 * `grid` is carried when the sheet came off something with a natural
 * parameterisation, a swept or lofted or revolved surface. It is what makes an
 * isoparametric curve mean anything: on an arbitrary triangle soup there is no
 * u and no v to hold constant.
 */
export function makeSheet(points, tris, opts = {}) {
  const vertProperties = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    vertProperties[i * 3] = points[i][0];
    vertProperties[i * 3 + 1] = points[i][1];
    vertProperties[i * 3 + 2] = points[i][2];
  }
  const flat = new Uint32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    flat[i * 3] = tris[i][0];
    flat[i * 3 + 1] = tris[i][1];
    flat[i * 3 + 2] = tris[i][2];
  }
  const sheet = { numProp: 3, vertProperties, triVerts: flat };
  if (opts.grid) sheet.grid = opts.grid;
  return sheet;
}

/** Every vertex of a sheet, or of a solid's mesh, as points. */
export function sheetPoints(sheet) {
  const stride = sheet.numProp;
  const n = sheet.vertProperties.length / stride;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = i * stride;
    out[i] = [
      sheet.vertProperties[b],
      sheet.vertProperties[b + 1],
      sheet.vertProperties[b + 2]
    ];
  }
  return out;
}

/** Every triangle, as index triples. */
export function sheetTris(sheet) {
  const out = [];
  for (let i = 0; i < sheet.triVerts.length; i += 3) {
    out.push([sheet.triVerts[i], sheet.triVerts[i + 1], sheet.triVerts[i + 2]]);
  }
  return out;
}

export function sheetArea(sheet) {
  const P = sheetPoints(sheet);
  let a = 0;
  for (const [i, j, k] of sheetTris(sheet)) {
    a += len(cross(sub(P[j], P[i]), sub(P[k], P[i]))) / 2;
  }
  return a;
}

/** Merge vertices that sit on top of each other, and drop collapsed faces. */
export function weldSheet(sheet, tol = 1e-5) {
  const P = sheetPoints(sheet);
  const q = Math.max(tol, 1e-9);
  const seen = new Map();
  const map = new Int32Array(P.length);
  const kept = [];
  for (let i = 0; i < P.length; i++) {
    const key = `${Math.round(P[i][0] / q)},${Math.round(P[i][1] / q)},${Math.round(P[i][2] / q)}`;
    const hit = seen.get(key);
    if (hit === undefined) {
      seen.set(key, kept.length);
      map[i] = kept.length;
      kept.push(P[i]);
    } else {
      map[i] = hit;
    }
  }
  const tris = [];
  for (const [i, j, k] of sheetTris(sheet)) {
    const a = map[i];
    const b = map[j];
    const c = map[k];
    if (a === b || b === c || c === a) continue;
    tris.push([a, b, c]);
  }
  const out = makeSheet(kept, tris);
  if (sheet.grid) out.grid = sheet.grid;
  return out;
}

/**
 * The loops around the edge of a sheet.
 *
 * An edge used by one triangle is on the boundary; one used by two is inside.
 * Walking the boundary half edges nose to tail gives the loops in order, which
 * is what patch, stitch and extend all need.
 */
export function boundaryLoops(sheet) {
  const counts = new Map();
  const key = (a, b) => `${Math.min(a, b)}_${Math.max(a, b)}`;
  const halves = [];
  for (const [i, j, k] of sheetTris(sheet)) {
    for (const pair of [[i, j], [j, k], [k, i]]) {
      counts.set(key(pair[0], pair[1]), (counts.get(key(pair[0], pair[1])) || 0) + 1);
      halves.push(pair);
    }
  }
  // Keep the half edges whose pair is missing, in their own triangle's
  // direction, so each loop comes out oriented with the surface.
  const next = new Map();
  for (const [a, b] of halves) {
    if (counts.get(key(a, b)) !== 1) continue;
    if (!next.has(a)) next.set(a, []);
    next.get(a).push(b);
  }

  const loops = [];
  const used = new Set();
  for (const [start, outs] of next) {
    for (const first of outs) {
      if (used.has(`${start}_${first}`)) continue;
      const loop = [start];
      let a = start;
      let b = first;
      let guard = 0;
      while (guard++ < 1e6) {
        used.add(`${a}_${b}`);
        if (b === start) break;
        loop.push(b);
        const onward = (next.get(b) || []).filter((c) => !used.has(`${b}_${c}`));
        if (!onward.length) break;
        a = b;
        b = onward[0];
      }
      if (loop.length > 2) loops.push(loop);
    }
  }
  return loops;
}

/** Area weighted vertex normals, which is what an offset moves along. */
export function vertexNormals(sheet) {
  const P = sheetPoints(sheet);
  const acc = P.map(() => [0, 0, 0]);
  for (const [i, j, k] of sheetTris(sheet)) {
    const n = cross(sub(P[j], P[i]), sub(P[k], P[i]));
    for (const v of [i, j, k]) {
      acc[v][0] += n[0];
      acc[v][1] += n[1];
      acc[v][2] += n[2];
    }
  }
  return acc.map((n) => {
    const u = unit(n);
    return len(u) > 0 ? u : [0, 0, 1];
  });
}

/** Turn a sheet inside out. Which way it faces decides which way it thickens. */
export function reverseSheet(sheet) {
  const tris = sheetTris(sheet).map(([i, j, k]) => [i, k, j]);
  const out = makeSheet(sheetPoints(sheet), tris);
  if (sheet.grid) out.grid = { ...sheet.grid, reversed: !sheet.grid.reversed };
  return out;
}

/**
 * Move every surface off itself by the same distance.
 *
 * The point every vertex has to land on is the one that is `distance` from
 * each face meeting there, which on anything smooth is simply along the normal
 * and at a crease is the mitre. Solving for it directly, rather than averaging
 * the normals and stepping along that, is the difference between a wall that
 * is 2 thick everywhere and one that thins to 1.4 at every corner.
 *
 * Faces whose normals agree to within a few degrees are treated as one, so a
 * curved surface gives a single condition and reads as smooth, while a real
 * edge gives two and gets mitred.
 */
export function offsetSheet(sheet, distance) {
  const P = sheetPoints(sheet);
  const groups = P.map(() => []);
  for (const [i, j, k] of sheetTris(sheet)) {
    const fn = unit(cross(sub(P[j], P[i]), sub(P[k], P[i])));
    if (!len(fn)) continue;
    for (const v of [i, j, k]) {
      const g = groups[v];
      const hit = g.find((n) => dot(n.dir, fn) > 0.99);
      if (hit) {
        hit.dir = unit(add(mul(hit.dir, hit.count), fn));
        hit.count++;
      } else {
        g.push({ dir: fn, count: 1 });
      }
    }
  }

  const moved = P.map((p, v) => {
    // The most used faces first, so a corner solved from three of them is
    // solved from the three that actually shape it.
    const dirs = groups[v]
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map((g) => g.dir);
    const step = offsetStep(dirs, distance);
    return step ? add(p, step) : p;
  });

  const out = makeSheet(moved, sheetTris(sheet));
  if (sheet.grid) out.grid = sheet.grid;
  return out;
}

/**
 * The shortest move that is `d` clear of every one of these planes.
 *
 * One plane gives the normal. Two give the mitre along their crease. Three give
 * the corner of a box. It is the least squares answer, damped so that two
 * planes which are nearly the same do not send the corner off to infinity.
 */
function offsetStep(normals, d) {
  const m = normals.length;
  if (!m) return null;
  if (m === 1) return mul(normals[0], d);

  // v = N' lambda, with (N N') lambda = d, which is m by m and small.
  const A = [];
  for (let i = 0; i < m; i++) {
    A.push([]);
    for (let j = 0; j < m; j++) {
      A[i].push(dot(normals[i], normals[j]) + (i === j ? 1e-6 : 0));
    }
    A[i].push(d);
  }
  for (let c = 0; c < m; c++) {
    let pivot = c;
    for (let r = c + 1; r < m; r++) {
      if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
    }
    if (Math.abs(A[pivot][c]) < 1e-9) return mul(normals[0], d);
    [A[c], A[pivot]] = [A[pivot], A[c]];
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k];
    }
  }
  let v = [0, 0, 0];
  for (let i = 0; i < m; i++) v = add(v, mul(normals[i], A[i][m] / A[i][i]));
  // A mitre that has run away means the planes were nearly parallel after all.
  if (len(v) > Math.abs(d) * 8) return mul(unit(v), Math.abs(d) * 8 * Math.sign(d || 1));
  return v;
}


/* --------------------------------------------------------- triangulation */

/**
 * Ear clipping, with holes bridged in.
 *
 * Used to fill a boundary loop, which is what Patch does and what heals a face
 * after Delete Face. Written here rather than pulled in because the whole point
 * of the project is that the geometry is readable.
 *
 * Points are two dimensional. The indices returned are into the outer loop
 * followed by each hole in turn, which is the order the caller keeps its own
 * points in.
 */
export function earcut(outer, holes = []) {
  let ring = outer.slice();
  let idx = outer.map((_, i) => i);
  let offset = outer.length;

  for (const hole of holes) {
    if (hole.length < 3) {
      offset += hole.length;
      continue;
    }
    // Bridge to the outer loop at the closest pair, which turns a ring with a
    // hole in it into one loop that ear clipping can eat.
    let best = null;
    for (let a = 0; a < ring.length; a++) {
      for (let b = 0; b < hole.length; b++) {
        const d = Math.hypot(ring[a][0] - hole[b][0], ring[a][1] - hole[b][1]);
        if (!best || d < best.d) best = { a, b, d };
      }
    }
    const bridgePts = [];
    const bridgeIdx = [];
    for (let i = 0; i <= hole.length; i++) {
      const h = (best.b + i) % hole.length;
      bridgePts.push(hole[h]);
      bridgeIdx.push(offset + h);
    }
    bridgePts.push(ring[best.a]);
    bridgeIdx.push(idx[best.a]);
    ring = [...ring.slice(0, best.a + 1), ...bridgePts, ...ring.slice(best.a + 1)];
    idx = [...idx.slice(0, best.a + 1), ...bridgeIdx, ...idx.slice(best.a + 1)];
    offset += hole.length;
  }

  const n = ring.length;
  if (n < 3) return [];

  let signed = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    signed += a[0] * b[1] - b[0] * a[1];
  }
  if (signed < 0) {
    ring = ring.slice().reverse();
    idx = idx.slice().reverse();
  }

  const area = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

  const live = ring.map((_, i) => i);
  const out = [];
  let guard = 0;
  while (live.length > 3 && guard++ < 100000) {
    let clipped = false;
    for (let i = 0; i < live.length; i++) {
      const ia = live[(i - 1 + live.length) % live.length];
      const ib = live[i];
      const ic = live[(i + 1) % live.length];
      const a = ring[ia];
      const b = ring[ib];
      const c = ring[ic];
      if (area(a, b, c) <= EPS) continue;

      let contains = false;
      for (const j of live) {
        if (j === ia || j === ib || j === ic) continue;
        const p = ring[j];
        // Bridging a hole leaves two copies of the two points it was bridged
        // between. Compared by index they are different vertices; compared by
        // position they are the corner itself, and a corner is never inside
        // its own ear. Without this every ear is refused and the fill degrades
        // to a fan across the hole.
        if (samePoint2(p, a) || samePoint2(p, b) || samePoint2(p, c)) continue;
        if (area(a, b, p) > EPS && area(b, c, p) > EPS && area(c, a, p) > EPS) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      out.push([idx[ia], idx[ib], idx[ic]]);
      live.splice(i, 1);
      clipped = true;
      break;
    }
    // A ring that will not clip is self intersecting. Fan what is left rather
    // than spin: a rough fill beats no fill, and the boundary is still right.
    if (!clipped) break;
  }
  if (live.length === 3) {
    out.push([idx[live[0]], idx[live[1]], idx[live[2]]]);
  } else if (live.length > 3) {
    for (let i = 1; i + 1 < live.length; i++) {
      out.push([idx[live[0]], idx[live[i]], idx[live[i + 1]]]);
    }
  }
  return out;
}

const samePoint2 = (a, b) =>
  Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/** The plane that fits a run of points best, by Newell's method. */
export function bestFitPlane(points) {
  const c = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0] / points.length;
    c[1] += p[1] / points.length;
    c[2] += p[2] / points.length;
  }
  let n = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  n = unit(n);
  if (!len(n)) n = [0, 0, 1];
  const x = unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  const y = cross(n, x);
  return { origin: c, n, x, y };
}

/** How far a run strays from the plane through it. */
export function planarity(points) {
  const pl = bestFitPlane(points);
  let worst = 0;
  for (const p of points) worst = Math.max(worst, Math.abs(dot(sub(p, pl.origin), pl.n)));
  return worst;
}

/** The diagonal of the box around a run of points. */
export function spanOf(points) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let d = 0; d < 3; d++) {
      if (p[d] < lo[d]) lo[d] = p[d];
      if (p[d] > hi[d]) hi[d] = p[d];
    }
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/* --------------------------------------------------------------- creation */

/**
 * Fill a boundary with a surface.
 *
 * A flat loop is triangulated in its own plane. One that is not flat gets a fan
 * from a point in the middle of it, which is a real patch rather than a
 * pretence at one: the boundary is exactly the curve given, and the inside is
 * the simplest surface that meets it.
 */
export function patchLoops(loops) {
  if (!loops?.length) return null;
  const outer = loops[0];
  if (outer.length < 3) return null;
  const pl = bestFitPlane(outer);
  const flat = planarity(outer) < Math.max(1e-3, 1e-4 * spanOf(outer));

  if (flat) {
    const to2 = (p) => {
      const d = sub(p, pl.origin);
      return [dot(d, pl.x), dot(d, pl.y)];
    };
    const holes = loops.slice(1).map((l) => l.map(to2));
    const tris = earcut(outer.map(to2), holes);
    const points = [...outer, ...loops.slice(1).flat()];
    return tris.length ? makeSheet(points, tris) : null;
  }

  const centre = [0, 0, 0];
  for (const p of outer) {
    centre[0] += p[0] / outer.length;
    centre[1] += p[1] / outer.length;
    centre[2] += p[2] / outer.length;
  }
  const points = [...outer, centre];
  const c = outer.length;
  const tris = [];
  for (let i = 0; i < outer.length; i++) tris.push([i, (i + 1) % outer.length, c]);
  return makeSheet(points, tris);
}

/** Resample a run of points to exactly n, evenly along its length. */
export function resampleRun(points, n, closed = false) {
  if (!points || points.length < 2) return null;
  const pts = closed ? [...points, points[0]] : points;
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = len(sub(pts[i], pts[i - 1]));
    seg.push(d);
    total += d;
  }
  if (total < EPS) return null;

  const out = [];
  const steps = closed ? n : n - 1;
  for (let s = 0; s <= steps; s++) {
    if (closed && s === steps) break;
    let want = (total * s) / steps;
    let i = 0;
    while (i < seg.length && want > seg[i]) {
      want -= seg[i];
      i++;
    }
    if (i >= seg.length) {
      out.push(pts[pts.length - 1].slice());
      continue;
    }
    const t = seg[i] > EPS ? want / seg[i] : 0;
    out.push(add(pts[i], mul(sub(pts[i + 1], pts[i]), t)));
  }
  return out;
}

/** Turn a closed run so it starts at whichever point is nearest to `near`. */
function alignRun(run, near) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < run.length; i++) {
    const d = len(sub(run[i], near));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return [...run.slice(best), ...run.slice(0, best)];
}

/**
 * A surface from rows of points: points along u, rows down v.
 *
 * Every generated surface comes through here, which is what gives them all a
 * parameterisation and so lets an isoparametric curve be read straight off.
 */
export function gridSheet(rows, opts = {}) {
  const valid = (rows || []).filter((r) => r && r.length);
  if (valid.length < 2) return null;
  const cols = valid[0].length;
  if (cols < 2 || valid.some((r) => r.length !== cols)) return null;

  const points = [];
  for (const row of valid) for (const p of row) points.push(p);

  const tris = [];
  const at = (r, c) => r * cols + (c % cols);
  const lastCol = opts.closedU ? cols : cols - 1;
  for (let r = 0; r + 1 < valid.length; r++) {
    for (let c = 0; c < lastCol; c++) {
      tris.push([at(r, c), at(r, c + 1), at(r + 1, c + 1)]);
      tris.push([at(r, c), at(r + 1, c + 1), at(r + 1, c)]);
    }
  }
  if (opts.closedV) {
    const r = valid.length - 1;
    for (let c = 0; c < lastCol; c++) {
      tris.push([at(r, c), at(r, c + 1), at(0, c + 1)]);
      tris.push([at(r, c), at(0, c + 1), at(0, c)]);
    }
  }
  if (!tris.length) return null;
  return makeSheet(points, tris, {
    grid: { rows: valid.length, cols, closedU: !!opts.closedU, closedV: !!opts.closedV }
  });
}

/** The surface between two curves, straight from one to the other. */
export function ruledSheet(runA, runB, opts = {}) {
  const n = opts.samples || 64;
  const closed = !!opts.closed;
  const a = resampleRun(runA, n, closed);
  let b = resampleRun(runB, n, closed);
  if (!a || !b) return null;

  // Which end of the second curve lines up with the first decides whether the
  // surface comes out flat or with a twist through it.
  if (closed) b = alignRun(b, a[0]);
  else if (len(sub(b[0], a[0])) > len(sub(b[b.length - 1], a[0]))) b = b.slice().reverse();

  return gridSheet([a, b], { closedU: closed });
}

/** A curve dragged along a straight line. */
export function extrudeRunSheet(run, direction, opts = {}) {
  const from = opts.from ?? 0;
  const to = opts.to ?? 1;
  const a = run.map((p) => add(p, mul(direction, from)));
  const b = run.map((p) => add(p, mul(direction, to)));
  return gridSheet([a, b], { closedU: !!opts.closed });
}

/** A curve turned about an axis. */
export function revolveRunSheet(run, origin, axis, degrees, segments = 64, opts = {}) {
  const ax = unit(axis);
  if (!len(ax)) return null;
  const full = Math.abs(degrees) >= 359.999;
  const steps = Math.max(3, Math.round((segments * Math.abs(degrees)) / 360));
  const rows = [];
  for (let s = 0; s <= steps; s++) {
    if (full && s === steps) break;
    const t = ((degrees * Math.PI) / 180) * (s / steps);
    const c = Math.cos(t);
    const sn = Math.sin(t);
    rows.push(
      run.map((p) => {
        const d = sub(p, origin);
        const par = mul(ax, dot(d, ax));
        const perp = sub(d, par);
        const side = cross(ax, perp);
        return add(origin, add(par, add(mul(perp, c), mul(side, sn))));
      })
    );
  }
  return gridSheet(rows, { closedU: !!opts.closed, closedV: full });
}

/**
 * A curve carried along a path, staying square to it.
 *
 * The section is read in the first frame and replayed in every later one, so
 * whatever offset it had from the start of the path it keeps the whole way.
 */
export function sweepRunSheet(run, frames, opts = {}) {
  if (!frames?.length || !run?.length) return null;
  const f0 = frames[0];
  const local = run.map((p) => {
    const d = sub(p, f0.origin);
    return [dot(d, f0.x), dot(d, f0.y)];
  });
  const rows = frames.map((f) =>
    local.map(([x, y]) => add(f.origin, add(mul(f.x, x), mul(f.y, y))))
  );
  return gridSheet(rows, { closedU: !!opts.closed, closedV: !!opts.closedPath });
}

/** A surface through a run of sections. */
export function loftRunsSheet(runs, opts = {}) {
  const n = opts.samples || 64;
  const closed = !!opts.closed;
  const rows = [];
  let reference = null;
  for (const run of runs) {
    let r = resampleRun(run, n, closed);
    if (!r) return null;
    if (closed && reference) r = alignRun(r, reference);
    reference = r[0];
    rows.push(r);
  }
  return gridSheet(rows, { closedU: closed, closedV: !!opts.closedLoft });
}

/* ----------------------------------------------------------------- modify */

/**
 * Push a sheet's boundary outwards, carrying on the way the surface was going.
 *
 * Each boundary point moves along the direction the surface leaves at, which on
 * a flat sheet is exactly in plane and on a curved one is tangent, so the new
 * band meets the old surface without a crease in it.
 */
export function extendSheet(sheet, distance) {
  const P = sheetPoints(sheet);
  const loops = boundaryLoops(sheet);
  if (!loops.length) return sheet;

  const neighbours = new Map();
  for (const [i, j, k] of sheetTris(sheet)) {
    for (const [a, b] of [[i, j], [j, k], [k, i]]) {
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      if (!neighbours.has(b)) neighbours.set(b, new Set());
      neighbours.get(a).add(b);
      neighbours.get(b).add(a);
    }
  }

  const points = P.map((p) => p.slice());
  const tris = sheetTris(sheet);
  for (const loop of loops) {
    const onLoop = new Set(loop);
    const ring = loop.map((v) => {
      let away = [0, 0, 0];
      for (const nb of neighbours.get(v) || []) {
        if (onLoop.has(nb)) continue;
        away = add(away, unit(sub(P[v], P[nb])));
      }
      const dir = unit(away);
      return points.push(add(P[v], mul(dir, distance))) - 1;
    });
    for (let i = 0; i < loop.length; i++) {
      const j = (i + 1) % loop.length;
      tris.push([loop[i], loop[j], ring[j]]);
      tris.push([loop[i], ring[j], ring[i]]);
    }
  }
  return weldSheet(makeSheet(points, tris), 1e-6);
}

/**
 * Cut a sheet where another surface crosses it, and keep one side.
 *
 * Every triangle is split against every cutter triangle it meets, then the
 * pieces are flooded outwards from the one nearest the point that was picked,
 * never stepping over a cut. What survives is the piece the pick was in.
 */
export function trimSheet(sheet, cutters, keepPoint) {
  const cutTris = [];
  for (const c of cutters || []) {
    const CP = sheetPoints(c);
    for (const [i, j, k] of sheetTris(c)) cutTris.push([CP[i], CP[j], CP[k]]);
  }
  if (!cutTris.length) return sheet;

  const P = sheetPoints(sheet);
  const points = [];
  const pieces = [];
  // Where the cuts ran. An edge of the result is a cut when both its ends lie
  // on one of these and within the stretch of it that was actually cut, which
  // is what stops the flood step walking straight across a cut, and stops it
  // treating some unrelated edge that happens to be coplanar as one.
  const cuts = [];

  for (const [i, j, k] of sheetTris(sheet)) {
    const tri = [P[i], P[j], P[k]];
    const nTri = unit(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
    const segs = [];
    for (const ct of cutTris) {
      const seg = triangleIntersection(tri, ct);
      if (seg) segs.push(seg);
    }

    let parts = [tri];
    for (const [s0, s1] of segs) {
      const cutN = unit(cross(sub(s1, s0), nTri));
      if (!len(cutN)) continue;
      const next = [];
      for (const part of parts) next.push(...splitPolygon(part, s0, cutN));
      parts = next;
      const dir = unit(sub(s1, s0));
      const ta = dot(s0, dir);
      const tb = dot(s1, dir);
      cuts.push({ o: s0, n: cutN, dir, lo: Math.min(ta, tb), hi: Math.max(ta, tb) });
    }
    for (const part of parts) {
      if (part.length < 3) continue;
      const base = points.length;
      for (const p of part) points.push(p);
      for (let t = 1; t + 1 < part.length; t++) pieces.push([base, base + t, base + t + 1]);
    }
  }

  const merged = weldSheet(makeSheet(points, pieces), 1e-6);
  return keepConnected(merged, keepPoint, cuts);
}

/** Does this edge lie along one of the cuts? */
function onACut(a, b, cuts) {
  for (const c of cuts) {
    if (Math.abs(dot(sub(a, c.o), c.n)) > 1e-5) continue;
    if (Math.abs(dot(sub(b, c.o), c.n)) > 1e-5) continue;
    const ta = dot(a, c.dir);
    const tb = dot(b, c.dir);
    if (Math.min(ta, tb) < c.lo - 1e-5) continue;
    if (Math.max(ta, tb) > c.hi + 1e-5) continue;
    return true;
  }
  return false;
}

/** Cut a convex polygon by a plane, returning whichever halves are real. */
function splitPolygon(poly, origin, normal) {
  const d = poly.map((p) => dot(sub(p, origin), normal));
  if (d.every((v) => v >= -1e-7)) return [poly];
  if (d.every((v) => v <= 1e-7)) return [poly];
  const front = [];
  const back = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const a = poly[i];
    const b = poly[j];
    if (d[i] >= -1e-7) front.push(a);
    if (d[i] <= 1e-7) back.push(a);
    if ((d[i] > 1e-7 && d[j] < -1e-7) || (d[i] < -1e-7 && d[j] > 1e-7)) {
      const t = d[i] / (d[i] - d[j]);
      const p = add(a, mul(sub(b, a), t));
      front.push(p);
      back.push(p);
    }
  }
  const out = [];
  if (front.length > 2) out.push(front);
  if (back.length > 2) out.push(back);
  return out.length ? out : [poly];
}

/** Keep the run of triangles reachable from the pick without crossing a cut. */
function keepConnected(sheet, keepPoint, cuts) {
  const P = sheetPoints(sheet);
  const tris = sheetTris(sheet);
  if (!tris.length) return sheet;

  const centre = (t) => [
    (P[t[0]][0] + P[t[1]][0] + P[t[2]][0]) / 3,
    (P[t[0]][1] + P[t[1]][1] + P[t[2]][1]) / 3,
    (P[t[0]][2] + P[t[1]][2] + P[t[2]][2]) / 3
  ];
  let seed = 0;
  if (keepPoint) {
    let best = Infinity;
    tris.forEach((t, i) => {
      const d = len(sub(centre(t), keepPoint));
      if (d < best) {
        best = d;
        seed = i;
      }
    });
  }

  const ek = (a, b) => `${Math.min(a, b)}_${Math.max(a, b)}`;
  const across = new Map();
  tris.forEach((t, i) => {
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      if (!across.has(ek(a, b))) across.set(ek(a, b), []);
      across.get(ek(a, b)).push(i);
    }
  });

  const keep = new Set([seed]);
  const queue = [seed];
  while (queue.length) {
    const t = tris[queue.pop()];
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      if (onACut(P[a], P[b], cuts)) continue;
      for (const other of across.get(ek(a, b)) || []) {
        if (keep.has(other)) continue;
        keep.add(other);
        queue.push(other);
      }
    }
  }
  // Points the surviving triangles no longer use go with them. Leaving them
  // behind makes a trimmed surface still look, to anything that reads its
  // points, as though it reached where it used to.
  return compactSheet(P, tris.filter((_, i) => keep.has(i)));
}

/** Where two triangles cross, as a segment, or null if they do not. */
export function triangleIntersection(a, b) {
  const na = unit(cross(sub(a[1], a[0]), sub(a[2], a[0])));
  const nb = unit(cross(sub(b[1], b[0]), sub(b[2], b[0])));
  if (!len(na) || !len(nb)) return null;

  const db = b.map((p) => dot(sub(p, a[0]), na));
  if (db.every((v) => v > 1e-9) || db.every((v) => v < -1e-9)) return null;
  const da = a.map((p) => dot(sub(p, b[0]), nb));
  if (da.every((v) => v > 1e-9) || da.every((v) => v < -1e-9)) return null;

  // Both cross the other's plane, so each spans an interval on the line where
  // the two planes meet, and the answer is where those intervals overlap.
  const line = unit(cross(na, nb));
  if (!len(line)) return null;

  const spanOn = (tri, d) => {
    const hits = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if ((d[i] > 1e-9 && d[j] < -1e-9) || (d[i] < -1e-9 && d[j] > 1e-9)) {
        const t = d[i] / (d[i] - d[j]);
        hits.push(add(tri[i], mul(sub(tri[j], tri[i]), t)));
      } else if (Math.abs(d[i]) <= 1e-9) {
        hits.push(tri[i].slice());
      }
    }
    if (hits.length < 2) return null;
    const ts = hits.map((p) => dot(p, line));
    return [Math.min(...ts), Math.max(...ts)];
  };

  const sa = spanOn(a, da);
  const sb = spanOn(b, db);
  if (!sa || !sb) return null;
  const lo = Math.max(sa[0], sb[0]);
  const hi = Math.min(sa[1], sb[1]);
  if (hi - lo < 1e-7) return null;

  const base = pointOnBothPlanes(a[0], na, b[0], nb);
  const t0 = dot(base, line);
  return [add(base, mul(line, lo - t0)), add(base, mul(line, hi - t0))];
}

/** A point lying on both planes, to hang the parameter along the line off. */
function pointOnBothPlanes(pa, na, pb, nb) {
  const d1 = dot(na, pa);
  const d2 = dot(nb, pb);
  const n = cross(na, nb);
  const denom = dot(n, n);
  if (denom < 1e-18) return pa.slice();
  return mul(add(mul(cross(n, nb), d1), mul(cross(na, n), d2)), 1 / denom);
}

/* ----------------------------------------------------------------- stitch */

/**
 * Weld a set of sheets into one mesh, and say whether it closed.
 *
 * Nothing goes to the kernel until this says closed. manifold will take a mesh
 * with holes in it and produce something that looks plausible and is not a
 * solid, and by the time that shows up it is in a printed part.
 */
/**
 * Wind every triangle the same way round.
 *
 * Surfaces made separately have no reason to agree on which side is out, and a
 * mesh whose triangles disagree is not a solid however well it closes. Walking
 * from one triangle to its neighbours and flipping any that share an edge in
 * the same direction settles it; the sign of the enclosed volume then says
 * whether the whole thing came out inside out.
 */
export function orientMesh(sheet) {
  const tris = sheetTris(sheet);
  const P = sheetPoints(sheet);
  if (!tris.length) return sheet;

  const ek = (a, b) => `${Math.min(a, b)}_${Math.max(a, b)}`;
  const across = new Map();
  tris.forEach((t, i) => {
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      if (!across.has(ek(a, b))) across.set(ek(a, b), []);
      across.get(ek(a, b)).push(i);
    }
  });

  const done = new Set();
  for (let start = 0; start < tris.length; start++) {
    if (done.has(start)) continue;
    done.add(start);
    const queue = [start];
    while (queue.length) {
      const i = queue.pop();
      const t = tris[i];
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        for (const j of across.get(ek(a, b)) || []) {
          if (j === i || done.has(j)) continue;
          const u = tris[j];
          // Neighbours that agree traverse the shared edge in opposite
          // directions. Reading it the same way means one of them is flipped.
          const sameWay =
            (u[0] === a && u[1] === b) ||
            (u[1] === a && u[2] === b) ||
            (u[2] === a && u[0] === b);
          if (sameWay) tris[j] = [u[0], u[2], u[1]];
          done.add(j);
          queue.push(j);
        }
      }
    }
  }

  let vol = 0;
  for (const [i, j, k] of tris) vol += dot(P[i], cross(P[j], P[k])) / 6;
  const out = vol < 0 ? tris.map(([i, j, k]) => [i, k, j]) : tris;
  const made = makeSheet(P, out);
  if (sheet.grid) made.grid = sheet.grid;
  return made;
}

export function stitchSheets(sheets, tol = 1e-4) {
  const points = [];
  const tris = [];
  for (const s of sheets) {
    const base = points.length;
    for (const p of sheetPoints(s)) points.push(p);
    for (const [i, j, k] of sheetTris(s)) tris.push([base + i, base + j, base + k]);
  }
  const welded = weldSheet(makeSheet(points, tris), tol);
  const loops = boundaryLoops(welded);
  const openEdges = loops.reduce((n, l) => n + l.length, 0);
  // Only a closed mesh has an inside to point away from, so that is the only
  // one worth orienting.
  const done = openEdges === 0 ? orientMesh(welded) : welded;
  return { sheet: done, closed: openEdges === 0, openLoops: loops, openEdges };
}

/** One sheet per face of a solid, which is what Unstitch produces. */
export function unstitchMesh(mesh, topo) {
  const P = sheetPoints(mesh);
  const out = [];
  for (const face of topo.faces) {
    const tris = face.tris.map((t) => [
      mesh.triVerts[t * 3],
      mesh.triVerts[t * 3 + 1],
      mesh.triVerts[t * 3 + 2]
    ]);
    if (!tris.length) continue;
    out.push({ face, sheet: compactSheet(P, tris) });
  }
  return out;
}

/** The chosen faces of a mesh, as one sheet. */
export function sheetFromFaces(mesh, topo, faceIds) {
  const P = sheetPoints(mesh);
  const wanted = new Set(faceIds);
  const tris = [];
  for (const face of topo.faces) {
    if (!wanted.has(face.id)) continue;
    for (const t of face.tris) {
      tris.push([mesh.triVerts[t * 3], mesh.triVerts[t * 3 + 1], mesh.triVerts[t * 3 + 2]]);
    }
  }
  return tris.length ? compactSheet(P, tris) : null;
}

/** Everything except the chosen faces, as one sheet with holes where they were. */
export function sheetWithoutFaces(mesh, topo, faceIds) {
  const P = sheetPoints(mesh);
  const dropped = new Set(faceIds);
  const tris = [];
  for (const face of topo.faces) {
    if (dropped.has(face.id)) continue;
    for (const t of face.tris) {
      tris.push([mesh.triVerts[t * 3], mesh.triVerts[t * 3 + 1], mesh.triVerts[t * 3 + 2]]);
    }
  }
  return tris.length ? compactSheet(P, tris) : null;
}

/** The same triangles, with only the points they actually use. */
function compactSheet(P, tris) {
  const map = new Map();
  const pts = [];
  const out = tris.map((t) =>
    t.map((v) => {
      if (!map.has(v)) {
        map.set(v, pts.length);
        pts.push(P[v]);
      }
      return map.get(v);
    })
  );
  return makeSheet(pts, out);
}

/**
 * Give a sheet thickness, and so turn it into something the kernel can hold.
 *
 * Two offsets, and a wall around every boundary loop. The wall is what closes
 * it, so if a loop is missed the result is not a solid at all, and the caller
 * is told here rather than finding out from a bad print.
 */
export function thickenSheet(sheet, distance, symmetric = false) {
  const back = symmetric ? offsetSheet(sheet, -distance / 2) : sheet;
  const front = symmetric ? offsetSheet(sheet, distance / 2) : offsetSheet(sheet, distance);

  const P0 = sheetPoints(back);
  const P1 = sheetPoints(front);
  const n = P0.length;
  const points = [...P0, ...P1];
  const tris = [];
  for (const [i, j, k] of sheetTris(back)) tris.push([i, k, j]);
  for (const [i, j, k] of sheetTris(front)) tris.push([n + i, n + j, n + k]);

  for (const loop of boundaryLoops(back)) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      tris.push([a, b, n + b]);
      tris.push([a, n + b, n + a]);
    }
  }
  let shell = weldSheet(makeSheet(points, tris), 1e-6);
  const closed = boundaryLoops(shell).length === 0;
  if (closed) shell = orientMesh(shell);
  return { sheet: shell, closed };
}

/* ------------------------------------------------------------ reading off */

/** Where a ray first meets a mesh, or null. */
export function rayHit(origin, direction, mesh) {
  const P = sheetPoints(mesh);
  const d = unit(direction);
  let best = null;
  for (const [i, j, k] of sheetTris(mesh)) {
    const e1 = sub(P[j], P[i]);
    const e2 = sub(P[k], P[i]);
    const pv = cross(d, e2);
    const det = dot(e1, pv);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tv = sub(origin, P[i]);
    const u = dot(tv, pv) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qv = cross(tv, e1);
    const v = dot(d, qv) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = dot(e2, qv) * inv;
    if (t < 1e-7) continue;
    if (!best || t < best.t) best = { t, point: add(origin, mul(d, t)) };
  }
  return best;
}

/**
 * Drop a run of points onto a surface along a direction.
 *
 * Points that miss break the run, so a curve projected onto a surface that only
 * partly covers it comes back as the pieces that landed rather than as one
 * curve with a jump across the gap.
 */
export function projectRunOnto(run, direction, mesh, opts = {}) {
  const reach = opts.reach || 1e5;
  const dir = unit(direction);
  const runs = [];
  let current = [];
  for (const p of run) {
    const hit = rayHit(add(p, mul(dir, -reach)), dir, mesh);
    if (hit) {
      current.push(hit.point);
    } else {
      if (current.length > 1) runs.push(current);
      current = [];
    }
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

/**
 * Curves of constant u or v across a surface.
 *
 * Only a surface with a parameterisation has these, which is why `grid` is
 * carried on everything generated here. A face lifted off a solid is a triangle
 * soup and has none, and saying so is better than inventing one.
 */
export function isoCurves(sheet, along = 'u', count = 5) {
  const g = sheet.grid;
  if (!g) return null;
  const P = sheetPoints(sheet);
  const at = (r, c) => P[r * g.cols + (c % g.cols)];
  const out = [];
  const n = Math.max(1, count);

  if (along === 'u') {
    // Constant v: one curve along each chosen row.
    for (let i = 0; i < n; i++) {
      const r = n === 1 ? 0 : Math.round((i * (g.rows - 1)) / (n - 1));
      const run = [];
      for (let c = 0; c < g.cols; c++) run.push(at(r, c));
      if (g.closedU) run.push(at(r, 0));
      out.push(run);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const c = n === 1 ? 0 : Math.round((i * (g.cols - 1)) / (n - 1));
      const run = [];
      for (let r = 0; r < g.rows; r++) run.push(at(r, c));
      if (g.closedV) run.push(at(0, c));
      out.push(run);
    }
  }
  return out;
}

export { dot, cross, sub, add, mul, unit, len };
