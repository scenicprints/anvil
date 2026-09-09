'use strict';

const { app, BrowserWindow, protocol, ipcMain, dialog, shell } = require('electron');
const LIB = require('./library.js');
const PROFILES = require('./profiles.js');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEME = 'anvil';

// Serve the renderer over a custom scheme rather than file://. WebAssembly
// instantiation and ES module imports both need a real origin; file:// gives
// neither and the manifold kernel will not load.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

const TEST_MODE = process.argv.includes('--anvil-test');

// Screenshot mode: boot the real editor, run a script against the page, save a
// PNG, exit. Used to check that the viewport actually draws what the kernel
// produced, which no headless assertion can tell you.
const shotArg = process.argv.indexOf('--anvil-shot');
const SHOT_MODE = shotArg >= 0;
const shotOut = SHOT_MODE ? process.argv[shotArg + 1] : null;
const scriptArg = process.argv.indexOf('--anvil-script');
const shotScript = scriptArg >= 0 ? process.argv[scriptArg + 1] : null;

let win = null;

// Path of the document currently open in the window, or null for untitled.
let currentPath = null;

function resolveWithin(relative) {
  const target = path.join(ROOT, decodeURIComponent(relative));
  const normalized = path.normalize(target);
  if (!normalized.startsWith(ROOT)) return null;
  return normalized;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function registerProtocol() {
  // Files are read through Node rather than handed to net.fetch, because once
  // the app is packaged they live inside an asar archive. Node's fs sees
  // through that; Chromium's network stack does not.
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const rel = pathname === '/' ? '/src/renderer/index.html' : pathname;
    const file = resolveWithin(rel);
    if (!file) return new Response('Forbidden', { status: 403 });

    try {
      const data = await fs.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(data, {
        status: 200,
        headers: { 'content-type': type, 'cache-control': 'no-cache' }
      });
    } catch (err) {
      const status = err.code === 'ENOENT' ? 404 : 500;
      return new Response(`${err.code || 'Error'}: ${rel}`, { status });
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1b1d21',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (TEST_MODE) {
    win.loadURL(`${SCHEME}://anvil/test/harness.html`);
  } else {
    // A hidden window composites lazily, so capturePage can hand back a frame
    // from several states ago. Screenshot runs show the window for that reason.
    win.once('ready-to-show', () => win.show());
    win.loadURL(`${SCHEME}://anvil/src/renderer/index.html`);
  }

  if (SHOT_MODE) runShot();


  if (process.argv.includes('--anvil-debug')) {
    const levels = ['verbose', 'info', 'warning', 'error'];
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const where = sourceId ? ` (${sourceId.split('/').pop()}:${line})` : '';
      process.stdout.write(`[renderer:${levels[level] || level}] ${message}${where}\n`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      process.stdout.write(`[renderer gone] ${JSON.stringify(details)}\n`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      process.stdout.write(`[load failed] ${code} ${desc} ${url}\n`);
    });
  }

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  /*
   * Unsaved work is asked about here rather than in the page, because Electron
   * gives beforeunload no dialog of its own: preventing it cancels the close
   * and tells nobody. This asks, acts on the answer, and above all always ends
   * up closing if anything goes wrong. A window that cannot be shut is worse
   * than a lost edit.
   */
  win.on('close', (e) => {
    if (closing || TEST_MODE || SHOT_MODE) return;
    e.preventDefault();
    confirmClose().catch(() => {
      closing = true;
      if (win) win.destroy();
    });
  });

  win.on('closed', () => {
    win = null;
  });
}

async function runShot() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));

    // The kernel is WebAssembly and loads after the page does.
    for (let i = 0; i < 100; i++) {
      const ready = await win.webContents.executeJavaScript(
        'Boolean(window.anvilDev && window.anvilDev.ready())'
      );
      if (ready) break;
      await wait(100);
    }

    if (shotScript) {
      const code = await fs.readFile(shotScript, 'utf8');
      const result = await win.webContents.executeJavaScript(
        `(async () => { ${code} })()`
      );
      if (result !== undefined) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
    }

    // Give the compositor a settled frame to hand back.
    await wait(900);
    const summary = await win.webContents.executeJavaScript(
      'JSON.stringify({features: window.anvilDev.state.doc.features.length,' +
        ' bodies: window.anvilDev.bodies.length,' +
        ' status: document.getElementById("solveState").textContent})'
    );
    process.stdout.write(`At capture: ${summary}\n`);

    const image = await win.webContents.capturePage();
    await fs.writeFile(shotOut, image.toPNG());
    process.stdout.write(`Saved ${shotOut}\n`);
    clearRecovery();
    app.exit(0);
  } catch (err) {
    process.stderr.write(`Screenshot failed: ${err.stack || err.message}\n`);
    clearRecovery();
    app.exit(1);
  }
}

// Set once the answer is in, so the second close attempt goes straight through.
let closing = false;

// When this process last wrote the open document, so a change made somewhere
// else can be told from one of our own.
let lastWrittenAt = null;

