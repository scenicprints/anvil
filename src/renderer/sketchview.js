/**
 * The 2D sketch editor.
 *
 * Sketch geometry lives in plane coordinates and is drawn in 3D on the sketch
 * plane, so the model stays visible behind the sketch. Interaction projects the
 * cursor ray onto that plane, which means sketching works from any viewing
 * angle rather than only face-on.
 *
 * Drawing applies constraints as it goes, the way a person expects: a line
 * drawn within a couple of degrees of level gets a horizontal constraint, and a
 * click landing on an existing endpoint reuses that point outright, which is
 * coincidence expressed as shared identity rather than as an equation.
 */

import * as THREE from './three.js';
import { solveSketch } from './solver.js';
import {
  tessellate,
  materializeSketch,
  entityLoops,
  entityRuns,
  findRegions,
  pointInPolygon,
  entityEndpoints,
  ellipseFrame,
  TAU
} from './profile.js';
import { sketchToWorld, worldToSketch, resolveDimensionExprs } from './features.js';
import { safeEval } from './expr.js';
import { textContours } from './textoutline.js';
import { endFrame, blendControls } from './blend.js';

/**
 * The point indices an entity is built from, and the one place that knows it.
 *
 * There were five copies of this walk (used-point test, selection, paste,
 * point compaction twice), so a new entity type meant finding all five and
 * adding a case, and missing one leaves a sketch whose points silently
 * renumber out from under it.
 */
export function entityPoints(ent) {
  if (!ent) return [];
  switch (ent.type) {
    case 'line':
      return [ent.p[0], ent.p[1]];
    case 'circle':
      return [ent.c];
    case 'arc':
      return [ent.c, ent.p[0], ent.p[1]];
    case 'spline':
    case 'bspline':
      return [...ent.p];
    case 'conic':
      return [ent.p[0], ent.p[1], ent.v];
    case 'ellipse':
      return [ent.c, ent.a, ent.b];
    case 'point':
    case 'text':
      return [ent.p];
    default:
      return [];
  }
}

/** Rewrite an entity's point indices through `fn`, in place. */
export function remapEntityPoints(ent, fn) {
  if (!ent) return ent;
  switch (ent.type) {
    case 'line':
      ent.p = [fn(ent.p[0]), fn(ent.p[1])];
      break;
    case 'circle':
      ent.c = fn(ent.c);
      break;
    case 'arc':
      ent.c = fn(ent.c);
      ent.p = [fn(ent.p[0]), fn(ent.p[1])];
      break;
    case 'spline':
    case 'bspline':
      ent.p = ent.p.map(fn);
      break;
    case 'conic':
      ent.p = [fn(ent.p[0]), fn(ent.p[1])];
      ent.v = fn(ent.v);
      break;
    case 'ellipse':
      ent.c = fn(ent.c);
      ent.a = fn(ent.a);
      ent.b = fn(ent.b);
      break;
    case 'point':
    case 'text':
      ent.p = fn(ent.p);
      break;
    default:
      break;
  }
  return ent;
}

const SNAP_PX = 10;
const AXIS_SNAP_DEG = 2.5;
// Travel in pixels between press and release above which the release counts
// as the next click rather than the end of a click.
const DRAG_DRAW_MIN = 6;

/**
 * The boxes that appear beside the cursor once a shape has its first point, so
 * a size can be typed rather than aimed at. Only tools whose typed value turns
 * into a real driving dimension are listed; the rest keep their click
 * behaviour rather than offering a field that quietly does nothing.
 */
const ENTRY_FIELDS = {
  line: [
    { key: 'length', label: 'Length' },
    { key: 'angle', label: 'Angle', unit: 'deg' }
  ],
  rectangle: [
    { key: 'width', label: 'Width' },
    { key: 'height', label: 'Height' }
  ],
  centerRectangle: [
    { key: 'width', label: 'Width' },
    { key: 'height', label: 'Height' }
  ],
  circle: [{ key: 'diameter', label: 'Diameter' }],
  circleDia: [{ key: 'diameter', label: 'Diameter' }]
};

/**
 * The text worth storing on a dimension beside its value, or null when the text
 * was only ever the number. Keeping `2in` or `wall * 2` is what lets the
 * dimension be re-read later; keeping `40` would just be noise.
 */
function exprOf(text, value) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  return Number(t) === value ? null : t;
}

/** Short number for a field that is changing under the cursor. */
function fmtEntry(v) {
  return String(Math.round(v * 1000) / 1000);
}

