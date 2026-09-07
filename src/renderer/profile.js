/**
 * Sketch geometry: tessellation, closed-region finding, containment nesting.
 *
 * Region finding uses planar half-edge face traversal. Every bounded face of
 * the sketch graph becomes a candidate profile, and faces nested directly
 * inside another become its holes. That gives the same behaviour as picking a
 * region in Fusion: a rectangle with a circle inside offers both the pierced
 * plate and the disc as separate profiles.
 */

const TAU = Math.PI * 2;

/**
 * Curve quality, and the single source of it for the whole application.
 *
 * Sketch curves are turned into polygons here, while cylinders, spheres and
 * revolves are tessellated inside the kernel. Any disagreement between the two
 * leaves slivers along every boolean between them, so the kernel is configured
 * from these same numbers and the segment count is computed by the kernel's own
 * rule rather than an equivalent-looking one.
 *
 * The angle bound governs small radii, the edge length bound governs large
 * ones. At six degrees a 7 mm hole is out by ten microns, well under what a
 * filament printer resolves.
 */
export const MIN_CIRCULAR_ANGLE = 6; // degrees between facets
export const MIN_CIRCULAR_EDGE = 0.5; // mm of facet length

/** Segments in a full circle, matching the kernel's Quality rule exactly. */
export function circleSegments(radius) {
  if (!(radius > 0)) return 4;
  const byAngle = 360 / MIN_CIRCULAR_ANGLE;
  const byLength = (2 * radius * Math.PI) / MIN_CIRCULAR_EDGE;
  let n = Math.floor(Math.min(byAngle, byLength)) + 3;
  n -= n % 4;
  // Sixteen at the least. Below that the facets meet at more than the angle a
  // join is still read as a surface, so a very small hole comes back as a ring
  // of flat faces rather than as a bore, and it is not round enough to print
  // to a screw anyway.
  return Math.max(n, 16);
}

export function arcSegments(radius, sweep) {
  if (radius <= 0) return 2;
  const full = circleSegments(radius);
  const n = Math.ceil((Math.abs(sweep) / TAU) * full);
  return Math.max(2, Math.min(512, n));
}

export function normalizeAngle(a) {
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
}

/* ------------------------------------------------------------------ */
/* Tessellation                                                        */
/* ------------------------------------------------------------------ */

/** The two ends of a curve, whatever kind it is. */
export function entityEndpoints(ent) {
  if (ent.type === 'line' || ent.type === 'arc') return [ent.p[0], ent.p[1]];
  if (ent.type === 'conic') return [ent.p[0], ent.p[1]];
  if (ent.type === 'spline' || ent.type === 'bspline') {
    return [ent.p[0], ent.p[ent.p.length - 1]];
  }
  return null;
}

/**
 * A curve through a set of points, using centripetal Catmull-Rom.
 *
 * The centripetal parameterisation is the one worth having: the uniform and
 * chordal versions both loop or cusp when control points bunch up, which is
 * exactly what happens when someone drags one spline point onto another.
 */
function splinePoints(pts, closed, segmentsPer = 16) {
  const n = pts.length;
  // A point that carries a third coordinate keeps it all the way through. The
  // curve is the same formula per component, so a 3D sketch needs no second
  // evaluator, and a flat sketch is untouched because its z is simply zero.
  const flat = (p) => ({ x: p.x, y: p.y, z: p.z || 0 });
  if (n < 2) return pts.map(flat);
  if (n === 2 && !closed) return [flat(pts[0]), flat(pts[1])];

  const at = (i) => {
    if (closed) return pts[((i % n) + n) % n];
    return pts[Math.max(0, Math.min(n - 1, i))];
  };

  const out = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);

    const t = [0, 0, 0, 0];
    for (let k = 1; k < 4; k++) {
      const a = [p0, p1, p2, p3][k - 1];
      const b = [p0, p1, p2, p3][k];
      const d = Math.hypot(b.x - a.x, b.y - a.y, (b.z || 0) - (a.z || 0));
      t[k] = t[k - 1] + Math.sqrt(d) || t[k - 1] + 1e-6;
    }

    for (let s = 0; s < segmentsPer; s++) {
      const u = t[1] + ((t[2] - t[1]) * s) / segmentsPer;
      const A1 = lerpPt(p0, p1, t[0], t[1], u);
      const A2 = lerpPt(p1, p2, t[1], t[2], u);
      const A3 = lerpPt(p2, p3, t[2], t[3], u);
      const B1 = lerpPt(A1, A2, t[0], t[2], u);
      const B2 = lerpPt(A2, A3, t[1], t[3], u);
      out.push(lerpPt(B1, B2, t[1], t[2], u));
    }
  }
  if (!closed) out.push(flat(pts[n - 1]));
  else out.push({ x: out[0].x, y: out[0].y, z: out[0].z || 0 });
  return out;
}

