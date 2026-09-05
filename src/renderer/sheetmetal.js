/**
 * Sheet metal: a part that is a folded flat sheet, and the flat it came from.
 *
 * The flat pattern is a second parallel model, not a view of the first. A bend
 * knows its own unfolded length from the K-factor, so the same feature list
 * builds either the folded part or the flat one depending only on whether each
 * bend is folded. That is the whole design, and everything else follows from it.
 *
 * The model is a tree of flat **panels** joined by **bends**. Each panel is a
 * contour in its own frame, with the material occupying the frame's normal from
 * 0 to the thickness. Each bend stores the line it folds about in its parent's
 * frame, and its child's frame is that parent's frame rotated about the bend
 * axis. Laying the child in the same plane instead, pushed out by the bend
 * allowance, gives the flat. Nothing else changes between the two.
 */

import * as THREE from './three.js';
import * as K from './kernel.js';

const EPS = 1e-9;

/* ---------------------------------------------------------------- vectors */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const l = len(a);
  return l > EPS ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/* ------------------------------------------------------------------ rules */

/**
 * The rule a part is made to.
 *
 * One active rule per part, which is the useful nine tenths of Fusion's rule
 * library. Every value is an expression, so a rule can be driven by a
 * parameter the way everything else in the document is.
 */
export const DEFAULT_RULE = {
  name: 'Aluminium 1.5 mm',
  thickness: '1.5',
  bendRadius: '1.5',
  kFactor: '0.44',
  gap: '0.2',
  reliefShape: 'round',
  reliefWidth: '',
  reliefDepth: '',
  cornerShape: 'round',
  cornerSize: ''
};

export const RELIEF_SHAPES = [
  ['round', 'Round'],
  ['straight', 'Straight'],
  ['tear', 'Tear'],
  ['none', 'None']
];

export const CORNER_SHAPES = [
  ['round', 'Round'],
  ['square', 'Square'],
  ['trim', 'Trim to bend'],
  ['none', 'None']
];

/** Where the bend sits relative to the edge a flange was taken from. */
export const BEND_POSITIONS = [
  ['inside', 'Inside'],
  ['outside', 'Outside'],
  ['adjacent', 'Adjacent'],
  ['tangent', 'Tangent']
];

/** Where the bend sits relative to the line a fold was drawn on. */
export const BEND_LINE_POSITIONS = [
  ['start', 'Start'],
  ['center', 'Center'],
  ['end', 'End']
];

/**
 * How much flat material a bend eats.
 *
 * The neutral axis sits a K-factor of the way through the thickness and neither
 * stretches nor compresses, so its arc length is the length of flat stock the
 * bend consumes. Everything about the flat pattern comes down to this number.
 */
export function bendAllowance(angleRad, radius, thickness, k) {
  return Math.abs(angleRad) * (radius + k * thickness);
}

/**
 * How much shorter the folded part is than the sum of its flat legs.
 *
 * Not used to build anything, but it is the number a shop quotes bends in, and
 * having it here means the two can be checked against each other.
 */
export function bendDeduction(angleRad, radius, thickness, k) {
  const a = Math.abs(angleRad);
  const setback = (radius + thickness) * Math.tan(a / 2);
  return 2 * setback - bendAllowance(a, radius, thickness, k);
}

/* ------------------------------------------------------------------ parts */

/**
 * Ids come from the feature that made the panel, never from a counter.
 *
 * The timeline is replayed from scratch on every rebuild, so a counter would
 * hand the same panel a different name each time and anything referring to it,
 * Unfold most of all, would lose its grip the moment a dimension changed.
 */

/** An empty part. Panels and bends are added to it as features run. */
export function newPart(rule) {
  return { rule, panels: [], bends: [], baseId: null };
}

/** Deep enough copy that a feature can add to a part without touching the last. */
export function clonePart(part) {
  return {
    rule: { ...part.rule },
    panels: part.panels.map((p) => ({
      ...p,
      contour: p.contour.map((q) => [q[0], q[1]]),
      holes: (p.holes || []).map((h) => h.map((q) => [q[0], q[1]])),
      frame: { ...p.frame }
    })),
    bends: part.bends.map((b) => ({ ...b, a: [...b.a], b: [...b.b] })),
    baseId: part.baseId
  };
}

