/**
 * Filleting the fold in a surface body, through the dialog.
 *
 * The geometry has its own tests. What this is for is the path through the
 * app: that Fillet will point at a surface at all, that the edges of one can be
 * picked, that the dialog stops offering the options that only mean something
 * on a solid, and that what comes back is still a surface rather than a solid
 * or nothing.
 *
 * That path is where this kind of work usually breaks. The builder was written
 * for solids and every gate along the way says so, so a blend that is exactly
 * right in a unit test can still be unreachable with a mouse.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

const rows = () => [...document.querySelectorAll('#inspectorBody .field')];
const rowFor = (t) => rows().find((r) => r.textContent.includes(t));
const labels = () => rows().map((r) => r.textContent.split('\n')[0].trim());

/* ---- a folded surface: a U, dragged ---- */
dev.setTab('surface');
const doc = () => dev.state.doc;

{
  const sk = {
    id: 'sk1',
    name: 'U',
    plane: 'XY',
    points: [
      { x: -10, y: 0 },
      { x: -10, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 0 }
    ],
    entities: [
      { id: 1, type: 'line', p: [0, 1] },
      { id: 2, type: 'line', p: [1, 2] },
      { id: 3, type: 'line', p: [2, 3] }
    ],
    constraints: [],
    nextEntityId: 4
  };
  doc().sketches[sk.id] = sk;
  doc().features.push({ id: 'fsk', type: 'sketch', sketch: sk.id });
  doc().features.push({
    id: 'fsurf',
    type: 'surfaceExtrude',
    sketch: sk.id,
    edges: [],
    distance: '10',
    direction: 'one'
  });
  dev.rebuildAll();
  await wait(1200);
}

const body = () => dev.state.records[0];
report.oneBody = dev.state.records.length === 1;
report.itIsASurface = !!body()?.sheet;
if (!report.itIsASurface) return { ...report, stuckAt: 'the surface did not build' };

const folds = body().topology.edges.filter((e) => !e.boundary && !e.tangent);
report.foldsFound = folds.length;
report.areaBefore = Number(dev.bodies[0].sheet ? sheetArea(dev.bodies[0].sheet).toFixed(2) : 0);

function sheetArea(sheet) {
  let a = 0;
  for (let i = 0; i < sheet.triVerts.length; i += 3) {
    const p = [0, 1, 2].map((k) => {
      const b = sheet.triVerts[i + k] * sheet.numProp;
      return [sheet.vertProperties[b], sheet.vertProperties[b + 1], sheet.vertProperties[b + 2]];
    });
    const u = p[1].map((v, d) => v - p[0][d]);
    const v = p[2].map((w, d) => w - p[0][d]);
    a +=
      Math.hypot(
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0]
      ) / 2;
  }
  return a;
}

/* ---- pick both folds and fillet them ---- */
{
  for (const e of folds) {
    dev.state.selection.edges.add(`${body().id}:${body().topology.edges.indexOf(e)}`);
  }
  dev.runCommand('fillet');
  await wait(800);
}

report.dialogOpened = !!document.getElementById('inspectorOk');
report.rowsShown = labels();
// The note is the promise the dialog makes about what it will do, and the
// absence of the type dropdown is the promise it will not pretend otherwise.
// A note is a hint rather than a field, so it is looked for where it lives.
report.saysItIsASurface = [...document.querySelectorAll('#inspectorBody .hint')].some((n) =>
  /surface body/i.test(n.textContent)
);
report.noFilletTypeRow = !rowFor('Set 1 type');
report.hasARadiusRow = !!rowFor('Set 1 radius');

{
  const input = rowFor('Set 1 radius')?.querySelector('input');
  if (!input) return { ...report, stuckAt: 'no radius box on the surface fillet' };
  input.value = '2';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(400);
}
document.getElementById('inspectorOk').click();
await wait(1500);

report.status = document.getElementById('status')?.textContent ?? null;
report.buildErrors = (dev.state.result?.errors || []).map((e) => e.message);
report.stillOneBody = dev.state.records.length === 1;
report.stillASurface = !!dev.state.records[0]?.sheet;
report.areaAfter = Number(sheetArea(dev.bodies[0].sheet).toFixed(2));

// Two square folds set back 2 on each of four sides is 80 of panel gone, and
// two quarter circles of radius 2 run 10 deep is what goes back in its place.
const want = 400 - 80 + 2 * (Math.PI / 2) * 2 * 10;
report.areaExpected = Number(want.toFixed(2));
report.theRightAmountCameOff = Math.abs(report.areaAfter - want) < 1;

/*
 * A blend is not a blend if it is still a sharp corner, and it is not a blend
 * either if the strip is merely lying in the gap: the pieces have to be joined.
 * Both are read off the topology of the result. Edges that are not rim edges
 * mean it is one surface; no edge anywhere near square means the fold is gone.
 *
 * Near square rather than shallow, because a surface body has no inside and so
 * no agreed way round for its triangles: two faces meeting flat read as 180 as
 * readily as 0, and only the right angle is unambiguous.
 */
{
  const topo = dev.state.records[0].topology;
  const inner = topo.edges.filter((e) => !e.boundary);
  report.edgesAcrossTheFold = inner.length;
  report.itIsOneJoinedSurface = inner.length > 0;
  report.dihedrals = inner.map((e) => Math.round(e.dihedral));
  report.nothingSquareLeft = inner.every((e) => e.dihedral < 60 || e.dihedral > 120);
}

return report;
