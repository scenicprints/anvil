/**
 * Teacher Mode: a chapter walked one step at a time.
 *
 * Anvil has 315 tools and nothing that says what they are for, in what order
 * they are meant to be used, or which of them the part in front of you needs. A
 * reference manual answers the first question and none of the others. This
 * answers all three by building something.
 *
 * It has a second job, and the second job is why the shape of it matters. Every
 * step says what should be true when it is finished, which makes every step a
 * test. Walking the campaign drives all 315 tools by hand with an assertion
 * behind each one, and that is a sweep of this program nothing else performs.
 *
 * The rules are all here rather than spread through the application, and the
 * application hands over what this needs through `init` rather than being
 * imported back, because a module that reaches into `app.js` and is reached
 * into by it cannot be loaded in either order.
 *
 * `TEACHER.md` is the design. This is the engine; the chapters are data, in
 * `lessons/`.
 */

/* ------------------------------------------------------------------ */
/* What the application hands over                                     */
/* ------------------------------------------------------------------ */

let api = null;

const T = {
  lesson: null,
  index: 0,
  marks: [],
  reports: [],
  ledger: new Set(),
  depth: new Set(),
  // How far through each chapter you got. A campaign of nine is something you
  // come back to, and the question on coming back is always which one you were
  // in the middle of.
  progress: {},
  before: null,
  recent: [],
  // How much of the command log was already there when this step began, so a
  // step can ask what has been run since rather than ever.
  since: 0,
  panel: null,
  ring: null,
  open: false,
  // Set while the engine itself is driving, so the auto-player is not blocked
  // by the rules it is there to test.
  auto: false
};

const LEDGER_KEY = 'anvil.teacher.ledger';
const DEPTH_KEY = 'anvil.teacher.depth';
const PROGRESS_KEY = 'anvil.teacher.progress';

/**
 * Everything blocking must never touch.
 *
 * The ribbon is what the lesson guides. Everything else stays yours, and the
 * list is short for a reason: each of these, blocked, turns a lesson into a
 * cage rather than a guide.
 *
 * The viewport most of all. Orbiting and picking are the same drag on the same
 * canvas, so there is no honest way to allow one and refuse the other, and a
 * lesson you cannot look around is not a lesson. Dialogs, because a step is
 * finished by answering one. Undo, because without it the first mistake is a
 * dead end. Tabs, because the next step is often on another one.
 */
const ALWAYS_LIVE = [
  '#teacher',
  '#viewwrap',
  '#inspector',
  '#browser',
  '#timeline',
  '#statusbar',
  '.tab',
  '[data-view]',
  '[data-cmd="undo"]',
  '[data-cmd="redo"]',
  '[data-cmd="fit"]',
  '[data-cmd="home"]',
  '[data-cmd="toggleProjection"]'
];

export function init(hooks) {
  api = hooks;
  load();
  window.addEventListener('click', guardClick, true);
  window.addEventListener('pointerdown', guardClick, true);
  window.addEventListener('keydown', guardKey, true);
  // Opening a group or changing tab moves the control the ring is drawn round,
  // and in the group's case reveals the real button where a moment ago there
  // was only its name.
  window.addEventListener('click', (e) => {
    if (e.target.closest?.('.grp-trigger, .tab')) setTimeout(reposition, 0);
  });
}

/* ------------------------------------------------------------------ */
/* The ledger                                                          */
/* ------------------------------------------------------------------ */

function load() {
  try {
    for (const t of JSON.parse(localStorage.getItem(LEDGER_KEY) || '[]')) T.ledger.add(t);
    for (const t of JSON.parse(localStorage.getItem(DEPTH_KEY) || '[]')) T.depth.add(t);
    T.progress = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
  } catch {
    /* a ledger that cannot be read starts again rather than stopping anything */
  }
}

function save() {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify([...T.ledger]));
    localStorage.setItem(DEPTH_KEY, JSON.stringify([...T.depth]));
  } catch {
    /* nothing here is worth failing a lesson over */
  }
}

/** Where each chapter was left, for the chooser and for coming back to one. */
export function progress(id) {
  return id ? T.progress[id] || null : T.progress;
}

