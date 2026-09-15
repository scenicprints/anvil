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
    step(
      'Draw a rough rectangle. Two corners, and do not aim: the size comes later.',
      tool('rectangle'),
      ['tool:rectangle', 'tool:select'],
      (s) => s.sketches().some((k) => (k.entities || []).length >= 4),
      { play: useTool('rectangle', [[-40, -30], [40, 30]]) }
    ),
    step(
      'Now say how big it is. Dimension the long side to 80.',
      tool('dimension'),
      'tool:dimension',
      (s) => s.sketches().some((k) => (k.constraints || []).some((c) => c.type === 'distance' || c.type === 'length'))
    ),
    step(
      'And the short side to 60. Watch the blue go: blue means it can still move.',
      tool('dimension'),
      'tool:dimension',
      (s) => s.sketches().some((k) => (k.constraints || []).filter((c) => c.type === 'distance' || c.type === 'length').length >= 2)
    ),
    step(
      'Finish the sketch.',
      cmd('finishSketch'),
      'finishSketch',
      (s) => !s.doc.sketches || Object.keys(s.doc.sketches).length >= 1,
      { play: done() }
    ),
    step(
      'Extrude it 6 mm. That is the base of the bracket.',
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
      'Draw a circle on it, anywhere sensible.',
      inMenu('circle', 'tool:circle'),
      'tool:circle',
      (s) => s.sketches().some((k) => (k.entities || []).some((e) => e.type === 'circle'))
    ),
    step(
      'Leave the sketch and make it a hole instead: pick the circle and use Hole.',
      cmd('hole'),
      ['hole', 'hole:simple'],
      made('hole'),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'Round the outside vertical corners. Fillet, 5 mm.',
      cmd('fillet'),
      ['fillet', 'fillet:constant'],
      made('fillet'),
      { check: all(noErrors(), shrankBy(1, 4000)) }
    ),
    step(
      'Break the top edges with a chamfer, 1 mm.',
      cmd('chamfer'),
      ['chamfer', 'chamfer:equal'],
      made('chamfer'),
      { check: all(noErrors(), shrankBy(0.1, 2000)) }
    ),
    step(
      'Pick the top face and push it up 4 mm with Press Pull.',
      cmd('pressPull'),
      'pressPull',
      made('offsetFace'),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'Measure something. Any two faces will do; the point is that it is there.',
      cmd('measure'),
      'measure',
      ran('measure')
    ),
    step(
      'Make it aluminium. Material is what it is made of, not what it looks like.',
      cmd('physicalMaterial'),
      'physicalMaterial',
      (s) => !!s.doc.materials
    ),
    step(
      'Add a construction plane offset from the top face. You will need one for the next chapter and this is where they come from.',
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
      ran('tool:line')
    ),
    step(
      'Two point circle, three point circle, then the two tangent and three tangent ones.',
      inMenu('circle', 'tool:circleDia'),
      ['tool:circleDia', 'tool:circle3', 'tool:circleTan2', 'tool:circleTan3'],
      ran('tool:circleDia')
    ),
    step(
      'Now the arcs: centre point, three point, and the tangent arc that carries on from a line.',
      inMenu('arc', 'tool:arc'),
      ['tool:arc', 'tool:arc3', 'tool:tangentArc'],
      ran('tool:arc')
    ),
    step(
      'Horizontal and vertical. The two constraints you will use more than all the others together.',
      con('horizontal'),
      ['con:horizontal', 'con:vertical'],
      ran('con:horizontal')
    ),
    step(
      'Parallel and perpendicular, on two lines that are neither.',
      con('parallel'),
      ['con:parallel', 'con:perpendicular'],
      ran('con:parallel')
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
