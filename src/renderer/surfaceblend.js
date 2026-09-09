/**
 * Fillet and chamfer on the edges of a surface body.
 *
 * The solid edge tools build a cutting solid and boolean it against the part.
 * A sheet has no inside for a boolean to work on, so none of that can be
 * pointed at one: the blend has to be built as surface geometry instead. Both
 * faces are trimmed back to where the blend meets them and a strip is stitched
 * into the gap.
 *
 * Nothing here needs the sheet to be oriented. A surface body has no inside, so
 * which way its normals point is not a fact about it, and a blend that depended
 * on that would come out on the wrong side of half the models that reach it.
 * What is used instead is the direction from the edge into each face, which is
 * a fact about the geometry however the triangles happen to be wound.
 */

import * as SH from './sheet.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : null;
};
const key = (p) => `${p[0].toFixed(4)}_${p[1].toFixed(4)}_${p[2].toFixed(4)}`;

/**
 * Where each face sits, seen from each of its own vertices.
 *
 * The average of the triangles meeting at a vertex, which is all that is
 * wanted from it: which way is into the face from here. A whole face's centroid
 * would do for a flat square and would be wrong for anything long or curved,
 * where the far end of the face is not the direction the near end runs in.
 */
function faceDirections(mesh, face) {
  const P = SH.sheetPoints(mesh);
  const at = new Map();
  for (const t of face.tris) {
    const vs = [mesh.triVerts[t * 3], mesh.triVerts[t * 3 + 1], mesh.triVerts[t * 3 + 2]];
    const c = mul(add(add(P[vs[0]], P[vs[1]]), P[vs[2]]), 1 / 3);
    for (const v of vs) {
      const k = key(P[v]);
      const rec = at.get(k) || { sum: [0, 0, 0], n: 0 };
      rec.sum = add(rec.sum, c);
      rec.n++;
      at.set(k, rec);
    }
  }
  return at;
}

/** The direction along a polyline at one of its points. */
function tangentAt(pts, i, closed) {
  const n = pts.length;
  const prev = i > 0 ? pts[i - 1] : closed ? pts[n - 1] : pts[i];
  const next = i + 1 < n ? pts[i + 1] : closed ? pts[0] : pts[i];
  return unit(sub(next, prev));
}

/**
 * The two runs where a blend of this size meets the faces either side.
 *
 * The setback is worked out per point rather than once for the edge, because a
 * fold that opens out along its length wants the blend to follow it. A rolling
 * ball tangent to both faces sits on the bisector, and the geometry of that is
 * an inscribed circle in the wedge: tangent points at r/tan(half angle) from
 * the edge, centre at r/sin(half angle).
 */
function blendRuns(mesh, topo, edge, size, kind) {
  const faceA = topo.faces[edge.faceA];
  const faceB = topo.faces[edge.faceB];
  if (!faceA || !faceB) return null;
  const dirsA = faceDirections(mesh, faceA);
  const dirsB = faceDirections(mesh, faceB);

  const pts = edge.points;
  const closed = pts.length > 2 && len(sub(pts[0], pts[pts.length - 1])) < 1e-6;
  const run = closed ? pts.slice(0, -1) : pts;

  const rows = { a: [], b: [], centre: [], normalA: [], normalB: [], back: 0 };
  for (let i = 0; i < run.length; i++) {
    const p = run[i];
    const t = tangentAt(run, i, closed);
    if (!t) return null;
    const k = key(p);
    const towards = (map) => {
      const rec = map.get(k);
      if (!rec) return null;
      const v = sub(mul(rec.sum, 1 / rec.n), p);
      return unit(sub(v, mul(t, dot(v, t))));
    };
    const dA = towards(dirsA);
    const dB = towards(dirsB);
    if (!dA || !dB) return null;

    const phi = Math.acos(Math.max(-1, Math.min(1, dot(dA, dB))));
    // Two faces almost in line, or almost folded back on themselves. Neither
    // has a wedge to put a blend in.
    if (phi < 0.05 || phi > Math.PI - 0.05) return null;

    const back = kind === 'chamfer' ? size : size / Math.tan(phi / 2);
    if (!(back > 0) || !Number.isFinite(back)) return null;
    rows.a.push(add(p, mul(dA, back)));
    rows.b.push(add(p, mul(dB, back)));
    const bis = unit(add(dA, dB));
    rows.centre.push(bis ? add(p, mul(bis, size / Math.sin(phi / 2))) : p);
    rows.normalA.push(unit(cross(dA, t)));
    rows.normalB.push(unit(cross(dB, t)));
    rows.back = Math.max(rows.back, back);
  }
  rows.closed = closed;
  return rows;
}

