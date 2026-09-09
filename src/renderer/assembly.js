/**
 * Components and joints.
 *
 * A component is a named container with its own placement; bodies belong to
 * one, and features only ever act on bodies inside the same component, which is
 * what stops a cut in one part eating into the part next to it.
 *
 * A joint says how one component may move relative to another. Each is captured
 * with both parts where they already sit, so a joint at rest changes nothing;
 * driving it then moves the child about the captured origin.
 *
 * Chains are walked out from the grounded components, which handles the tree of
 * hinges and slides that most mechanisms are. Where a chain closes back on
 * itself the tree is not enough: the joints round the loop have to agree with
 * each other, and that is a small nonlinear solve, done here by Gauss-Newton on
 * the mismatch each closing joint leaves.
 */

import * as THREE from './three.js';
import { safeEval } from './expr.js';

/**
 * The seven joints, and what each lets move.
 *
 * `dof` names the free variables in the order the solver packs them. `axes`
 * says how many directions the joint has to be given: one for a hinge, two for
 * anything that turns about one axis and slides along another.
 */
export const JOINT_TYPES = {
  rigid: { label: 'Rigid', dof: [], axes: 1 },
  revolute: { label: 'Revolute', dof: ['angle'], axes: 1 },
  slider: { label: 'Slider', dof: ['offset'], axes: 1 },
  cylindrical: { label: 'Cylindrical', dof: ['angle', 'offset'], axes: 1 },
  pinSlot: { label: 'Pin-Slot', dof: ['angle', 'offset'], axes: 2 },
  planar: { label: 'Planar', dof: ['angle', 'offset', 'offset2'], axes: 2 },
  ball: { label: 'Ball', dof: ['pitch', 'yaw', 'roll'], axes: 1 }
};

/** What each free variable is called on screen, and whether it is an angle. */
export const DOF_LABELS = {
  angle: { label: 'Angle', angular: true },
  offset: { label: 'Offset', angular: false },
  offset2: { label: 'Offset across', angular: false },
  pitch: { label: 'Pitch', angular: true },
  yaw: { label: 'Yaw', angular: true },
  roll: { label: 'Roll', angular: true }
};

export function jointDof(joint) {
  return JOINT_TYPES[joint?.type]?.dof || [];
}

/* ------------------------------------------------------------------ */

export function newComponent(name) {
  return {
    id: `cmp${Math.random().toString(36).slice(2, 9)}`,
    name: name || 'Component',
    grounded: false,
    transform: { p: [0, 0, 0], q: [0, 0, 0, 1] }
  };
}

function matrixOf(transform) {
  const m = new THREE.Matrix4();
  if (!transform) return m;
  const q = transform.q || [0, 0, 0, 1];
  m.makeRotationFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]));
  const p = transform.p || [0, 0, 0];
  m.setPosition(p[0], p[1], p[2]);
  return m;
}

const vec = (a) => new THREE.Vector3(a[0], a[1], a[2]);

/** The two axes a joint turns and slides about, normalised and square to each other. */
function jointAxes(joint) {
  const a = vec(joint.origin?.axis || [0, 0, 1]).normalize();
  let b = vec(joint.origin?.axis2 || [1, 0, 0]);
  // The second axis only means anything square to the first, and a pin slot
  // given two parallel axes is a cylindrical joint with extra steps.
  b.sub(a.clone().multiplyScalar(b.dot(a)));
  if (b.lengthSq() < 1e-12) {
    b = Math.abs(a.z) < 0.9
      ? new THREE.Vector3(0, 0, 1).cross(a)
      : new THREE.Vector3(1, 0, 0).cross(a);
  }
  return { a, b: b.normalize() };
}

/**
 * The motion a joint allows, as a matrix about its captured origin.
 *
 * `values` overrides what the joint says, which is how the loop solver tries a
 * candidate without writing it back into the document.
 */
