/**
 * A texture that is really there: the surface pushed in and out until the
 * pattern is geometry, so it survives being sliced and comes off the printer.
 *
 * Anvil already had a Texture Extrude, and it fell short in three ways that
 * between them made it useful only on a scan. It worked on mesh bodies and not
 * on a modelled solid. It projected the picture down one plane, so the pattern
 * went on the side facing that plane and smeared everywhere else. And it moved
 * the vertices the body already had, which on a box is eight of them: the
 * picture had nowhere to land.
 *
 * All three are fixed here, and the third is the one that matters. A surface can
 * only carry as much detail as it has vertices, so the mesh is refined first,
 * until its triangles are smaller than the smallest thing in the picture. That
 * is why this is expensive and why the count is reported: a two hundred
 * millimetre panel at a quarter millimetre of detail is millions of triangles,
 * and somebody should be told that before they wait for it.
 *
 * The pattern wraps because it is sampled three times, once down each axis, and
 * blended by which way the surface faces. So it carries over an edge and round a
 * corner without a seam, and it needs no unwrapping of the model, which a solid
 * built from features has no natural way to provide.
 */

/* ------------------------------------------------------------------ */
/* Refinement                                                          */
/* ------------------------------------------------------------------ */

/**
 * Split every edge longer than a target, and keep the mesh watertight.
 *
 * The naive way is to divide each big triangle into four. That leaves its
 * neighbour undivided with a new point sitting in the middle of their shared
 * edge, touching nothing: a T-junction, which is a crack you cannot see until
 * the slicer finds it and the print has a slot in it.
 *
 * So the split is done on the edges rather than on the triangles. Every edge
 * that is too long gets one midpoint, shared by both triangles that own it, and
 * then each triangle is rebuilt according to how many of its own edges were
 * split. Three ways it can go, and all three are here, which is the whole of
 * why this is longer than it looks like it should be.
 */
export function refineMesh(points, tris, target, budget = 1500000) {
  let P = points.map((p) => [p[0], p[1], p[2]]);
  let T = tris.map((t) => [t[0], t[1], t[2]]);
  // Which original triangle each one came out of. Refinement only ever splits,
  // so every triangle has exactly one ancestor, and tracking it as we go is
  // exact and free. Working it out afterwards by looking for the nearest
  // original is neither: it is a guess, and it is one guess per triangle
  // against every original, which on a real part is billions of comparisons.
  let parent = T.map((_, i) => i);
  const want = Math.max(1e-6, target);

  for (let pass = 0; pass < 12; pass++) {
    // Numeric keys, not strings. A pass over half a million triangles builds
    // one key per edge, and building those as strings is most of the run time.
    const stride = P.length + T.length * 3 + 8;
    const key = (a, b) => (a < b ? a * stride + b : b * stride + a);
    const long = new Map();

    // Which edges are too long. Measured before anything moves, so both
    // triangles on an edge agree about it.
    for (const [a, b, c] of T) {
      for (const [i, j] of [[a, b], [b, c], [c, a]]) {
        const k = key(i, j);
        if (long.has(k)) continue;
        const d = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]);
        if (d > want) long.set(k, -1);
      }
    }
    if (!long.size) break;

    // One new point per edge, shared by both triangles that own it. Shared is
    // the whole point: a midpoint made twice is a crack.
    for (const [k] of long) {
      const a = Math.floor(k / stride);
      const b = k % stride;
      long.set(k, P.length);
      P.push([
        (P[a][0] + P[b][0]) / 2,
        (P[a][1] + P[b][1]) / 2,
        (P[a][2] + P[b][2]) / 2
      ]);
    }

    const out = [];
    const from = [];
    const add = (t, owner) => {
      out.push(t);
      from.push(owner);
    };

    T.forEach(([a, b, c], ti) => {
      const owner = parent[ti];
      const ab = long.get(key(a, b)) ?? -1;
      const bc = long.get(key(b, c)) ?? -1;
      const ca = long.get(key(c, a)) ?? -1;
      const n = (ab >= 0) + (bc >= 0) + (ca >= 0);

      if (n === 0) {
        add([a, b, c], owner);
      } else if (n === 3) {
        add([a, ab, ca], owner);
        add([ab, b, bc], owner);
        add([ca, bc, c], owner);
        add([ab, bc, ca], owner);
      } else if (n === 1) {
        // One split: two triangles, hinged on the corner opposite.
        if (ab >= 0) {
          add([a, ab, c], owner);
          add([ab, b, c], owner);
        } else if (bc >= 0) {
          add([b, bc, a], owner);
          add([bc, c, a], owner);
        } else {
          add([c, ca, b], owner);
          add([ca, a, b], owner);
        }
      } else {
        /*
         * Two splits leave a pentagon, and it has to be filled without making a
         * triangle out of three points in a line.
         *
         * The first version of this fanned from a midpoint to the two corners
         * either side of it, which is exactly such a line: a midpoint and the
         * two ends of its own edge. Those triangles have no area, and a mesh
         * with them in it is not manifold, so the whole body was refused with
         * nothing on screen to say which triangle was at fault.
         *
         * A fan from a corner cannot do that, so both choices here are fans
         * from corners, and the shorter diagonal decides which.
         */
        const fan = (p, q, r, s, t) => {
          if (dist(P[t], P[q]) + dist(P[t], P[r]) < dist(P[p], P[r]) + dist(P[p], P[s])) {
            add([t, p, q], owner);
            add([t, q, r], owner);
            add([t, r, s], owner);
          } else {
            add([p, q, r], owner);
            add([p, r, s], owner);
            add([p, s, t], owner);
          }
        };
        // The pentagon, walked round in order from the unsplit edge.
        if (ab < 0) fan(a, b, bc, c, ca);
        else if (bc < 0) fan(b, c, ca, a, ab);
        else fan(c, a, ab, b, bc);
      }
    });

    T = out;
    parent = from;
    if (T.length > budget) break;
  }
  return { points: P, tris: T, parent };
}

