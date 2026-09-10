/**
 * Making a texture out of a picture.
 *
 * The arithmetic is covered by the suite. What this covers is the path a person
 * actually walks: a picture that is nothing like a height map goes in, the
 * dialog shows the surface it would make while the settings move, and what
 * comes out of it is a Texture feature on a real body.
 *
 * The file dialog is the one step a probe cannot answer, so the picture is
 * handed in directly and everything after it is the application's own code.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) =>
  report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`)
);

/**
 * A photograph, near enough: a picture that uses a narrow band of the range,
 * has speckle all over it, and means nothing as a height map until it is
 * worked on. Which is every picture anybody will ever open.
 */
function photograph(n) {
  const gray = new Array(n * n);
  const hash = (i, j) => {
    const v = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const v = j / n;
      // A few soft blobs, in the middle third of the range and nowhere near
      // black or white, with a fine speckle laid over the lot.
      let h = 0.5;
      h += 0.16 * Math.sin(u * 6.3 + Math.cos(v * 4.1) * 2);
      h += 0.1 * Math.cos(v * 8.8 - u * 3.3);
      h += (hash(i, j) - 0.5) * 0.12;
      gray[j * n + i] = Math.round(Math.max(0, Math.min(1, h)) * 255);
    }
  }
  return { width: n, height: n, gray };
}

dev.setTab('solid');
dev.state.doc.features = [
  {
    id: 'f1',
    type: 'primitive',
    shape: 'box',
    params: { width: '60', depth: '60', height: '14', centered: true, x: '0', y: '0', z: '0' },
    op: 'new'
  },
  { id: 'f2', type: 'fillet', bodies: 'all', sets: [{ radius: '3', all: true }] }
];
dev.rebuildAll();
await wait(1500);

const picture = photograph(256);
const H = dev.heightmap;

// What the picture is worth as it stands, and what the dialog's settings make
// of it. This is the whole argument for the tool existing.
const asItCame = H.heightStats(picture);
const opened = H.heightStats(H.toHeight(picture, { stretch: true }));
const cleaned = H.toHeight(picture, { stretch: true, smooth: 3, contrast: 0.3, tile: 'blend' });

// How badly the borders disagree, which is the seam you would feel at every
// repeat of the tile.
const seamOf = (m) => {
  let worst = 0;
  for (let y = 0; y < m.height; y++) {
    worst = Math.max(worst, Math.abs(m.gray[y * m.width] - m.gray[y * m.width + m.width - 1]));
  }
  return worst;
};

// The dialog itself, with the picture already in hand.
let started = null;
dev.texture.openTextureMaker(picture, 'Photograph', (img, name) => {
  started = { name, width: img.width, height: img.height };
  dev.texture.startTextureWith(img, name);
});
await wait(600);
const dialogUp = !document.querySelector('#modal').classList.contains('hidden');
const sliders = document.querySelectorAll('.texcontrols input[type="range"]').length;
const previews = document.querySelectorAll('.texshots canvas').length;

// Drag one of them, the way a person would, and check the preview redraws.
const smooth = document.querySelectorAll('.texcontrols input[type="range"]')[3];
smooth.value = '4';
smooth.dispatchEvent(new Event('input', { bubbles: true }));
await wait(300);

document.querySelector('#modalOk').click();
await wait(2500);

const feature = dev.state.doc.features.find((f) => f.type === 'textureRelief');
const held = feature ? dev.state.doc.imageData[feature.image] : null;

return {
  theProblem: {
    rangeAsItCame: Number((asItCame.max - asItCame.min).toFixed(2)),
    rangeAfterOpeningItOut: Number((opened.max - opened.min).toFixed(2)),
    seamAsItCame: seamOf(picture),
    seamAfterBlending: seamOf(cleaned)
  },
  dialogUp,
  sliders,
  previews,
  started,
  featureMade: !!feature,
  pictureKept: !!held?.gray,
  pictureIsPlainNumbers: Array.isArray(held?.gray),
  pictureNamed: held?.name,
  // The picture goes into the document in the same undo step as the feature
  // that uses it, so undoing the feature does not leave one behind.
  errors: (dev.state.result?.errors || []).map((e) => e.message).concat(report.errors)
};