function motionMatrix(joint, scope, values) {
  const kind = JOINT_TYPES[joint.type] || JOINT_TYPES.rigid;
  const o = joint.origin?.p || [0, 0, 0];
  const { a, b } = jointAxes(joint);

  const val = (name) => {
    if (values && values[name] !== undefined) return values[name];
    return clampToLimits(safeEval(joint[name], scope, 0), joint.limits, name);
  };
  const rad = (deg) => (deg * Math.PI) / 180;

  const m = new THREE.Matrix4().makeTranslation(o[0], o[1], o[2]);
  const R = (axis, deg) =>
    m.multiply(new THREE.Matrix4().makeRotationAxis(axis, rad(deg)));
  const T = (axis, d) =>
    m.multiply(new THREE.Matrix4().makeTranslation(axis.x * d, axis.y * d, axis.z * d));

  switch (joint.type) {
    case 'revolute':
      R(a, val('angle'));
      break;
    case 'slider':
      T(a, val('offset'));
      break;
    case 'cylindrical':
      R(a, val('angle'));
      T(a, val('offset'));
      break;
    case 'pinSlot':
      // Turns about one axis and slides along the other, which is the whole
      // difference from cylindrical.
      R(a, val('angle'));
      T(b, val('offset'));
      break;
    case 'planar': {
      // `a` is the normal, so it turns about that and slides in the plane.
      const c = a.clone().cross(b).normalize();
      R(a, val('angle'));
      T(b, val('offset'));
      T(c, val('offset2'));
      break;
    }
    case 'ball': {
      // Pitch about the second axis, yaw about their cross, roll about the
      // first, in that order, which is how Fusion names them.
      const c = a.clone().cross(b).normalize();
      R(b, val('pitch'));
      R(c, val('yaw'));
      R(a, val('roll'));
      break;
    }
    default:
      break;
  }

  m.multiply(new THREE.Matrix4().makeTranslation(-o[0], -o[1], -o[2]));
  return m;
}

function clampToLimits(value, limits, which) {
  if (!limits || limits.enabled === false) return value;
  const min = limits[`${which}Min`];
  const max = limits[`${which}Max`];
  let v = value;
  if (typeof min === 'number' && Number.isFinite(min)) v = Math.max(min, v);
  if (typeof max === 'number' && Number.isFinite(max)) v = Math.min(max, v);
  return v;
}

/* ------------------------------------------------------------------ */
/* Rigid groups and motion links                                       */
/* ------------------------------------------------------------------ */

/**
 * Rigid groups, folded into the joint list as ordinary rigid joints.
 *
 * A group of parts that never move relative to each other is the same thing as
 * each of them being rigidly jointed to the first, so it is expressed that way
 * rather than given a second mechanism of its own.
 */
/**
 * Ground To Parent, as a joint nobody has to make.
 *
 * Fusion's version is about nesting: a sub-component fixed inside the component
 * it sits in, rather than fixed in space. Anvil's components are a flat list, so
 * what "inside" means here is named directly: this one is held to that one.
 *
 * Which turns out to be the whole of it. A part held rigidly to another is a
 * rigid joint, and the solver already walks those; the difference from grounding
 * is only what it is held to. Grounded in space is a part that never moves, and
 * on an assembly with one thing bolted to another that is the wrong answer:
 * moving the bracket should take the plate with it.
 */
function jointsFromGroundedTo(components, joints) {
  const out = [];
  const alreadyChild = new Set((joints || []).map((j) => j.child));
  const known = new Set((components || []).map((c) => c.id));
  for (const c of components || []) {
    const to = c.groundedTo;
    // Held to itself, or to something that has gone: neither is a joint. The
    // component is simply not held, which is the safe reading.
    if (!to || to === c.id || !known.has(to)) continue;
    // A part already hanging off a joint keeps that joint, the same rule rigid
    // groups follow: nothing here may quietly overrule what somebody made.
    if (alreadyChild.has(c.id)) continue;
    alreadyChild.add(c.id);
    out.push({
      id: `groundedTo:${c.id}`,
      name: 'Grounded to parent',
      type: 'rigid',
      parent: to,
      child: c.id,
      fromGround: true
    });
  }
  return out;
}

