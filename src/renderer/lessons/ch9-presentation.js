/**
 * Chapter 9. Presentation and housekeeping.
 *
 * Making it look like something, and the handful of tools that belong to the
 * application rather than to the model. The shortest chapter, and the one where
 * everything is reversible, which is a decent place to end.
 */

import { cmd, inMenu, step, ran } from './kit.js';

export default {
  id: 'presentation',
  title: 'Presentation and housekeeping',
  blurb: 'Making it look like something, and the tools that belong to the program.',
  steps: [
    step(
      'Colour it. A face, then a whole body. Colour is what it looks like, not what it is made of.',
      cmd('appearance'),
      ['appearance', 'appearance:faces', 'appearance:bodies'],
      (s) => !!s.doc.appearance?.byBody || !!s.doc.appearance?.faces?.length,
      { tab: 'solid' }
    ),
    step(
      'Wrap a picture over the whole part, by the same three axis reading a texture uses.',
      cmd('wrapImage'),
      'wrapImage',
      ran('wrapImage'),
      { tab: 'mesh' }
    ),
    step(
      'Put a decal on one face, which is the same picture placed rather than wrapped.',
      inMenu('insert', 'insertDecal'),
      'insertDecal',
      ran('insertDecal')
    ),
    step(
      'Insert a canvas: a photograph on a plane, to model on top of.',
      inMenu('insert', 'insertCanvas'),
      'insertCanvas',
      ran('insertCanvas')
    ),
    step(
      'Render it properly. Pick a finish and let it run.',
      cmd('render'),
      'render',
      ran('render'),
      { tab: 'solid' }
    ),
    step(
      'Set an environment for it to reflect. A part with nothing to reflect reads as grey plastic.',
      inMenu('inspect', 'environmentMap'),
      'environmentMap',
      ran('environmentMap')
    ),
    step(
      'Animate the assembly coming apart.',
      cmd('animate'),
      'animate',
      ran('animate')
    ),
    step(
      'Fill in the document info: who made it, what it is, what it is for.',
      cmd('documentInfo'),
      'documentInfo',
      (s) => s.ran('documentInfo') || Object.keys(s.doc.info || {}).length > 0
    ),
    step(
      'Add a note to something that needs one.',
      cmd('addNote'),
      'addNote',
      (s) => s.ran('addNote') || (s.doc.notes || []).length > 0
    ),
    step(
      'Name a version, so you can get back to this one by name rather than by date.',
      cmd('namedVersions'),
      'namedVersions',
      (s) => s.ran('namedVersions') || (s.doc.versions || []).length > 0
    ),
    step(
      'Rename the design.',
      cmd('renameDesign'),
      'renameDesign',
      ran('renameDesign')
    ),
    step(
      'Drag the rollback marker back through the timeline and forward again. Start, previous, next, end.',
      cmd('rollbackPrev'),
      ['rollbackStart', 'rollbackPrev', 'rollbackNext', 'rollbackEnd'],
      (s) => s.ranAny(['rollbackStart', 'rollbackPrev', 'rollbackNext', 'rollbackEnd']),
      { tab: 'view' }
    ),
    step(
      'Go home, and switch between perspective and orthographic. Orthographic is the one to model in.',
      cmd('home'),
      ['home', 'toggleProjection'],
      (s) => s.ranAny(['home', 'toggleProjection'])
    )
  ]
};