export function panelById(part, pid) {
  return part.panels.find((p) => p.id === pid) || null;
}

export function bendById(part, bid) {
  return part.bends.find((b) => b.id === bid) || null;
}

/** The bends that leave this panel. */
export function bendsFrom(part, pid) {
  return part.bends.filter((b) => b.from === pid);
}

/** The base panel, and the first flat face of the part. */
export function basePanel(part) {
  return panelById(part, part.baseId);
}

/**
 * Start a part from a closed profile.
 *
 * This is Fusion's base flange: a flat sheet of the rule's thickness, in the
 * plane the profile was drawn on, and the root every later panel hangs off.
 */
export function addBasePanel(part, contour, holes, frame, panelId) {
  const panel = {
    id: panelId,
    contour: contour.map((q) => [q[0], q[1]]),
    holes: (holes || []).map((h) => h.map((q) => [q[0], q[1]])),
    frame: { ...frame },
    parentBend: null
  };
  part.panels.push(panel);
  if (!part.baseId) part.baseId = panel.id;
  return panel;
}

/**
 * Add a bend and the panel on the far side of it.
 *
 * `line` is in the parent's own frame, and the child's contour is in a frame of
 * its own where u runs away from that line and v runs along it. Keeping the
 * child in its own frame rather than continuing the parent's is what lets a
 * flange be taken off an edge at any angle without the arithmetic caring.
 */
export function addFlangePanel(part, parentId, line, opts) {
  const parent = panelById(part, parentId);
  if (!parent) return null;

  const ordered = orientBendLine(parent.contour, line);
  const height = opts.height;
  const v0 = opts.v0 ?? 0;
  const v1 =
    opts.v1 ?? Math.hypot(ordered.b[0] - ordered.a[0], ordered.b[1] - ordered.a[1]);

  const child = {
    id: opts.panelId,
    // A rectangle: out from the bend line by the height, along it by its extent.
    contour: [
      [0, v0],
      [height, v0],
      [height, v1],
      [0, v1]
    ],
    holes: [],
    frame: null,
    parentBend: null
  };
  part.panels.push(child);

  const bend = {
    id: opts.bendId,
    from: parentId,
    to: child.id,
    a: [ordered.a[0], ordered.a[1]],
    b: [ordered.b[0], ordered.b[1]],
    angle: opts.angle,
    radius: opts.radius,
    v0,
    v1,
    unfolded: false,
    relief: opts.relief !== false
  };
  part.bends.push(bend);
  child.parentBend = bend.id;
  return { panel: child, bend };
}

/**
 * Split a panel along a line and fold one half.
 *
 * This is Fusion's Fold. The stationary side keeps the panel and its frame; the
 * moving side becomes a panel of its own joined by a bend, which is the same
 * shape everything else in this file already deals with.
 *
 * The bend eats a length of flat equal to its allowance, and where that length
 * is taken from is what Bend Line Position chooses. Centred on the line, the
 * part loses nothing overall: the two halves each give up half the allowance
 * and the arc puts it back.
 */
