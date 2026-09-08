/**
 * Choosing things.
 *
 * Every command in the application begins by choosing something, and until now
 * the only way to choose was one click at a time. On a part with thirty faces
 * that is fine. On an imported model with four hundred it is the reason you
 * give up, which is why this is the largest single gap in the application and
 * why it comes before the modelling commands that are also missing.
 *
 * The rules here are all measurements on the topology rather than anything to
 * do with the pointer: how big a face is, which faces touch which, where a
 * region stops. Keeping them here rather than in the viewport is what lets them
 * be tested against a part whose answer is known by construction, and what lets
 * the same rule serve a menu command and a drag.
 */

/** Which faces touch which, across the edges between them. */
export function faceNeighbours(topo) {
  const near = new Map();
  const add = (a, b) => {
    if (a === undefined || a < 0 || b === undefined || b < 0) return;
    if (!near.has(a)) near.set(a, new Set());
    near.get(a).add(b);
  };
  for (const e of topo.edges) {
    add(e.faceA, e.faceB);
    add(e.faceB, e.faceA);
  }
  return near;
}

/** The edges between two faces, by the pair they lie between. */
function edgesBetween(topo) {
  const map = new Map();
  for (const e of topo.edges) {
    if (e.faceA === undefined || e.faceB === undefined) continue;
    const key = e.faceA < e.faceB ? `${e.faceA}_${e.faceB}` : `${e.faceB}_${e.faceA}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return map;
}

/**
 * Faces by how big they are.
 *
 * The one that earns its place on an import. A model that arrives with four
 * hundred faces usually has a dozen worth caring about and the rest are chips
 * and slivers; "everything under two square millimetres" selects the rest of
 * them in one go, and then they can be dealt with together.
 */
export function facesBySize(topo, { min = 0, max = Infinity } = {}) {
  const out = [];
  topo.faces.forEach((f, i) => {
    if (f.area >= min && f.area <= max) out.push(i);
  });
  return out;
}

/** The bounds worth offering, so the numbers in a dialog mean something. */
export function sizeRange(topo) {
  let lo = Infinity;
  let hi = 0;
  for (const f of topo.faces) {
    if (f.area < lo) lo = f.area;
    if (f.area > hi) hi = f.area;
  }
  return { min: Number.isFinite(lo) ? lo : 0, max: hi };
}

/** Everything not chosen, which is often the shorter thing to describe. */
export function invert(count, chosen) {
  const have = new Set(chosen);
  const out = [];
  for (let i = 0; i < count; i++) if (!have.has(i)) out.push(i);
  return out;
}

/** The faces touching these, and these. One ring out per call. */
export function grow(topo, chosen, rings = 1, near = faceNeighbours(topo)) {
  let have = new Set(chosen);
  for (let r = 0; r < rings; r++) {
    const next = new Set(have);
    for (const f of have) for (const n of near.get(f) || []) next.add(n);
    have = next;
  }
  return [...have];
}

/** The reverse: drop anything on the border of what is chosen. */
export function shrink(topo, chosen, near = faceNeighbours(topo)) {
  const have = new Set(chosen);
  return [...have].filter((f) => [...(near.get(f) || [])].every((n) => have.has(n)));
}

/**
 * Everything reachable from a seed without crossing a boundary.
 *
 * Fusion calls this Seed And Boundary and it is the most useful of the lot on a
 * shape nobody modelled: pick one face of a pocket, pick the rim around it, and
 * the whole pocket comes with it however many faces it turns out to be made of.
 *
 * The boundary is given as edges rather than as faces, because what stops a
 * region is where it ends, not what is beyond it.
 */
export function seedAndBoundary(topo, seeds, boundaryEdges) {
  const stop = new Set(boundaryEdges);
  const byPair = edgesBetween(topo);
  const near = faceNeighbours(topo);

  const blocked = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    const between = byPair.get(key) || [];
    // Blocked only when every edge between the two faces is part of the
    // boundary. One unblocked edge is still a way through.
    return between.length > 0 && between.every((e) => stop.has(e.id));
  };

  const out = new Set(seeds);
  const queue = [...seeds];
  let guard = 0;
  while (queue.length && guard++ < 1e6) {
    const f = queue.pop();
    for (const n of near.get(f) || []) {
      if (out.has(n) || blocked(f, n)) continue;
      out.add(n);
      queue.push(n);
    }
  }
  return [...out];
}

/**
 * Faces continuing smoothly from these, and no further.
 *
 * A blend shell, a bore, the whole of one curved surface: the run of faces you
 * would call one thing by eye. It stops where there is a crease, which is the
 * same test the topology uses to decide a face is a face.
 */
export function tangentRun(topo, seeds, maxDegrees = 15) {
  const byPair = edgesBetween(topo);
  const near = faceNeighbours(topo);
  const out = new Set(seeds);
  const queue = [...seeds];
  let guard = 0;
  while (queue.length && guard++ < 1e6) {
    const f = queue.pop();
    for (const n of near.get(f) || []) {
      if (out.has(n)) continue;
      const key = f < n ? `${f}_${n}` : `${n}_${f}`;
      const between = byPair.get(key) || [];
      // Smooth if any edge between them is: a face can meet its neighbour
      // sharply along one edge and softly along another.
      const smooth = between.some((e) => (e.dihedral ?? 180) <= maxDegrees);
      if (!smooth) continue;
      out.add(n);
      queue.push(n);
    }
  }
  return [...out];
}

/** Faces whose shape matches one of the chosen: same kind, same size. */
export function similarFaces(topo, chosen, tol = 0.02) {
  const want = [...chosen].map((i) => topo.faces[i]).filter(Boolean);
  if (!want.length) return [];
  const out = new Set(chosen);
  topo.faces.forEach((f, i) => {
    for (const w of want) {
      if (!!f.planar !== !!w.planar) continue;
      if (w.cylinder && f.cylinder) {
        if (Math.abs(f.cylinder.radius - w.cylinder.radius) > tol * Math.max(1, w.cylinder.radius))
          continue;
      } else if (!!f.cylinder !== !!w.cylinder) {
        continue;
      }
      const big = Math.max(f.area, w.area) || 1;
      if (Math.abs(f.area - w.area) / big > tol) continue;
      out.add(i);
      return;
    }
  });
  return [...out];
}

/**
 * The edges that carry on smoothly from the ones given.
 *
 * Fusion calls this Tangent Chain and has it ticked by default in Fillet and
 * Chamfer. Picking one edge of a rounded outline and getting the whole outline
 * is the difference between one click and thirty on any part that is not all
 * flats.
 *
 * `tangentRun` above is the face version and is not this: it walks across faces
 * that meet smoothly. This walks along edges that continue each other, which is
 * a different question. Two edges continue if they share an end and leave it in
 * nearly opposite directions, so a corner where four edges meet does not drag
 * the whole cage in.
 */
export function tangentEdgeRun(topo, seedIds, maxDegrees = 15) {
  const edges = topo?.edges || [];
  const endsOf = (e) => {
    const v = e.verts;
    return v && v.length >= 2 ? [v[0], v[v.length - 1]] : null;
  };

  const touching = new Map();
  edges.forEach((e, i) => {
    const ends = endsOf(e);
    if (!ends) return;
    for (const v of ends) {
      if (!touching.has(v)) touching.set(v, []);
      touching.get(v).push(i);
    }
  });

  // The unit direction an edge leaves the given end in.
  const leaving = (e, vertex) => {
    const ends = endsOf(e);
    const pts = e.points;
    if (!ends || !pts || pts.length < 2) return null;
    const [a, b] = vertex === ends[0] ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    return l < 1e-12 ? null : [d[0] / l, d[1] / l, d[2] / l];
  };

  const limit = Math.cos(((180 - maxDegrees) * Math.PI) / 180);
  const out = new Set(seedIds);
  const queue = [...seedIds];
  let guard = 0;
  while (queue.length && guard++ < 1e6) {
    const i = queue.pop();
    const e = edges[i];
    const ends = endsOf(e);
    if (!ends) continue;
    for (const v of ends) {
      const mine = leaving(e, v);
      if (!mine) continue;
      for (const j of touching.get(v) || []) {
        if (j === i || out.has(j)) continue;
        const other = leaving(edges[j], v);
        if (!other) continue;
        // Both point away from the shared end, so carrying straight on means
        // pointing in opposite directions: a dot near minus one.
        const dot = mine[0] * other[0] + mine[1] * other[1] + mine[2] * other[2];
        if (dot > limit) continue;
        out.add(j);
        queue.push(j);
      }
    }
  }
  return [...out];
}