function jointsFromRigidGroups(groups, joints) {
  const out = [];
  const alreadyChild = new Set((joints || []).map((j) => j.child));
  for (const g of groups || []) {
    const members = (g.components || []).filter(Boolean);
    if (members.length < 2) continue;
    const [head, ...rest] = members;
    for (const id of rest) {
      // A part already hanging off a joint keeps that joint; a rigid group
      // cannot quietly overrule what someone jointed by hand.
      if (alreadyChild.has(id)) continue;
      alreadyChild.add(id);
      out.push({
        id: `${g.id}:${id}`,
        name: g.name || 'Rigid group',
        type: 'rigid',
        parent: head,
        child: id,
        fromGroup: g.id
      });
    }
  }
  return out;
}

/**
 * One joint driving another through a ratio.
 *
 * Gears, a rack and pinion, a belt. The follower's value is worked out from the
 * driver's rather than read from the document, so it cannot be set directly and
 * cannot disagree with what drives it.
 */
function applyMotionLinks(links, joints, scope, values) {
  const byId = new Map(joints.map((j) => [j.id, j]));
  for (const link of links || []) {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (!from || !to) continue;
    const fromDof = jointDof(from)[0];
    const toDof = jointDof(to)[0];
    if (!fromDof || !toDof) continue;
    const ratio = Number(safeEval(link.ratio, scope, 1)) || 1;
    const base =
      values[from.id]?.[fromDof] ??
      clampToLimits(safeEval(from[fromDof], scope, 0), from.limits, fromDof);
    values[to.id] = { ...(values[to.id] || {}), [toDof]: base * ratio * (link.reverse ? -1 : 1) };
  }
}

/* ------------------------------------------------------------------ */
/* Solve                                                               */
/* ------------------------------------------------------------------ */

/**
 * Work out where every component ends up.
 * Returns { transforms: Map(id -> Matrix4), errors: [], loops: n }.
 */
