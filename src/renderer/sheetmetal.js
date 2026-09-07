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

/**
 * The rules a new document starts with.
 *
 * A library rather than one rule, because a part that is aluminium at the
 * bracket and steel at the bracket's mount is two rules, and swapping the whole
 * document over to make the second one is how the first one gets lost. Every
 * one of these is an ordinary rule that can be edited or thrown away: they are
 * a starting point, not a fixed list.
 */
export const STOCK_RULES = [
  { ...DEFAULT_RULE },
  {
    name: 'Aluminium 3 mm',
    thickness: '3',
    bendRadius: '3',
    kFactor: '0.44',
    gap: '0.4',
    reliefShape: 'round',
    reliefWidth: '',
    reliefDepth: '',
    cornerShape: 'round',
    cornerSize: ''
  },
  {
    name: 'Mild steel 1 mm',
    thickness: '1',
    bendRadius: '1',
    kFactor: '0.41',
    gap: '0.15',
    reliefShape: 'round',
    reliefWidth: '',
    reliefDepth: '',
    cornerShape: 'round',
    cornerSize: ''
  },
  {
    name: 'Mild steel 2 mm',
    thickness: '2',
    bendRadius: '2',
    kFactor: '0.41',
    gap: '0.3',
    reliefShape: 'round',
    reliefWidth: '',
    reliefDepth: '',
    cornerShape: 'round',
    cornerSize: ''
  },
  {
    name: 'Stainless 1.5 mm',
    thickness: '1.5',
    bendRadius: '2.25',
    kFactor: '0.38',
    gap: '0.2',
    reliefShape: 'straight',
    reliefWidth: '',
    reliefDepth: '',
    cornerShape: 'square',
    cornerSize: ''
  }
];

/** A rule out of a library by name, or the first one if that name is gone. */
export function ruleByName(rules, name) {
  if (!Array.isArray(rules) || !rules.length) return { ...DEFAULT_RULE };
  return rules.find((r) => r.name === name) || rules[0];
}

/** A name nothing in the library is using yet. */
export function uniqueRuleName(rules, wanted) {
  const taken = new Set((rules || []).map((r) => r.name));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; i < 500; i++) {
    const tryName = `${wanted} ${i}`;
    if (!taken.has(tryName)) return tryName;
  }
  return `${wanted} ${Date.now()}`;
}

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
 * A hem: an edge folded back on itself.
 *
 * What it is for is not decoration. A raw sheet edge is sharp, it is weak, and
 * on a panel anyone will ever touch it has to go somewhere. Folding it back
 * doubles the thickness at the edge, which stiffens it, and buries the cut.
 *
 * All four kinds are the same thing said with different numbers, so none of
 * them needs new machinery: a hem is one or two flanges chained off the edge,
 * and the panel and bend tree already knows how to fold, unfold and flatten
 * those. The second flange's bend line is known without looking at any
 * geometry, because a flange panel's own outline is a rectangle this file wrote
 * itself: the far edge is at x equal to the height, every time.
 *
 * The inner radius matters more here than anywhere else. Folded to nothing the
 * metal cracks, so the radius is never allowed below a thousandth and defaults
 * to one thickness, which is about the tightest a bend brake will do without
 * marking the outside.
 */
