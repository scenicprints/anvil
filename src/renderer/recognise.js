/**
 * Reading features back out of geometry that never had any.
 *
 * A model arriving from outside is a bag of triangles. Fusion's kernel is a
 * boundary representation, so a mesh is a foreign object it must convert before
 * it can do anything real with it, and until you pay for that conversion an
 * imported model is something you can look at and not much else.
 *
 * Anvil's kernel is a mesh kernel. An imported model is already the same kind
 * of thing every feature here operates on, which means the interesting question
 * is not "can it be converted" but "what is it". That is what this file answers:
 * given the topology, which of these faces is a hole, what diameter is it, does
 * it go through, and which of these curved faces are fillets rather than walls.
 *
 * None of it guesses. A hole is a cylindrical face whose surface normals point
 * at its own axis; a boss is the same face with the normals pointing away. A
 * fillet is a cylindrical face that meets both its neighbours tangentially,
 * which is what being a blend means. Both are measurements, not heuristics
 * about what a shape probably is.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** The component of `v` square to `axis`. */
function across(v, axis) {
  return sub(v, mul(axis, dot(v, axis)));
}

/** Every point of a face, as [x, y, z] triples. */
function facePoints(mesh, face) {
  const stride = mesh.numProp;
  const out = [];
  const seen = new Set();
  for (const t of face.tris) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.triVerts[t * 3 + k];
      if (seen.has(v)) continue;
      seen.add(v);
      const b = v * stride;
      out.push([mesh.vertProperties[b], mesh.vertProperties[b + 1], mesh.vertProperties[b + 2]]);
    }
  }
  return out;
}

/** One triangle's outward normal. */
function triNormal(mesh, t) {
  const stride = mesh.numProp;
  const p = (k) => {
    const b = mesh.triVerts[t * 3 + k] * stride;
    return [mesh.vertProperties[b], mesh.vertProperties[b + 1], mesh.vertProperties[b + 2]];
  };
  const a = p(0);
  const u = sub(p(1), a);
  const v = sub(p(2), a);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = len(n);
  return l > 1e-12 ? mul(n, 1 / l) : null;
}

/**
 * Does this cylindrical face face its own axis?
 *
 * A bore's outward normals point inward, at the axis; a boss's point away from
 * it. That one sign is the whole difference between a hole and a peg, and it is
 * measured rather than inferred from which is bigger or where it sits.
 */
function facesInward(mesh, face, cyl) {
  let inward = 0;
  let outward = 0;
  for (const t of face.tris) {
    const n = triNormal(mesh, t);
    if (!n) continue;
    const stride = mesh.numProp;
    const b = mesh.triVerts[t * 3] * stride;
    const p = [mesh.vertProperties[b], mesh.vertProperties[b + 1], mesh.vertProperties[b + 2]];
    const radial = across(sub(p, cyl.origin), cyl.dir);
    if (len(radial) < 1e-9) continue;
    if (dot(n, radial) < 0) inward++;
    else outward++;
  }
  if (inward + outward === 0) return null;
  return inward > outward;
}

/** How far a face runs along an axis, and where it starts and ends. */
function axialSpan(points, cyl) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const t = dot(sub(p, cyl.origin), cyl.dir);
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return { lo, hi, depth: hi - lo };
}

/**
 * Is this end of the bore capped?
 *
 * A blind hole has a bottom: a face across the axis, sitting near the end of
 * the cylinder and centred on it. A through hole has open air there. Looked for
 * among the faces that actually touch this one, so a coincidental face
 * elsewhere in the model cannot make a hole read as blind.
 */
function cappedAt(topo, face, cyl, at, radius) {
  for (const e of topo.edges) {
    if (e.faceA !== face.id && e.faceB !== face.id) continue;
    const otherId = e.faceA === face.id ? e.faceB : e.faceA;
    const other = topo.faces[otherId];
    if (!other || !other.planar) continue;
    // Across the axis rather than along it.
    if (Math.abs(dot(other.normal, cyl.dir)) < 0.9) continue;
    const t = dot(sub(other.centre, cyl.origin), cyl.dir);
    if (Math.abs(t - at) > Math.max(0.05, radius * 0.5)) continue;
    // Centred on the bore, which is what tells a bottom from the flat the
    // hole was drilled into.
    if (len(across(sub(other.centre, cyl.origin), cyl.dir)) > radius) continue;
    return true;
  }
  return false;
}