export function solveAssembly(components, joints, scope, opts = {}) {
  const transforms = new Map();
  const errors = [];
  const list = components || [];
  if (!list.length) return { transforms, errors, loops: 0 };

  const base = new Map();
  for (const c of list) base.set(c.id, matrixOf(c.transform));

  const all = [
    ...(joints || []),
    ...jointsFromGroundedTo(list, joints),
    ...jointsFromRigidGroups(opts.rigidGroups, joints)
  ].filter((j) => j.child && j.parent && base.has(j.child) && base.has(j.parent));

  // Split the joints into a tree that can be walked and the ones left over that
  // close a loop.
  //
  // A joint closes a loop when its two components are already connected by the
  // joints taken so far, which is what union-find is for. Checking only whether
  // a component already has a parent is not enough: a four bar gives every one
  // of its four components a different parent and still comes back on itself.
  const parentOf = new Map(list.map((c) => [c.id, c.id]));
  const findSet = (id) => {
    let root = id;
    while (parentOf.get(root) !== root) root = parentOf.get(root);
    while (parentOf.get(id) !== root) {
      const next = parentOf.get(id);
      parentOf.set(id, root);
      id = next;
    }
    return root;
  };
  const grounded = new Set(list.filter((c) => c.grounded).map((c) => c.id));

  const tree = [];
  const closing = [];
  const claimed = new Set();
  for (const j of all) {
    // A grounded part is not moved by anything, so a joint onto one is always
    // the loop closing rather than the chain carrying on.
    const wouldMoveGround = grounded.has(j.child);
    const alreadyPlaced = claimed.has(j.child);
    const sameTree = findSet(j.parent) === findSet(j.child);
    if (wouldMoveGround || alreadyPlaced || sameTree) {
      closing.push(j);
      continue;
    }
    claimed.add(j.child);
    parentOf.set(findSet(j.child), findSet(j.parent));
    tree.push(j);
  }

  /**
   * Every way out of the solver goes through here.
   *
   * Constraints are applied after the joints, not alongside them, and that is a
   * decision rather than an accident. A joint says how two parts may move for
   * ever after; a constraint says where a part goes now. Solving both at once
   * would need one solver over two quite different things, and the result of
   * getting it wrong is a part that will not stay where it was put. Applied
   * afterwards, in order, each constraint simply moves what it was pointed at,
   * and the last one wins, which is what somebody dragging parts together
   * expects.
   */
  const finish = (result) => {
    applyConstraints(result.transforms, list, tree, opts.constraints, result.errors);
    return result;
  };

  const values = {};
  applyMotionLinks(opts.motionLinks, all, scope, values);

  const place = (vals) => {
    const out = new Map();
    const byChild = new Map(tree.map((j) => [j.child, j]));
    const state = new Map();

    const resolve = (id) => {
      if (state.get(id) === 'done') return out.get(id);
      if (state.get(id) === 'busy') {
        // A cycle inside the tree itself, which no amount of solving fixes.
        state.set(id, 'done');
        out.set(id, base.get(id).clone());
        return out.get(id);
      }
      state.set(id, 'busy');

      const joint = byChild.get(id);
      const own = base.get(id) || new THREE.Matrix4();
      if (!joint) {
        out.set(id, own.clone());
      } else {
        const parentWorld = resolve(joint.parent) || new THREE.Matrix4();
        const parentBase = base.get(joint.parent) || new THREE.Matrix4();
        const drift = parentWorld.clone().multiply(parentBase.clone().invert());
        const m = drift
          .multiply(motionMatrix(joint, scope, vals[joint.id]))
          .multiply(own);
        out.set(id, m);
      }
      state.set(id, 'done');
      return out.get(id);
    };

    for (const c of list) resolve(c.id);
    return out;
  };

  if (!closing.length) {
    const out = place(values);
    for (const [k, v] of out) transforms.set(k, v);
    return finish({ transforms, errors, loops: 0 });
  }

  // Something has to give for the loop to close, and it is the joints round that
  // loop that were not driven by hand. A joint is driven when it is marked so,
  // or when a motion link already decides it.
  //
  // Only the joints on the loop: a hinge on the far side of the assembly has no
  // effect on whether this one closes, and letting the solver move it would
  // make the normal equations flat in that direction and shift a part nobody
  // asked it to touch.
  const onLoop = new Set();
  const treeByChild = new Map(tree.map((j) => [j.child, j]));
  const ancestry = (id) => {
    const chain = [];
    const seen = new Set();
    let at = id;
    while (at && !seen.has(at)) {
      seen.add(at);
      const j = treeByChild.get(at);
      if (!j) break;
      chain.push(j);
      at = j.parent;
    }
    return chain;
  };
  for (const j of closing) {
    const up = ancestry(j.parent);
    const down = ancestry(j.child);
    // Everything back to where the two branches meet.
    const upIds = new Set(up.map((x) => x.id));
    const shared = new Set(down.filter((x) => upIds.has(x.id)).map((x) => x.id));
    for (const x of [...up, ...down]) {
      if (!shared.has(x.id)) onLoop.add(x.id);
    }
  }

  const free = [];
  for (const j of tree) {
    if (!onLoop.has(j.id)) continue;
    if (j.driven || values[j.id]) continue;
    for (const name of jointDof(j)) free.push({ joint: j, name });
  }

  if (!free.length) {
    const out = place(values);
    for (const [k, v] of out) transforms.set(k, v);
    errors.push({
      id: closing[0].id,
      message:
        'These joints form a loop and every one of them is driven, so there is ' +
        'nothing left free to close it with'
    });
    return finish({ transforms, errors, loops: closing.length });
  }

  const start = free.map(({ joint, name }) =>
    clampToLimits(safeEval(joint[name], scope, 0), joint.limits, name)
  );

  const residual = (x) => {
    const vals = { ...values };
    free.forEach(({ joint, name }, i) => {
      vals[joint.id] = { ...(vals[joint.id] || {}), [name]: x[i] };
    });
    applyMotionLinks(opts.motionLinks, all, scope, vals);
    const placed = place(vals);
    const r = [];
    for (const j of closing) r.push(...closureResidual(j, placed, base, scope, vals[j.id]));
    return r;
  };

  const solved = gaussNewton(residual, start, { maxIterations: 60, tolerance: 1e-7 });
  const vals = { ...values };
  free.forEach(({ joint, name }, i) => {
    vals[joint.id] = { ...(vals[joint.id] || {}), [name]: solved.x[i] };
  });
  applyMotionLinks(opts.motionLinks, all, scope, vals);
  const out = place(vals);
  for (const [k, v] of out) transforms.set(k, v);

  if (!solved.converged) {
    errors.push({
      id: closing[0].id,
      message:
        'These joints form a loop that will not close. Check the lengths: a ' +
        'linkage can be asked for a position it cannot reach.'
    });
  }

  return finish({
    transforms,
    errors,
    loops: closing.length,
    solvedValues: vals,
    residual: solved.norm
  });
}

