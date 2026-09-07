/**
 * Inspection: mass properties, interference, and the two face analyses.
 *
 * Nothing here changes the model. Everything is measured off the mesh a rebuild
 * already produced, or drawn over it, so an analysis can never leave the part
 * different from how it was found.
 */

import * as K from './kernel.js';
import { buildTopology } from './topology.js';

/**
 * Densities in grams per cubic centimetre.
 *
 * The printing materials first, because that is what this is for: a part's mass
 * decides what it costs in filament and whether it can be posted. The metals
 * are here for the times a printed part stands in for one.
 */
export const MATERIALS = [
  ['pla', 'PLA', 1.24],
  ['petg', 'PETG', 1.27],
  ['abs', 'ABS', 1.04],
  ['asa', 'ASA', 1.07],
  ['tpu', 'TPU', 1.21],
  ['nylon', 'Nylon', 1.14],
  ['pc', 'Polycarbonate', 1.2],
  ['resin', 'Resin', 1.18],
  ['aluminium', 'Aluminium', 2.7],
  ['steel', 'Steel', 7.85],
  ['stainless', 'Stainless steel', 8.0],
  ['brass', 'Brass', 8.5],
  ['titanium', 'Titanium', 4.51],
  ['oak', 'Oak', 0.75]
];

const DENSITY = new Map(MATERIALS.map(([id, , d]) => [id, d]));

/** Grams per cubic centimetre for a named material, PLA when unknown. */
export function densityOf(name) {
  return DENSITY.get(name) ?? DENSITY.get('pla');
}

export function materialLabel(name) {
  const hit = MATERIALS.find(([id]) => id === name);
  return hit ? hit[1] : 'PLA';
}

/**
 * Volume and centroid of a mesh.
 *
 * Each triangle makes a tetrahedron with the origin. The signed volumes cancel
 * everywhere the surface doubles back, so the sum is the enclosed volume
 * however the body is placed, and the same weighting on the tetrahedra's own
 * centroids gives the centre of mass of a uniform solid.
 *
 * Being uniform is the assumption worth stating: a printed part is infill and
 * air, so this is the mass of the same shape solid.
 */
export function massProperties(mesh) {
  const vp = mesh.vertProperties;
  const tris = mesh.triVerts;
  let vol = 0;
  const c = [0, 0, 0];

  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3;
    const b = tris[t + 1] * 3;
    const d = tris[t + 2] * 3;
    const ax = vp[a];
    const ay = vp[a + 1];
    const az = vp[a + 2];
    const bx = vp[b];
    const by = vp[b + 1];
    const bz = vp[b + 2];
    const cx = vp[d];
    const cy = vp[d + 1];
    const cz = vp[d + 2];

    const v =
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    vol += v;
    c[0] += ((ax + bx + cx) / 4) * v;
    c[1] += ((ay + by + cy) / 4) * v;
    c[2] += ((az + bz + cz) / 4) * v;
  }

  if (Math.abs(vol) < 1e-12) return { volume: 0, centroid: [0, 0, 0] };
  return { volume: vol, centroid: [c[0] / vol, c[1] / vol, c[2] / vol] };
}

/**
 * Mass properties over a set of bodies, each with its own density.
 *
 * The combined centre is the masses' weighted mean, not the volumes', so a
 * steel insert in a plastic housing pulls it the way it really would.
 */
export function combinedMass(entries) {
  let mass = 0;
  let volume = 0;
  const c = [0, 0, 0];
  const each = [];

  for (const { id, name, mesh, material } of entries) {
    const { volume: v, centroid } = massProperties(mesh);
    // Cubic millimetres to cubic centimetres, then times grams per cc.
    const g = (v / 1000) * densityOf(material);
    mass += g;
    volume += v;
    c[0] += centroid[0] * g;
    c[1] += centroid[1] * g;
    c[2] += centroid[2] * g;
    each.push({ id, name, volume: v, grams: g, centroid, material });
  }

  if (Math.abs(mass) < 1e-12) return { mass: 0, volume, centre: [0, 0, 0], each };
  return { mass, volume, centre: [c[0] / mass, c[1] / mass, c[2] / mass], each };
}

/**
 * Every pair of bodies that overlaps, and by how much.
 *
 * Bodies that merely touch are not an interference: a boolean of two solids
 * meeting on a face gives a sliver of no volume, so anything under a
 * thousandth of a cubic millimetre is treated as contact rather than overlap.
 */
