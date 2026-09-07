/**
 * Stress analysis: what happens to a part when it is pushed.
 *
 * This is a real finite element solver, not a rule of thumb. It cuts the body
 * into a grid of little cubes, works out how each one resists being deformed,
 * and solves for the deflection of the whole thing under the loads given.
 *
 * Three decisions shape all of it, and each one is a trade made on purpose.
 *
 * **A regular grid of cubes, not a tetrahedral mesh.** Meshing an arbitrary
 * solid with tetrahedra that are all well shaped is a research problem, and one
 * badly shaped element poisons the answer everywhere. A grid cannot tangle,
 * cannot invert, and cannot produce a sliver. The price is a stair-stepped
 * boundary, and the answer to that is a finer grid rather than a cleverer
 * mesher.
 *
 * **Every element is the same cube, so its stiffness is worked out once.** That
 * is what makes this fast enough to run in a window: the 24 by 24 matrix that
 * says how one element resists deformation is computed a single time and used
 * for every element in the part.
 *
 * **The global system is never assembled.** A part of any size has hundreds of
 * thousands of unknowns and storing that matrix would be hopeless. Conjugate
 * gradients only ever needs the matrix times a vector, and that can be done one
 * element at a time out of the one stiffness matrix above.
 *
 * What to know about the answer. Trilinear cubes are too stiff in bending: a
 * beam solved this way deflects less than the real one, and the finer the grid
 * the closer it gets. So a single run is not a number to design to. Two runs at
 * different resolutions are: when the answer stops moving, it is the answer.
 * Everything here reports the resolution it used so that comparison can be made.
 */

/**
 * Stiffness and squashability, for the materials the density table already
 * knows about.
 *
 * Young's modulus in megapascals, which is newtons per square millimetre, so
 * everything here is in millimetres and newtons and nothing has to be scaled.
 * Yield is what the part is compared against to say whether it survived.
 *
 * The printed materials are the ones that matter here, and their numbers are
 * for a solid printed part along the layers. Across the layers a printed part
 * is weaker, sometimes by half, and no solver that treats the material as the
 * same in all directions will tell you that. It is said here instead.
 */
export const STIFFNESS = {
  pla: { modulus: 3500, poisson: 0.36, yield: 50 },
  petg: { modulus: 2100, poisson: 0.4, yield: 47 },
  abs: { modulus: 2200, poisson: 0.35, yield: 40 },
  asa: { modulus: 2200, poisson: 0.35, yield: 44 },
  tpu: { modulus: 30, poisson: 0.48, yield: 8 },
  nylon: { modulus: 1700, poisson: 0.39, yield: 45 },
  pc: { modulus: 2300, poisson: 0.37, yield: 62 },
  resin: { modulus: 2600, poisson: 0.35, yield: 55 },
  aluminium: { modulus: 69000, poisson: 0.33, yield: 240 },
  steel: { modulus: 200000, poisson: 0.29, yield: 250 },
  stainless: { modulus: 193000, poisson: 0.3, yield: 215 },
  brass: { modulus: 100000, poisson: 0.34, yield: 200 },
  titanium: { modulus: 114000, poisson: 0.34, yield: 830 },
  oak: { modulus: 11000, poisson: 0.35, yield: 40 }
};

export function stiffnessOf(name) {
  return STIFFNESS[name] || STIFFNESS.pla;
}

/* ------------------------------------------------------------------ */
/* Cutting the body into cubes                                         */
/* ------------------------------------------------------------------ */

/**
 * Which cubes of a regular grid are inside the body.
 *
 * By scanline rather than by testing every cube. One ray is fired along X for
 * each row of the grid, all its crossings with the surface are collected, and
 * every cube in that row is then classified by where it falls between them.
 * That turns a test per cube into a test per row, which for a grid twenty
 * across is twenty times less work, and it is exact rather than approximate:
 * crossings alternate in and out, which is the whole of what inside means for a
 * closed surface.
 */
