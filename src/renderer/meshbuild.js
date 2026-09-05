/**
 * Solids built by stitching sections together.
 *
 * Booleans of primitives cannot express a loft or a sweep, so those are built
 * as meshes directly: a series of closed sections, each resampled to the same
 * number of points, joined into a tube and capped at the ends.
 *
 * Two details do most of the work. Sections are resampled by arc length, so
 * corresponding points sit at corresponding places around the profile rather
 * than wherever the original polyline happened to put them. And each section's
 * starting point is rotated to line up with the previous one, which is what
 * stops a loft between two squares coming out as a twisted prism.
 */

import * as THREE from './three.js';
import * as K from './kernel.js';

/* ------------------------------------------------------------------ */
/* Contour handling                                                    */
/* ------------------------------------------------------------------ */

/** Total length around a closed polyline of [x, y] pairs. */
function perimeter(pts) {
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/**
 * Resample a closed contour to exactly n points.
 *
 * Spacing purely by arc length walks straight past corners, rounding a
 * rectangle's four right angles off by up to half the sample spacing. So the
 * corners are kept as they are and the remaining points shared out along the
 * runs between them, in proportion to how long each run is. The result has the
 * requested count, the original shape, and points that still correspond
 * sensibly from one section to the next.
 */
export function resampleClosed(pts, n) {
  const clean = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-9) clean.push(p);
  }
  while (
    clean.length > 1 &&
    Math.hypot(
      clean[0][0] - clean[clean.length - 1][0],
      clean[0][1] - clean[clean.length - 1][1]
    ) < 1e-9
  ) {
    clean.pop();
  }
  const m = clean.length;
  if (m < 3) return null;
  if (m === n) return clean;

  const lens = [];
  let total = 0;
  for (let i = 0; i < m; i++) {
    const a = clean[i];
    const b = clean[(i + 1) % m];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lens.push(l);
    total += l;
  }
  if (total < 1e-9) return null;

  // Too many corners to keep them all: fall back to even spacing.
  if (m > n) return evenlySpaced(clean, lens, total, n);

  // How many extra points each run between corners deserves.
  const extra = new Array(m).fill(0);
  let left = n - m;
  const share = lens.map((l) => (l / total) * left);
  for (let i = 0; i < m; i++) {
    extra[i] = Math.floor(share[i]);
    left -= extra[i];
  }
  // Hand the rounding remainder to the longest runs.
  const order = lens
    .map((l, i) => [share[i] - Math.floor(share[i]), i])
    .sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < left; k++) extra[order[k % m][1]]++;

  const out = [];
  for (let i = 0; i < m; i++) {
    const a = clean[i];
    const b = clean[(i + 1) % m];
    out.push(a);
    const steps = extra[i] + 1;
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function evenlySpaced(clean, lens, total, n) {
  const m = clean.length;
  const out = [];
  let seg = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const target = (i * total) / n;
    while (seg < m - 1 && acc + lens[seg] < target) {
      acc += lens[seg];
      seg++;
    }
    const t = lens[seg] > 1e-12 ? (target - acc) / lens[seg] : 0;
    const a = clean[seg];
    const b = clean[(seg + 1) % m];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Signed area, used to force a consistent winding between sections. */
function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/**
 * Rotate a contour's point order so its start is nearest the reference's,
 * which is what stops corresponding points spiralling around the solid.
 */
export function alignStart(pts, reference) {
  if (!reference) return pts;
  let best = 0;
  let bestScore = Infinity;
  for (let shift = 0; shift < pts.length; shift++) {
    let score = 0;
    for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 12))) {
      const a = pts[(i + shift) % pts.length];
      const b = reference[i];
      score += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
    }
    if (score < bestScore) {
      bestScore = score;
      best = shift;
    }
  }
  if (best === 0) return pts;
  return [...pts.slice(best), ...pts.slice(0, best)];
}

/* ------------------------------------------------------------------ */
/* Stitching                                                           */
/* ------------------------------------------------------------------ */

/**
 * Build a closed solid from a run of sections.
 *
 * `sections` is an array of rings, each an array of [x, y, z] triples with the
 * same length and the same orientation. `closed` joins the last section back to
 * the first, for a swept ring.
 */