export function foldPanel(part, panelId, line, opts) {
  const panel = panelById(part, panelId);
  if (!panel) return null;

  const t = opts.thickness;
  const r = opts.radius;
  const allow = bendAllowance(opts.angle, r, t, opts.k);

  // In the panel's own frame: along the fold line, and the way the moving half
  // lies from it.
  const d = unit2([line.b[0] - line.a[0], line.b[1] - line.a[1]]);
  const w = [-d[1], d[0]];
  const sign = opts.flip ? -1 : 1;
  const mv = [w[0] * -sign, w[1] * -sign];
  const u = (p) => (p[0] - line.a[0]) * mv[0] + (p[1] - line.a[1]) * mv[1];
  const along = (p) => (p[0] - line.a[0]) * d[0] + (p[1] - line.a[1]) * d[1];
  const at = (k) => [line.a[0] + mv[0] * k, line.a[1] + mv[1] * k];

  // Where the bend zone starts, measured from the line that was drawn.
  const z0 =
    opts.bendLinePosition === 'start'
      ? 0
      : opts.bendLinePosition === 'end'
        ? -allow
        : -allow / 2;

  const stationary = clipPolygon(panel.contour, at(z0), mv);
  const movingArea = clipPolygon(panel.contour, at(z0 + allow), [-mv[0], -mv[1]]);
  if (!stationary?.length || !movingArea?.length) return null;

  panel.contour = stationary;

  const child = {
    id: opts.panelId,
    contour: movingArea.map((p) => [Math.max(0, u(p) - (z0 + allow)), along(p)]),
    holes: [],
    frame: null,
    parentBend: null
  };
  part.panels.push(child);

  const ordered = orientBendLine(panel.contour, {
    a: at(z0),
    b: [at(z0)[0] + d[0], at(z0)[1] + d[1]]
  });
  // The bend runs the width of the material it was cut across.
  const vs = movingArea.map(along);
  const span = Math.hypot(ordered.b[0] - ordered.a[0], ordered.b[1] - ordered.a[1]) || 1;
  const dir = [
    (ordered.b[0] - ordered.a[0]) / span,
    (ordered.b[1] - ordered.a[1]) / span
  ];
  const proj = movingArea.map(
    (p) => (p[0] - ordered.a[0]) * dir[0] + (p[1] - ordered.a[1]) * dir[1]
  );

  const bend = {
    id: opts.bendId,
    from: panelId,
    to: child.id,
    a: ordered.a,
    b: [ordered.a[0] + dir[0] * Math.max(...proj), ordered.a[1] + dir[1] * Math.max(...proj)],
    angle: opts.angle * sign,
    radius: r,
    v0: Math.min(...proj),
    v1: Math.max(...proj),
    unfolded: false,
    relief: false
  };
  part.bends.push(bend);
  child.parentBend = bend.id;
  void vs;
  return { panel: child, bend };
}

/**
 * Put a bend line the way round the rest of the file expects.
 *
 * Everything downstream leans on one right handed triad: the direction out of
 * the panel, the direction along the bend, and the panel's normal, in that
 * order. Only one of the two ways round a line can satisfy that, so the line is
 * ordered here, once, and nothing after this has to check.
 */
export function orientBendLine(contour, line) {
  const d = unit2([line.b[0] - line.a[0], line.b[1] - line.a[1]]);
  // Out of the panel is whichever perpendicular points away from its middle.
  const out = [d[1], -d[0]];
  const c = centroid(contour);
  const away = (c[0] - line.a[0]) * out[0] + (c[1] - line.a[1]) * out[1] < 0;
  return away ? { a: line.a, b: line.b } : { a: line.b, b: line.a };
}

const unit2 = (v) => {
  const l = Math.hypot(v[0], v[1]);
  return l > EPS ? [v[0] / l, v[1] / l] : [1, 0];
};

/** Keep the half of a polygon on the side the normal points away from. */
function clipPolygon(poly, origin, normal) {
  const d = poly.map((p) => (p[0] - origin[0]) * normal[0] + (p[1] - origin[1]) * normal[1]);
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    if (d[i] <= 1e-9) out.push(poly[i]);
    if ((d[i] > 1e-9 && d[j] < -1e-9) || (d[i] < -1e-9 && d[j] > 1e-9)) {
      const t = d[i] / (d[i] - d[j]);
      out.push([
        poly[i][0] + (poly[j][0] - poly[i][0]) * t,
        poly[i][1] + (poly[j][1] - poly[i][1]) * t
      ]);
    }
  }
  return out.length > 2 ? out : null;
}

/* ----------------------------------------------------------------- frames */

/** A point of a panel, in world. */
function toWorld(frame, u, v, w = 0) {
  return [
    frame.origin[0] + frame.x[0] * u + frame.y[0] * v + frame.n[0] * w,
    frame.origin[1] + frame.x[1] * u + frame.y[1] * v + frame.n[1] * w,
    frame.origin[2] + frame.x[2] * u + frame.y[2] * v + frame.n[2] * w
  ];
}

