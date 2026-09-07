/**
 * Form: subdivision surface modelling, the sculpt side of the app.
 *
 * A form is a **control cage**, a coarse polygon mesh, plus the smooth surface
 * that cage implies. You edit the cage, which has a handful of faces you can
 * actually grab, and the surface follows. Catmull-Clark is what turns one into
 * the other, and it is the whole of the geometry here: everything else in this
 * file either builds a cage, changes its topology, or reads the surface off it.
 *
 * The cage is stored in the document the way a sketch is, because nothing in
 * the timeline can reproduce it: it is drawn rather than derived. A form body
 * is a surface until Finish Form, which is the point it becomes a solid the
 * rest of the app can boolean.
 *
 * Faces are ordered lists of point indices, of any length. Quads are what
 * subdivision wants and what every primitive here makes, but a triangle or a
 * five sided face is legal and subdivides correctly: after one step everything
 * is quads regardless, which is the property the whole scheme rests on.
 */

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
  return l > EPS ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** The key an undirected edge is filed under. */
export const edgeKey = (a, b) => `${Math.min(a, b)}_${Math.max(a, b)}`;

/* ------------------------------------------------------------------ cages */

export function newCage() {
  return { points: [], faces: [], creases: {}, corners: {} };
}

export function cloneCage(cage) {
  return {
    points: cage.points.map((p) => [p[0], p[1], p[2]]),
    faces: cage.faces.map((f) => f.slice()),
    creases: { ...cage.creases },
    corners: { ...cage.corners },
    frozen: { ...(cage.frozen || {}) },
    symmetry: cage.symmetry ? { ...cage.symmetry } : undefined
  };
}

/**
 * Who touches what.
 *
 * Rebuilt on demand rather than kept alongside the cage, because every
 * operation here changes the topology and a stale adjacency is worse than no
 * adjacency at all.
 */
export function adjacency(cage) {
  const edges = new Map();
  const facesAt = cage.points.map(() => []);
  const edgesAt = cage.points.map(() => []);

  cage.faces.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      facesAt[a].push(fi);
      const k = edgeKey(a, b);
      let e = edges.get(k);
      if (!e) {
        e = { key: k, a: Math.min(a, b), b: Math.max(a, b), faces: [] };
        edges.set(k, e);
        edgesAt[e.a].push(k);
        edgesAt[e.b].push(k);
      }
      e.faces.push(fi);
    }
  });
  return { edges, facesAt, edgesAt };
}

/** Every edge that has only one face on it: the rim of an open cage. */
export function boundaryEdges(cage, adj = adjacency(cage)) {
  return [...adj.edges.values()].filter((e) => e.faces.length === 1);
}

/** The rim, walked into loops. */
export function boundaryLoops(cage, adj = adjacency(cage)) {
  const open = boundaryEdges(cage, adj);
  const next = new Map();
  for (const e of open) {
    if (!next.has(e.a)) next.set(e.a, []);
    if (!next.has(e.b)) next.set(e.b, []);
    next.get(e.a).push(e.b);
    next.get(e.b).push(e.a);
  }
  const seen = new Set();
  const loops = [];
  for (const e of open) {
    if (seen.has(e.key)) continue;
    const loop = [e.a, e.b];
    seen.add(e.key);
    let guard = 0;
    while (guard++ < 1e5) {
      const end = loop[loop.length - 1];
      const step = (next.get(end) || []).find(
        (v) => !seen.has(edgeKey(end, v))
      );
      if (step === undefined) break;
      seen.add(edgeKey(end, step));
      if (step === loop[0]) break;
      loop.push(step);
    }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

/* ---------------------------------------------------------- subdivision */

/**
 * One step of Catmull-Clark.
 *
 * Every face becomes a quad per corner, built from the corner, the two edge
 * points either side of it, and the face's own centre. Where an edge is creased
 * or on the rim it keeps its own shape instead of being averaged into the
 * surface, and a crease loses a level of sharpness each step, which is what
 * makes a sharpness of two hold an edge for two subdivisions and then let go.
 */
export function subdivide(cage) {
  const adj = adjacency(cage);
  const P = cage.points;
  const out = [];
  const creases = {};
  const corners = {};

  // Face points.
  const facePoint = cage.faces.map((face) => {
    let c = [0, 0, 0];
    for (const v of face) c = add(c, P[v]);
    return mul(c, 1 / face.length);
  });
  const faceIndex = facePoint.map((p) => out.push(p) - 1);

  // Edge points.
  const edgeIndex = new Map();
  for (const e of adj.edges.values()) {
    const sharp = cage.creases[e.key] || 0;
    const mid = mul(add(P[e.a], P[e.b]), 0.5);
    let point = mid;
    if (e.faces.length === 2 && sharp < 1) {
      const smooth = mul(
        add(add(P[e.a], P[e.b]), add(facePoint[e.faces[0]], facePoint[e.faces[1]])),
        0.25
      );
      // A sharpness between nothing and one is a blend, which is what makes a
      // crease adjustable rather than on or off.
      point = sharp > 0 ? add(mul(smooth, 1 - sharp), mul(mid, sharp)) : smooth;
    }
    edgeIndex.set(e.key, out.push(point) - 1);
    }

  // Vertex points.
  const vertexIndex = P.map((p, v) => {
    const around = adj.edgesAt[v].map((k) => adj.edges.get(k));
    const faces = [...new Set(adj.facesAt[v])];
    const n = around.length;

    const cornerWeight = cage.corners[v] || 0;
    const sharpEdges = around.filter(
      (e) => (cage.creases[e.key] || 0) >= 1 || e.faces.length === 1
    );

    // A corner, or a vertex where three or more sharp edges meet, does not
    // move at all: that is what makes the tip of a creased box stay a tip.
    if (cornerWeight >= 1 || sharpEdges.length > 2) return out.push(p.slice()) - 1;

    if (sharpEdges.length === 2) {
      // On a crease or a rim the vertex follows the crease alone, which keeps
      // the line of it smooth without the surface either side pulling on it.
      const m = sharpEdges.map((e) => P[e.a === v ? e.b : e.a]);
      const crease = mul(add(add(m[0], m[1]), mul(p, 6)), 1 / 8);
      return out.push(crease) - 1;
    }

    if (!n || !faces.length) return out.push(p.slice()) - 1;

    let F = [0, 0, 0];
    for (const fi of faces) F = add(F, facePoint[fi]);
    F = mul(F, 1 / faces.length);

    let R = [0, 0, 0];
    for (const e of around) R = add(R, mul(add(P[e.a], P[e.b]), 0.5));
    R = mul(R, 1 / n);

    const moved = mul(add(add(F, mul(R, 2)), mul(p, n - 3)), 1 / n);
    return out.push(moved) - 1;
  });

  // The faces: one quad per corner of every original face.
  const faces = [];
  cage.faces.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const v = face[i];
      const prev = face[(i - 1 + face.length) % face.length];
      const next = face[(i + 1) % face.length];
      faces.push([
        vertexIndex[v],
        edgeIndex.get(edgeKey(v, next)),
        faceIndex[fi],
        edgeIndex.get(edgeKey(prev, v))
      ]);
    }
  });

  // Creases carry down a level, one sharpness less.
  for (const e of adj.edges.values()) {
    const sharp = cage.creases[e.key] || 0;
    if (sharp <= 0) continue;
    const left = Math.max(0, sharp - 1);
    if (left <= 0) continue;
    const mid = edgeIndex.get(e.key);
    creases[edgeKey(vertexIndex[e.a], mid)] = left;
    creases[edgeKey(mid, vertexIndex[e.b])] = left;
  }
  for (const [v, w] of Object.entries(cage.corners)) {
    if (w > 0) corners[vertexIndex[Number(v)]] = Math.max(0, w - 1);
  }

  return { points: out, faces, creases, corners, symmetry: cage.symmetry };
}

/** The cage subdivided a few times, which is the surface it stands for. */
export function subdivided(cage, levels = 2) {
  let out = cage;
  for (let i = 0; i < Math.max(0, Math.min(5, levels)); i++) out = subdivide(out);
  return out;
}

/**
 * A cage as triangles, in the shape the rest of the app passes meshes around.
 *
 * Quads are split on the shorter diagonal, which keeps a saddle looking like a
 * saddle instead of folding it along whichever way the indices happened to run.
 */
export function cageToMesh(cage) {
  const P = cage.points;
  const tris = [];
  // Which cage face each triangle came from, kept in step with the triangles.
  const triFace = [];
  const emit = (fi, ...idx) => {
    for (let i = 0; i < idx.length; i += 3) triFace.push(fi);
    tris.push(...idx);
  };

  cage.faces.forEach((face, fi) => {
    if (face.length < 3) return;
    if (face.length === 3) {
      emit(fi, face[0], face[1], face[2]);
      return;
    }
    if (face.length === 4) {
      const [a, b, c, d] = face;
      // The shorter diagonal, so a saddle looks like a saddle rather than
      // folding along whichever way the indices happened to run.
      const ac = len(sub(P[c], P[a]));
      const bd = len(sub(P[d], P[b]));
      if (ac <= bd) emit(fi, a, b, c, a, c, d);
      else emit(fi, a, b, d, b, c, d);
      return;
    }
    // Anything larger is fanned. After one subdivision everything is a quad, so
    // this only ever sees the cage itself, where a fan is good enough to draw.
    emit(fi, ...fanFace(face));
  });

  const verts = new Float32Array(P.length * 3);
  for (let i = 0; i < P.length; i++) {
    verts[i * 3] = P[i][0];
    verts[i * 3 + 1] = P[i][1];
    verts[i * 3 + 2] = P[i][2];
  }
  return {
    numProp: 3,
    vertProperties: verts,
    triVerts: new Uint32Array(tris),
    // Which cage face each triangle belongs to. The topology reads this and
    // refuses to merge triangles that disagree, so one cage face stays one
    // selectable face however flat it lies against its neighbour. Without it a
    // flat cage is a single face and there is nothing to point at.
    triTag: triFace.map(() => 'cage'),
    triFaceID: Int32Array.from(triFace),
    splitBySource: true
  };
}

