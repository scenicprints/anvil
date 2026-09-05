/**
 * Solid modelling kernel.
 *
 * Wraps manifold-3d, which is a watertight mesh boolean engine. Every solid it
 * produces is manifold by construction, which is exactly the guarantee a slicer
 * wants. WASM objects are reference counted by hand, so every operation that
 * creates an intermediate registers it with the active scope for disposal.
 */

import Module from '../../node_modules/manifold-3d/manifold.js';
import { MIN_CIRCULAR_ANGLE, MIN_CIRCULAR_EDGE } from './profile.js';

let wasm = null;
let ManifoldCls = null;
let CrossSectionCls = null;

export async function initKernel() {
  if (wasm) return wasm;
  wasm = await Module();
  wasm.setup();
  ManifoldCls = wasm.Manifold;
  CrossSectionCls = wasm.CrossSection;

  wasm.setMinCircularAngle(MIN_CIRCULAR_ANGLE);
  wasm.setMinCircularEdgeLength(MIN_CIRCULAR_EDGE);
  return wasm;
}

/** How many segments the kernel will use for a circle of this radius. */
export function circularSegments(radius) {
  return wasm ? wasm.getCircularSegments(radius) : 32;
}

export function isReady() {
  return !!wasm;
}

/* ------------------------------------------------------------------ */
/* Lifetime management                                                 */
/* ------------------------------------------------------------------ */

/**
 * Collects every WASM handle created during a rebuild so they can be freed in
 * one pass. Handles that survive as results are released from the scope first.
 */
export class Scope {
  constructor() {
    this.items = new Set();
  }

  track(obj) {
    if (obj && typeof obj.delete === 'function') this.items.add(obj);
    return obj;
  }

  release(obj) {
    this.items.delete(obj);
    return obj;
  }

  dispose() {
    for (const obj of this.items) {
      try {
        obj.delete();
      } catch {
        /* already gone */
      }
    }
    this.items.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

export function crossSection(contours, scope) {
  const cs = new CrossSectionCls(contours, 'EvenOdd');
  return scope.track(cs);
}

/**
 * Extrude planar contours.
 * `taperDeg` narrows (positive) or widens (negative) toward the top.
 */
export function extrudeContours(contours, opts, scope) {
  const {
    height,
    taperDeg = 0,
    twistDeg = 0,
    center = false,
    divisions = 0
  } = opts;

  const cs = crossSection(contours, scope);
  let scale = 1;
  if (taperDeg) {
    // Approximate a draft angle by shrinking the top face uniformly.
    const bounds = cs.bounds();
    const span = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1]
    ) / 2;
    if (span > 1e-9) {
      const inset = Math.tan((taperDeg * Math.PI) / 180) * height;
      scale = Math.max(0, 1 - inset / span);
    }
  }
  const nDiv = twistDeg || taperDeg ? Math.max(divisions, 1) : divisions;
  // scaleTop must be given as a pair. The binding accepts a bare number but
  // reads it as {x, 0}, which silently extrudes a wedge of half the volume.
  const solid = cs.extrude(height, nDiv, twistDeg, [scale, scale], center);
  return scope.track(solid);
}

export function revolveContours(contours, degrees, segments, scope) {
  const cs = crossSection(contours, scope);
  const solid = cs.revolve(segments || 0, degrees);
  return scope.track(solid);
}

