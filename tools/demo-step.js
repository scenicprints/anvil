/**
 * A STEP file, read and put into the document.
 *
 * Written out here rather than shipped as a fixture so the numbers in the
 * checks come from the same place as the geometry: a plate of 60 by 40 by 8
 * has to come back as 19200, and if it does not, one of the two is wrong.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SR = await import('./stepread.js');
const K = await import('./kernel.js');
const TP = await import('./topology.js');
const RC = await import('./recognise.js');
const report = { errors: [] };
window.addEventListener('error', (e) => report.errors.push(String(e.message)));

function stepBox(w, d, h) {
  const lines = [];
  let n = 0;
  const put = (t) => { n += 1; lines.push(`#${n}=${t};`); return n; };
  const pt = (x, y, z) => put(`CARTESIAN_POINT('',(${x},${y},${z}))`);
  const dir = (x, y, z) => put(`DIRECTION('',(${x},${y},${z}))`);
  const hx = w / 2, hy = d / 2, hz = h / 2;
  const corner = {};
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
    corner[`${sx},${sy},${sz}`] = pt(sx * hx, sy * hy, sz * hz);
  const vert = {};
  for (const k of Object.keys(corner)) vert[k] = put(`VERTEX_POINT('',#${corner[k]})`);
  const specs = [
    { nrm: [1, 0, 0], x: [0, 1, 0], ring: ['1,-1,-1', '1,1,-1', '1,1,1', '1,-1,1'] },
    { nrm: [-1, 0, 0], x: [0, 0, 1], ring: ['-1,-1,-1', '-1,-1,1', '-1,1,1', '-1,1,-1'] },
    { nrm: [0, 1, 0], x: [0, 0, 1], ring: ['-1,1,-1', '-1,1,1', '1,1,1', '1,1,-1'] },
    { nrm: [0, -1, 0], x: [1, 0, 0], ring: ['-1,-1,-1', '1,-1,-1', '1,-1,1', '-1,-1,1'] },
    { nrm: [0, 0, 1], x: [1, 0, 0], ring: ['-1,-1,1', '1,-1,1', '1,1,1', '-1,1,1'] },
    { nrm: [0, 0, -1], x: [0, 1, 0], ring: ['-1,-1,-1', '-1,1,-1', '1,1,-1', '1,-1,-1'] }
  ];
  const faces = [];
  for (const f of specs) {
    const o = pt(f.nrm[0] * hx, f.nrm[1] * hy, f.nrm[2] * hz);
    const z = dir(...f.nrm);
    const xd = dir(...f.x);
    const plane = put(`PLANE('',#${put(`AXIS2_PLACEMENT_3D('',#${o},#${z},#${xd})`)})`);
    const oriented = [];
    for (let i = 0; i < f.ring.length; i++) {
      const a = vert[f.ring[i]];
      const b = vert[f.ring[(i + 1) % f.ring.length]];
      const line = put(`LINE('',#${pt(0, 0, 0)},#${put(`VECTOR('',#${dir(1, 0, 0)},1.)`)})`);
      const edge = put(`EDGE_CURVE('',#${a},#${b},#${line},.T.)`);
      oriented.push(put(`ORIENTED_EDGE('',*,*,#${edge},.T.)`));
    }
    const loop = put(`EDGE_LOOP('',(${oriented.map((i) => `#${i}`).join(',')}))`);
    faces.push(put(`ADVANCED_FACE('',(#${put(`FACE_OUTER_BOUND('',#${loop},.T.)`)}),#${plane},.T.)`));
  }
  put(`CLOSED_SHELL('',(${faces.map((i) => `#${i}`).join(',')}))`);
  return ['ISO-10303-21;', 'HEADER;', "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));", 'ENDSEC;',
    'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
}

/* ---- read it ---- */
const text = stepBox(60, 40, 8);
report.fileBytes = text.length;
const out = SR.readSTEP(text);
report.read = {
  bodies: out.bodies.length,
  faces: out.faces,
  unread: out.unreadFaces,
  tris: out.bodies[0]?.mesh.triVerts.length / 3
};

/* ---- it is the plate it said it was ---- */
{
  const scope = new K.Scope();
  const solid = K.ofMesh(out.bodies[0].mesh.vertProperties, out.bodies[0].mesh.triVerts, scope);
  report.solid = {
    status: K.status(solid),
    volume: Number(solid.volume().toFixed(3)),
    wanted: 60 * 40 * 8,
    genus: solid.genus()
  };
  const topo = TP.buildTopology(K.meshData(solid));
  report.solid.faces = topo.faces.length;
  report.solid.recognised = RC.recognise(K.meshData(solid), topo).counts;
  scope.dispose();
}

/* ---- and it goes into the document as a body ---- */
{
  const key = 'stepdemo';
  dev.state.doc.meshData[key] = {
    verts: Array.from(out.bodies[0].mesh.vertProperties),
    tris: Array.from(out.bodies[0].mesh.triVerts)
  };
  dev.state.doc.features.push({
    id: 'fstep', type: 'insertMesh', data: key, label: 'plate.step', scale: '1', at: [0, 0, 0]
  });
  dev.rebuildAll();
  await wait(700);
  dev.state.vp.fit(1.6);
  await wait(300);
  report.inDocument = {
    bodies: dev.bodies.length,
    errors: dev.state.result.errors.map((e) => e.message)
  };
}

report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