export function addHem(part, parentId, line, opts = {}) {
  const parent = panelById(part, parentId);
  if (!parent) return null;

  const t = Math.max(1e-6, opts.thickness ?? 1);
  const r = Math.max(1e-6, opts.radius ?? t);
  const length = Math.max(1e-6, opts.length ?? t * 4);
  const kind = opts.kind || 'single';
  const relief = opts.relief !== false;
  const id = opts.id || 'hem';

  // Each entry is one fold: how far round, and how much flat after it.
  const folds = [];
  if (kind === 'teardrop') {
    // Round past halfway and then back on itself, which leaves the teardrop
    // shaped void the name comes from and brings the cut edge home to the
    // panel it started on.
    const first = ((opts.angle1 ?? 135) * Math.PI) / 180;
    const second = ((opts.angle2 ?? 90) * Math.PI) / 180;
    folds.push({ angle: first, radius: r, height: Math.max(1e-6, length * 0.6) });
    folds.push({ angle: second, radius: r, height: Math.max(1e-6, length * 0.4) });
  } else if (kind === 'rolled') {
    // One long turn rather than two, which is a curl and is what an edge gets
    // when it has to be safe to run a hand along.
    folds.push({
      angle: ((opts.angle ?? 270) * Math.PI) / 180,
      radius: Math.max(r, opts.rollRadius ?? r),
      height: length
    });
  } else if (kind === 'double') {
    // Folded, then the doubled edge folded again, so the cut ends up inside
    // two thicknesses of metal rather than one.
    folds.push({ angle: Math.PI, radius: r, height: length * 2 });
    folds.push({ angle: Math.PI, radius: r, height: length });
  } else {
    folds.push({ angle: Math.PI, radius: r, height: length });
  }

  const made = [];
  let onPanel = parentId;
  let onLine = line;

  folds.forEach((fold, i) => {
    const res = addFlangePanel(part, onPanel, onLine, {
      angle: fold.angle,
      radius: fold.radius,
      height: fold.height,
      panelId: `${id}:p${i}`,
      bendId: `${id}:b${i}`,
      // Relief is cut where the hem leaves the parent and nowhere else. A
      // relief notch in the middle of a hem would cut the fold in half.
      relief: relief && i === 0
    });
    if (!res) return;
    made.push(res);
    onPanel = res.panel.id;
    // The next fold happens at the far edge of the flange just made. Its
    // outline was written here, so where that edge is is known rather than
    // looked for: out from the bend line by the height.
    const far = fold.height - fold.radius;
    onLine = {
      a: [Math.max(1e-6, far), res.bend.v0],
      b: [Math.max(1e-6, far), res.bend.v1]
    };
  });

  return made.length ? made : null;
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

/* ---------------------------------------------------------------- corners */

/**
 * Where bends come together at a corner, and everything that meets there.
 *
 * Two bends off the same panel meet where their lines cross, which is a corner
 * of that panel and easy to see flat. A third is not: it belongs to a flange
 * that has already been folded away, so its bend line runs somewhere else
 * entirely and never passes through the point. What ties it to the corner is
 * the tree, not the geometry. A tab that closes the corner is a bend running
 * straight across the end of one of the two flanges, at exactly the distance
 * along that flange where the corner is, and that is what is looked for.
 *
 * This is the corner a two bend relief cannot see and the one that tears when
 * the part is folded, because three thicknesses of material converge on it.
 */
export function bendCorners(part, frames, thickness, tol = 1e-6) {
  const out = [];

  for (const parent of part.panels) {
    const outgoing = bendsFrom(part, parent.id);
    if (outgoing.length < 2) continue;
    const f = frames.get(parent.id);
    if (!f) continue;

    for (let i = 0; i < outgoing.length; i++) {
      for (let j = i + 1; j < outgoing.length; j++) {
        const at = bendsMeet(outgoing[i], outgoing[j]);
        if (!at) continue;

        const bends = [outgoing[i].id, outgoing[j].id];
        const radii = [outgoing[i].radius, outgoing[j].radius];
        for (const bend of [outgoing[i], outgoing[j]]) {
          for (const tab of closingBends(part, bend, at, tol)) {
            bends.push(tab.id);
            radii.push(tab.radius);
          }
        }
        out.push({
          point: toWorld(f, at[0], at[1]),
          panel: parent.id,
          bends,
          reach: Math.max(...radii) + (thickness || 0)
        });
      }
    }
  }
  return out;
}

/**
 * The bends across the end of a flange, at the corner its parent bend meets.
 *
 * A bend's child panel measures v along the bend line from its start, so the
 * corner sits at however far along that line it fell. A tab closing the corner
 * runs straight across the flange there, which means both ends of its line
 * share that v.
 */
function closingBends(part, bend, at, tol) {
  const along =
    (at[0] - bend.a[0]) * (bend.b[0] - bend.a[0]) +
    (at[1] - bend.a[1]) * (bend.b[1] - bend.a[1]);
  const span = Math.hypot(bend.b[0] - bend.a[0], bend.b[1] - bend.a[1]);
  if (!(span > EPS)) return [];
  const v = along / span;
  const near = Math.max(tol, span * 1e-6);

  return bendsFrom(part, bend.to).filter(
    (tab) => Math.abs(tab.a[1] - v) < near && Math.abs(tab.b[1] - v) < near
  );
}

/* ------------------------------------------------------------------ miter */

/**
 * Close the corner where two flanges meet.
 *
 * Two flanges off adjoining edges of the same panel do not overlap: each one
 * stands outside its own edge, so what they leave between them is a notch the
 * width of the material. A miter fills that notch and then cuts both on the
 * plane that bisects them, so the two ends meet along one line with the rule's
 * gap between them. Where the flanges do overlap instead, which is what
 * happens once a bend line sits inside the panel, the same cut trims them back.
 * Filling and trimming are the same operation from opposite sides, so it is
 * written once.
 *
 * The cut is straight through the thickness rather than bevelled, because the
 * blank is cut flat and that is the only shape it can have. The gap is measured
 * square to the miter plane, so the clearance is the same whatever angle the
 * two flanges meet at.
 */
export function miterCorners(part, frames, gap, opts = {}) {
  const half = Math.max(0, gap) / 2;
  const cuts = [];
  let corners = 0;

  for (const parent of part.panels) {
    const outgoing = bendsFrom(part, parent.id);
    if (outgoing.length < 2) continue;
    for (let i = 0; i < outgoing.length; i++) {
      for (let j = i + 1; j < outgoing.length; j++) {
        // The two bends have to meet, or these are opposite sides of the same
        // panel and there is no corner between them to close.
        if (!bendsMeet(outgoing[i], outgoing[j])) continue;
        const pair = miterPair(part, frames, outgoing[i], outgoing[j], half, opts);
        if (!pair) continue;
        cuts.push(...pair);
        corners++;
      }
    }
  }

  // Applied after every pair has been worked out, so a flange mitred against
  // two neighbours is measured against where it started rather than against
  // whichever cut happened to run first.
  for (const cut of cuts) {
    const panel = panelById(part, cut.id);
    if (panel) panel.contour = cut.contour;
  }
  return corners;
}

/** Do two bend lines off the same panel run into each other, within their runs? */
function bendsMeet(p, q, tol = 1e-6) {
  const r = [p.b[0] - p.a[0], p.b[1] - p.a[1]];
  const t = [q.b[0] - q.a[0], q.b[1] - q.a[1]];
  const denom = r[0] * t[1] - r[1] * t[0];
  if (Math.abs(denom) < 1e-9) return null;
  const u = ((q.a[0] - p.a[0]) * t[1] - (q.a[1] - p.a[1]) * t[0]) / denom;
  const v = ((q.a[0] - p.a[0]) * r[1] - (q.a[1] - p.a[1]) * r[0]) / denom;
  if (u < -tol || u > 1 + tol || v < -tol || v > 1 + tol) return null;
  return [p.a[0] + r[0] * u, p.a[1] + r[1] * u];
}

/** One corner: extend both flanges into it, then cut them on the bisector. */
function miterPair(part, frames, bendA, bendB, half, opts) {
  const idA = bendA.to;
  const idB = bendB.to;
  const A = panelById(part, idA);
  const B = panelById(part, idB);
  const fA = frames.get(idA);
  const fB = frames.get(idB);
  if (!A || !B || !fA || !fB) return null;

  // Parallel panels never come together along a line, so there is nothing to
  // bisect. Two flanges folded flat against each other are the usual case.
  const u = cross(fA.n, fB.n);
  if (len(u) < 1e-6) return null;
  const axis = unit(u);

  // A point on the line the two panel planes share.
  const dA = dot(fA.n, fA.origin);
  const dB = dot(fB.n, fB.origin);
  const onLine = mul(
    add(mul(cross(fB.n, u), dA), mul(cross(u, fA.n), dB)),
    1 / dot(u, u)
  );

  // Which way each panel's material lies off that line, square to it.
  const away = (panel, frame) => {
    const c = centroid(panel.contour);
    const w = sub(toWorld(frame, c[0], c[1]), onLine);
    return unit(sub(w, mul(axis, dot(w, axis))));
  };
  const eA = away(A, fA);
  const eB = away(B, fB);
  if (len(eA) < 0.5 || len(eB) < 0.5) return null;

  // The bisector's normal runs from B's material toward A's, so A keeps the
  // side it points into and B the other, each held back by half the gap.
  const n = unit(sub(eA, eB));
  if (len(n) < 0.5) return null;

  const reach =
    opts.reach ??
    Math.max(bendA.radius, bendB.radius) + (opts.thickness ?? 0) + half + 1e-3;

  const t = opts.thickness ?? 0;
  const cutA = fitToHalf(A, fA, n, onLine, half, +1, reach, t);
  const cutB = fitToHalf(B, fB, n, onLine, half, -1, reach, t);
  if (!cutA || !cutB) return null;
  return [
    { id: idA, contour: cutA },
    { id: idB, contour: cutB }
  ];
}

/**
 * A panel's contour brought to one side of a plane, in its own frame.
 *
 * `side` is +1 to keep the half the normal points into and -1 for the other.
 * The end nearest the plane is first run out by `reach` and then cut, so a
 * flange that stops short of the corner is carried into it and a flange that
 * overruns is taken back, both landing on the same line.
 *
 * Running the end out moves whichever vertices share the extreme value along
 * the bend line, which is exact for the rectangles and trapezia flanges are
 * made of and is the only shape a flange end takes.
 *
 * The cut goes straight through the thickness rather than following the
 * bisector through it, because a contour extruded along its normal is the only
 * shape a panel has and a laser cutting the blank is the only shape the real
 * part has either. So the material furthest through the thickness is what the
 * gap is measured from, not the face the contour sits on. Without that the two
 * flanges clear at one face and bite into each other at the other.
 */
function fitToHalf(panel, frame, n, onLine, half, side, reach, thickness) {
  const m = [dot(n, frame.x), dot(n, frame.y)];
  const mm = m[0] * m[0] + m[1] * m[1];
  // A panel standing square to the miter plane is never crossed by it.
  if (mm < 1e-12) return null;

  // Keep side * (n.X - n.onLine) >= half everywhere through the thickness, in
  // the panel's own coordinates.
  const worst = Math.max(0, -side * dot(n, frame.n)) * (thickness || 0);
  const c = half + worst + side * (dot(n, onLine) - dot(n, frame.origin));
  const normal = [-side * m[0], -side * m[1]];
  const origin = [(m[0] * side * c) / mm, (m[1] * side * c) / mm];
  const depth = (p) => side * (m[0] * p[0] + m[1] * p[1]) - c;

  let contour = panel.contour;
  // Only run the end out when the cut crosses the bend line rather than
  // running along it; along it there is no end to reach with.
  if (reach > 0 && Math.abs(m[1]) > Math.abs(m[0])) {
    const vs = contour.map((p) => p[1]);
    const hi = Math.max(...vs);
    const lo = Math.min(...vs);
    const atHi = contour.filter((p) => Math.abs(p[1] - hi) < 1e-6);
    const atLo = contour.filter((p) => Math.abs(p[1] - lo) < 1e-6);
    const worst = (list) => Math.min(...list.map(depth));
    const toHi = worst(atHi) < worst(atLo);
    const edge = toHi ? hi : lo;
    const moved = edge + (toHi ? reach : -reach);
    contour = contour.map((p) => (Math.abs(p[1] - edge) < 1e-6 ? [p[0], moved] : p));
  }

  return clipPolygon(contour, origin, normal);
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
