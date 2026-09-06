/**
 * Faces and edges recovered from a kernel mesh.
 *
 * The kernel deals in triangles, but a person points at faces and edges. This
 * rebuilds that view: coplanar triangles are welded into one face, smoothly
 * joined triangles into one curved face, and the boundaries between faces
 * become the edges you can select, sketch on, or fillet.
 *
 * It is recomputed after every rebuild rather than stored, so it never goes
 * stale, and nothing downstream may assume an id survives a model change.
 */

const PLANAR_TOL = 1e-4; // normal agreement for "same plane"
const OFFSET_TOL = 1e-4; // plane distance agreement, in mm
const SMOOTH_DEG = 24; // below this a join is a surface, not an edge

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A stable pair of axes spanning the plane with the given normal. */
export function basisFor(normal) {
  const n = norm(normal);
  // Pick the world axis least aligned with the normal so the cross is stable.
  const abs = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  let seed;
  if (abs[2] <= abs[0] && abs[2] <= abs[1]) seed = [0, 0, 1];
  else if (abs[1] <= abs[0]) seed = [0, 1, 0];
  else seed = [1, 0, 0];
  const x = norm(cross(seed, n));
  const y = norm(cross(n, x));
  return { x, y, n };
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {{numProp:number, vertProperties:Float32Array, triVerts:Uint32Array}} mesh
 * @returns {{faces:Array, edges:Array, triFace:Int32Array, positions:Float64Array}}
 */
export function buildTopology(mesh, opts = {}) {
  const stride = mesh.numProp;
  const src = mesh.vertProperties;
  const tris = mesh.triVerts;
  const triCount = tris.length / 3;
  const vertCount = src.length / stride;

  // Weld coincident vertices so triangles that merely share a location are
  // treated as sharing a corner.
  const positions = new Float64Array(vertCount * 3);
  const weld = new Int32Array(vertCount);
  const seen = new Map();
  for (let v = 0; v < vertCount; v++) {
    const b = v * stride;
    const x = src[b];
    const y = src[b + 1];
    const z = src[b + 2];
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    const hit = seen.get(key);
    if (hit === undefined) {
      seen.set(key, v);
      weld[v] = v;
    } else {
      weld[v] = hit;
    }
  }
  const P = (v) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];

  // Triangle normals and areas.
  const normals = new Float64Array(triCount * 3);
  const areas = new Float64Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = P(tris[t * 3]);
    const b = P(tris[t * 3 + 1]);
    const c = P(tris[t * 3 + 2]);
    const n = cross(sub(b, a), sub(c, a));
    const l = len(n);
    areas[t] = l / 2;
    const u = l > 1e-14 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 1];
    normals[t * 3] = u[0];
    normals[t * 3 + 1] = u[1];
    normals[t * 3 + 2] = u[2];
  }
  const N = (t) => [normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2]];

  // Adjacency across welded edges.
  const edgeMap = new Map();
  const addHalf = (a, b, t, k) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}_${hi}`;
    let rec = edgeMap.get(key);
    if (!rec) {
      rec = { a: lo, b: hi, tris: [] };
      edgeMap.set(key, rec);
    }
    rec.tris.push(t);
  };
  for (let t = 0; t < triCount; t++) {
    const v0 = weld[tris[t * 3]];
    const v1 = weld[tris[t * 3 + 1]];
    const v2 = weld[tris[t * 3 + 2]];
    addHalf(v0, v1, t, 0);
    addHalf(v1, v2, t, 1);
    addHalf(v2, v0, t, 2);
  }

  // How far two triangles can disagree and still be the same surface. A scan
  // needs this loosened or every triangle is its own face and nothing can be
  // pointed at; a machined part needs it tight or a fillet swallows the flat
  // beside it.
  const smoothDeg = opts.smoothDeg ?? SMOOTH_DEG;
  const cosSmooth = Math.cos((smoothDeg * Math.PI) / 180);

  /** Which feature and face a triangle came from, as one comparable string. */
  const srcOf = (t) =>
    mesh.triTag && mesh.triTag[t]
      ? `${mesh.triTag[t]}|${mesh.triFaceID[t]}`
      : null;

  // A mesh can ask for its own faces to be kept apart rather than merged by
  // angle. A control cage does: two quads of it lying dead flat against each
  // other are still two faces, and merging them leaves nothing to point at.
  // Solids do not, because there the angle is the whole point.
  const splitBySource = !!mesh.splitBySource;

  // Face groups set by hand. A triangle with a label belongs to that group and
  // to nothing else, whatever the angle says, which is what makes a face group
  // something you can decide rather than only regenerate. Everything left at
  // -1 is worked out the usual way, so pinning one face does not throw the
  // rest of the body's faces away.
  const labels =
    opts.labels && opts.labels.length === triCount ? opts.labels : null;
  const labelOf = (t) => (labels ? labels[t] : -1);

  /** Neighbouring triangles across a shared welded edge. */
  const neighboursOf = (t) => {
    const found = [];
    const vs = [weld[tris[t * 3]], weld[tris[t * 3 + 1]], weld[tris[t * 3 + 2]]];
    for (let k = 0; k < 3; k++) {
      const a = vs[k];
      const b = vs[(k + 1) % 3];
      const rec = edgeMap.get(`${Math.min(a, b)}_${Math.max(a, b)}`);
      if (!rec) continue;
      for (const other of rec.tris) if (other !== t) found.push(other);
    }
    return found;
  };

  // Booleans leave the odd zero-area triangle behind. Left to itself each one
  // becomes a face of its own, and then a rash of spurious edges around it, so
  // they are carried along with a neighbour instead of seeding anything.
  const degenerate = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) if (areas[t] < 1e-10) degenerate[t] = 1;

  /**
   * Faces are found in two passes.
   *
   * The first follows smooth joins, which gives whole surfaces but goes too
   * far once a fillet is tangent to the flat it meets: with nothing but angle
   * to go on, the flat, the fillet and the next flat are one continuous
   * surface, and the top of a filleted box stops being selectable.
   *
   * The second pass splits each surface back apart wherever a genuinely flat
   * region accounts for a real share of it. A box top surrounded by fillets is
   * most of its surface and becomes its own face; the fillet's own strips are
   * slivers by comparison and stay merged into the curved face they belong to.
   */
  const group = new Int32Array(triCount).fill(-1);
  const groups = [];

  for (let seed = 0; seed < triCount; seed++) {
    if (group[seed] !== -1 || degenerate[seed]) continue;
    const id = groups.length;
    const members = [];
    const stack = [seed];
    group[seed] = id;

    while (stack.length) {
      const t = stack.pop();
      members.push(t);
      const tn = N(t);
      for (const other of neighboursOf(t)) {
        if (group[other] !== -1) continue;
        if (degenerate[other]) {
          group[other] = id;
          members.push(other);
          continue;
        }
        const la = labelOf(t);
        const lb = labelOf(other);
        if (la >= 0 || lb >= 0) {
          // A hand set group has a hard boundary in both directions: its own
          // triangles stay together and nothing else joins them.
          if (la !== lb) continue;
        } else if (splitBySource) {
          // A cage says which face each triangle belongs to, and that is the
          // whole answer: the angle between two halves of one curved quad is
          // neither here nor there, and going by it splits a face in two.
          if (srcOf(t) !== srcOf(other)) continue;
        } else if (dot(tn, N(other)) < cosSmooth) {
          continue; // a real edge
        }
        group[other] = id;
        stack.push(other);
      }
    }
    groups.push(members);
  }

  // Any degenerate triangle no group reached forms its own, harmlessly.
  for (let t = 0; t < triCount; t++) {
    if (group[t] === -1) {
      group[t] = groups.length;
      groups.push([t]);
    }
  }

  const triFace = new Int32Array(triCount).fill(-1);
  const faces = [];

  const addFace = (members, planar, planeNormal) => {
    const faceId = faces.length;
    let area = 0;
    const centre = [0, 0, 0];
    const avgN = [0, 0, 0];
    for (const t of members) {
      triFace[t] = faceId;
      const w = areas[t];
      if (w <= 0) continue;
      const a = P(tris[t * 3]);
      const b = P(tris[t * 3 + 1]);
      const c = P(tris[t * 3 + 2]);
      area += w;
      const mid = scale(add(add(a, b), c), 1 / 3);
      centre[0] += mid[0] * w;
      centre[1] += mid[1] * w;
      centre[2] += mid[2] * w;
      const n = N(t);
      avgN[0] += n[0] * w;
      avgN[1] += n[1] * w;
      avgN[2] += n[2] * w;
    }
    const inv = area > 1e-14 ? 1 / area : 0;
    const face = {
      id: faceId,
      tris: members,
      planar,
      area,
      centre: scale(centre, inv),
      normal: planar && planeNormal ? planeNormal : norm(avgN)
    };
    // Which feature's geometry this face is part of, and which flat face of
    // that feature it was. Carried by the kernel through every boolean since,
    // so it names the face rather than describing where it happens to be.
    const src = dominantSource(members, mesh);
    if (src) face.src = src;
    if (!planar) face.cylinder = fitCylinder(members);
    faces.push(face);
    return faceId;
  };

  /**
   * Try to read a curved face as a cylinder.
   *
   * The axis is perpendicular to every surface normal, so it lies along the
   * cross product of any two of them that differ enough to be useful. If the
   * points then sit at a consistent distance from that axis, it really is a
   * cylinder, which is what lets a bore be measured and given an axis to
   * reference.
   */
  function fitCylinder(members) {
    if (members.length < 4) return null;
    const sample = [];
    const stride = Math.max(1, Math.floor(members.length / 24));
    for (let i = 0; i < members.length; i += stride) {
      if (areas[members[i]] > 1e-12) sample.push(N(members[i]));
    }
    if (sample.length < 3) return null;

    let axis = null;
    let spread = 0;
    for (let i = 0; i < sample.length; i++) {
      for (let j = i + 1; j < sample.length; j++) {
        const c = cross(sample[i], sample[j]);
        const l = len(c);
        if (l > spread) {
          spread = l;
          axis = scale(c, 1 / l);
        }
      }
    }
    if (!axis || spread < 0.05) return null;

    // Every normal should be square to the axis for a cylinder.
    for (const n of sample) {
      if (Math.abs(dot(n, axis)) > 0.08) return null;
    }

    const pts = [];
    for (let i = 0; i < members.length; i += stride) {
      const t = members[i];
      for (let k = 0; k < 3; k++) pts.push(P(weld[tris[t * 3 + k]]));
    }
    if (pts.length < 3) return null;

    let mean = [0, 0, 0];
    for (const p of pts) mean = add(mean, p);
    mean = scale(mean, 1 / pts.length);

    // The centre, by fitting a circle to the points seen down the axis.
    //
    // Averaging the points and calling that the centre only works for a face
    // that goes all the way round: on a whole bore the average does land on the
    // axis, and on anything less than that it lands somewhere out on the
    // surface. A fillet is a quarter of a cylinder, so every fillet in the
    // application failed this test and came back as an unrecognised curve. The
    // algebraic circle fit below does not care how much of the arc it is given.
    const b = basisFor(axis);
    const flatOf = (p) => {
      const rel = sub(p, mean);
      return [dot(rel, b.x), dot(rel, b.y)];
    };

    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
    for (const p of pts) {
      const [x, y] = flatOf(p);
      const z = x * x + y * y;
      sx += x; sy += y; sz += z;
      sxx += x * x; syy += y * y; sxy += x * y;
      sxz += x * z; syz += y * z;
    }
    const n = pts.length;
    // Solve the normal equations for the centre of the circle through them.
    const a11 = 2 * (sxx - (sx * sx) / n);
    const a12 = 2 * (sxy - (sx * sy) / n);
    const a22 = 2 * (syy - (sy * sy) / n);
    const b1 = sxz - (sx * sz) / n;
    const b2 = syz - (sy * sz) / n;
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12) return null;
    const cx = (b1 * a22 - b2 * a12) / det;
    const cy = (a11 * b2 - a12 * b1) / det;

    const origin = add(mean, add(scale(b.x, cx), scale(b.y, cy)));

    let radius = 0;
    for (const p of pts) {
      const rel = sub(p, origin);
      radius += len(sub(rel, scale(axis, dot(rel, axis))));
    }
    radius /= pts.length;
    if (!(radius > 1e-6)) return null;

    // Check the fit before believing it.
    let worst = 0;
    for (const p of pts) {
      const rel = sub(p, origin);
      const flat = sub(rel, scale(axis, dot(rel, axis)));
      worst = Math.max(worst, Math.abs(len(flat) - radius));
    }
    if (worst > Math.max(0.05, radius * 0.05)) return null;

    return { origin, dir: axis, radius };
  }

  /** Which feature and face a triangle came from, as one comparable string. */
  const sourceKey = srcOf;

  /** Connected runs of exactly-coplanar triangles inside one surface. */
  const coplanarPatches = (members) => {
    const inGroup = new Set(members);
    const seen = new Set();
    const patches = [];
    for (const seed of members) {
      if (seen.has(seed) || degenerate[seed]) continue;
      const seedN = N(seed);
      const seedD = dot(seedN, P(weld[tris[seed * 3]]));
      const seedSrc = sourceKey(seed);
      const patch = [];
      const stack = [seed];
      seen.add(seed);
      while (stack.length) {
        const t = stack.pop();
        patch.push(t);
        for (const other of neighboursOf(t)) {
          if (seen.has(other) || !inGroup.has(other) || degenerate[other]) continue;
          const on = N(other);
          if (dot(seedN, on) < 1 - PLANAR_TOL) continue;
          if (Math.abs(dot(seedN, P(weld[tris[other * 3]])) - seedD) > OFFSET_TOL) continue;
          // Coplanar is not enough when the two came from different faces of
          // different features. Split Face works by cutting a body and putting
          // it straight back, and without this the two halves are welded into
          // one face again and the split leaves no trace.
          const otherSrc = sourceKey(other);
          if (seedSrc && otherSrc && seedSrc !== otherSrc) continue;
          seen.add(other);
          stack.push(other);
        }
      }
      let area = 0;
      for (const t of patch) area += areas[t];
      patches.push({ tris: patch, area, normal: seedN });
    }
    return patches;
  };

  /**
   * A flat region counts as a face of its own once it is a real share of the
   * surface it sits in. On a filleted box the flats are each around a tenth of
   * the outer surface while a single fillet strip is well under a hundredth,
   * so anywhere in between separates them cleanly.
   */
  const PLANAR_SHARE = 0.02;

  for (const members of groups) {
    const solid = members.filter((t) => !degenerate[t]);
    if (!solid.length) continue;

    // A cage has already said what its faces are, and so has a hand set group,
    // so there is nothing to work out. Splitting a group into its flat patches
    // would break every curved quad back into the two triangles it is drawn
    // with, and would undo by angle the very grouping that was set to overrule
    // the angle.
    if (splitBySource || labelOf(solid[0]) >= 0) {
      const flat = coplanarPatches(members);
      addFace(solid, flat.length === 1, flat.length === 1 ? flat[0].normal : null);
      continue;
    }

    const patches = coplanarPatches(members);
    if (!patches.length) {
      addFace(solid, false, null);
      continue;
    }

    let groupArea = 0;
    for (const p of patches) groupArea += p.area;

    if (patches.length === 1) {
      addFace(solid, true, patches[0].normal);
      continue;
    }

    // A ring of equal facets is a coarse cylinder, not a set of flat faces.
    //
    // The share test below promotes any patch worth two percent of its group,
    // which is every single facet of a bore with fewer than fifty of them. A
    // 3 mm hole came back as forty flat faces and no cylinder at all, so it
    // could not be measured, threaded, or filled back in. What tells the two
    // apart is uniformity: a flat region that genuinely deserves its own face,
    // like the top of a filleted box, towers over the facets it sits among,
    // while a facet ring is all one size.
    const areas = patches.map((x) => x.area).sort((a, b) => a - b);
    if (patches.length >= 6 && areas[areas.length - 1] <= areas[0] * 1.5) {
      addFace(solid, false, null);
      continue;
    }

    const promoted = patches.filter(
      (p) => p.area >= Math.max(PLANAR_SHARE * groupArea, 1e-9)
    );
    if (!promoted.length) {
      addFace(solid, false, null);
      continue;
    }

    const claimed = new Set();
    for (const p of promoted) {
      for (const t of p.tris) claimed.add(t);
    }
    // Degenerate triangles are placed against a neighbour afterwards; they
    // must not seed anything of their own.
    const leftovers = members.filter((t) => !claimed.has(t) && !degenerate[t]);

    for (const p of promoted) addFace(p.tris, true, p.normal);

    // What is left may be several disconnected runs, each its own curved face.
    const pool = new Set(leftovers);
    while (pool.size) {
      const seed = pool.values().next().value;
      pool.delete(seed);
      const run = [seed];
      const stack = [seed];
      while (stack.length) {
        const t = stack.pop();
        for (const other of neighboursOf(t)) {
          if (!pool.has(other)) continue;
          pool.delete(other);
          run.push(other);
          stack.push(other);
        }
      }
      const sub = coplanarPatches(run);
      addFace(run, sub.length === 1, sub.length === 1 ? sub[0].normal : null);
    }
  }

  // Now place every degenerate triangle with a neighbour, so it belongs to a
  // face without ever having defined one.
  for (let pass = 0; pass < 3; pass++) {
    let placed = 0;
    for (let t = 0; t < triCount; t++) {
      if (triFace[t] !== -1) continue;
      for (const other of neighboursOf(t)) {
        if (triFace[other] === -1) continue;
        triFace[t] = triFace[other];
        faces[triFace[other]].tris.push(t);
        placed++;
        break;
      }
    }
    if (!placed) break;
  }

  /* ---- edges between faces ---- */

  const segsByPair = new Map();
  let openEdges = 0;
  for (const rec of edgeMap.values()) {
    const fs = new Set(rec.tris.map((t) => triFace[t]));
    // An edge with one triangle on it is the rim of an open surface. It is not
    // between two faces, but it is still the thing Patch, Stitch, Extend and
    // Trim are all pointed at, so it has to be selectable.
    const rim = rec.tris.length === 1;
    if (fs.size < 2 && !rim) continue;
    const [fa, fb] = rim
      ? [triFace[rec.tris[0]], -1]
      : [...fs].sort((x, y) => x - y);
    if (rim) openEdges++;
    const key = `${fa}_${fb}`;
    let list = segsByPair.get(key);
    if (!list) {
      list = { faceA: fa, faceB: fb, segs: [], boundary: rim };
      segsByPair.set(key, list);
    }
    list.segs.push([rec.a, rec.b]);
  }

  const edges = [];
  for (const group of segsByPair.values()) {
    for (const chain of chainSegments(group.segs)) {
      const pts = chain.map(P);
      if (pts.length < 2) continue;
      const e = classifyEdge(pts);
      e.id = edges.length;
      e.faceA = group.faceA;
      e.faceB = group.faceB;
      e.boundary = !!group.boundary;
      e.verts = chain;
      e.points = pts;

      // Measure the surfaces where they actually meet the edge. A face's
      // average normal is useless for anything curved: a cylinder's side
      // averages to nothing at all.
      const local = localFrame(e, edgeMap, triFace, normals, tris, weld, P);
      if (local) {
        Object.assign(e, local);
        e.convex = dot(local.nB, local.dirA) < 0;
        const agree = Math.max(-1, Math.min(1, dot(local.nA, local.nB)));
        e.dihedral = (Math.acos(agree) * 180) / Math.PI;
        // Where a fillet runs into the flat it was blended onto, the surfaces
        // are tangent. It is still a boundary you can select, but drawing it
        // would put a line across what looks like one continuous surface.
        e.tangent = e.dihedral < 15;
      } else {
        e.convex = false;
        e.dihedral = 180;
        e.tangent = false;
      }
      edges.push(e);
    }
  }

  // Overall size, used to judge how far is "far" when matching a stored
  // reference back to geometry after the model has changed.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < positions.length; v += 3) {
    if (positions[v] < minX) minX = positions[v];
    if (positions[v] > maxX) maxX = positions[v];
    if (positions[v + 1] < minY) minY = positions[v + 1];
    if (positions[v + 1] > maxY) maxY = positions[v + 1];
    if (positions[v + 2] < minZ) minZ = positions[v + 2];
    if (positions[v + 2] > maxZ) maxZ = positions[v + 2];
  }
  const extent =
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;

  return { faces, edges, triFace, positions, weld, triCount, extent, open: openEdges > 0 };

  /**
   * At the middle of the edge, the outward normal of each adjoining surface
   * and the direction leading away from the edge across it.
   */
  function localFrame(edge, map, triOfFace, triNormals, triIdx, weldMap, pos) {
    const chain = edge.verts;
    const k = Math.max(0, Math.floor((chain.length - 1) / 2));
    const va = chain[k];
    const vb = chain[k + 1];
    if (va === undefined || vb === undefined) return null;

    const rec = map.get(`${Math.min(va, vb)}_${Math.max(va, vb)}`);
    if (!rec || rec.tris.length < 2) return null;

    const pa = pos(va);
    const pb = pos(vb);
    const tangent = norm(sub(pb, pa));
    const mid = scale(add(pa, pb), 0.5);

    const pick = (faceId) => rec.tris.find((t) => triOfFace[t] === faceId);
    const tA = pick(edge.faceA);
    const tB = pick(edge.faceB);
    if (tA === undefined || tB === undefined) return null;

    const across = (t) => {
      const vs = [weldMap[triIdx[t * 3]], weldMap[triIdx[t * 3 + 1]], weldMap[triIdx[t * 3 + 2]]];
      const third = vs.find((v) => v !== va && v !== vb);
      if (third === undefined) return null;
      let v = sub(pos(third), mid);
      v = sub(v, scale(tangent, dot(v, tangent)));
      const l = len(v);
      return l < 1e-9 ? null : scale(v, 1 / l);
    };

    const dirA = across(tA);
    const dirB = across(tB);
    if (!dirA || !dirB) return null;

    return {
      refPoint: mid,
      tangent,
      nA: [triNormals[tA * 3], triNormals[tA * 3 + 1], triNormals[tA * 3 + 2]],
      nB: [triNormals[tB * 3], triNormals[tB * 3 + 1], triNormals[tB * 3 + 2]],
      dirA,
      dirB
    };
  }
}

/** Join loose segments into ordered polylines and loops. */
function chainSegments(segs) {
  const adjacency = new Map();
  const push = (k, v) => {
    let arr = adjacency.get(k);
    if (!arr) adjacency.set(k, (arr = []));
    arr.push(v);
  };
  const used = new Set();
  segs.forEach(([a, b], i) => {
    push(a, { i, other: b });
    push(b, { i, other: a });
  });

  const chains = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const [s, e] = segs[i];
    const chain = [s, e];

    // Walk forward then backward until the run ends or closes.
    for (const dir of [0, 1]) {
      for (;;) {
        const tip = dir === 0 ? chain[chain.length - 1] : chain[0];
        const options = (adjacency.get(tip) || []).filter((o) => !used.has(o.i));
        if (options.length !== 1) break;
        const next = options[0];
        used.add(next.i);
        if (dir === 0) chain.push(next.other);
        else chain.unshift(next.other);
        if (chain[0] === chain[chain.length - 1]) break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

/** Straight, circular, or something else. */
function classifyEdge(pts) {
  const closed =
    pts.length > 2 && len(sub(pts[0], pts[pts.length - 1])) < 1e-6;
  const unique = closed ? pts.slice(0, -1) : pts;

  let length = 0;
  for (let i = 0; i < pts.length - 1; i++) length += len(sub(pts[i + 1], pts[i]));

  if (!closed && unique.length >= 2) {
    const a = unique[0];
    const b = unique[unique.length - 1];
    const d = norm(sub(b, a));
    let straight = true;
    for (const p of unique) {
      const w = sub(p, a);
      const off = sub(w, scale(d, dot(w, d)));
      if (len(off) > 1e-5) {
        straight = false;
        break;
      }
    }
    if (straight) {
      return { kind: 'line', start: a, end: b, dir: d, length };
    }
  }

  // Circle: every point the same distance from the centroid, all in one plane.
  const c = [0, 0, 0];
  for (const p of unique) {
    c[0] += p[0] / unique.length;
    c[1] += p[1] / unique.length;
    c[2] += p[2] / unique.length;
  }
  // A circle has to be tessellated to be one: the four corners of a rectangle
  // are equidistant from its centre too, so distance alone would call every
  // rectangular boundary a circle. Requiring many points, each a short step
  // from the last, tells them apart.
  if (closed && unique.length >= 8) {
    const n = norm(cross(sub(unique[1], unique[0]), sub(unique[2], unique[0])));
    const r0 = len(sub(unique[0], c));
    let circular = r0 > 1e-9;
    let longestStep = 0;
    for (let i = 0; i < unique.length && circular; i++) {
      const p = unique[i];
      if (Math.abs(len(sub(p, c)) - r0) > Math.max(1e-4, r0 * 2e-3)) circular = false;
      if (Math.abs(dot(sub(p, c), n)) > 1e-4) circular = false;
      const q = unique[(i + 1) % unique.length];
      longestStep = Math.max(longestStep, len(sub(q, p)));
    }
    if (circular && longestStep < r0 * 0.5) {
      return { kind: 'circle', centre: c, axis: n, radius: r0, length, closed: true };
    }
  }

  return { kind: 'other', length, closed };
}

/**
 * A sketch plane taken from a planar face: origin at the face centre, normal
 * pointing out of the material.
 */
export function planeFromFace(face) {
  const b = basisFor(face.normal);
  return {
    origin: face.centre,
    x: b.x,
    y: b.y,
    n: b.n
  };
}

export { dot, cross, sub, add, scale, norm, len, SMOOTH_DEG };

/**
 * The feature and face id most of a run of triangles came from.
 *
 * Most rather than all, because a boolean can leave a triangle or two along a
 * seam attributed to the tool that cut it. The face as a whole belongs to
 * whichever source owns the bulk of it.
 */
function dominantSource(members, mesh) {
  if (!mesh?.triTag || !mesh?.triFaceID) return null;

  const tagCounts = new Map();
  const faceCounts = new Map();
  let known = 0;
  for (const t of members) {
    const tag = mesh.triTag[t];
    if (!tag) continue;
    known++;
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    const fid = mesh.triFaceID[t];
    if (fid < 0) continue;
    const key = `${tag}|${fid}`;
    faceCounts.set(key, (faceCounts.get(key) || 0) + 1);
  }
  if (!known) return null;

  let tag = null;
  let tagN = 0;
  for (const [k, n] of tagCounts) {
    if (n > tagN) {
      tagN = n;
      tag = k;
    }
  }
  if (!tag) return null;

  // Which face of that feature, when there is one. A curved face is a ring of
  // coplanar facets each with its own id, so no single one names it; taking
  // whichever happened to have the most triangles gives a name that changes
  // for no reason. Such a face records its feature and says the rest is not
  // knowable, and the geometric match tells it from its siblings.
  let best = null;
  let bestN = 0;
  for (const [key, n] of faceCounts) {
    if (n > bestN) {
      bestN = n;
      best = key;
    }
  }
  if (!best || bestN < known * 0.6) return { tag, face: -1 };
  const cut = best.lastIndexOf('|');
  return { tag: best.slice(0, cut), face: Number(best.slice(cut + 1)) };
}
