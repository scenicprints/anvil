/**
 * Blend Curve: the spline that joins the loose ends of two curves.
 *
 * The reason this is its own file is that the interesting part is not the
 * drawing. It is deciding where the control points go so that the join does not
 * show. Tangent continuity is easy and is what most packages stop at, and it is
 * not enough: two arcs joined tangentially still have a visible break in a
 * reflection, because the curvature jumps across the seam. Curvature continuity
 * removes that, and it is the reason to have this command at all rather than
 * drawing a spline by eye.
 *
 * The curve produced is a clamped cubic B-spline, which is what a sketch here
 * already knows how to hold, draw, solve and cut regions from. With four
 * control points that is exactly a cubic Bezier; with six there is enough
 * freedom at each end to set the curvature there as well.
 */

import { bsplinePoints } from './profile.js';
import { tessellate } from './profile.js';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
const len = (a) => Math.hypot(a.x, a.y);
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dot = (a, b) => a.x * b.x + a.y * b.y;
const unit = (a) => {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};
/** A quarter turn to the left, which is the direction positive curvature bends. */
const leftOf = (t) => ({ x: -t.y, y: t.x });

/** Signed curvature of the circle through three points, travelling a to c. */
export function curvatureThrough(a, b, c) {
  const ab = len(sub(b, a));
  const bc = len(sub(c, b));
  const ca = len(sub(a, c));
  const denom = ab * bc * ca;
  if (denom < 1e-15) return 0;
  return (2 * cross(sub(b, a), sub(c, a))) / denom;
}

/**
 * Where a curve ends, which way it is heading, and how hard it is turning.
 *
 * The tangent points away from the curve, out into the gap the blend has to
 * cross, and the curvature is measured travelling that way. Both are what the
 * blend needs to match, and taking them in the blend's own direction of travel
 * means no sign has to be flipped later.
 *
 * Lines, circles and arcs are answered exactly rather than sampled, because
 * three points off a tessellation of an arc give its curvature to about a part
 * in a thousand and a blend built on that has a visible kink.
 */
export function endFrame(sketch, ent, pointIndex) {
  if (!sketch || !ent) return null;
  const P = sketch.points;
  const at = P[pointIndex];
  if (!at) return null;

  if (ent.type === 'line') {
    const [a, b] = ent.p;
    const other = a === pointIndex ? P[b] : P[a];
    if (!other || (a !== pointIndex && b !== pointIndex)) return null;
    return { p: { x: at.x, y: at.y }, t: unit(sub(at, other)), k: 0 };
  }

  if (ent.type === 'arc') {
    const c = P[ent.c];
    if (!c) return null;
    const r = len(sub(at, c));
    if (r < 1e-9) return null;
    // Which way round the arc runs decides which way it leaves this end.
    const outward = ent.p[1] === pointIndex ? (ent.ccw === false ? -1 : 1) : ent.ccw === false ? 1 : -1;
    const radial = unit(sub(at, c));
    const t = mul({ x: -radial.y, y: radial.x }, outward);
    // The centre is on the inside of the turn, so which side of the tangent it
    // falls on is the sign of the curvature.
    const k = dot(unit(sub(c, at)), leftOf(t)) / r;
    return { p: { x: at.x, y: at.y }, t, k };
  }

  // Everything else is read off its own tessellation: splines, conics, and the
  // ellipse, none of which has a curvature worth writing out by hand here.
  const pts = tessellate(sketch, ent);
  if (!pts || pts.length < 3) return null;
  const startClose = len(sub(pts[0], at)) <= len(sub(pts[pts.length - 1], at));
  const run = startClose ? pts.slice(0, 3).reverse() : pts.slice(-3);
  // In travel order towards the end and out.
  const [q0, q1, q2] = run;
  return {
    p: { x: at.x, y: at.y },
    t: unit(sub(q2, q1)),
    k: curvatureThrough(q0, q1, q2)
  };
}

/**
 * The curvature a control polygon actually produces at the end it starts on.
 *
 * Three points on the curve give the circle through them, which is not quite
 * the circle the curve is really turning on: the error falls off with the
 * square of the spacing. Measuring at two spacings and extrapolating removes
 * that term, which takes the reading from a third of a percent out to a few
 * parts in a hundred thousand, and the blend is built on this number.
 */
function startCurvature(ctrl) {
  const pts = bsplinePoints(ctrl, false, 200);
  if (!pts || pts.length < 3) return 0;
  const near = curvatureThrough(pts[0], pts[1], pts[2]);
  if (pts.length < 5) return near;
  const wide = curvatureThrough(pts[0], pts[2], pts[4]);
  return (4 * near - wide) / 3;
}