export function voxelise(mesh, opts = {}) {
  const stride = mesh.numProp;
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  if (!vp?.length || !tv?.length) return null;

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vp.length; i += stride) {
    for (let d = 0; d < 3; d++) {
      if (vp[i + d] < lo[d]) lo[d] = vp[i + d];
      if (vp[i + d] > hi[d]) hi[d] = vp[i + d];
    }
  }
  const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const longest = Math.max(...span);
  if (!(longest > 0)) return null;

  // Sized by the thinnest direction, not the longest.
  //
  // This is the decision that decides whether the answer means anything. A cube
  // chosen to divide the long side neatly will not divide the short one, and a
  // 10 millimetre section then comes out 12.5 because that is where the cell
  // boundaries fell. Stiffness in bending goes as the thickness cubed, so a
  // section a quarter too fat is two and a half times too stiff, and the answer
  // is wrong by that much while looking perfectly reasonable.
  //
  // Sized by the thin direction the section is right, and the long direction
  // simply gets more cells, which costs time and costs no accuracy.
  const thinnest = Math.min(...span.filter((v) => v > 1e-9));
  let h;
  if (opts.size > 0) h = opts.size;
  else if (opts.through > 0) h = thinnest / Math.max(1, Math.round(opts.through));
  else h = longest / Math.max(2, Math.min(120, Math.round(opts.across || 20)));

  // A grid nobody can wait for is worse than a coarse one, so there is a
  // ceiling and it is said out loud rather than silently applied.
  const cells = (span[0] / h + 1) * (span[1] / h + 1) * (span[2] / h + 1);
  const ceiling = opts.most || 500000;
  let capped = false;
  if (cells > ceiling) {
    h *= Math.cbrt(cells / ceiling);
    capped = true;
  }
  // Nudged down, not up. A span that divides exactly, which is the commonest
  // case and every test case, comes to a whisker over a whole number in binary,
  // and rounding that up adds a rank of empty cells and shifts the whole grid
  // by half an element. Every node plane then misses the faces of the part, so
  // nothing can be held and nothing can be pushed.
  const n = span.map((s) => Math.max(1, Math.ceil(s / h - 1e-9)));
  // Centred in the box, so a part is not biased towards one corner by the
  // rounding up above.
  const origin = [0, 1, 2].map((d) => lo[d] - (n[d] * h - span[d]) / 2);

  const inside = new Uint8Array(n[0] * n[1] * n[2]);
  const at = (i, j, k) => (k * n[1] + j) * n[0] + i;

  // The triangles, unpacked once, for the rays below.
  const tris = tv.length / 3;
  const T = new Float64Array(tris * 9);
  for (let t = 0; t < tris; t++) {
    for (let c = 0; c < 3; c++) {
      const v = tv[t * 3 + c] * stride;
      T[t * 9 + c * 3] = vp[v];
      T[t * 9 + c * 3 + 1] = vp[v + 1];
      T[t * 9 + c * 3 + 2] = vp[v + 2];
    }
  }

  // Sampled a hair off the middle of each cell rather than exactly at it.
  //
  // The middle of a cell lands on the diagonal of a square face far more often
  // than chance would suggest, because both are laid out on the same regular
  // spacing. On that line the edge rule below has to decide a tie by an exact
  // comparison, and in floating point the numbers are never exactly equal, so
  // the tie is decided at random: sometimes both triangles claim the point,
  // sometimes neither, and the whole row of cells comes out wrong. Moved off
  // the line by a thousandth of a cell, the question never arises. Two
  // different offsets, so the diagonals running each way are both missed.
  const OFF_Y = 0.5037;
  const OFF_Z = 0.5061;

  const hits = [];
  let filled = 0;
  for (let k = 0; k < n[2]; k++) {
    const z = origin[2] + (k + OFF_Z) * h;
    for (let j = 0; j < n[1]; j++) {
      const y = origin[1] + (j + OFF_Y) * h;
      hits.length = 0;
      crossingsAlongX(T, y, z, hits);
      if (hits.length < 2) continue;
      hits.sort((a, b) => a - b);

      // In and out, in pairs. An odd count means the ray grazed an edge, and
      // the honest thing is to use what pairs up and leave the rest.
      for (let p = 0; p + 1 < hits.length; p += 2) {
        const from = hits[p];
        const to = hits[p + 1];
        let i0 = Math.ceil((from - origin[0]) / h - 0.5);
        let i1 = Math.floor((to - origin[0]) / h - 0.5);
        if (i0 < 0) i0 = 0;
        if (i1 > n[0] - 1) i1 = n[0] - 1;
        for (let i = i0; i <= i1; i++) {
          if (!inside[at(i, j, k)]) filled++;
          inside[at(i, j, k)] = 1;
        }
      }
    }
  }
  if (!filled) return null;

  return {
    origin,
    size: h,
    n,
    inside,
    filled,
    at,
    capped,
    // What the grid thinks the part weighs. Against the real volume this is the
    // one number that says whether the cubes are describing the part or a
    // fattened copy of it, and it costs nothing to carry.
    volume: filled * h * h * h
  };
}