export function stitchTube(sections, opts = {}) {
  const { closed = false, capPlanes = null } = opts;
  if (sections.length < 2) return null;
  const ring = sections[0].length;
  for (const s of sections) {
    if (s.length !== ring) return null;
  }

  const verts = [];
  for (const s of sections) {
    for (const p of s) verts.push(p[0], p[1], p[2]);
  }

  const tris = [];
  const count = sections.length;
  const spans = closed ? count : count - 1;
  for (let i = 0; i < spans; i++) {
    const a = i * ring;
    const b = ((i + 1) % count) * ring;
    for (let k = 0; k < ring; k++) {
      const k2 = (k + 1) % ring;
      // Two triangles per quad. The order matters: with the ring running
      // anticlockwise about the direction of travel, going around the ring
      // before stepping to the next section is what puts the normal on the
      // outside. The other order builds the same shape inside out, and the
      // kernel rejects it as not manifold.
      tris.push(a + k, a + k2, b + k2);
      tris.push(a + k, b + k2, b + k);
    }
  }

  if (!closed && capPlanes !== false) {
    const startCap = capContour(sections[0], true, verts);
    const endCap = capContour(sections[count - 1], false, verts, (count - 1) * ring);
    tris.push(...startCap, ...endCap);
  }

  return { verts: new Float32Array(verts), tris: new Uint32Array(tris) };
}

/**
 * Triangulate an end section. The ring is planar because every section comes
 * from a sketch profile, so it can be flattened into its own plane, cut up
 * there, and the indices used directly.
 */
