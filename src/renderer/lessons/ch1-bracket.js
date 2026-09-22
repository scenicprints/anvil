/**
 * Chapter 1. A bracket.
 *
 * An L of steel with a slot in one leg and two holes in the other. It is the
 * part everybody's first CAD lesson builds, and it is the right one, because
 * every idea the program is built on turns up in it and nothing else does.
 *
 * The sketching half is most of the chapter on purpose. A sketch that is not
 * constrained is a drawing, and a drawing changes shape when you look at it
 * sideways. Getting that across early is worth more than another solid tool.
 */

import {
  cmd, inMenu, tool, con, step, made, madeN, ran,
  all, changed, grewBy, shrankBy, noErrors, bodies,
  sketch, useTool, done
} from './kit.js';

/*
 * What the steps below point at.
 *
 * A step that says "the outside vertical corners" is asking for four edges out
 * of twelve, and a sentence is a poor way to say which: the ring round the
 * button says what to press and nothing about what to press it on. These hand
 * the teacher the actual edges and faces, which it paints on the model.
 */
function solidBody(s) {
  return (s.records || []).find((r) => r.topology && r.topology.faces.length) || null;
}

function topZ(topo) {
  let z = -Infinity;
  for (const f of topo.faces) if (f.centre && f.centre[2] > z) z = f.centre[2];
  return z;
}

/** The upright edges of the outside wall: what a corner fillet rounds. */
function uprightEdges(s) {
  const rec = solidBody(s);
  if (!rec) return null;
  const edges = rec.topology.edges
    .filter((e) => e.kind === 'line' && Math.abs(e.dir?.[2] ?? 0) > 0.99)
    .map((e) => ({ bodyId: rec.id, edgeId: e.id }));
  return edges.length ? { edges } : null;
}

/** The edges round the top face: what a chamfer breaks. */
function topEdges(s) {
  const rec = solidBody(s);
  if (!rec) return null;
  const top = topZ(rec.topology);
  const edges = rec.topology.edges
    .filter(
      (e) =>
        e.kind === 'line' &&
        Math.abs(e.dir?.[2] ?? 0) < 0.01 &&
        (e.points || []).every((p) => Math.abs(p[2] - top) < 1e-6)
    )
    .map((e) => ({ bodyId: rec.id, edgeId: e.id }));
  return edges.length ? { edges } : null;
}

/** The flat face on top. */
function topFace(s) {
  const rec = solidBody(s);
  if (!rec) return null;
  const top = topZ(rec.topology);
  const face = rec.topology.faces
    .filter((f) => f.planar && f.normal?.[2] > 0.99 && Math.abs(f.centre[2] - top) < 1e-6)
    .sort((a, b) => b.area - a.area)[0];
  return face ? { faces: [{ bodyId: rec.id, faceId: face.id }] } : null;
}

/*
 * A circle of this radius whose centre is the middle of a flat face lying in
 * the sketch's plane. Measured, so a circle placed by eye near the middle does
 * not count and one snapped there does, however it was snapped.
 */
function circleInFaceMiddle(s, k, radius) {
  const plane = s.result?.sketchPlanes?.[k.id];
  if (!plane) return false;
  const local = (p) => {
    const d = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]];
    const dot = (a) => d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
    return { u: dot(plane.x), v: dot(plane.y), w: dot(plane.n) };
  };
  const middles = [];
  for (const r of s.records || []) {
    for (const f of r.topology?.faces || []) {
      if (!f.planar || !f.centre) continue;
      const c = local(f.centre);
      if (Math.abs(c.w) < 1e-3) middles.push(c);
    }
  }
  return (k.entities || []).some((e) => {
    if (e.type !== 'circle' || Math.abs(e.r - radius) > 0.01) return false;
    const c = k.points?.[e.c];
    return !!c && middles.some((m) => Math.hypot(m.u - c.x, m.v - c.y) < 0.05);
  });
}