/**
 * Where a ray along X crosses the surface.
 *
 * The whole difficulty is a ray that lands exactly on the edge between two
 * triangles, and on a part made of flat faces that is not a rare accident, it
 * is what happens down the diagonal of every square face. Counted by both
 * triangles it gives two crossings in the same place, the pairs come out as
 * two intervals of no length, and the entire row reads as empty. Counted by
 * neither it reads as solid where there is air.
 *
 * So the edge is given to exactly one of the two, by the rule rasterisers use:
 * a point on an edge belongs to the triangle for which that edge is a top or a
 * left one. The two triangles that share an edge run along it in opposite
 * directions, so exactly one of them can see it that way, and which one is
 * consistent everywhere.
 */
function crossingsAlongX(T, y, z, out) {
  for (let i = 0; i < T.length; i += 9) {
    // Seen down the X axis, the triangle is a flat one in y and z.
    let p0 = T[i + 1];
    let q0 = T[i + 2];
    let p1 = T[i + 4];
    let q1 = T[i + 5];
    let p2 = T[i + 7];
    let q2 = T[i + 8];

    let area = (p1 - p0) * (q2 - q0) - (q1 - q0) * (p2 - p0);
    if (area > -1e-14 && area < 1e-14) continue;
    // Anticlockwise, so the rule below reads the same way for every triangle.
    let swapped = false;
    if (area < 0) {
      let t = p1;
      p1 = p2;
      p2 = t;
      t = q1;
      q1 = q2;
      q2 = t;
      area = -area;
      swapped = true;
    }

    const edge = (ap, aq, bp, bq) => {
      const e = (bp - ap) * (z - aq) - (bq - aq) * (y - ap);
      if (e > 0) return true;
      if (e < 0) return false;
      // On the line. Top or left takes it, which is the half of the boundary
      // this triangle owns.
      const dq = bq - aq;
      return dq > 0 || (dq === 0 && bp - ap < 0);
    };
    if (!edge(p0, q0, p1, q1)) continue;
    if (!edge(p1, q1, p2, q2)) continue;
    if (!edge(p2, q2, p0, q0)) continue;

    // Where along the ray, by weights inside the triangle.
    const w1 = ((y - p0) * (q2 - q0) - (z - q0) * (p2 - p0)) / area;
    const w2 = ((z - q0) * (p1 - p0) - (y - p0) * (q1 - q0)) / area;
    const x0 = T[i];
    const x1 = swapped ? T[i + 6] : T[i + 3];
    const x2 = swapped ? T[i + 3] : T[i + 6];
    out.push(x0 + w1 * (x1 - x0) + w2 * (x2 - x0));
  }
}

/**
 * The nodes of the grid that any element uses, numbered so gaps are skipped.
 *
 * A part is a fraction of its own bounding box, so numbering every corner of
 * the whole grid would leave most of them attached to nothing, and every one of
 * those is three unknowns the solver would carry for no reason.
 */
