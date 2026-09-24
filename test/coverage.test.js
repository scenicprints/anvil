'use strict';

/**
 * Does the campaign reach every tool?
 *
 * Teacher Mode is built on a promise that walking the nine chapters drives
 * every tool Anvil has. A promise like that decays the moment somebody adds a
 * command, so it is checked rather than believed: the tools are counted from
 * the application and the claims are read out of the lessons, and a tool that
 * nothing teaches fails the run.
 *
 * Plain node, no window, because it is all text.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');

/* ---- what the application has ---- */

// Opening and saving are not tools to be taught. Nor are the ids that only
// name a family menu: the menu's own items are counted instead.
const PLUMBING = new Set([
  'new', 'open', 'save', 'saveAs', 'saveCopy', 'undo', 'redo', 'fit',
  'openRecent', 'openFromLibrary', 'newProject', 'newFolder',
  'primitive', 'pattern', 'split', 'form', 'plane', 'cylinder', 'sphere',
  'torus', 'quadball', 'insert',
  // Teacher Mode itself, which is not a modelling tool and cannot teach itself.
  'teacher', 'teacherLedger',
  // A feature type, not a command: it reads as one only because reopening it
  // from the timeline is a case in the same shape. The command that makes one
  // is deleteBody, which has a button and a lesson of its own.
  'removeBody'
]);

const commands = new Set(
  [...app.matchAll(/^ {4}case '([a-zA-Z0-9_]+)':/gm)].map((m) => m[1]).filter((c) => !PLUMBING.has(c))
);
for (const m of html.matchAll(/data-tool="([a-zA-Z0-9]+)"/g)) commands.add(`tool:${m[1]}`);
for (const m of app.matchAll(/'tool:([a-zA-Z0-9]+)'/g)) commands.add(`tool:${m[1]}`);
for (const m of html.matchAll(/data-con="([a-zA-Z0-9]+)"/g)) commands.add(`con:${m[1]}`);

/* ---- what the lessons claim ---- */

const dir = path.join(root, 'src/renderer/lessons');
const claimed = new Map();
for (const file of fs.readdirSync(dir)) {
  if (!file.startsWith('ch') || !file.endsWith('.js')) continue;
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  // Every quoted word with no spaces in it. A lesson's prose is sentences, so
  // anything that matches a real tool id was meant as a claim on that tool.
  for (const m of text.matchAll(/'([A-Za-z0-9:]+)'/g)) {
    const id = m[1];
    if (!commands.has(id)) continue;
    if (!claimed.has(id)) claimed.set(id, new Set());
    claimed.get(id).add(file);
  }
}

/* ---- the verdict ---- */

const missing = [...commands].filter((c) => !claimed.has(c)).sort();
const failures = [];

/*
 * The ledger inside the application counts by reading the ribbon, and a
 * command with no button is invisible to it. app.js keeps a list of those.
 * This is what stops that list drifting: the commands with no button and no
 * menu entry have to be exactly the ones written down.
 */
{
  const inDom = new Set([...html.matchAll(/data-cmd="([a-zA-Z0-9_]+)"/g)].map((m) => m[1]));
  const menuStart = app.indexOf('const RIBBON_MENUS');
  const menuBody = app.slice(menuStart, app.indexOf('\n};', menuStart));
  const inMenus = new Set([...menuBody.matchAll(/\['([a-zA-Z0-9_:]+)',/g)].map((m) => m[1]));
  const block = app.match(/const OFF_RIBBON = \[([\s\S]*?)\];/);
  const listed = new Set(
    block ? [...block[1].matchAll(/'([a-zA-Z0-9_]+)'/g)].map((x) => x[1]) : []
  );
  const buttonless = [...commands].filter(
    (c) => !c.includes(':') && !inDom.has(c) && !inMenus.has(c)
  );
  const unlisted = buttonless.filter((c) => !listed.has(c)).sort();
  const stale = [...listed].filter((c) => !buttonless.includes(c)).sort();
  if (unlisted.length) failures.push(`OFF_RIBBON in app.js is missing: ${unlisted.join(', ')}`);
  if (stale.length) failures.push(`OFF_RIBBON in app.js names commands that have a button: ${stale.join(', ')}`);
}

if (missing.length) {
  failures.push(
    `${missing.length} tool${missing.length === 1 ? '' : 's'} no chapter teaches: ${missing.join(', ')}`
  );
}

// Every chapter must be reachable, or a file can sit there teaching nobody.
const index = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
for (const file of fs.readdirSync(dir)) {
  if (!file.startsWith('ch') || !file.endsWith('.js')) continue;
  if (!index.includes(file.replace(/\.js$/, ''))) {
    failures.push(`${file} is not in the campaign`);
  }
}

if (failures.length) {
  process.stderr.write(`coverage: FAILED\n${failures.map((f) => `  ${f}\n`).join('')}`);
  throw new Error('the campaign does not reach every tool');
}

process.stdout.write(
  `campaign coverage: ${claimed.size} of ${commands.size} tools taught across nine chapters\n`
);
