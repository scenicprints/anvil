/**
 * Fillet and chamfer on selected model edges.
 *
 * A mesh kernel has no rolling-ball operator, so the tool geometry is built
 * explicitly: the corner between the two faces is cut away and the rolling
 * ball's sweep is added back. For a straight edge that sweep is a cylinder, for
 * a circular edge it is a torus, and both fall out of the same two-dimensional
 * corner profile, swept the appropriate way.
 *
 * A sphere is dropped at every vertex where filleted edges meet, which is what
 * fills the gap the individual sweeps leave at a corner.
 */

import * as K from './kernel.js';
import * as THREE from './three.js';
import { basisFor, dot, cross, sub, add, scale, norm, len } from './topology.js';
import { arcSegments, circleSegments } from './profile.js';
import { variableSweep } from './meshbuild.js';

const EXTEND = 0.05; // mm of overrun so booleans do not leave slivers

/**
 * A block filling everything on the far side of a plane, in the direction the
 * normal points. Used to cut a corner off.
 */
function halfSpaceAt(origin, normal, span, scope) {
  const basis = basisFor(normal);
  const box = K.box([span * 3, span * 3, span * 2], true, scope);
  const m = new THREE.Matrix4();
  // The box is centred a span along the normal, so its near face lands on the
  // plane and its body is the side the normal points at.
  const o = [
    origin[0] + normal[0] * span,
    origin[1] + normal[1] * span,
    origin[2] + normal[2] * span
  ];
  m.set(
    basis.x[0], basis.y[0], basis.n[0], o[0],
    basis.x[1], basis.y[1], basis.n[1], o[1],
    basis.x[2], basis.y[2], basis.n[2], o[2],
    0, 0, 0, 1
  );
  return K.transform(box, m.elements, scope);
}

/* ------------------------------------------------------------------ */
/* The corner profile                                                  */
/* ------------------------------------------------------------------ */

/**
 * The two-dimensional region between a corner and the rolling ball.
 * `a` and `b` are unit directions into the two faces from the corner.
 * Returns a closed contour as [x, y] pairs, or null if the corner cannot take
 * the requested size.
 */
function cornerProfile(a, b, size, kind, segments, opts = {}) {
  const cosT = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]));
  const sinT = Math.abs(a[0] * b[1] - a[1] * b[0]);
  const theta = Math.atan2(sinT, cosT);
  if (theta < 1e-4 || Math.abs(theta - Math.PI) < 1e-4) return null;

  if (kind === 'chamfer') {
    // Equal by default. A second distance, or a distance and the angle the
    // chamfer face leans at, make it asymmetric. The angle is measured from
    // the first face, which is exact where the two faces meet square.
    const t = size;
    const t2 = opts.size2 !== undefined && opts.size2 !== null ? opts.size2 : size;
    return [
      [0, 0],
      [a[0] * t, a[1] * t],
      [b[0] * t2, b[1] * t2]
    ];
  }

  const r = size;
  const t = r / Math.tan(theta / 2);
  if (!Number.isFinite(t) || t <= 1e-9) return null;

  // Asymmetric: a second radius measured on the other face, so the blend runs
  // out further one way than the other. The two tangent points move apart and
  // the arc between them stops being circular, which is the whole point.
  const r2 = opts.size2 !== undefined && opts.size2 !== null ? opts.size2 : null;
  const t2 = r2 !== null ? r2 / Math.tan(theta / 2) : t;
  if (!Number.isFinite(t2) || t2 <= 1e-9) return null;

  // Curvature continuous, which Fusion calls G2. A circular arc meets a flat
  // face with a jump in curvature, from nothing to one over the radius, and on
  // a shiny part that jump is a visible line. This runs the curvature to
  // nothing at both ends instead, so there is no line to see.
  if (opts.continuity === 'G2') {
    return curvatureProfile(a, b, t, t2, segments, opts.weight);
  }

  // Different tangent distances means an elliptical arc rather than a circular
  // one, and both are the same rational quadratic: the two tangent points, the
  // corner as the control point, and a weight of sin(theta / 2), which is the
  // value that reproduces the circle exactly when the distances match.
  if (Math.abs(t2 - t) > 1e-9) {
    return conicProfile(a, b, t, t2, theta, segments);
  }

  const A = [a[0] * t, a[1] * t];
  const B = [b[0] * t, b[1] * t];
  const bis = norm2([a[0] + b[0], a[1] + b[1]]);
  const d = r / Math.sin(theta / 2);
  const C = [bis[0] * d, bis[1] * d];

  let aA = Math.atan2(A[1] - C[1], A[0] - C[0]);
  let aB = Math.atan2(B[1] - C[1], B[0] - C[0]);
  let sweep = aB - aA;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;

  // Follow the same curve quality as everything else so the blend and the
  // surfaces it lands on share vertex spacing.
  const steps = segments || arcSegments(r, Math.abs(sweep));
  const pts = [[0, 0], A];
  for (let i = 1; i < steps; i++) {
    const ang = aA + (sweep * i) / steps;
    pts.push([C[0] + r * Math.cos(ang), C[1] + r * Math.sin(ang)]);
  }
  pts.push(B);
  return pts;
}