/** Six control points from the two ends and how far each is pushed sideways. */
function assemble(a, b, d, hA, hB) {
  const side = (f, h) => {
    const c0 = { x: f.p.x, y: f.p.y };
    const c1 = add(c0, mul(f.t, d));
    return [c0, c1, add(add(c1, mul(f.t, d)), mul(leftOf(f.t), h))];
  };
  const head = side(a, hA);
  const tail = side(b, hB);
  return [...head, tail[2], tail[1], tail[0]];
}

/**
 * The sideways offsets that give each end the curvature it was asked for.
 *
 * Each end's first two control points are fixed by where the curve starts and
 * which way it goes. The third is pushed off the tangent, and how far off is
 * what sets the curvature there. A cubic gives that offset as three k d
 * squared, which is where the search starts; the finished curve is a B-spline
 * whose reading near the end is nudged by the control point beyond it, so the
 * guess is corrected against the assembled curve rather than against an
 * idealisation of it.
 */
function solveOffsets(a, b, d) {
  let hA = 3 * a.k * d * d;
  let hB = 3 * b.k * d * d;

  const measure = (h, which) => {
    const ctrl = assemble(a, b, d, which === 'a' ? h : hA, which === 'a' ? hB : h);
    return startCurvature(which === 'a' ? ctrl : ctrl.slice().reverse());
  };

  for (let pass = 0; pass < 3; pass++) {
    for (const which of ['a', 'b']) {
      const want = which === 'a' ? a.k : b.k;
      if (!want) continue;
      let x0 = which === 'a' ? hA : hB;
      let f0 = measure(x0, which) - want;
      let x1 = x0 * 1.05 + d * 1e-4;
      for (let i = 0; i < 8; i++) {
        const f1 = measure(x1, which) - want;
        if (Math.abs(f1) < Math.abs(want) * 1e-6 || Math.abs(f1 - f0) < 1e-18) break;
        const next = x1 - (f1 * (x1 - x0)) / (f1 - f0);
        x0 = x1;
        f0 = f1;
        x1 = next;
      }
      if (which === 'a') hA = x1;
      else hB = x1;
    }
  }
  return assemble(a, b, d, hA, hB);
}

/**
 * The control points of a blend between two curve ends.
 *
 * `bias` scales how far the handles reach. Longer handles hold the incoming
 * direction further into the blend and make it fuller; shorter ones let it
 * turn sooner. A third of the gap is the length that looks like neither.
 */
export function blendControls(a, b, opts = {}) {
  if (!a || !b) return null;
  const gap = len(sub(b.p, a.p));
  if (gap < 1e-9) return null;
  const bias = Number.isFinite(opts.bias) && opts.bias > 0 ? opts.bias : 1;
  const d = (gap / 3) * bias;
  const how = opts.continuity || 'G2';

  if (how === 'G0') {
    // Position only: a straight run between the two ends, which is a blend in
    // the sense that it closes the gap and nothing more.
    return [
      { x: a.p.x, y: a.p.y },
      { x: b.p.x, y: b.p.y }
    ];
  }

  if (how === 'G1') {
    return [
      { x: a.p.x, y: a.p.y },
      add(a.p, mul(a.t, d)),
      add(b.p, mul(b.t, d)),
      { x: b.p.x, y: b.p.y }
    ];
  }

  // Curvature continuous. Six control points, three at each end, of which the
  // third is the one that carries the curvature.
  return solveOffsets(a, b, d);
}

/**
 * What the blend really achieved at its ends, for reporting and for tests.
 *
 * A blend that claims curvature continuity and has not got it is worse than
 * one that never claimed it, so this measures the finished curve rather than
 * trusting the construction.
 */
export function blendReport(ctrl, a, b) {
  const forward = startCurvature(ctrl);
  const back = startCurvature(ctrl.slice().reverse());
  // A clamped B-spline leaves its first control point along the line to its
  // second, exactly, so that is the tangent to report rather than the direction
  // of a short chord of the drawn curve.
  const tA = unit(sub(ctrl[1], ctrl[0]));
  const tB = unit(sub(ctrl[ctrl.length - 2], ctrl[ctrl.length - 1]));
  return {
    curvatureA: forward,
    curvatureB: back,
    wantA: a.k,
    wantB: b.k,
    tangentA: dot(tA, a.t),
    tangentB: dot(tB, b.t)
  };
}
