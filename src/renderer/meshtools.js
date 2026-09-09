/**
 * Mesh tools: what to do with a triangle soup somebody sent you.
 *
 * The kernel here is already a mesh kernel, so a mesh body is not a foreign
 * object the way it is in a boundary representation package. The distinction
 * that matters is not mesh against solid, it is **watertight against not**: a
 * closed mesh can go to the kernel and be cut, joined and printed, and an open
 * one cannot. Everything in this file is either a way of measuring that gap or
 * a way of closing it.
 *
 * Meshes arrive in the same shape everything else in the app uses, which is
 * what `sheet.js` settled: numProp, vertProperties, triVerts. So topology,
 * display, picking and export all work on one already, and the tools here are
 * about the triangles rather than about plumbing.
 */

import {
  makeSheet,
  sheetPoints,
  sheetTris,
  weldSheet,
  boundaryLoops,
  orientMesh,
  patchLoops,
  spanOf
} from './sheet.js';

const EPS = 1e-12;

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

/* --------------------------------------------------------------- measuring */

/**
 * What is wrong with this mesh, if anything.
 *
 * Reported rather than fixed, because which of these matter depends on what
 * the mesh is for: a mesh being used as a reference to cut against does not
 * have to be closed, and one about to be printed does.
 */
export function meshHealth(mesh) {
  const P = sheetPoints(mesh);
  const tris = sheetTris(mesh);

  let degenerate = 0;
  for (const [i, j, k] of tris) {
    if (i === j || j === k || k === i) {
      degenerate++;
      continue;
    }
    const area = len(cross(sub(P[j], P[i]), sub(P[k], P[i]))) / 2;
    if (area < 1e-12) degenerate++;
  }

  // A vertex two triangles merely share the position of, rather than the index.
  const seen = new Map();
  let duplicated = 0;
  for (const p of P) {
    const key = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
    if (seen.has(key)) duplicated++;
    else seen.set(key, 1);
  }

  const welded = weldSheet(mesh, 1e-5);
  const loops = boundaryLoops(welded);
  const openEdges = loops.reduce((n, l) => n + l.length, 0);

  // An edge with three or more triangles on it is where two surfaces have been
  // stuck together, and no amount of hole filling will make it a solid.
  const counts = new Map();
  const key = (a, b) => `${Math.min(a, b)}_${Math.max(a, b)}`;
  for (const [i, j, k] of sheetTris(welded)) {
    for (const [a, b] of [[i, j], [j, k], [k, i]]) {
      counts.set(key(a, b), (counts.get(key(a, b)) || 0) + 1);
    }
  }
  let nonManifold = 0;
  for (const n of counts.values()) if (n > 2) nonManifold++;

  return {
    triangles: tris.length,
    vertices: P.length,
    degenerate,
    duplicated,
    openEdges,
    holes: loops.length,
    nonManifold,
    closed: openEdges === 0 && nonManifold === 0 && degenerate === 0
  };
}

/* ----------------------------------------------------------------- repair */

/**
 * Make a mesh into something the kernel will take.
 *
 * In the order that actually works: weld first, because two triangles that only
 * share a position are an open edge until they share an index; drop what is
 * degenerate, because a triangle with no area has no normal and poisons the
 * orientation walk; then agree on which way is out; then close what is left.
 */
export function repairMesh(mesh, opts = {}) {
  const tol = opts.tolerance ?? 1e-4;
  let out = weldSheet(mesh, tol);

  // Triangles with no area, and the exact duplicates a bad exporter leaves.
  const P = sheetPoints(out);
  const kept = [];
  const seen = new Set();
  for (const [i, j, k] of sheetTris(out)) {
    if (i === j || j === k || k === i) continue;
    if (len(cross(sub(P[j], P[i]), sub(P[k], P[i]))) / 2 < 1e-12) continue;
    const id = [i, j, k].slice().sort((a, b) => a - b).join('_');
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push([i, j, k]);
  }
  out = makeSheet(P, kept);
  out = dropNonManifold(out);

  if (opts.fillHoles !== false) {
    const loops = boundaryLoops(out);
    if (loops.length) {
      const pts = sheetPoints(out);
      const pieces = [out];
      for (const loop of loops) {
        const patch = patchLoops([loop.map((v) => pts[v])]);
        if (patch) pieces.push(patch);
      }
      out = mergeMeshes(pieces);
      out = weldSheet(out, tol);
      // Filling can lay a patch over something that was already there, so the
      // check for a third triangle on an edge has to run again afterwards.
      out = dropNonManifold(out);
    }
  }

  if (opts.orient !== false) out = orientMesh(out);
  return out;
}

/**
 * Take the surplus off any edge that has more than two triangles on it.
 *
 * A third triangle on an edge is a flap: two surfaces stuck together, or a fill
 * laid over something that was already there. No amount of hole filling makes
 * such a mesh a solid, because the trouble is not a gap, it is a fold. The
 * smallest triangle goes first, which is nearly always the sliver that should
 * not have been there, and dropping it can expose another so the pass repeats.
 */