function lerpPt(a, b, ta, tb, u) {
  const d = tb - ta;
  const f = Math.abs(d) < 1e-12 ? 0 : (u - ta) / d;
  const az = a.z || 0;
  const bz = b.z || 0;
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    z: az + (bz - az) * f
  };
}

/** Sample an entity into an ordered list of {x,y} from its start to its end. */
export function tessellate(sketch, ent) {
  const P = sketch.points;

  if (ent.type === 'spline') {
    const pts = ent.p.map((i) => P[i]).filter(Boolean);
    if (pts.length < 2) return [];
    return splinePoints(pts, !!ent.closed);
  }

  if (ent.type === 'line') {
    const a = P[ent.p[0]];
    const b = P[ent.p[1]];
    return [
      { x: a.x, y: a.y, z: a.z || 0 },
      { x: b.x, y: b.y, z: b.z || 0 }
    ];
  }

  if (ent.type === 'circle') {
    const c = P[ent.c];
    const n = arcSegments(ent.r, TAU);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * TAU;
      pts.push({ x: c.x + ent.r * Math.cos(t), y: c.y + ent.r * Math.sin(t) });
    }
    pts.push({ x: pts[0].x, y: pts[0].y });
    return pts;
  }

  if (ent.type === 'ellipse') {
    return ellipsePoints(sketch, ent);
  }

  if (ent.type === 'conic') {
    return conicPoints(sketch, ent);
  }

  if (ent.type === 'bspline') {
    const pts = ent.p.map((i) => P[i]).filter(Boolean);
    if (pts.length < 2) return [];
    return bsplinePoints(pts, !!ent.closed);
  }

  if (ent.type === 'text') {
    // Text is many loops, not one curve. `entityLoops` is what draws it and
    // what findRegions walks; returning a single run here would draw a line
    // from the end of one letter to the start of the next.
    return [];
  }

  if (ent.type === 'arc') {
    const c = P[ent.c];
    const a = P[ent.p[0]];
    const b = P[ent.p[1]];
    const r = Math.hypot(a.x - c.x, a.y - c.y);
    let a0 = Math.atan2(a.y - c.y, a.x - c.x);
    let a1 = Math.atan2(b.y - c.y, b.x - c.x);
    let sweep;
    if (ent.ccw === false) {
      sweep = a1 - a0;
      while (sweep > 0) sweep -= TAU;
      if (sweep === 0) sweep = -TAU;
    } else {
      sweep = a1 - a0;
      while (sweep < 0) sweep += TAU;
      if (sweep === 0) sweep = TAU;
    }
    const n = arcSegments(r, sweep);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = a0 + (sweep * i) / n;
      pts.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
    }
    return pts;
  }

  return [];
}

/** The ellipse's own frame, worked out from the three points that carry it. */
export function ellipseFrame(sketch, ent) {
  const P = sketch.points;
  const c = P[ent.c];
  const a = P[ent.a];
  const b = P[ent.b];
  if (!c || !a || !b) return null;
  const ux = a.x - c.x;
  const uy = a.y - c.y;
  const rx = Math.hypot(ux, uy);
  if (rx < 1e-9) return null;
  const nx = ux / rx;
  const ny = uy / rx;
  // Only the part of the minor point square to the major axis counts, so
  // dragging it does not shear the ellipse or fight the major axis for length.
  const ry = Math.abs(-(b.x - c.x) * ny + (b.y - c.y) * nx);
  return { cx: c.x, cy: c.y, rx, ry: ry < 1e-9 ? rx * 1e-6 : ry, nx, ny };
}