export function interferences(records, scope) {
  const CONTACT = 1e-3;
  const out = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i];
      const b = records[j];
      let solid = null;
      try {
        solid = K.intersection(a.solid, b.solid, scope);
      } catch {
        continue;
      }
      if (!solid || K.isEmpty(solid)) continue;
      const v = solid.volume();
      if (!(v > CONTACT)) continue;
      out.push({
        a: a.id,
        b: b.id,
        nameA: a.name,
        nameB: b.name,
        volume: v,
        centroid: massProperties(K.meshData(solid)).centroid
      });
    }
  }
  return out.sort((x, y) => y.volume - x.volume);
}

/**
 * A colour per vertex saying how each face is drafted about a pull direction.
 *
 * Green is drafted enough to come out of a mould, red is drafted the wrong way,
 * and grey is within the angle of vertical where it will drag. For a printed
 * part the same reading is about overhangs: a face further than the given angle
 * from the pull direction is one the printer has to bridge or support.
 */
export function draftColours(mesh, dir, angleDeg) {
  const vp = mesh.vertProperties;
  const tris = mesh.triVerts;
  const limit = Math.sin((Math.max(0, angleDeg) * Math.PI) / 180);
  const colours = new Float32Array(vp.length);

  const paint = (i, r, g, b) => {
    colours[i * 3] = r;
    colours[i * 3 + 1] = g;
    colours[i * 3 + 2] = b;
  };

  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3;
    const b = tris[t + 1] * 3;
    const c = tris[t + 2] * 3;
    const ux = vp[b] - vp[a];
    const uy = vp[b + 1] - vp[a + 1];
    const uz = vp[b + 2] - vp[a + 2];
    const vx = vp[c] - vp[a];
    const vy = vp[c + 1] - vp[a + 1];
    const vz = vp[c + 2] - vp[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;

    // Sine of the angle away from square to the pull, signed by which way the
    // face looks along it.
    const along = nx * dir[0] + ny * dir[1] + nz * dir[2];
    let r;
    let g;
    let bl;
    if (Math.abs(along) < limit) {
      // Too near vertical to draw out cleanly.
      r = 0.62;
      g = 0.6;
      bl = 0.56;
    } else if (along > 0) {
      r = 0.24;
      g = 0.55;
      bl = 0.3;
    } else {
      r = 0.72;
      g = 0.28;
      bl = 0.18;
    }
    paint(tris[t], r, g, bl);
    paint(tris[t + 1], r, g, bl);
    paint(tris[t + 2], r, g, bl);
  }
  return colours;
}


/* ------------------------------------------------------------------ */
/* Surface analyses                                                    */
/* ------------------------------------------------------------------ */

/**
 * Curvature at every vertex of a mesh.
 *
 * Gaussian curvature comes from the angle deficit: on a flat sheet the angles
 * of the triangles round a vertex add to a full turn, and how far short or over
 * they fall is the curvature, scaled by the area they cover. Mean curvature
 * comes from the cotangent Laplacian, whose length at a vertex is twice the
 * mean curvature. Between them the two principal curvatures fall out, which is
 * what the minimum radius and the curvature map both want.
 */
