/**
 * Menus, driven the way a mouse drives them.
 *
 * Every other demo reaches a ribbon menu with `element.click()`, which sends a
 * click and no pointer events at all. That is a path no mouse can take, and it
 * hid a menu that closed itself on pointerdown: the item being pressed was torn
 * out of the document before the click could reach it, so every dropdown in the
 * application, and the right click menu with them, did nothing whatsoever.
 *
 * So this one presses: down, up, then click. It checks that a dropdown opens,
 * that pressing an item actually runs it, and that a press outside still shuts
 * the menu, which is the behaviour the broken version was reaching for.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

/** What a mouse actually sends: down, up, then click. */
async function press(el) {
  const r = el.getBoundingClientRect();
  const at = {
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    pointerId: 1,
    bubbles: true,
    cancelable: true
  };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 0, buttons: 1 }));
  await wait(30);
  el.dispatchEvent(new PointerEvent('pointerup', { ...at, button: 0, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('click', { ...at, button: 0 }));
  await wait(150);
}

/* ---- 1. a dropdown on the Solid tab, pressed properly ---- */
dev.setTab('solid');
await wait(150);
await press(document.querySelector('[data-menu="primitive"]'));
report.primitiveMenuOpen = !!document.getElementById('markmenu');

const items = [...(document.getElementById('markmenu')?.querySelectorAll('button') || [])];
report.primitiveItems = items.map((b) => b.textContent);
if (items[1]) await press(items[1]);          // Cylinder
await wait(400);
report.afterPressingCylinder = {
  menuGone: !document.getElementById('markmenu'),
  dialogTitle: document.getElementById('inspectorTitle')?.textContent,
  dialogOpen: !document.getElementById('inspector')?.classList.contains('hidden')
};
document.getElementById('inspectorOk')?.click();
await wait(500);
report.bodies = dev.bodies.length;

/* ---- 2. a sketch family dropdown, pressed properly ---- */
document.querySelector('[data-tab="sketch"]').click();
await wait(150);
await press(document.querySelector('[data-panel="sketch"] [data-menu="rectangle"]'));
report.rectangleMenuOpen = !!document.getElementById('markmenu');
const rectItems = [...(document.getElementById('markmenu')?.querySelectorAll('button') || [])];
if (rectItems[1]) await press(rectItems[1]);   // Centre Rectangle
await wait(300);
report.afterPressingCentreRectangle = {
  menuGone: !document.getElementById('markmenu'),
  pendingTool: dev.state.pendingTool,
  status: document.getElementById('status')?.textContent
};

/* ---- 3. pressing outside still closes a menu ---- */
await press(document.querySelector('[data-menu="primitive"]') || document.body);
report.reopened = !!document.getElementById('markmenu');
{
  // On the canvas, which is where a press outside the menu actually lands.
  const canvas = document.getElementById('view');
  const r = canvas.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, bubbles: true };
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 0, buttons: 1 }));
  await wait(150);
}
report.closedByOutsidePress = !document.getElementById('markmenu');

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
