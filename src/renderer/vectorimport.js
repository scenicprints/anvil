/**
 * SVG and DXF into sketch entities.
 *
 * Both are read by hand rather than with a library, for the same reason the
 * expression parser is: opening a file must never be able to execute anything,
 * and neither format needs more than a tokenizer and some arithmetic.
 *
 * Everything comes out in millimetres with Y pointing up, which is the sketch's
 * convention. SVG counts Y downwards and DXF counts it upwards, so only one of
 * them gets flipped.
 *
 * Lines, circles and arcs keep their kind. Beziers and splines come in as
 * polylines, because a sketch has no bezier entity and pretending otherwise
 * would put a curve on screen that no dimension could ever describe.
 */

const CURVE_STEPS = 24;

/* ------------------------------------------------------------------ */
/* SVG                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Parse an SVG into `{ entities, width, height, units }`.
 *
 * Entities are `{kind:'line'|'circle'|'arc'|'poly', ...}` in a Y-up frame with
 * the drawing's own top-left at the origin, ready to be placed in a sketch.
 */
export function parseSVG(text, opts = {}) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('That file is not readable as SVG');
  const svg = doc.querySelector('svg');
  if (!svg) throw new Error('No <svg> element in that file');

  const size = svgSize(svg);
  const out = [];
  walk(svg, identity(), out, size);

  // SVG counts Y downwards. Flip once, here, rather than in every shape.
  for (const e of out) {
    for (const p of e.points || []) p.y = size.height - p.y;
    if (e.centre) e.centre.y = size.height - e.centre.y;
    if (e.kind === 'arc') {
      const a0 = e.start;
      e.start = -e.end;
      e.end = -a0;
    }
  }
  return { entities: out, width: size.width, height: size.height, units: 'mm' };
}

/**
 * The drawing's size in millimetres, and the scale from user units to it.
 *
 * A viewBox is what actually defines the coordinate system, and width/height
 * carry the real world size. When they disagree, the ratio between them is the
 * scale, which is how an SVG drawn at 96 dots per inch comes out life size.
 */
function svgSize(svg) {
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const hasBox = vb.length === 4 && vb.every(Number.isFinite);
  const wAttr = lengthToMm(svg.getAttribute('width'));
  const hAttr = lengthToMm(svg.getAttribute('height'));

  if (hasBox) {
    const [minX, minY, bw, bh] = vb;
    const sx = wAttr && bw ? wAttr / bw : 1;
    const sy = hAttr && bh ? hAttr / bh : sx;
    return { minX, minY, scale: sx, scaleY: sy, width: bw * sx, height: bh * (sy || sx) };
  }
  return {
    minX: 0,
    minY: 0,
    scale: 1,
    scaleY: 1,
    width: wAttr || 100,
    height: hAttr || 100
  };
}

/** A CSS length as millimetres. Unitless means user units, left as they are. */
function lengthToMm(v) {
  if (!v) return 0;
  const m = String(v).trim().match(/^(-?[\d.]+)\s*([a-z%]*)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] || '').toLowerCase();
  const per = {
    '': 1,
    px: 25.4 / 96,
    pt: 25.4 / 72,
    pc: 25.4 / 6,
    mm: 1,
    cm: 10,
    in: 25.4
  };
  return unit === '%' ? 0 : n * (per[unit] ?? 1);
}

const identity = () => [1, 0, 0, 1, 0, 0];

/** a then b, as SVG's own 2x3 matrix convention. */
function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

/**
 * The transform stack, flattened as it is walked.
 *
 * Nesting is why this has to be done on the way down rather than at the end: a
 * group's transform applies to everything inside it, and a child's own
 * transform sits inside that.
 */
