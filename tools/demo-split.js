/**
 * Splitting with more than one tool, and the mirror that shares the pick.
 *
 * Fusion takes several splitting tools at once, and one pass with three planes
 * is not the same as three features: the pieces from the first cut are what the
 * second cuts, so a box crossed by three planes comes out as eight parts. Anvil
 * took one tool and let go of the pick after it.
 *
 * Mirror fills its plane from the same branch of the picking code, and it still
 * takes exactly one, so this checks that too. Widening a shared branch and
 * breaking the other thing on it is the ordinary way this goes wrong.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const canvas = document.getElementById('view');
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

const at = (cx, cy) => ({
  clientX: cx,
  clientY: cy,
  pointerId: 1,
  bubbles: true,
  cancelable: true,
  isPrimary: true
});
const fire = (t, x, y, b) => canvas.dispatchEvent(new PointerEvent(t, { ...at(x, y), button: 0, buttons: b }));
async function clickAt(x, y) {
  fire('pointermove', x, y, 0);
  await wait(50);
  fire('pointerdown', x, y, 1);
  await wait(40);
  fire('pointerup', x, y, 0);
  await wait(300);
}

const rows = () => [...document.querySelectorAll('#inspectorBody .field')];
const rowFor = (t) => rows().find((r) => r.textContent.includes(t));
const summaryOf = (t) => rowFor(t)?.querySelector('.picksummary')?.textContent ?? null;

/* ---- a box about the origin ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(500);
for (const [label, value] of [['Width', '40'], ['Depth', '40'], ['Height', '40']]) {
  const input = rowFor(label)?.querySelector('input');
  if (!input) return { ...report, stuckAt: `no ${label} row` };
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(150);
}
{
  const centred = rowFor('Centre on origin')?.querySelector('input[type="checkbox"]');
  if (centred && !centred.checked) {
    centred.checked = true;
    centred.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(300);
  }
}
document.getElementById('inspectorOk').click();
await wait(900);
report.volumeBefore = Number(dev.bodies[0].solid.volume().toFixed(0));

/* ---- Split, which should open already asking ---- */
dev.runCommand('splitBody');
await wait(700);
report.dialog = document.getElementById('inspectorTitle')?.textContent;
report.armedOnOpen = dev.state.editing?.pickInto;
report.summaryStartsEmpty = summaryOf('Split with');
report.toolsStartEmpty = (dev.state.editing?.feature?.tools || []).length === 0;

/* ---- three origin planes, clicked one after another ---- */
{
  // Turned on by the pick, so they can be aimed at. Each is clicked well away
  // from the middle so the three do not land on each other.
  const aim = (x, y, z) => dev.state.vp.worldToScreen(x, y, z);
  const shots = [
    ['XY', aim(24, 24, 0)],
    ['XZ', aim(24, 0, 24)],
    ['YZ', aim(0, 24, 24)]
  ];
  report.planesVisible = dev.state.vp.originPlanes?.visible ?? null;
  for (const [name, s] of shots) {
    if (!s || s.behind) continue;
    await clickAt(s.clientX, s.clientY);
  }
  const tools = dev.state.editing?.feature?.tools || [];
  report.toolsPicked = tools.map((t) => (t.plane ? String(t.plane) : 'a face'));
  report.tookThree = tools.length === 3;
  // The row stays armed, or picking the second would mean re-arming for it.
  report.stillArmed = dev.state.editing?.pickInto === 'splitFace';
  report.summaryAfter = summaryOf('Split with');
  report.removeRowsAppeared = rows().filter((r) => r.textContent.includes('Remove')).length;
}

document.getElementById('inspectorOk').click();
await wait(1200);
report.bodies = dev.bodies.length;
report.volumes = dev.bodies.map((b) => Number(b.solid.volume().toFixed(0))).sort((a, b) => a - b);
report.cutIntoEight = report.bodies === 8;
report.nothingLost =
  Math.abs(report.volumes.reduce((a, b) => a + b, 0) - report.volumeBefore) < 1;
report.errorsAfterSplit = (dev.state.result?.errors || []).map((e) => e.message);

/* ---- and mirror, which shares the branch, still takes exactly one ---- */
{
  dev.state.selection.bodies.clear();
  dev.state.selection.bodies.add(dev.bodies[0].id);
  dev.runCommand('mirror');
  await wait(700);
  report.mirrorDialog = document.getElementById('inspectorTitle')?.textContent;
  const btn = rowFor('plane')?.querySelector('button') || rowFor('Mirror')?.querySelector('button');
  if (btn) {
    btn.click();
    await wait(300);
    const s = dev.state.vp.worldToScreen(24, 24, 0);
    if (s && !s.behind) await clickAt(s.clientX, s.clientY);
  }
  const f = dev.state.editing?.feature;
  report.mirrorPlane = f?.plane ?? null;
  report.mirrorTookOnePlane = !!f?.planeRef && !Array.isArray(f?.planeRef);
  // Mirror lets go after one, so the next click is an ordinary selection again.
  report.mirrorLetGo = dev.state.editing?.pickInto === null;
  document.getElementById('inspectorCancel')?.click();
  await wait(400);
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
