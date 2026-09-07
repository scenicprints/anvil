/**
 * Sketch constraint solver.
 *
 * Constraints are expressed as residual functions over a flat variable vector.
 * The vector holds every sketch point (x, y) followed by the radius of every
 * circle. Solving drives all residuals to zero with damped Gauss-Newton
 * (Levenberg-Marquardt), which tolerates the redundant and near-singular
 * systems that real sketching produces.
 *
 * Each constraint declares which variables it touches, so the Jacobian is built
 * by perturbing only those columns instead of the whole vector.
 */

const EPS = 1e-7;

/**
 * Finite-difference step. Central differences trade truncation error against
 * floating-point cancellation, and the error is smallest near cube-root-eps
 * times the value. Using 1e-7 instead, the obvious-looking choice, leaves the
 * gradient accurate to only about a part per million, which shows up as
 * dimensions that settle a few microns away from what was typed.
 */
function stepFor(value) {
  return Math.max(1e-6, Math.abs(value) * 6e-6);
}

/* ------------------------------------------------------------------ */
/* Variable layout                                                     */
/* ------------------------------------------------------------------ */

export function buildLayout(sketch) {
  const pointBase = new Map();
  let n = 0;
  sketch.points.forEach((_, i) => {
    pointBase.set(i, n);
    n += 2;
  });

  const radiusBase = new Map();
  for (const ent of sketch.entities) {
    if (ent.type === 'circle') {
      radiusBase.set(ent.id, n);
      n += 1;
    }
  }
  return { pointBase, radiusBase, size: n };
}

export function packVars(sketch, layout) {
  const v = new Float64Array(layout.size);
  sketch.points.forEach((p, i) => {
    const b = layout.pointBase.get(i);
    v[b] = p.x;
    v[b + 1] = p.y;
  });
  for (const ent of sketch.entities) {
    if (ent.type === 'circle') v[layout.radiusBase.get(ent.id)] = ent.r;
  }
  return v;
}

export function unpackVars(sketch, layout, v) {
  sketch.points.forEach((p, i) => {
    const b = layout.pointBase.get(i);
    p.x = v[b];
    p.y = v[b + 1];
  });
  for (const ent of sketch.entities) {
    if (ent.type === 'circle') ent.r = v[layout.radiusBase.get(ent.id)];
  }
}

/* ------------------------------------------------------------------ */
/* Residual construction                                               */
/* ------------------------------------------------------------------ */

const px = (v, layout, i) => v[layout.pointBase.get(i)];
const py = (v, layout, i) => v[layout.pointBase.get(i) + 1];

function pointVars(layout, i) {
  const b = layout.pointBase.get(i);
  return [b, b + 1];
}

function entityById(sketch, id) {
  return sketch.entities.find((e) => e.id === id) || null;
}

/**
 * Turn the sketch's constraint list into residual descriptors.
 * Each descriptor is { vars: number[], fn: (v) => number[] }.
 */
