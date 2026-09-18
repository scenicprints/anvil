/**
 * Chapter 7. A part somebody scanned.
 *
 * A mesh arrives broken, because they all do: holes where the scanner could not
 * see, a million triangles for a shape with six faces, and no faces at all as
 * far as the program is concerned. This chapter takes one from that to
 * something you can model on, which is the order the tools are in.
 */

import { cmd, inMenu, step, made, ran, all, changed, noErrors } from './kit.js';

/**
 * A scan, near enough: a sphere of triangles with some of them missing.
 *
 * Built rather than shipped as a file, so the chapter has something to repair
 * on any machine and the holes are in known places. Dropping triangles is what
 * a scanner does when it cannot see a surface, and it is the fault every one of
 * the tools below exists to deal with.
 */
function brokenScan(rings = 14, segments = 20) {
  const verts = [];
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j < segments; j++) {
      const theta = (j / segments) * Math.PI * 2;
      verts.push(
        20 * Math.sin(phi) * Math.cos(theta),
        20 * Math.sin(phi) * Math.sin(theta),
        20 * Math.cos(phi)
      );
    }
  }
  const at = (i, j) => i * segments + (j % segments);
  const tris = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      // The holes. Three patches the scanner never saw, in places you have to
      // turn the part round to find, which is also true of the real thing.
      const missing =
        (i === 4 && j > 3 && j < 8) ||
        (i === 9 && j > 12 && j < 15) ||
        (i === 2 && j === 17);
      if (missing) continue;
      tris.push(a, b, c);
      tris.push(a, c, d);
    }
  }
  return { verts, tris };
}

export default {
  id: 'scanned',
  start() {
    return {
      meshData: { lessonScan: brokenScan() },
      features: [
        {
          id: 'lesson-scan',
          type: 'insertMesh',
          data: 'lessonScan',
          label: 'Scan',
          scale: '1',
          at: [0, 0, 0]
        }
      ]
    };
  },
  title: 'A part somebody scanned',
  blurb: 'A broken mesh, repaired, grouped and turned into a solid.',
  steps: [
    step(
      'A scan is already here, holes and all. Insert Mesh is how one of your own gets in.',
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
      { check: noErrors(), needs: ['meshSeparate', 'meshMerge'] }
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
      (s) => s.has('faceGroupEdit') || s.ranAny(['createFaceGroup', 'combineFaceGroups', 'releaseFaceGroups']),
      { needs: ['createFaceGroup', 'combineFaceGroups', 'releaseFaceGroups'] }
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
