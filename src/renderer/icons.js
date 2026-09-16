/**
 * The ribbon's pictures.
 *
 * Every command used to be a single grey character out of a symbol font, and a
 * ribbon of those reads as a tool from the nineties however good the tool
 * behind it is. These are small drawings instead, in the manner of Fusion's:
 * isometric blocks and planes and arrows, in a palette where the colour says
 * what kind of thing a command works on before its name is read. Blue is a
 * solid, cyan a surface, grey a mesh, orange sheet metal, pink plastic, purple
 * a form, green construction, gold inspection, red taking something away.
 *
 * They are drawn here in code rather than shipped as files so that the whole
 * set shares one projection, one light and one outline, and a new command gets
 * an icon by composing a few lines rather than by opening a drawing program.
 *
 * All of them sit in a 32 unit square and are drawn to read on the dark chrome.
 */

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

const PAL = {
  blue: ['#a9d8ff', '#58aef2', '#2f80d0'],
  cyan: ['#c8f1ff', '#6fd0ef', '#3ba3c9'],
  grey: ['#eef1f5', '#b6bfca', '#838e9c'],
  orange: ['#ffd9a8', '#f3a553', '#cf7b22'],
  pink: ['#ffc9e6', '#ec84bf', '#bf5591'],
  purple: ['#dcc0ff', '#ad7bf0', '#8352cc'],
  green: ['#c6f2ae', '#72c950', '#43a02f'],
  gold: ['#ffe79a', '#f4bd3c', '#c98f16'],
  red: ['#ffb0a8', '#ec6158', '#bf3d35'],
  tan: ['#f1dfc4', '#d7b98f', '#a88a5e']
};

const INK = '#e9eef5';
const EDGE = 'rgba(8, 12, 20, 0.55)';
const ACCENT = '#63b6ff';
const PLUS = '#57c24a';
const MINUS = '#ec6158';

/* ------------------------------------------------------------------ */
/* Drawing kit                                                         */
/* ------------------------------------------------------------------ */

const f = (n) => Math.round(n * 100) / 100;

function poly(points, fill, stroke = EDGE, width = 0.8) {
  const d = points.map((p) => `${f(p[0])},${f(p[1])}`).join(' ');
  return `<polygon points="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round"/>`;
}

function path(d, stroke = INK, width = 1.8, fill = 'none', extra = '') {
  return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
}

function circle(cx, cy, r, fill, stroke = EDGE, width = 0.8) {
  return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"/>`;
}

function ellipse(cx, cy, rx, ry, fill, stroke = EDGE, width = 0.8) {
  return `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"/>`;
}

function text(x, y, s, size, fill = INK, weight = 700) {
  return `<text x="${x}" y="${y}" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="middle">${s}</text>`;
}

/** Isometric projection: x runs down to the right, y down to the left, z up. */
function iso(x, y, z, o = [16, 17], s = 1) {
  return [o[0] + (x - y) * 0.866 * s, o[1] + (x + y) * 0.5 * s - z * s];
}

/** A box in isometric, lit from above and to the left. */
function box(x, y, z, dx, dy, dz, pal = PAL.blue, o = [16, 17]) {
  const P = (a, b, c) => iso(a, b, c, o);
  const top = [P(x, y, z + dz), P(x + dx, y, z + dz), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)];
  const left = [P(x, y + dy, z), P(x + dx, y + dy, z), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)];
  const right = [P(x + dx, y, z), P(x + dx, y + dy, z), P(x + dx, y + dy, z + dz), P(x + dx, y, z + dz)];
  return poly(left, pal[1]) + poly(right, pal[2]) + poly(top, pal[0]);
}

/** A cylinder standing up, drawn from its ellipses. */
function cyl(cx, cy, rx, h, pal = PAL.blue) {
  const ry = rx * 0.5;
  return (
    `<path d="M${f(cx - rx)},${f(cy)} L${f(cx - rx)},${f(cy - h)} A${f(rx)},${f(ry)} 0 0 1 ${f(cx + rx)},${f(cy - h)} L${f(cx + rx)},${f(cy)} A${f(rx)},${f(ry)} 0 0 1 ${f(cx - rx)},${f(cy)} Z" fill="${pal[1]}" stroke="${EDGE}" stroke-width="0.8"/>` +
    `<path d="M${f(cx)},${f(cy + ry)} A${f(rx)},${f(ry)} 0 0 0 ${f(cx + rx)},${f(cy)} L${f(cx + rx)},${f(cy - h)} A${f(rx)},${f(ry)} 0 0 1 ${f(cx)},${f(cy - h + ry)} Z" fill="${pal[2]}" opacity="0.9"/>` +
    ellipse(cx, cy - h, rx, ry, pal[0])
  );
}

function sphere(cx, cy, r, pal = PAL.blue) {
  return circle(cx, cy, r, pal[1]) + ellipse(cx - r * 0.3, cy - r * 0.35, r * 0.45, r * 0.3, pal[0], 'none') ;
}

function torus(cx, cy, rx, pal = PAL.blue) {
  return ellipse(cx, cy, rx, rx * 0.55, pal[1]) + ellipse(cx, cy - 0.8, rx * 0.45, rx * 0.22, '#333941') + ellipse(cx - rx * 0.35, cy - rx * 0.28, rx * 0.35, rx * 0.12, pal[0], 'none');
}

/** A flat plane in isometric, the green of construction. */
function plane(o = [16, 18], size = 11, pal = PAL.green, z = 0) {
  const P = (a, b) => iso(a, b, z, o);
  return poly([P(-size, -size), P(size, -size), P(size, size), P(-size, size)], pal[1] + 'cc', pal[2], 1);
}

/** A thin sheet, bent up at one end, the orange of sheet metal. */
function sheetL(pal = PAL.orange, o = [15, 19]) {
  return box(-9, -6, 0, 16, 12, 2, pal, o) + box(7, -6, 0, 2, 12, 12, pal, o);
}

function arrow(x1, y1, x2, y2, color = ACCENT, width = 2) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const h = 4.2;
  const a1 = [x2 - h * Math.cos(ang - 0.5), y2 - h * Math.sin(ang - 0.5)];
  const a2 = [x2 - h * Math.cos(ang + 0.5), y2 - h * Math.sin(ang + 0.5)];
  return (
    path(`M${f(x1)},${f(y1)} L${f(x2 - Math.cos(ang) * 2)},${f(y2 - Math.sin(ang) * 2)}`, color, width) +
    poly([[x2, y2], a1, a2], color, color, 0.6)
  );
}

function spin(cx, cy, r, color = ACCENT) {
  const a0 = -2.4;
  const a1 = 1.6;
  const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
  const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  const tangent = a1 + Math.PI / 2;
  const tip = [p1[0] + Math.cos(tangent) * 1.5, p1[1] + Math.sin(tangent) * 1.5];
  return (
    path(`M${f(p0[0])},${f(p0[1])} A${r},${r} 0 1 1 ${f(p1[0])},${f(p1[1])}`, color, 2) +
    poly(
      [tip, [p1[0] + Math.cos(a1) * 3.2, p1[1] + Math.sin(a1) * 3.2], [p1[0] - Math.cos(a1) * 3.2, p1[1] - Math.sin(a1) * 3.2]],
      color,
      color,
      0.5
    )
  );
}

/* A small round badge in the corner, which is how a variant says what it adds. */
const plusBadge = (x = 25, y = 25) =>
  circle(x, y, 5, PLUS, '#1d5e17', 0.8) + path(`M${x - 2.6},${y} H${x + 2.6} M${x},${y - 2.6} V${y + 2.6}`, '#fff', 1.6);
const minusBadge = (x = 25, y = 25) =>
  circle(x, y, 5, MINUS, '#7a211b', 0.8) + path(`M${x - 2.6},${y} H${x + 2.6}`, '#fff', 1.6);
const xBadge = (x = 25, y = 25) =>
  circle(x, y, 5, MINUS, '#7a211b', 0.8) + path(`M${x - 2},${y - 2} L${x + 2},${y + 2} M${x + 2},${y - 2} L${x - 2},${y + 2}`, '#fff', 1.5);
const checkBadge = (x = 25, y = 25) =>
  circle(x, y, 5, PLUS, '#1d5e17', 0.8) + path(`M${x - 2.5},${y} L${x - 0.6},${y + 2} L${x + 2.7},${y - 2.2}`, '#fff', 1.6);

const pencil = (x = 22, y = 5, color = PAL.gold) =>
  poly([[x, y + 13], [x + 2.5, y + 13.8], [x + 10, y + 3], [x + 7.5, y + 2.2]], color[1]) +
  poly([[x, y + 13], [x + 2.5, y + 13.8], [x - 0.6, y + 16]], '#f3e1c2');

const magnifier = (x = 22, y = 22, color = INK) =>
  circle(x - 2, y - 2, 4.5, 'rgba(99,182,255,0.25)', color, 1.8) + path(`M${x + 1.2},${y + 1.2} L${x + 6},${y + 6}`, color, 2.4);

const dashedRect = (x, y, w, h, color = ACCENT) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(99,182,255,0.10)" stroke="${color}" stroke-width="1.6" stroke-dasharray="3 2" rx="1"/>`;

const cursor = (x = 18, y = 14, color = '#ffffff') =>
  poly([[x, y], [x, y + 13], [x + 3.2, y + 10], [x + 5.6, y + 15], [x + 7.6, y + 14], [x + 5.2, y + 9.2], [x + 9.2, y + 9.2]], color, '#11161e', 0.9);

const dot = (x, y, r = 2, color = INK) => circle(x, y, r, color, '#11161e', 0.6);

/** A cage of quads, the purple of a form. */
const cage = (pal = PAL.purple) =>
  `<path d="M7,11 Q16,4 25,11 Q28,18 25,24 Q16,29 7,24 Q4,18 7,11 Z" fill="${pal[1]}" stroke="${pal[2]}" stroke-width="1"/>` +
  path('M16,6 Q13,17 16,28 M5,17 Q16,14 27,17', pal[0], 1.1) +
  dot(7, 11, 1.4, pal[0]) + dot(25, 11, 1.4, pal[0]) + dot(25, 24, 1.4, pal[0]) + dot(7, 24, 1.4, pal[0]);

/** A patch of triangles, the grey of a mesh. */
const meshPatch = (pal = PAL.grey) =>
  poly([[5, 22], [16, 8], [27, 20], [17, 28]], pal[1]) +
  path('M5,22 L27,20 M16,8 L17,28 M10.5,15 L22,24 M21.5,14 L11,25', pal[2], 0.9);