/**
 * Every hole in a body, measured.
 *
 * A hole is a cylindrical face whose normals point at its axis. Everything else
 * about it, the diameter, which way it runs, how deep it is and whether it goes
 * through, follows from the same fit.
 */
export function findHoles(mesh, topo) {
  const out = [];
  for (const face of topo.faces) {
    const cyl = face.cylinder;
    if (!cyl || face.planar) continue;
    const inward = facesInward(mesh, face, cyl);
    if (inward !== true) continue;

    const points = facePoints(mesh, face);
    if (points.length < 3) continue;
    const span = axialSpan(points, cyl);
    if (!(span.depth > 1e-6)) continue;

    const bottomAt = cappedAt(topo, face, cyl, span.lo, cyl.radius);
    const topAt = cappedAt(topo, face, cyl, span.hi, cyl.radius);

    out.push({
      face: face.id,
      diameter: cyl.radius * 2,
      radius: cyl.radius,
      axis: cyl.dir,
      // The mouth and the floor, in world, so a feature can be built on it
      // without re-deriving where the thing is.
      from: add(cyl.origin, mul(cyl.dir, span.lo)),
      to: add(cyl.origin, mul(cyl.dir, span.hi)),
      depth: span.depth,
      through: !bottomAt && !topAt,
      blind: bottomAt !== topAt,
      area: face.area
    });
  }
  return out;
}

/**
 * Every fillet in a body.
 *
 * A fillet is a cylindrical face that runs into both of its neighbours without
 * a crease: that is what a blend is, and `tangent` on an edge already says it.
 * Convex or concave is the same sign that tells a hole from a boss, so the two
 * come out of one test.
 */
export function findFillets(mesh, topo) {
  const byFace = new Map();
  for (const e of topo.edges) {
    for (const id of [e.faceA, e.faceB]) {
      if (id === undefined || id < 0) continue;
      if (!byFace.has(id)) byFace.set(id, []);
      byFace.get(id).push(e);
    }
  }

  const out = [];
  for (const face of topo.faces) {
    const cyl = face.cylinder;
    if (!cyl || face.planar) continue;
    const edges = byFace.get(face.id) || [];
    const tangent = edges.filter((e) => e.tangent);
    // Both sides run out smoothly, which a wall or a bore does not do.
    if (tangent.length < 2) continue;

    const inward = facesInward(mesh, face, cyl);
    if (inward === null) continue;
    const points = facePoints(mesh, face);
    const span = axialSpan(points, cyl);

    out.push({
      face: face.id,
      radius: cyl.radius,
      axis: cyl.dir,
      centre: face.centre,
      length: span.depth,
      // A fillet on an outside edge takes material away and its surface faces
      // outward; one in an inside corner adds material and faces its axis.
      convex: !inward,
      area: face.area
    });
  }
  return out;
}

/** Round to a sensible number of places, so 4.999999 and 5 are one size. */
function sizeKey(v, places = 3) {
  return Number(v.toFixed(places));
}

/**
 * Holes and fillets gathered by size.
 *
 * Which is the useful shape for acting on them: a part has four M3 clearance
 * holes and eight 2 mm fillets, not twelve unrelated faces, and changing all
 * the 3.2s at once is the thing you actually want to do.
 */
export function groupBySize(items, key = 'diameter') {
  const groups = new Map();
  for (const it of items) {
    const k = sizeKey(it[key]);
    if (!groups.has(k)) groups.set(k, { size: k, items: [] });
    groups.get(k).items.push(it);
  }
  return [...groups.values()].sort((a, b) => a.size - b.size);
}

/**
 * What a body turns out to be made of.
 *
 * The report a person reads after importing something: so many holes in so many
 * sizes, so many fillets, so many flats. It is also what the interface offers
 * to select, which is why the groups come back rather than only the counts.
 */
export function recognise(mesh, topo) {
  const holes = findHoles(mesh, topo);
  const fillets = findFillets(mesh, topo);
  const flats = topo.faces.filter((f) => f.planar).length;
  const curved = topo.faces.length - flats;
  return {
    holes,
    fillets,
    holeSizes: groupBySize(holes, 'diameter'),
    filletSizes: groupBySize(fillets, 'radius'),
    counts: {
      faces: topo.faces.length,
      flats,
      curved,
      holes: holes.length,
      fillets: fillets.length,
      through: holes.filter((h) => h.through).length,
      blind: holes.filter((h) => !h.through).length
    }
  };
}
