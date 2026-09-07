/**
 * Render: a still of the model, accumulated rather than grabbed off the screen.
 *
 * The save dialog is skipped, because a demo that needs somebody to click Save
 * is not a demo. What is checked is the picture itself: that it is the size
 * asked for, that it holds the model rather than an empty frame, and that the
 * grid and the origin planes are not in it, which is the difference between a
 * render and a screenshot.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

/* ---- something to render ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(400);
document.getElementById('inspectorOk').click();
await wait(700);
{
  // A plate with a bore renders better than a bare box: a curved surface is
  // where the accumulation shows, because that is where a single pass has a
  // stepped edge.
  const doc = dev.state.doc;
  doc.features[0].params = {
    ...doc.features[0].params,
    width: '60',
    depth: '40',
    height: '12',
    centered: true
  };
  doc.features.push({
    id: 'fbore',
    type: 'primitive',
    shape: 'cylinder',
    op: 'cut',
    targets: 'all',
    params: { diameter: '16', height: '40', centered: true, x: '0', y: '0', z: '0' }
  });
  dev.rebuildAll();
  await wait(700);
}
dev.state.vp.fit();
await wait(600);
report.built = dev.bodies.length;

/* ---- a small render, measured ---- */
const started = performance.now();
const canvas = await dev.state.vp.renderStill({
  width: 480,
  height: 300,
  samples: 8,
  softness: 0.08,
  background: '#20242a'
});
report.render = {
  width: canvas.width,
  height: canvas.height,
  tookMs: Math.round(performance.now() - started)
};

/* ---- what is actually in the picture ---- */
{
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const bg = [0x20, 0x24, 0x2a];
  let lit = 0;
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 250) opaque++;
    const off =
      Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    if (off > 24) lit++;
  }
  const pixels = canvas.width * canvas.height;
  report.picture = {
    everyPixelOpaque: opaque === pixels,
    // A box seen from the usual angle covers a good part of the frame but
    // nothing like all of it. Nothing at all means an empty render; everything
    // means the background was never cleared.
    fractionCovered: +(lit / pixels).toFixed(3)
  };
  report.picture.holdsAModel = lit / pixels > 0.05 && lit / pixels < 0.9;
}

/* ---- the same view with nothing behind it ---- */
{
  const clear = await dev.state.vp.renderStill({
    width: 240,
    height: 150,
    samples: 4,
    background: 'transparent'
  });
  const data = clear.getContext('2d').getImageData(0, 0, clear.width, clear.height).data;
  let seeThrough = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 8) seeThrough++;
  report.transparent = {
    // The corners of the frame have no model in them, so they must be clear.
    someOfItIsClear: seeThrough > 0,
    fractionClear: +(seeThrough / (clear.width * clear.height)).toFixed(3)
  };
}

/* ---- the tool is not in the picture ---- */
report.helpersPutBack = {
  helpers: dev.state.vp.helperGroup.visible,
  overlay: dev.state.vp.overlayGroup.visible
};

/* ---- the same settings give the same picture twice ---- */
{
  const a = await dev.state.vp.renderStill({ width: 120, height: 80, samples: 4 });
  const b = await dev.state.vp.renderStill({ width: 120, height: 80, samples: 4 });
  const da = a.getContext('2d').getImageData(0, 0, 120, 80).data;
  const db = b.getContext('2d').getImageData(0, 0, 120, 80).data;
  let same = true;
  for (let i = 0; i < da.length; i++) {
    if (da[i] !== db[i]) {
      same = false;
      break;
    }
  }
  report.repeatable = same;
}

/* ---- and one to look at ---- */
//
// Put the finished picture over the window so the screenshot this demo is
// captured with is the render itself rather than the application drawing it.
{
  const big = await dev.state.vp.renderStill({
    width: 1200,
    height: 750,
    samples: 48,
    softness: 0.09,
    background: '#20242a'
  });
  const img = document.createElement('img');
  img.src = big.toDataURL('image/png');
  Object.assign(img.style, {
    position: 'fixed',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    background: '#20242a',
    zIndex: '99999'
  });
  document.body.appendChild(img);
  await wait(600);
  report.shown = { width: big.width, height: big.height };
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