function remember() {
  if (!T.lesson) return;
  T.progress[T.lesson.id] = {
    index: T.index,
    total: T.lesson.steps.length,
    done: T.marks.filter((m) => m === 'done').length
  };
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(T.progress));
  } catch {
    /* losing the bookmark is not worth failing a lesson over */
  }
}

/**
 * Every tool the application has, counted from the application rather than
 * from a list somebody has to remember to update.
 *
 * Commands come from the ribbon and from the family menus; the sketcher does
 * not go through `runCommand` at all, so its tools and its constraints are
 * read off their own buttons. A tool added to Anvil turns up here the next
 * time this runs, unticked, which is the point.
 */
export function everyTool() {
  const out = new Set();
  for (const b of document.querySelectorAll('[data-cmd]')) out.add(b.dataset.cmd);
  for (const b of document.querySelectorAll('[data-tool]')) out.add(`tool:${b.dataset.tool}`);
  for (const b of document.querySelectorAll('[data-con]')) out.add(`con:${b.dataset.con}`);
  for (const id of api?.menuCommands?.() || []) {
    out.add(id.startsWith('tool:') ? id : id);
  }
  for (const id of PLUMBING) out.delete(id);
  return out;
}

// Opening, saving and undoing are not tools to be taught, and a campaign that
// demanded them would be counting the front door as a room.
const PLUMBING = [
  'new', 'open', 'save', 'saveAs', 'saveCopy', 'undo', 'redo', 'fit',
  'openRecent', 'openFromLibrary', 'newProject', 'newFolder',
  // Ids that only name a family menu. The items inside are counted instead.
  'primitive', 'pattern', 'split', 'form', 'plane', 'cylinder', 'sphere',
  'torus', 'quadball', 'insert',
  // And this, which cannot teach itself.
  'teacher', 'teacherLedger'
];

export function ledger() {
  const all = everyTool();
  const ticked = [...T.ledger].filter((t) => all.has(t));
  const claimed = new Set();
  for (const lesson of api?.lessons?.() || []) {
    for (const step of lesson.steps || []) for (const c of step.covers || []) claimed.add(c);
  }
  return {
    total: all.size,
    ticked: ticked.length,
    missing: [...all].filter((t) => !T.ledger.has(t)).sort(),
    // A tool no chapter claims is a hole in the campaign rather than in the
    // app, and it is worth saying which.
    unclaimed: [...all].filter((t) => !claimed.has(t)).sort(),
    depth: [...T.depth].sort()
  };
}

function tick(ids) {
  let fresh = false;
  for (const id of ids || []) {
    const set = id.includes(':') && !id.startsWith('tool:') && !id.startsWith('con:')
      ? T.depth
      : T.ledger;
    if (!set.has(id)) fresh = true;
    set.add(id);
  }
  if (fresh) save();
}

/* ------------------------------------------------------------------ */
/* Running a chapter                                                   */
/* ------------------------------------------------------------------ */

export function openChapter(lesson, { resume = true, seed = true } = {}) {
  T.lesson = lesson;
  T.marks = lesson.steps.map(() => null);
  // Back where you left off, unless the chapter was finished, in which case
  // starting again is what opening it means.
  const held = resume ? T.progress[lesson.id] : null;
  T.index = held && held.index < lesson.steps.length ? held.index : 0;
  T.open = true;

  /*
   * Some chapters need something to work on.
   *
   * Chapter 7 repairs a broken mesh and chapter 8 asks whether a part is any
   * good, and neither question can be put to an empty document. Only ever into
   * an empty one: a chapter must not walk over work that is already open.
   */
  if (seed && lesson.start && api.seedDocument) {
    try {
      api.seedDocument(lesson.start());
    } catch (err) {
      file('seed', `The chapter could not lay out its starting model: ${err.message}`);
    }
  }

  buildPanel();
  enter();
}

export function close() {
  T.open = false;
  T.lesson = null;
  clearRing();
  api?.highlight?.(null);
  if (T.panel) T.panel.classList.add('hidden');
  document.body.classList.remove('teaching');
}