export default {
  id: 'bracket',
  title: 'Bracket',
  blurb: 'Sketching, constraining, and the four solid tools that do most of the work.',
  steps: [
    step(
      'Start a sketch. It will ask which plane: take the flat one on the ground, XY.',
      cmd('newSketch'),
      'newSketch',
      made('sketch'),
      { tab: 'solid', play: sketch('XY', 'rectangle', []) }
    ),
    /*
     * Placing it and sizing it are one step, because the program makes them
     * one gesture: after the first corner the Width and Height boxes are right
     * there by the cursor, and typing into them is the dimensioning. Split in
     * two, the lesson could not see the first half until the rectangle was
     * closed, by which time the sizes it was about to ask for had been typed.
     *
     * Either way counts: typed while drawing, or drawn rough and dimensioned
     * after with Sketch Dimension.
     */
    step(
      'Draw a rectangle 80 by 60. Click one corner, then type 80 in Width, Tab, 60 in Height, and Enter. Or draw it rough and dimension the two sides after.',
      tool('rectangle'),
      ['tool:rectangle', 'tool:select', 'tool:dimension'],
      (s) =>
        s.sketches().some(
          (k) =>
            (k.entities || []).length >= 4 &&
            (k.constraints || []).filter((c) => c.type === 'distance' || c.type === 'length').length >= 2
        ),
      { play: useTool('rectangle', [[-40, -30], [40, 30]]) }
    ),
    step(
      'Finish the sketch.',
      cmd('finishSketch'),
      'finishSketch',
      (s) => !s.sketching && Object.keys(s.doc.sketches || {}).length >= 1,
      { play: done() }
    ),
    step(
      'Extrude it 6 mm. Press Extrude, click inside the rectangle to take the profile, type 6 for the distance and press OK. That is the base of the bracket.',
      cmd('extrude'),
      ['extrude', 'extrude:distance'],
      made('extrude'),
      { check: all(noErrors(), bodies(1), grewBy(20000, 40000)) }
    ),
    step(
      'Put a sketch on the top face of what you just made. Click the face, then Create Sketch.',
      cmd('newSketch'),
      'newSketch',
      madeN('sketch', 2)
    ),
    step(
      'Draw a circle 10 mm across in the middle of the face. Take the circle tool, move to the middle of the face until the dot says Middle of face, click, type 10 in Diameter, and Enter.',
      inMenu('circle', 'tool:circle'),
      'tool:circle',
      (s) => s.sketches().some((k) => circleInFaceMiddle(s, k, 5))
    ),
    step(
      'Finish the sketch. The circle stays behind as the place the hole goes.',
      cmd('finishSketch'),
      'finishSketch',
      (s) => !s.sketching
    ),
    step(
      'Now Hole. It reads the circle: From sketch says which sketch, Places says how many holes it found, and the diameter comes from the circle itself. Press OK.',
      cmd('hole'),
      ['hole', 'hole:simple'],
      (s) => s.features('hole').some((f) => parseFloat(f.diameter) === 10),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'Round the outside vertical corners: the four upright edges, lit up on the model. Press Fillet, click each one, type 5 in the box by the cursor, then OK.',
      cmd('fillet'),
      ['fillet', 'fillet:constant'],
      made('fillet'),
      { check: all(noErrors(), shrankBy(1, 4000)), show: uprightEdges }
    ),
    step(
      'Break the edges round the top, lit up on the model, so the part is not sharp to hold. Press Chamfer, click them, type 1 in the box by the cursor, then OK.',
      cmd('chamfer'),
      ['chamfer', 'chamfer:equal'],
      made('chamfer'),
      { check: all(noErrors(), shrankBy(0.1, 2000)), show: topEdges }
    ),
    step(
      'Push the top face up 4 mm. Press Press Pull, click the top face, which is lit up, then drag the arrow or type 4 for the offset and press OK.',
      cmd('pressPull'),
      'pressPull',
      made('offsetFace'),
      { check: all(noErrors(), changed()), show: topFace }
    ),
    step(
      'Measure something. Click a corner, the middle of an edge or the centre of the hole, then a second one: it gives the distance and the gap along each axis. A face or an edge on its own reports its area or its length.',
      cmd('measure'),
      'measure',
      ran('measure')
    ),
    step(
      'Make it aluminium. Open MODIFY, press Physical Material, leave Apply to on the body, choose Aluminium and press OK. Material is what it is made of, which is where its mass comes from; the part takes the metal\u2019s colour to show it.',
      cmd('physicalMaterial'),
      'physicalMaterial',
      (s) => !!s.doc.materials
    ),
    step(
      'Add a plane floating above the part: click the top face, then CONSTRUCT and Planes, Axes, Points. Kind stays Offset Plane, From plane is the face you picked, type 10 for the distance and press OK. The next chapter sketches on one of these.',
      cmd('construct'),
      ['construct', 'offsetPlane'],
      (s) => (s.doc.construction || []).length > 0 || s.ranAny(['construct', 'offsetPlane'])
    ),
    step(
      'Turn one of the sketch lines into construction geometry. It stops closing the profile and starts being a guide.',
      cmd('construction'),
      'construction',
      ran('construction')
    ),
    step(
      'And mark a centreline. It is construction plus a claim: this is the line the part is about.',
      cmd('centerline'),
      'centerline',
      ran('centerline')
    ),
    step(
      'Trim a spare line out of a sketch. Open one, reach for Trim, click what should not be there.',
      tool('trim'),
      'tool:trim',
      ran('tool:trim')
    ),
    step(
      'Extend one to meet another.',
      tool('extend'),
      'tool:extend',
      ran('tool:extend')
    ),
    step(
      'Offset a curve to sit beside itself at a fixed distance.',
      tool('offset'),
      'tool:offset',
      ran('tool:offset')
    ),
    step(
      'Round a sketch corner with the sketch fillet, which is a different thing from the solid one.',
      tool('fillet'),
      'tool:fillet',
      ran('tool:fillet')
    ),
    step(
      'And the sketch chamfer.',
      tool('chamfer'),
      'tool:chamfer',
      ran('tool:chamfer')
    ),
    step(
      'Break a curve in two.',
      tool('breakCurve'),
      'tool:breakCurve',
      ran('tool:breakCurve')
    ),
    step(
      'Drop a sketch point. Holes and patterns are placed by them.',
      tool('point'),
      'tool:point',
      ran('tool:point')
    ),
    step(
      'Draw a line, then a centre rectangle, then a three point rectangle. Three ways of saying the same shape.',
      tool('line'),
      ['tool:line', 'tool:centerRectangle', 'tool:rectangle3'],
      ran('tool:line'),
      { needs: ['tool:line', 'tool:centerRectangle', 'tool:rectangle3'] }
    ),
    step(
      'Two point circle, three point circle, then the two tangent and three tangent ones.',
      inMenu('circle', 'tool:circleDia'),
      ['tool:circleDia', 'tool:circle3', 'tool:circleTan2', 'tool:circleTan3'],
      ran('tool:circleDia'),
      { needs: ['tool:circleDia', 'tool:circle3', 'tool:circleTan2', 'tool:circleTan3'] }
    ),
    step(
      'Now the arcs: centre point, three point, and the tangent arc that carries on from a line.',
      inMenu('arc', 'tool:arc'),
      ['tool:arc', 'tool:arc3', 'tool:tangentArc'],
      ran('tool:arc'),
      { needs: ['tool:arc', 'tool:arc3', 'tool:tangentArc'] }
    ),
    step(
      'Horizontal and vertical. The two constraints you will use more than all the others together.',
      con('horizontal'),
      ['con:horizontal', 'con:vertical'],
      ran('con:horizontal'),
      { needs: ['con:horizontal', 'con:vertical'] }
    ),
    step(
      'Parallel and perpendicular, on two lines that are neither.',
      con('parallel'),
      ['con:parallel', 'con:perpendicular'],
      ran('con:parallel'),
      { needs: ['con:parallel', 'con:perpendicular'] }
    ),
    step(
      'Tangent, between a line and an arc.',
      con('tangent'),
      'con:tangent',
      ran('con:tangent')
    ),
    step(
      'Equal, on two lines that should stay the same length as each other.',
      con('equal'),
      'con:equal',
      ran('con:equal')
    ),
    step(
      'Concentric, on two circles that share a centre.',
      con('concentric'),
      'con:concentric',
      ran('con:concentric')
    ),
    step(
      'Coincident, to weld two points together.',
      con('coincident'),
      'con:coincident',
      ran('con:coincident')
    ),
    step(
      'Collinear, on two lines that should lie along one line.',
      con('collinear'),
      'con:collinear',
      ran('con:collinear')
    ),
    step(
      'Midpoint, to pin a point to the middle of a line.',
      con('midpoint'),
      'con:midpoint',
      ran('con:midpoint')
    ),
    step(
      'Symmetric, about a centreline. This is the one that makes a part stay symmetrical when a dimension moves.',
      con('symmetric'),
      'con:symmetric',
      ran('con:symmetric')
    ),
    step(
      'And Fix, which nails something where it is. Use it sparingly: a fixed sketch cannot be driven by a parameter.',
      con('fix'),
      'con:fix',
      ran('con:fix')
    ),
    step(
      'Look straight at the sketch plane.',
      cmd('lookAt'),
      'lookAt',
      ran('lookAt')
    ),
    step(
      'Suppress a feature in the timeline, then put it back. It stays in the history and stops happening.',
      cmd('suppress'),
      'suppress',
      ran('suppress')
    ),
    step(
      'Delete a feature you do not want. Not the body it made: the feature that made it.',
      cmd('deleteFeature'),
      'deleteFeature',
      ran('deleteFeature')
    ),
    step(
      'Export it as an STL. That is a bracket, finished.',
      cmd('exportStl'),
      'exportStl',
      ran('exportStl')
    )
  ]
};