/**
 * Close the gaps between triangles that only nearly meet.
 *
 * The half of Repair that joins things, on its own. A mesh out of a scanner or
 * out of a bad exporter has every triangle written with its own three corners,
 * so two triangles that look joined share no vertex at all and every edge in
 * the file is an open edge. Welding by position is what makes it one surface.
 *
 * The tolerance is the whole of it and it is a real decision: too small and
 * nothing joins, too large and detail the size of the tolerance is thrown away.
 * So both counts come back, and the caller can raise it and look again.
 */
export function stitchMesh(mesh, tolerance = 1e-4) {
  const before = meshHealth(mesh);
  const welded = weldSheet(mesh, Math.max(1e-9, tolerance));

  // Triangles that welding has collapsed onto a line have no area left and are
  // not part of the surface any more.
  const P = sheetPoints(welded);
  const kept = [];
  for (const [i, j, k] of sheetTris(welded)) {
    if (i === j || j === k || k === i) continue;
    if (len(cross(sub(P[j], P[i]), sub(P[k], P[i]))) / 2 < 1e-12) continue;
    kept.push([i, j, k]);
  }
  const out = makeSheet(P, kept);
  const after = meshHealth(out);
  return {
    mesh: out,
    joined: before.vertices - after.vertices,
    openBefore: before.openEdges,
    openAfter: after.openEdges,
    closed: after.closed
  };
}

/**
 * Fill the holes in a mesh, or the small ones only.
 *
 * The other half of Repair. Filling every hole is wrong as often as it is
 * right: a scan of a bracket has a hundred pinholes worth closing and one big
 * opening where the part was cut off, and closing that one turns the part into
 * a bag. So holes are measured, and how big a hole is worth filling is asked.
 *
 * The measure is the perimeter of the hole rather than the number of edges
 * around it, because a hole in a fine mesh and the same hole in a coarse one
 * are the same hole.
 */
export function patchMesh(mesh, opts = {}) {
  const welded = weldSheet(mesh, opts.tolerance ?? 1e-5);
  const loops = boundaryLoops(welded);
  if (!loops.length) return { mesh: welded, filled: 0, left: 0, sizes: [] };

  const P = sheetPoints(welded);
  const perimeter = (loop) => {
    let sum = 0;
    for (let i = 0; i < loop.length; i++) {
      sum += len(sub(P[loop[(i + 1) % loop.length]], P[loop[i]]));
    }
    return sum;
  };
  const sizes = loops.map(perimeter);
  const limit = opts.maxPerimeter > 0 ? opts.maxPerimeter : Infinity;

  const pieces = [welded];
  let filled = 0;
  let left = 0;
  loops.forEach((loop, i) => {
    if (sizes[i] > limit) {
      left++;
      return;
    }
    const patch = patchLoops([loop.map((v) => P[v])]);
    if (patch?.triVerts?.length) {
      pieces.push(patch);
      filled++;
    } else {
      left++;
    }
  });
  if (!filled) return { mesh: welded, filled: 0, left, sizes };

  let out = weldSheet(mergeMeshes(pieces), opts.tolerance ?? 1e-5);
  // A patch can land on top of something that was already there, so the check
  // for a third triangle on an edge has to run after filling and not before.
  out = dropNonManifold(out);
  return { mesh: out, filled, left, sizes };
}

/**
 * How much each vertex of a mesh should follow a move, by distance.
 *
 * The chosen ones move fully and everything within reach of them follows less
 * and less, on a curve that leaves flat at both ends so the edge of the
 * influence does not show as a ridge.
 */
export function meshVertexWeights(mesh, verts, reach = 0) {
  const weight = new Map();
  for (const v of verts) weight.set(v, 1);
  if (!(reach > 0)) return weight;

  const P = sheetPoints(mesh);
  const chosen = [...new Set(verts)];
  for (let v = 0; v < P.length; v++) {
    if (weight.has(v)) continue;
    let best = Infinity;
    for (const c of chosen) {
      const d = len(sub(P[v], P[c]));
      if (d < best) best = d;
    }
    if (best >= reach) continue;
    const x = 1 - best / reach;
    weight.set(v, x * x * (3 - 2 * x));
  }
  return weight;
}

/** Move a mesh's vertices by a shift, scaled by how much each should follow. */
export function shiftMeshPoints(mesh, weights, shift) {
  const P = sheetPoints(mesh).map((p) => p.slice());
  for (const [v, w] of weights) {
    if (!P[v] || !(w > 0)) continue;
    P[v] = add(P[v], mul(shift, w));
  }
  const out = makeSheet(P, sheetTris(mesh));
  return out;
}

/** Every vertex of the triangles listed. */
export function vertsOfTriangles(mesh, tris) {
  const out = new Set();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) out.add(mesh.triVerts[t * 3 + k]);
  }
  return [...out];
}

export function dropNonManifold(mesh) {
  let P = sheetPoints(mesh);
  let tris = sheetTris(mesh);
  const key = (a, b) => `${Math.min(a, b)}_${Math.max(a, b)}`;

  for (let pass = 0; pass < 8; pass++) {
    const on = new Map();
    tris.forEach((t, i) => {
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const k = key(a, b);
        if (!on.has(k)) on.set(k, []);
        on.get(k).push(i);
      }
    });

    const doomed = new Set();
    for (const list of on.values()) {
      if (list.length <= 2) continue;
      const live = list.filter((i) => !doomed.has(i));
      if (live.length <= 2) continue;
      const area = (i) => {
        const t = tris[i];
        return len(cross(sub(P[t[1]], P[t[0]]), sub(P[t[2]], P[t[0]]))) / 2;
      };
      live.sort((a, b) => area(a) - area(b));
      for (let i = 0; i < live.length - 2; i++) doomed.add(live[i]);
    }
    if (!doomed.size) break;

    const kept = tris.filter((_, i) => !doomed.has(i));
    const next = compact(P, kept);
    P = sheetPoints(next);
    tris = sheetTris(next);
  }
  return makeSheet(P, tris);
}

