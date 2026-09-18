/**
 * Chapter 3. An enclosure.
 *
 * A box with a lid that has to fit it. Two parts that answer to each other is
 * where bodies, components and joints stop being three words for one thing:
 * a body is a shape, a component is a thing with a name and a place, and a
 * joint is the promise that two of them stay together.
 */

import { cmd, inMenu, step, made, madeN, ran, all, changed, noErrors, bodies } from './kit.js';

export default {
  id: 'enclosure',
  title: 'Enclosure',
  blurb: 'Two parts that have to fit each other, and the joints that hold them.',
  steps: [
    step(
      'Start with a box. 80 by 60 by 40.',
      inMenu('primitive', 'primBox'),
      ['primBox', 'primitive:box'],
      made('primitive'),
      { tab: 'solid', check: all(noErrors(), bodies(1)) }
    ),
    step(
      'Hollow it out. Shell, 2 mm, open at the top.',
      cmd('shell'),
      ['shell', 'shell:faces'],
      made('shell'),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'Now the other four primitives, off to one side. Cylinder, sphere, torus and pipe.',
      inMenu('primitive', 'primCyl'),
      ['primCyl', 'primSphere', 'primTorus', 'primPipe'],
      (s) => s.features('primitive').length >= 5
    ),
    step(
      'Combine two of them. Join, then try cut and intersect on the others.',
      cmd('combine'),
      ['combine', 'combine:join', 'combine:cut', 'combine:intersect'],
      made('combine'),
      { check: noErrors() }
    ),
    step(
      'Move a body somewhere useful.',
      cmd('move'),
      'move',
      made('move'),
      { check: noErrors() }
    ),
    step(
      'Scale one.',
      cmd('scale'),
      'scale',
      made('scale'),
      { check: noErrors() }
    ),
    step(
      'Align two bodies by a face each.',
      cmd('align'),
      'align',
      made('align'),
      { check: noErrors() }
    ),
    step(
      'Split the box in two at a plane. That is the lid.',
      inMenu('split', 'splitBody'),
      'splitBody',
      made('split'),
      { check: all(noErrors(), (s) => s.bodyCount() >= 2 || 'splitting should have left more bodies than it started with') }
    ),
    step(
      'Split a face rather than a body, which cuts the surface and leaves the shape alone.',
      inMenu('split', 'splitFace'),
      'splitFace',
      made('splitFace'),
      { check: noErrors() }
    ),
    step(
      'And split faces at a silhouette, which works on a curve no plane could cut.',
      inMenu('split', 'silhouetteSplit'),
      'silhouetteSplit',
      made('silhouetteSplit'),
      { check: noErrors() }
    ),
    step(
      'Offset a face on its own, without the arrow.',
      cmd('offsetFace'),
      'offsetFace',
      made('offsetFace'),
      { check: noErrors() }
    ),
    step(
      'Delete a face and let the shape heal over the hole.',
      cmd('deleteFace'),
      'deleteFace',
      made('deleteFace'),
      { check: noErrors() }
    ),
    step(
      'Replace a face with another surface.',
      cmd('replaceFace'),
      'replaceFace',
      made('replaceFace'),
      { check: noErrors() }
    ),
    step(
      'Fill a closed boundary between surfaces.',
      cmd('boundaryFill'),
      'boundaryFill',
      made('boundaryFill'),
      { check: noErrors() }
    ),
    step(
      'Delete a body you no longer want. It removes the feature that made it, because a body is an output.',
      cmd('deleteBody'),
      'deleteBody',
      ran('deleteBody')
    ),
    step(
      'Make the lid a component of its own.',
      cmd('newComponent'),
      'newComponent',
      (s) => (s.doc.components || []).length > 0
    ),
    step(
      'Ground it to its parent so it stops drifting.',
      cmd('groundToParent'),
      'groundToParent',
      ran('groundToParent')
    ),
    step(
      'Joint the lid to the box. A revolute joint, so it opens.',
      cmd('newJoint'),
      ['newJoint', 'newJoint:revolute'],
      (s) => (s.doc.joints || []).length > 0
    ),
    step(
      'Make an as built joint, which takes the parts where they already are.',
      cmd('asBuiltJoint'),
      'asBuiltJoint',
      ran('asBuiltJoint')
    ),
    step(
      'Place a joint origin, for the next one to aim at.',
      cmd('jointOrigin'),
      'jointOrigin',
      ran('jointOrigin')
    ),
    step(
      'Constrain two components to each other.',
      cmd('constrainComponents'),
      'constrainComponents',
      ran('constrainComponents')
    ),
    step(
      'Rigid group a few of them so they move as one.',
      cmd('rigidGroup'),
      'rigidGroup',
      ran('rigidGroup')
    ),
    step(
      'Link the motion of two joints.',
      cmd('motionLink'),
      'motionLink',
      ran('motionLink')
    ),
    step(
      'Drive the joints and watch the lid open.',
      cmd('driveJoints'),
      'driveJoints',
      ran('driveJoints')
    ),
    step(
      'Duplicate the component with its joints intact.',
      cmd('duplicateComponent'),
      'duplicateComponent',
      ran('duplicateComponent')
    ),
    step(
      'Check nothing shares space with anything else.',
      cmd('interference'),
      'interference',
      ran('interference')
    ),
    step(
      'Cut a section through the assembly to see inside it.',
      cmd('sectionAnalysis'),
      'sectionAnalysis',
      ran('sectionAnalysis')
    ),
    step(
      'Isolate one body, then show everything again.',
      cmd('isolate'),
      ['isolate', 'unisolate', 'hideSelected', 'showAll'],
      (s) => s.ranAny(['isolate', 'unisolate', 'hideSelected', 'showAll']),
      { needs: ['isolate',  ['unisolate', 'showAll']] }
    ),
    step(
      'Bring in another design as a component.',
      cmd('insertComponent'),
      'insertComponent',
      ran('insertComponent')
    ),
    step(
      'Derive one instead, which keeps a link back to where it came from.',
      cmd('insertDerive'),
      ['insertDerive', 'refreshDerived', 'editInPlace', 'breakLink'],
      (s) => s.ranAny(['insertDerive', 'refreshDerived', 'editInPlace', 'breakLink'])
    ),
    step(
      'Point the library somewhere, and search it.',
      cmd('chooseLibrary'),
      ['chooseLibrary', 'searchLibrary'],
      (s) => s.ranAny(['chooseLibrary', 'searchLibrary']),
      { needs: ['chooseLibrary', 'searchLibrary'] }
    ),
    step(
      'Add a profile, switch to it, give it a picture and take the picture off again.',
      cmd('addProfile'),
      ['addProfile', 'switchProfile', 'profilePicture', 'clearProfilePicture'],
      (s) => s.ranAny(['addProfile', 'switchProfile', 'profilePicture', 'clearProfilePicture'])
    )
  ]
};