export function vertexCurvature(mesh) {
  const vp = mesh.vertProperties;
  const tris = mesh.triVerts;
  const n = vp.length / 3;

  const area = new Float64Array(n);
  const deficit = new Float64Array(n).fill(Math.PI * 2);
  const lap = new Float64Array(n * 3);

  const at = (i) => [vp[i * 3], vp[i * 3 + 1], vp[i * 3 + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);

  for (let t = 0; t < tris.length; t += 3) {
    const idx = [tris[t], tris[t + 1], tris[t + 2]];
    const p = idx.map(at);
    for (let k = 0; k < 3; k++) {
      const a = p[k];
      const b = p[(k + 1) % 3];
      const c = p[(k + 2) % 3];
      const u = sub(b, a);
      const v = sub(c, a);
      const lu = len(u) || 1e-12;
      const lv = len(v) || 1e-12;
      const cosA = Math.min(1, Math.max(-1, dot(u, v) / (lu * lv)));
      const ang = Math.acos(cosA);
      deficit[idx[k]] -= ang;

      // A third of the triangle's area to each corner. Crude next to the mixed
      // Voronoi area, and close enough on a mesh this even.
      const cx = u[1] * v[2] - u[2] * v[1];
      const cy = u[2] * v[0] - u[0] * v[2];
      const cz = u[0] * v[1] - u[1] * v[0];
      area[idx[k]] += Math.hypot(cx, cy, cz) / 6;

      // Cotangent weights, accumulated as the Laplacian of the position.
      const cot = cosA / Math.max(1e-12, Math.sin(ang));
      const opp = sub(b, c);
      for (let d = 0; d < 3; d++) {
        lap[idx[(k + 1) % 3] * 3 + d] -= (cot * opp[d]) / 2;
        lap[idx[(k + 2) % 3] * 3 + d] += (cot * opp[d]) / 2;
      }
    }
  }

  const gauss = new Float64Array(n);
  const mean = new Float64Array(n);
  const kMin = new Float64Array(n);
  const kMax = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const A = Math.max(1e-12, area[i]);
    gauss[i] = deficit[i] / A;
    // The cotangent Laplacian of the position has length 2H when divided by
    // the vertex area, and the half already taken while accumulating the
    // weights is the other factor. A sphere of radius r reading 1/(2r) rather
    // than 1/r is what a stray two looks like.
    mean[i] = Math.hypot(lap[i * 3], lap[i * 3 + 1], lap[i * 3 + 2]) / (2 * A);
    // k1 and k2 are the roots of k^2 - 2H k + K = 0; a negative discriminant
    // only means the estimate wandered, so it is clamped rather than dropped.
    const disc = Math.max(0, mean[i] * mean[i] - gauss[i]);
    const root = Math.sqrt(disc);
    kMin[i] = mean[i] - root;
    kMax[i] = mean[i] + root;
  }
  return { gauss, mean, kMin, kMax };
}

/** The diagonal of a mesh's bounding box, for scaling anything size relative. */
export function meshExtent(mesh) {
  const vp = mesh.vertProperties;
  if (!vp.length) return 1;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vp.length; i += 3) {
    for (let d = 0; d < 3; d++) {
      if (vp[i + d] < lo[d]) lo[d] = vp[i + d];
      if (vp[i + d] > hi[d]) hi[d] = vp[i + d];
    }
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
}

/** A colour ramp from cool to warm, for a value already scaled to 0 to 1. */
function ramp(t) {
  const x = Math.min(1, Math.max(0, t));
  if (x < 0.5) {
    const u = x * 2;
    return [0.16 + 0.2 * u, 0.36 + 0.3 * u, 0.6 - 0.1 * u];
  }
  const u = (x - 0.5) * 2;
  return [0.36 + 0.4 * u, 0.66 - 0.4 * u, 0.5 - 0.35 * u];
}

/**
 * Faces coloured by how sharply they curve.
 *
 * Scaled against the part's own size rather than against absolute millimetres,
 * so a bracket and a bottle cap read the same way and a flat face is always at
 * the cool end.
 */
export function curvatureColours(mesh, extent) {
  const { mean } = vertexCurvature(mesh);
  const n = mean.length;
  const colours = new Float32Array(n * 3);
  const size = extent && extent > 1e-6 ? extent : meshExtent(mesh);
  const scale = Math.max(1e-9, 4 / Math.max(1e-6, size));
  for (let i = 0; i < n; i++) {
    const c = ramp(Math.abs(mean[i]) / scale);
    colours[i * 3] = c[0];
    colours[i * 3 + 1] = c[1];
    colours[i * 3 + 2] = c[2];
  }
  return colours;
}

/**
 * The tightest inside corner, coloured.
 *
 * What this answers is whether a cutter or a nozzle can get into it. Anything
 * whose concave radius is under the stated tool radius is painted red, because
 * that is the part that will come out wrong.
 */
export function minimumRadiusColours(mesh, toolRadius) {
  const { kMax } = vertexCurvature(mesh);
  const n = kMax.length;
  const colours = new Float32Array(n * 3);
  const limit = 1 / Math.max(1e-6, toolRadius);
  for (let i = 0; i < n; i++) {
    // Concave is positive curvature here, and the tighter it is the larger.
    const k = kMax[i];
    let c;
    if (k <= 0) c = [0.55, 0.58, 0.6];
    else if (k >= limit) c = [0.76, 0.24, 0.16];
    else c = ramp(k / limit);
    colours[i * 3] = c[0];
    colours[i * 3 + 1] = c[1];
    colours[i * 3 + 2] = c[2];
  }
  return colours;
}