export function buildResiduals(sketch, layout, opts = {}) {
  const out = [];
  const L = layout;
  const dragging = opts.dragging || null;

  const add = (vars, fn, weight = 1) => out.push({ vars, fn, weight });

  // Implicit: an arc's two endpoints must be equidistant from its centre,
  // otherwise the arc is not a circular arc at all.
  for (const ent of sketch.entities) {
    if (ent.type !== 'arc') continue;
    const [a, b] = ent.p;
    const c = ent.c;
    const vars = [...pointVars(L, a), ...pointVars(L, b), ...pointVars(L, c)];
    add(vars, (v) => {
      const r0 = Math.hypot(px(v, L, a) - px(v, L, c), py(v, L, a) - py(v, L, c));
      const r1 = Math.hypot(px(v, L, b) - px(v, L, c), py(v, L, b) - py(v, L, c));
      return [r0 - r1];
    });
  }

  for (const c of sketch.constraints) {
    // A driven dimension only reports a measurement; it must not push on the
    // geometry, so it contributes no residual.
    if (c.driven) continue;
    switch (c.type) {
      case 'coincident': {
        const [a, b] = c.points;
        add([...pointVars(L, a), ...pointVars(L, b)], (v) => [
          px(v, L, a) - px(v, L, b),
          py(v, L, a) - py(v, L, b)
        ]);
        break;
      }

      case 'fixed': {
        const i = c.point;
        const x0 = c.x;
        const y0 = c.y;
        add(pointVars(L, i), (v) => [px(v, L, i) - x0, py(v, L, i) - y0]);
        break;
      }

      case 'horizontal': {
        const ent = entityById(sketch, c.entity);
        if (!ent || ent.type !== 'line') break;
        const [a, b] = ent.p;
        add([...pointVars(L, a), ...pointVars(L, b)], (v) => [py(v, L, a) - py(v, L, b)]);
        break;
      }

      case 'vertical': {
        const ent = entityById(sketch, c.entity);
        if (!ent || ent.type !== 'line') break;
        const [a, b] = ent.p;
        add([...pointVars(L, a), ...pointVars(L, b)], (v) => [px(v, L, a) - px(v, L, b)]);
        break;
      }

      case 'parallel': {
        const e1 = entityById(sketch, c.entities[0]);
        const e2 = entityById(sketch, c.entities[1]);
        if (!e1 || !e2) break;
        const [a, b] = e1.p;
        const [d, e] = e2.p;
        const vars = [
          ...pointVars(L, a), ...pointVars(L, b),
          ...pointVars(L, d), ...pointVars(L, e)
        ];
        add(vars, (v) => {
          const ux = px(v, L, b) - px(v, L, a);
          const uy = py(v, L, b) - py(v, L, a);
          const wx = px(v, L, e) - px(v, L, d);
          const wy = py(v, L, e) - py(v, L, d);
          const lu = Math.hypot(ux, uy) || 1;
          const lw = Math.hypot(wx, wy) || 1;
          return [(ux * wy - uy * wx) / (lu * lw)];
        });
        break;
      }

      case 'collinear': {
        // Two lines on one infinite line. Parallel is not enough on its own:
        // two rails are parallel and are not collinear. Both ends of the second
        // line have to sit on the first, and that says the whole thing at once.
        const e1 = entityById(sketch, c.entities[0]);
        const e2 = entityById(sketch, c.entities[1]);
        if (!e1 || !e2 || e1.type !== 'line' || e2.type !== 'line') break;
        const [a, b] = e1.p;
        const [d, e] = e2.p;
        const vars = [
          ...pointVars(L, a), ...pointVars(L, b),
          ...pointVars(L, d), ...pointVars(L, e)
        ];
        add(vars, (v) => {
          const ux = px(v, L, b) - px(v, L, a);
          const uy = py(v, L, b) - py(v, L, a);
          const lu = Math.hypot(ux, uy) || 1;
          const off = (i) =>
            (ux * (py(v, L, i) - py(v, L, a)) - uy * (px(v, L, i) - px(v, L, a))) / lu;
          return [off(d), off(e)];
        });
        break;
      }

      case 'perpendicular': {
        const e1 = entityById(sketch, c.entities[0]);
        const e2 = entityById(sketch, c.entities[1]);
        if (!e1 || !e2) break;
        const [a, b] = e1.p;
        const [d, e] = e2.p;
        const vars = [
          ...pointVars(L, a), ...pointVars(L, b),
          ...pointVars(L, d), ...pointVars(L, e)
        ];
        add(vars, (v) => {
          const ux = px(v, L, b) - px(v, L, a);
          const uy = py(v, L, b) - py(v, L, a);
          const wx = px(v, L, e) - px(v, L, d);
          const wy = py(v, L, e) - py(v, L, d);
          const lu = Math.hypot(ux, uy) || 1;
          const lw = Math.hypot(wx, wy) || 1;
          return [(ux * wx + uy * wy) / (lu * lw)];
        });
        break;
      }

      case 'equal': {
        const e1 = entityById(sketch, c.entities[0]);
        const e2 = entityById(sketch, c.entities[1]);
        if (!e1 || !e2) break;
        const lenOf = (ent) => {
          if (ent.type === 'line') {
            const [a, b] = ent.p;
            return {
              vars: [...pointVars(L, a), ...pointVars(L, b)],
              fn: (v) => Math.hypot(px(v, L, b) - px(v, L, a), py(v, L, b) - py(v, L, a))
            };
          }
          if (ent.type === 'circle') {
            const rb = L.radiusBase.get(ent.id);
            return { vars: [rb], fn: (v) => v[rb] };
          }
          const [a] = ent.p;
          return {
            vars: [...pointVars(L, a), ...pointVars(L, ent.c)],
            fn: (v) => Math.hypot(px(v, L, a) - px(v, L, ent.c), py(v, L, a) - py(v, L, ent.c))
          };
        };
        const A = lenOf(e1);
        const B = lenOf(e2);
        add([...A.vars, ...B.vars], (v) => [A.fn(v) - B.fn(v)]);
        break;
      }

      case 'distance': {
        const [a, b] = c.points;
        const d = c.value;
        add([...pointVars(L, a), ...pointVars(L, b)], (v) => [
          Math.hypot(px(v, L, b) - px(v, L, a), py(v, L, b) - py(v, L, a)) - d
        ]);
        break;
      }

      case 'distanceX': {
        const [a, b] = c.points;
        add([...pointVars(L, a), ...pointVars(L, b)], (v) => [
          px(v, L, b) - px(v, L, a) - c.value
        ]);
        break;
      }

      case 'distanceY': {
        const [a, b] = c.points;
        add([...pointVars(L, a), ...pointVars(L, b)], (v) => [
          py(v, L, b) - py(v, L, a) - c.value
        ]);
        break;
      }

      case 'radius': {
        const ent = entityById(sketch, c.entity);
        if (!ent) break;
        if (ent.type === 'circle') {
          const rb = L.radiusBase.get(ent.id);
          add([rb], (v) => [v[rb] - c.value]);
        } else if (ent.type === 'arc') {
          const a = ent.p[0];
          add([...pointVars(L, a), ...pointVars(L, ent.c)], (v) => [
            Math.hypot(px(v, L, a) - px(v, L, ent.c), py(v, L, a) - py(v, L, ent.c)) - c.value
          ]);
        }
        break;
      }

      case 'diameter': {
        const ent = entityById(sketch, c.entity);
        if (!ent) break;
        if (ent.type === 'circle') {
          const rb = L.radiusBase.get(ent.id);
          add([rb], (v) => [2 * v[rb] - c.value]);
        } else if (ent.type === 'arc') {
          const a = ent.p[0];
          add([...pointVars(L, a), ...pointVars(L, ent.c)], (v) => [
            2 * Math.hypot(px(v, L, a) - px(v, L, ent.c), py(v, L, a) - py(v, L, ent.c)) - c.value
          ]);
        }
        break;
      }

      case 'angle': {
        const e1 = entityById(sketch, c.entities[0]);
        const e2 = entityById(sketch, c.entities[1]);
        if (!e1 || !e2) break;
        const [a, b] = e1.p;
        const [d, e] = e2.p;
        const target = (c.value * Math.PI) / 180;
        const vars = [
          ...pointVars(L, a), ...pointVars(L, b),
          ...pointVars(L, d), ...pointVars(L, e)
        ];
        add(vars, (v) => {
          const ux = px(v, L, b) - px(v, L, a);
          const uy = py(v, L, b) - py(v, L, a);
          const wx = px(v, L, e) - px(v, L, d);
          const wy = py(v, L, e) - py(v, L, d);
          const cross = ux * wy - uy * wx;
          const dot = ux * wx + uy * wy;
          let ang = Math.atan2(cross, dot);
          let diff = ang - target;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          return [diff];
        });
        break;
      }

      case 'pointOnLine': {
        const ent = entityById(sketch, c.entity);
        if (!ent || ent.type !== 'line') break;
        const [a, b] = ent.p;
        const i = c.point;
        const vars = [...pointVars(L, i), ...pointVars(L, a), ...pointVars(L, b)];
        add(vars, (v) => {
          const ux = px(v, L, b) - px(v, L, a);
          const uy = py(v, L, b) - py(v, L, a);
          const wx = px(v, L, i) - px(v, L, a);
          const wy = py(v, L, i) - py(v, L, a);
          const lu = Math.hypot(ux, uy) || 1;
          return [(ux * wy - uy * wx) / lu];
        });
        break;
      }

      case 'pointOnCircle': {
        const ent = entityById(sketch, c.entity);
        if (!ent) break;
        const i = c.point;
        if (ent.type === 'circle') {
          const rb = L.radiusBase.get(ent.id);
          const vars = [...pointVars(L, i), ...pointVars(L, ent.c), rb];
          add(vars, (v) => [
            Math.hypot(px(v, L, i) - px(v, L, ent.c), py(v, L, i) - py(v, L, ent.c)) - v[rb]
          ]);
        } else if (ent.type === 'arc') {
          const a = ent.p[0];
          const vars = [
            ...pointVars(L, i), ...pointVars(L, ent.c), ...pointVars(L, a)
          ];
          add(vars, (v) => {
            const r = Math.hypot(px(v, L, a) - px(v, L, ent.c), py(v, L, a) - py(v, L, ent.c));
            return [
              Math.hypot(px(v, L, i) - px(v, L, ent.c), py(v, L, i) - py(v, L, ent.c)) - r
            ];
          });
        }
        break;
      }

      case 'concentric': {
        const e1 = entityById(sketch, c.entities[0]);
        const e2 = entityById(sketch, c.entities[1]);
        if (!e1 || !e2) break;
        const a = e1.c;
        const b = e2.c;
        add([...pointVars(L, a), ...pointVars(L, b)], (v) => [
          px(v, L, a) - px(v, L, b),
          py(v, L, a) - py(v, L, b)
        ]);
        break;
      }

      case 'symmetric': {
        const [a, b] = c.points;
        const ent = entityById(sketch, c.entity);
        if (!ent || ent.type !== 'line') break;
        const [d, e] = ent.p;
        const vars = [
          ...pointVars(L, a), ...pointVars(L, b),
          ...pointVars(L, d), ...pointVars(L, e)
        ];
        add(vars, (v) => {
          const ax = px(v, L, a), ay = py(v, L, a);
          const bx = px(v, L, b), by = py(v, L, b);
          const dx = px(v, L, d), dy = py(v, L, d);
          const ex = px(v, L, e), ey = py(v, L, e);
          const ux = ex - dx, uy = ey - dy;
          const lu = Math.hypot(ux, uy) || 1;
          const nx = -uy / lu, ny = ux / lu;
          // Midpoint must sit on the mirror line.
          const mx = (ax + bx) / 2 - dx;
          const my = (ay + by) / 2 - dy;
          // The chord must run along the line normal.
          const cx = bx - ax, cy = by - ay;
          return [mx * nx + my * ny, (cx * ux + cy * uy) / lu];
        });
        break;
      }

      case 'tangent': {
        const e1 = entityById(sketch, c.entities[0]);
        const e2 = entityById(sketch, c.entities[1]);
        if (!e1 || !e2) break;
        const line = e1.type === 'line' ? e1 : e2.type === 'line' ? e2 : null;
        const curve = e1.type === 'line' ? e2 : e1;
        if (line && curve && curve.type !== 'line') {
          const [a, b] = line.p;
          const cc = curve.c;
          const radius = (v) => {
            if (curve.type === 'circle') return v[L.radiusBase.get(curve.id)];
            const q = curve.p[0];
            return Math.hypot(px(v, L, q) - px(v, L, cc), py(v, L, q) - py(v, L, cc));
          };
          const extra =
            curve.type === 'circle'
              ? [L.radiusBase.get(curve.id)]
              : pointVars(L, curve.p[0]);
          const vars = [
            ...pointVars(L, a), ...pointVars(L, b), ...pointVars(L, cc), ...extra
          ];
          add(vars, (v) => {
            const ux = px(v, L, b) - px(v, L, a);
            const uy = py(v, L, b) - py(v, L, a);
            const lu = Math.hypot(ux, uy) || 1;
            const wx = px(v, L, cc) - px(v, L, a);
            const wy = py(v, L, cc) - py(v, L, a);
            const dist = (ux * wy - uy * wx) / lu;
            return [Math.abs(dist) - radius(v)];
          });
        } else if (e1.type !== 'line' && e2.type !== 'line') {
          // Curve to curve: centre distance equals the sum or difference of radii.
          const c1 = e1.c;
          const c2 = e2.c;
          const rad = (ent) => {
            if (ent.type === 'circle') {
              const rb = L.radiusBase.get(ent.id);
              return { vars: [rb], fn: (v) => v[rb] };
            }
            const q = ent.p[0];
            return {
              vars: [...pointVars(L, q), ...pointVars(L, ent.c)],
              fn: (v) => Math.hypot(px(v, L, q) - px(v, L, ent.c), py(v, L, q) - py(v, L, ent.c))
            };
          };
          const R1 = rad(e1);
          const R2 = rad(e2);
          const vars = [
            ...pointVars(L, c1), ...pointVars(L, c2), ...R1.vars, ...R2.vars
          ];
          add(vars, (v) => {
            const d = Math.hypot(px(v, L, c1) - px(v, L, c2), py(v, L, c1) - py(v, L, c2));
            const r1 = R1.fn(v);
            const r2 = R2.fn(v);
            const outer = d - (r1 + r2);
            const inner = d - Math.abs(r1 - r2);
            return [Math.abs(outer) < Math.abs(inner) ? outer : inner];
          });
        }
        break;
      }

      case 'midpointOfPair': {
        const [a, b] = c.points;
        const i = c.point;
        const vars = [...pointVars(L, i), ...pointVars(L, a), ...pointVars(L, b)];
        add(vars, (v) => [
          px(v, L, i) - (px(v, L, a) + px(v, L, b)) / 2,
          py(v, L, i) - (py(v, L, a) + py(v, L, b)) / 2
        ]);
        break;
      }

      case 'midpoint': {
        const ent = entityById(sketch, c.entity);
        if (!ent || ent.type !== 'line') break;
        const [a, b] = ent.p;
        const i = c.point;
        const vars = [...pointVars(L, i), ...pointVars(L, a), ...pointVars(L, b)];
        add(vars, (v) => [
          px(v, L, i) - (px(v, L, a) + px(v, L, b)) / 2,
          py(v, L, i) - (py(v, L, a) + py(v, L, b)) / 2
        ]);
        break;
      }

      default:
        break;
    }
  }

  // While dragging, pull the grabbed points toward where the cursor put them,
  // with a soft residual that yields to real constraints instead of fighting
  // them. A whole selection moves as several pulls at once.
  if (dragging) {
    for (const g of Array.isArray(dragging) ? dragging : [dragging]) {
      const i = g.point;
      add(pointVars(L, i), (v) => [
        (px(v, L, i) - g.x) * 1,
        (py(v, L, i) - g.y) * 1
      ], 0.35);
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Dense linear algebra                                                */
/* ------------------------------------------------------------------ */

/** Solve (A + lambda*I) x = b for symmetric positive semi-definite A. */
function solveDamped(A, b, n, lambda) {
  const M = new Float64Array(n * n);
  M.set(A);
  for (let i = 0; i < n; i++) M[i * n + i] += lambda;

  const x = new Float64Array(b);
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;

  for (let col = 0; col < n; col++) {
    let best = col;
    let bestVal = Math.abs(M[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(M[r * n + col]);
      if (val > bestVal) {
        bestVal = val;
        best = r;
      }
    }
    if (bestVal < 1e-14) continue;
    if (best !== col) {
      for (let k = 0; k < n; k++) {
        const t = M[col * n + k];
        M[col * n + k] = M[best * n + k];
        M[best * n + k] = t;
      }
      const t = x[col];
      x[col] = x[best];
      x[best] = t;
    }
    const piv = M[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col] / piv;
      if (f === 0) continue;
      for (let k = col; k < n; k++) M[r * n + k] -= f * M[col * n + k];
      x[r] -= f * x[col];
    }
  }

  for (let row = n - 1; row >= 0; row--) {
    const piv = M[row * n + row];
    if (Math.abs(piv) < 1e-14) {
      x[row] = 0;
      continue;
    }
    let s = x[row];
    for (let k = row + 1; k < n; k++) s -= M[row * n + k] * x[k];
    x[row] = s / piv;
  }
  return x;
}

/* ------------------------------------------------------------------ */
/* Solve                                                               */
/* ------------------------------------------------------------------ */

function evaluate(residuals, v) {
  const rows = [];
  for (const r of residuals) {
    const vals = r.fn(v);
    for (const val of vals) rows.push({ val, weight: r.weight, res: r });
  }
  return rows;
}

/**
 * Solve a sketch in place.
 * Returns { ok, iterations, error, dof }.
 */
export function solveSketch(sketch, opts = {}) {
  const layout = buildLayout(sketch);
  if (layout.size === 0) return { ok: true, iterations: 0, error: 0, dof: 0 };

  const residuals = buildResiduals(sketch, layout, opts);
  if (residuals.length === 0) {
    return { ok: true, iterations: 0, error: 0, dof: layout.size };
  }

  const n = layout.size;
  let v = packVars(sketch, layout);
  const maxIter = opts.maxIterations || 60;
  // Tolerance is on the residual itself. Comparing it against the summed
  // squares instead would stop the solve while dimensions were still tens of
  // microns out, because squaring a small number flatters it.
  const tol = opts.tolerance || 1e-10;
  let lambda = 1e-6;
  let iterations = 0;
  let err = Infinity;

  const cost = (vec) => {
    let s = 0;
    for (const r of residuals) {
      const w = r.weight;
      for (const val of r.fn(vec)) s += w * w * val * val;
    }
    return s;
  };

  err = cost(v);

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    if (Math.sqrt(err) < tol) break;

    // Build J^T J and J^T r sparsely: each residual only touches its own vars.
    const JtJ = new Float64Array(n * n);
    const Jtr = new Float64Array(n);

    for (const r of residuals) {
      const base = r.fn(v);
      const m = base.length;
      const vars = r.vars;
      const grads = [];
      for (let k = 0; k < m; k++) grads.push(new Float64Array(vars.length));

      for (let a = 0; a < vars.length; a++) {
        const vi = vars[a];
        const h = stepFor(v[vi]);
        const saved = v[vi];
        v[vi] = saved + h;
        const plus = r.fn(v);
        v[vi] = saved - h;
        const minus = r.fn(v);
        v[vi] = saved;
        for (let k = 0; k < m; k++) grads[k][a] = (plus[k] - minus[k]) / (2 * h);
      }

      const w2 = r.weight * r.weight;
      for (let k = 0; k < m; k++) {
        const g = grads[k];
        const rk = base[k];
        for (let a = 0; a < vars.length; a++) {
          const ia = vars[a];
          Jtr[ia] += w2 * g[a] * rk;
          for (let b = 0; b < vars.length; b++) {
            JtJ[ia * n + vars[b]] += w2 * g[a] * g[b];
          }
        }
      }
    }

    let improved = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const neg = new Float64Array(n);
      for (let i = 0; i < n; i++) neg[i] = -Jtr[i];
      const step = solveDamped(JtJ, neg, n, lambda);

      const trial = new Float64Array(v);
      for (let i = 0; i < n; i++) trial[i] += step[i];

      const trialErr = cost(trial);
      if (trialErr < err) {
        v = trial;
        err = trialErr;
        lambda = Math.max(lambda * 0.4, 1e-9);
        improved = true;
        break;
      }
      lambda *= 6;
    }
    if (!improved) break;
  }

  unpackVars(sketch, layout, v);

  const { dof, movable } = analyseFreedom(sketch, layout, residuals, v);
  const residual = Math.sqrt(err);
  return {
    ok: residual < 1e-6,
    iterations,
    error: residual,
    dof,
    movable,
    layout,
    constrained: entityFreedom(sketch, layout, movable)
  };
}

/**
 * Which variables can still move, and how many independent ways there are to
 * move them.
 *
 * Counting rank alone answers "is the sketch finished" but not "which bits of
 * it are loose", and the second question is the useful one while drawing. So
 * the Jacobian is reduced fully and the null space read off it: a variable is
 * loose if it appears in any null-space direction, which includes variables
 * that only move in response to something else being dragged.
 */
function analyseFreedom(sketch, layout, residuals, v) {
  const n = layout.size;
  const rows = [];
  for (const r of residuals) {
    if (r.weight !== 1) continue; // skip the soft drag pull
    const base = r.fn(v);
    const vars = r.vars;
    const grads = base.map(() => new Float64Array(n));
    for (let a = 0; a < vars.length; a++) {
      const vi = vars[a];
      const h = stepFor(v[vi]);
      const saved = v[vi];
      v[vi] = saved + h;
      const plus = r.fn(v);
      v[vi] = saved - h;
      const minus = r.fn(v);
      v[vi] = saved;
      for (let k = 0; k < base.length; k++) grads[k][vi] = (plus[k] - minus[k]) / (2 * h);
    }
    for (const g of grads) rows.push(g);
  }

  const movable = new Uint8Array(n).fill(1);
  if (!rows.length) return { dof: n, movable };

  // Reduced row echelon form, tracking which column each pivot landed in.
  const pivotOfRow = [];
  let row = 0;
  for (let col = 0; col < n && row < rows.length; col++) {
    let best = 1e-8;
    let pivot = -1;
    for (let r = row; r < rows.length; r++) {
      const val = Math.abs(rows[r][col]);
      if (val > best) {
        best = val;
        pivot = r;
      }
    }
    if (pivot < 0) continue;

    const tmp = rows[row];
    rows[row] = rows[pivot];
    rows[pivot] = tmp;

    const pr = rows[row];
    const pv = pr[col];
    for (let k = col; k < n; k++) pr[k] /= pv;

    for (let r = 0; r < rows.length; r++) {
      if (r === row) continue;
      const f = rows[r][col];
      if (Math.abs(f) < 1e-14) continue;
      for (let k = col; k < n; k++) rows[r][k] -= f * pr[k];
    }

    pivotOfRow.push(col);
    row++;
  }

  const rank = pivotOfRow.length;
  const isPivot = new Uint8Array(n);
  for (const c of pivotOfRow) isPivot[c] = 1;

  // Start from nothing being loose, then mark what the null space can reach.
  movable.fill(0);
  const freeCols = [];
  for (let c = 0; c < n; c++) if (!isPivot[c]) freeCols.push(c);
  for (const c of freeCols) movable[c] = 1;

  for (let r = 0; r < rank; r++) {
    const p = pivotOfRow[r];
    for (const f of freeCols) {
      if (Math.abs(rows[r][f]) > 1e-9) {
        movable[p] = 1;
        break;
      }
    }
  }

  return { dof: Math.max(0, n - rank), movable };
}

/**
 * Split the movable flags per entity, so each curve can be drawn according to
 * whether it is pinned down.
 */
export function entityFreedom(sketch, layout, movable) {
  const out = new Map();
  const pointLoose = (i) => {
    const b = layout.pointBase.get(i);
    if (b === undefined) return true;
    return !!(movable[b] || movable[b + 1]);
  };

  for (const ent of sketch.entities) {
    let loose = false;
    if (ent.type === 'line') {
      loose = pointLoose(ent.p[0]) || pointLoose(ent.p[1]);
    } else if (ent.type === 'circle') {
      const rb = layout.radiusBase.get(ent.id);
      loose = pointLoose(ent.c) || (rb !== undefined && !!movable[rb]);
    } else if (ent.type === 'arc') {
      loose = pointLoose(ent.c) || pointLoose(ent.p[0]) || pointLoose(ent.p[1]);
    } else if (ent.type === 'spline' || ent.type === 'bspline') {
      loose = ent.p.some(pointLoose);
    } else if (ent.type === 'conic') {
      loose = ent.p.some(pointLoose) || pointLoose(ent.v);
    } else if (ent.type === 'ellipse') {
      loose = pointLoose(ent.c) || pointLoose(ent.a) || pointLoose(ent.b);
    } else if (ent.type === 'point' || ent.type === 'text') {
      // Text carries its outlines itself and is placed by a single point, so
      // one letter does not cost the solver two variables per outline point.
      loose = pointLoose(ent.p);
    }
    out.set(ent.id, !loose);
  }
  return out;
}

export { EPS };