export function nodesOf(grid) {
  const [nx, ny, nz] = grid.n;
  const wide = nx + 1;
  const tall = ny + 1;
  const deep = nz + 1;
  const number = new Int32Array(wide * tall * deep).fill(-1);
  const nodeAt = (i, j, k) => (k * tall + j) * wide + i;

  const elements = [];
  let count = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!grid.inside[grid.at(i, j, k)]) continue;
        // The eight corners, in the order the element stiffness expects: the
        // near face anticlockwise, then the far one.
        const corners = [
          nodeAt(i, j, k),
          nodeAt(i + 1, j, k),
          nodeAt(i + 1, j + 1, k),
          nodeAt(i, j + 1, k),
          nodeAt(i, j, k + 1),
          nodeAt(i + 1, j, k + 1),
          nodeAt(i + 1, j + 1, k + 1),
          nodeAt(i, j + 1, k + 1)
        ];
        for (const c of corners) {
          if (number[c] < 0) number[c] = count++;
        }
        elements.push(corners.map((c) => number[c]));
      }
    }
  }

  const xyz = new Float64Array(count * 3);
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const id = number[nodeAt(i, j, k)];
        if (id < 0) continue;
        xyz[id * 3] = grid.origin[0] + i * grid.size;
        xyz[id * 3 + 1] = grid.origin[1] + j * grid.size;
        xyz[id * 3 + 2] = grid.origin[2] + k * grid.size;
      }
    }
  }

  return { count, xyz, elements: Int32Array.from(elements.flat()), number, nodeAt };
}

/* ------------------------------------------------------------------ */
/* One element                                                         */
/* ------------------------------------------------------------------ */

const GAUSS = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];

/** The eight corners of the reference cube, in the order used above. */
const CORNERS = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1]
];

/**
 * How the shape functions change, at one point in the reference cube.
 *
 * Eight functions, three derivatives each. Everything about a trilinear
 * hexahedron comes from these, so they are written out once and read off.
 */
function shapeDerivatives(xi, eta, zeta) {
  const d = new Float64Array(24);
  for (let a = 0; a < 8; a++) {
    const [sx, sy, sz] = CORNERS[a];
    d[a * 3] = (sx * (1 + sy * eta) * (1 + sz * zeta)) / 8;
    d[a * 3 + 1] = ((1 + sx * xi) * sy * (1 + sz * zeta)) / 8;
    d[a * 3 + 2] = ((1 + sx * xi) * (1 + sy * eta) * sz) / 8;
  }
  return d;
}

/** The six by six that turns strain into stress, for a material the same everywhere. */
export function elasticity(modulus, poisson) {
  const v = Math.max(0, Math.min(0.49, poisson));
  const f = modulus / ((1 + v) * (1 - 2 * v));
  const D = new Float64Array(36);
  const put = (r, c, x) => {
    D[r * 6 + c] = x;
  };
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) put(i, j, f * (i === j ? 1 - v : v));
  }
  for (let i = 3; i < 6; i++) put(i, i, f * ((1 - 2 * v) / 2));
  return D;
}

/**
 * The strain matrix at one point: how the corners moving becomes the element
 * straining.
 *
 * Six rows because strain has six numbers, twenty four columns because eight
 * corners move in three directions each. The cube is the same size in every
 * direction, so the map from the reference cube to the real one is a single
 * scale and there is no Jacobian to invert.
 */
function strainMatrix(xi, eta, zeta, size) {
  const d = shapeDerivatives(xi, eta, zeta);
  const scale = 2 / size;
  const B = new Float64Array(6 * 24);
  for (let a = 0; a < 8; a++) {
    const dx = d[a * 3] * scale;
    const dy = d[a * 3 + 1] * scale;
    const dz = d[a * 3 + 2] * scale;
    const c = a * 3;
    B[0 * 24 + c] = dx;
    B[1 * 24 + c + 1] = dy;
    B[2 * 24 + c + 2] = dz;
    B[3 * 24 + c] = dy;
    B[3 * 24 + c + 1] = dx;
    B[4 * 24 + c + 1] = dz;
    B[4 * 24 + c + 2] = dy;
    B[5 * 24 + c] = dz;
    B[5 * 24 + c + 2] = dx;
  }
  return B;
}

/**
 * The three extra shapes that let a cube bend.
 *
 * This is the fix for the one serious fault of a trilinear cube, which is that
 * it cannot bend. Asked to, it shears instead, and shearing takes far more
 * force, so a beam made of them comes out several times too stiff. It is not a
 * small error: one element through the depth gives a fifth of the right answer,
 * and getting inside a few percent needs a dozen, which for a real part is a
 * grid nobody can wait for.
 *
 * The cure is to let the element deform in three ways its corners cannot
 * describe, each a parabola across one direction, and then to solve those away
 * before the element ever reaches the global system. The element still has
 * twenty four numbers on the outside and the solver never knows the difference.
 *
 * Taylor, Beresford and Wilson, 1976. On a rectangular element it passes the
 * patch test, which is the check that says a formulation cannot get a simple
 * answer wrong.
 */
