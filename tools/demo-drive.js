/**
 * A model kept in a folder that syncs.
 *
 * Three things have to hold: a save never leaves a half written document on
 * disk, a model anything can open lands beside it, and a file changed by
 * another machine is a choice rather than silent loss.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

report.bridge = {
  changedOnDisk: typeof window.anvil.changedOnDisk === 'function',
  heldByOther: typeof window.anvil.heldByOther === 'function',
  // Not save.length: contextBridge wraps every function it exposes and the
  // wrapper does not carry the original arity, so that number says nothing.
  save: typeof window.anvil.save === 'function'
};

/* A body, so there is something for the sidecar to hold. */
dev.setTab('solid');
dev.runCommand('primBox');
await wait(400);
document.getElementById('inspectorOk').click();
await wait(600);
report.bodies = dev.bodies.length;

/* The sidecar is built from what is visible and is real STL. */
{
  const MU = await import('./meshutil.js');
  const K = await import('./kernel.js');
  const meshes = dev.bodies.map((b) => K.meshData(b.solid));
  const stl = MU.toBinarySTL(meshes);
  const back = MU.parseSTL(stl);
  report.sidecar = {
    bytes: stl.byteLength ?? stl.length,
    trisOut: meshes[0].triVerts.length / 3,
    trisBack: back.triVerts.length / 3,
    readsBack: back.triVerts.length === meshes[0].triVerts.length
  };
}

/* Nothing is held and nothing has changed, with no document open. */
report.heldWithNoDoc = await window.anvil.heldByOther();
report.changedWithNoDoc = await window.anvil.changedOnDisk();

report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
