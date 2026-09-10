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



/*
 * What each material is actually like, as numbers a renderer understands.
 *
 * Metalness is not a dial between plastic and metal: it is a switch, and half
 * of it is not a thing that exists. What separates brushed aluminium from
 * polished steel is roughness, and what separates a printed part from a moulded
 * one is roughness too. So the metals differ from each other only in how rough
 * they are, and the plastics carry a clear coat instead, which is the thin shiny
 * layer over a diffuse colour that a moulded or painted part actually has.
 */
export const RENDER_FINISH = {
  aluminium: { metalness: 1, roughness: 0.34 },
  steel: { metalness: 1, roughness: 0.28 },
  stainless: { metalness: 1, roughness: 0.2 },
  brass: { metalness: 1, roughness: 0.26 },
  titanium: { metalness: 1, roughness: 0.42 },
  // A printed part is matt and slightly rough whatever it is made of: the layer
  // lines scatter far more light than the polymer does.
  pla: { metalness: 0, roughness: 0.62, clearcoat: 0.15, clearcoatRoughness: 0.5 },
  petg: { metalness: 0, roughness: 0.42, clearcoat: 0.4, clearcoatRoughness: 0.3 },
  abs: { metalness: 0, roughness: 0.58, clearcoat: 0.2, clearcoatRoughness: 0.45 },
  nylon: { metalness: 0, roughness: 0.7, clearcoat: 0.05, clearcoatRoughness: 0.6 },
  // ABS with the gloss taken off it, which is what ASA is for: it goes outside
  // and it is meant not to shine.
  asa: { metalness: 0, roughness: 0.72, clearcoat: 0.1, clearcoatRoughness: 0.6 },
  // Rubber. No coat at all and rough enough to kill a highlight, because the
  // one thing everybody knows about a flexible part is that it is not shiny.
  tpu: { metalness: 0, roughness: 0.85 },
  // Polycarbonate is the glassy one: hard, clear, and it holds a reflection.
  pc: { metalness: 0, roughness: 0.15, clearcoat: 0.9, clearcoatRoughness: 0.08 },
  // Wood is matt and has no coat. Roughness alone got it as far as a pale matt
  // solid; the grain is what makes it oak, and it is named here rather than
  // switched on somewhere else so that everything a material is stays in one
  // place.
  oak: { metalness: 0, roughness: 0.78, grain: { wood: 'oak' } },
  // Resin comes off the printer glossy, which is most of why it photographs
  // better than filament does.
  resin: { metalness: 0, roughness: 0.18, clearcoat: 0.8, clearcoatRoughness: 0.1 }
};

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
 * Every place a ray meets a mesh, in order along it.
 *
 * The thickness sweep only wants the first one, but anything that has to know
 * what is solid and what is air along a line wants all of them: crossings
 * alternate in and out, which is the whole of how a point is told to be inside
 * a closed body.
 */
export function rayHits(mesh) {
  const cast = rayCasterAll(mesh);
  return cast;
}

function rayCasterAll(mesh) {
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
    const out = [];
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
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (hit > 1e-9) out.push(hit);
    }
    out.sort((a, b) => a - b);
    return out;
  };
}

/**
 * The outline a shape sweeps out when it is spun about an axis.
 *
 * A bolt head spun about its own shank is a cylinder as wide as the corners of
 * its flats, and that number is what decides whether a socket clears it. The
 * same reading is what a lathe would have to cut to make the part, which is
 * where the command comes from.
 *
 * It has to be measured against the material rather than against the corners.
 * A hexagon's vertices are all at one radius, so a profile taken from the
 * points alone reports a hollow tube where there is a solid bar. So the reading
 * is taken by firing rays out from the axis: crossings alternate in and out, and
 * what they give at each station is the run of radii that actually hold
 * material. The outer edge is the furthest of them and the inner edge is where
 * the material starts, which is zero wherever the axis runs through solid.
 *
 * Points come back in the axis's own frame, the first number along it and the
 * second out from it. Nothing here knows about a sketch plane.
 */