/** Rotate a vector about a unit axis, Rodrigues. */
function rotateVec(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(
    add(mul(v, c), mul(cross(axis, v), s)),
    mul(axis, dot(axis, v) * (1 - c))
  );
}

/** Rotate a point about a line. */
function rotatePoint(p, origin, axis, angle) {
  return add(origin, rotateVec(sub(p, origin), axis, angle));
}

/**
 * Where the bend sits in the world, given its parent's frame.
 *
 * The centre of the arc is a bend radius clear of the concave face, which is
 * whichever face the fold closes onto: the far one for a fold toward the
 * normal, the near one for a fold away from it.
 */
export function bendGeometry(part, bend, parentFrame, thickness) {
  const A = toWorld(parentFrame, bend.a[0], bend.a[1]);
  const B = toWorld(parentFrame, bend.b[0], bend.b[1]);
  const D = unit(sub(B, A));
  const N = [parentFrame.n[0], parentFrame.n[1], parentFrame.n[2]];
  // Out of the panel, square to the bend line and in the panel's own plane.
  // The line was ordered when the bend was made so that this comes out
  // pointing away from the material rather than into it, which is what keeps
  // W, D and N a right handed triad and every sign below decidable.
  const W = unit(cross(D, N));

  // The centre of the arc sits a bend radius clear of the concave face, which
  // is the far face for a fold toward the normal and the near one for a fold
  // away from it.
  const r = bend.radius;
  const centre = bend.angle >= 0 ? add(A, mul(N, thickness + r)) : add(A, mul(N, -r));
  // Rotating by this about D takes W toward the normal, which is the direction
  // a positive angle is meant to fold in. Measured rather than assumed, because
  // it depends on the handedness of the frame the panel happens to carry.
  const sense = dot(cross(D, W), N) >= 0 ? 1 : -1;
  return { A, B, D, N, W, centre, sense };
}

function centroid(poly) {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p[0] / poly.length;
    y += p[1] / poly.length;
  }
  return [x, y];
}

/**
 * Every panel's frame, either folded or laid flat.
 *
 * The only difference between the two is what a bend does to its child: fold it
 * about the bend axis, or leave it in the plane and push it out by the bend
 * allowance. A bend that has been unfolded takes the flat route even when the
 * rest of the part is folded, which is what Unfold does.
 */
export function resolveFrames(part, thickness, k, opts = {}) {
  const flat = !!opts.flat;
  const frames = new Map();
  const base = basePanel(part);
  if (!base) return frames;
  frames.set(base.id, base.frame);

  const queue = [base.id];
  let guard = 0;
  while (queue.length && guard++ < 10000) {
    const pid = queue.shift();
    const pf = frames.get(pid);
    for (const bend of bendsFrom(part, pid)) {
      const g = bendGeometry(part, bend, pf, thickness);
      const child = panelById(part, bend.to);
      if (!child) continue;

      if (flat || bend.unfolded) {
        const allow = bendAllowance(bend.angle, bend.radius, thickness, k);
        frames.set(child.id, {
          origin: add(g.A, mul(g.W, allow)),
          x: g.W,
          y: g.D,
          n: g.N
        });
      } else {
        const turn = bend.angle * g.sense;
        frames.set(child.id, {
          origin: rotatePoint(g.A, g.centre, g.D, turn),
          x: rotateVec(g.W, g.D, turn),
          y: g.D,
          n: rotateVec(g.N, g.D, turn)
        });
      }
      queue.push(child.id);
    }
  }
  return frames;
}

/* ------------------------------------------------------------------ build */

/** The 4x4 that places a frame's own coordinates into the world. */
function frameMatrix(frame) {
  const m = new THREE.Matrix4();
  m.set(
    frame.x[0], frame.y[0], frame.n[0], frame.origin[0],
    frame.x[1], frame.y[1], frame.n[1], frame.origin[1],
    frame.x[2], frame.y[2], frame.n[2], frame.origin[2],
    0, 0, 0, 1
  );
  return m;
}

