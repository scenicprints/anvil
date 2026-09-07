/**
 * Generative design: letting the load decide the shape.
 *
 * The question it answers is the one nobody can answer by eye. Given where a
 * part is held, where it is pushed, and how much material it is allowed, where
 * should that material go? Not "is this bracket strong enough", which is what
 * the stress solver answers, but "what should the bracket look like".
 *
 * The method is topology optimisation, and the whole of it is one idea repeated:
 * solve the part, see which bits of material are storing energy, take material
 * away from the bits that are not and give it to the bits that are, and solve
 * again. Material that is carrying load earns its place; material that is idle
 * loses it. Thirty or forty rounds of that and what is left is the shape.
 *
 * Two details are not obvious and both are necessary.
 *
 * **Material is a dial, not a switch.** An element is not in or out, it is
 * somewhere between nothing and solid, and its stiffness is its share cubed.
 * Cubing is what makes half-solid material a bad deal: it costs half the budget
 * and buys an eighth of the stiffness, so the answer settles on shapes that are
 * mostly solid or mostly empty rather than a fog of half material everywhere.
 *
 * **The reading has to be blurred before it is acted on.** Acted on directly,
 * the answer breaks into a checkerboard of alternating solid and empty cells,
 * which is not a real shape: it is an artefact of the elements, and it looks
 * stiffer to the maths than it is. Averaging each element's reading with its
 * neighbours over a radius removes it, and has the side effect of setting the
 * finest feature the answer is allowed to have, which is exactly what somebody
 * printing it wants to control.
 *
 * Nothing here draws or touches the kernel. What comes out is a number per
 * element, between nothing and one.
 */

/**
 * Which elements are near which, and how strongly, for the blur.
 *
 * Worked out once and reused every round, because it depends only on the grid
 * and it is the second most expensive thing here after the solve itself.
 */
export function neighbourhood(grid, elementCells, radius) {
  const r = Math.max(1, radius);
  const reach = Math.ceil(r) - 1;
  const [nx, ny] = grid.n;
  const index = new Map();
  elementCells.forEach((cell, e) => index.set(cell, e));

  const starts = new Int32Array(elementCells.length + 1);
  const list = [];
  const weights = [];

  elementCells.forEach((cell, e) => {
    starts[e] = list.length;
    const i = cell % nx;
    const j = ((cell / nx) | 0) % ny;
    const k = (cell / (nx * ny)) | 0;
    for (let dk = -reach; dk <= reach; dk++) {
      for (let dj = -reach; dj <= reach; dj++) {
        for (let di = -reach; di <= reach; di++) {
          const d = Math.hypot(di, dj, dk);
          if (d > r) continue;
          const other = index.get(cell + di + dj * nx + dk * nx * ny);
          if (other === undefined) continue;
          // The nearer it is the more it counts, falling to nothing at the
          // edge of the radius.
          list.push(other);
          weights.push(r - d);
        }
      }
    }
  });
  starts[elementCells.length] = list.length;
  return { starts, list: Int32Array.from(list), weights: Float64Array.from(weights) };
}

/** One element's reading, blurred with its neighbours'. */
export function blur(near, density, raw) {
  const out = new Float64Array(raw.length);
  for (let e = 0; e < raw.length; e++) {
    let sum = 0;
    let total = 0;
    for (let i = near.starts[e]; i < near.starts[e + 1]; i++) {
      const other = near.list[i];
      const w = near.weights[i];
      // Weighted by how much material is there as well as by distance, which
      // is what keeps the blur from smearing a reading out of empty space.
      sum += w * Math.max(1e-3, density[other]) * raw[other];
      total += w;
    }
    const own = Math.max(1e-3, density[e]);
    out[e] = total > 0 ? sum / (total * own) : raw[e];
  }
  return out;
}