/**
 * Move components to satisfy their constraints, in the order they were made.
 *
 * A constraint carries its two faces as a point and a direction in each
 * component's own space, the same way a joint carries its origin, so it
 * survives the parts being moved by anything else first.
 *
 * Whatever hangs off the child by a joint comes with it. Moving a bracket
 * without the screw that is jointed into it would be a strange thing to do,
 * and leaving the screw behind is the sort of bug that is noticed three
 * assemblies later.
 */
function applyConstraints(transforms, list, tree, constraints, errors) {
  if (!constraints?.length) return;
  const known = new Set(list.map((c) => c.id));
  const kids = new Map();
  for (const j of tree || []) {
    if (!kids.has(j.parent)) kids.set(j.parent, []);
    kids.get(j.parent).push(j.child);
  }
  const withDescendants = (id) => {
    const out = [id];
    for (let i = 0; i < out.length && i < 4096; i++) {
      for (const k of kids.get(out[i]) || []) if (!out.includes(k)) out.push(k);
    }
    return out;
  };

  const worldFrame = (id, frame) => {
    const m = transforms.get(id);
    if (!m || !frame) return null;
    const p = new THREE.Vector3(...(frame.p || [0, 0, 0])).applyMatrix4(m);
    const n = new THREE.Vector3(...(frame.axis || [0, 0, 1]))
      .transformDirection(m)
      .normalize();
    return { p: [p.x, p.y, p.z], axis: [n.x, n.y, n.z] };
  };

  for (const c of constraints) {
    if (!c || !known.has(c.child) || !known.has(c.parent)) continue;
    const childFrame = worldFrame(c.child, c.childFrame);
    const parentFrame = worldFrame(c.parent, c.parentFrame);
    const step = constraintTransform(c.kind, childFrame, parentFrame, {
      offset: Number(c.offset) || 0,
      flip: !!c.flip
    });
    if (!step) {
      errors.push({
        id: c.id,
        message: 'Those two faces cannot be brought together. Check they are not the same face.'
      });
      continue;
    }

    const move = new THREE.Matrix4().makeRotationAxis(
      new THREE.Vector3(...step.rotation.axis),
      step.rotation.angle
    );
    move.premultiply(new THREE.Matrix4().makeTranslation(...step.translation));
    for (const id of withDescendants(c.child)) {
      const m = transforms.get(id);
      if (m) transforms.set(id, m.clone().premultiply(move));
    }
  }
}

/**
 * How far a closing joint is from being satisfied.
 *
 * The two components are already placed by the tree, so the joint's own origin
 * has ended up in two places at once, one carried by each side. Whatever
 * separates them along a direction the joint does not allow is error; whatever
 * separates them along one it does allow is simply the joint doing its job and
 * must not be counted, or the solver would fight the mechanism.
 */