/** A curved surface panel, the cyan of surfaces. */
const surfacePanel = (pal = PAL.cyan) =>
  `<path d="M4,20 Q10,10 18,13 T29,9 L29,17 Q22,21 16,19 T4,26 Z" fill="${pal[1]}" stroke="${pal[2]}" stroke-width="1"/>` +
  path('M4,20 Q10,10 18,13 T29,9', pal[0], 1.2);

/* ------------------------------------------------------------------ */
/* Sketch strokes, drawn flat in ink with a blue accent                */
/* ------------------------------------------------------------------ */

const ends = (...pts) => pts.map(([x, y]) => dot(x, y, 1.7, ACCENT)).join('');

const S = {
  line: () => path('M6,24 L26,8') + ends([6, 24], [26, 8]),
  rect: () => path('M6,9 H26 V23 H6 Z') + ends([6, 9], [26, 23]),
  rectCentre: () => path('M6,9 H26 V23 H6 Z') + ends([16, 16], [26, 23]) + path('M16,16 L26,23', ACCENT, 1, 'none', 'stroke-dasharray="2 2"'),
  rect3: () => path('M5,19 L17,7 L27,17 L15,29 Z') + ends([5, 19], [17, 7], [27, 17]),
  circle: () => circle(16, 16, 10, 'none', INK, 1.8) + ends([16, 16]),
  circleDia: () => circle(16, 16, 10, 'none', INK, 1.8) + path('M6,16 H26', ACCENT, 1, 'none', 'stroke-dasharray="2 2"') + ends([6, 16], [26, 16]),
  circle3: () => circle(16, 16, 10, 'none', INK, 1.8) + ends([6, 16], [21, 7.3], [21, 24.7]),
  circleTan2: () => circle(17, 16, 7, 'none', INK, 1.8) + path('M4,9 H28 M4,23 H28', ACCENT, 1.4),
  circleTan3: () => circle(16, 18, 6, 'none', INK, 1.8) + path('M4,12 H28 M5,28 L16,5 M27,28 L16,5', ACCENT, 1.1),
  arc: () => path('M6,22 A10,10 0 0 1 26,22') + ends([16, 22], [6, 22], [26, 22]),
  arc3: () => path('M6,22 A10,10 0 0 1 26,22') + ends([6, 22], [16, 12], [26, 22]),
  arcTan: () => path('M4,24 H14', ACCENT, 1.6) + path('M14,24 A8,8 0 0 0 26,14') + ends([14, 24], [26, 14]),
  polygon: () => path('M16,5 L26,11 L26,21 L16,27 L6,21 L6,11 Z') + circle(16, 16, 11, 'none', ACCENT, 1, ) ,
  polygonCirc: () => path('M16,8 L23,12 L23,20 L16,24 L9,20 L9,12 Z') + circle(16, 16, 8, 'none', ACCENT, 1),
  polygonEdge: () => path('M16,5 L26,11 L26,21 L16,27 L6,21 L6,11 Z') + path('M6,21 L16,27', ACCENT, 2.6),
  slot: () => path('M10,10 H22 A6,6 0 0 1 22,22 H10 A6,6 0 0 1 10,10 Z') + ends([10, 16], [22, 16]),
  slotOverall: () => path('M10,10 H22 A6,6 0 0 1 22,22 H10 A6,6 0 0 1 10,10 Z') + ends([4, 16], [28, 16]),
  slotCentre: () => path('M10,10 H22 A6,6 0 0 1 22,22 H10 A6,6 0 0 1 10,10 Z') + ends([16, 16], [22, 16]),
  slotArc: () => path('M5,22 A12,12 0 0 1 27,22') + path('M5,22 A12,12 0 0 1 27,22', 'rgba(233,238,245,0.35)', 7) + ends([5, 22], [16, 10], [27, 22]),
  slotArcCentre: () => path('M5,24 A12,12 0 0 1 27,24', 'rgba(233,238,245,0.35)', 7) + path('M5,24 A12,12 0 0 1 27,24') + ends([16, 24], [5, 24]),
  ellipse: () => ellipse(16, 16, 11, 7, 'none', INK, 1.8) + ends([16, 16], [27, 16]),
  spline: () => path('M4,24 C10,4 18,30 28,8') + ends([4, 24], [12, 14], [20, 18], [28, 8]),
  splineCP: () => path('M4,24 L10,6 L20,28 L28,8', ACCENT, 1, 'none', 'stroke-dasharray="2 2"') + path('M4,24 C10,6 20,28 28,8') + ends([10, 6], [20, 28]),
  conic: () => path('M4,26 Q16,-2 28,26') + path('M4,26 L16,6 L28,26', ACCENT, 1, 'none', 'stroke-dasharray="2 2"'),
  blend: () => path('M3,22 H11', ACCENT, 2) + path('M21,10 H29', ACCENT, 2) + path('M11,22 C17,22 15,10 21,10'),
  blendG1: () => path('M3,22 H11', ACCENT, 2) + path('M21,10 H29', ACCENT, 2) + path('M11,22 C14,22 18,10 21,10', INK, 1.8, 'none', 'stroke-dasharray="3 1.5"'),
  point: () => path('M10,16 H22 M16,10 V22', ACCENT, 1.2) + dot(16, 16, 3, INK),
  text: () => text(16, 25, 'A', 22, INK, 800) + path('M5,28 H27', ACCENT, 1.4),
  select: () => cursor(10, 5),
  fillet: () => path('M6,26 V14 A8,8 0 0 1 14,6 H26') + path('M6,6 V26 M6,6 H26', 'rgba(233,238,245,0.3)', 1, 'none', 'stroke-dasharray="2 2"'),
  chamfer: () => path('M6,26 V13 L13,6 H26') + path('M6,13 V6 H13', 'rgba(233,238,245,0.3)', 1, 'none', 'stroke-dasharray="2 2"'),
  trim: () => path('M4,16 H13', INK) + path('M19,16 H28', 'rgba(233,238,245,0.35)', 1.6, 'none', 'stroke-dasharray="2 2"') + path('M16,4 V28', ACCENT, 1.6) + path('M20,9 L26,23 M26,9 L20,23', '#ff9d6e', 1.6),
  offset: () => path('M5,22 C10,8 22,8 27,22') + path('M9,26 C13,15 19,15 23,26', ACCENT, 1.8),
  breakCurve: () => path('M4,16 H14 M18,16 H28') + ends([14, 16], [18, 16]) + path('M16,6 V26', ACCENT, 1, 'none', 'stroke-dasharray="2 2"'),
  extend: () => path('M4,20 H18') + path('M18,20 H26', ACCENT, 1.8, 'none', 'stroke-dasharray="2.5 2"') + path('M27,6 V28', INK, 1.4),
  mirror: () => path('M16,3 V29', ACCENT, 1.2, 'none', 'stroke-dasharray="3 2"') + path('M4,24 L12,8 L12,24 Z') + path('M28,24 L20,8 L20,24 Z', INK, 1.8),
  patternRect: () => ['6,6', '18,6', '6,18', '18,18'].map((p) => { const [x, y] = p.split(','); return `<rect x="${x}" y="${y}" width="8" height="8" fill="none" stroke="${INK}" stroke-width="1.6"/>`; }).join(''),
  patternCirc: () => [0, 1, 2, 3, 4, 5].map((i) => { const a = (i * Math.PI) / 3; return circle(16 + 9 * Math.cos(a), 16 + 9 * Math.sin(a), 2.6, 'none', INK, 1.5); }).join('') + dot(16, 16, 1.5, ACCENT),
  scale: () => `<rect x="5" y="13" width="14" height="14" fill="none" stroke="rgba(233,238,245,0.4)" stroke-width="1.2" stroke-dasharray="2 2"/>` + `<rect x="5" y="5" width="22" height="22" fill="none" stroke="${INK}" stroke-width="1.6"/>` + arrow(12, 20, 24, 8, ACCENT, 1.6),
  move: () => arrow(16, 16, 16, 3) + arrow(16, 16, 16, 29) + arrow(16, 16, 3, 16) + arrow(16, 16, 29, 16),
  copy: () => `<rect x="5" y="9" width="14" height="17" rx="1.5" fill="none" stroke="${INK}" stroke-width="1.6"/><rect x="12" y="4" width="14" height="17" rx="1.5" fill="#333941" stroke="${ACCENT}" stroke-width="1.6"/>`,
  paste: () => `<rect x="6" y="6" width="17" height="22" rx="2" fill="${PAL.tan[1]}" stroke="${EDGE}"/><rect x="10" y="3" width="9" height="5" rx="1" fill="${PAL.grey[1]}" stroke="${EDGE}"/><rect x="12" y="12" width="14" height="16" rx="1" fill="#fff" stroke="${EDGE}"/>`,
  editText: () => text(12, 24, 'A', 18, INK, 800) + pencil(16, 4),
  construction: () => path('M4,26 L28,6', '#ffb35c', 2, 'none', 'stroke-dasharray="3 2.5"'),
  centerline: () => path('M4,26 L28,6', '#ffb35c', 2, 'none', 'stroke-dasharray="7 2 1.5 2"'),
  dimension: () => path('M5,10 V26 M27,10 V26', INK, 1.2) + arrow(15, 18, 6, 18, ACCENT, 1.4) + arrow(17, 18, 26, 18, ACCENT, 1.4) + text(16, 13, '25', 8, INK, 700),
  lookAt: () => dashedRect(6, 9, 20, 16) + circle(16, 17, 3, ACCENT, ACCENT) + path('M3,17 Q16,4 29,17 Q16,30 3,17', INK, 1.4),
  finish: () => circle(16, 16, 12, PLUS, '#1d5e17', 1) + path('M9.5,16.5 L14,21 L23,11', '#fff', 3),
  projectInto: () => box(-6, -6, 6, 12, 12, 8, PAL.blue, [16, 13]) + path('M6,27 H26', ACCENT, 2) + path('M11,21 V26 M21,21 V26', ACCENT, 1.2, 'none', 'stroke-dasharray="2 1.5"'),
  insertSvg: () => `<rect x="5" y="4" width="18" height="24" rx="2" fill="${PAL.grey[0]}" stroke="${EDGE}"/>` + text(14, 20, 'SVG', 7, '#2f80d0', 800) + arrow(27, 8, 27, 22, PLUS, 2),
  insertDxf: () => `<rect x="5" y="4" width="18" height="24" rx="2" fill="${PAL.grey[0]}" stroke="${EDGE}"/>` + text(14, 20, 'DXF', 7, '#cf7b22', 800) + arrow(27, 8, 27, 22, PLUS, 2)
};

