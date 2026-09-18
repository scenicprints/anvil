/**
 * Chapter 6. A handle.
 *
 * Form is a fifth of this program and none of it means anything outside Form,
 * so this is unavoidably the long chapter. It is also the one that teaches the
 * least transferable thing and the most useful one: a cage is not the shape, it
 * is what the shape is pulled towards, and everything here is a way of moving
 * the cage.
 */

import { cmd, inMenu, step, made, ran, all, changed, noErrors } from './kit.js';

/** Form tools leave no feature of their own until the form is finished. */
const shaped = (id) => (s) => s.ran(id);

export default {
  id: 'handle',
  title: 'Handle',
  blurb: 'A grip shaped by pushing a cage about. The whole of the Form tab.',
  steps: [
    step(
      'Start a form with a box. Everything in this tab happens inside one.',
      inMenu('formCreate', 'formBox'),
      'formBox',
      made('form'),
      { tab: 'form' }
    ),
    step(
      'The other five starting shapes: plane, cylinder, sphere, torus and quadball.',
      inMenu('formCreate', 'formPlane'),
      ['formPlane', 'formCylinder', 'formSphere', 'formTorus', 'formQuadball'],
      (s) => s.ranAny(['formPlane', 'formCylinder', 'formSphere', 'formTorus', 'formQuadball']),
      { needs: ['formPlane', 'formCylinder', 'formSphere', 'formTorus', 'formQuadball'] }
    ),
    step(
      'And the five built from curves: extrude, revolve, sweep, loft and pipe.',
      inMenu('formCreate', 'formExtrudeCurve'),
      ['formExtrudeCurve', 'formRevolveCurve', 'formSweepCurve', 'formLoftCurves', 'formPipeCurve'],
      (s) => s.ranAny(['formExtrudeCurve', 'formRevolveCurve', 'formSweepCurve', 'formLoftCurves', 'formPipeCurve']),
      { needs: ['formExtrudeCurve', 'formRevolveCurve', 'formSweepCurve', 'formLoftCurves', 'formPipeCurve'] }
    ),
    step(
      'Add a face to the cage by hand.',
      cmd('formFace'),
      'formFace',
      shaped('formFace')
    ),
    step(
      'Now Edit Form, which is where the shaping happens. Pick a face and pull it.',
      cmd('editForm'),
      ['editForm', 'formPull'],
      (s) => s.ranAny(['editForm', 'formPull'])
    ),
    step(
      'Grow the selection a ring, then shrink it back.',
      inMenu('formSelect', 'formGrow'),
      ['formGrow', 'formShrink'],
      (s) => s.ranAny(['formGrow', 'formShrink']),
      { needs: ['formGrow', 'formShrink'] }
    ),
    step(
      'Select a loop across the quads, and a ring along them. They are different questions.',
      inMenu('formSelect', 'formLoop'),
      ['formLoop', 'formRing'],
      (s) => s.ranAny(['formLoop', 'formRing']),
      { needs: ['formLoop', 'formRing'] }
    ),
    step(
      'Invert the selection, and select the lot.',
      inMenu('formSelect', 'formInvert'),
      ['formInvert', 'formSelectAll'],
      (s) => s.ranAny(['formInvert', 'formSelectAll']),
      { needs: ['formInvert', 'formSelectAll'] }
    ),
    step(
      'Insert an edge where you need more control.',
      inMenu('formInsert', 'formInsertEdge'),
      ['formInsertEdge', 'formInsertPoint'],
      (s) => s.ranAny(['formInsertEdge', 'formInsertPoint'])
    ),
    step(
      'Subdivide a face into four.',
      inMenu('formInsert', 'formSubdivide'),
      'formSubdivide',
      shaped('formSubdivide')
    ),
    step(
      'Bridge between two faces to make a handle out of a lump.',
      inMenu('formShape', 'formBridge'),
      'formBridge',
      shaped('formBridge')
    ),
    step(
      'Fill a hole in the cage.',
      inMenu('formShape', 'formFillHole'),
      'formFillHole',
      shaped('formFillHole')
    ),
    step(
      'Delete a face, and erase one, which are not the same thing.',
      inMenu('formShape', 'formDelete'),
      ['formDelete', 'formErase'],
      (s) => s.ranAny(['formDelete', 'formErase']),
      { needs: ['formDelete', 'formErase'] }
    ),
    step(
      'Weld two points into one, then unweld them.',
      inMenu('formWeld', 'formWeld'),
      ['formWeld', 'formUnweld'],
      (s) => s.ranAny(['formWeld', 'formUnweld']),
      { needs: ['formWeld', 'formUnweld'] }
    ),
    step(
      'Merge two edges.',
      inMenu('formWeld', 'formMergeEdge'),
      'formMergeEdge',
      shaped('formMergeEdge')
    ),
    step(
      'Crease an edge so the surface holds a corner there, then uncrease it.',
      inMenu('formCrease', 'formCrease'),
      ['formCrease', 'formUncrease'],
      (s) => s.ranAny(['formCrease', 'formUncrease']),
      { needs: ['formCrease', 'formUncrease'] }
    ),
    step(
      'Bevel an edge of the cage.',
      inMenu('formCrease', 'formBevel'),
      'formBevel',
      shaped('formBevel')
    ),
    step(
      'Smooth a run of points, and straighten another.',
      inMenu('formTidy', 'formSmooth'),
      ['formSmooth', 'formStraighten'],
      (s) => s.ranAny(['formSmooth', 'formStraighten']),
      { needs: ['formSmooth', 'formStraighten'] }
    ),
    step(
      'Cylindrify a ring so it is actually round.',
      inMenu('formTidy', 'formCylindrify'),
      'formCylindrify',
      shaped('formCylindrify')
    ),
    step(
      'Flatten a set of points onto a plane, and even out the spacing with Uniform.',
      inMenu('formTidy', 'formFlatten'),
      ['formFlatten', 'formUniform'],
      (s) => s.ranAny(['formFlatten', 'formUniform']),
      { needs: ['formFlatten', 'formUniform'] }
    ),
    step(
      'Slide a point along the surface rather than through it.',
      inMenu('formTidy', 'formSlide'),
      'formSlide',
      shaped('formSlide')
    ),
    step(
      'Match an edge to another piece of geometry.',
      inMenu('formTidy', 'formMatch'),
      'formMatch',
      shaped('formMatch')
    ),
    step(
      'Interpolate a run of points, then take it off again.',
      inMenu('formTidy', 'formInterpolate'),
      ['formInterpolate', 'formUninterpolate'],
      (s) => s.ranAny(['formInterpolate', 'formUninterpolate']),
      { needs: ['formInterpolate', 'formUninterpolate'] }
    ),
    step(
      'Build it from a curve instead.',
      inMenu('formShape', 'formByCurve'),
      'formByCurve',
      shaped('formByCurve')
    ),
    step(
      'Freeze part of the cage so it stops moving when its neighbours do, then unfreeze it.',
      inMenu('formTidy', 'formFreeze'),
      ['formFreeze', 'formUnfreeze'],
      (s) => s.ranAny(['formFreeze', 'formUnfreeze']),
      { needs: ['formFreeze', 'formUnfreeze'] }
    ),
    step(
      'Mirror the cage so the two halves are the same thing rather than two things that match.',
      inMenu('formFaces', 'formMirror'),
      ['formMirror', 'formCircular'],
      (s) => s.ranAny(['formMirror', 'formCircular'])
    ),
    step(
      'Clear the symmetry and see the halves come apart.',
      inMenu('formFaces', 'formClearSymmetry'),
      'formClearSymmetry',
      shaped('formClearSymmetry')
    ),
    step(
      'Switch the display: the cage, the surface, and the cage over the surface. The last is the one to work in.',
      inMenu('formDisplay', 'formDisplayBox'),
      ['formDisplayBox', 'formDisplayControl', 'formDisplaySmooth'],
      (s) => s.ranAny(['formDisplayBox', 'formDisplayControl', 'formDisplaySmooth']),
      { needs: ['formDisplayBox', 'formDisplayControl', 'formDisplaySmooth'] }
    ),
    step(
      'Repair the cage. Break it on purpose first if it will not complain.',
      cmd('formRepair'),
      'formRepair',
      shaped('formRepair')
    ),
    step(
      'Thicken the open cage into a shell with walls.',
      cmd('formThicken'),
      'formThicken',
      made('formThicken'),
      { check: noErrors() }
    ),
    step(
      'Finish the form. It becomes a body like any other.',
      cmd('finishForm'),
      'finishForm',
      made('finishForm'),
      { check: all(noErrors(), changed()) }
    )
  ]
};
