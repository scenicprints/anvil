/**
 * Shaping a form by dragging what you can see.
 *
 * Three things that are all the same want. Grabbing the surface rather than the
 * cage, because a control point is not on the shape and on anything rounded it
 * sits a long way off. Tangent handles, because the way a surface leaves a
 * point is a thing you should be able to take hold of. And snapping, because a
 * form that has to sit on a part put there by eye is never quite on it.
 *
 * All three are pointer work, so all three are driven here with real pointer
 * events rather than by calling the handlers: what is being checked is that the
 * hit testing finds the right thing and that the right thing then moves.
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
  await wait(250);
}
async function dragFrom(x0, y0, x1, y1) {
  fire('pointermove', x0, y0, 0);
  await wait(40);
  fire('pointerdown', x0, y0, 1);
  await wait(60);
  for (let i = 1; i <= 6; i++) {
    fire('pointermove', x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6, 1);
    await wait(50);
  }
  fire('pointerup', x1, y1, 0);
  await wait(400);
}

const rows = () => [...document.querySelectorAll('#inspectorBody .field')];
const rowFor = (t) => rows().find((r) => r.textContent.includes(t));
const setSelect = async (label, value) => {
  const sel = rowFor(label)?.querySelector('select');
  if (!sel) return false;
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(400);
  return true;
};
/** Where a point in the model is on screen. */
const screenOf = (p) => {
  const s = dev.state.vp.worldToScreen(p[0], p[1], p[2]);
  return s && !s.behind ? [s.clientX, s.clientY] : null;
};

/* ---- a box form ---- */
dev.setTab('form');
dev.runCommand('formBox');
await wait(900);
if (document.getElementById('inspectorOk')) {
  document.getElementById('inspectorOk').click();
  await wait(1200);
}

const ed = () => dev.state.editForm;
const cage = () => dev.state.doc.forms[ed()?.form];
report.madeAForm = !!dev.state.records.find((r) => r.isForm);
if (!report.madeAForm) return { ...report, stuckAt: 'no form was made' };

dev.runCommand('editForm');
await wait(900);
report.shapingStarted = !!ed();
if (!report.shapingStarted) return { ...report, stuckAt: 'Edit Form did not open' };

/* ---- the marks stand where the surface is, not where the cage is ---- */
{
  const FM = dev.form;
  report.hasLimitPoints = typeof FM?.limitPoints === 'function';
  const before = dev.state.vp.cagePoints;
  report.marksAreTheCageToStart = before === cage().points;

  report.switchedToSurface = await setSelect('Drag', 'surface');
  const marks = dev.state.vp.cagePoints;
  report.marksMovedOntoTheSurface =
    marks !== cage().points &&
    Math.hypot(...marks[0]) < Math.hypot(...cage().points[0]) - 0.5;
  report.cageCorner = cage().points[0].map((v) => +v.toFixed(3));
  report.surfaceCorner = marks[0].map((v) => +v.toFixed(3));
}

/* ---- dragging the surface puts the surface where it was dragged ---- */
{
  const FM = dev.form;
  const v = 0;
  ed().vertices.clear();
  ed().vertices.add(v);
  dev.refreshEditForm();
  await wait(300);

  const wanted = 6;
  const before = FM.limitPoints(cage())[v];
  const cageBefore = cage().points[v].slice();
  // Straight through the machinery the handle uses, because a drag on a gizmo
  // arrow cannot be aimed reliably from a script and this is the part that has
  // to be right.
  dev.state.doc.forms[ed().form] = FM.transformLimitPoints(
    cage(),
    new Map([[v, 1]]),
    FM.translation([wanted, 0, 0])
  );
  dev.rebuildAll();
  await wait(700);

  const after = FM.limitPoints(cage())[v];
  report.surfaceWentWhereItWasSent = Math.abs(after[0] - before[0] - wanted) < 1e-6;
  report.controlPointWentFurther =
    cage().points[v][0] - cageBefore[0] > wanted + 1;
  report.byHowMuchFurther = +(cage().points[v][0] - cageBefore[0]).toFixed(2);
}