export function spunProfile(mesh, axis, opts = {}) {
  const stations = Math.max(8, Math.min(512, opts.stations || 64));
  const spokes = Math.max(3, Math.min(64, opts.spokes || 12));
  const origin = axis.origin || [0, 0, 0];
  const dir = unit3(axis.dir || [0, 0, 1]);
  const vp = mesh.vertProperties;
  const stride = mesh.numProp;
  if (!vp?.length) return null;

  let lo = Infinity;
  let hi = -Infinity;
  let reach = 0;
  for (let v = 0; v < vp.length; v += stride) {
    const dx = vp[v] - origin[0];
    const dy = vp[v + 1] - origin[1];
    const dz = vp[v + 2] - origin[2];
    const t = dx * dir[0] + dy * dir[1] + dz * dir[2];
    if (t < lo) lo = t;
    if (t > hi) hi = t;
    const r = Math.hypot(dx - dir[0] * t, dy - dir[1] * t, dz - dir[2] * t);
    if (r > reach) reach = r;
  }
  if (!(hi > lo)) return null;

  const frame = basis3(dir);
  const cast = rayCasterAll(mesh);
  const span = hi - lo;
  const outer = [];
  const inner = [];

  for (let i = 0; i < stations; i++) {
    // Just inside each end rather than exactly on it: a ray fired along the
    // plane of the end cap grazes it and counts crossings nobody agrees about.
    const at = lo + (span * (i + 0.5)) / stations;
    const ox = origin[0] + dir[0] * at;
    const oy = origin[1] + dir[1] * at;
    const oz = origin[2] + dir[2] * at;

    let far = 0;
    let near = Infinity;
    for (let k = 0; k < spokes; k++) {
      const a = (2 * Math.PI * k) / spokes;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const ux = frame.x[0] * ca + frame.y[0] * sa;
      const uy = frame.x[1] * ca + frame.y[1] * sa;
      const uz = frame.x[2] * ca + frame.y[2] * sa;
      const hits = cast(ox, oy, oz, ux, uy, uz);
      if (!hits.length) continue;
      if (hits[hits.length - 1] > far) far = hits[hits.length - 1];
      // An odd number of crossings ahead means this spoke started in the
      // material, so the material reaches the axis here.
      const first = hits.length % 2 === 1 ? 0 : hits[0];
      if (first < near) near = first;
    }
    if (far <= 0) continue;
    outer.push([at, far]);
    inner.push([at, Number.isFinite(near) ? near : 0]);
  }

  if (outer.length < 2) return null;
  outer[0] = [lo, outer[0][1]];
  outer[outer.length - 1] = [hi, outer[outer.length - 1][1]];
  inner[0] = [lo, inner[0][1]];
  inner[inner.length - 1] = [hi, inner[inner.length - 1][1]];

  const bore = Math.min(...inner.map((p) => p[1]));
  const hollow = bore > Math.max(1e-6, reach * 1e-3);
  return {
    outer,
    inner: hollow ? inner : null,
    loop: hollow
      ? [...outer, ...inner.slice().reverse()]
      : [[lo, 0], ...outer, [hi, 0]],
    hollow,
    length: span,
    maxRadius: Math.max(...outer.map((p) => p[1])),
    minRadius: hollow ? bore : 0
  };
}

function unit3(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
}