/**
 * Join points that are in the same place.
 *
 * Refinement splits edges by vertex index, so two triangles either side of an
 * edge have to be using the same two indices for it. A mesh that arrives with
 * its corners written out per triangle, which is what an STL is, has a separate
 * index for every one, and every edge is then split twice into two midpoints
 * that are in the same place and joined to nothing.
 */
export function weldPoints(points, tris, tol = 1e-6) {
  const at = new Map();
  const map = new Array(points.length);
  const out = [];
  const q = 1 / Math.max(tol, 1e-9);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const k = `${Math.round(p[0] * q)}_${Math.round(p[1] * q)}_${Math.round(p[2] * q)}`;
    const had = at.get(k);
    if (had === undefined) {
      at.set(k, out.length);
      map[i] = out.length;
      out.push([p[0], p[1], p[2]]);
    } else {
      map[i] = had;
    }
  }
  const kept = [];
  for (const [a, b, c] of tris) {
    const t = [map[a], map[b], map[c]];
    // A triangle whose corners welded together had no area to begin with.
    if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) kept.push(t);
  }
  return { points: out, tris: kept };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/* ------------------------------------------------------------------ */
/* Displacement                                                        */
/* ------------------------------------------------------------------ */

/** Smoothed normals, area weighted, which is what the surface actually faces. */
export function vertexNormals(points, tris) {
  const acc = points.map(() => [0, 0, 0]);
  for (const [i, j, k] of tris) {
    const ux = points[j][0] - points[i][0];
    const uy = points[j][1] - points[i][1];
    const uz = points[j][2] - points[i][2];
    const vx = points[k][0] - points[i][0];
    const vy = points[k][1] - points[i][1];
    const vz = points[k][2] - points[i][2];
    // Not normalised: a big triangle should count for more than a sliver.
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [i, j, k]) {
      acc[v][0] += nx;
      acc[v][1] += ny;
      acc[v][2] += nz;
    }
  }
  return acc.map((n) => {
    const l = Math.hypot(n[0], n[1], n[2]);
    return l > 1e-12 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 1];
  });
}

/**
 * The picture, read at a point in space, from whichever way the surface faces.
 *
 * Three readings blended, which is what carries the pattern over an edge. On a
 * face square to an axis one reading wins outright; on a rounded corner the
 * three mix, and the pattern bends round it rather than stopping.
 */
export function sampleTriplanar(sample, p, n, opts) {
  const s = opts.scale;
  const a = opts.angle || 0;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const spin = (u, v) => [u * cos - v * sin, u * sin + v * cos];

  const [ux, vx] = spin(p[1] * s, p[2] * s);
  const [uy, vy] = spin(p[2] * s, p[0] * s);
  const [uz, vz] = spin(p[0] * s, p[1] * s);

  const k = opts.sharpness || 4;
  let wx = Math.pow(Math.abs(n[0]), k);
  let wy = Math.pow(Math.abs(n[1]), k);
  let wz = Math.pow(Math.abs(n[2]), k);
  const sum = wx + wy + wz;
  if (!(sum > 1e-9)) return sample(0, 0);
  wx /= sum;
  wy /= sum;
  wz /= sum;

  return sample(ux, vx) * wx + sample(uy, vy) * wy + sample(uz, vz) * wz;
}

/**
 * Push a surface in and out by the brightness of a picture.
 *
 * Mid grey is the surface as it was, white stands out and black cuts in, which
 * is the convention every height map uses and the one that lets a pattern be
 * drawn without deciding in advance whether it is raised or sunk.
 *
 * `mask` says how much of the movement each vertex takes, which is how a
 * texture is put on some faces and not others. A vertex on the boundary takes
 * none, so the untextured part of the body is untouched and the two stay joined:
 * the alternative is a step at the boundary, and a step is a crack waiting to be
 * found by a slicer.
 */
export function displace(points, tris, sample, opts) {
  const normals = vertexNormals(points, tris);
  const depth = opts.depth ?? 1;
  const mode = opts.mode || 'both';
  const mask = opts.mask;

  return points.map((p, i) => {
    const w = mask ? mask[i] : 1;
    if (!(w > 0)) return p;
    const h = sampleTriplanar(sample, p, normals[i], opts);
    const t = mode === 'out' ? h : mode === 'in' ? h - 1 : h - 0.5;
    const d = t * depth * w;
    return [p[0] + normals[i][0] * d, p[1] + normals[i][1] * d, p[2] + normals[i][2] * d];
  });
}

/**
 * How much each vertex belongs to the faces that were picked.
 *
 * One where every triangle round the vertex was picked, nought where none was,
 * and in between on the boundary, which softens the edge of the textured patch
 * over the width of one triangle rather than dropping it off a cliff.
 */
export function faceMask(points, tris, chosenTris) {
  const want = new Set(chosenTris);
  const inside = points.map(() => 0);
  const total = points.map(() => 0);
  tris.forEach((t, i) => {
    const hit = want.has(i) ? 1 : 0;
    for (const v of t) {
      inside[v] += hit;
      total[v]++;
    }
  });
  return inside.map((n, i) => (total[i] ? n / total[i] : 0));
}