export function current() {
  if (!T.open || !T.lesson) return null;
  return { lesson: T.lesson, step: T.lesson.steps[T.index], index: T.index };
}

export function isOpen() {
  return T.open;
}

/** Arriving at a step: remember where the model was, point at the control. */
function enter() {
  const step = T.lesson?.steps[T.index];
  if (!step) return finish();
  T.since = T.recent.length;
  T.before = snapshot();
  if (step.tab && api.setTab) api.setTab(step.tab);
  document.body.classList.add('teaching');
  remember();
  render();
  spotlight();
  // A step whose condition is already true when it is reached has nothing to
  // do, which happens whenever a step asks for something a previous step left
  // behind. Checking on arrival rather than only on the next command is what
  // stops it sitting there already satisfied and waiting.
  poll();
}

function finish() {
  clearRing();
  render(true);
}

export function advance() {
  if (T.index < T.lesson.steps.length - 1) {
    T.index++;
    enter();
  } else {
    T.index = T.lesson.steps.length;
    finish();
  }
}

export function back() {
  if (T.index > 0) {
    T.index--;
    enter();
  }
}

/**
 * Skip, which is also how a bug gets filed.
 *
 * Blocked everywhere but the one control and told to press it, a step whose
 * condition never comes true because the app is broken would trap you with
 * nothing to do. So Skip is always live, and because the usual reason for
 * skipping is that the step did not work, skipping writes a report.
 */
export function skip() {
  const step = T.lesson?.steps[T.index];
  if (!step) return;
  T.marks[T.index] = 'skipped';
  file('skipped', 'The step could not be completed.');
  advance();
}

/* ------------------------------------------------------------------ */
/* Knowing what happened                                               */
/* ------------------------------------------------------------------ */

export function noteCommand(id) {
  T.recent.push({ id, at: Date.now() });
  if (T.recent.length > 40) T.recent.shift();
  if (!T.open) {
    // The ledger records what you have used whether or not a lesson is running,
    // so ordinary work counts towards it too.
    tick([id]);
    return;
  }
  tick([id]);
  poll();
  // A command that changes nothing in the document never reaches the rebuild
  // tap, and one that opens a dialog has not done anything yet when this runs.
  // Looking again on the next turn of the loop catches the first kind.
  setTimeout(() => {
    if (T.open) poll();
  }, 0);
}

export function noteTool(id) {
  noteCommand(`tool:${id}`);
}

export function noteConstraint(id) {
  noteCommand(`con:${id}`);
}

export function noteRebuild() {
  if (T.open) poll();
}

/**
 * Has the step been done, and was it done right?
 *
 * Two separate questions on purpose. `done` reads the document, so it does not
 * care whether the ribbon, the keyboard or the context menu got you there, and
 * it ticks the step. `check` asks whether the result is correct, and a failure
 * files a report without standing in your way, because a wrong result is a bug
 * in the app rather than a mistake by the person following the instructions.
 */
function poll() {
  const step = T.lesson?.steps[T.index];
  if (!step || T.marks[T.index]) return;
  let ok = false;
  try {
    ok = !!step.done(snapshot());
  } catch (err) {
    file('threw', `The step's own condition threw: ${err.message}`);
    return;
  }
  if (!ok) return;

  T.marks[T.index] = 'done';
  tick(step.covers);
  remember();

  if (step.check) {
    let verdict = true;
    let why = '';
    try {
      const r = step.check(snapshot());
      verdict = r === true || r === undefined;
      if (typeof r === 'string') {
        verdict = false;
        why = r;
      }
    } catch (err) {
      verdict = false;
      why = `the check threw: ${err.message}`;
    }
    if (!verdict) {
      T.marks[T.index] = 'wrong';
      file('wrong', why || 'The step was done and the result was not what it should be.');
    }
  }

  const errs = api.getState().result?.errors || [];
  if (errs.length) file('errors', errs.map((e) => e.message).join(' | '));

  render();
  spotlight();
}

/**
 * The model as a lesson sees it.
 *
 * Steps are data and should not have to know how the application stores
 * anything, so everything they are likely to ask is answered here, and the
 * measurements they compare against are taken the same way every time.
 */
