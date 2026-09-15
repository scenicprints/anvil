/**
 * Chapter 7. A part somebody scanned.
 *
 * A mesh arrives broken, because they all do: holes where the scanner could not
 * see, a million triangles for a shape with six faces, and no faces at all as
 * far as the program is concerned. This chapter takes one from that to
 * something you can model on, which is the order the tools are in.
 */

import { cmd, inMenu, step, made, ran, all, changed, noErrors } from './kit.js';

export default {
  id: 'scanned',
  title: 'A part somebody scanned',
  blurb: 'A broken mesh, repaired, grouped and turned into a solid.',
  steps: [
    step(
      'Bring in a mesh. Any STL or OBJ will do; a scan is better, because a scan is broken.',
      inMenu('insertParts', 'insertMesh'),
      'insertMesh',
      made('insertMesh'),
      { tab: 'mesh' }
    ),
    step(
      'Look at what is wrong with it before touching anything. Validate says how many holes.',
      cmd('validate'),
      'validate',
      ran('validate')
    ),
    step(
      'Repair it.',
      cmd('meshRepair'),
      'meshRepair',
      made('meshRepair'),
      { check: noErrors() }
    ),
    step(
      'Stitch the open edges that are left.',
      cmd('meshStitch'),
      'meshStitch',
      made('meshStitch'),
      { check: noErrors() }
    ),
    step(
      'Patch the holes that stitching could not close.',
      cmd('meshPatch'),
      'meshPatch',
      made('meshPatch'),
      { check: noErrors() }
    ),
    step(
      'Reverse the normals if it is inside out.',
      cmd('meshReverse'),
      'meshReverse',
      made('meshReverse'),
      { check: noErrors() }
    ),
    step(
      'Scale it to the size it should have been. Scans arrive in the wrong units more often than not.',
      cmd('meshScale'),
      'meshScale',
      made('meshScale'),
      { check: noErrors() }
    ),
    step(
      'Align it to the origin so the planes mean something.',
      cmd('meshAlign'),
      'meshAlign',
      made('meshAlign'),
      { check: noErrors() }
    ),
    step(
      'Reduce the triangle count. A million triangles for six faces is a million triangles wasted.',
      cmd('meshReduce'),
      ['meshReduce', 'meshReduce:ratio'],
      made('meshReduce'),
      { check: noErrors() }
    ),
    step(
      'Remesh it evenly.',
      cmd('meshRemesh'),
      'meshRemesh',
      made('meshRemesh'),
      { check: noErrors() }
    ),
    step(
      'Smooth the noise out of it.',
      cmd('meshSmooth'),
      'meshSmooth',
      made('meshSmooth'),
      { check: noErrors() }
    ),
    step(
      'Cut it with a plane.',
      cmd('meshPlaneCut'),
      'meshPlaneCut',
      made('meshPlaneCut'),
      { check: noErrors() }
    ),
    step(
      'Shell it.',
      cmd('meshShell'),
      'meshShell',
      made('meshShell'),
      { check: noErrors() }
    ),
    step(
      'Erase a patch you do not want.',
      cmd('meshErase'),
      'meshErase',
      made('meshErase'),
      { check: noErrors() }
    ),
    step(
      'Separate the shells into bodies of their own, then merge two back together.',
      cmd('meshSeparate'),
      ['meshSeparate', 'meshMerge'],
      (s) => s.has('meshSeparate') || s.has('meshMerge'),
      { check: noErrors() }
    ),
    step(
      'Move vertices directly, which is the only editing a mesh really has.',
      cmd('meshDirectEdit'),
      'meshDirectEdit',
      made('meshDirectEdit'),
      { check: noErrors() }
    ),
    step(
      'Generate face groups. Without them every triangle is its own face and nothing can be pointed at.',
      inMenu('faceGroups', 'faceGroups'),
      'faceGroups',
      made('faceGroups'),
      { check: noErrors() }
    ),
    step(
      'Set the palette angle, and see how much of the shape one click takes.',
      cmd('meshPalette'),
      'meshPalette',
      ran('meshPalette')
    ),
    step(
      'Pin a group by hand where the angle got it wrong, combine two, and release them back to the angle.',
      inMenu('faceGroups', 'createFaceGroup'),
      ['createFaceGroup', 'combineFaceGroups', 'releaseFaceGroups', 'faceGroupEdit'],
      (s) => s.has('faceGroupEdit') || s.ranAny(['createFaceGroup', 'combineFaceGroups', 'releaseFaceGroups'])
    ),
    step(
      'Read the shape back: Recognise finds the holes and the flats.',
      cmd('recognise'),
      'recognise',
      ran('recognise')
    ),
    step(
      'Take a section through the mesh into a sketch.',
      cmd('meshSection'),
      'meshSection',
      ran('meshSection'),
      { tab: 'sketch' }
    ),
    step(
      'Push a texture into it the old way, down one plane, which is still the right tool on a scan.',
      cmd('textureExtrude'),
      'textureExtrude',
      made('textureExtrude'),
      { tab: 'mesh', check: noErrors() }
    ),
    step(
      'Tessellate a solid into a mesh, which is the same road in the other direction.',
      cmd('tessellate'),
      'tessellate',
      made('tessellate'),
      { check: noErrors() }
    ),
    step(
      'And convert the mesh to a solid. Now it can be filleted, cut and weighed like anything else.',
      cmd('convertMesh'),
      'convertMesh',
      made('convertMesh'),
      { check: all(noErrors(), changed()) }
    )
  ]
};