function closureResidual(joint, placed, base, scope, vals) {
  const pw = placed.get(joint.parent);
  const cw = placed.get(joint.child);
  if (!pw || !cw) return [];

  const pb = base.get(joint.parent) || new THREE.Matrix4();
  const cb = base.get(joint.child) || new THREE.Matrix4();
  // Where each side has carried the shared origin frame to.
  const originFrame = new THREE.Matrix4().makeTranslation(
    joint.origin?.p?.[0] || 0,
    joint.origin?.p?.[1] || 0,
    joint.origin?.p?.[2] || 0
  );
  const fromParent = pw
    .clone()
    .multiply(pb.clone().invert())
    .multiply(motionMatrix(joint, scope, vals))
    .multiply(originFrame);
  const fromChild = cw.clone().multiply(cb.clone().invert()).multiply(originFrame);

  const rel = fromParent.clone().invert().multiply(fromChild);
  const t = new THREE.Vector3().setFromMatrixPosition(rel);
  const q = new THREE.Quaternion().setFromRotationMatrix(rel);
  // The vector part of a quaternion is the rotation axis times the sine of half
  // the angle, which is a fine small-angle error measure and needs no atan2.
  const rot = new THREE.Vector3(q.x, q.y, q.z);
  if (q.w < 0) rot.negate();

  const { a, b } = jointAxes(joint);
  const perp = (v, axis) => v.clone().sub(axis.clone().multiplyScalar(v.dot(axis)));
  const out = [];
  const push = (v) => out.push(v.x, v.y, v.z);

  switch (joint.type) {
    case 'revolute':
      push(t);
      push(perp(rot, a));
      break;
    case 'slider':
      push(perp(t, a));
      push(rot);
      break;
    case 'cylindrical':
      push(perp(t, a));
      push(perp(rot, a));
      break;
    case 'pinSlot':
      push(perp(t, b));
      push(perp(rot, a));
      break;
    case 'planar':
      out.push(t.dot(a));
      push(perp(rot, a));
      break;
    case 'ball':
      push(t);
      break;
    default:
      push(t);
      push(rot);
      break;
  }
  return out;
}

/**
 * Gauss-Newton with Levenberg damping, on a numerical Jacobian.
 *
 * The systems here are tiny, a handful of unknowns against a handful of
 * residuals, so a dense solve of the normal equations is both simplest and
 * fastest. The damping is what stops it throwing itself across the room when a
 * linkage passes through a position where the Jacobian goes thin, which for a
 * four bar is every time it lines up straight.
 */
function gaussNewton(residual, x0, opts = {}) {
  const maxIterations = opts.maxIterations || 50;
  const tolerance = opts.tolerance || 1e-7;
  const n = x0.length;
  let x = x0.slice();
  let r = residual(x);
  let norm = normOf(r);
  let lambda = 1e-3;

  for (let iter = 0; iter < maxIterations && norm > tolerance; iter++) {
    const m = r.length;
    if (!m) break;

    // Central differences: an angle in degrees needs a step big enough to move
    // the residual out of the floating point grass.
    const J = [];
    const h = 1e-4;
    for (let j = 0; j < n; j++) {
      const up = x.slice();
      const down = x.slice();
      up[j] += h;
      down[j] -= h;
      const ru = residual(up);
      const rd = residual(down);
      const col = new Array(m);
      for (let i = 0; i < m; i++) col[i] = (ru[i] - rd[i]) / (2 * h);
      J.push(col);
    }

    // Normal equations, JtJ + lambda I, solved by Gaussian elimination.
    const A = [];
    for (let i = 0; i < n; i++) {
      A.push(new Array(n + 1).fill(0));
      for (let k = 0; k < n; k++) {
        let s = 0;
        for (let q = 0; q < m; q++) s += J[i][q] * J[k][q];
        A[i][k] = s + (i === k ? lambda * (1 + s) : 0);
      }
      let g = 0;
      for (let q = 0; q < m; q++) g += J[i][q] * r[q];
      A[i][n] = -g;
    }

    const step = solveDense(A, n);
    if (!step) break;

    const trial = x.map((v, i) => v + step[i]);
    const rt = residual(trial);
    const nt = normOf(rt);
    if (nt < norm) {
      x = trial;
      r = rt;
      norm = nt;
      lambda = Math.max(1e-9, lambda * 0.4);
    } else {
      lambda *= 6;
      if (lambda > 1e7) break;
    }
  }

  return { x, norm, converged: norm <= Math.max(tolerance, 1e-5) };
}