/** One panel as a solid: its contour given the rule's thickness. */
function panelSolid(panel, frame, thickness, scope) {
  const contours = [panel.contour, ...(panel.holes || [])];
  const prism = K.extrudeContours(contours, { height: thickness }, scope);
  return K.transform(prism, frameMatrix(frame).elements, scope);
}

/**
 * One bend as a solid: the arc of material between two panels.
 *
 * The section is an annulus sector in the plane square to the bend line, swept
 * along it. A bend that has been unfolded is a flat strip of the allowance
 * length instead, which is exactly the material the flat pattern shows.
 */
function bendSolid(part, bend, parentFrame, thickness, k, scope) {
  const g = bendGeometry(part, bend, parentFrame, thickness);
  const v0 = bend.v0 ?? 0;
  const v1 = bend.v1 ?? len(sub(g.B, g.A));
  const width = v1 - v0;
  if (!(width > EPS)) return null;

  const along = add(g.A, mul(g.D, v0));

  if (bend.unfolded) {
    const allow = bendAllowance(bend.angle, bend.radius, thickness, k);
    if (!(allow > EPS)) return null;
    const strip = K.extrudeContours(
      [[[0, 0], [allow, 0], [allow, width], [0, width]]],
      { height: thickness },
      scope
    );
    return K.transform(
      strip,
      frameMatrix({ origin: along, x: g.W, y: g.D, n: g.N }).elements,
      scope
    );
  }

  const r = bend.radius;
  const theta = bend.angle;
  if (Math.abs(theta) < 1e-6) return null;
  const steps = Math.max(4, Math.ceil((Math.abs(theta) * 180) / Math.PI / 6));

  // The section is an annulus sector. e0 points from the centre of the arc at
  // the material where the bend starts; e1 is the way it turns.
  const inner = [];
  const outer = [];
  for (let i = 0; i <= steps; i++) {
    const phi = (Math.abs(theta) * i) / steps;
    const c = Math.cos(phi);
    const sn = Math.sin(phi);
    inner.push([r * c, r * sn]);
    outer.push([(r + thickness) * c, (r + thickness) * sn]);
  }
  const section = [...inner, ...outer.reverse()];

  const e0 = theta >= 0 ? mul(g.N, -1) : g.N;
  const e1 = g.W;
  // Which way the section's own third axis runs along the bend is a question of
  // handedness, so it is measured rather than assumed, and the sweep is started
  // from whichever end of the bend it runs away from.
  const e2 = cross(e0, e1);
  const forward = dot(e2, g.D) >= 0;
  const origin = add(g.centre, mul(g.D, forward ? v0 : v1));

  const prism = K.extrudeContours([section], { height: width }, scope);
  return K.transform(
    prism,
    frameMatrix({ origin, x: e0, y: e1, n: e2 }).elements,
    scope
  );
}

/**
 * The part as a solid, folded or flat.
 *
 * Both come out of the same walk. Nothing here knows which one it is building
 * beyond the frames it was handed, which is the point.
 */
export function buildPart(part, scope, opts = {}) {
  const t = opts.thickness;
  const k = opts.kFactor;
  const flat = !!opts.flat;
  const frames = resolveFrames(part, t, k, { flat });

  const pieces = [];
  for (const panel of part.panels) {
    const frame = frames.get(panel.id);
    if (!frame || panel.contour.length < 3) continue;
    try {
      pieces.push(panelSolid(panel, frame, t, scope));
    } catch {
      /* a panel that will not close is dropped rather than losing the part */
    }
  }
  for (const bend of part.bends) {
    const pf = frames.get(bend.from);
    if (!pf) continue;
    try {
      const s = flat
        ? bendSolid(part, { ...bend, unfolded: true }, pf, t, k, scope)
        : bendSolid(part, bend, pf, t, k, scope);
      if (s) pieces.push(s);
    } catch {
      /* likewise */
    }
  }
  if (!pieces.length) return null;

  let solid = pieces[0];
  for (let i = 1; i < pieces.length; i++) solid = K.union(solid, pieces[i], scope);
  return solid;
}

/* ----------------------------------------------------------------- relief */

/**
 * The notch a bend needs when its flange is narrower than the face it leaves.
 *
 * Without it the material either side of the bend has nowhere to go and the
 * part cannot actually be folded. The shape is the rule's, and the depth runs
 * past the bend so the tear starts where it is meant to.
 */