/**
 * Zebra stripes, for reading how smoothly one face runs into the next.
 *
 * The stripe follows the angle between the surface normal and a direction, so
 * a stripe that kinks means the normals kink, which is a crease; a stripe that
 * merely bends means the curvature changes. That is the whole reason to look at
 * stripes rather than at the surface.
 */
export function zebraColours(mesh, dir, bands) {
  const vp = mesh.vertProperties;
  const tris = mesh.triVerts;
  const n = vp.length / 3;
  const normals = new Float64Array(n * 3);

  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3;
    const b = tris[t + 1] * 3;
    const c = tris[t + 2] * 3;
    const ux = vp[b] - vp[a];
    const uy = vp[b + 1] - vp[a + 1];
    const uz = vp[b + 2] - vp[a + 2];
    const vx = vp[c] - vp[a];
    const vy = vp[c + 1] - vp[a + 1];
    const vz = vp[c + 2] - vp[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const i of [tris[t], tris[t + 1], tris[t + 2]]) {
      normals[i * 3] += nx;
      normals[i * 3 + 1] += ny;
      normals[i * 3 + 2] += nz;
    }
  }

  const colours = new Float32Array(n * 3);
  const k = Math.max(1, bands || 12);
  for (let i = 0; i < n; i++) {
    const l =
      Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
    const d =
      (normals[i * 3] * dir[0] + normals[i * 3 + 1] * dir[1] + normals[i * 3 + 2] * dir[2]) / l;
    const stripe = Math.sin(Math.acos(Math.min(1, Math.max(-1, d))) * k) > 0 ? 0.93 : 0.16;
    colours[i * 3] = stripe;
    colours[i * 3 + 1] = stripe;
    colours[i * 3 + 2] = stripe;
  }
  return colours;
}

/**
 * Which parts of a body can be reached from a direction.
 *
 * A ray is cast out of each vertex along the direction, and if it meets the
 * body again on the way out, that vertex is in shadow: a tool coming from there
 * cannot touch it, and a printer laying down from there has to bridge to it.
 * Brute force against every triangle, which is fine at these mesh sizes and
 * honest about what it measures.
 */
export function accessibilityColours(mesh, dir) {
  const vp = mesh.vertProperties;
  const tris = mesh.triVerts;
  const n = vp.length / 3;
  const colours = new Float32Array(n * 3);
  const d = normalise(dir);
  const EPS = 1e-4;

  for (let i = 0; i < n; i++) {
    const ox = vp[i * 3] + d[0] * EPS;
    const oy = vp[i * 3 + 1] + d[1] * EPS;
    const oz = vp[i * 3 + 2] + d[2] * EPS;
    let blocked = false;
    for (let t = 0; t < tris.length && !blocked; t += 3) {
      if (tris[t] === i || tris[t + 1] === i || tris[t + 2] === i) continue;
      blocked = rayHitsTriangle(ox, oy, oz, d, vp, tris[t], tris[t + 1], tris[t + 2]);
    }
    const c = blocked ? [0.72, 0.28, 0.18] : [0.24, 0.55, 0.3];
    colours[i * 3] = c[0];
    colours[i * 3 + 1] = c[1];
    colours[i * 3 + 2] = c[2];
  }
  return colours;
}