function normOf(r) {
  let s = 0;
  for (const v of r) s += v * v;
  return Math.sqrt(s);
}

/** Gaussian elimination with partial pivoting on an n by n+1 augmented matrix. */
function solveDense(A, n) {
  for (let col = 0; col < n; col++) {
    let best = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[best][col])) best = row;
    }
    if (Math.abs(A[best][col]) < 1e-14) return null;
    [A[col], A[best]] = [A[best], A[col]];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = A[row][col] / A[col][col];
      if (!f) continue;
      for (let k = col; k <= n; k++) A[row][k] -= f * A[col][k];
    }
  }
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = A[i][n] / A[i][i];
  return x.every(Number.isFinite) ? x : null;
}

/* ------------------------------------------------------------------ */
/* Contact                                                             */
/* ------------------------------------------------------------------ */

/**
 * How far a joint can be driven before the parts in a contact set touch.
 *
 * Deliberately not a physics engine: it walks the one degree of freedom being
 * driven from where it rests towards where it was asked to go, and stops at the
 * last position that does not overlap. That is what stops a lid closing through
 * its own hinge, which is what contact is wanted for, and it says plainly that
 * it is nothing more.
 */
export function limitByContact(from, to, overlapsAt, steps = 24) {
  if (!overlapsAt(from)) {
    if (!overlapsAt(to)) return to;
  } else {
    // Already touching where it started; there is nothing to walk.
    return from;
  }

  let good = from;
  let bad = to;
  for (let i = 0; i < steps; i++) {
    const mid = (good + bad) / 2;
    if (overlapsAt(mid)) bad = mid;
    else good = mid;
    if (Math.abs(bad - good) < 1e-4) break;
  }
  return good;
}

/* ------------------------------------------------------------------ */
/* Constraints                                                         */
/* ------------------------------------------------------------------ */

/**
 * Where a component has to go to put one of its faces against another.
 *
 * This is the other way of assembling, and it is worth having alongside joints
 * rather than instead of them. A joint says how two parts may move relative to
 * each other for ever after. A constraint says where a part goes now: put this
 * face flat on that one. Most of the time that is all anybody wants, and being
 * made to define a joint origin first is why people give up and type
 * coordinates.
 *
 * Three kinds, and each takes away something different:
 *
 * **Mate** puts two faces together, touching, facing into each other. That is
 * what two parts bolted flat against each other are.
 *
 * **Flush** puts two faces in one plane facing the same way, which is what two
 * parts lined up along an edge are. The difference from mate is the direction
 * the second face ends up pointing, and getting it the wrong way round turns a
 * part inside its neighbour, so the two are separate rather than one command
 * with a tick box.
 *
 * **Concentric** puts two round faces on one axis, which is a shaft in a bore.
 * It says nothing about how far along, on purpose: that is what is left free,
 * and it is usually a mate on an end face that decides it.
 *
 * Each returns a transform to apply to the child, or null when the two frames
 * cannot be brought together at all.
 */
