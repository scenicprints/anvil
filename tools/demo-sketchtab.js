/** Open a sketch and show the Sketch tab, to check the ribbon still fits. */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

document.querySelector('[data-cmd="newSketch"]').click();
await wait(120);
const node = [...document.querySelectorAll('#tree .node')].find(
  (n) => n.textContent.trim() === 'XY plane'
);
if (!node) return { error: 'no XY plane' };
node.click();
await wait(600);

dev.setTab('sketch');
await wait(300);

const ribbon = document.getElementById('ribbon');
const panel = document.querySelector('[data-panel="sketch"]');
const groups = [...panel.querySelectorAll('.group')];

// A group whose buttons run onto a third row costs the viewport fifty pixels.
const rows = groups.map((g) => {
  const tops = new Set(
    [...g.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top))
  );
  return { label: g.querySelector('.glabel')?.textContent, rows: tops.size };
});

dev.state.sketcher.setTool('ellipse');
await wait(200);

/* ---- reaching for a tool with no sketch open has to start one ---- */
const cold = {};
dev.runCommand('finishSketch');
await wait(400);
document.querySelector('[data-tab="sketch"]').click();
await wait(150);
cold.sketchActive = !!dev.state.sketcher.active;

// Through the dropdown, which is the path that used to dead end hardest:
// every button on the tab said "start a sketch first" and did nothing.
document.querySelector('[data-panel="sketch"] [data-menu="rectangle"]').click();
await wait(150);
document.getElementById('markmenu')?.querySelector('button')?.click();
await wait(250);
cold.asked = document.getElementById('status')?.textContent;
cold.remembered = dev.state.pendingTool;

[...document.querySelectorAll('#tree .node')]
  .find((n) => n.textContent.trim() === 'XY plane')?.click();
await wait(900);
cold.openedWith = dev.state.sketcher.tool;
cold.nowActive = !!dev.state.sketcher.active;

/* ---- and the origin snaps, so a shape can be drawn from it ---- */
const canvas = document.getElementById('view');
const px = dev.state.sketcher.pixelScale();
const at = dev.state.sketcher.planeToScreen(px * 3, px * 3);
const box = canvas.getBoundingClientRect();
canvas.dispatchEvent(
  new PointerEvent('pointermove', {
    clientX: box.left + at.x, clientY: box.top + at.y,
    buttons: 0, pointerId: 1, bubbles: true
  })
);
await wait(150);
const snap = dev.state.sketcher.snapInfo;

return {
  ribbonHeight: Math.round(ribbon.getBoundingClientRect().height),
  viewportHeight: Math.round(document.getElementById('viewwrap').getBoundingClientRect().height),
  rows,
  activeTool: 'ellipse',
  coldReach: cold,
  originSnap: { label: snap?.label ?? null, at: snap ? [snap.x, snap.y] : null }
};