/** The blend surface itself: a flat strip for a chamfer, an arc for a fillet. */
function stripFor(rows, kind, segments) {
  if (kind === 'chamfer') return SH.gridSheet([rows.a, rows.b], { closedU: rows.closed });

  const grid = [];
  for (let s = 0; s <= segments; s++) {
    const f = s / segments;
    grid.push(
      rows.a.map((pa, i) => {
        const c = rows.centre[i];
        const u = sub(pa, c);
        const v = sub(rows.b[i], c);
        const axis = unit(cross(u, v));
        if (!axis) return pa;
        // Turned about the centre rather than interpolated across the chord,
        // which is the difference between a fillet and a flat with its corners
        // taken off.
        const cosA = Math.max(-1, Math.min(1, dot(u, v) / ((len(u) * len(v)) || 1)));
        const ang = Math.acos(cosA) * f;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const rot = add(
          add(mul(u, cs), mul(cross(axis, u), sn)),
          mul(axis, dot(axis, u) * (1 - cs))
        );
        return add(c, rot);
      })
    );
  }
  return SH.gridSheet(grid, { closedU: rows.closed });
}

/**
 * A wall standing on a run, for trimming a face back to it.
 *
 * Run past both ends of an open run, or the cut stops short of the rim and the
 * piece meant to come away is still attached by a sliver at the corner.
 */
function cutterFor(run, normals, closed, reach) {
  let line = run;
  let ns = normals;
  if (!closed && run.length > 1) {
    const head = unit(sub(run[0], run[1]));
    const tail = unit(sub(run[run.length - 1], run[run.length - 2]));
    if (!head || !tail) return null;
    line = [add(run[0], mul(head, reach)), ...run, add(run[run.length - 1], mul(tail, reach))];
    ns = [normals[0], ...normals, normals[normals.length - 1]];
  }
  const up = line.map((p, i) => (ns[i] ? add(p, mul(ns[i], reach)) : p));
  const down = line.map((p, i) => (ns[i] ? add(p, mul(ns[i], -reach)) : p));
  return SH.gridSheet([up, down], { closedU: closed });
}

/**
 * Fillet or chamfer the given edges of a surface body.
 *
 * Every edge is measured against the sheet as it arrived and the faces are
 * trimmed once, at the end, with everything that cuts them. Doing them one at a
 * time would mean each blend was measured against a face the last one had
 * already cut back, so two blends meeting at a corner would fight over it.
 */
export function blendSheetEdges(mesh, topo, edges, size, kind, opts = {}) {
  if (!(size > 0)) return null;
  const span = topo.extent || SH.spanOf(SH.sheetPoints(mesh)) || 1;
  const segments = opts.segments || 8;

  const strips = [];
  const skipped = [];
  const cuts = new Map();
  const noteCut = (faceId, cutter, run) => {
    const rec = cuts.get(faceId) || { cutters: [], runs: [] };
    rec.cutters.push(cutter);
    rec.runs.push(run);
    cuts.set(faceId, rec);
  };

  for (const edge of edges) {
    if (edge.boundary || edge.faceA < 0 || edge.faceB < 0) {
      skipped.push(edge);
      continue;
    }
    const rows = blendRuns(mesh, topo, edge, size, kind);
    const strip = rows && stripFor(rows, kind, segments);
    if (!strip) {
      skipped.push(edge);
      continue;
    }
    const reach = Math.max(rows.back * 2, span * 0.02);
    const cutA = cutterFor(rows.a, rows.normalA, rows.closed, reach);
    const cutB = cutterFor(rows.b, rows.normalB, rows.closed, reach);
    if (!cutA || !cutB) {
      skipped.push(edge);
      continue;
    }
    strips.push(strip);
    noteCut(edge.faceA, cutA, rows.a);
    noteCut(edge.faceB, cutB, rows.b);
  }
  if (!strips.length) return null;

  const pieces = [...strips];
  for (const face of topo.faces) {
    const piece = SH.sheetFromFaces(mesh, topo, [face.id]);
    if (!piece) continue;
    const rec = cuts.get(face.id);
    if (!rec) {
      pieces.push(piece);
      continue;
    }
    /*
     * The piece to keep is the one furthest from every cut, which on a face
     * trimmed on two sides at once is not the same as furthest from any one of
     * them.
     *
     * Measured at triangle centres rather than at the face's own points. A
     * point of the face is a corner of it, and on a panel cut back on both
     * sides every corner is the same distance from the nearer cut, so the pick
     * came down to whichever was listed first and half the time that is the
     * offcut. A triangle centre is inside the face, which is where the
     * question is actually being asked.
     */
    const P = SH.sheetPoints(piece);
    let keep = null;
    let far = -Infinity;
    for (const t of SH.sheetTris(piece)) {
      const c = mul(add(add(P[t[0]], P[t[1]]), P[t[2]]), 1 / 3);
      let near = Infinity;
      for (const run of rec.runs) for (const q of run) near = Math.min(near, len(sub(c, q)));
      if (near > far) {
        far = near;
        keep = c;
      }
    }
    const trimmed = keep ? SH.trimSheet(piece, rec.cutters, keep) : null;
    pieces.push(trimmed && SH.sheetArea(trimmed) > 1e-9 ? trimmed : piece);
  }

  const tol = Math.max(span * 1e-4, 1e-5);
  const stitched = SH.stitchSheets(pieces, tol);
  // Where the trim landed on a face is decided by that face's triangles, and
  // the blend has its own points along the same line. They meet exactly and
  // still do not join until the odd ones out are put into both sides.
  const sheet = SH.healTJunctions(stitched.sheet, tol);
  const loops = SH.boundaryLoops(sheet);
  return { sheet, skipped, openEdges: loops.reduce((n, l) => n + l.length, 0) };
}