/** Two directions square to an axis and to each other. */
function basis3(n) {
  const seed = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = unit3([
    n[1] * seed[2] - n[2] * seed[1],
    n[2] * seed[0] - n[0] * seed[2],
    n[0] * seed[1] - n[1] * seed[0]
  ]);
  const y = [
    n[1] * x[2] - n[2] * x[1],
    n[2] * x[0] - n[0] * x[2],
    n[0] * x[1] - n[1] * x[0]
  ];
  return { x, y };
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

/* ------------------------------------------------------------------ */
/* Surface continuity                                                  */
/* ------------------------------------------------------------------ */

/**
 * How smoothly two faces meet along the edge between them.
 *
 * The three degrees everybody in surfacing talks about and nobody can see by
 * looking. G0 is touching: the two faces share the edge and there is no gap. G1
 * is tangent: they leave the edge in the same direction, so there is no crease.
 * G2 is curvature continuous: they leave it curving by the same amount, so
 * there is no band of different shading either.
 *
 * The difference between G1 and G2 is the difference between a joint you can
 * find with a fingernail and one you can only find with a reflection, which is
 * why zebra exists and why this exists beside it: zebra shows you there is
 * something wrong, and this says by how much.
 *
 * Measured per point along the edge and reported at its worst, because a blend
 * that is perfect for most of its length and creased at one end is a creased
 * blend.
 */
export function surfaceContinuity(mesh, topo, edges) {
  const P = pointsOf(mesh);
  const tris = trisOf(mesh);
  const normals = triNormals(P, tris);

  // Which triangles of each face touch each vertex, so a normal can be taken
  // on one side of the edge without the other side's triangles pulling it
  // round. A normal averaged across the crease is a normal that says there is
  // no crease.
  const atVertex = new Map();
  tris.forEach((t, i) => {
    const face = topo.triFace[i];
    for (const v of t) {
      const key = `${face}_${v}`;
      const rec = atVertex.get(key) || { n: [0, 0, 0], round: [], facets: [] };
      rec.n = add3(rec.n, normals[i]);
      rec.facets.push(normals[i]);
      for (const w of t) if (w !== v) rec.round.push(w);
      atVertex.set(key, rec);
    }
  });

  const out = [];
  for (const edge of edges) {
    if (edge.faceA === undefined || edge.faceB === undefined || edge.faceB < 0) continue;
    let worstAngle = 0;
    let worstCurve = 0;
    let worstGap = 0;
    let samples = 0;

    for (const v of edge.verts || []) {
      const a = atVertex.get(`${edge.faceA}_${v}`);
      const b = atVertex.get(`${edge.faceB}_${v}`);
      if (!a || !b) continue;
      const nA = norm3(a.n);
      const nB = norm3(b.n);
      if (!nA || !nB) continue;
      samples++;

      /*
       * How far the two faces turn as they cross the edge, less how far each
       * of them turns within itself.
       *
       * The subtraction is the whole measurement and not a fudge. A body here
       * is triangles, so a curved face is already a series of small steps: a 6
       * mm fillet drawn in forty facets steps two and a quarter degrees every
       * facet, and a tangent join reads as two and a quarter degrees of crease
       * unless that is accounted for. Which would put the floor of this
       * reading an order of magnitude above the thing it exists to find.
       *
       * So what is reported is the step across the edge measured against the
       * steps along each face beside it. A crease is a step that stands out
       * from its neighbours; a tangent join is one that does not.
       */
      const dot = Math.max(-1, Math.min(1, nA[0] * nB[0] + nA[1] * nB[1] + nA[2] * nB[2]));
      const across = (Math.acos(dot) * 180) / Math.PI;
      const floor = Math.max(spread(a.facets), spread(b.facets));
      worstAngle = Math.max(worstAngle, Math.max(0, across - floor));

      // How hard each side is curving away from the edge, from the neighbours
      // it has on its own side. Two sides that curve the same amount meet
      // without a band of different shading; two that do not, do not.
      const kA = normalCurvature(P, v, a.round, nA);
      const kB = normalCurvature(P, v, b.round, nB);
      if (kA !== null && kB !== null) {
        const scale = Math.max(Math.abs(kA), Math.abs(kB), 1e-9);
        worstCurve = Math.max(worstCurve, Math.abs(kA - kB) / scale);
      }
    }
    if (!samples) continue;

    /*
     * The verdict, in the order the degrees are actually reached.
     *
     * The thresholds are the ones surfacing uses in practice rather than
     * anything exact: a tenth of a degree is below what any process can hold,
     * and five per cent of curvature is below what a reflection shows.
     */
    const verdict =
      worstAngle > 0.1
        ? worstAngle > 15
          ? 'G0, and it is a corner'
          : 'G0, touching but creased'
        : worstCurve > 0.05
          ? 'G1, tangent but the curvature steps'
          : 'G2, curvature continuous';

    out.push({
      edge: edge.id,
      angle: worstAngle,
      curvature: worstCurve,
      gap: worstGap,
      points: samples,
      verdict
    });
  }
  return out;
}

/**
 * The widest turn between any two facets of one face at one point.
 *
 * The noise floor of a reading taken on triangles: nothing smaller than this
 * can be told apart from the tessellation itself.
 */
function spread(facets) {
  let worst = 0;
  for (let i = 0; i < facets.length; i++) {
    const a = norm3(facets[i]);
    if (!a) continue;
    for (let j = i + 1; j < facets.length; j++) {
      const b = norm3(facets[j]);
      if (!b) continue;
      const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
      worst = Math.max(worst, (Math.acos(d) * 180) / Math.PI);
    }
  }
  return worst;
}

/** How sharply a surface bends away from a point, along its own neighbours. */
function normalCurvature(P, v, round, n) {
  let worst = null;
  for (const w of round) {
    const d = sub3(P[w], P[v]);
    const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    if (l2 < 1e-12) continue;
    // The standard estimate: twice the height of a neighbour above the tangent
    // plane, over the square of how far away it is.
    const k = (2 * (d[0] * n[0] + d[1] * n[1] + d[2] * n[2])) / l2;
    if (worst === null || Math.abs(k) > Math.abs(worst)) worst = k;
  }
  return worst;
}

/* ------------------------------------------------------------------ */
/* Isocurves                                                           */
/* ------------------------------------------------------------------ */

/**
 * Lines drawn across a face, for reading its shape.
 *
 * On a surface built from curves there is a real u and v to follow and those
 * are the lines. On anything else, and on every face of a solid, there is no
 * parameterisation at all: the face is triangles, and triangles have no idea
 * which way is along.
 *
 * So the fallback is contours in the face's own frame, which is not the same
 * thing and is honest about being a stand-in. What it is for is the same
 * either way: evenly spaced lines bunch up where a surface is tight and spread
 * where it is slack, and a line that wobbles is a surface that wobbles.
 */
export function isoLines(mesh, face, count = 8) {
  const P = pointsOf(mesh);
  const tris = trisOf(mesh);
  const members = face.tris.map((t) => tris[t]);
  if (!members.length) return [];

  // The frame to run the contours in: the face's own normal, and the longest
  // direction across it for the first axis.
  const n = norm3(face.normal) || [0, 0, 1];
  const seen = [...new Set(members.flat())];
  const centre = seen.reduce((acc, v) => add3(acc, P[v]), [0, 0, 0]).map((c) => c / seen.length);
  let u = null;
  let far = 0;
  for (const v of seen) {
    const d = sub3(P[v], centre);
    const flat = sub3(d, mul3(n, d[0] * n[0] + d[1] * n[1] + d[2] * n[2]));
    const l = Math.hypot(flat[0], flat[1], flat[2]);
    if (l > far) {
      far = l;
      u = norm3(flat);
    }
  }
  if (!u) return [];
  const w = norm3(cross3(n, u)) || [0, 1, 0];

  const runs = [];
  for (const axis of [u, w]) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of seen) {
      const t = dot3(sub3(P[v], centre), axis);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    if (!(hi > lo + 1e-9)) continue;
    for (let i = 1; i < count; i++) {
      const at = lo + ((hi - lo) * i) / count;
      const segs = [];
      for (const t of members) {
        const seg = sliceTriangle(P, t, centre, axis, at);
        if (seg) segs.push(seg);
      }
      if (segs.length) runs.push(...joinSegments(segs));
    }
  }
  return runs;
}