function norm2(v) {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/**
 * The arc of an asymmetric fillet: tangent to both faces, at a different
 * distance along each.
 *
 * A rational quadratic Bezier through the two tangent points with the corner
 * itself as the control point. The corner is the origin here, which is what
 * makes the numerator collapse to two terms. At a weight of sin(theta / 2) and
 * equal distances this is the circular arc exactly, so switching a set to
 * asymmetric and then giving it the same radius twice changes nothing about
 * the part.
 */
function conicProfile(a, b, tA, tB, theta, segments) {
  const A = [a[0] * tA, a[1] * tA];
  const B = [b[0] * tB, b[1] * tB];
  const w = Math.sin(theta / 2);
  const steps = segments || arcSegments(Math.max(tA, tB), Math.PI - theta);
  const pts = [[0, 0], A];
  for (let i = 1; i < steps; i++) {
    const s = i / steps;
    const u = 1 - s;
    const den = u * u + 2 * s * u * w + s * s;
    pts.push([(u * u * A[0] + s * s * B[0]) / den, (u * u * A[1] + s * s * B[1]) / den]);
  }
  pts.push(B);
  return pts;
}

/**
 * The curve of a curvature continuous fillet.
 *
 * A quintic Bezier whose first three control points lie on the line from the
 * near tangent point to the corner, and whose last three lie on the line from
 * the corner to the far one. Three collinear control points at an end is
 * exactly the condition for zero curvature there, and the faces it lands on
 * are flat, so both sides read zero and there is no step.
 *
 * The tangent points are where the circular fillet of the same radius would
 * have put them, so switching a set from G1 to G2 keeps the runout and changes
 * only the shape between. Tangency weight is how hard the curve is pulled
 * toward the corner: at 1 it sits close to the circular arc, below that it
 * flattens and spreads, above it tightens.
 */
function curvatureProfile(a, b, tA, tB, segments, weight) {
  const w = Number.isFinite(weight) && weight > 0 ? Math.min(weight, 1.2) : 1;
  const A = [a[0] * tA, a[1] * tA];
  const B = [b[0] * tB, b[1] * tB];
  // Fractions of the way from each tangent point to the corner. Two of them,
  // so the first three points are collinear and so are the last three.
  const near = 0.4 * w;
  const far = 0.8 * w;
  const along = (P, f) => [P[0] * (1 - f), P[1] * (1 - f)];
  const ctrl = [A, along(A, near), along(A, far), along(B, far), along(B, near), B];

  const steps = segments || Math.max(8, arcSegments(Math.max(tA, tB), Math.PI / 2));
  const pts = [[0, 0]];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    // de Casteljau, which is short enough at degree five to write out plainly
    // and is stable where the binomial form is not.
    let cur = ctrl;
    while (cur.length > 1) {
      const next = [];
      for (let j = 0; j < cur.length - 1; j++) {
        next.push([
          cur[j][0] + (cur[j + 1][0] - cur[j][0]) * s,
          cur[j][1] + (cur[j + 1][1] - cur[j][1]) * s
        ]);
      }
      cur = next;
    }
    pts.push(cur[0]);
  }
  return pts;
}

/* ------------------------------------------------------------------ */
/* Tool construction                                                   */
/* ------------------------------------------------------------------ */

/**
 * Push the two straight legs of a corner profile a hair outside the faces they
 * lie on.
 *
 * A stitched tool is handed to the kernel as single precision vertices, so a
 * leg meant to lie exactly in a face plane instead wanders either side of it by
 * a fraction of a micron. The boolean then cuts along a surface it cannot
 * decide about and leaves slivers behind. Ten microns of clearance is far above
 * that noise and lands in air outside the part, where it removes nothing.
 *
 * The arc is left exactly where it was, so the blend radius is untouched.
 */
const LEG_CLEARANCE = 0.01;