function normalise(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Moller-Trumbore, forward hits only. */
function rayHitsTriangle(ox, oy, oz, d, vp, ia, ib, ic) {
  const ax = vp[ia * 3];
  const ay = vp[ia * 3 + 1];
  const az = vp[ia * 3 + 2];
  const e1x = vp[ib * 3] - ax;
  const e1y = vp[ib * 3 + 1] - ay;
  const e1z = vp[ib * 3 + 2] - az;
  const e2x = vp[ic * 3] - ax;
  const e2y = vp[ic * 3 + 1] - ay;
  const e2z = vp[ic * 3 + 2] - az;

  const px = d[1] * e2z - d[2] * e2y;
  const py = d[2] * e2x - d[0] * e2z;
  const pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;

  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return false;

  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-6;
}

/**
 * A comb along a curve, showing its curvature as spikes off the outside.
 *
 * Reading curvature off a curve by eye is close to impossible; reading a comb
 * is easy, because a kink in the comb's outer edge is a kink in the curvature
 * that the curve itself hides.
 */
export function curvatureComb(points, scale = 1, density = 1) {
  const out = [];
  const step = Math.max(1, Math.round(1 / Math.max(0.05, density)));
  for (let i = step; i < points.length - step; i += step) {
    const a = points[i - step];
    const b = points[i];
    const c = points[i + step];
    const spike = combSpike(a, b, c, scale);
    if (spike) out.push({ at: b, to: spike });
  }
  return out;
}

function combSpike(a, b, c, scale) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const vz = c[2] - b[2];
  const lu = Math.hypot(ux, uy, uz);
  const lv = Math.hypot(vx, vy, vz);
  if (lu < 1e-9 || lv < 1e-9) return null;

  // Menger curvature: one over the radius of the circle through the three
  // points, which is four times the triangle's area over the product of its
  // sides.
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  const cross = Math.hypot(cx, cy, cz);
  const lw = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  if (lw < 1e-9 || cross < 1e-12) return null;
  const k = (2 * cross) / (lu * lv * lw);

  // Out along the normal in the plane of the three points, which is the
  // direction the curve is turning away from.
  const nx = cy * ux - cz * uy;
  const ny = cz * ux - cx * uz;
  const nz = cx * uy - cy * ux;
  const ln = Math.hypot(nx, ny, nz) || 1;
  const s = k * scale;
  return [b[0] - (nx / ln) * s, b[1] - (ny / ln) * s, b[2] - (nz / ln) * s];
}

/**
 * A ray caster over one mesh, with the mesh unpacked once.
 *
 * The general one in `sheet.js` rebuilds its point list on every call, which is
 * right for a handful of rays and ruinous for the thousands a thickness sweep
 * sends. Here the triangles are flattened into one typed array up front and the
 * inner loop touches nothing but numbers.
 */
export function rayCaster(mesh) {
  const stride = mesh.numProp;
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const n = tv.length / 3;
  const T = new Float64Array(n * 9);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const v = tv[t * 3 + k] * stride;
      T[t * 9 + k * 3] = vp[v];
      T[t * 9 + k * 3 + 1] = vp[v + 1];
      T[t * 9 + k * 3 + 2] = vp[v + 2];
    }
  }

  return (ox, oy, oz, dx, dy, dz) => {
    let best = Infinity;
    for (let i = 0; i < T.length; i += 9) {
      const ax = T[i];
      const ay = T[i + 1];
      const az = T[i + 2];
      const e1x = T[i + 3] - ax;
      const e1y = T[i + 4] - ay;
      const e1z = T[i + 5] - az;
      const e2x = T[i + 6] - ax;
      const e2y = T[i + 7] - ay;
      const e2z = T[i + 8] - az;
      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const tx = ox - ax;
      const ty = oy - ay;
      const tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < -1e-9 || u + v > 1 + 1e-9) continue;
      const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (hit > 1e-7 && hit < best) best = hit;
    }
    return best;
  };
}

/**
 * Wall thickness under a point on a surface, measured by looking through it.
 *
 * A ray sent straight into the material comes out the other side, and how far
 * it went is the thickness there. This is the honest measure rather than an
 * offset test: it reads a rib, a boss wall and the web between two pockets the
 * same way, and it needs nothing to be recognised first.
 *
 * It reads through a hole as well, which is why the caller samples a face in
 * several places and keeps the smallest sensible reading rather than the
 * smallest of all of them.
 */
export function thicknessAt(mesh, point, normal) {
  const cast = typeof mesh === 'function' ? mesh : rayCaster(mesh);
  const dx = -normal[0];
  const dy = -normal[1];
  const dz = -normal[2];
  return cast(
    point[0] + dx * 1e-4,
    point[1] + dy * 1e-4,
    point[2] + dz * 1e-4,
    dx,
    dy,
    dz
  );
}

/** A few points spread over a face, for sampling it rather than its centre. */
function faceSamples(mesh, face, want = 3) {
  const stride = mesh.numProp;
  const out = [];
  const step = Math.max(1, Math.floor(face.tris.length / want));
  for (let i = 0; i < face.tris.length; i += step) {
    const t = face.tris[i];
    const at = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = mesh.triVerts[t * 3 + k] * stride;
      at[0] += mesh.vertProperties[v] / 3;
      at[1] += mesh.vertProperties[v + 1] / 3;
      at[2] += mesh.vertProperties[v + 2] / 3;
    }
    out.push(at);
  }
  return out;
}