function ellipsePoints(sketch, ent) {
  const f = ellipseFrame(sketch, ent);
  if (!f) return [];
  const n = arcSegments(Math.max(f.rx, f.ry), TAU);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    const px = f.rx * Math.cos(t);
    const py = f.ry * Math.sin(t);
    pts.push({
      x: f.cx + px * f.nx - py * f.ny,
      y: f.cy + px * f.ny + py * f.nx
    });
  }
  pts.push({ x: pts[0].x, y: pts[0].y });
  return pts;
}

/**
 * Every closed loop an entity contributes, or null if it is not that kind of
 * thing. Most entities are one curve; text is a loop per letter and more than
 * one for a letter with a counter in it, so the display and the region finder
 * both go through here rather than assuming a single run of points.
 */
export function entityLoops(sketch, ent) {
  if (ent.type === 'text') {
    const o = sketch.points[ent.p];
    if (!o || !ent.contours?.length) return [];
    const th = ((ent.angle || 0) * Math.PI) / 180;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    return ent.contours.map((loop) =>
      loop.map((q) => ({
        x: o.x + q.x * cs - q.y * sn,
        y: o.y + q.x * sn + q.y * cs
      }))
    );
  }
  if (ent.type === 'ellipse') {
    const pts = ellipsePoints(sketch, ent);
    return pts.length >= 4 ? [pts] : [];
  }
  if (ent.type === 'circle') return [tessellate(sketch, ent)];
  if ((ent.type === 'spline' || ent.type === 'bspline') && ent.closed) {
    return [tessellate(sketch, ent)];
  }
  return null;
}

/**
 * Every run of points an entity draws as, one for an ordinary curve and one per
 * loop for text. Drawing, picking and box selection all go through this, so a
 * multi-loop entity is not silently reduced to its first loop.
 */
export function entityRuns(sketch, ent) {
  const loops = entityLoops(sketch, ent);
  if (loops) return loops;
  const pts = tessellate(sketch, ent);
  return pts.length ? [pts] : [];
}

/**
 * A conic arc, as a rational quadratic Bezier.
 *
 * Three points and one number describe every conic anyone draws: the two ends,
 * the vertex where their tangents meet, and rho, which says how far out towards
 * that vertex the curve bulges. Rho is measured from the middle of the chord,
 * so 0.5 puts the curve exactly halfway to the vertex and gives a parabola,
 * below that is an ellipse and above it a hyperbola. That is the same
 * convention every other CAD package uses, so a number carried over from one
 * means the same shape here.
 */
export function conicPoints(sketch, ent) {
  const P = sketch.points;
  const a = P[ent.p[0]];
  const b = P[ent.p[1]];
  const v = P[ent.v];
  if (!a || !b || !v) return [];

  const rho = Math.min(0.95, Math.max(0.05, Number(ent.rho) || 0.5));
  const w = rho / (1 - rho);

  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  const reach = Math.hypot(v.x - (a.x + b.x) / 2, v.y - (a.y + b.y) / 2);
  const n = Math.max(12, Math.min(180, circleSegments(Math.max(chord, reach) / 2)));

  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const k0 = u * u;
    const k1 = 2 * u * t * w;
    const k2 = t * t;
    const d = k0 + k1 + k2;
    pts.push({
      x: (k0 * a.x + k1 * v.x + k2 * b.x) / d,
      y: (k0 * a.y + k1 * v.y + k2 * b.y) / d
    });
  }
  return pts;
}

/**
 * A cubic B-spline through control points, clamped at both ends.
 *
 * Unlike the fit-point spline this does not pass through its points, it is
 * pulled towards them, which is the other of the two things "spline" means in
 * CAD and the one that behaves well when a point is dragged hard. Clamping the
 * knots is what makes it start and end exactly on the first and last control
 * point, so it has real endpoints for a region to close on.
 */