/** Degrees from the sketch X axis, in [0, 360). */
function angleOf(dx, dy) {
  const a = (Math.atan2(dy, dx) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
}

const COLORS = {
  // Geometry the model put here, not the sketch: near black would read as
  // ordinary drawing and blue as unconstrained, and it is neither.
  projected: 0x8a6d3b,
  // On a light ground the ordinary CAD convention holds: geometry that is
  // pinned down draws near black, and anything still free to move draws blue.
  // The accent is spent on the selection alone, so hover stays a grey whisper.
  normal: 0x26241e,
  loose: 0x3a5f8a,
  construction: 0x7a7490,
  selected: 0xd84b1e,
  hover: 0x8d8980,
  point: 0x33312b,
  fixedPoint: 0x3d7a44,
  preview: 0x86837b,
  guide: 0xa39e93
};

export class SketchEditor {
  constructor(viewport, overlayEl) {
    this.vp = viewport;
    this.overlayEl = overlayEl;

    this.active = false;
    this.sketch = null;
    this.plane = null;

    this.tool = 'select';
    this.pending = null;
    // Where a press that started a shape went down, so releasing away from it
    // can stand in for the second click.
    this.dragDraw = null;
    // Boxes for typing a size instead of aiming one, live while a shape is
    // half made. See beginEntry.
    this.entry = null;
    this.entryEl = null;
    this.paramScope = {};
    // Set by the host so dimension labels read in the document's unit.
    this.displayLength = null;
    // A rubber band being dragged out over empty space, in sketch coordinates.
    this.band = null;
    this.bandEl = null;
    // What Ctrl+C took, ready to be pasted.
    this.clipboard = null;
    this.cursor = { x: 0, y: 0 };
    this.snapInfo = null;

    this.selection = new Set();
    this.hovered = null;
    this.dragging = null;
    this.regions = [];
    this.selectedRegions = new Set();

    this.showConstraints = true;
    this.snapToGrid = false;
    this.gridStep = 1;

    this.group = new THREE.Group();
    this.group.renderOrder = 5;
    this.vp.overlayGroup.add(this.group);

    this.labels = [];
    this.onChange = null;
    this.onBeforeChange = null;
    this.onStatus = null;
    this.onDimensionRequest = null;
    this.onTextRequest = null;
    // Geometry the model puts into this sketch: projected edges and the
    // section where a body crosses the plane. It is rebuilt from the model
    // every time, so it is drawn but never selected, dragged or dimensioned.
    this.derived = null;
    this.onRegionsChanged = null;

    this._pointTexture = this._makePointTexture();
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  begin(sketch, plane) {
    this.active = true;
    this.sketch = sketch;
    this.plane = plane;
    this.selection.clear();
    this.selectedRegions.clear();
    this.pending = null;
    this.dragDraw = null;
    this.endEntry();
    this.band = null;
    this.hideBand();
    this.tool = 'select';
    this.rebuild();
  }

  end() {
    this.active = false;
    this.sketch = null;
    this.pending = null;
    this.dragDraw = null;
    this.endEntry();
    this.band = null;
    this.hideBand();
    this.clearGraphics();
    this.clearLabels();
  }

  setTool(tool) {
    this.pending = null;
    this.dragDraw = null;
    this.endEntry();
    this.band = null;
    this.hideBand();
    this.tool = tool;
    this.status(this.toolHint(tool));
    this.rebuild();
  }

  toolHint(tool) {
    const hints = {
      select: 'Select. Drag geometry to reshape it.',
      line: 'Click points for a chain. Escape or double click ends it.',
      rectangle: 'Click two opposite corners.',
      centerRectangle: 'Click the centre, then a corner.',
      circle: 'Click the centre, then a point on the circle.',
      circleDia: 'Click two opposite points on the circle.',
      arc: 'Click the centre, the start, then the end.',
      arc3: 'Click the start, the end, then a point on the arc.',
      polygon: 'Click the centre, then a vertex.',
      slot: 'Click the two centres, then the width.',
      fillet: 'Click a corner between two lines.',
      chamfer: 'Click a corner between two lines.',
      offset: 'Click a curve to offset it.',
      trim: 'Click the piece of a curve to remove.',
      dimension: 'Click geometry to dimension it.',
      point: 'Click to place a point.',
      spline: 'Click points along the curve. Escape or double click ends it.',
      ellipse: 'Click the centre, the end of the long axis, then how wide.',
      text: 'Click where the text starts.',
      breakCurve: 'Click a curve where another crosses it, to cut it there.',
      extend: 'Click the end of a curve to run it on to what it meets.',
      polygonCirc: 'Click the centre, then out to the middle of an edge.',
      polygonEdge: 'Click the two ends of one edge.',
      slotOverall: 'Click each far end, then the width.',
      slotCentre: 'Click the middle, then one end, then the width.',
      slotArc3: 'Click both ends, a point on the arc, then the width.',
      slotArcCentre: 'Click the arc centre, both ends, then the width.',
      rectangle3: 'Click two corners of one edge, then the width.',
      conic: 'Click both ends, then the vertex their tangents meet at.',
      splineCP: 'Click control points. The curve is pulled towards them.',
      circle3: 'Click three points the circle should pass through.',
      blendCurve: 'Click the loose end of one curve, then of another.',
      blendCurveG1: 'Click the loose end of one curve, then of another.',
      circleTan2: 'Click two lines, then where the circle goes.',
      circleTan3: 'Click three lines it should touch.',
      tangentArc: 'Click the end of a curve, then where the arc should finish.'
    };
    return hints[tool] || '';
  }

  status(msg) {
    if (this.onStatus) this.onStatus(msg);
  }

  /* ---------------------------------------------------------------- */
  /* Coordinate conversion                                             */
  /* ---------------------------------------------------------------- */

  screenToPlane(clientX, clientY) {
    const rc = this.vp.raycastRay(clientX, clientY);
    const n = new THREE.Vector3(...this.plane.n);
    const o = new THREE.Vector3(...this.plane.origin);
    const geoPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
    const hit = new THREE.Vector3();
    if (!rc.ray.intersectPlane(geoPlane, hit)) return null;
    const local = worldToSketch(this.plane, hit);
    return { x: local.u, y: local.v };
  }

  planeToScreen(x, y) {
    const world = sketchToWorld(this.plane, x, y, 0);
    const v = world.clone().project(this.vp.camera);
    const rect = this.vp.canvas.getBoundingClientRect();
    return {
      x: ((v.x + 1) / 2) * rect.width,
      y: ((-v.y + 1) / 2) * rect.height,
      behind: v.z > 1
    };
  }

  /** World length of one screen pixel on the sketch plane. */
  pixelScale() {
    const a = this.planeToScreen(0, 0);
    const b = this.planeToScreen(1, 0);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return d > 1e-6 ? 1 / d : 0.1;
  }

  /* ---------------------------------------------------------------- */
  /* Points and entities                                               */
  /* ---------------------------------------------------------------- */

  addPoint(x, y, z) {
    this.sketch.points.push({ x, y, ...(z ? { z } : {}) });
    return this.sketch.points.length - 1;
  }

  /** Reuse an existing point when the snap landed on one, else make a new one. */
  resolvePoint(pos, snap) {
    if (snap && snap.pointIndex !== undefined && snap.pointIndex !== null) {
      return snap.pointIndex;
    }
    const idx = this.addPoint(pos.x, pos.y);
    if (
      !this.suppressAuto &&
      snap && snap.entityId !== undefined && snap.entityId !== null && snap.onCurve
    ) {
      const ent = this.entity(snap.entityId);
      if (ent) {
        if (ent.type === 'line') {
          this.addConstraint({ type: 'pointOnLine', point: idx, entity: ent.id });
        } else {
          this.addConstraint({ type: 'pointOnCircle', point: idx, entity: ent.id });
        }
      }
    }
    return idx;
  }

  entity(id) {
    return this.sketch.entities.find((e) => e.id === id);
  }

  nextId() {
    return this.sketch.nextEntityId++;
  }

  addEntity(ent) {
    ent.id = this.nextId();
    ent.construction = !!this.constructionMode;
    this.sketch.entities.push(ent);
    return ent;
  }

  addConstraint(c) {
    c.id = `c${this.sketch.nextEntityId++}`;
    this.sketch.constraints.push(c);
    return c;
  }

  removeEntity(id) {
    const i = this.sketch.entities.findIndex((e) => e.id === id);
    if (i < 0) return;
    this.sketch.entities.splice(i, 1);
    this.sketch.constraints = this.sketch.constraints.filter(
      (c) =>
        c.entity !== id && !(c.entities && c.entities.includes(id))
    );
  }

  /* ---------------------------------------------------------------- */
  /* Snapping                                                          */
  /* ---------------------------------------------------------------- */

  snap(pos, opts = {}) {
    const px = this.pixelScale();
    const tol = SNAP_PX * px;
    let best = null;
    const consider = (x, y, info, priority) => {
      const d = Math.hypot(x - pos.x, y - pos.y);
      if (d > tol) return;
      const score = d - priority * tol * 0.35;
      if (!best || score < best.score) {
        best = { x, y, score, ...info };
      }
    };

    // Origin always snaps; it is the anchor every sketch wants.
    consider(0, 0, { label: 'origin', originPoint: true }, 3);

    const skipPoints = opts.skipPoints || new Set();
    this.sketch.points.forEach((p, i) => {
      if (skipPoints.has(i)) return;
      if (!this.pointIsUsed(i)) return;
      consider(p.x, p.y, { pointIndex: i, label: 'point' }, 3);
    });

    for (const ent of this.sketch.entities) {
      if (opts.skipEntity === ent.id) continue;
      if (ent.type === 'line') {
        const a = this.sketch.points[ent.p[0]];
        const b = this.sketch.points[ent.p[1]];
        consider((a.x + b.x) / 2, (a.y + b.y) / 2, { entityId: ent.id, label: 'midpoint', midOf: ent.id }, 2);
      } else if (ent.c !== undefined) {
        // Only the entities that actually have one. This used to be a bare
        // else, which read `points[undefined]` for a spline, a point, a piece
        // of text or a conic and threw. A pointer handler swallows what it
        // throws, so the whole sketch simply stopped responding to clicks with
        // nothing said, and only from the moment one of those was drawn.
        const c = this.sketch.points[ent.c];
        if (!c) continue;
        consider(c.x, c.y, { pointIndex: ent.c, label: 'center' }, 2);
        if (ent.type === 'circle') {
          const dx = pos.x - c.x;
          const dy = pos.y - c.y;
          const d = Math.hypot(dx, dy) || 1;
          consider(
            c.x + (dx / d) * ent.r,
            c.y + (dy / d) * ent.r,
            { entityId: ent.id, label: 'on curve', onCurve: true },
            0
          );
        }
      }
    }

    // Projected and sectioned geometry is snapped to as well: it is put in the
    // sketch to be drawn against, so not catching it would defeat the point.
    if (this.derived?.entities?.length) {
      const D = { points: this.derived.points, entities: this.derived.entities };
      for (const p of this.derived.points) {
        consider(p.x, p.y, { label: 'projected' }, 2);
      }
      for (const ent of this.derived.entities) {
        const pts = tessellate(D, ent);
        for (let i = 0; i < pts.length - 1; i++) {
          const near = closestOnSegment(pos, pts[i], pts[i + 1]);
          consider(near.x, near.y, { label: 'on projected', onCurve: true }, 0);
        }
      }
    }

    // Nearest point on any curve.
    for (const ent of this.sketch.entities) {
      if (opts.skipEntity === ent.id) continue;
      if (ent.type === 'circle') continue;
      // Snapping to a letter's outline is hundreds of targets of pure noise.
      if (ent.type === 'text') continue;
      const pts = tessellate(this.sketch, ent);
      for (let i = 0; i < pts.length - 1; i++) {
        const near = closestOnSegment(pos, pts[i], pts[i + 1]);
        consider(near.x, near.y, { entityId: ent.id, label: 'on curve', onCurve: true }, 0);
      }
    }

    if (best) {
      this.snapInfo = best;
      return { x: best.x, y: best.y, snap: best };
    }

    if (this.snapToGrid && this.gridStep > 0) {
      const gx = Math.round(pos.x / this.gridStep) * this.gridStep;
      const gy = Math.round(pos.y / this.gridStep) * this.gridStep;
      if (Math.hypot(gx - pos.x, gy - pos.y) < tol) {
        this.snapInfo = { x: gx, y: gy, label: 'grid' };
        return { x: gx, y: gy, snap: this.snapInfo };
      }
    }

    this.snapInfo = null;
    return { x: pos.x, y: pos.y, snap: null };
  }

  pointIsUsed(i) {
    for (const e of this.sketch.entities) {
      if (entityPoints(e).includes(i)) return true;
    }
    return false;
  }

  /** Nudge a segment onto the horizontal or vertical when it is nearly there. */
  axisAlign(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return { pos: to, axis: null };
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const nearest = Math.round(angle / 90) * 90;
    if (Math.abs(angle - nearest) <= AXIS_SNAP_DEG) {
      const rad = (nearest * Math.PI) / 180;
      return {
        pos: { x: from.x + Math.cos(rad) * len, y: from.y + Math.sin(rad) * len },
        axis: nearest % 180 === 0 ? 'horizontal' : 'vertical'
      };
    }
    return { pos: to, axis: null };
  }

  /* ---------------------------------------------------------------- */
  /* Interaction                                                       */
  /* ---------------------------------------------------------------- */

  onPointerDown(e) {
    if (!this.active || e.button !== 0) return false;
    // Holding Ctrl stops constraints being inferred, for the times the guess
    // is wrong and fighting it costs more than adding them by hand.
    this.suppressAuto = e.ctrlKey;

    // A second click in the same place ends a chain, which is what every
    // drawing tool has trained people to expect.
    if (e.detail >= 2 && this.pending) {
      this.pending = null;
      this.dragDraw = null;
      this.endEntry();
      this.rebuild();
      return true;
    }

    this.dragDraw = null;

    const raw = this.screenToPlane(e.clientX, e.clientY);
    if (!raw) return false;

    const skipPoints = new Set();
    if (this.pending?.points) for (const p of this.pending.points) skipPoints.add(p);
    let { x, y, snap } = this.snap(raw, { skipPoints });

    if (this.tool === 'select') {
      return this.selectAt(e, { x, y }, snap);
    }

    // A typed size wins over where the click landed, so clicking to finish a
    // shape whose width was typed keeps that width.
    if (this.entryLocked()) {
      const target = this.entryTarget({ x, y });
      this.applyTool(target, null, e);
      return true;
    }

    this.applyTool({ x, y }, snap, e);
    // If that press left a shape half made, remember where it happened. A
    // release far enough away finishes the shape, so dragging a rectangle out
    // works as well as clicking its two corners.
    if (this.pending) this.dragDraw = { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey };
    return true;
  }

  onPointerMove(e) {
    if (!this.active) return;
    const raw = this.screenToPlane(e.clientX, e.clientY);
    if (!raw) return;

    const skipPoints = new Set();
    if (this.dragging) {
      // Everything being dragged has to be left out of the snap, or the points
      // travelling with the cursor snap to themselves and the drag goes nowhere.
      if (this.dragging.point !== undefined) skipPoints.add(this.dragging.point);
      for (const i of this.dragging.points || []) skipPoints.add(i);
    }
    if (this.pending?.points) for (const p of this.pending.points) skipPoints.add(p);
    const snapped = this.snap(raw, { skipPoints });
    this.cursor = { x: snapped.x, y: snapped.y };

    if (this.dragging) {
      this.dragTo(snapped);
      return;
    }

    if (this.band) {
      this.band.x1 = raw.x;
      this.band.y1 = raw.y;
      this.showBand();
      return;
    }

    if (this.tool === 'select') {
      this.updateHover(raw);
    }
    this.updateEntry(this.cursor);
    this.rebuild();
  }

  onPointerUp(e) {
    if (this.band) {
      this.finishBand();
      return;
    }
    if (this.dragging) {
      this.dragging = null;
      this.solve();
      this.commit();
      return;
    }

    // Only the button that started the shape finishes it. A middle drag to pan
    // ends in a release too, and must not drop a corner where the pan stopped.
    if (!e || e.button !== 0) return;
    const start = this.dragDraw;
    this.dragDraw = null;
    if (!start || !this.pending) return;
    // A click and a drag differ only by how far the pointer moved between down
    // and up, so anything under a few pixels is left to the second click.
    const far = Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > DRAG_DRAW_MIN;
    if (!far) return;

    const raw = this.screenToPlane(e.clientX, e.clientY);
    if (!raw) return;
    this.suppressAuto = start.ctrl || e.ctrlKey;
    const skipPoints = new Set(this.pending.points || []);
    const { x, y, snap } = this.snap(raw, { skipPoints });
    if (this.entryLocked()) {
      this.applyTool(this.entryTarget({ x, y }), null, e);
      return;
    }
    this.applyTool({ x, y }, snap, e);
  }

  onKeyDown(e) {
    if (!this.active) return false;

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') {
        this.copySelection();
        return true;
      }
      if (k === 'v') {
        this.pasteClipboard();
        return true;
      }
      if (k === 'd') {
        // Duplicate in place is a copy and a paste in one keystroke.
        if (!this.copySelection()) return true;
        this.pasteClipboard();
        return true;
      }
      if (k === 'a') {
        this.selection.clear();
        for (const ent of this.sketch.entities) this.selection.add(`e${ent.id}`);
        this.rebuild();
        this.commitSelection();
        this.status(`${this.selection.size} selected.`);
        return true;
      }
      return false;
    }

    // Nudge the selection with the arrow keys, a grid step at a time.
    if (e.key.startsWith('Arrow') && this.selection.size) {
      const step = (this.snapToGrid && this.gridStep > 0 ? this.gridStep : 1) * (e.shiftKey ? 10 : 1);
      const d = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step]
      }[e.key];
      if (d) {
        this.moveSelection(d[0], d[1]);
        return true;
      }
    }

    if (e.key === 'Escape') {
      if (this.band) {
        this.band = null;
        this.hideBand();
        this.rebuild();
        return true;
      }
      if (this.pending) {
        this.pending = null;
        this.endEntry();
        this.rebuild();
        return true;
      }
      if (this.tool !== 'select') {
        this.setTool('select');
        return true;
      }
      return false;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelection();
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Selection and dragging                                            */
  /* ---------------------------------------------------------------- */

  selectAt(e, pos, snap) {
    const additive = e.shiftKey || e.ctrlKey;
    const px = this.pixelScale();

    // A point under the cursor takes priority, and dragging it starts at once.
    if (snap && snap.pointIndex !== undefined && snap.pointIndex !== null) {
      const key = `p${snap.pointIndex}`;
      if (!additive) this.selection.clear();
      this.selection.add(key);
      this.announce();
      this.dragging = { point: snap.pointIndex };
      this.rebuild();
      return true;
    }

    const hit = this.entityAt(pos, px * SNAP_PX);
    if (hit) {
      const key = `e${hit.id}`;
      if (additive) {
        if (this.selection.has(key)) this.selection.delete(key);
        else this.selection.add(key);
      } else if (!this.selection.has(key)) {
        // Grabbing something outside the selection replaces it, so a press and
        // a drag in one motion moves the thing under the cursor.
        this.selection.clear();
        this.selection.add(key);
      }
      // Whatever is selected now travels together.
      if (this.selection.has(key)) this.beginSelectionDrag(pos);
      this.rebuild();
      this.commitSelection();
      return true;
    }

    const region = this.regionAt(pos);
    if (region) {
      if (!additive) this.selectedRegions.clear();
      if (this.selectedRegions.has(region.id)) this.selectedRegions.delete(region.id);
      else this.selectedRegions.add(region.id);
      this.rebuild();
      if (this.onRegionsChanged) this.onRegionsChanged();
      return true;
    }

    // Nothing under the cursor, so this is the start of a rubber band.
    this.band = { x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y, additive };
    if (!additive) {
      this.selection.clear();
      this.selectedRegions.clear();
      this.rebuild();
      this.commitSelection();
      if (this.onRegionsChanged) this.onRegionsChanged();
    }
    return true;
  }

  /**
   * Start moving everything selected. The point nearest the press leads, so the
   * drag snaps the way a single point drag does rather than sliding freely.
   */
  beginSelectionDrag(pos) {
    const points = [...this.selectedPoints()];
    if (!points.length) return;
    let lead = points[0];
    let bestD = Infinity;
    for (const i of points) {
      const p = this.sketch.points[i];
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d < bestD) {
        bestD = d;
        lead = i;
      }
    }
    this.announce();
    this.dragging = {
      lead,
      points,
      origin: points.map((i) => ({ i, x: this.sketch.points[i].x, y: this.sketch.points[i].y })),
      anchors: this.anchorsFor(new Set(points)),
      grab: { x: pos.x, y: pos.y }
    };
  }

  /** Select what the rubber band covers and put it away. */
  finishBand() {
    const b = this.band;
    this.band = null;
    this.hideBand();
    if (!b) return;
    const w = Math.abs(b.x1 - b.x0);
    const h = Math.abs(b.y1 - b.y0);
    if (w < 1e-9 && h < 1e-9) return;

    const lo = { x: Math.min(b.x0, b.x1), y: Math.min(b.y0, b.y1) };
    const hi = { x: Math.max(b.x0, b.x1), y: Math.max(b.y0, b.y1) };
    const inside = (p) => p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y;
    // Dragged rightwards takes only what is wholly inside; dragged leftwards
    // takes anything it touches. That is the convention every CAD package uses.
    const window = b.x1 >= b.x0;

    if (!b.additive) this.selection.clear();
    for (const ent of this.sketch.entities) {
      const pts = entityRuns(this.sketch, ent).flat();
      if (!pts.length) continue;
      const hit = window ? pts.every(inside) : pts.some(inside);
      if (hit) this.selection.add(`e${ent.id}`);
    }
    this.announce();
    this.rebuild();
    this.commitSelection();
    this.status(
      this.selection.size
        ? `${this.selection.size} selected. Drag to move, Ctrl+C to copy.`
        : 'Nothing in the box.'
    );
  }

  showBand() {
    if (!this.overlayEl || !this.band) return;
    if (!this.bandEl) {
      this.bandEl = document.createElement('div');
      this.bandEl.className = 'sk-band';
      this.overlayEl.appendChild(this.bandEl);
    }
    const a = this.planeToScreen(this.band.x0, this.band.y0);
    const c = this.planeToScreen(this.band.x1, this.band.y1);
    this.bandEl.classList.toggle('crossing', this.band.x1 < this.band.x0);
    this.bandEl.style.left = `${Math.min(a.x, c.x)}px`;
    this.bandEl.style.top = `${Math.min(a.y, c.y)}px`;
    this.bandEl.style.width = `${Math.abs(c.x - a.x)}px`;
    this.bandEl.style.height = `${Math.abs(c.y - a.y)}px`;
  }

  hideBand() {
    if (this.bandEl) {
      this.bandEl.remove();
      this.bandEl = null;
    }
  }

  /**
   * Ask the application for the wording and the size, then place the run.
   *
   * The outlines are worked out once and kept on the entity, because tracing
   * them is expensive and the letters do not change when the sketch solves.
   * Only the placing point does, so moving the text costs nothing.
   */
  requestText(pointIndex, existing = null) {
    if (!this.onTextRequest) return;
    const current = existing
      ? {
          text: existing.text,
          font: existing.font,
          height: existing.height,
          bold: existing.bold,
          italic: existing.italic,
          align: existing.align,
          angle: existing.angle
        }
      : { text: '', font: 'Arial', height: 10, bold: false, italic: false, align: 'left', angle: 0 };

    this.onTextRequest(current, (opts) => {
      if (!opts || !String(opts.text || '').trim()) {
        // Nothing typed and nothing to place, so the point goes back too
        // rather than being left behind as an orphan.
        if (!existing) this.compactPoints();
        this.rebuild();
        return;
      }
      const contours = textContours(opts.text, opts);
      if (!contours.length) {
        this.status('That text produced no outline. Check the font and the height.');
        return;
      }
      if (this.onBeforeChange) this.onBeforeChange();
      if (existing) {
        Object.assign(existing, opts, { contours });
      } else {
        this.addEntity({ type: 'text', p: pointIndex, ...opts, contours });
      }
      this.refreshRegions();
      this.announce();
      this.rebuild();
      this.status(`Text placed. ${contours.length} outline${contours.length === 1 ? '' : 's'}.`);
    });
  }

  /**
   * Drop parsed vector geometry into the open sketch.
   *
   * The entities arrive in the file's own frame with Y already the right way
   * up. Placing is a scale and an offset, so the same call serves both formats
   * and both are dropped where the caller asks rather than at the origin.
   */
  insertVector(entities, opts = {}) {
    const scale = Number(opts.scale) || 1;
    const ox = Number(opts.x) || 0;
    const oy = Number(opts.y) || 0;
    const at = (p) => this.addPoint(ox + p.x * scale, oy + p.y * scale);

    if (this.onBeforeChange) this.onBeforeChange();
    let made = 0;

    for (const e of entities) {
      if (e.kind === 'line') {
        const a = at(e.points[0]);
        const b = at(e.points[1]);
        if (a === b) continue;
        this.addEntity({ type: 'line', p: [a, b] });
        made++;
      } else if (e.kind === 'circle') {
        const c = at(e.centre);
        const r = e.r * scale;
        if (r > 1e-6) {
          this.addEntity({ type: 'circle', c, r });
          made++;
        }
      } else if (e.kind === 'arc') {
        const c = at(e.centre);
        const r = e.r * scale;
        if (r <= 1e-6) continue;
        const cp = this.sketch.points[c];
        const p0 = this.addPoint(cp.x + r * Math.cos(e.start), cp.y + r * Math.sin(e.start));
        const p1 = this.addPoint(cp.x + r * Math.cos(e.end), cp.y + r * Math.sin(e.end));
        this.addEntity({ type: 'arc', c, p: [p0, p1], ccw: true });
        made++;
      } else if (e.kind === 'point') {
        this.addEntity({ type: 'point', p: at(e.points[0]) });
        made++;
      } else if (e.kind === 'poly') {
        // A run of straight segments rather than one entity, so each piece can
        // be trimmed, dimensioned and constrained like anything else drawn.
        const idx = e.points.map(at);
        const n = idx.length;
        for (let i = 0; i + 1 < n; i++) {
          if (idx[i] === idx[i + 1]) continue;
          this.addEntity({ type: 'line', p: [idx[i], idx[i + 1]] });
          made++;
        }
        if (e.closed && n > 2 && idx[n - 1] !== idx[0]) {
          this.addEntity({ type: 'line', p: [idx[n - 1], idx[0]] });
          made++;
        }
      }
    }

    this.compactPoints();
    this.refreshRegions();
    this.announce();
    this.rebuild();
    return made;
  }

  /**
   * Bring world space curves into this sketch as they are, without flattening
   * them onto the plane.
   *
   * This is what makes a sketch three dimensional: the points keep their
   * distance from the plane rather than being projected onto it, so an edge
   * that runs up and over a part comes in as the shape it actually is. A flat
   * sketch cannot hold that, so the sketch is marked as three dimensional the
   * moment anything off plane arrives in it.
   */
  insertWorldCurves(runs, opts = {}) {
    if (!runs?.length) return 0;
    if (this.onBeforeChange) this.onBeforeChange();

    const FLAT = 1e-6;
    let offPlane = false;
    let made = 0;

    for (const run of runs) {
      const local = run.map((w) => {
        const q = worldToSketch(this.plane, { x: w[0], y: w[1], z: w[2] });
        if (Math.abs(q.w) > FLAT) offPlane = true;
        return q;
      });
      if (local.length < 2) continue;

      const idx = local.map((q) => this.addPoint(q.u, q.v, q.w));
      if (opts.asLines) {
        for (let i = 0; i + 1 < idx.length; i++) {
          if (idx[i] === idx[i + 1]) continue;
          this.addEntity({ type: 'line', p: [idx[i], idx[i + 1]] });
          made++;
        }
      } else {
        // One entity for the whole run, so it can be swept along or trimmed as
        // the single curve it is.
        this.addEntity({ type: 'spline', p: idx });
        made++;
      }
    }

    if (offPlane) this.sketch.is3d = true;
    this.compactPoints();
    this.refreshRegions();
    this.announce();
    this.rebuild();
    return made;
  }

  /** Reopen the text dialog for whichever text entity is selected. */
  editSelectedText() {
    const ent = [...this.selection]
      .filter((k) => k.startsWith('e'))
      .map((k) => this.sketch.entities.find((e) => `e${e.id}` === k))
      .find((e) => e && e.type === 'text');
    if (!ent) {
      this.status('Select a piece of text first.');
      return false;
    }
    this.requestText(ent.p, ent);
    return true;
  }

  /** The point indices an entity is built from. */
  pointsOfEntity(ent) {
    return entityPoints(ent);
  }

  /**
   * The fixed constraints anchoring any of these points, with where they were
   * anchored. Moving geometry has to bring them along; leaving them behind
   * means the solver simply pulls everything back and the move does nothing.
   */
  anchorsFor(points) {
    const out = [];
    for (const c of this.sketch.constraints) {
      if (c.type !== 'fixed' || !points.has(c.point)) continue;
      out.push({ c, x: c.x, y: c.y });
    }
    return out;
  }

  /** Every point the current selection moves, entities and loose points alike. */
  selectedPoints() {
    const out = new Set();
    for (const key of this.selection) {
      if (key.startsWith('p')) out.add(Number(key.slice(1)));
      else for (const i of this.pointsOfEntity(this.entity(Number(key.slice(1))))) out.add(i);
    }
    return out;
  }

  selectedEntities() {
    return [...this.selection]
      .filter((k) => k.startsWith('e'))
      .map((k) => this.entity(Number(k.slice(1))))
      .filter(Boolean);
  }

  entityAt(pos, tol) {
    let best = null;
    let bestD = tol;
    for (const ent of this.sketch.entities) {
      for (const pts of entityRuns(this.sketch, ent)) {
        for (let i = 0; i < pts.length - 1; i++) {
          const near = closestOnSegment(pos, pts[i], pts[i + 1]);
          const d = Math.hypot(near.x - pos.x, near.y - pos.y);
          if (d < bestD) {
            bestD = d;
            best = ent;
          }
        }
      }
    }
    return best;
  }

  regionAt(pos) {
    for (const r of [...this.regions].sort((a, b) => a.area - b.area)) {
      if (!pointInPolygon(pos, r.outer)) continue;
      let inHole = false;
      for (const h of r.holes) {
        if (pointInPolygon(pos, h)) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return r;
    }
    return null;
  }

  updateHover(pos) {
    const px = this.pixelScale();
    const hit = this.entityAt(pos, px * SNAP_PX);
    const key = hit ? `e${hit.id}` : null;
    if (key !== this.hovered) {
      this.hovered = key;
    }
  }

  dragTo(snapped) {
    // A single grabbed point goes straight where the cursor says.
    if (this.dragging.point !== undefined) {
      const p = this.sketch.points[this.dragging.point];
      if (!p) return;
      for (const c of this.sketch.constraints) {
        if (c.type === 'fixed' && c.point === this.dragging.point) {
          c.x = snapped.x;
          c.y = snapped.y;
        }
      }
      p.x = snapped.x;
      p.y = snapped.y;
      solveSketch(this.sketch, {
        dragging: { point: this.dragging.point, x: snapped.x, y: snapped.y },
        maxIterations: 24
      });
      this.refreshRegions();
      this.rebuild();
      return;
    }

    // A selection moves rigidly: every point shifts by the same amount, and the
    // solver is told to hold all of them there so constraints settle around the
    // move rather than dragging one corner out of shape.
    const dx = snapped.x - this.dragging.grab.x;
    const dy = snapped.y - this.dragging.grab.y;
    for (const a of this.dragging.anchors || []) {
      a.c.x = a.x + dx;
      a.c.y = a.y + dy;
    }
    const pulls = [];
    for (const o of this.dragging.origin) {
      const p = this.sketch.points[o.i];
      if (!p) continue;
      p.x = o.x + dx;
      p.y = o.y + dy;
      pulls.push({ point: o.i, x: p.x, y: p.y });
    }
    solveSketch(this.sketch, { dragging: pulls, maxIterations: 24 });
    this.refreshRegions();
    this.rebuild();
  }

  /* ---------------------------------------------------------------- */
  /* Move, copy, paste                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Take a copy of the selected geometry. Constraints come along only when both
   * ends of them were selected, so a copy is never quietly tied to something it
   * left behind.
   */
  copySelection() {
    const ents = this.selectedEntities();
    if (!ents.length) {
      this.status('Select something to copy first.');
      return false;
    }
    const pts = new Set();
    for (const e of ents) for (const i of this.pointsOfEntity(e)) pts.add(i);
    const order = [...pts].sort((a, b) => a - b);
    const remap = new Map(order.map((i, n) => [i, n]));
    const ids = new Set(ents.map((e) => e.id));

    const kept = [];
    for (const c of this.sketch.constraints) {
      // A fixed constraint pins absolute coordinates, which cannot mean the
      // same thing once the copy is somewhere else.
      if (c.type === 'fixed') continue;
      const cPts = [...(c.points || []), ...(c.point !== undefined ? [c.point] : [])];
      const cEnts = [...(c.entities || []), ...(c.entity !== undefined ? [c.entity] : [])];
      if (cPts.some((i) => !remap.has(i))) continue;
      if (cEnts.some((i) => !ids.has(i))) continue;
      if (!cPts.length && !cEnts.length) continue;
      kept.push(c);
    }

    this.clipboard = {
      points: order.map((i) => ({ ...this.sketch.points[i] })),
      entities: ents.map((e) => JSON.parse(JSON.stringify(e))),
      constraints: JSON.parse(JSON.stringify(kept)),
      remap: [...remap.entries()]
    };
    this.status(`${ents.length} copied.`);
    return true;
  }

  /** Drop the clipboard into the sketch, offset so it does not hide the original. */
  pasteClipboard(dx = null, dy = null) {
    const clip = this.clipboard;
    if (!clip) {
      this.status('Nothing copied yet.');
      return false;
    }
    this.announce();
    const step = dx === null ? this.pixelScale() * 30 : 0;
    const ox = dx === null ? step : dx;
    const oy = dy === null ? -step : dy;

    const remap = new Map(clip.remap);
    const base = this.sketch.points.length;
    for (const p of clip.points) this.sketch.points.push({ x: p.x + ox, y: p.y + oy });
    const point = (i) => base + remap.get(i);

    const idMap = new Map();
    this.selection.clear();
    for (const src of clip.entities) {
      const e = JSON.parse(JSON.stringify(src));
      const old = e.id;
      delete e.id;
      remapEntityPoints(e, point);
      const made = this.addEntity(e);
      idMap.set(old, made.id);
      this.selection.add(`e${made.id}`);
    }

    for (const src of clip.constraints) {
      const c = JSON.parse(JSON.stringify(src));
      delete c.id;
      if (c.points) c.points = c.points.map(point);
      if (c.point !== undefined) c.point = point(c.point);
      if (c.entities) c.entities = c.entities.map((i) => idMap.get(i));
      if (c.entity !== undefined) c.entity = idMap.get(c.entity);
      this.addConstraint(c);
    }

    this.solve();
    this.rebuild();
    this.commit();
    this.commitSelection();
    this.status(`${clip.entities.length} pasted.`);
    return true;
  }

  /**
   * Shift the selection by a fixed amount, or lay a copy of it down there. This
   * is the numeric counterpart to dragging, for when the distance matters.
   */
  moveSelection(dx, dy, copy = false) {
    if (copy) {
      if (!this.copySelection()) return false;
      return this.pasteClipboard(dx, dy);
    }
    const points = this.selectedPoints();
    if (!points.size) {
      this.status('Select something to move first.');
      return false;
    }
    this.announce();
    for (const a of this.anchorsFor(points)) {
      a.c.x = a.x + dx;
      a.c.y = a.y + dy;
    }
    const pulls = [];
    for (const i of points) {
      const p = this.sketch.points[i];
      if (!p) continue;
      p.x += dx;
      p.y += dy;
      pulls.push({ point: i, x: p.x, y: p.y });
    }
    solveSketch(this.sketch, { dragging: pulls, maxIterations: 40 });
    this.solve();
    this.rebuild();
    this.commit();
    return true;
  }

  deleteSelection() {
    this.announce();
    for (const key of this.selection) {
      if (key.startsWith('e')) this.removeEntity(Number(key.slice(1)));
    }
    this.selection.clear();
    this.compactPoints();
    this.solve();
    this.commit();
  }

  /** Drop points nothing references, keeping every reference consistent. */
  compactPoints() {
    const used = new Set();
    for (const e of this.sketch.entities) {
      for (const i of entityPoints(e)) used.add(i);
    }
    for (const c of this.sketch.constraints) {
      if (c.point !== undefined) used.add(c.point);
      if (c.points) for (const p of c.points) used.add(p);
    }

    const remap = new Map();
    const next = [];
    this.sketch.points.forEach((p, i) => {
      if (!used.has(i)) return;
      remap.set(i, next.length);
      next.push(p);
    });

    const fix = (i) => (remap.has(i) ? remap.get(i) : 0);
    for (const e of this.sketch.entities) remapEntityPoints(e, fix);
    this.sketch.constraints = this.sketch.constraints.filter((c) => {
      if (c.point !== undefined) {
        if (!remap.has(c.point)) return false;
        c.point = remap.get(c.point);
      }
      if (c.points) {
        if (c.points.some((p) => !remap.has(p))) return false;
        c.points = c.points.map((p) => remap.get(p));
      }
      return true;
    });
    this.sketch.points = next;
  }

  /* ---------------------------------------------------------------- */
  /* Drawing tools                                                     */
  /* ---------------------------------------------------------------- */

  applyTool(pos, snap, e) {
    const T = this.tool;
    this.announce();

    if (T === 'point') {
      const idx = this.resolvePoint(pos, snap);
      this.addEntity({ type: 'point', p: idx });
      this.finishStep();
      return;
    }

    if (T === 'line') {
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx], chainStart: idx, lastLine: null };
        this.maybeAnchor(idx, snap);
        this.beginEntry(T, idx);
        return;
      }
      const prev = this.pending.points[this.pending.points.length - 1];
      const previousLine = this.pending.lastLine;
      const from = this.sketch.points[prev];
      // A typed angle already says where the point goes, so do not let the
      // axis snap pull it off that angle.
      const aligned =
        this.suppressAuto || this.entryLocked()
          ? { pos, axis: null }
          : this.axisAlign(from, pos);
      const idx = this.resolvePoint(aligned.pos, snap);
      if (idx === prev) return;
      const ent = this.addEntity({ type: 'line', p: [prev, idx] });
      if (aligned.axis && !snap?.pointIndex && !this.suppressAuto) {
        this.addConstraint({ type: aligned.axis, entity: ent.id });
      }
      this.applyEntryDimensions({ points: [prev, idx], line: ent.id, previousLine });
      this.pending.points.push(idx);
      this.pending.lastLine = ent.id;
      // Closing back onto the chain start finishes the loop.
      if (idx === this.pending.chainStart) {
        this.pending = null;
        this.endEntry();
      } else {
        // A chain carries on, so the boxes reopen against the new point.
        this.beginEntry(T, idx);
      }
      this.finishStep(true);
      return;
    }

    if (T === 'rectangle' || T === 'centerRectangle') {
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        this.maybeAnchor(idx, snap);
        this.beginEntry(T, idx);
        return;
      }
      const a = this.sketch.points[this.pending.points[0]];
      const built = this.buildRectangle(
        a,
        pos,
        T === 'centerRectangle',
        this.pending.points[0]
      );
      if (built) {
        this.applyEntryDimensions({
          widthPoints: [built.p00, built.p10],
          heightPoints: [built.p10, built.p11]
        });
      }
      this.endEntry();
      this.pending = null;
      this.finishStep();
      return;
    }

    if (T === 'circle' || T === 'circleDia') {
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        this.maybeAnchor(idx, snap);
        this.beginEntry(T, idx);
        return;
      }
      const first = this.pending.points[0];
      const a = this.sketch.points[first];
      let circle = null;
      if (T === 'circle') {
        const r = Math.hypot(pos.x - a.x, pos.y - a.y);
        if (r > 1e-6) circle = this.addEntity({ type: 'circle', c: first, r });
      } else {
        const cx = (a.x + pos.x) / 2;
        const cy = (a.y + pos.y) / 2;
        const r = Math.hypot(pos.x - a.x, pos.y - a.y) / 2;
        const c = this.addPoint(cx, cy);
        if (r > 1e-6) circle = this.addEntity({ type: 'circle', c, r });
      }
      if (circle) this.applyEntryDimensions({ circle: circle.id });
      this.endEntry();
      this.pending = null;
      this.finishStep();
      return;
    }

    if (T === 'ellipse') {
      // Centre, then the end of the major axis, then how far out the minor one
      // reaches. All three are real sketch points, so the ellipse is dragged,
      // dimensioned and solved like everything else.
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        this.maybeAnchor(idx, snap);
        return;
      }
      if (this.pending.points.length === 1) {
        const idx = this.resolvePoint(pos, snap);
        if (idx === this.pending.points[0]) return;
        this.pending.points.push(idx);
        return;
      }
      const c = this.pending.points[0];
      const a = this.pending.points[1];
      const b = this.addPoint(pos.x, pos.y);
      this.addEntity({ type: 'ellipse', c, a, b });
      this.pending = null;
      this.finishStep();
      return;
    }

    if (T === 'text') {
      // One click places it; the wording and the size are asked for after,
      // because there is nothing useful to preview until they are known.
      const idx = this.resolvePoint(pos, snap);
      this.maybeAnchor(idx, snap);
      this.pending = null;
      this.requestText(idx);
      this.finishStep();
      return;
    }

    if (T === 'arc') {
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        this.maybeAnchor(idx, snap);
        return;
      }
      if (this.pending.points.length === 1) {
        const idx = this.resolvePoint(pos, snap);
        this.pending.points.push(idx);
        return;
      }
      const c = this.pending.points[0];
      const s = this.pending.points[1];
      const centre = this.sketch.points[c];
      const start = this.sketch.points[s];
      const r = Math.hypot(start.x - centre.x, start.y - centre.y);
      const ang = Math.atan2(pos.y - centre.y, pos.x - centre.x);
      const endIdx = this.addPoint(centre.x + r * Math.cos(ang), centre.y + r * Math.sin(ang));
      const a0 = Math.atan2(start.y - centre.y, start.x - centre.x);
      let sweep = ang - a0;
      while (sweep < -Math.PI) sweep += TAU;
      while (sweep > Math.PI) sweep -= TAU;
      this.addEntity({ type: 'arc', c, p: [s, endIdx], ccw: sweep >= 0 });
      this.pending = null;
      this.finishStep();
      return;
    }

    if (T === 'blendCurve' || T === 'blendCurveG1') {
      // The loose end nearest the click, rather than whatever the snap made of
      // it. A blend has to attach to geometry that is already there, so putting
      // a new point down when the click missed would leave a stray point and no
      // blend, which is the worst of both.
      const idx = this.looseEndNear(pos);
      const owner = idx === null ? null : this.curveEndAt(idx);
      if (!owner) {
        this.status('That is not the end of a curve. Click one of the two ends to join.');
        return;
      }
      if (!this.pending) {
        this.pending = { tool: T, ends: [{ idx, ent: owner }] };
        this.status('Now the end of the other curve.');
        return;
      }
      const first = this.pending.ends[0];
      this.pending = null;
      if (first.idx === idx) {
        this.status('Those are the same end.');
        this.finishStep();
        return;
      }
      this.buildBlendCurve(first, { idx, ent: owner }, T === 'blendCurve' ? 'G2' : 'G1');
      this.finishStep();
      return;
    }

    if (T === 'circle3') {
      // Three points on the rim. The one case where the circle is known by
      // where it goes rather than by where its middle is, which is how a bore
      // gets matched to three measured points off a real part.
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        this.maybeAnchor(idx, snap);
        return;
      }
      if (this.pending.points.length === 1) {
        this.pending.points.push(this.resolvePoint(pos, snap));
        return;
      }
      const a = this.sketch.points[this.pending.points[0]];
      const b = this.sketch.points[this.pending.points[1]];
      const circ = circleThrough(a, b, pos);
      if (!circ) {
        this.status('Those three points lie on a line, so there is no circle through them.');
        this.pending = null;
        this.finishStep();
        return;
      }
      const c = this.addPoint(circ.x, circ.y);
      const r = Math.hypot(a.x - circ.x, a.y - circ.y);
      const circle = this.addEntity({ type: 'circle', c, r });
      // The two points that were clicked stay on it, so moving one moves the
      // circle rather than leaving a point stranded beside it.
      for (const i of this.pending.points) {
        this.addConstraint({ type: 'pointOnCircle', point: i, entity: circle.id });
      }
      this.pending = null;
      this.finishStep();
      return;
    }

    if (T === 'arc3') {
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        return;
      }
      if (this.pending.points.length === 1) {
        const idx = this.resolvePoint(pos, snap);
        this.pending.points.push(idx);
        return;
      }
      const s = this.sketch.points[this.pending.points[0]];
      const t = this.sketch.points[this.pending.points[1]];
      const circ = circleThrough(s, t, pos);
      if (circ) {
        const c = this.addPoint(circ.x, circ.y);
        const a0 = Math.atan2(s.y - circ.y, s.x - circ.x);
        const am = Math.atan2(pos.y - circ.y, pos.x - circ.x);
        const a1 = Math.atan2(t.y - circ.y, t.x - circ.x);
        const ccw = angleBetween(a0, am, a1);
        this.addEntity({
          type: 'arc',
          c,
          p: [this.pending.points[0], this.pending.points[1]],
          ccw
        });
      }
      this.pending = null;
      this.finishStep();
      return;
    }

    if (T === 'polygon' || T === 'polygonCirc') {
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        this.maybeAnchor(idx, snap);
        return;
      }
      const c = this.sketch.points[this.pending.points[0]];
      // Inscribed puts the corners on the circle you drag out; circumscribed
      // puts the flats on it, which is the one that matters when the polygon
      // has to clear a spanner or hold a nut.
      this.buildPolygon(c, pos, this.polygonSides || 6, T === 'polygonCirc');
      this.pending = null;
      this.finishStep();
      return;
    }

    if (T === 'polygonEdge') {
      // Two clicks give one edge, and the polygon is built off it.
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        this.maybeAnchor(idx, snap);
        return;
      }
      const a = this.sketch.points[this.pending.points[0]];
      this.buildEdgePolygon(a, pos, this.polygonSides || 6);
      this.pending = null;
      this.finishStep();
      return;
    }

    if (
      T === 'slot' ||
      T === 'slotOverall' ||
      T === 'slotCentre' ||
      T === 'slotArc3' ||
      T === 'slotArcCentre'
    ) {
      const wanted = T === 'slotArc3' || T === 'slotArcCentre' ? 3 : 2;
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        return;
      }
      if (this.pending.points.length < wanted) {
        const idx = this.resolvePoint(pos, snap);
        if (idx === this.pending.points[this.pending.points.length - 1]) return;
        this.pending.points.push(idx);
        return;
      }
      const P = this.pending.points.map((i) => this.sketch.points[i]);
      this.buildSlotVariant(T, P, pos);
      this.pending = null;
      this.finishStep();
      return;
    }

    if (T === 'rectangle3') {
      // The first two clicks give one edge with its direction, so unlike the
      // two corner rectangle this one is not stuck square to the axes.
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        this.maybeAnchor(idx, snap);
        return;
      }
      if (this.pending.points.length === 1) {
        const idx = this.resolvePoint(pos, snap);
        if (idx === this.pending.points[0]) return;
        this.pending.points.push(idx);
        return;
      }
      const a = this.sketch.points[this.pending.points[0]];
      const b = this.sketch.points[this.pending.points[1]];
      this.buildThreePointRectangle(this.pending.points[0], this.pending.points[1], a, b, pos);
      this.pending = null;
      this.finishStep();
      return;
    }

    if (T === 'tangentArc') {
      // The first click has to land on the end of an existing curve, because
      // that curve is what the arc leaves tangent to. Without one there is no
      // arc to work out, so it says so rather than drawing something arbitrary.
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        const src = this.tangentSourceAt(idx);
        if (!src) {
          this.status('Start a tangent arc at the end of a line or an arc.');
          return;
        }
        this.pending = { tool: T, points: [idx], src };
        return;
      }
      const start = this.pending.points[0];
      const endIdx = this.resolvePoint(pos, snap);
      this.buildTangentArc(start, this.pending.src, endIdx);
      this.pending = null;
      this.finishStep();
      return;
    }

    if (T === 'conic') {
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        this.maybeAnchor(idx, snap);
        return;
      }
      if (this.pending.points.length === 1) {
        const idx = this.resolvePoint(pos, snap);
        if (idx === this.pending.points[0]) return;
        this.pending.points.push(idx);
        return;
      }
      const v = this.resolvePoint(pos, snap);
      this.addEntity({
        type: 'conic',
        p: [this.pending.points[0], this.pending.points[1]],
        v,
        rho: this.conicRho || 0.5
      });
      this.pending = null;
      this.finishStep();
      return;
    }

    if (T === 'circleTan2' || T === 'circleTan3') {
      const want = T === 'circleTan3' ? 3 : 2;
      const line = this.entityAt(pos, this.pixelScale() * SNAP_PX * 2);
      if (!this.pending) this.pending = { tool: T, lines: [] };
      if (line && line.type === 'line' && !this.pending.lines.includes(line.id)) {
        this.pending.lines.push(line.id);
        this.status(
          this.pending.lines.length < want
            ? `${this.pending.lines.length} of ${want} lines.`
            : 'Now click where the circle goes.'
        );
        if (this.pending.lines.length < want) return;
        if (T === 'circleTan3') {
          this.buildTangentCircle(this.pending.lines, pos);
          this.pending = null;
          this.finishStep();
        }
        return;
      }
      if (this.pending.lines.length >= want) {
        this.buildTangentCircle(this.pending.lines, pos);
        this.pending = null;
        this.finishStep();
      } else {
        this.status(`Click ${want} lines for the circle to touch.`);
      }
      return;
    }

    if (T === 'spline' || T === 'splineCP') {
      if (!this.pending) {
        const idx = this.resolvePoint(pos, snap);
        this.pending = { tool: T, points: [idx] };
        this.maybeAnchor(idx, snap);
        return;
      }
      const idx = this.resolvePoint(pos, snap);
      const pts = this.pending.points;
      if (idx === pts[pts.length - 1]) return;
      pts.push(idx);

      // Rebuild the curve each click so it grows under the cursor.
      if (this.pending.entity) this.removeEntity(this.pending.entity);
      const ent = this.addEntity({
        type: T === 'splineCP' ? 'bspline' : 'spline',
        p: [...pts]
      });
      this.pending.entity = ent.id;
      this.finishStep(true);
      return;
    }

    if (T === 'fillet' || T === 'chamfer') {
      this.applyCornerTool(pos, T);
      return;
    }

    if (T === 'trim') {
      const hit = this.entityAt(pos, this.pixelScale() * SNAP_PX);
      if (hit) {
        this.trimAt(hit, pos);
      }
      return;
    }

    if (T === 'offset') {
      const hit = this.entityAt(pos, this.pixelScale() * SNAP_PX);
      if (hit) this.offsetEntity(hit, pos);
      return;
    }

    if (T === 'breakCurve') {
      const hit = this.entityAt(pos, this.pixelScale() * SNAP_PX);
      if (hit) this.breakAt(hit, pos);
      return;
    }

    if (T === 'extend') {
      const hit = this.entityAt(pos, this.pixelScale() * SNAP_PX);
      if (hit) this.extendAt(hit, pos);
      return;
    }

    if (T === 'dimension') {
      this.dimensionAt(pos, snap);
      return;
    }
  }

  /** Fix the very first point of a sketch to the origin when it landed there. */
  maybeAnchor(idx, snap) {
    if (snap?.originPoint && !this.suppressAuto) {
      const already = this.sketch.constraints.some(
        (c) => c.type === 'fixed' && c.point === idx
      );
      if (!already) this.addConstraint({ type: 'fixed', point: idx, x: 0, y: 0 });
    }
    this.rebuild();
  }

  buildRectangle(a, b, fromCentre, reuseIdx) {
    let x0;
    let y0;
    let x1;
    let y1;
    if (fromCentre) {
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      x0 = a.x - dx;
      x1 = a.x + dx;
      y0 = a.y - dy;
      y1 = a.y + dy;
    } else {
      x0 = a.x;
      x1 = b.x;
      y0 = a.y;
      y1 = b.y;
    }
    if (Math.abs(x1 - x0) < 1e-9 || Math.abs(y1 - y0) < 1e-9) return null;

    const p00 = fromCentre ? this.addPoint(x0, y0) : reuseIdx;
    const p10 = this.addPoint(x1, y0);
    const p11 = this.addPoint(x1, y1);
    const p01 = this.addPoint(x0, y1);
    if (fromCentre) {
      // The centre stays on the midpoint of the diagonal, so dragging a corner
      // grows the rectangle about the point that was clicked first.
      this.addConstraint({ type: 'midpointOfPair', points: [p00, p11], point: reuseIdx });
    }

    const e0 = this.addEntity({ type: 'line', p: [p00, p10] });
    const e1 = this.addEntity({ type: 'line', p: [p10, p11] });
    const e2 = this.addEntity({ type: 'line', p: [p11, p01] });
    const e3 = this.addEntity({ type: 'line', p: [p01, p00] });

    this.addConstraint({ type: 'horizontal', entity: e0.id });
    this.addConstraint({ type: 'horizontal', entity: e2.id });
    this.addConstraint({ type: 'vertical', entity: e1.id });
    this.addConstraint({ type: 'vertical', entity: e3.id });

    return { p00, p10, p11, p01, edges: [e0.id, e1.id, e2.id, e3.id] };
  }

  buildPolygon(c, edgePt, sides, circumscribed = false) {
    const n = Math.max(3, Math.min(64, sides));
    let r = Math.hypot(edgePt.x - c.x, edgePt.y - c.y);
    if (r < 1e-6) return;
    // Circumscribed measures to the middle of an edge, so the corners have to
    // reach further out for the flats to land on the circle asked for.
    if (circumscribed) r /= Math.cos(Math.PI / n);
    const a0 = Math.atan2(edgePt.y - c.y, edgePt.x - c.x) + (circumscribed ? Math.PI / n : 0);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + (TAU * i) / n;
      idx.push(this.addPoint(c.x + r * Math.cos(a), c.y + r * Math.sin(a)));
    }
    const edges = [];
    for (let i = 0; i < n; i++) {
      edges.push(this.addEntity({ type: 'line', p: [idx[i], idx[(i + 1) % n]] }));
    }
    for (let i = 1; i < n; i++) {
      this.addConstraint({ type: 'equal', entities: [edges[0].id, edges[i].id] });
    }
  }

  /**
   * The curve ending at this point, and the direction it arrives in.
   *
   * A tangent arc has to leave along that direction, so this is what makes the
   * arc determined by two clicks rather than three.
   */
  tangentSourceAt(idx) {
    for (const ent of this.sketch.entities) {
      const ends = entityEndpoints(ent);
      if (!ends) continue;
      const which = ends[0] === idx ? 0 : ends[1] === idx ? 1 : -1;
      if (which < 0) continue;
      const pts = tessellate(this.sketch, ent);
      if (pts.length < 2) continue;
      // Pointing away from the curve, so the arc carries on rather than
      // doubling back over what it grew from.
      const a = which === 0 ? pts[1] : pts[pts.length - 2];
      const b = which === 0 ? pts[0] : pts[pts.length - 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      return { entity: ent.id, tx: dx / len, ty: dy / len };
    }
    return null;
  }

  /**
   * The arc that starts at `start`, leaves along the source's tangent, and ends
   * at `endIdx`.
   *
   * Its centre is square to the tangent and the same distance from both ends,
   * which pins it exactly. When the two points sit symmetrically about that
   * perpendicular there is no such circle, only a straight line, and it says so.
   */
  buildTangentArc(start, src, endIdx) {
    const s = this.sketch.points[start];
    const e = this.sketch.points[endIdx];
    if (!s || !e || start === endIdx) return;

    const nx = -src.ty;
    const ny = src.tx;
    const vx = s.x - e.x;
    const vy = s.y - e.y;
    const denom = 2 * (vx * nx + vy * ny);
    if (Math.abs(denom) < 1e-9) {
      this.status('That point is straight ahead, so there is no arc through it.');
      return;
    }
    const d = -(vx * vx + vy * vy) / denom;
    const cx = s.x + nx * d;
    const cy = s.y + ny * d;
    const cIdx = this.addPoint(cx, cy);

    // Which way it turns is whichever way leaves along the tangent rather than
    // against it: counterclockwise puts the tangent at plus ninety degrees.
    const rx = s.x - cx;
    const ry = s.y - cy;
    const ccw = -ry * src.tx + rx * src.ty > 0;

    const arc = this.addEntity({ type: 'arc', c: cIdx, p: [start, endIdx], ccw });
    this.addConstraint({ type: 'tangent', entities: [src.entity, arc.id] });
  }

  /** A polygon built off one edge, given its two ends. */
  buildEdgePolygon(a, b, sides) {
    const n = Math.max(3, Math.min(64, sides));
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) return;
    // The centre sits on the perpendicular bisector, at the apothem.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const apothem = len / (2 * Math.tan(Math.PI / n));
    const cx = mx - uy * apothem;
    const cy = my + ux * apothem;

    const r = Math.hypot(a.x - cx, a.y - cy);
    const a0 = Math.atan2(a.y - cy, a.x - cx);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const ang = a0 + (TAU * i) / n;
      idx.push(this.addPoint(cx + r * Math.cos(ang), cy + r * Math.sin(ang)));
    }
    const edges = [];
    for (let i = 0; i < n; i++) {
      edges.push(this.addEntity({ type: 'line', p: [idx[i], idx[(i + 1) % n]] }));
    }
    for (let i = 1; i < n; i++) {
      this.addConstraint({ type: 'equal', entities: [edges[0].id, edges[i].id] });
    }
  }

  /**
   * A rectangle from one edge and a width, so it can sit at any angle.
   *
   * The first edge is kept as the geometry that was actually clicked, and the
   * other three are constrained square to it, which is what keeps it a
   * rectangle when a point is later dragged.
   */
  buildThreePointRectangle(ia, ib, a, b, pos) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const nx = -dy / len;
    const ny = dx / len;
    const w = (pos.x - a.x) * nx + (pos.y - a.y) * ny;
    if (Math.abs(w) < 1e-6) return;

    const ic = this.addPoint(b.x + nx * w, b.y + ny * w);
    const id = this.addPoint(a.x + nx * w, a.y + ny * w);
    const e0 = this.addEntity({ type: 'line', p: [ia, ib] });
    const e1 = this.addEntity({ type: 'line', p: [ib, ic] });
    const e2 = this.addEntity({ type: 'line', p: [ic, id] });
    const e3 = this.addEntity({ type: 'line', p: [id, ia] });
    this.addConstraint({ type: 'parallel', entities: [e0.id, e2.id] });
    this.addConstraint({ type: 'parallel', entities: [e1.id, e3.id] });
    this.addConstraint({ type: 'perpendicular', entities: [e0.id, e1.id] });
  }

  /** The nearest loose curve end to a point, within reach of a click. */
  looseEndNear(pos) {
    const reach = this.pixelScale() * SNAP_PX * 3;
    let best = null;
    for (const ent of this.sketch.entities) {
      if (ent.construction) continue;
      const ends = entityEndpoints(ent);
      if (!ends) continue;
      for (const i of ends) {
        const p = this.sketch.points[i];
        if (!p) continue;
        const d = Math.hypot(p.x - pos.x, p.y - pos.y);
        if (d > reach) continue;
        if (!best || d < best.d) best = { d, i };
      }
    }
    return best ? best.i : null;
  }

  /**
   * The curve a point is the loose end of, if it is one.
   *
   * Loose matters: joining onto the middle of a curve, or onto an end that is
   * already joined to something, gives a curve that leaves at a tangent nothing
   * else agrees with. So an end that two curves already share is not offered.
   */
  curveEndAt(idx) {
    const owners = [];
    for (const ent of this.sketch.entities) {
      if (ent.construction) continue;
      const ends = entityEndpoints(ent);
      if (ends && ends.includes(idx)) owners.push(ent);
    }
    return owners.length === 1 ? owners[0] : null;
  }

  /**
   * Join two loose ends with a spline that does not show the join.
   *
   * The end points are the sketch's own, not copies, so dragging the curve that
   * was blended drags the blend with it and the join stays closed. What the
   * join cannot keep on its own is the direction and the curvature, which are
   * built in rather than constrained: nothing in a 2D solver expresses "leaves
   * this end at this curvature", and pretending otherwise with a chain of
   * construction lines would be worse than saying so.
   */
  buildBlendCurve(first, second, continuity) {
    const a = endFrame(this.sketch, first.ent, first.idx);
    const b = endFrame(this.sketch, second.ent, second.idx);
    if (!a || !b) {
      this.status('Could not read the ends of those curves.');
      return;
    }
    const ctrl = blendControls(a, b, { continuity, bias: this.blendBias || 1 });
    if (!ctrl || ctrl.length < 3) {
      this.status('Those two ends are on top of each other.');
      return;
    }
    const inner = ctrl.slice(1, -1).map((c) => this.addPoint(c.x, c.y));
    this.addEntity({ type: 'bspline', p: [first.idx, ...inner, second.idx] });
    this.status(
      continuity === 'G2'
        ? 'Blended, matching direction and curvature at both ends.'
        : 'Blended, matching direction at both ends.'
    );
  }

  /**
   * The slot variants, all reduced to two arc centres and a half width.
   *
   * Fusion offers five ways to say where a slot goes, and they differ only in
   * which points you click. Working out the centres here means one builder
   * makes the geometry and one place has to be right about it.
   */
  buildSlotVariant(tool, P, pos) {
    if (tool === 'slotArc3' || tool === 'slotArcCentre') {
      const arc =
        tool === 'slotArcCentre'
          ? { c: P[0], a: P[1], b: P[2] }
          : arcThrough(P[0], P[2], P[1]);
      if (!arc) {
        this.status('Those three points do not make an arc.');
        return;
      }
      const r = Math.hypot(arc.a.x - arc.c.x, arc.a.y - arc.c.y);
      const half = Math.max(Math.abs(Math.hypot(pos.x - arc.c.x, pos.y - arc.c.y) - r), 1e-3);
      this.buildArcSlot(arc.c, r, arc.a, arc.b, half);
      return;
    }

    let a = P[0];
    let b = P[1];
    const half = Math.max(distToSegment(pos, a, b), 1e-3);

    if (tool === 'slotOverall') {
      // The clicks were the far ends, caps included, so the arc centres sit a
      // radius in from each of them.
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len <= 2 * half) {
        this.status('That slot is shorter than it is wide.');
        return;
      }
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      a = { x: a.x + ux * half, y: a.y + uy * half };
      b = { x: b.x - ux * half, y: b.y - uy * half };
    } else if (tool === 'slotCentre') {
      // The first click was the middle, so the far centre is its mirror.
      b = P[1];
      a = { x: 2 * P[0].x - b.x, y: 2 * P[0].y - b.y };
    }

    this.buildSlot(a, b, half);
  }

  /** A slot that follows an arc: two concentric arcs and a round cap each end. */
  buildArcSlot(centre, r, from, to, half) {
    if (r <= half) {
      this.status('That arc is tighter than the slot is wide.');
      return;
    }
    const a0 = Math.atan2(from.y - centre.y, from.x - centre.x);
    let a1 = Math.atan2(to.y - centre.y, to.x - centre.x);
    let sweep = a1 - a0;
    while (sweep <= -Math.PI) sweep += TAU;
    while (sweep > Math.PI) sweep -= TAU;
    if (Math.abs(sweep) < 1e-4) return;
    a1 = a0 + sweep;

    const at = (rad, ang) => ({
      x: centre.x + rad * Math.cos(ang),
      y: centre.y + rad * Math.sin(ang)
    });
    const cIdx = this.addPoint(centre.x, centre.y);
    const mA = at(r, a0);
    const mB = at(r, a1);
    const capA = this.addPoint(mA.x, mA.y);
    const capB = this.addPoint(mB.x, mB.y);

    const inA = this.addPoint(at(r - half, a0).x, at(r - half, a0).y);
    const outA = this.addPoint(at(r + half, a0).x, at(r + half, a0).y);
    const inB = this.addPoint(at(r - half, a1).x, at(r - half, a1).y);
    const outB = this.addPoint(at(r + half, a1).x, at(r + half, a1).y);

    // The two long edges follow the arc, one inside the path and one outside,
    // and a cap closes each end. The caps turn the opposite way from the inner
    // edge so they bulge past the ends rather than cutting back into the slot.
    const ccw = sweep >= 0;
    this.addEntity({ type: 'arc', c: cIdx, p: ccw ? [inA, inB] : [inB, inA], ccw: true });
    this.addEntity({ type: 'arc', c: cIdx, p: ccw ? [outB, outA] : [outA, outB], ccw: false });
    // Both caps turn the same way whichever way the slot sweeps, because the
    // endpoint order flips with it and the two cancel out. Measured against the
    // area an arc slot must have rather than reasoned about: the three wrong
    // combinations are all a plausible looking shape.
    this.addEntity({ type: 'arc', c: capB, p: ccw ? [inB, outB] : [outB, inB], ccw: false });
    this.addEntity({ type: 'arc', c: capA, p: ccw ? [outA, inA] : [inA, outA], ccw: false });
  }

  /**
   * A circle touching two or three straight lines.
   *
   * Three lines pin it outright, at the incircle of the triangle they make.
   * Two leave a family of answers along their bisector, so where you clicked
   * picks one, which is how Fusion asks for it too.
   */
  buildTangentCircle(lineIds, pos) {
    const lines = lineIds
      .map((id) => this.entity(id))
      .filter((e) => e && e.type === 'line')
      .map((e) => {
        const a = this.sketch.points[e.p[0]];
        const b = this.sketch.points[e.p[1]];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        // Normal pointing towards the click, so "distance" is signed the way
        // the answer needs it.
        let nx = -(b.y - a.y) / len;
        let ny = (b.x - a.x) / len;
        if ((pos.x - a.x) * nx + (pos.y - a.y) * ny < 0) {
          nx = -nx;
          ny = -ny;
        }
        return { a, nx, ny, id: e.id };
      });
    if (lines.length < 2) return;

    // Distance from a point to each line is equal, and equal to the radius.
    // Two lines give one equation and the click supplies the rest; three give
    // two equations, which is a two by two solve.
    const eq = (l1, l2) => ({
      a: l1.nx - l2.nx,
      b: l1.ny - l2.ny,
      c: l1.nx * l1.a.x + l1.ny * l1.a.y - (l2.nx * l2.a.x + l2.ny * l2.a.y)
    });

    let cx;
    let cy;
    if (lines.length >= 3) {
      const e1 = eq(lines[0], lines[1]);
      const e2 = eq(lines[0], lines[2]);
      const det = e1.a * e2.b - e2.a * e1.b;
      if (Math.abs(det) < 1e-9) {
        this.status('Those lines do not close a corner to fit a circle in.');
        return;
      }
      cx = (e1.c * e2.b - e2.c * e1.b) / det;
      cy = (e1.a * e2.c - e2.a * e1.c) / det;
    } else {
      // On the bisector, as near the click as the two lines allow.
      const e1 = eq(lines[0], lines[1]);
      const n2 = e1.a * e1.a + e1.b * e1.b;
      if (n2 < 1e-12) {
        this.status('Those two lines are parallel.');
        return;
      }
      const t = (e1.c - (e1.a * pos.x + e1.b * pos.y)) / n2;
      cx = pos.x + e1.a * t;
      cy = pos.y + e1.b * t;
    }

    const r = Math.abs(
      lines[0].nx * (cx - lines[0].a.x) + lines[0].ny * (cy - lines[0].a.y)
    );
    if (!(r > 1e-6)) {
      this.status('That circle would have no size.');
      return;
    }
    const c = this.addPoint(cx, cy);
    const circle = this.addEntity({ type: 'circle', c, r });
    for (const l of lines) {
      this.addConstraint({ type: 'tangent', entities: [l.id, circle.id] });
    }
  }

  buildSlot(a, b, width) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const nx = -dy / len;
    const ny = dx / len;
    const r = width;

    const ca = this.addPoint(a.x, a.y);
    const cb = this.addPoint(b.x, b.y);
    const a1 = this.addPoint(a.x + nx * r, a.y + ny * r);
    const a2 = this.addPoint(a.x - nx * r, a.y - ny * r);
    const b1 = this.addPoint(b.x + nx * r, b.y + ny * r);
    const b2 = this.addPoint(b.x - nx * r, b.y - ny * r);

    const l1 = this.addEntity({ type: 'line', p: [a1, b1] });
    const l2 = this.addEntity({ type: 'line', p: [b2, a2] });
    // Clockwise, so each cap bulges away from the slot. Counterclockwise takes
    // the short way round between the same two points, which is back through
    // the middle: the ends came out bitten in rather than rounded off, and it
    // is close enough to right at a glance to have gone unnoticed.
    this.addEntity({ type: 'arc', c: cb, p: [b1, b2], ccw: false });
    this.addEntity({ type: 'arc', c: ca, p: [a2, a1], ccw: false });
    this.addConstraint({ type: 'equal', entities: [l1.id, l2.id] });
    this.addConstraint({ type: 'parallel', entities: [l1.id, l2.id] });
  }

  applyCornerTool(pos, kind) {
    // Find two lines that share a point near the click.
    const px = this.pixelScale();
    let found = null;
    for (const a of this.sketch.entities) {
      if (a.type !== 'line') continue;
      for (const b of this.sketch.entities) {
        if (b === a || b.type !== 'line') continue;
        const shared = a.p.find((i) => b.p.includes(i));
        if (shared === undefined) continue;
        const p = this.sketch.points[shared];
        const d = Math.hypot(p.x - pos.x, p.y - pos.y);
        if (d < SNAP_PX * px * 3 && (!found || d < found.d)) {
          found = { a, b, shared, d };
        }
      }
    }
    if (!found) {
      this.status('Click a corner where two lines meet.');
      return;
    }

    const { a, b, shared } = found;
    const corner = this.sketch.points[shared];
    const otherA = this.sketch.points[a.p[0] === shared ? a.p[1] : a.p[0]];
    const otherB = this.sketch.points[b.p[0] === shared ? b.p[1] : b.p[0]];

    const u = norm2({ x: otherA.x - corner.x, y: otherA.y - corner.y });
    const v = norm2({ x: otherB.x - corner.x, y: otherB.y - corner.y });
    const lenA = Math.hypot(otherA.x - corner.x, otherA.y - corner.y);
    const lenB = Math.hypot(otherB.x - corner.x, otherB.y - corner.y);

    const cosT = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y));
    const theta = Math.acos(cosT);
    if (theta < 1e-4 || Math.abs(theta - Math.PI) < 1e-4) {
      this.status('Those lines are in line with each other.');
      return;
    }

    const size = this.cornerRadius || Math.min(lenA, lenB) * 0.2;

    if (kind === 'chamfer') {
      const t = Math.min(size, lenA * 0.9, lenB * 0.9);
      const pa = this.addPoint(corner.x + u.x * t, corner.y + u.y * t);
      const pb = this.addPoint(corner.x + v.x * t, corner.y + v.y * t);
      this.replaceEndpoint(a, shared, pa);
      this.replaceEndpoint(b, shared, pb);
      this.addEntity({ type: 'line', p: [pa, pb] });
    } else {
      const r = Math.min(size, lenA * 0.9, lenB * 0.9);
      const t = r / Math.tan(theta / 2);
      if (!Number.isFinite(t) || t <= 0 || t > Math.min(lenA, lenB)) {
        this.status('That radius will not fit this corner.');
        return;
      }
      const pa = this.addPoint(corner.x + u.x * t, corner.y + u.y * t);
      const pb = this.addPoint(corner.x + v.x * t, corner.y + v.y * t);
      const bis = norm2({ x: u.x + v.x, y: u.y + v.y });
      const dCentre = r / Math.sin(theta / 2);
      const cIdx = this.addPoint(corner.x + bis.x * dCentre, corner.y + bis.y * dCentre);

      this.replaceEndpoint(a, shared, pa);
      this.replaceEndpoint(b, shared, pb);

      const centre = this.sketch.points[cIdx];
      const a0 = Math.atan2(
        this.sketch.points[pa].y - centre.y,
        this.sketch.points[pa].x - centre.x
      );
      const a1 = Math.atan2(
        this.sketch.points[pb].y - centre.y,
        this.sketch.points[pb].x - centre.x
      );
      let sweep = a1 - a0;
      while (sweep < -Math.PI) sweep += TAU;
      while (sweep > Math.PI) sweep -= TAU;

      const arc = this.addEntity({ type: 'arc', c: cIdx, p: [pa, pb], ccw: sweep >= 0 });
      this.addConstraint({ type: 'tangent', entities: [a.id, arc.id] });
      this.addConstraint({ type: 'tangent', entities: [b.id, arc.id] });
    }

    this.compactPoints();
    this.finishStep();
  }

  replaceEndpoint(ent, oldIdx, newIdx) {
    if (ent.type === 'line' || ent.type === 'arc') {
      ent.p = ent.p.map((i) => (i === oldIdx ? newIdx : i));
    }
  }

  offsetEntity(ent, pos) {
    const dist = this.offsetDistance || 2;
    if (ent.type === 'circle') {
      const c = this.sketch.points[ent.c];
      const outward = Math.hypot(pos.x - c.x, pos.y - c.y) > ent.r;
      const nc = this.addPoint(c.x, c.y);
      const r = ent.r + (outward ? dist : -dist);
      if (r > 1e-6) {
        this.addEntity({ type: 'circle', c: nc, r });
        this.addConstraint({ type: 'concentric', entities: [ent.id, this.sketch.entities[this.sketch.entities.length - 1].id] });
      }
    } else if (ent.type === 'line') {
      const a = this.sketch.points[ent.p[0]];
      const b = this.sketch.points[ent.p[1]];
      const d = norm2({ x: b.x - a.x, y: b.y - a.y });
      let nx = -d.y;
      let ny = d.x;
      const side = (pos.x - a.x) * nx + (pos.y - a.y) * ny;
      if (side < 0) {
        nx = -nx;
        ny = -ny;
      }
      const p0 = this.addPoint(a.x + nx * dist, a.y + ny * dist);
      const p1 = this.addPoint(b.x + nx * dist, b.y + ny * dist);
      const ne = this.addEntity({ type: 'line', p: [p0, p1] });
      this.addConstraint({ type: 'parallel', entities: [ent.id, ne.id] });
    }
    this.finishStep();
  }

  /**
   * Cut a line in two where the rest of the sketch crosses it, keeping both
   * halves. Trim throws the clicked piece away; break leaves it, which is what
   * you want when the two halves are about to be given different constraints.
   */
  breakAt(ent, pos) {
    if (ent.type !== 'line') {
      this.status('Break works on a line. Trim the piece off a curve instead.');
      return;
    }
    const a = this.sketch.points[ent.p[0]];
    const b = this.sketch.points[ent.p[1]];
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    if (len2 < 1e-12) return;
    const tOf = (p) => ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2;

    const cuts = this.intersectionsOn(ent)
      .map(tOf)
      .filter((t) => t > 1e-4 && t < 1 - 1e-4)
      .sort((m, n) => m - n);
    if (!cuts.length) {
      this.status('Nothing crosses that line, so there is nowhere to break it.');
      return;
    }

    // The crossing nearest the click, so a line crossed several times breaks
    // where the pointer was rather than at whichever one came first.
    const tClick = tOf(pos);
    let best = cuts[0];
    for (const t of cuts) {
      if (Math.abs(t - tClick) < Math.abs(best - tClick)) best = t;
    }

    if (this.onBeforeChange) this.onBeforeChange();
    const start = ent.p[0];
    const end = ent.p[1];
    const q = this.addPoint(a.x + (b.x - a.x) * best, a.y + (b.y - a.y) * best);
    this.removeEntity(ent.id);
    this.addEntity({ type: 'line', p: [start, q] });
    this.addEntity({ type: 'line', p: [q, end] });
    this.status('Line broken in two.');
    this.finishStep();
  }

  /**
   * Run the near end of a line on until it meets the next thing in its way.
   *
   * The extension is along the line's own direction, so the meeting point is
   * where that ray first crosses another curve. Nothing in the way means
   * nothing happens, rather than the line shooting off to some arbitrary length.
   */
  extendAt(ent, pos) {
    if (ent.type !== 'line') {
      this.status('Extend works on a line.');
      return;
    }
    const ia = ent.p[0];
    const ib = ent.p[1];
    const a = this.sketch.points[ia];
    const b = this.sketch.points[ib];
    const da = Math.hypot(pos.x - a.x, pos.y - a.y);
    const db = Math.hypot(pos.x - b.x, pos.y - b.y);
    const movingStart = da < db;
    const tip = movingStart ? a : b;
    const anchor = movingStart ? b : a;
    const dx = tip.x - anchor.x;
    const dy = tip.y - anchor.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return;
    const ux = dx / len;
    const uy = dy / len;

    let bestT = Infinity;
    let bestP = null;
    for (const other of this.sketch.entities) {
      if (other.id === ent.id || other.construction) continue;
      for (const run of entityRuns(this.sketch, other)) {
        for (let i = 0; i < run.length - 1; i++) {
          const hit = rayHitSegment(tip, ux, uy, run[i], run[i + 1]);
          if (hit && hit.t > 1e-6 && hit.t < bestT) {
            bestT = hit.t;
            bestP = hit.p;
          }
        }
      }
    }
    if (!bestP) {
      this.status('Nothing in the way to extend to.');
      return;
    }

    if (this.onBeforeChange) this.onBeforeChange();
    const q = this.addPoint(bestP.x, bestP.y);
    this.removeEntity(ent.id);
    this.addEntity({ type: 'line', p: movingStart ? [q, ib] : [ia, q] });
    this.status('Line extended.');
    this.finishStep();
  }

  /**
   * Remove the piece of a curve between its nearest intersections with the
   * rest of the sketch, which is what "trim" means to anyone drawing.
   */
  trimAt(ent, pos) {
    const cuts = this.intersectionsOn(ent);
    const pts = tessellate(this.sketch, ent);

    if (ent.type === 'line') {
      const a = this.sketch.points[ent.p[0]];
      const b = this.sketch.points[ent.p[1]];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const tOf = (p) => ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len);
      const tClick = tOf(pos);
      const ts = [0, ...cuts.map(tOf).filter((t) => t > 1e-6 && t < 1 - 1e-6), 1].sort(
        (m, n) => m - n
      );
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < ts.length - 1; i++) {
        if (tClick >= ts[i] && tClick <= ts[i + 1]) {
          lo = ts[i];
          hi = ts[i + 1];
          break;
        }
      }
      if (lo <= 1e-6 && hi >= 1 - 1e-6) {
        this.removeEntity(ent.id);
      } else {
        const at = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        const originalStart = ent.p[0];
        const originalEnd = ent.p[1];
        this.removeEntity(ent.id);
        if (lo > 1e-6) {
          const q = this.addPoint(at(lo).x, at(lo).y);
          this.addEntity({ type: 'line', p: [originalStart, q] });
        }
        if (hi < 1 - 1e-6) {
          const q = this.addPoint(at(hi).x, at(hi).y);
          this.addEntity({ type: 'line', p: [q, originalEnd] });
        }
      }
    } else if (ent.type === 'circle') {
      const c = this.sketch.points[ent.c];
      const angles = cuts
        .map((p) => Math.atan2(p.y - c.y, p.x - c.x))
        .map((a) => (a < 0 ? a + TAU : a))
        .sort((m, n) => m - n);
      if (angles.length < 2) {
        this.removeEntity(ent.id);
      } else {
        let click = Math.atan2(pos.y - c.y, pos.x - c.x);
        if (click < 0) click += TAU;
        let lo = angles[angles.length - 1] - TAU;
        let hi = angles[0];
        for (let i = 0; i < angles.length; i++) {
          const s = angles[i];
          const e = i + 1 < angles.length ? angles[i + 1] : angles[0] + TAU;
          if (click >= s && click <= e) {
            lo = s;
            hi = e;
            break;
          }
        }
        const cIdx = ent.c;
        const r = ent.r;
        this.removeEntity(ent.id);
        const sIdx = this.addPoint(c.x + r * Math.cos(hi), c.y + r * Math.sin(hi));
        const eIdx = this.addPoint(c.x + r * Math.cos(lo), c.y + r * Math.sin(lo));
        this.addEntity({ type: 'arc', c: cIdx, p: [sIdx, eIdx], ccw: true });
      }
    } else {
      this.removeEntity(ent.id);
    }

    this.compactPoints();
    this.finishStep();
  }

  intersectionsOn(ent) {
    const out = [];
    const mine = tessellate(this.sketch, ent);
    for (const other of this.sketch.entities) {
      if (other.id === ent.id) continue;
      const theirs = tessellate(this.sketch, other);
      for (let i = 0; i < mine.length - 1; i++) {
        for (let j = 0; j < theirs.length - 1; j++) {
          const hit = segIntersect(mine[i], mine[i + 1], theirs[j], theirs[j + 1]);
          if (hit) out.push(hit);
        }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Dimensions and constraints                                        */
  /* ---------------------------------------------------------------- */

  dimensionAt(pos, snap) {
    if (!this.pending || this.pending.tool !== 'dimension') {
      // A circle or arc dimensions on its own.
      const hit = this.entityAt(pos, this.pixelScale() * SNAP_PX);
      if (hit && (hit.type === 'circle' || hit.type === 'arc')) {
        const current =
          hit.type === 'circle'
            ? hit.r * 2
            : 2 *
              Math.hypot(
                this.sketch.points[hit.p[0]].x - this.sketch.points[hit.c].x,
                this.sketch.points[hit.p[0]].y - this.sketch.points[hit.c].y
              );
        this.requestDimension('diameter', current, (value, expr) => {
          this.addConstraint({ type: 'diameter', entity: hit.id, value, ...(expr ? { expr } : {}) });
        });
        return;
      }
      if (hit && hit.type === 'line') {
        const a = this.sketch.points[hit.p[0]];
        const b = this.sketch.points[hit.p[1]];
        const current = Math.hypot(b.x - a.x, b.y - a.y);
        this.requestDimension('length', current, (value, expr) => {
          this.addConstraint({
            type: 'distance',
            points: [hit.p[0], hit.p[1]],
            value,
            ...(expr ? { expr } : {})
          });
        });
        return;
      }
      if (snap?.pointIndex !== undefined && snap.pointIndex !== null) {
        this.pending = { tool: 'dimension', points: [snap.pointIndex] };
        this.status('Now click the second point.');
        return;
      }
      this.status('Click a line, a circle, or two points.');
      return;
    }

    if (snap?.pointIndex !== undefined && snap.pointIndex !== null) {
      const a = this.pending.points[0];
      const b = snap.pointIndex;
      this.pending = null;
      if (a === b) return;
      const pa = this.sketch.points[a];
      const pb = this.sketch.points[b];
      const current = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      this.requestDimension('distance', current, (value, expr) => {
        this.addConstraint({ type: 'distance', points: [a, b], value, ...(expr ? { expr } : {}) });
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Typed dimensions while drawing                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Open the entry boxes for a tool that has just taken its first point.
   * Values track the cursor until one is typed into, which locks it.
   */
  beginEntry(tool, anchorIdx) {
    const specs = ENTRY_FIELDS[tool];
    if (!specs || !this.overlayEl) return;
    this.entry = {
      tool,
      anchor: anchorIdx,
      fields: specs.map((f) => ({ ...f, value: 0, expr: '', locked: false }))
    };
    this._buildEntryDom();
    this.updateEntry(this.cursor);
  }

  endEntry() {
    if (this.entryEl) {
      this.entryEl.remove();
      this.entryEl = null;
    }
    this.entry = null;
  }

  entryLocked() {
    return !!this.entry && this.entry.fields.some((f) => f.locked);
  }

  /** What the cursor alone says each field is worth. */
  _measureEntry(pos) {
    const a = this.sketch.points[this.entry.anchor];
    if (!a) return {};
    const dx = pos.x - a.x;
    const dy = pos.y - a.y;
    switch (this.entry.tool) {
      case 'line':
        return { length: Math.hypot(dx, dy), angle: angleOf(dx, dy) };
      case 'rectangle':
        return { width: Math.abs(dx), height: Math.abs(dy) };
      case 'centerRectangle':
        // buildRectangle reads the second point as a half extent from the
        // centre, but the box asks for the whole width, the way Fusion does.
        return { width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
      case 'circle':
        return { diameter: Math.hypot(dx, dy) * 2 };
      case 'circleDia':
        return { diameter: Math.hypot(dx, dy) };
      default:
        return {};
    }
  }

  /** Refresh the untyped fields from the cursor and move the boxes with it. */
  updateEntry(pos) {
    if (!this.entry || !this.entryEl) return;
    const measured = this._measureEntry(pos);
    for (const f of this.entry.fields) {
      if (f.locked) continue;
      f.value = measured[f.key] ?? 0;
      const input = this.entryEl.querySelector('input[data-key="' + f.key + '"]');
      if (input && document.activeElement !== input) input.value = fmtEntry(f.value);
    }
    const s = this.planeToScreen(pos.x, pos.y);
    this.entryEl.style.display = s.behind ? 'none' : '';
    this.entryEl.style.left = (s.x + 16) + 'px';
    this.entryEl.style.top = (s.y + 16) + 'px';
  }

  /**
   * Where the second point has to sit for the typed values to hold. Fields left
   * untyped keep following the cursor, so typing only a width still lets the
   * height be aimed.
   */
  entryTarget(pos) {
    if (!this.entry) return pos;
    const a = this.sketch.points[this.entry.anchor];
    if (!a) return pos;
    const val = (key) => {
      const f = this.entry.fields.find((x) => x.key === key);
      return f && f.locked ? f.value : null;
    };
    const dx = pos.x - a.x;
    const dy = pos.y - a.y;

    if (this.entry.tool === 'line') {
      const len = val('length') ?? Math.hypot(dx, dy);
      const angDeg = val('angle') ?? angleOf(dx, dy);
      const ang = (angDeg * Math.PI) / 180;
      return { x: a.x + len * Math.cos(ang), y: a.y + len * Math.sin(ang) };
    }

    // Which way the cursor points decides which corner, or which side of the
    // centre, the typed size grows towards.
    const sx = dx < 0 ? -1 : 1;
    const sy = dy < 0 ? -1 : 1;

    if (this.entry.tool === 'rectangle' || this.entry.tool === 'centerRectangle') {
      const half = this.entry.tool === 'centerRectangle' ? 0.5 : 1;
      const w = val('width');
      const h = val('height');
      return {
        x: w === null ? pos.x : a.x + sx * w * half,
        y: h === null ? pos.y : a.y + sy * h * half
      };
    }

    const d = val('diameter');
    if (d === null) return pos;
    const r = this.entry.tool === 'circle' ? d / 2 : d;
    const len = Math.hypot(dx, dy);
    const ux = len > 1e-9 ? dx / len : 1;
    const uy = len > 1e-9 ? dy / len : 0;
    return { x: a.x + ux * r, y: a.y + uy * r };
  }

  _buildEntryDom() {
    if (this.entryEl) this.entryEl.remove();
    const box = document.createElement('div');
    box.className = 'sk-entry';

    for (const f of this.entry.fields) {
      const wrap = document.createElement('label');
      wrap.className = 'sk-entry-field';
      const cap = document.createElement('span');
      cap.textContent = f.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.key = f.key;
      input.spellcheck = false;
      input.addEventListener('input', () => {
        const text = input.value.trim();
        f.locked = text !== '';
        f.expr = text;
        f.value = this.evalEntry(text, f.value);
        wrap.classList.toggle('locked', f.locked);
        this.rebuild();
      });
      input.addEventListener('keydown', (ev) => this._entryKey(ev, f));
      wrap.appendChild(cap);
      wrap.appendChild(input);
      box.appendChild(wrap);
    }

    this.overlayEl.appendChild(box);
    this.entryEl = box;
  }

  /** A field takes a number, or any expression the parameters understand. */
  evalEntry(text, fallback) {
    const t = String(text).trim();
    if (!t) return fallback;
    const v = safeEval(t, this.paramScope || {}, NaN);
    return Number.isFinite(v) ? v : fallback;
  }

  _entryKey(ev, field) {
    if (!this.entry) return;
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const inputs = [...this.entryEl.querySelectorAll('input')];
      const i = inputs.indexOf(ev.target);
      const next = inputs[(i + (ev.shiftKey ? -1 : 1) + inputs.length) % inputs.length];
      next.focus();
      next.select();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      // Whether a field counts as typed is settled by the input event, not by
      // what is showing. The untyped ones display the measurement under the
      // cursor, and committing from one of those must not freeze it.
      ev.target.blur();
      this.applyTool(this.entryTarget(this.cursor), null, {});
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      ev.target.blur();
      this.pending = null;
      this.dragDraw = null;
      this.endEntry();
      this.rebuild();
    }
  }

  /**
   * Turn the typed fields into constraints on what was just built, so the shape
   * keeps that size when something upstream of it moves.
   */
  applyEntryDimensions(built) {
    if (!this.entry) return;
    const locked = this.entry.fields.filter((f) => f.locked);
    const dim = (c, f) => {
      // Keep the text when it was more than a number, so a size given as
      // `wall * 2` or `2in` still reads back the way it was typed.
      const expr = exprOf(f.expr, f.value);
      if (expr) c.expr = expr;
      this.addConstraint(c);
    };

    for (const f of locked) {
      if (f.key === 'length' && built.points) {
        dim({ type: 'distance', points: built.points, value: f.value }, f);
      } else if (f.key === 'width' && built.widthPoints) {
        dim({ type: 'distance', points: built.widthPoints, value: f.value }, f);
      } else if (f.key === 'height' && built.heightPoints) {
        dim({ type: 'distance', points: built.heightPoints, value: f.value }, f);
      } else if (f.key === 'diameter' && built.circle !== undefined) {
        dim({ type: 'diameter', entity: built.circle, value: f.value }, f);
      } else if (f.key === 'angle' && built.line !== undefined) {
        this._applyAngle(f, built);
      }
    }
    this.endEntry();
  }

  /**
   * An angle from the X axis has nothing to hang a dimension on, because the
   * axis is not an entity a constraint can name. Square angles become the
   * horizontal or vertical they mean, and anything else is measured against the
   * previous segment of the chain, which is a real dimension. A lone slanted
   * line is placed where it was asked for, left undimensioned, and says so.
   */
  _applyAngle(field, built) {
    const a = ((field.value % 360) + 360) % 360;
    const square = [0, 90, 180, 270].find(
      (t) => Math.abs(a - t) < 1e-6 || Math.abs(a - t - 360) < 1e-6
    );
    if (square !== undefined) {
      this.addConstraint({
        type: square === 90 || square === 270 ? 'vertical' : 'horizontal',
        entity: built.line
      });
      return;
    }
    if (built.previousLine !== undefined && built.previousLine !== null) {
      const prev = this.entity(built.previousLine);
      const now = this.entity(built.line);
      if (prev && now) {
        this.addConstraint({
          type: 'angle',
          entities: [built.previousLine, built.line],
          value: this._measuredAngle(prev, now)
        });
        return;
      }
    }
    this.status(
      'Line drawn at ' + fmtEntry(field.value) + ' degrees. There is nothing ' +
        'to measure that angle against yet, so it is not dimensioned.'
    );
  }

  _measuredAngle(e1, e2) {
    const P = this.sketch.points;
    const u = { x: P[e1.p[1]].x - P[e1.p[0]].x, y: P[e1.p[1]].y - P[e1.p[0]].y };
    const w = { x: P[e2.p[1]].x - P[e2.p[0]].x, y: P[e2.p[1]].y - P[e2.p[0]].y };
    return (Math.atan2(u.x * w.y - u.y * w.x, u.x * w.x + u.y * w.y) * 180) / Math.PI;
  }

  /**
   * Ask the host for a dimension and apply what comes back.
   *
   * `current` may be the text a dimension already carries, so reopening one
   * written as `wall * 2` offers that rather than the millimetres it came to.
   * `apply` is handed the number and the text it was written as.
   */
  requestDimension(kind, current, apply) {
    const place = (value, text) => {
      const before = solveSketch(this.sketch, { maxIterations: 4 }).dof;
      apply(value, exprOf(text, value));
      const added = this.sketch.constraints[this.sketch.constraints.length - 1];
      const after = solveSketch(this.sketch, { maxIterations: 30 });

      // If the sketch was already pinned down, this dimension cannot drive
      // anything. Fusion turns it into a reference rather than refusing it, and
      // shows it in parentheses.
      if (added && before === 0 && after.dof === 0 && after.error > 1e-6) {
        added.driven = true;
        this.status('That dimension would over-constrain the sketch, so it is a reference.');
      } else if (added && before === after.dof && before === 0) {
        added.driven = true;
      }
      this.finishStep();
    };

    if (!this.onDimensionRequest) {
      place(Number(current) || 0, null);
      return;
    }
    this.onDimensionRequest(kind, current, (text) => {
      if (text === null || text === undefined) return;
      const value = this.evalEntry(text, NaN);
      if (!Number.isFinite(value)) {
        this.status(`"${text}" is not a length this can work out.`);
        return;
      }
      place(value, text);
    });
  }

  applyConstraint(type) {
    this.announce();
    const ents = [...this.selection]
      .filter((k) => k.startsWith('e'))
      .map((k) => this.entity(Number(k.slice(1))))
      .filter(Boolean);
    const pts = [...this.selection]
      .filter((k) => k.startsWith('p'))
      .map((k) => Number(k.slice(1)));

    const need = (n, what) => {
      this.status(`Select ${what} first.`);
      return false;
    };

    switch (type) {
      case 'horizontal':
      case 'vertical':
        if (!ents.length) return need(1, 'a line');
        for (const e of ents) {
          if (e.type === 'line') this.addConstraint({ type, entity: e.id });
        }
        break;

      case 'collinear':
        if (ents.length < 2) return need(2, 'two lines');
        if (ents.some((e) => e.type !== 'line')) {
          this.status('Collinear is for lines.');
          return;
        }
        for (let i = 1; i < ents.length; i++) {
          this.addConstraint({ type, entities: [ents[0].id, ents[i].id] });
        }
        break;

      case 'parallel':
      case 'perpendicular':
      case 'equal':
      case 'tangent':
      case 'concentric':
        if (ents.length < 2) return need(2, 'two curves');
        for (let i = 1; i < ents.length; i++) {
          this.addConstraint({ type, entities: [ents[0].id, ents[i].id] });
        }
        break;

      case 'coincident':
        if (pts.length < 2) return need(2, 'two points');
        for (let i = 1; i < pts.length; i++) {
          this.addConstraint({ type, points: [pts[0], pts[i]] });
        }
        break;

      case 'midpoint':
        if (!pts.length || !ents.length) return need(2, 'a point and a line');
        this.addConstraint({ type, point: pts[0], entity: ents[0].id });
        break;

      case 'symmetric':
        if (pts.length < 2 || !ents.length) return need(3, 'two points and a line');
        this.addConstraint({ type, points: [pts[0], pts[1]], entity: ents[0].id });
        break;

      case 'fix':
        for (const i of pts) {
          const p = this.sketch.points[i];
          this.addConstraint({ type: 'fixed', point: i, x: p.x, y: p.y });
        }
        for (const e of ents) {
          const ids = e.type === 'line' ? e.p : e.type === 'arc' ? [e.c, ...e.p] : [e.c];
          for (const i of ids) {
            const p = this.sketch.points[i];
            this.addConstraint({ type: 'fixed', point: i, x: p.x, y: p.y });
          }
        }
        break;

      default:
        return false;
    }

    this.finishStep();
    return true;
  }

  toggleConstruction() {
    this.announce();
    const ents = [...this.selection]
      .filter((k) => k.startsWith('e'))
      .map((k) => this.entity(Number(k.slice(1))))
      .filter(Boolean);
    if (!ents.length) {
      this.constructionMode = !this.constructionMode;
      this.status(this.constructionMode ? 'Drawing construction geometry.' : 'Drawing normal geometry.');
      return;
    }
    for (const e of ents) e.construction = !e.construction;
    this.finishStep();
  }

  /**
   * Mirror the selected curves about a line.
   *
   * The copies are tied to the originals with symmetry constraints rather than
   * being loose duplicates, so dimensioning one side still moves both.
   */
  mirrorSelection(axisEntityId) {
    const axis = this.entity(axisEntityId);
    if (!axis || axis.type !== 'line') {
      this.status('Pick a line to mirror about.');
      return false;
    }
    const chosen = [...this.selection]
      .filter((k) => k.startsWith('e'))
      .map((k) => this.entity(Number(k.slice(1))))
      .filter((e) => e && e.id !== axisEntityId);
    if (!chosen.length) {
      this.status('Select the geometry to mirror first.');
      return false;
    }

    this.announce();
    const P = this.sketch.points;
    const a = P[axis.p[0]];
    const b = P[axis.p[1]];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) return false;

    const reflect = (p) => {
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      const px2 = a.x + dx * t;
      const py2 = a.y + dy * t;
      return { x: 2 * px2 - p.x, y: 2 * py2 - p.y };
    };

    const mapped = new Map();
    const mirrorPoint = (i) => {
      if (mapped.has(i)) return mapped.get(i);
      const r = reflect(P[i]);
      const idx = this.addPoint(r.x, r.y);
      mapped.set(i, idx);
      this.addConstraint({ type: 'symmetric', points: [i, idx], entity: axis.id });
      return idx;
    };

    for (const ent of chosen) {
      if (ent.type === 'line') {
        this.addEntity({ type: 'line', p: [mirrorPoint(ent.p[0]), mirrorPoint(ent.p[1])] });
      } else if (ent.type === 'circle') {
        const c = mirrorPoint(ent.c);
        const copy = this.addEntity({ type: 'circle', c, r: ent.r });
        this.addConstraint({ type: 'equal', entities: [ent.id, copy.id] });
      } else if (ent.type === 'arc') {
        // Reflection reverses the way an arc turns.
        this.addEntity({
          type: 'arc',
          c: mirrorPoint(ent.c),
          p: [mirrorPoint(ent.p[0]), mirrorPoint(ent.p[1])],
          ccw: ent.ccw === false
        });
      } else if (ent.type === 'spline') {
        this.addEntity({ type: 'spline', p: ent.p.map(mirrorPoint), closed: ent.closed });
      }
    }

    this.compactPoints();
    this.finishStep();
    return true;
  }

  /**
   * Copy the chosen geometry through a point transform.
   *
   * Every pattern is this with a different transform, so the entity-by-entity
   * knowledge lives here once. A copy is plain geometry rather than an instance
   * that tracks the original, which is the same trade the model patterns make:
   * predictable, and never surprising when the original later moves.
   */
  copySelectionThrough(transform, opts = {}) {
    const chosen = this.selectedEntities();
    if (!chosen.length) return [];
    const P = this.sketch.points;
    const mapped = new Map();
    const at = (i) => {
      if (mapped.has(i)) return mapped.get(i);
      const q = transform(P[i]);
      const idx = this.addPoint(q.x, q.y);
      mapped.set(i, idx);
      return idx;
    };

    // How much the transform stretches, so a circle's stored radius keeps up.
    const scaleOf = () => {
      const o = transform({ x: 0, y: 0 });
      const u = transform({ x: 1, y: 0 });
      return Math.hypot(u.x - o.x, u.y - o.y);
    };
    const k = opts.scales ? scaleOf() : 1;

    const made = [];
    for (const ent of chosen) {
      const copy = { ...ent };
      delete copy.id;
      if (ent.type === 'line') copy.p = [at(ent.p[0]), at(ent.p[1])];
      else if (ent.type === 'circle') {
        copy.c = at(ent.c);
        copy.r = ent.r * k;
      } else if (ent.type === 'arc') {
        copy.c = at(ent.c);
        copy.p = [at(ent.p[0]), at(ent.p[1])];
        // A reflection reverses the way an arc turns; a rotation does not.
        if (opts.reverseArcs) copy.ccw = ent.ccw === false;
      } else if (ent.type === 'spline') copy.p = ent.p.map(at);
      else if (ent.type === 'ellipse') {
        copy.c = at(ent.c);
        copy.a = at(ent.a);
        copy.b = at(ent.b);
      } else if (ent.type === 'point') copy.p = at(ent.p);
      else if (ent.type === 'text') {
        copy.p = at(ent.p);
        copy.contours = ent.contours?.map((loop) => loop.map((q) => ({ ...q })));
        if (k !== 1) {
          copy.height = ent.height * k;
          copy.contours = copy.contours?.map((loop) =>
            loop.map((q) => ({ x: q.x * k, y: q.y * k }))
          );
        }
      } else continue;
      made.push(this.addEntity(copy));
    }
    return made;
  }

  /** The entities currently selected, in document order. */
  selectedEntities() {
    return [...this.selection]
      .filter((key) => key.startsWith('e'))
      .map((key) => this.entity(Number(key.slice(1))))
      .filter(Boolean);
  }

  /**
   * A grid of copies. Counts include the original, so 1 by 1 is a no-op rather
   * than a duplicate sitting exactly on top of what it came from.
   */
  patternSelectionRect({ countX = 2, countY = 1, spacingX = 10, spacingY = 10, angle = 0 }) {
    if (!this.selectedEntities().length) {
      this.status('Select the geometry to pattern first.');
      return false;
    }
    const th = (angle * Math.PI) / 180;
    const ux = Math.cos(th);
    const uy = Math.sin(th);
    const nx = Math.ceil(Math.max(1, countX));
    const ny = Math.ceil(Math.max(1, countY));
    if (nx * ny <= 1) {
      this.status('A pattern of one is what is already there.');
      return false;
    }
    this.announce();
    // Every copy comes from the original, not from the copy before it, so a
    // rounding error cannot accumulate along the row.
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (i === 0 && j === 0) continue;
        const dx = i * spacingX * ux - j * spacingY * uy;
        const dy = i * spacingX * uy + j * spacingY * ux;
        this.copySelectionThrough((p) => ({ x: p.x + dx, y: p.y + dy }));
      }
    }
    this.finishStep();
    this.status(`Patterned into ${nx * ny}.`);
    return true;
  }

  /** Copies turned about a centre. The count includes the original. */
  patternSelectionCircular({ count = 4, angle = 360, cx = 0, cy = 0, rotate = true }) {
    if (!this.selectedEntities().length) {
      this.status('Select the geometry to pattern first.');
      return false;
    }
    const n = Math.ceil(Math.max(1, count));
    if (n <= 1) {
      this.status('A pattern of one is what is already there.');
      return false;
    }
    // A full turn puts the last copy back on the first, so the step divides by
    // the count; anything less is an arc and the ends are both wanted.
    const full = Math.abs(Math.abs(angle) - 360) < 1e-6;
    const step = ((angle * Math.PI) / 180) / (full ? n : n - 1);

    this.announce();
    for (let i = 1; i < n; i++) {
      const th = step * i;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      this.copySelectionThrough((p) => {
        const dx = p.x - cx;
        const dy = p.y - cy;
        return {
          x: cx + dx * cs - dy * sn,
          y: cy + dx * sn + dy * cs
        };
      });
    }
    this.finishStep();
    this.status(`Patterned into ${n}.`);
    return true;
  }

  /**
   * Resize the chosen geometry about a point, in place rather than as a copy.
   *
   * Dimensions are left alone on purpose: a scaled sketch whose dimensions
   * still say the old numbers is wrong either way, and silently rewriting what
   * someone typed is the worse of the two. A driven dimension pulls the
   * geometry back on the next solve, which says clearly that it is in charge.
   */
  scaleSelection({ factor = 1, cx = 0, cy = 0 }) {
    const chosen = this.selectedEntities();
    if (!chosen.length) {
      this.status('Select the geometry to scale first.');
      return false;
    }
    const k = Number(factor);
    if (!Number.isFinite(k) || Math.abs(k) < 1e-9) {
      this.status('A scale of zero has nothing to show.');
      return false;
    }

    this.announce();
    const moved = new Set();
    for (const ent of chosen) {
      for (const i of entityPoints(ent)) moved.add(i);
      if (ent.type === 'circle') ent.r *= Math.abs(k);
      if (ent.type === 'text') {
        ent.height *= Math.abs(k);
        ent.contours = ent.contours?.map((loop) =>
          loop.map((q) => ({ x: q.x * k, y: q.y * k }))
        );
      }
    }
    for (const i of moved) {
      const p = this.sketch.points[i];
      if (!p) continue;
      p.x = cx + (p.x - cx) * k;
      p.y = cy + (p.y - cy) * k;
    }
    // Anchors have to come along, or the solver simply pulls it all back and
    // the scale appears to do nothing at all.
    for (const c of this.sketch.constraints) {
      if (c.type === 'fixed' && moved.has(c.point)) {
        c.x = cx + (c.x - cx) * k;
        c.y = cy + (c.y - cy) * k;
      }
    }
    this.finishStep();
    this.status(`Scaled by ${k}.`);
    return true;
  }

  removeConstraint(id) {
    this.sketch.constraints = this.sketch.constraints.filter((c) => c.id !== id);
    this.finishStep();
  }

  /* ---------------------------------------------------------------- */
  /* Solve and notify                                                  */
  /* ---------------------------------------------------------------- */

  solve() {
    if (!this.sketch) return null;
    resolveDimensionExprs(this.sketch, this.paramScope);
    const res = solveSketch(this.sketch, { maxIterations: 60 });
    this.lastSolve = res;
    this.refreshRegions();
    return res;
  }

  refreshRegions() {
    if (!this.sketch) return;
    // Projected edges and a section close regions just as the sketch's own
    // curves do, and the rebuild already counts them that way. Leaving them out
    // here means a section you can see but cannot click, which is the whole
    // reason for taking one.
    this.regions = findRegions(materializeSketch(this.sketch, this.derived));
    const live = new Set(this.regions.map((r) => r.id));
    for (const id of [...this.selectedRegions]) {
      if (!live.has(id)) this.selectedRegions.delete(id);
    }
  }

  finishStep(keepTool = false) {
    this.solve();
    this.rebuild();
    this.commit();
    if (!keepTool && this.tool !== 'select' && this.oneShot) this.setTool('select');
  }

  commit() {
    if (this.onChange) this.onChange();
  }

  /** Tell the host an edit is about to happen, so it can save the state. */
  announce() {
    if (this.onBeforeChange) this.onBeforeChange();
  }

  commitSelection() {
    if (this.onSelectionChanged) this.onSelectionChanged();
  }

  selectedRegionObjects() {
    return this.regions.filter((r) => this.selectedRegions.has(r.id));
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  clearGraphics() {
    while (this.group.children.length) {
      const c = this.group.children.pop();
      c.geometry?.dispose?.();
      if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
      else c.material?.dispose?.();
    }
  }

  clearLabels() {
    for (const el of this.labels) el.remove();
    this.labels = [];
  }

  rebuild() {
    if (!this.active) return;
    this.clearGraphics();

    // The third coordinate is honoured, so a curve that leaves the plane is
    // drawn where it actually is rather than flattened onto it.
    const toWorld = (p) => sketchToWorld(this.plane, p.x, p.y, p.z || 0);

    // Filled regions, so a closed profile reads as an area rather than an outline.
    for (const r of this.regions) {
      const selected = this.selectedRegions.has(r.id);
      const shape = new THREE.Shape(r.outer.map((p) => new THREE.Vector2(p.x, p.y)));
      for (const h of r.holes) {
        shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
      }
      const geo = new THREE.ShapeGeometry(shape);
      geo.applyMatrix4(this._planeMatrix());
      // A closed profile is tinted, not shaded: on a light ground a grey wash
      // reads as dirt on the drawing. Chosen ones take the accent.
      const mat = new THREE.MeshBasicMaterial({
        color: selected ? 0xd84b1e : 0xf6f4ef,
        transparent: true,
        opacity: selected ? 0.2 : 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: false
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 4;
      this.group.add(mesh);
    }

    // Geometry that came from the model, drawn first so the sketch's own
    // curves sit over it.
    if (this.derived?.entities?.length) {
      const P = this.derived.points;
      for (const ent of this.derived.entities) {
        const run = tessellate({ points: P, entities: this.derived.entities }, ent);
        if (run.length < 2) continue;
        const geo = new THREE.BufferGeometry().setFromPoints(run.map(toWorld));
        const line = new THREE.Line(
          geo,
          new THREE.LineBasicMaterial({
            color: COLORS.projected,
            depthTest: false,
            transparent: true,
            opacity: 0.95
          })
        );
        line.renderOrder = 5;
        this.group.add(line);
      }
    }

    // Curves.
    for (const ent of this.sketch.entities) {
      if (ent.type === 'point') continue;
      // One entity can be many loops, so each is drawn on its own rather than
      // strung together into one run that jumps between letters.
      for (const run of entityRuns(this.sketch, ent)) {
      const pts = run.map(toWorld);
      if (pts.length < 2) continue;
      const key = `e${ent.id}`;
      const selected = this.selection.has(key);
      const hovered = this.hovered === key;
      const settled = this.lastSolve?.constrained?.get(ent.id);
      const color = selected
        ? COLORS.selected
        : hovered
          ? COLORS.hover
          : ent.construction
            ? COLORS.construction
            : settled
              ? COLORS.normal
              : COLORS.loose;

      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = ent.construction
        ? new THREE.LineDashedMaterial({
            color,
            dashSize: this.pixelScale() * 6,
            gapSize: this.pixelScale() * 4,
            depthTest: false,
            transparent: true
          })
        : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
      const line = new THREE.Line(geo, mat);
      if (ent.construction) line.computeLineDistances();
      line.renderOrder = 6;
      this.group.add(line);
      }
    }

    // Points.
    const fixedSet = new Set(
      this.sketch.constraints.filter((c) => c.type === 'fixed').map((c) => c.point)
    );
    const positions = [];
    const colors = [];
    this.sketch.points.forEach((p, i) => {
      if (!this.pointIsUsed(i)) return;
      const w = toWorld(p);
      positions.push(w.x, w.y, w.z);
      const c = new THREE.Color(
        this.selection.has(`p${i}`)
          ? COLORS.selected
          : fixedSet.has(i)
            ? COLORS.fixedPoint
            : COLORS.point
      );
      colors.push(c.r, c.g, c.b);
    });
    if (positions.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const mat = new THREE.PointsMaterial({
        size: 7,
        sizeAttenuation: false,
        vertexColors: true,
        map: this._pointTexture,
        transparent: true,
        depthTest: false,
        alphaTest: 0.4
      });
      const pts = new THREE.Points(geo, mat);
      pts.renderOrder = 8;
      this.group.add(pts);
    }

    this._renderPreview(toWorld);
    this._renderLabels();
    this.vp.invalidate();
  }

  _planeMatrix() {
    const p = this.plane;
    const m = new THREE.Matrix4();
    m.set(
      p.x[0], p.y[0], p.n[0], p.origin[0],
      p.x[1], p.y[1], p.n[1], p.origin[1],
      p.x[2], p.y[2], p.n[2], p.origin[2],
      0, 0, 0, 1
    );
    return m;
  }

  _renderPreview(toWorld) {
    if (!this.pending && this.tool === 'select') return;
    // Once a size has been typed the shape is that size, so the preview has to
    // show it rather than keep following the pointer.
    const c = this.entryLocked() ? this.entryTarget(this.cursor) : this.cursor;
    const mkLine = (a, b, color = COLORS.preview) => {
      const geo = new THREE.BufferGeometry().setFromPoints([toWorld(a), toWorld(b)]);
      const mat = new THREE.LineBasicMaterial({
        color,
        depthTest: false,
        transparent: true,
        opacity: 0.9
      });
      const l = new THREE.Line(geo, mat);
      l.renderOrder = 7;
      this.group.add(l);
    };
    const mkCircle = (centre, r) => {
      const pts = [];
      const n = 96;
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * TAU;
        pts.push(toWorld({ x: centre.x + r * Math.cos(t), y: centre.y + r * Math.sin(t) }));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: COLORS.preview,
        depthTest: false,
        transparent: true,
        opacity: 0.9
      });
      const l = new THREE.Line(geo, mat);
      l.renderOrder = 7;
      this.group.add(l);
    };

    if (!this.pending) return;
    const P = this.sketch.points;
    const first = P[this.pending.points[0]];

    switch (this.pending.tool) {
      case 'line': {
        const prev = P[this.pending.points[this.pending.points.length - 1]];
        const aligned = this.entryLocked() ? { pos: c } : this.axisAlign(prev, c);
        mkLine(prev, aligned.pos);
        break;
      }
      case 'rectangle':
      case 'centerRectangle': {
        let x0 = first.x;
        let y0 = first.y;
        let x1 = c.x;
        let y1 = c.y;
        if (this.pending.tool === 'centerRectangle') {
          const dx = Math.abs(c.x - first.x);
          const dy = Math.abs(c.y - first.y);
          x0 = first.x - dx;
          x1 = first.x + dx;
          y0 = first.y - dy;
          y1 = first.y + dy;
        }
        mkLine({ x: x0, y: y0 }, { x: x1, y: y0 });
        mkLine({ x: x1, y: y0 }, { x: x1, y: y1 });
        mkLine({ x: x1, y: y1 }, { x: x0, y: y1 });
        mkLine({ x: x0, y: y1 }, { x: x0, y: y0 });
        break;
      }
      case 'circle':
        mkCircle(first, Math.hypot(c.x - first.x, c.y - first.y));
        break;
      case 'circleDia':
        mkCircle(
          { x: (first.x + c.x) / 2, y: (first.y + c.y) / 2 },
          Math.hypot(c.x - first.x, c.y - first.y) / 2
        );
        break;
      case 'polygon': {
        const r = Math.hypot(c.x - first.x, c.y - first.y);
        const n = Math.max(3, this.polygonSides || 6);
        const a0 = Math.atan2(c.y - first.y, c.x - first.x);
        for (let i = 0; i < n; i++) {
          const t0 = a0 + (TAU * i) / n;
          const t1 = a0 + (TAU * (i + 1)) / n;
          mkLine(
            { x: first.x + r * Math.cos(t0), y: first.y + r * Math.sin(t0) },
            { x: first.x + r * Math.cos(t1), y: first.y + r * Math.sin(t1) }
          );
        }
        break;
      }
      case 'arc': {
        if (this.pending.points.length === 1) {
          mkLine(first, c);
        } else {
          const s = P[this.pending.points[1]];
          const r = Math.hypot(s.x - first.x, s.y - first.y);
          mkCircle(first, r);
          mkLine(first, c, COLORS.guide);
        }
        break;
      }
      case 'slot': {
        if (this.pending.points.length === 1) mkLine(first, c);
        else {
          const b = P[this.pending.points[1]];
          mkLine(first, b);
          mkCircle(first, distToSegment(c, first, b));
          mkCircle(b, distToSegment(c, first, b));
        }
        break;
      }
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- */
  /* HTML overlay for dimensions and constraint glyphs                 */
  /* ---------------------------------------------------------------- */

  _renderLabels() {
    this.clearLabels();
    if (!this.overlayEl) return;

    const P = this.sketch.points;
    const items = [];

    for (const c of this.sketch.constraints) {
      if (c.type === 'distance' || c.type === 'distanceX' || c.type === 'distanceY') {
        const a = P[c.points[0]];
        const b = P[c.points[1]];
        if (!a || !b) continue;
        const measured =
          c.type === 'distanceX'
            ? b.x - a.x
            : c.type === 'distanceY'
              ? b.y - a.y
              : Math.hypot(b.x - a.x, b.y - a.y);
        items.push({
          kind: 'dim',
          id: c.id,
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          text: this._dimText(c, measured),
          constraint: c
        });
      } else if (c.type === 'radius' || c.type === 'diameter') {
        const ent = this.entity(c.entity);
        if (!ent) continue;
        const centre = P[ent.c];
        if (!centre) continue;
        const r =
          ent.type === 'circle'
            ? ent.r
            : Math.hypot(P[ent.p[0]].x - centre.x, P[ent.p[0]].y - centre.y);
        const measured = c.type === 'diameter' ? r * 2 : r;
        const prefix = c.type === 'diameter' ? 'D' : 'R';
        items.push({
          kind: 'dim',
          id: c.id,
          x: centre.x,
          y: centre.y + r * 0.4,
          text: this._dimText(c, measured, prefix),
          constraint: c
        });
      } else if (c.type === 'angle') {
        const e1 = this.entity(c.entities[0]);
        if (!e1) continue;
        const a = P[e1.p[0]];
        items.push({
          kind: 'dim',
          id: c.id,
          x: a.x,
          y: a.y,
          text: `${c.value}°`,
          constraint: c
        });
      } else if (this.showConstraints) {
        const glyph = CONSTRAINT_GLYPHS[c.type];
        if (!glyph) continue;
        const anchor = this._constraintAnchor(c);
        if (!anchor) continue;
        items.push({ kind: 'glyph', id: c.id, x: anchor.x, y: anchor.y, text: glyph, constraint: c });
      }
    }

    for (const item of items) {
      const el = document.createElement('div');
      el.className = item.kind === 'dim' ? 'sk-dim' : 'sk-glyph';
      if (item.constraint.driven) el.classList.add('driven');
      if (item.constraint.expr) el.classList.add('linked');
      el.textContent = item.text;
      el.dataset.constraintId = item.id;
      el.title = item.constraint.expr
        ? `${item.constraint.type} = ${item.constraint.expr}`
        : item.constraint.type;
      if (item.kind === 'dim') {
        el.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          const c = item.constraint;
          // Offer the text it was written as, and replace it. Setting only the
          // value would leave the old expression to overwrite the edit on the
          // next solve.
          this.requestDimension(c.type, c.expr ?? c.value, (value, expr) => {
            c.value = value;
            if (expr) c.expr = expr;
            else delete c.expr;
          });
        });
      }
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.removeConstraint(item.id);
      });
      this.overlayEl.appendChild(el);
      this.labels.push(el);
      el._sk = item;
    }

    this.updateOverlay();
  }

  /**
   * How a dimension reads on screen. A driven reference is in brackets, the way
   * every CAD package writes one, and anything whose value comes from an
   * expression is marked `fx` so a parameter link is visible without opening it.
   */
  _dimText(c, measured, prefix = '') {
    const fmt = this.displayLength || formatLength;
    const body = c.driven ? `(${prefix}${fmt(measured)})` : `${prefix}${fmt(c.value)}`;
    return c.expr ? `fx ${body}` : body;
  }

  _constraintAnchor(c) {
    const P = this.sketch.points;
    if (c.point !== undefined && P[c.point]) return P[c.point];
    if (c.points && P[c.points[0]]) {
      const a = P[c.points[0]];
      const b = P[c.points[1]];
      if (b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return a;
    }
    const id = c.entity ?? c.entities?.[0];
    const ent = this.entity(id);
    if (!ent) return null;
    if (ent.type === 'line') {
      const a = P[ent.p[0]];
      const b = P[ent.p[1]];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    return P[ent.c];
  }

  updateOverlay() {
    if (!this.active) return;
    if (this.entry) this.updateEntry(this.cursor);
    if (this.band) this.showBand();
    if (!this.labels.length) return;
    for (const el of this.labels) {
      const item = el._sk;
      const s = this.planeToScreen(item.x, item.y);
      if (s.behind) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.left = `${s.x}px`;
      el.style.top = `${s.y}px`;
    }
  }

  _makePointTexture() {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(3, 3, 10, 10);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

const CONSTRAINT_GLYPHS = {
  horizontal: '—',
  vertical: '|',
  parallel: '∥',
  collinear: '≡',
  perpendicular: '⊥',
  tangent: 'T',
  equal: '=',
  concentric: '◎',
  coincident: '●',
  midpoint: '△',
  symmetric: '↔',
  fixed: '✕',
  pointOnLine: '•',
  pointOnCircle: '•'
};

function closestOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

function distToSegment(p, a, b) {
  const q = closestOnSegment(p, a, b);
  return Math.hypot(p.x - q.x, p.y - q.y);
}

function norm2(v) {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

function circleThrough(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const ua = a.x * a.x + a.y * a.y;
  const ub = b.x * b.x + b.y * b.y;
  const uc = c.x * c.x + c.y * c.y;
  return {
    x: (ua * (b.y - c.y) + ub * (c.y - a.y) + uc * (a.y - b.y)) / d,
    y: (ua * (c.x - b.x) + ub * (a.x - c.x) + uc * (b.x - a.x)) / d
  };
}

/** True when going counter-clockwise from a0 to a1 passes through am. */
function angleBetween(a0, am, a1) {
  const norm = (x) => {
    let v = x % TAU;
    if (v < 0) v += TAU;
    return v;
  };
  const m = norm(am - a0);
  const e = norm(a1 - a0);
  return m <= e;
}

function segIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-15) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
  if (t < 1e-9 || t > 1 - 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: p1.x + d1x * t, y: p1.y + d1y * t };
}

/**
 * Where a ray leaving `o` along `(ux, uy)` first crosses a segment. Returns the
 * distance along the ray as well as the point, so the nearest crossing wins.
 */
/** The circle through three points, as a centre with the first and last on it. */
function arcThrough(a, b, via) {
  const d = 2 * (a.x * (b.y - via.y) + b.x * (via.y - a.y) + via.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const sa = a.x * a.x + a.y * a.y;
  const sb = b.x * b.x + b.y * b.y;
  const sv = via.x * via.x + via.y * via.y;
  const cx = (sa * (b.y - via.y) + sb * (via.y - a.y) + sv * (a.y - b.y)) / d;
  const cy = (sa * (via.x - b.x) + sb * (a.x - via.x) + sv * (b.x - a.x)) / d;
  return { c: { x: cx, y: cy }, a, b };
}

function rayHitSegment(o, ux, uy, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const den = ux * dy - uy * dx;
  if (Math.abs(den) < 1e-15) return null;
  const t = ((a.x - o.x) * dy - (a.y - o.y) * dx) / den;
  const u = ((a.x - o.x) * uy - (a.y - o.y) * ux) / den;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, p: { x: o.x + ux * t, y: o.y + uy * t } };
}

export function formatLength(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '?';
  const r = Math.round(n * 1000) / 1000;
  return `${r}`;
}

export { COLORS, CONSTRAINT_GLYPHS };