function parseTransform(str) {
  let m = identity();
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(str))) {
    const n = hit[2].trim().split(/[\s,]+/).map(Number);
    const d = (i, dflt = 0) => (Number.isFinite(n[i]) ? n[i] : dflt);
    let t = identity();
    switch (hit[1]) {
      case 'matrix':
        t = [d(0, 1), d(1), d(2), d(3, 1), d(4), d(5)];
        break;
      case 'translate':
        t = [1, 0, 0, 1, d(0), d(1)];
        break;
      case 'scale':
        t = [d(0, 1), 0, 0, d(1, d(0, 1)), 0, 0];
        break;
      case 'rotate': {
        const a = (d(0) * Math.PI) / 180;
        const cx = d(1);
        const cy = d(2);
        const r = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        t = mul(mul([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan((d(0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan((d(0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
        break;
    }
    m = mul(m, t);
  }
  return m;
}

function walk(node, parentM, out, size) {
  for (const el of node.children || []) {
    const m = mul(parentM, parseTransform(el.getAttribute('transform')));
    const tag = el.tagName.toLowerCase();
    const num = (name, dflt = 0) => {
      const v = Number(el.getAttribute(name));
      return Number.isFinite(v) ? v : dflt;
    };
    // A shape used only as a clip or a definition is not geometry.
    if (tag === 'defs' || tag === 'clippath' || tag === 'mask') continue;

    const place = (x, y) => {
      const p = apply(m, x, y);
      return {
        x: (p.x - size.minX) * size.scale,
        y: (p.y - size.minY) * (size.scaleY || size.scale)
      };
    };

    if (tag === 'g' || tag === 'svg' || tag === 'a') {
      walk(el, m, out, size);
      continue;
    }

    if (tag === 'line') {
      out.push({
        kind: 'line',
        points: [place(num('x1'), num('y1')), place(num('x2'), num('y2'))]
      });
    } else if (tag === 'rect') {
      const x = num('x');
      const y = num('y');
      const w = num('width');
      const h = num('height');
      if (w > 0 && h > 0) {
        const c = [
          place(x, y),
          place(x + w, y),
          place(x + w, y + h),
          place(x, y + h)
        ];
        for (let i = 0; i < 4; i++) {
          out.push({ kind: 'line', points: [c[i], c[(i + 1) % 4]] });
        }
      }
    } else if (tag === 'circle') {
      const r = num('r');
      if (r > 0) {
        // Only a transform that scales both axes alike leaves a circle round.
        const scale = Math.hypot(m[0], m[1]);
        const even = Math.abs(scale - Math.hypot(m[2], m[3])) < 1e-6;
        if (even) {
          out.push({
            kind: 'circle',
            centre: place(num('cx'), num('cy')),
            r: r * scale * size.scale
          });
        } else {
          out.push({ kind: 'poly', closed: true, points: samplePoints(64, (t) =>
            place(num('cx') + r * Math.cos(t), num('cy') + r * Math.sin(t))) });
        }
      }
    } else if (tag === 'ellipse') {
      const rx = num('rx');
      const ry = num('ry');
      if (rx > 0 && ry > 0) {
        out.push({ kind: 'poly', closed: true, points: samplePoints(64, (t) =>
          place(num('cx') + rx * Math.cos(t), num('cy') + ry * Math.sin(t))) });
      }
    } else if (tag === 'polyline' || tag === 'polygon') {
      const nums = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      const pts = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push(place(nums[i], nums[i + 1]));
      if (pts.length >= 2) {
        out.push({ kind: 'poly', closed: tag === 'polygon', points: pts });
      }
    } else if (tag === 'path') {
      for (const sub of parsePath(el.getAttribute('d') || '', place)) out.push(sub);
    }

    if (el.children?.length) walk(el, m, out, size);
  }
}

function samplePoints(n, f) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(f((i / n) * Math.PI * 2));
  return pts;
}

/**
 * An SVG path's `d` attribute into polylines.
 *
 * Straight runs stay straight; every curve is flattened. The elliptical arc
 * command is converted through its centre form, which is the fiddly part of
 * the format and the reason a hand written reader is worth the space.
 */
function parsePath(d, place) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const out = [];
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let lastCtrl = null;
  let run = [];

  const flush = (closed) => {
    if (run.length >= 2) out.push({ kind: 'poly', closed: !!closed, points: run });
    run = [];
  };
  const num = () => Number(toks[i++]);
  const push = (x, y) => run.push(place(x, y));

  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'M') {
      const x = num();
      const y = num();
      flush(false);
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      startX = cx;
      startY = cy;
      push(cx, cy);
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') {
      const x = num();
      const y = num();
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      push(cx, cy);
    } else if (C === 'H') {
      const x = num();
      cx = rel ? cx + x : x;
      push(cx, cy);
    } else if (C === 'V') {
      const y = num();
      cy = rel ? cy + y : y;
      push(cx, cy);
    } else if (C === 'Z') {
      cx = startX;
      cy = startY;
      flush(true);
      push(cx, cy);
    } else if (C === 'C' || C === 'S') {
      let x1;
      let y1;
      if (C === 'C') {
        x1 = rel ? cx + num() : num();
        y1 = rel ? cy + num() : num();
      } else {
        // A smooth curve reflects the previous control point through the
        // current one, which is the whole point of the shorthand.
        x1 = lastCtrl ? 2 * cx - lastCtrl.x : cx;
        y1 = lastCtrl ? 2 * cy - lastCtrl.y : cy;
      }
      const x2 = rel ? cx + num() : num();
      const y2 = rel ? cy + num() : num();
      const x = rel ? cx + num() : num();
      const y = rel ? cy + num() : num();
      for (let k = 1; k <= CURVE_STEPS; k++) {
        const t = k / CURVE_STEPS;
        const u = 1 - t;
        push(
          u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
          u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y
        );
      }
      lastCtrl = { x: x2, y: y2 };
      cx = x;
      cy = y;
      continue;
    } else if (C === 'Q' || C === 'T') {
      let x1;
      let y1;
      if (C === 'Q') {
        x1 = rel ? cx + num() : num();
        y1 = rel ? cy + num() : num();
      } else {
        x1 = lastCtrl ? 2 * cx - lastCtrl.x : cx;
        y1 = lastCtrl ? 2 * cy - lastCtrl.y : cy;
      }
      const x = rel ? cx + num() : num();
      const y = rel ? cy + num() : num();
      for (let k = 1; k <= CURVE_STEPS; k++) {
        const t = k / CURVE_STEPS;
        const u = 1 - t;
        push(u * u * cx + 2 * u * t * x1 + t * t * x, u * u * cy + 2 * u * t * y1 + t * t * y);
      }
      lastCtrl = { x: x1, y: y1 };
      cx = x;
      cy = y;
      continue;
    } else if (C === 'A') {
      const rx = Math.abs(num());
      const ry = Math.abs(num());
      const rot = (num() * Math.PI) / 180;
      const large = num() !== 0;
      const sweep = num() !== 0;
      const x = rel ? cx + num() : num();
      const y = rel ? cy + num() : num();
      arcTo(cx, cy, rx, ry, rot, large, sweep, x, y, push);
      cx = x;
      cy = y;
      lastCtrl = null;
      continue;
    } else {
      i++;
      continue;
    }
    lastCtrl = null;
  }
  flush(false);
  return out;
}

/** SVG's endpoint arc, converted to a centre and swept. */
function arcTo(x0, y0, rx, ry, rot, large, sweep, x1, y1, push) {
  if (rx < 1e-12 || ry < 1e-12) {
    push(x1, y1);
    return;
  }
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const dx = (x0 - x1) / 2;
  const dy = (y0 - y1) / 2;
  const ux = cosR * dx + sinR * dy;
  const uy = -sinR * dx + cosR * dy;

  // The radii have to be big enough to reach; SVG says to scale them up if not.
  let lam = (ux * ux) / (rx * rx) + (uy * uy) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
    lam = 1;
  }
  const sign = large !== sweep ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * uy * uy - ry * ry * ux * ux;
  const den = rx * rx * uy * uy + ry * ry * ux * ux;
  const co = sign * Math.sqrt(Math.max(0, num / (den || 1)));
  const cxp = (co * rx * uy) / ry;
  const cyp = (-co * ry * ux) / rx;
  const ccx = cosR * cxp - sinR * cyp + (x0 + x1) / 2;
  const ccy = sinR * cxp + cosR * cyp + (y0 + y1) / 2;

  const ang = (vx, vy) => Math.atan2(vy, vx);
  const a0 = ang((ux - cxp) / rx, (uy - cyp) / ry);
  const a1 = ang((-ux - cxp) / rx, (-uy - cyp) / ry);
  let sweepAngle = a1 - a0;
  if (!sweep && sweepAngle > 0) sweepAngle -= Math.PI * 2;
  if (sweep && sweepAngle < 0) sweepAngle += Math.PI * 2;

  const steps = Math.max(4, Math.ceil((Math.abs(sweepAngle) / (Math.PI * 2)) * 64));
  for (let k = 1; k <= steps; k++) {
    const t = a0 + (sweepAngle * k) / steps;
    const px = rx * Math.cos(t);
    const py = ry * Math.sin(t);
    push(ccx + cosR * px - sinR * py, ccy + sinR * px + cosR * py);
  }
}

/* ------------------------------------------------------------------ */
/* DXF                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Parse a DXF's ENTITIES section.
 *
 * DXF is a flat list of group-code and value pairs, so the whole format is a
 * two-line-at-a-time read. Only the entity types a 2D drawing actually uses are
 * handled; anything else is skipped rather than guessed at.
 *
 * DXF already counts Y upwards, so nothing is flipped here.
 */
export function parseDXF(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([Number(lines[i].trim()), lines[i + 1].trim()]);
  }

  const out = [];
  let i = 0;
  // Straight to ENTITIES: the header and the tables carry no geometry.
  while (i < pairs.length && !(pairs[i][0] === 2 && pairs[i][1] === 'ENTITIES')) i++;

  let cur = null;
  const finish = () => {
    if (cur) emitDXF(cur, out);
    cur = null;
  };

  for (; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === 0) {
      finish();
      if (value === 'ENDSEC') break;
      cur = { type: value, v: {}, verts: [] };
      continue;
    }
    if (!cur) continue;
    if (cur.type === 'LWPOLYLINE' && code === 10) {
      cur.verts.push({ x: Number(value), y: 0 });
    } else if (cur.type === 'LWPOLYLINE' && code === 20) {
      if (cur.verts.length) cur.verts[cur.verts.length - 1].y = Number(value);
    } else {
      // Repeated codes keep the first, which is what the format means by them.
      if (cur.v[code] === undefined) cur.v[code] = value;
    }
  }
  finish();
  return { entities: out, units: 'mm' };
}

function emitDXF(e, out) {
  const n = (code, dflt = 0) => {
    const v = Number(e.v[code]);
    return Number.isFinite(v) ? v : dflt;
  };
  switch (e.type) {
    case 'LINE':
      out.push({
        kind: 'line',
        points: [
          { x: n(10), y: n(20) },
          { x: n(11), y: n(21) }
        ]
      });
      break;
    case 'CIRCLE':
      if (n(40) > 0) out.push({ kind: 'circle', centre: { x: n(10), y: n(20) }, r: n(40) });
      break;
    case 'ARC':
      if (n(40) > 0) {
        out.push({
          kind: 'arc',
          centre: { x: n(10), y: n(20) },
          r: n(40),
          start: (n(50) * Math.PI) / 180,
          end: (n(51) * Math.PI) / 180
        });
      }
      break;
    case 'LWPOLYLINE': {
      const pts = e.verts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (pts.length >= 2) {
        out.push({ kind: 'poly', closed: (n(70) & 1) === 1, points: pts });
      }
      break;
    }
    case 'POINT':
      out.push({ kind: 'point', points: [{ x: n(10), y: n(20) }] });
      break;
    default:
      break;
  }
}