function outsetLegs(contour, a, b) {
  if (contour.length < 3) return contour;
  const perpAway = (dir, other) => {
    const p = [-dir[1], dir[0]];
    return p[0] * other[0] + p[1] * other[1] > 0 ? [-p[0], -p[1]] : p;
  };
  const pA = perpAway(a, b);
  const pB = perpAway(b, a);
  const e = LEG_CLEARANCE;

  const first = contour[1];
  const last = contour[contour.length - 1];

  // Where the two shifted leg lines now cross is the new apex.
  const det = a[0] * b[1] - a[1] * b[0];
  if (Math.abs(det) < 1e-9) return contour;
  const cx = pA[0] * e;
  const cy = pA[1] * e;
  const dx = pB[0] * e;
  const dy = pB[1] * e;
  const s = ((dx - cx) * b[1] - (dy - cy) * b[0]) / det;
  const apex = [cx + a[0] * s, cy + a[1] * s];

  return [
    apex,
    [first[0] + pA[0] * e, first[1] + pA[1] * e],
    ...contour.slice(1),
    [last[0] + pB[0] * e, last[1] + pB[1] * e]
  ];
}

/**
 * A blend whose size changes along the edge.
 *
 * The constant case is a plain extrusion of one profile, which is both simpler
 * and exact, so this path is only taken when the two ends actually differ.
 */
function variableToolForLineEdge(edge, startSize, endSize, kind, scope, opts = {}) {
  const d = edge.dir;
  const uA = edge.dirA;
  const uB = edge.dirB;
  if (!uA || !uB) return null;

  const e1 = uA;
  const e2 = norm(cross(d, e1));
  const a2 = [1, 0];
  const b2 = [dot(uB, e1), dot(uB, e2)];

  const steps = Math.max(8, Math.ceil(edge.length / 1.5));

  // One segment count for every station, taken from the largest radius, so all
  // the profiles have matching points and can be stitched without resampling.
  const cosT = Math.max(-1, Math.min(1, a2[0] * b2[0] + a2[1] * b2[1]));
  const sinT = Math.abs(a2[0] * b2[1] - a2[1] * b2[0]);
  const theta = Math.atan2(sinT, cosT);
  const segments = arcSegments(Math.max(startSize, endSize), theta);

  const stations = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const size = startSize + (endSize - startSize) * t;
    if (size <= 1e-6) return null;
    const raw = cornerProfile(a2, b2, size, kind, segments, opts);
    if (!raw) return null;
    const contour = outsetLegs(raw, a2, b2);

    // Overrun both ends so the boolean has something to bite on.
    const along = -EXTEND + t * (edge.length + EXTEND * 2);
    stations.push({
      contour,
      frame: {
        origin: add(edge.start, scale(d, along)),
        x: e1,
        y: e2
      }
    });
  }
  return variableSweep(stations, scope);
}

function toolForLineEdge(topo, edge, size, kind, scope, opts = {}) {
  const d = edge.dir;
  const uA = edge.dirA;
  const uB = edge.dirB;
  if (!uA || !uB) return null;

  // Work in the plane perpendicular to the edge, with the first face's
  // direction as the local x axis.
  const e1 = uA;
  const e2 = norm(cross(d, e1));
  const a2 = [1, 0];
  const b2 = [dot(uB, e1), dot(uB, e2)];

  const contour = cornerProfile(a2, b2, size, kind, undefined, opts);
  if (!contour) return null;

  const height = edge.length + EXTEND * 2;
  const solid = K.extrudeContours([contour], { height }, scope);

  const origin = add(edge.start, scale(d, -EXTEND));
  const m = new THREE.Matrix4();
  m.set(
    e1[0], e2[0], d[0], origin[0],
    e1[1], e2[1], d[1], origin[1],
    e1[2], e2[2], d[2], origin[2],
    0, 0, 0, 1
  );
  return K.transform(solid, m.elements, scope);
}

function toolForCircleEdge(topo, edge, size, kind, scope, opts = {}) {
  const axis = edge.axis;
  const c = edge.centre;
  const p0 = edge.refPoint || edge.points[0];
  if (!edge.dirA || !edge.dirB) return null;

  // Radius direction at the sample point, with any axial component removed.
  const spoke = sub(p0, c);
  const radialDir = norm(sub(spoke, scale(axis, dot(spoke, axis))));

  // The surface directions already lie perpendicular to the edge, which for a
  // circle means they lie in the radial-axial half plane exactly.
  const project = (v) => {
    const x = dot(v, radialDir);
    const y = dot(v, axis);
    const l = Math.hypot(x, y);
    return l < 1e-9 ? null : [x / l, y / l];
  };
  const a2 = project(edge.dirA);
  const b2 = project(edge.dirB);
  if (!a2 || !b2) return null;

  const contour = cornerProfile(a2, b2, size, kind, undefined, opts);
  if (!contour) return null;

  // Move the profile out to the edge's radius and revolve it about the axis.
  const R = edge.radius;
  const shifted = contour.map(([x, y]) => [R + x, y]);
  if (shifted.some(([x]) => x <= 1e-6)) return null;

  const solid = K.revolveContours([shifted], 360, circleSegments(R), scope);

  const b = basisFor(axis);
  const m = new THREE.Matrix4();
  m.set(
    b.x[0], b.y[0], axis[0], c[0],
    b.x[1], b.y[1], axis[1], c[1],
    b.x[2], b.y[2], axis[2], c[2],
    0, 0, 0, 1
  );
  return K.transform(solid, m.elements, scope);
}

