/**
 * Turning a picture into a texture.
 *
 * The Texture feature takes a height map: mid grey is the surface as it was,
 * white stands out, black cuts in. Hardly any picture is already one. A photo
 * uses a third of the available range and none of it means depth, a logo is
 * black on white with an alpha channel doing the real work, and a JPEG carries
 * a fine noise that a printer will faithfully reproduce as fuzz.
 *
 * So this is the step between. Everything here works on the same plain
 * {width, height, gray} the rest of the application passes about, gray being
 * one byte a pixel, and every operation returns a new one rather than changing
 * what it was given: the picture as it arrived has to survive, because the
 * whole point of the dialog is to try settings against it and change your mind.
 *
 * Nothing here touches a canvas or the document. It is arithmetic on an array,
 * which is what makes it testable, and the preview in the dialog is drawn from
 * the same functions the feature will use, so what is on screen is what will be
 * on the part.
 */

/** What a picture is turned into a height map with, left alone. */
export const DEFAULTS = {
  // Which way round brightness means height. Light is the convention and dark
  // is what you want for a logo drawn in black.
  read: 'light',
  // Stretch the picture's own darkest and lightest to the full range. On by
  // default because a photo that uses the middle third of the range gives a
  // third of the depth that was asked for, and nobody asks for that.
  stretch: true,
  black: 0,
  white: 1,
  contrast: 0,
  smooth: 0,
  edges: 0,
  tile: 'none'
};

/** The darkest and the lightest of a picture, and its average. */
export function heightStats(img) {
  let min = 255;
  let max = 0;
  let sum = 0;
  for (const v of img.gray) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const n = img.gray.length || 1;
  return { min: min / 255, max: max / 255, mean: sum / n / 255 };
}

/**
 * A picture, as a height map.
 *
 * The order is not a matter of taste. Reading and stretching come first
 * because everything after them is about where mid grey is, and mid grey is
 * not where it should be until the range has been opened out. Smoothing comes
 * before the outlines are found, because an edge detector run on a noisy
 * picture finds the noise. Tiling is last, since it has to be the last word on
 * what the borders are.
 */
export function toHeight(img, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = img.width * img.height;
  let v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = img.gray[i] / 255;

  if (o.read === 'dark') for (let i = 0; i < n; i++) v[i] = 1 - v[i];

  if (o.stretch) {
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < n; i++) {
      if (v[i] < lo) lo = v[i];
      if (v[i] > hi) hi = v[i];
    }
    // A picture of one flat tone has nothing to stretch, and dividing by the
    // nothing between its darkest and its lightest would turn rounding error
    // into a pattern.
    if (hi - lo > 1 / 255) {
      const k = 1 / (hi - lo);
      for (let i = 0; i < n; i++) v[i] = (v[i] - lo) * k;
    }
  }

  // The black and white points: everything below one is flat bottom, above the
  // other is flat top, and what is between them is spread across the depth.
  // This is what carves a shape out of a photo rather than embossing all of it.
  const black = Math.min(o.black, o.white - 1e-4);
  const span = Math.max(1e-4, o.white - black);
  if (black !== 0 || o.white !== 1) {
    for (let i = 0; i < n; i++) v[i] = clamp01((v[i] - black) / span);
  }

  if (Math.abs(o.contrast) > 1e-6) {
    // An S about mid grey, so the surface as it was stays where it is and the
    // high and low places move apart. Negative flattens the same way.
    const k = o.contrast > 0 ? 1 / (1 - Math.min(0.98, o.contrast)) : 1 + o.contrast;
    for (let i = 0; i < n; i++) v[i] = clamp01(0.5 + (v[i] - 0.5) * k);
  }

  if (o.smooth > 0) v = blur(v, img.width, img.height, o.smooth);

  if (o.edges > 0) {
    const outline = sobel(v, img.width, img.height);
    const t = Math.min(1, o.edges);
    // The outlines cut in and the rest of the picture is left flat and proud,
    // which is what turns a photograph into something that reads as a drawing
    // when it is printed rather than as a grey smear.
    for (let i = 0; i < n; i++) v[i] = v[i] * (1 - t) + (1 - outline[i]) * t;
  }

  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) gray[i] = Math.round(clamp01(v[i]) * 255);
  const out = { width: img.width, height: img.height, gray };
  return o.tile === 'none' ? out : seamless(out, o.tile);
}

/**
 * Make a tile that meets itself.
 *
 * A texture is repeated across the part, so wherever the tile ends the next one
 * begins, and if the two borders do not agree there is a hard line down the
 * work at every repeat. On a screen it is a mark; on a printed part it is a
 * ridge you can catch a fingernail on.
 *
 * Two ways, because they fail differently. Mirroring is exact: a quarter of the
 * picture, flipped both ways, meets itself perfectly by construction, and the
 * cost is that a quarter of the picture is all you get and the result is
 * obviously symmetric. Blending keeps the whole picture and the whole
 * resolution by fading into a half-shifted copy of itself toward the borders,
 * which no longer match because they are no longer the borders: it is the
 * middle of the picture that ends up at the edges, and the middle already
 * agrees with itself.
 */
