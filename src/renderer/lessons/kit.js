/**
 * The shapes a step is made of.
 *
 * A chapter is a few dozen steps and almost all of them say the same three
 * things: press that, and when a feature of this type turns up, you are done.
 * Written out longhand that is four lines each and a thousand lines a chapter,
 * and the interesting part, which is what the step actually checks, gets lost
 * in the scaffolding around it.
 *
 * So the scaffolding is here and the chapters are the words and the checks.
 */

/** Point at a ribbon button. */
export const cmd = (id) => ({ cmd: id });

/** Point at an item inside a family menu, opening the menu first. */
export const inMenu = (menu, id) => ({ menu, cmd: id });

/** Point at a sketch tool, or at a constraint. */
export const tool = (id) => ({ tool: id });
export const con = (id) => ({ con: id });

/** A feature of this type exists. The ordinary condition. */
export const made = (type) => (s) => s.has(type);

/** At least this many of them, for a step that adds another. */
export const madeN = (type, n) => (s) => s.features(type).length >= n;

/**
 * The command was run, which is all that can be asked of a tool that leaves no
 * mark: an analysis, a selection rule, a view, an export.
 */
export const ran = (id) => (s) => s.ran(id);

/** A step, with the common fields in a fixed order so a chapter reads evenly. */
export function step(say, point, covers, done, extra = {}) {
  return { say, point, covers: [].concat(covers), done, ...extra };
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

/**
 * A check returns true when the result is right, or a sentence saying what is
 * wrong. The sentence goes into the report, so it is written to be read by
 * somebody who was not watching.
 */

/** The model got bigger by somewhere in this range. */
export const grewBy = (min, max) => (s) => {
  const d = s.volumeDelta();
  return (
    (d >= min && d <= max) ||
    `expected the model to grow by ${min} to ${max} cubic mm and it changed by ${d.toFixed(1)}`
  );
};

/** And smaller. Written the way round somebody thinks about a cut. */
export const shrankBy = (min, max) => (s) => {
  const d = -s.volumeDelta();
  return (
    (d >= min && d <= max) ||
    `expected the model to lose ${min} to ${max} cubic mm and it changed by ${(-d).toFixed(1)}`
  );
};

/** It changed at all, which is the weakest honest thing to say about a shape. */
export const changed = () => (s) =>
  Math.abs(s.volumeDelta()) > 1e-6 || 'the shape did not change at all';

/** There are this many bodies now. */
export const bodies = (n) => (s) =>
  s.bodyCount() === n || `expected ${n} bodies and there are ${s.bodyCount()}`;

/** Nothing in the document is complaining. */
export const noErrors = () => (s) => {
  const e = s.errors();
  return !e.length || `the rebuild reported: ${e.join(' | ')}`;
};

/** Every check in turn, reporting the first that fails. */
export const all = (...checks) => (s) => {
  for (const c of checks) {
    const r = c(s);
    if (r !== true && r !== undefined) return r;
  }
  return true;
};

/* ------------------------------------------------------------------ */
/* Playing a step                                                      */
/* ------------------------------------------------------------------ */

/**
 * How a step drives itself, for the auto-player and for nobody else.
 *
 * A person reads the instruction and clicks. These exist so a chapter can be
 * walked with nobody watching, which is what stops one rotting quietly between
 * the day it is written and the day somebody sits through it.
 *
 * The default, pressing the control and accepting the dialog, covers the steps
 * that need nothing picked first. Everything below is for the ones that do.
 */

/**
 * Pick something, then press the control, then type into the dialog.
 *
 * Written, proved on its own, and not yet trusted on a chapter: driven from
 * inside a playthrough the four steps it was tried on committed their feature
 * before the value landed, and a script that fails files its report against
 * the application rather than against itself. That is worse than no script at
 * all, so the steps it was on are back on the default until this is right.
 */
export const withPick = (kind, fields = null, which = 0) => async (c) => {
  c.drive.select?.(kind, which);
  await c.wait(80);
  // Held open when there is something to type, or accepting it commits the
  // feature at whatever it opened with and the number never lands.
  await c.press(c.step || {}, { answer: !fields });
  if (!fields) return;

  /*
   * Wait for the dialog before typing into it.
   *
   * A command that rebuilds on the way in takes longer to open than the fixed
   * pause after the press, and a value set before there is anything to set it
   * on is silently dropped. That is how a scripted extrude committed at zero
   * and reported itself as the app's fault.
   */
  for (let i = 0; i < 40 && c.drive.read?.('type') === undefined; i++) await c.wait(50);
  for (const [k, v] of Object.entries(fields)) c.drive.field?.(k, v);
  await c.wait(250);
  c.drive.commit?.();
  await c.wait(500);
};

/** Open a sketch on a plane and draw with one tool, click by click. */
export const sketch = (plane, tool, points) => async (c) => {
  c.drive.sketchOn?.(plane);
  await c.wait(700);
  if (tool) c.drive.tool?.(tool);
  await c.wait(120);
  for (const [x, y] of points || []) {
    c.drive.sketchAt?.(x, y);
    await c.wait(140);
  }
};

/** Reach for a sketch tool inside a sketch that is already open. */
export const useTool = (tool, points = []) => async (c) => {
  c.drive.tool?.(tool);
  await c.wait(120);
  for (const [x, y] of points) {
    c.drive.sketchAt?.(x, y);
    await c.wait(140);
  }
};

/** Leave the sketch. */
export const done = () => async (c) => {
  c.drive.finishSketch?.();
  await c.wait(600);
};
