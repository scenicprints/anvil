'use strict';

const { app, BrowserWindow, protocol, ipcMain, dialog, shell } = require('electron');
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
    app.exit(0);
  } catch (err) {
    process.stderr.write(`Screenshot failed: ${err.stack || err.message}\n`);
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

function setTitle() {
  if (!win) return;
  const name = currentPath ? path.basename(currentPath) : 'Untitled';
  win.setTitle(`${name} - Anvil`);
}

app.whenReady().then(() => {
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

ipcMain.handle('doc:open', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open Model',
    filters: DOC_FILTERS,
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const file = res.filePaths[0];
  try {
    const text = await fs.readFile(file, 'utf8');
    const held = await foreignLock(file);
    if (currentPath && currentPath !== file) await dropLock(currentPath);
    currentPath = file;
    lastWrittenAt = await modifiedAt(file);
    await takeLock(file);
    beatLock();
    setTitle();
    return { ok: true, path: file, data: JSON.parse(text), held };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
  try {
    const text = await fs.readFile(file, 'utf8');
    const held = await foreignLock(file);
    if (currentPath && currentPath !== file) await dropLock(currentPath);
    currentPath = file;
    lastWrittenAt = await modifiedAt(file);
    await takeLock(file);
    beatLock();
    setTitle();
    return { ok: true, path: file, data: JSON.parse(text), held };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_BEAT_MS = 30 * 1000;
let lockBeat = null;

const lockPathFor = (file) => `${file}.anvillock`;

function whoWeAre() {
  return {
    host: os.hostname(),
    user: os.userInfo?.().username || '',
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
  try {
    await writeAtomic(file, JSON.stringify(data, null, 2));
    currentPath = file;
    lastWrittenAt = await modifiedAt(file);
    await takeLock(file);
    beatLock();

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
    return { ok: true, path: file, beside };
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

ipcMain.handle('doc:currentPath', async () => currentPath);

/* ------------------------------------------------------------------ */
/* Mesh export                                                         */
/* ------------------------------------------------------------------ */

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
  app.exit(summary.failed ? 1 : 0);
});

ipcMain.handle('dialog:message', async (_e, opts) => {
  const res = await dialog.showMessageBox(win, opts);
  return res;
});