export function reliefCuts(part, bend, thickness, rule) {
  if (!bend.relief || rule.reliefShape === 'none') return [];
  const parent = panelById(part, bend.from);
  if (!parent) return [];

  const w = rule.reliefWidth > 0 ? rule.reliefWidth : thickness;
  const depth = rule.reliefDepth > 0 ? rule.reliefDepth : thickness + bend.radius;

  const d = unit2([bend.b[0] - bend.a[0], bend.b[1] - bend.a[1]]);
  const nrm = [-d[1], d[0]];
  // Into the parent, away from the flange.
  const c = centroid(parent.contour);
  const into =
    (c[0] - bend.a[0]) * nrm[0] + (c[1] - bend.a[1]) * nrm[1] > 0
      ? nrm
      : [-nrm[0], -nrm[1]];

  const at = (s) => [bend.a[0] + d[0] * s, bend.a[1] + d[1] * s];
  const notch = (s, dir) => {
    const p0 = at(s);
    const corners = [];
    const push = (ds, dn) =>
      corners.push([
        p0[0] + d[0] * ds * dir + into[0] * dn,
        p0[1] + d[1] * ds * dir + into[1] * dn
      ]);
    if (rule.reliefShape === 'tear') {
      push(0, 0);
      push(w * 0.5, depth);
      push(-w * 0.5, depth);
      return corners;
    }
    push(0, 0);
    push(w, 0);
    push(w, depth);
    push(0, depth);
    if (rule.reliefShape === 'round') {
      // A rounded end, which is the shape a punch actually leaves.
      const out = [];
      const steps = 8;
      for (let i = 0; i <= steps; i++) {
        const a = Math.PI * (i / steps);
        const ds = (w / 2) * (1 - Math.cos(a));
        const dn = depth + (w / 2) * Math.sin(a);
        out.push([
          p0[0] + d[0] * ds * dir + into[0] * dn,
          p0[1] + d[1] * ds * dir + into[1] * dn
        ]);
      }
      return [corners[0], corners[1], ...out.reverse()];
    }
    return corners;
  };

  const cuts = [];
  const span = Math.hypot(bend.b[0] - bend.a[0], bend.b[1] - bend.a[1]);
  if ((bend.v0 ?? 0) > 1e-6) cuts.push(notch(bend.v0, -1));
  if ((bend.v1 ?? span) < span - 1e-6) cuts.push(notch(bend.v1, 1));
  return cuts;
}

/* ------------------------------------------------------------------- flat */

/**
 * The flat pattern's outline, in the base panel's own plane.
 *
 * This is what a laser cuts and what the DXF carries: the outer boundary, the
 * holes, and the bend lines, which are not cut but are marked so the brake
 * operator knows where to put the part.
 */
export function flatOutline(part, thickness, k) {
  const frames = resolveFrames(part, thickness, k, { flat: true });
  const base = basePanel(part);
  if (!base) return null;
  const B = base.frame;

  // Everything is in the base panel's plane, so its own u and v are the sheet's.
  const toSheet = (p) => {
    const d = sub(p, B.origin);
    return [dot(d, B.x), dot(d, B.y)];
  };

  const cuts = [];
  const holes = [];
  for (const panel of part.panels) {
    const f = frames.get(panel.id);
    if (!f) continue;
    cuts.push(panel.contour.map((q) => toSheet(toWorld(f, q[0], q[1]))));
    for (const h of panel.holes || []) {
      holes.push(h.map((q) => toSheet(toWorld(f, q[0], q[1]))));
    }
  }

  const bendLines = [];
  for (const bend of part.bends) {
    const pf = frames.get(bend.from);
    if (!pf) continue;
    const g = bendGeometry(part, bend, pf, thickness);
    const allow = bendAllowance(bend.angle, bend.radius, thickness, k);
    const a0 = add(g.A, mul(g.D, bend.v0 ?? 0));
    const a1 = add(g.A, mul(g.D, bend.v1 ?? len(sub(g.B, g.A))));
    // Both edges of the bend zone, which is what the flat actually shows.
    bendLines.push([toSheet(a0), toSheet(a1)]);
    bendLines.push([
      toSheet(add(a0, mul(g.W, allow))),
      toSheet(add(a1, mul(g.W, allow)))
    ]);
  }

  return { panels: cuts, holes, bendLines };
}