/**
 * Move material to where it is working, without spending more than the budget.
 *
 * A bisection on one number: how hard to push material towards the places that
 * want it. Push too hard and the part uses more than it is allowed, too little
 * and it uses less, and there is exactly one setting in between.
 *
 * Bisected on the logarithm, not on the number. The right setting depends on
 * how much energy is in the part, which varies by many powers of ten between
 * one problem and the next, so the search has to start across a range of the
 * same kind. Halving that range in the ordinary way spends nearly every step
 * in the top decade and never reaches the bottom ones; halving it in the
 * logarithm crosses eighteen decades in about forty steps.
 *
 * The step is limited so nothing moves more than a fifth of the way in one
 * round. Without that the answer oscillates: everything empties, then
 * everything fills, and it never settles.
 */
export function step(density, sensitivity, opts = {}) {
  const budget = Math.max(0.01, Math.min(1, opts.fraction ?? 0.4));
  const move = opts.move ?? 0.2;
  const floor = opts.floor ?? 1e-3;
  const locked = opts.locked || null;

  // The bracket has to be worked out from the readings, not written down.
  // How hard to push depends on how much energy is in the part, and that varies
  // by many powers of ten between one problem and the next: a bracket of fixed
  // numbers is either far too wide, so the search wastes itself, or too narrow,
  // in which case the answer is outside it and the budget is simply missed.
  //
  // At the top of the bracket every element is squeezed to the floor; at the
  // bottom every one is at solid. Anything that puts both ends outside the
  // answer will do, so the ends are put well outside.
  let biggest = 0;
  for (let e = 0; e < density.length; e++) {
    const want = density[e] * density[e] * Math.max(0, -sensitivity[e]);
    if (want > biggest) biggest = want;
  }
  if (!(biggest > 0)) return Float64Array.from(density);
  let high = (biggest / (floor * floor)) * 1e3;
  let low = biggest * 1e-12;
  const out = new Float64Array(density.length);
  const want = budget * density.length;

  for (let round = 0; round < 120; round++) {
    const mid = Math.sqrt(low * high);
    let used = 0;
    for (let e = 0; e < density.length; e++) {
      if (locked && locked[e]) {
        out[e] = 1;
        used += 1;
        continue;
      }
      // Where the reading says material is worth more than it costs, take more.
      const wish = density[e] * Math.sqrt(Math.max(0, -sensitivity[e]) / mid);
      let next = Math.min(1, density[e] + move, Math.max(floor, density[e] - move, wish));
      if (!Number.isFinite(next)) next = density[e];
      out[e] = next;
      used += next;
    }
    if (used > want) low = mid;
    else high = mid;
    if (high / low < 1 + 1e-9) break;
  }
  return out;
}

/**
 * The whole loop: solve, read, blur, move, repeat.
 *
 * `solveOnce` is handed in rather than imported so this file never has to know
 * how a part is solved, only that it can be. It is given the current density
 * and hands back the deflection.
 *
 * It stops when the shape stops changing, which is the honest place to stop:
 * a fixed number of rounds either wastes time or stops halfway, and which of
 * those depends on the part.
 */
export function optimise(count, solveOnce, energyOf, near, opts = {}) {
  const budget = Math.max(0.05, Math.min(0.95, opts.fraction ?? 0.4));
  const penalty = opts.penalty ?? 3;
  const rounds = Math.max(1, Math.round(opts.rounds ?? 40));
  const settled = opts.settled ?? 0.01;
  const locked = opts.locked || null;

  let density = new Float64Array(count).fill(budget);
  if (locked) for (let e = 0; e < count; e++) if (locked[e]) density[e] = 1;

  const history = [];
  let warm = null;
  const scale = new Float64Array(count);
  const sensitivity = new Float64Array(count);

  for (let round = 0; round < rounds; round++) {
    for (let e = 0; e < count; e++) {
      // Stiffness is the share cubed, which is what makes half material a bad
      // deal and pushes the answer towards solid or empty.
      scale[e] = 1e-9 + (1 - 1e-9) * Math.pow(density[e], penalty);
    }
    const solved = solveOnce(scale, warm);
    warm = solved?.guess || warm;
    if (!solved?.ok) return { ok: false, reason: solved?.reason || 'It would not solve', density, history };

    const energy = energyOf(solved.displacement);
    let compliance = 0;
    for (let e = 0; e < count; e++) {
      const full = energy[e];
      compliance += scale[e] * full;
      sensitivity[e] = -penalty * Math.pow(density[e], penalty - 1) * full;
    }

    const smoothed = near ? blur(near, density, sensitivity) : sensitivity;
    const next = step(density, smoothed, { fraction: budget, locked, move: opts.move });

    let biggest = 0;
    for (let e = 0; e < count; e++) biggest = Math.max(biggest, Math.abs(next[e] - density[e]));
    density = next;
    history.push({ round: round + 1, compliance, change: biggest });
    if (biggest < settled) break;
    if (opts.onRound) opts.onRound(history[history.length - 1], density);
  }

  return { ok: true, density, history, rounds: history.length };
}

