/**
 * Chapter 2. A knob.
 *
 * Turned rather than extruded, knurled round its edge, and with a number on
 * the face. The chapter where the timeline starts earning its keep: change the
 * diameter at the end of it and the knurling, the text and the boss all move.
 */

import { cmd, inMenu, tool, step, made, madeN, ran, all, changed, noErrors, bodies } from './kit.js';

export default {
  id: 'knob',
  title: 'Knob',
  blurb: 'Turning, repeating and decorating, on a part that has to stay one part.',
  steps: [
    step(
      'Sketch the half section of a knob on the XZ plane. A closed outline, all on one side of the middle.',
      cmd('newSketch'),
      'newSketch',
      made('sketch'),
      { tab: 'solid' }
    ),
    step(
      'Draw a centreline down the axis. A revolve opened on a sketch with exactly one already turns about it.',
      cmd('centerline'),
      'centerline',
      ran('centerline')
    ),
    step(
      'Revolve it. Full turn.',
      cmd('revolve'),
      ['revolve', 'revolve:full'],
      made('revolve'),
      { check: all(noErrors(), bodies(1), changed()) }
    ),
    step(
      'Draft the outside wall by 2 degrees so it would come out of a mould.',
      cmd('draft'),
      'draft',
      made('draft'),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'Sketch a polygon on the top face. Inscribed, six sides.',
      inMenu('polygon', 'tool:polygon'),
      ['tool:polygon', 'tool:polygonCirc', 'tool:polygonEdge'],
      (s) => s.ranAny(['tool:polygon', 'tool:polygonCirc', 'tool:polygonEdge'])
    ),
    step(
      'Now a slot. Centre to centre first, then look at the other four ways of drawing one.',
      inMenu('slot', 'tool:slot'),
      ['tool:slot', 'tool:slotOverall', 'tool:slotCentre', 'tool:slotArc3', 'tool:slotArcCentre'],
      (s) => s.ranAny(['tool:slot', 'tool:slotOverall', 'tool:slotCentre', 'tool:slotArc3', 'tool:slotArcCentre'])
    ),
    step(
      'And an ellipse: centre, the end of the long axis, then how far the short one goes.',
      tool('ellipse'),
      'tool:ellipse',
      ran('tool:ellipse')
    ),
    step(
      'Put some text on the face.',
      tool('text'),
      'tool:text',
      ran('tool:text')
    ),
    step(
      'Change what it says. Text is a sketch entity, so it is edited rather than redrawn.',
      cmd('editText'),
      'editText',
      ran('editText')
    ),
    step(
      'Move something in the sketch, then copy and paste it.',
      cmd('sketchMove'),
      ['sketchMove', 'sketchCopy', 'sketchPaste'],
      (s) => s.ranAny(['sketchMove', 'sketchCopy', 'sketchPaste'])
    ),
    step(
      'Mirror sketch geometry about the centreline.',
      cmd('mirrorSketch'),
      'mirrorSketch',
      ran('mirrorSketch')
    ),
    step(
      'Scale a piece of the sketch.',
      cmd('sketchScale'),
      'sketchScale',
      ran('sketchScale')
    ),
    step(
      'Pattern inside the sketch: a rectangular grid, then a circular ring.',
      cmd('sketchPatternRect'),
      ['sketchPatternRect', 'sketchPatternCirc'],
      (s) => s.ranAny(['sketchPatternRect', 'sketchPatternCirc'])
    ),
    step(
      'Cut the knurl: a circular pattern of the notch, all the way round.',
      inMenu('pattern', 'patternCirc'),
      ['patternCirc', 'patternCirc:identical'],
      made('patternCircular'),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'A rectangular pattern as well, of something on the top face.',
      inMenu('pattern', 'patternRect'),
      'patternRect',
      made('patternRect'),
      { check: noErrors() }
    ),
    step(
      'Pattern along a path.',
      inMenu('pattern', 'patternPath'),
      'patternPath',
      made('patternPath'),
      { check: noErrors() }
    ),
    step(
      'And pattern a whole feature rather than its result.',
      inMenu('pattern', 'patternFeature'),
      'patternFeature',
      made('patternFeature'),
      { check: noErrors() }
    ),
    step(
      'Mirror the lot about a plane.',
      cmd('mirror'),
      'mirror',
      made('mirror'),
      { check: noErrors() }
    ),
    step(
      'Cut a coil: a section swept along a helix. This is how a spring and a thread are both made.',
      cmd('coil'),
      'coil',
      made('coil'),
      { check: noErrors() }
    ),
    step(
      'Thread the bore. A modelled thread, not a picture of one.',
      cmd('thread'),
      'thread',
      made('thread'),
      { check: noErrors() }
    ),
    step(
      'Make a texture out of a picture, so the grip is a finish rather than geometry you drew.',
      cmd('makeTexture'),
      'makeTexture',
      ran('makeTexture')
    ),
    step(
      'Put it on, on the faces you pick and nowhere else.',
      cmd('textureRelief'),
      ['textureRelief', 'textureRelief:faces'],
      made('textureRelief'),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'Open Parameters and give the diameter a name. Then change it and watch everything downstream move.',
      cmd('parameters'),
      'parameters',
      (s) => s.ran('parameters')
    ),
    step(
      'Send it to print: bed, format, and out.',
      cmd('print3D'),
      'print3D',
      ran('print3D')
    )
  ]
};
