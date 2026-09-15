/**
 * Every chapter, played with nobody watching.
 *
 * A step says what it wants and how to know it happened, and the default
 * player presses the thing the ring is round and accepts whatever dialog
 * opens. That is enough for most of the campaign, and where it is not enough
 * the step comes back marked `never`, which is exactly the list worth having:
 * either the lesson needs a script of its own or the feature does not work.
 *
 * This is the run that stops a chapter rotting quietly.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { chapters: [], errors: [] };
window.addEventListener('error', (e) => out.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

for (const chapter of dev.chapters) {
  // A clean document for each, and the chapter's own starting model if it has
  // one, because a chapter played on the leftovers of the last one is not the
  // chapter anybody will walk.
  dev.state.doc.features = [];
  dev.state.doc.sketches = {};
  dev.state.doc.meshData = {};
  dev.rebuildAll();
  await wait(500);
  if (chapter.start) {
    const seed = chapter.start();
    Object.assign(dev.state.doc.meshData, seed.meshData || {});
    dev.state.doc.features.push(...(seed.features || []));
    dev.rebuildAll();
    await wait(900);
  }

  const played = await dev.teacher.play(chapter, { pause: 20 });
  const never = played.steps.filter((s) => s.mark === 'never');
  out.chapters.push({
    id: chapter.id,
    steps: played.steps.length,
    done: played.steps.filter((s) => s.mark === 'done').length,
    wrong: played.steps.filter((s) => s.mark === 'wrong').length,
    never: never.length,
    neverList: never.map((s) => `${s.step}: ${s.say.slice(0, 48)}`),
    threw: played.steps.filter((s) => s.error).map((s) => `${s.step}: ${s.error}`),
    // The reason a check failed is the whole value of the run. Without it a
    // wrong step is a number rather than something anybody can act on.
    faults: played.reports
      .filter((r) => r.kind === 'wrong' || r.kind === 'errors')
      .map((r) => ({ step: r.step, kind: r.kind, say: r.say?.slice(0, 60), why: r.why }))
  });
}

out.total = out.chapters.reduce((a, c) => a + c.steps, 0);
out.reached = out.chapters.reduce((a, c) => a + c.done + c.wrong, 0);
return out;
