/**
 * Batch 5 through the real interface: the seven joint types, a rigid group, a
 * motion link, contact, and a four bar linkage that closes and then turns.
 *
 * Runs inside the page via --anvil-script.
 */

const dev = window.anvilDev;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};

async function fillInspector(values) {
  await wait(150);
  const rows = [...document.querySelectorAll('#inspectorBody .field')].map((f) =>
    f.querySelector('input, select')
  );
  values.forEach((v, i) => {
    const el = rows[i];
    if (!el || v === null) return;
    if (el.type === 'checkbox') {
      el.checked = !!v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'SELECT') {
      el.value = String(v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  document.getElementById('inspectorOk').click();
  await wait(300);
}

/** A bar of the given length, as its own component, lying along X from x0. */
async function makeBar(name, x0, length, width, z) {
  dev.runCommand('newComponent');
  await wait(250);
  dev.runCommand('primBox');
  await wait(250);
  const f = dev.state.editing?.feature;
  if (!f) throw new Error('no box dialog');
  Object.assign(f.params, {
    width: String(length),
    depth: String(width),
    height: '4',
    centered: false,
    x: String(x0),
    y: String(-width / 2),
    z: String(z)
  });
  f.op = 'new';
  dev.rebuildAll();
  document.getElementById('inspectorOk').click();
  await wait(350);
  const comp = dev.state.doc.components[dev.state.doc.components.length - 1];
  comp.name = name;
  return comp;
}

/* ---- a four bar: ground 60 across, crank 20, coupler 60, rocker 40 ---- */

const ground = await makeBar('Ground', 0, 60, 6, 0);
ground.grounded = true;
const crank = await makeBar('Crank', 0, 20, 5, 6);
const coupler = await makeBar('Coupler', 20, 60, 5, 12);
const rocker = await makeBar('Rocker', 60, 40, 5, 18);
report.components = dev.state.doc.components.length;

const Z = [0, 0, 1];
dev.state.doc.joints = [
  { id: 'a', name: 'Crank pivot', type: 'revolute', parent: ground.id, child: crank.id,
    origin: { p: [0, 0, 0], axis: Z }, angle: '20', driven: true },
  { id: 'b', name: 'Crank to coupler', type: 'revolute', parent: crank.id, child: coupler.id,
    origin: { p: [20, 0, 0], axis: Z }, angle: '0' },
  { id: 'c', name: 'Coupler to rocker', type: 'revolute', parent: coupler.id, child: rocker.id,
    origin: { p: [80, 0, 0], axis: Z }, angle: '0' },
  { id: 'd', name: 'Rocker pivot', type: 'revolute', parent: rocker.id, child: ground.id,
    origin: { p: [60, 0, 0], axis: Z }, angle: '0' }
];
dev.rebuildAll();
await wait(400);

report.fourBar = {
  errors: dev.state.result.errors.map((e) => e.message),
  bodies: dev.bodies.length
};

// Turn the crank and watch the rest follow. A linkage that closes will put the
// coupler somewhere different at each crank angle, and the rocker's own ground
// pivot must never move, because it is pinned to the ground.
const couplerAt = () => {
  const rec = dev.state.records.find((r) => r.name === 'Body 3') || dev.state.records[2];
  const bb = rec.mesh ? null : null;
  const m = dev.state.result.assembly?.get?.(coupler.id);
  return m;
};

const sample = [];
for (const angle of [0, 30, 60, 90]) {
  dev.state.doc.joints[0].angle = String(angle);
  dev.rebuildAll();
  await wait(220);
  const b = dev.bodies.find((x) => x.component === coupler.id);
  const box = b ? b.solid.boundingBox() : null;
  sample.push({
    crank: angle,
    couplerCentre: box
      ? [
          Number(((box.min[0] + box.max[0]) / 2).toFixed(2)),
          Number(((box.min[1] + box.max[1]) / 2).toFixed(2))
        ]
      : null,
    errors: dev.state.result.errors.length
  });
}
report.turning = sample;
report.movedThrough = new Set(sample.map((s) => String(s.couplerCentre))).size;

/* ---- every joint type opens and solves ---- */

const types = {};
for (const t of Object.keys(dev.jointTypes)) {
  dev.state.doc.joints = [
    {
      id: 'solo', name: 'Test', type: t, parent: ground.id, child: crank.id,
      origin: { p: [0, 0, 0], axis: [0, 0, 1], axis2: [1, 0, 0] },
      angle: '15', offset: '5', offset2: '3', pitch: '10', yaw: '10', roll: '10'
    }
  ];
  dev.rebuildAll();
  await wait(150);
  types[t] = dev.state.result.errors.length === 0;
}
report.everyTypeSolves = types;

/* ---- rigid group ---- */

dev.state.doc.joints = [
  { id: 'a', name: 'Slide', type: 'slider', parent: ground.id, child: crank.id,
    origin: { p: [0, 0, 0], axis: [0, 1, 0] }, offset: '25' }
];
dev.state.doc.rigidGroups = [
  { id: 'g1', name: 'Head', components: [crank.id, coupler.id] }
];
dev.rebuildAll();
await wait(300);
{
  const c = dev.bodies.find((x) => x.component === crank.id);
  const p = dev.bodies.find((x) => x.component === coupler.id);
  const cy = c ? (c.solid.boundingBox().min[1] + c.solid.boundingBox().max[1]) / 2 : null;
  const py = p ? (p.solid.boundingBox().min[1] + p.solid.boundingBox().max[1]) / 2 : null;
  report.rigidGroup = {
    crankY: Number(cy.toFixed(2)),
    couplerY: Number(py.toFixed(2)),
    movedTogether: Math.abs(cy - py) < 0.01
  };
}

/* ---- motion link ---- */

dev.state.doc.rigidGroups = [];
dev.state.doc.joints = [
  { id: 'drive', name: 'Drive', type: 'revolute', parent: ground.id, child: crank.id,
    origin: { p: [0, 0, 0], axis: Z }, angle: '30' },
  { id: 'follow', name: 'Follow', type: 'revolute', parent: ground.id, child: coupler.id,
    origin: { p: [0, 0, 0], axis: Z }, angle: '0' }
];
dev.state.doc.motionLinks = [{ id: 'l1', from: 'drive', to: 'follow', ratio: '2' }];
dev.rebuildAll();
await wait(300);
report.motionLinkErrors = dev.state.result.errors.length;

/* ---- the dialogs all open ---- */

const dialogs = {};
for (const cmd of ['newJoint', 'asBuiltJoint', 'rigidGroup', 'motionLink', 'driveJoints']) {
  dev.runCommand(cmd);
  await wait(250);
  dialogs[cmd] = dev.state.editing || document.getElementById('inspectorTitle')
    ? document.getElementById('inspectorTitle').textContent
    : `no dialog (${document.getElementById('status').textContent})`;
  const cancel = document.getElementById('inspectorCancel');
  if (dev.state.editing) cancel.click();
  else document.getElementById('inspector').classList.add('hidden');
  await wait(180);
}
report.dialogs = dialogs;

/* ---- back to the linkage for the picture ---- */

dev.state.doc.motionLinks = [];
dev.state.doc.joints = [
  { id: 'a', name: 'Crank pivot', type: 'revolute', parent: ground.id, child: crank.id,
    origin: { p: [0, 0, 0], axis: Z }, angle: '55', driven: true },
  { id: 'b', name: 'Crank to coupler', type: 'revolute', parent: crank.id, child: coupler.id,
    origin: { p: [20, 0, 0], axis: Z }, angle: '0' },
  { id: 'c', name: 'Coupler to rocker', type: 'revolute', parent: coupler.id, child: rocker.id,
    origin: { p: [80, 0, 0], axis: Z }, angle: '0' },
  { id: 'd', name: 'Rocker pivot', type: 'revolute', parent: rocker.id, child: ground.id,
    origin: { p: [60, 0, 0], axis: Z }, angle: '0' }
];
dev.rebuildAll();
await wait(400);

// Straight down, because a four bar is a shape in a plane and any tilt at all
// turns four bars at four heights into a heap of sticks.
dev.state.vp.setView([0, 0, 1], false, [0, 1, 0]);
dev.state.vp.fit(1.25);
dev.setStatus('A four bar linkage, closed and driven.');
await wait(400);
report.finalErrors = dev.state.result.errors.map((e) => e.message);
return report;