/**
 * Build the cut and add parts for a set of edges on one body.
 * Convex edges lose the corner and gain the sweep; concave edges do the
 * opposite, which is the same construction with the boolean reversed.
 */
export function buildEdgeTools(topo, edges, size, kind, scope, opts = {}) {
  const convexTools = [];
  const concaveTools = [];
  const skipped = [];
  const endSize = opts.endSize;
  const varying = endSize !== undefined && Math.abs(endSize - size) > 1e-9;

  // A size per edge, when the caller has one. Chord length and hold line both
  // work a different radius out for every edge from the shape it sits in, so
  // one number for the whole set will not do.
  const sizeOf = (edge) => {
    if (!opts.sizeFor) return size;
    const r = opts.sizeFor(edge);
    return Number.isFinite(r) && r > 0 ? r : 0;
  };
  const sizeUsed = new Map();

  for (const edge of edges) {
    const r = sizeOf(edge);
    if (!(r > 0)) {
      skipped.push(edge);
      continue;
    }
    let tool = null;
    if (edge.kind === 'line') {
      tool = varying
        ? variableToolForLineEdge(edge, r, endSize, kind, scope, opts)
        : toolForLineEdge(topo, edge, r, kind, scope, opts);
    } else if (edge.kind === 'circle') {
      tool = toolForCircleEdge(topo, edge, r, kind, scope, opts);
    }

    if (!tool) {
      skipped.push(edge);
      continue;
    }
    sizeUsed.set(edge, r);
    (edge.convex ? convexTools : concaveTools).push({ edge, tool });
  }

  // Corners: where several filleted edges meet at a point, their sweeps stop
  // short and leave a notch. A ball fills it, but it belongs where the rolling
  // ball would rest, tangent to all three faces, not on the sharp corner. Put
  // it on the corner itself and it bulges out and adds volume instead.
  const vertexFaces = new Map();
  const vertexSize = new Map();
  // Which edges leave each corner, and where. A chamfer's corner facet is the
  // plane through the point one chamfer distance along each of them.
  const vertexLegs = new Map();
  const vertexAt = new Map();
  for (const { edge } of convexTools) {
    if (edge.kind !== 'line') continue;
    const ends = [edge.verts[0], edge.verts[edge.verts.length - 1]];
    for (const v of ends) {
      let set = vertexFaces.get(v);
      if (!set) vertexFaces.set(v, (set = new Set()));
      set.add(edge.faceA);
      set.add(edge.faceB);

      // The direction the edge leaves this corner in, and the corner's place.
      const pts = edge.points;
      if (pts && pts.length >= 2) {
        const first = v === ends[0];
        const a = first ? pts[0] : pts[pts.length - 1];
        const b = first ? pts[1] : pts[pts.length - 2];
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const l = Math.hypot(d[0], d[1], d[2]);
        if (l > 1e-12) {
          if (!vertexLegs.has(v)) vertexLegs.set(v, []);
          vertexLegs.get(v).push({ dir: [d[0] / l, d[1] / l, d[2] / l], size: sizeUsed.get(edge) });
          vertexAt.set(v, a);
        }
      }
      // The ball has to fit every sweep meeting here, so it takes the smallest
      // radius of them. A bigger one would stand proud of the narrower fillet.
      const r = sizeUsed.get(edge);
      vertexSize.set(v, Math.min(vertexSize.get(v) ?? Infinity, r));
    }
  }

  const blends = [];
  // The ball is a rolling ball: one radius, tangent to all three faces. An
  // asymmetric blend is not a ball at all, and a curvature continuous one has
  // no single radius to give it, so dropping one at those corners would stand
  // proud of the sweeps it is meant to join. Those corners are left as the
  // sweeps make them.
  const rollingBall =
    kind === 'fillet' && !varying && opts.continuity !== 'G2' && opts.size2 == null;
  if (rollingBall) {
    for (const [v, faceIds] of vertexFaces) {
      const planes = [...faceIds]
        .map((id) => topo.faces[id])
        .filter((f) => f && f.planar);
      if (planes.length < 3) continue;

      const r = vertexSize.get(v) ?? size;
      if (!(r > 0)) continue;
      const centre = ballCentre(planes, r);
      if (!centre) continue;
      blends.push(K.translate(K.sphere(r, circleSegments(r), scope), centre, scope));
    }
  }

  /*
   * Where three chamfers meet, the three bevelled faces run together to a
   * point. Fusion calls that Miter and offers Chamfer instead, which "creates
   * a chamfer to join beveled edges at the corner": the point is cut off by a
   * fourth facet through the tangent points, one chamfer distance along each
   * edge leaving the corner.
   *
   * It is one more half space per corner, unioned into the same cut, so it
   * takes its material away with everything else rather than in a pass of its
   * own.
   */
  const cornerCuts = [];
  if (kind === 'chamfer' && ['chamfer', 'blend'].includes(opts.cornerType)) {
    for (const [v, legs] of vertexLegs) {
      if (legs.length < 3) continue;
      const at = vertexAt.get(v);
      if (!at) continue;
      const pts = legs
        .filter((l) => l.size > 0)
        .map((l) => [at[0] + l.dir[0] * l.size, at[1] + l.dir[1] * l.size, at[2] + l.dir[2] * l.size]);
      if (pts.length < 3) continue;

      // The plane through the first three of them. More than three legs at one
      // corner is a shape whose tangent points need not be coplanar at all, so
      // the facet is taken from three and the rest are left to the sweeps.
      const u = sub(pts[1], pts[0]);
      const w = sub(pts[2], pts[0]);
      const n0 = cross(u, w);
      const nl = len(n0);
      if (nl < 1e-9) continue;
      let n = [n0[0] / nl, n0[1] / nl, n0[2] / nl];
      // Away from the corner vertex, which is the side the leftover point is
      // on. The vertex itself has already gone: the three chamfers meet at a
      // point further out along the diagonal than the vertex was, and that
      // point is what this facet is here to take off. Cutting the side the
      // vertex is on removes only what is removed already, which is exactly
      // what the first version of this did.
      const toCorner = sub(at, pts[0]);
      if (dot(n, toCorner) > 0) n = [-n[0], -n[1], -n[2]];

      // Bounded to the corner. A half space is unbounded, and the plane
      // through the three tangent points of one corner of a box has most of
      // that box on the far side of it, so cutting with the plane alone takes
      // the part away rather than its corner. The ball is big enough to hold
      // the leftover point the three chamfers meet at, which sits about one
      // chamfer distance and a half out along the diagonal, and far smaller
      // than the gap to the next corner.
      const big = Math.max(...legs.map((l) => l.size));
      const reach = big * 8 + 1;
      const near = K.translate(K.sphere(big * 2.5, circleSegments(big * 2.5), scope), at, scope);
      let cut = K.intersection(halfSpaceAt(pts[0], n, reach, scope), near, scope);

      /*
       * Blend, which Fusion describes as blending the bevelled edges into the
       * adjacent edges. Same cut as the chamfered corner, with a sphere put
       * back into it, so what is left where the point was is round rather than
       * flat and it runs into the bevels instead of meeting them at an edge.
       *
       * The sphere passes exactly through the three tangent points, so the
       * blend starts where the bevels do and there is no step. Its centre sits
       * one circumradius inside along the corner's own diagonal, which puts its
       * surface a shade over four tenths of that radius proud of the flat
       * facet: more material than the chamfered corner leaves and less than the
       * mitre, which is where a blend belongs between the two.
       */
      if (opts.cornerType === 'blend') {
        const mid = [
          (pts[0][0] + pts[1][0] + pts[2][0]) / 3,
          (pts[0][1] + pts[1][1] + pts[2][1]) / 3,
          (pts[0][2] + pts[1][2] + pts[2][2]) / 3
        ];
        // Equidistant from all three by symmetry of the corner; the mean is
        // the circumcentre for the symmetric case and near enough for the rest,
        // and the radius is taken as the furthest of the three so the sphere
        // reaches every one of them.
        const rad = Math.max(...pts.map((p) => len(sub(p, mid))));
        if (rad > 1e-9) {
          const c = [mid[0] - n[0] * rad, mid[1] - n[1] * rad, mid[2] - n[2] * rad];
          const R = Math.sqrt(2) * rad;
          const ball = K.translate(K.sphere(R, circleSegments(R), scope), c, scope);
          cut = K.difference(cut, ball, scope);
        }
      }

      cornerCuts.push(cut);
    }
  }

  return {
    cut: convexTools.length || cornerCuts.length
      ? K.unionAll([...convexTools.map((t) => t.tool), ...cornerCuts], scope)
      : null,
    addBack: concaveTools.length ? K.unionAll(concaveTools.map((t) => t.tool), scope) : null,
    blends: blends.length ? K.unionAll(blends, scope) : null,
    applied: convexTools.length + concaveTools.length,
    skipped
  };
}