/* ---- tangent handles: one point picked shows them, several do not ---- */
{
  await setSelect('Drag', 'control');
  ed().vertices.clear();
  ed().vertices.add(0);
  dev.refreshEditForm();
  await wait(400);
  const handles = dev.state.vp.tangentHandles;
  report.handlesAtOnePoint = handles ? handles.length : 0;
  report.handlesAreOnTheEdges =
    !!handles &&
    handles.every((h) => {
      const p = cage().points[h.vertex];
      const q = cage().points[h.neighbour];
      const want = [0, 1, 2].map((d) => p[d] + (q[d] - p[d]) * 0.45);
      return Math.hypot(...[0, 1, 2].map((d) => h.at[d] - want[d])) < 1e-9;
    });

  ed().vertices.add(1);
  dev.refreshEditForm();
  await wait(300);
  // Several points picked have no one tangent between them, so none are shown.
  report.noHandlesWithTwoPicked = !dev.state.vp.tangentHandles;
}

/* ---- and dragging one slides its neighbour along the edge, nothing else ---- */
{
  ed().vertices.clear();
  ed().vertices.add(0);
  dev.refreshEditForm();
  await wait(400);
  const handles = dev.state.vp.tangentHandles;
  const h = handles?.[0];
  if (!h) return { ...report, stuckAt: 'no tangent handle to drag' };

  const before = cage().points.map((p) => p.slice());
  const from = screenOf(h.at);
  const along = screenOf(before[h.neighbour]);
  report.handleIsOnScreen = !!from && !!along;
  if (from && along) {
    // Away from the vertex, along the line the edge already runs on.
    const to = [from[0] + (along[0] - from[0]) * 2.2, from[1] + (along[1] - from[1]) * 2.2];
    await dragFrom(from[0], from[1], to[0], to[1]);
    await wait(500);

    const after = cage().points;
    const moved = after
      .map((p, i) => (Math.hypot(...[0, 1, 2].map((d) => p[d] - before[i][d])) > 1e-6 ? i : -1))
      .filter((i) => i >= 0);
    report.onlyTheNeighbourMoved = moved.length === 1 && moved[0] === h.neighbour;
    report.whichMoved = moved;

    // Along the same line: the direction from the vertex is unchanged and only
    // the distance grew, which is what a tangent handle is for.
    const dirOf = (p) => {
      const d = [0, 1, 2].map((k) => p[k] - before[h.vertex][k]);
      const l = Math.hypot(...d) || 1;
      return d.map((v) => v / l);
    };
    const was = dirOf(before[h.neighbour]);
    const now = dirOf(after[h.neighbour]);
    report.tangentKeptItsDirection =
      Math.hypot(...[0, 1, 2].map((d) => now[d] - was[d])) < 1e-6;
    const reach = (p) => Math.hypot(...[0, 1, 2].map((d) => p[d] - before[h.vertex][d]));
    report.tangentGotLonger = reach(after[h.neighbour]) > reach(before[h.neighbour]) + 0.5;
  }
}

/* ---- snapping looks at the model and not at the form's own surface ---- */
{
  // A form's points sit on and around its own surface, so without the
  // exclusion every point would snap to the shape it is itself making, and the
  // drag would chase itself: each move changes the surface, which moves the
  // thing it was aiming at.
  const form = dev.state.records.find((r) => r.isForm);
  const p = cage().points[0];
  const on = dev.state.vp.worldToScreen(p[0], p[1], p[2]);
  report.formPointIsOnScreen = !!on && !on.behind;
  if (on) {
    const loose = dev.snapModelPoint(on.clientX, on.clientY);
    const strict = dev.snapModelPoint(on.clientX, on.clientY, { skipBody: form.id });
    report.wouldSnapToItself = !!loose;
    report.doesNotSnapToItself = !strict;
  }
}

report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