function fanFace(face) {
  const out = [];
  for (let i = 1; i + 1 < face.length; i++) out.push(face[0], face[i], face[i + 1]);
  return out;
}

/** The smooth surface, as triangles. */
export function formMesh(cage, levels = 2) {
  return cageToMesh(subdivided(cage, levels));
}

/**
 * Wind every face the same way round, and outward.
 *
 * A cage built by hand has no reason to agree with itself, and a mesh whose
 * faces disagree has no inside: the kernel reads it as having negative volume
 * and every normal in the viewport points the wrong way. Walking from one face
 * to its neighbours settles which way round they go, and the sign of the
 * enclosed volume settles which of the two answers is out.
 */
export function orientCage(cage) {
  const faces = cage.faces.map((f) => f.slice());
  if (!faces.length) return cage;

  const across = new Map();
  faces.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const k = edgeKey(face[i], face[(i + 1) % face.length]);
      if (!across.has(k)) across.set(k, []);
      across.get(k).push(fi);
    }
  });

  const done = new Set();
  for (let start = 0; start < faces.length; start++) {
    if (done.has(start)) continue;
    done.add(start);
    const queue = [start];
    while (queue.length) {
      const fi = queue.pop();
      const face = faces[fi];
      for (let i = 0; i < face.length; i++) {
        const a = face[i];
        const b = face[(i + 1) % face.length];
        for (const fj of across.get(edgeKey(a, b)) || []) {
          if (fj === fi || done.has(fj)) continue;
          const other = faces[fj];
          // Neighbours that agree cross their shared edge in opposite
          // directions. Reading it the same way means one is flipped.
          let sameWay = false;
          for (let j = 0; j < other.length; j++) {
            if (other[j] === a && other[(j + 1) % other.length] === b) sameWay = true;
          }
          if (sameWay) faces[fj] = other.slice().reverse();
          done.add(fj);
          queue.push(fj);
        }
      }
    }
  }

  // Six times the enclosed volume, which only needs its sign to be read.
  let vol = 0;
  for (const face of faces) {
    for (let i = 1; i + 1 < face.length; i++) {
      const a = cage.points[face[0]];
      const b = cage.points[face[i]];
      const c = cage.points[face[i + 1]];
      vol += dot(a, cross(b, c));
    }
  }
  const out = cloneCage(cage);
  out.faces = vol < 0 ? faces.map((f) => f.slice().reverse()) : faces;
  return out;
}

/**
 * Move a cage so the surface it stands for is the size that was asked for.
 *
 * Subdivision does not pass through its own cage: the smooth surface sits well
 * inside it, and a ball whose cage points are all exactly 20 from the middle
 * comes out nearer 17. Nobody asking for a radius of 20 means the cage, so the
 * cage is measured against its own limit once and scaled to suit.
 */
export function fitToLimit(cage, measure, target, apply, levels = 3) {
  const got = measure(subdivided(cage, levels));
  if (!(got > EPS) || !(target > EPS)) return cage;
  const out = cloneCage(cage);
  out.points = out.points.map((p) => apply(p, target / got));
  return out;
}

/** The average distance from a point, over a cage's own points. */
export function meanRadius(cage, centre) {
  if (!cage.points.length) return 0;
  let total = 0;
  for (const p of cage.points) total += len(sub(p, centre));
  return total / cage.points.length;
}

/** The largest distance from an axis, over a cage's own points. */
export function maxAxialRadius(cage, origin, dir) {
  let most = 0;
  for (const p of cage.points) {
    const d = sub(p, origin);
    most = Math.max(most, len(sub(d, mul(dir, dot(d, dir)))));
  }
  return most;
}

/* ------------------------------------------------------------ primitives */

/** A point on a plane's own coordinates, in the world. */
function at(plane, u, v, w = 0) {
  return [
    plane.origin[0] + plane.x[0] * u + plane.y[0] * v + plane.n[0] * w,
    plane.origin[1] + plane.x[1] * u + plane.y[1] * v + plane.n[1] * w,
    plane.origin[2] + plane.x[2] * u + plane.y[2] * v + plane.n[2] * w
  ];
}

/** A flat grid of quads. */
export function planeCage(plane, width, height, nx = 2, ny = 2) {
  const cage = newCage();
  const cols = Math.max(1, Math.round(nx));
  const rows = Math.max(1, Math.round(ny));
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      cage.points.push(
        at(plane, -width / 2 + (width * c) / cols, -height / 2 + (height * r) / rows)
      );
    }
  }
  const id = (r, c) => r * (cols + 1) + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cage.faces.push([id(r, c), id(r, c + 1), id(r + 1, c + 1), id(r + 1, c)]);
    }
  }
  return cage;
}

/** A box of quads, divided as asked in each direction. */
export function boxCage(plane, size, divisions = [2, 2, 2]) {
  const [w, d, h] = size;
  const [nx, ny, nz] = divisions.map((v) => Math.max(1, Math.round(v)));
  const cage = newCage();
  const index = new Map();

  const key = (i, j, k) => `${i}_${j}_${k}`;
  const point = (i, j, k) => {
    const kk = key(i, j, k);
    if (index.has(kk)) return index.get(kk);
    const p = at(
      plane,
      -w / 2 + (w * i) / nx,
      -d / 2 + (d * j) / ny,
      -h / 2 + (h * k) / nz
    );
    index.set(kk, cage.points.push(p) - 1);
    return index.get(kk);
  };

  // Only the shell: the six sides, each a grid, sharing their edges.
  const quad = (a, b, c, d2) => cage.faces.push([a, b, c, d2]);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      quad(point(i, j, 0), point(i + 1, j, 0), point(i + 1, j + 1, 0), point(i, j + 1, 0));
      quad(point(i, j, nz), point(i, j + 1, nz), point(i + 1, j + 1, nz), point(i + 1, j, nz));
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      quad(point(i, 0, k), point(i, 0, k + 1), point(i + 1, 0, k + 1), point(i + 1, 0, k));
      quad(point(i, ny, k), point(i + 1, ny, k), point(i + 1, ny, k + 1), point(i, ny, k + 1));
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nz; k++) {
      quad(point(0, j, k), point(0, j + 1, k), point(0, j + 1, k + 1), point(0, j, k + 1));
      quad(point(nx, j, k), point(nx, j, k + 1), point(nx, j + 1, k + 1), point(nx, j + 1, k));
    }
  }
  return orientCage(cage);
}

/** A tube of quads, optionally closed at each end. */
export function cylinderCage(plane, radius, height, sides = 8, rows = 2, capped = true) {
  const cage = newCage();
  const n = Math.max(3, Math.round(sides));
  const r = Math.max(1, Math.round(rows));
  for (let k = 0; k <= r; k++) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      cage.points.push(
        at(plane, radius * Math.cos(a), radius * Math.sin(a), -height / 2 + (height * k) / r)
      );
    }
  }
  const id = (k, i) => k * n + (i % n);
  for (let k = 0; k < r; k++) {
    for (let i = 0; i < n; i++) {
      cage.faces.push([id(k, i), id(k, i + 1), id(k + 1, i + 1), id(k + 1, i)]);
    }
  }
  if (capped) {
    const bottom = [];
    const top = [];
    for (let i = 0; i < n; i++) {
      bottom.push(id(0, n - 1 - i));
      top.push(id(r, i));
    }
    cage.faces.push(bottom, top);
  }
  const axis = unit(plane.n);
  return orientCage(
    fitToLimit(
      cage,
      (c) => maxAxialRadius(c, plane.origin, axis),
      radius,
      (p, k) => {
        // Radially only: the height was asked for as well and must not move.
        const d = sub(p, plane.origin);
        const along = mul(axis, dot(d, axis));
        return add(plane.origin, add(along, mul(sub(d, along), k)));
      }
    )
  );
}

/** A ball of quads, with a pole at each end. */
export function sphereCage(plane, radius, sides = 8, rows = 6) {
  const cage = newCage();
  const n = Math.max(3, Math.round(sides));
  const r = Math.max(2, Math.round(rows));
  const south = cage.points.push(at(plane, 0, 0, -radius)) - 1;
  const ringStart = cage.points.length;
  for (let k = 1; k < r; k++) {
    const phi = Math.PI * (k / r);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      cage.points.push(
        at(
          plane,
          radius * Math.sin(phi) * Math.cos(a),
          radius * Math.sin(phi) * Math.sin(a),
          -radius * Math.cos(phi)
        )
      );
    }
  }
  const north = cage.points.push(at(plane, 0, 0, radius)) - 1;
  const id = (k, i) => ringStart + (k - 1) * n + (i % n);

  for (let i = 0; i < n; i++) cage.faces.push([south, id(1, i + 1), id(1, i)]);
  for (let k = 1; k < r - 1; k++) {
    for (let i = 0; i < n; i++) {
      cage.faces.push([id(k, i), id(k, i + 1), id(k + 1, i + 1), id(k + 1, i)]);
    }
  }
  for (let i = 0; i < n; i++) cage.faces.push([north, id(r - 1, i), id(r - 1, i + 1)]);
  return orientCage(
    fitToLimit(
      cage,
      (c) => meanRadius(c, plane.origin),
      radius,
      (p, k) => add(plane.origin, mul(sub(p, plane.origin), k))
    )
  );
}