export function offsetContours(contours, delta, joinType, scope) {
  const cs = crossSection(contours, scope);
  const off = cs.offset(delta, joinType || 'Round', 2, 0);
  return scope.track(off);
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export function box(size, center, scope) {
  return scope.track(ManifoldCls.cube(size, !!center));
}

export function cylinder(height, rLow, rHigh, segments, center, scope) {
  return scope.track(
    ManifoldCls.cylinder(height, rLow, rHigh === undefined ? rLow : rHigh, segments || 0, !!center)
  );
}

export function sphere(radius, segments, scope) {
  return scope.track(ManifoldCls.sphere(radius, segments || 0));
}

/* ------------------------------------------------------------------ */
/* Booleans and transforms                                             */
/* ------------------------------------------------------------------ */

export function union(a, b, scope) {
  return scope.track(a.add(b));
}

export function difference(a, b, scope) {
  return scope.track(a.subtract(b));
}

export function intersection(a, b, scope) {
  return scope.track(a.intersect(b));
}

export function unionAll(list, scope) {
  if (!list.length) return null;
  let acc = list[0];
  for (let i = 1; i < list.length; i++) acc = scope.track(acc.add(list[i]));
  return acc;
}

/** Apply a column-major 4x4 matrix (Three.js Matrix4.elements layout). */
export function transform(solid, matrixElements, scope) {
  return scope.track(solid.transform(Array.from(matrixElements)));
}

export function translate(solid, v, scope) {
  return scope.track(solid.translate(v));
}

export function mirrorAcross(solid, normal, scope) {
  return scope.track(solid.mirror(normal));
}

export function copy(solid, scope) {
  // A zero translation is the cheapest way to get an independent handle.
  return scope.track(solid.translate([0, 0, 0]));
}

/* ------------------------------------------------------------------ */
/* Inspection                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

/**
 * Which feature each piece of geometry came from.
 *
 * manifold can mark a solid as an original, after which every triangle of it,
 * and of anything later cut or joined out of it, still says which original it
 * belongs to and which flat face of that original it was part of. That is the
 * persistent naming problem solved at the source rather than guessed at
 * afterwards from position and size.
 *
 * The IDs manifold hands out are per run and start again every rebuild, so they
 * are useless to store. They are mapped here to a tag of our own choosing, the
 * feature's id, which does not change. The map is cleared at the start of each
 * rebuild.
 */
const originalTags = new Map();

export function resetOriginalTags() {
  originalTags.clear();
}

/**
 * Mark a solid as having come from `tag`, and hand back the marked copy.
 *
 * The result is a different object from the input; the caller must use it.
 */
export function tagOriginal(solid, tag, scope) {
  if (!solid || !tag) return solid;
  try {
    const marked = scope ? scope.track(solid.asOriginal()) : solid.asOriginal();
    const id = marked.originalID();
    if (id < 0) return marked;

    // The face ids manifold hands out come from a counter that keeps climbing
    // through the whole run, so the same face of the same shape gets a
    // different number on the next rebuild and a stored reference to it is
    // worthless. They are renumbered here against this solid's own mesh, in
    // order of first appearance, which is the same order every time the same
    // shape is built. That local number is what gets written down.
    const faceMap = new Map();
    try {
      const mesh = marked.getMesh();
      if (mesh.faceID) {
        for (let t = 0; t < mesh.faceID.length; t++) {
          const f = mesh.faceID[t];
          if (!faceMap.has(f)) faceMap.set(f, faceMap.size);
        }
      }
    } catch {
      /* no face ids to renumber, so the tag alone will have to do */
    }

    originalTags.set(id, { tag, faceMap });
    return marked;
  } catch {
    // Marking is an improvement on the geometric match, never a requirement,
    // so a kernel that will not do it must not break the build.
    return solid;
  }
}

export function tagOf(originalID) {
  return originalTags.get(originalID)?.tag ?? null;
}

export function meshData(solid) {
  const mesh = solid.getMesh();
  const out = {
    numProp: mesh.numProp,
    vertProperties: mesh.vertProperties,
    triVerts: mesh.triVerts
  };

  // Per triangle: which feature it came from, and which face of that feature's
  // own geometry. Resolved here so nothing downstream ever sees a raw id.
  const runs = mesh.runOriginalID;
  const runIndex = mesh.runIndex;
  const faceID = mesh.faceID;
  if (runs && runIndex && faceID) {
    const triCount = mesh.triVerts.length / 3;
    const triTag = new Array(triCount).fill(null);
    const triFace = new Int32Array(triCount).fill(-1);
    for (let r = 0; r < runs.length; r++) {
      const entry = originalTags.get(runs[r]);
      if (!entry) continue;
      // runIndex counts triVerts entries, three to a triangle.
      const from = Math.floor(runIndex[r] / 3);
      const to = Math.floor(runIndex[r + 1] / 3);
      for (let t = from; t < to && t < triCount; t++) {
        triTag[t] = entry.tag;
        const local = entry.faceMap.get(faceID[t]);
        triFace[t] = local === undefined ? -1 : local;
      }
    }
    out.triTag = triTag;
    out.triFaceID = triFace;
  }
  return out;
}

export function properties(solid) {
  return {
    volume: solid.volume(),
    surfaceArea: solid.surfaceArea(),
    genus: solid.genus(),
    numTri: solid.numTri(),
    numVert: solid.numVert()
  };
}

export function boundingBox(solid) {
  return solid.boundingBox();
}

export function isEmpty(solid) {
  return !solid || solid.isEmpty();
}

/** Smooth an existing solid, used for the display-only rounded preview. */
export function refine(solid, n, scope) {
  return scope.track(solid.refine(n));
}

/**
 * Build a solid from triangles assembled by hand. Used where a feature's tool
 * geometry is easier to state as a mesh than as a boolean of primitives, such
 * as the prism standing on an arbitrary face.
 */
export function ofMesh(vertProperties, triVerts, scope) {
  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties:
      vertProperties instanceof Float32Array
        ? vertProperties
        : new Float32Array(vertProperties),
    triVerts: triVerts instanceof Uint32Array ? triVerts : new Uint32Array(triVerts)
  });
  mesh.merge();
  return scope.track(ManifoldCls.ofMesh(mesh));
}

export function status(solid) {
  try {
    return solid.status();
  } catch {
    return 'unknown';
  }
}

export function raw() {
  return { Manifold: ManifoldCls, CrossSection: CrossSectionCls, wasm };
}
