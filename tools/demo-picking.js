/**
 * The three things volume tests cannot see: does clicking a profile twice let
 * it go, does a profile picked into a dialog look picked, and does the callout
 * say what the dialog wants.
 *
 * Runs inside the page via --anvil-script.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const canvas = document.getElementById('view');
const report = {};

function planePoint(x, y) {
  const s = dev.state.sketcher.planeToScreen(x, y);
  const rect = canvas.getBoundingClientRect();
  return { clientX: rect.left + s.x, clientY: rect.top + s.y };
}

function fire(type, at, opts = {}) {
  canvas.dispatchEvent(
    new PointerEvent(type, {
      ...at,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      bubbles: true,
      cancelable: true,
      ...opts
    })
  );
}

async function clickPlane(x, y) {
  const at = planePoint(x, y);
  fire('pointermove', at);
  await wait(15);
  fire('pointerdown', at);
  fire('pointerup', at);
  await wait(30);
}

/** Screen position of a finished sketch's region, for clicking it in the model. */
function profilePoint(index) {
  const mesh = dev.state.profileTargets[index];
  if (!mesh) return null;
  mesh.geometry.computeBoundingSphere();
  const c = mesh.geometry.boundingSphere.center.clone();
  mesh.localToWorld(c);
  // worldToScreen already returns client coordinates.
  const s = dev.state.vp.worldToScreen(c.x, c.y, c.z);
  if (!Number.isFinite(s.clientX) || !Number.isFinite(s.clientY)) return null;
  return { clientX: s.clientX, clientY: s.clientY };
}

async function clickProfile(index) {
  const at = profilePoint(index);
  if (!at) return false;
  fire('pointermove', at);
  await wait(40);
  fire('pointerdown', at);
  fire('pointerup', at);
  await wait(60);
  return true;
}

/* ---- a sketch with two separate regions ---- */

document.querySelector('[data-cmd="newSketch"]').click();
await wait(120);
{
  const node = [...document.querySelectorAll('#tree .node')].find(
    (n) => n.textContent.trim() === 'XY plane'
  );
  if (!node) return { error: 'no XY plane in the browser' };
  node.click();
}
await wait(600);

const sketcher = dev.state.sketcher;
if (!sketcher.active) return { error: 'sketch did not start' };

sketcher.setTool('centerRectangle');
await clickPlane(-22, 0);
await clickPlane(-6, 12);
sketcher.setTool('centerRectangle');
await clickPlane(22, 0);
await clickPlane(38, 12);

// Finish with nothing chosen, so the extrude dialog has to be pointed at.
dev.runCommand('finishSketch');
await wait(400);
report.regions = dev.state.profileTargets.length;
report.carried = dev.state.selection.profiles.length;

// Off the sketch plane, or the regions are edge on and unclickable.
dev.state.vp.setView([0.5, -0.8, 0.42], false);
dev.state.vp.fit(1.6);
await wait(350);

/* ---- the callout ---- */

dev.runCommand('extrude');
await wait(300);
{
  const box = document.getElementById('pickcallout');
  report.calloutShown = !box.classList.contains('hidden');
  report.calloutTitle = document.getElementById('pcTitle').textContent;
  report.calloutMsg = document.getElementById('pcMsg').textContent;
  report.calloutCountBefore = document.getElementById('pcCount').textContent;
  report.oldBarHidden = document.getElementById('pickbar').classList.contains('hidden');
}

/* ---- clicking the same profile three times ---- */

const f = dev.state.editing?.feature;
if (!f) return { ...report, error: 'extrude dialog did not open' };

const seeds = () => (f.seeds === null ? 'whole' : f.seeds.length);

report.seedsAtOpen = seeds();
if (!(await clickProfile(0))) return { ...report, error: 'no profile mesh to click' };
report.afterClick1 = seeds();
await clickProfile(0);
report.afterClick2 = seeds();
await clickProfile(0);
report.afterClick3 = seeds();

// Leave one profile chosen and the second hovered, so the shot shows both the
// selected fill and the hover fill at once.
report.calloutCountAfter = document.getElementById('pcCount').textContent;

{
  const at = profilePoint(1);
  if (at) {
    fire('pointermove', at);
    // The callout follows the real cursor, which synthetic canvas events do not
    // move, so nudge it through the wrapper the same way a pointer would.
    document.getElementById('viewwrap').dispatchEvent(
      new PointerEvent('pointermove', { ...at, bubbles: true, pointerId: 1 })
    );
    await wait(120);
    report.hovered = !!dev.state.hoverProfile;
  }
}

// Left at zero distance on purpose, so the shot has one region chosen and one
// hovered rather than one region and one finished body.
await wait(200);

report.calloutStillShown = !document
  .getElementById('pickcallout')
  .classList.contains('hidden');
dev.setStatus('Picking demo: one profile chosen, one hovered.');
await wait(300);
return report;