export function bsplinePoints(ctrl, closed, perSpan = 12) {
  const pts = closed ? [...ctrl, ctrl[0], ctrl[1], ctrl[2]] : ctrl;
  const n = pts.length;
  if (n < 3) return pts.map((p) => ({ x: p.x, y: p.y }));

  // Clamped uniform knots: the first and last repeated so the ends are pinned.
  const deg = 3;
  const knots = [];
  const m = n + deg + 1;
  for (let i = 0; i < m; i++) {
    if (closed) knots.push(i);
    else if (i <= deg) knots.push(0);
    else if (i >= n) knots.push(n - deg);
    else knots.push(i - deg);
  }

  const t0 = knots[deg];
  const t1 = knots[n];
  const steps = Math.max(8, Math.min(600, perSpan * (n - deg)));
  const out = [];
  for (let s = 0; s <= steps; s++) {
    const t = t0 + ((t1 - t0) * s) / steps;
    out.push(deBoor(t, pts, knots, deg));
  }
  if (closed) out.push({ x: out[0].x, y: out[0].y });
  return out;
}

function deBoor(t, pts, knots, deg) {
  const n = pts.length;
  let k = deg;
  while (k < n - 1 && t >= knots[k + 1]) k++;

  const d = [];
  for (let j = 0; j <= deg; j++) {
    const idx = Math.min(n - 1, Math.max(0, k - deg + j));
    d.push({ x: pts[idx].x, y: pts[idx].y });
  }
  for (let r = 1; r <= deg; r++) {
    for (let j = deg; j >= r; j--) {
      const lo = knots[k - deg + j];
      const hi = knots[k + 1 + j - r];
      const span = hi - lo;
      const a = span > 1e-12 ? (t - lo) / span : 0;
      d[j] = {
        x: (1 - a) * d[j - 1].x + a * d[j].x,
        y: (1 - a) * d[j - 1].y + a * d[j].y
      };
    }
  }
  return d[deg];
}

/** Tangent direction leaving `endpoint` (0 = start, 1 = end) of an entity. */
function tangentAt(sketch, ent, fromStart) {
  const pts = tessellate(sketch, ent);
  if (pts.length < 2) return { x: 1, y: 0 };
  if (fromStart) {
    return { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y };
  }
  const n = pts.length;
  return { x: pts[n - 2].x - pts[n - 1].x, y: pts[n - 2].y - pts[n - 1].y };
}

/* ------------------------------------------------------------------ */
/* Polygon helpers                                                     */
/* ------------------------------------------------------------------ */

export function signedArea(poly) {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y)) {
      const x = ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
      if (pt.x < x) inside = !inside;
    }
  }
  return inside;
}

/** A point guaranteed to lie inside a simple polygon. */
export function interiorPoint(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const c = poly[(i + 2) % n];
    const mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
    if (pointInPolygon(mid, poly)) return mid;
    const nudge = { x: (mid.x + b.x) / 2, y: (mid.y + b.y) / 2 };
    if (pointInPolygon(nudge, poly)) return nudge;
  }
  // Fall back to the centroid, which is inside for convex shapes.
  let sx = 0;
  let sy = 0;
  for (const p of poly) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / n, y: sy / n };
}