function incompatibleStrain(xi, eta, zeta, size) {
  const scale = 2 / size;
  // One parabola across each direction, each free to move in all three.
  const d = [
    [-2 * xi * scale, 0, 0],
    [0, -2 * eta * scale, 0],
    [0, 0, -2 * zeta * scale]
  ];
  const B = new Float64Array(6 * 9);
  for (let m = 0; m < 3; m++) {
    const [dx, dy, dz] = d[m];
    const c = m * 3;
    B[0 * 9 + c] = dx;
    B[1 * 9 + c + 1] = dy;
    B[2 * 9 + c + 2] = dz;
    B[3 * 9 + c] = dy;
    B[3 * 9 + c + 1] = dx;
    B[4 * 9 + c + 1] = dz;
    B[4 * 9 + c + 2] = dy;
    B[5 * 9 + c] = dz;
    B[5 * 9 + c + 2] = dx;
  }
  return B;
}

/** B transpose D B, for two strain matrices of any width. */
function bTdb(D, left, leftWide, right, rightWide, weight, into) {
  const DB = new Float64Array(6 * rightWide);
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < rightWide; c++) {
      let sum = 0;
      for (let k = 0; k < 6; k++) sum += D[r * 6 + k] * right[k * rightWide + c];
      DB[r * rightWide + c] = sum;
    }
  }
  for (let i = 0; i < leftWide; i++) {
    for (let j = 0; j < rightWide; j++) {
      let sum = 0;
      for (let k = 0; k < 6; k++) sum += left[k * leftWide + i] * DB[k * rightWide + j];
      into[i * rightWide + j] += sum * weight;
    }
  }
}

/** A small square matrix inverted by elimination, which is all this needs. */
function invert(a, n) {
  const m = new Float64Array(n * 2 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) m[i * 2 * n + j] = a[i * n + j];
    m[i * 2 * n + n + i] = 1;
  }
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(m[r * 2 * n + c]) > Math.abs(m[pivot * 2 * n + c])) pivot = r;
    }
    if (Math.abs(m[pivot * 2 * n + c]) < 1e-300) return null;
    if (pivot !== c) {
      for (let j = 0; j < 2 * n; j++) {
        const t = m[c * 2 * n + j];
        m[c * 2 * n + j] = m[pivot * 2 * n + j];
        m[pivot * 2 * n + j] = t;
      }
    }
    const d = m[c * 2 * n + c];
    for (let j = 0; j < 2 * n; j++) m[c * 2 * n + j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r * 2 * n + c];
      if (!f) continue;
      for (let j = 0; j < 2 * n; j++) m[r * 2 * n + j] -= f * m[c * 2 * n + j];
    }
  }
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = m[i * 2 * n + n + j];
  return out;
}

/**
 * How one cube resists being deformed: a twenty four by twenty four matrix.
 *
 * Worked out by integrating over the cube at eight points, which is exact for
 * this element. Because every element in the grid is the same cube, this is
 * computed once for the whole part, and that is what makes the rest affordable.
 *
 * By default it is given the three extra bending shapes and they are solved
 * away here, so the matrix that leaves this function is the same size as before
 * and behaves far better. Pass `plain` to see what it would have been without
 * them, which is what the test that justifies all this compares against.
 */
export function hexStiffness(modulus, poisson, size, opts = {}) {
  const D = elasticity(modulus, poisson);
  const Kuu = new Float64Array(24 * 24);
  const Kua = new Float64Array(24 * 9);
  const Kaa = new Float64Array(9 * 9);
  const weight = (size / 2) ** 3;
  const plain = !!opts.plain;

  for (const xi of GAUSS) {
    for (const eta of GAUSS) {
      for (const zeta of GAUSS) {
        const B = strainMatrix(xi, eta, zeta, size);
        bTdb(D, B, 24, B, 24, weight, Kuu);
        if (plain) continue;
        const G = incompatibleStrain(xi, eta, zeta, size);
        bTdb(D, B, 24, G, 9, weight, Kua);
        bTdb(D, G, 9, G, 9, weight, Kaa);
      }
    }
  }
  if (plain) return Kuu;

  // Solve the extra shapes away. What is left is how the element behaves once
  // it has been allowed to bend rather than forced to shear.
  const inverse = invert(Kaa, 9);
  if (!inverse) return Kuu;
  for (let i = 0; i < 24; i++) {
    for (let j = 0; j < 24; j++) {
      let sum = 0;
      for (let a = 0; a < 9; a++) {
        let inner = 0;
        for (let b = 0; b < 9; b++) inner += inverse[a * 9 + b] * Kua[j * 9 + b];
        sum += Kua[i * 9 + a] * inner;
      }
      Kuu[i * 24 + j] -= sum;
    }
  }
  return Kuu;
}

