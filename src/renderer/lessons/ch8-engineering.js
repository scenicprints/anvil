/**
 * Chapter 8. The engineering pass.
 *
 * No new shape. Taking a part that is already built and asking whether it is
 * any good, which is the half of CAD nobody teaches and the half that decides
 * whether the thing works.
 *
 * The selection rules live here rather than in chapter 1 on purpose. They are
 * the tools you reach for on a part with four hundred faces, and you have to
 * have met such a part before they mean anything.
 */

import { cmd, inMenu, step, made, ran, all, noErrors } from './kit.js';

export default {
  id: 'engineering',
  title: 'The engineering pass',
  blurb: 'Is it any good? Analyses, selection rules and the tools that answer.',
  steps: [
    step(
      'Open something with a few dozen faces. The bracket will do. Then pick a face and grow the selection a ring.',
      cmd('selectGrow'),
      ['selectGrow', 'selectShrink'],
      (s) => s.ranAny(['selectGrow', 'selectShrink']),
      { tab: 'solid' }
    ),
    step(
      'Select everything like the one you picked. On a drilled plate that is every hole of that size.',
      cmd('selectSimilar'),
      'selectSimilar',
      ran('selectSimilar')
    ),
    step(
      'Seed and boundary: pick one face of a pocket and the rim round it, and take the whole pocket.',
      cmd('selectSeedBoundary'),
      'selectSeedBoundary',
      ran('selectSeedBoundary')
    ),
    step(
      'Tangent chain, which walks along edges that carry on from each other.',
      cmd('selectTangent'),
      'selectTangent',
      ran('selectTangent')
    ),
    step(
      'By size, which is how an imported model gets its slivers dealt with in one go.',
      cmd('selectBySize'),
      ['selectBySize', 'selectByName'],
      (s) => s.ranAny(['selectBySize', 'selectByName'])
    ),
    step(
      'Invert it, and take every outside edge at once.',
      cmd('selectInvert'),
      ['selectInvert', 'selectAllEdges'],
      (s) => s.ranAny(['selectInvert', 'selectAllEdges'])
    ),
    step(
      'Save that selection so you can come back to it.',
      cmd('createSelectionSet'),
      'createSelectionSet',
      ran('createSelectionSet')
    ),
    step(
      'Now narrow what a click can land on. Faces only, then edges, bodies, components and sketch geometry, then back to anything.',
      inMenu('selectPriority', 'priorityFace'),
      ['priorityFace', 'priorityEdge', 'priorityBody', 'priorityComponent', 'prioritySketch', 'priorityAuto'],
      (s) => s.ranAny(['priorityFace', 'priorityEdge', 'priorityBody', 'priorityComponent', 'prioritySketch'])
    ),
    step(
      'Weigh it. Centre of mass, with the material it is actually made of.',
      cmd('centreOfMass'),
      'centreOfMass',
      ran('centreOfMass')
    ),
    step(
      'Colour it by how it lies against a pull direction. Green comes out of the mould, red does not.',
      inMenu('inspect', 'draftAnalysis'),
      'draftAnalysis',
      ran('draftAnalysis')
    ),
    step(
      'Curvature map: cool where it is flat, warm where it is tight.',
      inMenu('inspect', 'curvatureMap'),
      ['curvatureMap', 'curvatureComb'],
      (s) => s.ranAny(['curvatureMap', 'curvatureComb'])
    ),
    step(
      'Minimum radius, against the smallest cutter or nozzle you have.',
      inMenu('inspect', 'minimumRadius'),
      'minimumRadius',
      ran('minimumRadius')
    ),
    step(
      'Zebra stripes, which is how a surface is read for continuity by eye.',
      inMenu('inspect', 'zebraAnalysis'),
      ['zebraAnalysis', 'surfaceContinuity'],
      (s) => s.ranAny(['zebraAnalysis', 'surfaceContinuity'])
    ),
    step(
      'Isocurves, and an environment map to read reflections off it.',
      inMenu('inspect', 'isocurveAnalysis'),
      ['isocurveAnalysis', 'environmentMap'],
      (s) => s.ranAny(['isocurveAnalysis', 'environmentMap'])
    ),
    step(
      'Accessibility: can a tool reach it at all.',
      inMenu('inspect', 'accessibility'),
      'accessibility',
      ran('accessibility')
    ),
    step(
      'Design Advice, which reads the whole part and says what will go wrong in the print.',
      cmd('designAdvice'),
      'designAdvice',
      ran('designAdvice')
    ),
    step(
      'Take a spun profile off it.',
      cmd('spunProfile'),
      'spunProfile',
      ran('spunProfile'),
      { tab: 'sketch' }
    ),
    step(
      'Colour by component, then by feature, then clear the analysis and get the real colours back.',
      cmd('colourByComponent'),
      ['colourByComponent', 'colourByFeature', 'clearAnalysis'],
      (s) => s.ranAny(['colourByComponent', 'colourByFeature', 'clearAnalysis']),
      { tab: 'solid' }
    ),
    step(
      'Now the plastic features. A boss to take a screw.',
      inMenu('plastic', 'boss'),
      'boss',
      made('boss'),
      { check: noErrors() }
    ),
    step(
      'A rest, a snap fit and a lip.',
      inMenu('plastic', 'rest'),
      ['rest', 'snapFit', 'lip'],
      (s) => s.has('rest') || s.has('snapFit') || s.has('lip'),
      { check: noErrors() }
    ),
    step(
      'Run a simulation. Load a face, fix another, and see where it is worst.',
      cmd('simulate'),
      'simulate',
      ran('simulate')
    ),
    step(
      'Clear the stress colours.',
      cmd('clearStress'),
      'clearStress',
      ran('clearStress')
    ),
    step(
      'Generative design: say what has to stay and what it has to carry, and let it find the shape.',
      cmd('generative'),
      'generative',
      ran('generative')
    ),
    step(
      'Set up configurations, so one document holds the small one and the large one.',
      cmd('configurations'),
      'configurations',
      (s) => s.ran('configurations') || !!s.doc.configurations
    ),
    step(
      'Turn history off and see what it costs you. Then undo, because it is not a thing to leave off by accident.',
      cmd('toggleHistory'),
      'toggleHistory',
      ran('toggleHistory')
    ),
    step(
      'Throw the rebuild cache away and build the lot again. This is how "have I confused it" gets answered.',
      cmd('computeAll'),
      'computeAll',
      ran('computeAll')
    )
  ]
};