/**
 * The prism standing on a face, one face-worth of area swept along the face
 * normal. Adding it thickens the body at that face; subtracting it hollows in.
 *
 * Built directly as triangles because the face is whatever shape it is, holes
 * and all, and re-deriving its outline as a polygon would only throw that away.
 */
export function buildFacePrism(mesh, face, distance, scope, along) {
  if (Math.abs(distance) < 1e-9) return null;

  const stride = mesh.numProp;
  const pos = mesh.vertProperties;
  const tris = mesh.triVerts;
  // Along the face's own normal unless told otherwise. Moving a face sideways
  // wants the prism to lean the way the move goes, or the walls it leaves
  // behind stand square to the face rather than following it.
  const n = along || face.normal;
  const offset = [n[0] * distance, n[1] * distance, n[2] * distance];

  // Renumber only the vertices this face uses.
  const local = new Map();
  const base = [];
  const vertexOf = (v) => {
    if (local.has(v)) return local.get(v);
    const id = base.length / 3;
    const b = v * stride;
    base.push(pos[b], pos[b + 1], pos[b + 2]);
    local.set(v, id);
    return id;
  };

  const faceTris = [];
  for (const t of face.tris) {
    faceTris.push([
      vertexOf(tris[t * 3]),
      vertexOf(tris[t * 3 + 1]),
      vertexOf(tris[t * 3 + 2])
    ]);
  }

  const count = base.length / 3;
  const verts = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    verts[i * 3] = base[i * 3];
    verts[i * 3 + 1] = base[i * 3 + 1];
    verts[i * 3 + 2] = base[i * 3 + 2];
    const o = (count + i) * 3;
    verts[o] = base[i * 3] + offset[0];
    verts[o + 1] = base[i * 3 + 1] + offset[1];
    verts[o + 2] = base[i * 3 + 2] + offset[2];
  }

  // Edges used once by the face are its outline, and those get the walls.
  const edgeCount = new Map();
  const key = (a, b) => `${Math.min(a, b)}_${Math.max(a, b)}`;
  for (const [a, b, c] of faceTris) {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = key(p, q);
      const rec = edgeCount.get(k);
      if (rec) rec.count++;
      else edgeCount.set(k, { a: p, b: q, count: 1 });
    }
  }

  const out = [];
  const up = distance > 0;
  for (const [a, b, c] of faceTris) {
    // The cap facing along the offset keeps the original winding; the one
    // left behind is flipped so both point out of the prism.
    if (up) {
      out.push(count + a, count + b, count + c);
      out.push(a, c, b);
    } else {
      out.push(a, b, c);
      out.push(count + a, count + c, count + b);
    }
  }
  for (const rec of edgeCount.values()) {
    if (rec.count !== 1) continue;
    const a = rec.a;
    const b = rec.b;
    if (up) {
      out.push(a, b, count + b);
      out.push(a, count + b, count + a);
    } else {
      out.push(b, a, count + a);
      out.push(b, count + a, count + b);
    }
  }

  return K.ofMesh(verts, new Uint32Array(out), scope);
}

