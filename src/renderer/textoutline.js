/**
 * Text to sketch contours.
 *
 * There is no font outline API in a browser, and shipping a font parser to read
 * the curves out of a TTF is a large amount of code for what a printed part
 * needs. So the text is drawn once at a high pixels-per-em onto a canvas and
 * its coverage is traced back out.
 *
 * The tracing is marching squares on the alpha channel with the crossing found
 * by linear interpolation rather than snapped to the pixel, which is what keeps
 * a curve smooth instead of stepped, followed by Douglas-Peucker to throw away
 * the points that were only carrying the raster's noise. At 220 pixels per em
 * and a tolerance of a third of a pixel that lands well inside the width of a
 * 0.4 mm nozzle for any text a part is likely to carry.
 *
 * Whatever fonts the machine has are available, because the canvas is the one
 * doing the shaping: ligatures, kerning and accents all come out right.
 */

const PPEM = 220;
const ISO = 0.5;
const SIMPLIFY_PX = 0.34;

export const TEXT_FONTS = [
  'Arial',
  'Helvetica',
  'Segoe UI',
  'Verdana',
  'Tahoma',
  'Times New Roman',
  'Georgia',
  'Courier New',
  'Consolas',
  'Impact'
];

/**
 * Outlines for a run of text, in sketch units.
 *
 * The baseline of the first line sits on y = 0 and the run starts at x = 0, so
 * the caller only has to place one point. Y is turned the right way up on the
 * way out, since a canvas counts downwards.
 */
