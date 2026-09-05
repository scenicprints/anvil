/**
 * Kernel mesh to display mesh.
 *
 * The kernel emits a raw triangle soup with shared vertices. Two things turn
 * that into something that reads as CAD rather than as a game asset: normals
 * averaged only across gently-joined triangles, so cylinders shade smoothly
 * while box corners stay crisp, and a separate line set along the sharp edges,
 * which is what makes a model look drafted instead of faceted.
 */

import * as THREE from './three.js';

const DEFAULT_CREASE = 32; // degrees

/**
 * Build a BufferGeometry with crease-angle normals.
 * Vertices are split wherever the joining angle exceeds the crease threshold.
 */
export function buildGeometry(mesh, creaseDeg = DEFAULT_CREASE) {
  const stride = mesh.numProp;
  const pos = mesh.vertProperties;
  const tris = mesh.triVerts;
  const triCount = tris.length / 3;

  // Face normals and areas.
  const faceNormal = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const i0 = tris[t * 3] * stride;
    const i1 = tris[t * 3 + 1] * stride;
    const i2 = tris[t * 3 + 2] * stride;

    const ax = pos[i1] - pos[i0];
    const ay = pos[i1 + 1] - pos[i0 + 1];
    const az = pos[i1 + 2] - pos[i0 + 2];
    const bx = pos[i2] - pos[i0];
    const by = pos[i2 + 1] - pos[i0 + 1];
    const bz = pos[i2 + 2] - pos[i0 + 2];

    faceNormal[t * 3] = ay * bz - az * by;
    faceNormal[t * 3 + 1] = az * bx - ax * bz;
    faceNormal[t * 3 + 2] = ax * by - ay * bx;
  }

  // Group the triangles touching each vertex.
  const vertCount = pos.length / stride;
  const incidentHead = new Int32Array(vertCount).fill(-1);
  const incidentNext = new Int32Array(triCount * 3).fill(-1);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k];
      const slot = t * 3 + k;
      incidentNext[slot] = incidentHead[v];
      incidentHead[v] = slot;
    }
  }

  const cosLimit = Math.cos((creaseDeg * Math.PI) / 180);

  const outPos = new Float32Array(triCount * 9);
  const outNorm = new Float32Array(triCount * 9);

  const nx = new Float64Array(3);

  for (let t = 0; t < triCount; t++) {
    const fnx = faceNormal[t * 3];
    const fny = faceNormal[t * 3 + 1];
    const fnz = faceNormal[t * 3 + 2];
    // A zero-area triangle has no direction of its own; treat it as flat in Z
    // so it still contributes a valid, if arbitrary, normal.
    const rawLen = Math.hypot(fnx, fny, fnz);
    const degenerate = rawLen < 1e-12;
    const flen = degenerate ? 1 : rawLen;
    const ux = degenerate ? 0 : fnx / flen;
    const uy = degenerate ? 0 : fny / flen;
    const uz = degenerate ? 1 : fnz / flen;

    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k];
      // Average the neighbours that sit within the crease angle. Areas are
      // baked into the unnormalised face normals, weighting large faces more.
      nx[0] = 0;
      nx[1] = 0;
      nx[2] = 0;
      for (let slot = incidentHead[v]; slot !== -1; slot = incidentNext[slot]) {
        const ot = (slot / 3) | 0;
        let ox = faceNormal[ot * 3];
        let oy = faceNormal[ot * 3 + 1];
        let oz = faceNormal[ot * 3 + 2];
        const olen = Math.hypot(ox, oy, oz) || 1;
        const dot = (ox / olen) * ux + (oy / olen) * uy + (oz / olen) * uz;
        if (dot >= cosLimit) {
          nx[0] += ox;
          nx[1] += oy;
          nx[2] += oz;
        }
      }
      let len = Math.hypot(nx[0], nx[1], nx[2]);
      if (len < 1e-12) {
        // Fall back to this triangle's own normal. A zero normal renders as a
        // black hole in the surface, which reads as a modelling error that is
        // not actually there.
        nx[0] = ux;
        nx[1] = uy;
        nx[2] = uz;
        len = 1;
      }

      const o = t * 9 + k * 3;
      const src = v * stride;
      outPos[o] = pos[src];
      outPos[o + 1] = pos[src + 1];
      outPos[o + 2] = pos[src + 2];
      outNorm[o] = nx[0] / len;
      outNorm[o + 1] = nx[1] / len;
      outNorm[o + 2] = nx[2] / len;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(outNorm, 3));
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  return geom;
}

/**
 * Line segments along edges where two faces meet at more than `angleDeg`,
 * plus every boundary edge. This is the model's visible outline.
 */