/* Constraints, as the plain marks a drafter would write. */
const C = {
  horizontal: () => path('M4,16 H28', INK, 2.4),
  vertical: () => path('M16,4 V28', INK, 2.4),
  parallel: () => path('M8,26 L18,6 M15,26 L25,6', INK, 2.2),
  perpendicular: () => path('M6,25 H26 M16,25 V6', INK, 2.2),
  collinear: () => path('M4,28 L13,19 M19,13 L28,4', INK, 2.2) + ends([13, 19], [19, 13]),
  tangent: () => circle(14, 18, 8, 'none', INK, 1.8) + path('M4,10 H28', ACCENT, 2),
  equal: () => path('M7,12 H25 M7,20 H25', INK, 2.6),
  concentric: () => circle(16, 16, 11, 'none', INK, 1.8) + circle(16, 16, 5.5, 'none', ACCENT, 1.8),
  coincident: () => path('M5,26 L16,16 M27,26 L16,16', INK, 1.8) + dot(16, 16, 3, ACCENT),
  midpoint: () => path('M4,24 L28,8', INK, 1.8) + poly([[16, 11], [20, 16], [16, 21], [12, 16]], ACCENT, ACCENT),
  symmetric: () => path('M16,3 V29', ACCENT, 1.2, 'none', 'stroke-dasharray="3 2"') + path('M5,10 L12,22 M27,10 L20,22', INK, 2),
  fix: () => `<rect x="9" y="14" width="14" height="12" rx="2" fill="${PAL.gold[1]}" stroke="${EDGE}"/>` + path('M12,14 V10 A4,4 0 0 1 20,10 V14', INK, 2)
};

/* ------------------------------------------------------------------ */
/* Solid bits used over and over                                       */
/* ------------------------------------------------------------------ */

const B = {
  cube: (pal = PAL.blue) => box(-7, -7, 0, 14, 14, 12, pal, [16, 18]),
  slab: (pal = PAL.blue, o = [16, 20]) => box(-9, -7, 0, 18, 14, 5, pal, o),
  block: (pal = PAL.blue) => box(-9, -6, 0, 18, 12, 9, pal, [16, 20]),
  tall: (pal = PAL.blue) => box(-5, -5, 0, 10, 10, 16, pal, [16, 23])
};

/* ------------------------------------------------------------------ */
/* Every command                                                       */
/* ------------------------------------------------------------------ */