/* ------------------------------------------------------------------ */
/* Solving                                                             */
/* ------------------------------------------------------------------ */

/**
 * Solve for the deflection of every node under the loads given.
 *
 * Conjugate gradients, matrix free. The global stiffness matrix is never built:
 * every time the solver needs it multiplied by a vector, the elements are
 * walked and each one's contribution added. For a part of any size that is the
 * difference between a solve that runs and one that runs out of memory.
 *
 * Preconditioned by the diagonal, which for this problem is most of the benefit
 * of a preconditioner for almost none of the cost.
 *
 * Fixed nodes are held by zeroing their rows in every vector the solver
 * touches, which is the cheapest way to say "this does not move" and needs no
 * change to the matrix at all.
 */
export function solve(nodes, elements, Ke, opts = {}) {
  const dof = nodes.count * 3;
  const fixed = new Uint8Array(dof);
  for (const d of opts.fixed || []) if (d >= 0 && d < dof) fixed[d] = 1;

  const f = new Float64Array(dof);
  for (const [d, v] of opts.forces || []) if (d >= 0 && d < dof) f[d] += v;
  for (let d = 0; d < dof; d++) if (fixed[d]) f[d] = 0;

  // Nothing held down means the part can drift, and a solver asked to balance
  // a free body runs forever getting nowhere.
  let held = 0;
  for (let d = 0; d < dof; d++) if (fixed[d]) held++;
  if (!held) return { ok: false, reason: 'Nothing is holding it, so it would simply move.' };
  let load = 0;
  for (let d = 0; d < dof; d++) load += f[d] * f[d];
  if (load < 1e-30) return { ok: false, reason: 'Nothing is pushing it.' };

  const count = elements.length / 8;
  const diag = new Float64Array(dof);
  for (let e = 0; e < count; e++) {
    for (let a = 0; a < 8; a++) {
      const node = elements[e * 8 + a];
      for (let c = 0; c < 3; c++) {
        const i = a * 3 + c;
        diag[node * 3 + c] += Ke[i * 24 + i];
      }
    }
  }
  for (let d = 0; d < dof; d++) if (fixed[d] || diag[d] < 1e-30) diag[d] = 1;

  const u = new Float64Array(dof);
  const r = Float64Array.from(f);
  const z = new Float64Array(dof);
  const p = new Float64Array(dof);
  const Ap = new Float64Array(dof);
  const local = new Float64Array(24);

  const multiply = (x, out) => {
    out.fill(0);
    for (let e = 0; e < count; e++) {
      const base = e * 8;
      for (let a = 0; a < 8; a++) {
        const node = elements[base + a] * 3;
        local[a * 3] = x[node];
        local[a * 3 + 1] = x[node + 1];
        local[a * 3 + 2] = x[node + 2];
      }
      for (let i = 0; i < 24; i++) {
        let sum = 0;
        const row = i * 24;
        for (let j = 0; j < 24; j++) sum += Ke[row + j] * local[j];
        const node = elements[base + ((i / 3) | 0)] * 3 + (i % 3);
        out[node] += sum;
      }
    }
    for (let d = 0; d < dof; d++) if (fixed[d]) out[d] = 0;
  };

  for (let d = 0; d < dof; d++) z[d] = r[d] / diag[d];
  p.set(z);
  let rz = 0;
  for (let d = 0; d < dof; d++) rz += r[d] * z[d];
  const target = Math.sqrt(load) * (opts.tolerance ?? 1e-8);
  const most = opts.iterations || Math.min(20000, dof * 2);

  let iterations = 0;
  let residual = Math.sqrt(load);
  for (; iterations < most; iterations++) {
    multiply(p, Ap);
    let pAp = 0;
    for (let d = 0; d < dof; d++) pAp += p[d] * Ap[d];
    if (!(Math.abs(pAp) > 1e-300)) break;
    const alpha = rz / pAp;
    for (let d = 0; d < dof; d++) {
      u[d] += alpha * p[d];
      r[d] -= alpha * Ap[d];
    }
    residual = 0;
    for (let d = 0; d < dof; d++) residual += r[d] * r[d];
    residual = Math.sqrt(residual);
    if (residual < target) {
      iterations++;
      break;
    }
    for (let d = 0; d < dof; d++) z[d] = r[d] / diag[d];
    let rzNext = 0;
    for (let d = 0; d < dof; d++) rzNext += r[d] * z[d];
    const beta = rzNext / rz;
    rz = rzNext;
    for (let d = 0; d < dof; d++) p[d] = z[d] + beta * p[d];
  }

  return {
    ok: true,
    displacement: u,
    iterations,
    residual,
    converged: residual < target * 10,
    dof
  };
}