/** Ask about unsaved work, then close. Any failure closes anyway. */
async function confirmClose() {
  // Asking the page whether it is dirty must never be what keeps the window
  // open. If it does not answer promptly, treat it as clean and close.
  const withTimeout = (promise, ms, fallback) =>
    Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
    ]);

  let dirty = false;
  try {
    dirty = await withTimeout(
      win.webContents.executeJavaScript(
        'Boolean(window.anvilDev && window.anvilDev.isDirty && window.anvilDev.isDirty())'
      ),
      2000,
      false
    );
  } catch {
    dirty = false;
  }

  if (dirty) {
    const name = currentPath ? path.basename(currentPath) : 'this model';
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Save', "Don't save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Anvil',
      message: `Save changes to ${name} before closing?`,
      detail: 'Unsaved changes will be lost.'
    });

    if (response === 2) return;
    if (response === 0) {
      let saved = false;
      try {
        saved = await win.webContents.executeJavaScript('window.anvilDev.saveNow()');
      } catch {
        saved = false;
      }

      // A save that was cancelled or failed leaves the window open, because
      // closing now would throw the work away after being asked to keep it.
      if (!saved) return;
    }
  }

  closing = true;
  win.close();
}

/* ------------------------------------------------------------------ */
/* Crash recovery                                                      */
/* ------------------------------------------------------------------ */

/*
 * What is written between saves, so that a crash costs minutes rather than an
 * evening.
 *
 * It is not a save and must never behave like one. It does not touch the
 * document, does not clear the dirty flag, does not bump the version counter
 * and does not take a lock: the file on disk is exactly what the person last
 * chose to write, and this sits beside it in the application's own folder
 * saying "there was more".
 *
 * Kept per window rather than per document, because the case it exists for is
 * the one where there is no document yet: an hour into a new part that has
 * never been saved is the work that hurts most to lose, and it is the only work
 * that nothing else in the system is holding on to.
 *
 * The file is removed on a clean exit. Anything left behind is therefore, by
 * definition, an exit that was not clean, which is what makes the offer at
 * startup trustworthy: it never appears when nothing went wrong.
 */
const RECOVERY_MS = 20 * 1000;
const sessionId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const recoveryDir = () => path.join(app.getPath('userData'), 'recovery');
const recoveryPath = (id) => path.join(recoveryDir(), `${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.json`);

async function writeRecovery(doc) {
  try {
    await fs.mkdir(recoveryDir(), { recursive: true });
    await writeAtomic(
      recoveryPath(sessionId),
      JSON.stringify({
        session: sessionId,
        path: currentPath,
        title: doc?.name || null,
        profile: activeProfile()?.name || null,
        at: Date.now(),
        doc
      })
    );
    return true;
  } catch {
    // A recovery file that cannot be written must never stop the work. It is
    // insurance, and insurance that interrupts is worse than none.
    return false;
  }
}

function clearRecovery() {
  try {
    fsSync.unlinkSync(recoveryPath(sessionId));
  } catch {
    /* there was none, which is where we wanted to get to */
  }
}

ipcMain.handle('doc:autosave', async (_e, doc) => ({ ok: await writeRecovery(doc) }));
ipcMain.handle('doc:recoveryDone', async () => {
  clearRecovery();
  return { ok: true };
});
ipcMain.handle('doc:recoveryInterval', async () => RECOVERY_MS);

/**
 * Anything left over from a session that did not end tidily.
 *
 * Its own session is skipped, or this window would offer to recover the work it
 * is doing right now. Anything older than a fortnight is thrown away rather
 * than offered: a file that old is from a crash somebody has long since worked
 * around, and being asked about it every morning is how a real offer starts
 * being dismissed without reading.
 */
ipcMain.handle('doc:recoverable', async () => {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(recoveryDir(), { withFileTypes: true });
  } catch {
    return { ok: true, found: [] };
  }
  const fortnight = 14 * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const full = path.join(recoveryDir(), entry.name);
    let got = null;
    try {
      got = JSON.parse(await fs.readFile(full, 'utf8'));
    } catch {
      // Unreadable, which most likely means it was being written when the
      // power went. There is nothing here to offer.
      try {
        await fs.unlink(full);
      } catch {
        /* leave it */
      }
      continue;
    }
    if (!got || got.session === sessionId || !got.doc) continue;
    if (Date.now() - (got.at || 0) > fortnight) {
      try {
        await fs.unlink(full);
      } catch {
        /* leave it */
      }
      continue;
    }
    out.push({
      session: got.session,
      path: got.path || null,
      title: got.title || (got.path ? path.basename(got.path) : 'an unsaved model'),
      profile: got.profile || null,
      at: got.at || 0
    });
  }
  out.sort((a, b) => b.at - a.at);
  return { ok: true, found: out };
});