const ICONS = {
  /* ---- create ---- */
  newSketch: () => dashedRect(4, 8, 19, 16) + path('M8,20 L13,13 L17,17 L20,12', INK, 1.6) + plusBadge(25, 25),
  extrude: () => B.slab(PAL.blue, [15, 23]) + arrow(15, 16, 15, 3, ACCENT, 2.2),
  revolve: () => cyl(15, 24, 9, 10, PAL.blue) + spin(15, 9, 6),
  hole: () => B.slab(PAL.blue, [16, 21]) + ellipse(16, 16.5, 5, 2.6, '#1b2530') + path('M16,4 V14', ACCENT, 1.6, 'none', 'stroke-dasharray="2 2"'),
  coil: () => path('M8,26 C24,26 24,21 8,21 C24,21 24,16 8,16 C24,16 24,11 8,11 C24,11 24,6 8,6', PAL.blue[1], 3) + path('M8,26 C24,26 24,21 8,21 C24,21 24,16 8,16 C24,16 24,11 8,11 C24,11 24,6 8,6', PAL.blue[0], 1),
  sweep: () => path('M4,26 C10,26 12,10 26,8', '#ffb35c', 1.4, 'none', 'stroke-dasharray="3 2"') + `<path d="M4,26 C10,26 12,10 26,8" fill="none" stroke="${PAL.blue[1]}" stroke-width="7" stroke-linecap="round"/>` + path('M4,24 C10,24 12,8 26,6', PAL.blue[0], 1.4),
  loft: () => poly([[4, 25], [12, 29], [12, 20], [4, 16]], PAL.blue[1]) + poly([[20, 12], [28, 8], [28, 3], [20, 7]], PAL.blue[2]) + poly([[12, 29], [28, 8], [28, 3], [12, 20]], PAL.blue[0] + 'bb') + poly([[4, 16], [12, 20], [28, 3], [20, 7]], PAL.blue[0]),
  rib: () => B.slab(PAL.blue, [16, 25]) + box(-1.2, -9, 5, 2.4, 18, 10, PAL.blue, [16, 25]),
  web: () => B.slab(PAL.blue, [16, 25]) + box(-1, -9, 5, 2, 18, 9, PAL.blue, [16, 25]) + box(-9, -1, 5, 18, 2, 9, PAL.blue, [16, 25]),
  emboss: () => B.slab(PAL.blue, [16, 22]) + text(16, 17, 'A', 11, PAL.blue[0], 900),
  thread: () => cyl(16, 26, 7, 20, PAL.grey) + path('M9,22 L23,19 M9,17 L23,14 M9,12 L23,9', PAL.grey[2], 1.6),
  primBox: () => B.cube(),
  primCyl: () => cyl(16, 25, 10, 14),
  primSphere: () => sphere(16, 16, 11),
  primTorus: () => torus(16, 17, 12),
  primPipe: () => cyl(16, 25, 10, 14) + ellipse(16, 11, 5, 2.5, '#1b2530'),
  primitive: () => B.cube(),
  pattern: () => box(-9, -9, 0, 7, 7, 7, PAL.blue, [16, 16]) + box(2, -9, 0, 7, 7, 7, PAL.blue, [16, 16]) + box(-9, 2, 0, 7, 7, 7, PAL.blue, [16, 16]) + box(2, 2, 0, 7, 7, 7, PAL.blue, [16, 16]),
  patternRect: () => ICONS.pattern(),
  patternCirc: () => [0, 1, 2, 3, 4, 5].map((i) => { const a = (i * Math.PI) / 3; return cyl(16 + 10 * Math.cos(a), 18 + 6 * Math.sin(a), 3, 4); }).join(''),
  patternPath: () => path('M3,26 C10,10 20,24 29,8', '#ffb35c', 1.3, 'none', 'stroke-dasharray="3 2"') + box(-2, -2, 0, 5, 5, 5, PAL.blue, [6, 22]) + box(-2, -2, 0, 5, 5, 5, PAL.blue, [16, 18]) + box(-2, -2, 0, 5, 5, 5, PAL.blue, [26, 12]),
  patternFeature: () => B.slab(PAL.blue, [16, 24]) + cyl(10, 17, 3, 4) + cyl(22, 17, 3, 4) + cyl(16, 13, 3, 4),
  mirror: () => path('M16,2 V30', PAL.green[1], 1.6, 'none', 'stroke-dasharray="3 2"') + box(-4, -4, 0, 8, 8, 10, PAL.blue, [8, 22]) + box(-4, -4, 0, 8, 8, 10, PAL.blue, [24, 22]),
  textureRelief: () => B.slab(PAL.tan, [16, 21]) + path('M5,15 Q8,12 11,15 T17,15 T23,15 T29,15 M6,19 Q9,16 12,19 T18,19 T24,19', PAL.tan[2], 1.2),
  makeTexture: () => `<rect x="4" y="4" width="17" height="14" rx="1.5" fill="${PAL.cyan[1]}" stroke="${EDGE}"/><path d="M5,16 L10,10 L14,14 L17,11 L20,16 Z" fill="${PAL.green[1]}"/>` + arrow(14, 20, 20, 26, ACCENT, 1.8) + box(-3, -4, 0, 6, 8, 2, PAL.tan, [24, 26]),
  thickenSolid: () => surfacePanel() + arrow(16, 22, 16, 30, ACCENT, 1.8),
  boundaryFill: () => poly([[4, 22], [16, 28], [28, 22], [16, 16]], PAL.cyan[1] + 'cc', PAL.cyan[2]) + poly([[16, 4], [16, 28], [28, 22], [28, 10]], PAL.cyan[2] + 'aa', PAL.cyan[2]) + box(-4, -4, 0, 8, 8, 8, PAL.blue, [16, 21]),
  insertDerive: () => B.cube(PAL.blue) + path('M20,8 A5,5 0 1 1 27,12', PLUS, 2) + poly([[27, 5], [27, 11], [22, 8]], PLUS, PLUS),

  /* ---- modify ---- */
  pressPull: () => B.slab(PAL.blue, [15, 23]) + poly([[15, 13.8], [22.8, 18.3], [15, 22.8], [7.2, 18.3]], PAL.gold[1] + 'dd') + arrow(15, 18, 15, 3, ACCENT, 2.2),
  fillet: () => `<path d="M6,27 V14 A9,9 0 0 1 15,5 H27 V27 Z" fill="${PAL.blue[1]}" stroke="${EDGE}" stroke-width="0.8"/>` + path('M6,14 A9,9 0 0 1 15,5', PAL.gold[0], 2.4),
  chamfer: () => poly([[6, 27], [6, 13], [14, 5], [27, 5], [27, 27]], PAL.blue[1]) + path('M6,13 L14,5', PAL.gold[0], 2.4),
  shell: () => box(-9, -8, 0, 18, 16, 12, PAL.blue, [16, 22]) + poly([iso(-7, -6, 12, [16, 22]), iso(7, -6, 12, [16, 22]), iso(7, 6, 12, [16, 22]), iso(-7, 6, 12, [16, 22])], '#1b2a3c'),
  fullRound: () => box(-9, -3, 0, 18, 6, 11, PAL.blue, [16, 22]) + path('M6,13 Q16,0 26,13', PAL.gold[0], 2.2),
  draft: () => poly([[8, 27], [24, 27], [21, 7], [11, 7]], PAL.blue[1]) + path('M16,4 V29', PAL.green[1], 1.2, 'none', 'stroke-dasharray="2 2"') + path('M24,27 L21,7', PAL.gold[0], 2),
  scale: () => box(-4, -4, 0, 8, 8, 8, PAL.blue, [11, 25]) + `<rect x="5" y="4" width="23" height="23" fill="none" stroke="rgba(233,238,245,0.45)" stroke-width="1.2" stroke-dasharray="3 2"/>` + arrow(15, 17, 26, 6, ACCENT, 1.8),
  combine: () => box(-8, -8, 0, 11, 11, 11, PAL.blue, [14, 22]) + box(-3, -3, 0, 11, 11, 11, PAL.cyan, [18, 22]) + plusBadge(26, 26),
  offsetFace: () => B.block(PAL.blue) + poly([iso(9, -6, 0, [16, 20]), iso(9, 6, 0, [16, 20]), iso(9, 6, 9, [16, 20]), iso(9, -6, 9, [16, 20])], PAL.gold[1]) + arrow(24, 16, 30, 13, ACCENT, 1.8),
  replaceFace: () => B.block(PAL.blue) + surfacePanel(PAL.cyan).replace('<path', '<path transform="translate(0,-10) scale(1,0.8)"'),
  splitFace: () => B.block(PAL.blue) + path('M4,14 L28,14', PAL.green[1], 2),
  splitBody: () => box(-9, -6, 0, 18, 12, 5, PAL.blue, [16, 25]) + box(-9, -6, 0, 18, 12, 5, PAL.blue, [16, 16]) + path('M3,19 H29', PAL.green[1], 1.6, 'none', 'stroke-dasharray="3 2"'),
  silhouetteSplit: () => sphere(16, 16, 11, PAL.blue) + path('M5,16 Q16,22 27,16', PAL.gold[0], 2),
  split: () => ICONS.splitBody(),
  move: () => B.cube(PAL.blue) + S.move().replace(/<path/g, '<path opacity="0.95"'),
  align: () => box(-9, -6, 0, 18, 12, 4, PAL.grey, [16, 26]) + box(-5, -5, 0, 10, 10, 8, PAL.blue, [16, 16]) + arrow(16, 4, 16, 12, ACCENT, 1.8),
  deleteBody: () => B.cube(PAL.blue) + xBadge(25, 25),
  deleteFace: () => B.block(PAL.blue) + poly([iso(-9, -6, 9, [16, 20]), iso(9, -6, 9, [16, 20]), iso(9, 6, 9, [16, 20]), iso(-9, 6, 9, [16, 20])], '#1b2a3c') + minusBadge(25, 25),
  measure: () => poly([[3, 20], [22, 5], [29, 13], [10, 28]], PAL.gold[1]) + path('M8,21 L10,23 M12,17 L15,20 M16,14 L18,16 M20,11 L23,14 M24,8 L26,10', '#6e4b00', 1.2),
  parameters: () => text(15, 23, 'ƒx', 17, INK, 700) + path('M4,27 H27', ACCENT, 1.4),
  physicalMaterial: () => sphere(16, 16, 11, PAL.grey) + path('M8,20 Q16,12 24,20 M8,13 Q16,5 24,13', PAL.grey[2], 1),
  appearance: () => circle(16, 16, 12, '#ffffff22', EDGE) + `<path d="M16,16 L16,4 A12,12 0 0 1 26.4,10 Z" fill="${PAL.red[1]}"/><path d="M16,16 L26.4,10 A12,12 0 0 1 26.4,22 Z" fill="${PAL.gold[1]}"/><path d="M16,16 L26.4,22 A12,12 0 0 1 16,28 Z" fill="${PAL.green[1]}"/><path d="M16,16 L16,28 A12,12 0 0 1 5.6,22 Z" fill="${PAL.cyan[1]}"/><path d="M16,16 L5.6,22 A12,12 0 0 1 5.6,10 Z" fill="${PAL.blue[1]}"/><path d="M16,16 L5.6,10 A12,12 0 0 1 16,4 Z" fill="${PAL.purple[1]}"/>`,
  computeAll: () => cyl(16, 26, 8, 16, PAL.grey) + spin(16, 13, 5, PLUS),

  /* ---- configure and document ---- */
  configurations: () => `<rect x="4" y="5" width="24" height="22" rx="2" fill="${PAL.grey[0]}" stroke="${EDGE}"/>` + path('M4,12 H28 M12,5 V27', PAL.grey[2], 1.2) + `<rect x="14" y="14" width="12" height="4" fill="${PAL.blue[1]}"/><rect x="14" y="20" width="12" height="4" fill="${PAL.green[1]}"/>`,
  documentInfo: () => `<path d="M7,3 H20 L26,9 V29 H7 Z" fill="${PAL.grey[0]}" stroke="${EDGE}"/>` + path('M11,14 H22 M11,19 H22 M11,24 H18', PAL.grey[2], 1.6),
  addNote: () => `<path d="M5,5 H27 V21 L21,27 H5 Z" fill="${PAL.gold[0]}" stroke="${EDGE}"/>` + path('M9,11 H23 M9,16 H20', '#8a6a10', 1.6),
  namedVersions: () => circle(16, 16, 12, PAL.cyan[0], EDGE) + path('M16,8 V16 L22,20', '#1b3a4c', 2.2),
  toggleHistory: () => `<rect x="3" y="11" width="26" height="10" rx="2" fill="${PAL.grey[1]}" stroke="${EDGE}"/>` + [7, 13, 19, 25].map((x) => `<rect x="${x - 2}" y="13" width="4" height="6" fill="${PAL.blue[1]}"/>`).join(''),
  teacher: () => `<path d="M3,12 L16,6 L29,12 L16,18 Z" fill="${PAL.blue[1]}" stroke="${EDGE}"/>` + path('M9,15 V22 Q16,27 23,22 V15', INK, 1.8) + path('M27,13 V21', PAL.gold[1], 1.8),

  /* ---- make, simulate, render ---- */
  simulate: () => B.block(PAL.grey) + `<path d="M7,17 L16,12 L25,17" fill="none" stroke="${PAL.red[1]}" stroke-width="2.4"/>` + arrow(16, 2, 16, 11, PAL.red[1], 2),
  generative: () => `<path d="M5,26 C5,16 12,18 12,10 C12,4 20,4 20,10 C20,18 27,16 27,26 Z" fill="${PAL.green[1]}" stroke="${EDGE}"/>` + circle(16, 10, 3, '#1b2a3c', 'none') + path('M8,26 H24', PAL.green[2], 1.4),
  clearStress: () => B.block(PAL.grey) + xBadge(25, 25),
  animate: () => B.cube(PAL.blue) + poly([[20, 19], [29, 24], [20, 29]], PLUS, '#1d5e17'),
  render: () => `<path d="M4,10 H11 L13,7 H19 L21,10 H28 V26 H4 Z" fill="${PAL.grey[1]}" stroke="${EDGE}"/>` + circle(16, 18, 5.5, PAL.blue[0], EDGE) + circle(16, 18, 2.5, PAL.blue[2], 'none'),
  print3D: () => `<rect x="4" y="4" width="24" height="5" fill="${PAL.grey[1]}" stroke="${EDGE}"/>` + poly([[14, 9], [18, 9], [16, 14]], PAL.orange[1]) + box(-6, -6, 0, 12, 12, 7, PAL.orange, [16, 25]) + path('M4,28 H28', PAL.grey[2], 2),
  exportStl: () => B.cube(PAL.blue) + arrow(22, 14, 30, 6, PLUS, 2),

  /* ---- construct ---- */
  construct: () => plane([16, 20], 10) + path('M16,4 V20', PAL.gold[1], 1.8) + dot(16, 20, 2.2, PAL.gold[0]),
  offsetPlane: () => plane([14, 23], 9) + plane([18, 13], 9, PAL.green) + arrow(18, 22, 18, 13, ACCENT, 1.4),

  /* ---- inspect ---- */
  sectionAnalysis: () => box(-9, -8, 0, 9, 16, 14, PAL.blue, [18, 22]) + poly([iso(0, -8, 0, [18, 22]), iso(0, 8, 0, [18, 22]), iso(0, 8, 14, [18, 22]), iso(0, -8, 14, [18, 22])], PAL.red[1]) + plane([22, 16], 5, PAL.green),
  centreOfMass: () => sphere(16, 16, 11, PAL.grey) + `<path d="M16,16 L16,5 A11,11 0 0 1 27,16 Z M16,16 L16,27 A11,11 0 0 1 5,16 Z" fill="#20252e"/>`,
  interference: () => box(-8, -8, 0, 11, 11, 11, PAL.blue, [14, 22]) + box(-3, -3, 0, 11, 11, 11, PAL.cyan, [18, 22]) + poly([[14, 13], [18, 11], [18, 16], [14, 18]], PAL.red[1], PAL.red[2]),
  draftAnalysis: () => poly([[6, 27], [16, 5], [26, 27]], PAL.green[1]) + poly([[16, 5], [26, 27], [16, 27]], PAL.red[1]) + poly([[11, 16], [16, 5], [21, 16]], PAL.gold[1], 'none'),
  curvatureComb: () => path('M4,24 C10,8 22,8 28,24', INK, 2) + path('M7,17 L5,12 M10,13 L9,6 M16,11 L16,3 M22,13 L23,6 M25,17 L27,12', PAL.purple[1], 1.4) + path('M5,12 Q16,-2 27,12', PAL.purple[0], 1),
  curvatureMap: () => `<defs><linearGradient id="icCurv" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3b6fe0"/><stop offset="0.5" stop-color="#57c24a"/><stop offset="1" stop-color="#ec6158"/></linearGradient></defs>` + `<path d="M4,26 C6,10 14,6 28,6 V26 Z" fill="url(#icCurv)" stroke="${EDGE}"/>`,
  minimumRadius: () => path('M5,27 V15 A10,10 0 0 1 15,5 H27', INK, 2.2) + circle(15, 15, 10, 'none', PAL.red[1], 1.2) + arrow(15, 15, 8, 8, PAL.red[1], 1.4),
  zebraAnalysis: () => `<clipPath id="icZeb"><path d="M4,26 C6,10 14,6 28,6 V26 Z"/></clipPath><g clip-path="url(#icZeb)"><rect x="0" y="0" width="32" height="32" fill="#f4f4f4"/>${[0, 1, 2, 3, 4].map((i) => `<path d="M${-4 + i * 8},32 L${8 + i * 8},0" stroke="#11161e" stroke-width="3.5"/>`).join('')}</g><path d="M4,26 C6,10 14,6 28,6 V26 Z" fill="none" stroke="${EDGE}"/>`,
  environmentMap: () => sphere(16, 16, 11, PAL.cyan) + path('M5,16 H27 M16,5 Q10,16 16,27 M16,5 Q22,16 16,27', PAL.cyan[2], 1),
  accessibility: () => B.block(PAL.blue) + arrow(4, 4, 12, 12, PAL.gold[1], 2) + arrow(28, 4, 21, 12, PAL.gold[1], 2),
  designAdvice: () => B.block(PAL.blue) + circle(24, 9, 6, PAL.gold[1], EDGE) + text(24, 13, '!', 10, '#3a2a00', 900),
  surfaceContinuity: () => surfacePanel() + path('M16,5 V29', PAL.gold[1], 1.2, 'none', 'stroke-dasharray="2 2"') + text(24, 29, 'G2', 8, PAL.gold[0], 800),
  isocurveAnalysis: () => surfacePanel() + path('M10,13 Q12,20 10,24 M16,12 Q18,18 16,22 M22,10 Q24,15 22,20', '#1b3a4c', 1.2),
  validate: () => B.cube(PAL.blue) + checkBadge(25, 25),
  colourByComponent: () => box(-8, -8, 0, 8, 8, 10, PAL.blue, [16, 22]) + box(0, -8, 0, 8, 8, 10, PAL.green, [16, 22]) + box(-8, 0, 0, 16, 8, 6, PAL.orange, [16, 22]),
  colourByFeature: () => box(-9, -7, 0, 18, 14, 5, PAL.blue, [16, 24]) + box(-5, -3, 5, 10, 6, 5, PAL.gold, [16, 24]) + box(-2, -1, 10, 4, 2, 5, PAL.red, [16, 24]),
  clearAnalysis: () => B.cube(PAL.grey) + circle(25, 25, 5, PAL.grey[0], EDGE) + path('M22,25 H28', '#333', 1.6),
  inspect: () => magnifier(18, 18),

  /* ---- insert ---- */
  insertMesh: () => meshPatch() + arrow(26, 2, 26, 12, PLUS, 2),
  insertComponent: () => B.cube(PAL.blue) + arrow(26, 2, 26, 11, PLUS, 2),
  insertCanvas: () => `<rect x="3" y="6" width="26" height="20" rx="1.5" fill="${PAL.cyan[0]}" stroke="${EDGE}"/><path d="M4,24 L12,14 L18,20 L22,16 L28,24 Z" fill="${PAL.green[1]}"/>` + circle(22, 11, 2.5, PAL.gold[1], 'none'),
  insertDecal: () => B.block(PAL.blue) + `<path d="M12,9 L22,5 L22,13 L12,17 Z" fill="${PAL.gold[0]}" stroke="${EDGE}"/>` + circle(17, 10, 1.8, PAL.red[1], 'none'),
  wrapImage: () => cyl(16, 26, 10, 18, PAL.blue) + `<path d="M6,14 Q16,19 26,14 V21 Q16,26 6,21 Z" fill="${PAL.gold[0]}" opacity="0.9"/>`,
  refreshDerived: () => B.cube(PAL.blue) + spin(24, 8, 5, PLUS),
  editInPlace: () => B.cube(PAL.blue) + pencil(18, 6),
  breakLink: () => path('M5,20 L11,14 A4,4 0 0 1 17,20', INK, 2.4) + path('M27,12 L21,18 A4,4 0 0 1 15,12', INK, 2.4) + path('M14,24 L10,28 M22,4 L18,8', PAL.red[1], 2),
  insertParts: () => ICONS.insertComponent(),

  /* ---- assemble ---- */
  newComponent: () => box(-8, -8, 0, 16, 16, 12, PAL.blue, [16, 21]) + path('M5,9 L16,4 L27,9', PAL.gold[1], 1.4) + plusBadge(25, 25),
  newJoint: () => box(-9, -6, 0, 18, 12, 4, PAL.grey, [16, 27]) + box(-5, -5, 0, 10, 10, 8, PAL.blue, [16, 14]) + circle(16, 19.5, 3.4, PAL.gold[1], EDGE) + dot(16, 19.5, 1.2, '#333'),
  assemble: () => ICONS.newJoint(),
  asBuiltJoint: () => ICONS.newJoint() + checkBadge(26, 7),
  jointOrigin: () => circle(16, 17, 7, 'none', PAL.gold[1], 2) + path('M16,4 V30 M3,17 H29', PAL.gold[1], 1.2) + dot(16, 17, 2.2, PAL.gold[0]),
  groundToParent: () => B.cube(PAL.blue) + path('M6,29 H26 M9,31 H23', PAL.grey[1], 1.8) + path('M16,24 V29', PAL.grey[1], 1.8),
  constrainComponents: () => box(-4, -4, 0, 8, 8, 8, PAL.blue, [9, 24]) + box(-4, -4, 0, 8, 8, 8, PAL.cyan, [23, 14]) + path('M12,20 L20,14', PAL.gold[1], 2),
  rigidGroup: () => box(-4, -4, 0, 8, 8, 8, PAL.blue, [10, 22]) + box(-4, -4, 0, 8, 8, 8, PAL.blue, [22, 22]) + `<rect x="3" y="6" width="26" height="22" rx="3" fill="none" stroke="${PAL.gold[1]}" stroke-width="1.6" stroke-dasharray="3 2"/>`,
  motionLink: () => circle(10, 16, 6, PAL.grey[1], EDGE) + circle(22, 16, 6, PAL.grey[1], EDGE) + path('M10,10 H22 M10,22 H22', PAL.gold[1], 1.6) + dot(10, 16, 1.5, '#333') + dot(22, 16, 1.5, '#333'),
  driveJoints: () => ICONS.newJoint() + poly([[22, 3], [30, 8], [22, 13]], PLUS, '#1d5e17'),
  duplicateComponent: () => box(-6, -6, 0, 10, 10, 9, PAL.blue, [12, 21]) + box(-4, -4, 0, 10, 10, 9, PAL.cyan, [20, 25]),

  /* ---- select ---- */
  selectAllEdges: () => box(-8, -8, 0, 16, 16, 12, PAL.grey, [16, 21]).replace(new RegExp(EDGE.replace(/[()]/g, '\\$&'), 'g'), PAL.gold[1]),
  selectMore: () => cursor(12, 8) + dashedRect(3, 3, 26, 26, PAL.gold[1]),
  selectPriority: () => cursor(14, 11) + `<rect x="3" y="4" width="11" height="4" fill="${PAL.gold[1]}"/><rect x="3" y="10" width="8" height="4" fill="${PAL.grey[1]}"/>`,
  selectGrow: () => cursor(18, 12) + dashedRect(3, 3, 22, 22, PAL.gold[1]) + arrow(9, 9, 3, 3, PAL.gold[1], 1.4),
  selectShrink: () => cursor(18, 12) + dashedRect(8, 8, 12, 12, PAL.gold[1]),
  selectInvert: () => `<rect x="3" y="3" width="13" height="26" fill="${PAL.gold[1]}88"/><rect x="16" y="3" width="13" height="26" fill="none" stroke="${PAL.gold[1]}" stroke-dasharray="2 2"/>` + spin(16, 16, 6, INK),
  selectTangent: () => path('M4,24 H14 A8,8 0 0 0 22,16 V6', PAL.gold[1], 2.6) + cursor(18, 16),
  selectSimilar: () => [8, 16, 24].map((x) => cyl(x, 22, 3.4, 8, x === 8 ? PAL.gold : PAL.blue)).join('') + cursor(20, 12),
  selectSeedBoundary: () => poly([[4, 24], [16, 30], [28, 24], [16, 18]], PAL.gold[1] + 'aa', PAL.gold[1]) + path('M4,24 L16,18 L28,24', PAL.red[1], 1.8) + cursor(14, 6),
  selectBySize: () => [[7, 24, 3], [15, 22, 5], [25, 19, 7]].map(([x, y, r]) => circle(x, y, r, PAL.gold[1] + '88', PAL.gold[1], 1.2)).join('') + cursor(4, 3),
  selectByName: () => `<rect x="3" y="18" width="22" height="9" rx="2" fill="${PAL.grey[0]}" stroke="${EDGE}"/>` + text(14, 25.5, 'abc', 7, '#333', 700) + cursor(18, 3),
  meshPalette: () => meshPatch() + cursor(17, 10),
  createSelectionSet: () => `<path d="M4,9 H13 L15,12 H28 V27 H4 Z" fill="${PAL.gold[1]}" stroke="${EDGE}"/>` + cursor(16, 12),
  isolate: () => box(-5, -5, 0, 10, 10, 10, PAL.blue, [16, 21]) + circle(16, 16, 13, 'none', PAL.gold[1], 1.6),
  unisolate: () => [9, 23].map((x) => box(-3, -3, 0, 6, 6, 6, PAL.blue, [x, 22])).join('') + box(-3, -3, 0, 6, 6, 6, PAL.blue, [16, 13]),
  showAll: () => path('M3,16 Q16,4 29,16 Q16,28 3,16', INK, 1.8) + circle(16, 16, 4.5, ACCENT, EDGE),
  hideSelected: () => ICONS.showAll() + path('M5,27 L27,5', PAL.red[1], 2.2),
  priorityAuto: () => cursor(12, 8),
  priorityFace: () => B.block(PAL.grey) + poly([iso(-9, -6, 9, [16, 20]), iso(9, -6, 9, [16, 20]), iso(9, 6, 9, [16, 20]), iso(-9, 6, 9, [16, 20])], PAL.gold[1]),
  priorityEdge: () => B.block(PAL.grey) + path(`M${iso(-9, 6, 9, [16, 20]).join(',')} L${iso(9, 6, 9, [16, 20]).join(',')}`, PAL.gold[1], 2.6),
  priorityBody: () => B.block(PAL.gold),
  priorityComponent: () => box(-8, -8, 0, 16, 16, 12, PAL.gold, [16, 21]) + path('M5,9 L16,4 L27,9', INK, 1.4),
  prioritySketch: () => dashedRect(4, 8, 24, 16, PAL.gold[1]) + path('M8,20 L13,13 L17,17 L22,11', PAL.gold[1], 1.6),

  /* ---- surface ---- */
  surfaceExtrude: () => poly([iso(-9, -6, 0, [15, 24]), iso(9, -6, 0, [15, 24]), iso(9, -6, 10, [15, 24]), iso(-9, -6, 10, [15, 24])], PAL.cyan[1]) + path(`M${iso(-9, -6, 0, [15, 24]).join(',')} L${iso(9, -6, 0, [15, 24]).join(',')}`, '#ffb35c', 1.6) + arrow(24, 12, 24, 2, ACCENT, 1.8),
  surfaceRevolve: () => `<path d="M6,26 Q6,8 16,6 Q26,8 26,26" fill="${PAL.cyan[1]}" stroke="${PAL.cyan[2]}"/>` + spin(16, 17, 6),
  surfaceSweep: () => `<path d="M4,26 C10,26 12,10 26,8" fill="none" stroke="${PAL.cyan[1]}" stroke-width="8"/>` + path('M4,26 C10,26 12,10 26,8', '#ffb35c', 1.2, 'none', 'stroke-dasharray="3 2"'),
  surfaceLoft: () => `<path d="M4,24 Q10,18 12,26 L28,8 Q24,4 20,10 Z" fill="${PAL.cyan[1]}" stroke="${PAL.cyan[2]}"/>` + path('M4,24 Q10,18 12,26', '#ffb35c', 1.4) + path('M20,10 Q24,4 28,8', '#ffb35c', 1.4),
  patch: () => `<path d="M5,20 Q8,8 16,9 T27,17 Q24,27 15,26 T5,20 Z" fill="${PAL.cyan[1]}" stroke="#ffb35c" stroke-width="1.8"/>`,
  ruled: () => path('M4,24 L14,28', '#ffb35c', 1.8) + poly([[4, 24], [14, 28], [24, 10], [14, 6]], PAL.cyan[1] + 'dd', PAL.cyan[2]) + path('M7,20 L17,25 M10,15 L20,19 M12,10 L22,14', PAL.cyan[2], 0.8),
  offsetSurface: () => surfacePanel(PAL.cyan).replace('<path', '<path transform="translate(0,5)"') + surfacePanel(PAL.cyan).replace('<path', '<path transform="translate(0,-5)" opacity="0.8"'),
  trimSurface: () => surfacePanel() + path('M16,4 V28', PAL.red[1], 1.8) + path('M20,9 L26,23 M26,9 L20,23', PAL.red[1], 1.4),
  extendSurface: () => surfacePanel() + arrow(26, 14, 31, 12, ACCENT, 1.8),
  untrimSurface: () => surfacePanel() + spin(16, 16, 5, PLUS),
  mergeSurface: () => surfacePanel() + path('M16,6 V26', PLUS, 1.8) + plusBadge(26, 26),
  stitch: () => surfacePanel() + path('M8,12 L10,20 M13,11 L15,19 M18,10 L20,18 M23,9 L25,17', INK, 1.4),
  unstitch: () => surfacePanel() + path('M4,17 H29', '#333941', 3),
  reverseNormal: () => surfacePanel() + arrow(12, 18, 12, 7, ACCENT, 1.6) + arrow(22, 12, 22, 23, PAL.red[1], 1.6),
  thicken: () => surfacePanel() + arrow(16, 20, 16, 30, ACCENT, 1.8),

  /* ---- mesh ---- */
  tessellate: () => B.cube(PAL.grey) + path('M9,13 L23,21 M16,9 L16,25 M9,21 L23,13', PAL.grey[2], 0.9),
  recognise: () => meshPatch() + magnifier(22, 21, PAL.gold[1]),
  faceGroups: () => poly([[5, 22], [16, 8], [16, 18]], PAL.blue[1]) + poly([[16, 8], [27, 20], [16, 18]], PAL.green[1]) + poly([[5, 22], [16, 18], [27, 20], [17, 28]], PAL.gold[1]),
  createFaceGroup: () => ICONS.faceGroups() + plusBadge(26, 7),
  combineFaceGroups: () => ICONS.faceGroups() + path('M10,19 H22', INK, 2),
  releaseFaceGroups: () => ICONS.faceGroups() + minusBadge(26, 7),
  faceGroupEdit: () => ICONS.faceGroups() + pencil(18, 2),
  meshStitch: () => meshPatch() + path('M8,12 L10,17 M13,10 L15,15 M18,8 L20,13', INK, 1.4),
  meshPatch: () => poly([[5, 22], [16, 8], [27, 20], [17, 28]], PAL.grey[1]) + poly([[12, 17], [19, 14], [20, 21], [14, 23]], PLUS) + path('M5,22 L27,20 M16,8 L17,28', PAL.grey[2], 0.8),
  meshDirectEdit: () => meshPatch() + arrow(16, 17, 16, 3, ACCENT, 2),
  meshRepair: () => meshPatch() + path('M22,6 L28,12 M20,14 L26,8', PAL.gold[1], 2.6) + circle(27, 7, 2.4, 'none', PAL.gold[1], 1.6),
  meshMerge: () => meshPatch() + plusBadge(26, 26),
  meshScale: () => meshPatch() + arrow(17, 17, 29, 5, ACCENT, 1.8),
  meshSeparate: () => poly([[3, 20], [12, 9], [14, 24]], PAL.grey[1]) + poly([[18, 22], [22, 8], [29, 18]], PAL.grey[1]) + path('M16,4 V28', ACCENT, 1, 'none', 'stroke-dasharray="2 2"'),
  meshReduce: () => poly([[5, 22], [16, 8], [27, 20], [17, 28]], PAL.grey[1]) + path('M5,22 L27,20', PAL.grey[2], 0.9) + arrow(26, 4, 26, 13, MINUS, 1.8),
  meshRemesh: () => meshPatch() + path('M8,18 L24,18 M10.5,13 L21,13 M12,23 L22,23', PAL.grey[2], 0.8),
  meshSmooth: () => `<path d="M4,22 Q10,10 16,16 T28,12 L28,26 L4,26 Z" fill="${PAL.grey[1]}" stroke="${EDGE}"/>` + path('M4,22 Q10,10 16,16 T28,12', INK, 1.4),
  meshPlaneCut: () => meshPatch() + plane([16, 17], 9, PAL.green),
  meshShell: () => poly([[4, 24], [16, 6], [28, 24]], PAL.grey[1]) + poly([[10, 22], [16, 13], [22, 22]], '#20252e'),
  meshAlign: () => meshPatch() + path('M3,29 H29', PAL.green[1], 2),
  meshErase: () => meshPatch() + poly([[12, 17], [19, 14], [20, 21], [14, 23]], '#20252e') + xBadge(26, 26),
  meshReverse: () => meshPatch() + arrow(12, 18, 12, 7, ACCENT, 1.6) + arrow(21, 12, 21, 24, PAL.red[1], 1.6),
  textureExtrude: () => meshPatch() + path('M7,21 Q10,16 13,20 T19,19 T25,18', PAL.tan[0], 1.6),
  convertMesh: () => meshPatch() + arrow(22, 12, 29, 5, ACCENT, 1.6) + box(-3, -3, 0, 6, 6, 6, PAL.blue, [26, 30]),
  meshSection: () => meshPatch() + path('M4,15 H28', ACCENT, 2),

  /* ---- sheet metal ---- */
  smRule: () => `<rect x="4" y="5" width="22" height="22" rx="2" fill="${PAL.grey[0]}" stroke="${EDGE}"/>` + path('M8,11 H22 M8,16 H22 M8,21 H16', PAL.grey[2], 1.4) + box(-3, -3, 0, 6, 6, 2, PAL.orange, [25, 26]),
  baseFlange: () => box(-10, -8, 0, 20, 16, 2.5, PAL.orange, [16, 20]),
  flange: () => sheetL(),
  hem: () => box(-9, -6, 0, 16, 12, 2, PAL.orange, [15, 21]) + path('M22,15 Q30,12 26,7 Q22,6 18,9', PAL.orange[1], 3),
  loftedFlange: () => `<path d="M4,26 L12,28 Q20,14 28,10 L24,5 Q14,10 4,26 Z" fill="${PAL.orange[1]}" stroke="${EDGE}"/>`,
  contourFlange: () => path('M4,26 V16 H14 V8 H28', PAL.orange[1], 4) + path('M4,26 V16 H14 V8 H28', PAL.orange[0], 1.2),
  sheetFold: () => box(-9, -6, 0, 9, 12, 2, PAL.orange, [16, 22]) + poly([iso(0, -6, 2, [16, 22]), iso(0, 6, 2, [16, 22]), iso(8, 6, 10, [16, 22]), iso(8, -6, 10, [16, 22])], PAL.orange[1]) + path('M9,15 L23,23', PAL.green[1], 1, 'none', 'stroke-dasharray="2 2"'),
  unfold: () => sheetL() + arrow(21, 8, 29, 16, ACCENT, 1.6),
  refold: () => box(-10, -6, 0, 20, 12, 2, PAL.orange, [16, 22]) + arrow(24, 20, 24, 8, ACCENT, 1.6),
  rip: () => sheetL() + path('M15,6 L17,11 L14,15 L17,20', PAL.red[1], 1.8),
  cornerRelief: () => sheetL() + circle(19, 18, 3, '#20252e', PAL.red[1], 1.2),
  miter: () => box(-9, -6, 0, 16, 2, 12, PAL.orange, [15, 22]) + box(-9, -6, 0, 2, 12, 12, PAL.orange, [15, 22]) + path('M9,18 L13,10', PAL.gold[0], 1.8),
  convertToSheetMetal: () => B.cube(PAL.blue) + arrow(22, 16, 29, 9, ACCENT, 1.6) + box(-3, -3, 0, 7, 7, 1.5, PAL.orange, [25, 29]),
  flatPattern: () => poly([[4, 16], [10, 10], [22, 10], [28, 16], [22, 22], [10, 22]], PAL.orange[1]) + path('M10,10 V22 M22,10 V22', PAL.green[1], 1, 'none', 'stroke-dasharray="2 2"'),
  exportFlatDXF: () => ICONS.flatPattern() + arrow(20, 26, 28, 26, PLUS, 1.8),

  /* ---- plastic ---- */
  boss: () => B.slab(PAL.pink, [16, 25]) + cyl(16, 19, 6, 11, PAL.pink) + ellipse(16, 8, 2.6, 1.3, '#20252e'),
  rest: () => B.slab(PAL.pink, [16, 25]) + box(-7, -2, 5, 14, 4, 4, PAL.pink, [16, 25]),
  snapFit: () => box(-9, -3, 0, 4, 6, 18, PAL.pink, [16, 27]) + poly([[13, 5], [20, 9], [16, 12]], PAL.pink[1]),
  lip: () => B.slab(PAL.pink, [16, 22]) + box(-9, -7, 5, 18, 2.4, 3, PAL.pink, [16, 22]),
  plastic: () => ICONS.boss(),

  /* ---- form ---- */
  formBox: () => cage() ,
  formPlane: () => poly([iso(-10, -10, 0, [16, 17]), iso(10, -10, 0, [16, 17]), iso(10, 10, 0, [16, 17]), iso(-10, 10, 0, [16, 17])], PAL.purple[1], PAL.purple[2]) + path(`M${iso(0, -10, 0, [16, 17]).join(',')} L${iso(0, 10, 0, [16, 17]).join(',')} M${iso(-10, 0, 0, [16, 17]).join(',')} L${iso(10, 0, 0, [16, 17]).join(',')}`, PAL.purple[0], 1),
  formCylinder: () => cyl(16, 25, 10, 15, PAL.purple) + path('M6,17 Q16,22 26,17', PAL.purple[0], 1),
  formSphere: () => sphere(16, 16, 11, PAL.purple) + path('M5,16 Q16,21 27,16 M16,5 Q11,16 16,27', PAL.purple[0], 1),
  formTorus: () => torus(16, 17, 12, PAL.purple),
  formQuadball: () => sphere(16, 16, 11, PAL.purple) + path('M9,8 L9,24 M23,8 L23,24 M5,12 H27 M5,20 H27', PAL.purple[0], 0.9),
  formCreate: () => cage() + path('M3,29 C10,22 20,30 29,24', '#ffb35c', 1.4),
  formExtrudeCurve: () => path('M4,26 Q16,18 28,26', '#ffb35c', 1.6) + `<path d="M4,26 Q16,18 28,26 L28,12 Q16,4 4,12 Z" fill="${PAL.purple[1]}" stroke="${PAL.purple[2]}"/>`,
  formRevolveCurve: () => `<path d="M6,26 Q6,8 16,6 Q26,8 26,26" fill="${PAL.purple[1]}" stroke="${PAL.purple[2]}"/>` + spin(16, 17, 6),
  formSweepCurve: () => `<path d="M4,26 C10,26 12,10 26,8" fill="none" stroke="${PAL.purple[1]}" stroke-width="8"/>` + path('M4,26 C10,26 12,10 26,8', '#ffb35c', 1.2, 'none', 'stroke-dasharray="3 2"'),
  formLoftCurves: () => `<path d="M4,24 Q10,18 12,26 L28,8 Q24,4 20,10 Z" fill="${PAL.purple[1]}" stroke="${PAL.purple[2]}"/>`,
  formPipeCurve: () => `<path d="M4,26 C10,26 12,10 26,8" fill="none" stroke="${PAL.purple[1]}" stroke-width="6" stroke-linecap="round"/>` + path('M4,26 C10,26 12,10 26,8', PAL.purple[0], 1.2),
  formFace: () => poly([[6, 22], [14, 8], [27, 12], [22, 26]], PAL.purple[1], PAL.purple[2]) + dot(6, 22, 1.8, INK) + dot(14, 8, 1.8, INK) + dot(27, 12, 1.8, INK) + dot(22, 26, 1.8, INK),
  editForm: () => cage() + arrow(16, 16, 16, 3, PAL.red[1], 1.6) + arrow(16, 16, 29, 16, PAL.green[1], 1.6),
  formPull: () => cage() + arrow(16, 20, 16, 2, ACCENT, 2),
  formSelect: () => cage() + cursor(16, 12),
  formGrow: () => cage() + dashedRect(2, 2, 28, 28, PAL.gold[1]),
  formShrink: () => cage() + dashedRect(10, 10, 12, 12, PAL.gold[1]),
  formLoop: () => cage() + path('M5,17 Q16,14 27,17', PAL.gold[1], 2.4),
  formRing: () => cage() + path('M16,6 Q13,17 16,28', PAL.gold[1], 2.4),
  formInvert: () => cage() + spin(16, 17, 5, INK),
  formSelectAll: () => cage().replace(new RegExp(PAL.purple[1], 'g'), PAL.gold[1]),
  formInsert: () => cage() + path('M9,8 Q6,17 9,26', PLUS, 2),
  formInsertEdge: () => cage() + path('M22,7 Q25,17 22,27', PLUS, 2),
  formInsertPoint: () => cage() + dot(20, 20, 2.6, PLUS),
  formSubdivide: () => cage() + path('M10,9 Q8,17 10,26 M22,9 Q24,17 22,26 M6,13 Q16,10 26,13 M6,21 Q16,24 26,21', PAL.purple[0], 0.8),
  formFaces: () => cage() + poly([[13, 12], [20, 12], [20, 19], [13, 19]], '#20252e'),
  formBridge: () => poly([[3, 10], [11, 8], [11, 24], [3, 22]], PAL.purple[1], PAL.purple[2]) + poly([[21, 8], [29, 10], [29, 22], [21, 24]], PAL.purple[1], PAL.purple[2]) + poly([[11, 8], [21, 8], [21, 24], [11, 24]], PAL.purple[0] + '99', PLUS),
  formFillHole: () => cage() + poly([[13, 12], [20, 12], [20, 19], [13, 19]], PLUS),
  formDelete: () => cage() + poly([[13, 12], [20, 12], [20, 19], [13, 19]], '#20252e') + xBadge(26, 26),
  formWeld: () => cage() + path('M13,21 L16,17 L19,21', PLUS, 2) + dot(16, 17, 2, PLUS),
  formUnweld: () => cage() + dot(13, 20, 2, PAL.red[1]) + dot(19, 20, 2, PAL.red[1]),
  formCrease: () => cage() + path('M5,17 L27,17', PAL.red[1], 2.6),
  formUncrease: () => cage() + path('M5,17 Q16,11 27,17', PLUS, 2.2),
  formShape: () => cage() + path('M4,28 Q16,20 28,28', PAL.gold[1], 1.8),
  formSmooth: () => sphere(16, 16, 11, PAL.purple) + path('M6,20 Q16,12 26,20', PAL.purple[0], 1.4),
  formStraighten: () => cage() + path('M4,27 H28', PAL.gold[1], 2.2),
  formCylindrify: () => cyl(16, 25, 9, 15, PAL.purple) + path('M5,4 L27,4', PAL.gold[1], 1.4, 'none', 'stroke-dasharray="2 2"'),
  formSlide: () => cage() + arrow(9, 26, 23, 26, PAL.gold[1], 1.8),
  formBevel: () => poly([[5, 27], [5, 13], [13, 5], [27, 5], [27, 27]], PAL.purple[1], PAL.purple[2]) + path('M5,13 L13,5 M9,17 L17,9', PAL.purple[0], 1.6),
  formErase: () => cage() + poly([[12, 12], [21, 12], [21, 20], [12, 20]], PLUS + '99'),
  formMergeEdge: () => cage() + path('M5,17 H27', PLUS, 2),
  formFreeze: () => cage() + path('M16,6 V28 M7,11 L25,23 M25,11 L7,23', '#bfe6ff', 1.6),
  formUnfreeze: () => cage() + path('M16,6 V28 M7,11 L25,23 M25,11 L7,23', '#bfe6ff', 1.6) + xBadge(26, 26),
  formMatch: () => cage() + path('M3,29 C12,24 20,30 29,24', PAL.blue[1], 2.2),
  formByCurve: () => cage() + path('M3,5 C10,12 22,2 29,8', '#ffb35c', 1.8),
  formInterpolate: () => cage() + dot(7, 11, 2.2, PLUS) + dot(25, 11, 2.2, PLUS) + dot(25, 24, 2.2, PLUS) + dot(7, 24, 2.2, PLUS),
  formUninterpolate: () => cage() + dot(7, 11, 2.2, PAL.red[1]) + dot(25, 24, 2.2, PAL.red[1]),
  formTidy: () => cage() + path('M4,28 H28', INK, 1.6),
  formFlatten: () => poly([iso(-10, -10, 0, [16, 20]), iso(10, -10, 0, [16, 20]), iso(10, 10, 0, [16, 20]), iso(-10, 10, 0, [16, 20])], PAL.purple[1], PAL.purple[2]) + arrow(16, 2, 16, 14, ACCENT, 1.8),
  formUniform: () => cage() + path('M9,8 V27 M16,6 V28 M23,8 V27', PAL.purple[0], 1),
  formMirror: () => path('M16,2 V30', PAL.green[1], 1.6, 'none', 'stroke-dasharray="3 2"') + `<path d="M15,6 Q5,6 5,17 Q5,28 15,28 Z" fill="${PAL.purple[1]}" stroke="${PAL.purple[2]}"/><path d="M17,6 Q27,6 27,17 Q27,28 17,28 Z" fill="${PAL.purple[1]}" stroke="${PAL.purple[2]}" opacity="0.75"/>`,
  formCircular: () => [0, 1, 2, 3, 4, 5].map((i) => { const a = (i * Math.PI) / 3; return `<path d="M16,16 L${f(16 + 12 * Math.cos(a))},${f(16 + 12 * Math.sin(a))} A12,12 0 0 1 ${f(16 + 12 * Math.cos(a + 0.9))},${f(16 + 12 * Math.sin(a + 0.9))} Z" fill="${PAL.purple[i % 2 ? 1 : 0]}" stroke="${PAL.purple[2]}" stroke-width="0.6"/>`; }).join(''),
  formClearSymmetry: () => ICONS.formMirror() + xBadge(26, 26),
  formDisplay: () => cage() + path('M3,16 Q16,4 29,16', INK, 1.2),
  formDisplayBox: () => `<rect x="5" y="7" width="22" height="18" fill="${PAL.purple[1]}" stroke="${PAL.purple[2]}"/>` + path('M16,7 V25 M5,16 H27', PAL.purple[0], 1),
  formDisplayControl: () => `<rect x="5" y="7" width="22" height="18" fill="none" stroke="${PAL.purple[0]}" stroke-dasharray="2 2"/>` + ellipse(16, 16, 9, 7, PAL.purple[1], PAL.purple[2]),
  formDisplaySmooth: () => ellipse(16, 16, 11, 9, PAL.purple[1], PAL.purple[2]) + ellipse(12, 12, 4, 2.5, PAL.purple[0], 'none'),
  formRepair: () => cage() + path('M22,6 L28,12 M20,14 L26,8', PAL.gold[1], 2.6),
  formThicken: () => cage() + arrow(16, 22, 16, 31, ACCENT, 1.8),
  finishForm: () => S.finish(),

  /* ---- sketch tab commands ---- */
  finishSketch: () => S.finish(),
  sketchMove: () => S.move(),
  sketchCopy: () => S.copy(),
  sketchPaste: () => S.paste(),
  mirrorSketch: () => S.mirror(),
  sketchPatternRect: () => S.patternRect(),
  sketchPatternCirc: () => S.patternCirc(),
  sketchScale: () => S.scale(),
  editText: () => S.editText(),
  construction: () => S.construction(),
  centerline: () => S.centerline(),
  lookAt: () => S.lookAt(),
  project: () => S.projectInto(),
  projectCopy: () => S.projectInto() + plusBadge(26, 7),
  intersect: () => B.cube(PAL.blue) + path('M3,19 H29', ACCENT, 2),
  include3D: () => B.cube(PAL.blue) + path('M9,13 L16,17 L23,13', ACCENT, 2.2),
  intersectionCurve: () => surfacePanel() + path('M6,24 Q16,6 27,14', ACCENT, 2),
  projectToSurface: () => sphere(16, 20, 10, PAL.blue) + path('M8,15 Q16,10 24,15', ACCENT, 2) + path('M16,2 V10', ACCENT, 1.2, 'none', 'stroke-dasharray="2 2"'),
  isoCurve: () => surfacePanel() + path('M16,6 Q14,16 16,26', ACCENT, 2),
  spunProfile: () => cyl(16, 26, 9, 18, PAL.blue) + path('M16,4 V30', ACCENT, 1.2, 'none', 'stroke-dasharray="3 2"') + path('M16,8 H25 V26', ACCENT, 2),
  insert: () => S.insertSvg(),
  insertSvg: () => S.insertSvg(),
  insertDxf: () => S.insertDxf(),

  /* ---- sketch tools ---- */
  'tool:select': () => S.select(),
  'tool:line': () => S.line(),
  'tool:rectangle': () => S.rect(),
  'tool:centerRectangle': () => S.rectCentre(),
  'tool:rectangle3': () => S.rect3(),
  'tool:circle': () => S.circle(),
  'tool:circleDia': () => S.circleDia(),
  'tool:circle3': () => S.circle3(),
  'tool:circleTan2': () => S.circleTan2(),
  'tool:circleTan3': () => S.circleTan3(),
  'tool:arc': () => S.arc(),
  'tool:arc3': () => S.arc3(),
  'tool:tangentArc': () => S.arcTan(),
  'tool:polygon': () => S.polygon(),
  'tool:polygonCirc': () => S.polygonCirc(),
  'tool:polygonEdge': () => S.polygonEdge(),
  'tool:slot': () => S.slot(),
  'tool:slotOverall': () => S.slotOverall(),
  'tool:slotCentre': () => S.slotCentre(),
  'tool:slotArc3': () => S.slotArc(),
  'tool:slotArcCentre': () => S.slotArcCentre(),
  'tool:ellipse': () => S.ellipse(),
  'tool:spline': () => S.spline(),
  'tool:splineCP': () => S.splineCP(),
  'tool:conic': () => S.conic(),
  'tool:blendCurve': () => S.blend(),
  'tool:blendCurveG1': () => S.blendG1(),
  'tool:point': () => S.point(),
  'tool:text': () => S.text(),
  'tool:fillet': () => S.fillet(),
  'tool:chamfer': () => S.chamfer(),
  'tool:trim': () => S.trim(),
  'tool:offset': () => S.offset(),
  'tool:breakCurve': () => S.breakCurve(),
  'tool:extend': () => S.extend(),
  'tool:dimension': () => S.dimension(),
  rectangle: () => S.rect(),
  circle: () => S.circle(),
  arc: () => S.arc(),
  polygon: () => S.polygon(),
  slot: () => S.slot(),
  spline: () => S.spline(),

  preferences: () => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => { const t = (i * Math.PI) / 4; return `<rect x="14" y="3" width="4" height="7" rx="1" fill="${PAL.grey[1]}" stroke="${EDGE}" transform="rotate(${i * 45} 16 16)"/>`; }).join('') + circle(16, 16, 9, PAL.grey[1]) + circle(16, 16, 3.5, '#2a2f36'),

  /* ---- timeline playback ---- */
  rollbackStart: () => path('M8,6 V26', INK, 2.4) + poly([[26, 6], [26, 26], [11, 16]], INK, INK),
  rollbackPrev: () => poly([[25, 6], [25, 26], [10, 16]], INK, INK),
  rollbackNext: () => poly([[7, 6], [7, 26], [22, 16]], INK, INK),
  rollbackEnd: () => path('M24,6 V26', INK, 2.4) + poly([[6, 6], [6, 26], [21, 16]], INK, INK),

  /* ---- camera and view ---- */
  fit: () => B.cube(PAL.grey) + path('M3,9 V3 H9 M23,3 H29 V9 M29,23 V29 H23 M9,29 H3 V23', INK, 1.8),
  home: () => `<path d="M4,15 L16,5 L28,15 V28 H4 Z" fill="${PAL.grey[1]}" stroke="${EDGE}"/>` + `<rect x="13" y="19" width="6" height="9" fill="#20252e"/>`,
  toggleProjection: () => path('M4,10 L16,4 L28,10 L16,16 Z M4,10 V22 L16,28 V16 M28,10 V22 L16,28', INK, 1.4),
  library: () => `<path d="M3,8 H12 L14,11 H29 V27 H3 Z" fill="${PAL.gold[1]}" stroke="${EDGE}"/>`,
  new: () => `<path d="M7,3 H20 L26,9 V29 H7 Z" fill="${PAL.grey[0]}" stroke="${EDGE}"/>` + plusBadge(24, 24),
  open: () => `<path d="M3,8 H12 L14,11 H29 V27 H3 Z" fill="${PAL.gold[1]}" stroke="${EDGE}"/>` + path('M3,27 L8,15 H31 L27,27', PAL.gold[0], 1.2, PAL.gold[0]),
  save: () => `<rect x="4" y="4" width="24" height="24" rx="2" fill="${PAL.blue[1]}" stroke="${EDGE}"/><rect x="9" y="4" width="13" height="8" fill="${PAL.grey[0]}"/><rect x="8" y="17" width="16" height="11" fill="#20252e"/>`,
  saveAs: () => ICONS.save() + pencil(18, 12),
  undo: () => path('M8,12 H20 A7,7 0 0 1 20,26 H11', INK, 2.4) + poly([[3, 12], [10, 6], [10, 18]], INK, INK),
  redo: () => path('M24,12 H12 A7,7 0 0 0 12,26 H21', INK, 2.4) + poly([[29, 12], [22, 6], [22, 18]], INK, INK),
  search: () => magnifier(18, 18)
};