/* ---------------------------------------------------------------- reading */

/**
 * Read an ordinary solid as a folded sheet.
 *
 * A sheet metal part is pairs of parallel flat faces one thickness apart, with
 * cylindrical faces of a consistent radius between them. Both are things the
 * topology already works out, so this is a matter of reading them rather than
 * of recognising shapes. What it cannot do is guess a thickness: that comes
 * from the rule, and a body that is not that thick is refused rather than
 * quietly converted to something the brake cannot make.
 */
export function readSheetMetal(mesh, topo, thickness) {
  const flats = topo.faces.filter((f) => f.planar && f.area > 1e-6);
  const pairs = [];
  const used = new Set();

  for (let i = 0; i < flats.length; i++) {
    if (used.has(i)) continue;
    for (let j = i + 1; j < flats.length; j++) {
      if (used.has(j)) continue;
      const a = flats[i];
      const b = flats[j];
      // Facing each other, one thickness apart.
      if (dot(a.normal, b.normal) > -0.999) continue;
      // b has to sit behind a's own face, one thickness away. Signed, because
      // two faces a thickness apart that both point outward are the two sides
      // of the sheet, and two that point at each other are a slot.
      const gap = dot(sub(b.centre, a.centre), a.normal);
      if (gap > 0) continue;
      if (Math.abs(-gap - thickness) > Math.max(0.02, thickness * 0.05)) continue;
      if (Math.abs(a.area - b.area) > Math.max(1, a.area * 0.35)) continue;
      pairs.push({ outer: a, inner: b, gap });
      used.add(i);
      used.add(j);
      break;
    }
  }
  if (!pairs.length) return null;

  const bends = topo.faces
    .filter((f) => !f.planar && f.cylinder)
    .map((f) => ({ face: f, ...f.cylinder }));

  return { pairs, bends, thickness };
}

/* -------------------------------------------------------------------- DXF */

/**
 * The flat, as a DXF a laser cutter will take.
 *
 * Written by hand as R12, which every machine and every shop reads without
 * argument. Cut geometry and bend lines go on separate layers, because they
 * mean different things to the operator: one is a path, the other is a mark.
 */
export function flatToDXF(outline, opts = {}) {
  const out = [];
  const pair = (code, value) => {
    out.push(String(code));
    out.push(String(value));
  };

  pair(0, 'SECTION');
  pair(2, 'HEADER');
  pair(9, '$INSUNITS');
  pair(70, 4); // millimetres
  pair(0, 'ENDSEC');

  pair(0, 'SECTION');
  pair(2, 'TABLES');
  pair(0, 'TABLE');
  pair(2, 'LAYER');
  pair(70, 2);
  for (const [name, colour] of [['CUT', 7], ['BEND', 1]]) {
    pair(0, 'LAYER');
    pair(2, name);
    pair(70, 0);
    pair(62, colour);
    pair(6, 'CONTINUOUS');
  }
  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');

  pair(0, 'SECTION');
  pair(2, 'ENTITIES');

  const polyline = (points, layer, closed) => {
    if (points.length < 2) return;
    pair(0, 'LWPOLYLINE');
    pair(8, layer);
    pair(90, points.length);
    pair(70, closed ? 1 : 0);
    for (const p of points) {
      pair(10, round(p[0]));
      pair(20, round(p[1]));
    }
  };

  for (const poly of outline.panels) polyline(poly, 'CUT', true);
  for (const hole of outline.holes) polyline(hole, 'CUT', true);
  if (opts.bendLines !== false) {
    for (const line of outline.bendLines) polyline(line, 'BEND', false);
  }

  pair(0, 'ENDSEC');
  pair(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

function round(v) {
  return Math.round(v * 1e6) / 1e6;
}

export { toWorld as panelPointToWorld, rotateVec, rotatePoint };
