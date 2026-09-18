/**
 * Chapter 5. A bottle.
 *
 * A shape too soft for extrude and revolve, which is what surfaces are for. A
 * surface has no inside, so nothing here can be cut or weighed until the last
 * step turns the lot into a solid, and that is the whole lesson: surfaces are
 * scaffolding you throw away.
 */

import { cmd, inMenu, tool, step, made, ran, all, changed, noErrors } from './kit.js';

export default {
  id: 'bottle',
  title: 'Bottle',
  blurb: 'Curves that are not arcs, and the surfaces they build.',
  steps: [
    step(
      'Sketch the profile with a fit point spline. Click through the shape, do not aim.',
      inMenu('spline', 'tool:spline'),
      ['tool:spline', 'tool:splineCP'],
      (s) => s.ranAny(['tool:spline', 'tool:splineCP']),
      { tab: 'sketch' }
    ),
    step(
      'Draw a conic curve, and set rho. Below a half it is an ellipse, above it a hyperbola.',
      inMenu('spline', 'tool:conic'),
      'tool:conic',
      ran('tool:conic')
    ),
    step(
      'Blend two curves together, position first and then tangent.',
      inMenu('spline', 'tool:blendCurve'),
      ['tool:blendCurve', 'tool:blendCurveG1'],
      (s) => s.ranAny(['tool:blendCurve', 'tool:blendCurveG1']),
      { needs: ['tool:blendCurve', 'tool:blendCurveG1'] }
    ),
    step(
      'Sweep a profile along a path to make the body of it.',
      cmd('sweep'),
      ['sweep', 'sweep:path'],
      made('sweep'),
      { tab: 'solid', check: all(noErrors(), changed()) }
    ),
    step(
      'Loft between two profiles for the shoulder.',
      cmd('loft'),
      ['loft', 'loft:free'],
      made('loft'),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'Thicken an open curve into a wall with Rib.',
      cmd('rib'),
      'rib',
      made('rib'),
      { check: noErrors() }
    ),
    step(
      'And Web, which is the same idea for several curves at once.',
      cmd('web'),
      'web',
      made('web'),
      { check: noErrors() }
    ),
    step(
      'Emboss a label into the side. Raised or sunk, from a sketch on the face.',
      cmd('emboss'),
      ['emboss', 'emboss:emboss', 'emboss:deboss'],
      made('emboss'),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'Full round the rim: a fillet that runs right across between two faces.',
      cmd('fullRound'),
      'fullRound',
      made('fullRound'),
      { check: noErrors() }
    ),
    step(
      'Now the surface tab. Extrude a curve into a surface rather than a solid.',
      cmd('surfaceExtrude'),
      'surfaceExtrude',
      made('surfaceExtrude'),
      { tab: 'surface', check: noErrors() }
    ),
    step(
      'Revolve one.',
      cmd('surfaceRevolve'),
      'surfaceRevolve',
      made('surfaceRevolve'),
      { check: noErrors() }
    ),
    step(
      'Sweep one.',
      cmd('surfaceSweep'),
      'surfaceSweep',
      made('surfaceSweep'),
      { check: noErrors() }
    ),
    step(
      'Loft between two.',
      cmd('surfaceLoft'),
      'surfaceLoft',
      made('surfaceLoft'),
      { check: noErrors() }
    ),
    step(
      'Patch a hole in a surface.',
      cmd('patch'),
      'patch',
      made('patch'),
      { check: noErrors() }
    ),
    step(
      'Build a ruled surface off an edge.',
      cmd('ruled'),
      'ruled',
      made('ruled'),
      { check: noErrors() }
    ),
    step(
      'Offset a surface to sit beside itself.',
      cmd('offsetSurface'),
      'offsetSurface',
      made('offsetSurface'),
      { check: noErrors() }
    ),
    step(
      'Trim a surface with another one, then untrim it to get the piece back.',
      cmd('trimSurface'),
      ['trimSurface', 'untrimSurface'],
      (s) => s.has('trimSurface') || s.has('untrimSurface'),
      { check: noErrors(), needs: ['trimSurface', 'untrimSurface'] }
    ),
    step(
      'Extend a surface to reach something.',
      cmd('extendSurface'),
      'extendSurface',
      made('extendSurface'),
      { check: noErrors() }
    ),
    step(
      'Merge two surfaces into one.',
      cmd('mergeSurface'),
      'mergeSurface',
      made('mergeSurface'),
      { check: noErrors() }
    ),
    step(
      'Stitch them into something closed, then unstitch it again.',
      cmd('stitch'),
      ['stitch', 'unstitch'],
      (s) => s.has('stitch') || s.has('unstitch'),
      { check: noErrors(), needs: ['stitch', 'unstitch'] }
    ),
    step(
      'Reverse a normal so the surface faces the way you meant.',
      cmd('reverseNormal'),
      'reverseNormal',
      made('reverseNormal'),
      { check: noErrors() }
    ),
    step(
      'Thicken the lot into a solid. That is the scaffolding thrown away.',
      cmd('thicken'),
      'thicken',
      made('thicken'),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'Back in a sketch: project an edge of the solid, linked, then as a copy.',
      cmd('project'),
      ['project', 'projectCopy'],
      (s) => s.ranAny(['project', 'projectCopy']),
      { tab: 'sketch', needs: ['project', 'projectCopy'] }
    ),
    step(
      'Take an intersection of the body with the sketch plane.',
      cmd('intersect'),
      'intersect',
      ran('intersect')
    ),
    step(
      'Include a 3D edge, and take the curve where two surfaces cross.',
      cmd('include3D'),
      ['include3D', 'intersectionCurve'],
      (s) => s.ranAny(['include3D', 'intersectionCurve']),
      { needs: ['include3D', 'intersectionCurve'] }
    ),
    step(
      'Project a sketch onto a curved surface rather than through it.',
      cmd('projectToSurface'),
      'projectToSurface',
      ran('projectToSurface')
    ),
    step(
      'Pull an isocurve off a surface.',
      cmd('isoCurve'),
      'isoCurve',
      ran('isoCurve')
    ),
    step(
      'Bring in artwork: an SVG, then a DXF.',
      inMenu('insert', 'insertSvg'),
      ['insertSvg', 'insertDxf'],
      (s) => s.ranAny(['insertSvg', 'insertDxf']),
      { needs: ['insertSvg', 'insertDxf'] }
    )
  ]
};