function snapshot() {
  const s = api.getState();
  const bodies = s.result?.bodies || [];
  const doc = s.doc || {};
  const volume = () => {
    let v = 0;
    for (const b of bodies) {
      try {
        if (b.solid) v += b.solid.volume();
      } catch {
        /* a body mid rebuild has no volume worth reporting */
      }
    }
    return v;
  };
  return {
    doc,
    result: s.result,
    records: s.records || [],
    selection: s.selection,
    bodies,
    before: T.before,
    features: (type) => (doc.features || []).filter((f) => f.type === type),
    has: (type) => (doc.features || []).some((f) => f.type === type),
    last: (type) => [...(doc.features || [])].reverse().find((f) => f.type === type) || null,
    sketches: () => Object.values(doc.sketches || {}),
    bodyCount: () => bodies.length,
    faceCount: () => (s.records || []).reduce((a, r) => a + (r.topology?.faces.length || 0), 0),
    volume,
    // What the model did while this step was current, which is what a check is
    // usually about: not that a feature exists, but that it changed the right
    // amount of the right thing.
    volumeDelta: () => volume() - (T.before?.volume ?? volume()),
    bodyDelta: () => bodies.length - (T.before?.bodies ?? bodies.length),
    errors: () => (s.result?.errors || []).map((e) => e.message),
    /*
     * Has this been run since the step began?
     *
     * The weaker of the two conditions, and the honest one for a third of the
     * toolset: an analysis paints the screen, a selection rule changes what is
     * picked, an export opens a file dialog, and none of them leave anything
     * in the document to assert on. Where there is something better to ask,
     * ask that instead.
     */
    ran: (id) => T.recent.slice(T.since).some((r) => r.id === id),
    ranAny: (ids) => T.recent.slice(T.since).some((r) => ids.includes(r.id)),
    selected: () => ({
      faces: s.selection?.faces.size || 0,
      edges: s.selection?.edges.size || 0,
      bodies: s.selection?.bodies.size || 0
    })
  };
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

/**
 * What went wrong, written down so it can be reproduced without a conversation.
 *
 * The document is the whole of it, because a fault in a modelling program is
 * almost never about the click and almost always about the state it happened
 * in.
 */
function file(kind, why) {
  const step = T.lesson?.steps[T.index];
  const report = {
    when: new Date().toISOString(),
    chapter: T.lesson?.id,
    title: T.lesson?.title,
    step: T.index,
    say: step?.say,
    kind,
    why,
    commands: T.recent.slice(-12),
    errors: api.getState().result?.errors?.map((e) => e.message) || [],
    doc: safeDoc()
  };
  T.reports.push(report);
  render();
  return report;
}

function safeDoc() {
  try {
    // Pictures are megabytes of base64 and say nothing about a fault, so the
    // report keeps their names and drops their contents.
    const doc = JSON.parse(JSON.stringify(api.getState().doc || {}));
    for (const key of Object.keys(doc.imageData || {})) {
      doc.imageData[key] = { dropped: true };
    }
    for (const key of Object.keys(doc.meshData || {})) {
      doc.meshData[key] = { dropped: true };
    }
    return doc;
  } catch (err) {
    return { unreadable: err.message };
  }
}

export async function saveReports() {
  if (!T.reports.length) {
    api.setStatus('Nothing has gone wrong yet.');
    return;
  }
  const name = `anvil-teacher-${T.lesson?.id || 'session'}`;
  await api.exportText(name, 'json', 'Teacher report', JSON.stringify(T.reports, null, 2));
  api.setStatus(`${T.reports.length} report${T.reports.length === 1 ? '' : 's'} written.`);
}

export function reports() {
  return T.reports;
}

/* ------------------------------------------------------------------ */
/* Blocking                                                            */
/* ------------------------------------------------------------------ */

/**
 * While a step is live, the ribbon does what the step says and nothing else.
 *
 * Refused out loud rather than in silence. A button that does nothing when
 * pressed reads as a broken button, and this whole mode exists to tell broken
 * apart from not-yet.
 */
function guardClick(e) {
  if (!blocking()) return;
  const el = e.target.closest?.('[data-cmd], [data-menu], [data-tool], [data-con]');
  if (!el) return;
  if (live(el)) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  if (e.type === 'click') {
    const step = T.lesson.steps[T.index];
    api.setStatus(`Not yet. ${step.say}`);
    flashRing();
  }
}

function guardKey(e) {
  if (!blocking()) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  // Everything that is not a command: leaving, undoing, moving about, and
  // answering a dialog.
  if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'Tab') return;
  if (e.key.startsWith('Arrow') || e.key === 'Delete' || e.key === 'Backspace') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length !== 1) return;
  // The shortcut for the step's own command is allowed, and the application
  // writes it into the button's tooltip, so there is no second table of them
  // here to fall out of step with the first.
  if (e.key.toLowerCase() === shortcutForStep()) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  flashRing();
}