function dedupe(poly, tol = 1e-7) {
  const out = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > tol) out.push(p);
  }
  while (
    out.length > 1 &&
    Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= tol
  ) {
    out.pop();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Region finding                                                      */
/* ------------------------------------------------------------------ */

/**
 * Find every closed region in a sketch.
 *
 * Returns an array of regions:
 *   { id, outer: [{x,y}...], holes: [[{x,y}...]], area, entities: Set<entityId> }
 */
export function findRegions(sketch) {
  // A three dimensional sketch closes no regions: a loop that leaves its plane
  // bounds nothing, and treating its points as flat would invent a profile
  // that is not there.
  if (sketch.is3d) return [];
  const solids = sketch.entities.filter((e) => !e.construction);
  const regions = [];

  // Self-closed curves are regions on their own: a full circle, and a spline
  // whose ends are the same point. Neither has two ends for the graph walk to
  // join up, so they never take part in it.
  const closed = solids.filter(
    (e) =>
      e.type === 'circle' ||
      e.type === 'ellipse' ||
      e.type === 'text' ||
      ((e.type === 'spline' || e.type === 'bspline') && e.closed)
  );
  for (const ent of closed) {
    // Called through a lambda on purpose: `map(dedupe)` hands the array index
    // in as the tolerance, so every loop after the first is welded at 1 mm,
    // 2 mm, 3 mm and a small counter disappears outright.
    const loops = (entityLoops(sketch, ent) || [])
      .map((poly) => dedupe(poly))
      .filter((poly) => poly.length >= 3);
    if (!loops.length) continue;

    if (loops.length === 1) {
      let poly = loops[0];
      if (signedArea(poly) < 0) poly = poly.reverse();
      regions.push({
        id: `c:${ent.id}`,
        outer: poly,
        holes: [],
        entities: new Set([ent.id])
      });
      continue;
    }

    // Loops that came from one entity are one shape, not several that happen
    // to sit inside each other. A letter's counter has to be a hole in it, not
    // a profile of its own; leaving it to the general nesting pass below makes
    // it both, and extruding the whole sketch then fills every O back in.
    //
    // Even-odd, the same rule a font itself is filled by: a loop inside an odd
    // number of the others is a hole, and it belongs to the smallest loop that
    // contains it.
    const ranked = loops
      .map((poly) => ({ poly, area: Math.abs(signedArea(poly)), sample: interiorPoint(poly) }))
      .sort((a, b) => b.area - a.area);

    const depthOf = (loop) =>
      ranked.filter((o) => o !== loop && o.area > loop.area && pointInPolygon(loop.sample, o.poly))
        .length;

    const owners = [];
    for (const loop of ranked) {
      if (depthOf(loop) % 2 === 0) {
        let outer = loop.poly;
        if (signedArea(outer) < 0) outer = [...outer].reverse();
        const region = {
          id: `c:${ent.id}:${owners.length}`,
          outer,
          holes: [],
          entities: new Set([ent.id])
        };
        owners.push({ region, loop });
        regions.push(region);
      } else {
        // The smallest containing outer, so a counter inside a letter inside a
        // ring lands on the letter rather than on the ring.
        let best = null;
        for (const o of owners) {
          if (!pointInPolygon(loop.sample, o.loop.poly)) continue;
          if (!best || o.loop.area < best.loop.area) best = o;
        }
        if (!best) continue;
        let hole = loop.poly;
        if (signedArea(hole) > 0) hole = [...hole].reverse();
        best.region.holes.push(hole);
      }
    }
  }

  // Everything with two distinct ends forms a graph traversed for planar faces.
  const open = solids.filter(
    (e) =>
      entityEndpoints(e) &&
      !((e.type === 'spline' || e.type === 'bspline') && e.closed)
  );
  if (open.length) {
    regions.push(...traverseFaces(sketch, open));
  }

  // Nest: a region directly inside another becomes that one's hole.
  for (const r of regions) {
    r.area = Math.abs(signedArea(r.outer));
    r.sample = interiorPoint(r.outer);
  }
  regions.sort((a, b) => b.area - a.area);

  const parentOf = new Map();
  for (let i = 0; i < regions.length; i++) {
    for (let j = 0; j < i; j++) {
      if (!pointInPolygon(regions[i].sample, regions[j].outer)) continue;
      // Already a hole in the enclosing region, so it is beside it rather than
      // inside it: two letters of the same run must not swallow one another.
      if (regions[j].holes.some((h) => pointInPolygon(regions[i].sample, h))) continue;
      parentOf.set(regions[i], regions[j]);
    }
  }
  // parentOf now holds the smallest enclosing region because of the sort order.

  for (const [child, parent] of parentOf) {
    let hole = child.outer;
    if (signedArea(hole) > 0) hole = [...hole].reverse();
    parent.holes.push(hole);
    for (const e of child.entities) parent.entities.add(e);
  }

  return regions.filter((r) => r.area > 1e-9);
}

function traverseFaces(sketch, entities) {
  // Weld endpoints that coincide so shared corners join up.
  const P = sketch.points;
  const nodeOf = new Map();
  const nodes = [];
  const keyOf = (idx) => {
    const p = P[idx];
    return `${Math.round(p.x * 1e6)}|${Math.round(p.y * 1e6)}`;
  };
  const nodeFor = (idx) => {
    const k = keyOf(idx);
    if (!nodeOf.has(k)) {
      nodeOf.set(k, nodes.length);
      nodes.push({ x: P[idx].x, y: P[idx].y, edges: [] });
    }
    return nodeOf.get(k);
  };

  const half = [];
  for (const ent of entities) {
    const ends = entityEndpoints(ent);
    if (!ends) continue;
    const a = nodeFor(ends[0]);
    const b = nodeFor(ends[1]);
    if (a === b) continue;
    const pts = dedupe(tessellate(sketch, ent));
    if (pts.length < 2) continue;

    const fwd = {
      id: half.length,
      ent: ent.id,
      from: a,
      to: b,
      pts,
      dir: tangentAt(sketch, ent, true)
    };
    half.push(fwd);
    const rev = {
      id: half.length,
      ent: ent.id,
      from: b,
      to: a,
      pts: [...pts].reverse(),
      dir: tangentAt(sketch, ent, false)
    };
    half.push(rev);
    fwd.twin = rev.id;
    rev.twin = fwd.id;
    nodes[a].edges.push(fwd.id);
    nodes[b].edges.push(rev.id);
  }

  // Sort the half-edges leaving each node by outgoing angle.
  for (const node of nodes) {
    node.edges.sort((p, q) => {
      const ep = half[p];
      const eq = half[q];
      return Math.atan2(ep.dir.y, ep.dir.x) - Math.atan2(eq.dir.y, eq.dir.x);
    });
  }

  const nextAround = (heId) => {
    // Arrive along heId, leave along the neighbour clockwise from its twin.
    const he = half[heId];
    const twin = half[he.twin];
    const ring = nodes[twin.from].edges;
    const at = ring.indexOf(he.twin);
    const nextIdx = (at - 1 + ring.length) % ring.length;
    return ring[nextIdx];
  };

  const visited = new Set();
  const faces = [];
  for (const he of half) {
    if (visited.has(he.id)) continue;
    const loop = [];
    let cur = he.id;
    let guard = 0;
    while (!visited.has(cur) && guard++ < half.length * 4) {
      visited.add(cur);
      loop.push(cur);
      cur = nextAround(cur);
    }
    if (loop.length < 2) continue;

    const poly = [];
    const used = new Set();
    for (const id of loop) {
      const e = half[id];
      used.add(e.ent);
      for (let i = 0; i < e.pts.length - 1; i++) poly.push(e.pts[i]);
    }
    const clean = dedupe(poly);
    if (clean.length < 3) continue;
    const area = signedArea(clean);
    // The unbounded face traverses clockwise; drop it.
    if (area <= 1e-9) continue;
    faces.push({
      id: `f:${loop.slice().sort((a, b) => a - b).join('-')}`,
      outer: clean,
      holes: [],
      entities: used
    });
  }
  return faces;
}

/**
 * Walk a sketch's curves into one ordered polyline.
 *
 * Sweep and rib take a path rather than an area, so the curves have to be put
 * in order and pointed the same way. Chains that do not close start from a free
 * end; closed ones start anywhere.
 */
export function chainPath(sketch, opts = {}) {
  const wanted = sketch.entities.filter((e) => {
    if (!entityEndpoints(e)) return false;
    if (opts.entities && !opts.entities.includes(e.id)) return false;
    if (!opts.includeConstruction && e.construction) return false;
    return true;
  });
  if (!wanted.length) return null;

  const degree = new Map();
  const bump = (i) => degree.set(i, (degree.get(i) || 0) + 1);
  for (const e of wanted) {
    const [a, b] = entityEndpoints(e);
    bump(a);
    bump(b);
  }

  let start = null;
  for (const [idx, count] of degree) {
    if (count === 1) {
      start = idx;
      break;
    }
  }
  const closed = start === null;
  if (closed) start = wanted[0].p[0];

  const unused = new Set(wanted.map((e) => e.id));
  const points = [];
  let current = start;
  let guard = 0;

  while (unused.size && guard++ < wanted.length + 2) {
    const next = wanted.find((e) => {
      if (!unused.has(e.id)) return false;
      const [a, b] = entityEndpoints(e);
      return a === current || b === current;
    });
    if (!next) break;
    unused.delete(next.id);
    const [na, nb] = entityEndpoints(next);

    let pts = tessellate(sketch, next);
    if (nb === current && na !== current) pts = [...pts].reverse();
    else if (na !== current) break;

    if (points.length) pts = pts.slice(1);
    points.push(...pts);
    current = na === current ? nb : na;
  }

  if (points.length < 2) return null;
  return { points, closed: closed && points.length > 2 };
}

/**
 * Give a polyline width: offset it to both sides and close the result.
 *
 * Corners are mitred, with the mitre clamped so a sharp turn produces a
 * blunted corner rather than a spike shooting off to infinity.
 */
export function thickenPolyline(points, halfWidth, closed) {
  const pts = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-9) pts.push(p);
  }
  if (closed && pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) pts.pop();
  }
  if (pts.length < 2) return null;

  const n = pts.length;
  const MITRE_LIMIT = 4;

  const offsetSide = (sign) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const next = pts[(i + 1) % n];

      const hasPrev = closed || i > 0;
      const hasNext = closed || i < n - 1;

      const dIn = hasPrev ? unit(cur.x - prev.x, cur.y - prev.y) : null;
      const dOut = hasNext ? unit(next.x - cur.x, next.y - cur.y) : null;
      const d = dIn && dOut ? unit(dIn.x + dOut.x, dIn.y + dOut.y) : dIn || dOut;
      if (!d) continue;

      let nx = -d.y * sign;
      let ny = d.x * sign;

      let scale = 1;
      if (dIn && dOut) {
        const cosHalf = Math.sqrt(
          Math.max(0, (1 + (dIn.x * dOut.x + dIn.y * dOut.y)) / 2)
        );
        scale = cosHalf > 1e-6 ? Math.min(1 / cosHalf, MITRE_LIMIT) : MITRE_LIMIT;
      }
      out.push([cur.x + nx * halfWidth * scale, cur.y + ny * halfWidth * scale]);
    }
    return out;
  };

  const left = offsetSide(1);
  const right = offsetSide(-1);
  if (left.length < 2 || right.length < 2) return null;

  if (closed) {
    // A closed path gives a ring: the two offsets are its outer and inner edge.
    const outer = signedArea(left.map(([x, y]) => ({ x, y }))) > 0 ? left : [...left].reverse();
    const inner = signedArea(right.map(([x, y]) => ({ x, y }))) > 0 ? [...right].reverse() : right;
    return [outer, inner];
  }

  return [[...left, ...right.reverse()]];
}