/**
 * Where a ball of the given radius rests tangent to three planes, on the
 * material side of each. Solves n_i . p = n_i . c_i - r.
 */
function ballCentre(planes, r) {
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      for (let k = j + 1; k < planes.length; k++) {
        const rows = [planes[i], planes[j], planes[k]].map((f) => ({
          n: f.normal,
          d: dot(f.normal, f.centre) - r
        }));
        const p = solve3(rows);
        if (p) return p;
      }
    }
  }
  return null;
}

function solve3(rows) {
  const m = rows.map((r) => r.n);
  const rhs = rows.map((r) => r.d);
  const det = det3(m);
  if (Math.abs(det) < 1e-6) return null;
  const col = (idx) => {
    const c = m.map((row) => row.slice());
    for (let i = 0; i < 3; i++) c[i][idx] = rhs[i];
    return det3(c) / det;
  };
  return [col(0), col(1), col(2)];
}

function det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

/* ------------------------------------------------------------------ */
/* Persistent references                                               */
/* ------------------------------------------------------------------ */

/**
 * Edges are remembered by where they are rather than by index, because a
 * rebuild renumbers everything. Matching is on the midpoint, with the kind and
 * length used to break ties.
 */
export function edgeReference(edge, topo) {
  const mid = edge.points[Math.floor(edge.points.length / 2)];
  const ref = {
    p: [mid[0], mid[1], mid[2]],
    kind: edge.kind,
    length: Number(edge.length.toFixed(4))
  };
  if (edge.dir) ref.dir = [edge.dir[0], edge.dir[1], edge.dir[2]];
  if (edge.axis) ref.dir = [edge.axis[0], edge.axis[1], edge.axis[2]];

  // An edge is where two faces meet, so naming both of them names the edge.
  // That is far stronger than where its midpoint happens to sit, and it is the
  // difference between a fillet staying on the boss it was put on and jumping
  // to the boss next door when the spacing changes.
  if (topo?.faces) {
    const a = topo.faces[edge.faceA]?.src;
    const b = topo.faces[edge.faceB]?.src;
    if (a || b) {
      ref.between = [
        a ? { tag: a.tag, face: a.face } : null,
        b ? { tag: b.tag, face: b.face } : null
      ];
    }
  }
  return ref;
}