/* Constraint buttons share their names with nothing else, so they are keyed plainly. */
for (const [k, v] of Object.entries(C)) ICONS[`con:${k}`] = v;

/* A feature on the timeline is drawn with the icon of the command that made it. */
const FEATURE_ICON = {
  sketch: 'newSketch',
  extrude: 'extrude',
  revolve: 'revolve',
  hole: 'hole',
  primitive: 'primBox',
  mirror: 'mirror',
  patternRect: 'patternRect',
  patternCircular: 'patternCirc',
  patternPath: 'patternPath',
  patternFeature: 'patternFeature',
  move: 'move',
  scale: 'scale',
  combine: 'combine',
  fillet: 'fillet',
  chamfer: 'chamfer',
  shell: 'shell',
  offsetFace: 'pressPull',
  loft: 'loft',
  sweep: 'sweep',
  rib: 'rib',
  web: 'web',
  draft: 'draft',
  split: 'splitBody',
  splitFace: 'splitFace',
  silhouetteSplit: 'silhouetteSplit',
  thread: 'thread',
  coil: 'coil',
  emboss: 'emboss',
  construction: 'construct',
  align: 'align',
  boss: 'boss',
  rest: 'rest',
  snapFit: 'snapFit',
  lip: 'lip',
  fullRound: 'fullRound',
  deleteFace: 'deleteFace',
  replaceFace: 'replaceFace',
  boundaryFill: 'boundaryFill',
  textureRelief: 'textureRelief',
  textureExtrude: 'textureExtrude',
  insertMesh: 'insertMesh',
  insertComponent: 'insertComponent',
  tessellate: 'tessellate',
  convertMesh: 'convertMesh',
  faceGroups: 'faceGroups',
  faceGroupEdit: 'faceGroupEdit',
  form: 'formBox',
  finishForm: 'finishForm',
  formThicken: 'formThicken',
  baseFlange: 'baseFlange',
  flange: 'flange',
  hem: 'hem',
  loftedFlange: 'loftedFlange',
  contourFlange: 'contourFlange',
  sheetFold: 'sheetFold',
  unfold: 'unfold',
  refold: 'refold',
  rip: 'rip',
  cornerRelief: 'cornerRelief',
  miter: 'miter',
  convertToSheetMetal: 'convertToSheetMetal',
  flatPattern: 'flatPattern',
  surfaceExtrude: 'surfaceExtrude',
  surfaceRevolve: 'surfaceRevolve',
  surfaceSweep: 'surfaceSweep',
  surfaceLoft: 'surfaceLoft',
  patch: 'patch',
  ruled: 'ruled',
  offsetSurface: 'offsetSurface',
  trimSurface: 'trimSurface',
  untrimSurface: 'untrimSurface',
  extendSurface: 'extendSurface',
  mergeSurface: 'mergeSurface',
  stitch: 'stitch',
  unstitch: 'unstitch',
  reverseNormal: 'reverseNormal',
  thicken: 'thicken',
  jointEdit: 'newJoint'
};
for (const t of Object.keys({ meshStitch: 1, meshPatch: 1, meshDirectEdit: 1, meshRepair: 1, meshMerge: 1, meshScale: 1, meshSeparate: 1, meshReduce: 1, meshRemesh: 1, meshSmooth: 1, meshPlaneCut: 1, meshShell: 1, meshAlign: 1, meshErase: 1, meshReverse: 1 })) {
  FEATURE_ICON[t] = t;
}

/** The markup for a command's icon, or nothing if it has none. */
export function iconSvg(id, size = 28) {
  const draw = ICONS[id];
  if (!draw) return '';
  let body;
  try {
    body = draw();
  } catch {
    return '';
  }
  return `<svg class="icon" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

/** The icon for a feature on the timeline, by the command that makes it. */
export function featureIconSvg(type, size = 18) {
  return iconSvg(FEATURE_ICON[type] || type, size);
}

export function hasIcon(id) {
  return !!ICONS[id];
}

export function iconIds() {
  return Object.keys(ICONS);
}