/** Where a plane crosses one triangle, as a segment. */
function sliceTriangle(P, t, origin, axis, at) {
  const d = t.map((v) => dot3(sub3(P[v], origin), axis) - at);
  const hits = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    if ((d[i] > 0 && d[j] < 0) || (d[i] < 0 && d[j] > 0)) {
      const f = d[i] / (d[i] - d[j]);
      hits.push(add3(P[t[i]], mul3(sub3(P[t[j]], P[t[i]]), f)));
    } else if (Math.abs(d[i]) < 1e-12) {
      hits.push(P[t[i]].slice());
    }
  }
  return hits.length >= 2 ? [hits[0], hits[1]] : null;
}

/** Loose segments walked into runs, so a contour draws as one line. */
function joinSegments(segs) {
  const key = (p) => `${p[0].toFixed(4)}_${p[1].toFixed(4)}_${p[2].toFixed(4)}`;
  const left = segs.slice();
  const runs = [];
  while (left.length) {
    const run = left.pop();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = left.length - 1; i >= 0; i--) {
        const seg = left[i];
        if (key(seg[0]) === key(run[run.length - 1])) run.push(seg[1]);
        else if (key(seg[1]) === key(run[run.length - 1])) run.push(seg[0]);
        else if (key(seg[1]) === key(run[0])) run.unshift(seg[0]);
        else if (key(seg[0]) === key(run[0])) run.unshift(seg[1]);
        else continue;
        left.splice(i, 1);
        grew = true;
      }
    }
    if (run.length > 1) runs.push(run);
  }
  return runs;
}

/* ------------------------------------------------------------------ */
/* Validate                                                            */
/* ------------------------------------------------------------------ */

/**
 * What is wrong with a body, said plainly.
 *
 * Not a proof that it is right. A kernel that will boolean a shape at all has
 * already settled the questions a validity check exists to ask in most
 * packages, so what is worth reporting here is different: the things that build
 * cleanly and then go wrong later, at the slicer or on the bed.
 *
 * A sliver face is the one that costs. It survives every check, exports fine,
 * and comes out of a slicer as a wall a nozzle cannot lay down.
 */