/**
 * The stress in every element, and how far every node moved.
 *
 * Stress is read at the eight corners of each element and the worst kept. The
 * middle would be smoother and it would be wrong in the one direction that
 * matters: bending stress is highest at the surface and zero in the middle of
 * the section, so an element centre systematically under-reads the peak. With
 * one element through the depth it reads zero for a beam that is at yield.
 * Under-reading a stress is how a part gets signed off and then breaks.
 *
 * Von Mises because that is what a ductile material fails by, and because it is
 * the number a yield strength is quoted against.
 */
export function stresses(nodes, elements, displacement, material, size) {
  const D = elasticity(material.modulus, material.poisson);
  // The eight corners, worked out once, because every element is the same cube.
  const corners = CORNERS.map(([x, y, z]) => strainMatrix(x, y, z, size));
  const count = elements.length / 8;
  const out = new Float64Array(count);
  const local = new Float64Array(24);
  const strain = new Float64Array(6);
  const stress = new Float64Array(6);
  let worst = 0;
  let worstAt = -1;

  for (let e = 0; e < count; e++) {
    for (let a = 0; a < 8; a++) {
      const node = elements[e * 8 + a] * 3;
      local[a * 3] = displacement[node];
      local[a * 3 + 1] = displacement[node + 1];
      local[a * 3 + 2] = displacement[node + 2];
    }
    let peak = 0;
    for (const B of corners) {
      for (let r = 0; r < 6; r++) {
        let sum = 0;
        for (let c = 0; c < 24; c++) sum += B[r * 24 + c] * local[c];
        strain[r] = sum;
      }
      for (let r = 0; r < 6; r++) {
        let sum = 0;
        for (let c = 0; c < 6; c++) sum += D[r * 6 + c] * strain[c];
        stress[r] = sum;
      }
      const [sx, sy, sz, txy, tyz, tzx] = stress;
      const vm = Math.sqrt(
        0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) +
          3 * (txy * txy + tyz * tyz + tzx * tzx)
      );
      if (vm > peak) peak = vm;
    }
    out[e] = peak;
    if (peak > worst) {
      worst = peak;
      worstAt = e;
    }
  }

  let move = 0;
  let moveAt = -1;
  for (let n = 0; n < nodes.count; n++) {
    const d = Math.hypot(
      displacement[n * 3],
      displacement[n * 3 + 1],
      displacement[n * 3 + 2]
    );
    if (d > move) {
      move = d;
      moveAt = n;
    }
  }

  return {
    vonMises: out,
    maxStress: worst,
    maxStressAt: worstAt,
    maxMove: move,
    maxMoveAt: moveAt,
    factor: worst > 1e-12 ? material.yield / worst : Infinity
  };
}

/**
 * The nodes on one side of a plane through the part, for holding or pushing.
 *
 * Picking by geometry rather than by clicking each one: what somebody means by
 * "hold this face" is every node on it, and a face of a grid is a slab one
 * element thick.
 */