export function textContours(text, opts = {}) {
  const {
    font = 'Arial',
    height = 10,
    bold = false,
    italic = false,
    align = 'left',
    lineSpacing = 1.2
  } = opts;

  const lines = String(text ?? '').split(/\r?\n/);
  if (!lines.some((l) => l.trim().length)) return [];

  const style = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}`;
  const face = `${style}${PPEM}px "${font}", sans-serif`;

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = face;
  const widths = lines.map((l) => measure.measureText(l).width);
  const widest = Math.max(...widths, 1);

  // Ample room above and below: an ascender, a descender, and a margin so the
  // trace never runs off the edge of the field and leaves a loop open.
  const pad = Math.ceil(PPEM * 0.35);
  const lineStep = PPEM * lineSpacing;
  const w = Math.ceil(widest + pad * 2);
  const h = Math.ceil(lineStep * (lines.length - 1) + PPEM * 1.6 + pad * 2);
  if (w * h > 40e6) return [];

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.font = face;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';

  const baseline0 = pad + PPEM;
  lines.forEach((line, i) => {
    if (!line.length) return;
    let x = pad;
    if (align === 'center') x = pad + (widest - widths[i]) / 2;
    else if (align === 'right') x = pad + (widest - widths[i]);
    ctx.fillText(line, x, baseline0 + i * lineStep);
  });

  const img = ctx.getImageData(0, 0, w, h).data;
  const field = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) field[i] = img[i * 4] / 255;

  const loops = traceLoops(field, w, h);

  // Into sketch units. The origin of the run is the left end of the first
  // baseline, so a text entity needs one point to be placed by.
  const s = height / PPEM;
  const ox = pad;
  const oy = baseline0;
  const shiftX = align === 'center' ? -widest / 2 : align === 'right' ? -widest : 0;

  const out = [];
  for (const loop of loops) {
    const simplified = simplify(loop, SIMPLIFY_PX);
    if (simplified.length < 3) continue;
    out.push(
      simplified.map((p) => ({
        x: (p.x - ox + shiftX) * s,
        y: (oy - p.y) * s
      }))
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Marching squares                                                    */
/* ------------------------------------------------------------------ */

/**
 * Where the iso level crosses between two samples. Interpolating rather than
 * taking the midpoint is the whole difference between a smooth letter and a
 * staircase, since the antialiased edge is a real coverage ramp.
 */
function cross(v0, v1, x0, y0, x1, y1) {
  const d = v1 - v0;
  const t = Math.abs(d) < 1e-9 ? 0.5 : (ISO - v0) / d;
  const c = Math.min(1, Math.max(0, t));
  return { x: x0 + (x1 - x0) * c, y: y0 + (y1 - y0) * c };
}

function traceLoops(field, w, h) {
  const at = (x, y) => field[y * w + x];
  const segs = [];

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      let code = 0;
      if (tl > ISO) code |= 8;
      if (tr > ISO) code |= 4;
      if (br > ISO) code |= 2;
      if (bl > ISO) code |= 1;
      if (code === 0 || code === 15) continue;

      const T = () => cross(tl, tr, x, y, x + 1, y);
      const R = () => cross(tr, br, x + 1, y, x + 1, y + 1);
      const B = () => cross(bl, br, x, y + 1, x + 1, y + 1);
      const L = () => cross(tl, bl, x, y, x, y + 1);

      // Wound so the filled area stays on the left, which is what lets the
      // segments be chained head to tail without hunting for a neighbour.
      switch (code) {
        case 1: segs.push([L(), B()]); break;
        case 2: segs.push([B(), R()]); break;
        case 3: segs.push([L(), R()]); break;
        case 4: segs.push([R(), T()]); break;
        case 6: segs.push([B(), T()]); break;
        case 7: segs.push([L(), T()]); break;
        case 8: segs.push([T(), L()]); break;
        case 9: segs.push([T(), B()]); break;
        case 11: segs.push([T(), R()]); break;
        case 12: segs.push([R(), L()]); break;
        case 13: segs.push([R(), B()]); break;
        case 14: segs.push([B(), L()]); break;
        // The two saddles. Which pair of corners is joined is genuinely
        // ambiguous from the corners alone, so the centre decides, and a
        // stroke that all but touches itself comes out as two edges rather
        // than one crossed figure of eight.
        case 5: {
          const mid = (tl + tr + br + bl) / 4;
          if (mid > ISO) {
            segs.push([L(), T()]);
            segs.push([R(), B()]);
          } else {
            segs.push([L(), B()]);
            segs.push([R(), T()]);
          }
          break;
        }
        case 10: {
          const mid = (tl + tr + br + bl) / 4;
          if (mid > ISO) {
            segs.push([T(), R()]);
            segs.push([B(), L()]);
          } else {
            segs.push([T(), L()]);
            segs.push([B(), R()]);
          }
          break;
        }
        default: break;
      }
    }
  }

  return chain(segs);
}

/** Join segments head to tail into closed loops. */
function chain(segs) {
  const from = new Map();
  for (const s of segs) {
    const k = key(s[0]);
    if (!from.has(k)) from.set(k, []);
    from.get(k).push(s);
  }

  const used = new Set();
  const loops = [];
  for (const s0 of segs) {
    if (used.has(s0)) continue;
    const loop = [s0[0]];
    let cur = s0;
    used.add(cur);
    // Bounded, so a malformed field can never spin here.
    for (let guard = 0; guard < segs.length + 4; guard++) {
      loop.push(cur[1]);
      const next = (from.get(key(cur[1])) || []).find((s) => !used.has(s));
      if (!next) break;
      used.add(next);
      cur = next;
      if (key(cur[1]) === key(s0[0])) {
        loop.push(cur[1]);
        break;
      }
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/* ------------------------------------------------------------------ */
/* Simplification                                                      */
/* ------------------------------------------------------------------ */

function perpDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

function dp(pts, first, last, tol, keep) {
  let worst = 0;
  let at = -1;
  for (let i = first + 1; i < last; i++) {
    const d = perpDistance(pts[i], pts[first], pts[last]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst > tol && at > 0) {
    dp(pts, first, at, tol, keep);
    keep.add(at);
    dp(pts, at, last, tol, keep);
  }
}

/**
 * Douglas-Peucker on a closed loop. The two points furthest apart are pinned
 * first so the run is split into two open chains; running it on a ring from an
 * arbitrary start collapses the whole thing when the ends happen to be close.
 */
function simplify(loop, tol) {
  const pts = loop.slice();
  if (pts.length > 1 && key(pts[0]) === key(pts[pts.length - 1])) pts.pop();
  const n = pts.length;
  if (n < 4) return pts;

  let a = 0;
  let b = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > best) {
      best = d;
      b = i;
    }
  }
  best = -1;
  for (let i = 0; i < n; i++) {
    const d = (pts[i].x - pts[b].x) ** 2 + (pts[i].y - pts[b].y) ** 2;
    if (d > best) {
      best = d;
      a = i;
    }
  }
  if (a > b) [a, b] = [b, a];

  const keep = new Set([a, b]);
  dp(pts, a, b, tol, keep);

  // The wrap-around half, walked as its own chain.
  const tail = [];
  for (let i = b; i < n; i++) tail.push(pts[i]);
  for (let i = 0; i <= a; i++) tail.push(pts[i]);
  const tailKeep = new Set([0, tail.length - 1]);
  dp(tail, 0, tail.length - 1, tol, tailKeep);
  for (const i of tailKeep) keep.add((b + i) % n);

  return [...keep].sort((x, y) => x - y).map((i) => pts[i]);
}

function key(p) {
  return `${Math.round(p.x * 64)}|${Math.round(p.y * 64)}`;
}
