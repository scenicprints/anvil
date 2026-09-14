/**
 * Picking a face, and nothing else happening.
 *
 * A face is what a click lands on, and for a long time picking one did three
 * other things as well: it stood an extrude arrow up on the face, it turned
 * the camera so the arrow had length to be dragged along, and because the
 * arrow is drawn over the top of everything and takes the click before the
 * model does, the next pick landed on the arrow instead of on the face beside
 * it. Colouring a face, sketching on it, or picking two of them all meant
 * fighting that.
 *
 * So this checks the quiet version: one click selects one face and changes
 * nothing else, a second with Shift adds to it, the commands that want a body
 * take the body the picked face belongs to rather than every body in the
 * document, and the arrow appears when Press Pull is asked for and not before.
 *
 * Real pointer events at real screen positions, like the other probes here,
 * because every one of these faults is invisible from inside the functions
 * they live in.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const canvas = document.getElementById('view');
const report = { errors: [] };
window.addEventListener('error', (e) =>
  report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`)
);

const at = (cx, cy, shift) => ({
  clientX: cx,
  clientY: cy,
  pointerId: 1,
  bubbles: true,
  cancelable: true,
  isPrimary: true,
  shiftKey: !!shift
});
const fire = (type, cx, cy, buttons, shift) =>
  canvas.dispatchEvent(new PointerEvent(type, { ...at(cx, cy, shift), button: 0, buttons }));

async function clickAt(cx, cy, shift = false) {
  fire('pointermove', cx, cy, 0, shift);
  await wait(40);
  fire('pointerdown', cx, cy, 1, shift);
  await wait(40);
  fire('pointerup', cx, cy, 0, shift);
  await wait(200);
}

const screen = (p) => dev.state.vp.worldToScreen(p[0], p[1], p[2]);
const faceIndex = (key) => Number(String(key).split(':').pop());
const bodyOf = (key) => String(key).split(':').slice(0, -1).join(':');

const arrowLength = () => {
  const f = dev.state.pullHandle?.frame;
  if (!f) return 0;
  const size = dev.state.vp.pixelSize() * 95;
  const o = screen(f.origin);
  const tip = screen([
    f.origin[0] + f.z[0] * size,
    f.origin[1] + f.z[1] * size,
    f.origin[2] + f.z[2] * size
  ]);
  if (!o || !tip || o.behind || tip.behind) return 0;
  return Number(Math.hypot(tip.clientX - o.clientX, tip.clientY - o.clientY).toFixed(1));
};
const eye = () => dev.state.vp.camera.position.toArray().map((n) => Number(n.toFixed(3)));
const moved = (a, b) => a.some((n, i) => Math.abs(n - b[i]) > 0.01);

async function dropSelection() {
  document.body.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(150);
}

/** Wait for the panel, then press OK and wait for what it did. */
async function okPanel() {
  for (let i = 0; i < 40 && document.getElementById('inspector').classList.contains('hidden'); i++) {
    await wait(50);
  }
  document.getElementById('inspectorOk').click();
  await wait(700);
}

/** Answer a panel: set each of its choices in turn, then press OK. */
async function answerPanel(values) {
  const rows = [...document.querySelectorAll('#inspectorBody select')];
  for (const [i, v] of values.entries()) {
    if (!rows[i]) continue;
    rows[i].value = v;
    rows[i].dispatchEvent(new Event('change', { bubbles: true }));
    await wait(150);
  }
  await okPanel();
  return rows.length;
}

/**
 * A screen point that really does land on a face of this body other than the
 * one given. Aiming at a corner of the box by arithmetic lands on the
 * silhouette as often as on the face, and a miss there starts a selection box
 * rather than picking anything, which would read as the Shift click failing.
 */
function otherFacePoint(bodyId, avoid) {
  const rec = dev.state.records.find((r) => r.id === bodyId);
  for (const face of rec?.topology?.faces || []) {
    const s = screen(face.centre);
    if (!s || s.behind) continue;
    const hit = dev.state.vp.pickEntity(s.clientX, s.clientY, { edges: false });
    if (hit && hit.bodyId === bodyId && hit.faceId !== null && hit.faceId !== avoid) return s;
  }
  return null;
}

/* ---- a box and a cylinder, so "this body" can be told from "every body" ---- */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(400);
await okPanel();

dev.runCommand('primCyl');
await wait(400);
{
  const f = dev.state.editing?.feature;
  if (!f) return { ...report, error: 'no cylinder dialog' };
  // Beside the box and its own body, not joined to it: the point of it is to
  // be the body that must NOT be touched when the box is coloured.
  f.op = 'new';
  f.params.diameter = '26';
  f.params.height = '50';
  f.params.x = '40';
  await okPanel();
}
await wait(400);
dev.state.vp.fit(1.7);
await wait(400);
report.bodies = dev.bodies.length;
if (report.bodies !== 2) return { ...report, error: 'expected a box and a cylinder' };

const box = dev.bodies[0];
const top = Number(box.solid.boundingBox().max[2].toFixed(3));
const topFace = screen([-9, -7, top]);

