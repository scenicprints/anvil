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

return {
  ribbonHeight: Math.round(ribbon.getBoundingClientRect().height),
  viewportHeight: Math.round(document.getElementById('viewwrap').getBoundingClientRect().height),
  rows,
  activeTool: dev.state.sketcher.tool
};