/** A ring of quads. */
export function torusCage(plane, ringRadius, tubeRadius, ringSides = 12, tubeSides = 8) {
  const cage = newCage();
  const R = Math.max(3, Math.round(ringSides));
  const T = Math.max(3, Math.round(tubeSides));
  for (let i = 0; i < R; i++) {
    const a = (i / R) * Math.PI * 2;
    for (let j = 0; j < T; j++) {
      const b = (j / T) * Math.PI * 2;
      const rad = ringRadius + tubeRadius * Math.cos(b);
      cage.points.push(
        at(plane, rad * Math.cos(a), rad * Math.sin(a), tubeRadius * Math.sin(b))
      );
    }
  }
  const id = (i, j) => (i % R) * T + (j % T);
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < T; j++) {
      cage.faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  }

  // A torus has two sizes to hit, so both are measured off the limit: how far
  // the surface reaches from the axis at its widest and its narrowest gives the
  // ring and the tube it actually came out as.
  const axis = unit(plane.n);
  const radii = (c) => {
    let lo = Infinity;
    let hi = 0;
    for (const p of c.points) {
      const d = sub(p, plane.origin);
      const rad = len(sub(d, mul(axis, dot(d, axis))));
      lo = Math.min(lo, rad);
      hi = Math.max(hi, rad);
    }
    return { ring: (hi + lo) / 2, tube: (hi - lo) / 2 };
  };
  const got = radii(subdivided(cage, 3));
  if (got.ring > EPS && got.tube > EPS) {
    const kr = ringRadius / got.ring;
    const kt = tubeRadius / got.tube;
    cage.points = cage.points.map((p) => {
      const d = sub(p, plane.origin);
      const along = mul(axis, dot(d, axis));
      const flat = sub(d, along);
      const rad = len(flat);
      const outward = rad > EPS ? mul(flat, 1 / rad) : [0, 0, 0];
      const onRing = mul(outward, got.ring);
      const fromRing = add(sub(flat, onRing), along);
      return add(plane.origin, add(mul(onRing, kr), mul(fromRing, kt)));
    });
  }
  return orientCage(cage);
}

/**
 * A ball made of six grids rather than of rings and poles.
 *
 * Six quads pushed out onto a sphere. It has no poles, so every vertex has four
 * neighbours and the surface has no pinch in it: this is the one to start a
 * rounded shape from, which is why Fusion gives it its own button.
 */