/* ---- one click picks one face, and does nothing else at all ---- */
await dropSelection();
const before = eye();
await clickAt(topFace.clientX, topFace.clientY);
report.oneClick = {
  faces: dev.state.selection.faces.size,
  bodies: dev.state.selection.bodies.size,
  arrow: arrowLength(),
  editorOpen: !!dev.state.editing,
  cameraMoved: moved(before, eye())
};
report.pickingAFaceIsJustPicking =
  report.oneClick.faces === 1 &&
  report.oneClick.arrow === 0 &&
  !report.oneClick.editorOpen &&
  !report.oneClick.cameraMoved;

/* ---- and a second one with Shift adds to it ---- */
const first = [...dev.state.selection.faces][0];
const second = otherFacePoint(bodyOf(first), faceIndex(first));
if (!second) return { ...report, error: 'no second face in view' };
await clickAt(second.clientX, second.clientY, true);
report.shiftClick = {
  faces: dev.state.selection.faces.size,
  editorOpen: !!dev.state.editing,
  title: document.getElementById('inspectorTitle')?.textContent
};
report.twoFacesCanBePicked = report.shiftClick.faces === 2 && !report.shiftClick.editorOpen;

/* ---- colouring those two faces colours those two faces ---- */
dev.runCommand('appearance');
await wait(400);
report.appearanceRows = await answerPanel(['faces', '#b8564a']);
report.faceColour = {
  faces: (dev.doc.appearance?.faces || []).length,
  byBody: Object.keys(dev.doc.appearance?.byBody || {}).length,
  allOnTheOneBody: (dev.doc.appearance?.faces || []).every((f) => f.body === bodyOf(first))
};
report.facesTookTheColour =
  report.faceColour.faces === 2 &&
  report.faceColour.byBody === 0 &&
  report.faceColour.allOnTheOneBody;

// And they are found again after a rebuild, which a face number cannot do.
dev.rebuildAll();
await wait(800);
report.colourFoundItsFacesAgain =
  (dev.state.records.find((r) => r.id === bodyOf(first))?.faceColours || []).length === 2;

/* ---- colouring the body colours that body, not the document ---- */
await dropSelection();
await clickAt(topFace.clientX, topFace.clientY);
const picked = bodyOf([...dev.state.selection.faces][0]);
dev.runCommand('appearance');
await wait(400);
await answerPanel(['bodies', '#4a7fb8']);
report.bodyColour = { coloured: Object.keys(dev.doc.appearance?.byBody || {}), picked };
report.onlyTheBodyUnderTheFace =
  report.bodyColour.coloured.length === 1 && report.bodyColour.coloured[0] === picked;

/* ---- Bodies only means bodies only ---- */
await dropSelection();
dev.runCommand('priorityBody');
await clickAt(topFace.clientX, topFace.clientY);
report.bodyPriority = {
  bodies: dev.state.selection.bodies.size,
  faces: dev.state.selection.faces.size
};
report.bodyPriorityPicksBodies =
  report.bodyPriority.bodies === 1 && report.bodyPriority.faces === 0;
dev.runCommand('priorityAuto');
await dropSelection();

/* ---- and the arrow comes back the moment Press Pull is asked for ---- */
await clickAt(topFace.clientX, topFace.clientY);
report.beforeAsking = arrowLength();
dev.runCommand('pressPull');
await wait(900);
report.afterAsking = {
  arrow: arrowLength(),
  title: document.getElementById('inspectorTitle')?.textContent,
  box: !!document.querySelector('.pull-entry input')
};
report.pressPullStandsItUp =
  report.beforeAsking === 0 && report.afterAsking.arrow > 40 && report.afterAsking.box;
document.getElementById('inspectorCancel').click();
await wait(600);
report.cancelLeftNothing = !dev.state.editing && !document.querySelector('.pull-entry');

/* ---- a command asked for first takes the pick, and the selection does not ---- */
// The other order. Picking first and then asking for a command is above; this
// is asking for the command and then pointing at what it should work on, which
// is the order Fusion opens every one of these dialogs expecting.
await dropSelection();
dev.runCommand('fillet');
await wait(900);
report.filletOpensArmed = {
  title: document.getElementById('inspectorTitle')?.textContent,
  armed: dev.state.editing?.pickInto || null
};
{
  const rec = dev.state.records.find((r) => r.id === bodyOf(first));
  const edge = (rec?.topology?.edges || []).find((e) => e.convex && e.refPoint);
  const s = edge ? screen(edge.refPoint) : null;
  if (s && !s.behind) await clickAt(s.clientX, s.clientY);
  report.pickWentToTheCommand = {
    intoFeature: dev.state.editing?.feature?.sets?.[0]?.edges?.length ?? 0,
    intoSelection: dev.state.selection.edges.size,
    stillFillet: document.getElementById('inspectorTitle')?.textContent
  };
}
report.theOpenCommandGetsThePick =
  report.pickWentToTheCommand.intoFeature === 1 &&
  report.pickWentToTheCommand.intoSelection === 0 &&
  report.pickWentToTheCommand.stillFillet === 'Fillet';
document.getElementById('inspectorCancel').click();
await wait(600);

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