function blocking() {
  if (!T.open || T.auto) return false;
  const step = T.lesson?.steps[T.index];
  return !!step && !T.marks[T.index] && T.lesson.block !== false;
}

function live(el) {
  for (const sel of ALWAYS_LIVE) if (el.closest(sel)) return true;
  const real = targetReal();
  if (!real) return true;
  // The real button, the pinned icon that stands in for it, and the group that
  // holds them both. All three are the same intention arriving by a different
  // route, and refusing any of them makes the step impossible to finish.
  for (const t of [real, targetEl()]) {
    if (t && (el === t || t.contains(el) || el.contains(t))) return true;
  }
  const group = real.closest('.group');
  if (group && group.contains(el)) return true;
  // A step that points into a family menu has to let the menu be opened, and
  // then the item inside it.
  const step = T.lesson.steps[T.index];
  if (step.point?.menu && el.dataset?.menu === step.point.menu) return true;
  if (step.point?.menu && el.closest('.ribbon-menu')) return true;
  return false;
}

function shortcutForStep() {
  const target = targetReal();
  const title = target?.getAttribute('title') || '';
  const m = title.match(/\(([A-Za-z])\)\s*$/);
  return m ? m[1].toLowerCase() : null;
}

/* ------------------------------------------------------------------ */
/* Pointing                                                            */
/* ------------------------------------------------------------------ */

/**
 * The button the step is about, whether or not anybody can see it.
 *
 * This is the one the block measures against, because a person working through
 * a folded group clicks the real button inside the popover, not the group's
 * name that got them there.
 */
function targetReal() {
  const step = T.lesson?.steps[T.index];
  if (!step || !step.point) return null;
  const p = step.point;
  if (typeof p === 'string') return document.querySelector(p);
  if (p.cmd) {
    return (
      document.querySelector(`[data-cmd="${p.cmd}"]`) ||
      (p.menu ? document.querySelector(`[data-menu="${p.menu}"]`) : null)
    );
  }
  if (p.menu) return document.querySelector(`[data-menu="${p.menu}"]`);
  if (p.tool) return document.querySelector(`[data-tool="${p.tool}"]`);
  if (p.con) return document.querySelector(`[data-con="${p.con}"]`);
  return null;
}

/** And the thing on screen that stands for it, which is what the ring goes round. */
function targetEl() {
  return visible(targetReal());
}

/**
 * The thing on screen that stands for a button.
 *
 * The ribbon keeps the first few commands of each group out on the bar as bare
 * icons and folds the rest into a popover behind the group's name, so the
 * button a step names is usually not the thing anybody can see or press: it
 * sits in a closed popup with no box at all, and a ring drawn round it lands
 * in the corner of the window with nothing under it.
 *
 * So the ring follows what is actually visible. The pinned icon if there is
 * one, the group's own name if there is not, and the real button once the
 * group has been opened and it has somewhere to be.
 */
function visible(el) {
  if (!el || el.offsetParent) return el;
  const id = el.dataset.cmd || el.dataset.tool || el.dataset.menu || el.dataset.con;
  const pin = id ? document.querySelector(`[data-pin-for="${id}"]`) : null;
  if (pin?.offsetParent) return pin;
  const trigger = el.closest('.group')?.querySelector('.grp-trigger');
  return trigger?.offsetParent ? trigger : el;
}