export function quadballCage(plane, radius, divisions = 3) {
  const n = Math.max(1, Math.round(divisions));
  const cage = newCage();
  const index = new Map();
  const key = (p) =>
    `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;

  const push = (x, y, z) => {
    const onBall = mul(unit([x, y, z]), radius);
    const k = key(onBall);
    if (index.has(k)) return index.get(k);
    index.set(k, cage.points.push(at(plane, onBall[0], onBall[1], onBall[2])) - 1);
    return index.get(k);
  };

  // The six faces of a cube, each a grid, each point pushed out to the radius.
  const dirs = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]
  ];
  for (const [normal, u, v] of dirs) {
    const grid = [];
    for (let i = 0; i <= n; i++) {
      const row = [];
      for (let j = 0; j <= n; j++) {
        const s = -1 + (2 * i) / n;
        const t = -1 + (2 * j) / n;
        row.push(
          push(
            normal[0] + u[0] * s + v[0] * t,
            normal[1] + u[1] * s + v[1] * t,
            normal[2] + u[2] * s + v[2] * t
          )
        );
      }
      grid.push(row);
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        cage.faces.push([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
      }
    }
  }
  return orientCage(
    fitToLimit(
      cage,
      (c) => meanRadius(c, plane.origin),
      radius,
      (p, k) => add(plane.origin, mul(sub(p, plane.origin), k))
    )
  );
}

/** A single face from a run of points, which is where a hand made shape starts. */
export function faceCage(points) {
  const cage = newCage();
  for (const p of points) cage.points.push([p[0], p[1], p[2]]);
  cage.faces.push(points.map((_, i) => i));
  return cage;
}

/* --------------------------------------------------------- sculpting */

/**
 * Relax chosen points towards the middle of what they are joined to.
 *
 * The one operation that undoes a mess without deciding what the shape should
 * have been. It is a Laplacian, and the strength is how far towards the
 * neighbours' average each step goes, so the same call run twice at a half is
 * gentler than one run at one and lands in nearly the same place.
 *
 * Every step is worked out from the positions before that step, not as it goes,
 * or the answer depends on which point happens to be numbered first.
 */
export function smoothPoints(cage, verts, opts = {}) {
  const chosen = new Set(verts);
  if (!chosen.size) return null;
  const strength = Math.max(0, Math.min(1, opts.strength ?? 0.5));
  const rounds = Math.max(1, Math.round(opts.iterations ?? 1));
  const held = cage.frozen || {};
  const adj = adjacency(cage);
  const out = cloneCage(cage);

  for (let r = 0; r < rounds; r++) {
    const was = out.points.map((p) => p.slice());
    for (const v of chosen) {
      if (held[v]) continue;
      const around = [];
      for (const k of adj.edgesAt[v] || []) {
        const e = adj.edges.get(k);
        around.push(e.a === v ? e.b : e.a);
      }
      if (around.length < 2) continue;
      let mid = [0, 0, 0];
      for (const n of around) mid = add(mid, was[n]);
      mid = mul(mid, 1 / around.length);
      out.points[v] = add(was[v], mul(sub(mid, was[v]), strength));
    }
  }
  return out;
}

/**
 * Pull chosen points onto the straight line that fits them best.
 *
 * The line is the one through their middle along the direction they vary in
 * most, which is the first principal direction, found by turning a starting
 * guess into the data a few times rather than by writing out an eigenvector
 * solver for a three by three.
 */
export function straightenPoints(cage, verts, opts = {}) {
  const chosen = [...new Set(verts)];
  if (chosen.length < 2) return null;
  const held = cage.frozen || {};
  const pts = chosen.map((v) => cage.points[v]);
  const centre = averageOf(pts);
  const dir = mainDirection(pts, centre);
  if (!dir) return null;

  const out = cloneCage(cage);
  const strength = Math.max(0, Math.min(1, opts.strength ?? 1));
  for (const v of chosen) {
    if (held[v]) continue;
    const d = sub(cage.points[v], centre);
    const onLine = add(centre, mul(dir, dot(d, dir)));
    out.points[v] = add(cage.points[v], mul(sub(onLine, cage.points[v]), strength));
  }
  return out;
}

/**
 * Pull chosen points onto a cylinder about an axis.
 *
 * The radius is the average of what they already are, so a row of points that
 * wobbles about a bore lands on the bore rather than on some new size. Given no
 * axis it takes the direction they vary in most, which is right for a run along
 * a shaft and wrong for a ring around one, so the axis can be said.
 */
export function cylindrifyPoints(cage, verts, opts = {}) {
  const chosen = [...new Set(verts)];
  if (chosen.length < 3) return null;
  const held = cage.frozen || {};
  const pts = chosen.map((v) => cage.points[v]);
  const centre = opts.origin ? opts.origin.slice() : averageOf(pts);
  const dir = opts.dir ? normOr(opts.dir) : mainDirection(pts, centre);
  if (!dir) return null;

  const radial = (p) => {
    const d = sub(p, centre);
    return sub(d, mul(dir, dot(d, dir)));
  };
  let radius = opts.radius;
  if (!(radius > 0)) {
    radius = 0;
    for (const p of pts) radius += len(radial(p)) / pts.length;
  }
  if (!(radius > 0)) return null;

  const out = cloneCage(cage);
  const strength = Math.max(0, Math.min(1, opts.strength ?? 1));
  for (const v of chosen) {
    if (held[v]) continue;
    const off = radial(cage.points[v]);
    const l = len(off);
    if (l < 1e-9) continue;
    const want = add(sub(cage.points[v], off), mul(off, radius / l));
    out.points[v] = add(cage.points[v], mul(sub(want, cage.points[v]), strength));
  }
  return out;
}

/** The average of a set of points. */
function averageOf(pts) {
  let c = [0, 0, 0];
  for (const p of pts) c = add(c, p);
  return mul(c, 1 / Math.max(1, pts.length));
}

/**
 * The direction a set of points varies in most.
 *
 * Power iteration on the scatter matrix: start with a guess, push it through
 * the data, and it turns towards the direction with the most spread in it. A
 * dozen rounds is far more than a handful of cage points needs.
 */
function mainDirection(pts, centre) {
  let v = [1, 0, 0];
  for (let round = 0; round < 24; round++) {
    let next = [0, 0, 0];
    for (const p of pts) {
      const d = sub(p, centre);
      next = add(next, mul(d, dot(d, v)));
    }
    const l = len(next);
    if (l < 1e-12) {
      // The first guess lay square to everything. Try another one rather than
      // returning a direction that was never in the data.
      if (round === 0) {
        v = [0, 1, 0];
        continue;
      }
      return null;
    }
    v = mul(next, 1 / l);
  }
  return v;
}

function normOr(v) {
  const l = len(v);
  return l > 1e-12 ? mul(v, 1 / l) : null;
}

/**
 * Slide a run of points along the edges that lead away from it.
 *
 * An edge loop in the wrong place is the commonest thing to want to move, and
 * moving it by hand pulls it off the surface. Sliding keeps it on the surface by
 * running each of its points along one of the two edges leaving the loop.
 *
 * Which of the two counts as forward is decided once, at the first point, and
 * carried round the loop, or half the loop slides one way and half the other
 * and the loop shears instead of sliding.
 */
export function slideEdges(cage, verts, t = 0.25) {
  const chosen = new Set(verts);
  if (!chosen.size || !t) return null;
  const held = cage.frozen || {};
  const adj = adjacency(cage);

  const railsOf = (v) => {
    const out = [];
    for (const k of adj.edgesAt[v] || []) {
      const e = adj.edges.get(k);
      const other = e.a === v ? e.b : e.a;
      if (!chosen.has(other)) out.push(other);
    }
    return out;
  };

  // Order the run so the side chosen at one point carries to the next.
  const order = [...chosen].filter((v) => railsOf(v).length >= 2);
  if (!order.length) return null;

  const out = cloneCage(cage);
  let reference = null;
  for (const v of order) {
    const rails = railsOf(v);
    const ways = rails.map((n) => ({ n, dir: normOr(sub(cage.points[n], cage.points[v])) }));
    const usable = ways.filter((w) => w.dir);
    if (usable.length < 2) continue;
    if (!reference) reference = usable[0].dir;
    let best = usable[0];
    for (const w of usable) {
      if (dot(w.dir, reference) > dot(best.dir, reference)) best = w;
    }
    reference = best.dir;
    if (held[v]) continue;
    const step = t > 0 ? t : -t;
    const along = t > 0 ? best : pickOther(usable, best);
    if (!along) continue;
    out.points[v] = add(cage.points[v], mul(sub(cage.points[along.n], cage.points[v]), step));
  }
  return out;
}

function pickOther(ways, notThis) {
  for (const w of ways) if (w !== notThis) return w;
  return null;
}

/**
 * Take an edge out and let the two faces either side become one.
 *
 * Dissolving rather than deleting: the surface is unchanged, there is simply
 * one fewer edge holding it. This is how a cage that was subdivided too far
 * gets brought back without losing the shape.
 *
 * A boundary edge has only one face, so there is nothing to merge it into and
 * it is left alone rather than quietly deleting the face.
 */
export function eraseAndFill(cage, pairs) {
  let out = cloneCage(cage);
  let done = 0;

  for (const [a, b] of pairs || []) {
    const adj = adjacency(out);
    const e = adj.edges.get(edgeKey(a, b));
    if (!e || e.faces.length !== 2) continue;
    const [fi, fj] = e.faces;
    const one = out.faces[fi];
    const two = out.faces[fj];
    if (!one || !two) continue;

    /**
     * The part of a face that survives, which is all of it except the edge.
     *
     * The edge runs one way round this face, and the run that is left is the
     * one that starts where the edge finishes and comes back round to where it
     * started. Walking from either end without looking at which way the edge
     * runs gives the two corners of the edge itself, which is the short way and
     * is exactly the part being removed.
     */
    const survivor = (face) => {
      for (let i = 0; i < face.length; i++) {
        const x = face[i];
        const y = face[(i + 1) % face.length];
        if ((x !== a || y !== b) && (x !== b || y !== a)) continue;
        const run = [];
        for (let k = 0; k < face.length; k++) run.push(face[(i + 1 + k) % face.length]);
        return run;
      }
      return null;
    };

    const first = survivor(one);
    const second = survivor(two);
    if (!first || !second) continue;
    // They run in opposite directions across the edge, so the second picks up
    // exactly where the first leaves off.
    if (first[0] !== second[second.length - 1]) continue;

    // Each run ends on the corner the other starts from, so the two shared
    // corners would otherwise appear twice.
    const merged = [...first.slice(0, -1), ...second.slice(0, -1)];
    if (merged.length < 3 || new Set(merged).size !== merged.length) continue;

    const faces = out.faces.filter((_, i) => i !== fi && i !== fj);
    faces.push(merged);
    const creases = { ...out.creases };
    delete creases[edgeKey(a, b)];
    out = { ...out, faces, creases };
    done++;
  }
  return done ? compactCage(out) : null;
}

/**
 * Put an edge either side of one, which is how a subdivided edge is hardened.
 *
 * A single edge in a control cage smooths away; two edges close together hold a
 * shape. That is what Fusion's Bevel Edge does and it is why a chamfer on a form
 * is a matter of adding edges rather than of cutting a face.
 *
 * The loops go in across the edges leaving each end, at the offset given, so a
 * small offset is a tight bevel.
 */
export function bevelEdge(cage, a, b, offset = 0.2) {
  const t = Math.max(0.01, Math.min(0.49, offset));
  const adj = adjacency(cage);
  const e = adj.edges.get(edgeKey(a, b));
  if (!e) return null;

  // The edge leaving `a` inside each face, which is the one a new loop crosses.
  const across = [];
  for (const fi of e.faces) {
    const face = cage.faces[fi];
    const at = face.indexOf(a);
    if (at < 0) continue;
    const before = face[(at - 1 + face.length) % face.length];
    const after = face[(at + 1) % face.length];
    const other = before === b ? after : before;
    if (other !== b) across.push(other);
  }
  if (!across.length) return null;

  let out = cage;
  let made = 0;
  for (const c of across) {
    const next = insertEdgeLoop(out, a, c, t);
    if (next) {
      out = next;
      made++;
    }
  }
  return made ? out : null;
}

/**
 * Join two open edges into one, welding their points in pairs.
 *
 * The two runs have to have the same number of points: this is a merge, not a
 * fit, and pretending otherwise would put a crease where two cages happen to
 * have been divided differently. Each pair meets in the middle, so neither side
 * is treated as the one that was right.
 */
export function mergeEdgeRuns(cage, runA, runB, opts = {}) {
  if (!runA?.length || runA.length !== runB?.length) return null;
  const out = cloneCage(cage);
  const bias = Math.max(0, Math.min(1, opts.bias ?? 0.5));

  const to = new Map();
  for (let i = 0; i < runA.length; i++) {
    const a = runA[i];
    const b = runB[i];
    if (a === b || to.has(b)) continue;
    out.points[a] = add(out.points[a], mul(sub(out.points[b], out.points[a]), bias));
    to.set(b, a);
  }
  if (!to.size) return null;

  const at = (v) => (to.has(v) ? to.get(v) : v);
  const faces = [];
  for (const face of out.faces) {
    const run = [];
    for (const v of face) {
      const w = at(v);
      if (run.length && run[run.length - 1] === w) continue;
      run.push(w);
    }
    while (run.length > 1 && run[0] === run[run.length - 1]) run.pop();
    if (run.length > 2 && new Set(run).size === run.length) faces.push(run);
  }
  const creases = {};
  for (const [k, w] of Object.entries(out.creases)) {
    const [x, y] = k.split('_').map(Number);
    if (at(x) !== at(y)) creases[edgeKey(at(x), at(y))] = w;
  }
  const corners = {};
  for (const [v, w] of Object.entries(out.corners)) corners[at(Number(v))] = w;
  const frozen = {};
  for (const v of Object.keys(out.frozen || {})) frozen[at(Number(v))] = true;
  return compactCage({ points: out.points, faces, creases, corners, frozen, symmetry: cage.symmetry });
}

/**
 * Pin points so nothing moves them.
 *
 * The use of it is shaping one end of a form without disturbing the end that is
 * already right. It is not a property of the shape, it is a property of the
 * session, but it lives on the cage because that is what gets saved and what
 * gets handed to the next person.
 */
export function setFrozen(cage, verts, on = true) {
  if (!verts?.length) return null;
  const out = cloneCage(cage);
  out.frozen = { ...(out.frozen || {}) };
  for (const v of verts) {
    if (on) out.frozen[v] = true;
    else delete out.frozen[v];
  }
  return out;
}

/**
 * Make the surface pass exactly through a point, or let it go back to smooth.
 *
 * A subdivision surface normally passes near its control points rather than
 * through them. Fusion calls the exception an interpolated point; here it is a
 * corner weight, which is the same thing said in the language the subdivision
 * already speaks, so no second mechanism has to be kept in step with the first.
 */
export function setInterpolated(cage, verts, on = true) {
  if (!verts?.length) return null;
  const out = cloneCage(cage);
  out.corners = { ...(out.corners || {}) };
  for (const v of verts) {
    if (on) out.corners[v] = Math.max(out.corners[v] || 0, 4);
    else delete out.corners[v];
  }
  return out;
}

/**
 * Where a run of points meets a curve, and how far along it that is.
 *
 * Arc length rather than segment number, because a polyline off a fillet has a
 * hundred short segments at one end and four long ones at the other, and
 * spacing points by segment would bunch them all at the fillet.
 */
export function arcLengths(run) {
  const at = [0];
  for (let i = 1; i < run.length; i++) at.push(at[i - 1] + len(sub(run[i], run[i - 1])));
  return at;
}

/** The closest point on a polyline, and how far along it that is. */
export function closestOnRun(run, p) {
  const at = arcLengths(run);
  let best = null;
  for (let i = 0; i + 1 < run.length; i++) {
    const a = run[i];
    const b = run[i + 1];
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 > 1e-18 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
    const q = add(a, mul(ab, t));
    const d = len(sub(p, q));
    if (!best || d < best.distance) {
      best = { point: q, distance: d, along: at[i] + Math.sqrt(l2) * t };
    }
  }
  return best;
}

/** The point a given distance along a polyline. */
export function pointAlongRun(run, along) {
  const at = arcLengths(run);
  const total = at[at.length - 1];
  const s = Math.max(0, Math.min(total, along));
  for (let i = 0; i + 1 < run.length; i++) {
    if (s > at[i + 1]) continue;
    const span = at[i + 1] - at[i];
    const t = span > 1e-12 ? (s - at[i]) / span : 0;
    return add(run[i], mul(sub(run[i + 1], run[i]), t));
  }
  return run[run.length - 1].slice();
}

/**
 * Bring cage points onto a curve.
 *
 * Two ways, and which one is wanted depends on what the curve is for. Onto the
 * nearest point of it is a match: an open edge of a form put onto the edge of a
 * solid so the two meet, where every point is already roughly where it belongs
 * and only needs to arrive. Spread along it is an edit: a row of points laid out
 * evenly from one end of the curve to the other, which is what dragging a form
 * to follow a drawn line means, and it moves points a long way on purpose.
 *
 * `weights` carries the same move out into the cage around the run, so the
 * surface follows rather than creasing at the row that was moved. Frozen points
 * never move, whichever way it is done.
 */
export function matchPoints(cage, verts, target, opts = {}) {
  const chosen = [...new Set(verts)];
  if (chosen.length < 1 || !target?.length || target.length < 2) return null;
  const held = cage.frozen || {};
  const strength = Math.max(0, Math.min(1, opts.strength ?? 1));
  const out = cloneCage(cage);
  const shifts = new Map();

  if (opts.mode === 'spread') {
    // In the order they lie along the curve, so a row picked in any order still
    // comes out in one direction rather than crossing over itself.
    const along = new Map();
    for (const v of chosen) along.set(v, closestOnRun(target, cage.points[v])?.along ?? 0);
    const order = chosen.slice().sort((a, b) => along.get(a) - along.get(b));
    const total = arcLengths(target).pop();
    order.forEach((v, i) => {
      const s = order.length === 1 ? total / 2 : (total * i) / (order.length - 1);
      shifts.set(v, sub(pointAlongRun(target, s), cage.points[v]));
    });
  } else {
    for (const v of chosen) {
      const hit = closestOnRun(target, cage.points[v]);
      if (hit) shifts.set(v, sub(hit.point, cage.points[v]));
    }
  }
  if (!shifts.size) return null;

  for (const [v, shift] of shifts) {
    if (held[v]) continue;
    out.points[v] = add(cage.points[v], mul(shift, strength));
  }

  // The surrounding cage follows, if it was asked to. Each point takes the move
  // of whichever chosen point it is weighted against most, which is the one it
  // is nearest to in the cage.
  if (opts.weights) {
    const adj = opts.adjacency || adjacency(cage);
    const nearestChosen = nearestOf(cage, chosen, adj);
    for (const [v, w] of opts.weights) {
      if (held[v] || shifts.has(v) || !(w > 0)) continue;
      const source = nearestChosen.get(v);
      const shift = source === undefined ? null : shifts.get(source);
      if (!shift) continue;
      out.points[v] = add(cage.points[v], mul(shift, strength * w));
    }
  }
  return out;
}

/** For every point, which of the chosen ones is fewest edges away. */
function nearestOf(cage, chosen, adj) {
  const from = new Map();
  let front = [];
  for (const v of chosen) {
    from.set(v, v);
    front.push(v);
  }
  let guard = 0;
  while (front.length && guard++ < 4096) {
    const next = [];
    for (const v of front) {
      for (const k of adj.edgesAt[v] || []) {
        const e = adj.edges.get(k);
        const other = e.a === v ? e.b : e.a;
        if (from.has(other)) continue;
        from.set(other, from.get(v));
        next.push(other);
      }
    }
    front = next;
  }
  return from;
}

/* ------------------------------------------------------------- topology */

/** Take faces out, and the points nothing uses any more with them. */
export function deleteFaces(cage, faceIds) {
  const drop = new Set(faceIds);
  const kept = cage.faces.filter((_, i) => !drop.has(i));
  return compactCage({ ...cloneCage(cage), faces: kept });
}

/** The same cage with only the points its faces use. */
export function compactCage(cage) {
  const map = new Map();
  const points = [];
  const faces = cage.faces.map((face) =>
    face.map((v) => {
      if (!map.has(v)) {
        map.set(v, points.length);
        points.push(cage.points[v]);
      }
      return map.get(v);
    })
  );
  const creases = {};
  for (const [k, w] of Object.entries(cage.creases || {})) {
    const [a, b] = k.split('_').map(Number);
    if (map.has(a) && map.has(b)) creases[edgeKey(map.get(a), map.get(b))] = w;
  }
  const corners = {};
  for (const [v, w] of Object.entries(cage.corners || {})) {
    if (map.has(Number(v))) corners[map.get(Number(v))] = w;
  }
  const frozen = {};
  for (const v of Object.keys(cage.frozen || {})) {
    if (map.has(Number(v))) frozen[map.get(Number(v))] = true;
  }
  return { points, faces, creases, corners, frozen, symmetry: cage.symmetry };
}

/**
 * Put a form body back into a state the subdivision can work on.
 *
 * A cage goes wrong in a handful of ways, all of them from editing rather than
 * from building: points end up on top of each other after a drag, a face is
 * left with two corners at the same point, the same face gets made twice, and
 * points are left behind that nothing uses. None of it shows on screen until
 * the subdivision produces a crease out of nowhere or a hole where there is a
 * face, at which point it is hard to find by looking.
 *
 * Every repair is reported. A cage that had nothing wrong with it comes back
 * unchanged and says so, rather than being quietly rebuilt, because a rebuild
 * renumbers the points and takes every crease and selection with it.
 */
export function repairCage(cage, opts = {}) {
  const tolerance = opts.tolerance ?? 1e-4;
  const fixed = { welded: 0, degenerate: 0, duplicate: 0, orphaned: 0, flipped: 0, filled: 0 };

  // ---- points sitting on top of each other
  const grid = new Map();
  const key = (p) =>
    `${Math.round(p[0] / tolerance)}_${Math.round(p[1] / tolerance)}_${Math.round(p[2] / tolerance)}`;
  const moveTo = new Map();
  cage.points.forEach((p, i) => {
    const k = key(p);
    if (grid.has(k)) {
      moveTo.set(i, grid.get(k));
      fixed.welded++;
    } else {
      grid.set(k, i);
    }
  });
  const at = (v) => (moveTo.has(v) ? moveTo.get(v) : v);

  // ---- faces that are no longer faces
  const faces = [];
  const seen = new Set();
  for (const face of cage.faces) {
    // A corner repeated straight after itself is a fold in the outline, not a
    // corner, and welding is what usually makes one.
    const run = [];
    for (const v of face) {
      const w = at(v);
      if (run.length && run[run.length - 1] === w) continue;
      run.push(w);
    }
    while (run.length > 1 && run[0] === run[run.length - 1]) run.pop();

    if (run.length < 3 || new Set(run).size !== run.length) {
      fixed.degenerate++;
      continue;
    }
    // The same face made twice, whichever corner it was started from and
    // whichever way round it runs.
    const sorted = run.slice().sort((a, b) => a - b).join('_');
    if (seen.has(sorted)) {
      fixed.duplicate++;
      continue;
    }
    seen.add(sorted);
    faces.push(run);
  }

  // ---- points nothing uses
  const used = new Set();
  for (const face of faces) for (const v of face) used.add(v);
  fixed.orphaned = cage.points.filter((_, i) => !used.has(i) && !moveTo.has(i)).length;

  let out = compactCage({
    points: cage.points,
    faces,
    creases: remapCreases(cage.creases, at),
    corners: remapCorners(cage.corners, at),
    symmetry: cage.symmetry
  });

  // ---- holes, when asked for. Filling one is a change of shape, so it is
  // never done unasked: a form that is meant to be open is a normal thing.
  if (opts.fillHoles) {
    let guard = 0;
    while (guard++ < 64) {
      const loops = boundaryLoops(out);
      if (!loops.length) break;
      const before = out.faces.length;
      const filled = fillHole(out, loops[0], 'single');
      if (!filled || filled.faces.length === before) break;
      out = filled;
      fixed.filled++;
    }
  }

  // ---- winding
  const wasClockwise = out.faces.map((f) => f.join('_'));
  const oriented = orientCage(out);
  fixed.flipped = oriented.faces.filter((f, i) => f.join('_') !== wasClockwise[i]).length;

  fixed.changed =
    fixed.welded + fixed.degenerate + fixed.duplicate + fixed.orphaned + fixed.filled + fixed.flipped;
  return { cage: oriented, fixed };
}

/** Creases follow their points when two points become one. */
function remapCreases(creases, at) {
  const out = {};
  for (const [k, w] of Object.entries(creases || {})) {
    const [a, b] = k.split('_').map(Number);
    const x = at(a);
    const y = at(b);
    // A crease along an edge whose two ends have become one point is not an
    // edge any more.
    if (x === y) continue;
    out[edgeKey(x, y)] = w;
  }
  return out;
}

function remapCorners(corners, at) {
  const out = {};
  for (const [v, w] of Object.entries(corners || {})) out[at(Number(v))] = w;
  return out;
}

/** Split every chosen face into one quad per corner. */
export function subdivideFaces(cage, faceIds) {
  const drop = new Set(faceIds);
  if (!drop.size) return cage;
  const out = cloneCage(cage);
  const midOf = new Map();
  const mid = (a, b) => {
    const k = edgeKey(a, b);
    if (midOf.has(k)) return midOf.get(k);
    const i = out.points.push(mul(add(out.points[a], out.points[b]), 0.5)) - 1;
    midOf.set(k, i);
    return i;
  };

  const faces = [];
  cage.faces.forEach((face, fi) => {
    if (!drop.has(fi)) {
      faces.push(face.slice());
      return;
    }
    let c = [0, 0, 0];
    for (const v of face) c = add(c, cage.points[v]);
    const centre = out.points.push(mul(c, 1 / face.length)) - 1;
    for (let i = 0; i < face.length; i++) {
      const v = face[i];
      const prev = face[(i - 1 + face.length) % face.length];
      const next = face[(i + 1) % face.length];
      faces.push([v, mid(v, next), centre, mid(prev, v)]);
    }
  });
  out.faces = faces;
  return splitNeighbours(out, cage, midOf);
}

/**
 * Keep the cage watertight after splitting only some of its faces.
 *
 * A face that was not split still has the old long edge along it, while its
 * neighbour now has two shorter ones with a point in the middle. Left alone
 * that is a T-junction, and a T-junction is a crack in the surface. So the
 * unsplit neighbour has the new point put into its own boundary.
 */
function splitNeighbours(out, original, midOf) {
  if (!midOf.size) return out;
  out.faces = out.faces.map((face) => {
    const grown = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      grown.push(a);
      const m = midOf.get(edgeKey(a, b));
      if (m !== undefined && !face.includes(m)) grown.push(m);
    }
    return grown;
  });
  void original;
  return out;
}

/** Put a point in the middle of an edge, and into the faces that share it. */
export function insertPoint(cage, a, b) {
  const out = cloneCage(cage);
  const m = out.points.push(mul(add(out.points[a], out.points[b]), 0.5)) - 1;
  const midOf = new Map([[edgeKey(a, b), m]]);
  return splitNeighbours(out, cage, midOf);
}

/**
 * Run a new edge all the way round a ring of quads.
 *
 * Starting from one edge, the ring is the quads reached by stepping across each
 * to the edge opposite, until it comes back round or runs off the rim. That is
 * what makes one click add a whole loop rather than a single edge, and it is
 * the operation the shape of a form is actually built with.
 */
export function insertEdgeLoop(cage, a, b, t = 0.5) {
  const adj = adjacency(cage);
  const ring = edgeRing(cage, adj, a, b);
  if (!ring.length) return null;

  const out = cloneCage(cage);
  const midOf = new Map();
  const cut = (x, y) => {
    const k = edgeKey(x, y);
    if (midOf.has(k)) return midOf.get(k);
    const p = add(out.points[x], mul(sub(out.points[y], out.points[x]), t));
    const i = out.points.push(p) - 1;
    midOf.set(k, i);
    return i;
  };

  const split = new Set(ring.map((r) => r.face));
  const faces = [];
  cage.faces.forEach((face, fi) => {
    const step = ring.find((r) => r.face === fi);
    if (!split.has(fi) || !step) {
      faces.push(face.slice());
      return;
    }
    // The two edges the loop crosses, and the two halves of the quad between.
    const m1 = cut(step.e1[0], step.e1[1]);
    const m2 = cut(step.e2[0], step.e2[1]);
    const i1 = face.indexOf(step.e1[0]);
    const ordered = [];
    for (let i = 0; i < face.length; i++) ordered.push(face[(i1 + i) % face.length]);
    // ordered starts at e1[0]; e1 is ordered[0]..ordered[1] and e2 is
    // ordered[2]..ordered[3] on a quad.
    faces.push([ordered[0], m1, m2, ordered[3]]);
    faces.push([m1, ordered[1], ordered[2], m2]);
  });

  out.faces = faces;
  return splitNeighbours(out, cage, midOf);
}

/** The quads a loop would pass through, starting from one edge. */
export function edgeRing(cage, adj, a, b) {
  const start = adj.edges.get(edgeKey(a, b));
  if (!start) return [];
  const steps = [];
  const seenFace = new Set();
  const seenEdge = new Set();

  let edge = start;
  let guard = 0;
  while (edge && guard++ < 1e4) {
    if (seenEdge.has(edge.key)) break;
    seenEdge.add(edge.key);
    const face = edge.faces.find((f) => !seenFace.has(f));
    if (face === undefined) break;
    const poly = cage.faces[face];
    if (poly.length !== 4) break;
    seenFace.add(face);

    // The edge opposite, in the same quad.
    const i = poly.findIndex(
      (v, k) => edgeKey(v, poly[(k + 1) % 4]) === edge.key
    );
    if (i < 0) break;
    const oppA = poly[(i + 2) % 4];
    const oppB = poly[(i + 3) % 4];
    steps.push({
      face,
      e1: [poly[i], poly[(i + 1) % 4]],
      e2: [oppA, oppB]
    });
    edge = adj.edges.get(edgeKey(oppA, oppB));
    if (edge && edge.key === start.key) break;
  }
  return steps;
}

/** Set or clear a crease on the chosen edges. */
export function creaseEdges(cage, pairs, weight) {
  const out = cloneCage(cage);
  for (const [a, b] of pairs) {
    const k = edgeKey(a, b);
    if (weight > 0) out.creases[k] = weight;
    else delete out.creases[k];
  }
  return out;
}

/** Weld points that sit on top of each other into one. */
export function weldVertices(cage, verts, tolerance = 1e-4) {
  const out = cloneCage(cage);
  const pick = verts?.length ? new Set(verts) : null;
  const seen = new Map();
  const map = new Int32Array(out.points.length);
  const kept = [];
  const q = Math.max(tolerance, 1e-9);

  out.points.forEach((p, i) => {
    if (pick && !pick.has(i)) {
      map[i] = kept.length;
      kept.push(p);
      return;
    }
    const k = `${Math.round(p[0] / q)},${Math.round(p[1] / q)},${Math.round(p[2] / q)}`;
    if (seen.has(k)) {
      map[i] = seen.get(k);
      return;
    }
    seen.set(k, kept.length);
    map[i] = kept.length;
    kept.push(p);
  });

  const faces = [];
  for (const face of out.faces) {
    const moved = [];
    for (const v of face) {
      const m = map[v];
      if (!moved.length || moved[moved.length - 1] !== m) moved.push(m);
    }
    if (moved.length > 2 && moved[0] === moved[moved.length - 1]) moved.pop();
    if (moved.length > 2) faces.push(moved);
  }
  const creases = {};
  for (const [k, w] of Object.entries(out.creases)) {
    const [a, b] = k.split('_').map(Number);
    if (map[a] !== map[b]) creases[edgeKey(map[a], map[b])] = w;
  }
  return compactCage({ points: kept, faces, creases, corners: {}, symmetry: cage.symmetry });
}

/** Give a point of its own back to every face that was sharing one. */
export function unweldVertices(cage, verts) {
  const out = cloneCage(cage);
  const pick = new Set(verts);
  const first = new Set();
  out.faces = out.faces.map((face) =>
    face.map((v) => {
      if (!pick.has(v)) return v;
      if (!first.has(v)) {
        first.add(v);
        return v;
      }
      return out.points.push(out.points[v].slice()) - 1;
    })
  );
  return out;
}

/**
 * Close a hole in the cage.
 *
 * A single face across it is the plain answer and often the right one. Fanning
 * to a point in the middle gives the surface somewhere to go on a big opening,
 * which a single many sided face does not.
 */
export function fillHole(cage, loop, mode = 'single') {
  if (!loop || loop.length < 3) return null;
  const out = cloneCage(cage);
  if (mode === 'single') {
    out.faces.push(loop.slice());
    return out;
  }
  let c = [0, 0, 0];
  for (const v of loop) c = add(c, out.points[v]);
  const centre = out.points.push(mul(c, 1 / loop.length)) - 1;
  for (let i = 0; i < loop.length; i++) {
    out.faces.push([loop[i], loop[(i + 1) % loop.length], centre]);
  }
  return out;
}

/**
 * Join two openings with a run of faces between them.
 *
 * Both rims are walked the same way round and lined up at their nearest points,
 * which is what stops a bridge coming out with a twist through it. The number of
 * faces along it decides how much the surface has to work with.
 */
export function bridge(cage, loopA, loopB, segments = 1) {
  if (loopA.length !== loopB.length || loopA.length < 3) return null;
  const out = cloneCage(cage);
  const n = loopA.length;

  // Line the second rim up with the first, and turn it round if that makes the
  // total distance shorter: a bridge between two rings can be made either way.
  let best = null;
  for (const flip of [false, true]) {
    const ring = flip ? [loopB[0], ...loopB.slice(1).reverse()] : loopB.slice();
    for (let off = 0; off < n; off++) {
      let total = 0;
      for (let i = 0; i < n; i++) {
        total += len(sub(out.points[loopA[i]], out.points[ring[(i + off) % n]]));
      }
      if (!best || total < best.total) best = { total, ring, off };
    }
  }
  const other = (i) => best.ring[(i + best.off) % n];

  const steps = Math.max(1, Math.round(segments));
  let previous = loopA.slice();
  for (let s = 1; s <= steps; s++) {
    const row =
      s === steps
        ? loopA.map((_, i) => other(i))
        : loopA.map((v, i) => {
            const a = out.points[v];
            const b = out.points[other(i)];
            return out.points.push(add(a, mul(sub(b, a), s / steps))) - 1;
          });
    for (let i = 0; i < n; i++) {
      out.faces.push([previous[i], previous[(i + 1) % n], row[(i + 1) % n], row[i]]);
    }
    previous = row;
  }
  return out;
}

/** Pull the chosen points onto a plane. */
export function flatten(cage, verts, plane) {
  const out = cloneCage(cage);
  const n = unit(plane.n);
  for (const v of verts) {
    const d = dot(sub(out.points[v], plane.origin), n);
    out.points[v] = sub(out.points[v], mul(n, d));
  }
  return out;
}

/**
 * Even the cage out without changing what it stands for.
 *
 * Every point moves toward the middle of its neighbours, and then back onto the
 * surface it was on. A cage that has been pulled about has faces of wildly
 * different sizes, and it is the uneven ones that make a subdivision surface
 * ripple.
 */
export function makeUniform(cage, iterations = 3) {
  let out = cloneCage(cage);
  for (let it = 0; it < Math.max(1, iterations); it++) {
    const adj = adjacency(out);
    const before = out.points.map((p) => p.slice());
    const rim = new Set();
    for (const e of boundaryEdges(out, adj)) {
      rim.add(e.a);
      rim.add(e.b);
    }
    out.points = out.points.map((p, v) => {
      if (rim.has(v)) return p;
      const around = adj.edgesAt[v];
      if (!around.length) return p;
      let mid = [0, 0, 0];
      for (const k of around) {
        const e = adj.edges.get(k);
        mid = add(mid, before[e.a === v ? e.b : e.a]);
      }
      mid = mul(mid, 1 / around.length);
      // Along the surface only: the part of the move that leaves it is dropped,
      // so evening the cage out does not also deflate it.
      const nrm = vertexNormal(out, adj, v, before);
      const move = sub(mid, p);
      return add(p, sub(move, mul(nrm, dot(move, nrm))));
    });
  }
  return out;
}

function vertexNormal(cage, adj, v, points) {
  let n = [0, 0, 0];
  for (const fi of new Set(adj.facesAt[v])) {
    const face = cage.faces[fi];
    for (let i = 1; i + 1 < face.length; i++) {
      n = add(
        n,
        cross(
          sub(points[face[i]], points[face[0]]),
          sub(points[face[i + 1]], points[face[0]])
        )
      );
    }
  }
  const u = unit(n);
  return len(u) ? u : [0, 0, 1];
}

/* ------------------------------------------------------------- symmetry */

/**
 * Split every face a plane crosses, along the plane.
 *
 * The cut points go in once per edge and are shared by both faces on it, so the
 * cage stays watertight rather than gaining a crack where the two sides of a
 * split disagree about where the plane was. Faces the plane only touches at a
 * corner are left alone: there is nothing to split.
 */
export function splitCageByPlane(cage, plane) {
  const n = unit(plane.n);
  const side = (p) => dot(sub(p, plane.origin), n);
  const out = cloneCage(cage);
  const cutOf = new Map();

  const cut = (a, b) => {
    const k = edgeKey(a, b);
    if (cutOf.has(k)) return cutOf.get(k);
    const da = side(out.points[a]);
    const db = side(out.points[b]);
    const t = da / (da - db);
    const p = add(out.points[a], mul(sub(out.points[b], out.points[a]), t));
    const i = out.points.push(p) - 1;
    cutOf.set(k, i);
    return i;
  };

  const faces = [];
  for (const face of cage.faces) {
    const d = face.map((v) => side(out.points[v]));
    const crosses = d.some((x) => x > 1e-7) && d.some((x) => x < -1e-7);
    if (!crosses) {
      faces.push(face.slice());
      continue;
    }

    // Walk the face, adding a cut point wherever the plane is crossed, and
    // cutting the ring into two where those points fall.
    const walk = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      walk.push({ v: a, on: Math.abs(d[i]) <= 1e-7 });
      const j = (i + 1) % face.length;
      if ((d[i] > 1e-7 && d[j] < -1e-7) || (d[i] < -1e-7 && d[j] > 1e-7)) {
        walk.push({ v: cut(a, b), on: true });
      }
    }
    const marks = walk.map((w, i) => (w.on ? i : -1)).filter((i) => i >= 0);
    if (marks.length !== 2) {
      // Three or more crossings means a face folded through the plane more than
      // once, which a cage should not do. Left whole rather than guessed at.
      faces.push(face.slice());
      continue;
    }

    const [p1, p2] = marks;
    const one = [];
    for (let i = p1; i !== p2; i = (i + 1) % walk.length) one.push(walk[i].v);
    one.push(walk[p2].v);
    const two = [];
    for (let i = p2; i !== p1; i = (i + 1) % walk.length) two.push(walk[i].v);
    two.push(walk[p1].v);
    if (one.length > 2) faces.push(one);
    if (two.length > 2) faces.push(two);
  }

  out.faces = faces;
  // Every face that shared a cut edge needs the new point in its own ring too,
  // or the two disagree about the edge and the cage is no longer closed.
  return splitNeighbours(out, cage, cutOf);
}

/**
 * Make the cage symmetric about a plane, and remember that it is.
 *
 * The cage is cut on the plane first, so a face that straddles it becomes two
 * faces that do not. Then the far side goes and is replaced by a mirror of the
 * near side, which is what makes the two halves the same thing rather than two
 * things that happen to match. Remembering it is what lets a later edit be
 * mirrored as it is made rather than repaired afterwards.
 */
export function mirrorInternal(cage, plane) {
  const n = unit(plane.n);
  const side = (p) => dot(sub(p, plane.origin), n);
  const split = splitCageByPlane(cage, plane);

  const near = compactCage({
    ...split,
    faces: split.faces.filter((face) => {
      // A face is on the near side if its middle is, which is the only test
      // that works for one lying along the plane.
      let c = [0, 0, 0];
      for (const v of face) c = add(c, split.points[v]);
      return side(mul(c, 1 / face.length)) > 1e-7;
    })
  });
  if (!near.faces.length) return null;

  // Anything within a whisker of the plane is put exactly on it, so the seam
  // welds rather than nearly welding.
  near.points = near.points.map((p) => {
    const d = side(p);
    return Math.abs(d) < 1e-6 ? sub(p, mul(n, d)) : p;
  });

  const out = cloneCage(near);
  const onSeam = near.points.map((p) => Math.abs(side(p)) < 1e-9);
  const mirrorOf = near.points.map((p, i) =>
    onSeam[i] ? i : out.points.push(sub(p, mul(n, 2 * side(p)))) - 1
  );
  for (const face of near.faces) out.faces.push(face.map((v) => mirrorOf[v]).reverse());
  for (const [k, w] of Object.entries(near.creases)) {
    const [a, b] = k.split('_').map(Number);
    out.creases[edgeKey(mirrorOf[a], mirrorOf[b])] = w;
  }
  out.symmetry = { kind: 'mirror', origin: plane.origin, n };
  return orientCage(weldVertices(out, null, 1e-7));
}

/** The same, turned about an axis instead of reflected. */
export function circularInternal(cage, axis, count) {
  const n = Math.max(2, Math.round(count));
  const dir = unit(axis.dir);
  const wedge = (Math.PI * 2) / n;

  // Only what lies in the first wedge, measured about the axis.
  const basis = frameFor(dir);
  const angleOf = (p) => {
    const d = sub(p, axis.origin);
    const flat = sub(d, mul(dir, dot(d, dir)));
    return Math.atan2(dot(flat, basis.y), dot(flat, basis.x));
  };
  const inWedge = (p) => {
    let a = angleOf(p);
    if (a < -1e-7) a += Math.PI * 2;
    return a <= wedge + 1e-7;
  };

  const keep = cloneCage(cage);
  keep.faces = keep.faces.filter((face) =>
    face.some((v) => inWedge(keep.points[v]))
  );
  const one = compactCage(keep);
  if (!one.faces.length) return null;

  const out = cloneCage(one);
  for (let k = 1; k < n; k++) {
    const turn = wedge * k;
    const base = out.points.length;
    for (const p of one.points) out.points.push(rotateAbout(p, axis.origin, dir, turn));
    for (const face of one.faces) out.faces.push(face.map((v) => base + v));
  }
  out.symmetry = { kind: 'circular', origin: axis.origin, dir, count: n };
  return weldVertices(out, null, 1e-5);
}

function frameFor(n) {
  const x = unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  return { x, y: cross(n, x) };
}

function rotateAbout(p, origin, axis, angle) {
  const v = sub(p, origin);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(
    origin,
    add(add(mul(v, c), mul(cross(axis, v), s)), mul(axis, dot(axis, v) * (1 - c)))
  );
}

/** Forget the symmetry without changing the shape. */
export function clearSymmetry(cage) {
  const out = cloneCage(cage);
  delete out.symmetry;
  return out;
}

/**
 * Mirror a move so the other half of a symmetric form follows it.
 *
 * Called as an edit is made rather than after it, which is the difference
 * between symmetry that holds and symmetry you have to keep repairing.
 */
export function mirrorMoves(cage, moved) {
  const sym = cage.symmetry;
  if (!sym || sym.kind !== 'mirror') return moved;
  const reflect = (p) => sub(p, mul(sym.n, 2 * dot(sub(p, sym.origin), sym.n)));
  const at2 = new Map();
  cage.points.forEach((p, i) => {
    at2.set(
      `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`,
      i
    );
  });

  const out = new Map(moved);
  for (const [v, p] of moved) {
    const twin = at2.get(
      (() => {
        const r = reflect(cage.points[v]);
        return `${Math.round(r[0] * 1e4)},${Math.round(r[1] * 1e4)},${Math.round(r[2] * 1e4)}`;
      })()
    );
    if (twin !== undefined && twin !== v && !out.has(twin)) out.set(twin, reflect(p));
  }
  return out;
}

/* ------------------------------------------------------------- editing */

/**
 * Pull a new face out of the ones selected.
 *
 * The single most used thing in the workspace: it is how a limb is drawn out of
 * a body. The chosen faces are lifted off, the hole they leave is walled in, and
 * what comes back is the lifted faces, which is what the drag then moves. Faces
 * picked together are lifted as one piece, so a run of them comes out as a limb
 * rather than as a row of separate stubs.
 */
export function extrudeFaces(cage, faceIds, distance = 0) {
  const pick = new Set(faceIds);
  if (!pick.size) return null;
  const out = cloneCage(cage);
  const adj = adjacency(cage);

  // Which points are on the boundary of the lifted patch, and which are inside
  // it. An inside point moves and takes everything with it; a boundary one is
  // duplicated so the wall has something to stand on.
  const onPatch = new Set();
  for (const fi of pick) for (const v of cage.faces[fi]) onPatch.add(v);

  const boundary = new Set();
  for (const e of adj.edges.values()) {
    const inside = e.faces.filter((f) => pick.has(f)).length;
    if (inside > 0 && inside < e.faces.length) {
      boundary.add(e.a);
      boundary.add(e.b);
    }
    // An edge of the patch that has nothing on its far side is on the cage's
    // own rim, and counts as boundary too.
    if (inside === e.faces.length && e.faces.length === 1) {
      boundary.add(e.a);
      boundary.add(e.b);
    }
  }

  const lifted = new Map();
  const normalAt = (v) => {
    let n = [0, 0, 0];
    for (const fi of new Set(adj.facesAt[v])) {
      if (!pick.has(fi)) continue;
      n = add(n, faceNormal(cage, fi));
    }
    const u = unit(n);
    return len(u) ? u : [0, 0, 1];
  };
  for (const v of onPatch) {
    const moved = add(cage.points[v], mul(normalAt(v), distance));
    lifted.set(v, out.points.push(moved) - 1);
  }

  // The lifted faces, and a wall round the edge of the patch.
  const faces = [];
  cage.faces.forEach((face, fi) => {
    if (!pick.has(fi)) faces.push(face.slice());
  });
  for (const fi of pick) faces.push(cage.faces[fi].map((v) => lifted.get(v)));

  for (const e of adj.edges.values()) {
    const inside = e.faces.filter((f) => pick.has(f)).length;
    const onRim = inside === e.faces.length && e.faces.length === 1;
    if (!(inside > 0 && inside < e.faces.length) && !onRim) continue;
    // Wound to match the face it came off, so the wall faces outward too.
    const fi = e.faces.find((f) => pick.has(f));
    const face = cage.faces[fi];
    const i = face.indexOf(e.a);
    const forward = face[(i + 1) % face.length] === e.b;
    const [a, b] = forward ? [e.a, e.b] : [e.b, e.a];
    faces.push([a, b, lifted.get(b), lifted.get(a)]);
  }

  out.faces = faces;
  void boundary;
  return { cage: compactCageKeeping(out, lifted), lifted: [...lifted.values()] };
}

/** The average normal of one face. */
function faceNormal(cage, fi) {
  const face = cage.faces[fi];
  let n = [0, 0, 0];
  for (let i = 1; i + 1 < face.length; i++) {
    n = add(
      n,
      cross(
        sub(cage.points[face[i]], cage.points[face[0]]),
        sub(cage.points[face[i + 1]], cage.points[face[0]])
      )
    );
  }
  const u = unit(n);
  return len(u) ? u : [0, 0, 1];
}

/** Compact, and renumber the points a caller is still holding on to. */
function compactCageKeeping(cage, lifted) {
  const before = cage.points.length;
  const used = new Set();
  for (const face of cage.faces) for (const v of face) used.add(v);
  if (used.size === before) return cage;

  const map = new Map();
  const points = [];
  for (let v = 0; v < before; v++) {
    if (!used.has(v)) continue;
    map.set(v, points.length);
    points.push(cage.points[v]);
  }
  const faces = cage.faces.map((face) => face.map((v) => map.get(v)));
  const creases = {};
  for (const [k, w] of Object.entries(cage.creases || {})) {
    const [a, b] = k.split('_').map(Number);
    if (map.has(a) && map.has(b)) creases[edgeKey(map.get(a), map.get(b))] = w;
  }
  for (const [k, v] of lifted) lifted.set(k, map.get(v));
  return { points, faces, creases, corners: {}, symmetry: cage.symmetry };
}

/* -------------------------------------------------------- selection sets */

/** The points a set of faces is made of. */
export function pointsOfFaces(cage, faceIds) {
  const out = new Set();
  for (const fi of faceIds) for (const v of cage.faces[fi]) out.add(v);
  return [...out];
}

/**
 * One more ring of faces out, or one fewer.
 *
 * Growing takes every face that shares a point with the selection; shrinking
 * drops every face that has a point on its edge. Between them they are how a
 * selection is worked up to the right size without clicking forty times.
 */
export function growFaces(cage, faceIds, adj = adjacency(cage)) {
  const have = new Set(faceIds);
  const touched = new Set();
  for (const fi of have) for (const v of cage.faces[fi]) {
    for (const other of adj.facesAt[v]) touched.add(other);
  }
  return [...touched];
}

export function shrinkFaces(cage, faceIds, adj = adjacency(cage)) {
  const have = new Set(faceIds);
  const edgeOfSet = new Set();
  for (const e of adj.edges.values()) {
    const inside = e.faces.filter((f) => have.has(f)).length;
    if (inside > 0 && inside < e.faces.length) {
      edgeOfSet.add(e.a);
      edgeOfSet.add(e.b);
    }
  }
  return [...have].filter((fi) => !cage.faces[fi].some((v) => edgeOfSet.has(v)));
}

/**
 * The whole loop an edge belongs to.
 *
 * A loop runs end to end: at each vertex it carries straight on, which on a
 * cage means taking the edge that shares no face with the one arrived on. At a
 * vertex where four edges meet there is exactly one such edge, and that is what
 * makes a loop the natural run of edges along a shape rather than round it.
 */
export function edgeLoop(cage, a, b, adj = adjacency(cage)) {
  const out = [[a, b]];
  const seen = new Set([edgeKey(a, b)]);

  const straightOn = (from, at) => {
    const here = adj.edges.get(edgeKey(from, at));
    if (!here) return null;
    const faces = new Set(here.faces);
    for (const k of adj.edgesAt[at]) {
      if (k === here.key) continue;
      const e = adj.edges.get(k);
      if (e.faces.some((f) => faces.has(f))) continue;
      return e;
    }
    return null;
  };

  // Forwards from one end, then backwards from the other, so an open run comes
  // out whole rather than as the half the walk happened to start on.
  for (const [first, second] of [[a, b], [b, a]]) {
    let from = first;
    let at = second;
    let guard = 0;
    while (guard++ < 1e4) {
      const next = straightOn(from, at);
      if (!next || seen.has(next.key)) break;
      seen.add(next.key);
      out.push([next.a, next.b]);
      from = at;
      at = next.a === at ? next.b : next.a;
    }
  }
  return out;
}

/**
 * The ring an edge belongs to: the edges parallel to it, round the same band.
 *
 * Where a loop runs along a shape, a ring runs round it, crossing a band of
 * quads by stepping from each edge to the one opposite in the quad beside it.
 * It is the same walk Insert Edge makes, which is not a coincidence: inserting
 * a loop is cutting across exactly this ring.
 */
export function edgeRingSet(cage, a, b, adj = adjacency(cage)) {
  const out = [[a, b]];
  const seen = new Set([edgeKey(a, b)]);
  for (const step of edgeRing(cage, adj, a, b)) {
    const k = edgeKey(step.e2[0], step.e2[1]);
    if (seen.has(k)) break;
    seen.add(k);
    out.push([step.e2[0], step.e2[1]]);
  }
  return out;
}

/* ---------------------------------------------------------- moving points */

export const SOFT_EXTENTS = [
  ['none', 'Off'],
  ['distance', 'Distance'],
  ['faces', 'Face count']
];

export const TRANSITIONS = [
  ['smooth', 'Smooth'],
  ['linear', 'Linear'],
  ['bulge', 'Bulge']
];

/**
 * How much of a move each point takes.
 *
 * The chosen points take all of it. With soft modification on, the ones around
 * them take a share that falls off with how far away they are, which is what
 * makes a drag a swell in the surface rather than a dent with a hard rim. How
 * it falls off is the transition, and the three are the three Fusion offers.
 */
export function softWeights(cage, chosen, opts = {}, adj = adjacency(cage)) {
  const weight = new Map();
  for (const v of chosen) weight.set(v, 1);
  const mode = opts.extent || 'none';
  // Frozen points are pinned, and that has to be the last word rather than a
  // suggestion: the whole use of freezing is to shape one part of a form
  // without disturbing the part that is already right.
  const held = cage.frozen || {};
  const pin = (w) => {
    for (const v of Object.keys(held)) w.delete(Number(v));
    return w;
  };
  if (mode === 'none') return pin(weight);

  const shape = (t) => {
    const x = Math.max(0, Math.min(1, 1 - t));
    if (opts.transition === 'linear') return x;
    if (opts.transition === 'bulge') return Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x)));
    return x * x * (3 - 2 * x); // smoothstep
  };
  const scale = Math.max(0, opts.weight ?? 1);

  if (mode === 'faces') {
    // How many steps across the cage, which is what a face count means.
    const rings = Math.max(1, Math.round(opts.faces ?? 1));
    let front = new Set(chosen);
    const seen = new Set(chosen);
    for (let r = 1; r <= rings; r++) {
      const next = new Set();
      for (const v of front) {
        for (const k of adj.edgesAt[v]) {
          const e = adj.edges.get(k);
          const other = e.a === v ? e.b : e.a;
          if (seen.has(other)) continue;
          seen.add(other);
          next.add(other);
        }
      }
      for (const v of next) weight.set(v, shape(r / (rings + 1)) * scale);
      front = next;
      if (!front.size) break;
    }
    return pin(weight);
  }

  // By distance, from whichever chosen point is nearest.
  const reach = Math.max(1e-9, opts.distance ?? 10);
  for (let v = 0; v < cage.points.length; v++) {
    if (weight.has(v)) continue;
    let best = Infinity;
    for (const c of chosen) best = Math.min(best, len(sub(cage.points[v], cage.points[c])));
    if (best >= reach) continue;
    weight.set(v, shape(best / reach) * scale);
  }
  return pin(weight);
}

/**
 * Move, turn or scale a set of points, and mirror it if the form is symmetric.
 *
 * One place, so live symmetry, soft weighting and the three kinds of transform
 * are decided once rather than in each of the manipulator's handles.
 */
export function transformPoints(cage, weights, transform) {
  const out = cloneCage(cage);
  const moved = new Map();

  for (const [v, w] of weights) {
    if (!(w > 0)) continue;
    const from = cage.points[v];
    const to = transform(from, v);
    moved.set(v, add(from, mul(sub(to, from), w)));
  }

  const all = mirrorMoves(cage, moved);
  for (const [v, p] of all) out.points[v] = p;
  return out;
}

/** Move by a vector. */
export function translation(delta) {
  return (p) => add(p, delta);
}

/** Turn about a line. */
export function rotation(origin, axis, angle) {
  const dir = unit(axis);
  return (p) => rotateAbout(p, origin, dir, angle);
}

/**
 * Scale about a point.
 *
 * A factor per axis, in the frame given, so scaling along one handle of the
 * manipulator stretches rather than swelling.
 */
export function scaling(origin, frame, factors) {
  return (p) => {
    const d = sub(p, origin);
    const local = [dot(d, frame.x), dot(d, frame.y), dot(d, frame.z)];
    return add(
      origin,
      add(
        mul(frame.x, local[0] * factors[0]),
        add(mul(frame.y, local[1] * factors[1]), mul(frame.z, local[2] * factors[2]))
      )
    );
  };
}

/**
 * The frame a manipulator sits in.
 *
 * World is the model's own. View lines it up with the screen, which is what you
 * want for pushing something toward yourself. Selection uses the surface's own
 * normal, so pulling up means out of the shape rather than up the world.
 */
export function selectionFrame(cage, verts, kind, camera) {
  const centre = centroidOf(cage, verts);
  if (kind === 'view' && camera) {
    return { origin: centre, x: camera.x, y: camera.y, z: camera.z };
  }
  if (kind === 'selection') {
    const adj = adjacency(cage);
    let n = [0, 0, 0];
    const seen = new Set();
    for (const v of verts) {
      for (const fi of adj.facesAt[v]) {
        if (seen.has(fi)) continue;
        seen.add(fi);
        n = add(n, faceNormal(cage, fi));
      }
    }
    const z = unit(n);
    if (len(z)) {
      const x = unit(Math.abs(z[0]) < 0.9 ? cross(z, [1, 0, 0]) : cross(z, [0, 1, 0]));
      return { origin: centre, x, y: cross(z, x), z };
    }
  }
  return { origin: centre, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
}

export function centroidOf(cage, verts) {
  if (!verts.length) return [0, 0, 0];
  let c = [0, 0, 0];
  for (const v of verts) c = add(c, cage.points[v]);
  return mul(c, 1 / verts.length);
}

/** The outward normal at a point, over the faces that meet there. */
export function pointNormal(cage, v, adj = adjacency(cage)) {
  let n = [0, 0, 0];
  for (const fi of new Set(adj.facesAt[v])) n = add(n, faceNormal(cage, fi));
  const u = unit(n);
  return len(u) ? u : [0, 0, 1];
}

export { unit as formUnit, add as formAdd, sub as formSub, mul as formMul, dot as formDot };