export function validateBodies(entries) {
  const out = [];
  for (const entry of entries) {
    const { name, mesh, topo, solid, sheet } = entry;
    const notes = [];
    const size = topo?.extent || 1;

    if (sheet) {
      const rim = (topo?.edges || []).filter((e) => e.boundary).length;
      // Not a fault. A surface is open by nature, and saying so is the useful
      // part: a surface cannot be printed until it is thickened or stitched.
      notes.push({
        level: 'note',
        text: rim
          ? `An open surface with ${rim} edge${rim === 1 ? '' : 's'} of rim. It has no inside, so it cannot be printed until it is thickened or stitched.`
          : 'A closed surface. Stitch turns it into a solid.'
      });
    } else if (solid) {
      const props = solid.volume ? { volume: solid.volume(), area: solid.surfaceArea?.() } : null;
      if (props && !(props.volume > 0)) {
        notes.push({ level: 'bad', text: 'No volume at all: this is not a solid.' });
      }
      if (topo?.open) {
        notes.push({
          level: 'bad',
          text: 'The shell is not closed. Exporting this gives a mesh a slicer will argue with.'
        });
      }
    }

    // Faces so small nothing downstream can hold them: a wall thinner than a
    // nozzle, a facet smaller than a slicer's tolerance.
    const tiny = (topo?.faces || []).filter((f) => f.area > 0 && f.area < size * size * 1e-6);
    if (tiny.length) {
      notes.push({
        level: 'warn',
        text: `${tiny.length} face${tiny.length === 1 ? '' : 's'} smaller than a thousandth of the part across. These survive every check and come out of a slicer as walls a nozzle cannot lay down.`
      });
    }

    // Edges shorter than the tolerance anything downstream works to.
    const short = (topo?.edges || []).filter((e) => {
      const pts = e.points || [];
      if (pts.length < 2) return false;
      let len = 0;
      for (let i = 1; i < pts.length; i++) {
        len += Math.hypot(
          pts[i][0] - pts[i - 1][0],
          pts[i][1] - pts[i - 1][1],
          pts[i][2] - pts[i - 1][2]
        );
      }
      return len < size * 1e-5;
    });
    if (short.length) {
      notes.push({
        level: 'warn',
        text: `${short.length} edge${short.length === 1 ? '' : 's'} shorter than a hundred-thousandth of the part. Usually the leftovers of a boolean that nearly missed.`
      });
    }

    const degenerate = countDegenerate(mesh);
    if (degenerate) {
      notes.push({
        level: 'warn',
        text: `${degenerate} triangle${degenerate === 1 ? '' : 's'} with no area. Harmless here and rejected by some other packages.`
      });
    }

    if (!notes.length) notes.push({ level: 'ok', text: 'Nothing to report.' });
    out.push({ name, notes });
  }
  return out;
}

function countDegenerate(mesh) {
  if (!mesh?.triVerts) return 0;
  const P = pointsOf(mesh);
  let n = 0;
  for (let i = 0; i < mesh.triVerts.length; i += 3) {
    const a = P[mesh.triVerts[i]];
    const b = P[mesh.triVerts[i + 1]];
    const c = P[mesh.triVerts[i + 2]];
    const u = sub3(b, a);
    const v = sub3(c, a);
    const x = cross3(u, v);
    if (Math.hypot(x[0], x[1], x[2]) < 1e-12) n++;
  }
  return n;
}

/* ---------------------------------------------------------- small helpers */

function pointsOf(mesh) {
  const stride = mesh.numProp;
  const out = [];
  for (let i = 0; i < mesh.vertProperties.length; i += stride) {
    out.push([mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]]);
  }
  return out;
}

function trisOf(mesh) {
  const out = [];
  for (let i = 0; i < mesh.triVerts.length; i += 3) {
    out.push([mesh.triVerts[i], mesh.triVerts[i + 1], mesh.triVerts[i + 2]]);
  }
  return out;
}

function triNormals(P, tris) {
  return tris.map(([a, b, c]) => {
    const x = cross3(sub3(P[b], P[a]), sub3(P[c], P[a]));
    // Area weighted on purpose: a sliver triangle should not swing the normal
    // at a vertex as far as the big one beside it.
    return x;
  });
}

const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
function norm3(a) {
  if (!a) return null;
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
}