function unit(x, y) {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

/**
 * A sketch with its projected geometry folded in.
 *
 * Projected curves are regenerated from the model on every rebuild rather than
 * copied once, so they follow what they were traced from. They are kept out of
 * the sketch's own arrays and merged into a throwaway copy here, because the
 * editor's points are addressed by index and inserting into that list would
 * renumber everything the constraints refer to.
 */
export function materializeSketch(sketch, projected) {
  if (!projected || !projected.entities?.length) return sketch;

  const base = sketch.points.length;
  const points = sketch.points.concat(projected.points);
  const entities = sketch.entities.concat(
    projected.entities.map((e) => {
      const copy = { ...e, projected: true };
      if (e.type === 'line') copy.p = [e.p[0] + base, e.p[1] + base];
      else if (e.type === 'circle') copy.c = e.c + base;
      else if (e.type === 'arc') {
        copy.c = e.c + base;
        copy.p = [e.p[0] + base, e.p[1] + base];
      } else if (e.type === 'spline' || e.type === 'bspline') {
        copy.p = e.p.map((i) => i + base);
      } else if (e.type === 'conic') {
        copy.p = [e.p[0] + base, e.p[1] + base];
        copy.v = e.v + base;
      }
      else if (e.type === 'ellipse') {
        copy.c = e.c + base;
        copy.a = e.a + base;
        copy.b = e.b + base;
      } else if (e.type === 'point' || e.type === 'text') copy.p = e.p + base;
      return copy;
    })
  );

  return { ...sketch, points, entities };
}

/** Convert a region to manifold's polygon input: [outer, ...holes]. */
export function regionToPolygons(region) {
  const contours = [];
  let outer = region.outer;
  if (signedArea(outer) < 0) outer = [...outer].reverse();
  contours.push(outer.map((p) => [p.x, p.y]));
  for (const h of region.holes) {
    let hole = h;
    if (signedArea(hole) > 0) hole = [...hole].reverse();
    contours.push(hole.map((p) => [p.x, p.y]));
  }
  return contours;
}

export { TAU };
