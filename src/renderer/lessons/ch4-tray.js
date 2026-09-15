/**
 * Chapter 4. A sheet metal tray.
 *
 * The shortest chapter and the most self contained. Sheet metal is not a
 * different modeller, it is one promise: whatever you build can be flattened
 * again, because it was made from a flat sheet in the first place. Every tool
 * here exists to keep that promise.
 */

import { cmd, step, made, ran, all, changed, noErrors } from './kit.js';

export default {
  id: 'tray',
  title: 'Sheet metal tray',
  blurb: 'A rule, some flanges, and a flat pattern that could go to a laser.',
  steps: [
    step(
      'Set the rule first. Thickness and bend radius, before any geometry, because everything after this obeys it.',
      cmd('smRule'),
      'smRule',
      (s) => s.ran('smRule') || !!s.doc.sheetRules,
      { tab: 'sheet' }
    ),
    step(
      'Sketch the floor of the tray and make it a base flange.',
      cmd('baseFlange'),
      'baseFlange',
      made('baseFlange'),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'Turn the four edges up. A flange on each.',
      cmd('flange'),
      'flange',
      made('flange'),
      { check: all(noErrors(), changed()) }
    ),
    step(
      'Hem the top edge so nobody cuts themselves on it.',
      cmd('hem'),
      'hem',
      made('hem'),
      { check: noErrors() }
    ),
    step(
      'Add a contour flange, which follows a drawn line rather than an edge.',
      cmd('contourFlange'),
      'contourFlange',
      made('contourFlange'),
      { check: noErrors() }
    ),
    step(
      'And a lofted flange between two different profiles.',
      cmd('loftedFlange'),
      'loftedFlange',
      made('loftedFlange'),
      { check: noErrors() }
    ),
    step(
      'Fold a face along a line.',
      cmd('sheetFold'),
      'sheetFold',
      made('sheetFold'),
      { check: noErrors() }
    ),
    step(
      'Unfold a bend to work on the face flat, then refold it.',
      cmd('unfold'),
      ['unfold', 'refold'],
      (s) => s.has('unfold') || s.has('refold'),
      { check: noErrors() }
    ),
    step(
      'Rip a corner so the two walls stop being one piece of metal.',
      cmd('rip'),
      'rip',
      made('rip'),
      { check: noErrors() }
    ),
    step(
      'Put relief in the corners. Without it the metal tears where three bends meet.',
      cmd('cornerRelief'),
      'cornerRelief',
      made('cornerRelief'),
      { check: noErrors() }
    ),
    step(
      'Miter the corner where two flanges meet.',
      cmd('miter'),
      'miter',
      made('miter'),
      { check: noErrors() }
    ),
    step(
      'Take an ordinary solid and convert it to sheet metal.',
      cmd('convertToSheetMetal'),
      'convertToSheetMetal',
      made('convertToSheetMetal'),
      { check: noErrors() }
    ),
    step(
      'Flatten it. This is the promise being kept.',
      cmd('flatPattern'),
      'flatPattern',
      made('flatPattern'),
      { check: noErrors() }
    ),
    step(
      'And write the flat out as a DXF, which is what a laser wants.',
      cmd('exportFlatDXF'),
      'exportFlatDXF',
      ran('exportFlatDXF')
    )
  ]
};