export function buildEdges(mesh, angleDeg = 24) {
  const stride = mesh.numProp;
  const pos = mesh.vertProperties;
  const tris = mesh.triVerts;
  const triCount = tris.length / 3;

  // Weld positions so edges shared by separately-indexed verts still pair up.
  const weld = new Int32Array(pos.length / stride);
  const map = new Map();
  for (let v = 0; v < weld.length; v++) {
    const b = v * stride;
    const key = `${Math.round(pos[b] * 1e5)},${Math.round(pos[b + 1] * 1e5)},${Math.round(
      pos[b + 2] * 1e5
    )}`;
    let id = map.get(key);
    if (id === undefined) {
      id = v;
      map.set(key, id);
    }
    weld[v] = id;
  }

  const faceNormal = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const i0 = tris[t * 3] * stride;
    const i1 = tris[t * 3 + 1] * stride;
    const i2 = tris[t * 3 + 2] * stride;
    const ax = pos[i1] - pos[i0];
    const ay = pos[i1 + 1] - pos[i0 + 1];
    const az = pos[i1 + 2] - pos[i0 + 2];
    const bx = pos[i2] - pos[i0];
    const by = pos[i2 + 1] - pos[i0 + 1];
    const bz = pos[i2 + 2] - pos[i0 + 2];
    let x = ay * bz - az * by;
    let y = az * bx - ax * bz;
    let z = ax * by - ay * bx;
    const l = Math.hypot(x, y, z) || 1;
    faceNormal[t * 3] = x / l;
    faceNormal[t * 3 + 1] = y / l;
    faceNormal[t * 3 + 2] = z / l;
  }

  const edges = new Map();
  const addEdge = (a, b, t) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * 4294967296 + hi;
    const rec = edges.get(key);
    if (rec) rec.push(t);
    else edges.set(key, [t]);
  };

  for (let t = 0; t < triCount; t++) {
    const a = weld[tris[t * 3]];
    const b = weld[tris[t * 3 + 1]];
    const c = weld[tris[t * 3 + 2]];
    addEdge(a, b, t);
    addEdge(b, c, t);
    addEdge(c, a, t);
  }

  const cosLimit = Math.cos((angleDeg * Math.PI) / 180);
  const verts = [];

  for (const [key, faces] of edges) {
    const hi = key % 4294967296;
    const lo = (key - hi) / 4294967296;
    let sharp = false;
    if (faces.length === 1) {
      sharp = true;
    } else {
      for (let i = 1; i < faces.length && !sharp; i++) {
        const t0 = faces[0] * 3;
        const t1 = faces[i] * 3;
        const dot =
          faceNormal[t0] * faceNormal[t1] +
          faceNormal[t0 + 1] * faceNormal[t1 + 1] +
          faceNormal[t0 + 2] * faceNormal[t1 + 2];
        if (dot < cosLimit) sharp = true;
      }
    }
    if (!sharp) continue;
    const ib = lo * stride;
    const jb = hi * stride;
    verts.push(pos[ib], pos[ib + 1], pos[ib + 2], pos[jb], pos[jb + 1], pos[jb + 2]);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return geom;
}

/** Binary STL. Units are millimetres, which is what every slicer assumes. */
export function toBinarySTL(meshes) {
  let triTotal = 0;
  for (const m of meshes) triTotal += m.triVerts.length / 3;

  const buf = new ArrayBuffer(84 + triTotal * 50);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const header = 'Exported by Anvil';
  for (let i = 0; i < header.length && i < 80; i++) bytes[i] = header.charCodeAt(i);
  view.setUint32(80, triTotal, true);

  let off = 84;
  for (const m of meshes) {
    const stride = m.numProp;
    const pos = m.vertProperties;
    const tris = m.triVerts;
    for (let t = 0; t < tris.length / 3; t++) {
      const i0 = tris[t * 3] * stride;
      const i1 = tris[t * 3 + 1] * stride;
      const i2 = tris[t * 3 + 2] * stride;

      const ax = pos[i1] - pos[i0];
      const ay = pos[i1 + 1] - pos[i0 + 1];
      const az = pos[i1 + 2] - pos[i0 + 2];
      const bx = pos[i2] - pos[i0];
      const by = pos[i2 + 1] - pos[i0 + 1];
      const bz = pos[i2 + 2] - pos[i0 + 2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1;

      view.setFloat32(off, nx / l, true);
      view.setFloat32(off + 4, ny / l, true);
      view.setFloat32(off + 8, nz / l, true);
      off += 12;

      for (const base of [i0, i1, i2]) {
        view.setFloat32(off, pos[base], true);
        view.setFloat32(off + 4, pos[base + 1], true);
        view.setFloat32(off + 8, pos[base + 2], true);
        off += 12;
      }
      view.setUint16(off, 0, true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}

/** Wavefront OBJ, for when something downstream will not read STL. */
export function toOBJ(meshes, names = []) {
  const lines = ['# Exported by Anvil', '# Units: millimetres'];
  let base = 1;
  meshes.forEach((m, idx) => {
    const stride = m.numProp;
    const pos = m.vertProperties;
    const tris = m.triVerts;
    lines.push(`o ${names[idx] || `Body${idx + 1}`}`);
    const vcount = pos.length / stride;
    for (let v = 0; v < vcount; v++) {
      const b = v * stride;
      lines.push(`v ${pos[b].toFixed(6)} ${pos[b + 1].toFixed(6)} ${pos[b + 2].toFixed(6)}`);
    }
    for (let t = 0; t < tris.length / 3; t++) {
      lines.push(
        `f ${tris[t * 3] + base} ${tris[t * 3 + 1] + base} ${tris[t * 3 + 2] + base}`
      );
    }
    base += vcount;
  });
  return lines.join('\n');
}

export { DEFAULT_CREASE };