ipcMain.handle('doc:recover', async (_e, session) => {
  try {
    const got = JSON.parse(await fs.readFile(recoveryPath(session), 'utf8'));
    if (!got?.doc) return { ok: false, error: 'There is nothing in that recovery file' };
    return { ok: true, path: got.path || null, at: got.at || 0, data: got.doc };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('doc:discardRecovery', async (_e, session) => {
  try {
    await fs.unlink(recoveryPath(session));
  } catch {
    /* already gone */
  }
  return { ok: true };
});

function setTitle() {
  if (!win) return;
  const name = currentPath ? path.basename(currentPath) : 'Untitled';
  win.setTitle(`${name} - Anvil`);
}

app.whenReady().then(() => {
  loadProfiles();
  registerProtocol();
  createWindow();
  setTitle();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ */
/* Document IPC                                                        */
/* ------------------------------------------------------------------ */

const DOC_FILTERS = [
  { name: 'Anvil Model', extensions: ['anvil'] },
  { name: 'All Files', extensions: ['*'] }
];

ipcMain.handle('doc:new', async () => {
  currentPath = null;
  setTitle();
  return { ok: true };
});

/**
 * Read a file, and say so if it is taking a while.
 *
 * OneDrive's Files On-Demand leaves a file on disk as a placeholder until
 * something touches it, and the touch is what downloads it. So a read is not
 * either instant or a failure: it can be a slow read of a file that is really
 * there and on its way. Saying nothing for thirty seconds looks exactly like a
 * hang, and a timeout that gave up would turn a working library into a broken
 * one the first time somebody opened a part they had not used on this machine.
 *
 * So it waits as long as it takes and tells the window what it is waiting for.
 */
async function readMaybeSlowly(file) {
  const slow = setTimeout(() => {
    try {
      win?.webContents.send('doc:slowRead', { path: file });
    } catch {
      /* the window may be gone, and the read carries on regardless */
    }
  }, 1200);
  try {
    return await fs.readFile(file, 'utf8');
  } finally {
    clearTimeout(slow);
    try {
      win?.webContents.send('doc:slowRead', null);
    } catch {
      /* as above */
    }
  }
}

/**
 * Open a document and take it as the one being worked on.
 *
 * One body for both ways in, because the difference between them is only
 * whether a dialog picked the file, and everything after that has to be the
 * same: the same lock, the same version, the same entry in recents.
 */
async function openDocument(file) {
  try {
    const text = await readMaybeSlowly(file);
    const held = await foreignLock(file);
    if (currentPath && currentPath !== file) await dropLock(currentPath);
    currentPath = file;
    lastWrittenAt = await modifiedAt(file);
    await takeLock(file);
    beatLock();
    setTitle();
    const data = JSON.parse(text);
    // What was on disk when this was read, which is what a later save has to
    // check it is still writing on top of.
    loadedVersion = Number(data?.version) || 0;
    rememberOpened(file, data);
    await noteInIndex(file, data);
    return { ok: true, path: file, name: libraryNameFor(file), data, held };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('doc:open', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open Model',
    filters: DOC_FILTERS,
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const file = res.filePaths[0];
  return openDocument(file);
});

/**
 * Read a vector file in to be traced into a sketch.
 *
 * Deliberately not `doc:open`: importing must not become the document's path,
 * or the next Ctrl+S writes the model over the SVG it was drawn from.
 */
ipcMain.handle('import:vector', async (_e, kind) => {
  const filters =
    kind === 'dxf'
      ? [{ name: 'DXF', extensions: ['dxf'] }]
      : [{ name: 'SVG', extensions: ['svg'] }];
  const res = await dialog.showOpenDialog(win, {
    title: kind === 'dxf' ? 'Insert DXF' : 'Insert SVG',
    filters,
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const file = res.filePaths[0];
  try {
    const text = await fs.readFile(file, 'utf8');
    return { ok: true, path: file, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Another Anvil document, read without opening it.
 *
 * The difference from `doc:open` is the whole point: this reads a file so the
 * document that is already open can take something out of it, and the file
 * being read is never made current, never locked and never saved to. Getting
 * that wrong would mean inserting a part quietly took over from the assembly
 * being built.
 *
 * A path can be given, which is how a derived part is refreshed later without
 * asking again, and only a path that ends in .anvil is read.
 */
/** What an Anvil document is called, and what a file cannot be called. */
const DOC_EXT = /\.anvil$/i;
const BAD_NAME = /[\\/:*?"<>|]/;

/*
 * The library: one folder a profile points at, and the reason a design can name
 * another design at all.
 *
 * A path is not a name. The same two files on a laptop and a desktop sit under
 * different roots, and a link recorded as an absolute path works on exactly one
 * machine. Recorded against the library root it is the same name everywhere,
 * and the root is the only thing each machine has to know for itself.
 *
 * All of it lives here rather than in the renderer because it is a fact about
 * this installation, not about the document, and because resolving a name has
 * to happen where the files are.
 */
const profileFile = () => path.join(app.getPath('userData'), 'profiles.json');
const oldRootFile = () => path.join(app.getPath('userData'), 'library.json');

let profiles = PROFILES.EMPTY;

function saveProfiles() {
  try {
    fsSync.writeFileSync(profileFile(), JSON.stringify(profiles, null, 2), 'utf8');
  } catch {
    /* a profile that cannot be written must not stop the work */
  }
}

/**
 * Read the profiles, or make the first one.
 *
 * The upgrade matters more than the first run. Somebody already has a library
 * folder set from before profiles existed, and losing it would look exactly
 * like losing the library: every derived link in every document would stop
 * resolving by name on the next open. So the old single-folder file is read
 * once and becomes the first profile's root.
 */
function loadProfiles() {
  let store = null;
  try {
    store = JSON.parse(fsSync.readFileSync(profileFile(), 'utf8'));
  } catch {
    /* nothing yet, which is either a first run or an upgrade */
  }
  let inherited = null;
  if (!store) {
    try {
      const old = JSON.parse(fsSync.readFileSync(oldRootFile(), 'utf8'));
      if (old && typeof old.root === 'string') inherited = old.root;
    } catch {
      /* no old setting either */
    }
  }
  const before = JSON.stringify(store);
  profiles = PROFILES.firstRun(store, {
    name: os.userInfo?.().username || 'Me',
    root: inherited
  });
  if (JSON.stringify(profiles) !== before) saveProfiles();
}

const activeProfile = () => PROFILES.active(profiles);
const libraryRoot = () => activeProfile()?.root || null;

/** The two library questions, asked against whichever root is in use. */
const libraryNameFor = (file) => LIB.libraryNameFor(libraryRoot(), file);
const libraryPathFor = (name) => LIB.libraryPathFor(libraryRoot(), name);

/* ---------------------------------------------------------------- */
/* The index, which is a cache and never the truth                   */
/* ---------------------------------------------------------------- */

const indexPath = () => {
  const root = libraryRoot();
  return root ? path.join(root, LIB.INDEX_FILE) : null;
};

async function readIndex() {
  const file = indexPath();
  if (!file) return LIB.normaliseIndex(null);
  try {
    return LIB.normaliseIndex(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    // Missing, or written by a version that thought differently. Either way it
    // is a cache, so the answer is to rebuild rather than to complain.
    return LIB.normaliseIndex(null);
  }
}

async function writeIndex(index) {
  const file = indexPath();
  if (!file) return;
  try {
    await writeAtomic(file, JSON.stringify(index, null, 2));
  } catch {
    /* an index that cannot be written is an index that gets rebuilt */
  }
}

/**
 * Every document under the library root, by walking.
 *
 * Walking and not reading. `readdir` and `stat` do not pull a synced file down,
 * and opening one does, so a list of three hundred parts must never be the
 * thing that downloads three hundred parts.
 */
async function walkLibrary() {
  const root = libraryRoot();
  if (!root) return [];
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (DOC_EXT.test(entry.name)) {
        const name = libraryNameFor(full);
        if (!name) continue;
        out.push({ name, path: full, modified: await modifiedAt(full), ...LIB.placeOf(name) });
      }
    }
  };
  await walk(root, 0);
  return out;
}

/** The library as it stands, with the index folded in and written back. */
async function libraryState() {
  const found = await walkLibrary();
  const index = LIB.mergeIndex(await readIndex(), found);
  await writeIndex(index);
  const byName = new Map(found.map((f) => [f.name, f.path]));
  return {
    root: libraryRoot(),
    documents: index.documents.map((d) => ({ ...d, path: byName.get(d.name) || null })),
    index
  };
}

/** Note what opening a document taught us, so a search need not open it again. */
async function noteInIndex(file, doc) {
  const name = libraryNameFor(file);
  if (!name) return;
  const index = LIB.noteDocument(await readIndex(), {
    name,
    ...LIB.placeOf(name),
    modified: await modifiedAt(file),
    title: doc?.name || LIB.titleFromName(name),
    parameters: (doc?.parameters || []).map((p) => p.name).filter(Boolean)
  });
  await writeIndex(index);
}

/* ---------------------------------------------------------------- */
/* Profiles, projects and recents, over the wire                     */
/* ---------------------------------------------------------------- */

/*
 * Profile pictures.
 *
 * Kept as files beside the profile store rather than as base64 inside it. A
 * store that has to stay legible in a text editor is one of the few things
 * standing between somebody and a broken install they cannot fix by hand, and a
 * wall of base64 is the end of that.
 *
 * On this machine and not in the library, because a profile is a per-machine
 * thing: the library holds parts, and an application's own furniture does not
 * belong in a folder somebody put their work in.
 */
const pictureDir = () => path.join(app.getPath('userData'), 'pictures');
const picturePath = (id) => path.join(pictureDir(), `${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.png`);

async function pictureFor(id) {
  try {
    const buf = await fs.readFile(picturePath(id));
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    // No picture is the ordinary case, not a failure. Nobody has to have one.
    return null;
  }
}

ipcMain.handle('profiles:list', async () => ({
  profiles: await Promise.all(
    profiles.profiles.map(async (p) => ({
      id: p.id,
      name: p.name,
      root: p.root,
      picture: await pictureFor(p.id)
    }))
  ),
  active: profiles.active,
  // Asked once at startup, and only worth asking when there is a choice.
  ask: profiles.profiles.length > 1
}));

/**
 * Set a profile's picture, from bytes the window has already made square.
 *
 * The scaling happens up there because that is where there is a canvas to do it
 * with, and because it means nothing arrives here that has to be trusted to be
 * a sensible size: a cap on the bytes is the last word either way.
 */
ipcMain.handle('profiles:setPicture', async (_e, opts) => {
  const id = opts?.id;
  if (!profiles.profiles.some((p) => p.id === id)) {
    return { ok: false, error: 'There is no profile by that name' };
  }
  const bytes = opts?.bytes;
  if (!bytes?.length) return { ok: false, error: 'That picture came through empty' };
  if (bytes.length > 512 * 1024) {
    return { ok: false, error: 'That picture is too big even after being scaled down' };
  }
  try {
    await fs.mkdir(pictureDir(), { recursive: true });
    await writeAtomicBytes(picturePath(id), Buffer.from(bytes));
    return { ok: true, picture: await pictureFor(id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('profiles:picture', async (_e, id) => ({ picture: await pictureFor(id) }));

ipcMain.handle('profiles:clearPicture', async (_e, id) => {
  try {
    await fs.unlink(picturePath(id));
  } catch {
    /* there was none, which is where we wanted to get to */
  }
  return { ok: true };
});

ipcMain.handle('profiles:use', async (_e, id) => {
  profiles = PROFILES.use(profiles, id);
  saveProfiles();
  return { ok: true, profile: activeProfile() };
});

ipcMain.handle('profiles:add', async (_e, name) => {
  const res = PROFILES.add(profiles, { name });
  if (res.error) return { ok: false, error: res.error };
  profiles = res.store;
  saveProfiles();
  return { ok: true, profile: res.profile };
});

ipcMain.handle('profiles:remove', async (_e, id) => {
  const before = profiles.profiles.length;
  profiles = PROFILES.remove(profiles, id);
  saveProfiles();
  // Only once it has actually gone. The last profile will not be removed, and
  // deleting the picture of one that is still there would be a puzzle nobody
  // could work out from the outside.
  if (profiles.profiles.length < before) {
    try {
      await fs.unlink(picturePath(id));
    } catch {
      /* it had none */
    }
  }
  return { ok: true, active: activeProfile() };
});

ipcMain.handle('profiles:recents', async () => {
  const p = activeProfile();
  if (!p) return { ok: true, recents: [] };
  // Checked against the disk before being shown. A recents list is a promise
  // that a click will open something, and a file that has been moved or deleted
  // breaks that promise every time it is offered.
  const alive = [];
  const gone = [];
  for (const r of p.recents) {
    const at = await modifiedAt(r.path);
    if (at === null) gone.push(r.path);
    else alive.push({ ...r, modified: at });
  }
  if (gone.length) {
    profiles = PROFILES.forget(profiles, p.id, gone);
    saveProfiles();
  }
  return { ok: true, recents: alive };
});

function rememberOpened(file, doc) {
  const p = activeProfile();
  if (!p || !file) return;
  profiles = PROFILES.remember(profiles, p.id, {
    path: file,
    name: libraryNameFor(file),
    title: doc?.name || null,
    at: Date.now()
  });
  saveProfiles();
}

ipcMain.handle('library:get', async () => ({
  root: libraryRoot(),
  profile: activeProfile() ? { id: activeProfile().id, name: activeProfile().name } : null
}));

ipcMain.handle('library:choose', async () => {
  const p = activeProfile();
  if (!p) return { ok: false, error: 'There is no profile to set a library for' };
  const res = await dialog.showOpenDialog(win, {
    title: `Choose the library folder for ${p.name}`,
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  profiles = PROFILES.update(profiles, p.id, { root: res.filePaths[0] });
  saveProfiles();
  return { ok: true, root: libraryRoot() };
});

ipcMain.handle('library:list', async () => {
  if (!libraryRoot()) return { ok: false, error: 'No library folder has been chosen yet' };
  const state = await libraryState();
  return { ok: true, root: state.root, documents: state.documents };
});

ipcMain.handle('library:search', async (_e, query) => {
  if (!libraryRoot()) return { ok: false, error: 'No library folder has been chosen yet' };
  const state = await libraryState();
  const byName = new Map(state.documents.map((d) => [d.name, d.path]));
  return {
    ok: true,
    results: LIB.searchIndex(state.index, query).map((d) => ({ ...d, path: byName.get(d.name) || null }))
  };
});

/**
 * Make a project, which is a folder with a note in it saying it is one.
 *
 * The note is what survives being copied to another machine or being found in
 * Explorer a year later. Anvil could infer a project from any folder under
 * `projects/`, and does when the note is missing, but a folder that says what
 * it is beats a convention nobody can see.
 */
ipcMain.handle('library:createProject', async (_e, name) => {
  const root = libraryRoot();
  if (!root) return { ok: false, error: 'No library folder has been chosen yet' };
  const clean = String(name || '').trim();
  if (!clean || BAD_NAME.test(clean)) {
    return { ok: false, error: 'That name has characters a folder cannot have' };
  }
  const dir = path.join(root, 'projects', clean);
  try {
    await fs.mkdir(dir, { recursive: true });
    const note = path.join(dir, 'project.json');
    try {
      await fs.access(note);
    } catch {
      await writeAtomic(
        note,
        JSON.stringify(
          { name: clean, id: `pr${Date.now().toString(36)}`, created: new Date().toISOString() },
          null,
          2
        )
      );
    }
    return { ok: true, project: clean, path: dir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** A folder inside a project, for when a project grows past one list. */
ipcMain.handle('library:createFolder', async (_e, opts) => {
  const root = libraryRoot();
  if (!root) return { ok: false, error: 'No library folder has been chosen yet' };
  const inside = libraryPathFor(String(opts?.within || 'projects'));
  const clean = String(opts?.name || '').trim();
  if (!inside) return { ok: false, error: 'That is not a place in the library' };
  if (!clean || BAD_NAME.test(clean)) {
    return { ok: false, error: 'That name has characters a folder cannot have' };
  }
  try {
    const dir = path.join(inside, clean);
    await fs.mkdir(dir, { recursive: true });
    return { ok: true, path: dir, name: libraryNameFor(dir) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Every project in the library, from the folders rather than from the index. */
ipcMain.handle('library:projects', async () => {
  const root = libraryRoot();
  if (!root) return { ok: false, error: 'No library folder has been chosen yet' };
  const dir = path.join(root, 'projects');
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { ok: true, projects: [] };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    let note = null;
    try {
      note = JSON.parse(await fs.readFile(path.join(dir, entry.name, 'project.json'), 'utf8'));
    } catch {
      /* a folder with no note is still a project, it just has less to say */
    }
    out.push({
      name: entry.name,
      title: note?.name || entry.name,
      id: note?.id || null,
      created: note?.created || null
    });
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return { ok: true, projects: out };
});

ipcMain.handle('doc:readAnother', async (_e, file) => {
  let target = file;
  if (!target) {
    const res = await dialog.showOpenDialog(win, {
      title: 'Insert from another document',
      filters: [{ name: 'Anvil', extensions: ['anvil'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    target = res.filePaths[0];
  }
  if (!/\.anvil$/i.test(target)) return { ok: false, error: 'That is not an Anvil document' };
  if (currentPath && path.resolve(currentPath) === path.resolve(target)) {
    return { ok: false, error: 'That is this document. A part cannot be derived from itself.' };
  }
  try {
    const text = await fs.readFile(target, 'utf8');
    const at = await modifiedAt(target);
    return { ok: true, path: target, name: libraryNameFor(target), text, modified: at };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * A linked document, found by its library name first and its path second.
 *
 * That order is the whole point. The name is the same on every machine, so it
 * is tried first and the path is only a fallback: for a link made before there
 * was a library, or to a file that sits outside it.
 */
ipcMain.handle('doc:readLinked', async (_e, opts) => {
  const name = opts?.name || null;
  const file = opts?.file || null;
  const byName = libraryPathFor(name);
  for (const target of [byName, file]) {
    if (!target) continue;
    try {
      const text = await fs.readFile(target, 'utf8');
      return {
        ok: true,
        path: target,
        name: libraryNameFor(target) || name,
        viaName: target === byName,
        text,
        modified: await modifiedAt(target)
      };
    } catch {
      /* try the next way of finding it */
    }
  }
  return {
    ok: false,
    error: name
      ? name + ' is not in the library, and the path it was linked by is gone too'
      : 'That linked document could not be found'
  };
});

/**
 * A mesh or an image off the disk, as bytes.
 *
 * Bytes rather than text, because an STL is usually binary and a 3MF is always
 * a zip. What to make of them is the renderer's business; this only opens the
 * file the person pointed at.
 */
ipcMain.handle('import:binary', async (_e, kind) => {
  const filters =
    kind === 'image'
      ? [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }]
      : [
          { name: 'Models', extensions: ['step', 'stp', 'stl', 'obj', '3mf'] },
          { name: 'STEP', extensions: ['step', 'stp'] },
          { name: 'Mesh', extensions: ['stl', 'obj', '3mf'] }
        ];
  const res = await dialog.showOpenDialog(win, {
    title: kind === 'image' ? 'Choose an image' : 'Insert Model',
    filters,
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const file = res.filePaths[0];
  try {
    const buf = await fs.readFile(file);
    return { ok: true, path: file, bytes: new Uint8Array(buf) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('doc:openPath', async (_e, file) => {
  return openDocument(file);
});

/* ------------------------------------------------------------------ */
/* Keeping a model in a folder that syncs                              */
/* ------------------------------------------------------------------ */

/**
 * Who is holding a document open.
 *
 * A folder that syncs is the cheapest hub there is, and the one thing it cannot
 * do is tell two machines about each other. A lock beside the document does,
 * and it is only ever advisory: it says who had it and when, and the person at
 * the second machine decides what that is worth.
 *
 * Stale by time rather than by tidiness, because an application that is killed
 * never gets to clean up after itself and a lock nobody can clear is worse than
 * no lock at all.
 */
/*
 * The version this document was at when it was read.
 *
 * The third of the three things that make two computers work. A modified time
 * catches most of it and trusts two machines' clocks to agree, which they do
 * not: a file written on the desktop can arrive on the laptop stamped a minute
 * in the past, and then a save here looks like the newer one and is not.
 *
 * A counter in the document has no such problem. It only ever goes up, and the
 * machine that wrote it is written down beside it, so a refusal can say who to
 * go and ask.
 */
let loadedVersion = 0;

const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_BEAT_MS = 30 * 1000;
let lockBeat = null;

const lockPathFor = (file) => `${file}.anvillock`;


function whoWeAre() {
  return {
    host: os.hostname(),
    user: os.userInfo?.().username || '',
    // The profile as well as the machine, because "Kevin on DESKTOP has this
    // open" is a sentence somebody can act on and a host name on its own is
    // not.
    profile: activeProfile()?.name || null,
    pid: process.pid
  };
}

async function readLock(file) {
  try {
    const text = await fs.readFile(lockPathFor(file), 'utf8');
    const got = JSON.parse(text);
    if (!got || typeof got.at !== 'number') return null;
    return got;
  } catch {
    return null;
  }
}

/** A lock held by someone else and still being refreshed, or null. */
async function foreignLock(file) {
  const got = await readLock(file);
  if (!got) return null;
  const mine = whoWeAre();
  if (got.host === mine.host && got.pid === mine.pid) return null;
  if (Date.now() - got.at > LOCK_STALE_MS) return null;
  return got;
}

async function takeLock(file) {
  if (!file) return;
  try {
    await fs.writeFile(
      lockPathFor(file),
      JSON.stringify({ ...whoWeAre(), at: Date.now() }),
      'utf8'
    );
  } catch {
    /* a lock that cannot be written must not stop the work */
  }
}

async function dropLock(file) {
  if (!file) return;
  try {
    const got = await readLock(file);
    const mine = whoWeAre();
    // Only ever remove our own, so a second machine's lock survives our exit.
    if (got && (got.host !== mine.host || got.pid !== mine.pid)) return;
    await fs.unlink(lockPathFor(file));
  } catch {
    /* already gone */
  }
}

function beatLock() {
  if (lockBeat) clearInterval(lockBeat);
  lockBeat = setInterval(() => {
    if (currentPath) takeLock(currentPath);
  }, LOCK_BEAT_MS);
}

app.on('before-quit', () => {
  if (lockBeat) clearInterval(lockBeat);
  // This is what makes the offer at startup trustworthy: a recovery file only
  // survives an exit that never got here.
  clearRecovery();
  // Synchronous, because the process is on its way out and a promise will not
  // be waited for.
  try {
    if (currentPath) {
      const got = JSON.parse(fsSync.readFileSync(lockPathFor(currentPath), 'utf8'));
      const mine = whoWeAre();
      if (got.host === mine.host && got.pid === mine.pid) {
        fsSync.unlinkSync(lockPathFor(currentPath));
      }
    }
  } catch {
    /* nothing to clear */
  }
});

ipcMain.handle('doc:heldByOther', async () => {
  if (!currentPath) return { held: false };
  const got = await foreignLock(currentPath);
  return got ? { held: true, ...got } : { held: false };
});

ipcMain.handle('doc:save', async (_e, { data, saveAs, sidecar }) => {
  let file = currentPath;
  if (!file || saveAs) {
    const res = await dialog.showSaveDialog(win, {
      title: 'Save Model',
      defaultPath: file || 'Untitled.anvil',
      filters: DOC_FILTERS
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    file = res.filePath;
  }
  /*
   * Has somebody else written to this since we read it?
   *
   * Asked of the file rather than of the clock. The counter in the document
   * only goes up, so a version on disk higher than the one we loaded means
   * another machine has been here, whatever the timestamps say.
   *
   * Not asked on a Save As or a first save: writing a new file cannot overwrite
   * anybody's work, and the version there belongs to whatever it was copied
   * from rather than to the file being made.
   */
  const fresh = !currentPath || saveAs;
  const clash = LIB.savingWouldClobber(fresh ? null : await versionOnDisk(file), loadedVersion, {
    fresh
  });
  if (clash) return { ok: false, conflict: clash };

  const stamped = {
    ...data,
    docId: data?.docId || `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    version: (fresh ? Number(data?.version) || 0 : loadedVersion) + 1,
    writtenBy: whoWeAre().profile || whoWeAre().user || null,
    writtenAt: new Date().toISOString()
  };

  try {
    await writeAtomic(file, JSON.stringify(stamped, null, 2));
    currentPath = file;
    loadedVersion = stamped.version;
    lastWrittenAt = await modifiedAt(file);
    await takeLock(file);
    beatLock();
    rememberOpened(file, stamped);
    await noteInIndex(file, stamped);

    // A model beside the document that anything can open. The point of keeping
    // work in a synced folder is that a link to it is useful to someone else,
    // and a link to a file only this application can read is not.
    let beside = null;
    if (sidecar?.bytes?.length) {
      try {
        const base = file.replace(/\.[^.\\/]+$/, '');
        beside = `${base}.${sidecar.ext || 'stl'}`;
        await writeAtomicBytes(beside, Buffer.from(sidecar.bytes));
      } catch {
        beside = null;
      }
    }

    setTitle();
    // Saved is saved: whatever was being held against a crash is now in the
    // document, and leaving it behind would offer somebody their own work back.
    clearRecovery();
    return { ok: true, path: file, name: libraryNameFor(file), beside, version: stamped.version, docId: stamped.docId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Write a document without ever leaving a half written one on disk.
 *
 * Writing in place has two ways to lose a model, and a folder that syncs to
 * somewhere else makes both of them likely rather than rare. A crash partway
 * through leaves the file truncated, and that is the only copy. A sync client
 * watching the folder can upload the file while it is still being written and
 * push the truncated version everywhere.
 *
 * Writing beside it and renaming over the top closes both. A rename within a
 * directory either happens or does not, so a reader sees the old file or the
 * new one and never something in between.
 */
async function writeAtomic(file, text) {
  const temp = `${file}.writing`;
  const handle = await fs.open(temp, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    // On disk, not merely handed to the operating system, before the rename
    // makes it the document of record.
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
}

/** The same, for something that is bytes rather than text. */
async function writeAtomicBytes(file, buf) {
  const temp = `${file}.writing`;
  const handle = await fs.open(temp, 'w');
  try {
    await handle.writeFile(buf);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
}

/**
 * The counter and the writer in the file as it stands, without loading it as a
 * document.
 *
 * A parse of the whole file, because a `.anvil` is JSON and there is no cheaper
 * honest way to read one field out of it. It happens once per save, which is
 * nothing next to what the save itself does.
 */
async function versionOnDisk(file) {
  try {
    const got = JSON.parse(await fs.readFile(file, 'utf8'));
    return { version: Number(got?.version) || 0, writtenBy: got?.writtenBy || null };
  } catch {
    // Not there, or not readable. Neither is a conflict: a save onto a file
    // that is not there is just a save.
    return null;
  }
}

/** When a file last changed, or null if it is not there. */
async function modifiedAt(file) {
  try {
    const st = await fs.stat(file);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Has this document changed underneath us since we last wrote it?
 *
 * The question a synced folder makes worth asking: the same file may have been
 * edited on another machine and pulled down while it sat open here. Answering
 * it is what turns silent loss into a choice.
 */
ipcMain.handle('doc:changedOnDisk', async () => {
  if (!currentPath || lastWrittenAt === null) return { changed: false };
  const now = await modifiedAt(currentPath);
  if (now === null) return { changed: false, missing: true };
  return { changed: now > lastWrittenAt + 1, at: now, path: currentPath };
});

ipcMain.handle('doc:currentPath', async () => ({
  path: currentPath,
  name: libraryNameFor(currentPath)
}));

/**
 * Rename the open document, on disk and as the document of record.
 *
 * Fusion's Data Panel rename, which locally is just this. The lock moves with
 * it, or the old name keeps a lock nobody will ever clear and the new one has
 * none at all.
 */
ipcMain.handle('doc:rename', async (_e, to) => {
  if (!currentPath) return { ok: false, error: 'Save this document before renaming it' };
  const clean = String(to || '').trim();
  if (!clean || BAD_NAME.test(clean)) {
    return { ok: false, error: 'That name has characters a file cannot have' };
  }
  const next = path.join(path.dirname(currentPath), DOC_EXT.test(clean) ? clean : clean + '.anvil');
  if (path.resolve(next) === path.resolve(currentPath)) {
    return { ok: true, path: currentPath, name: libraryNameFor(currentPath) };
  }
  try {
    await fs.access(next);
    return { ok: false, error: 'There is already a document by that name here' };
  } catch {
    /* nothing in the way, which is what we want */
  }
  try {
    await dropLock(currentPath);
    await fs.rename(currentPath, next);
    currentPath = next;
    lastWrittenAt = await modifiedAt(next);
    await takeLock(next);
    setTitle();
    return { ok: true, path: next, name: libraryNameFor(next) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Write a copy somewhere else and carry on editing this one.
 *
 * Not Save As, which is the same act with the opposite ending: Save As leaves
 * you working in the new file, and a copy is for when what you want is the
 * copy, not to move house.
 */
ipcMain.handle('doc:saveCopy', async (_e, opts) => {
  const suggested = currentPath
    ? currentPath.replace(DOC_EXT, ' copy.anvil')
    : 'Untitled copy.anvil';
  const res = await dialog.showSaveDialog(win, {
    title: 'Save a Copy',
    defaultPath: suggested,
    filters: DOC_FILTERS
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    await writeAtomic(res.filePath, JSON.stringify(opts?.data, null, 2));
    return { ok: true, path: res.filePath, name: libraryNameFor(res.filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ------------------------------------------------------------------ */
/* Mesh export                                                         */
/* ------------------------------------------------------------------ */

/** A rendered image, written where the person says. */
ipcMain.handle('export:image', async (_e, { suggestedName, bytes }) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save the render',
    defaultPath: suggestedName || 'render.png',
    filters: [{ name: 'PNG', extensions: ['png'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    await writeAtomicBytes(res.filePath, Buffer.from(bytes));
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Write a plain text file the document does not own: a parameter list, and
 * whatever else turns out to want one.
 *
 * Separate from `export:mesh` because that names its filters after the three
 * mesh formats, and separate from `doc:save` because writing one of these must
 * never become the document's path.
 */
ipcMain.handle('export:text', async (_e, { suggestedName, ext, label, data }) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Export',
    defaultPath: suggestedName,
    filters: [{ name: label || String(ext).toUpperCase(), extensions: [ext] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    await fs.writeFile(res.filePath, String(data), 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Read one back. Same reasoning as above about not touching the document. */
ipcMain.handle('import:text', async (_e, { ext, label }) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import',
    filters: [{ name: label || String(ext).toUpperCase(), extensions: [ext] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  try {
    const text = await fs.readFile(res.filePaths[0], 'utf8');
    return { ok: true, path: res.filePaths[0], text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('export:mesh', async (_e, { suggestedName, ext, data }) => {
  const filters = {
    stl: [{ name: 'STL (binary)', extensions: ['stl'] }],
    obj: [{ name: 'Wavefront OBJ', extensions: ['obj'] }],
    '3mf': [{ name: '3MF', extensions: ['3mf'] }]
  }[ext] || [{ name: 'File', extensions: [ext] }];

  const res = await dialog.showSaveDialog(win, {
    title: 'Export',
    defaultPath: suggestedName,
    filters
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };

  try {
    const buf = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data), 'utf8');
    await fs.writeFile(res.filePath, buf);
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Hand a finished print file to whatever the machine opens it with.
 *
 * Which is a slicer, on any machine that has one, and that is the whole point:
 * exporting into a folder and then going and finding it is the step Fusion's
 * own 3D Print command exists to remove.
 *
 * Only the two extensions this application writes are allowed through. Opening
 * a file by shell is running whatever is registered for it, so the set has to
 * be one that cannot be talked into being something else.
 */
ipcMain.handle('shell:launch', async (_e, file) => {
  if (!file) return { ok: false, error: 'No file' };
  if (!/\.(3mf|stl)$/i.test(file)) return { ok: false, error: 'Not a print file' };
  const err = await shell.openPath(file);
  if (err) return { ok: false, error: err };
  return { ok: true };
});

ipcMain.handle('shell:showItem', async (_e, file) => {
  if (file) shell.showItemInFolder(file);
  return { ok: true };
});

// Reporting channel for the test harness page. The editor never sends this.
ipcMain.on('test:done', (_e, summary) => {
  const write = (line) => process.stdout.write(`${line}\n`);
  if (summary.log) for (const line of summary.log) write(line);
  for (const r of summary.results) {
    write(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}`);
    if (!r.ok) write(`       ${r.error}`);
  }
  write('');
  write(`${summary.total - summary.failed}/${summary.total} passed`);
  clearRecovery();
  app.exit(summary.failed ? 1 : 0);
});

ipcMain.handle('dialog:message', async (_e, opts) => {
  const res = await dialog.showMessageBox(win, opts);
  return res;
});