/**
 * Everything about a design that is likely to give trouble downstream.
 *
 * Fusion calls this Design Advice and mostly points at moulding. This points at
 * the two things a part here actually meets: a printer and, sometimes, a cutter.
 * Every finding names where it is, so it can be selected rather than hunted
 * for, and every threshold is a setting rather than a rule, because a 0.4 nozzle
 * and a 0.8 nozzle disagree about almost all of them.
 *
 * Nothing here is a verdict. A thin wall is a finding, not an error: plenty of
 * parts are meant to have one.
 */
export function designAdvice(entries, opts = {}) {
  const up = opts.up || [0, 0, 1];
  const minWall = opts.minWall ?? 1.2;
  const minFeature = opts.minFeature ?? 0.8;
  const overhang = opts.overhang ?? 45;
  const sharpAt = opts.sharpAt ?? 60;
  const findings = [];

  for (const { id, name, mesh, topo } of entries) {
    if (!mesh || !topo) continue;
    const label = name || 'body';

    // ---- thin walls
    const cast = rayCaster(mesh);
    let thinnest = null;
    for (const face of topo.faces) {
      if (face.area < minFeature * minFeature) continue;
      let here = Infinity;
      for (const at of faceSamples(mesh, face, 3)) {
        const t = thicknessAt(cast, at, face.normal);
        if (t < here) here = t;
      }
      if (here < minWall && (!thinnest || here < thinnest.thickness)) {
        thinnest = { face: face.id, thickness: here, at: face.centre };
      }
    }
    if (thinnest) {
      findings.push({
        kind: 'thinWall',
        bodyId: id,
        faceId: thinnest.face,
        at: thinnest.at,
        value: thinnest.thickness,
        message: `${label} is ${thinnest.thickness.toFixed(2)} thick in places, under the ${minWall} asked for.`
      });
    }

    // ---- gaps and bores too narrow to print
    //
    // The same ray, turned round. Sent out of a face it escapes into the air,
    // unless the face is looking across a bore or a slot, in which case it
    // lands on the other side of it and how far it went is the width. This
    // reads a faceted bore, which a fit to a cylinder cannot: below about four
    // millimetres a round hole comes out of the kernel as a handful of flats,
    // and those are exactly the holes small enough to be worth warning about.
    let narrowest = null;
    for (const face of topo.faces) {
      if (face.area < minFeature * minFeature * 0.25) continue;
      for (const at of faceSamples(mesh, face, 2)) {
        const gap = cast(
          at[0] + face.normal[0] * 1e-4,
          at[1] + face.normal[1] * 1e-4,
          at[2] + face.normal[2] * 1e-4,
          face.normal[0],
          face.normal[1],
          face.normal[2]
        );
        if (gap < minFeature * 2 && (!narrowest || gap < narrowest.gap)) {
          narrowest = { gap, face: face.id, at: face.centre };
        }
      }
    }
    if (narrowest) {
      findings.push({
        kind: 'narrowGap',
        bodyId: id,
        faceId: narrowest.face,
        at: narrowest.at,
        value: narrowest.gap,
        message: `A ${narrowest.gap.toFixed(2)} gap in ${label}. A ${minFeature} nozzle will close it up.`
      });
    }

    // ---- sharp inside corners
    let sharpLength = 0;
    let sharpAtPoint = null;
    for (const e of topo.edges) {
      if (e.convex || e.dihedral < sharpAt) continue;
      sharpLength += e.length || 0;
      if (!sharpAtPoint) sharpAtPoint = e.points?.[Math.floor(e.points.length / 2)] || null;
    }
    if (sharpLength > 0) {
      findings.push({
        kind: 'sharpCorner',
        bodyId: id,
        at: sharpAtPoint,
        value: sharpLength,
        message: `${sharpLength.toFixed(1)} of sharp inside corner in ${label}. A fillet there is stronger and easier to cut.`
      });
    }

    // ---- overhangs, and how much of it sits on the plate
    //
    // Per triangle rather than per face, because a face's average normal is
    // no use for this: a sphere is one face and averages to nothing at all,
    // and it is exactly the sphere that is all overhang.
    const stride = mesh.numProp;
    const vp = mesh.vertProperties;
    const tv = mesh.triVerts;
    const height = (x, y, z) => x * up[0] + y * up[1] + z * up[2];

    let lowest = Infinity;
    for (let v = 0; v < vp.length; v += stride) {
      const h = height(vp[v], vp[v + 1], vp[v + 2]);
      if (h < lowest) lowest = h;
    }

    let total = 0;
    let overhangArea = 0;
    let contact = 0;
    const steep = Math.cos(((90 - overhang) * Math.PI) / 180);
    for (let t = 0; t < tv.length; t += 3) {
      const a = tv[t] * stride;
      const b = tv[t + 1] * stride;
      const c = tv[t + 2] * stride;
      const ux = vp[b] - vp[a];
      const uy = vp[b + 1] - vp[a + 1];
      const uz = vp[b + 2] - vp[a + 2];
      const wx = vp[c] - vp[a];
      const wy = vp[c + 1] - vp[a + 1];
      const wz = vp[c + 2] - vp[a + 2];
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      const twice = Math.hypot(nx, ny, nz);
      if (twice < 1e-12) continue;
      const area = twice / 2;
      total += area;
      const down = -height(nx, ny, nz) / twice;
      if (down <= 0) continue;

      const top = Math.max(
        height(vp[a], vp[a + 1], vp[a + 2]),
        height(vp[b], vp[b + 1], vp[b + 2]),
        height(vp[c], vp[c + 1], vp[c + 2])
      );
      // Resting on the plate is not an overhang, it is the part standing on
      // something. Anything else facing down past the angle is.
      if (down > 0.999 && top - lowest < 1e-3) contact += area;
      else if (down > steep) overhangArea += area;
    }

    if (overhangArea > total * 0.02) {
      findings.push({
        kind: 'overhang',
        bodyId: id,
        value: overhangArea,
        message: `${Math.round((100 * overhangArea) / total)} in a hundred of ${label} overhangs past ${overhang} degrees, so it needs support or turning over.`
      });
    }

    if (contact < Math.max(25, total * 0.005)) {
      findings.push({
        kind: 'contact',
        bodyId: id,
        value: contact,
        message: contact
          ? `${label} touches the plate over ${contact.toFixed(1)} square. It will want a brim.`
          : `${label} does not sit flat on anything. It will need support under all of it.`
      });
    }

    // ---- does it fit
    if (opts.bed) {
      const size = meshSize(mesh);
      const bed = opts.bed;
      const fits =
        (size[0] <= bed[0] && size[1] <= bed[1]) || (size[1] <= bed[0] && size[0] <= bed[1]);
      if (!fits || size[2] > bed[2]) {
        findings.push({
          kind: 'bed',
          bodyId: id,
          value: size,
          message: `${label} is ${size.map((n) => n.toFixed(0)).join(' by ')} and the bed is ${bed.join(' by ')}.`
        });
      }
    }
  }

  return findings;
}

