/**
 * Baseline for batch 6: how often does a stored face or edge reference survive
 * an upstream change?
 *
 * The easy case is a plate with one top face, where orientation and area alone
 * pick it out. The case that matters is a part carrying several faces that look
 * exactly alike, because then only position tells them apart, and position is
 * the one thing a dimension change ruins.
 */

const mods = await Promise.all([
  import('./features.js'),
  import('./kernel.js'),
  import('./topology.js'),
  import('./edgefeature.js')
]);
const { newDocument, newSketch, rebuild, uid } = mods[0];
const K = mods[1];
const { buildTopology } = mods[2];
const { faceReference, edgeReference, resolveFaceRefs, resolveEdgeRefs } = mods[3];

/** A plate with four identical bosses, spaced across its width. */
function bossDoc(spacing) {
  const doc = newDocument();
  doc.features = [
    {
      id: 'plate', type: 'primitive', shape: 'box', op: 'new', targets: 'all',
      params: {
        width: String(spacing * 5), depth: '40', height: '10',
        diameter: '20', topDiameter: '0', centered: false, x: '0', y: '0', z: '0'
      }
    }
  ];
  for (let i = 0; i < 4; i++) {
    doc.features.push({
      id: `boss${i}`, type: 'primitive', shape: 'cylinder', op: 'join', targets: 'all',
      params: {
        diameter: '12', height: '8', topDiameter: '0', width: '10', depth: '10',
        centered: false, x: String(spacing * (i + 1)), y: '20', z: '10'
      }
    });
  }
  return doc;
}

/** The top face of the boss nearest x, from a built body. */
function bossTop(topo, x) {
  const tops = topo.faces.filter(
    (f) => f.planar && f.normal[2] > 0.99 && Math.abs(f.centre[2] - 18) < 0.01
  );
  return tops.sort((a, b) => Math.abs(a.centre[0] - x) - Math.abs(b.centre[0] - x))[0];
}

/**
 * Strip the names off a reference, leaving only what it used to carry. That is
 * how the before and the after are measured the same way rather than compared
 * across two different checks.
 */
function stripNames(ref) {
  const copy = { ...ref };
  delete copy.src;
  delete copy.between;
  return copy;
}

const out = {};

/* ---- a face reference among four that look alike ---- */

function faceRun(named) {
  const start = 20;
  const first = rebuild(bossDoc(start));
  const topo = buildTopology(K.meshData(first.bodies[0].solid));
  const tops = topo.faces.filter(
    (f) => f.planar && f.normal[2] > 0.99 && Math.abs(f.centre[2] - 18) < 0.01
  );
  out.bossesFound = tops.length;

  // The third boss along, which starts at x = 60.
  const target = bossTop(topo, start * 3);
  const ref = faceReference(target);
  out.targetStartedAt = Number(target.centre[0].toFixed(2));

  const lost = [];
  for (const spacing of [21, 22, 24, 26, 30, 36, 44, 60]) {
    const res = rebuild(bossDoc(spacing));
    const t2 = buildTopology(K.meshData(res.bodies[0].solid));
    const [found] = resolveFaceRefs(t2, [named ? ref : stripNames(ref)]);
    // It should still be the third boss, which is now at spacing * 3.
    const want = spacing * 3;
    const right = found && Math.abs(found.centre[0] - want) < 1;
    if (!right) {
      lost.push({
        spacing,
        landedOn: found ? Number(found.centre[0].toFixed(1)) : null,
        wanted: want
      });
    }
  }
  return lost;
}

/* ---- and what that costs: a fillet on the third boss ---- */

function filletRun(named) {
  const start = 20;
  const first = rebuild(bossDoc(start));
  const topo = buildTopology(K.meshData(first.bodies[0].solid));
  const target = bossTop(topo, start * 3);
  // The round edge at the top of that boss.
  const edge = topo.edges
    .filter((e) => e.kind === 'circle' && Math.abs(e.centre[2] - 18) < 0.01)
    .sort((a, b) => Math.abs(a.centre[0] - start * 3) - Math.abs(b.centre[0] - start * 3))[0];
  out.edgeFound = !!edge;
  const ref = edge ? edgeReference(edge, topo) : null;

  const lost = [];
  if (ref) {
    for (const spacing of [20, 21, 22, 24, 26, 30, 36, 44, 60]) {
      const doc = bossDoc(spacing);
      doc.features.push({
        id: 'ffil', type: 'fillet', bodies: 'all',
        sets: [{ edges: [named ? ref : stripNames(ref)], radius: '2' }]
      });
      const res = rebuild(doc);
      const errs = res.errors.filter((e) => e.feature === 'ffil');

      // Where did it actually land? Rebuild without the fillet and compare.
      const plainRes = rebuild(bossDoc(spacing));
      const plain = plainRes.bodies[0].solid.volume();
      const filleted = res.bodies[0] ? res.bodies[0].solid.volume() : 0;
      const took = plain - filleted > 0.5;

      // Which boss actually got rounded: compare each boss's top face area
      // with and without the fillet. Taking the smallest face outright picks
      // up the slivers a blend leaves rather than the boss top.
      let onRight = false;
      let landedOn = null;
      if (took) {
        const t2 = buildTopology(K.meshData(res.bodies[0].solid));
        const p2 = buildTopology(K.meshData(plainRes.bodies[0].solid));
        const topsNear = (topo, x) =>
          topo.faces
            .filter(
              (f) =>
                f.planar &&
                f.normal[2] > 0.99 &&
                Math.abs(f.centre[2] - 18) < 0.01 &&
                Math.abs(f.centre[0] - x) < 6
            )
            .reduce((sum, f) => sum + f.area, 0);
        let worst = 0;
        for (let i = 1; i <= 4; i++) {
          const x = spacing * i;
          const before = topsNear(p2, x);
          const after = topsNear(t2, x);
          const shrank = before - after;
          if (shrank > worst) {
            worst = shrank;
            landedOn = x;
          }
        }
        onRight = landedOn !== null && Math.abs(landedOn - spacing * 3) < 1;
      }
      if (errs.length || !took || !onRight) {
        lost.push({ spacing, errored: errs.length > 0, took, landedOn, wanted: spacing * 3 });
      }
    }
  }
  return lost;
}

const beforeFace = faceRun(false);
const afterFace = faceRun(true);
const beforeFillet = filletRun(false);
const afterFillet = filletRun(true);

out.before = {
  faceLost: `${beforeFace.length} of 8`,
  faceLostAt: beforeFace.map((x) => x.spacing),
  filletOnWrongBoss: `${beforeFillet.length} of 9`,
  filletWrongAt: beforeFillet.map((x) => x.spacing)
};
out.after = {
  faceLost: `${afterFace.length} of 8`,
  faceLostAt: afterFace.map((x) => x.spacing),
  filletOnWrongBoss: `${afterFillet.length} of 9`,
  filletWrongAt: afterFillet.map((x) => x.spacing)
};
return out;
