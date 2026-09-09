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

/* ------------------------------------------------------------------ */
/* Writing a 3MF                                                       */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip with everything stored rather than compressed.
 *
 * Deflating would need a compressor bundled, and there is nothing here worth
 * bundling one for: a 3MF of a printed part is a few hundred kilobytes of XML
 * and the file goes straight into a slicer on the same machine. Stored entries
 * are part of the format, and every reader accepts them.
 */
export function zipStore(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const body = data instanceof Uint8Array ? data : enc.encode(data);
    const crc = crc32(body);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, 0x21, true); // date, 1 Jan 1996, fixed so the file is reproducible
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, body.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    locals.push(local, body);

    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0x21, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, body.length, true);
    dv.setUint32(24, body.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    central.push(dir);

    offset += local.length + body.length;
  }

  const dirSize = central.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);

  const total =
    locals.reduce((n, b) => n + b.length, 0) + dirSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of [...locals, ...central, end]) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** XML text with the five characters that cannot appear raw taken out. */
function xmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A 3MF from a set of meshes.
 *
 * Worth having over an STL for three reasons that all matter to a printed
 * part: it says what unit the numbers are in, so a part never arrives at a
 * twenty-fifth of its size; it keeps the bodies apart and named, so a print
 * with four parts on the plate is still four parts; and it is a tenth the size.
 */
