/**
 * The campaign.
 *
 * Nine chapters, in the order they are meant to be walked, which is also
 * roughly easiest to hardest. Between them they reach every tool the
 * application has; `test/coverage.js` is what proves that rather than hoping,
 * and it fails the run when a tool is added to Anvil and nothing teaches it.
 */

import bracket from './ch1-bracket.js';
import knob from './ch2-knob.js';
import enclosure from './ch3-enclosure.js';
import tray from './ch4-tray.js';
import bottle from './ch5-bottle.js';
import handle from './ch6-handle.js';
import scanned from './ch7-scanned.js';
import engineering from './ch8-engineering.js';
import presentation from './ch9-presentation.js';

export const CHAPTERS = [
  bracket,
  knob,
  enclosure,
  tray,
  bottle,
  handle,
  scanned,
  engineering,
  presentation
];