/** Several meshes as one, with their indices moved out of each other's way. */
export function mergeMeshes(meshes) {
  const points = [];
  const tris = [];
  for (const m of meshes) {
    const base = points.length;
    for (const p of sheetPoints(m)) points.push(p);
    for (const [i, j, k] of sheetTris(m)) tris.push([base + i, base + j, base + k]);
  }
  return makeSheet(points, tris);
}

/** The connected pieces of a mesh, each as its own. */
export function separateMesh(mesh) {
  const tris = sheetTris(mesh);
  const P = sheetPoints(mesh);
  if (!tris.length) return [];

  // Union find over the vertices, which is what "connected" means here.
  const parent = new Int32Array(P.length);
  for (let i = 0; i < P.length; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const join = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const [i, j, k] of tris) {
    join(i, j);
    join(j, k);
  }

  const groups = new Map();
  for (const t of tris) {
    const r = find(t[0]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  return [...groups.values()].map((list) => compact(P, list));
}

/** The same triangles, with only the points they use. */
function compact(P, tris) {
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

/* ---------------------------------------------------------------- smooth */

/**
 * Pull every vertex toward the middle of its neighbours.
 *
 * Plain Laplacian smoothing, which shrinks: a sphere smoothed enough becomes a
 * smaller sphere. Taubin's alternating positive and negative step is what stops
 * that, and it is two lines rather than one, so it is what runs here.
 */
export function smoothMesh(mesh, opts = {}) {
  const iterations = Math.max(1, Math.round(opts.iterations ?? 5));
  const lambda = opts.strength ?? 0.5;
  const mu = opts.shrink === false ? -lambda / (1 - 0.1 * lambda) : 0;
  const holdBoundary = opts.holdBoundary !== false;

  let P = sheetPoints(mesh).map((p) => p.slice());
  const tris = sheetTris(mesh);
  const neighbours = P.map(() => new Set());
  for (const [i, j, k] of tris) {
    neighbours[i].add(j);
    neighbours[i].add(k);
    neighbours[j].add(i);
    neighbours[j].add(k);
    neighbours[k].add(i);
    neighbours[k].add(j);
  }
  const onEdge = new Set();
  if (holdBoundary) {
    for (const loop of boundaryLoops(mesh)) for (const v of loop) onEdge.add(v);
  }

  const step = (factor) => {
    const next = P.map((p, v) => {
      if (onEdge.has(v) || !neighbours[v].size) return p;
      let mid = [0, 0, 0];
      for (const n of neighbours[v]) mid = add(mid, P[n]);
      mid = mul(mid, 1 / neighbours[v].size);
      return add(p, mul(sub(mid, p), factor));
    });
    P = next;
  };

  for (let it = 0; it < iterations; it++) {
    step(lambda);
    if (mu) step(mu);
  }
  return makeSheet(P, tris);
}

/* ---------------------------------------------------------------- reduce */

/**
 * Fewer triangles, in the places that cost the least shape.
 *
 * Garland and Heckbert's quadric error metric: every vertex carries the sum of
 * the squared distances to the planes of the faces around it, as a symmetric
 * 4 by 4, and collapsing an edge costs whatever that sum says about where the
 * two ends end up. Collapsing cheapest first is what keeps a flat face flat and
 * spends the triangles on the curvature instead.
 */
export function reduceMesh(mesh, opts = {}) {
  const welded = weldSheet(mesh, opts.tolerance ?? 1e-5);
  const P = sheetPoints(welded).map((p) => p.slice());
  const tris = sheetTris(welded);
  const total = tris.length;

  const target = opts.triangles
    ? Math.max(4, Math.round(opts.triangles))
    : Math.max(4, Math.round(total * (opts.ratio ?? 0.5)));
  if (target >= total) return welded;

  // Quadrics, one per vertex.
  const Q = P.map(() => new Float64Array(10));
  const addPlane = (v, n, d) => {
    const q = Q[v];
    const [a, b, c] = n;
    q[0] += a * a;
    q[1] += a * b;
    q[2] += a * c;
    q[3] += a * d;
    q[4] += b * b;
    q[5] += b * c;
    q[6] += b * d;
    q[7] += c * c;
    q[8] += c * d;
    q[9] += d * d;
  };
  for (const [i, j, k] of tris) {
    const n = unit(cross(sub(P[j], P[i]), sub(P[k], P[i])));
    if (!len(n)) continue;
    const d = -dot(n, P[i]);
    addPlane(i, n, d);
    addPlane(j, n, d);
    addPlane(k, n, d);
  }

  // A boundary edge gets a wall of its own, so an open mesh keeps its outline.
  const edgeFaces = new Map();
  const ekey = (a, b) => `${Math.min(a, b)}_${Math.max(a, b)}`;
  for (const t of tris) {
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      const key = ekey(a, b);
      if (!edgeFaces.has(key)) edgeFaces.set(key, []);
      edgeFaces.get(key).push(t);
    }
  }
  for (const [key, faces] of edgeFaces) {
    if (faces.length !== 1) continue;
    const [a, b] = key.split('_').map(Number);
    const t = faces[0];
    const fn = unit(cross(sub(P[t[1]], P[t[0]]), sub(P[t[2]], P[t[0]])));
    const along = unit(sub(P[b], P[a]));
    const wall = unit(cross(along, fn));
    if (!len(wall)) continue;
    const d = -dot(wall, P[a]);
    // Heavily weighted, because losing the silhouette is worse than losing
    // a triangle in the middle of a face.
    for (let w = 0; w < 100; w++) {
      addPlane(a, wall, d);
      addPlane(b, wall, d);
    }
  }

  const cost = (q, p) => {
    const [x, y, z] = p;
    return (
      q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x +
      q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y +
      q[7] * z * z + 2 * q[8] * z +
      q[9]
    );
  };
  const sumQ = (a, b) => {
    const out = new Float64Array(10);
    for (let i = 0; i < 10; i++) out[i] = a[i] + b[i];
    return out;
  };

  const alive = new Uint8Array(P.length).fill(1);
  const around = P.map(() => new Set());
  tris.forEach((t, i) => {
    around[t[0]].add(i);
    around[t[1]].add(i);
    around[t[2]].add(i);
  });
  const live = tris.map(() => true);

  // Candidate collapses, cheapest first. A plain array re-sorted lazily beats a
  // heap here: the mesh sizes this sees are thousands, not millions, and a heap
  // whose keys keep changing needs more bookkeeping than it saves.
  const edges = [];
  for (const key of edgeFaces.keys()) {
    const [a, b] = key.split('_').map(Number);
    edges.push(placeEdge(a, b));
  }

  function placeEdge(a, b) {
    const q = sumQ(Q[a], Q[b]);
    // The midpoint, or whichever end is cheaper. Solving for the true optimum
    // needs the 3 by 3 to be invertible and it often is not, and the best of
    // three candidates is within a whisker of it in practice.
    const mid = mul(add(P[a], P[b]), 0.5);
    const options = [P[a], P[b], mid];
    let best = null;
    for (const p of options) {
      const c = cost(q, p);
      if (!best || c < best.c) best = { c, p: p.slice() };
    }
    return { a, b, cost: best.c, at: best.p };
  }

  let count = total;
  let guard = 0;
  while (count > target && edges.length && guard++ < total * 4) {
    edges.sort((x, y) => x.cost - y.cost);
    let did = false;
    for (let e = 0; e < edges.length; e++) {
      const { a, b, at } = edges[e];
      if (a === b || !alive[a] || !alive[b]) {
        edges.splice(e, 1);
        e--;
        continue;
      }
      // Would the collapse turn a triangle inside out? If so it is not cheap
      // at all, whatever the quadric says.
      if (flips(a, b, at)) continue;

      // Do it: b becomes a, at the new position.
      P[a] = at;
      Q[a] = sumQ(Q[a], Q[b]);
      alive[b] = 0;
      for (const t of around[b]) {
        if (!live[t]) continue;
        const tri = tris[t];
        for (let i = 0; i < 3; i++) if (tri[i] === b) tri[i] = a;
        if (tri[0] === tri[1] || tri[1] === tri[2] || tri[2] === tri[0]) {
          live[t] = false;
          count--;
        } else {
          around[a].add(t);
        }
      }
      around[b].clear();
      edges.splice(e, 1);
      // Anything that touched b now touches a, and costs something else. An
      // edge between the two of them becomes an edge from a to itself, which is
      // not an edge at all: collapsing one marks the surviving vertex dead and
      // strands every triangle on it, and the decimation stalls where it stands.
      for (let i = edges.length - 1; i >= 0; i--) {
        const g = edges[i];
        const ga = g.a === b ? a : g.a;
        const gb = g.b === b ? a : g.b;
        if (ga === gb) {
          edges.splice(i, 1);
          continue;
        }
        if (ga !== g.a || gb !== g.b || ga === a || gb === a) {
          edges[i] = placeEdge(ga, gb);
        }
      }
      did = true;
      break;
    }
    if (!did) break;
  }

  function flips(a, b, at) {
    for (const v of [a, b]) {
      for (const t of around[v]) {
        if (!live[t]) continue;
        const tri = tris[t];
        if (tri.includes(a) && tri.includes(b)) continue;
        const before = unit(cross(sub(P[tri[1]], P[tri[0]]), sub(P[tri[2]], P[tri[0]])));
        const moved = tri.map((x) => (x === a || x === b ? at : P[x]));
        const after = unit(cross(sub(moved[1], moved[0]), sub(moved[2], moved[0])));
        if (!len(after)) return true;
        if (dot(before, after) < 0.1) return true;
      }
    }
    return false;
  }

  const kept = [];
  for (let t = 0; t < tris.length; t++) if (live[t]) kept.push(tris[t]);
  return compact(P, kept);
}

/* ---------------------------------------------------------------- remesh */

/**
 * Triangles of one size, everywhere.
 *
 * Botsch and Kobbelt's incremental remeshing, which is four passes repeated:
 * split what is too long, collapse what is too short, flip toward six
 * neighbours a vertex, and slide each vertex across its own surface toward the
 * middle of its neighbours. Sliding is what makes them even, and projecting
 * back onto the mesh it started as is what stops that sliding from rounding the
 * shape off.
 */
export function remesh(mesh, opts = {}) {
  const P0 = sheetPoints(mesh);
  const target =
    opts.edgeLength ?? Math.max(1e-3, spanOf(P0) / Math.max(4, opts.divisions ?? 40));
  const iterations = Math.max(1, Math.round(opts.iterations ?? 4));

  const original = weldSheet(mesh, 1e-5);
  const index = new SurfaceIndex(original);

  let work = original;
  for (let it = 0; it < iterations; it++) {
    work = splitLong(work, target * (4 / 3));
    work = collapseShort(work, target * (4 / 5), target * (4 / 3));
    work = flipToValence(work);
    work = smoothMesh(work, { iterations: 1, strength: 0.5, holdBoundary: true });
    if (opts.project !== false) work = project(work, index);
  }
  return weldSheet(work, 1e-6);
}

function splitLong(mesh, maxLen) {
  const P = sheetPoints(mesh).map((p) => p.slice());
  const tris = sheetTris(mesh);
  const midOf = new Map();
  const key = (a, b) => `${Math.min(a, b)}_${Math.max(a, b)}`;

  const midpoint = (a, b) => {
    const k = key(a, b);
    if (midOf.has(k)) return midOf.get(k);
    const idx = P.push(mul(add(P[a], P[b]), 0.5)) - 1;
    midOf.set(k, idx);
    return idx;
  };

  const out = [];
  for (const [i, j, k] of tris) {
    const e = [
      len(sub(P[j], P[i])) > maxLen,
      len(sub(P[k], P[j])) > maxLen,
      len(sub(P[i], P[k])) > maxLen
    ];
    const n = e.filter(Boolean).length;
    if (n === 0) {
      out.push([i, j, k]);
      continue;
    }
    // Split every long edge of the triangle at once, which keeps the mesh
    // conforming without a second pass to tidy up after it.
    const a = e[0] ? midpoint(i, j) : null;
    const b = e[1] ? midpoint(j, k) : null;
    const c = e[2] ? midpoint(k, i) : null;
    if (a !== null && b !== null && c !== null) {
      out.push([i, a, c], [a, j, b], [c, b, k], [a, b, c]);
    } else if (a !== null && b !== null) {
      out.push([i, a, b], [a, j, b], [i, b, k]);
    } else if (b !== null && c !== null) {
      out.push([j, b, c], [b, k, c], [j, c, i]);
    } else if (c !== null && a !== null) {
      out.push([k, c, a], [c, i, a], [k, a, j]);
    } else if (a !== null) {
      out.push([i, a, k], [a, j, k]);
    } else if (b !== null) {
      out.push([j, b, i], [b, k, i]);
    } else {
      out.push([k, c, j], [c, i, j]);
    }
  }
  return makeSheet(P, out);
}

function collapseShort(mesh, minLen, maxLen) {
  const P = sheetPoints(mesh).map((p) => p.slice());
  const tris = sheetTris(mesh).map((t) => t.slice());
  const onEdge = new Set();
  for (const loop of boundaryLoops(mesh)) for (const v of loop) onEdge.add(v);

  const around = P.map(() => new Set());
  tris.forEach((t, i) => {
    around[t[0]].add(i);
    around[t[1]].add(i);
    around[t[2]].add(i);
  });
  const live = tris.map(() => true);
  const alive = new Uint8Array(P.length).fill(1);

  const neighbours = (v) => {
    const out = new Set();
    for (const t of around[v]) {
      if (!live[t]) continue;
      for (const x of tris[t]) if (x !== v) out.add(x);
    }
    return out;
  };

  for (let v = 0; v < P.length; v++) {
    if (!alive[v] || onEdge.has(v)) continue;
    for (const n of neighbours(v)) {
      if (!alive[n] || onEdge.has(n)) continue;
      if (len(sub(P[n], P[v])) >= minLen) continue;
      // Collapsing must not make some other edge too long instead.
      let ok = true;
      for (const x of neighbours(n)) {
        if (x !== v && len(sub(P[x], P[v])) > maxLen) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      alive[n] = 0;
      for (const t of around[n]) {
        if (!live[t]) continue;
        const tri = tris[t];
        for (let i = 0; i < 3; i++) if (tri[i] === n) tri[i] = v;
        if (tri[0] === tri[1] || tri[1] === tri[2] || tri[2] === tri[0]) live[t] = false;
        else around[v].add(t);
      }
      around[n].clear();
      break;
    }
  }
  const kept = [];
  for (let t = 0; t < tris.length; t++) if (live[t]) kept.push(tris[t]);
  return compact(P, kept);
}

/**
 * Flip the edges that would leave their vertices with better valence.
 *
 * Six neighbours is what a vertex wants in an even triangulation, and four on a
 * boundary. Counting how far off the four vertices of two adjoining triangles
 * are, before and after, says whether the flip is worth making.
 */
function flipToValence(mesh) {
  const P = sheetPoints(mesh);
  const tris = sheetTris(mesh).map((t) => t.slice());
  const key = (a, b) => `${Math.min(a, b)}_${Math.max(a, b)}`;

  const valence = new Int32Array(P.length);
  const edges = new Map();
  for (let t = 0; t < tris.length; t++) {
    const tri = tris[t];
    for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
      const k = key(a, b);
      if (!edges.has(k)) edges.set(k, []);
      edges.get(k).push(t);
      valence[a]++;
    }
  }
  const onEdge = new Set();
  for (const loop of boundaryLoops(mesh)) for (const v of loop) onEdge.add(v);
  const want = (v) => (onEdge.has(v) ? 4 : 6);

  for (const [k, faces] of edges) {
    if (faces.length !== 2) continue;
    const [a, b] = k.split('_').map(Number);
    const [t0, t1] = faces;
    const c = tris[t0].find((v) => v !== a && v !== b);
    const d = tris[t1].find((v) => v !== a && v !== b);
    if (c === undefined || d === undefined || c === d) continue;

    const before =
      Math.abs(valence[a] - want(a)) + Math.abs(valence[b] - want(b)) +
      Math.abs(valence[c] - want(c)) + Math.abs(valence[d] - want(d));
    const after =
      Math.abs(valence[a] - 1 - want(a)) + Math.abs(valence[b] - 1 - want(b)) +
      Math.abs(valence[c] + 1 - want(c)) + Math.abs(valence[d] + 1 - want(d));
    if (after >= before) continue;

    // Only if it does not fold the surface over on itself.
    const n0 = unit(cross(sub(P[b], P[a]), sub(P[c], P[a])));
    const m0 = unit(cross(sub(P[d], P[c]), sub(P[a], P[c])));
    const m1 = unit(cross(sub(P[b], P[c]), sub(P[d], P[c])));
    if (dot(n0, m0) < 0.2 || dot(n0, m1) < 0.2) continue;

    tris[t0] = [c, a, d];
    tris[t1] = [c, d, b];
    valence[a]--;
    valence[b]--;
    valence[c]++;
    valence[d]++;
  }
  return makeSheet(P, tris);
}

/**
 * A grid over a mesh's triangles, for asking what is nearest.
 *
 * Remeshing slides vertices across the surface and then has to put them back on
 * it. Without an index that is every vertex against every triangle, which on
 * anything real is the difference between a second and a minute.
 */
export class SurfaceIndex {
  constructor(mesh) {
    this.P = sheetPoints(mesh);
    this.tris = sheetTris(mesh);
    const span = spanOf(this.P) || 1;
    this.cell = Math.max(span / 40, 1e-6);
    // How far a search can usefully widen: past this it is off the end of the
    // mesh in every direction and there is nothing more to find.
    this.reach = Math.ceil(span / this.cell) + 2;
    this.grid = new Map();
    this.tris.forEach((t, i) => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const v of t) {
        for (let d = 0; d < 3; d++) {
          lo[d] = Math.min(lo[d], this.P[v][d]);
          hi[d] = Math.max(hi[d], this.P[v][d]);
        }
      }
      for (let x = Math.floor(lo[0] / this.cell); x <= Math.floor(hi[0] / this.cell); x++) {
        for (let y = Math.floor(lo[1] / this.cell); y <= Math.floor(hi[1] / this.cell); y++) {
          for (let z = Math.floor(lo[2] / this.cell); z <= Math.floor(hi[2] / this.cell); z++) {
            const k = `${x}_${y}_${z}`;
            if (!this.grid.has(k)) this.grid.set(k, []);
            this.grid.get(k).push(i);
          }
        }
      }
    });
  }

  /** The point on the mesh nearest this one, or the point itself if nothing is near. */
  closest(p) {
    const c = this.cell;
    let best = null;
    for (let ring = 0; ring < 3 && !best; ring++) {
      const seen = new Set();
      const bx = Math.floor(p[0] / c);
      const by = Math.floor(p[1] / c);
      const bz = Math.floor(p[2] / c);
      for (let x = bx - ring; x <= bx + ring; x++) {
        for (let y = by - ring; y <= by + ring; y++) {
          for (let z = bz - ring; z <= bz + ring; z++) {
            for (const t of this.grid.get(`${x}_${y}_${z}`) || []) {
              if (seen.has(t)) continue;
              seen.add(t);
              const q = closestOnTriangle(p, this.P[this.tris[t][0]], this.P[this.tris[t][1]], this.P[this.tris[t][2]]);
              const d = len(sub(q, p));
              if (!best || d < best.d) best = { d, q };
            }
          }
        }
      }
    }
    return best ? best.q : p;
  }

  /**
   * The point on the mesh nearest this one, however far away it is.
   *
   * Where `closest` gives up after three rings and hands the point back,
   * because a remeshed vertex that has not moved is a safe answer, this one
   * keeps widening until it finds something. Laying a tool onto a face by
   * shortest distance starts with the tool held well clear of the body, so
   * giving up quietly would leave it exactly where it was drawn.
   *
   * It stops as soon as the best it has found is nearer than the ring it is
   * about to search, which is what makes it the real nearest point rather than
   * the first one it happened to meet.
   */
  nearest(p) {
    const c = this.cell;
    const bx = Math.floor(p[0] / c);
    const by = Math.floor(p[1] / c);
    const bz = Math.floor(p[2] / c);
    const seen = new Set();
    let best = null;
    for (let ring = 0; ring <= this.reach; ring++) {
      if (best && best.d <= (ring - 1) * c) break;
      for (let x = bx - ring; x <= bx + ring; x++) {
        for (let y = by - ring; y <= by + ring; y++) {
          for (let z = bz - ring; z <= bz + ring; z++) {
            for (const t of this.grid.get(`${x}_${y}_${z}`) || []) {
              if (seen.has(t)) continue;
              seen.add(t);
              const q = closestOnTriangle(
                p,
                this.P[this.tris[t][0]],
                this.P[this.tris[t][1]],
                this.P[this.tris[t][2]]
              );
              const d = len(sub(q, p));
              if (!best || d < best.d) best = { d, q };
            }
          }
        }
      }
    }
    return best ? best.q : p;
  }
}

