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

/* ------------------------------------------------------------------ */
/* Reading meshes in                                                   */
/* ------------------------------------------------------------------ */

/**
 * An STL, binary or ASCII.
 *
 * Which one it is has to be sniffed rather than trusted: plenty of binary STLs
 * begin with the word "solid" because whoever wrote them put a name in the
 * header, so the only reliable test is whether the triangle count in the header
 * accounts for the length of the file.
 */
export function parseSTL(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 84) return asciiSTL(textOf(bytes));

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (84 + count * 50 === bytes.length) return binarySTL(view, count);
  return asciiSTL(textOf(bytes));
}

function textOf(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function binarySTL(view, count) {
  const points = new Float32Array(count * 9);
  const tris = new Uint32Array(count * 3);
  let off = 84;
  for (let t = 0; t < count; t++) {
    off += 12; // the stored normal, which is recomputed rather than believed
    for (let k = 0; k < 3; k++) {
      points[t * 9 + k * 3] = view.getFloat32(off, true);
      points[t * 9 + k * 3 + 1] = view.getFloat32(off + 4, true);
      points[t * 9 + k * 3 + 2] = view.getFloat32(off + 8, true);
      off += 12;
    }
    tris[t * 3] = t * 3;
    tris[t * 3 + 1] = t * 3 + 1;
    tris[t * 3 + 2] = t * 3 + 2;
    off += 2; // attribute byte count
  }
  return { numProp: 3, vertProperties: points, triVerts: tris };
}

function asciiSTL(text) {
  const points = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m;
  while ((m = re.exec(text))) {
    points.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const count = Math.floor(points.length / 9);
  const tris = new Uint32Array(count * 3);
  for (let i = 0; i < count * 3; i++) tris[i] = i;
  return {
    numProp: 3,
    vertProperties: new Float32Array(points.slice(0, count * 9)),
    triVerts: tris
  };
}

/**
 * A Wavefront OBJ.
 *
 * Only the geometry: v and f. Normals and texture coordinates are read past,
 * because a face index of the form `3/1/1` still names vertex 3 and that is the
 * only part of it this cares about. Faces with more than three corners are
 * fanned, which is right for the convex polygons an OBJ actually contains.
 */
export function parseOBJ(text) {
  const verts = [];
  const tris = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      verts.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (parts[0] === 'f') {
      const idx = [];
      for (let i = 1; i < parts.length; i++) {
        const n = Number(parts[i].split('/')[0]);
        if (!Number.isFinite(n)) continue;
        // Negative indices count back from the end, which is legal OBJ.
        idx.push(n > 0 ? n - 1 : verts.length / 3 + n);
      }
      for (let i = 1; i + 1 < idx.length; i++) {
        tris.push(idx[0], idx[i], idx[i + 1]);
      }
    }
  }
  return {
    numProp: 3,
    vertProperties: new Float32Array(verts),
    triVerts: new Uint32Array(tris)
  };
}

/**
 * A 3MF, which is a zip of XML.
 *
 * The archive is opened with the browser's own inflate rather than a bundled
 * one: a 3MF's model file is deflated, and `DecompressionStream` is already
 * here. Everything a 3MF carries beyond the mesh, materials, colours, the build
 * transform, is read past.
 */
export async function parse3MF(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const files = await unzip(bytes);
  const key = Object.keys(files).find((n) => /3dmodel\.model$/i.test(n));
  if (!key) throw new Error('That 3MF has no model in it');
  return parse3MFModel(new TextDecoder().decode(files[key]));
}

/** The mesh out of a 3MF's model XML. */
export function parse3MFModel(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That 3MF model is not readable XML');

  const verts = [];
  const tris = [];
  let base = 0;
  // Every mesh in the file, since a 3MF may hold several objects and inserting
  // all of them is what "insert this file" means.
  for (const mesh of doc.getElementsByTagName('mesh')) {
    base = verts.length / 3;
    for (const v of mesh.getElementsByTagName('vertex')) {
      verts.push(
        Number(v.getAttribute('x')),
        Number(v.getAttribute('y')),
        Number(v.getAttribute('z'))
      );
    }
    for (const t of mesh.getElementsByTagName('triangle')) {
      tris.push(
        base + Number(t.getAttribute('v1')),
        base + Number(t.getAttribute('v2')),
        base + Number(t.getAttribute('v3'))
      );
    }
  }
  if (!tris.length) throw new Error('That 3MF has no triangles in it');
  return {
    numProp: 3,
    vertProperties: new Float32Array(verts),
    triVerts: new Uint32Array(tris)
  };
}

/**
 * Read a zip far enough to get the files out of it.
 *
 * Only the two storage methods a 3MF actually uses: stored and deflated. The
 * central directory is walked rather than the local headers, because a local
 * header is allowed to leave the sizes at zero and say so in a trailer.
 */
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record, found by walking back from the end.
  let end = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('That file is not a zip, so it is not a 3MF');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = {};

  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));

    // The local header repeats the name and extra field, and their lengths
    // there are the ones that count.
    const localNameLen = view.getUint16(localAt + 26, true);
    const localExtraLen = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataAt, dataAt + compressed);

    if (method === 0) out[name] = raw;
    else if (method === 8) out[name] = await inflateRaw(raw);

    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Which reader a file needs, from its name. */
export function meshReaderFor(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'stl') return 'stl';
  if (ext === 'obj') return 'obj';
  if (ext === '3mf') return '3mf';
  return null;
}

export { DEFAULT_CREASE };
