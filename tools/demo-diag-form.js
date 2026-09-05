/** Scratch: does one cage face come back as one selectable face? */
const [F, TOPO] = await Promise.all([import('./form.js'), import('./topology.js')]);
const XY = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };
const out = {};

const grid = F.planeCage(XY, 40, 40, 3, 3);
const mesh = F.cageToMesh(grid);
out.gridFaces = grid.faces.length;
out.meshTris = mesh.triVerts.length / 3;
out.tagged = mesh.triFaceID.length;
const topo = TOPO.buildTopology(mesh);
out.topoFaces = topo.faces.length;
out.faceSrc = topo.faces.slice(0, 4).map((f) => f.src?.face ?? null);

const box = F.boxCage(XY, [20, 20, 20], [2, 2, 2]);
const bm = F.cageToMesh(box);
const bt = TOPO.buildTopology(bm);
out.boxCageFaces = box.faces.length;
out.boxTopoFaces = bt.faces.length;
out.boxSrcDistinct = new Set(bt.faces.map((f) => f.src?.face)).size;
return out;