export function to3MF(meshes, names = [], opts = {}) {
  const unit = opts.unit || 'millimeter';
  const objects = [];
  const items = [];

  meshes.forEach((mesh, i) => {
    const stride = mesh.numProp;
    const vp = mesh.vertProperties;
    const tv = mesh.triVerts;
    const verts = [];
    for (let v = 0; v < vp.length; v += stride) {
      verts.push(
        `<vertex x="${trim(vp[v])}" y="${trim(vp[v + 1])}" z="${trim(vp[v + 2])}"/>`
      );
    }
    const tris = [];
    for (let t = 0; t < tv.length; t += 3) {
      tris.push(`<triangle v1="${tv[t]}" v2="${tv[t + 1]}" v3="${tv[t + 2]}"/>`);
    }
    const id = i + 1;
    objects.push(
      `<object id="${id}" type="model" name="${xmlText(names[i] || `Body ${id}`)}">` +
        `<mesh><vertices>${verts.join('')}</vertices>` +
        `<triangles>${tris.join('')}</triangles></mesh></object>`
    );
    items.push(`<item objectid="${id}"/>`);
  });

  const model =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<model unit="${unit}" xml:lang="en-US" ` +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    '<metadata name="Application">Anvil</metadata>' +
    `<resources>${objects.join('')}</resources>` +
    `<build>${items.join('')}</build></model>`;

  const types =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>';

  return zipStore([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: rels },
    { name: '3D/3dmodel.model', data: model }
  ]);
}

/** A number written short: printers do not care past a thousandth. */
function trim(n) {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
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

/* ------------------------------------------------------------------ */
/* More ways in                                                        */
/* ------------------------------------------------------------------ */

/**
 * PLY, in both of its forms.
 *
 * The header is always text and says which. Scanners write PLY more than
 * anything else does, which is why it is worth having: a scan of a part you are
 * fitting something to arrives as a PLY far more often than as an STL.
 */
export function parsePLY(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextDecoder('latin1').decode(buf.subarray(0, Math.min(buf.length, 65536)));
  const endAt = head.indexOf('end_header');
  if (!head.startsWith('ply') || endAt < 0) throw new Error('That is not a PLY file');
  const lines = head.slice(0, endAt).split(/\r?\n/);
  const dataAt = endAt + head.slice(endAt).indexOf('\n') + 1;

  let format = 'ascii';
  const elements = [];
  for (const line of lines) {
    const bits = line.trim().split(/\s+/);
    if (bits[0] === 'format') format = bits[1];
    else if (bits[0] === 'element') elements.push({ name: bits[1], count: Number(bits[2]), props: [] });
    else if (bits[0] === 'property' && elements.length) {
      const e = elements[elements.length - 1];
      if (bits[1] === 'list') e.props.push({ list: true, countType: bits[2], type: bits[3], name: bits[4] });
      else e.props.push({ list: false, type: bits[1], name: bits[2] });
    }
  }

  const verts = [];
  const tris = [];

  if (format === 'ascii') {
    const text = new TextDecoder().decode(buf.subarray(dataAt));
    const rows = text.split(/\r?\n/).filter((l) => l.trim().length);
    let at = 0;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++, at++) {
        const nums = (rows[at] || '').trim().split(/\s+/).map(Number);
        if (el.name === 'vertex') verts.push(nums[0], nums[1], nums[2]);
        else if (el.name === 'face') fanInto(tris, nums.slice(1, 1 + nums[0]));
      }
    }
  } else {
    const little = format !== 'binary_big_endian';
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let at = dataAt;
    const sizeOf = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
    const read = (type) => {
      const n = sizeOf[type] || 4;
      let v = 0;
      if (type === 'float' || type === 'float32') v = view.getFloat32(at, little);
      else if (type === 'double' || type === 'float64') v = view.getFloat64(at, little);
      else if (n === 1) v = view.getUint8(at);
      else if (n === 2) v = view.getUint16(at, little);
      else v = view.getUint32(at, little);
      at += n;
      return v;
    };
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        const row = {};
        let list = null;
        for (const prop of el.props) {
          if (prop.list) {
            const n = read(prop.countType);
            list = [];
            for (let k = 0; k < n; k++) list.push(read(prop.type));
          } else row[prop.name] = read(prop.type);
        }
        if (el.name === 'vertex') verts.push(row.x, row.y, row.z);
        else if (el.name === 'face' && list) fanInto(tris, list);
      }
    }
  }

  if (!tris.length) throw new Error('That PLY has no faces in it');
  return [{ verts, tris }];
}

/** A polygon of any number of corners, as triangles from its first one. */
function fanInto(tris, idx) {
  for (let i = 1; i + 1 < idx.length; i++) tris.push(idx[0], idx[i], idx[i + 1]);
}

/**
 * OFF, which is about as simple as a mesh file gets.
 *
 * Worth reading because it costs twenty lines and because academic and mesh
 * processing tools still hand it out.
 */
export function parseOFF(text) {
  const rows = String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l.length);
  if (!/^(ST|C|N|4|n)*OFF$/i.test(rows[0] || '')) throw new Error('That is not an OFF file');
  const counts = rows[1].split(/\s+/).map(Number);
  const nv = counts[0];
  const nf = counts[1];
  const verts = [];
  const tris = [];
  for (let i = 0; i < nv; i++) {
    const n = rows[2 + i].split(/\s+/).map(Number);
    verts.push(n[0], n[1], n[2]);
  }
  for (let i = 0; i < nf; i++) {
    const n = rows[2 + nv + i].split(/\s+/).map(Number);
    fanInto(tris, n.slice(1, 1 + n[0]));
  }
  if (!tris.length) throw new Error('That OFF has no faces in it');
  return [{ verts, tris }];
}

/**
 * glTF and GLB, as far as the triangles.
 *
 * The format is a scene description with materials, animation and cameras, and
 * none of that is a part. What is taken is the meshes and where the scene puts
 * them, which is what somebody wants when a model they were sent happens to be
 * a GLB rather than an STL.
 */
export async function parseGLTF(bytes, opts = {}) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let json = null;
  let binary = null;

  if (buf.length > 12 && new DataView(buf.buffer, buf.byteOffset).getUint32(0, true) === 0x46546c67) {
    // GLB: a header, then chunks of JSON and of binary.
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let at = 12;
    while (at + 8 <= buf.length) {
      const len = view.getUint32(at, true);
      const kind = view.getUint32(at + 4, true);
      const body = buf.subarray(at + 8, at + 8 + len);
      if (kind === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
      else if (kind === 0x004e4942) binary = body;
      at += 8 + len + ((4 - (len % 4)) % 4);
    }
  } else {
    json = JSON.parse(new TextDecoder().decode(buf));
  }
  if (!json?.meshes?.length) throw new Error('That glTF has no meshes in it');

  // Buffers: the binary chunk, or data URIs. A file that points at another file
  // beside it cannot be followed, since only this one was opened.
  const buffers = (json.buffers || []).map((b, i) => {
    if (!b.uri) return binary;
    const m = /^data:[^;]*;base64,(.*)$/.exec(b.uri);
    if (m) return Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    throw new Error(`That glTF keeps its data in ${b.uri}, which is a separate file`);
  });

  const SIZES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const readAccessor = (index) => {
    const acc = json.accessors[index];
    const viewSpec = json.bufferViews[acc.bufferView];
    const data = buffers[viewSpec.buffer];
    if (!data) throw new Error('That glTF is missing the data its meshes point at');
    const size = SIZES[acc.componentType] * COUNTS[acc.type];
    const stride = viewSpec.byteStride || size;
    const base = (viewSpec.byteOffset || 0) + (acc.byteOffset || 0);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out = [];
    for (let i = 0; i < acc.count; i++) {
      const at = base + i * stride;
      for (let k = 0; k < COUNTS[acc.type]; k++) {
        const o = at + k * SIZES[acc.componentType];
        if (acc.componentType === 5126) out.push(view.getFloat32(o, true));
        else if (acc.componentType === 5125) out.push(view.getUint32(o, true));
        else if (acc.componentType === 5123) out.push(view.getUint16(o, true));
        else if (acc.componentType === 5122) out.push(view.getInt16(o, true));
        else out.push(view.getUint8(o));
      }
    }
    return out;
  };

  const out = [];
  for (const mesh of json.meshes) {
    const verts = [];
    const tris = [];
    for (const prim of mesh.primitives || []) {
      // Mode 4 is triangles. Strips and fans are rare in exported models and
      // are left rather than guessed at.
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      const pos = prim.attributes?.POSITION;
      if (pos === undefined) continue;
      const points = readAccessor(pos);
      const base = verts.length / 3;
      for (const v of points) verts.push(v);
      if (prim.indices !== undefined) {
        for (const i of readAccessor(prim.indices)) tris.push(base + i);
      } else {
        for (let i = 0; i < points.length / 3; i++) tris.push(base + i);
      }
    }
    if (tris.length) out.push({ verts, tris, name: mesh.name || '' });
  }
  if (!out.length) throw new Error('That glTF has no triangles in it');
  if (opts.yUp !== false) {
    // glTF is Y up and everything here is Z up. Turning it on the way in is the
    // difference between a part lying on the bed and one standing on its nose.
    for (const m of out) {
      for (let i = 0; i < m.verts.length; i += 3) {
        const y = m.verts[i + 1];
        m.verts[i + 1] = -m.verts[i + 2];
        m.verts[i + 2] = y;
      }
    }
  }
  return out;
}

/**
 * COLLADA, as far as the triangles.
 *
 * XML, and old, and still what a good deal of scanned and downloaded geometry
 * arrives as.
 */
export function parseDAE(text) {
  const doc = new DOMParser().parseFromString(String(text), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That COLLADA file will not parse');

  const sources = {};
  for (const src of doc.querySelectorAll('source')) {
    const arr = src.querySelector('float_array');
    if (!arr) continue;
    sources[`#${src.getAttribute('id')}`] = arr.textContent.trim().split(/\s+/).map(Number);
  }
  const verticesOf = {};
  for (const v of doc.querySelectorAll('vertices')) {
    const input = v.querySelector('input[semantic="POSITION"]');
    if (input) verticesOf[`#${v.getAttribute('id')}`] = input.getAttribute('source');
  }

  const out = [];
  for (const geom of doc.querySelectorAll('geometry')) {
    const verts = [];
    const tris = [];
    for (const prim of geom.querySelectorAll('triangles, polylist')) {
      const posInput = prim.querySelector('input[semantic="VERTEX"]');
      if (!posInput) continue;
      const via = posInput.getAttribute('source');
      const src = sources[via] || sources[verticesOf[via]];
      if (!src) continue;

      const stride = prim.querySelectorAll('input').length || 1;
      const offset = Number(posInput.getAttribute('offset') || 0);
      const p = prim.querySelector('p');
      if (!p) continue;
      const idx = p.textContent.trim().split(/\s+/).map(Number);

      const base = verts.length / 3;
      for (const n of src) verts.push(n);
      const counts = prim.querySelector('vcount');
      if (counts) {
        // A polylist gives the corner count of each polygon in turn.
        const each = counts.textContent.trim().split(/\s+/).map(Number);
        let at = 0;
        for (const n of each) {
          const corners = [];
          for (let k = 0; k < n; k++) corners.push(base + idx[(at + k) * stride + offset]);
          at += n;
          fanInto(tris, corners);
        }
      } else {
        for (let i = 0; i + 2 < idx.length / stride; i += 3) {
          tris.push(
            base + idx[i * stride + offset],
            base + idx[(i + 1) * stride + offset],
            base + idx[(i + 2) * stride + offset]
          );
        }
      }
    }
    if (tris.length) out.push({ verts, tris, name: geom.getAttribute('name') || '' });
  }
  if (!out.length) throw new Error('That COLLADA file has no triangles in it');
  return out;
}

/** The archive reader, which the Fusion archive needs as much as a 3MF does. */
export { unzip };

/** Which reader a file needs, from its name. */
export function meshReaderFor(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'stl') return 'stl';
  if (ext === 'obj') return 'obj';
  if (ext === '3mf') return '3mf';
  if (ext === 'ply') return 'ply';
  if (ext === 'off') return 'off';
  if (ext === 'gltf' || ext === 'glb') return 'gltf';
  if (ext === 'dae') return 'dae';
  if (ext === 'f3d' || ext === 'f3z') return 'f3d';
  return null;
}

export { DEFAULT_CREASE };
