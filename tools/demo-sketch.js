/**
 * Drives the sketch tools with synthetic pointer events, the same path a mouse
 * takes, and reports what the sketch and the solver made of it.
 *
 * Runs inside the page via --anvil-script.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const canvas = document.getElementById('view');

function pointAt(x, y) {
  const s = dev.state.sketcher.planeToScreen(x, y);
  const rect = canvas.getBoundingClientRect();
  return { clientX: rect.left + s.x, clientY: rect.top + s.y };
}

function fire(type, x, y) {
  const at = pointAt(x, y);
  canvas.dispatchEvent(
    new PointerEvent(type, {
      ...at,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      bubbles: true,
      cancelable: true
    })
  );
}

async function click(x, y) {
  fire('pointermove', x, y);
  await wait(20);
  fire('pointerdown', x, y);
  fire('pointerup', x, y);
  await wait(40);
}

/* ---- start a sketch on XY through the ribbon ---- */

// Create Sketch asks by putting the origin planes in the viewport, so answer it
// by pointing at a spot only XY covers rather than by filling in a dialog.
document.querySelector('[data-cmd="newSketch"]').click();
await wait(120);
{
  const at = dev.state.vp.worldToScreen(20, 20, 0);
  canvas.dispatchEvent(new PointerEvent('pointermove', { ...at, button: 0, buttons: 0, pointerId: 1, bubbles: true, cancelable: true }));
  await wait(30);
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 0, buttons: 1, pointerId: 1, bubbles: true, cancelable: true }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...at, button: 0, buttons: 0, pointerId: 1, bubbles: true, cancelable: true }));
}
await wait(700);

const sketcher = dev.state.sketcher;
if (!sketcher.active) return { error: 'sketch mode did not start' };

/* ---- draw an outer rectangle ---- */

sketcher.setTool('rectangle');
await click(-30, -18);
await click(30, 18);

/* ---- a circle in the middle and two more off to the sides ---- */

sketcher.setTool('circle');
await click(0, 0);
await click(8, 0);

await click(-20, 0);
await click(-20, 4);

await click(20, 0);
await click(20, 4);

/* ---- a chain of lines making a notch, closed back on itself ---- */

sketcher.setTool('line');
await click(-8, 12);
await click(8, 12);
await click(0, 6);
await click(-8, 12);

const solve = sketcher.solve();
sketcher.refreshRegions();
sketcher.rebuild();
await wait(200);

const summary = {
  points: sketcher.sketch.points.length,
  entities: sketcher.sketch.entities.map((e) => e.type),
  constraints: sketcher.sketch.constraints.map((c) => c.type),
  regions: sketcher.regions.length,
  regionAreas: sketcher.regions.map((r) => Number(r.area.toFixed(2))),
  dof: solve.dof,
  residual: solve.error
};

/* ---- pick the plate region, finish, and extrude it ---- */

const plate = sketcher.regions.find((r) => r.holes.length > 0) || sketcher.regions[0];
sketcher.selectedRegions.add(plate.id);
sketcher.rebuild();
await wait(150);

const shot = dev.state.vp;
shot.setView([0.5, -0.8, 0.35]);
await wait(200);

summary.selectedRegionArea = Number(plate.area.toFixed(2));
summary.selectedRegionHoles = plate.holes.length;

return summary;