export function constraintTransform(kind, childFrame, parentFrame, opts = {}) {
  if (!childFrame || !parentFrame) return null;
  const cn = unitOf(childFrame.axis || childFrame.normal);
  const pn = unitOf(parentFrame.axis || parentFrame.normal);
  if (!cn || !pn) return null;

  const offset = opts.offset || 0;
  const flip = !!opts.flip;
  // Mate turns the child to face into the parent; flush turns it to face the
  // same way. Which of those is wanted is the whole of the difference.
  let want = kind === 'flush' ? pn.slice() : [-pn[0], -pn[1], -pn[2]];
  if (kind === 'concentric') want = pn.slice();
  if (flip) want = [-want[0], -want[1], -want[2]];

  const turn = rotationBetween(cn, want);
  if (!turn) return null;

  // Where the child's own point lands once it has been turned.
  const p = childFrame.p || childFrame.origin;
  if (!p) return null;
  const turned = applyRotation(turn, p);

  let target;
  if (kind === 'concentric') {
    // Onto the parent's axis, keeping wherever it already sits along that axis.
    // A shaft slid into a bore has not been told how far in to go.
    const q = parentFrame.p || parentFrame.origin;
    const d = [turned[0] - q[0], turned[1] - q[1], turned[2] - q[2]];
    const along = d[0] * want[0] + d[1] * want[1] + d[2] * want[2];
    target = [
      q[0] + want[0] * along,
      q[1] + want[1] * along,
      q[2] + want[2] * along
    ];
  } else {
    const q = parentFrame.p || parentFrame.origin;
    // An offset holds the two apart along the parent's own normal, which is
    // what a shim or a running clearance is.
    target = [q[0] + pn[0] * offset, q[1] + pn[1] * offset, q[2] + pn[2] * offset];
  }

  return {
    rotation: turn,
    translation: [target[0] - turned[0], target[1] - turned[1], target[2] - turned[2]]
  };
}

/**
 * The shortest turn that takes one direction onto another.
 *
 * Rodrigues, with the two degenerate cases written out. Already pointing the
 * right way is no turn at all. Pointing exactly the wrong way has no shortest
 * turn, because every half turn about every direction square to it does the
 * job, so one such direction is picked and the ambiguity is stated here rather
 * than left to surface as a part that flips when a number is nudged.
 */
export function rotationBetween(from, to) {
  const a = unitOf(from);
  const b = unitOf(to);
  if (!a || !b) return null;
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d > 1 - 1e-12) return { axis: [0, 0, 1], angle: 0 };
  if (d < -1 + 1e-12) {
    const seed = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const axis = unitOf(crossOf(a, seed));
    return axis ? { axis, angle: Math.PI } : null;
  }
  const axis = unitOf(crossOf(a, b));
  return axis ? { axis, angle: Math.acos(Math.max(-1, Math.min(1, d))) } : null;
}

/** One point through a turn about an axis through the origin. */
export function applyRotation(turn, p) {
  if (!turn || !turn.angle) return [p[0], p[1], p[2]];
  const k = turn.axis;
  const c = Math.cos(turn.angle);
  const s = Math.sin(turn.angle);
  const kd = k[0] * p[0] + k[1] * p[1] + k[2] * p[2];
  const kx = crossOf(k, p);
  return [
    p[0] * c + kx[0] * s + k[0] * kd * (1 - c),
    p[1] * c + kx[1] * s + k[1] * kd * (1 - c),
    p[2] * c + kx[2] * s + k[2] * kd * (1 - c)
  ];
}

/** What a constraint leaves free, said the way the joint list says it. */
export function constraintDof(kind) {
  if (kind === 'concentric') return { slide: 1, turn: 1 };
  return { slide: 2, turn: 1 };
}

function unitOf(v) {
  if (!v) return null;
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

function crossOf(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

/** A joint's origin, captured from where the parts currently sit. */
export function captureJointOrigin(point, axis, axis2) {
  const o = {
    p: [point[0], point[1], point[2]],
    axis: [axis[0], axis[1], axis[2]]
  };
  if (axis2) o.axis2 = [axis2[0], axis2[1], axis2[2]];
  return o;
}