/**
 * The surface of what is left, as triangles.
 *
 * A face of a kept cell that has no kept cell behind it is on the outside, and
 * the outside is all of them together. Blocky on purpose: this is the answer at
 * the resolution it was worked out at, and smoothing it here would suggest a
 * precision the grid does not have. Smooth it afterwards, deliberately, with
 * the mesh tools that already exist for that.
 */
export function surfaceOf(grid, elementCells, density, threshold = 0.5) {
  const [nx, ny, nz] = grid.n;
  const kept = new Uint8Array(nx * ny * nz);
  elementCells.forEach((cell, e) => {
    if (density[e] >= threshold) kept[cell] = 1;
  });
  const at = (i, j, k) =>
    i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : kept[(k * ny + j) * nx + i];

  const points = [];
  const tris = [];
  const seen = new Map();
  const h = grid.size;
  const put = (i, j, k) => {
    const key = (k * (ny + 1) + j) * (nx + 1) + i;
    let id = seen.get(key);
    if (id === undefined) {
      id = points.length / 3;
      points.push(
        grid.origin[0] + i * h,
        grid.origin[1] + j * h,
        grid.origin[2] + k * h
      );
      seen.set(key, id);
    }
    return id;
  };
  const quad = (a, b, c, d) => {
    tris.push(a, b, c, a, c, d);
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!at(i, j, k)) continue;
        // Wound so every face looks outwards, which is what makes the result a
        // solid rather than a bag.
        if (!at(i - 1, j, k)) quad(put(i, j, k), put(i, j, k + 1), put(i, j + 1, k + 1), put(i, j + 1, k));
        if (!at(i + 1, j, k)) quad(put(i + 1, j, k), put(i + 1, j + 1, k), put(i + 1, j + 1, k + 1), put(i + 1, j, k + 1));
        if (!at(i, j - 1, k)) quad(put(i, j, k), put(i + 1, j, k), put(i + 1, j, k + 1), put(i, j, k + 1));
        if (!at(i, j + 1, k)) quad(put(i, j + 1, k), put(i, j + 1, k + 1), put(i + 1, j + 1, k + 1), put(i + 1, j + 1, k));
        if (!at(i, j, k - 1)) quad(put(i, j, k), put(i, j + 1, k), put(i + 1, j + 1, k), put(i + 1, j, k));
        if (!at(i, j, k + 1)) quad(put(i, j, k + 1), put(i + 1, j, k + 1), put(i + 1, j + 1, k + 1), put(i, j + 1, k + 1));
      }
    }
  }

  if (!tris.length) return null;
  return {
    numProp: 3,
    vertProperties: new Float32Array(points),
    triVerts: new Uint32Array(tris)
  };
}

/** How much of the allowance the answer actually used. */
export function usage(density) {
  let sum = 0;
  for (const d of density) sum += d;
  return sum / Math.max(1, density.length);
}

/** How much of it is properly solid or properly empty rather than a fog. */
export function crispness(density) {
  let grey = 0;
  for (const d of density) if (d > 0.2 && d < 0.8) grey++;
  return 1 - grey / Math.max(1, density.length);
}
