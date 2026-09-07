/**
 * Decals: an image laid on the surface of a part.
 *
 * The difficulty is not the picture, it is the edge of it. A decal covers some
 * triangles whole and cuts across others, and the ones it cuts across are the
 * whole problem: leave them and the image smears out past where it should stop,
 * drop them and it has a ragged edge that follows the triangles rather than the
 * artwork.
 *
 * So the triangles are really cut. Each one is projected into the decal's own
 * flat frame, clipped against the rectangle there, and the pieces are lifted
 * back onto the surface by where they sit inside the original triangle. What
 * comes out is a small mesh that lies on the part, ends exactly where the image
 * ends, and needs nothing of the renderer but an ordinary textured material.
 *
 * Nothing here touches the kernel or the renderer, so a decal can be checked
 * against numbers: how much area it covers, whether it stops at the edge, and
 * whether it wrapped round onto a face it should not have reached.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/**
 * Cut a polygon down to what lies on one side of a line.
 *
 * Sutherland and Hodgman, which is the right tool because the rectangle being
 * cut against is convex: four passes, one per side, and each pass keeps what is
 * inside and puts a new corner wherever an edge crosses.
 */
function clipAgainst(poly, keep) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const inA = keep(a);
    const inB = keep(b);
    if (inA) out.push(a);
    if (inA !== inB) {
      const t = keep.where(a, b);
      out.push(mix(a, b, t));
    }
  }
  return out;
}

/** A corner part way between two, carrying everything each of them holds. */
function mix(a, b, t) {
  return {
    u: a.u + (b.u - a.u) * t,
    v: a.v + (b.v - a.v) * t,
    // The barycentric weights ride along, which is what lets a cut corner be
    // put back on the surface rather than on the flat.
    w: [0, 1, 2].map((i) => a.w[i] + (b.w[i] - a.w[i]) * t)
  };
}

/** The four sides of the rectangle, as tests with the crossing point built in. */
function sidesOf(halfW, halfH) {
  const make = (get, limit, greater) => {
    const test = (p) => (greater ? get(p) >= limit : get(p) <= limit);
    test.where = (a, b) => {
      const da = get(a) - limit;
      const db = get(b) - limit;
      const span = da - db;
      return Math.abs(span) < 1e-12 ? 0 : da / span;
    };
    return test;
  };
  const u = (p) => p.u;
  const v = (p) => p.v;
  return [
    make(u, -halfW, true),
    make(u, halfW, false),
    make(v, -halfH, true),
    make(v, halfH, false)
  ];
}

/**
 * The piece of a mesh a decal lands on, with the image's own coordinates on it.
 *
 * `frame` is where the image is and which way it looks: an origin, two
 * directions across it, and the direction it projects along, which points into
 * the part.
 *
 * Only triangles facing back at the image are taken. Without that a decal put
 * on the front of a part comes out on the back as well, mirrored, which is the
 * first thing anybody notices and the last thing they expect.
 */
export function decalMesh(mesh, frame, opts = {}) {
  const width = Math.max(1e-6, opts.width ?? 40);
  const height = Math.max(1e-6, opts.height ?? 40);
  const lift = opts.offset ?? 0.02;
  const halfW = width / 2;
  const halfH = height / 2;
  const sides = sidesOf(halfW, halfH);

  const stride = mesh.numProp;
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const at = (i) => [vp[i * stride], vp[i * stride + 1], vp[i * stride + 2]];

  const points = [];
  const uvs = [];
  const tris = [];
  let covered = 0;

  for (let t = 0; t < tv.length; t += 3) {
    const P = [at(tv[t]), at(tv[t + 1]), at(tv[t + 2])];
    const nRaw = cross(sub(P[1], P[0]), sub(P[2], P[0]));
    const area = len(nRaw);
    if (area < 1e-12) continue;
    const n = [nRaw[0] / area, nRaw[1] / area, nRaw[2] / area];
    // Facing back at the image, not away from it and not edge on.
    if (dot(n, frame.n) > -1e-6) continue;

    const flat = P.map((p, i) => {
      const d = sub(p, frame.origin);
      return {
        u: dot(d, frame.x),
        v: dot(d, frame.y),
        w: [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]
      };
    });

    let poly = flat;
    for (const side of sides) {
      poly = clipAgainst(poly, side);
      if (poly.length < 3) break;
    }
    if (poly.length < 3) continue;

    const base = points.length;
    for (const c of poly) {
      // Back onto the surface: the weights say where inside the original
      // triangle this corner is, and the surface is where that lands.
      const p = [0, 1, 2].map(
        (k) => P[0][k] * c.w[0] + P[1][k] * c.w[1] + P[2][k] * c.w[2] + n[k] * lift
      );
      points.push(p);
      uvs.push([(c.u + halfW) / width, (c.v + halfH) / height]);
    }
    for (let i = 1; i + 1 < poly.length; i++) {
      tris.push([base, base + i, base + i + 1]);
    }
    covered += polygonArea(poly);
  }

  if (!tris.length) return null;
  return {
    numProp: 3,
    vertProperties: new Float32Array(points.flat()),
    triVerts: new Uint32Array(tris.flat()),
    uv: new Float32Array(uvs.flat()),
    // How much of the image actually landed on something, as a fraction. A
    // decal half off the edge of a part is a real thing to want to know about.
    coverage: covered / (width * height)
  };
}

/** The area a flat polygon encloses, unsigned. */
function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.u * q.v - q.u * p.v;
  }
  return Math.abs(a) / 2;
}