function capContour(ring, isStart, verts, base = 0) {
  const n = ring.length;
  if (n < 3) return [];

  // Plane of the ring, from its Newell normal.
  const normal = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
    normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
    normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const nl = Math.hypot(normal[0], normal[1], normal[2]);
  if (nl < 1e-12) return [];
  const nz = [normal[0] / nl, normal[1] / nl, normal[2] / nl];

  const seed =
    Math.abs(nz[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const ax = cross(seed, nz);
  const axl = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const ex = [ax[0] / axl, ax[1] / axl, ax[2] / axl];
  const ey = cross(nz, ex);

  const flat = ring.map((p) => {
    const d = [p[0] - ring[0][0], p[1] - ring[0][1], p[2] - ring[0][2]];
    return new THREE.Vector2(
      d[0] * ex[0] + d[1] * ex[1] + d[2] * ex[2],
      d[0] * ey[0] + d[1] * ey[1] + d[2] * ey[2]
    );
  });

  const faces = THREE.ShapeUtils.triangulateShape(flat, []);
  const out = [];
  for (const [a, b, c] of faces) {
    // The start cap faces backwards along the run, the end cap forwards.
    if (isStart) out.push(base + a, base + c, base + b);
    else out.push(base + a, base + b, base + c);
  }
  return out;
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

/* ------------------------------------------------------------------ */
/* Frames along a path                                                 */
/* ------------------------------------------------------------------ */

/**
 * Rotation minimising frames along a polyline.
 *
 * Carrying one frame forward by the smallest rotation that keeps it
 * perpendicular to the path is what stops a swept profile spinning as the path
 * curves. Building each frame independently from a fixed world axis instead
 * makes the sweep flip wherever the tangent passes that axis.
 */
export function pathFrames(points, opts = {}) {
  const { closed = false, twistDegrees = 0 } = opts;
  const n = points.length;
  if (n < 2) return [];

  const tangents = [];
  for (let i = 0; i < n; i++) {
    let t;
    if (i === 0) t = closed ? sub3(points[1], points[n - 1]) : sub3(points[1], points[0]);
    else if (i === n - 1) {
      t = closed ? sub3(points[0], points[n - 2]) : sub3(points[n - 1], points[n - 2]);
    } else t = sub3(points[i + 1], points[i - 1]);
    tangents.push(normalize3(t));
  }

  const frames = [];
  let normal = perpendicularTo(tangents[0]);

  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // Rotate the carried normal by the same turn the tangent just made.
      const prev = tangents[i - 1];
      const cur = tangents[i];
      const axis = cross(prev, cur);
      const sin = Math.hypot(axis[0], axis[1], axis[2]);
      if (sin > 1e-9) {
        const angle = Math.atan2(sin, dot3(prev, cur));
        normal = rotateAbout(normal, [axis[0] / sin, axis[1] / sin, axis[2] / sin], angle);
      }
      // Keep it exactly perpendicular against drift.
      normal = normalize3(sub3(normal, mul3(cur, dot3(normal, cur))));
    }
    const binormal = cross(tangents[i], normal);
    frames.push({ origin: points[i], x: normal, y: binormal, z: tangents[i] });
  }

  if (twistDegrees) {
    const total = (twistDegrees * Math.PI) / 180;
    frames.forEach((f, i) => {
      const angle = (total * i) / Math.max(1, n - 1);
      f.x = rotateAbout(f.x, f.z, angle);
      f.y = cross(f.z, f.x);
    });
  }

  return frames;
}

function perpendicularTo(v) {
  const seed = Math.abs(v[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return normalize3(cross(seed, v));
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function rotateAbout(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot3(axis, v);
  const cr = cross(axis, v);
  return [
    v[0] * c + cr[0] * s + axis[0] * d * (1 - c),
    v[1] * c + cr[1] * s + axis[1] * d * (1 - c),
    v[2] * c + cr[2] * s + axis[2] * d * (1 - c)
  ];
}

/* ------------------------------------------------------------------ */
/* Loft and sweep                                                      */
/* ------------------------------------------------------------------ */

const RING_POINTS = 96;

/**
 * Loft between planar loops.
 * `loops` is an array of { contour: [[x,y]...], plane } in order.
 */
export function loftLoops(loops, scope, opts = {}) {
  if (loops.length < 2) return null;
  const n = opts.ringPoints || RING_POINTS;

  let previous = null;
  const sections = [];
  for (const loop of loops) {
    let flat = loop.contour;
    if (signedArea(flat) < 0) flat = [...flat].reverse();
    // A point section has no area to resample, so its ring is the point
    // repeated. That is what lets a loft come to a tip.
    let ring = degenerateRing(flat, n) || resampleClosed(flat, n);
    if (!ring) return null;
    ring = alignStart(ring, previous);
    previous = ring;

    const p = loop.plane;
    sections.push(
      ring.map(([x, y]) => [
        p.origin[0] + p.x[0] * x + p.y[0] * y,
        p.origin[1] + p.x[1] * x + p.y[1] * y,
        p.origin[2] + p.x[2] * x + p.y[2] * y
      ])
    );
  }

  const mesh = stitchTube(sections, { closed: !!opts.closed });
  if (!mesh) return null;
  return K.ofMesh(mesh.verts, mesh.tris, scope);
}

/** A ring of n copies of one place, when a section is a single point. */
function degenerateRing(flat, n) {
  if (!flat.length) return null;
  const [x0, y0] = flat[0];
  for (const [x, y] of flat) {
    if (Math.hypot(x - x0, y - y0) > 1e-9) return null;
  }
  const ring = [];
  for (let i = 0; i < n; i++) ring.push([x0, y0]);
  return ring;
}

/**
 * Sweep a planar loop along a path.
 * `contour` is in the profile plane's own coordinates; the path is world space.
 */
export function sweepLoop(contour, pathPoints, scope, opts = {}) {
  const n = opts.ringPoints || RING_POINTS;
  let flat = contour;
  if (signedArea(flat) < 0) flat = [...flat].reverse();
  const ring = resampleClosed(flat, n);
  if (!ring) return null;

  // The caller may already have built the frames, because it needed the first
  // one to express the profile in.
  const frames =
    opts.frames ||
    pathFrames(pathPoints, {
      closed: opts.closed,
      twistDegrees: opts.twistDegrees || 0
    });
  if (frames.length < 2) return null;

  /*
   * How much the section is scaled at each station along the path.
   *
   * `scaleAt` carries a value per frame, which is how a guide rail drives the
   * section: the rail's distance from the path at that point says how much
   * bigger the profile has to be there. Stretching applies it in one direction
   * only, along the frame's own X, which is the way the rail leans.
   */
  const factors = opts.scaleAt?.by || null;
  const stretch = opts.scaleAt?.mode === 'stretch';
  const legacyEnd = opts.scaleEnd && opts.scaleEnd !== 1 ? opts.scaleEnd : null;
  const scaleFor = (i) => {
    if (factors) return factors[Math.min(i, factors.length - 1)] ?? 1;
    if (!legacyEnd) return 1;
    return 1 + (legacyEnd - 1) * (i / Math.max(1, frames.length - 1));
  };

  const sections = frames.map((f, i) => {
    const s = scaleFor(i);
    const sx = s;
    const sy = stretch ? 1 : s;
    return ring.map(([x, y]) => [
      f.origin[0] + f.x[0] * x * sx + f.y[0] * y * sy,
      f.origin[1] + f.x[1] * x * sx + f.y[1] * y * sy,
      f.origin[2] + f.x[2] * x * sx + f.y[2] * y * sy
    ]);
  });

  const mesh = stitchTube(sections, { closed: !!opts.closed });
  if (!mesh) return null;
  return K.ofMesh(mesh.verts, mesh.tris, scope);
}

/**
 * A helical solid, for threads.
 *
 * The profile is given in the (radial, axial) half plane and carried around the
 * axis while rising by one pitch per turn. Frames are built from the radius and
 * the axis directly rather than from the path tangent, so the profile stays
 * pointing out of the cylinder instead of rolling with the helix.
 */
/**
 * A section swept along a helix, in a local frame of (radial, axial).
 *
 * `taperDeg` opens the helix into a cone as it climbs, and `spiral` spends the
 * pitch on the radius instead of the height so the result lies flat. Both are
 * flags rather than separate functions because only the centre of the section
 * moves; the stitching, the handedness and the winding fix are all the same.
 */
export function helicalSweep(profile, opts, scope) {
  const {
    radius,
    pitch,
    turns,
    stepsPerTurn = 48,
    startZ = 0,
    handed = 1,
    taperDeg = 0,
    spiral = false
  } = opts;

  const steps = Math.max(8, Math.round(stepsPerTurn * turns));
  const sections = [];
  const taper = Math.tan((taperDeg * Math.PI) / 180);

  // The local frame here is (radial, axial), and radial cross axial points
  // against the direction of travel, so this frame is left handed. The ring
  // therefore has to run the opposite way round from the usual convention or
  // the whole helix comes out inside out, and subtracting it adds material.
  const wantPositiveArea = handed < 0;
  const oriented =
    signedArea(profile) > 0 === wantPositiveArea ? profile : [...profile].reverse();
  const ring = resampleClosed(oriented, opts.ringPoints || 32);
  if (!ring) return null;

  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * turns;
    const angle = handed * t * Math.PI * 2;

    // A spiral spends its pitch on the radius instead of on the height, so it
    // lies flat and winds outward. Everything else about the sweep is the same,
    // which is why it is a flag here rather than a second function.
    const z = spiral ? startZ : startZ + t * pitch;
    const centre = spiral ? radius + t * pitch : radius + (z - startZ) * taper;
    if (centre <= 0) continue;

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // Local axes: outward radial, then along the axis.
    sections.push(
      ring.map(([r, a]) => [
        (centre + r) * cosA,
        (centre + r) * sinA,
        z + a
      ])
    );
  }
  if (sections.length < 2) return null;

  const mesh = stitchTube(sections, { closed: false });
  if (!mesh) return null;
  return K.ofMesh(mesh.verts, mesh.tris, scope);
}

/**
 * A blend swept along an edge with the profile changing as it goes, which is
 * what a variable radius fillet is. Each station gets its own corner profile,
 * resampled to a common ring so the stations can be stitched.
 */
export function variableSweep(stations, scope, opts = {}) {
  const n = opts.ringPoints || 48;
  const sections = [];

  // If the stations were generated with matching point counts there is nothing
  // to gain from resampling, and something to lose: spacing points evenly by
  // arc length walks straight past the sharp corners of a profile, rounding
  // them off by a fraction of the sample spacing. Corners matter here, because
  // a blend's straight legs have to land exactly on the faces they cut.
  const uniform = stations.every((st) => st.contour.length === stations[0].contour.length);

  for (const station of stations) {
    let flat = station.contour;
    if (signedArea(flat) < 0) flat = [...flat].reverse();
    const ring = uniform ? flat : resampleClosed(flat, n);
    if (!ring) return null;
    // No start alignment here. Every station comes from the same profile
    // generator anchored at the same corner, so points already correspond;
    // matching by nearest distance instead would rotate the larger rings
    // against the smaller ones and put a twist through the blend.

    const f = station.frame;
    sections.push(
      ring.map(([x, y]) => [
        f.origin[0] + f.x[0] * x + f.y[0] * y,
        f.origin[1] + f.x[1] * x + f.y[1] * y,
        f.origin[2] + f.x[2] * x + f.y[2] * y
      ])
    );
  }

  const mesh = stitchTube(sections, { closed: false });
  if (!mesh) return null;
  return K.ofMesh(mesh.verts, mesh.tris, scope);
}

export { signedArea as contourArea, RING_POINTS };
