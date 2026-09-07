/**
 * The three new sketch tools, drawn the way a person draws them.
 *
 * A three point circle, a collinear constraint, and a blend curve joining two
 * arcs. The blend is the one worth watching: the check at the end is not that
 * a spline appeared, it is that the curvature on either side of the join
 * matches, which is the whole reason the command exists.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

const BL = await import('./blend.js');
const PR = await import('./profile.js');
const SV = await import('./solver.js');

const sk = () => dev.state.sketcher.sketch;
const ents = () => sk().entities;

/* ---- a sketch to draw in ---- */
//
// Create Sketch asks which plane by putting the origin planes in the viewport,
// so it is answered by pointing at a spot only XY covers.
const canvas = document.getElementById('view');
document.querySelector('[data-cmd="newSketch"]').click();
await wait(150);
{
  const at = dev.state.vp.worldToScreen(20, 20, 0);
  const send = (type, buttons) =>
    canvas.dispatchEvent(
      new PointerEvent(type, { ...at, button: 0, buttons, pointerId: 1, bubbles: true, cancelable: true })
    );
  send('pointermove', 0);
  await wait(30);
  send('pointerdown', 1);
  send('pointerup', 0);
}
await wait(700);
report.inSketch = !!dev.state.sketcher.active;
if (!report.inSketch) return report;

/* ---- three point circle ---- */
{
  const s = dev.state.sketcher;
  s.setTool('circle3');
  const before = ents().length;
  // Three points of a circle of radius 10 about the origin, clicked in turn.
  s.applyTool({ x: 10, y: 0 }, null, {});
  s.applyTool({ x: 0, y: 10 }, null, {});
  s.applyTool({ x: -10, y: 0 }, null, {});
  await wait(200);
  const made = ents().slice(before).find((e) => e.type === 'circle');
  report.circle3 = made
    ? { radius: +made.r.toFixed(4), centre: [sk().points[made.c].x, sk().points[made.c].y] }
    : null;
}

/* ---- collinear ---- */
{
  const s = dev.state.sketcher;
  const put = (x, y) => sk().points.push({ x, y }) - 1;
  const a0 = put(-40, -30);
  const a1 = put(-20, -30);
  const b0 = put(0, -24);
  const b1 = put(20, -20);
  const e1 = s.addEntity({ type: 'line', p: [a0, a1] });
  const e2 = s.addEntity({ type: 'line', p: [b0, b1] });
  s.addConstraint({ type: 'fixed', point: a0, x: -40, y: -30 });
  s.addConstraint({ type: 'fixed', point: a1, x: -20, y: -30 });
  s.addConstraint({ type: 'collinear', entities: [e1.id, e2.id] });
  SV.solveSketch(sk());
  report.collinear = {
    y0: +sk().points[b0].y.toFixed(4),
    y1: +sk().points[b1].y.toFixed(4),
    stillApart: +(sk().points[b0].x - sk().points[a1].x).toFixed(2)
  };
}

/* ---- blend curve between two arcs ---- */
{
  const s = dev.state.sketcher;
  const put = (x, y) => sk().points.push({ x, y }) - 1;
  const cL = put(-40, 30);
  const lStart = put(-55, 30);
  const lEnd = put(-40, 45);
  const cR = put(40, 30);
  const rEnd = put(40, 45);
  const rStart = put(55, 30);
  // The mirror of the left arc, so both loose ends are the same height and both
  // are turning the same amount. Mirroring turns it round, so it runs the other
  // way.
  const arcL = s.addEntity({ type: 'arc', c: cL, p: [lStart, lEnd], ccw: true });
  const arcR = s.addEntity({ type: 'arc', c: cR, p: [rEnd, rStart], ccw: true });

  s.setTool('blendCurve');
  const before = ents().length;
  s.applyTool({ x: sk().points[lEnd].x, y: sk().points[lEnd].y }, null, {});
  s.applyTool({ x: sk().points[rEnd].x, y: sk().points[rEnd].y }, null, {});
  await wait(200);

  const spline = ents().slice(before).find((e) => e.type === 'bspline');
  report.blend = spline ? { controlPoints: spline.p.length } : null;
  if (spline) {
    const a = BL.endFrame(sk(), arcL, lEnd);
    const b = BL.endFrame(sk(), arcR, rEnd);
    const ctrl = spline.p.map((i) => ({ x: sk().points[i].x, y: sk().points[i].y }));
    const r = BL.blendReport(ctrl, a, b);
    report.blend.join = {
      curvatureWantedA: +r.wantA.toFixed(5),
      curvatureGotA: +r.curvatureA.toFixed(5),
      curvatureWantedB: +r.wantB.toFixed(5),
      curvatureGotB: +r.curvatureB.toFixed(5),
      tangentA: +r.tangentA.toFixed(6),
      tangentB: +r.tangentB.toFixed(6)
    };
    // The blend starts and finishes on the arcs' own points, not on copies, so
    // moving an arc takes the blend with it.
    report.blend.sharesEnds = spline.p[0] === lEnd && spline.p[spline.p.length - 1] === rEnd;
    report.blend.drawn = PR.tessellate(sk(), spline).length;
  }
}

dev.finishSketch();
await wait(400);
report.finalErrors = (dev.state.result?.errors || []).map((e) => e.message);
return report;
