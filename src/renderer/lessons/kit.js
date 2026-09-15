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