/** A ring round the control the step is about, and the model it is about. */
function spotlight() {
  clearRing();
  const step = T.lesson?.steps[T.index];
  if (!step || T.marks[T.index]) {
    api.highlight?.(null);
    return;
  }

  const el = targetEl();
  if (el && el.offsetParent) {
    el.classList.add('teacher-target');
    const r = el.getBoundingClientRect();
    const ring = document.createElement('div');
    ring.className = 'teacher-ring';
    ring.style.left = `${r.left - 4}px`;
    ring.style.top = `${r.top - 4}px`;
    ring.style.width = `${r.width + 8}px`;
    ring.style.height = `${r.height + 8}px`;
    document.body.appendChild(ring);
    T.ring = ring;
  }

  // Geometry the step wants pointed at, worked out by the step itself because
  // only it knows which face of which body it means.
  if (step.show) {
    try {
      api.highlight?.(step.show(snapshot()));
    } catch {
      api.highlight?.(null);
    }
  } else {
    api.highlight?.(null);
  }
}

function clearRing() {
  if (T.ring) T.ring.remove();
  T.ring = null;
  for (const el of document.querySelectorAll('.teacher-target')) {
    el.classList.remove('teacher-target');
  }
}

function flashRing() {
  if (!T.ring) return;
  T.ring.classList.remove('flash');
  // Reading the layout is what restarts the animation; without it a second
  // refusal in a row does nothing visible and reads as the app ignoring you.
  void T.ring.offsetWidth;
  T.ring.classList.add('flash');
}