/** The nearest point of a triangle to a point, Ericson's case analysis. */
export function closestOnTriangle(p, a, b, c) {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a.slice();

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b.slice();

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3 || EPS);
    return add(a, mul(ab, v));
  }

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c.slice();

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6 || EPS);
    return add(a, mul(ac, w));
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6) || EPS);
    return add(b, mul(sub(c, b), w));
  }

  const denom = 1 / (va + vb + vc || EPS);
  return add(a, add(mul(ab, vb * denom), mul(ac, vc * denom)));
}

function project(mesh, index) {
  const onEdge = new Set();
  for (const loop of boundaryLoops(mesh)) for (const v of loop) onEdge.add(v);
  const P = sheetPoints(mesh).map((p, i) => (onEdge.has(i) ? p : index.closest(p)));
  return makeSheet(P, sheetTris(mesh));
}

/* ------------------------------------------------------------- plane cut */

/**
 * Cut a mesh with a plane.
 *
 * Every triangle the plane crosses is split on it, and what happens next is the
 * cut type: keep one side, keep both as separate bodies, or keep the whole
 * thing and only remember where the cut ran. Filling caps the opening the cut
 * left, which is the difference between a body you can print and a shell.
 */
export function planeCut(mesh, plane, opts = {}) {
  const P = sheetPoints(mesh);
  const n = unit(plane.n);
  const o = plane.origin;
  const side = (p) => dot(sub(p, o), n);

  const near = [];
  const far = [];
  const points = [];
  const push = (p) => points.push(p) - 1;
  const key = (p) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)},${Math.round(p[2] * 1e6)}`;
  const seen = new Map();
  const at = (p) => {
    const k = key(p);
    if (seen.has(k)) return seen.get(k);
    const i = push(p.slice());
    seen.set(k, i);
    return i;
  };

  for (const t of sheetTris(mesh)) {
    const tri = t.map((v) => P[v]);
    const d = tri.map(side);
    if (d.every((x) => x >= -1e-9)) {
      far.push(tri.map(at));
      continue;
    }
    if (d.every((x) => x <= 1e-9)) {
      near.push(tri.map(at));
      continue;
    }
    // It straddles: clip it both ways and keep the pieces.
    const front = clip(tri, d, 1);
    const back = clip(tri, d, -1);
    for (const poly of [front]) fan(poly, far);
    for (const poly of [back]) fan(poly, near);
  }

  function clip(tri, d, want) {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const di = d[i] * want;
      const dj = d[j] * want;
      if (di >= -1e-9) out.push(tri[i]);
      if ((di > 1e-9 && dj < -1e-9) || (di < -1e-9 && dj > 1e-9)) {
        const s = d[i] / (d[i] - d[j]);
        out.push(add(tri[i], mul(sub(tri[j], tri[i]), s)));
      }
    }
    return out;
  }

  function fan(poly, into) {
    if (poly.length < 3) return;
    const idx = poly.map(at);
    for (let i = 1; i + 1 < idx.length; i++) into.push([idx[0], idx[i], idx[i + 1]]);
  }

  // Both sides are built out of one shared list of points, so each piece has to
  // be given only the ones its own triangles use. Left in, they make a piece
  // look, to anything that reads its points, as though it reached across the
  // cut. Clipping also leaves slivers of no area where a corner sat exactly on
  // the plane, and those stop a mesh being a solid however well it closes.
  const make = (list) => {
    if (!list.length) return null;
    const real = list.filter((t) => {
      if (t[0] === t[1] || t[1] === t[2] || t[2] === t[0]) return false;
      const [a, b, c] = t.map((v) => points[v]);
      return len(cross(sub(b, a), sub(c, a))) / 2 > 1e-10;
    });
    if (!real.length) return null;
    return weldSheet(compact(points, real), 1e-6);
  };
  let a = make(near);
  let b = make(far);

  if (opts.fill !== false) {
    a = capOn(a, plane);
    b = capOn(b, plane);
  }

  if (opts.mode === 'split') return [a, b].filter(Boolean);
  if (opts.mode === 'faces') {
    const both = make([...near, ...far]);
    return both ? [both] : [];
  }
  return [opts.keep === 'far' ? b : a].filter(Boolean);
}

/** Close the opening a cut left, in the plane it was cut on. */
function capOn(mesh, plane) {
  if (!mesh) return mesh;
  const P = sheetPoints(mesh);
  const n = unit(plane.n);
  const pieces = [mesh];
  for (const loop of boundaryLoops(mesh)) {
    const pts = loop.map((v) => P[v]);
    // Only the loops that actually lie in the cutting plane. A mesh that was
    // already open somewhere else keeps its own holes.
    const off = pts.reduce((m, p) => Math.max(m, Math.abs(dot(sub(p, plane.origin), n))), 0);
    if (off > 1e-4) continue;
    const patch = patchLoops([pts]);
    if (patch) pieces.push(patch);
  }
  if (pieces.length === 1) return mesh;
  const joined = weldSheet(mergeMeshes(pieces), 1e-6);
  const JP = sheetPoints(joined);
  const real = sheetTris(joined).filter((t) => {
    if (t[0] === t[1] || t[1] === t[2] || t[2] === t[0]) return false;
    return len(cross(sub(JP[t[1]], JP[t[0]]), sub(JP[t[2]], JP[t[0]]))) / 2 > 1e-10;
  });
  return orientMesh(makeSheet(JP, real));
}

/**
 * The curve where a plane crosses a mesh.
 *
 * Read as segments and then chained, so what comes back is closed loops rather
 * than a bag of pieces. This is what Create Mesh Section Sketch is for:
 * something to trace over when reverse engineering a scan.
 */
export function sectionCurves(mesh, plane) {
  const P = sheetPoints(mesh);
  const n = unit(plane.n);
  const o = plane.origin;
  const side = (p) => dot(sub(p, o), n);

  const segs = [];
  for (const t of sheetTris(mesh)) {
    const tri = t.map((v) => P[v]);
    const d = tri.map(side);
    const hits = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if ((d[i] > 1e-9 && d[j] < -1e-9) || (d[i] < -1e-9 && d[j] > 1e-9)) {
        const s = d[i] / (d[i] - d[j]);
        hits.push(add(tri[i], mul(sub(tri[j], tri[i]), s)));
      } else if (Math.abs(d[i]) <= 1e-9) {
        hits.push(tri[i].slice());
      }
    }
    if (hits.length === 2 && len(sub(hits[0], hits[1])) > 1e-9) segs.push(hits);
  }
  return chainSegments(segs);
}

/** Segments nose to tail, into as few runs as they will make. */
function chainSegments(segs) {
  const key = (p) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
  const at = new Map();
  for (const [a, b] of segs) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const k = key(from);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(to);
    }
  }
  const used = new Set();
  const runs = [];
  for (const [a, b] of segs) {
    const id = `${key(a)}|${key(b)}`;
    if (used.has(id)) continue;
    used.add(id);
    used.add(`${key(b)}|${key(a)}`);

    const run = [a, b];
    // Forward, then backward, so an open run comes out whole rather than in two.
    for (const forward of [true, false]) {
      let guard = 0;
      while (guard++ < 1e5) {
        const end = forward ? run[run.length - 1] : run[0];
        const next = (at.get(key(end)) || []).find(
          (p) => !used.has(`${key(end)}|${key(p)}`)
        );
        if (!next) break;
        used.add(`${key(end)}|${key(next)}`);
        used.add(`${key(next)}|${key(end)}`);
        if (forward) run.push(next);
        else run.unshift(next);
      }
    }
    if (run.length > 1) runs.push(run);
  }
  return runs;
}

/* ------------------------------------------------------ texture extrude */

/**
 * Push a mesh's surface in and out by the brightness of an image.
 *
 * The image is laid over the mesh along a direction and each vertex moves along
 * its own normal by however light or dark the picture is where it lands. What
 * it is for is a texture that is really there, in the geometry, so it survives
 * being sliced and printed.
 */
export function displaceByImage(mesh, sample, opts = {}) {
  const plane = opts.plane;
  const height = opts.height ?? 1;
  const width = opts.width ?? Math.max(1e-6, spanOf(sheetPoints(mesh)));
  const invert = !!opts.invert;

  const P = sheetPoints(mesh);
  const normals = vertexNormalsOf(mesh);
  const moved = P.map((p, i) => {
    const d = sub(p, plane.origin);
    const u = dot(d, plane.x) / width + 0.5;
    const v = dot(d, plane.y) / width + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return p;
    let t = sample(u, v);
    if (!Number.isFinite(t)) return p;
    if (invert) t = 1 - t;
    return add(p, mul(normals[i], t * height));
  });
  return makeSheet(moved, sheetTris(mesh));
}

function vertexNormalsOf(mesh) {
  const P = sheetPoints(mesh);
  const acc = P.map(() => [0, 0, 0]);
  for (const [i, j, k] of sheetTris(mesh)) {
    const n = cross(sub(P[j], P[i]), sub(P[k], P[i]));
    for (const v of [i, j, k]) {
      acc[v][0] += n[0];
      acc[v][1] += n[1];
      acc[v][2] += n[2];
    }
  }
  return acc.map((n) => {
    const u = unit(n);
    return len(u) ? u : [0, 0, 1];
  });
}

export { sheetPoints as meshPoints, sheetTris as meshTris };