export function nodesNear(nodes, plane, tolerance) {
  const out = [];
  const n = plane.normal;
  const o = plane.origin;
  for (let i = 0; i < nodes.count; i++) {
    const d =
      (nodes.xyz[i * 3] - o[0]) * n[0] +
      (nodes.xyz[i * 3 + 1] - o[1]) * n[1] +
      (nodes.xyz[i * 3 + 2] - o[2]) * n[2];
    if (Math.abs(d) <= tolerance) out.push(i);
  }
  return out;
}

/** Every degree of freedom of a set of nodes, which is what fixing one means. */
export function dofsOf(list) {
  const out = [];
  for (const n of list) out.push(n * 3, n * 3 + 1, n * 3 + 2);
  return out;
}

/**
 * A force spread over a set of nodes, weighted by how much face each one has.
 *
 * Evenly is wrong, and wrong in a way that looks like a real answer. A flat
 * face of the grid has corner nodes touching one element, edge nodes touching
 * two and inside nodes touching four, so an even share over-loads the corners
 * and under-loads the middle. What comes back is a stress concentration at the
 * corners of the loaded face that is not in the part, it is in the way the load
 * was applied, and it is the number somebody would quote.
 *
 * Weighted by how many elements each node belongs to, the share matches the
 * area each node is responsible for, and a uniform push comes out uniform.
 */
export function spreadForce(list, vector, elements) {
  const out = [];
  if (!list.length) return out;

  let weights = null;
  let total = list.length;
  if (elements) {
    const touching = new Map();
    for (let i = 0; i < elements.length; i++) {
      const node = elements[i];
      if (touching.has(node)) touching.set(node, touching.get(node) + 1);
      else touching.set(node, 1);
    }
    weights = list.map((n) => touching.get(n) || 1);
    total = weights.reduce((a, b) => a + b, 0);
  }

  list.forEach((n, i) => {
    const share = (weights ? weights[i] : 1) / total;
    out.push(
      [n * 3, vector[0] * share],
      [n * 3 + 1, vector[1] * share],
      [n * 3 + 2, vector[2] * share]
    );
  });
  return out;
}

/**
 * Is the grid fine enough to be describing this part at all?
 *
 * A cube bigger than the thinnest part of the model turns a 10 millimetre beam
 * into a 20 millimetre one, and every number after that is about a part nobody
 * drew. Measured by how many cubes the part is across in its narrowest
 * direction, which is the number that has to be at least a few.
 */
export function gridQuality(grid) {
  const [nx, ny, nz] = grid.n;
  // How thick the part is, in cubes, in the thinnest of the three directions
  // it actually occupies.
  let thinnest = Infinity;
  for (const [a, b, c] of [
    [0, 1, 2],
    [1, 0, 2],
    [2, 0, 1]
  ]) {
    const size = [nx, ny, nz];
    let least = Infinity;
    for (let u = 0; u < size[b]; u++) {
      for (let v = 0; v < size[c]; v++) {
        let run = 0;
        for (let w = 0; w < size[a]; w++) {
          const at = [0, 0, 0];
          at[a] = w;
          at[b] = u;
          at[c] = v;
          if (grid.inside[grid.at(at[0], at[1], at[2])]) run++;
        }
        if (run > 0 && run < least) least = run;
      }
    }
    if (least < thinnest) thinnest = least;
  }
  return {
    across: thinnest === Infinity ? 0 : thinnest,
    // Two cubes through a wall is the least that can bend at all. Under that
    // the answer is about a different part.
    enough: thinnest >= 2,
    good: thinnest >= 4
  };
}

/**
 * How far the grid's idea of the part is from the real one, by volume.
 *
 * The check that catches the fault nothing else does. A grid whose cubes do not
 * divide a section leaves it fatter or thinner than it is, and since bending
 * stiffness goes as the thickness cubed, a few percent of volume is a great
 * deal of stiffness. Every other reading looks reasonable while that is
 * happening, so it is worth a number of its own.
 */
export function volumeError(grid, trueVolume) {
  if (!(trueVolume > 0)) return { error: 0, ok: true };
  const error = (grid.volume - trueVolume) / trueVolume;
  return {
    error,
    percent: error * 100,
    // Five percent of volume is about fifteen of stiffness, which is as much as
    // is worth living with.
    ok: Math.abs(error) <= 0.05
  };
}
