/**
 * Animation: taking an assembly apart, on a timeline.
 *
 * What this is for is telling somebody how a thing goes together. A still of an
 * exploded assembly is the single most useful drawing there is for that, and a
 * moving one is better still, because it shows the order as well as the
 * arrangement.
 *
 * A storyboard is a list of steps. Each one moves one component, by a distance
 * and optionally a turn, starting at a time and taking a while. Nothing here
 * rebuilds the model: a step is a transform laid over a body for display, so
 * scrubbing the timeline costs nothing and the model underneath never moves.
 * That matters more than it sounds. An animation that edited the assembly would
 * leave the parts wherever the playhead happened to stop.
 *
 * Everything here is arithmetic on the storyboard. Nothing draws, nothing
 * writes to the document and nothing touches the kernel.
 */

/** A storyboard with nothing in it, which is what a document starts with. */
export function newStoryboard() {
  return { steps: [], length: 4 };
}

/** How long the whole thing runs, which is as far as the last step reaches. */
export function lengthOf(story) {
  let end = 0;
  for (const s of story?.steps || []) {
    end = Math.max(end, (s.start || 0) + (s.duration || 0));
  }
  return Math.max(end, 0.001);
}

/**
 * How far through a step the clock is, eased.
 *
 * Eased rather than linear because a part that starts and stops dead looks
 * broken, and smoothstep is the cheapest curve that leaves flat at both ends.
 */
export function progressOf(step, time) {
  const start = step.start || 0;
  const dur = Math.max(1e-6, step.duration || 0);
  const t = Math.max(0, Math.min(1, (time - start) / dur));
  return t * t * (3 - 2 * t);
}

/**
 * Where every component is at a given moment.
 *
 * Steps add up: two steps moving the same component both count, which is what
 * lets a part come out and then turn over. The order they were written in is
 * the order they are applied, so a later step's turn happens about the position
 * the earlier ones left.
 */
export function offsetsAt(story, time) {
  const out = new Map();
  for (const step of story?.steps || []) {
    if (!step.component) continue;
    const p = progressOf(step, time);
    if (p <= 0) continue;
    const held = out.get(step.component) || { move: [0, 0, 0], turns: [] };
    if (step.move) {
      held.move[0] += (step.move[0] || 0) * p;
      held.move[1] += (step.move[1] || 0) * p;
      held.move[2] += (step.move[2] || 0) * p;
    }
    if (step.turn && step.turn.degrees) {
      held.turns.push({
        axis: step.turn.axis || [0, 0, 1],
        origin: step.turn.origin || [0, 0, 0],
        radians: ((step.turn.degrees || 0) * Math.PI * p) / 180
      });
    }
    out.set(step.component, held);
  }
  return out;
}

/**
 * A storyboard that takes an assembly apart, made from where the parts are.
 *
 * Each component moves away from the middle of the whole thing, along the line
 * from that middle to its own. That is the explode everybody draws by hand, and
 * doing it from the geometry rather than by eye means it stays right when a
 * part moves.
 *
 * The parts go one after another rather than all at once, because the order is
 * half of what an exploded view is for. Furthest out first: that is the order
 * things come off, and it reads as taking apart rather than as flying away.
 */
export function autoExplode(parts, opts = {}) {
  const usable = (parts || []).filter((p) => p.component && p.centre);
  if (usable.length < 2) return null;

  const spread = opts.spread ?? 1.5;
  const each = Math.max(0.05, opts.each ?? 0.7);
  const overlap = Math.max(0, Math.min(0.95, opts.overlap ?? 0.5));

  const centre = [0, 1, 2].map(
    (i) => usable.reduce((a, p) => a + p.centre[i], 0) / usable.length
  );
  const size = Math.max(
    1,
    ...usable.map((p) => Math.hypot(...[0, 1, 2].map((i) => p.centre[i] - centre[i])))
  );

  const ordered = usable
    .map((p) => {
      const away = [0, 1, 2].map((i) => p.centre[i] - centre[i]);
      const reach = Math.hypot(...away);
      // A part sitting exactly in the middle has no direction to go, so it is
      // sent up: the alternative is leaving it where it is, buried. Marked
      // rather than given a tiny reach, because a tiny reach is what everything
      // downstream divides by.
      if (reach > 1e-5) return { part: p, dir: away.map((v) => v / reach), reach };
      return { part: p, dir: [0, 0, 1], reach: 0, central: true };
    })
    .sort((a, b) => b.reach - a.reach);

  const step = each * (1 - overlap);
  const steps = ordered.map((e, i) => {
    const dir = e.dir;
    const distance = size * spread * (e.central ? 0.6 : 1);
    return {
      id: `ex${i}`,
      name: `${e.part.name || 'Part'} out`,
      component: e.part.component,
      move: dir.map((v) => v * distance),
      start: +(i * step).toFixed(4),
      duration: each
    };
  });

  return { steps, length: lengthOf({ steps }) };
}

/** A step written by hand, with somewhere sensible to start. */
export function newStep(story, component, name) {
  return {
    id: `st${Math.random().toString(36).slice(2, 9)}`,
    name: name || 'Move',
    component,
    move: [0, 0, 20],
    turn: null,
    start: lengthOf(story) === 0.001 ? 0 : lengthOf(story),
    duration: 0.7
  };
}

/**
 * What is happening at a given moment, in words.
 *
 * A scrubber with a number on it says nothing about what the number means. The
 * name of the step that is running is what somebody watching actually wants.
 */
export function captionAt(story, time) {
  // A step that has just finished is finished, not running. Without the strict
  // end the last step reads as still going at the moment everything has
  // stopped, and the caption says a part is coming out when it is already out.
  const running = (story?.steps || []).filter(
    (s) => time >= (s.start || 0) && time < (s.start || 0) + (s.duration || 0)
  );
  if (running.length) return running.map((s) => s.name).join(', ');
  // Finished the moment it reaches its end, to match: between them the two
  // tests cover every moment exactly once, so there is no instant where a step
  // is neither running nor done.
  const done = (story?.steps || []).filter((s) => time >= (s.start || 0) + (s.duration || 0));
  if (!done.length) return 'Together';
  if (done.length === (story?.steps || []).length) return 'Apart';
  return `${done.length} of ${story.steps.length} apart`;
}