/** Do two stored sources name the same face? */
function sameSrc(a, b) {
  if (!a || !b) return false;
  if (a.tag !== b.tag) return false;
  // A face id of minus one means the feature is known but no single face of it
  // is, which is what a curved face looks like. The feature is still worth
  // matching on: it is the difference between the right boss and the one next
  // to it, and position tells apart the few faces left over.
  if (a.face < 0 || b.face < 0) return true;
  return a.face === b.face;
}

/** Does an edge sit between the same pair of named faces, either way round? */
function edgeBetweenMatches(ref, topo, edge) {
  if (!ref.between || !topo?.faces) return false;
  const a = topo.faces[edge.faceA]?.src;
  const b = topo.faces[edge.faceB]?.src;
  const [ra, rb] = ref.between;
  return (
    (sameSrc(ra, a) && sameSrc(rb, b)) || (sameSrc(ra, b) && sameSrc(rb, a))
  );
}

export function faceReference(face) {
  const ref = {
    p: [face.centre[0], face.centre[1], face.centre[2]],
    n: [face.normal[0], face.normal[1], face.normal[2]],
    area: Number(face.area.toFixed(4)),
    planar: !!face.planar
  };
  // A closed curved face has no normal worth storing: the facet normals of a
  // bore point every way round and average to nothing, so `n` comes back as
  // zero and no later match can ever align with it. What identifies a cylinder
  // is its axis and its radius, so those are what get written down.
  if (face.cylinder) {
    ref.axis = [face.cylinder.dir[0], face.cylinder.dir[1], face.cylinder.dir[2]];
    ref.radius = Number(face.cylinder.radius.toFixed(4));
  }
  // The name, where the kernel could give one. Everything above is a
  // description of where the face happened to be; this is which face it is.
  if (face.src) ref.src = { tag: face.src.tag, face: face.src.face };
  return ref;
}

/**
 * Matching a stored reference back to geometry, after the model may have
 * changed underneath it.
 *
 * Position alone is no good: change a dimension and every face moves, which is
 * exactly when the reference has to survive. So which way a face points comes
 * first, its size second, and distance only as a tiebreak between faces that
 * are otherwise alike, measured relative to the size of the part rather than in
 * millimetres.
 *
 * This is the persistent naming problem, and no cheap answer to it is
 * completely safe. It fails toward "no match", which shows up as a reported
 * error on the feature, not as silently filleting the wrong edge.
 */
const MATCH_LIMIT = 0.85;