/** The box a mesh fills, as three lengths. */
export function meshSize(mesh) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const stride = mesh.numProp;
  for (let i = 0; i < mesh.vertProperties.length; i += stride) {
    for (let d = 0; d < 3; d++) {
      const v = mesh.vertProperties[i + d];
      if (v < lo[d]) lo[d] = v;
      if (v > hi[d]) hi[d] = v;
    }
  }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

/**
 * The loops where two solids' surfaces meet, in world space.
 *
 * Taken from the solid they share: its surface is made partly of one body and
 * partly of the other, and the edges where those two parts meet are exactly the
 * intersection. Which triangle came from which body is something the kernel
 * carries, so this reads the answer off rather than working it out from the
 * geometry, and it is right at a tangency where a geometric approach is not.
 */
export function intersectionRuns(solidA, solidB, scope) {
  const a = K.tagOriginal(K.copy(solidA, scope), 'ixA', scope);
  const b = K.tagOriginal(K.copy(solidB, scope), 'ixB', scope);
  const shared = K.intersection(a, b, scope);
  if (K.isEmpty(shared)) return [];

  const topo = buildTopology(K.meshData(shared));
  // An edge with one body's surface on one side and the other's on the other is
  // on the curve where they cross. Both sides from the same body is just that
  // body's own edge, which was there before they met.
  const runs = [];
  for (const edge of topo.edges) {
    const fa = topo.faces[edge.faceA]?.src?.tag;
    const fb = topo.faces[edge.faceB]?.src?.tag;
    if (!fa || !fb || fa === fb) continue;
    if (edge.points?.length > 1) runs.push(edge.points);
  }
  return runs;
}
