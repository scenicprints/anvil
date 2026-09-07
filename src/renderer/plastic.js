/**
 * The four plastic part features, as profiles.
 *
 * A boss, a rest, a snap fit and a lip are all the same kind of thing: a small
 * standard shape put on a face of a bigger part. What makes them worth having
 * as commands rather than as sketches is that each one is a handful of numbers a
 * person already knows, and working out the outline from those numbers by hand
 * every time is where the mistakes come from.
 *
 * Everything here is a two dimensional outline and nothing here touches the
 * kernel. A boss is a profile turned about an axis, a rest and a lip are
 * profiles pushed along one, and a snap fit is a profile pushed across its
 * width. That keeps the shapes testable against numbers rather than against
 * pictures, which for geometry like this is the whole game: a snap with the
 * wrong lead-in angle looks exactly like a snap with the right one.
 *
 * Two conventions run through the file. A profile to be turned is written as
 * `[radius, height]`, which is what the kernel's revolve expects. A profile to
 * be pushed is written as `[x, y]` in the plane it is drawn in, and the caller
 * says where that plane is.
 */

const TAU = Math.PI * 2;

/** Points along a circular arc, from one angle to another, in the given sense. */
function arc(cx, cy, r, from, to, steps) {
  const n = Math.max(2, Math.round(steps));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = from + ((to - from) * i) / n;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

/**
 * The turned outline of a screw boss.
 *
 * A post with a hole down it, standing on a face, with a fillet where it meets
 * the face. The fillet is not decoration: a boss without one snaps off at the
 * base, which is where the whole load is, and on a printed part it is also
 * where the layer lines run straight across the stress.
 *
 * The bore is measured from the top down, because that is where the screw goes
 * in and how deep it can reach is the number that matters. A bore as deep as
 * the boss goes right through into whatever the boss is standing on.
 *
 * Returned as `[radius, height]` pairs running anticlockwise, ready to turn.
 */
export function bossProfile(opts = {}) {
  const R = Math.max(1e-6, opts.diameter ?? 8) / 2;
  const H = Math.max(1e-6, opts.height ?? 10);
  const bore = Math.max(0, opts.bore ?? 3) / 2;
  const boreDepth = Math.min(H, Math.max(0, opts.boreDepth ?? H));
  const fillet = Math.max(0, Math.min(opts.fillet ?? 1.5, R, H / 2));
  if (bore >= R) return null;

  const out = [];
  const through = boreDepth >= H - 1e-9;
  // The foot of the profile: the axis for a blind bore, the bore wall for one
  // that goes right through.
  out.push(through ? [bore, 0] : [0, 0]);

  if (fillet > 0) {
    // A quarter circle from the face up onto the wall. Its centre is one fillet
    // radius out from the wall and one up from the face.
    out.push([R + fillet, 0]);
    const steps = Math.max(4, Math.round(fillet * 4));
    // From straight down off the centre round to straight out from it, going
    // the short way, which is the quarter that touches both the face and wall.
    for (const p of arc(R + fillet, fillet, fillet, -Math.PI / 2, -Math.PI, steps)) {
      out.push(p);
    }
  } else {
    out.push([R, 0]);
  }

  out.push([R, H]);
  out.push([bore, H]);
  if (!through) {
    out.push([bore, H - boreDepth]);
    out.push([0, H - boreDepth]);
  }
  return dedupe(out);
}

/**
 * One rib against the side of a boss, as an outline to push across.
 *
 * A gusset: tall against the boss, running down and out to nothing at the face.
 * Drawn in `[radius, height]` like the boss itself, so the caller has one frame
 * to think in rather than two.
 */
export function bossRibProfile(opts = {}) {
  const R = Math.max(1e-6, opts.diameter ?? 8) / 2;
  const reach = Math.max(1e-6, opts.reach ?? R);
  const height = Math.max(1e-6, opts.height ?? 6);
  const fillet = Math.max(0, opts.fillet ?? 0);
  // It starts at the top of the boss wall, runs out to the face, and the fillet
  // at the boss's own foot is left clear so the two do not fight.
  return dedupe([
    [R, 0],
    [R + reach, 0],
    [R, height],
    [R, Math.max(0, fillet)]
  ]);
}

/**
 * The turned outline of a round rest, or the pushed outline of a square one.
 *
 * A rest is a pad: a small raised or sunken patch that something else sits on,
 * so that two parts touch on three small places rather than on one big one that
 * will never be flat. The draft is what lets it come out of a mould and, on a
 * printed part, what stops the first layer curling off the edge.
 */
export function restProfile(opts = {}) {
  const height = Math.max(1e-6, opts.height ?? 2);
  const draft = Math.max(0, Math.min(60, opts.draft ?? 0));
  const inset = Math.tan((draft * Math.PI) / 180) * height;

  if (opts.shape === 'rectangular') {
    const w = Math.max(1e-6, opts.width ?? 10) / 2;
    const d = Math.max(1e-6, opts.depth ?? 10) / 2;
    const r = Math.max(0, Math.min(opts.corner ?? 0, w, d));
    return { kind: 'push', contour: roundedRect(w, d, r), taper: draft, height };
  }

  const R = Math.max(1e-6, opts.diameter ?? 10) / 2;
  if (inset >= R) return null;
  const top = R - inset;
  return {
    kind: 'turn',
    contour: dedupe([
      [0, 0],
      [R, 0],
      [top, height],
      [0, height]
    ]),
    height
  };
}

/** A rectangle with rounded corners, anticlockwise, about the origin. */
export function roundedRect(halfWidth, halfDepth, radius) {
  const r = Math.max(0, Math.min(radius, halfWidth, halfDepth));
  if (r < 1e-9) {
    return [
      [-halfWidth, -halfDepth],
      [halfWidth, -halfDepth],
      [halfWidth, halfDepth],
      [-halfWidth, halfDepth]
    ];
  }
  const steps = Math.max(3, Math.round(r * 3));
  const x = halfWidth - r;
  const y = halfDepth - r;
  return dedupe([
    ...arc(x, -y, r, -Math.PI / 2, 0, steps),
    ...arc(x, y, r, 0, Math.PI / 2, steps),
    ...arc(-x, y, r, Math.PI / 2, Math.PI, steps),
    ...arc(-x, -y, r, Math.PI, (3 * Math.PI) / 2, steps)
  ]);
}

/**
 * The side view of a cantilever snap fit.
 *
 * The beam runs from its root at x = 0 out to its tip at x = length, and the
 * hook stands on top of it at the tip. Two angles decide whether it works.
 *
 * The lead-in is the shallow face the hook rides over on the way in, and a
 * shallow one is what makes a part that clicks together with a thumb rather
 * than with a mallet. The retention face is the other side, and it is what
 * holds: square is the strongest and is what most printed snaps use, and
 * leaning it past square makes a hook that has to be prised rather than pulled.
 *
 * Returned as `[along, up]` pairs running anticlockwise.
 */
export function snapProfile(opts = {}) {
  const L = Math.max(1e-6, opts.length ?? 12);
  const T = Math.max(1e-6, opts.thickness ?? 2);
  const h = Math.max(1e-6, opts.hook ?? 1.5);
  const leadIn = Math.max(5, Math.min(80, opts.leadIn ?? 30));
  const retention = Math.max(30, Math.min(90, opts.retention ?? 90));

  const lead = h / Math.tan((leadIn * Math.PI) / 180);
  // Square is no overhang. Anything under square leans the face out over the
  // tip, which is an undercut and is what makes a snap that will not come back
  // out on its own.
  const over = retention >= 89.999 ? 0 : h / Math.tan((retention * Math.PI) / 180);
  if (lead >= L) return null;

  return dedupe([
    [0, 0],
    [L, 0],
    [L + over, T + h],
    [L - lead, T],
    [0, T]
  ]);
}

/**
 * The outline of a lip, as a band to sit inside the rim of a shelled part.
 *
 * Two halves of a printed enclosure that meet on a flat face will not stay
 * lined up. A lip on one half and a groove in the other is what locates them,
 * and the clearance between the two is the number that decides whether they
 * click together or have to be forced.
 *
 * Given the outer boundary of the mating face, the band runs from `inset` in
 * from that edge to `inset + width`. As a groove it is the same band made wider
 * by the clearance, so the same numbers describe both halves and they cannot
 * drift apart.
 */
export function lipBand(opts = {}) {
  const width = Math.max(1e-6, opts.width ?? 1.2);
  const inset = Math.max(0, opts.inset ?? 0.8);
  const clearance = Math.max(0, opts.clearance ?? 0.15);
  const groove = !!opts.groove;
  // The groove has to be wider than the lip by the clearance, and to start
  // that much sooner, or the lip fouls its walls before it is home.
  return {
    outer: groove ? -(inset - clearance) : -inset,
    inner: groove ? -(inset + width + clearance) : -(inset + width),
    height: Math.max(1e-6, opts.height ?? 2),
    clearance
  };
}

/** Points on top of each other are one point, and a closing repeat is dropped. */
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 1e-9) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-9) {
    out.pop();
  }
  return out;
}

/** The area a closed outline encloses, signed, which says which way it runs. */
export function signedArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export { TAU };