export function resolveFaceRefs(topo, refs) {
  const out = [];
  const taken = new Set();
  const extent = topo.extent || 1;

  for (const ref of refs || []) {
    // By name first, when the kernel gave one. A face that says which feature
    // and which of its faces it is needs no guessing at all, and this is the
    // case that used to fail: four identical bosses are told apart by which
    // feature made them, never by which is nearest where the old one was.
    if (ref.src) {
      const named = topo.faces.filter((f) => !taken.has(f.id) && sameSrc(f.src, ref.src));
      if (named.length === 1) {
        taken.add(named[0].id);
        out.push(named[0]);
        continue;
      }
      if (named.length > 1) {
        // One feature can leave several faces with the same name, a pattern's
        // copies among them. Position decides between those and only those.
        let near = named[0];
        let nearD = Infinity;
        for (const f of named) {
          const d = Math.hypot(
            f.centre[0] - ref.p[0],
            f.centre[1] - ref.p[1],
            f.centre[2] - ref.p[2]
          );
          if (d < nearD) {
            nearD = d;
            near = f;
          }
        }
        taken.add(near.id);
        out.push(near);
        continue;
      }
    }

    let best = null;
    let bestScore = Infinity;
    for (const face of topo.faces) {
      if (taken.has(face.id)) continue;
      if (!!face.planar !== !!ref.planar) continue;

      let alignment;
      let radiusTerm = 0;
      if (!ref.planar && ref.axis && face.cylinder) {
        // The fit can hand the axis back pointing either way, and a bore is
        // the same bore either way, so only the line matters and not the sense.
        alignment = Math.abs(
          face.cylinder.dir[0] * ref.axis[0] +
            face.cylinder.dir[1] * ref.axis[1] +
            face.cylinder.dir[2] * ref.axis[2]
        );
        if (ref.radius > 1e-9 && face.cylinder.radius > 1e-9) {
          radiusTerm = Math.abs(Math.log(face.cylinder.radius / ref.radius));
        }
      } else if (!ref.planar && !ref.axis) {
        // Written before an axis was recorded. Nothing to align against, so
        // position and size do all the work and old files still open.
        alignment = 1;
      } else {
        alignment =
          face.normal[0] * ref.n[0] + face.normal[1] * ref.n[1] + face.normal[2] * ref.n[2];
      }
      if (alignment < 0.9) continue;

      const d = Math.hypot(
        face.centre[0] - ref.p[0],
        face.centre[1] - ref.p[1],
        face.centre[2] - ref.p[2]
      );
      const areaRatio =
        ref.area > 1e-9 && face.area > 1e-9
          ? Math.abs(Math.log(face.area / ref.area))
          : 1;

      const score =
        (1 - alignment) * 2 + d / extent + areaRatio * 0.25 + radiusTerm * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = face;
      }
    }
    if (best && bestScore < MATCH_LIMIT) {
      taken.add(best.id);
      out.push(best);
    }
  }
  return out;
}

export function resolveEdgeRefs(topo, refs) {
  const out = [];
  const taken = new Set();

  const byName = [];
  const rest = [];
  for (const ref of refs || []) {
    const named = ref.between
      ? topo.edges.filter((e) => edgeBetweenMatches(ref, topo, e))
      : [];
    if (named.length) byName.push({ ref, named });
    else rest.push(ref);
  }
  for (const { ref, named } of byName) {
    // Nearest among the edges between the same two named faces, which is only
    // ever a choice when one pair of faces meets along more than one edge.
    let near = null;
    let nearD = Infinity;
    for (const e of named) {
      if (taken.has(e.id)) continue;
      const mid = e.points[Math.floor(e.points.length / 2)];
      const d = Math.hypot(mid[0] - ref.p[0], mid[1] - ref.p[1], mid[2] - ref.p[2]);
      if (d < nearD) {
        nearD = d;
        near = e;
      }
    }
    if (near) {
      taken.add(near.id);
      out.push(near);
    } else {
      rest.push(ref);
    }
  }
  refs = rest;
  const extent = topo.extent || 1;

  for (const ref of refs || []) {
    let best = null;
    let bestScore = Infinity;
    for (const edge of topo.edges) {
      if (taken.has(edge.id)) continue;
      if (edge.kind !== ref.kind) continue;

      const mid = edge.points[Math.floor(edge.points.length / 2)];
      const d = Math.hypot(mid[0] - ref.p[0], mid[1] - ref.p[1], mid[2] - ref.p[2]);

      // Direction matters more than position: a box edge that has been made
      // longer is still that edge.
      let alignment = 1;
      if (ref.dir && edge.dir) {
        alignment = Math.abs(
          edge.dir[0] * ref.dir[0] + edge.dir[1] * ref.dir[1] + edge.dir[2] * ref.dir[2]
        );
        if (alignment < 0.9) continue;
      }
      const lengthRatio =
        ref.length > 1e-9 && edge.length > 1e-9
          ? Math.abs(Math.log(edge.length / ref.length))
          : 1;

      const score = (1 - alignment) * 2 + d / extent + lengthRatio * 0.25;
      if (score < bestScore) {
        bestScore = score;
        best = edge;
      }
    }
    if (best && bestScore < MATCH_LIMIT) {
      taken.add(best.id);
      out.push(best);
    }
  }
  return out;
}