export function seamless(img, mode = 'blend') {
  const { width: w, height: h } = img;
  const gray = new Uint8Array(w * h);

  if (mode === 'mirror') {
    for (let y = 0; y < h; y++) {
      const sy = Math.min(y, h - 1 - y);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(x, w - 1 - x);
        gray[y * w + x] = img.gray[sy * w + sx];
      }
    }
    return { width: w, height: h, gray };
  }

  const hx = Math.floor(w / 2);
  const hy = Math.floor(h / 2);
  for (let y = 0; y < h; y++) {
    // One at the middle of the picture, nothing at its border, so the border
    // is taken entirely from the shifted copy and the middle entirely from the
    // picture itself.
    const wy = 1 - Math.abs((2 * y) / (h - 1 || 1) - 1);
    const oy = (y + hy) % h;
    for (let x = 0; x < w; x++) {
      const wx = 1 - Math.abs((2 * x) / (w - 1 || 1) - 1);
      const ox = (x + hx) % w;
      const s = wx * wy;
      gray[y * w + x] = Math.round(img.gray[y * w + x] * s + img.gray[oy * w + ox] * (1 - s));
    }
  }
  return { width: w, height: h, gray };
}

/* ------------------------------------------------------------------ */
/* The picture as it will feel                                          */
/* ------------------------------------------------------------------ */

/**
 * The height map, lit from the side, as a picture of the surface it will make.
 *
 * Worth more than the grey map it is drawn from, and the reason is the whole
 * lesson of this feature: a height map shown as grey tells you the numbers, and
 * a raking light tells you the part. Two settings that read almost the same in
 * grey are plainly different once there are shadows in them, and the difference
 * is a quarter of an hour of refining and printing to find out any other way.
 *
 * The light comes across the surface rather than down it, for the same reason a
 * photographer lights a coin that way: a light behind the camera casts no
 * shadow into anything, and relief without shadow is invisible.
 */
export function shadePreview(img, opts = {}) {
  const { width: w, height: h, gray } = img;
  const depth = opts.depth ?? 1;
  const base = opts.colour ?? [0x8f, 0x5c, 0x33];
  const out = new Uint8ClampedArray(w * h * 4);

  // Where the light is: low and off to one side, in the same frame as the
  // picture, so it rakes across the pattern.
  const lx = -0.55;
  const ly = 0.55;
  const lz = 0.63;
  const ll = Math.hypot(lx, ly, lz);

  const at = (x, y) =>
    gray[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))] / 255;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // The slope of the surface, from the pixels either side. Scaled by the
      // depth, so a deeper texture casts a harder shadow here as it will there.
      const dx = (at(x + 1, y) - at(x - 1, y)) * depth * 12;
      const dy = (at(x, y + 1) - at(x, y - 1)) * depth * 12;
      const nl = Math.hypot(dx, dy, 1);
      const diffuse = Math.max(0, (-dx * lx - dy * ly + lz) / (nl * ll));
      // A little from everywhere as well, or the far side of every ridge is
      // black and the picture reads as a pattern of holes.
      const light = 0.22 + 0.95 * diffuse;
      const k = (y * w + x) * 4;
      out[k] = base[0] * light;
      out[k + 1] = base[1] * light;
      out[k + 2] = base[2] * light;
      out[k + 3] = 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Blur, as three box passes rather than a real Gaussian.
 *
 * Three passes of a box is close enough to a Gaussian that nothing downstream
 * could tell, and a box pass costs the same whatever its radius because it is a
 * running total. A true Gaussian on a 512 pixel picture at a radius of ten is
 * two hundred multiplies a pixel, live, while somebody drags a slider.
 */
function blur(v, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  let a = v;
  for (let pass = 0; pass < 3; pass++) {
    a = boxRun(a, w, h, r, false);
    a = boxRun(a, w, h, r, true);
  }
  return a;
}

/** One box pass, along the rows or down the columns. */
function boxRun(v, w, h, r, down) {
  const out = new Float32Array(v.length);
  const len = down ? h : w;
  const other = down ? w : h;
  const step = down ? w : 1;
  const jump = down ? 1 : w;
  const n = 2 * r + 1;

  for (let j = 0; j < other; j++) {
    const base = j * jump;
    // The window hangs off both ends, and what it finds there is the end pixel
    // repeated. Wrapping instead would drag one edge of the picture into the
    // other, which is exactly the seam that tiling is trying to remove.
    let sum = v[base] * (r + 1);
    for (let i = 1; i <= r; i++) sum += v[base + Math.min(len - 1, i) * step];
    for (let i = 0; i < len; i++) {
      out[base + i * step] = sum / n;
      const drop = v[base + Math.max(0, i - r) * step];
      const add = v[base + Math.min(len - 1, i + r + 1) * step];
      sum += add - drop;
    }
  }
  return out;
}

/**
 * Where the picture changes, as a number from nothing to one.
 *
 * Sobel, which is the ordinary answer, and scaled by its own largest so that a
 * faint drawing and a hard one both come out as outlines rather than one of
 * them coming out as almost nothing.
 */
function sobel(v, w, h) {
  const out = new Float32Array(v.length);
  const at = (x, y) => v[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  let most = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x - 1, y) -
        at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1);
      const m = Math.hypot(gx, gy);
      out[y * w + x] = m;
      if (m > most) most = m;
    }
  }
  if (most > 1e-6) for (let i = 0; i < out.length; i++) out[i] /= most;
  return out;
}