export function reposition() {
  if (T.open) spotlight();
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

function buildPanel() {
  if (T.panel) {
    T.panel.classList.remove('hidden');
    return;
  }
  const el = document.createElement('div');
  el.id = 'teacher';
  el.innerHTML = `
    <div class="teacher-head">
      <span class="teacher-chapter"></span>
      <button class="teacher-x" title="Leave the lesson">&#10005;</button>
    </div>
    <div class="teacher-body">
      <div class="teacher-count"></div>
      <div class="teacher-say"></div>
      <div class="teacher-note"></div>
    </div>
    <div class="teacher-foot">
      <button class="teacher-back" title="The step before">Back</button>
      <button class="teacher-skip" title="Could not do it. Files a report.">Skip</button>
      <button class="teacher-save hidden" title="Write the reports out as a file">Save reports</button>
      <span class="teacher-ledger"></span>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('.teacher-x').addEventListener('click', () => close());
  el.querySelector('.teacher-skip').addEventListener('click', () => skip());
  el.querySelector('.teacher-back').addEventListener('click', () => back());
  el.querySelector('.teacher-save').addEventListener('click', () => saveReports());
  T.panel = el;
}

function render(done = false) {
  if (!T.panel) return;
  const total = T.lesson?.steps.length || 0;
  T.panel.querySelector('.teacher-chapter').textContent = T.lesson?.title || '';

  if (done || T.index >= total) {
    T.panel.querySelector('.teacher-count').textContent = 'Finished';
    T.panel.querySelector('.teacher-say').textContent =
      `${T.lesson.title} is built. ${T.marks.filter((m) => m === 'done').length} of ${total} steps done.`;
  } else {
    const step = T.lesson.steps[T.index];
    T.panel.querySelector('.teacher-count').textContent = `Step ${T.index + 1} of ${total}`;
    T.panel.querySelector('.teacher-say').textContent = step.say;
  }

  const mark = T.marks[T.index];
  const note = T.panel.querySelector('.teacher-note');
  note.className = `teacher-note ${mark || ''}`;
  note.textContent =
    mark === 'done'
      ? 'Done.'
      : mark === 'wrong'
        ? 'Done, but the result is wrong. Written down.'
        : mark === 'skipped'
          ? 'Skipped, and written down.'
          : '';

  // The way on is the same gesture whether it went right or wrong, because a
  // wrong result is the app's fault and must not hold the lesson up.
  const next = T.panel.querySelector('.teacher-next');
  if (mark && !next && T.index < total) {
    const b = document.createElement('button');
    b.className = 'teacher-next accent';
    b.textContent = 'Next';
    b.addEventListener('click', () => {
      b.remove();
      advance();
    });
    T.panel.querySelector('.teacher-foot').appendChild(b);
  }
  if (!mark && next) next.remove();

  // The way out of a session with faults in it. Hidden until there is
  // something to write, because a button that writes nothing is a button that
  // teaches you not to press it.
  T.panel.querySelector('.teacher-save').classList.toggle('hidden', !T.reports.length);

  const l = ledger();
  T.panel.querySelector('.teacher-ledger').textContent =
    `${l.ticked} of ${l.total} tools` + (T.reports.length ? ` · ${T.reports.length} logged` : '');
}

/* ------------------------------------------------------------------ */
/* The auto-player                                                     */
/* ------------------------------------------------------------------ */

/**
 * Walk a chapter with nobody watching.
 *
 * Every step already says what it wants and how to know it happened, so a step
 * that also says how to do it can be played. That is what the probes in
 * `tools/` do by hand, and it means a chapter is checked before anybody is
 * asked to sit through it: a step whose condition never comes true under the
 * player is either a broken lesson or a broken feature, and either way it is
 * found in a batch run rather than at step fourteen on a Sunday.
 */
/**
 * What a step does when it has not said how to play itself.
 *
 * Almost every step in the campaign is the same gesture: press the thing the
 * ring is round, answer the dialog it opens by accepting what it offers, and
 * let the condition decide whether that worked. Writing that out three hundred
 * times would be three hundred chances to write it slightly differently, so it
 * is written once and steps that need something else say so.
 *
 * A step that cannot be played this way comes back marked `never`, which is
 * the auto-player earning its keep: either the lesson needs a script or the
 * feature is broken, and both are worth knowing before anybody sits through it.
 *
 * On the campaign as it stands this reaches about a fifth of the steps, and the
 * rest want geometry picked or a dialog filled with real numbers. Selecting
 * something plausible first was tried, the biggest flat face or every outside
 * edge depending on the command, and moved the figure by one step out of two
 * hundred and thirty three, so it is not here. What the remaining steps want is
 * a `play` of their own, written the way the probes in `tools/` are.
 */
async function press(step) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // A folded group has to be opened before what is inside it can be pressed.
  const real = targetReal();
  const shown = targetEl();
  if (shown && shown !== real && shown.classList.contains('grp-trigger')) {
    shown.click();
    await wait(80);
  }
  (real || shown)?.click();
  await wait(220);
  await answer();
}

/** Accept whatever a dialog is offering, which is what a default is for. */
async function answer() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const panel = document.getElementById('inspector');
  if (!panel || panel.classList.contains('hidden')) return;
  document.getElementById('inspectorOk')?.click();
  await wait(320);
}

export async function play(lesson, { pause = 40 } = {}) {
  // From the top, and on whatever document is open rather than seeding one:
  // the player is checking the steps, not rehearsing the chapter.
  openChapter(lesson, { resume: false, seed: false });
  T.auto = true;
  // Where this chapter's reports start. Handing back every report ever filed
  // made each chapter look like it had inherited the faults of the one before,
  // which is a confident way to send somebody hunting the wrong thing.
  const from = T.reports.length;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  for (let i = 0; i < lesson.steps.length; i++) {
    T.index = i;
    T.marks[i] = null;
    T.since = T.recent.length;
    T.before = snapshot();
    const step = lesson.steps[i];
    let err = null;
    try {
      if (step.play) await step.play({ ...snapshot(), wait, api, press, answer });
      else await press(step);
    } catch (e) {
      err = e.message;
    }
    await wait(pause);
    poll();
    out.push({
      step: i,
      say: step.say,
      played: step.play ? 'script' : 'default',
      mark: T.marks[i] || 'never',
      error: err
    });
  }
  T.auto = false;
  const reportsMade = T.reports.slice(from);
  close();
  return { chapter: lesson.id, steps: out, reports: reportsMade };
}
