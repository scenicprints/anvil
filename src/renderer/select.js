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
