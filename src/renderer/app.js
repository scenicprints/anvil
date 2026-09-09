/**
 * Anvil - application shell.
 *
 * Holds the document, drives rebuilds, and wires the UI. Feature dialogs work
 * the way modelling dialogs should: the feature is appended to the timeline
 * immediately and every keystroke rebuilds, so what is on screen during editing
 * is the real result rather than a preview that might differ.
 */

import * as THREE from './three.js';
import { initKernel } from './kernel.js';
import * as K from './kernel.js';
import { Viewport, ISO_VIEW } from './viewport.js';
import { SketchEditor } from './sketchview.js';
import {
  toBinarySTL,
  toOBJ,
  to3MF,
  parseSTL,
  parseOBJ,
  parse3MF,
  meshReaderFor
} from './meshutil.js';
import {
  newDocument,
  newSketch,
  rebuild,
  resolvePlane,
  featureLabel,
  sketchToWorld,
  bakeBodies,
  sectionedMesh,
  meshOf,
  isSheet,
  normalizeSheetRules,
  topologyOptions,
  RebuildCache,
  uid
} from './features.js';
import { recognise } from './recognise.js';
import * as PRESET from './presets.js';
import * as SEL from './select.js';
import { readSTEP } from './stepread.js';
import { projectRunOnto, isoCurves } from './sheet.js';
import * as SM from './sheetmetal.js';
import * as FM from './form.js';
import { decalMesh } from './decal.js';
import * as CF from './configure.js';
import * as AN from './animation.js';
import * as FE from './fea.js';
import * as GD from './generative.js';
import { meshHealth, sectionCurves } from './meshtools.js';
import {
  newComponent,
  JOINT_TYPES,
  DOF_LABELS,
  jointDof,
  captureJointOrigin,
  limitByContact
} from './assembly.js';
import { CONSTRUCTION_LABELS } from './construction.js';
import {
  resolveParameters,
  evaluate,
  safeEval,
  parametersToCsv,
  parametersFromCsv
} from './expr.js';
import { entityRuns, interiorPoint, pointInPolygon, tessellate, chainPath } from './profile.js';
import { buildTopology, basisFor } from './topology.js';
import {
  edgeReference,
  faceReference,
  resolveFaceRefs,
  resolveEdgeRefs
} from './edgefeature.js';
import { TEXT_FONTS } from './textoutline.js';
import { parseSVG, parseDXF } from './vectorimport.js';
import {
  MATERIALS,
  materialLabel,
  combinedMass,
  interferences,
  draftColours,
  intersectionRuns,
  curvatureColours,
  minimumRadiusColours,
  zebraColours,
  accessibilityColours,
  curvatureComb,
  designAdvice,
  meshSize,
  spunProfile
} from './analysis.js';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  doc: newDocument(),
  result: null,
  vp: null,
  sketcher: null,
  activeSketchFeature: null,
  selection: {
    bodies: new Set(),
    features: new Set(),
    // "bodyId:faceId" and "bodyId:edgeId", so a reference stays meaningful
    // when several bodies are on screen.
    faces: new Set(),
    edges: new Set(),
    profiles: []
  },
  picking: null, // an active "now click the thing" prompt from a dialog
  hiddenBodies: new Set(),
  dirty: false,
  editing: null, // { feature, isNew, restore }
  docPath: null,
  showEdges: true,
  activeComponent: null,
  undo: [],
  redo: [],
  records: [],
  hoverFace: null,
  hoverEdge: null,
  hoverProfile: null,
  lastPointer: null,
  hiddenSketches: new Set(),
  // Inspection is a way of looking at the model, never a change to it, so it
  // lives beside the view settings rather than on the timeline.
  section: null,
  draft: null,
  faceAnalysis: null,
  comb: null,
  massMarker: null
};

const $ = (sel) => document.querySelector(sel);
const el = {
  status: null,
  solveState: null,
  tree: null,
  timeline: null,
  inspector: null,
  inspectorBody: null,
  inspectorTitle: null,
  viewhint: null,
  docname: null
};

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  el.status = $('#status');
  el.solveState = $('#solveState');
  el.tree = $('#tree');
  el.timeline = $('#timeline');
  el.inspector = $('#inspector');
  el.inspectorBody = $('#inspectorBody');
  el.inspectorTitle = $('#inspectorTitle');
  el.viewhint = $('#viewhint');
  el.docname = $('#docname');

  $('#bootMsg').textContent = 'Starting the modelling kernel';
  try {
    await initKernel();
  } catch (err) {
    $('#bootMsg').textContent = `Kernel failed to start: ${err.message}`;
    $('#bootMsg').style.color = '#e06c5f';
    return;
  }

  state.vp = new Viewport($('#view'), $('#overlay'));
  state.sketcher = new SketchEditor(state.vp, $('#overlay'));

  state.vp.onRendered = () => {
    if (state.sketcher.active) state.sketcher.updateOverlay();
    placeNotes();
  };
  state.vp.onPointerDown = (e) => handleViewportDown(e);
  state.vp.onPointerMove = (e) => {
    if (state.editForm?.drag && editFormPointerMove(e)) return true;
    if (state.pullDrag && pullPointerMove(e)) return true;
    if (state.band && bandPointerMove(e)) return true;
    return handleViewportMove(e);
  };
  state.vp.onPointerUp = (e) => {
    if (state.editForm?.drag && editFormPointerUp(e)) return true;
    if (state.pullDrag && pullPointerUp(e)) return true;
    if (state.band && bandPointerUp(e)) return true;
    return state.sketcher.onPointerUp(e);
  };
  state.vp.onContextMenu = (e) => showMarkingMenu(e);

  // Its own listener rather than a line in handleViewportMove, because that
  // returns early while a sketch is open and the callout has to keep up
  // regardless of who is handling the click.
  // Slice cuts through the bodies at the plane being drawn on, so a sketch
  // inside a closed part is not drawn against a wall you cannot see past.
  $('#chkSlice')?.addEventListener('change', (e) => {
    state.sliceSketch = e.target.checked;
    refreshSlice();
  });

  // Construction lines and projected geometry are scaffolding: wanted while you
  // are placing things against them, in the way once you are not.
  for (const [id, key] of [
    ['chkShowConstruction', 'showConstruction'],
    ['chkShowProjected', 'showProjected']
  ]) {
    $(`#${id}`)?.addEventListener('change', (e) => {
      state.sketcher[key] = e.target.checked;
      state.sketcher.rebuild();
    });
  }

  $('#viewwrap').addEventListener('pointermove', (e) => {
    state.lastPointer = { x: e.clientX, y: e.clientY };
    placeCallout();
  });

  state.sketcher.onChange = () => {
    state.dirty = true;
    rebuildAll();
  };
  state.sketcher.onBeforeChange = () => pushUndo('sketch edit');
  state.sketcher.onStatus = (m) => setStatus(m);
  state.sketcher.onDimensionRequest = (kind, current, cb) => {
    // The text goes back untouched. The sketcher works it out, so a dimension
    // takes an expression or a unit exactly like every other field does.
    const shown = typeof current === 'number' ? String(round(current)) : String(current);
    promptValue(`Enter ${kind}`, shown, (text) => cb(text));
  };
  // Dimension labels are written by the sketcher but the unit is the
  // document's, so the formatter is handed in rather than hardcoded.
  state.sketcher.onTextRequest = (current, cb) => askForText(current, cb);
  state.sketcher.displayLength = fmtLengthBare;
  state.sketcher.onRegionsChanged = () => updateHints();
  state.sketcher.onSelectionChanged = () => updateHints();

  wireUI();
  buildToolbars();
  wireKeys();

  rebuildAll();
  state.vp.fit();
  setDocUnits(state.doc.units || 'mm');
  $('#gridStep').value = fmtLengthBare(state.sketcher.gridStep);
  setStatus('Ready. Press S to start a sketch.');
  updateHints();

  $('#boot').classList.add('gone');
  setTimeout(() => $('#boot').remove(), 400);
}

/* ------------------------------------------------------------------ */
/* Rebuild                                                             */
/* ------------------------------------------------------------------ */

/**
 * What the last rebuild left behind, one cache for the session.
 *
 * Not one per document: what the cache knows is keyed on what the features
 * say, not on which object holds them, so opening another document simply
 * fails to match and frees what it was holding. That is also what makes undo
 * quick, because undo hands back a document parsed afresh and an identity
 * check would throw the whole cache away every time.
 */
function rebuildCache() {
  if (!state.cache) state.cache = new RebuildCache();
  return state.cache;
}

function rebuildAll() {
  const t0 = performance.now();
  const previous = state.result;

  // A form's size fields build its cage, but only while the dialog that made
  // it is open. After that the cage has been shaped by hand, and rebuilding it
  // from a width and a height would throw that away.
  if (state.editing?.feature?.type === 'form') refreshFormCage(state.editing.feature);

  let res;
  try {
    // The cache carries what the last rebuild built, so an edit to the end of
    // a long timeline does not replay the whole of it. A rebuild that throws
    // leaves it holding a prefix that is still true, so it is kept.
    res = rebuild(state.doc, { cache: rebuildCache() });
  } catch (err) {
    setSolveState('err', `Rebuild failed: ${err.message}`);
    return;
  }

  const records = [];
  for (const b of res.bodies) {
    try {
      // A sheet is already a mesh. A solid has to be asked for one.
      const mesh = meshOf(b);
      // Faces and edges are recovered fresh every rebuild. They are what the
      // pointer selects and what fillet and sketch-on-face refer to.
      let topology = null;
      try {
        // A mesh body can say at what angle two triangles stop being the same
        // surface. Without that a scan is a million faces of one triangle each
        // and nothing on it can be pointed at.
        topology = buildTopology(mesh, topologyOptions(b));
      } catch (err) {
        res.errors.push({ feature: b.createdBy, message: `Topology: ${err.message}` });
      }
      records.push({
        id: b.id,
        name: b.name,
        mesh,
        topology,
        // A surface body has no inside, so mass, section and interference all
        // have to leave it alone, and it is drawn from both sides.
        sheet: isSheet(b),
        // Not `mesh`: that name already holds this record's triangles, and
        // setting it to a flag replaces the geometry with a boolean.
        isMesh: !!b.mesh,
        isForm: !!b.form,
        // The smooth surface drawn behind the cage in Control Frame, so what is
        // being shaped and what it stands for are both on screen at once.
        overlayMesh: b.overlayMesh || null,
        // A colour set by hand, which is about how it looks and not about what
        // it is made of, so it lives on the document rather than the timeline.
        appearance: state.doc.appearance?.byBody?.[b.id] || null,
        visible: !state.hiddenBodies.has(b.id)
      });
    } catch (err) {
      res.errors.push({ feature: b.createdBy, message: err.message });
    }
  }
  state.records = records;
  applyAnalyses(records, res);

  state.result = res;
  res.disposeIntermediates();
  if (previous) previous.dispose();

  state.vp.setBodies(records);
  applyAnimationOffsets();
  state.vp.setCanvases(placedCanvases());
  state.vp.setDecals(placedDecals(records));
  state.vp.setSelection(state.selection.bodies);
  pruneSelection();
  refreshHighlight();
  renderSketchDisplay();

  if (state.sketcher.active && state.sketcher.sketch) {
    // What the model contributes to this sketch is worked out by the rebuild,
    // so it can only be handed over afterwards.
    state.sketcher.derived = res.sketchProjections?.[state.sketcher.sketch.id] || null;
    state.sketcher.refreshRegions();
    state.sketcher.rebuild();
  }

  renderTree();
  renderTimeline();
  renderAnalysisOverlay();
  syncDialogError();
  // The face the handle stands on has just been rebuilt, so the handle has to
  // move with it. Not during a drag: the frame it is being dragged along has
  // to hold still, or the thing being pulled runs away from the pointer.
  if (!state.pullDrag) refreshPullHandle();

  const ms = Math.round(performance.now() - t0);
  const errCount = visibleErrors().length + Object.keys(res.paramErrors).length;
  if (errCount) {
    setSolveState('err', `${errCount} problem${errCount > 1 ? 's' : ''}`);
  } else {
    const tris = records.reduce((s, r) => s + r.mesh.triVerts.length / 3, 0);
    setSolveState(
      'ok',
      `${records.length} bod${records.length === 1 ? 'y' : 'ies'} · ${tris.toLocaleString()} tris · ${ms} ms`
    );
  }
}

function setStatus(msg) {
  if (el.status) el.status.textContent = msg || '';
}

function setSolveState(kind, msg) {
  if (!el.solveState) return;
  el.solveState.className = kind;
  el.solveState.textContent = msg;
}

/* ------------------------------------------------------------------ */
/* Display units                                                       */
/* ------------------------------------------------------------------ */

/**
 * The document is measured in millimetres and always will be: that is what the
 * kernel works in and what a slicer expects out of an STL. What changes here is
 * only how a length is written down and read back.
 */
const DISPLAY_UNITS = {
  mm: { per: 1, label: 'mm', areaLabel: 'mm\u00b2', volLabel: 'cm\u00b3', volPer: 1000, dp: 3 },
  cm: { per: 10, label: 'cm', areaLabel: 'cm\u00b2', volLabel: 'cm\u00b3', volPer: 1000, dp: 4 },
  m: { per: 1000, label: 'm', areaLabel: 'm\u00b2', volLabel: 'm\u00b3', volPer: 1e9, dp: 5 },
  in: { per: 25.4, label: 'in', areaLabel: 'in\u00b2', volLabel: 'in\u00b3', volPer: 16387.064, dp: 4 },
  ft: { per: 304.8, label: 'ft', areaLabel: 'ft\u00b2', volLabel: 'ft\u00b3', volPer: 28316846.6, dp: 5 }
};

function displayUnit() {
  return DISPLAY_UNITS[state.doc?.units] || DISPLAY_UNITS.mm;
}

function unitLabel() {
  return displayUnit().label;
}

/** Millimetres in, a written length out, in whatever the document shows. */
function fmtLength(mm) {
  const u = displayUnit();
  const n = Number(mm);
  if (!Number.isFinite(n)) return '?';
  return `${round(n / u.per, u.dp)} ${u.label}`;
}

/** The same, without the unit, for a label that already says what it is. */
function fmtLengthBare(mm) {
  const u = displayUnit();
  const n = Number(mm);
  if (!Number.isFinite(n)) return '?';
  return String(round(n / u.per, u.dp));
}

function fmtArea(mm2) {
  const u = displayUnit();
  return `${round(Number(mm2) / (u.per * u.per), 3)} ${u.areaLabel}`;
}

function fmtVolume(mm3) {
  const u = displayUnit();
  return `${round(Number(mm3) / u.volPer, 3)} ${u.volLabel}`;
}

/**
 * A number typed with no unit means the document's unit, so an inch document
 * reads `2` as two inches. Anything with a unit on it is already absolute.
 */
function displayToMm(text, scope) {
  const t = String(text ?? '').trim();
  if (!t) return 0;
  const value = safeEval(t, scope, NaN);
  if (!Number.isFinite(value)) return NaN;
  return /[a-z"'\u2032\u2033]/i.test(t) ? value : value * displayUnit().per;
}

function setDocUnits(name) {
  if (!DISPLAY_UNITS[name]) return;
  // Only a real change counts as an edit. Boot calls this to put the unit on
  // screen, and marking the document dirty for that made every fresh launch
  // look like it had unsaved work.
  const changed = state.doc.units !== name;
  state.doc.units = name;
  if (changed) state.dirty = true;
  const box = $('#units');
  if (box) box.textContent = unitLabel();
  const sel = $('#docUnits');
  if (sel && sel.value !== name) sel.value = name;
  state.sketcher.displayLength = fmtLengthBare;
  // Dimension labels are drawn by the sketcher, and renderSketchDisplay leaves
  // an open sketch alone, so it has to be asked directly.
  if (state.sketcher.active) state.sketcher.rebuild();
  renderSketchDisplay();
  const step = $('#gridStep');
  if (step) step.value = fmtLengthBare(state.sketcher.gridStep);
  updateHints();
  setStatus(`Showing lengths in ${unitLabel()}.`);
}

function round(v, n = 4) {
  const f = Math.pow(10, n);
  return Math.round(v * f) / f;
}

/* ------------------------------------------------------------------ */
/* Viewport interaction                                                */
/* ------------------------------------------------------------------ */

/**
 * What a click is allowed to select right now. Feature dialogs narrow this so
 * that, for instance, a fillet only ever picks up edges.
 */
/**
 * What a click is allowed to land on.
 *
 * A dialog waiting to be pointed at sets this for itself and is always obeyed.
 * Otherwise it is whatever priority is in force, which is a setting rather than
 * a mode: on a part where the faces are small and the edges are everywhere,
 * being able to say "edges only" for a while is the difference between picking
 * what you meant and picking eleven times.
 */
function activeFilter() {
  if (state.picking?.filter) return state.picking.filter;
  const p = state.selectPriority || 'auto';
  if (p === 'auto') return { faces: true, edges: true, bodies: true, profiles: true };
  return {
    faces: p === 'face',
    edges: p === 'edge',
    bodies: p === 'body' || p === 'component',
    profiles: false,
    wholeBody: p === 'component'
  };
}

function handleViewportDown(e) {
  // The view cube is the viewport's own business now, so that dragging it to
  // orbit works while a sketch has hold of every other click.
  if (state.sketcher.active) {
    return state.sketcher.onPointerDown(e);
  }

  if (e.button !== 0) return false;

  // Shaping a form takes the click before anything else does, so a drag on the
  // manipulator is not read as the start of an orbit.
  if (state.editForm && editFormPointerDown(e)) return true;

  // The pull arrow standing on the selection, for the same reason.
  if (state.pullHandle && pullPointerDown(e)) return true;

  // A dialog that is waiting to be pointed at gets the click first.
  if (state.editing?.pickInto) {
    const armed = state.editing.pickInto;
    const wantsPlane = armed === 'startObject' || armed === 'toObject';
    if (wantsPlane) {
      const pl = state.vp.pickPlane(e.clientX, e.clientY);
      if (pl) return pickIntoEdit({ kind: 'plane', planeName: pl.planeName });
    }
    if (['neutral', 'splitFace', 'mirrorPlane'].includes(armed)) {
      const pl = state.vp.pickPlane(e.clientX, e.clientY);
      if (pl) return pickIntoEdit({ kind: 'plane', planeName: pl.planeName });
    }
    if (armed === 'sections') {
      // A point first: it is small, and a profile usually sits behind it.
      const pt = pickSketchPoint(e.clientX, e.clientY);
      if (pt) return pickIntoEdit({ kind: 'sketchPoint', ...pt });
    }
    if (armed === 'axis' || armed === 'path' || armed === 'rail' || armed === 'rails') {
      // A sketch curve first, because that is what these ask for and it is
      // drawn over whatever is behind it.
      const line = pickSketchLine(e.clientX, e.clientY);
      if (line) {
        if (armed === 'axis' && line.type !== 'line') {
          setStatus('An axis has to be a straight line.');
          return true;
        }
        return pickIntoEdit({ kind: 'sketchLine', ...line });
      }
    }
    // A corner is on the silhouette, so aiming at one means aiming at the very
    // edge of the body and usually a few pixels outside it. Asking the snap
    // before the raycast is what lets a corner be clicked at all: without it
    // the ray misses the solid and the click does nothing.
    if (movePointArmed() && snapModelPoint(e.clientX, e.clientY)) {
      return pickIntoEdit({ kind: 'point' });
    }

    // Both the profile row and a loft's section list are filled from profiles.
    const wantsProfile = armed === 'profiles' || armed === 'sections';
    const profile = wantsProfile ? pickProfile(e.clientX, e.clientY) : null;
    if (profile) return pickIntoEdit({ kind: 'profile', ...profile });
    const wantsEdges =
      [
        'axis',
        'path',
        'rail',
        'constructPath',
        'constructEdgeA',
        'constructEdgeB',
        'plasticFace',
        'jointAxis2',
        'surfaceCurves',
        'sheetEdges',
        'moveDirection'
      ].includes(armed) || !!blendPickRow(armed);
    // A plane click has to be offered before the body raycast, or a plane
    // drawn behind the model can never be reached.
    if (['alignFrom', 'alignTo', 'silhouetteDir'].includes(armed)) {
      const plane = state.vp.pickPlane(e.clientX, e.clientY);
      if (plane) return pickIntoEdit({ kind: 'plane', planeName: plane.planeName });
    }
    const hit = state.vp.pickEntity(e.clientX, e.clientY, { edges: wantsEdges });
    if (hit) return pickIntoEdit(hit);
    // The other way round for a direction: the origin planes are sixty across
    // and hang through the middle of everything, so offering them first meant
    // aiming at the top of a box and being handed the XZ plane it happens to
    // sit on. An edge or a face is what is being aimed at; a plane is what is
    // left when the click hit nothing.
    if (armed === 'moveDirection') {
      const plane = state.vp.pickPlane(e.clientX, e.clientY);
      if (plane) return pickIntoEdit({ kind: 'plane', planeName: plane.planeName });
    }
    return true;
  }


  const plane = state.vp.pickPlane(e.clientX, e.clientY);
  if (plane && state.picking?.filter?.planes) {
    acceptPick({ kind: 'plane', planeName: plane.planeName }, e);
    return true;
  }

  const filter = activeFilter();

  // A sketch profile sitting in front of the model takes precedence, which is
  // what makes picking the region you just drew work without hiding the body.
  if (filter.profiles) {
    const profile = pickProfile(e.clientX, e.clientY);
    if (profile) {
      acceptPick({ kind: 'profile', ...profile }, e);
      return true;
    }
  }

  const hit = state.vp.pickEntity(e.clientX, e.clientY, { edges: filter.edges !== false });
  if (!hit) {
    // Nothing under the pointer, so a drag from here is a selection box rather
    // than a miss. Dragged rightwards it takes what is wholly inside; dragged
    // leftwards it takes anything it touches, which is the convention every
    // CAD package shares and the one people already have in their hands.
    if (!state.picking) {
      if (!e.shiftKey) clearGeometrySelection();
      startBand(e);
      return true;
    }
    if (!e.shiftKey) clearGeometrySelection();
    return false;
  }

  if (hit.kind === 'edge' && !filter.edges) return false;
  if (hit.kind === 'face' && !filter.faces && !filter.bodies) return false;

  acceptPick(hit, e);
  return true;
}

/** Fold a pick into the selection, or hand it to whatever dialog asked for it. */
function acceptPick(hit, e) {
  const additive = e.shiftKey || e.ctrlKey;

  if (state.picking) {
    state.picking.onPick(hit, additive);
    refreshHighlight();
    updateHints();
    return;
  }

  if (!additive) clearGeometrySelection(false);

  if (hit.kind === 'profile') {
    // A closed sketch region, which is what Extrude and Revolve want. Without
    // this it fell through and clicking a finished sketch selected nothing.
    const same = (p) => p.sketch === hit.sketch && p.regionId === hit.regionId;
    const at = state.selection.profiles.findIndex(same);
    if (at >= 0) state.selection.profiles.splice(at, 1);
    else state.selection.profiles.push({ sketch: hit.sketch, regionId: hit.regionId, seed: hit.seed });
    renderSketchDisplay();
  } else if (hit.kind === 'edge') {
    toggle(state.selection.edges, `${hit.bodyId}:${hit.edgeId}`, additive);
  } else if (hit.kind === 'face' && hit.faceId !== null) {
    toggle(state.selection.faces, `${hit.bodyId}:${hit.faceId}`, additive);
  } else if (hit.bodyId) {
    toggle(state.selection.bodies, hit.bodyId, additive);
  }

  state.vp.setSelection(state.selection.bodies);
  refreshHighlight();
  renderTree();
  refreshPullHandle();
  updateHints();
}

function toggle(set, key, additive) {
  if (additive && set.has(key)) set.delete(key);
  else set.add(key);
}

function clearGeometrySelection(redraw = true) {
  state.selection.bodies.clear();
  state.selection.faces.clear();
  state.selection.edges.clear();
  state.selection.profiles = [];
  if (redraw) {
    state.vp.setSelection(state.selection.bodies);
    refreshHighlight();
    renderTree();
    refreshPullHandle();
    updateHints();
  }
}

/** Drop references to geometry that the last rebuild removed. */
function pruneSelection() {
  const alive = new Map((state.records || []).map((r) => [r.id, r]));
  for (const set of [state.selection.faces, state.selection.edges]) {
    for (const key of [...set]) {
      const idx = key.lastIndexOf(':');
      const bodyId = key.slice(0, idx);
      const n = Number(key.slice(idx + 1));
      const rec = alive.get(bodyId);
      const list = set === state.selection.faces ? rec?.topology?.faces : rec?.topology?.edges;
      if (!list || !list[n]) set.delete(key);
    }
  }
  for (const id of [...state.selection.bodies]) {
    if (!alive.has(id)) state.selection.bodies.delete(id);
  }
}

function splitKey(key) {
  const idx = key.lastIndexOf(':');
  return { bodyId: key.slice(0, idx), index: Number(key.slice(idx + 1)) };
}

function refreshHighlight() {
  if (!state.vp) return;
  state.vp.setHighlight({
    faces: [...state.selection.faces].map((k) => {
      const { bodyId, index } = splitKey(k);
      return { bodyId, faceId: index };
    }),
    edges: [...state.selection.edges].map((k) => {
      const { bodyId, index } = splitKey(k);
      return { bodyId, edgeId: index };
    }),
    hoverFace: state.hoverFace,
    hoverEdge: state.hoverEdge
  });
}

/**
 * Everywhere in the model worth snapping a picked point to.
 *
 * Point to point used to take the middle of whatever face was clicked, or the
 * bare spot the ray happened to land on. Neither is a place anybody means. What
 * is meant is a corner, the middle of an edge, or the centre of a hole, and
 * with nothing on screen saying which of those had been taken the pick could
 * not be checked either.
 *
 * Worked out once per rebuild, because it walks every edge of every body.
 */
function modelSnapPoints() {
  if (state.snapPointsFor === state.result && state.snapPoints) return state.snapPoints;
  const out = [];
  for (const rec of state.records || []) {
    const topo = rec.topology;
    if (!topo) continue;
    for (const e of topo.edges) {
      if (e.kind === 'line' && e.start && e.end) {
        out.push({ at: e.start, label: 'Corner' });
        out.push({ at: e.end, label: 'Corner' });
        out.push({
          at: [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2, (e.start[2] + e.end[2]) / 2],
          label: 'Middle of the edge'
        });
      } else if (e.centre) {
        out.push({ at: e.centre, label: 'Centre' });
      }
    }
    for (const f of topo.faces) {
      if (f.centre) out.push({ at: f.centre, label: 'Middle of the face' });
    }
  }
  state.snapPoints = out;
  state.snapPointsFor = state.result;
  return out;
}

// Nearer wins, but a corner is worth a few pixels over a face middle sitting
// the same distance away: it is the more definite thing to have meant.
const SNAP_RANK = {
  Corner: 0,
  'Middle of the edge': 5,
  Centre: 5,
  'Middle of the face': 12
};

/** The place in the model nearest the pointer, or nothing within reach. */
function snapModelPoint(clientX, clientY) {
  let best = null;
  for (const c of modelSnapPoints()) {
    const s = state.vp.worldToScreen(c.at[0], c.at[1], c.at[2]);
    if (!s || s.behind) continue;
    const d = Math.hypot(s.clientX - clientX, s.clientY - clientY);
    if (d > 16) continue;
    const score = d + (SNAP_RANK[c.label] ?? 20);
    if (!best || score < best.score) best = { at: c.at, label: c.label, score };
  }
  return best;
}

/**
 * True while a click would fill in a place in the model: either end of a point
 * to point move, or the pivot a rotate turns about. All three want the same
 * corners and hole centres, so all three snap the same way.
 */
function movePointArmed() {
  const armed = state.editing?.pickInto;
  return armed === 'movePointFrom' || armed === 'movePointTo' || armed === 'movePivot';
}

/** Say what a click would take, beside the cursor, before it is made. */
function updateMoveSnapHint(e) {
  const hint = $('#snaphint');
  if (!hint) return;
  if (!movePointArmed()) {
    if (hint.dataset.owner === 'move') {
      hint.style.display = 'none';
      hint.dataset.owner = '';
    }
    return;
  }
  const snap = snapModelPoint(e.clientX, e.clientY);
  const rect = state.vp.canvas.getBoundingClientRect();
  hint.dataset.owner = 'move';
  hint.style.display = 'block';
  hint.textContent = snap ? snap.label : 'On the face';
  hint.style.left = `${e.clientX - rect.left + 14}px`;
  hint.style.top = `${e.clientY - rect.top + 14}px`;
}

function handleViewportMove(e) {
  if (state.sketcher.active) {
    state.sketcher.onPointerMove(e);
    updateSnapHint(e);
    return;
  }

  updateMoveSnapHint(e);

  // While a dialog is waiting on a profile, the region under the cursor lights
  // up so it is obvious what a click is about to take. Without it there is no
  // signal at all until after the click, and none then either.
  const wantsProfile = profilePickArmed() || activeFilter().profiles;
  const overProfile = wantsProfile ? pickProfile(e.clientX, e.clientY) : null;
  const nextProfile = overProfile
    ? { sketch: overProfile.sketch, regionId: overProfile.regionId }
    : null;
  const sameProfile =
    (!nextProfile && !state.hoverProfile) ||
    (nextProfile &&
      state.hoverProfile &&
      nextProfile.sketch === state.hoverProfile.sketch &&
      nextProfile.regionId === state.hoverProfile.regionId);
  if (!sameProfile) {
    state.hoverProfile = nextProfile;
    renderSketchDisplay();
  }
  if (overProfile) {
    state.vp.setHover(null);
    return;
  }

  const filter = activeFilter();
  if (filter.planes) {
    const over = state.vp.pickPlane(e.clientX, e.clientY);
    state.vp.setPlaneHover(over ? over.planeName : null);
    if (over) {
      state.hoverFace = null;
      state.hoverEdge = null;
      refreshHighlight();
      state.vp.setHover(null);
      return;
    }
  }
  const hit = state.vp.pickEntity(e.clientX, e.clientY, { edges: filter.edges !== false });
  const nextFace =
    hit && hit.kind === 'face' && hit.faceId !== null && filter.faces
      ? { bodyId: hit.bodyId, faceId: hit.faceId }
      : null;
  const nextEdge =
    hit && hit.kind === 'edge' && filter.edges
      ? { bodyId: hit.bodyId, edgeId: hit.edgeId }
      : null;

  const same = (a, b) =>
    (!a && !b) ||
    (a && b && a.bodyId === b.bodyId && (a.faceId ?? a.edgeId) === (b.faceId ?? b.edgeId));

  if (!same(nextFace, state.hoverFace) || !same(nextEdge, state.hoverEdge)) {
    state.hoverFace = nextFace;
    state.hoverEdge = nextEdge;
    refreshHighlight();
  }
  state.vp.setHover(hit && !nextFace && !nextEdge ? hit.bodyId : null);
}

/* ------------------------------------------------------------------ */
/* Undo                                                                */
/* ------------------------------------------------------------------ */

/**
 * Undo works on whole-document snapshots. The document is small, plain data,
 * and rebuilt from scratch anyway, so this is both simpler and more reliable
 * than trying to invert individual operations, and it can never leave the
 * timeline and the geometry disagreeing.
 */
const UNDO_LIMIT = 120;

function pushUndo(label) {
  const snapshot = JSON.stringify(state.doc);
  const top = state.undo[state.undo.length - 1];
  if (top && top.snapshot === snapshot) return;
  state.undo.push({ snapshot, label: label || '' });
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  state.redo.length = 0;
}

function applySnapshot(snapshot) {
  const wasSketching = state.sketcher.active ? state.sketcher.sketch.id : null;
  exitSketch();
  state.doc = JSON.parse(snapshot);

  // A sketch is put away because something was built on it. Undo can take that
  // something away again, and then hiding it is a leftover from a state that no
  // longer exists: the sketch goes back to being the thing you draw on, and
  // until this it stayed invisible and its profiles could not be clicked.
  for (const id of [...state.hiddenSketches]) {
    const built = state.doc.features.some((f) => f.type !== 'sketch' && f.sketch === id);
    if (!built) state.hiddenSketches.delete(id);
  }

  clearGeometrySelection(false);
  state.selection.features.clear();
  state.editing = null;
  el.inspector.classList.add('hidden');
  rebuildAll();

  // Stay in the sketch that was being edited, if it still exists.
  if (wasSketching && state.doc.sketches[wasSketching]) {
    const feature = state.doc.features.find(
      (f) => f.type === 'sketch' && f.sketch === wasSketching
    );
    if (feature) enterSketch(feature, { keepView: true });
  }
}

function undo() {
  if (!state.undo.length) {
    setStatus('Nothing to undo.');
    return;
  }
  const entry = state.undo.pop();
  state.redo.push({ snapshot: JSON.stringify(state.doc), label: entry.label });
  applySnapshot(entry.snapshot);
  setStatus(entry.label ? `Undid ${entry.label}` : 'Undo');
}

function redoAction() {
  if (!state.redo.length) {
    setStatus('Nothing to redo.');
    return;
  }
  const entry = state.redo.pop();
  state.undo.push({ snapshot: JSON.stringify(state.doc), label: entry.label });
  applySnapshot(entry.snapshot);
  setStatus(entry.label ? `Redid ${entry.label}` : 'Redo');
}

/* ------------------------------------------------------------------ */
/* Finished sketches shown in the model                                */
/* ------------------------------------------------------------------ */

/**
 * Sketches stay on screen after they are finished, with their closed regions
 * drawn as pickable faces. Choosing what to extrude then happens in the
 * viewport against the real model, rather than having to be decided before
 * leaving the sketch.
 */
function renderSketchDisplay() {
  if (!state.vp) return;
  if (!state.sketchGroup) {
    state.sketchGroup = new THREE.Group();
    state.vp.overlayGroup.add(state.sketchGroup);
  }
  const g = state.sketchGroup;
  while (g.children.length) {
    const c = g.children.pop();
    c.geometry?.dispose?.();
    c.material?.dispose?.();
  }
  state.profileTargets = [];
  state.sketchLineTargets = [];
  state.sketchPointTargets = [];

  if (state.sketcher.active) return;

  const res = state.result;
  if (!res) return;

  for (const feature of state.doc.features) {
    if (feature.type !== 'sketch') continue;
    const sk = state.doc.sketches[feature.sketch];
    if (!sk || state.hiddenSketches?.has(sk.id)) continue;
    const plane = res.sketchPlanes?.[sk.id] || resolvePlane(sk.plane, res.scope);
    const regions = res.sketchRegions?.[sk.id] || [];

    const m = new THREE.Matrix4();
    m.set(
      plane.x[0], plane.y[0], plane.n[0], plane.origin[0],
      plane.x[1], plane.y[1], plane.n[1], plane.origin[1],
      plane.x[2], plane.y[2], plane.n[2], plane.origin[2],
      0, 0, 0, 1
    );

    for (const ent of sk.entities) {
      if (ent.type === 'point') {
        // Drawn and pickable, because a loft can come to a tip at one.
        const q = sk.points[ent.p];
        if (!q) continue;
        const w = sketchToWorld(plane, q.x, q.y, 0);
        const geo = new THREE.BufferGeometry().setFromPoints([w]);
        const dot = new THREE.Points(
          geo,
          new THREE.PointsMaterial({ color: 0x33312b, size: 7, sizeAttenuation: false })
        );
        dot.renderOrder = 4;
        dot.userData.sketchPoint = { sketch: sk.id, point: ent.p };
        g.add(dot);
        state.sketchPointTargets.push(dot);
        continue;
      }
      // Text draws as one loop per letter, so each run gets its own line, and
      // a three dimensional sketch keeps its curves off the plane.
      for (const run of entityRuns(sk, ent)) {
        const pts = run.map((p) => sketchToWorld(plane, p.x, p.y, p.z || 0));
        if (pts.length < 2) continue;
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({
          color: ent.construction ? 0x6f6ba8 : 0x9aa7b4,
          transparent: true,
          opacity: 0.85,
          depthTest: true
        });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 3;
        // Tagged so an axis can be chosen by clicking the line, the way Fusion
        // has you point at it, rather than picking it out of a list by number.
        line.userData.sketchLine = { sketch: sk.id, entity: ent.id, type: ent.type };
        g.add(line);
        state.sketchLineTargets.push(line);
      }
    }

    // Projected edges and sections belong to the sketch as much as its own
    // curves do, and a finished sketch that shows one but not the other is
    // simply missing half of itself.
    const derived = state.result?.sketchProjections?.[sk.id];
    if (derived?.entities?.length) {
      const D = { points: derived.points, entities: derived.entities };
      for (const ent of derived.entities) {
        const run = tessellate(D, ent);
        if (run.length < 2) continue;
        const geo = new THREE.BufferGeometry().setFromPoints(
          run.map((q) => sketchToWorld(plane, q.x, q.y, 0))
        );
        const line = new THREE.Line(
          geo,
          new THREE.LineBasicMaterial({
            color: 0x8a6d3b,
            transparent: true,
            opacity: 0.85,
            depthTest: true
          })
        );
        line.renderOrder = 3;
        g.add(line);
      }
    }

    const chosen = chosenProfiles();
    const hov = state.hoverProfile;
    for (const r of regions) {
      const seed = interiorPoint(r.outer);
      // Matched by containment, the same test the rebuild uses to turn stored
      // seeds back into regions, so what lights up is what will be built.
      const selected =
        chosen.whole === sk.id ||
        chosen.seeds.some((c) => c.sketch === sk.id && regionHoldsSeed(r, c.seed));
      const hovered =
        !selected && !!hov && hov.sketch === sk.id && hov.regionId === r.id;
      const tone = selected ? 'selected' : hovered ? 'hover' : 'idle';
      const shape = new THREE.Shape(r.outer.map((p) => new THREE.Vector2(p.x, p.y)));
      for (const h of r.holes) {
        shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
      }
      const geo = new THREE.ShapeGeometry(shape);
      geo.applyMatrix4(m);
      const mat = new THREE.MeshBasicMaterial({
        color: PROFILE_COLOURS[tone],
        transparent: true,
        opacity: selected ? 0.42 : hovered ? 0.26 : 0.1,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 3;
      mesh.userData.profile = { sketch: sk.id, regionId: r.id, seed };

      // A chosen region gets its boundary drawn too. The fill alone is easy to
      // miss where a region is small or mostly behind the body.
      if (selected || hovered) {
        const ring = new THREE.BufferGeometry().setFromPoints(
          [...r.outer, r.outer[0]].map((q) => sketchToWorld(plane, q.x, q.y, 0))
        );
        const outline = new THREE.Line(
          ring,
          new THREE.LineBasicMaterial({ color: PROFILE_COLOURS[tone], linewidth: 1 })
        );
        outline.renderOrder = 5;
        g.add(outline);
      }
      g.add(mesh);
      state.profileTargets.push(mesh);
    }
  }
  state.vp.invalidate();
}

/** The sketch line under the cursor, for choosing a revolve axis. */
function pickSketchLine(clientX, clientY) {
  if (!state.sketchLineTargets?.length) return null;
  const rc = state.vp.raycastRay(clientX, clientY);
  // A line has no area, so the ray needs a tolerance in world units to catch it.
  rc.params.Line = { threshold: state.vp.pixelWorldSize() * 6 };
  const hits = rc.intersectObjects(state.sketchLineTargets, false);
  if (!hits.length) return null;
  return hits[0].object.userData.sketchLine;
}

/** The sketch point under the cursor, for a loft that comes to a tip. */
function pickSketchPoint(clientX, clientY) {
  if (!state.sketchPointTargets?.length) return null;
  const rc = state.vp.raycastRay(clientX, clientY);
  rc.params.Points = { threshold: state.vp.pixelWorldSize() * 8 };
  const hits = rc.intersectObjects(state.sketchPointTargets, false);
  if (!hits.length) return null;
  return hits[0].object.userData.sketchPoint;
}

/**
 * The colours a sketch region is drawn in. Deeper blue than the pre-reskin
 * 0x3d7fd0, which washed out against the light drafting ground.
 */
const PROFILE_COLOURS = {
  idle: 0x8b93a0,
  hover: 0x5a86c8,
  selected: 0x1f4f9c
};

/**
 * Which profiles count as chosen right now.
 *
 * A dialog that is being pointed at writes into `feature.seeds` (or a loft's
 * `sections`) and never touches `state.selection.profiles`, so colouring only
 * from the latter meant a profile clicked into a dialog looked exactly like one
 * that had been ignored. Whichever list owns the selection at this moment is
 * the one that drives the colour.
 */
function chosenProfiles() {
  const ed = state.editing;
  const armed = ed?.pickInto;
  const f = ed?.feature;

  if (armed === 'profiles' && f) {
    // `seeds === null` means the whole sketch, so every region of it is in.
    if (f.seeds === null || f.seeds === undefined) {
      return { whole: f.sketch || null, seeds: [] };
    }
    return { whole: null, seeds: f.seeds.map((seed) => ({ sketch: f.sketch, seed })) };
  }

  if (armed === 'sections' && f) {
    return {
      whole: null,
      seeds: (f.sections || [])
        .filter((x) => x.sketch && x.seed)
        .map((x) => ({ sketch: x.sketch, seed: x.seed }))
    };
  }

  return {
    whole: null,
    seeds: state.selection.profiles.map((p) => ({ sketch: p.sketch, seed: p.seed }))
  };
}

/** A stored seed lands in this region: inside its outline and in none of its holes. */
function regionHoldsSeed(region, seed) {
  if (!seed || !Number.isFinite(seed.x) || !Number.isFinite(seed.y)) return false;
  if (!pointInPolygon(seed, region.outer)) return false;
  for (const h of region.holes) if (pointInPolygon(seed, h)) return false;
  return true;
}

/** True while a viewport click would go to a dialog's profile or section row. */
function profilePickArmed() {
  const armed = state.editing?.pickInto;
  return armed === 'profiles' || armed === 'sections';
}

/**
 * The one profile on screen, when there is exactly one.
 *
 * `profileTargets` is what is actually drawn and clickable, which is the same
 * "visible in your design" the Extrude reference means: a sketch switched off
 * in the browser is not in it.
 */
function onlyVisibleProfile() {
  const targets = state.profileTargets || [];
  if (targets.length !== 1) return null;
  return targets[0].userData.profile || null;
}

function pickProfile(clientX, clientY) {
  if (!state.profileTargets?.length) return null;
  const rc = state.vp.raycastRay(clientX, clientY);
  const hits = rc.intersectObjects(state.profileTargets, false);
  if (!hits.length) return null;
  return hits[0].object.userData.profile;
}

function updateSnapHint(e) {
  const hint = $('#snaphint');
  const info = state.sketcher.snapInfo;
  if (!info || !info.label) {
    hint.style.display = 'none';
    return;
  }
  const rect = state.vp.canvas.getBoundingClientRect();
  hint.style.display = 'block';
  hint.textContent = info.label;
  hint.style.left = `${e.clientX - rect.left + 14}px`;
  hint.style.top = `${e.clientY - rect.top + 14}px`;
}

/* ------------------------------------------------------------------ */
/* UI wiring                                                           */
/* ------------------------------------------------------------------ */

function wireUI() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  });

  document.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => runCommand(btn.dataset.cmd));
  });

  // Tool options, read straight off the sketcher rather than kept in the
  // document: they say how the next shape is drawn, not what the model is.
  const wireToolOpt = (id, key, parse) => {
    const input = $(`#${id}`);
    if (!input) return;
    const push = () => {
      const v = parse(input.value);
      if (v !== null) state.sketcher[key] = v;
      input.value = String(state.sketcher[key]);
    };
    input.addEventListener('change', push);
    input.addEventListener('blur', push);
    push();
  };
  wireToolOpt('polySides', 'polygonSides', (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 3 && n <= 64 ? n : null;
  });
  wireToolOpt('conicRho', 'conicRho', (v) => {
    const n = Number(v);
    // Outside this the curve degenerates into the chord or the vertex itself.
    return Number.isFinite(n) && n > 0.05 && n < 0.95 ? Math.round(n * 1000) / 1000 : null;
  });

  $('#cmdopen')?.addEventListener('click', () => openCommandSearch());

  document.querySelectorAll('[data-menu]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showRibbonMenu(btn.dataset.menu, btn);
    });
  });

  document.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => reachForTool(btn.dataset.tool));
  });

  document.querySelectorAll('[data-con]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.sketcher.active) return;
      state.sketcher.applyConstraint(btn.dataset.con);
    });
  });

  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dirs = {
        top: [0, 0, 1],
        bottom: [0, 0, -1],
        front: [0, -1, 0],
        back: [0, 1, 0],
        left: [-1, 0, 0],
        right: [1, 0, 0]
      };
      if (btn.dataset.view === 'iso') state.vp.setHomeView();
      else state.vp.setView(dirs[btn.dataset.view]);
    });
  });

  $('#chkGrid').addEventListener('change', (e) => state.vp.setGridVisible(e.target.checked));
  $('#chkOrigin').addEventListener('change', (e) => state.vp.setOriginVisible(e.target.checked));
  $('#chkPlanes').addEventListener('change', (e) => state.vp.setPlanesVisible(e.target.checked));
  $('#chkTransparent').addEventListener('change', (e) =>
    state.vp.setBodyOpacity(e.target.checked ? 0.45 : 1)
  );
  $('#chkEdges').addEventListener('change', (e) => {
    state.showEdges = e.target.checked;
    for (const [, entry] of state.vp.bodies) entry.lines.visible = e.target.checked;
    state.vp.invalidate();
  });

  $('#chkInvertZoom').addEventListener('change', (e) => {
    state.vp.bindings.invertZoom = e.target.checked;
  });
  $('#chkZoomCursor').addEventListener('change', (e) => {
    state.vp.bindings.zoomToCursor = e.target.checked;
  });
  $('#chkSnapGrid').addEventListener('change', (e) => {
    state.sketcher.snapToGrid = e.target.checked;
    setStatus(e.target.checked ? `Snapping to a ${fmtLength(state.sketcher.gridStep)} grid.` : 'Grid snap off.');
  });
  $('#gridStep').addEventListener('change', (e) => {
    const scope = resolveParameters(state.doc.parameters).scope;
    const mm = displayToMm(e.target.value, scope);
    if (!Number.isFinite(mm) || mm <= 0) {
      setStatus('A grid step has to be a positive length.');
      e.target.value = fmtLengthBare(state.sketcher.gridStep);
      return;
    }
    state.sketcher.gridStep = mm;
    setStatus(`Grid step ${fmtLength(mm)}.`);
  });
  $('#docUnits').addEventListener('change', (e) => setDocUnits(e.target.value));

  $('#chkSwapMouse').addEventListener('change', (e) => {
    state.vp.bindings.middle = e.target.checked ? 'orbit' : 'pan';
    state.vp.bindings.shiftMiddle = e.target.checked ? 'pan' : 'orbit';
  });

  $('#pickOk').addEventListener('click', () => {
    if (state.editing?.pickInto) setEditPick(null);
    else endPicking(true);
  });
  $('#pickCancel').addEventListener('click', () => {
    if (state.editing?.pickInto) setEditPick(null);
    else endPicking(false);
  });

  $('#inspectorClose').addEventListener('click', () => cancelEdit());
  $('#inspectorCancel').addEventListener('click', () => cancelEdit());
  $('#inspectorOk').addEventListener('click', () => commitEdit());

  $('#modalCancel').addEventListener('click', () => closeModal(null));
}

function setTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document
    .querySelectorAll('.ribbon-panel')
    .forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
}

/**
 * Take up a sketch tool, starting a sketch if there is not one already.
 *
 * Reaching for the rectangle tool is saying you want to draw a rectangle, and
 * the only honest answer to that is to let you. The tab used to answer "start a
 * sketch first" and then do nothing, which leaves every button on it dead with
 * no way from the tab you are looking at to the state it needs. The tool is
 * remembered across the plane pick and put in your hand when the sketch opens.
 */
function reachForTool(tool) {
  if (state.sketcher.active) {
    state.sketcher.setTool(tool);
    syncToolButtons();
    return;
  }
  state.pendingTool = tool;
  cmdNewSketch();
  // A face was already picked, so the sketch is open and the tool is in hand.
  if (state.sketcher.active) return;
  setStatus(`Select a plane or a planar face to sketch on, then ${TOOL_NAMES[tool] || tool}.`);
}

/** What a tool is called, for the line that asks where to put the sketch. */
const TOOL_NAMES = {
  select: 'select',
  line: 'draw a line',
  rectangle: 'draw a rectangle',
  centerRectangle: 'draw a rectangle',
  rectangle3: 'draw a rectangle',
  circle: 'draw a circle',
  circleDia: 'draw a circle',
  circle3: 'draw a circle',
  circleTan2: 'draw a circle',
  circleTan3: 'draw a circle',
  arc: 'draw an arc',
  arc3: 'draw an arc',
  tangentArc: 'draw an arc',
  polygon: 'draw a polygon',
  polygonCirc: 'draw a polygon',
  polygonEdge: 'draw a polygon',
  slot: 'draw a slot',
  slotOverall: 'draw a slot',
  slotCentre: 'draw a slot',
  slotArc3: 'draw a slot',
  slotArcCentre: 'draw a slot',
  point: 'place a point',
  ellipse: 'draw an ellipse',
  spline: 'draw a spline',
  splineCP: 'draw a spline',
  conic: 'draw a conic',
  blendCurve: 'blend two curve ends',
  blendCurveG1: 'blend two curve ends',
  text: 'place text',
  fillet: 'round a corner',
  chamfer: 'cut a corner',
  trim: 'trim',
  offset: 'offset',
  breakCurve: 'break a curve',
  extend: 'extend',
  mirror: 'mirror'
};

function syncToolButtons() {
  const active = state.sketcher.active ? state.sketcher.tool : null;
  document.querySelectorAll('[data-tool]').forEach((b) => {
    b.classList.toggle('on', active === b.dataset.tool);
  });
  // A family button stands for several tools, so it lights up when any one of
  // them is in hand. Without this the accent is simply lost the moment a tool
  // is reached for through its list or its keyboard shortcut.
  document.querySelectorAll('[data-tools]').forEach((b) => {
    const names = b.dataset.tools.split(',');
    b.classList.toggle('on', !!active && names.includes(active));
  });

  // With the commands folded into flyouts, the tool in your hand would
  // otherwise be invisible: it is lit inside a panel nobody is looking at. The
  // group that holds it says so, and says which one.
  for (const group of document.querySelectorAll('.group')) {
    const lit = group.querySelector('button.on');
    group.classList.toggle('has-on', !!lit);
    const name = group.querySelector('.grp-name');
    if (!name) continue;
    const label = lit?.querySelector('.lbl')?.textContent?.trim();
    name.textContent = label && lit.dataset.tool ? label : group.dataset.name || name.textContent;
  }
}

function wireKeys() {
  window.addEventListener('keydown', (e) => {
    // Search reaches everything and so it answers from everywhere, including
    // from inside a field, which is the one shortcut that has to.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openCommandSearch();
      return;
    }

    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') {
        // The pull box is left focused on purpose, so the exact size can be
        // typed over the one that was dragged to. That makes Escape land in a
        // text box rather than on the model, and merely blurring it leaves the
        // extrude open with its box still floating by the pointer. Escape there
        // means the same as Escape anywhere else: stop this.
        const inPullBox = state.pullValueEl?.contains(document.activeElement);
        document.activeElement.blur();
        if (inPullBox) {
          if (state.editing) cancelEdit();
          else hidePullValue();
          e.preventDefault();
        }
      }
      return;
    }

    // Shaping is a mode, and Escape is how every other mode here is left.
    if (state.editForm && e.key === 'Escape') {
      endEditForm();
      e.preventDefault();
      return;
    }

    if (state.sketcher.active && state.sketcher.onKeyDown(e)) {
      syncToolButtons();
      e.preventDefault();
      return;
    }

    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redoAction();
      else undo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redoAction();
      return;
    }

    if (ctrl && e.key.toLowerCase() === 's') {
      e.preventDefault();
      runCommand(e.shiftKey ? 'saveAs' : 'save');
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      runCommand('open');
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      runCommand('new');
      return;
    }

    if (ctrl) return;

    // Modelling shortcuts follow Fusion's defaults so the muscle memory works.
    const map = {
      s: 'newSketch',
      e: 'extrude',
      r: 'revolve',
      h: 'hole',
      f: 'fillet',
      q: 'pressPull',
      m: 'move',
      c: 'combine',
      p: 'parameters',
      i: 'measure'
    };
    const sketchMap = {
      l: 'line',
      c: 'circle',
      r: 'rectangle',
      a: 'arc',
      d: 'dimension',
      x: 'construction',
      t: 'trim',
      o: 'offset',
      p: 'project'
    };
    const k = e.key.toLowerCase();
    // Measure works inside a sketch too, on whatever is selected there.
    if (state.sketcher.active && k === 'i') {
      runCommand('measure');
      e.preventDefault();
      return;
    }
    if (state.sketcher.active && sketchMap[k]) {
      if (sketchMap[k] === 'construction') state.sketcher.toggleConstruction();
      else if (sketchMap[k] === 'project') runCommand('project');
      else state.sketcher.setTool(sketchMap[k]);
      syncToolButtons();
      e.preventDefault();
      return;
    }
    if (!state.sketcher.active && map[k]) {
      runCommand(map[k]);
      e.preventDefault();
      return;
    }

    if (e.key === 'Enter') {
      if (state.picking) {
        endPicking(true);
        e.preventDefault();
        return;
      }
      if (state.editing) {
        commitEdit();
        e.preventDefault();
        return;
      }
    }

    if (e.key === 'Escape') {
      if (state.picking) {
        endPicking(false);
        setStatus('Cancelled.');
        return;
      }
      if (state.editing?.pickInto) {
        // Let go of the pointer first. Cancelling the whole dialog because you
        // wanted to stop picking is a long way from what Escape should mean.
        setEditPick(null);
        setStatus('Stopped picking. Escape again to cancel.');
        return;
      }
      if (state.editing) {
        cancelEdit();
        return;
      }
      clearGeometrySelection();
      return;
    }
    if (e.key === 'Delete') {
      if (state.selection.bodies.size) runCommand('deleteBody');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function runCommand(cmd) {
  switch (cmd) {
    case 'new':
      await cmdNew();
      break;
    case 'open':
      await cmdOpen();
      break;
    case 'save':
      await cmdSave(false);
      break;
    case 'saveAs':
      await cmdSave(true);
      break;
    case 'exportStl':
      await cmdExport('stl');
      break;

    case 'newSketch':
      cmdNewSketch();
      break;
    case 'lookAt':
      cmdLookAt();
      break;
    case 'finishSketch':
      finishSketch();
      break;
    case 'construction':
      if (state.sketcher.active) state.sketcher.toggleConstruction();
      break;
    case 'centerline':
      if (state.sketcher.active) state.sketcher.toggleCenterline();
      break;


    case 'extrude':
      startFeatureDialog('extrude');
      break;
    case 'revolve':
      startFeatureDialog('revolve');
      break;
    case 'hole':
      startFeatureDialog('hole');
      break;
    case 'primBox':
      startPrimitive('box');
      break;
    case 'primCyl':
      startPrimitive('cylinder');
      break;
    case 'primTorus':
      startPrimitive('torus');
      break;
    case 'primPipe':
      startPrimitive('pipe');
      break;
    case 'primSphere':
      startPrimitive('sphere');
      break;
    case 'mirror':
      startFeatureDialog('mirror');
      break;
    case 'patternRect':
      startFeatureDialog('patternRect');
      break;
    case 'patternCirc':
      startFeatureDialog('patternCircular');
      break;
    case 'move':
      startFeatureDialog('move');
      break;
    case 'scale':
      startFeatureDialog('scale');
      break;
    case 'combine':
      startFeatureDialog('combine');
      break;
    case 'fillet':
      startEdgeBlend('fillet');
      break;
    case 'chamfer':
      startEdgeBlend('chamfer');
      break;
    case 'shell':
      startShell();
      break;
    case 'pressPull':
      startPressPull();
      break;
    case 'undo':
      undo();
      break;
    case 'redo':
      redoAction();
      break;
    case 'selectAllEdges':
      selectAllConvexEdges();
      break;
    case 'project':
      cmdProject(true);
      break;
    case 'projectCopy':
      cmdProject(false);
      break;
    case 'intersect':
      cmdIntersect();
      break;
    case 'include3D':
      cmdInclude3D();
      break;
    case 'intersectionCurve':
      cmdIntersectionCurve();
      break;
    case 'projectToSurface':
      cmdProjectToSurface();
      break;
    case 'spunProfile':
      cmdSpunProfile();
      break;
    case 'isoCurve':
      cmdIsoCurve();
      break;
    case 'surfaceExtrude':
      cmdSurfaceExtrude();
      break;
    case 'surfaceRevolve':
      cmdSurfaceRevolve();
      break;
    case 'surfaceSweep':
      cmdSurfaceSweep();
      break;
    case 'surfaceLoft':
      cmdSurfaceLoft();
      break;
    case 'patch':
      cmdPatch();
      break;
    case 'ruled':
      cmdRuled();
      break;
    case 'offsetSurface':
      cmdOffsetSurface();
      break;
    case 'trimSurface':
      cmdTrimSurface();
      break;
    case 'extendSurface':
      cmdExtendSurface();
      break;
    case 'untrimSurface':
      cmdUntrimSurface();
      break;
    case 'mergeSurface':
      cmdMergeSurface();
      break;
    case 'stitch':
      cmdStitch();
      break;
    case 'unstitch':
      cmdUnstitch();
      break;
    case 'reverseNormal':
      cmdReverseNormal();
      break;
    case 'thicken':
      cmdThicken();
      break;
    case 'boundaryFill':
      cmdBoundaryFill();
      break;
    case 'replaceFace':
      cmdReplaceFace();
      break;
    case 'boss':
      cmdPlastic('boss');
      break;
    case 'rest':
      cmdPlastic('rest');
      break;
    case 'snapFit':
      cmdPlastic('snapFit');
      break;
    case 'lip':
      cmdPlastic('lip');
      break;
    case 'smRule':
      cmdSheetRule();
      break;
    case 'baseFlange':
      cmdBaseFlange();
      break;
    case 'flange':
      cmdFlange();
      break;
    case 'contourFlange':
      cmdContourFlange();
      break;
    case 'sheetFold':
      cmdSheetFold();
      break;
    case 'unfold':
      cmdUnfold(false);
      break;
    case 'refold':
      cmdUnfold(true);
      break;
    case 'rip':
      cmdRip();
      break;
    case 'cornerRelief':
      cmdCornerRelief();
      break;
    case 'miter':
      cmdMiter();
      break;
    case 'convertToSheetMetal':
      cmdConvertToSheetMetal();
      break;
    case 'flatPattern':
      cmdFlatPattern();
      break;
    case 'exportFlatDXF':
      cmdExportFlatDXF();
      break;
    case 'insertComponent':
      cmdInsertFromFile(false);
      break;
    case 'insertDerive':
      cmdInsertFromFile(true);
      break;
    case 'refreshDerived':
      cmdRefreshDerived();
      break;
    case 'insertCanvas':
      cmdInsertCanvas();
      break;
    case 'insertDecal':
      cmdInsertDecal();
      break;
    case 'insertMesh':
      cmdInsertMesh();
      break;
    case 'tessellate':
      cmdTessellate();
      break;
    case 'meshRepair':
      cmdMeshRepair();
      break;
    case 'meshStitch':
      cmdMeshStitch();
      break;
    case 'meshPatch':
      cmdMeshPatch();
      break;
    case 'meshDirectEdit':
      cmdMeshDirectEdit();
      break;
    case 'physicalMaterial':
      cmdPhysicalMaterial();
      break;
    case 'appearance':
      cmdAppearance();
      break;
    case 'computeAll':
      cmdComputeAll();
      break;
    case 'configurations':
      cmdConfigurations();
      break;
    case 'documentInfo':
      cmdDocumentInfo();
      break;
    case 'namedVersions':
      cmdNamedVersions();
      break;
    case 'addNote':
      cmdAddNote();
      break;
    case 'render':
      cmdRender();
      break;
    case 'animate':
      cmdAnimate();
      break;
    case 'simulate':
      cmdSimulate();
      break;
    case 'clearStress':
      clearStress();
      break;
    case 'generative':
      cmdGenerative();
      break;
    case 'meshReduce':
      cmdMeshReduce();
      break;
    case 'meshRemesh':
      cmdMeshRemesh();
      break;
    case 'meshSmooth':
      cmdMeshSmooth();
      break;
    case 'meshPlaneCut':
      cmdMeshPlaneCut();
      break;
    case 'meshScale':
      cmdMeshScale();
      break;
    case 'meshSeparate':
      cmdMeshSeparate();
      break;
    case 'meshMerge':
      cmdMeshMerge();
      break;
    case 'meshErase':
      cmdMeshErase();
      break;
    case 'meshReverse':
      cmdMeshReverse();
      break;
    case 'convertMesh':
      cmdConvertMesh();
      break;
    case 'createFaceGroup':
      cmdFaceGroupEdit('pin');
      break;
    case 'combineFaceGroups':
      cmdFaceGroupEdit('combine');
      break;
    case 'releaseFaceGroups':
      cmdFaceGroupEdit('release');
      break;
    case 'recognise':
      cmdRecognise();
      break;
    case 'selectInvert':
      cmdSelectInvert();
      break;
    case 'selectGrow':
      cmdSelectGrow(1);
      break;
    case 'selectShrink':
      cmdSelectShrink();
      break;
    case 'selectTangent':
      cmdSelectTangent();
      break;
    case 'selectSimilar':
      cmdSelectSimilar();
      break;
    case 'selectSeedBoundary':
      cmdSeedAndBoundary();
      break;
    case 'createSelectionSet':
      createSelectionSet();
      break;
    case 'selectBySize':
      cmdSelectBySize();
      break;
    case 'isolate':
      cmdIsolate();
      break;
    case 'unisolate':
      cmdUnisolate();
      break;
    case 'priorityAuto':
      cmdSelectPriority('auto');
      break;
    case 'priorityBody':
      cmdSelectPriority('body');
      break;
    case 'priorityFace':
      cmdSelectPriority('face');
      break;
    case 'priorityEdge':
      cmdSelectPriority('edge');
      break;
    case 'faceGroups':
      cmdFaceGroups();
      break;
    case 'textureExtrude':
      cmdTextureExtrude();
      break;
    case 'meshSection':
      cmdMeshSection();
      break;
    case 'formBox':
      startFormPrimitive('box');
      break;
    case 'formPlane':
      startFormPrimitive('plane');
      break;
    case 'formCylinder':
      startFormPrimitive('cylinder');
      break;
    case 'formSphere':
      startFormPrimitive('sphere');
      break;
    case 'formTorus':
      startFormPrimitive('torus');
      break;
    case 'formQuadball':
      startFormPrimitive('quadball');
      break;
    case 'formSubdivide':
      cmdFormSubdivideFaces();
      break;
    case 'formInsertEdge':
      cmdFormInsertEdge();
      break;
    case 'formInsertPoint':
      cmdFormInsertPoint();
      break;
    case 'formDelete':
      cmdFormDeleteFaces();
      break;
    case 'formFillHole':
      cmdFormFillHole();
      break;
    case 'formBridge':
      cmdFormBridge();
      break;
    case 'formCrease':
      cmdFormCrease(true);
      break;
    case 'formUncrease':
      cmdFormCrease(false);
      break;
    case 'formWeld':
      cmdFormWeld(false);
      break;
    case 'formUnweld':
      cmdFormWeld(true);
      break;
    case 'formExtrudeCurve':
      cmdFormFromCurve('extrude');
      break;
    case 'formRevolveCurve':
      cmdFormFromCurve('revolve');
      break;
    case 'formSweepCurve':
      cmdFormFromCurve('sweep');
      break;
    case 'formLoftCurves':
      cmdFormFromCurve('loft');
      break;
    case 'formPipeCurve':
      cmdFormFromCurve('pipe');
      break;
    case 'formFace':
      cmdFormFace();
      break;
    case 'formSmooth':
      cmdFormSmooth();
      break;
    case 'formStraighten':
      cmdFormStraighten();
      break;
    case 'formCylindrify':
      cmdFormCylindrify();
      break;
    case 'formSlide':
      cmdFormSlide();
      break;
    case 'formBevel':
      cmdFormBevel();
      break;
    case 'formErase':
      cmdFormErase();
      break;
    case 'formMergeEdge':
      cmdFormMergeEdge();
      break;
    case 'formFreeze':
      cmdFormFreeze(true);
      break;
    case 'formUnfreeze':
      cmdFormFreeze(false);
      break;
    case 'formMatch':
      cmdFormMatch('nearest');
      break;
    case 'formByCurve':
      cmdFormMatch('spread');
      break;
    case 'formInterpolate':
      cmdFormInterpolate(true);
      break;
    case 'formUninterpolate':
      cmdFormInterpolate(false);
      break;
    case 'formFlatten':
      cmdFormFlatten();
      break;
    case 'formUniform':
      cmdFormMakeUniform();
      break;
    case 'formMirror':
      cmdFormMirror();
      break;
    case 'formCircular':
      cmdFormCircular();
      break;
    case 'formClearSymmetry':
      cmdFormClearSymmetry();
      break;
    case 'formDisplayBox':
      cmdFormDisplay('box');
      break;
    case 'formDisplayControl':
      cmdFormDisplay('control');
      break;
    case 'formDisplaySmooth':
      cmdFormDisplay('smooth');
      break;
    case 'formRepair':
      cmdFormRepair();
      break;
    case 'formThicken':
      cmdFormThicken();
      break;
    case 'finishForm':
      cmdFinishForm();
      break;
    case 'editForm':
      cmdEditForm();
      break;
    case 'formPull':
      cmdFormPull();
      break;
    case 'formGrow':
      cmdFormGrow(false);
      break;
    case 'formShrink':
      cmdFormGrow(true);
      break;
    case 'formLoop':
      cmdFormLoop(false);
      break;
    case 'formRing':
      cmdFormLoop(true);
      break;
    case 'formInvert':
      cmdFormInvert();
      break;
    case 'formSelectAll':
      cmdFormSelectAll();
      break;
    case 'loft':
      startLoft();
      break;
    case 'sweep':
      startSweep();
      break;
    case 'rib':
      startRib();
      break;
    case 'draft':
      startDraft();
      break;
    case 'splitBody':
      startSplit();
      break;
    case 'thread':
      startThread();
      break;
    case 'coil':
      startCoil();
      break;
    case 'emboss':
      startEmboss();
      break;
    case 'web':
      startWeb();
      break;
    case 'align':
      startAlign();
      break;
    case 'deleteFace':
      startDeleteFace();
      break;
    case 'silhouetteSplit':
      startSilhouetteSplit();
      break;
    case 'splitFace':
      startSplitFace();
      break;
    case 'patternPath':
      startPatternPath();
      break;
    case 'patternFeature':
      startPatternFeature();
      break;
    case 'mirrorSketch':
      startSketchMirror();
      break;
    case 'sketchMove':
      startSketchMove();
      break;
    case 'sketchCopy':
      state.sketcher.copySelection();
      break;
    case 'sketchPaste':
      state.sketcher.pasteClipboard();
      break;
    case 'sketchPatternRect':
      startSketchPatternRect();
      break;
    case 'sketchPatternCirc':
      startSketchPatternCirc();
      break;
    case 'sketchScale':
      startSketchScale();
      break;
    case 'editText':
      state.sketcher.editSelectedText();
      break;
    case 'insertSvg':
      startVectorImport('svg');
      break;
    case 'insertDxf':
      startVectorImport('dxf');
      break;
    case 'measure':
      startMeasure();
      break;
    case 'sectionAnalysis':
      startSectionAnalysis();
      break;
    case 'centreOfMass':
      startCentreOfMass();
      break;
    case 'interference':
      startInterference();
      break;
    case 'draftAnalysis':
      startDraftAnalysis();
      break;
    case 'curvatureMap':
      startFaceAnalysis('curvature');
      break;
    case 'minimumRadius':
      startFaceAnalysis('minRadius');
      break;
    case 'zebraAnalysis':
      startFaceAnalysis('zebra');
      break;
    case 'accessibility':
      startFaceAnalysis('access');
      break;
    case 'environmentMap':
      startFaceAnalysis('chrome');
      break;
    case 'curvatureComb':
      startCurvatureComb();
      break;
    case 'designAdvice':
      startDesignAdvice();
      break;
    case 'print3D':
      cmdPrint3D();
      break;
    case 'clearAnalysis':
      clearAnalysis();
      break;
    case 'construct':
      startConstruction();
      break;
    case 'newComponent':
      addComponent();
      break;
    case 'newJoint':
      startJoint();
      break;
    case 'asBuiltJoint':
      startAsBuiltJoint();
      break;
    case 'jointOrigin':
      cmdJointOrigin();
      break;
    case 'constrainComponents':
      cmdConstrainComponents();
      break;
    case 'hem':
      cmdHem();
      break;
    case 'loftedFlange':
      cmdLoftedFlange();
      break;
    case 'rigidGroup':
      startRigidGroup();
      break;
    case 'motionLink':
      startMotionLink();
      break;
    case 'driveJoints':
      startDriveJoints();
      break;
    case 'toggleHistory':
      toggleHistory();
      break;
    case 'hideSelected':
      for (const id of state.selection.bodies) state.hiddenBodies.add(id);
      rebuildAll();
      break;
    case 'showAll':
      state.hiddenBodies.clear();
      state.hiddenSketches.clear();
      rebuildAll();
      break;
    case 'parameters':
      showParameters();
      break;
    case 'offsetPlane':
      showOffsetPlane();
      break;

    case 'deleteBody':
      deleteSelectedBodies();
      break;
    case 'deleteFeature':
      deleteSelectedFeatures();
      break;
    case 'suppress':
      toggleSuppress();
      break;

    case 'fit':
      state.vp.fit();
      break;
    case 'home':
      state.vp.setHomeView();
      break;
    case 'toggleProjection':
      state.vp.setProjection(!state.vp.usePerspective);
      setStatus(state.vp.usePerspective ? 'Perspective view' : 'Orthographic view');
      break;

    case 'rollbackStart':
      setRollback(-1);
      break;
    case 'rollbackPrev':
      setRollback((currentRollback() ?? state.doc.features.length - 1) - 1);
      break;
    case 'rollbackNext':
      setRollback((currentRollback() ?? -1) + 1);
      break;
    case 'rollbackEnd':
      setRollback(null);
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* File                                                                */
/* ------------------------------------------------------------------ */

async function cmdNew() {
  if (state.dirty) {
    const res = await window.anvil.message({
      type: 'question',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Save changes before starting a new model?'
    });
    if (res.response === 2) return;
    if (res.response === 0) {
      const ok = await cmdSave(false);
      if (!ok) return;
    }
  }
  exitSketch();
  state.doc = newDocument();
  state.selection.bodies.clear();
  state.selection.features.clear();
  state.hiddenBodies.clear();
  state.dirty = false;
  await window.anvil.newDoc();
  state.docPath = null;
  el.docname.textContent = 'Untitled';
  rebuildAll();
  state.vp.fit();
  setStatus('New model.');
}

async function cmdOpen() {
  const res = await window.anvil.open();
  if (!res.ok) {
    if (res.error) setStatus(`Could not open: ${res.error}`);
    return;
  }
  exitSketch();
  state.doc = migrate(res.data);
  state.selection.bodies.clear();
  state.hiddenBodies.clear();
  state.dirty = false;
  state.docPath = res.path;
  el.docname.textContent = res.path.split(/[\\/]/).pop();

  // A folder that syncs cannot tell two machines about each other, so a lock
  // beside the document does. Advisory on purpose: it says who had it and
  // when, and the decision is the reader's.
  if (res.held) {
    const when = new Date(res.held.at).toLocaleString();
    window.anvil.message({
      type: 'warning',
      title: 'Open somewhere else',
      message: `${res.held.user || 'Someone'} on ${res.held.host} has this open.`,
      detail:
        `Last seen ${when}. Two machines editing one file will not merge: ` +
        'whichever saves last wins. Save a copy if you mean to work on it now.',
      buttons: ['I understand']
    });
  }
  rebuildAll();
  state.vp.fit();
  setStatus(`Opened ${el.docname.textContent}`);
}

async function cmdSave(saveAs) {
  // A document kept in a folder that syncs, which is the cheapest hub there
  // is, can be edited on another machine and pulled down while it sits open
  // here. Saving over that without asking is silent loss, and the only moment
  // it can be caught is now.
  if (!saveAs && (await changedElsewhere())) {
    const choice = await window.anvil.message({
      type: 'warning',
      title: 'Changed somewhere else',
      message: 'This file has changed on disk since you opened it.',
      detail:
        'Another machine, or another copy of Anvil, has written to it. Saving ' +
        'now replaces that version with yours.',
      buttons: ['Save anyway', 'Save a copy', 'Cancel'],
      defaultId: 1,
      cancelId: 2
    });
    if (choice?.response === 2) return false;
    if (choice?.response === 1) saveAs = true;
  }

  const res = await window.anvil.save(state.doc, saveAs, sidecarMesh());
  if (!res.ok) {
    if (res.error) setStatus(`Could not save: ${res.error}`);
    return false;
  }
  state.dirty = false;
  state.docPath = res.path;
  el.docname.textContent = res.path.split(/[\\/]/).pop();
  setStatus(
    res.beside
      ? `Saved ${el.docname.textContent}, and ${res.beside.split(/[\\/]/).pop()} beside it`
      : `Saved ${el.docname.textContent}`
  );
  return true;
}
/**
 * A model written beside the document, in a format anything can open.
 *
 * The point of keeping work in a folder that syncs is that a link to it is
 * useful to somebody else, and a link to a file only this application can read
 * is not. An STL costs nothing to write, and every viewer, slicer and browser
 * preview understands one.
 */
function sidecarMesh() {
  const bodies = (state.result?.bodies || []).filter(
    (b) => b.solid && !state.hiddenBodies.has(b.id)
  );
  if (!bodies.length) return null;
  try {
    const data = toBinarySTL(bodies.map((b) => K.meshData(b.solid)));
    return { ext: 'stl', bytes: data instanceof Uint8Array ? data : new Uint8Array(data) };
  } catch {
    // A model that will not export must never be a model that will not save.
    return null;
  }
}


/** Has the open document been written by something else since we last saw it? */
async function changedElsewhere() {
  try {
    const got = await window.anvil.changedOnDisk?.();
    return !!got?.changed;
  } catch {
    // A check that cannot run must never be the reason a save does not.
    return false;
  }
}

async function cmdExport(ext) {
  if (!state.result || !state.result.bodies.length) {
    setStatus('Nothing to export yet.');
    return;
  }
  const visible = state.result.bodies.filter((b) => !state.hiddenBodies.has(b.id));
  if (!visible.length) {
    setStatus('Every body is hidden.');
    return;
  }
  const meshes = visible.map((b) => K.meshData(b.solid));
  const base = (state.docPath ? state.docPath.split(/[\\/]/).pop() : 'Untitled').replace(
    /\.anvil$/i,
    ''
  );

  let data;
  if (ext === 'stl') data = toBinarySTL(meshes);
  else data = toOBJ(meshes, visible.map((b) => b.name));

  const res = await window.anvil.exportMesh(`${base}.${ext}`, ext, data);
  if (res.ok) {
    setStatus(`Exported ${res.path.split(/[\\/]/).pop()}`);
    window.anvil.showItem(res.path);
  } else if (res.error) {
    setStatus(`Export failed: ${res.error}`);
  }
}

function migrate(data) {
  const doc = newDocument();
  Object.assign(doc, data);
  doc.parameters = doc.parameters || [];
  doc.sketches = doc.sketches || {};
  doc.features = doc.features || [];
  doc.bodyNames = doc.bodyNames || {};
  doc.construction = doc.construction || [];
  doc.components = doc.components || [];
  doc.joints = doc.joints || [];
  doc.selectionSets = doc.selectionSets || [];
  doc.baseBodies = doc.baseBodies || [];
  normalizeSheetRules(doc);
  doc.meshData = doc.meshData || {};
  doc.imageData = doc.imageData || {};
  doc.appearance = doc.appearance || {};
  doc.flatExports = doc.flatExports || {};
  doc.canvases = doc.canvases || {};
  doc.decals = doc.decals || {};
  doc.configurations = doc.configurations || null;
  doc.versions = doc.versions || [];
  doc.info = doc.info || {};
  doc.notes = doc.notes || [];
  doc.animation = doc.animation || null;
  doc.constraints = doc.constraints || [];
  doc.forms = doc.forms || {};
  if (doc.captureHistory === undefined) doc.captureHistory = true;
  if (doc.rollback === undefined) doc.rollback = null;
  // A fillet or chamfer saved with no edges used to mean every convex edge,
  // because that was the only thing an empty list could mean. It means nothing
  // picked yet now, so the old files are given the flag that says what they
  // meant. Only on load: a set made in this session and left empty is empty.
  for (const f of doc.features) {
    if (f.type !== 'fillet' && f.type !== 'chamfer') continue;
    for (const set of f.sets || []) {
      if (set.all === undefined && !set.edges?.length) set.all = true;
    }
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* Sketch lifecycle                                                    */
/* ------------------------------------------------------------------ */

function cmdNewSketch() {
  if (state.sketcher.active) {
    finishSketch();
    return;
  }

  // A selected planar face is an unambiguous answer to "where", so use it and
  // skip the dialog, which is how it goes in Fusion.
  const face = singleSelectedFace();
  if (face) {
    startSketchOn(faceSketchPlane(face.record, face.face));
    return;
  }

  beginPlanePick();
}

/**
 * Ask for the sketch plane by pointing at it, which is how Fusion asks. The
 * three origin planes come up in the viewport for the duration, and a planar
 * face of a body or a construction plane in the browser answers just as well.
 */
function beginPlanePick() {
  const wasVisible = state.vp.originPlanes.visible;
  state.vp.setPlanesVisible(true);

  let taken = false;
  const take = (spec) => {
    taken = true;
    // The pick is still open at this point, so close it before the sketch
    // starts and steals the pointer.
    endPicking(false);
    startSketchOn(spec);
  };

  state.pickingPlane = (name) => take(name);

  beginPicking({
    prompt: 'Select a plane or a planar face to sketch on.',
    filter: { planes: true, faces: true, edges: false, bodies: false, profiles: false },
    once: true,
    onEnd: () => {
      state.pickingPlane = null;
      state.vp.setPlaneHover(null);
      state.vp.setPlanesVisible(wasVisible);
      // Tidying runs whether the plane was taken or not, so a tool reached for
      // and then thought better of is dropped here rather than lying in wait
      // for the next sketch. It cannot be dropped unconditionally: on a taken
      // pick this runs before the sketch opens.
      if (!taken) state.pendingTool = null;
    },
    onPick: (hit) => {
      if (hit.kind === 'plane') {
        take(hit.planeName);
        return;
      }
      if (hit.kind === 'face' && hit.faceId !== null) {
        const record = (state.records || []).find((r) => r.id === hit.bodyId);
        const face = record?.topology?.faces[hit.faceId];
        if (!face || !face.planar) {
          setStatus('That face is curved. Pick a flat one, or an origin plane.');
          return;
        }
        take(faceSketchPlane(record, face));
      }
    }
  });
}

function startSketchOn(planeSpec) {
  pushUndo('create sketch');
  const sk = newSketch(planeSpec, `Sketch ${Object.keys(state.doc.sketches).length + 1}`);
  state.doc.sketches[sk.id] = sk;
  const feature = { id: uid('f'), type: 'sketch', sketch: sk.id };
  insertFeature(feature);
  state.dirty = true;
  clearGeometrySelection(false);
  rebuildAll();
  enterSketch(feature, { draw: true });
}

function singleSelectedFace() {
  if (state.selection.faces.size !== 1) return null;
  const { bodyId, index } = splitKey([...state.selection.faces][0]);
  const record = (state.records || []).find((r) => r.id === bodyId);
  const face = record?.topology?.faces[index];
  if (!face || !face.planar) return null;
  return { record, face };
}

/**
 * The one selected edge, when exactly one is selected and it is an edge a
 * fillet could stand on.
 *
 * A tangent edge is turned away: where two faces meet smoothly there is no
 * outward direction to drag along and no corner to round.
 */
function singleSelectedEdge() {
  if (state.selection.edges.size !== 1 || state.selection.faces.size) return null;
  const { bodyId, index } = splitKey([...state.selection.edges][0]);
  const record = (state.records || []).find((r) => r.id === bodyId);
  const edge = record?.topology?.edges[index];
  if (!edge?.refPoint || !edge.nA || !edge.nB) return null;
  const z = [
    edge.nA[0] + edge.nB[0],
    edge.nA[1] + edge.nB[1],
    edge.nA[2] + edge.nB[2]
  ];
  const len = Math.hypot(z[0], z[1], z[2]);
  if (len < 1e-6) return null;
  return { record, edge, out: [z[0] / len, z[1] / len, z[2] / len] };
}

/**
 * A sketch attached to a face. The reference is stored so the sketch can find
 * the face again after a rebuild, and the frame it was created with is kept as
 * a fallback for when the face is gone.
 */
function faceSketchPlane(record, face) {
  const basis = basisFor(face.normal);
  const d =
    face.normal[0] * face.centre[0] +
    face.normal[1] * face.centre[1] +
    face.normal[2] * face.centre[2];
  return {
    face: faceReference(face),
    frame: {
      origin: [face.normal[0] * d, face.normal[1] * d, face.normal[2] * d],
      x: basis.x,
      y: basis.y,
      n: basis.n
    }
  };
}

function enterSketch(feature, opts = {}) {
  const sk = state.doc.sketches[feature.sketch];
  if (!sk) return;
  const scope = resolveParameters(state.doc.parameters).scope;
  // The sketcher solves on its own between rebuilds, so it needs the parameters
  // to work out a dimension written as an expression.
  state.sketcher.paramScope = scope;
  // Worked out after the sketch is up, below, once its plane is known.
  const plane =
    state.result?.sketchPlanes?.[sk.id] || resolvePlane(sk.plane, scope);
  state.activeSketchFeature = feature;
  state.hiddenSketches.delete(sk.id);
  state.sketcher.begin(sk, plane);
  state.sketcher.refreshRegions();
  state.sketcher.rebuild();
  setTab('sketch');
  syncToolButtons();
  renderSketchDisplay();

  if (!opts.keepView) {
    // The plane's own Y goes up the screen, so a line drawn rightwards is a
    // horizontal in sketch coordinates too and the inferred constraint agrees
    // with what you can see.
    state.vp.setView(plane.n, true, plane.y);

    // Look straight at the plane from a sensible distance. Without this an
    // empty sketch opens at whatever zoom the model needed, which on a fresh
    // document is far enough out that the grid is the only thing you can aim at.
    const hasBodies = (state.result?.bodies.length || 0) > 0;
    if (!hasBodies) {
      state.vp.target.set(plane.origin[0], plane.origin[1], plane.origin[2]);
      state.vp.spherical.radius = 190;
      state.vp.orthoZoom = 60;
      state.vp.invalidate();
    }
  }
  state.vp.setBodyOpacity(0.35);

  // A new sketch opens on the line tool, the way Fusion does, because the only
  // reason to have made one is to draw. Reopening an existing sketch is usually
  // to change something, so that lands on select.
  if (opts.draw || state.pendingTool) {
    // Whatever was reached for on the tab, or the line tool, which is what a
    // sketch made for no stated reason opens on.
    state.sketcher.setTool(state.pendingTool || 'line');
    syncToolButtons();
  }
  state.pendingTool = null;

  // The plane is known by now, so the slice can be put where the sketch is.
  refreshSlice();

  setStatus(`Editing ${sk.name}. Draw, then press Finish.`);
  updateHints();
}

function exitSketch() {
  if (!state.sketcher.active) return;
  state.sketcher.end();
  state.activeSketchFeature = null;
  // The slice belongs to the sketch that asked for it. Left alone it cuts the
  // model open for the rest of the session, which is the same shape of bug as
  // the value box that used to outlive its feature.
  state.vp.setSlice(null);
  state.vp.setBodyOpacity($('#chkTransparent').checked ? 0.45 : 1);
  syncToolButtons();
  updateHints();
}

function finishSketch() {
  if (!state.sketcher.active) return;
  const sk = state.sketcher.sketch;
  const chosen = state.sketcher.selectedRegionObjects();
  exitSketch();
  setTab('solid');
  rebuildAll();

  // Anything picked inside the sketch carries out to the model, so Extrude can
  // be pressed straight away. Otherwise the regions are simply left on screen
  // waiting to be clicked.
  state.selection.profiles = chosen.map((r) => ({
    sketch: sk.id,
    regionId: r.id,
    seed: interiorPoint(r.outer)
  }));
  renderSketchDisplay();
  setStatus(
    state.selection.profiles.length
      ? `${state.selection.profiles.length} profile selected. Press E to extrude.`
      : 'Sketch finished. Click a region, then press E to extrude.'
  );
  updateHints();
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

function currentRollback() {
  return state.doc.rollback === null || state.doc.rollback === undefined
    ? null
    : state.doc.rollback;
}

function setRollback(index) {
  const max = state.doc.features.length - 1;
  if (index === null || index >= max) state.doc.rollback = null;
  else state.doc.rollback = Math.max(-1, Math.min(max, index));
  rebuildAll();
}

function insertFeature(feature) {
  const at = currentRollback();
  if (at === null) {
    state.doc.features.push(feature);
  } else {
    state.doc.features.splice(at + 1, 0, feature);
    state.doc.rollback = at + 1;
  }
  return feature;
}

function renderTimeline() {
  el.timeline.innerHTML = '';
  const rollback = currentRollback();
  const errorIds = new Set(visibleErrors().map((e) => e.feature));

  const icons = {
    sketch: '✎',
    extrude: '⬆',
    revolve: '↻',
    hole: '◎',
    primitive: '▣',
    mirror: '⇋',
    patternRect: '⁙',
    patternCircular: '⊛',
    move: '✥',
    scale: '⤢',
    combine: '⊕',
    fillet: '◡',
    chamfer: '◺',
    shell: '⊔',
    offsetFace: '⇅',
    loft: '◇',
    sweep: '⌁',
    rib: '⌷',
    draft: '◿',
    split: '⊟',
    thread: '⌸',
    construction: '▱',
    patternPath: '⋯',
    patternFeature: '⁘'
  };

  state.doc.features.forEach((f, i) => {
    const node = document.createElement('div');
    node.className = 'tl-item';
    if (state.selection.features.has(f.id)) node.classList.add('sel');
    if (rollback !== null && i > rollback) node.classList.add('rolled');
    if (f.suppressed) node.classList.add('suppressed');
    if (errorIds.has(f.id)) node.classList.add('err');
    node.title = featureLabel(state.doc, f);
    node.innerHTML = `<span>${icons[f.type] || '●'}</span><span class="tl-n">${i + 1}</span>`;

    node.addEventListener('click', () => {
      state.selection.features.clear();
      state.selection.features.add(f.id);
      renderTimeline();
      renderTree();
      updateHints();
    });
    node.addEventListener('dblclick', () => editFeature(f));
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      setRollback(i);
    });
    el.timeline.appendChild(node);

    if (rollback === i) {
      const marker = document.createElement('div');
      marker.className = 'tl-marker';
      el.timeline.appendChild(marker);
    }
  });

  if (rollback === -1) {
    const marker = document.createElement('div');
    marker.className = 'tl-marker';
    el.timeline.insertBefore(marker, el.timeline.firstChild);
  }
}

function deleteSelectedFeatures() {
  if (!state.selection.features.size) {
    setStatus('Select a timeline feature first.');
    return;
  }
  pushUndo('delete feature');
  state.doc.features = state.doc.features.filter((f) => {
    if (!state.selection.features.has(f.id)) return true;
    if (f.type === 'sketch') delete state.doc.sketches[f.sketch];
    return false;
  });
  state.selection.features.clear();
  state.dirty = true;
  rebuildAll();
}

function toggleSuppress() {
  if (!state.selection.features.size) {
    setStatus('Select a timeline feature first.');
    return;
  }
  pushUndo('suppress');
  for (const f of state.doc.features) {
    if (state.selection.features.has(f.id)) f.suppressed = !f.suppressed;
  }
  state.dirty = true;
  rebuildAll();
}

/* ------------------------------------------------------------------ */
/* Browser tree                                                        */
/* ------------------------------------------------------------------ */

function renderTree() {
  el.tree.innerHTML = '';

  const addNode = (label, opts = {}) => {
    const n = document.createElement('div');
    n.className = `node${opts.child ? ' child' : ''}${opts.head ? ' group-head' : ''}${
      opts.selected ? ' sel' : ''
    }`;
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = opts.head ? '▾' : '';
    n.appendChild(caret);

    const text = document.createElement('span');
    text.textContent = label;
    n.appendChild(text);

    if (opts.error) {
      const e = document.createElement('span');
      e.className = 'err';
      e.textContent = '!';
      e.title = opts.error;
      n.appendChild(e);
    }

    if (opts.eye) {
      const eye = document.createElement('span');
      eye.className = 'eye';
      // A filled dot for shown, a hollow one for hidden. The eye and the
      // no-entry sign are colour emoji, which put two saturated glyphs in
      // a window that is otherwise entirely grey.
      eye.textContent = opts.visible ? '●' : '○';
      eye.addEventListener('click', (ev) => {
        ev.stopPropagation();
        opts.eye();
      });
      n.appendChild(eye);
    }

    if (opts.remove) {
      // A cross rather than a bin: this row is the only place some things can
      // be got rid of, and a thing that cannot be removed is a thing nobody
      // will risk adding.
      const x = document.createElement('span');
      x.className = 'eye';
      x.textContent = '✕';
      x.title = 'Remove';
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        opts.remove();
      });
      n.appendChild(x);
    }

    if (opts.onClick) n.addEventListener('click', opts.onClick);
    if (opts.onDblClick) n.addEventListener('dblclick', opts.onDblClick);
    el.tree.appendChild(n);
    return n;
  };

  addNode('Parameters', {
    head: true,
    onClick: () => showParameters()
  });
  const { errors: perrs } = resolveParameters(state.doc.parameters);
  for (const p of state.doc.parameters) {
    addNode(`${p.name} = ${p.expr}`, { child: true, error: perrs[p.name] });
  }

  if ((state.doc.selectionSets || []).length) {
    addNode('Selection Sets', { head: true });
    for (const s of state.doc.selectionSets) {
      addNode(`${s.name} (${selectionSetCount(s)})`, {
        child: true,
        onClick: () => restoreSelectionSet(s),
        onDblClick: () => renameSelectionSet(s),
        remove: () => {
          pushUndo('delete selection set');
          state.doc.selectionSets = state.doc.selectionSets.filter((x) => x.id !== s.id);
          state.dirty = true;
          renderTree();
        }
      });
    }
  }

  addNode('Origin', { head: true });
  for (const name of ['XY', 'XZ', 'YZ']) {
    addNode(`${name} plane`, {
      child: true,
      onClick: () => {
        if (state.pickingPlane) state.pickingPlane(name);
      }
    });
  }

  addNode('Sketches', { head: true });
  for (const f of state.doc.features) {
    if (f.type !== 'sketch') continue;
    const sk = state.doc.sketches[f.sketch];
    if (!sk) continue;
    addNode(sk.name, {
      child: true,
      selected: state.selection.features.has(f.id),
      eye: () => {
        if (state.hiddenSketches.has(sk.id)) state.hiddenSketches.delete(sk.id);
        else state.hiddenSketches.add(sk.id);
        renderSketchDisplay();
        renderTree();
      },
      visible: !state.hiddenSketches.has(sk.id),
      onClick: () => {
        state.selection.features.clear();
        state.selection.features.add(f.id);
        renderTree();
        renderTimeline();
      },
      onDblClick: () => {
        exitSketch();
        enterSketch(f);
      }
    });
  }

  if (state.doc.components.length) {
    addNode('Components', { head: true });
    for (const c of state.doc.components) {
      addNode(`${c.name}${c.grounded ? ' (grounded)' : ''}`, {
        child: true,
        selected: state.activeComponent === c.id,
        onClick: () => {
          state.activeComponent = state.activeComponent === c.id ? null : c.id;
          renderTree();
          setStatus(
            state.activeComponent
              ? `${c.name} is active. New features go into it.`
              : 'No active component. New features are loose in the document.'
          );
        },
        onDblClick: () => {
          c.grounded = !c.grounded;
          state.dirty = true;
          rebuildAll();
        }
      });
    }
  }

  if (state.doc.joints.length) {
    addNode('Joints', { head: true });
    for (const j of state.doc.joints) {
      const parent = state.doc.components.find((c) => c.id === j.parent);
      const child = state.doc.components.find((c) => c.id === j.child);
      addNode(`${j.name}: ${child?.name || '?'} on ${parent?.name || '?'}`, {
        child: true,
        onClick: () => editJoint(j)
      });
    }
  }

  // Canvases and decals are neither bodies nor features, and they have to be
  // somewhere: a picture laid on the model that cannot be switched off or
  // thrown away is not a tool, it is a mess.
  const canvases = Object.values(state.doc.canvases || {});
  const decals = Object.values(state.doc.decals || {});
  if (canvases.length || decals.length) {
    addNode('Images', { head: true });
    for (const c of canvases) {
      addNode(`${c.name} (canvas)`, {
        child: true,
        eye: () => {
          state.hiddenCanvases = state.hiddenCanvases || new Set();
          if (state.hiddenCanvases.has(c.id)) state.hiddenCanvases.delete(c.id);
          else state.hiddenCanvases.add(c.id);
          rebuildAll();
        },
        visible: !state.hiddenCanvases?.has(c.id),
        onClick: () => showCanvasPanel(c.id),
        remove: () => {
          pushUndo('remove canvas');
          delete state.doc.imageData[c.image];
          delete state.doc.canvases[c.id];
          state.dirty = true;
          rebuildAll();
        }
      });
    }
    for (const d of decals) {
      addNode(`${d.name} (decal)`, {
        child: true,
        onClick: () => showDecalPanel(d.id),
        remove: () => {
          pushUndo('remove decal');
          delete state.doc.imageData[d.image];
          delete state.doc.decals[d.id];
          state.dirty = true;
          rebuildAll();
        }
      });
    }
  }

  const notes = state.doc.notes || [];
  if (notes.length) {
    const left = notes.filter((n) => !n.done).length;
    addNode(left ? `Notes (${left} to deal with)` : 'Notes', { head: true });
    for (const n of notes) {
      addNode(`${n.done ? '✓ ' : ''}${n.text}`, {
        child: true,
        onClick: () => editNote(n.id)
      });
    }
  }

  const constructionFeatures = state.doc.features.filter((f) => f.type === 'construction');
  if (constructionFeatures.length) {
    addNode('Construction', { head: true });
    for (const f of constructionFeatures) {
      const built = state.result?.construction?.get(f.entry.id);
      addNode(f.entry.name || CONSTRUCTION_LABELS[f.entry.type] || 'Construction', {
        child: true,
        error: built ? null : 'Could not be built',
        selected: state.selection.features.has(f.id),
        onClick: () => {
          state.selection.features.clear();
          state.selection.features.add(f.id);
          renderTree();
          renderTimeline();
        }
      });
    }
  }

  // Solids, surfaces and meshes are listed apart, because almost nothing you
  // can do to one can be done to the others. A mesh is a surface underneath,
  // but it is not one to work on: it has its own tab and its own tools.
  const allBodies = state.result?.bodies || [];
  const solidList = allBodies.filter((b) => b.solid);
  const sheetList = allBodies.filter((b) => !b.solid && !b.mesh && !b.form);
  const meshList = allBodies.filter((b) => !b.solid && b.mesh && !b.form);
  const formList = allBodies.filter((b) => !b.solid && b.form);
  const bodyNode = (b) => {
    // A flat pattern that has been sent out as a DXF says so, and says when the
    // model has moved since. Somebody cutting from that file has no way to know
    // otherwise, and the cost of finding out late is a sheet of metal.
    const sent = b.outline ? flatExportState(b) : null;
    const label = sent
      ? `${b.name} ${sent.stale ? '(DXF is behind the model)' : '(DXF written)'}`
      : b.name;
    return addNode(label, {
      child: true,
      error: sent?.stale ? `${sent.file} was written from an older shape` : null,
      selected: state.selection.bodies.has(b.id),
      eye: () => {
        if (state.hiddenBodies.has(b.id)) state.hiddenBodies.delete(b.id);
        else state.hiddenBodies.add(b.id);
        rebuildAll();
      },
      visible: !state.hiddenBodies.has(b.id),
      onClick: () => {
        state.selection.bodies.clear();
        state.selection.bodies.add(b.id);
        state.vp.setSelection(state.selection.bodies);
        renderTree();
        updateHints();
      }
    });
  };

  if (solidList.length || (!sheetList.length && !meshList.length && !formList.length)) {
    addNode('Bodies', { head: true });
    for (const b of solidList) bodyNode(b);
  }
  if (sheetList.length) {
    addNode('Surfaces', { head: true });
    for (const b of sheetList) bodyNode(b);
  }
  if (meshList.length) {
    addNode('Meshes', { head: true });
    for (const b of meshList) bodyNode(b);
  }
  if (formList.length) {
    addNode('Forms', { head: true });
    for (const b of formList) bodyNode(b);
  }

  const problems = visibleErrors();
  if (problems.length) {
    addNode('Problems', { head: true });
    for (const e of problems) {
      addNode(e.message, { child: true, error: e.message });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Hints                                                               */
/* ------------------------------------------------------------------ */

/**
 * Read the navigation hint off the live bindings. Writing it out by hand let it
 * drift into saying the opposite of what the middle button actually did.
 */
function navHint(withZoom) {
  const b = state.vp.bindings;
  const bits = [`Middle drag ${b.middle}s`, `shift middle ${b.shiftMiddle}s`];
  if (withZoom) bits.push('wheel zooms');
  return bits.join(' · ');
}

function updateHints() {
  const bits = [];
  if (state.sketcher.active) {
    const s = state.sketcher.lastSolve;
    if (s) {
      bits.push(s.dof === 0 ? 'Fully constrained' : `${s.dof} degree${s.dof === 1 ? '' : 's'} of freedom`);
    }
    const regions = state.sketcher.selectedRegions.size;
    if (regions) bits.push(`${regions} profile${regions === 1 ? '' : 's'} selected`);
    bits.push(navHint(false));
  } else {
    if (state.selection.bodies.size) {
      bits.push(`${state.selection.bodies.size} body selected`);
      const props = bodyProperties();
      if (props) bits.push(props);
    } else {
      bits.push(navHint(true));
    }
  }
  el.viewhint.textContent = bits.join('  ·  ');
}

function bodyProperties() {
  if (!state.result) return null;
  let volume = 0;
  let area = 0;
  const box = new THREE.Box3();
  let any = false;
  for (const b of state.result.bodies) {
    if (!state.selection.bodies.has(b.id)) continue;
    const p = K.properties(b.solid);
    volume += p.volume;
    area += p.surfaceArea;
    const bb = K.boundingBox(b.solid);
    box.expandByPoint(new THREE.Vector3(...bb.min));
    box.expandByPoint(new THREE.Vector3(...bb.max));
    any = true;
  }
  if (!any) return null;
  const size = box.getSize(new THREE.Vector3());
  const u = displayUnit();
  const d = (v) => round(v / u.per, 2);
  const bits = [
    `${d(size.x)} × ${d(size.y)} × ${d(size.z)} ${u.label}`,
    fmtVolume(volume),
    `surface ${fmtArea(area)}`
  ];

  // A body in more than one piece will not print as one thing, and it is easy
  // to make by mistake: a join whose parts never actually touch. Worth saying
  // so, but only for what is selected, since it costs a decomposition.
  let pieces = 0;
  for (const b of state.result.bodies) {
    if (!state.selection.bodies.has(b.id)) continue;
    try {
      const parts = b.solid.decompose();
      pieces += parts.length;
      for (const p of parts) p.delete();
    } catch {
      pieces += 1;
    }
  }
  if (pieces > state.selection.bodies.size) {
    bits.push(`${pieces} separate pieces`);
  }
  return bits.join(' · ');
}

function deleteSelectedBodies() {
  if (!state.selection.bodies.size) {
    setStatus('Select a body first.');
    return;
  }
  // Bodies are outputs, so removing one means removing the feature that made it.
  const featureIds = new Set(
    (state.result?.bodies || [])
      .filter((b) => state.selection.bodies.has(b.id))
      .map((b) => b.createdBy)
  );
  state.selection.features = featureIds;
  deleteSelectedFeatures();
  state.selection.bodies.clear();
}

/* ------------------------------------------------------------------ */
/* Feature dialogs                                                     */
/* ------------------------------------------------------------------ */

function activeSketchId() {
  if (state.selection.profiles.length) return state.selection.profiles[0].sketch;
  for (const id of state.selection.features) {
    const f = state.doc.features.find((x) => x.id === id);
    if (f?.type === 'sketch') return f.sketch;
  }
  const sketches = state.doc.features.filter((f) => f.type === 'sketch');
  return sketches.length ? sketches[sketches.length - 1].sketch : null;
}

/** Seed points for whichever profiles are chosen, or null to mean all of them. */
function activeSeeds(sketchId) {
  const picked = state.selection.profiles.filter((p) => p.sketch === sketchId);
  return picked.length ? picked.map((p) => p.seed) : null;
}

const OP_OPTIONS = [
  ['new', 'New body'],
  ['join', 'Join'],
  ['cut', 'Cut'],
  ['intersect', 'Intersect']
];

const EXTRUDE_OP_OPTIONS = [...OP_OPTIONS, ['component', 'New component']];

/** How many profiles and faces an extrude is working from, written out. */
function extrudeSelectionText(f) {
  const n = (f.seeds === null ? -1 : (f.seeds || []).length) + 0;
  const faces = (f.faces || []).length;
  if (f.seeds === null) return faces ? `Whole sketch and ${faces} face(s)` : 'Whole sketch';
  const bits = [];
  if (n > 0) bits.push(`${n} profile${n === 1 ? '' : 's'}`);
  if (faces) bits.push(`${faces} face${faces === 1 ? '' : 's'}`);
  return bits.length ? bits.join(' and ') : 'Nothing yet';
}

function objectRefText(ref) {
  if (!ref) return 'Nothing yet';
  if (ref.plane) return typeof ref.plane === 'string' ? `${ref.plane} plane` : 'Construction plane';
  return ref.face ? 'A face' : 'A body';
}

/**
 * The Extrude dialog, in the order Fusion asks for things: what to extrude,
 * what kind, where it starts, which way it goes, how far, and what to do with
 * the result. Everything past the first two rows hides itself when it does not
 * apply, so the panel stays short for the ordinary case.
 */
function extrudeFields() {
  const isThin = (f) => f.kind === 'thin';
  const twoSides = (f) => f.direction === 'two';
  const notSymmetric = (f) => f.direction !== 'symmetric';

  return [
    {
      key: '__profiles',
      label: 'Profile',
      type: 'pick',
      pick: 'profiles',
      summary: extrudeSelectionText,
      clear: (f) => {
        f.seeds = [];
        f.faces = [];
      }
    },
    {
      key: 'kind',
      label: 'Type',
      type: 'select',
      options: [
        ['solid', 'Extrude'],
        ['thin', 'Thin extrude']
      ]
    },
    {
      key: 'start',
      label: 'Start',
      type: 'select',
      options: [
        ['profile', 'Profile plane'],
        ['offset', 'Offset'],
        ['object', 'Object']
      ]
    },
    { key: 'startOffset', label: 'Start offset', type: 'expr', showIf: (f) => f.start === 'offset' },
    {
      key: '__startObject',
      label: 'Start from',
      type: 'pick',
      pick: 'startObject',
      showIf: (f) => f.start === 'object',
      summary: (f) => objectRefText(f.startObject),
      clear: (f) => {
        f.startObject = null;
      }
    },
    {
      key: 'direction',
      label: 'Direction',
      type: 'select',
      options: [
        ['one', 'One side'],
        ['two', 'Two sides'],
        ['symmetric', 'Symmetric']
      ]
    },
    {
      key: 'measure',
      label: 'Measurement',
      type: 'select',
      showIf: (f) => f.direction === 'symmetric',
      options: [
        ['whole', 'Whole length'],
        ['half', 'Half length']
      ]
    },
    {
      key: 'extent',
      label: 'Extent',
      type: 'select',
      options: [
        ['distance', 'Distance'],
        ['object', 'To object'],
        ['all', 'All']
      ]
    },
    { key: 'distance', label: 'Distance', type: 'expr', showIf: (f) => f.extent === 'distance' },
    {
      key: '__toObject',
      label: 'Up to',
      type: 'pick',
      pick: 'toObject',
      showIf: (f) => f.extent === 'object',
      summary: (f) => objectRefText(f.toObject),
      clear: (f) => {
        f.toObject = null;
      }
    },
    {
      key: 'extend',
      label: 'Extend',
      type: 'select',
      showIf: (f) => f.extent === 'object',
      options: [
        ['face', 'To selected face'],
        ['adjacent', 'To adjacent faces'],
        ['body', 'To body'],
        ['through', 'Through body']
      ]
    },
    { key: 'toOffset', label: 'Object offset', type: 'expr', showIf: (f) => f.extent === 'object' },
    { key: 'flip', label: 'Flip direction', type: 'bool', showIf: (f) => f.direction === 'one' },

    {
      key: 'extent2',
      label: 'Second side',
      type: 'select',
      showIf: twoSides,
      options: [
        ['distance', 'Distance'],
        ['all', 'All']
      ]
    },
    {
      key: 'distance2',
      label: 'Second distance',
      type: 'expr',
      showIf: (f) => twoSides(f) && (f.extent2 || 'distance') === 'distance'
    },
    { key: 'taper2', label: 'Second taper', type: 'expr', showIf: twoSides },

    { key: 'taper', label: 'Taper angle', type: 'expr', showIf: notSymmetric },
    { key: 'wall', label: 'Wall thickness', type: 'expr', showIf: isThin },
    {
      key: 'wallLocation',
      label: 'Wall location',
      type: 'select',
      showIf: isThin,
      options: [
        ['side1', 'Side 1'],
        ['side2', 'Side 2'],
        ['center', 'Centre']
      ]
    },
    {
      key: 'op',
      label: 'Operation',
      type: 'select',
      options: EXTRUDE_OP_OPTIONS,
      get: (f) => f.op || 'new',
      set: (f, v) => {
        f.op = v;
        // The rebuild puts the body in a component named after the feature, so
        // the document needs a matching entry for it to appear in the browser.
        if (v === 'component') ensureFeatureComponent(f);
      }
    },
    {
      key: '__targets',
      label: 'Objects to cut',
      type: 'pick',
      pick: 'targets',
      showIf: (f) => ['cut', 'intersect', 'join'].includes(f.op),
      summary: (f) =>
        !f.targets || f.targets === 'all'
          ? 'Every body'
          : `${f.targets.length} body${f.targets.length === 1 ? '' : 's'}`,
      clear: (f) => {
        f.targets = 'all';
      }
    }
  ];
}

/**
 * Which of a blend's edge lists a pick is armed for: the edges to blend, or the
 * hold line the blend has to run out on. Both are edge picks into the same set,
 * so they are told apart by name rather than by two separate flows.
 */
function blendPickRow(armed) {
  const m = /^(set|hold):(\d+)$/.exec(String(armed || ''));
  if (!m) return null;
  return { list: m[1] === 'set' ? 'edges' : 'holdEdges', index: Number(m[2]) };
}

/**
 * Fillet and Chamfer, which both work on sets of edges. Each set carries its
 * own size, so a part can be blended at three different radii in one feature
 * rather than three.
 */
function blendFields(kind) {
  return {
    build(feature) {
      const out = [];
      (feature.sets || []).forEach((set, i) => {
        const n = i + 1;
        out.push({
          key: `__set${i}`,
          label: `Set ${n} edges`,
          type: 'pick',
          pick: `set:${i}`,
          summary: (f) => {
            const set = f.sets[i];
            const c = set?.edges?.length || 0;
            // An empty list used to mean the whole part. It means nothing
            // picked yet, and `all` is the deliberate ask, so the summary says
            // which of the two this set is rather than the old answer.
            if (c) return `${c} edge${c === 1 ? '' : 's'}`;
            return set?.all ? 'Every convex edge' : 'none yet';
          },
          clear: (f) => {
            f.sets[i].edges = [];
          }
        });
        out.push({
          // On by default, the same as Fusion. One click takes the whole run of
          // edges that carry on smoothly from the one picked.
          key: `sets.${i}.tangentChain`,
          label: `Set ${n} follows tangent edges`,
          type: 'bool',
          get: (f) => f.sets[i]?.tangentChain !== false,
          set: (f, v) => {
            f.sets[i].tangentChain = !!v;
          }
        });
        if (kind === 'fillet') {
          const typeOf = (f) => f.sets[i]?.filletType || 'constant';
          out.push({
            key: `sets.${i}.filletType`,
            label: `Set ${n} type`,
            type: 'select',
            options: [
              ['constant', 'Constant radius'],
              ['variable', 'Variable radius'],
              ['asymmetric', 'Asymmetric'],
              ['chord', 'Chord length'],
              ['hold', 'Hold line']
            ]
          });
          out.push({
            key: `sets.${i}.radius`,
            label: (f) =>
              typeOf(f) === 'asymmetric' ? `Set ${n} radius on face 1` : `Set ${n} radius`,
            type: 'expr',
            showIf: (f) =>
              ['constant', 'variable', 'asymmetric'].includes(typeOf(f))
          });
          out.push({
            key: `sets.${i}.radius2`,
            label: `Set ${n} radius on face 2`,
            type: 'expr',
            showIf: (f) => typeOf(f) === 'asymmetric'
          });
          out.push({
            // A circular arc meets a flat face with a jump in curvature, and on
            // a shiny part that jump is a visible line. G2 runs the curvature
            // out to nothing at both ends instead.
            key: `sets.${i}.continuity`,
            label: `Set ${n} continuity`,
            type: 'select',
            options: [
              ['G1', 'Tangent (G1)'],
              ['G2', 'Curvature (G2)']
            ],
            showIf: (f) => typeOf(f) !== 'hold'
          });
          out.push({
            key: `sets.${i}.weight`,
            label: `Set ${n} tangency weight`,
            type: 'expr',
            showIf: (f) => f.sets[i]?.continuity === 'G2' && typeOf(f) !== 'hold'
          });
          out.push({
            key: `sets.${i}.endRadius`,
            label: `Set ${n} end radius`,
            type: 'expr',
            showIf: (f) => typeOf(f) === 'variable'
          });
          out.push({
            key: `sets.${i}.chord`,
            label: `Set ${n} chord`,
            type: 'expr',
            showIf: (f) => typeOf(f) === 'chord'
          });
          out.push({
            key: `__hold${i}`,
            label: `Set ${n} hold line`,
            type: 'pick',
            pick: `hold:${i}`,
            showIf: (f) => typeOf(f) === 'hold',
            summary: (f) => {
              const c = f.sets[i]?.holdEdges?.length || 0;
              return c ? `${c} edge${c === 1 ? '' : 's'}` : 'Nothing held yet';
            },
            clear: (f) => {
              f.sets[i].holdEdges = [];
            }
          });
        } else {
          out.push({
            key: `sets.${i}.radius`,
            label: `Set ${n} distance`,
            type: 'expr'
          });
          out.push({
            key: `sets.${i}.chamferType`,
            label: `Set ${n} type`,
            type: 'select',
            options: [
              ['equal', 'Equal distance'],
              ['two', 'Two distances'],
              ['angle', 'Distance and angle']
            ]
          });
          out.push({
            key: `sets.${i}.distance2`,
            label: `Set ${n} second distance`,
            type: 'expr',
            showIf: (f) => f.sets[i]?.chamferType === 'two'
          });
          out.push({
            key: `sets.${i}.angle`,
            label: `Set ${n} angle`,
            type: 'expr',
            showIf: (f) => f.sets[i]?.chamferType === 'angle'
          });
        }
      });

      out.push({
        key: '__addSet',
        label: 'Add another set',
        type: 'action',
        run: (f) => {
          f.sets.push({
            edges: [],
            radius: kind === 'fillet' ? '2' : '1',
            radius2: kind === 'fillet' ? '2' : '1',
            endRadius: null,
            filletType: 'constant',
            continuity: 'G1',
            weight: '1',
            chord: '2',
            holdEdges: [],
            chamferType: 'equal',
            distance2: '1',
            angle: '45'
          });
          setEditPick(`set:${f.sets.length - 1}`);
        }
      });
      if ((feature.sets || []).length > 1) {
        out.push({
          key: '__dropSet',
          label: 'Remove the last set',
          type: 'action',
          run: (f) => {
            f.sets.pop();
            setEditPick(null);
          }
        });
      }
      return out;
    }
  };
}

/** Fields for a blend, worked out from how many sets it currently has. */
function blendFieldsFor(feature, kind) {
  return blendFields(kind).build(feature);
}

/** Hole: what kind, how deep, and whether it is tapped. */
/** A point typed as three numbers, stored as an array. */
function pointField(key, label, showIf) {
  return {
    key: `__${key}`,
    label,
    type: 'expr',
    showIf,
    get: (f) => (f[key] || [0, 0, 0]).join(', '),
    set: (f, v) => {
      const parts = String(v)
        .split(/[\s,;]+/)
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x));
      if (parts.length === 3) f[key] = parts;
    }
  };
}

/** Move: shift it, turn it about something, or take it from here to there. */
function moveFields() {
  const isType = (t) => (f) => (f.moveType || 'translate') === t;
  return [
    {
      key: '__bodies',
      label: 'Bodies',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) =>
        !f.bodies || f.bodies === 'all'
          ? 'Every body'
          : `${f.bodies.length} body${f.bodies.length === 1 ? '' : 's'}`,
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    {
      key: 'moveType',
      label: 'Move type',
      type: 'select',
      options: [
        ['translate', 'Translate'],
        ['rotate', 'Rotate'],
        ['points', 'Point to point'],
        ['direction', 'Along a direction']
      ]
    },
    {
      // Fusion has this on every move type, and it is the difference between
      // laying a part out twice and building it twice.
      key: 'copy',
      label: 'Create a copy',
      type: 'bool'
    },
    { key: 'dx', label: 'Move X', type: 'expr', showIf: isType('translate') },
    { key: 'dy', label: 'Move Y', type: 'expr', showIf: isType('translate') },
    { key: 'dz', label: 'Move Z', type: 'expr', showIf: isType('translate') },
    { key: 'rx', label: 'Rotate X', type: 'expr', showIf: isType('translate') },
    { key: 'ry', label: 'Rotate Y', type: 'expr', showIf: isType('translate') },
    { key: 'rz', label: 'Rotate Z', type: 'expr', showIf: isType('translate') },
    {
      key: '__rotAxis',
      label: 'About axis',
      type: 'select',
      showIf: isType('rotate'),
      options: [
        ['z', 'Z axis'],
        ['x', 'X axis'],
        ['y', 'Y axis']
      ],
      get: (f) => {
        const a = f.rotAxis || [0, 0, 1];
        return Math.abs(a[0]) > 0.5 ? 'x' : Math.abs(a[1]) > 0.5 ? 'y' : 'z';
      },
      set: (f, v) => {
        f.rotAxis = v === 'x' ? [1, 0, 0] : v === 'y' ? [0, 1, 0] : [0, 0, 1];
      }
    },
    { key: 'rotAngle', label: 'Angle', type: 'expr', showIf: isType('rotate') },
    {
      // Set Pivot. Typing three numbers is still there below, but the axis of a
      // part is almost never a number anybody knows: it is a corner, a hole
      // centre, or the middle of a face, and those can be clicked.
      key: '__pivotPick',
      label: 'Set the pivot',
      type: 'pick',
      pick: 'movePivot',
      showIf: isType('rotate'),
      summary: (f) =>
        f.pivot ? f.pivot.map((n) => round(n, 2)).join(', ') : 'The middle of the bodies',
      clear: (f) => {
        f.pivot = null;
      }
    },
    pointField('pivot', 'Or turn about (x, y, z)', isType('rotate')),
    {
      // Pick Direction. An edge gives its own line, a flat face gives the way
      // it faces, so "out from this face by 5" is two clicks and a number.
      key: '__alongPick',
      label: 'Direction',
      type: 'pick',
      pick: 'moveDirection',
      showIf: isType('direction'),
      summary: (f) => f.directionLabel || 'Nothing yet',
      clear: (f) => {
        f.direction = null;
        f.directionLabel = null;
      }
    },
    {
      key: 'alongDistance',
      label: `Distance (${unitLabel()})`,
      type: 'expr',
      showIf: isType('direction')
    },
    {
      key: '__flipAlong',
      label: 'Flip the direction',
      type: 'action',
      showIf: (f) => isType('direction')(f) && !!f.direction,
      run: (f) => {
        f.direction = f.direction.map((n) => -n);
      }
    },
    {
      key: '__fromPick',
      label: 'From',
      type: 'pick',
      pick: 'movePointFrom',
      showIf: isType('points'),
      summary: (f) => (f.fromPoint ? f.fromPoint.map((n) => round(n, 2)).join(', ') : 'Nothing yet'),
      clear: (f) => {
        f.fromPoint = null;
      }
    },
    {
      key: '__toPick',
      label: 'To',
      type: 'pick',
      pick: 'movePointTo',
      showIf: isType('points'),
      summary: (f) => (f.toPoint ? f.toPoint.map((n) => round(n, 2)).join(', ') : 'Nothing yet'),
      clear: (f) => {
        f.toPoint = null;
      }
    }
  ];
}

/** Scale, about the part's own middle or about the origin. */
function scaleFields() {
  return [
    { key: 'factor', label: 'Factor', type: 'expr', showIf: (f) => !f.nonUniform },
    { key: 'nonUniform', label: 'Per axis', type: 'bool' },
    { key: 'sx', label: 'X factor', type: 'expr', showIf: (f) => f.nonUniform },
    { key: 'sy', label: 'Y factor', type: 'expr', showIf: (f) => f.nonUniform },
    { key: 'sz', label: 'Z factor', type: 'expr', showIf: (f) => f.nonUniform },
    {
      key: 'pivotMode',
      label: 'Scale about',
      type: 'select',
      options: [
        ['centre', 'The middle of the part'],
        ['origin', 'The world origin'],
        ['point', 'A point']
      ]
    },
    pointField('pivot', 'Point (x, y, z)', (f) => f.pivotMode === 'point')
  ];
}

/** Split: cut a body with a plane, or with the plane a face lies in. */
/** One splitting tool, written the way its row wants it. */
function splitToolText(tool) {
  if (!tool) return 'nothing';
  if (tool.plane) {
    const name = optionForPlane(tool.plane);
    return String(name).startsWith('c:') ? 'a construction plane' : `the ${name} plane`;
  }
  return 'a face of the model';
}

function splitFields(feature) {
  // Fusion takes several tools at once, and the pieces from one cut are what
  // the next cuts: a box crossed by three planes comes out as eight parts.
  // Doing that as three features instead means three rows in the timeline and
  // three chances to roll back to the wrong one.
  const drop = [];
  (feature?.tools || []).forEach((tool, i) => {
    drop.push({
      key: `__dropTool${i}`,
      label: `Remove ${splitToolText(tool)}`,
      type: 'action',
      run: (f) => {
        f.tools.splice(i, 1);
      }
    });
  });

  return [
    {
      key: '__tools',
      label: 'Split with',
      type: 'pick',
      pick: 'splitFace',
      summary: (f) => {
        const n = (f.tools || []).length;
        if (!n) return 'Nothing yet';
        return n === 1 ? splitToolText(f.tools[0]) : `${n} tools`;
      },
      clear: (f) => {
        f.tools = [];
      }
    },
    ...drop,
    {
      key: '__addPlane',
      label: 'Or add a plane',
      type: 'select',
      options: [['', 'Pick one'], ...planeOptions()],
      get: () => '',
      set: (f, v) => {
        if (!v) return;
        f.tools = f.tools || [];
        f.tools.push({ plane: planeSpecFromOption(v) });
      }
    },
    {
      key: 'splitType',
      label: 'Result',
      type: 'select',
      options: [
        ['body', 'Two bodies'],
        ['keep', 'Keep only the near side']
      ]
    }
  ];
}

/** Coil: a section swept along a helix, to Fusion's own set of options. */
function coilFields(feature) {
  // Taken as an argument, not read off state.editing: the spec is worked out
  // before the dialog is open, so there is nothing to read off yet.
  const type = feature?.coilType || 'revHeight';
  return [
    {
      key: 'plane',
      label: 'Plane',
      type: 'select',
      options: planeOptions(),
      get: (f) => optionForPlane(f.plane),
      set: (f, v) => {
        f.plane = planeSpecFromOption(v);
      }
    },
    {
      key: 'coilType',
      label: 'Type',
      type: 'select',
      options: [
        ['revHeight', 'Revolutions and height'],
        ['revPitch', 'Revolutions and pitch'],
        ['heightPitch', 'Height and pitch'],
        ['spiral', 'Spiral']
      ]
    },
    {
      key: 'rotation',
      label: 'Rotation',
      type: 'select',
      options: [
        ['ccw', 'Counterclockwise'],
        ['cw', 'Clockwise']
      ]
    },
    { key: 'diameter', label: `Diameter (${unitLabel()})`, type: 'expr' },
    // Which two of revolutions, height and pitch are asked for depends on the
    // type, because the third is worked out from them.
    ...(type !== 'heightPitch'
      ? [{ key: 'revolutions', label: 'Revolutions', type: 'expr' }]
      : []),
    ...(['revHeight', 'heightPitch'].includes(type)
      ? [{ key: 'height', label: `Height (${unitLabel()})`, type: 'expr' }]
      : []),
    ...(type !== 'revHeight'
      ? [{ key: 'pitch', label: `Pitch (${unitLabel()})`, type: 'expr' }]
      : []),
    ...(type !== 'spiral'
      ? [{ key: 'angle', label: 'Taper angle (deg)', type: 'expr' }]
      : []),
    {
      key: 'section',
      label: 'Section',
      type: 'select',
      options: [
        ['circular', 'Circular'],
        ['square', 'Square'],
        ['triExt', 'Triangular (external)'],
        ['triInt', 'Triangular (internal)']
      ]
    },
    {
      key: 'sectionPosition',
      label: 'Section position',
      type: 'select',
      options: [
        ['center', 'On centre'],
        ['inside', 'Inside'],
        ['outside', 'Outside']
      ]
    },
    { key: 'sectionSize', label: `Section size (${unitLabel()})`, type: 'expr' },
    {
      key: 'op',
      label: 'Operation',
      type: 'select',
      options: EXTRUDE_OP_OPTIONS,
      get: (f) => f.op || 'new',
      // Coil offered New component and then did not make one. The rebuild puts
      // the body in a component named after the feature, so without a matching
      // entry in the document the coil vanished out of the browser tree and
      // could not be jointed to anything.
      set: (f, v) => {
        f.op = v;
        if (v === 'component') ensureFeatureComponent(f);
      }
    }
  ];
}

/** Emboss: a sketch raised out of a face, or sunk into it. */
function embossFields() {
  return [
    {
      key: '__profiles',
      label: 'Profile',
      type: 'pick',
      pick: 'profiles',
      summary: (f) => extrudeSelectionText(f),
      clear: (f) => {
        f.seeds = [];
      }
    },
    {
      key: '__faces',
      label: 'Faces',
      type: 'pick',
      pick: 'embossFaces',
      summary: (f) => {
        const n = (f.faces || []).length;
        return n ? `${n} face${n === 1 ? '' : 's'}` : 'Nothing yet';
      },
      clear: (f) => {
        f.faces = [];
      }
    },
    {
      key: 'effect',
      label: 'Effect',
      type: 'select',
      options: [
        ['emboss', 'Emboss, add material'],
        ['deboss', 'Deboss, remove material']
      ]
    },
    { key: 'flipNormal', label: 'Flip normal', type: 'bool' },
    { key: 'depth', label: `Depth (${unitLabel()})`, type: 'expr' },
    { key: 'alignX', label: `Move across (${unitLabel()})`, type: 'expr' },
    { key: 'alignY', label: `Move up (${unitLabel()})`, type: 'expr' },
    { key: 'alignAngle', label: 'Rotate (deg)', type: 'expr' }
  ];
}

/** Web: open sketch curves thickened into internal walls. */
function webFields(feature) {
  return [
    {
      key: 'thickness',
      label: `Thickness (${unitLabel()})`,
      type: 'expr'
    },
    {
      key: 'direction',
      label: 'Thickness sits',
      type: 'select',
      options: [
        ['symmetric', 'Half each side of the curve'],
        ['one', 'All to one side']
      ]
    },
    {
      key: 'start',
      label: 'Which side',
      type: 'select',
      showIf: (f) => f.direction === 'one',
      options: [
        ['bottom', 'One way'],
        ['top', 'The other']
      ]
    },
    {
      key: 'extentType',
      label: 'Extent',
      type: 'select',
      options: [
        ['toNext', 'To next'],
        ['depth', 'Depth']
      ]
    },
    ...((feature?.extentType || 'toNext') === 'depth'
      ? [{ key: 'depth', label: `Depth (${unitLabel()})`, type: 'expr' }]
      : []),
    { key: 'flip', label: 'Flip direction', type: 'bool' },
    { key: 'draftAngle', label: 'Draft angle (deg)', type: 'expr' },
    { key: 'extendCurves', label: 'Extend curves to the walls', type: 'bool' },
    { key: 'op', label: 'Operation', type: 'select', options: OP_OPTIONS }
  ];
}

/** Align: put one face of a body flat against another. */
function alignFields() {
  const faceText = (ref) => {
    if (!ref) return 'Nothing yet';
    return ref.plane ? `The ${ref.plane} plane` : 'A face of the model';
  };
  return [
    {
      key: '__bodies',
      label: 'Bodies to move',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) =>
        Array.isArray(f.bodies) ? `${f.bodies.length} chosen` : 'Every body',
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    {
      key: '__from',
      label: 'From',
      type: 'pick',
      pick: 'alignFrom',
      summary: (f) => faceText(f.from),
      clear: (f) => {
        f.from = null;
      }
    },
    {
      key: '__to',
      label: 'To',
      type: 'pick',
      pick: 'alignTo',
      summary: (f) => faceText(f.to),
      clear: (f) => {
        f.to = null;
      }
    },
    { key: 'flip', label: 'Flip', type: 'bool' },
    { key: 'angle', label: 'Turn about the target (deg)', type: 'expr' }
  ];
}

/** Delete Face: fill a round hole back in. */
function deleteFaceFields() {
  return [
    {
      key: '__faces',
      label: 'Faces',
      type: 'pick',
      pick: 'draftFaces',
      summary: (f) => {
        const n = (f.faces || []).length;
        return n ? `${n} face${n === 1 ? '' : 's'}` : 'Nothing yet';
      },
      clear: (f) => {
        f.faces = [];
      }
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Fills a round bore with its own cylinder. Anything else is refused rather than guessed at.'
    }
  ];
}

/** Silhouette Split: cut a body at its outline seen from a direction. */
function silhouetteFields() {
  return [
    {
      key: '__direction',
      label: 'View direction',
      type: 'pick',
      pick: 'silhouetteDir',
      summary: (f) =>
        f.direction
          ? f.direction.plane
            ? `Along the ${f.direction.plane} normal`
            : "Along a face's normal"
          : 'Nothing yet',
      clear: (f) => {
        f.direction = null;
      }
    },
    {
      key: '__bodies',
      label: 'Target body',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) =>
        Array.isArray(f.bodies) ? `${f.bodies.length} chosen` : 'Every body',
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Splits at the parting line, which has to be flat. Fusion asks for that too.'
    }
  ];
}

/** Press Pull: push or pull the chosen faces along their own normals. */
function pressPullFields() {
  return [
    {
      key: '__faces',
      label: 'Faces',
      type: 'pick',
      pick: 'draftFaces',
      summary: (f) => {
        const n = (f.faces || []).length;
        return n ? `${n} face${n === 1 ? '' : 's'}` : 'Nothing yet';
      },
      clear: (f) => {
        f.faces = [];
      }
    },
    { key: 'distance', label: 'Offset', type: 'expr' }
  ];
}

/** Mirror: which bodies, and the plane to reflect them in. */
function mirrorFields() {
  return [
    {
      key: '__bodies',
      label: 'Bodies',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) =>
        !f.bodies || f.bodies === 'all'
          ? 'Every body'
          : `${f.bodies.length} body${f.bodies.length === 1 ? '' : 's'}`,
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    {
      key: '__plane',
      label: 'Mirror plane',
      type: 'pick',
      pick: 'mirrorPlane',
      summary: (f) => objectRefText(f.planeRef) ,
      clear: (f) => {
        f.planeRef = null;
      }
    },
    {
      key: 'plane',
      label: 'Or a plane by name',
      type: 'select',
      options: planeOptions(),
      get: (f) => optionForPlane(f.plane),
      set: (f, v) => {
        f.plane = planeSpecFromOption(v);
        f.planeRef = null;
      }
    },
    {
      key: 'op',
      label: 'Result',
      type: 'select',
      options: [
        ['separate', 'Separate bodies'],
        ['join', 'One body']
      ]
    }
  ];
}

/** Combine: one target, any number of tools, and what to do with them. */
function combineFields() {
  const named = (state.result?.bodies || []).map((b) => [b.id, b.name]);
  return [
    {
      key: '__target',
      label: 'Target body',
      type: 'pick',
      pick: 'combineTarget',
      summary: (f) => named.find(([id]) => id === f.target)?.[1] || 'Nothing yet',
      clear: (f) => {
        f.target = null;
      }
    },
    {
      key: 'target',
      label: 'Or a target by name',
      type: 'select',
      options: named
    },
    {
      key: '__tools',
      label: 'Tool bodies',
      type: 'pick',
      pick: 'combineTools',
      summary: (f) => {
        const n = (f.tools || []).length;
        return n ? `${n} body${n === 1 ? '' : 's'}` : 'Nothing yet';
      },
      clear: (f) => {
        f.tools = [];
      }
    },
    {
      key: 'op',
      label: 'Operation',
      type: 'select',
      options: [
        ['join', 'Join'],
        ['cut', 'Cut'],
        ['intersect', 'Intersect']
      ]
    },
    { key: 'keepTools', label: 'Keep tool bodies', type: 'bool' },
    { key: 'newComponent', label: 'Result in a new component', type: 'bool' }
  ];
}

function holeFields() {
  return [
    {
      key: 'holeType',
      label: 'Type',
      type: 'select',
      options: [
        ['simple', 'Simple'],
        ['counterbore', 'Counterbore'],
        ['countersink', 'Countersink']
      ]
    },
    { key: 'diameter', label: 'Diameter', type: 'expr' },
    {
      key: 'cbDiameter',
      label: 'Counterbore diameter',
      type: 'expr',
      showIf: (f) => f.holeType === 'counterbore'
    },
    {
      key: 'cbDepth',
      label: 'Counterbore depth',
      type: 'expr',
      showIf: (f) => f.holeType === 'counterbore'
    },
    {
      key: 'csDiameter',
      label: 'Countersink diameter',
      type: 'expr',
      showIf: (f) => f.holeType === 'countersink'
    },
    {
      key: 'csAngle',
      label: 'Countersink angle',
      type: 'expr',
      showIf: (f) => f.holeType === 'countersink'
    },
    {
      key: 'flip',
      label: 'Direction',
      type: 'select',
      options: [
        ['no', 'Along plane normal'],
        ['yes', 'Against plane normal']
      ],
      get: (f) => (f.flip ? 'yes' : 'no'),
      set: (f, v) => {
        f.flip = v === 'yes';
      }
    },
    {
      key: 'extent',
      label: 'Extent',
      type: 'select',
      options: [
        ['distance', 'Distance'],
        ['object', 'To object'],
        ['all', 'All']
      ]
    },
    { key: 'depth', label: 'Depth', type: 'expr', showIf: (f) => f.extent === 'distance' },
    {
      key: '__toObject',
      label: 'Down to',
      type: 'pick',
      pick: 'toObject',
      showIf: (f) => f.extent === 'object',
      summary: (f) => objectRefText(f.toObject),
      clear: (f) => {
        f.toObject = null;
      }
    },
    {
      key: 'toOffset',
      label: 'Object offset',
      type: 'expr',
      showIf: (f) => f.extent === 'object'
    },
    {
      key: 'tipAngle',
      label: 'Drill tip angle',
      type: 'expr',
      showIf: (f) => f.extent === 'distance'
    },
    { key: 'tapped', label: 'Tapped', type: 'bool' },
    { key: 'pitch', label: 'Thread pitch', type: 'expr', showIf: (f) => f.tapped },
    { key: 'clearance', label: 'Print clearance', type: 'expr', showIf: (f) => f.tapped },
    { key: 'leftHanded', label: 'Left handed', type: 'bool', showIf: (f) => f.tapped },
    { key: 'op', label: 'Operation', type: 'select', options: OP_OPTIONS },
    TARGETS_FIELD
  ];
}

const PATTERN_RESULT = {
  key: 'op',
  label: 'Result',
  type: 'select',
  options: [
    ['separate', 'Separate bodies'],
    ['join', 'One body']
  ]
};

const SPACING_TYPE = {
  key: 'spacingType',
  label: 'Distance type',
  type: 'select',
  options: [
    ['spacing', 'Spacing between copies'],
    ['extent', 'Whole distance covered']
  ]
};

const SYMMETRY = {
  key: 'symmetry',
  label: 'Symmetric',
  type: 'select',
  options: [
    ['no', 'No'],
    ['yes', 'Yes']
  ]
};

/** Instances left out of a pattern, written as a list to type into. */
const SKIP_FIELD = {
  key: '__skip',
  label: 'Skip instances',
  type: 'expr',
  get: (f) => (f.skipInstances || []).join(' '),
  set: (f, v) => {
    f.skipInstances = String(v)
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
};

function patternRectFields() {
  return [
    { key: 'count1', label: 'Count along X', type: 'expr' },
    { key: 'spacing1', label: 'X distance', type: 'expr' },
    { key: 'count2', label: 'Count along Y', type: 'expr' },
    { key: 'spacing2', label: 'Y distance', type: 'expr' },
    SPACING_TYPE,
    SYMMETRY,
    SKIP_FIELD,
    PATTERN_RESULT
  ];
}

function patternCircFields() {
  return [
    { key: 'count', label: 'Count', type: 'expr' },
    { key: 'angle', label: 'Total angle', type: 'expr' },
    {
      key: '__axis',
      label: 'Axis',
      type: 'select',
      options: [
        ['z', 'Z axis'],
        ['x', 'X axis'],
        ['y', 'Y axis']
      ],
      get: (f) => {
        const a = f.axis || [0, 0, 1];
        return Math.abs(a[0]) > 0.5 ? 'x' : Math.abs(a[1]) > 0.5 ? 'y' : 'z';
      },
      set: (f, v) => {
        f.axis = v === 'x' ? [1, 0, 0] : v === 'y' ? [0, 1, 0] : [0, 0, 1];
      }
    },
    SYMMETRY,
    SKIP_FIELD,
    PATTERN_RESULT
  ];
}

function shellFields() {
  return [
    {
      key: '__openFaces',
      label: 'Faces to leave open',
      type: 'pick',
      pick: 'openFaces',
      summary: (f) => {
        const n = (f.openFaces || []).length;
        return n ? `${n} face${n === 1 ? '' : 's'}` : 'None, closed all round';
      },
      clear: (f) => {
        f.openFaces = [];
      }
    },
    {
      // The mouth of a shelled part is usually one surface that the topology
      // happens to hold as several, a rounded rim being the ordinary case.
      // Curved faces are kept here, unlike Draft: opening one is fine, it is
      // only leaning one that has nothing to lean about.
      key: 'tangentChain',
      label: 'Follow tangent faces',
      type: 'bool',
      get: (f) => f.tangentChain !== false,
      set: (f, v) => {
        f.tangentChain = !!v;
      }
    },
    {
      key: 'thickness',
      label: (f) => (f.side === 'both' ? 'Inside thickness' : 'Wall thickness'),
      type: 'expr'
    },
    {
      // Straddling the surface takes a thickness each way. One number halved
      // was the old reading, and it could not make a wall that sits mostly
      // outside the shape it came from.
      key: 'thicknessOut',
      label: 'Outside thickness',
      type: 'expr',
      showIf: (f) => f.side === 'both'
    },
    {
      key: 'side',
      label: 'Direction',
      type: 'select',
      options: [
        ['inside', 'Inside'],
        ['outside', 'Outside'],
        ['both', 'Both']
      ]
    }
  ];
}

function draftFields() {
  return [
    {
      key: '__faces',
      label: 'Faces',
      type: 'pick',
      pick: 'draftFaces',
      summary: (f) => {
        const n = (f.faces || []).length;
        return n ? `${n} face${n === 1 ? '' : 's'}` : 'Nothing yet';
      },
      clear: (f) => {
        f.faces = [];
      }
    },
    {
      // On by default, the same as Fusion. One click takes the whole run of
      // faces that carry on smoothly from the one picked, so a rounded wall is
      // drafted as the one wall it looks like.
      key: 'tangentChain',
      label: 'Follow tangent faces',
      type: 'bool',
      get: (f) => f.tangentChain !== false,
      set: (f, v) => {
        f.tangentChain = !!v;
      }
    },
    {
      key: '__neutral',
      label: 'Neutral plane',
      type: 'pick',
      pick: 'neutral',
      summary: (f) => objectRefText(f.neutralRef) ,
      clear: (f) => {
        f.neutralRef = null;
      }
    },
    {
      key: '__neutralName',
      label: 'Or a plane by name',
      type: 'select',
      options: planeOptions(),
      get: (f) => optionForPlane(f.neutral),
      set: (f, v) => {
        f.neutral = planeSpecFromOption(v);
        f.neutralRef = null;
      }
    },
    { key: 'angle', label: 'Draft angle', type: 'expr' },
    {
      key: 'sides',
      label: 'Draft sides',
      type: 'select',
      options: [
        ['one', 'One side'],
        ['two', 'Two sides, an angle each'],
        ['symmetric', 'Symmetric']
      ]
    },
    {
      key: 'angle2',
      label: 'Angle on the other side',
      type: 'expr',
      showIf: (f) => f.sides === 'two'
    },
    {
      // Which way the mould opens. The same faces drafted the other way round.
      key: 'flipPull',
      label: 'Flip pull direction',
      type: 'bool'
    }
  ];
}

function revolveAxisText(f) {
  const a = f.axis;
  if (!a) return 'Nothing yet';
  if (a.type === 'entity') {
    const sk = f.sketch ? state.doc.sketches[f.sketch] : null;
    const ent = (sk?.entities || []).find((e) => e.id === a.entity);
    return ent?.centerline ? 'The sketch centreline' : 'A sketch line';
  }
  if (a.type === 'edge') return 'A model edge';
  if (a.type === 'construction') return 'A construction axis';
  if (a.type === 'world') return `World ${String(a.worldAxis).toUpperCase()} axis`;
  return `Sketch ${a.type.toUpperCase()} axis`;
}

/**
 * The Revolve dialog, laid out the way Extrude is: what to turn, what to turn
 * it about, which way, how far, and what to do with the result.
 */
function revolveFields() {
  const named = [
    ['', 'Picked in the canvas'],
    ['y', 'Sketch Y axis'],
    ['x', 'Sketch X axis'],
    ['world:x', 'World X axis'],
    ['world:y', 'World Y axis'],
    ['world:z', 'World Z axis']
  ];
  for (const c of state.doc.construction || []) {
    if (c.entry && String(c.entry.type).startsWith('axis')) {
      named.push([`c:${c.entry.id}`, c.name || 'Construction axis']);
    }
  }

  return [
    {
      key: '__profiles',
      label: 'Profile',
      type: 'pick',
      pick: 'profiles',
      summary: extrudeSelectionText,
      clear: (f) => {
        f.seeds = [];
        f.faces = [];
      }
    },
    {
      key: '__axis',
      label: 'Axis',
      type: 'pick',
      pick: 'axis',
      summary: revolveAxisText,
      clear: (f) => {
        f.axis = { type: 'y' };
      }
    },
    {
      // Fusion has this checked by default. Off, an axis that is not in the
      // profile's plane is refused, which is what this always did.
      key: 'projectAxis',
      label: 'Project axis onto the profile plane',
      type: 'bool'
    },
    {
      key: '__namedAxis',
      label: 'Or an axis by name',
      type: 'select',
      options: named,
      get: (f) => {
        const a = f.axis || {};
        if (a.type === 'world') return `world:${a.worldAxis}`;
        if (a.type === 'construction') return `c:${a.id}`;
        // An axis chosen by pointing has no name in this list, and saying it is
        // the sketch Y axis when it is not would be a lie.
        if (a.type === 'entity' || a.type === 'edge') return '';
        return a.type === 'x' ? 'x' : 'y';
      },
      set: (f, v) => {
        if (!v) return;
        if (v.startsWith('world:')) f.axis = { type: 'world', worldAxis: v.slice(6) };
        else if (v.startsWith('c:')) f.axis = { type: 'construction', id: v.slice(2) };
        else f.axis = { type: v };
      }
    },
    {
      key: 'direction',
      label: 'Direction',
      type: 'select',
      options: [
        ['one', 'One side'],
        ['two', 'Two sides'],
        ['symmetric', 'Symmetric']
      ],
      showIf: (f) => f.extent !== 'full'
    },
    {
      key: 'measure',
      label: 'Measurement',
      type: 'select',
      showIf: (f) => f.extent !== 'full' && f.direction === 'symmetric',
      options: [
        ['whole', 'Whole angle'],
        ['half', 'Half angle']
      ]
    },
    {
      key: 'extent',
      label: 'Extent',
      type: 'select',
      options: [
        ['angle', 'Angle'],
        ['object', 'To object'],
        ['full', 'Full']
      ]
    },
    { key: 'angle', label: 'Angle', type: 'expr', showIf: (f) => f.extent === 'angle' },
    {
      key: 'angle2',
      label: 'Second angle',
      type: 'expr',
      showIf: (f) => f.extent === 'angle' && f.direction === 'two'
    },
    {
      key: '__toObject',
      label: 'Up to',
      type: 'pick',
      pick: 'toObject',
      showIf: (f) => f.extent === 'object',
      summary: (f) => objectRefText(f.toObject),
      clear: (f) => {
        f.toObject = null;
      }
    },
    {
      key: 'toOffset',
      label: 'Angle offset',
      type: 'expr',
      showIf: (f) => f.extent === 'object'
    },
    { key: 'op', label: 'Operation', type: 'select', options: EXTRUDE_OP_OPTIONS,
      get: (f) => f.op || 'new',
      set: (f, v) => {
        f.op = v;
        if (v === 'component') ensureFeatureComponent(f);
      } },
    {
      key: '__targets',
      label: 'Objects to cut',
      type: 'pick',
      pick: 'targets',
      showIf: (f) => ['cut', 'intersect', 'join'].includes(f.op),
      summary: (f) =>
        !f.targets || f.targets === 'all'
          ? 'Every body'
          : `${f.targets.length} body${f.targets.length === 1 ? '' : 's'}`,
      clear: (f) => {
        f.targets = 'all';
      }
    }
  ];
}

const TARGETS_FIELD = {
  key: '__targets',
  label: 'Objects to cut',
  type: 'pick',
  pick: 'targets',
  showIf: (f) => ['cut', 'intersect', 'join'].includes(f.op),
  summary: (f) =>
    !f.targets || f.targets === 'all'
      ? 'Every body'
      : `${f.targets.length} body${f.targets.length === 1 ? '' : 's'}`,
  clear: (f) => {
    f.targets = 'all';
  }
};

function curveRefText(ref) {
  if (!ref) return 'Nothing yet';
  if (ref.edges) return `${ref.edges.length} model edge(s)`;
  const sk = state.doc.sketches[ref.sketch];
  return sk ? sk.name : 'A sketch curve';
}

/** Sketches that hold something a path or rail could be chained from. */
function pathSketchOptions() {
  const out = [['', 'Picked in the canvas']];
  for (const f of state.doc.features) {
    if (f.type !== 'sketch') continue;
    const sk = state.doc.sketches[f.sketch];
    if (sk && sk.entities.some((e) => e.type !== 'point')) out.push([sk.id, sk.name]);
  }
  return out;
}

const CURVE_PICK_FIELDS = (key, label, showIf) => [
  {
    key: `__${key}`,
    label,
    type: 'pick',
    pick: key,
    showIf,
    summary: (f) => curveRefText(f[key]),
    clear: (f) => {
      f[key] = null;
    }
  },
  {
    key: `__${key}Name`,
    label: `Or ${label.toLowerCase()} by name`,
    type: 'select',
    showIf,
    options: pathSketchOptions(),
    get: (f) => (f[key] && f[key].sketch ? f[key].sketch : ''),
    set: (f, v) => {
      if (v) f[key] = { sketch: v };
    }
  }
];

/**
 * The Sweep dialog. What to sweep, along what, optionally guided by a rail,
 * then how far along, how it leans and turns, and what to do with the result.
 */
function sweepFields() {
  const railed = (f) => f.sweepType === 'rail';
  return [
    {
      key: 'sweepType',
      label: 'Type',
      type: 'select',
      options: [
        ['path', 'Single path'],
        ['rail', 'Path and guide rail']
      ]
    },
    {
      key: '__profiles',
      label: 'Profile',
      type: 'pick',
      pick: 'profiles',
      summary: extrudeSelectionText,
      clear: (f) => {
        f.seeds = [];
        f.faces = [];
      }
    },
    ...CURVE_PICK_FIELDS('path', 'Path'),
    ...CURVE_PICK_FIELDS('rail', 'Guide rail', railed),
    {
      key: 'profileScaling',
      label: 'Profile scaling',
      type: 'select',
      showIf: railed,
      options: [
        ['scale', 'Scale'],
        ['stretch', 'Stretch'],
        ['none', 'None']
      ]
    },
    { key: 'distance', label: 'Distance (0 to 1)', type: 'expr' },
    { key: 'taper', label: 'Taper angle', type: 'expr', showIf: (f) => !railed(f) },
    { key: 'twist', label: 'Twist angle', type: 'expr' },
    {
      key: 'orientation',
      label: 'Orientation',
      type: 'select',
      options: [
        ['perpendicular', 'Perpendicular'],
        ['parallel', 'Parallel']
      ]
    },
    { key: 'op', label: 'Operation', type: 'select', options: EXTRUDE_OP_OPTIONS,
      get: (f) => f.op || 'new',
      set: (f, v) => {
        f.op = v;
        if (v === 'component') ensureFeatureComponent(f);
      } },
    TARGETS_FIELD
  ];
}


function loftSectionText(f) {
  const n = (f.sections || []).length;
  if (!n) return 'Nothing yet';
  return `${n} section${n === 1 ? '' : 's'}`;
}

/**
 * What one loft section is, written short enough for a row.
 *
 * Order is the whole point of the list, so each row says where it sits as well
 * as what it is.
 */
function loftSectionRowText(entry, i) {
  const what = entry?.point
    ? 'a sketch point'
    : entry?.face
      ? 'a face'
      : entry?.seed
        ? 'a profile'
        : 'a section';
  return `${i + 1}. ${what}`;
}

/** The Loft dialog: the sections in order, how the ends leave, and any rails. */
function loftFields(feature) {
  const CONDITIONS = [
    ['connected', 'Connected'],
    ['tangent', 'Tangent']
  ];
  // Fusion lets the profile order be changed, and the order is what a loft is:
  // the same three sections in a different order is a different shape. Clicking
  // them again in the right order was the only way to fix a mis-ordered loft,
  // which on a five section one means five more picks and getting it right the
  // second time.
  const reorder = [];
  (feature?.sections || []).forEach((entry, i) => {
    if (i === 0) return;
    reorder.push({
      key: `__up${i}`,
      label: `Move ${loftSectionRowText(entry, i)} earlier`,
      type: 'action',
      run: (f) => {
        const list = f.sections;
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
      }
    });
  });

  return [
    {
      key: '__sections',
      label: 'Profiles',
      type: 'pick',
      pick: 'sections',
      summary: loftSectionText,
      clear: (f) => {
        f.sections = [];
      }
    },
    ...reorder,
    { key: 'startCondition', label: 'Start', type: 'select', options: CONDITIONS },
    {
      key: 'startWeight',
      label: 'Start weight',
      type: 'expr',
      showIf: (f) => f.startCondition === 'tangent'
    },
    { key: 'endCondition', label: 'End', type: 'select', options: CONDITIONS },
    {
      key: 'endWeight',
      label: 'End weight',
      type: 'expr',
      showIf: (f) => f.endCondition === 'tangent'
    },
    {
      key: '__rails',
      label: 'Guide rails',
      type: 'pick',
      pick: 'rails',
      summary: (f) => {
        const n = (f.rails || []).length;
        return n ? `${n} rail${n === 1 ? '' : 's'}` : 'None';
      },
      clear: (f) => {
        f.rails = [];
      }
    },
    { key: 'closed', label: 'Closed loop', type: 'bool' },
    { key: 'op', label: 'Operation', type: 'select', options: EXTRUDE_OP_OPTIONS,
      get: (f) => f.op || 'new',
      set: (f, v) => {
        f.op = v;
        if (v === 'component') ensureFeatureComponent(f);
      } },
    TARGETS_FIELD
  ];
}

/** A new revolve, set up from whatever happens to be selected. */
function newRevolveFeature() {
  const base = newExtrudeFeature();
  return {
    ...base,
    type: 'revolve',
    axis: { type: 'y' },
    // Checked by default, the same as Fusion. An axis picked in the canvas that
    // happens to sit off the profile's plane is flattened onto it rather than
    // turned away, which is what a person means when they point at it.
    projectAxis: true,
    direction: 'one',
    measure: 'whole',
    extent: 'angle',
    angle: '360',
    angle2: '0',
    toOffset: '0'
  };
}

/** A new extrude, set up from whatever happens to be selected. */
/** A component of its own for a feature whose operation asks for one. */
function ensureFeatureComponent(feature) {
  const id = `${feature.id}:c`;
  if (state.doc.components.some((c) => c.id === id)) return id;
  const c = newComponent(`Component ${state.doc.components.length + 1}`);
  c.id = id;
  if (!state.doc.components.length) c.grounded = true;
  state.doc.components.push(c);
  return id;
}

function newExtrudeFeature() {
  const sketchId = activeSketchId();
  const seeds = sketchId ? activeSeeds(sketchId) : null;
  const faces = [...state.selection.faces]
    .map((key) => {
      const { bodyId, index } = splitKey(key);
      const record = (state.records || []).find((r) => r.id === bodyId);
      const face = record?.topology?.faces[index];
      return face && face.planar ? { bodyId, face: faceReference(face) } : null;
    })
    .filter(Boolean);

  // Picking the sketch itself in the browser or the timeline means all of it,
  // in one step, which is the other way Fusion lets you choose what to extrude.
  const wholeSketch = [...state.selection.features].some((id) => {
    const f = state.doc.features.find((x) => x.id === id);
    return f?.type === 'sketch' && f.sketch === sketchId;
  });
  const hasPick = (seeds && seeds.length) || faces.length;
  const onFace = !!state.doc.sketches[sketchId]?.plane?.face;
  // Join only where the sketch is drawn on a body, which is what "add this to
  // that" looks like. A sketch on an origin plane, or on a plane of its own, is
  // a new part: joining it made two rectangles drawn a hundred millimetres
  // apart come out as one body with two lumps in it, which is not something
  // anybody asked for and is a nuisance to undo.
  const defaultOp = state.result?.bodies.length && (onFace || faces.length) ? 'join' : 'new';

  return {
    id: uid('f'),
    type: 'extrude',
    // Only claim a sketch when something in one was actually chosen. Guessing
    // the most recent one means the first profile clicked can belong to a
    // different sketch and get turned away, which for a sweep is every time,
    // because the newest sketch there is the path.
    sketch: wholeSketch || hasPick ? sketchId : null,
    // Nothing chosen means nothing chosen. It used to fall back to every
    // profile in the last sketch, which is how an extrude could happen to
    // something you had not pointed at.
    seeds: wholeSketch ? null : hasPick ? seeds || [] : [],
    faces,
    kind: 'solid',
    start: 'profile',
    startOffset: '0',
    direction: 'one',
    measure: 'whole',
    extent: 'distance',
    // Zero, so nothing appears until a length is given.
    distance: '0',
    distance2: '0',
    extent2: 'distance',
    extend: 'face',
    toOffset: '0',
    taper: '0',
    taper2: '0',
    twist: '0',
    wall: '2',
    wallLocation: 'side1',
    flip: onFace && defaultOp === 'cut',
    op: defaultOp,
    targets: 'all'
  };
}

function startFeatureDialog(type) {
  if (state.sketcher.active) finishSketch();

  const sketchId = activeSketchId();
  const seeds = sketchId ? activeSeeds(sketchId) : null;

  let feature;
  const opOptions = [
    ['new', 'New body'],
    ['join', 'Join'],
    ['cut', 'Cut'],
    ['intersect', 'Intersect']
  ];

  if (type === 'extrude') {
    if (!sketchId && !state.selection.faces.size) {
      setStatus('Make a sketch first, or select a planar face.');
      return;
    }
    feature = newExtrudeFeature();
    // "When you invoke the Extrude tool, and there is only one profile visible
    // in your design, it is automatically selected." Fusion's own Extrude
    // reference says so, and it is the difference between drawing a rectangle
    // and having a solid, and drawing a rectangle and being asked which of the
    // one things on screen you meant.
    const only = onlyVisibleProfile();
    if (only && !feature.seeds?.length && !feature.faces.length) {
      feature.sketch = only.sketch;
      feature.seeds = [only.seed];
    }
    openFeatureEditor(feature, 'Extrude', extrudeFields());
    // Otherwise it opens ready to be pointed at, so nothing has to be picked
    // before reaching for the command.
    if (!feature.seeds?.length && !feature.faces.length) {
      setEditPick('profiles');
      setStatus('Click the profiles or planar faces to extrude.');
    } else {
      setEditPick('profiles');
      setStatus('Drag the arrow, or type a distance. Click profiles to add more.');
    }
    return;
  }

  if (type === 'revolve') {
    if (!sketchId && !state.selection.faces.size) {
      setStatus('Make a sketch first, or select a planar face.');
      return;
    }
    feature = newRevolveFeature();
    // One profile on screen is the one meant, the same rule Extrude follows and
    // the same one Fusion states for both.
    const onlyR = onlyVisibleProfile();
    if (onlyR && !feature.seeds?.length && !feature.faces.length) {
      feature.sketch = onlyR.sketch;
      feature.seeds = [onlyR.seed];
    }
    // A centreline is the sketch saying what the part turns about, so a revolve
    // takes it rather than defaulting to the sketch Y axis and being corrected.
    // Only when there is exactly one: two centrelines is a question, and
    // guessing at it is worse than asking.
    {
      const sk = feature.sketch ? state.doc.sketches[feature.sketch] : null;
      const lines = (sk?.entities || []).filter((e) => e.type === 'line' && e.centerline);
      if (lines.length === 1) feature.axis = { type: 'entity', entity: lines[0].id };
    }
    openFeatureEditor(feature, 'Revolve', revolveFields());
    if (!feature.seeds.length && !feature.faces.length) {
      setEditPick('profiles');
      setStatus('Click the profiles or planar faces to revolve.');
    }
    return;
  }

  if (type === 'hole') {
    if (!sketchId) {
      setStatus('Make a sketch with points where the holes go.');
      return;
    }
    const sk = state.doc.sketches[sketchId];
    const pointIdx = sk.entities.filter((e) => e.type === 'point').map((e) => e.p);
    const centres = sk.entities.filter((e) => e.type === 'circle').map((e) => e.c);
    const all = [...new Set([...pointIdx, ...centres])];
    if (!all.length) {
      setStatus('That sketch has no points or circles to place holes at.');
      return;
    }
    feature = {
      id: uid('f'),
      type: 'hole',
      sketch: sketchId,
      points: all,
      holeType: 'simple',
      extent: 'all',
      toOffset: '0',
      tapped: false,
      pitch: '1.5',
      clearance: '0.2',
      leftHanded: false,
      op: 'cut',
      targets: 'all',
      diameter: '5',
      depth: '10',
      through: true,
      flip: false,
      counterbore: false,
      countersink: false,
      cbDiameter: '10',
      cbDepth: '3',
      csDiameter: '10',
      csAngle: '90',
      tipAngle: '0'
    };
    openFeatureEditor(feature, 'Hole', holeFields());
    return;
  }

  if (type === 'mirror') {
    feature = {
      id: uid('f'),
      type: 'mirror',
      bodies: bodySelectionOrAll(),
      plane: 'YZ',
      op: 'join'
    };
    openFeatureEditor(feature, 'Mirror', mirrorFields());
    return;
  }

  if (type === 'patternRect') {
    feature = {
      id: uid('f'),
      type: 'patternRect',
      bodies: bodySelectionOrAll(),
      dir1: [1, 0, 0],
      dir2: [0, 1, 0],
      count1: '3',
      spacing1: '20',
      count2: '1',
      spacing2: '20',
      op: 'join'
    };
    openFeatureEditor(feature, 'Rectangular Pattern', patternRectFields());
    return;
  }

  if (type === 'patternCircular') {
    feature = {
      id: uid('f'),
      type: 'patternCircular',
      bodies: bodySelectionOrAll(),
      axis: [0, 0, 1],
      center: [0, 0, 0],
      count: '6',
      angle: '360',
      op: 'join'
    };
    openFeatureEditor(feature, 'Circular Pattern', patternCircFields());
    return;
  }

  if (type === 'move') {
    feature = {
      id: uid('f'),
      type: 'move',
      moveType: 'translate',
      rotAxis: [0, 0, 1],
      rotAngle: '0',
      bodies: bodySelectionOrAll(),
      dx: '0',
      dy: '0',
      dz: '0',
      rx: '0',
      ry: '0',
      rz: '0',
      copy: false,
      direction: null,
      directionLabel: null,
      alongDistance: '10'
    };
    openFeatureEditor(feature, 'Move', moveFields());
    return;
  }

  if (type === 'scale') {
    feature = {
      id: uid('f'),
      type: 'scale',
      pivotMode: 'centre',
      bodies: bodySelectionOrAll(),
      factor: '1',
      nonUniform: false,
      sx: '1',
      sy: '1',
      sz: '1'
    };
    openFeatureEditor(feature, 'Scale', scaleFields());
    return;
  }

  if (type === 'combine') {
    const bodies = state.result?.bodies || [];
    if (bodies.length < 2) {
      setStatus('Combine needs at least two bodies.');
      return;
    }
    feature = {
      id: uid('f'),
      type: 'combine',
      target: bodies[0].id,
      tools: [bodies[1].id],
      op: 'join',
      keepTools: false
    };
    openFeatureEditor(feature, 'Combine', combineFields());
  }
}

/**
 * Project: copy model edges into the sketch as reference geometry.
 *
 * The copy is a snapshot, not a live link. Fusion's projected geometry updates
 * when the model does; this does not, so re-project after a change that moves
 * what you traced. The copied curves are fixed, so the solver treats them as
 * the anchors they are meant to be.
 */
/**
 * Where the chosen bodies cross this sketch's plane, brought in as geometry.
 *
 * Fusion's Intersect. It is stored as a reference to the body rather than as
 * the curves it produced, so the section moves when the model does, which is
 * the whole reason to take a section rather than to draw one.
 */
function cmdIntersect() {
  if (!state.sketcher.active) {
    setStatus('Intersect works inside a sketch.');
    return;
  }
  const ids = state.selection.bodies.size
    ? [...state.selection.bodies]
    : (state.result?.bodies || []).map((b) => b.id);
  if (!ids.length) {
    setStatus('Nothing to take a section of yet.');
    return;
  }

  const sk = state.sketcher.sketch;
  pushUndo('intersect');
  sk.intersections = sk.intersections || [];
  let added = 0;
  for (const bodyId of ids) {
    if (sk.intersections.some((r) => r.bodyId === bodyId)) continue;
    sk.intersections.push({ bodyId });
    added++;
  }
  clearGeometrySelection(false);
  state.dirty = true;
  rebuildAll();

  const got = state.sketcher.derived?.entities?.length || 0;
  if (!got) {
    // Put it back rather than leaving a reference that produces nothing.
    sk.intersections = sk.intersections.filter((r) => !ids.includes(r.bodyId));
    rebuildAll();
    setStatus('Nothing crosses this sketch plane.');
    return;
  }
  setStatus(
    added
      ? `Section taken through ${added} bod${added === 1 ? 'y' : 'ies'}. It follows the model.`
      : 'Those bodies are already sectioned into this sketch.'
  );
}

/**
 * Bring model edges into the sketch as they are, not flattened onto its plane.
 *
 * The difference from Project is the whole point: Project answers "where does
 * this edge sit when squashed onto my plane", which is what you want for
 * tracing an outline. Include answers "give me that edge", which is what you
 * want when it is going to be swept along or measured against, and it is only
 * possible in a sketch that can hold a curve which leaves its plane.
 */
function cmdInclude3D() {
  if (!state.sketcher.active) {
    setStatus('Include 3D Geometry works inside a sketch.');
    return;
  }
  const edges = gatherSelectedEdges();
  if (!edges.length) {
    setStatus('Select model edges or a face in the viewport first.');
    return;
  }

  pushUndo('include 3D geometry');
  const runs = edges.map((e) => e.points).filter((pts) => pts?.length > 1);
  const made = state.sketcher.insertWorldCurves(runs, { asLines: false });
  clearGeometrySelection(false);
  state.dirty = true;
  rebuildAll();

  setStatus(
    made
      ? `${made} curve${made === 1 ? '' : 's'} included. ${
          state.sketcher.sketch.is3d
            ? 'This sketch is three dimensional now.'
            : 'They happened to lie in the plane.'
        }`
      : 'Nothing there could be included.'
  );
}

/**
 * The curve where two bodies meet.
 *
 * Taken from the solid they share: its surface is made partly of one body and
 * partly of the other, and the edges where those two parts meet are exactly the
 * intersection. Which triangle came from which body is something the kernel
 * carries, so this is a matter of reading the answer rather than working it out
 * geometrically.
 */
function cmdIntersectionCurve() {
  if (!state.sketcher.active) {
    setStatus('Intersection Curve works inside a sketch.');
    return;
  }
  const chosen = [...state.selection.bodies];
  const bodies = (state.result?.bodies || []).filter((b) =>
    chosen.length ? chosen.includes(b.id) : true
  );
  if (bodies.length < 2) {
    setStatus('Select two bodies that overlap, or have two in the model.');
    return;
  }

  const scope = new K.Scope();
  const runs = [];
  try {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        runs.push(...intersectionRuns(bodies[i].solid, bodies[j].solid, scope));
      }
    }
  } catch (err) {
    scope.dispose();
    setStatus(`Could not work that out: ${err.message}`);
    return;
  }
  scope.dispose();

  if (!runs.length) {
    setStatus('Those bodies do not cross, so there is no curve where they meet.');
    return;
  }

  pushUndo('intersection curve');
  const made = state.sketcher.insertWorldCurves(runs, { asLines: true });
  clearGeometrySelection(false);
  state.dirty = true;
  rebuildAll();
  setStatus(
    `${runs.length} intersection curve${runs.length === 1 ? '' : 's'}, ${made} segments.`
  );
}

/**
 * Project model edges into the sketch.
 *
 * Linked, the edges are stored as references and flattened again on every
 * rebuild, so they follow the model. Unlinked, they are copied in once as
 * ordinary sketch geometry that can then be trimmed and dimensioned like
 * anything drawn by hand. Fusion offers the same choice, and the difference
 * matters: a linked projection cannot be edited, and a copy will not update.
 */
function cmdProject(linked = true) {
  if (!state.sketcher.active) {
    setStatus('Project works inside a sketch.');
    return;
  }
  if (!state.selection.edges.size && !state.selection.faces.size) {
    setStatus('Select model edges or a face in the viewport, then press P.');
    return;
  }

  if (linked) {
    const sk = state.sketcher.sketch;
    pushUndo('project');
    sk.projections = sk.projections || [];
    let added = 0;
    for (const edge of gatherSelectedEdges()) {
      const ref = edgeReference(edge, edge.topo);
      if (sk.projections.some((r) => sameEdgeRef(r, ref))) continue;
      sk.projections.push(ref);
      added++;
    }
    clearGeometrySelection(false);
    state.dirty = true;
    rebuildAll();
    setStatus(
      added
        ? `${added} edge${added === 1 ? '' : 's'} projected. They follow the model.`
        : 'Those edges are already projected into this sketch.'
    );
    return;
  }

  const sk = state.sketcher.sketch;
  const plane = state.sketcher.plane;
  pushUndo('project');

  const toPlane = (p) => {
    const v = new THREE.Vector3(p[0], p[1], p[2]);
    const local = worldToSketchLocal(plane, v);
    return { x: local.u, y: local.v, w: local.w };
  };

  const gather = gatherSelectedEdges();

  let added = 0;
  const FLAT = 1e-4;
  for (const edge of gather) {
    if (edge.kind === 'line') {
      const a = toPlane(edge.start);
      const b = toPlane(edge.end);
      const ia = state.sketcher.addPoint(a.x, a.y);
      const ib = state.sketcher.addPoint(b.x, b.y);
      const ent = state.sketcher.addEntity({ type: 'line', p: [ia, ib] });
      ent.projected = true;
      state.sketcher.addConstraint({ type: 'fixed', point: ia, x: a.x, y: a.y });
      state.sketcher.addConstraint({ type: 'fixed', point: ib, x: b.x, y: b.y });
      added++;
    } else if (edge.kind === 'circle') {
      const c = toPlane(edge.centre);
      // A circle only stays a circle if its plane is parallel to the sketch's.
      const axisDot = Math.abs(
        edge.axis[0] * plane.n[0] + edge.axis[1] * plane.n[1] + edge.axis[2] * plane.n[2]
      );
      if (axisDot < 1 - FLAT) continue;
      const ic = state.sketcher.addPoint(c.x, c.y);
      const ent = state.sketcher.addEntity({ type: 'circle', c: ic, r: edge.radius });
      ent.projected = true;
      state.sketcher.addConstraint({ type: 'fixed', point: ic, x: c.x, y: c.y });
      state.sketcher.addConstraint({
        type: 'radius',
        entity: ent.id,
        value: edge.radius
      });
      added++;
    }
  }

  if (!added) {
    setStatus('Nothing there could be projected onto this plane.');
    return;
  }
  clearGeometrySelection(false);
  state.sketcher.finishStep();
  setStatus(`Projected ${added} edge${added === 1 ? '' : 's'} into the sketch.`);
}

/** Every model edge the selection names, a face standing for its own boundary. */
function gatherSelectedEdges() {
  const out = [];
  // The topology travels with each edge, because naming an edge means naming
  // the two faces it lies between and that needs the whole topology.
  for (const key of state.selection.edges) {
    const { bodyId, index } = splitKey(key);
    const rec = (state.records || []).find((r) => r.id === bodyId);
    const edge = rec?.topology?.edges[index];
    if (edge) out.push({ ...edge, topo: rec.topology });
  }
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    const rec = (state.records || []).find((r) => r.id === bodyId);
    const face = rec?.topology?.faces[index];
    if (!face) continue;
    for (const edge of rec.topology.edges) {
      if (edge.faceA === face.id || edge.faceB === face.id) {
        out.push({ ...edge, topo: rec.topology });
      }
    }
  }
  return out;
}

function worldToSketchLocal(plane, p) {
  const dx = p.x - plane.origin[0];
  const dy = p.y - plane.origin[1];
  const dz = p.z - plane.origin[2];
  return {
    u: dx * plane.x[0] + dy * plane.x[1] + dz * plane.x[2],
    v: dx * plane.y[0] + dy * plane.y[1] + dz * plane.y[2],
    w: dx * plane.n[0] + dy * plane.n[1] + dz * plane.n[2]
  };
}

/** Every outside edge of the bodies in play, for filleting a whole part at once. */
function selectAllConvexEdges() {
  const targets = state.selection.bodies.size
    ? [...state.selection.bodies]
    : (state.records || []).map((r) => r.id);
  state.selection.edges.clear();
  for (const bodyId of targets) {
    const rec = (state.records || []).find((r) => r.id === bodyId);
    for (const edge of rec?.topology?.edges || []) {
      if (edge.convex) state.selection.edges.add(`${bodyId}:${edge.id}`);
    }
  }
  refreshHighlight();
  updateHints();
  setStatus(`${state.selection.edges.size} outside edges selected.`);
}

/* ------------------------------------------------------------------ */
/* Marking menu                                                        */
/* ------------------------------------------------------------------ */

/**
 * Right click offers what makes sense for whatever is selected, rather than
 * one fixed list. Same idea as Fusion's marking menu, without the radial
 * flourish.
 */
function showMarkingMenu(e) {
  closeMarkingMenu();
  const items = [];

  if (state.sketcher.active) {
    items.push({ label: 'Finish Sketch', run: () => finishSketch() });
    if (state.sketcher.selection.size) {
      items.push({ label: 'Delete', run: () => state.sketcher.deleteSelection() });
      items.push({
        label: 'Toggle Construction',
        run: () => state.sketcher.toggleConstruction()
      });
      items.push({
        label: 'Toggle Centreline',
        run: () => state.sketcher.toggleCenterline()
      });
    }
    items.push({ label: 'Dimension', run: () => state.sketcher.setTool('dimension') });
  } else {
    if (state.selection.profiles.length) {
      items.push({ label: 'Extrude', run: () => runCommand('extrude') });
      items.push({ label: 'Revolve', run: () => runCommand('revolve') });
    }
    if (state.selection.edges.size) {
      items.push({ label: 'Fillet', run: () => startEdgeBlend('fillet') });
      items.push({ label: 'Chamfer', run: () => startEdgeBlend('chamfer') });
    }
    if (state.selection.faces.size) {
      items.push({ label: 'Press Pull', run: () => startPressPull() });
      items.push({ label: 'Create Sketch', run: () => cmdNewSketch() });
      items.push({ label: 'Shell', run: () => startShell() });
    }
    if (state.selection.bodies.size) {
      items.push({ label: 'Move', run: () => runCommand('move') });
      items.push({ label: 'Hide', run: () => runCommand('hideSelected') });
      items.push({ label: 'Delete', run: () => runCommand('deleteBody') });
    }
    if (!items.length) {
      items.push({ label: 'Create Sketch', run: () => cmdNewSketch() });
      items.push({ label: 'Fit View', run: () => state.vp.fit() });
      items.push({ label: 'Home View', run: () => state.vp.setHomeView() });
    }
  }

  items.push({ separator: true });
  items.push({ label: 'Undo', run: () => undo(), disabled: !state.undo.length });
  items.push({ label: 'Redo', run: () => redoAction(), disabled: !state.redo.length });

  const menu = document.createElement('div');
  menu.id = 'markmenu';
  for (const item of items) {
    if (item.separator) {
      const hr = document.createElement('div');
      hr.className = 'mm-sep';
      menu.appendChild(hr);
      continue;
    }
    const b = document.createElement('button');
    b.textContent = item.label;
    b.disabled = !!item.disabled;
    b.addEventListener('click', () => {
      closeMarkingMenu();
      item.run();
    });
    menu.appendChild(b);
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  armMenuClose(menu);
}

let menuCloser = null;

function closeMarkingMenu() {
  document.getElementById('markmenu')?.remove();
  if (menuCloser) {
    window.removeEventListener('pointerdown', menuCloser, true);
    menuCloser = null;
  }
}

/**
 * Close a menu when the next press lands outside it.
 *
 * Not on the next press anywhere, which is what this used to do. A real mouse
 * fires pointerdown before click, so pressing an item tore the menu out of the
 * document before the click could reach the item being pressed, and every menu
 * in the application did nothing at all: the dropdowns on every tab and the
 * right click menu alike. Only the press that lands outside closes it now.
 *
 * The reason this survived a suite of tests that drive the real interface is
 * that `element.click()` dispatches a click and no pointer events at all, so
 * the demos took a path no mouse can take. They press properly now.
 */
function armMenuClose(menu) {
  const onDown = (e) => {
    // `contains` throws on anything that is not a node, and a listener that
    // throws never gets to close the menu, which leaves it stuck open over
    // everything else.
    if (e.target instanceof Node && menu.contains(e.target)) return;
    closeMarkingMenu();
  };
  menuCloser = onDown;
  // After the click that opened it has finished, or that same click closes it.
  // Capturing, so a handler that swallows pointerdown cannot leave it stuck open.
  setTimeout(() => {
    if (menuCloser === onDown) window.addEventListener('pointerdown', onDown, true);
  }, 0);
}

/**
 * Ribbon buttons that stand for a group of related commands.
 *
 * The Solid tab ran out of room: every command having its own button pushed
 * Create onto a third row, and a third row costs the viewport fifty pixels of
 * height. Fusion groups these the same way, so nothing is hidden that was not
 * already grouped in the reference.
 */
const RIBBON_MENUS = {
  rectangle: [
    ['tool:rectangle', 'Two Point Rectangle'],
    ['tool:centerRectangle', 'Centre Rectangle'],
    ['tool:rectangle3', 'Three Point Rectangle']
  ],
  circle: [
    ['tool:circle', 'Centre Diameter Circle'],
    ['tool:circleDia', 'Two Point Circle'],
    ['tool:circle3', 'Three Point Circle'],
    ['tool:circleTan2', 'Two Tangent Circle'],
    ['tool:circleTan3', 'Three Tangent Circle']
  ],
  arc: [
    ['tool:arc', 'Centre Point Arc'],
    ['tool:arc3', 'Three Point Arc'],
    ['tool:tangentArc', 'Tangent Arc']
  ],
  polygon: [
    ['tool:polygon', 'Inscribed Polygon'],
    ['tool:polygonCirc', 'Circumscribed Polygon'],
    ['tool:polygonEdge', 'Edge Polygon']
  ],
  slot: [
    ['tool:slot', 'Centre To Centre Slot'],
    ['tool:slotOverall', 'Overall Slot'],
    ['tool:slotCentre', 'Centre Point Slot'],
    ['tool:slotArc3', 'Three Point Arc Slot'],
    ['tool:slotArcCentre', 'Centre Point Arc Slot']
  ],
  spline: [
    ['tool:spline', 'Fit Point Spline'],
    ['tool:splineCP', 'Control Point Spline'],
    ['tool:conic', 'Conic Curve'],
    ['tool:blendCurve', 'Blend Curve, Curvature Continuous'],
    ['tool:blendCurveG1', 'Blend Curve, Tangent Continuous']
  ],
  assemble: [
    ['newComponent', 'New Component'],
    ['newJoint', 'Joint'],
    ['asBuiltJoint', 'As-built Joint'],
    ['jointOrigin', 'Joint Origin'],
    ['constrainComponents', 'Constrain Components'],
    ['rigidGroup', 'Rigid Group'],
    ['motionLink', 'Motion Link'],
    ['driveJoints', 'Drive Joints']
  ],
  split: [
    ['splitBody', 'Split Body'],
    ['splitFace', 'Split Face'],
    ['silhouetteSplit', 'Silhouette Split']
  ],
  inspect: [
    ['sectionAnalysis', 'Section Analysis'],
    ['centreOfMass', 'Centre Of Mass'],
    ['interference', 'Interference'],
    ['draftAnalysis', 'Draft Analysis'],
    ['curvatureComb', 'Curvature Comb'],
    ['curvatureMap', 'Curvature Map'],
    ['minimumRadius', 'Minimum Radius'],
    ['zebraAnalysis', 'Zebra'],
    ['environmentMap', 'Environment Map'],
    ['accessibility', 'Accessibility'],
    ['designAdvice', 'Design Advice'],
    ['clearAnalysis', 'Clear Analysis']
  ],
  project: [
    ['project', 'Project, linked to the model'],
    ['projectCopy', 'Project as a copy'],
    ['intersect', 'Intersect with the sketch plane'],
    ['include3D', 'Include 3D Geometry'],
    ['intersectionCurve', 'Intersection Curve'],
    ['projectToSurface', 'Project To Surface'],
    ['isoCurve', 'Isoparametric Curve'],
    ['spunProfile', 'Spun Profile'],
    ['meshSection', 'Mesh Section']
  ],
  insert: [
    ['insertSvg', 'Insert SVG'],
    ['insertDxf', 'Insert DXF']
  ],
  insertParts: [
    ['insertComponent', 'Insert Component from a file'],
    ['insertDerive', 'Insert Derive, kept linked'],
    ['refreshDerived', 'Refresh what is derived'],
    ['insertCanvas', 'Canvas, an image to trace'],
    ['insertDecal', 'Decal, an image on a face']
  ],
  selectMore: [
    ['selectGrow', 'Grow'],
    ['selectShrink', 'Shrink'],
    ['selectInvert', 'Invert Selection'],
    ['selectTangent', 'Tangent Run'],
    ['selectSimilar', 'Select Similar'],
    ['selectSeedBoundary', 'Seed And Boundary'],
    ['selectBySize', 'Select By Size'],
    ['createSelectionSet', 'Save As A Selection Set'],
    ['isolate', 'Isolate'],
    ['unisolate', 'Show All Again']
  ],
  selectPriority: [
    ['priorityAuto', 'Anything'],
    ['priorityFace', 'Faces only'],
    ['priorityEdge', 'Edges only'],
    ['priorityBody', 'Bodies only']
  ],
  faceGroups: [
    ['faceGroups', 'Generate Face Groups'],
    ['createFaceGroup', 'Create Face Group'],
    ['combineFaceGroups', 'Combine Face Groups'],
    ['releaseFaceGroups', 'Delete Face Groups']
  ],
  primitive: [
    ['primBox', 'Box'],
    ['primCyl', 'Cylinder'],
    ['primSphere', 'Sphere'],
    ['primTorus', 'Torus'],
    ['primPipe', 'Pipe']
  ],
  formFaces: [
    ['formBridge', 'Bridge'],
    ['formFillHole', 'Fill Hole'],
    ['formDelete', 'Delete Faces']
  ],
  formTidy: [
    ['formFlatten', 'Flatten'],
    ['formUniform', 'Make Uniform']
  ],
  plastic: [
    ['boss', 'Boss'],
    ['rest', 'Rest'],
    ['snapFit', 'Snap Fit'],
    ['lip', 'Lip']
  ],
  formCreate: [
    ['formExtrudeCurve', 'Extrude a curve'],
    ['formRevolveCurve', 'Revolve a curve'],
    ['formSweepCurve', 'Sweep a curve along a path'],
    ['formLoftCurves', 'Loft between sketches'],
    ['formPipeCurve', 'Pipe along a path'],
    ['formFace', 'Face from picked points']
  ],
  formShape: [
    ['formSmooth', 'Smooth'],
    ['formStraighten', 'Straighten'],
    ['formCylindrify', 'Cylindrify'],
    ['formSlide', 'Slide Edge'],
    ['formBevel', 'Bevel Edge'],
    ['formErase', 'Erase And Fill'],
    ['formMergeEdge', 'Merge Edge'],
    ['formFreeze', 'Freeze'],
    ['formUnfreeze', 'Unfreeze'],
    ['formMatch', 'Match'],
    ['formByCurve', 'Edit Form By Curve'],
    ['formInterpolate', 'Interpolate'],
    ['formUninterpolate', 'Un-interpolate']
  ],
  formSelect: [
    ['formGrow', 'Grow'],
    ['formShrink', 'Shrink'],
    ['formLoop', 'Loop'],
    ['formRing', 'Ring'],
    ['formInvert', 'Invert'],
    ['formSelectAll', 'Select all']
  ],
  formInsert: [
    ['formInsertEdge', 'Insert Edge'],
    ['formInsertPoint', 'Insert Point'],
    ['formSubdivide', 'Subdivide Faces']
  ],
  formWeld: [
    ['formWeld', 'Weld Vertices'],
    ['formUnweld', 'Unweld Vertices']
  ],
  formCrease: [
    ['formCrease', 'Crease'],
    ['formUncrease', 'Uncrease']
  ],
  formDisplay: [
    ['formDisplayBox', 'Box'],
    ['formDisplayControl', 'Control Frame'],
    ['formDisplaySmooth', 'Smooth']
  ],
  pattern: [
    ['patternRect', 'Rectangular Pattern'],
    ['patternCirc', 'Circular Pattern'],
    ['patternPath', 'Path Pattern'],
    ['patternFeature', 'Feature Pattern']
  ]
};

/* ------------------------------------------------------------------ */
/* The toolbar                                                         */
/* ------------------------------------------------------------------ */

/**
 * Fold each ribbon group into a flyout, and the ribbon into one slim bar.
 *
 * Thirty labelled buttons laid out in two rows is the shape of a toolbar from
 * the nineties, and no amount of repainting changes that. What it costs is a
 * hundred pixels of viewport and the ability to find anything: every command on
 * the tab shouts at the same volume, so none of them are legible as a group.
 *
 * So a group becomes what it always was in the markup, a named set, and the bar
 * shows the names. The commands themselves are untouched and stay exactly where
 * they were in the document, which is what lets everything that points at them
 * by `data-cmd` carry on working.
 */
/** How many of a group's commands stay out on the bar as bare icons. */
const PINNED_PER_GROUP = 5;

function buildToolbars() {
  for (const panel of document.querySelectorAll('.ribbon-panel')) {
    for (const group of panel.querySelectorAll('.group')) {
      if (group.dataset.folded) continue;
      const label = group.querySelector('.glabel');
      const name = label?.textContent?.trim() || 'More';

      const pop = document.createElement('div');
      pop.className = 'grp-pop';
      // Everything but the name goes inside, in the order it was written.
      for (const child of [...group.children]) {
        if (child === label) continue;
        pop.appendChild(child);
      }

      // The first few commands stay out on the bar as bare icons, the way a
      // modelling toolbar does it, and the group's name under them opens the
      // rest. What is used constantly is one click, everything is two, and the
      // bar is one row rather than three.
      const pinned = document.createElement('div');
      pinned.className = 'grp-pinned';
      const candidates = [...pop.querySelectorAll(':scope > button')].filter(
        (b) => b.classList.contains('big')
      );
      for (const b of candidates.slice(0, PINNED_PER_GROUP)) {
        const shortcut = document.createElement('button');
        shortcut.className = 'pin';
        shortcut.type = 'button';
        shortcut.title = b.title || b.querySelector('.lbl')?.textContent?.trim() || '';
        shortcut.innerHTML = b.querySelector('.ico')?.outerHTML || '';
        // Points at the real button rather than copying what it does, so a
        // command has one definition and one place it is wired up.
        shortcut.addEventListener('click', (e) => {
          e.stopPropagation();
          closeGroups();
          b.click();
        });
        shortcut.dataset.pinFor = b.dataset.cmd || b.dataset.tool || b.dataset.menu || '';
        pinned.appendChild(shortcut);
      }

      const trigger = document.createElement('button');
      trigger.className = 'grp-trigger';
      trigger.type = 'button';
      trigger.innerHTML = `<span class="grp-name"></span><span class="grp-caret">\u25be</span>`;
      trigger.querySelector('.grp-name').textContent = name;
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleGroup(group);
      });

      if (label) label.remove();
      group.appendChild(pinned);
      group.appendChild(trigger);
      group.appendChild(pop);
      group.dataset.folded = '1';
      group.dataset.name = name;
    }
  }

  // A command inside a flyout closes it, the way a menu item closes a menu.
  // A dropdown inside one does not, or its own list would have nothing to
  // hang off.
  document.addEventListener('click', (e) => {
    const inPop = e.target.closest?.('.grp-pop');
    if (!inPop) return;
    if (e.target.closest('[data-menu]')) return;
    closeGroups();
  });

  window.addEventListener('pointerdown', (e) => {
    if (e.target instanceof Node && e.target.closest?.('.group')) return;
    closeGroups();
  }, true);
}

function toggleGroup(group) {
  const open = group.classList.contains('open');
  closeGroups();
  if (!open) {
    group.classList.add('open');
    // Kept inside the window rather than hanging off the right of it.
    const pop = group.querySelector('.grp-pop');
    if (pop) {
      pop.style.left = '0px';
      const r = pop.getBoundingClientRect();
      const over = r.right - (window.innerWidth - 8);
      if (over > 0) pop.style.left = `${-over}px`;
    }
  }
}

function closeGroups() {
  for (const g of document.querySelectorAll('.group.open')) g.classList.remove('open');
}

/* ------------------------------------------------------------------ */
/* Command search                                                      */
/* ------------------------------------------------------------------ */

/**
 * Every command in the application, by name.
 *
 * Folding the groups away makes the toolbar quiet and makes a command one click
 * further off. This is the other half of that bargain, and the half that
 * actually makes a large application usable: if you know what it is called you
 * never have to know where it lives.
 */
function allCommands() {
  const out = [];
  const seen = new Set();
  for (const panel of document.querySelectorAll('.ribbon-panel')) {
    const tab = panel.dataset.panel;
    for (const btn of panel.querySelectorAll('button[data-cmd], button[data-tool]')) {
      const name = btn.querySelector('.lbl')?.textContent?.trim() || btn.textContent.trim();
      const key = `${btn.dataset.cmd || ''}|${btn.dataset.tool || ''}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        tab,
        group: btn.closest('.group')?.dataset.name || '',
        cmd: btn.dataset.cmd || null,
        tool: btn.dataset.tool || null,
        title: btn.title || ''
      });
    }
  }
  // The named lists behind the dropdowns are commands too, and they are the
  // ones hardest to find by pointing. Where they live is read off the button
  // that opens them, so it reads as a place rather than as the key the list
  // happens to be stored under.
  for (const [menu, items] of Object.entries(RIBBON_MENUS)) {
    const opener = document.querySelector(`[data-menu="${menu}"]`);
    const where = opener?.querySelector('.lbl')?.textContent?.replace(/\s*▾\s*$/, '').trim();
    for (const [cmd, name] of items) {
      const key = `${cmd}|`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        tab: opener?.closest('.ribbon-panel')?.dataset.panel || '',
        group: where || opener?.closest('.group')?.dataset.name || '',
        cmd: cmd.startsWith('tool:') ? null : cmd,
        tool: cmd.startsWith('tool:') ? cmd.slice(5) : null,
        title: ''
      });
    }
  }
  return out;
}

function openCommandSearch() {
  closeCommandSearch();
  closeGroups();

  const wrap = document.createElement('div');
  wrap.id = 'cmdsearch';
  const box = document.createElement('div');
  box.className = 'cmd-box';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Search commands';
  input.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'cmd-list';
  box.appendChild(input);
  box.appendChild(list);
  wrap.appendChild(box);
  document.body.appendChild(wrap);

  const all = allCommands();
  let shown = [];
  let at = 0;

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = (q
      ? all
          .map((c) => ({ c, i: c.name.toLowerCase().indexOf(q) }))
          .filter((x) => x.i >= 0)
          // A match at the start of the name beats one in the middle of it.
          .sort((a, b) => a.i - b.i || a.c.name.length - b.c.name.length)
          .map((x) => x.c)
      : all
    ).slice(0, 40);
    at = Math.min(at, Math.max(0, shown.length - 1));
    list.innerHTML = '';
    shown.forEach((c, i) => {
      const row = document.createElement('button');
      row.className = 'cmd-row' + (i === at ? ' at' : '');
      const nm = document.createElement('span');
      nm.className = 'cmd-name';
      nm.textContent = c.name;
      const where = document.createElement('span');
      where.className = 'cmd-where';
      where.textContent = [c.tab, c.group].filter(Boolean).join(' \u203a ');
      row.appendChild(nm);
      row.appendChild(where);
      row.addEventListener('click', () => run(c));
      list.appendChild(row);
    });
  };

  const run = (c) => {
    closeCommandSearch();
    if (!c) return;
    if (c.tool) reachForTool(c.tool);
    else if (c.cmd) runCommand(c.cmd);
  };

  input.addEventListener('input', () => {
    at = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      at = Math.min(at + 1, shown.length - 1);
      draw();
      list.children[at]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      at = Math.max(at - 1, 0);
      draw();
      list.children[at]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(shown[at]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCommandSearch();
    }
  });
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === wrap) closeCommandSearch();
  });

  draw();
  input.focus();
}

function closeCommandSearch() {
  document.getElementById('cmdsearch')?.remove();
}

function showRibbonMenu(name, anchor) {
  closeMarkingMenu();
  const items = RIBBON_MENUS[name];
  if (!items) return;

  const menu = document.createElement('div');
  menu.id = 'markmenu';
  for (const [cmd, label] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      closeMarkingMenu();
      if (cmd.startsWith('tool:')) {
        reachForTool(cmd.slice(5));
      } else {
        runCommand(cmd);
      }
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);

  // Under the button it belongs to, and pulled back inside the window rather
  // than hanging off the right edge.
  const r = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - box.width - 8)}px`;
  menu.style.top = `${Math.min(r.bottom, window.innerHeight - box.height - 8)}px`;

  armMenuClose(menu);
}

/* ------------------------------------------------------------------ */
/* The newer solid features                                            */
/* ------------------------------------------------------------------ */

/** Sketches that currently hold at least one closed region. */
function sketchesWithProfiles() {
  const out = [];
  for (const f of state.doc.features) {
    if (f.type !== 'sketch') continue;
    const sk = state.doc.sketches[f.sketch];
    if (!sk) continue;
    const regions = state.result?.sketchRegions?.[sk.id] || [];
    if (regions.length) out.push({ sketch: sk, regions });
  }
  return out;
}

/** Sketches whose curves form an open or closed chain, usable as a path. */
function sketchesWithPaths() {
  const out = [];
  for (const f of state.doc.features) {
    if (f.type !== 'sketch') continue;
    const sk = state.doc.sketches[f.sketch];
    if (!sk) continue;
    if (sk.entities.some((e) => e.type === 'line' || e.type === 'arc' || e.type === 'spline')) {
      out.push(sk);
    }
  }
  return out;
}

function startLoft() {
  if (state.sketcher.active) finishSketch();
  const feature = {
    ...newExtrudeFeature(),
    type: 'loft',
    sections: [],
    rails: [],
    startCondition: 'connected',
    endCondition: 'connected',
    startWeight: '1',
    endWeight: '1',
    closed: false
  };
  delete feature.sketch;
  delete feature.seeds;
  delete feature.faces;
  openFeatureEditor(feature, 'Loft', loftFields(feature));
  setEditPick('sections');
  setStatus('Click each profile in turn, in the order the loft runs through them.');
}

function startSweep() {
  if (state.sketcher.active) finishSketch();
  const sketchId = activeSketchId();
  if (!sketchId && !state.selection.faces.size) {
    setStatus('Sweep needs a closed profile and a path to follow.');
    return;
  }

  const paths = pathSketchOptions().filter(([id]) => id && id !== sketchId);
  const feature = {
    ...newExtrudeFeature(),
    type: 'sweep',
    sweepType: 'path',
    path: paths.length ? { sketch: paths[0][0] } : null,
    rail: null,
    profileScaling: 'scale',
    distance: '1',
    taper: '0',
    twist: '0',
    scale: '1',
    orientation: 'perpendicular'
  };
  openFeatureEditor(feature, 'Sweep', sweepFields());
  if (!feature.seeds.length && !feature.faces.length) {
    setEditPick('profiles');
    setStatus('Click the profiles to sweep, then the path to follow.');
  }
}

function startRib() {
  if (state.sketcher.active) finishSketch();
  const paths = sketchesWithPaths();
  if (!paths.length) {
    setStatus('Rib needs an open sketch curve to thicken.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'rib',
    sketch: paths[paths.length - 1].id,
    thickness: '2',
    direction: 'symmetric',
    start: 'bottom',
    depth: '10',
    flip: false,
    op: state.result?.bodies.length ? 'join' : 'new',
    targets: 'all'
  };
  openFeatureEditor(feature, 'Rib', [
    {
      key: 'sketch',
      label: 'Curve',
      type: 'select',
      options: paths.map((sk) => [sk.id, sk.name])
    },
    { key: 'thickness', label: 'Thickness', type: 'expr' },
    {
      key: 'direction',
      label: 'Thickness sits',
      type: 'select',
      options: [
        ['symmetric', 'Half each side of the curve'],
        ['one', 'All to one side']
      ]
    },
    {
      key: 'start',
      label: 'Which side',
      type: 'select',
      showIf: (f) => f.direction === 'one',
      options: [
        ['bottom', 'One way'],
        ['top', 'The other']
      ]
    },
    { key: 'depth', label: 'Depth', type: 'expr' },
    { key: 'flip', label: 'Flip direction', type: 'bool' },
    { key: 'op', label: 'Operation', type: 'select', options: OP_OPTIONS }
  ]);
}

function startDraft() {
  if (state.sketcher.active) finishSketch();
  const faceRefs = selectedFaceRefs();
  if (!state.result?.bodies.length) {
    setStatus('There is nothing to draft yet.');
    return;
  }
  const [bodyId, faces] = faceRefs.size
    ? [...faceRefs][0]
    : [state.result.bodies[0].id, []];
  const feature = {
    id: uid('f'),
    type: 'draft',
    bodies: [bodyId],
    faces,
    angle: '3',
    // Written even when it is not shown, so that a draft made here always
    // carries a second angle. An absent one is how an old two-sided draft is
    // told apart from a new one and read back as symmetric.
    angle2: '3',
    neutral: 'XY',
    sides: 'one',
    flipPull: false
  };
  openFeatureEditor(feature, 'Draft', draftFields());
  if (!faces.length) {
    setEditPick('draftFaces');
    setStatus('Click the faces to draft.');
  }
}

function startSplit() {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('Nothing to split yet.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'split',
    splitType: 'body',
    bodies: bodySelectionOrAll(),
    // Written even when empty, so an absent list is reliably an old document
    // and empty reliably means nothing picked yet.
    tools: []
  };
  openFeatureEditor(feature, 'Split Body', splitFields(feature));
  setEditPick('splitFace');
  setStatus('Click a face or a plane to split with. Several can be used at once.');
}

function startCoil() {
  if (state.sketcher.active) finishSketch();
  const feature = {
    id: uid('f'),
    type: 'coil',
    plane: 'XY',
    coilType: 'revHeight',
    rotation: 'ccw',
    diameter: '20',
    revolutions: '4',
    height: '20',
    pitch: '5',
    angle: '0',
    section: 'circular',
    sectionPosition: 'center',
    sectionSize: '3',
    op: state.result?.bodies.length ? 'join' : 'new',
    targets: 'all'
  };
  openFeatureEditor(feature, 'Coil', coilFields(feature));
}

function startEmboss() {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('Emboss needs a body to work on.');
    return;
  }
  const sketchId = activeSketchId();
  if (!sketchId) {
    setStatus('Draw the shape on a sketch first, then emboss it onto a face.');
    return;
  }
  const seeds = activeSeeds(sketchId);
  const feature = {
    id: uid('f'),
    type: 'emboss',
    sketch: sketchId,
    seeds: seeds && seeds.length ? seeds : [],
    faces: facesFromSelection(),
    effect: 'emboss',
    flipNormal: false,
    depth: '1',
    alignX: '0',
    alignY: '0',
    alignAngle: '0'
  };
  openFeatureEditor(feature, 'Emboss', embossFields());
  // Point at whichever half is still empty, the profile first.
  setEditPick(feature.seeds.length ? 'embossFaces' : 'profiles');
}

function startWeb() {
  if (state.sketcher.active) finishSketch();
  const sketchId = activeSketchId();
  if (!sketchId) {
    setStatus('Draw the wall lines on a sketch first.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'web',
    sketch: sketchId,
    thickness: '2',
    direction: 'symmetric',
    start: 'bottom',
    extentType: 'toNext',
    depth: '10',
    flip: false,
    draftAngle: '0',
    extendCurves: true,
    op: state.result?.bodies.length ? 'join' : 'new',
    bodies: 'all',
    targets: 'all'
  };
  openFeatureEditor(feature, 'Web', webFields(feature));
}

function startAlign() {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('Nothing to align yet.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'align',
    bodies: bodySelectionOrAll(),
    from: null,
    to: null,
    flip: false,
    angle: '0'
  };
  openFeatureEditor(feature, 'Align', alignFields());
  setEditPick('alignFrom');
}

function startDeleteFace() {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('Nothing to delete a face from yet.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'deleteFace',
    faces: facesFromSelection()
  };
  openFeatureEditor(feature, 'Delete Face', deleteFaceFields());
  if (!feature.faces.length) setEditPick('draftFaces');
}

/**
 * Divide a face in two, leaving the shape alone.
 *
 * Useful for drafting or colouring only part of a face, and for giving a later
 * feature a smaller thing to hold on to.
 */
function startSplitFace() {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('Nothing to split a face on yet.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'splitFace',
    bodies: bodySelectionOrAll(),
    plane: 'XY',
    faceRef: null
  };
  openFeatureEditor(feature, 'Split Face', splitFaceFields());
}

function splitFaceFields() {
  return [
    {
      key: '__face',
      label: 'Split with a face',
      type: 'pick',
      pick: 'splitFace',
      summary: (f) => (f.faceRef ? 'A face of the model' : 'Not using one'),
      clear: (f) => {
        f.faceRef = null;
      }
    },
    {
      key: 'plane',
      label: 'Or a plane',
      type: 'select',
      options: planeOptions(),
      get: (f) => optionForPlane(f.plane),
      set: (f, v) => {
        f.plane = planeSpecFromOption(v);
        f.faceRef = null;
      }
    },
    {
      key: '__bodies',
      label: 'Bodies',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) =>
        Array.isArray(f.bodies) ? `${f.bodies.length} chosen` : 'Every body',
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'The shape does not change. What was one face becomes two, each selectable on its own.'
    }
  ];
}

function startSilhouetteSplit() {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('Nothing to split yet.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'silhouetteSplit',
    direction: null,
    bodies: bodySelectionOrAll()
  };
  openFeatureEditor(feature, 'Silhouette Split', silhouetteFields());
  setEditPick('silhouetteDir');
}

/** Whatever faces are selected, as references a feature can store. */
function facesFromSelection() {
  const out = [];
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    const rec = (state.records || []).find((r) => r.id === bodyId);
    const face = rec?.topology?.faces[index];
    if (face) out.push({ bodyId, face: faceReference(face) });
  }
  return out;
}

function startThread() {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('Make a rod or a hole to thread first.');
    return;
  }

  // A selected cylindrical face gives the diameter and the axis for free.
  let diameter = '8';
  let internal = false;
  let bodies = bodySelectionOrAll();
  const face = singleSelectedCylinder();
  if (face) {
    diameter = String(round(face.face.cylinder.radius * 2, 3));
    internal = faceIsBore(face.record, face.face);
    bodies = [face.record.id];
  }

  const feature = {
    id: uid('f'),
    type: 'thread',
    bodies,
    diameter,
    pitch: String(defaultPitchFor(Number(diameter) || 8)),
    length: '10',
    clearance: '0.2',
    internal,
    leftHanded: false,
    plane: 'XY'
  };
  openFeatureEditor(feature, 'Thread', [
    { key: 'diameter', label: 'Diameter', type: 'expr' },
    { key: 'pitch', label: 'Pitch', type: 'expr' },
    { key: 'length', label: 'Length', type: 'expr' },
    { key: 'clearance', label: 'Print clearance', type: 'expr' },
    { key: 'internal', label: 'Internal (a nut)', type: 'bool' },
    { key: 'leftHanded', label: 'Left handed', type: 'bool' },
    { key: 'plane', label: 'Starts on', type: 'select', options: planeOptions() }
  ]);
}

/** Coarse pitch for a nominal metric size, which is what a bolt would use. */
function defaultPitchFor(d) {
  const table = [
    [3, 0.5], [4, 0.7], [5, 0.8], [6, 1], [8, 1.25],
    [10, 1.5], [12, 1.75], [16, 2], [20, 2.5], [24, 3]
  ];
  let best = table[0];
  for (const row of table) {
    if (Math.abs(row[0] - d) < Math.abs(best[0] - d)) best = row;
  }
  return best[1];
}

function singleSelectedCylinder() {
  if (state.selection.faces.size !== 1) return null;
  const { bodyId, index } = splitKey([...state.selection.faces][0]);
  const record = (state.records || []).find((r) => r.id === bodyId);
  const face = record?.topology?.faces[index];
  if (!face || face.planar || !face.cylinder) return null;
  return { record, face };
}

/** A bore faces inward, so its normals point back toward its own axis. */
function faceIsBore(record, face) {
  const c = face.cylinder;
  const toAxis = [
    c.origin[0] - face.centre[0],
    c.origin[1] - face.centre[1],
    c.origin[2] - face.centre[2]
  ];
  const dot =
    toAxis[0] * face.normal[0] + toAxis[1] * face.normal[1] + toAxis[2] * face.normal[2];
  return dot > 0;
}

function startPatternPath() {
  if (state.sketcher.active) finishSketch();
  const paths = sketchesWithPaths();
  if (!paths.length) {
    setStatus('Draw a path sketch first.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'patternPath',
    bodies: bodySelectionOrAll(),
    path: { sketch: paths[paths.length - 1].id },
    count: '5',
    spacing: '0',
    follow: true,
    op: 'join'
  };
  openFeatureEditor(feature, 'Path Pattern', [
    {
      key: '__path',
      label: 'Path',
      type: 'select',
      options: paths.map((sk) => [sk.id, sk.name]),
      get: (f) => f.path.sketch,
      set: (f, v) => {
        f.path = { sketch: v };
      }
    },
    { key: 'count', label: 'Count', type: 'expr' },
    { key: 'spacing', label: 'Spacing (0 spreads evenly)', type: 'expr' },
    { key: 'follow', label: 'Turn to follow the path', type: 'bool' },
    {
      key: 'op',
      label: 'Result',
      type: 'select',
      options: [
        ['join', 'One body'],
        ['separate', 'Separate bodies']
      ]
    }
  ]);
}

function startPatternFeature() {
  if (state.sketcher.active) finishSketch();
  const patternable = state.doc.features.filter((f) =>
    ['extrude', 'revolve', 'hole', 'primitive', 'sweep', 'loft'].includes(f.type)
  );
  if (!patternable.length) {
    setStatus('There is no feature to repeat yet.');
    return;
  }
  const picked = [...state.selection.features].filter((id) =>
    patternable.some((f) => f.id === id)
  );

  const feature = {
    id: uid('f'),
    type: 'patternFeature',
    features: picked.length ? picked : [patternable[patternable.length - 1].id],
    pattern: 'rectangular',
    count1: '3',
    spacing1: '20',
    count2: '1',
    spacing2: '20',
    dir1: [1, 0, 0],
    dir2: [0, 1, 0],
    count: '6',
    angle: '360',
    axis: [0, 0, 1],
    center: [0, 0, 0]
  };

  openFeatureEditor(feature, 'Feature Pattern', [
    {
      key: '__feature',
      label: 'Repeat',
      type: 'select',
      options: patternable.map((f) => [f.id, featureLabel(state.doc, f)]),
      get: (f) => f.features[0],
      set: (f, v) => {
        f.features = [v];
      }
    },
    {
      key: 'pattern',
      label: 'Arrangement',
      type: 'select',
      options: [
        ['rectangular', 'Rectangular'],
        ['circular', 'Circular']
      ]
    },
    { key: 'count1', label: 'Count along X', type: 'expr', showIf: (f) => f.pattern !== 'circular' },
    { key: 'spacing1', label: 'Spacing X', type: 'expr', showIf: (f) => f.pattern !== 'circular' },
    { key: 'count2', label: 'Count along Y', type: 'expr', showIf: (f) => f.pattern !== 'circular' },
    { key: 'spacing2', label: 'Spacing Y', type: 'expr', showIf: (f) => f.pattern !== 'circular' },
    { key: 'count', label: 'Count', type: 'expr', showIf: (f) => f.pattern === 'circular' },
    { key: 'angle', label: 'Total angle', type: 'expr', showIf: (f) => f.pattern === 'circular' }
  ]);
}

/* ------------------------------------------------------------------ */
/* Construction geometry                                               */
/* ------------------------------------------------------------------ */

/** Base planes plus every construction plane made so far. */
function planeOptions() {
  const out = [
    ['XY', 'XY'],
    ['XZ', 'XZ'],
    ['YZ', 'YZ']
  ];
  for (const f of state.doc.features) {
    if (f.type !== 'construction') continue;
    if (f.entry.type === 'ucs') {
      // A coordinate system contributes three planes, not one, and they are
      // what makes it worth having: a sketch on a fixture's own XY is the
      // whole point of setting one up.
      const stem = f.entry.name || 'Coordinate System';
      for (const [suffix, label] of [['xy', 'XY'], ['xz', 'XZ'], ['yz', 'YZ']]) {
        out.push([`c:${f.entry.id}/${suffix}`, `${stem} ${label}`]);
      }
      continue;
    }
    if (!String(f.entry.type).startsWith('plane')) continue;
    out.push([`c:${f.entry.id}`, f.entry.name || CONSTRUCTION_LABELS[f.entry.type]]);
  }
  return out;
}

/** Turn a plane dropdown value back into something resolvePlane understands. */
function planeSpecFromOption(value) {
  if (typeof value === 'string' && value.startsWith('c:')) {
    return { construction: value.slice(2) };
  }
  return value;
}

/** The way one of the three origin planes faces. */
function planeNormal(name) {
  return { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] }[String(name).toUpperCase()] || null;
}

function axisOptions() {
  const out = [
    ['w:x', 'X axis'],
    ['w:y', 'Y axis'],
    ['w:z', 'Z axis']
  ];
  for (const f of state.doc.features) {
    if (f.type !== 'construction') continue;
    if (f.entry.type === 'ucs') {
      const stem = f.entry.name || 'Coordinate System';
      for (const suffix of ['x', 'y', 'z']) {
        out.push([`c:${f.entry.id}/${suffix}`, `${stem} ${suffix.toUpperCase()}`]);
      }
      continue;
    }
    if (!String(f.entry.type).startsWith('axis')) continue;
    out.push([`c:${f.entry.id}`, f.entry.name || CONSTRUCTION_LABELS[f.entry.type]]);
  }
  return out;
}

function axisSpecFromOption(value) {
  if (value.startsWith('w:')) return { worldAxis: value.slice(2) };
  return { construction: value.slice(2) };
}

/**
 * Move the sketch selection by a stated distance, or leave a copy there. The
 * numeric counterpart to dragging it, for when the distance is the point.
 */
function startSketchMove() {
  if (!state.sketcher.active) {
    setStatus('Open a sketch first.');
    return;
  }
  if (!state.sketcher.selection.size) {
    setStatus('Select the geometry to move first. Drag a box round it, or click it.');
    return;
  }
  const scope = resolveParameters(state.doc.parameters).scope;
  showInspector(
    'Move Sketch Geometry',
    [
      { key: 'dx', label: `Along X (${unitLabel()})`, type: 'expr', value: '0' },
      { key: 'dy', label: `Along Y (${unitLabel()})`, type: 'expr', value: '0' },
      { key: 'copy', label: 'Leave a copy', type: 'check', value: false }
    ],
    (values) => {
      const dx = safeEval(values.dx, scope, 0);
      const dy = safeEval(values.dy, scope, 0);
      if (!dx && !dy) {
        setStatus('That is a move of nothing.');
        return;
      }
      state.sketcher.moveSelection(dx, dy, !!values.copy);
      setStatus(values.copy ? 'Copy placed.' : 'Moved.');
    }
  );
}

/** Guard shared by every sketch command that works on a selection. */
function sketchSelectionReady(what) {
  if (!state.sketcher.active) {
    setStatus('Open a sketch first.');
    return false;
  }
  if (!state.sketcher.selection.size) {
    setStatus(`Select the geometry to ${what} first. Drag a box round it, or click it.`);
    return false;
  }
  return true;
}

function startSketchPatternRect() {
  if (!sketchSelectionReady('pattern')) return;
  const scope = resolveParameters(state.doc.parameters).scope;
  showInspector(
    'Rectangular Sketch Pattern',
    [
      { key: 'countX', label: 'Count along X', type: 'expr', value: '3' },
      { key: 'spacingX', label: `Spacing X (${unitLabel()})`, type: 'expr', value: '10' },
      { key: 'countY', label: 'Count along Y', type: 'expr', value: '1' },
      { key: 'spacingY', label: `Spacing Y (${unitLabel()})`, type: 'expr', value: '10' },
      { key: 'angle', label: 'Angle of the rows (deg)', type: 'expr', value: '0' }
    ],
    (v) => {
      state.sketcher.patternSelectionRect({
        countX: safeEval(v.countX, scope, 1),
        countY: safeEval(v.countY, scope, 1),
        spacingX: safeEval(v.spacingX, scope, 0),
        spacingY: safeEval(v.spacingY, scope, 0),
        angle: safeEval(v.angle, scope, 0)
      });
    }
  );
}

function startSketchPatternCirc() {
  if (!sketchSelectionReady('pattern')) return;
  const scope = resolveParameters(state.doc.parameters).scope;
  // The centre defaults to the sketch origin, which is where a bolt circle is
  // drawn about nine times out of ten.
  showInspector(
    'Circular Sketch Pattern',
    [
      { key: 'count', label: 'Count, including the original', type: 'expr', value: '6' },
      { key: 'angle', label: 'Total angle (deg)', type: 'expr', value: '360' },
      { key: 'cx', label: `Centre X (${unitLabel()})`, type: 'expr', value: '0' },
      { key: 'cy', label: `Centre Y (${unitLabel()})`, type: 'expr', value: '0' }
    ],
    (v) => {
      state.sketcher.patternSelectionCircular({
        count: safeEval(v.count, scope, 1),
        angle: safeEval(v.angle, scope, 360),
        cx: safeEval(v.cx, scope, 0),
        cy: safeEval(v.cy, scope, 0)
      });
    }
  );
}

function startSketchScale() {
  if (!sketchSelectionReady('scale')) return;
  const scope = resolveParameters(state.doc.parameters).scope;
  showInspector(
    'Scale Sketch Geometry',
    [
      { key: 'factor', label: 'Scale factor', type: 'expr', value: '1' },
      { key: 'cx', label: `About X (${unitLabel()})`, type: 'expr', value: '0' },
      { key: 'cy', label: `About Y (${unitLabel()})`, type: 'expr', value: '0' }
    ],
    (v) => {
      state.sketcher.scaleSelection({
        factor: safeEval(v.factor, scope, 1),
        cx: safeEval(v.cx, scope, 0),
        cy: safeEval(v.cy, scope, 0)
      });
    }
  );
}

/**
 * The wording and the size of a piece of sketch text, asked for after it has
 * been placed, since there is nothing to preview before then.
 */
function askForText(current, cb) {
  const scope = resolveParameters(state.doc.parameters).scope;
  showInspector(
    'Text',
    [
      { key: 'text', label: 'Text', type: 'text', value: current.text || '' },
      {
        key: 'font',
        label: 'Font',
        type: 'select',
        value: current.font || 'Arial',
        options: TEXT_FONTS.map((f) => [f, f])
      },
      { key: 'height', label: `Height (${unitLabel()})`, type: 'expr', value: String(current.height ?? 10) },
      {
        key: 'align',
        label: 'Align',
        type: 'select',
        value: current.align || 'left',
        options: [
          ['left', 'Left'],
          ['center', 'Centre'],
          ['right', 'Right']
        ]
      },
      { key: 'angle', label: 'Angle (deg)', type: 'expr', value: String(current.angle ?? 0) },
      { key: 'bold', label: 'Bold', type: 'check', value: !!current.bold },
      { key: 'italic', label: 'Italic', type: 'check', value: !!current.italic }
    ],
    (v) => {
      cb({
        text: v.text,
        font: v.font,
        height: safeEval(v.height, scope, 10),
        align: v.align,
        angle: safeEval(v.angle, scope, 0),
        bold: !!v.bold,
        italic: !!v.italic
      });
    }
  );
}

/**
 * Trace an SVG or a DXF into the open sketch.
 *
 * The file is read in the main process and parsed here, by hand, so opening one
 * can never execute anything. What comes back is ordinary sketch geometry:
 * lines, circles and arcs keep their kind, and everything curved arrives as a
 * polyline, because a sketch has no bezier entity and drawing one it cannot
 * dimension would be worse than saying so.
 */
async function startVectorImport(kind) {
  if (!state.sketcher.active) {
    setStatus('Open a sketch to import into first.');
    return;
  }
  const res = await window.anvil.importVector(kind);
  if (!res?.ok) {
    if (res && !res.canceled) setStatus(`Could not read that file: ${res.error}`);
    return;
  }

  let parsed;
  try {
    parsed = kind === 'dxf' ? parseDXF(res.text) : parseSVG(res.text);
  } catch (err) {
    setStatus(err.message);
    return;
  }
  if (!parsed.entities.length) {
    setStatus('Nothing in that file that a sketch can hold.');
    return;
  }

  const scope = resolveParameters(state.doc.parameters).scope;
  const name = String(res.path).split(/[\\/]/).pop();
  const bounds = vectorBounds(parsed.entities);
  const wide = Math.max(bounds.w, bounds.h) || 1;

  showInspector(
    `Insert ${kind.toUpperCase()}`,
    [
      { key: '__note', label: '', type: 'note', text:
        `${name}: ${parsed.entities.length} shapes, ${round(bounds.w, 2)} by ${round(bounds.h, 2)} ${unitLabel()} as drawn.` },
      { key: 'scale', label: 'Scale', type: 'expr', value: '1' },
      { key: 'x', label: `Place at X (${unitLabel()})`, type: 'expr', value: '0' },
      { key: 'y', label: `Place at Y (${unitLabel()})`, type: 'expr', value: '0' },
      { key: 'centre', label: 'Centre it on that point', type: 'check', value: true }
    ],
    (v) => {
      const scale = safeEval(v.scale, scope, 1) || 1;
      let x = safeEval(v.x, scope, 0);
      let y = safeEval(v.y, scope, 0);
      if (v.centre) {
        x -= (bounds.minX + bounds.w / 2) * scale;
        y -= (bounds.minY + bounds.h / 2) * scale;
      }
      const made = state.sketcher.insertVector(parsed.entities, { scale, x, y });
      setStatus(
        made
          ? `${made} curve${made === 1 ? '' : 's'} from ${name}. Its longest side is ${round(wide * scale, 2)} ${unitLabel()}.`
          : 'Nothing usable in that file.'
      );
    }
  );
}

/** The extent of parsed vector geometry, for placing and reporting it. */
function vectorBounds(entities) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const e of entities) {
    for (const p of e.points || []) see(p.x, p.y);
    if (e.centre) {
      const r = e.r || 0;
      see(e.centre.x - r, e.centre.y - r);
      see(e.centre.x + r, e.centre.y + r);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, w: 0, h: 0 };
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Draw the inspections that are marks rather than colours.
 *
 * A comb and a centre of mass are both things laid over the model, not changes
 * to how it is shaded, so they live in the overlay with the sketch geometry and
 * are thrown away and rebuilt each time like it is.
 */
function renderAnalysisOverlay() {
  if (!state.vp) return;
  if (!state.analysisGroup) {
    state.analysisGroup = new THREE.Group();
    state.vp.overlayGroup.add(state.analysisGroup);
  }
  const g = state.analysisGroup;
  while (g.children.length) {
    const c = g.children.pop();
    c.geometry?.dispose();
    c.material?.dispose();
  }

  if (state.comb?.length) {
    const pts = [];
    for (const run of state.comb) {
      for (const spike of run) {
        pts.push(new THREE.Vector3(spike.at[0], spike.at[1], spike.at[2]));
        pts.push(new THREE.Vector3(spike.to[0], spike.to[1], spike.to[2]));
      }
      // The outer edge of the comb joined up, which is the line worth reading:
      // a kink in it is a kink in the curvature.
      const hull = [];
      for (const spike of run) {
        hull.push(new THREE.Vector3(spike.to[0], spike.to[1], spike.to[2]));
      }
      if (hull.length > 1) {
        const outline = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(hull),
          new THREE.LineBasicMaterial({ color: 0xd84b1e, depthTest: false })
        );
        outline.renderOrder = 8;
        g.add(outline);
      }
    }
    if (pts.length) {
      const spikes = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: 0x8a6d3b,
          transparent: true,
          opacity: 0.8,
          depthTest: false
        })
      );
      spikes.renderOrder = 7;
      g.add(spikes);
    }
  }

  if (state.massMarker) {
    // A cross rather than a dot, because a dot at the centre of a part is
    // indistinguishable from a speck on the screen.
    const [x, y, z] = state.massMarker;
    const r = Math.max(2, (state.vp.pixelWorldSize?.() || 0.1) * 24);
    const pts = [
      new THREE.Vector3(x - r, y, z), new THREE.Vector3(x + r, y, z),
      new THREE.Vector3(x, y - r, z), new THREE.Vector3(x, y + r, z),
      new THREE.Vector3(x, y, z - r), new THREE.Vector3(x, y, z + r)
    ];
    const cross = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xd84b1e, depthTest: false })
    );
    cross.renderOrder = 9;
    g.add(cross);
  }

  state.vp.invalidate();
}

/**
 * Fold whatever inspection is showing into what gets drawn.
 *
 * The records still carry the real mesh for picking and export. Only the mesh
 * handed to the viewport is replaced, so a section is a way of looking at the
 * part and never a change to it: save, export or measure while one is up and
 * the answers are the same as with it down.
 */
function applyAnalyses(records, res) {
  for (const rec of records) {
    delete rec.displayMesh;
    delete rec.vertexColours;
    delete rec.chrome;
  }
  // A stress result is a colour per vertex, the same as every other analysis,
  // so it goes on and comes off the same way.
  if (state.stress?.colours) {
    for (const rec of records) {
      const held = state.stress.colours.get(rec.id);
      if (held && held.length === rec.mesh.vertProperties.length) rec.vertexColours = held;
    }
  }
  if (!state.section && !state.draft && !state.faceAnalysis) return;

  const scope = new K.Scope();
  try {
    if (state.section) {
      const cut = sectionPlaneFor(res, scope);
      if (cut) {
        for (const rec of records) {
          const body = res.bodies.find((b) => b.id === rec.id);
          if (!body?.solid) continue;
          try {
            const mesh = sectionedMesh(body.solid, cut, scope);
            // A body wholly on the far side simply goes, which is what a cut
            // through an assembly should do.
            rec.displayMesh = mesh;
            if (!mesh) rec.sectionedAway = true;
          } catch {
            /* leave it whole rather than lose it */
          }
        }
      }
    }

    if (state.faceAnalysis) {
      const evald = resolveParameters(state.doc.parameters).scope;
      const fa = state.faceAnalysis;
      const base = resolvePlane(fa.plane || 'XY', evald, res.construction);
      const sign = fa.flip ? -1 : 1;
      const dir = base ? [base.n[0] * sign, base.n[1] * sign, base.n[2] * sign] : [0, 0, 1];
      for (const rec of records) {
        const mesh = rec.displayMesh || rec.mesh;
        if (!mesh) continue;
        if (fa.kind === 'curvature') {
          rec.vertexColours = curvatureColours(mesh);
        } else if (fa.kind === 'minRadius') {
          rec.vertexColours = minimumRadiusColours(mesh, safeEval(fa.tool, evald, 1));
        } else if (fa.kind === 'zebra') {
          rec.vertexColours = zebraColours(mesh, dir, safeEval(fa.bands, evald, 12));
        } else if (fa.kind === 'access') {
          rec.vertexColours = accessibilityColours(mesh, dir);
        } else if (fa.kind === 'chrome') {
          rec.chrome = true;
        }
      }
    }

    if (state.draft) {
      const evald = resolveParameters(state.doc.parameters).scope;
      const base = resolvePlane(state.draft.plane, evald, res.construction);
      if (base) {
        const sign = state.draft.flip ? -1 : 1;
        const dir = [base.n[0] * sign, base.n[1] * sign, base.n[2] * sign];
        const angle = safeEval(state.draft.angle, evald, 3);
        for (const rec of records) {
          rec.vertexColours = draftColours(rec.displayMesh || rec.mesh, dir, angle);
        }
      }
    }
  } finally {
    scope.dispose();
  }
}

/** The section's cutting plane, resolved against this rebuild's construction. */
function sectionPlaneFor(res, scope) {
  if (!state.section) return null;
  const evald = resolveParameters(state.doc.parameters).scope;
  const base = resolvePlane(state.section.plane, evald, res.construction);
  if (!base) return null;
  const d = safeEval(state.section.offset, evald, 0);
  const sign = state.section.flip ? -1 : 1;
  return {
    origin: [
      base.origin[0] + base.n[0] * d,
      base.origin[1] + base.n[1] * d,
      base.origin[2] + base.n[2] * d
    ],
    n: [base.n[0] * -sign, base.n[1] * -sign, base.n[2] * -sign]
  };
}

/* ------------------------------------------------------------------ */
/* Inspect                                                             */
/* ------------------------------------------------------------------ */

/**
 * Cut the view open on a plane.
 *
 * The cut is a real boolean against a half space rather than a clipping plane,
 * because clipping only hides the triangles in front and what shows through is
 * the inside of the surface: a solid reads as hollow, which is the opposite of
 * what a section is for. The model is untouched; only what is drawn changes.
 */
function startSectionAnalysis() {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('Nothing to cut through yet.');
    return;
  }
  const scope = resolveParameters(state.doc.parameters).scope;
  const current = state.section || { plane: 'XY', offset: '0', flip: false };

  showInspector(
    'Section Analysis',
    [
      {
        key: 'plane',
        label: 'Cut with',
        type: 'select',
        value: optionForPlane(current.plane),
        options: planeOptions()
      },
      { key: 'offset', label: `Offset (${unitLabel()})`, type: 'expr', value: current.offset },
      { key: 'flip', label: 'Flip which half is kept', type: 'check', value: current.flip },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'A view, not a change. The model keeps its shape and an export is unaffected.'
      }
    ],
    (v) => {
      state.section = {
        plane: planeSpecFromOption(v.plane),
        offset: v.offset,
        flip: !!v.flip
      };
      state.dirty = false;
      rebuildAll();
      setStatus('Section on. Inspect again, or Clear Analysis, to put it away.');
    }
  );
}

/**
 * What the part weighs, and where it balances.
 *
 * A density has to come from somewhere, so a material does. The number is for
 * the same shape solid: a printed part is infill and air, and saying so is
 * more use than quietly reporting a mass it will never have.
 */
function startCentreOfMass() {
  if (state.sketcher.active) finishSketch();
  // A surface encloses nothing, so it has no mass and no centre of one.
  const records = (state.records || []).filter((r) => r.mesh && !r.sheet);
  if (!records.length) {
    setStatus('Nothing to weigh yet. A surface has no mass.');
    return;
  }
  const chosen = state.selection.bodies.size
    ? records.filter((r) => state.selection.bodies.has(r.id))
    : records;

  const mats = state.doc.materials || {};
  const entries = chosen.map((r) => ({
    id: r.id,
    name: r.name,
    mesh: r.mesh,
    material: mats.byBody?.[r.id] || mats.default || 'pla'
  }));
  const props = combinedMass(entries);

  showInspector(
    'Centre Of Mass',
    [
      {
        key: 'material',
        label: 'Material',
        type: 'select',
        value: mats.default || 'pla',
        options: MATERIALS.map(([id, label, d]) => [id, `${label}  ${d} g/cc`])
      },
      {
        key: '__note',
        label: '',
        type: 'note',
        text:
          `${chosen.length} bod${chosen.length === 1 ? 'y' : 'ies'}, ` +
          `${round(props.volume / 1000, 2)} cc, ${round(props.mass, 2)} g as ` +
          `${materialLabel(entries[0]?.material)}. ` +
          `Balances at ${props.centre.map((n) => round(n, 2)).join(', ')}.`
      },
      {
        key: '__note2',
        label: '',
        type: 'note',
        text: 'Solid, at that density. A printed part is infill and air and will weigh less.'
      }
    ],
    (v) => {
      state.doc.materials = { ...(state.doc.materials || {}), default: v.material };
      state.dirty = true;
      const again = combinedMass(
        chosen.map((r) => ({ id: r.id, name: r.name, mesh: r.mesh, material: v.material }))
      );
      state.massMarker = again.centre;
      rebuildAll();
      setStatus(
        `${round(again.mass, 2)} g of ${materialLabel(v.material)}, ` +
          `balancing at ${again.centre.map((n) => round(n, 2)).join(', ')}.`
      );
    }
  );
}

/** Every pair of bodies that shares space, worst first. */
function startInterference() {
  if (state.sketcher.active) finishSketch();
  const bodies = (state.result?.bodies || []).filter((b) => b.solid);
  if (bodies.length < 2) {
    setStatus('Interference needs two solid bodies to compare.');
    return;
  }
  const chosen = state.selection.bodies.size
    ? bodies.filter((b) => state.selection.bodies.has(b.id))
    : bodies;
  if (chosen.length < 2) {
    setStatus('Select at least two bodies, or none to check them all.');
    return;
  }

  const scope = new K.Scope();
  let hits;
  try {
    hits = interferences(chosen, scope);
  } finally {
    scope.dispose();
  }

  if (!hits.length) {
    showInspector(
      'Interference',
      [
        {
          key: '__note',
          label: '',
          type: 'note',
          text: `No overlap between ${chosen.length} bodies. Touching is not counted.`
        }
      ],
      () => {}
    );
    setStatus(`${chosen.length} bodies checked. Nothing overlaps.`);
    return;
  }

  showInspector(
    'Interference',
    hits.slice(0, 12).map((h, i) => ({
      key: `__hit${i}`,
      label: '',
      type: 'note',
      text: `${h.nameA} and ${h.nameB} share ${round(h.volume, 3)} mm3, around ${h.centroid
        .map((n) => round(n, 1))
        .join(', ')}.`
    })),
    () => {}
  );
  setStatus(`${hits.length} overlap${hits.length === 1 ? '' : 's'} found.`);
}

/**
 * Let the load decide the shape.
 *
 * The question it answers is the one nobody can answer by eye. Given where the
 * part is held, where it is pushed, and how much material it may have, where
 * should that material go? Not "is this bracket strong enough", which is what
 * the stress solver answers, but "what should the bracket look like".
 *
 * It is set up exactly like a stress run, because it is one: the same held
 * faces, the same pushed faces, the same load. What it adds is the allowance,
 * and then it solves the part forty times over, each time taking material from
 * where it is idle and giving it to where it is working.
 *
 * What comes out is a new body, blocky at the resolution it was worked out at,
 * and it is meant to be worked on rather than printed. Smooth it, or trace it,
 * or use it as the shape to model properly. That is how this is used everywhere
 * it is used.
 */
function cmdGenerative() {
  if (state.sketcher.active) finishSketch();
  const setup = state.stressSetup;
  if (!setup?.held?.length || !setup?.pushed?.length) {
    setStatus('Set it up under Stress first: hold some faces, push some others.');
    return;
  }

  const kept = state.generativeSetup || { fraction: '35', rounds: '30', through: '3', fine: '1.5' };
  showInspector(
    'Generative Design',
    [
      { key: 'fraction', label: 'How much material it may keep, per cent', type: 'expr', value: kept.fraction },
      {
        key: 'through',
        label: 'Cubes through the thinnest part',
        type: 'select',
        value: kept.through,
        options: [
          ['2', '2, quick and blocky'],
          ['3', '3'],
          ['4', '4, slow'],
          ['5', '5, very slow']
        ]
      },
      { key: 'fine', label: 'Finest feature, in cubes', type: 'expr', value: kept.fine },
      { key: 'rounds', label: 'How many rounds at most', type: 'expr', value: kept.rounds },
      {
        key: '__setup',
        label: '',
        type: 'note',
        text: `${setup.held.length} held, ${setup.pushed.length} pushed, ${setup.force} newtons ${
          { 'z-': 'down', 'z+': 'up', into: 'into the face' }[setup.direction] || setup.direction
        }.`
      },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'It solves the part once per round, so this takes a while. What comes out is blocky at the resolution it was worked out at, and it is a shape to work from rather than a part to print.'
      }
    ],
    async (v) => {
      state.generativeSetup = { ...v };
      await runGenerative({ ...setup, ...v });
    }
  );
}

async function runGenerative(setup) {
  const body = (state.result?.bodies || []).find(
    (b) => b.solid && b.id === setup.held[0].body
  );
  const record = (state.records || []).find((r) => r.id === body?.id);
  if (!record?.topology) {
    setStatus('That body is not here any more.');
    return;
  }

  const scope = resolveParameters(state.doc.parameters);
  const through = Math.round(safeEval(setup.through, scope, 3));
  const fraction = Math.max(5, Math.min(90, safeEval(setup.fraction, scope, 35))) / 100;
  const rounds = Math.max(5, Math.min(200, Math.round(safeEval(setup.rounds, scope, 30))));
  const fine = Math.max(1, safeEval(setup.fine, scope, 1.5));

  setStatus('Cutting the design space into cubes...');
  await new Promise((r) => setTimeout(r, 0));

  const grid = FE.voxelise(record.mesh, { through });
  if (!grid) {
    setStatus('That body could not be cut into cubes.');
    return;
  }
  const nodes = FE.nodesOf(grid);
  const mats = state.doc.materials || {};
  const material = FE.stiffnessOf(mats.byBody?.[body.id] || mats.default || 'pla');
  const Ke = FE.hexStiffness(material.modulus, material.poisson, grid.size);

  // Which cell each element sits in, in the order the elements were made, which
  // is what lets a reading be blurred with its neighbours.
  const cells = [];
  for (let k = 0; k < grid.n[2]; k++) {
    for (let j = 0; j < grid.n[1]; j++) {
      for (let i = 0; i < grid.n[0]; i++) {
        if (grid.inside[grid.at(i, j, k)]) cells.push((k * grid.n[1] + j) * grid.n[0] + i);
      }
    }
  }

  const held = stressNodesFor(setup.held, record, nodes, grid);
  const pushed = stressNodesFor(setup.pushed, record, nodes, grid);
  if (!held.length || !pushed.length) {
    setStatus('The grid is too coarse to land on those faces. Try more cubes.');
    return;
  }

  const magnitude = safeEval(setup.force, scope, 100);
  const dir = stressDirection(setup, record);
  const forces = FE.spreadForce(pushed, dir.map((v) => v * magnitude), nodes.elements);
  const fixed = FE.dofsOf(held);

  // The material carrying the load in and out has to stay: taking away the
  // face that is bolted down solves a different problem.
  const locked = new Uint8Array(cells.length);
  lockAround(nodes, cells, grid, [...held, ...pushed], locked);

  setStatus(`Working, ${cells.length} cubes, up to ${rounds} rounds...`);
  await new Promise((r) => setTimeout(r, 0));

  const near = GD.neighbourhood(grid, cells, fine);
  const t0 = performance.now();
  let last = null;
  const out = GD.optimise(
    cells.length,
    (scale, guess) =>
      FE.solve(nodes, nodes.elements, Ke, { fixed, forces, scale, guess, iterations: 800 }),
    (u) => FE.elementEnergy(nodes.elements, Ke, u),
    near,
    {
      fraction,
      rounds,
      locked,
      onRound: (r) => {
        last = r;
        setStatus(
          `Round ${r.round} of ${rounds}, giving ${r.compliance.toExponential(2)}, still moving by ${r.change.toFixed(3)}.`
        );
      }
    }
  );
  if (!out.ok) {
    setStatus(out.reason);
    return;
  }

  const shape = GD.surfaceOf(grid, cells, out.density, 0.5);
  if (!shape) {
    setStatus('Nothing was left. Allow it more material.');
    return;
  }

  pushUndo('generative design');
  const key = uid('mesh');
  state.doc.meshData[key] = {
    verts: Array.from(shape.vertProperties),
    tris: Array.from(shape.triVerts)
  };
  state.doc.features.push({
    id: uid('f'),
    type: 'insertMesh',
    data: key,
    label: `${body.name} generated`,
    scale: '1',
    at: [0, 0, 0]
  });
  state.dirty = true;
  rebuildAll();

  const first = out.history[0].compliance;
  const final = out.history[out.history.length - 1].compliance;
  const took = Math.round((performance.now() - t0) / 100) / 10;
  setStatus(
    `${Math.round(GD.usage(out.density) * 100)} in a hundred of the space kept, ` +
      `${(first / final).toFixed(1)} times stiffer than spreading the same material evenly. ` +
      `${out.rounds} rounds, ${took} s. It is blocky on purpose: smooth it on the Mesh tab.`
  );
}

/** Lock the cubes around a set of nodes, so a fixture is never optimised away. */
function lockAround(nodes, cells, grid, list, locked) {
  const [nx, ny] = grid.n;
  const index = new Map();
  cells.forEach((cell, e) => index.set(cell, e));
  for (const n of list) {
    const i = Math.floor((nodes.xyz[n * 3] - grid.origin[0]) / grid.size);
    const j = Math.floor((nodes.xyz[n * 3 + 1] - grid.origin[1]) / grid.size);
    const k = Math.floor((nodes.xyz[n * 3 + 2] - grid.origin[2]) / grid.size);
    for (let dk = -1; dk <= 0; dk++) {
      for (let dj = -1; dj <= 0; dj++) {
        for (let di = -1; di <= 0; di++) {
          const e = index.get((k + dk) * nx * ny + (j + dj) * nx + (i + di));
          if (e !== undefined) locked[e] = 1;
        }
      }
    }
  }
}

/** The nodes a set of held or pushed faces comes to, on a given grid. */
function stressNodesFor(refs, record, nodes, grid) {
  const seen = new Set();
  for (const r of refs) {
    const [face] = resolveFaceRefs(record.topology, [r.face]);
    if (!face) continue;
    for (const n of FE.nodesNear(
      nodes,
      { origin: face.centre, normal: face.normal },
      grid.size * 0.6
    )) {
      if (withinFace(nodes, n, face, grid.size)) seen.add(n);
    }
  }
  return [...seen];
}

/** Which way a stress or generative setup pushes. */
function stressDirection(setup, record) {
  if (setup.direction === 'into') {
    const [face] = resolveFaceRefs(record.topology, [setup.pushed[0].face]);
    if (face) return face.normal.map((v) => -v);
  }
  return (
    {
      'z-': [0, 0, -1],
      'z+': [0, 0, 1],
      'x+': [1, 0, 0],
      'x-': [-1, 0, 0],
      'y+': [0, 1, 0],
      'y-': [0, -1, 0]
    }[setup.direction] || [0, 0, -1]
  );
}

/**
 * What happens to a part when it is pushed.
 *
 * A real finite element solve, not a rule of thumb. What it needs from the
 * person is the three things it cannot know: which faces are held, which faces
 * are pushed and how hard, and how fine to cut the part up.
 *
 * The last one is the one to understand. Everything here is worked out on a
 * grid of little cubes, and a single run at one grid is not a number to design
 * to. Two runs at different resolutions are: when the answer stops moving, it
 * is the answer. The panel says what resolution it used so that comparison can
 * actually be made.
 */
function cmdSimulate() {
  if (state.sketcher.active) finishSketch();
  const solids = (state.result?.bodies || []).filter((b) => b.solid);
  if (!solids.length) {
    setStatus('Stress analysis needs a solid body.');
    return;
  }

  const picked = pickedFaceList();
  const kept = state.stressSetup || {
    held: null,
    pushed: null,
    force: '100',
    direction: 'z-',
    through: '4'
  };
  // Whatever is selected now is taken as the answer to whichever question has
  // not been answered yet, which is how this gets used: pick, run, pick, run.
  const setup = { ...kept };
  if (picked.length && !setup.held) setup.held = picked.map((f) => f.ref);
  else if (picked.length && !setup.pushed) setup.pushed = picked.map((f) => f.ref);

  showInspector(
    'Stress Analysis',
    [
      {
        key: '__held',
        label: 'Held',
        type: 'action',
        run: () => {
          const now = pickedFaceList();
          if (!now.length) {
            setStatus('Select the faces that are bolted down, then press Held.');
            return;
          }
          setup.held = now.map((f) => f.ref);
          state.stressSetup = { ...setup };
          setStatus(`${now.length} face${now.length === 1 ? '' : 's'} held.`);
        }
      },
      {
        key: '__pushed',
        label: 'Pushed',
        type: 'action',
        run: () => {
          const now = pickedFaceList();
          if (!now.length) {
            setStatus('Select the faces the load is on, then press Pushed.');
            return;
          }
          setup.pushed = now.map((f) => f.ref);
          state.stressSetup = { ...setup };
          setStatus(`${now.length} face${now.length === 1 ? '' : 's'} pushed.`);
        }
      },
      { key: 'force', label: 'How hard, in newtons', type: 'expr', value: setup.force },
      {
        key: 'direction',
        label: 'Which way',
        type: 'select',
        value: setup.direction,
        options: [
          ['z-', 'Down'],
          ['z+', 'Up'],
          ['x+', 'Along X'],
          ['x-', 'Back along X'],
          ['y+', 'Along Y'],
          ['y-', 'Back along Y'],
          ['into', 'Into the face']
        ]
      },
      {
        key: 'through',
        label: 'Cubes through the thinnest part',
        type: 'select',
        value: setup.through,
        options: [
          ['2', '2, quick and rough'],
          ['3', '3'],
          ['4', '4, a fair answer'],
          ['6', '6'],
          ['8', '8, slow']
        ]
      },
      {
        key: '__state',
        label: '',
        type: 'note',
        text: `${setup.held ? `${setup.held.length} held` : 'nothing held yet'}, ${
          setup.pushed ? `${setup.pushed.length} pushed` : 'nothing pushed yet'
        }.`
      },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'One run at one resolution is not a number to design to. Run it twice at different resolutions: when the answer stops moving, that is the answer.'
      }
    ],
    async (v) => {
      state.stressSetup = { ...setup, ...v };
      await runStress({ ...setup, ...v });
    }
  );
}

/** Every face currently picked, with a reference that survives a rebuild. */
function pickedFaceList() {
  const out = [];
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    const record = (state.records || []).find((r) => r.id === bodyId);
    const face = record?.topology?.faces[index];
    if (!face) continue;
    out.push({ bodyId, face, ref: { body: bodyId, face: faceReference(face, record.topology) } });
  }
  return out;
}

/**
 * Cut the part up, solve it, and colour it by what came out.
 *
 * The faces are turned into held and pushed nodes by their own planes rather
 * than by picking nodes: what somebody means by "hold this face" is every node
 * on it, and a face of the grid is a slab one element thick.
 */
async function runStress(setup) {
  const body = (state.result?.bodies || []).find(
    (b) => b.solid && (!setup.held?.length || b.id === setup.held[0].body)
  );
  if (!body) {
    setStatus('That body is not here any more.');
    return;
  }
  if (!setup.held?.length) {
    setStatus('Nothing is holding it. Select the faces that are bolted down and press Held.');
    return;
  }
  if (!setup.pushed?.length) {
    setStatus('Nothing is pushing it. Select the faces the load is on and press Pushed.');
    return;
  }

  const record = (state.records || []).find((r) => r.id === body.id);
  if (!record?.topology) {
    setStatus('That body could not be read.');
    return;
  }
  const scope = resolveParameters(state.doc.parameters);
  const through = Math.round(safeEval(setup.through, scope, 4));

  setStatus(`Cutting it into cubes, ${through} through the thinnest part...`);
  await new Promise((r) => setTimeout(r, 0));

  const mesh = record.mesh;
  // Sized by the thin direction rather than the long one. Stiffness in bending
  // goes as the thickness cubed, so a section that comes out a quarter too fat
  // because the cells did not divide it is two and a half times too stiff, and
  // nothing else in the answer looks wrong.
  const grid = FE.voxelise(mesh, { through });
  if (!grid) {
    setStatus('That body could not be cut into cubes. It may not be closed.');
    return;
  }
  const nodes = FE.nodesOf(grid);
  const quality = FE.gridQuality(grid);

  const mats = state.doc.materials || {};
  const material = FE.stiffnessOf(mats.byBody?.[body.id] || mats.default || 'pla');
  const Ke = FE.hexStiffness(material.modulus, material.poisson, grid.size);

  const held = stressNodesFor(setup.held, record, nodes, grid);
  const pushed = stressNodesFor(setup.pushed, record, nodes, grid);
  if (!held.length || !pushed.length) {
    setStatus('The grid is too coarse to land on those faces. Try more cubes.');
    return;
  }

  const magnitude = safeEval(setup.force, scope, 100);
  const dir = stressDirection(setup, record);

  setStatus(`Solving, ${nodes.count * 3} unknowns...`);
  await new Promise((r) => setTimeout(r, 0));

  const t0 = performance.now();
  const res = FE.solve(nodes, nodes.elements, Ke, {
    fixed: FE.dofsOf(held),
    forces: FE.spreadForce(pushed, dir.map((v) => v * magnitude), nodes.elements)
  });
  if (!res.ok) {
    setStatus(res.reason);
    return;
  }
  const out = FE.stresses(nodes, nodes.elements, res.displacement, material, grid.size);
  const took = Math.round(performance.now() - t0);

  const trueVolume = body.solid.volume();
  const fidelity = FE.volumeError(grid, trueVolume);

  state.stress = {
    bodyId: body.id,
    grid,
    nodes,
    result: out,
    material,
    through,
    quality,
    fidelity,
    colours: new Map([[body.id, stressColours(mesh, grid, nodes, out)]])
  };
  rebuildAll();

  const words = [
    `${out.maxStress.toFixed(1)} MPa at worst, ${material.yield} to yield, so ${
      out.factor > 99 ? 'nowhere near it' : `${out.factor.toFixed(1)} times over`
    }.`,
    `It moves ${out.maxMove.toFixed(3)} mm.`,
    `${grid.filled} cubes, ${quality.across} through the thinnest part, ${res.iterations} passes, ${took} ms.`
  ];
  if (!quality.enough) {
    words.push('The grid is coarser than the part is thick, so this is about a different part. Use more cubes.');
  }
  if (!fidelity.ok) {
    // The one that catches what nothing else does: cubes that do not divide a
    // section leave it fatter or thinner than it is, and stiffness goes as the
    // cube of that.
    words.push(
      `The cubes come to ${fidelity.percent > 0 ? '' : 'minus '}${Math.abs(fidelity.percent).toFixed(0)} in a hundred ${
        fidelity.percent > 0 ? 'more' : 'less'
      } material than the part has, so it is being solved a little ${
        fidelity.percent > 0 ? 'fatter' : 'thinner'
      } than it is.`
    );
  }
  if (grid.capped) {
    words.push('That resolution was more cubes than is sensible, so it was made coarser.');
  }
  if (!res.converged) {
    words.push('The solve did not settle. Treat the numbers as a hint.');
  }
  setStatus(words.join(' '));
}

/**
 * Is this node actually on that face, or merely level with it?
 *
 * A plane through one end of a part passes through everything else at the same
 * height, and holding all of that is not what "hold this face" means.
 */
function withinFace(nodes, node, face, size) {
  const p = [nodes.xyz[node * 3], nodes.xyz[node * 3 + 1], nodes.xyz[node * 3 + 2]];
  let best = Infinity;
  const step = Math.max(1, Math.floor(face.tris.length / 64));
  for (let i = 0; i < face.tris.length; i += step) {
    const c = face.centre;
    const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
    if (d < best) best = d;
    break;
  }
  // The face's own reach, plus a cube, which is as near as a grid can get.
  return best <= faceReach(face) + size;
}

/** How far a face extends from its own middle. */
function faceReach(face) {
  if (face._reach !== undefined) return face._reach;
  // From the area, which is already known, rather than from the triangles.
  face._reach = Math.sqrt(Math.max(face.area, 0)) * 0.75;
  return face._reach;
}

/**
 * A colour per vertex of the drawn mesh, from the stress in the cube it is in.
 *
 * Nearest cube rather than interpolated. The result is a step per cube, which
 * is honest: that is the resolution the answer was worked out at, and a smooth
 * picture would suggest a precision the grid does not have.
 */
function stressColours(mesh, grid, nodes, out) {
  const vp = mesh.vertProperties;
  const stride = mesh.numProp;
  const count = vp.length / stride;
  const colours = new Float32Array(count * 3);
  const peak = Math.max(1e-9, out.maxStress);

  // Which element is in each cell, so a vertex can find its stress by position.
  const cell = new Int32Array(grid.n[0] * grid.n[1] * grid.n[2]).fill(-1);
  let e = 0;
  for (let k = 0; k < grid.n[2]; k++) {
    for (let j = 0; j < grid.n[1]; j++) {
      for (let i = 0; i < grid.n[0]; i++) {
        if (grid.inside[grid.at(i, j, k)]) cell[grid.at(i, j, k)] = e++;
      }
    }
  }

  for (let v = 0; v < count; v++) {
    const x = vp[v * stride];
    const y = vp[v * stride + 1];
    const z = vp[v * stride + 2];
    const i = Math.max(0, Math.min(grid.n[0] - 1, Math.floor((x - grid.origin[0]) / grid.size)));
    const j = Math.max(0, Math.min(grid.n[1] - 1, Math.floor((y - grid.origin[1]) / grid.size)));
    const k = Math.max(0, Math.min(grid.n[2] - 1, Math.floor((z - grid.origin[2]) / grid.size)));
    const at = cell[grid.at(i, j, k)];
    const t = at >= 0 ? Math.min(1, out.vonMises[at] / peak) : 0;
    const [r, g, b] = heat(t);
    colours[v * 3] = r;
    colours[v * 3 + 1] = g;
    colours[v * 3 + 2] = b;
  }
  return colours;
}

/**
 * Cool to hot, for a number already scaled from nought to one.
 *
 * Blue through green to red, because that is the ramp every stress plot in
 * every package uses and reading one should not need a legend to be learned.
 */
function heat(t) {
  const x = Math.max(0, Math.min(1, t));
  if (x < 0.5) {
    const u = x * 2;
    return [0.16 + 0.2 * u, 0.4 + 0.4 * u, 0.75 - 0.35 * u];
  }
  const u = (x - 0.5) * 2;
  return [0.36 + 0.6 * u, 0.8 - 0.65 * u, 0.4 - 0.35 * u];
}

/** Put the ordinary colour back. */
function clearStress() {
  if (!state.stress) {
    setStatus('No stress result to clear.');
    return;
  }
  state.stress = null;
  rebuildAll();
  setStatus('Stress colours cleared.');
}

/**
 * Take the assembly apart, on a timeline.
 *
 * What this is for is telling somebody how a thing goes together. An exploded
 * view is the single most useful drawing there is for that, and a moving one is
 * better still, because it shows the order as well as the arrangement.
 *
 * Nothing here rebuilds anything. A step is a transform laid over a body for
 * display, so scrubbing costs nothing and the model underneath never moves,
 * which is what stops the assembly being left wherever the playhead stopped.
 */
function cmdAnimate() {
  if (state.sketcher.active) finishSketch();
  const parts = animatableParts();
  if (parts.length < 2) {
    setStatus('An exploded view needs two or more components. Make some first.');
    return;
  }
  state.doc.animation = state.doc.animation || AN.newStoryboard();
  state.anim = state.anim || { time: 0, playing: false };
  drawAnimationPanel();
}

/** Every component that has a body, with where its middle is. */
function animatableParts() {
  const byComponent = new Map();
  for (const record of state.records || []) {
    const body = (state.result?.bodies || []).find((b) => b.id === record.id);
    if (!body?.component || !record.topology) continue;
    const centre = [0, 0, 0];
    let weight = 0;
    for (const face of record.topology.faces) {
      for (let i = 0; i < 3; i++) centre[i] += face.centre[i] * face.area;
      weight += face.area;
    }
    if (weight < 1e-9) continue;
    const held = byComponent.get(body.component) || {
      component: body.component,
      name: componentName(body.component),
      bodies: [],
      sum: [0, 0, 0],
      weight: 0
    };
    held.bodies.push(record.id);
    for (let i = 0; i < 3; i++) held.sum[i] += centre[i];
    held.weight += weight;
    byComponent.set(body.component, held);
  }
  return [...byComponent.values()].map((c) => ({
    ...c,
    centre: c.sum.map((v) => v / Math.max(1e-9, c.weight))
  }));
}

/** Lay the current moment of the storyboard over the bodies. */
function applyAnimationOffsets() {
  const story = state.doc.animation;
  if (!story?.steps?.length || !state.anim) {
    state.vp.setBodyOffsets(null);
    return;
  }
  const byComponent = AN.offsetsAt(story, state.anim.time || 0);
  const perBody = new Map();
  for (const body of state.result?.bodies || []) {
    const held = body.component && byComponent.get(body.component);
    if (held) perBody.set(body.id, held);
  }
  state.vp.setBodyOffsets(perBody);
}

/** The panel that builds and plays a storyboard. */
function drawAnimationPanel() {
  const story = state.doc.animation;
  const parts = animatableParts();
  const length = AN.lengthOf(story);

  showInspector(
    'Animation',
    [
      {
        key: '__caption',
        label: '',
        type: 'note',
        text: `${AN.captionAt(story, state.anim.time)} · ${state.anim.time.toFixed(2)} of ${length.toFixed(2)} seconds`
      },
      {
        key: 'time',
        label: 'Where the playhead is',
        type: 'expr',
        get: () => String(state.anim.time.toFixed(2)),
        set: (f, v) => {
          const t = Number(v);
          if (!Number.isFinite(t)) return;
          state.anim.time = Math.max(0, Math.min(AN.lengthOf(story), t));
          applyAnimationOffsets();
        }
      },
      {
        key: '__play',
        label: state.anim.playing ? 'Stop' : 'Play it through',
        type: 'action',
        run: () => togglePlay()
      },
      {
        key: '__explode',
        label: 'Take it apart automatically',
        type: 'action',
        run: () => {
          const made = AN.autoExplode(parts, { spread: 1.6 });
          if (!made) {
            setStatus('There is nothing here to take apart.');
            return;
          }
          pushUndo('explode');
          state.doc.animation = made;
          state.anim.time = AN.lengthOf(made);
          state.dirty = true;
          applyAnimationOffsets();
          drawAnimationPanel();
          setStatus(`${made.steps.length} parts, ${AN.lengthOf(made).toFixed(1)} seconds.`);
        }
      },
      {
        key: '__together',
        label: 'Put it back together',
        type: 'action',
        run: () => {
          state.anim.time = 0;
          applyAnimationOffsets();
          drawAnimationPanel();
        }
      },
      ...(story.steps || []).slice(0, 12).map((step, i) => ({
        key: `__s${i}`,
        label: '',
        type: 'note',
        text: `${(step.start || 0).toFixed(2)}s  ${step.name} · ${Math.round(
          Math.hypot(...(step.move || [0, 0, 0]))
        )} away`
      })),
      {
        key: '__clear',
        label: 'Clear the storyboard',
        type: 'action',
        run: () => {
          pushUndo('clear animation');
          state.doc.animation = AN.newStoryboard();
          state.anim.time = 0;
          state.dirty = true;
          applyAnimationOffsets();
          drawAnimationPanel();
        }
      },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'Nothing here moves the model. The parts come apart on screen and the geometry stays where it is, so wherever the playhead stops, the assembly is still assembled.'
      }
    ],
    () => {
      state.anim.playing = false;
    }
  );
}

/** Run the storyboard, or stop it. */
function togglePlay() {
  if (!state.anim) return;
  if (state.anim.playing) {
    state.anim.playing = false;
    drawAnimationPanel();
    return;
  }
  const story = state.doc.animation;
  const length = AN.lengthOf(story);
  state.anim.playing = true;
  state.anim.time = 0;
  const started = performance.now();

  const tick = () => {
    if (!state.anim.playing) return;
    const t = (performance.now() - started) / 1000;
    state.anim.time = Math.min(length, t);
    applyAnimationOffsets();
    if (t >= length) {
      state.anim.playing = false;
      drawAnimationPanel();
      setStatus('Apart.');
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  drawAnimationPanel();
}

/**
 * A still of the model, better than the screen can draw in real time.
 *
 * Not a path tracer and not pretending to be one. What makes the difference is
 * accumulation: the same view is drawn many times with the camera moved by a
 * fraction of a pixel and the lights moved a little each pass, and the results
 * averaged. Jittering the camera gives antialiasing far past what the hardware
 * does, and jittering the lights turns every hard shadow soft for nothing,
 * because a light sampled over an area is what a soft shadow is.
 *
 * The finish comes from the material, which is the point of having said what
 * each body is made of: steel renders as metal because it is metal, and a
 * printed part does not.
 */
function cmdRender() {
  if (state.sketcher.active) finishSketch();
  if (!(state.result?.bodies || []).length) {
    setStatus('Nothing to render yet.');
    return;
  }
  const kept = state.render || {
    size: '1600',
    samples: '48',
    softness: '0.08',
    background: '#20242a',
    finish: true
  };

  showInspector(
    'Render',
    [
      {
        key: 'size',
        label: 'Width in pixels',
        type: 'select',
        value: kept.size,
        options: [
          ['800', '800, quick look'],
          ['1600', '1600, for a document'],
          ['2400', '2400, for print'],
          ['3200', '3200, big']
        ]
      },
      {
        key: 'samples',
        label: 'Passes',
        type: 'select',
        value: kept.samples,
        options: [
          ['8', '8, rough'],
          ['24', '24'],
          ['48', '48, good'],
          ['128', '128, slow and clean']
        ]
      },
      { key: 'softness', label: 'How soft the shadows', type: 'expr', value: kept.softness },
      {
        key: 'background',
        label: 'Behind it',
        type: 'select',
        value: kept.background,
        options: [
          ['#20242a', 'The usual dark'],
          ['#f2f0ec', 'White, for a document'],
          ['#000000', 'Black'],
          ['transparent', 'Nothing, so it can be laid on anything']
        ]
      },
      { key: 'finish', label: 'Use what each body is made of', type: 'bool', value: kept.finish },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'More passes means less noise and a cleaner edge, and takes longer in proportion. Nothing of the tool is in the picture: no grid, no planes, no manipulator.'
      }
    ],
    async (v) => {
      state.render = { ...v };
      const scope = resolveParameters(state.doc.parameters);
      const width = Math.round(safeEval(v.size, scope, 1600));
      const rect = state.vp.canvas.getBoundingClientRect();
      const height = Math.max(64, Math.round((width * rect.height) / Math.max(1, rect.width)));

      const undo = v.finish ? applyRenderFinish() : null;
      setStatus(`Rendering ${width} by ${height}, ${v.samples} passes...`);
      let canvas;
      try {
        canvas = await state.vp.renderStill({
          width,
          height,
          samples: Math.round(safeEval(v.samples, scope, 48)),
          softness: safeEval(v.softness, scope, 0.08),
          background: v.background
        });
      } catch (err) {
        undo?.();
        setStatus(`The render failed: ${err.message}`);
        return;
      }
      undo?.();

      const bytes = await pngBytesOf(canvas);
      const base = (state.docPath ? state.docPath.split(/[\\/]/).pop() : 'Untitled').replace(
        /\.anvil$/i,
        ''
      );
      const res = await window.anvil.exportImage?.(`${base}.png`, bytes);
      if (res?.ok) {
        setStatus(`Saved ${res.path.split(/[\\/]/).pop()}, ${width} by ${height}.`);
        window.anvil.showItem(res.path);
      } else if (res?.error) {
        setStatus(`Could not save it: ${res.error}`);
      } else {
        setStatus('Render finished, not saved.');
      }
    }
  );
}

/**
 * Give every body the finish of what it is made of, and hand back the undo.
 *
 * This is what makes the Material command worth more than a number on a mass
 * report: steel renders as metal because it is metal. Put back afterwards,
 * because the working view is deliberately matt, so the shape is the subject
 * and not the finish.
 */
function applyRenderFinish() {
  const mats = state.doc.materials || {};
  const was = [];
  for (const record of state.records || []) {
    const entry = state.vp.bodies?.get(record.id);
    if (!entry?.mat) continue;
    const name = mats.byBody?.[record.id] || mats.default || 'pla';
    was.push({ mat: entry.mat, metalness: entry.mat.metalness, roughness: entry.mat.roughness });
    const metal = ['aluminium', 'steel', 'stainless', 'brass', 'titanium'].includes(name);
    entry.mat.metalness = metal ? 0.85 : 0.05;
    entry.mat.roughness = metal ? 0.32 : name === 'resin' ? 0.25 : 0.55;
    entry.mat.needsUpdate = true;
  }
  return () => {
    for (const w of was) {
      w.mat.metalness = w.metalness;
      w.mat.roughness = w.roughness;
      w.mat.needsUpdate = true;
    }
    state.vp.invalidate();
  };
}

/** A canvas as PNG bytes, which is what the file writer wants. */
async function pngBytesOf(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * A note pinned to a place on the model.
 *
 * The reason to have these rather than a text file beside the part is that a
 * note about a face is useless once you cannot tell which face. Pinned, it
 * points at the thing it is about, and it moves when the model does because
 * what is stored is a reference to the face and not a position in space.
 *
 * Notes are not geometry and do not go in the timeline. Rolling back past one
 * would be a strange thing for a remark to do.
 */
function cmdAddNote() {
  if (state.sketcher.active) finishSketch();
  const anchor = noteAnchorFromSelection();
  if (!anchor) {
    setStatus('Select the face or edge the note is about first.');
    return;
  }

  showInspector(
    'Note',
    [
      { key: 'text', label: 'Note', type: 'text', value: '' },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'Pinned to what is selected, so it points at the thing it is about and moves when the model does.'
      }
    ],
    (v) => {
      const text = String(v.text || '').trim();
      if (!text) {
        setStatus('A note with nothing in it is not a note.');
        return;
      }
      pushUndo('note');
      state.doc.notes = state.doc.notes || [];
      state.doc.notes.push({ id: uid('note'), text, ...anchor, done: false });
      state.dirty = true;
      renderTree();
      rebuildAll();
      setStatus('Note pinned.');
    }
  );
}

/** Where a note goes, as a reference that survives a rebuild plus a fallback. */
function noteAnchorFromSelection() {
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    const record = (state.records || []).find((r) => r.id === bodyId);
    const face = record?.topology?.faces[index];
    if (!face) continue;
    return { face: faceReference(face, record.topology), at: face.centre.slice() };
  }
  for (const key of state.selection.edges) {
    const { bodyId, index } = splitKey(key);
    const record = (state.records || []).find((r) => r.id === bodyId);
    const edge = record?.topology?.edges[index];
    if (!edge?.points?.length) continue;
    const mid = edge.points[Math.floor(edge.points.length / 2)];
    return { edge: edgeReference(edge, record.topology), at: mid.slice() };
  }
  return null;
}

/**
 * Where every note currently is, in the world.
 *
 * Looked up again each rebuild rather than stored, so a note follows the face
 * it is about. When the face has gone the note stays where it was put and says
 * so, because a note that vanishes because a fillet was added is worse than one
 * sitting in roughly the right place.
 */
function noteAnchors() {
  const out = [];
  for (const note of state.doc.notes || []) {
    let at = note.at;
    let lost = true;
    for (const record of state.records || []) {
      if (!record.topology) continue;
      if (note.face) {
        const [face] = resolveFaceRefs(record.topology, [note.face]);
        if (face) {
          at = face.centre;
          lost = false;
          break;
        }
      } else if (note.edge) {
        const [edge] = resolveEdgeRefs(record.topology, [note.edge]);
        if (edge?.points?.length) {
          at = edge.points[Math.floor(edge.points.length / 2)];
          lost = false;
          break;
        }
      }
    }
    if (at) out.push({ note, at, lost });
  }
  return out;
}

/**
 * Draw the notes over the canvas, once the camera for this frame is settled.
 *
 * In HTML rather than in the scene, because text in a 3D scene either faces the
 * wrong way or has to be rebuilt every time the view moves, and neither is
 * worth it for a remark.
 */
function placeNotes() {
  const wrap = document.getElementById('viewwrap');
  if (!wrap) return;
  const anchors = noteAnchors();
  if (!state.noteEls) state.noteEls = new Map();

  const seen = new Set();
  for (const { note, at, lost } of anchors) {
    seen.add(note.id);
    let el = state.noteEls.get(note.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'note-pin';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        editNote(note.id);
      });
      wrap.appendChild(el);
      state.noteEls.set(note.id, el);
    }
    el.textContent = note.text;
    el.title = lost ? 'The geometry this was about has gone' : note.text;
    el.classList.toggle('lost', lost);
    el.classList.toggle('done', !!note.done);

    const s = state.vp.worldToScreen(at[0], at[1], at[2]);
    if (!s || s.behind) {
      el.style.display = 'none';
      continue;
    }
    const r = wrap.getBoundingClientRect();
    el.style.display = '';
    el.style.left = `${s.clientX - r.left}px`;
    el.style.top = `${s.clientY - r.top}px`;
  }

  for (const [id, el] of state.noteEls) {
    if (seen.has(id)) continue;
    el.remove();
    state.noteEls.delete(id);
  }
}

/** Read a note, change it, mark it dealt with, or throw it away. */
function editNote(id) {
  const note = (state.doc.notes || []).find((n) => n.id === id);
  if (!note) return;
  showInspector(
    'Note',
    [
      { key: 'text', label: 'Note', type: 'text', value: note.text },
      { key: 'done', label: 'Dealt with', type: 'bool', value: !!note.done },
      { key: 'remove', label: 'Throw it away', type: 'bool', value: false }
    ],
    (v) => {
      pushUndo('note');
      if (v.remove) {
        state.doc.notes = state.doc.notes.filter((n) => n.id !== id);
        setStatus('Note removed.');
      } else {
        note.text = String(v.text || '').trim() || note.text;
        note.done = !!v.done;
        setStatus(note.done ? 'Note marked as dealt with.' : 'Note saved.');
      }
      state.dirty = true;
      renderTree();
      state.vp.invalidate();
    }
  );
}

/**
 * The table that turns one document into several parts.
 *
 * A bracket that comes in three lengths is one design, not three. Drawing it
 * three times means three sets of everything to keep in step, and they will not
 * stay in step.
 *
 * Shown as a real table because that is what it is, and because the whole value
 * of one is seeing the variants side by side. A stack of dialogs would hide
 * exactly the thing worth looking at.
 */
function cmdConfigurations() {
  if (state.sketcher.active) finishSketch();
  state.doc.configurations = state.doc.configurations || CF.newTable();
  drawConfigTable();
}

function drawConfigTable() {
  const table = state.doc.configurations;
  const modal = $('#modal');
  $('#modalTitle').textContent = 'Configurations';
  const body = $('#modalBody');
  body.innerHTML = '';
  body.className = 'wide';

  const note = document.createElement('div');
  note.className = 'hint';
  const st = CF.tableState(table);
  note.textContent = st.active
    ? `${st.active.name} is in force.${
        st.blanks.length ? ` It says nothing about ${st.blanks.join(', ')}, so those are left as drawn.` : ''
      }`
    : 'Nothing is in force, so the model is as it was drawn. Click a row name to make it current.';
  body.appendChild(note);

  const grid = document.createElement('table');
  grid.className = 'cfgtable';

  const head = document.createElement('tr');
  head.appendChild(cell('th', 'Configuration'));
  for (const col of table.columns) {
    const th = cell('th', CF.columnLabel(col));
    const drop = document.createElement('button');
    drop.textContent = '✕';
    drop.title = 'Remove this column';
    drop.addEventListener('click', () => {
      pushUndo('configuration column');
      table.columns = table.columns.filter((c) => c.id !== col.id);
      state.dirty = true;
      drawConfigTable();
      rebuildAll();
    });
    th.appendChild(drop);
    head.appendChild(th);
  }
  head.appendChild(cell('th', ''));
  grid.appendChild(head);

  for (const row of table.rows) {
    const tr = document.createElement('tr');
    if (row.id === table.active) tr.className = 'on';

    const name = cell('td', '');
    const pick = document.createElement('button');
    pick.textContent = row.name;
    pick.title = 'Make this one current';
    pick.addEventListener('click', () => {
      pushUndo('configuration');
      table.active = table.active === row.id ? null : row.id;
      state.dirty = true;
      drawConfigTable();
      rebuildAll();
      setStatus(table.active ? `${row.name} is in force.` : 'Back to the model as drawn.');
    });
    name.appendChild(pick);
    tr.appendChild(name);

    for (const col of table.columns) {
      const td = cell('td', '');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = row.values?.[col.id] ?? '';
      input.placeholder = col.kind === 'suppress' || col.kind === 'visible' ? 'yes / no' : 'as drawn';
      input.addEventListener('change', () => {
        pushUndo('configuration value');
        row.values = row.values || {};
        row.values[col.id] = input.value;
        state.dirty = true;
        if (table.active === row.id) rebuildAll();
      });
      td.appendChild(input);
      tr.appendChild(td);
    }

    const tools = cell('td', '');
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      pushUndo('configuration row');
      table.rows.push(CF.copyRow(table, row));
      state.dirty = true;
      drawConfigTable();
    });
    tools.appendChild(copy);
    const drop = document.createElement('button');
    drop.textContent = '✕';
    drop.addEventListener('click', () => {
      pushUndo('configuration row');
      table.rows = table.rows.filter((r) => r.id !== row.id);
      if (table.active === row.id) table.active = null;
      state.dirty = true;
      drawConfigTable();
      rebuildAll();
    });
    tools.appendChild(drop);
    tr.appendChild(tools);
    grid.appendChild(tr);
  }
  body.appendChild(grid);

  const buttons = document.createElement('div');
  buttons.className = 'cfgbuttons';
  const addRow = document.createElement('button');
  addRow.textContent = 'Add a configuration';
  addRow.addEventListener('click', () => {
    pushUndo('configuration row');
    table.rows.push(CF.copyRow(table, table.rows[table.rows.length - 1], `Configuration ${table.rows.length + 1}`));
    state.dirty = true;
    drawConfigTable();
  });
  buttons.appendChild(addRow);

  const addCol = document.createElement('button');
  addCol.textContent = 'Add a column';
  addCol.addEventListener('click', () => addConfigColumn());
  buttons.appendChild(addCol);
  body.appendChild(buttons);

  modal.classList.remove('hidden');
  $('#modalOk').onclick = () => {
    modal.classList.add('hidden');
    body.className = '';
    $('#modalOk').onclick = null;
  };
}

function cell(tag, text) {
  const c = document.createElement(tag);
  if (text) c.textContent = text;
  return c;
}

/** Ask what a new column drives, then what in particular. */
function addConfigColumn() {
  const table = state.doc.configurations;
  const kinds = Object.entries(CF.COLUMN_KINDS).map(([k, v]) => [k, v.label]);
  promptChoice('What does this column change?', kinds, (kind) => {
    if (!kind) return;
    const targets = configTargets(kind);
    const add = (ref, label) => {
      pushUndo('configuration column');
      table.columns.push({
        id: `col${Math.random().toString(36).slice(2, 9)}`,
        kind,
        ref: ref ?? '',
        label
      });
      state.dirty = true;
      drawConfigTable();
    };
    if (!targets) return add('', CF.COLUMN_KINDS[kind].label);
    if (!targets.length) {
      setStatus(`There is nothing in this document to point a ${CF.COLUMN_KINDS[kind].label} column at.`);
      return;
    }
    promptChoice(`Which ${CF.COLUMN_KINDS[kind].needs}?`, targets, (ref) => {
      if (ref === null || ref === undefined) return;
      const found = targets.find(([v]) => v === ref);
      add(ref, `${CF.COLUMN_KINDS[kind].label}: ${found ? found[1] : ref}`);
    });
  });
}

/** What a column of each kind can point at, or null when it points at nothing. */
function configTargets(kind) {
  if (kind === 'rule') return null;
  if (kind === 'parameter') {
    return (state.doc.parameters || []).map((p) => [p.name, `${p.name} = ${p.expr}`]);
  }
  if (kind === 'suppress') {
    return (state.doc.features || [])
      .filter((f) => f.type !== 'sketch')
      .map((f) => [f.id, featureLabel(state.doc, f)]);
  }
  if (kind === 'joint') {
    return (state.doc.joints || []).map((j) => [j.id, j.name || j.id]);
  }
  return (state.result?.bodies || []).map((b) => [b.id, b.name]);
}

/**
 * What this document is, as opposed to what shape it is.
 *
 * A part number and a description are not decoration. They are what a drawing,
 * a purchase order and a shelf all agree on, and a model without them is a
 * model somebody has to name again every time it leaves.
 */
function cmdDocumentInfo() {
  const info = state.doc.info || {};
  showInspector(
    'Document Properties',
    [
      { key: 'name', label: 'Name', type: 'text', value: info.name || state.doc.name || '' },
      { key: 'partNumber', label: 'Part number', type: 'text', value: info.partNumber || '' },
      { key: 'description', label: 'Description', type: 'text', value: info.description || '' },
      { key: 'revision', label: 'Revision', type: 'text', value: info.revision || '' },
      { key: 'material', label: 'Material note', type: 'text', value: info.material || '' },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'These travel with the document and go into a 3MF when one is written, so what comes out the other end knows what it is.'
      }
    ],
    (v) => {
      pushUndo('document properties');
      state.doc.info = { ...info, ...v };
      if (v.name) state.doc.name = v.name;
      state.dirty = true;
      renderTree();
      setStatus(v.partNumber ? `${v.partNumber}: ${v.name || 'unnamed'}.` : 'Properties saved.');
    }
  );
}

/**
 * Named states of the document, kept inside it.
 *
 * Not a substitute for a version control system and not pretending to be one.
 * What it is for is the hour in which a part is being tried three ways: keep
 * the one that worked before starting the next, and go back to it without
 * having to remember what was changed.
 *
 * Each one holds the whole document, which is honest about the cost. A model
 * with a scan in it is a large thing to copy, so the size is said out loud.
 */
function cmdNamedVersions() {
  state.doc.versions = state.doc.versions || [];
  const list = state.doc.versions;
  const rows = list.map((v, i) => ({
    key: `__v${i}`,
    label: '',
    type: 'action',
    run: () => restoreVersion(v.id)
  }));

  showInspector(
    'Named Versions',
    [
      { key: 'name', label: 'Keep this one as', type: 'text', value: nextVersionName() },
      ...list.map((v, i) => ({
        key: `__row${i}`,
        label: '',
        type: 'note',
        text: `${v.name} · ${new Date(v.at).toLocaleString()} · ${sizeWords(v.size)}`
      })),
      ...(list.length
        ? [
            {
              key: 'restore',
              label: 'Go back to',
              type: 'select',
              value: '',
              options: [['', 'Nothing, just keep a new one'], ...list.map((v) => [v.id, v.name])]
            }
          ]
        : []),
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'Each one holds the whole document. It is for trying a part three ways in an hour, not for keeping a history.'
      }
    ],
    (v) => {
      if (v.restore) {
        restoreVersion(v.restore);
        return;
      }
      const data = JSON.stringify({ ...state.doc, versions: undefined });
      pushUndo('keep a version');
      state.doc.versions.push({
        id: uid('ver'),
        name: v.name || nextVersionName(),
        at: Date.now(),
        size: data.length,
        data
      });
      state.dirty = true;
      renderTree();
      setStatus(`Kept as ${v.name || 'a version'}, ${sizeWords(data.length)}.`);
    }
  );
}

function nextVersionName() {
  const used = new Set((state.doc.versions || []).map((v) => v.name));
  let n = 1;
  while (used.has(`Version ${n}`)) n++;
  return `Version ${n}`;
}

function sizeWords(bytes) {
  if (!bytes) return 'no size';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Put a kept version back, keeping the list of versions itself. */
function restoreVersion(id) {
  const held = (state.doc.versions || []).find((v) => v.id === id);
  if (!held) {
    setStatus('That version is not in this document any more.');
    return;
  }
  let doc;
  try {
    doc = migrate(JSON.parse(held.data));
  } catch (err) {
    setStatus(`That version could not be read: ${err.message}`);
    return;
  }
  pushUndo('go back to a version');
  // The list of versions is not part of what was kept, or going back to an
  // early one would throw away everything kept since.
  doc.versions = state.doc.versions;
  state.doc = doc;
  state.dirty = true;
  clearGeometrySelection(false);
  if (state.cache) {
    state.cache.dispose();
    state.cache = null;
  }
  rebuildAll();
  setStatus(`Back to ${held.name}.`);
}

/**
 * An image laid on a face of the model.
 *
 * The face is remembered as a reference rather than as a number, so the decal
 * follows the part when the model is rebuilt. Where it was when it was placed
 * is kept as well, and used when the face has gone: a decal that vanishes
 * because a fillet was added is worse than one sitting where it was left, and
 * the tree says which of the two has happened.
 */
async function cmdInsertDecal() {
  if (state.sketcher.active) finishSketch();
  const pick = firstPickedFaceRef();
  if (!pick) {
    setStatus('Select the flat face to put it on first.');
    return;
  }
  const frame = decalFrameFromSelection();
  if (!frame) {
    setStatus('That face is curved. A decal needs somewhere flat to look at.');
    return;
  }

  const res = await window.anvil.importBinary('image');
  if (!res.ok) {
    if (res.error) setStatus(`Could not read that: ${res.error}`);
    return;
  }
  let bitmap;
  try {
    bitmap = await imageOf(res.bytes);
  } catch (err) {
    setStatus(`Could not read that image: ${err.message}`);
    return;
  }

  const key = uid('img');
  state.doc.imageData[key] = { url: bitmap.url, width: bitmap.width, height: bitmap.height };
  const id = uid('decal');
  const across = 30;
  state.doc.decals = state.doc.decals || {};
  state.doc.decals[id] = {
    id,
    name: (res.path || 'Decal').split(/[\\/]/).pop(),
    image: key,
    face: pick,
    frame,
    width: across,
    height: (across * bitmap.height) / bitmap.width,
    x: 0,
    y: 0,
    turn: 0,
    opacity: 1
  };
  state.dirty = true;
  showDecalPanel(id);
}

/** The frame a decal projects along, captured off the face that was picked. */
function decalFrameFromSelection() {
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    const record = (state.records || []).find((r) => r.id === bodyId);
    const face = record?.topology?.faces[index];
    if (!face?.planar) continue;
    const basis = basisFor(face.normal);
    // Standing off the face and looking back at it, which is what makes the
    // projection direction point into the material.
    return {
      origin: [0, 1, 2].map((i) => face.centre[i] + face.normal[i] * 1),
      x: basis.x,
      y: basis.y,
      n: face.normal.map((v) => -v)
    };
  }
  return null;
}

/** The panel that sizes and places a decal. */
function showDecalPanel(id) {
  const decal = state.doc.decals?.[id];
  if (!decal) return;
  showInspector(
    'Decal',
    [
      { key: 'width', label: 'How wide', type: 'expr', value: String(decal.width) },
      { key: 'x', label: 'Across the face', type: 'expr', value: String(decal.x) },
      { key: 'y', label: 'Up it', type: 'expr', value: String(decal.y) },
      { key: 'turn', label: 'Turned, degrees', type: 'expr', value: String(decal.turn) },
      { key: 'opacity', label: 'How solid, 0 to 1', type: 'expr', value: String(decal.opacity) },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'The triangles under it are really cut to the edge of the image, so it stops where the picture stops rather than where the mesh happens to.'
      }
    ],
    (v) => {
      const scope = resolveParameters(state.doc.parameters);
      const width = Math.max(1e-3, safeEval(v.width, scope, decal.width));
      const held = state.doc.imageData[decal.image];
      pushUndo('decal');
      Object.assign(decal, {
        width,
        height: held ? (width * held.height) / held.width : decal.height,
        x: safeEval(v.x, scope, 0),
        y: safeEval(v.y, scope, 0),
        turn: safeEval(v.turn, scope, 0),
        opacity: Math.max(0, Math.min(1, safeEval(v.opacity, scope, 1)))
      });
      state.dirty = true;
      rebuildAll();
      const on = placedDecals(state.records || []).find((d) => d.decalId === decal.id);
      setStatus(
        on
          ? `${decal.name}, ${Math.round(on.coverage * 100)} in a hundred of it on the part.`
          : `${decal.name} is not landing on anything. Move it, or make it smaller.`
      );
    }
  );
}

/**
 * Every decal, cut to the surface it lies on.
 *
 * Recomputed each rebuild rather than stored, because what it lies on is what
 * changes. Storing the cut mesh would mean a decal that stayed the shape of a
 * face that is no longer there.
 */
function placedDecals(records) {
  const out = [];
  for (const d of Object.values(state.doc.decals || {})) {
    const held = state.doc.imageData?.[d.image];
    if (!held?.url) continue;

    // The face if it is still there, and where it was if it is not.
    let frame = d.frame;
    let target = null;
    for (const record of records) {
      if (!record.topology) continue;
      const [face] = resolveFaceRefs(record.topology, [d.face]);
      if (!face?.planar) continue;
      const basis = basisFor(face.normal);
      frame = {
        origin: [0, 1, 2].map((i) => face.centre[i] + face.normal[i] * 1),
        x: basis.x,
        y: basis.y,
        n: face.normal.map((v) => -v)
      };
      target = record;
      break;
    }
    if (!frame) continue;

    const t = ((d.turn || 0) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const x = [0, 1, 2].map((i) => frame.x[i] * cos + frame.y[i] * sin);
    const y = [0, 1, 2].map((i) => -frame.x[i] * sin + frame.y[i] * cos);
    const origin = [0, 1, 2].map((i) => frame.origin[i] + x[i] * (d.x || 0) + y[i] * (d.y || 0));
    const placed = { origin, x, y, n: frame.n };

    // Against the body it was put on if that is known, and against everything
    // otherwise, which is what makes a decal work across a joint between two
    // bodies that meet.
    const look = target ? [target] : records;
    for (const record of look) {
      if (!record.mesh) continue;
      const cut = decalMesh(record.mesh, placed, {
        width: d.width,
        height: d.height,
        offset: Math.max(0.01, (d.width || 30) * 0.0005)
      });
      if (!cut) continue;
      out.push({
        id: `${d.id}:${record.id}`,
        decalId: d.id,
        url: held.url,
        mesh: cut,
        coverage: cut.coverage,
        opacity: d.opacity ?? 1,
        visible: !state.hiddenBodies.has(record.id)
      });
    }
  }
  return out;
}

/**
 * Every canvas, worked out into a rectangle in the world.
 *
 * The plane, the offsets and the turn are settings; what the viewport wants is
 * a place and two directions. Doing that here keeps the drawing code from
 * having to know what a construction plane is.
 */
function placedCanvases() {
  const out = [];
  const scope = resolveParameters(state.doc.parameters).scope;
  for (const c of Object.values(state.doc.canvases || {})) {
    const held = state.doc.imageData?.[c.image];
    if (!held?.url) continue;
    const plane = resolvePlane(c.plane || 'XY', scope, state.result?.construction);
    if (!plane) continue;

    const t = ((c.turn || 0) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const x = [
      plane.x[0] * cos + plane.y[0] * sin,
      plane.x[1] * cos + plane.y[1] * sin,
      plane.x[2] * cos + plane.y[2] * sin
    ];
    const y = [
      -plane.x[0] * sin + plane.y[0] * cos,
      -plane.x[1] * sin + plane.y[1] * cos,
      -plane.x[2] * sin + plane.y[2] * cos
    ];
    const origin = [0, 1, 2].map(
      (i) => plane.origin[i] + plane.x[i] * (c.x || 0) + plane.y[i] * (c.y || 0)
    );
    out.push({
      id: c.id,
      url: held.url,
      width: c.width || 100,
      height: c.height || 100,
      opacity: c.opacity ?? 0.6,
      behind: c.behind !== false,
      visible: !state.hiddenCanvases?.has(c.id),
      origin,
      x,
      y,
      n: plane.n
    });
  }
  return out;
}

/**
 * Bodies out of another Anvil document, as a component of this one.
 *
 * What comes across is the shape, not the timeline, and that is on purpose.
 * Replaying somebody else's features inside this document would mean two sets
 * of parameters with the same names, two sets of sketches, and a rebuild that
 * fails here because of an edit made over there. What is wanted from an
 * inserted part is its shape.
 *
 * Derived is the same thing with the path remembered, so it can be read again.
 * Linked and live are different words: this is linked, and it updates when it
 * is told to, which is what Refresh is for.
 */
async function cmdInsertFromFile(derive) {
  if (state.sketcher.active) finishSketch();
  const res = await window.anvil.readAnother?.();
  if (!res?.ok) {
    if (res?.error) setStatus(res.error);
    return;
  }

  const taken = await bodiesFromDocument(res.text);
  if (!taken) return;
  if (!taken.meshes.length) {
    setStatus(`${taken.name} has no solid bodies in it.`);
    return;
  }

  pushUndo(derive ? 'insert derive' : 'insert component');
  const keys = taken.meshes.map((m) => {
    const key = uid('mesh');
    state.doc.meshData[key] = m;
    return key;
  });

  const comp = newComponent(taken.name);
  state.doc.components = state.doc.components || [];
  state.doc.components.push(comp);

  state.doc.features.push({
    id: uid('f'),
    type: 'insertComponent',
    component: comp.id,
    data: keys,
    label: taken.name,
    scale: '1',
    at: [0, 0, 0],
    // Only a derived part remembers where it came from. An inserted one is a
    // copy and saying it was linked would be a lie.
    source: derive ? { path: res.path, modified: res.modified, bodies: keys.length } : null
  });
  state.dirty = true;
  rebuildAll();
  setStatus(
    `${taken.name}: ${keys.length} bod${keys.length === 1 ? 'y' : 'ies'}${
      derive ? ', kept linked to the file it came from' : ''
    }.`
  );
}

/**
 * Rebuild every derived part from the file it came from.
 *
 * Told to rather than watched for. A file watcher would mean this document
 * changing under somebody's hands while they were working in it, and a part
 * that changes shape without being asked is worse than one that is a day old.
 */
async function cmdRefreshDerived() {
  const derived = (state.doc.features || []).filter((f) => f.type === 'insertComponent' && f.source?.path);
  if (!derived.length) {
    setStatus('Nothing in this document is derived from another file.');
    return;
  }

  let changed = 0;
  let missing = 0;
  for (const f of derived) {
    const res = await window.anvil.readAnother?.(f.source.path);
    if (!res?.ok) {
      missing++;
      continue;
    }
    const taken = await bodiesFromDocument(res.text);
    if (!taken?.meshes.length) {
      missing++;
      continue;
    }
    const before = f.data.map((k) => state.doc.meshData[k]?.tris?.length || 0).join(',');
    for (const k of f.data) delete state.doc.meshData[k];
    f.data = taken.meshes.map((m) => {
      const key = uid('mesh');
      state.doc.meshData[key] = m;
      return key;
    });
    f.source = { path: res.path, modified: res.modified, bodies: f.data.length };
    const after = f.data.map((k) => state.doc.meshData[k]?.tris?.length || 0).join(',');
    if (before !== after) changed++;
  }

  if (changed) {
    pushUndo('refresh derived');
    state.dirty = true;
    rebuildAll();
  }
  setStatus(
    `${derived.length} derived part${derived.length === 1 ? '' : 's'} checked. ` +
      `${changed || 'none'} changed${missing ? `, ${missing} could not be read` : ''}.`
  );
}

/**
 * Another document's solids, as triangles.
 *
 * Rebuilt in a scope of its own and thrown away straight afterwards, so nothing
 * of the other document's kernel handles outlives this call.
 */
async function bodiesFromDocument(text) {
  let other;
  try {
    other = migrate(JSON.parse(text));
  } catch (err) {
    setStatus(`That document could not be read: ${err.message}`);
    return null;
  }

  let res;
  try {
    res = rebuild(other, {});
  } catch (err) {
    setStatus(`That document does not rebuild: ${err.message}`);
    return null;
  }

  const meshes = [];
  try {
    for (const b of res.bodies) {
      const mesh = b.solid ? K.meshData(b.solid) : b.sheet;
      if (!mesh?.triVerts?.length) continue;
      meshes.push({
        verts: Array.from(mesh.vertProperties),
        tris: Array.from(mesh.triVerts)
      });
    }
  } finally {
    res.dispose();
  }
  return { name: other.name || 'Inserted part', meshes };
}

/**
 * An image on a plane, to trace over.
 *
 * The one thing this does that nothing else here does is let a drawing that
 * exists only as a photograph become a part. Calibrating is the whole of making
 * that work: an image has pixels and a part has millimetres, and the way across
 * is to say how long something in the picture really is.
 */
async function cmdInsertCanvas() {
  if (state.sketcher.active) finishSketch();
  const res = await window.anvil.importBinary('image');
  if (!res.ok) {
    if (res.error) setStatus(`Could not read that: ${res.error}`);
    return;
  }

  let bitmap;
  try {
    bitmap = await imageOf(res.bytes);
  } catch (err) {
    setStatus(`Could not read that image: ${err.message}`);
    return;
  }

  const key = uid('img');
  state.doc.canvases = state.doc.canvases || {};
  const id = uid('canvas');
  const across = 100;
  state.doc.canvases[id] = {
    id,
    name: (res.path || 'Canvas').split(/[\\/]/).pop(),
    image: key,
    plane: 'XY',
    width: across,
    height: (across * bitmap.height) / bitmap.width,
    x: 0,
    y: 0,
    turn: 0,
    opacity: 0.6,
    behind: true
  };
  state.doc.imageData[key] = { url: bitmap.url, width: bitmap.width, height: bitmap.height };
  state.dirty = true;
  showCanvasPanel(id);
}

/** An image as a data URL and its size, which is all a canvas needs of it. */
async function imageOf(bytes) {
  const blob = new Blob([bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)]);
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('unreadable'));
    reader.readAsDataURL(blob);
  });
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('not an image this can read'));
    img.src = url;
  });
  return { url, width: img.naturalWidth, height: img.naturalHeight };
}

/** The panel that places a canvas and calibrates it. */
function showCanvasPanel(id) {
  const canvas = state.doc.canvases?.[id];
  if (!canvas) return;
  showInspector(
    'Canvas',
    [
      {
        key: 'plane',
        label: 'On which plane',
        type: 'select',
        value: canvas.plane,
        options: planeOptions()
      },
      { key: 'width', label: 'How wide it really is', type: 'expr', value: String(canvas.width) },
      { key: 'x', label: 'Across', type: 'expr', value: String(canvas.x) },
      { key: 'y', label: 'Up', type: 'expr', value: String(canvas.y) },
      { key: 'turn', label: 'Turned, degrees', type: 'expr', value: String(canvas.turn) },
      { key: 'opacity', label: 'How solid, 0 to 1', type: 'expr', value: String(canvas.opacity) },
      { key: 'behind', label: 'Behind the model', type: 'bool', value: canvas.behind !== false },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'An image has pixels and a part has millimetres. Set the width to something in the picture whose real size is known, and everything traced off it comes out the right size.'
      }
    ],
    (v) => {
      const scope = resolveParameters(state.doc.parameters);
      const width = Math.max(1e-3, safeEval(v.width, scope, canvas.width));
      const held = state.doc.imageData[canvas.image];
      pushUndo('canvas');
      Object.assign(canvas, {
        plane: v.plane,
        width,
        height: held ? (width * held.height) / held.width : canvas.height,
        x: safeEval(v.x, scope, 0),
        y: safeEval(v.y, scope, 0),
        turn: safeEval(v.turn, scope, 0),
        opacity: Math.max(0, Math.min(1, safeEval(v.opacity, scope, 0.6))),
        behind: !!v.behind
      });
      state.dirty = true;
      rebuildAll();
      setStatus(`${canvas.name}, ${round(width, 1)} across.`);
    }
  );
}

/**
 * A named place on the model that joints and constraints can be pointed at.
 *
 * Fusion has this because picking geometry every time is fine until the
 * geometry moves. A joint origin is captured once, from a face, an edge or a
 * bore, and everything that refers to it goes on working when the face it came
 * off is replaced by a fillet.
 *
 * It is put in the document's construction list rather than in a list of its
 * own, because that is already the list of "things that exist to be referred
 * to" and it is already rebuilt in order.
 */
function cmdJointOrigin() {
  if (state.sketcher.active) finishSketch();
  const frame = capturedFrameFromSelection();
  if (!frame) {
    setStatus('Select a flat face, a bore, or a round edge to capture.');
    return;
  }

  showInspector(
    'Joint Origin',
    [
      { key: 'name', label: 'Name', type: 'text', value: nextJointOriginName() },
      { key: 'offset', label: 'Along its own axis', type: 'expr', value: '0' },
      {
        key: '__where',
        label: '',
        type: 'note',
        text: `At ${frame.p.map((n) => round(n, 2)).join(', ')}, facing ${frame.axis
          .map((n) => round(n, 2))
          .join(', ')}.`
      },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'Captured now and kept. Whatever refers to it goes on working when the face it came off is replaced by a fillet.'
      }
    ],
    (v) => {
      const scope = resolveParameters(state.doc.parameters);
      const along = safeEval(v.offset, scope, 0);
      pushUndo('joint origin');
      const id = uid('jo');
      state.doc.construction = state.doc.construction || [];
      state.doc.features.push({
        id: uid('f'),
        type: 'construction',
        entry: {
          id,
          name: v.name || 'Joint origin',
          type: 'jointOrigin',
          p: [
            frame.p[0] + frame.axis[0] * along,
            frame.p[1] + frame.axis[1] * along,
            frame.p[2] + frame.axis[2] * along
          ],
          axis: frame.axis.slice(),
          axis2: frame.axis2 ? frame.axis2.slice() : null
        }
      });
      state.dirty = true;
      rebuildAll();
      setStatus(`${v.name || 'Joint origin'} captured.`);
    }
  );
}

function nextJointOriginName() {
  const used = new Set(
    (state.doc.features || [])
      .filter((f) => f.type === 'construction' && f.entry?.type === 'jointOrigin')
      .map((f) => f.entry.name)
  );
  let n = 1;
  while (used.has(`Origin ${n}`)) n++;
  return `Origin ${n}`;
}

/**
 * A point and a direction off whatever is picked.
 *
 * A bore gives its axis, a flat face gives its normal, a round edge gives its
 * centre and the way it faces, and a straight edge gives its direction. Those
 * are the four things people point at, and each one has an obvious answer.
 */
function capturedFrameFromSelection() {
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    const record = (state.records || []).find((r) => r.id === bodyId);
    const face = record?.topology?.faces[index];
    if (!face) continue;
    if (face.cylinder) return captureJointOrigin(face.cylinder.origin, face.cylinder.dir);
    if (face.planar) return captureJointOrigin(face.centre, face.normal);
  }
  for (const key of state.selection.edges) {
    const { bodyId, index } = splitKey(key);
    const record = (state.records || []).find((r) => r.id === bodyId);
    const edge = record?.topology?.edges[index];
    if (!edge) continue;
    if (edge.kind === 'circle') return captureJointOrigin(edge.centre, edge.axis);
    if (edge.kind === 'line') return captureJointOrigin(edge.start, edge.dir);
  }
  return null;
}

/**
 * Put a face of one component against a face of another.
 *
 * The other way of assembling, and worth having alongside joints rather than
 * instead of them. A joint says how two parts may move for ever after; a
 * constraint says where a part goes now. Most of the time that is all anybody
 * wants, and being made to define a joint origin first is why people give up
 * and type coordinates.
 */
function cmdConstrainComponents() {
  if (state.sketcher.active) finishSketch();
  const picked = [];
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    const record = (state.records || []).find((r) => r.id === bodyId);
    const face = record?.topology?.faces[index];
    const body = (state.result?.bodies || []).find((b) => b.id === bodyId);
    if (!face || !body?.component) continue;
    picked.push({ body, face, record });
  }
  if (picked.length < 2) {
    setStatus('Select one face on each of the two components, the child first.');
    return;
  }
  const [child, parent] = picked;
  if (child.body.component === parent.body.component) {
    setStatus('Those two faces are on the same component, so there is nothing to move.');
    return;
  }

  showInspector(
    'Constrain Components',
    [
      {
        key: 'kind',
        label: 'How they meet',
        type: 'select',
        value: 'mate',
        options: [
          ['mate', 'Mate, the faces touch'],
          ['flush', 'Flush, the faces line up'],
          ['concentric', 'Concentric, on one axis']
        ]
      },
      { key: 'offset', label: 'Held apart by', type: 'expr', value: '0' },
      { key: 'flip', label: 'The other way round', type: 'bool', value: false },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: `${componentName(child.body.component)} moves onto ${componentName(parent.body.component)}. Whatever is jointed to it comes too.`
      }
    ],
    (v) => {
      const scope = resolveParameters(state.doc.parameters);
      pushUndo('constrain components');
      state.doc.constraints = state.doc.constraints || [];
      state.doc.constraints.push({
        id: uid('cn'),
        kind: v.kind,
        child: child.body.component,
        parent: parent.body.component,
        childFrame: localFrameOf(child),
        parentFrame: localFrameOf(parent),
        offset: safeEval(v.offset, scope, 0),
        flip: !!v.flip
      });
      state.dirty = true;
      rebuildAll();
      const bad = (state.result?.errors || []).filter((e) => /brought together/.test(e.message));
      setStatus(
        bad.length
          ? bad[0].message
          : `${componentName(child.body.component)} is ${v.kind === 'concentric' ? 'on the same axis as' : v.kind === 'flush' ? 'flush with' : 'mated to'} ${componentName(parent.body.component)}.`
      );
    }
  );
}

/**
 * A face as a point and a direction in its component's own space.
 *
 * In the component's space rather than the world's, so the constraint survives
 * everything else moving the part first. The body already carries the transform
 * that was applied to it, so undoing that is what turns the world back into the
 * component.
 */
function localFrameOf(pick) {
  const world = pick.face.cylinder
    ? { p: pick.face.cylinder.origin, axis: pick.face.cylinder.dir }
    : { p: pick.face.centre, axis: pick.face.normal };
  const comp = (state.doc.components || []).find((c) => c.id === pick.body.component);
  const m = comp ? matrixOfComponent(comp) : null;
  if (!m) return { p: world.p.slice(), axis: world.axis.slice() };
  const inv = m.clone().invert();
  const p = new THREE.Vector3(...world.p).applyMatrix4(inv);
  const a = new THREE.Vector3(...world.axis).transformDirection(inv).normalize();
  return { p: [p.x, p.y, p.z], axis: [a.x, a.y, a.z] };
}

/** A component's own placement, as a matrix. */
function matrixOfComponent(comp) {
  const t = comp.transform;
  if (!t) return new THREE.Matrix4();
  if (Array.isArray(t) && t.length === 16) return new THREE.Matrix4().fromArray(t);
  const m = new THREE.Matrix4();
  if (t.position) m.setPosition(t.position[0], t.position[1], t.position[2]);
  return m;
}

function componentName(id) {
  return (state.doc.components || []).find((c) => c.id === id)?.name || 'that component';
}

/* -------- sheet metal, the two that were missing -------- */

function cmdHem() {
  if (state.sketcher.active) finishSketch();
  if (!sheetBodies().length) {
    setStatus('A hem folds the edge of a sheet metal body. There are none yet.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'hem',
    bodies: pickedSheetIds(),
    edges: [...selectedEdgeRefs().values()].flat(),
    kind: 'single',
    length: '6',
    radius: '',
    angle: '270',
    angle1: '135',
    angle2: '90',
    relief: true
  };
  openFeatureEditor(feature, 'Hem', hemFields());
  if (!feature.edges.length) {
    setEditPick('sheetEdges');
    setStatus('Click the edges to fold back.');
  }
}

function hemFields() {
  return [
    sheetBodyField(),
    {
      key: '__edges',
      label: 'Edges',
      type: 'pick',
      pick: 'sheetEdges',
      summary: (f) => countOf(f.edges, 'edge'),
      clear: (f) => {
        f.edges = [];
      }
    },
    {
      key: 'kind',
      label: 'Kind',
      type: 'select',
      options: [
        ['single', 'Single, folded flat back'],
        ['teardrop', 'Teardrop, curled round'],
        ['rolled', 'Rolled, a curl'],
        ['double', 'Double, folded twice']
      ]
    },
    { key: 'length', label: 'How much is folded back', type: 'expr' },
    { key: 'radius', label: 'Inner radius, blank for one thickness', type: 'text' },
    { key: 'angle', label: 'How far round', type: 'expr', showIf: (f) => f.kind === 'rolled' },
    { key: 'angle1', label: 'First fold', type: 'expr', showIf: (f) => f.kind === 'teardrop' },
    { key: 'angle2', label: 'Second fold', type: 'expr', showIf: (f) => f.kind === 'teardrop' },
    { key: 'relief', label: 'Cut relief where it leaves the panel', type: 'bool' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'A raw sheet edge is sharp and weak. Folding it back doubles the thickness there and buries the cut. Folded to nothing the metal cracks, so the radius never goes below a thousandth.'
    }
  ];
}

function cmdLoftedFlange() {
  if (state.sketcher.active) finishSketch();
  const sketches = sketchesWithCurves();
  if (sketches.length < 2) {
    setStatus('A lofted flange runs between two sketched sections. Draw both first.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'loftedFlange',
    sketch: sketches[0].id,
    sketchTo: sketches[1].id,
    around: '24',
    thickness: ''
  };
  openFeatureEditor(feature, 'Lofted Flange', loftedFlangeFields());
}

function loftedFlangeFields() {
  const list = () => sketchesWithCurves().map((sk) => [sk.id, sk.name]);
  return [
    { key: 'sketch', label: 'From', type: 'select', options: list },
    { key: 'sketchTo', label: 'To', type: 'select', options: list },
    { key: 'around', label: 'Points round each section', type: 'expr' },
    { key: 'thickness', label: 'Thickness, blank for the rule', type: 'text' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'A transition has no bend lines anywhere on it, so it has no flat pattern here. The part is real; it is not something this can unfold.'
    }
  ];
}

/**
 * The four plastic part features, which all stand on a face.
 *
 * One command over four sets of numbers, because they share everything that is
 * awkward: finding the face, standing something square on it, and putting it
 * where on that face it goes. What differs between them is only the shape, and
 * the shape is worked out in plastic.js where it can be checked against numbers.
 */
function cmdPlastic(kind) {
  if (state.sketcher.active) finishSketch();
  if (!(state.result?.bodies || []).some((b) => b.solid)) {
    setStatus('These stand on a face of a solid. There is nothing solid yet.');
    return;
  }
  const titles = { boss: 'Boss', rest: 'Rest', snapFit: 'Snap Fit', lip: 'Lip' };
  const defaults = {
    boss: {
      diameter: '8',
      bore: '3',
      height: '10',
      boreDepth: '8',
      through: false,
      fillet: '1.5',
      ribs: '0',
      ribThickness: '1.5',
      ribHeight: '7',
      ribReach: '4',
      x: '0',
      y: '0'
    },
    rest: {
      shape: 'round',
      diameter: '10',
      width: '10',
      depth: '10',
      corner: '1',
      height: '2',
      draft: '5',
      op: 'join',
      x: '0',
      y: '0'
    },
    snapFit: {
      length: '12',
      thickness: '2',
      width: '6',
      hook: '1.5',
      leadIn: '30',
      retention: '90',
      clearance: '0.2',
      facing: '0',
      op: 'join',
      x: '0',
      y: '0'
    },
    lip: { width: '1.2', inset: '0.8', height: '2', clearance: '0.15', op: 'join' }
  };

  const feature = {
    id: uid('f'),
    type: kind,
    face: firstPickedFaceRef(),
    ...defaults[kind]
  };
  openFeatureEditor(feature, titles[kind], plasticFields(kind));
  if (!feature.face) {
    setEditPick('plasticFace');
    setStatus('Click the face it stands on.');
  }
}

/** The face currently picked, as a reference that survives a rebuild. */
function firstPickedFaceRef() {
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    const record = (state.records || []).find((r) => r.id === bodyId);
    const face = record?.topology?.faces[index];
    if (face) return faceReference(face, record.topology);
  }
  return null;
}

const PLASTIC_FACE_FIELD = {
  key: '__face',
  label: 'Stands on',
  type: 'pick',
  pick: 'plasticFace',
  summary: (f) => (f.face ? 'chosen' : 'click a flat face'),
  clear: (f) => {
    f.face = null;
  }
};

const PLASTIC_WHERE_FIELDS = [
  { key: 'x', label: 'Across the face', type: 'expr' },
  { key: 'y', label: 'And up it', type: 'expr' }
];

function plasticFields(kind) {
  if (kind === 'boss') {
    return [
      PLASTIC_FACE_FIELD,
      { key: 'diameter', label: 'Outside diameter', type: 'expr' },
      { key: 'bore', label: 'Bore', type: 'expr' },
      { key: 'height', label: 'Height', type: 'expr' },
      { key: 'through', label: 'Bore goes right through', type: 'bool' },
      { key: 'boreDepth', label: 'Bore depth from the top', type: 'expr', showIf: (f) => !f.through },
      { key: 'fillet', label: 'Fillet at the foot', type: 'expr' },
      { key: 'ribs', label: 'How many ribs', type: 'expr' },
      { key: 'ribThickness', label: 'Rib thickness', type: 'expr', showIf: (f) => Number(f.ribs) > 0 },
      { key: 'ribHeight', label: 'Rib height', type: 'expr', showIf: (f) => Number(f.ribs) > 0 },
      { key: 'ribReach', label: 'How far a rib reaches out', type: 'expr', showIf: (f) => Number(f.ribs) > 0 },
      ...PLASTIC_WHERE_FIELDS,
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'The fillet at the foot is where the load is. A boss without one snaps off there, and on a printed part that is also where the layers run across the stress.'
      }
    ];
  }
  if (kind === 'rest') {
    return [
      PLASTIC_FACE_FIELD,
      {
        key: 'shape',
        label: 'Shape',
        type: 'select',
        options: [
          ['round', 'Round'],
          ['rectangular', 'Rectangular']
        ]
      },
      { key: 'diameter', label: 'Diameter', type: 'expr', showIf: (f) => f.shape !== 'rectangular' },
      { key: 'width', label: 'Width', type: 'expr', showIf: (f) => f.shape === 'rectangular' },
      { key: 'depth', label: 'Depth', type: 'expr', showIf: (f) => f.shape === 'rectangular' },
      { key: 'corner', label: 'Corner radius', type: 'expr', showIf: (f) => f.shape === 'rectangular' },
      { key: 'height', label: 'Height', type: 'expr' },
      { key: 'draft', label: 'Draft angle', type: 'expr' },
      {
        key: 'op',
        label: 'Raised or sunken',
        type: 'select',
        options: [
          ['join', 'Raised'],
          ['cut', 'Sunken']
        ]
      },
      ...PLASTIC_WHERE_FIELDS,
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'Three small pads touch properly. One big face never does, because nothing is flat enough, so it rocks on whichever two high spots it has.'
      }
    ];
  }
  if (kind === 'snapFit') {
    return [
      PLASTIC_FACE_FIELD,
      { key: 'length', label: 'Beam length', type: 'expr' },
      { key: 'thickness', label: 'Beam thickness', type: 'expr' },
      { key: 'width', label: 'Beam width', type: 'expr' },
      { key: 'hook', label: 'Hook height', type: 'expr' },
      { key: 'leadIn', label: 'Lead-in angle', type: 'expr' },
      { key: 'retention', label: 'Retention angle', type: 'expr' },
      { key: 'facing', label: 'Which way it faces, degrees', type: 'expr' },
      {
        key: 'op',
        label: 'Hook or catch',
        type: 'select',
        options: [
          ['join', 'The hook'],
          ['cut', 'The catch it clicks into']
        ]
      },
      { key: 'clearance', label: 'Clearance for the catch', type: 'expr', showIf: (f) => f.op === 'cut' },
      ...PLASTIC_WHERE_FIELDS,
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'The lead-in is the shallow face the hook rides over going in, and a shallow one is the difference between clicking together with a thumb and needing a mallet. Ninety degrees of retention is square, which holds hardest.'
      }
    ];
  }
  return [
    PLASTIC_FACE_FIELD,
    { key: 'width', label: 'Lip width', type: 'expr' },
    { key: 'inset', label: 'In from the edge', type: 'expr' },
    { key: 'height', label: 'Height', type: 'expr' },
    { key: 'clearance', label: 'Clearance', type: 'expr' },
    {
      key: 'op',
      label: 'Lip or groove',
      type: 'select',
      options: [
        ['join', 'The lip'],
        ['cut', 'The groove it drops into']
      ]
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Run it twice with the same numbers, once on each half. The groove takes the clearance on both walls, so the two cannot drift apart.'
    }
  ];
}

/**
 * Everything about the model that is likely to give trouble later.
 *
 * The thresholds are asked for rather than assumed, because there is no such
 * thing as a thin wall in the abstract: it depends on the nozzle, and a 0.4 and
 * a 0.8 disagree about most of a part. What comes back is a list of findings,
 * not a verdict, and clicking one selects the geometry it is about so it can be
 * looked at rather than hunted for.
 */
function startDesignAdvice() {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('Nothing to advise on yet.');
    return;
  }
  const kept = state.advice || {
    minWall: '1.2',
    minFeature: '0.8',
    overhang: '45',
    bed: '256, 256, 256'
  };

  showInspector(
    'Design Advice',
    [
      { key: 'minWall', label: 'Thinnest wall to allow', type: 'expr', value: kept.minWall },
      { key: 'minFeature', label: 'Nozzle, or smallest feature', type: 'expr', value: kept.minFeature },
      { key: 'overhang', label: 'Steepest overhang, degrees', type: 'expr', value: kept.overhang },
      { key: 'bed', label: 'Bed, X Y Z, blank for none', type: 'text', value: kept.bed },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'Nothing here changes the model. A finding is something to look at, not an error.'
      }
    ],
    (v) => {
      state.advice = { ...v };
      const scope = resolveParameters(state.doc.parameters);
      const bed = String(v.bed || '')
        .split(/[\s,x]+/)
        .map((n) => parseFloat(n))
        .filter((n) => Number.isFinite(n) && n > 0);

      const entries = [];
      for (const record of state.records || []) {
        if (!record.topology || !record.mesh) continue;
        if (state.hiddenBodies.has(record.id)) continue;
        // A surface has no inside, so a ray sent into it to measure a wall
        // never comes out and every reading would be infinite.
        if (record.sheet) continue;
        entries.push({
          id: record.id,
          name: record.name,
          mesh: record.mesh,
          topo: record.topology
        });
      }
      if (!entries.length) {
        setStatus('Every body is hidden.');
        return;
      }

      const found = designAdvice(entries, {
        minWall: safeEval(v.minWall, scope, 1.2),
        minFeature: safeEval(v.minFeature, scope, 0.8),
        overhang: safeEval(v.overhang, scope, 45),
        bed: bed.length === 3 ? bed : null
      });

      if (!found.length) {
        showInspector(
          'Design Advice',
          [
            {
              key: '__ok',
              label: '',
              type: 'note',
              text: `${entries.length} bod${entries.length === 1 ? 'y' : 'ies'} checked. Nothing to flag.`
            }
          ],
          () => {}
        );
        setStatus('Nothing to flag.');
        return;
      }

      state.adviceFound = found;
      showInspector(
        'Design Advice',
        found.slice(0, 14).map((f, i) => ({
          key: `__f${i}`,
          label: '',
          type: 'note',
          text: f.message
        })),
        () => {}
      );
      // The first finding is selected, so the part turns up under the pointer
      // rather than being described and left to be found.
      const first = found.find((f) => f.faceId !== undefined);
      if (first) {
        clearGeometrySelection();
        state.selection.faces.add(`${first.bodyId}:${first.faceId}`);
        refreshHighlight();
        renderTree();
      }
      setStatus(`${found.length} thing${found.length === 1 ? '' : 's'} to look at.`);
    }
  );
}

/**
 * Write the model out for a printer, and hand it to the slicer.
 *
 * 3MF rather than STL by default, and the reason is not size. An STL says
 * nothing about what unit its numbers are in, so every slicer guesses, and a
 * part arriving at a twenty-fifth of its size is the commonest thing that goes
 * wrong between here and a printer. A 3MF says millimetres, keeps the bodies
 * apart, and keeps their names.
 */
async function cmdPrint3D() {
  if (state.sketcher.active) finishSketch();
  const solids = (state.result?.bodies || []).filter(
    (b) => b.solid && !state.hiddenBodies.has(b.id)
  );
  if (!solids.length) {
    setStatus('Nothing solid to print. A surface has no thickness.');
    return;
  }
  const chosen = state.selection.bodies.size
    ? solids.filter((b) => state.selection.bodies.has(b.id))
    : solids;

  const kept = state.print3d || { format: '3mf', bed: '256, 256, 256', open: true };
  const meshes = chosen.map((b) => K.meshData(b.solid));
  const sizes = meshes.map(meshSize);
  const worst = [0, 1, 2].map((d) => Math.max(...sizes.map((s) => s[d])));

  showInspector(
    'Make 3D Print',
    [
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        value: kept.format,
        options: [
          ['3mf', '3MF, with units and names'],
          ['stl', 'STL, one lump of triangles']
        ]
      },
      { key: 'bed', label: 'Bed, X Y Z', type: 'text', value: kept.bed },
      { key: 'open', label: 'Open it in the slicer', type: 'bool', value: kept.open },
      {
        key: '__what',
        label: '',
        type: 'note',
        text: `${chosen.length} bod${chosen.length === 1 ? 'y' : 'ies'}, biggest ${worst
          .map((n) => n.toFixed(1))
          .join(' by ')}.`
      }
    ],
    async (v) => {
      state.print3d = { ...v };
      const bed = String(v.bed || '')
        .split(/[\s,x]+/)
        .map((n) => parseFloat(n))
        .filter((n) => Number.isFinite(n) && n > 0);

      if (bed.length === 3) {
        const tooBig = sizes.filter(
          (s) =>
            !((s[0] <= bed[0] && s[1] <= bed[1]) || (s[1] <= bed[0] && s[0] <= bed[1])) ||
            s[2] > bed[2]
        );
        if (tooBig.length) {
          setStatus(
            `${tooBig.length} of ${sizes.length} will not fit a ${bed.join(' by ')} bed. Writing it anyway.`
          );
        }
      }

      const base = (state.docPath ? state.docPath.split(/[\\/]/).pop() : 'Untitled').replace(
        /\.anvil$/i,
        ''
      );
      const names = chosen.map((b) => b.name);
      const data = v.format === 'stl' ? toBinarySTL(meshes) : to3MF(meshes, names);

      const res = await window.anvil.exportMesh(`${base}.${v.format}`, v.format, data);
      if (!res.ok) {
        if (res.error) setStatus(`Could not write it: ${res.error}`);
        return;
      }
      const file = res.path.split(/[\\/]/).pop();
      if (v.open) {
        const launched = await window.anvil.launchFile?.(res.path);
        if (launched?.ok) {
          setStatus(`${file} handed to the slicer.`);
          return;
        }
        window.anvil.showItem(res.path);
        setStatus(`${file} written. Nothing on this machine opens a ${v.format}.`);
        return;
      }
      window.anvil.showItem(res.path);
      setStatus(`${file} written.`);
    }
  );
}

/**
 * Colour every face by how it lies against a pull direction.
 *
 * For a moulded part that is draft. For a printed one it is the same reading
 * turned round: a face further than the angle from the build direction is one
 * the printer has to bridge or hold up.
 */
function startDraftAnalysis() {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('Nothing to analyse yet.');
    return;
  }
  const current = state.draft || { plane: 'XY', angle: '3', flip: false };
  showInspector(
    'Draft Analysis',
    [
      {
        key: 'plane',
        label: 'Pull square to',
        type: 'select',
        value: optionForPlane(current.plane),
        options: planeOptions()
      },
      { key: 'angle', label: 'Angle (deg)', type: 'expr', value: current.angle },
      { key: 'flip', label: 'Pull the other way', type: 'check', value: current.flip },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'Green draws out, red is undercut, grey is too near vertical to draw at all.'
      }
    ],
    (v) => {
      state.draft = {
        plane: planeSpecFromOption(v.plane),
        angle: v.angle,
        flip: !!v.flip
      };
      rebuildAll();
      setStatus('Draft shown. Clear Analysis puts the ordinary colour back.');
    }
  );
}

/**
 * The analyses that colour a whole body rather than measure it.
 *
 * All five put a colour on every vertex and nothing else, so one command serves
 * them with the kind switched on the way in. Which ones are worth looking at
 * depends entirely on the part: curvature and zebra are for a shape whose
 * surface has to flow, minimum radius and accessibility are for one that has to
 * be cut or printed.
 */
function startFaceAnalysis(kind) {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('Nothing to analyse yet.');
    return;
  }
  const current = state.faceAnalysis?.kind === kind ? state.faceAnalysis : null;

  const titles = {
    curvature: 'Curvature Map',
    minRadius: 'Minimum Radius',
    zebra: 'Zebra',
    access: 'Accessibility',
    chrome: 'Environment Map'
  };
  const notes = {
    curvature:
      'Cool is flat, warm is tightly curved, scaled against the size of the part.',
    minRadius:
      'Red is an inside corner tighter than the tool, which will not come out as drawn.',
    zebra:
      'A stripe that kinks is a crease. A stripe that only bends is the curvature changing.',
    access:
      'Green can be reached from that direction. Red is in the shadow of the part itself.',
    chrome:
      'A polished finish, for reading reflections. It changes nothing about the model.'
  };

  const fields = [{ key: '__note', label: '', type: 'note', text: notes[kind] }];
  if (kind === 'zebra' || kind === 'access') {
    fields.unshift({
      key: 'plane',
      label: kind === 'access' ? 'Reach from' : 'Light from',
      type: 'select',
      value: optionForPlane(current?.plane || 'XY'),
      options: planeOptions()
    });
  }
  if (kind === 'zebra') {
    fields.push({ key: 'bands', label: 'Stripes', type: 'expr', value: current?.bands || '12' });
  }
  if (kind === 'minRadius') {
    fields.push({
      key: 'tool',
      label: `Tool or nozzle radius (${unitLabel()})`,
      type: 'expr',
      value: current?.tool || '1'
    });
  }
  if (kind === 'access') {
    fields.push({ key: 'flip', label: 'From the other side', type: 'check', value: !!current?.flip });
  }

  showInspector(titles[kind], fields, (v) => {
    state.faceAnalysis = {
      kind,
      plane: v.plane ? planeSpecFromOption(v.plane) : 'XY',
      bands: v.bands,
      tool: v.tool,
      flip: !!v.flip
    };
    // Only one colouring at a time, or they would fight over the same buffer.
    state.draft = null;
    rebuildAll();
    setStatus(`${titles[kind]} shown. Clear Analysis puts it away.`);
  });
}

/**
 * A comb along the edges of the model, showing how their curvature runs.
 *
 * Drawn on model edges rather than on sketch curves, because that is where a
 * kink actually costs something: two faces meeting along an edge whose comb
 * jumps are two faces that will not look like one surface.
 */
function startCurvatureComb() {
  if (state.sketcher.active) finishSketch();
  if (!state.selection.edges.size) {
    setStatus('Select the model edges to comb first.');
    return;
  }
  const scope = resolveParameters(state.doc.parameters).scope;
  showInspector(
    'Curvature Comb',
    [
      { key: 'scale', label: 'Comb length', type: 'expr', value: '40' },
      { key: 'density', label: 'How many spikes', type: 'expr', value: '1' },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'A straight run of comb is constant curvature. A jump in it is a crease.'
      }
    ],
    (v) => {
      const edges = gatherSelectedEdges();
      const scale = safeEval(v.scale, scope, 40);
      const density = safeEval(v.density, scope, 1);
      state.comb = edges
        .map((e) => curvatureComb(e.points, scale, density))
        .filter((c) => c.length);
      rebuildAll();
      setStatus(
        state.comb.length
          ? `Combed ${state.comb.length} edge${state.comb.length === 1 ? '' : 's'}.`
          : 'Those edges are straight, so there is no curvature to comb.'
      );
    }
  );
}

/** Put every analysis away and show the model as it is. */
function clearAnalysis() {
  const had =
    state.section || state.draft || state.massMarker || state.faceAnalysis || state.comb;
  state.section = null;
  state.draft = null;
  state.massMarker = null;
  state.faceAnalysis = null;
  state.comb = null;
  rebuildAll();
  setStatus(had ? 'Analysis cleared.' : 'No analysis was showing.');
}

function startConstruction() {
  if (state.sketcher.active) finishSketch();

  const kinds = [
    ['planeOffset', 'Offset Plane'],
    ['planeAngle', 'Plane at Angle'],
    ['planeMidplane', 'Midplane'],
    ['planeThreePoints', 'Plane Through 3 Points'],
    ['planeTangent', 'Tangent Plane'],
    ['axisTwoPoints', 'Axis Through 2 Points'],
    ['axisEdge', 'Axis Along an Edge'],
    ['axisCylinder', 'Axis of a Cylinder'],
    ['axisPlanes', 'Axis Where 2 Planes Meet'],
    ['axisNormal', 'Axis Normal to a Plane or Face'],
    ['pointAxisPlane', 'Point Where an Axis Meets a Plane'],
    ['pointCentre', 'Point at a Circle Centre'],
    ['planeAlongPath', 'Plane Along a Path'],
    ['planeTangentPoint', 'Plane Tangent at a Point'],
    ['pointAlongPath', 'Point Along a Path'],
    ['pointThreePlanes', 'Point Where 3 Planes Meet'],
    ['planePerpendicular', 'Plane Square Across an Axis'],
    ['planeTwoEdges', 'Plane Through 2 Edges'],
    ['pointTwoEdges', 'Point Where 2 Edges Meet'],
    ['ucs', 'Coordinate System']
  ];

  const entry = {
    id: uid('cx'),
    type: 'planeOffset',
    name: '',
    base: 'XY',
    distance: '10',
    angle: '45',
    axis: { worldAxis: 'x' },
    planeA: 'XY',
    planeB: 'XZ',
    planeC: 'YZ',
    plane: 'XY',
    guide: 'XY',
    t: '0.5'
  };
  attachSelectionToConstruction(entry);

  const feature = { id: uid('f'), type: 'construction', entry };

  openFeatureEditor(feature, 'Construction Geometry', [
    {
      key: '__kind',
      label: 'Kind',
      type: 'select',
      options: kinds,
      get: (f) => f.entry.type,
      set: (f, v) => {
        f.entry.type = v;
        attachSelectionToConstruction(f.entry);
      }
    },
    {
      key: '__base',
      label: 'From plane',
      type: 'select',
      options: planeOptions(),
      showIf: (f) => ['planeOffset', 'planeAngle'].includes(f.entry.type),
      get: (f) => optionForPlane(f.entry.base),
      set: (f, v) => {
        f.entry.base = planeSpecFromOption(v);
      }
    },
    {
      key: '__distance',
      label: 'Distance',
      type: 'expr',
      showIf: (f) => f.entry.type === 'planeOffset',
      get: (f) => f.entry.distance,
      set: (f, v) => {
        f.entry.distance = v;
      }
    },
    {
      key: '__angle',
      label: 'Angle',
      type: 'expr',
      showIf: (f) => ['planeAngle', 'planeTangent'].includes(f.entry.type),
      get: (f) => f.entry.angle,
      set: (f, v) => {
        f.entry.angle = v;
      }
    },
    {
      key: '__axis',
      label: 'About axis',
      type: 'select',
      options: axisOptions(),
      showIf: (f) => ['planeAngle', 'pointAxisPlane'].includes(f.entry.type),
      get: (f) => optionForAxis(f.entry.axis),
      set: (f, v) => {
        f.entry.axis = axisSpecFromOption(v);
      }
    },
    {
      key: '__edgeA',
      label: 'First edge',
      type: 'pick',
      pick: 'constructEdgeA',
      showIf: (f) => ['planeTwoEdges', 'pointTwoEdges'].includes(f.entry.type),
      summary: (f) => (f.entry.edgeA ? 'chosen' : 'none yet'),
      clear: (f) => {
        f.entry.edgeA = null;
      }
    },
    {
      key: '__edgeB',
      label: 'Second edge',
      type: 'pick',
      pick: 'constructEdgeB',
      showIf: (f) => ['planeTwoEdges', 'pointTwoEdges'].includes(f.entry.type),
      summary: (f) => (f.entry.edgeB ? 'chosen' : 'none yet'),
      clear: (f) => {
        f.entry.edgeB = null;
      }
    },
    {
      key: '__ucsX',
      label: 'Which way X goes',
      type: 'select',
      options: axisOptions(),
      showIf: (f) => f.entry.type === 'ucs',
      get: (f) => optionForAxis(f.entry.axisX),
      set: (f, v) => {
        f.entry.axisX = axisSpecFromOption(v);
      }
    },
    {
      key: '__ucsY',
      label: 'And roughly which way Y goes',
      type: 'select',
      options: axisOptions(),
      showIf: (f) => f.entry.type === 'ucs',
      get: (f) => optionForAxis(f.entry.axisY),
      set: (f, v) => {
        f.entry.axisY = axisSpecFromOption(v);
      }
    },
    {
      key: '__ucsFlip',
      label: 'Turn Z the other way',
      type: 'bool',
      showIf: (f) => f.entry.type === 'ucs',
      get: (f) => !!f.entry.flip,
      set: (f, v) => {
        f.entry.flip = !!v;
      }
    },
    {
      key: '__ucsNote',
      label: '',
      type: 'note',
      showIf: (f) => f.entry.type === 'ucs',
      text:
        'Y is squared up against X rather than taken as given, so two picked edges that are nearly at right angles still make a frame that is exactly at right angles.'
    },
    {
      key: '__acrossAxis',
      label: 'Square across',
      type: 'select',
      options: axisOptions(),
      showIf: (f) => f.entry.type === 'planePerpendicular',
      get: (f) => optionForAxis(f.entry.axis),
      set: (f, v) => {
        f.entry.axis = axisSpecFromOption(v);
      }
    },
    {
      key: '__t',
      label: 'How far along, 0 to 1',
      type: 'expr',
      showIf: (f) => ['planeAlongPath', 'pointAlongPath'].includes(f.entry.type),
      get: (f) => f.entry.t,
      set: (f, v) => {
        f.entry.t = v;
      }
    },
    {
      key: '__path',
      label: 'Path',
      type: 'pick',
      pick: 'constructPath',
      showIf: (f) => ['planeAlongPath', 'pointAlongPath'].includes(f.entry.type),
      summary: (f) =>
        f.entry.path
          ? f.entry.path.edge
            ? 'A model edge'
            : 'A sketch curve'
          : 'Nothing yet',
      clear: (f) => {
        f.entry.path = null;
      }
    },
    {
      key: '__planeC',
      label: 'Third plane',
      type: 'select',
      options: planeOptions(),
      showIf: (f) => f.entry.type === 'pointThreePlanes',
      get: (f) => optionForPlane(f.entry.planeC),
      set: (f, v) => {
        f.entry.planeC = planeSpecFromOption(v);
      }
    },
    {
      key: '__planeA',
      label: 'First plane',
      type: 'select',
      options: planeOptions(),
      showIf: (f) =>
        ['planeMidplane', 'axisPlanes', 'pointThreePlanes'].includes(f.entry.type),
      get: (f) => optionForPlane(f.entry.planeA),
      set: (f, v) => {
        f.entry.planeA = planeSpecFromOption(v);
      }
    },
    {
      key: '__planeB',
      label: 'Second plane',
      type: 'select',
      options: planeOptions(),
      showIf: (f) =>
        ['planeMidplane', 'axisPlanes', 'pointThreePlanes'].includes(f.entry.type),
      get: (f) => optionForPlane(f.entry.planeB),
      set: (f, v) => {
        f.entry.planeB = planeSpecFromOption(v);
      }
    },
    {
      key: '__plane',
      label: 'Plane',
      type: 'select',
      options: planeOptions(),
      showIf: (f) => ['axisNormal', 'pointAxisPlane'].includes(f.entry.type),
      get: (f) => optionForPlane(f.entry.plane),
      set: (f, v) => {
        f.entry.plane = planeSpecFromOption(v);
      }
    },
    {
      key: '__name',
      label: 'Name',
      type: 'text',
      get: (f) => f.entry.name || '',
      set: (f, v) => {
        f.entry.name = v;
      }
    }
  ]);

  setStatus(
    'Kinds that use a face, an edge or sketch points take them from the current selection.'
  );
}

function optionForPlane(spec) {
  if (typeof spec === 'string') return spec;
  if (spec && spec.construction) return `c:${spec.construction}`;
  return 'XY';
}

function optionForAxis(spec) {
  if (spec && spec.worldAxis) return `w:${spec.worldAxis}`;
  if (spec && spec.construction) return `c:${spec.construction}`;
  return 'w:x';
}

/** Feed whatever is selected into the construction entry that needs it. */
function attachSelectionToConstruction(entry) {
  const faces = selectedFaceRefs();
  const edges = selectedEdgeRefs();

  if (entry.type === 'planeTangent' || entry.type === 'axisCylinder') {
    const first = [...faces.values()][0];
    if (first && first[0]) entry.face = first[0];
  }
  if (entry.type === 'axisEdge' || entry.type === 'pointCentre') {
    const first = [...edges.values()][0];
    if (first && first[0]) entry.edge = first[0];
  }
  if (entry.type === 'planeTwoEdges' || entry.type === 'pointTwoEdges') {
    const all = [...edges.values()].flat();
    if (all[0]) entry.edgeA = all[0];
    if (all[1]) entry.edgeB = all[1];
  }
  if (entry.type === 'planeThreePoints' || entry.type === 'axisTwoPoints') {
    const pts = [];
    for (const f of state.doc.features) {
      if (f.type !== 'sketch') continue;
      const sk = state.doc.sketches[f.sketch];
      if (!sk) continue;
      sk.points.forEach((_, i) => pts.push({ sketch: sk.id, index: i }));
    }
    if (entry.type === 'planeThreePoints') entry.points = pts.slice(0, 3);
    else {
      entry.pointA = pts[0];
      entry.pointB = pts[1];
    }
  }
}

/* ------------------------------------------------------------------ */
/* Components, joints, and direct modelling                            */
/* ------------------------------------------------------------------ */

function addComponent() {
  pushUndo('new component');
  const c = newComponent(`Component ${state.doc.components.length + 1}`);
  if (!state.doc.components.length) c.grounded = true;
  state.doc.components.push(c);
  state.activeComponent = c.id;
  state.dirty = true;
  rebuildAll();
  setStatus(`${c.name} is now active. New features go into it.`);
}

function startJoint(opts = {}) {
  if (state.sketcher.active) finishSketch();
  const comps = state.doc.components;
  if (comps.length < 2) {
    setStatus('A joint needs two components.');
    return;
  }

  // The joint is captured where the parts already are, so at rest it moves
  // nothing. A selected face or edge gives it a sensible axis to turn about.
  const anchor = jointAnchorFromSelection();
  const joint = {
    id: uid('j'),
    name: `Joint ${state.doc.joints.length + 1}`,
    type: 'revolute',
    parent: comps[0].id,
    child: comps[1].id,
    origin: anchor,
    asBuilt: !!opts.asBuilt,
    driven: false,
    angle: '0',
    offset: '0',
    offset2: '0',
    pitch: '0',
    yaw: '0',
    roll: '0'
  };
  state.doc.joints.push(joint);

  const feature = { id: uid('f'), type: 'jointEdit', joint: joint.id };
  state.editingJoint = joint;

  openFeatureEditor(
    feature,
    opts.asBuilt ? 'As-built Joint' : 'Joint',
    [
      {
        key: '__type',
        label: 'Type',
        type: 'select',
        options: Object.entries(JOINT_TYPES).map(([k, v]) => [k, v.label]),
        get: () => joint.type,
        set: (_f, v) => {
          joint.type = v;
        }
      },
      {
        key: '__parent',
        label: 'Fixed part',
        type: 'select',
        options: comps.map((c) => [c.id, c.name]),
        get: () => joint.parent,
        set: (_f, v) => {
          joint.parent = v;
        }
      },
      {
        key: '__child',
        label: 'Moving part',
        type: 'select',
        options: comps.map((c) => [c.id, c.name]),
        get: () => joint.child,
        set: (_f, v) => {
          joint.child = v;
        }
      },
      {
        key: '__secondAxis',
        label: 'Second axis',
        type: 'pick',
        pick: 'jointAxis2',
        showIf: () => (JOINT_TYPES[joint.type]?.axes || 1) > 1,
        summary: () =>
          joint.origin?.axis2
            ? joint.origin.axis2.map((n) => round(n, 2)).join(', ')
            : 'Worked out from the first',
        clear: () => {
          if (joint.origin) delete joint.origin.axis2;
        }
      },
      // One row per degree of freedom the chosen type actually has, which is
      // what keeps a ball's three angles and a slider's one offset in the same
      // dialog without either of them carrying the other's boxes.
      ...['angle', 'offset', 'offset2', 'pitch', 'yaw', 'roll'].map((name) => ({
        key: `__${name}`,
        label: DOF_LABELS[name].label,
        type: 'expr',
        showIf: () => jointDof(joint).includes(name),
        get: () => joint[name] ?? '0',
        set: (_f, v) => {
          joint[name] = v;
        }
      })),
      {
        key: '__driven',
        label: 'Hold this one where it is set',
        type: 'bool',
        showIf: () => jointDof(joint).length > 0,
        get: () => !!joint.driven,
        set: (_f, v) => {
          joint.driven = v;
        }
      },
      {
        key: '__limited',
        label: 'Limit its travel',
        type: 'bool',
        showIf: () => jointDof(joint).length > 0,
        get: () => !!joint.limits && joint.limits.enabled !== false,
        set: (_f, v) => {
          joint.limits = v ? { ...(joint.limits || {}), enabled: true } : null;
        }
      },
      ...['angle', 'offset', 'offset2', 'pitch', 'yaw', 'roll'].flatMap((name) => [
        {
          key: `__${name}Min`,
          label: `${DOF_LABELS[name].label} least`,
          type: 'expr',
          showIf: () => !!joint.limits && jointDof(joint).includes(name),
          get: () => String(joint.limits?.[`${name}Min`] ?? ''),
          set: (_f, v) => {
            const n = Number(v);
            joint.limits[`${name}Min`] = Number.isFinite(n) ? n : undefined;
          }
        },
        {
          key: `__${name}Max`,
          label: `${DOF_LABELS[name].label} most`,
          type: 'expr',
          showIf: () => !!joint.limits && jointDof(joint).includes(name),
          get: () => String(joint.limits?.[`${name}Max`] ?? ''),
          set: (_f, v) => {
            const n = Number(v);
            joint.limits[`${name}Max`] = Number.isFinite(n) ? n : undefined;
          }
        }
      ]),
      {
        key: '__contact',
        label: 'Stop where the parts touch',
        type: 'bool',
        showIf: () => jointDof(joint).length > 0,
        get: () => !!joint.contact,
        set: (_f, v) => {
          joint.contact = v;
        }
      }
    ],
    true
  );
}

/**
 * An as-built joint: the parts are jointed exactly where they already sit.
 *
 * The difference from an ordinary joint is what happens on creation, not
 * afterwards. Both capture the origin from the current position, but an
 * ordinary joint may then be driven off that rest position, whereas as-built
 * is the statement that where they are is where they belong.
 */
function startAsBuiltJoint() {
  startJoint({ asBuilt: true });
}

/**
 * Lock several components together.
 *
 * Expressed as a group rather than as a rigid joint each, because that is how
 * it is thought about: these parts are one thing now. The solver turns it back
 * into rigid joints, so nothing downstream has to know about groups.
 */
function startRigidGroup() {
  if (state.sketcher.active) finishSketch();
  const comps = state.doc.components || [];
  if (comps.length < 2) {
    setStatus('A rigid group needs two components.');
    return;
  }
  state.doc.rigidGroups = state.doc.rigidGroups || [];
  const group = {
    id: uid('rg'),
    name: `Rigid group ${state.doc.rigidGroups.length + 1}`,
    components: comps.slice(0, 2).map((c) => c.id)
  };

  showInspector(
    'Rigid Group',
    [
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'Tick the components that should move as one. The first stays put and the rest follow it.'
      },
      ...comps.map((c) => ({
        key: c.id,
        label: c.name,
        type: 'check',
        value: group.components.includes(c.id)
      }))
    ],
    (values) => {
      const chosen = comps.filter((c) => values[c.id]).map((c) => c.id);
      if (chosen.length < 2) {
        setStatus('A rigid group needs at least two components.');
        return;
      }
      pushUndo('rigid group');
      group.components = chosen;
      state.doc.rigidGroups.push(group);
      state.dirty = true;
      rebuildAll();
      setStatus(`${chosen.length} components locked together.`);
    }
  );
}

/**
 * One joint driving another through a ratio: gears, a belt, a rack.
 *
 * The follower stops being something you can set, because its value now comes
 * from the driver. That is the point of the link and it is worth being blunt
 * about, so the dialog says so.
 */
function startMotionLink() {
  if (state.sketcher.active) finishSketch();
  const movable = (state.doc.joints || []).filter((j) => jointDof(j).length);
  if (movable.length < 2) {
    setStatus('A motion link needs two joints that can move.');
    return;
  }
  state.doc.motionLinks = state.doc.motionLinks || [];
  showInspector(
    'Motion Link',
    [
      {
        key: 'from',
        label: 'Driver',
        type: 'select',
        value: movable[0].id,
        options: movable.map((j) => [j.id, j.name || j.id])
      },
      {
        key: 'to',
        label: 'Follower',
        type: 'select',
        value: movable[1].id,
        options: movable.map((j) => [j.id, j.name || j.id])
      },
      { key: 'ratio', label: 'Ratio', type: 'expr', value: '2' },
      { key: 'reverse', label: 'Turn it the other way', type: 'check', value: false },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'The follower is worked out from the driver, so it can no longer be set on its own.'
      }
    ],
    (v) => {
      if (v.from === v.to) {
        setStatus('A joint cannot drive itself.');
        return;
      }
      pushUndo('motion link');
      state.doc.motionLinks.push({
        id: uid('ml'),
        from: v.from,
        to: v.to,
        ratio: v.ratio,
        reverse: !!v.reverse
      });
      state.dirty = true;
      rebuildAll();
      setStatus('Linked. Drive the first and the second follows.');
    }
  );
}

/**
 * Drive a joint, stopping at contact when it is asked for.
 *
 * Contact is walked rather than simulated: the joint is stepped from where it
 * rests towards where it was asked to go and stopped at the last position where
 * nothing overlaps. That is enough to keep a lid off its own hinge, and it is
 * not a physics engine, which the dialog says.
 */
function startDriveJoints() {
  if (state.sketcher.active) finishSketch();
  const movable = (state.doc.joints || []).filter((j) => jointDof(j).length);
  if (!movable.length) {
    setStatus('No joint here can move.');
    return;
  }
  const joint = movable[0];
  const dof = jointDof(joint)[0];

  showInspector(
    'Drive Joints',
    [
      {
        key: 'joint',
        label: 'Joint',
        type: 'select',
        value: joint.id,
        options: movable.map((j) => [j.id, j.name || j.id])
      },
      { key: 'to', label: `Drive to`, type: 'expr', value: String(joint[dof] ?? '0') },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'With contact ticked on the joint it stops where the parts meet rather than passing through.'
      }
    ],
    (v) => {
      const target = state.doc.joints.find((j) => j.id === v.joint);
      if (!target) return;
      const name = jointDof(target)[0];
      const scope = resolveParameters(state.doc.parameters).scope;
      const from = safeEval(target[name], scope, 0);
      const to = safeEval(v.to, scope, from);

      pushUndo('drive joint');
      if (target.contact) {
        const stop = limitByContact(from, to, (value) => {
          target[name] = String(value);
          rebuildAll();
          return assemblyOverlaps();
        });
        target[name] = String(round(stop, 4));
        rebuildAll();
        setStatus(
          Math.abs(stop - to) > 1e-3
            ? `Stopped at ${round(stop, 2)}, where the parts meet.`
            : `Driven to ${round(stop, 2)}. Nothing in the way.`
        );
      } else {
        target[name] = String(to);
        rebuildAll();
        setStatus(`Driven to ${round(to, 2)}.`);
      }
      state.dirty = true;
    }
  );
}

/** Whether any two bodies in different components currently share space. */
function assemblyOverlaps() {
  const bodies = state.result?.bodies || [];
  if (bodies.length < 2) return false;
  const scope = new K.Scope();
  try {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        // Only across components: two bodies of the same part touching is not
        // a collision, it is how the part is made.
        if (bodies[i].component && bodies[i].component === bodies[j].component) continue;
        const hit = K.intersection(bodies[i].solid, bodies[j].solid, scope);
        if (!K.isEmpty(hit) && hit.volume() > 1e-3) return true;
      }
    }
  } catch {
    return false;
  } finally {
    scope.dispose();
  }
  return false;
}

/** Where a joint should pivot, taken from the current selection. */
function jointAnchorFromSelection() {
  const cyl = singleSelectedCylinder();
  if (cyl) {
    return captureJointOrigin(cyl.face.cylinder.origin, cyl.face.cylinder.dir);
  }
  const face = singleSelectedFace();
  if (face) return captureJointOrigin(face.face.centre, face.face.normal);
  for (const key of state.selection.edges) {
    const { bodyId, index } = splitKey(key);
    const rec = (state.records || []).find((r) => r.id === bodyId);
    const edge = rec?.topology?.edges[index];
    if (edge?.kind === 'circle') return captureJointOrigin(edge.centre, edge.axis);
    if (edge?.kind === 'line') return captureJointOrigin(edge.start, edge.dir);
  }
  return captureJointOrigin([0, 0, 0], [0, 0, 1]);
}

async function toggleHistory() {
  if (state.doc.captureHistory === false) {
    state.doc.captureHistory = true;
    state.dirty = true;
    rebuildAll();
    setStatus('Design history is being captured again. New work goes on the timeline.');
    return;
  }

  const res = await window.anvil.message({
    type: 'warning',
    buttons: ['Turn it off', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Stop capturing design history?',
    detail:
      'The current shape is kept, but the features that made it are discarded and ' +
      'the timeline is cleared. Dimensions can no longer be edited after the fact. ' +
      'This cannot be undone by saving over the file.'
  });
  if (res.response !== 0) return;

  pushUndo('turn off history');
  try {
    state.doc.baseBodies = bakeBodies(state.result?.bodies || []);
  } catch (err) {
    setStatus(`Could not freeze the model: ${err.message}`);
    return;
  }
  state.doc.features = [];
  state.doc.sketches = {};
  state.doc.rollback = null;
  state.doc.captureHistory = false;
  state.dirty = true;
  rebuildAll();
  setStatus('Design history off. Editing works on the geometry directly.');
}

/** With history off, every operation is baked as soon as it is accepted. */
function bakeIfDirectModelling() {
  if (state.doc.captureHistory !== false) return;
  if (!state.doc.features.length) return;
  try {
    state.doc.baseBodies = bakeBodies(state.result?.bodies || []);
    state.doc.features = [];
    state.doc.sketches = {};
    rebuildAll();
  } catch (err) {
    setStatus(`Could not freeze the model: ${err.message}`);
  }
}

function startSketchMirror() {
  if (!state.sketcher.active) {
    setStatus('Sketch mirror works inside a sketch.');
    return;
  }
  const lines = state.sketcher.sketch.entities.filter((e) => e.type === 'line');
  if (!lines.length) {
    setStatus('Draw a line to mirror about first.');
    return;
  }
  const selected = [...state.sketcher.selection]
    .filter((k) => k.startsWith('e'))
    .map((k) => Number(k.slice(1)));
  if (!selected.length) {
    setStatus('Select the geometry to mirror, then pick the mirror line.');
    return;
  }

  // A centreline is drawn to be mirrored about, so it goes to the top of the
  // list and does not have to be picked out of the line numbers.
  const label = (l) =>
    l.centerline
      ? `Line ${l.id} (centreline)`
      : `Line ${l.id}${l.construction ? ' (construction)' : ''}`;
  const ordered = [...lines].sort((a, b) => (b.centerline ? 1 : 0) - (a.centerline ? 1 : 0));

  promptChoice(
    'Mirror about which line?',
    ordered.map((l) => [String(l.id), label(l)]),
    (value) => {
      state.sketcher.mirrorSelection(Number(value));
    }
  );
}

function editJoint(joint) {
  const comps = state.doc.components;
  const feature = { id: uid('f'), type: 'jointEdit', joint: joint.id };
  openFeatureEditor(
    feature,
    'Joint',
    [
      {
        key: '__type',
        label: 'Type',
        type: 'select',
        options: Object.entries(JOINT_TYPES).map(([k, v]) => [k, v.label]),
        get: () => joint.type,
        set: (_f, v) => {
          joint.type = v;
        }
      },
      {
        key: '__parent',
        label: 'Fixed part',
        type: 'select',
        options: comps.map((c) => [c.id, c.name]),
        get: () => joint.parent,
        set: (_f, v) => {
          joint.parent = v;
        }
      },
      {
        key: '__child',
        label: 'Moving part',
        type: 'select',
        options: comps.map((c) => [c.id, c.name]),
        get: () => joint.child,
        set: (_f, v) => {
          joint.child = v;
        }
      },
      {
        key: '__angle',
        label: 'Angle',
        type: 'expr',
        showIf: () => JOINT_TYPES[joint.type]?.angle,
        get: () => joint.angle,
        set: (_f, v) => {
          joint.angle = v;
        }
      },
      {
        key: '__offset',
        label: 'Offset',
        type: 'expr',
        showIf: () => JOINT_TYPES[joint.type]?.offset,
        get: () => joint.offset,
        set: (_f, v) => {
          joint.offset = v;
        }
      }
    ],
    true
  );
}

function bodySelectionOrAll() {
  if (state.selection.bodies.size) return [...state.selection.bodies];
  // A picked face or edge names its body just as well.
  const fromGeometry = new Set();
  for (const key of [...state.selection.faces, ...state.selection.edges]) {
    fromGeometry.add(splitKey(key).bodyId);
  }
  return fromGeometry.size ? [...fromGeometry] : 'all';
}

/* ------------------------------------------------------------------ */
/* Selection sets                                                      */
/* ------------------------------------------------------------------ */

/**
 * Name what is selected so it can be got back.
 *
 * Fusion calls these Selection Sets. The reason to have them is a thirty edge
 * fillet: picking those edges once is a chore, picking them again after a
 * rebuild has renumbered everything is why people stop editing parts.
 *
 * What is stored is references, not indices. An index is a position in this
 * rebuild's topology and means nothing after the next one. A reference is
 * orientation, then size and position, which is the same thing every feature in
 * the document uses to hold on to a face across a dimension change.
 */
function createSelectionSet() {
  const sel = state.selection;
  if (!sel.faces.size && !sel.edges.size && !sel.bodies.size) {
    setStatus('Select something first, then name it.');
    return;
  }

  const set = {
    id: uid('s'),
    name: `Set ${(state.doc.selectionSets || []).length + 1}`,
    bodies: [...sel.bodies],
    faces: [],
    edges: []
  };
  for (const [bodyId, refs] of selectedFaceRefs()) {
    for (const face of refs) set.faces.push({ bodyId, face });
  }
  for (const [bodyId, refs] of selectedEdgeRefs()) {
    for (const edge of refs) set.edges.push({ bodyId, edge });
  }

  promptText('Name this selection set', set.name, (name) => {
    const clean = String(name || '').trim();
    if (!clean) return;
    set.name = clean;
    pushUndo('create selection set');
    state.doc.selectionSets = state.doc.selectionSets || [];
    state.doc.selectionSets.push(set);
    state.dirty = true;
    renderTree();
    setStatus(`${set.name}: ${selectionSetCount(set)} saved.`);
  });
}

/** How much is in a set, written the way the browser row wants it. */
function selectionSetCount(set) {
  const bits = [];
  if (set.edges?.length) bits.push(`${set.edges.length} edge${set.edges.length === 1 ? '' : 's'}`);
  if (set.faces?.length) bits.push(`${set.faces.length} face${set.faces.length === 1 ? '' : 's'}`);
  if (set.bodies?.length) bits.push(`${set.bodies.length} bod${set.bodies.length === 1 ? 'y' : 'ies'}`);
  return bits.join(', ') || 'empty';
}

/**
 * Put a saved selection back.
 *
 * References that no longer resolve are counted and said out loud rather than
 * passed over. A set that used to hold thirty edges and now finds twenty six is
 * the one thing you need to know before pressing Fillet, and a silent set would
 * hide exactly that.
 */
function restoreSelectionSet(set) {
  const sel = state.selection;
  sel.faces.clear();
  sel.edges.clear();
  sel.bodies.clear();
  sel.profiles = [];

  let lost = 0;
  const byBody = (list) => {
    const m = new Map();
    for (const item of list || []) {
      if (!m.has(item.bodyId)) m.set(item.bodyId, []);
      m.get(item.bodyId).push(item);
    }
    return m;
  };

  for (const [bodyId, items] of byBody(set.faces)) {
    const rec = (state.records || []).find((r) => r.id === bodyId);
    if (!rec?.topology) {
      lost += items.length;
      continue;
    }
    for (const item of items) {
      const [face] = resolveFaceRefs(rec.topology, [item.face]);
      if (!face) {
        lost++;
        continue;
      }
      sel.faces.add(`${bodyId}:${rec.topology.faces.indexOf(face)}`);
    }
  }

  for (const [bodyId, items] of byBody(set.edges)) {
    const rec = (state.records || []).find((r) => r.id === bodyId);
    if (!rec?.topology) {
      lost += items.length;
      continue;
    }
    for (const item of items) {
      const [edge] = resolveEdgeRefs(rec.topology, [item.edge]);
      if (!edge) {
        lost++;
        continue;
      }
      sel.edges.add(`${bodyId}:${rec.topology.edges.indexOf(edge)}`);
    }
  }

  for (const id of set.bodies || []) {
    if ((state.result?.bodies || []).some((b) => b.id === id)) sel.bodies.add(id);
    else lost++;
  }

  refreshHighlight();
  renderTree();
  setStatus(
    lost
      ? `${set.name}: ${selectionSetCount({
          edges: [...sel.edges],
          faces: [...sel.faces],
          bodies: [...sel.bodies]
        })} back, ${lost} no longer in the model.`
      : `${set.name} restored.`
  );
}

function renameSelectionSet(set) {
  promptText('Rename this selection set', set.name, (name) => {
    const clean = String(name || '').trim();
    if (!clean) return;
    pushUndo('rename selection set');
    set.name = clean;
    state.dirty = true;
    renderTree();
  });
}

/* ------------------------------------------------------------------ */
/* Edge and face features                                              */
/* ------------------------------------------------------------------ */

function selectedEdgeRefs() {
  const byBody = new Map();
  for (const key of state.selection.edges) {
    const { bodyId, index } = splitKey(key);
    const rec = (state.records || []).find((r) => r.id === bodyId);
    const edge = rec?.topology?.edges[index];
    if (!edge) continue;
    if (!byBody.has(bodyId)) byBody.set(bodyId, []);
    byBody.get(bodyId).push(edgeReference(edge, rec.topology));
  }
  return byBody;
}

function selectedFaceRefs() {
  const byBody = new Map();
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    const rec = (state.records || []).find((r) => r.id === bodyId);
    const face = rec?.topology?.faces[index];
    if (!face) continue;
    if (!byBody.has(bodyId)) byBody.set(bodyId, []);
    byBody.get(bodyId).push(faceReference(face));
  }
  return byBody;
}

function startEdgeBlend(kind) {
  if (state.sketcher.active) finishSketch();
  const byBody = selectedEdgeRefs();
  if (!state.result?.bodies.length) {
    setStatus(`There is nothing to ${kind} yet.`);
    return;
  }

  // Opens ready to be pointed at, the way Extrude does, and does nothing until
  // it has been. It used to take every convex edge on the part the moment the
  // button was pressed, which is a whole shape changed before anything was
  // asked for.
  const [bodyId, edges] = byBody.size ? [...byBody][0] : [state.result.bodies[0].id, []];
  const feature = {
    id: uid('f'),
    type: kind,
    bodies: [bodyId],
    sets: [
      {
        edges,
        radius: kind === 'fillet' ? '2' : '1',
        radius2: kind === 'fillet' ? '2' : '1',
        endRadius: null,
        continuity: 'G1',
        weight: '1',
        chamferType: 'equal',
        distance2: '1',
        angle: '45'
      }
    ]
  };
  openFeatureEditor(
    feature,
    kind === 'fillet' ? 'Fillet' : 'Chamfer',
    blendFieldsFor(feature, kind)
  );
  if (!edges.length) {
    setEditPick('set:0');
    setStatus(`Click the edges to ${kind}.`);
  }
}

function startShell() {
  if (state.sketcher.active) finishSketch();
  const faceRefs = selectedFaceRefs();
  const bodies = bodySelectionOrAll();
  if (bodies === 'all' && !(state.result?.bodies.length)) {
    setStatus('Nothing to shell yet.');
    return;
  }

  const bodyId = faceRefs.size ? [...faceRefs.keys()][0] : null;
  const feature = {
    id: uid('f'),
    type: 'shell',
    bodies: bodyId ? [bodyId] : bodies,
    thickness: '2',
    openFaces: bodyId ? faceRefs.get(bodyId) : []
  };
  feature.side = 'inside';
  openFeatureEditor(feature, 'Shell', shellFields());
  if (!feature.openFaces.length) setEditPick('openFaces');
  setStatus(
    feature.openFaces.length
      ? `Shelling with ${feature.openFaces.length} face${
          feature.openFaces.length === 1 ? '' : 's'
        } left open.`
      : 'Shelling closed. Select faces first to leave them open.'
  );
}

/**
 * Press Pull: offset the selected faces along their own normals. On a planar
 * face this is Fusion's offset-face behaviour, which is the quickest way to
 * make something thicker or thinner without going back to the sketch.
 */
function startPressPull() {
  if (state.sketcher.active) finishSketch();

  if (state.selection.edges.size) {
    startEdgeBlend('fillet');
    return;
  }

  const faceRefs = selectedFaceRefs();
  if (!faceRefs.size) {
    beginPicking({
      prompt: 'Click a face to push or pull. Press Enter when done.',
      filter: { faces: true, edges: false, bodies: false, profiles: false },
      onDone: () => startPressPull()
    });
    return;
  }

  const [bodyId, faces] = [...faceRefs][0];
  const feature = {
    id: uid('f'),
    type: 'offsetFace',
    bodies: [bodyId],
    faces,
    distance: '2'
  };
  openFeatureEditor(feature, 'Press Pull', pressPullFields());
}

/* ------------------------------------------------------------------ */
/* Pulling, straight off the selection                                 */
/* ------------------------------------------------------------------ */

/**
 * The arrow that stands on whatever is selected, waiting to be pulled.
 *
 * Clicking a face and dragging it is the obvious way to say "make this
 * thicker", and asking for a command and then a second pick of the thing
 * already pointed at is two steps of ceremony in front of one intention. So a
 * single planar face, or a single sketch profile, grows a handle: drag it and
 * the body follows as it happens.
 *
 * A face pulls itself; a profile extrudes. They are different features and the
 * same gesture, which is the point.
 */
/**
 * The arrow for an extrude dialog that is already open.
 *
 * Reaching for the ribbon's Extrude is the other way into the same feature, and
 * it used to be a dead end. The dialog opens with a distance of zero, on
 * purpose, so nothing appears before a length is given. But there was nothing
 * to give a length with: no arrow, because an open dialog took the arrow away,
 * and no value box, because the box belongs to a drag. So the profile was
 * chosen, the callout said so, and the screen never changed. Typing into the
 * dialog's own distance field worked, and nothing on screen said that was the
 * only thing left that would.
 *
 * Fusion stands an arrow on the profile the moment it is picked, and dragging
 * it is how the number gets filled in. This is that arrow. It drives the
 * feature the dialog is already editing rather than making a new one.
 */
function editingPullTarget() {
  const f = state.editing?.feature;
  if (!f || f.type !== 'extrude') return null;
  // Only the plain case. A revolve turns rather than travels, and to-object and
  // two-sided extrudes are not one length along one axis.
  if (f.extent !== 'distance' || f.direction === 'two') return null;

  if (f.faces?.length) {
    const record = (state.records || []).find((r) => r.id === f.faces[0].bodyId);
    if (!record?.topology) return null;
    const [face] = resolveFaceRefs(record.topology, [f.faces[0].face]);
    if (!face?.planar) return null;
    const b = basisFor(face.normal);
    return {
      kind: 'editing',
      frame: { origin: face.centre, x: b.x, y: b.y, z: face.normal },
      feature: f
    };
  }

  const plane = f.sketch ? state.result?.sketchPlanes?.[f.sketch] : null;
  const regions = f.sketch ? state.result?.sketchRegions?.[f.sketch] : null;
  if (!plane || !regions?.length) return null;
  // A seed is a point inside the region, matched by containment, which is the
  // same test the rebuild uses. A null seed list means the whole sketch, so the
  // arrow stands on the first region of it rather than nowhere.
  const region = f.seeds?.length
    ? regions.find((r) => regionHoldsSeed(r, f.seeds[0]))
    : f.seeds === null
      ? regions[0]
      : null;
  if (!region) return null;
  const origin = regionCentreWorld(region, plane);
  if (!origin) return null;
  return {
    kind: 'editing',
    frame: { origin, x: plane.x, y: plane.y, z: plane.n },
    feature: f
  };
}

function pullTarget() {
  // An open dialog gets its own arrow rather than none at all.
  if (state.editing && !state.sketcher.active && !state.picking && !state.editForm) {
    return editingPullTarget();
  }
  if (state.sketcher.active || state.editing || state.picking || state.editForm) return null;

  if (state.selection.faces.size === 1 && !state.selection.edges.size) {
    const found = singleSelectedFace();
    if (!found) return null;
    const b = basisFor(found.face.normal);
    return {
      kind: 'face',
      frame: { origin: found.face.centre, x: b.x, y: b.y, z: found.face.normal },
      record: found.record,
      face: found.face
    };
  }

  // Fusion's Press Pull is a router: a profile opens Extrude, a face opens
  // Offset Face, and an edge opens Fillet. The arrow was already the first two.
  // The bisector of the two faces is the direction a fillet grows in, whether
  // it is rounding a corner off or filling one in.
  const edge = singleSelectedEdge();
  if (edge) {
    const b = basisFor(edge.out);
    return {
      kind: 'edge',
      frame: { origin: edge.edge.refPoint, x: b.x, y: b.y, z: edge.out },
      record: edge.record,
      edge: edge.edge
    };
  }

  if (state.selection.profiles.length === 1 && !state.selection.faces.size) {
    const pick = state.selection.profiles[0];
    const plane = state.result?.sketchPlanes?.[pick.sketch];
    const region = state.result?.sketchRegions?.[pick.sketch]?.find(
      (r) => r.id === pick.regionId
    );
    if (!plane || !region) return null;
    const at = regionCentreWorld(region, plane);
    if (!at) return null;
    return {
      kind: 'profile',
      frame: { origin: at, x: plane.x, y: plane.y, z: plane.n },
      pick
    };
  }
  return null;
}

/** The middle of a sketch region, in the world, so the arrow stands on it. */
function regionCentreWorld(region, plane) {
  const ring = region.outer || region.points || null;
  if (!ring || !ring.length) return null;
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += (Array.isArray(p) ? p[0] : p.x) / ring.length;
    y += (Array.isArray(p) ? p[1] : p.y) / ring.length;
  }
  return sketchToWorld(plane, x, y, 0).toArray();
}

/** Put the handle where it belongs, or take it away. */
function refreshPullHandle() {
  const target = state.pullDrag ? state.pullDrag.target : pullTarget();
  const appeared = !!target && !state.pullHandle;
  state.pullHandle = target;
  state.vp.setGizmo(target ? target.frame : null, 'pull');

  // An arrow pointing straight at the eye is a dot. There is nothing to aim at
  // and no direction to drag in, and that is exactly the state you are in the
  // moment a sketch is finished, because finishing one leaves you looking
  // square at its plane. So the view is turned as soon as the arrow appears,
  // and what you press is what you were looking at.
  //
  // It used to turn at the press instead, which was worse than not turning at
  // all: the arrow leapt a hundred and thirty pixels out from under the pointer
  // that had just grabbed it, and the direction you had aimed to drag in was no
  // longer the direction the arrow lay along.
  if (appeared && !state.pullDrag && turnToSeeAxis(target.frame.z)) {
    state.vp.setGizmo(target.frame, 'pull');
  }

  // The value box stands beside the arrow for as long as the arrow is there,
  // and goes when it goes. Swept up here rather than at each exit, because it
  // was the exits that were missed: only the dialog's own OK and Cancel ever
  // cleared it, so every other way out left it floating beside the pointer for
  // the rest of the session.
  syncPullValueBox();

  // The callout steps aside for the arrow, and the arrow has just changed, so
  // it has to be told now rather than at the next pointer move. Otherwise it
  // sits on top of the arrow from the moment the arrow appears until the mouse
  // is moved, which is exactly the moment somebody is looking for it.
  placeCallout();
}

/** A press on the arrow starts a pull. Returns true when it took the click. */
function pullPointerDown(e) {
  if (!state.pullHandle || e.button !== 0) return false;
  const hit = state.vp.pickGizmo(e.clientX, e.clientY);
  if (!hit || hit.kind !== 'move') return false;

  const target = state.pullHandle;
  const frame = target.frame;
  // Normally the view was already turned when the arrow appeared, so this does
  // nothing. It is here for the one case that is left: orbiting to end-on after
  // selecting and then pressing. A jump at that moment is jarring, and it is
  // still better than a drag along an arrow with no length to drag along.
  turnToSeeAxis(frame.z);
  const start = { x: e.clientX, y: e.clientY };

  // The arrow on an open dialog drives the feature that dialog is editing.
  // Nothing is created and nothing is opened: it is already there, waiting for
  // the one number it has not been given.
  if (target.kind === 'editing') {
    state.pullDrag = {
      target,
      frame,
      start,
      feature: target.feature,
      moved: false,
      typed: false,
      existing: true
    };
    showPullValue(e);
    try {
      state.vp.canvas.setPointerCapture(e.pointerId);
      state.pullDrag.pointerId = e.pointerId;
    } catch {
      /* capture is a convenience, not a requirement */
    }
    return true;
  }

  // Recorded before the dialog opens, not after. Opening it rebuilds, and a
  // rebuild takes the handle away again unless it can see that a drag has hold
  // of it, which left the arrow vanishing under the pointer that grabbed it.
  const feature = pullFeatureFor(target);
  state.pullDrag = { target, frame, start, feature, moved: false, typed: false };
  openPullEditor(target, feature);

  showPullValue(e);
  try {
    state.vp.canvas.setPointerCapture(e.pointerId);
    state.pullDrag.pointerId = e.pointerId;
  } catch {
    /* capture is a convenience, not a requirement */
  }
  return true;
}

/** The feature a pull on this target creates. */
function pullFeatureFor(target) {
  if (target.kind === 'edge') {
    return {
      id: uid('f'),
      type: 'fillet',
      bodies: [target.record.id],
      sets: [
        {
          edges: [edgeReference(target.edge)],
          radius: '0',
          filletType: 'constant',
          endRadius: null,
          chamferType: 'equal',
          distance2: '1',
          angle: '45'
        }
      ]
    };
  }
  if (target.kind === 'face') {
    return {
      id: uid('f'),
      type: 'offsetFace',
      bodies: [target.record.id],
      faces: [faceReference(target.face)],
      distance: '0'
    };
  }
  return {
    id: uid('f'),
    type: 'extrude',
    sketch: target.pick.sketch,
    seeds: [target.pick.seed],
    distance: '0',
    // An extrude goes one way and is turned round by `flip`. It has no
    // "other side" setting: `two` means both at once, with a length each.
    direction: 'one',
    flip: false,
    // Join only where the sketch is drawn on a body. Anywhere else it is a new
    // part, not an addition to whatever happens to exist already.
    op:
      state.result?.bodies.length && state.doc.sketches[target.pick.sketch]?.plane?.face
        ? 'join'
        : 'new',
    targets: 'all',
    taper: '0',
    extent: 'distance'
  };
}

/**
 * Put the feature in and open its dialog, without moving the camera or taking
 * the focus. The feature goes in straight away and is driven from there, so
 * what is on screen is the real rebuild rather than a preview that might
 * disagree with it.
 */
function openPullEditor(target, feature) {
  const title = { edge: 'Fillet', face: 'Press Pull' }[target.kind] || 'Extrude';
  const fields =
    target.kind === 'edge'
      ? blendFieldsFor(feature, 'fillet')
      : target.kind === 'face'
        ? pressPullFields()
        : extrudeFields();
  openFeatureEditor(feature, title, fields, false, { keepView: true, keepFocus: true });
}

function pullPointerMove(e) {
  const d = state.pullDrag;
  if (!d) return false;
  if (!d.typed) {
    setPullDistance(axisDragAmount(d.frame, e.clientX - d.start.x, e.clientY - d.start.y));
    d.moved = true;
  }
  movePullValue(e);
  return true;
}

/**
 * Let go, and leave the number in hand.
 *
 * The box stays, focused and selected, so the exact size can simply be typed
 * over the one that was dragged to. That is the answer to having dragged
 * roughly the right amount and knowing the number you actually wanted.
 */
function pullPointerUp(e) {
  const d = state.pullDrag;
  if (!d) return false;
  try {
    state.vp.canvas.releasePointerCapture(d.pointerId ?? e?.pointerId);
  } catch {
    /* already let go */
  }
  state.pullDrag = null;
  refreshPullHandle();

  // A press on the arrow that never moved is a click, not a drag, and what it
  // is a click on is whatever the arrow is standing on. Taken as a drag of
  // nothing it started a feature: clicking a face a second time, or clicking
  // anywhere near the arrow the first click put up, opened Press Pull at zero.
  // From the outside that is the app deciding on its own to extrude, and it is
  // what makes a face impossible to simply select and then sketch on.
  if (!d.moved && !d.typed && e) {
    if (d.existing && state.editing?.pickInto) {
      hidePullValue();
      const profile = profilePickArmed() ? pickProfile(e.clientX, e.clientY) : null;
      if (profile) return pickIntoEdit({ kind: 'profile', ...profile });
      const hit = state.vp.pickEntity(e.clientX, e.clientY, { edges: false });
      if (hit) return pickIntoEdit(hit);
      return true;
    }
    if (!d.existing) {
      // The feature was put in at the press, so backing out of it here leaves
      // no trace, and the click falls through to ordinary selection.
      cancelEdit();
      refreshPullHandle();
      const hit = state.vp.pickEntity(e.clientX, e.clientY, { edges: false });
      if (hit) acceptPick(hit, e);
      return true;
    }
  }

  const input = state.pullValueEl?.querySelector('input');
  if (input) {
    input.focus();
    input.select();
  }
  return true;
}

/**
 * How far along the frame's axis a pointer has dragged, measured on screen.
 *
 * The exact answer is where the pointer's ray comes nearest the axis, which is
 * what the form manipulator uses and what this used first. It is the wrong
 * measure here. As the axis turns to face the camera, that nearest point runs
 * away to infinity, so a face seen close to end on jumped by tens of
 * millimetres for a pixel of movement, and pulling it gently was impossible.
 *
 * Measuring along the axis as it appears on screen has no such singularity: a
 * drag of so many pixels along the arrow is that fraction of the arrow's
 * length. Where the axis is so close to end on that it has almost no length on
 * screen there is no honest answer at all, and it returns nothing rather than a
 * wild one. The value box is sitting right there to be typed into.
 */
function axisDragAmount(frame, dx, dy) {
  const reference = state.vp.pixelSize() * 95;
  const a = state.vp.worldToScreen(frame.origin[0], frame.origin[1], frame.origin[2]);
  const b = state.vp.worldToScreen(
    frame.origin[0] + frame.z[0] * reference,
    frame.origin[1] + frame.z[1] * reference,
    frame.origin[2] + frame.z[2] * reference
  );
  if (!a || !b || a.behind || b.behind) return 0;

  const ax = b.clientX - a.clientX;
  const ay = b.clientY - a.clientY;
  const len2 = ax * ax + ay * ay;

  // Still end on, so the axis has no direction on screen to follow. Dragging up
  // grows it, at the rate a pixel is worth where the thing being pulled sits,
  // so moving the pointer an inch moves the face an inch as it looks.
  if (len2 < 625) return -dy * state.vp.pixelSize();

  return ((dx * ax + dy * ay) / len2) * reference;
}

/** Set the distance the drag has reached, live, in the dialog and the model. */
function setPullDistance(mm) {
  const d = state.pullDrag;
  if (!d) return;
  const rounded = Math.abs(mm) < 1e-9 ? 0 : Number(mm.toFixed(4));
  // A fillet has a radius rather than a distance, and no sign at all: dragged
  // back past nothing there is no fillet, not an inside-out one.
  if (d.feature.type === 'fillet') {
    d.feature.sets[0].radius = String(Math.max(0, rounded));
  } else {
    d.feature.distance = String(rounded);
    // A face offset carries its sign, and cuts in when it is negative. An
    // extrude has no sign: it is a length one way, turned round by `flip`.
    if (d.feature.type === 'extrude') {
      d.feature.distance = String(Math.abs(rounded));
      d.feature.flip = rounded < 0;
    }
  }
  // The same number the dialog's own field shows. A feature stores what the
  // expression evaluates to, with no unit conversion in between, so converting
  // here would put two different numbers on screen for one distance.
  const input = state.pullValueEl?.querySelector('input');
  if (input && document.activeElement !== input) input.value = String(round(Math.abs(rounded), 3));
  if (state.editing) renderFields();
  rebuildAll();
}

/* ------------------------------------------------------------------ */

/**
 * The value box that follows the cursor while pulling.
 *
 * Built to look and behave like the one the sketcher shows while drawing,
 * because it is the same question asked in three dimensions and answering it
 * two different ways would be two things to learn.
 */
function showPullValue(e) {
  hidePullValue();
  const box = document.createElement('div');
  box.className = 'sk-entry pull-entry';

  const wrap = document.createElement('label');
  wrap.className = 'sk-entry-field';
  const cap = document.createElement('span');
  cap.textContent = state.pullHandle?.kind === 'edge' ? 'Radius' : 'Distance';
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.value = '0';
  input.addEventListener('input', () => {
    const text = input.value.trim();
    if (state.pullDrag) state.pullDrag.typed = text !== '';
    wrap.classList.toggle('locked', text !== '');
    // Whatever the parameters understand, so a size can be given as `wall * 2`.
    // The text itself is kept rather than the number it came to, so it still
    // reads back the way it was typed and still follows the parameter.
    const scope = resolveParameters(state.doc.parameters).scope;
    if (!Number.isFinite(safeEval(text, scope, NaN))) return;

    // Typing a size into the box is the same request as dragging to one, so it
    // makes the feature the same way a drag does. Without this the box was
    // inert until something had been dragged, which is the wrong way round:
    // typing the number you already know is the quicker of the two.
    if (!state.editing && state.pullHandle && state.pullHandle.kind !== 'editing') {
      const target = state.pullHandle;
      openPullEditor(target, pullFeatureFor(target));
      input.focus();
    }
    const feature = state.editing?.feature;
    if (!feature) return;
    if (feature.type === 'fillet' && feature.sets?.length) feature.sets[0].radius = text;
    else feature.distance = text;
    renderFields();
    scheduleRebuild();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      hidePullValue();
      commitEdit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      hidePullValue();
      cancelEdit();
      // The box comes back with the arrow, so letting go of the feature is not
      // enough on its own: let go of what the arrow is standing on too.
      clearGeometrySelection();
    }
  });

  wrap.appendChild(cap);
  wrap.appendChild(input);
  box.appendChild(wrap);
  document.getElementById('viewwrap').appendChild(box);
  state.pullValueEl = box;
  movePullValue(e);
}

function movePullValue(e) {
  const box = state.pullValueEl;
  if (!box) return;
  const r = document.getElementById('viewwrap').getBoundingClientRect();
  if (e) {
    box.style.left = `${e.clientX - r.left + 18}px`;
    box.style.top = `${e.clientY - r.top + 18}px`;
    return;
  }
  // No pointer to follow, so it stands beside the arrow's tip: near enough to
  // read as belonging to it, off to the side so it does not cover it.
  const f = state.pullHandle?.frame;
  if (!f) return;
  const len = state.vp.pixelSize() * 95;
  const tip = state.vp.worldToScreen(
    f.origin[0] + f.z[0] * len,
    f.origin[1] + f.z[1] * len,
    f.origin[2] + f.z[2] * len
  );
  if (!tip || tip.behind) return;
  const w = box.offsetWidth || 150;
  const h = box.offsetHeight || 34;
  const pad = 8;
  const x = Math.max(pad, Math.min(tip.clientX - r.left + 20, r.width - w - pad));
  const y = Math.max(pad, Math.min(tip.clientY - r.top - h / 2, r.height - h - pad));
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
}

/**
 * Keep a box beside the arrow whenever there is an arrow.
 *
 * It used to exist only during a drag, so the only way to give a size was to
 * drag out a wrong one first and then type over it. The number is usually
 * already known, and typing it is quicker than dragging to it; there was
 * nothing on screen that said so, or that said the arrow could be typed at all.
 *
 * The element is kept rather than rebuilt while the arrow stays up, or every
 * rebuild would take the focus and the half-typed number with it.
 */
function syncPullValueBox() {
  // While dragging, the box belongs to the drag and follows the cursor.
  if (state.pullDrag) return;
  if (!state.pullHandle) {
    if (!state.editing) hidePullValue();
    return;
  }
  if (!state.pullValueEl) {
    // Where the keyboard was before the box appeared. Taking focus off a field
    // somebody is already typing in would be worse than not having the box.
    const busy = document.activeElement;
    const free =
      !busy || busy === document.body || busy === state.vp.canvas || busy.tagName === 'CANVAS';
    showPullValue(null);
    const f = state.editing?.feature;
    const shown = f && f.distance !== '0' ? f.distance : '';
    const input = state.pullValueEl?.querySelector('input');
    if (input) {
      input.value = shown;
      // Focused, or it is a box you have to find and click before it will take
      // anything, which is the same as not being able to type at all.
      if (free) {
        input.focus();
        input.select();
      }
    }
  }
  movePullValue(null);
}

function hidePullValue() {
  state.pullValueEl?.remove();
  state.pullValueEl = null;
}

/* ------------------------------------------------------------------ */
/* Picking prompts                                                     */
/* ------------------------------------------------------------------ */

/**
 * Put the app into "now click something" mode. Dialogs use this rather than
 * demanding a selection be made beforehand.
 */
function beginPicking({ prompt, filter, onDone, onPick, once, onEnd }) {
  const intoSelection = (hit, additive) => {
    if (!additive) {
      if (filter.edges) state.selection.edges.clear();
      if (filter.faces) state.selection.faces.clear();
      if (filter.profiles) state.selection.profiles = [];
    }
    if (hit.kind === 'edge') {
      toggle(state.selection.edges, `${hit.bodyId}:${hit.edgeId}`, true);
    } else if (hit.kind === 'face' && hit.faceId !== null) {
      toggle(state.selection.faces, `${hit.bodyId}:${hit.faceId}`, true);
    } else if (hit.kind === 'profile') {
      const key = (p) => `${p.sketch}|${p.regionId}`;
      const existing = state.selection.profiles.findIndex((p) => key(p) === key(hit));
      if (existing >= 0) state.selection.profiles.splice(existing, 1);
      else state.selection.profiles.push(hit);
      renderSketchDisplay();
    }
  };

  state.picking = {
    filter,
    prompt,
    onDone,
    onEnd,
    // A caller that wants the pick itself passes onPick, and with `once` the
    // first one ends the session. Everything else folds into the selection and
    // waits for OK.
    onPick: (hit, additive) => {
      if (!onPick) return intoSelection(hit, additive);
      onPick(hit, additive);
      if (once) endPicking(false);
      return undefined;
    }
  };
  setStatus(prompt);
  syncPickBar();
  updateHints();
}

function endPicking(run) {
  const pick = state.picking;
  state.picking = null;
  syncPickBar();
  // onEnd tidies up whatever the pick turned on, whether it was taken or not.
  if (pick?.onEnd) pick.onEnd();
  if (run && pick?.onDone) pick.onDone();
  updateHints();
}

const PICK_PROMPTS = {
  profiles: 'Click the profiles and planar faces to use.',
  sections: 'Click each profile in turn.',
  axis: 'Click the line to turn about.',
  path: 'Click the curve to follow.',
  rail: 'Click the guide rail.',
  rails: 'Click the guide rails.',
  startObject: 'Click the face or plane to start from.',
  toObject: 'Click the face, plane or body to reach.',
  targets: 'Click the bodies to affect.',
  openFaces: 'Click the faces to leave open.',
  draftFaces: 'Click the faces.',
  neutral: 'Click the neutral plane.',
  splitFace: 'Click the faces or planes to cut with.',
  mirrorPlane: 'Click the plane to mirror in.',
  combineTarget: 'Click the body to keep.',
  combineTools: 'Click the bodies to combine with it.',
  moveBodies: 'Click the bodies to move.',
  movePointFrom: 'Click where to measure from.',
  movePointTo: 'Click where to measure to.',
  movePivot: 'Click the point to turn about.',
  moveDirection: 'Click an edge, a flat face, or an origin plane.',
  embossFaces: 'Click the faces to emboss onto.',
  constructPath: 'Click the curve or edge to measure along.',
  groupFaces: 'Click the faces to group.',
  holdEdges: 'Click the edge the fillet should run out on.',
  jointAxis2: 'Click the edge or face giving the second direction.',
  alignFrom: 'Click the face on the part being moved.',
  alignTo: 'Click the face it should land on.',
  silhouetteDir: 'Click the plane or face to look along.'
};

/** How much the armed row has taken so far, written out beside the prompt. */
function pickCountText(armed, f) {
  if (!f) return '';
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  if (armed === 'profiles') {
    if (f.seeds === null || f.seeds === undefined) return 'whole sketch';
    const total = n(f.seeds) + n(f.faces);
    return total ? `${total} chosen` : 'none yet';
  }
  const row = blendPickRow(armed);
  if (row) {
    const c = n(f.sets?.[row.index]?.[row.list]);
    return c ? `${c} edge${c === 1 ? '' : 's'}` : 'none yet';
  }
  const listFor = {
    sections: f.sections,
    rails: f.rails,
    targets: Array.isArray(f.targets) ? f.targets : null,
    openFaces: f.openFaces,
    draftFaces: f.faces,
    splitFace: f.tools,
    combineTools: f.tools,
    moveBodies: f.bodies
  }[armed];
  if (listFor === undefined) return '';
  const c = n(listFor);
  return c ? `${c} chosen` : 'none yet';
}

/**
 * Sit the callout beside the cursor, inside the viewport. It is flipped rather
 * than clamped near an edge, so it never covers the thing being pointed at.
 */
/**
 * What the callout has to keep off: the arrow, and the value box standing
 * beside it, as one rectangle in the viewport wrapper's coordinates.
 *
 * Both, not just the arrow. Avoiding only the arrow moved the callout to
 * exactly where the box had just been put, which swapped one thing being
 * covered for another.
 */
function pullArrowArea(r) {
  const f = state.pullHandle?.frame;
  let area = null;
  if (f) {
    const len = state.vp.pixelSize() * 95;
    const a = state.vp.worldToScreen(f.origin[0], f.origin[1], f.origin[2]);
    const b = state.vp.worldToScreen(
      f.origin[0] + f.z[0] * len,
      f.origin[1] + f.z[1] * len,
      f.origin[2] + f.z[2] * len
    );
    if (a && b && !a.behind && !b.behind) {
      const m = 16;
      area = {
        x0: Math.min(a.clientX, b.clientX) - r.left - m,
        x1: Math.max(a.clientX, b.clientX) - r.left + m,
        y0: Math.min(a.clientY, b.clientY) - r.top - m,
        y1: Math.max(a.clientY, b.clientY) - r.top + m
      };
    }
  }
  const box = state.pullValueEl?.getBoundingClientRect();
  if (box && box.width) {
    const m = 10;
    const b = {
      x0: box.left - r.left - m,
      x1: box.right - r.left + m,
      y0: box.top - r.top - m,
      y1: box.bottom - r.top + m
    };
    area = area
      ? {
          x0: Math.min(area.x0, b.x0),
          x1: Math.max(area.x1, b.x1),
          y0: Math.min(area.y0, b.y0),
          y1: Math.max(area.y1, b.y1)
        }
      : b;
  }
  return area;
}

/**
 * Put the callout near the cursor, and off the arrow.
 *
 * It follows the pointer, which is right where the arrow is standing, so it
 * covered the arrow completely. It passes clicks through, so the arrow could
 * still be grabbed the whole time, which is worse rather than better: a panel
 * saying "click the profiles to use", sitting on top of the one thing on screen
 * that would have said what to do next.
 */
function placeCallout() {
  const box = $('#pickcallout');
  if (!box || box.classList.contains('hidden')) return;
  const wrap = $('#viewwrap');
  const r = wrap.getBoundingClientRect();
  const p = state.lastPointer || { x: r.left + r.width / 2, y: r.top + 60 };
  const w = box.offsetWidth || 180;
  const h = box.offsetHeight || 62;
  const pad = 8;
  const px = p.x - r.left;
  const py = p.y - r.top;
  const arrow = pullArrowArea(r);

  // Above the cursor first, because below it covers the thing being pointed at,
  // then the other three corners, then out past whichever end of the arrow has
  // the room. The last of these always clears it, so there is always an answer.
  const spots = [
    [px + 18, py - h - 14],
    [px - w - 18, py - h - 14],
    [px + 18, py + 20],
    [px - w - 18, py + 20]
  ];
  if (arrow) {
    spots.push(
      [arrow.x1 + 12, py - h / 2],
      [arrow.x0 - w - 12, py - h / 2],
      [px - w / 2, arrow.y1 + 12],
      [px - w / 2, arrow.y0 - h - 12]
    );
  }

  const inside = ([x, y]) =>
    x >= pad && y >= pad && x + w <= r.width - pad && y + h <= r.height - pad;
  const clear = ([x, y]) =>
    !arrow || x > arrow.x1 || x + w < arrow.x0 || y > arrow.y1 || y + h < arrow.y0;

  const at =
    spots.find((s) => inside(s) && clear(s)) || spots.find(clear) || spots[0];
  box.style.left = `${Math.max(pad, Math.min(at[0], r.width - w - pad))}px`;
  box.style.top = `${Math.max(pad, Math.min(at[1], r.height - h - pad))}px`;
}

function syncPickBar() {
  const bar = $('#pickbar');
  const box = $('#pickcallout');
  if (!bar || !box) return;
  const armed = state.editing?.pickInto;

  if (state.picking) {
    // The standalone pick flow owns its own OK and Cancel, so it keeps the bar.
    $('#pickmsg').textContent = state.picking.prompt || 'Select';
    bar.classList.remove('hidden');
    box.classList.add('hidden');
    return;
  }

  bar.classList.add('hidden');

  if (!armed) {
    box.classList.add('hidden');
    return;
  }

  // While a dialog is waiting to be pointed at, every click in the viewport
  // goes to it. Saying so, next to the cursor rather than off at the top of the
  // window, is the difference between that and the window feeling dead.
  const f = state.editing.feature;
  const blendRow = blendPickRow(armed);
  const key = blendRow ? (blendRow.list === 'edges' ? 'setEdges' : 'holdEdges') : armed;
  $('#pcTitle').textContent = f ? featureLabel(state.doc, f) : 'Select';
  $('#pcMsg').textContent = PICK_PROMPTS[key] || 'Click the edges to use.';
  $('#pcCount').textContent = pickCountText(armed, f);
  box.classList.remove('hidden');
  placeCallout();
}

function startPrimitive(shape) {
  if (state.sketcher.active) finishSketch();
  const feature = {
    id: uid('f'),
    type: 'primitive',
    shape,
    op: state.result?.bodies.length ? 'join' : 'new',
    targets: 'all',
    params: {
      width: '30',
      depth: '30',
      height: '20',
      diameter: '20',
      topDiameter: '0',
      tubeDiameter: '8',
      wall: '2',
      centered: true,
      x: '0',
      y: '0',
      z: '0'
    }
  };

  const common = [
    { key: 'params.x', label: 'Position X', type: 'expr' },
    { key: 'params.y', label: 'Position Y', type: 'expr' },
    { key: 'params.z', label: 'Position Z', type: 'expr' },
    { key: 'params.centered', label: 'Centre on origin', type: 'bool' },
    {
      key: 'op',
      label: 'Operation',
      type: 'select',
      options: [
        ['new', 'New body'],
        ['join', 'Join'],
        ['cut', 'Cut'],
        ['intersect', 'Intersect']
      ]
    }
  ];

  const shapeFields = {
    box: [
      { key: 'params.width', label: 'Width (X)', type: 'expr' },
      { key: 'params.depth', label: 'Depth (Y)', type: 'expr' },
      { key: 'params.height', label: 'Height (Z)', type: 'expr' }
    ],
    cylinder: [
      { key: 'params.diameter', label: 'Diameter', type: 'expr' },
      { key: 'params.height', label: 'Height', type: 'expr' }
    ],
    cone: [
      { key: 'params.diameter', label: 'Base diameter', type: 'expr' },
      { key: 'params.topDiameter', label: 'Top diameter', type: 'expr' },
      { key: 'params.height', label: 'Height', type: 'expr' }
    ],
    torus: [
      { key: 'params.diameter', label: 'Ring diameter', type: 'expr' },
      { key: 'params.tubeDiameter', label: 'Tube diameter', type: 'expr' }
    ],
    pipe: [
      { key: 'params.diameter', label: 'Outside diameter', type: 'expr' },
      { key: 'params.wall', label: 'Wall thickness', type: 'expr' },
      { key: 'params.height', label: 'Height', type: 'expr' }
    ]
  };
  const fields = [
    ...(shapeFields[shape] || [{ key: 'params.diameter', label: 'Diameter', type: 'expr' }]),
    ...common
  ];

  openFeatureEditor(feature, shape.charAt(0).toUpperCase() + shape.slice(1), fields);
}

/** Features whose whole point is the depth they add to a sketch. */
const DEPTH_FEATURES = new Set(['extrude', 'revolve', 'sweep', 'loft', 'hole', 'rib', 'thread']);

/**
 * Turn the view off the sketch plane before building on it.
 *
 * A sketch leaves the camera looking straight down its own normal, which is
 * right for drawing and useless for extruding: the depth goes exactly away from
 * you and the outline on screen does not change at all. The feature works, and
 * looks like it has done nothing.
 */
function turnToSeeDepth(feature) {
  if (!DEPTH_FEATURES.has(feature.type)) return;
  // Once per dialog. Turning again on every pick would fight the pointer.
  if (state.editing?._turned) return;
  const plane = feature.sketch && state.result?.sketchPlanes?.[feature.sketch];
  if (!plane) return;

  const n = new THREE.Vector3(plane.n[0], plane.n[1], plane.n[2]).normalize();
  const view = new THREE.Vector3()
    .subVectors(state.vp.camera.position, state.vp.target)
    .normalize();
  // Within a few degrees of the normal there is nothing to see. Further round
  // than that, leave the view where it was put.
  if (Math.abs(view.dot(n)) < Math.cos((10 * Math.PI) / 180)) return;
  if (state.editing) state.editing._turned = true;
  state.vp.setView(ISO_VIEW);
}

/**
 * Turn the view when an axis points along it, so there is something to see.
 *
 * Same judgement as `turnToSeeDepth` and the same ten degrees, but asked about
 * a direction rather than about a feature, because a face being pulled has no
 * sketch to ask about.
 */
function turnToSeeAxis(axis) {
  const n = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
  const view = new THREE.Vector3()
    .subVectors(state.vp.camera.position, state.vp.target)
    .normalize();
  if (Math.abs(view.dot(n)) < Math.cos((10 * Math.PI) / 180)) return false;
  // At once, not eased into. The press has already happened and the drag is
  // about to be measured against where the arrow lies on screen, so a camera
  // still gliding into place would measure the drag against a view that is no
  // longer there by the time the pointer moves.
  state.vp.setView(ISO_VIEW, false);
  return true;
}

/**
 * Append the feature straight away and rebuild on every edit, so the viewport
 * shows the actual result while the dialog is open. Cancel removes it again.
 */
function openFeatureEditor(feature, title, fields, isExisting = false, opts = {}) {
  if (state.editing) cancelEdit();
  if (state.picking) endPicking(false);

  // The document as it stands before the dialog touches anything. It goes on
  // the undo stack only if the dialog is accepted, so cancelling leaves no
  // trace at all.
  const preEdit = JSON.stringify(state.doc);

  if (!isExisting) {
    if (state.activeComponent && feature.component === undefined) {
      feature.component = state.activeComponent;
    }
    insertFeature(feature);
  }
  state.editing = {
    feature,
    isNew: !isExisting,
    fields,
    title,
    preEdit,
    snapshot: JSON.stringify(feature)
  };

  // A preset marked as the default for this kind of feature is applied to a
  // fresh one, which is the whole point of marking it: the same 0.6 chamfer on
  // every part without typing it. Never to an existing feature being edited,
  // where it would silently overwrite what that feature was built with.
  if (!isExisting && presetTypeOf(feature)) {
    const chosen = PRESET.openingPreset(presetStore(), presetTypeOf(feature));
    if (chosen) {
      PRESET.applyValues(feature, chosen.values);
      state.editing.snapshot = JSON.stringify(feature);
    }
  }

  el.inspectorTitle.textContent = title;
  el.inspector.classList.remove('hidden');
  renderFields();
  rebuildAll();
  // Not while a drag is in hand: turning the camera under a pointer that is
  // pulling something moves the thing being aimed at.
  if (!isExisting && !opts.keepView) turnToSeeDepth(feature);

  if (opts.keepFocus) return;
  const firstInput = el.inspectorBody.querySelector(
    '.field:not(.presetrow) input, .field:not(.presetrow) select'
  );
  if (firstInput) {
    firstInput.focus();
    if (firstInput.select) firstInput.select();
  }
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  const target = parts.reduce((o, k) => (o[k] = o[k] || {}), obj);
  target[last] = value;
}

/* ------------------------------------------------------------------ */
/* Dialog presets                                                      */
/* ------------------------------------------------------------------ */

/*
 * Presets belong to the person, not the part: the point of saving a 0.6 chamfer
 * is that it is there in the next document too. There is no profile to hang
 * them on yet, so they live in the renderer's own storage, which for a desktop
 * application is a file in the user data folder. When profiles arrive they move
 * onto the profile, and this is the one place that has to change.
 */
/**
 * What a preset is filed under.
 *
 * The feature type, except where one type is several dialogs. A primitive is a
 * box or a cylinder or a sphere and they ask for different things, so a box
 * preset has no business appearing in a cylinder dialog. `applyValues` would
 * skip the rows that do not exist anyway, but offering a preset that does
 * nothing is worse than not offering it.
 */
function presetTypeOf(feature) {
  if (!feature?.type) return null;
  return feature.shape ? `${feature.type}:${feature.shape}` : feature.type;
}

function presetStore() {
  if (!state.presets) state.presets = PRESET.loadPresets(window.localStorage);
  return state.presets;
}

function writePresetStore(data) {
  state.presets = data;
  PRESET.savePresets(window.localStorage, data);
}

/**
 * The preset row at the top of a feature dialog.
 *
 * One select and the four things Fusion offers beside it. It is only drawn
 * where there is something to save: a dialog of nothing but pick rows has no
 * settings, and offering to name them would be offering nothing.
 */
function renderPresetRow(feature, fields) {
  const type = presetTypeOf(feature);
  if (!type) return;
  if (!PRESET.presetKeys(fields).length) return;

  const entry = PRESET.presetsFor(presetStore(), type);
  const wrap = document.createElement('div');
  wrap.className = 'field presetrow';

  const label = document.createElement('label');
  label.textContent = 'Preset';
  wrap.appendChild(label);

  const row = document.createElement('div');
  row.className = 'row';

  const sel = document.createElement('select');
  const options = [['', 'Defaults']];
  if (entry.lastUsed) options.push(['__lastUsed', 'Last used']);
  for (const p of entry.saved) {
    options.push([p.name, p.name === entry.default ? `${p.name} (default)` : p.name]);
  }
  for (const [value, text] of options) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  }
  // Nothing is selected in it: the list is a thing to apply, not a record of
  // what the feature currently holds. A feature edited after a preset was
  // applied no longer matches it, and showing the name would say it did.
  sel.value = '';
  sel.addEventListener('change', () => {
    const name = sel.value;
    if (!name) return;
    const chosen =
      name === '__lastUsed'
        ? { name: 'Last used', values: entry.lastUsed }
        : entry.saved.find((p) => p.name === name);
    if (!chosen) return;
    const { applied, skipped } = PRESET.applyValues(feature, chosen.values);
    renderFields();
    rebuildAll();
    setStatus(
      skipped.length
        ? `${chosen.name}: ${applied.length} setting${applied.length === 1 ? '' : 's'} applied, ${skipped.length} this feature does not have.`
        : `${chosen.name} applied.`
    );
  });
  row.appendChild(sel);

  const button = (text, title, run) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', run);
    row.appendChild(b);
  };

  button('Save', 'Save these settings under a name', () => {
    promptText('Name this preset', `${state.editing.title || feature.type}`, (name) => {
      const clean = String(name || '').trim();
      if (!clean) return;
      writePresetStore(
        PRESET.putPreset(
          presetStore(),
          type,
          clean,
          PRESET.captureValues(feature, fields)
        )
      );
      renderFields();
      setStatus(`Saved as ${clean}.`);
    });
  });

  if (entry.saved.length || entry.lastUsed) {
    button('Default', 'Open this kind of dialog with the chosen preset', () => {
      const choices = [['', 'The feature own defaults']];
      if (entry.lastUsed) choices.push(['__lastUsed', 'Last used']);
      for (const p of entry.saved) choices.push([p.name, p.name]);
      promptChoice('Open new ones with', choices, (name) => {
        writePresetStore(PRESET.setDefaultPreset(presetStore(), type, name));
        renderFields();
        setStatus(
          name
            ? `New ${state.editing.title || feature.type} dialogs will open with ${name === '__lastUsed' ? 'the last used values' : name}.`
            : `New ${state.editing.title || feature.type} dialogs will open with their own defaults.`
        );
      });
    });
  }

  if (entry.saved.length) {
    button('Rename', 'Rename a saved preset', () => {
      promptChoice(
        'Rename which preset',
        entry.saved.map((p) => [p.name, p.name]),
        (from) => {
          promptText('New name', from, (to) => {
            const clean = String(to || '').trim();
            if (!clean || clean === from) return;
            writePresetStore(PRESET.renamePreset(presetStore(), type, from, clean));
            renderFields();
          });
        }
      );
    });
    button('Delete', 'Delete a saved preset', () => {
      promptChoice(
        'Delete which preset',
        entry.saved.map((p) => [p.name, p.name]),
        (name) => {
          writePresetStore(PRESET.dropPreset(presetStore(), type, name));
          renderFields();
          setStatus(`${name} deleted.`);
        }
      );
    });
  }

  wrap.appendChild(row);
  el.inspectorBody.appendChild(wrap);
}

function renderFields() {
  const { feature, fields } = state.editing;
  el.inspectorBody.innerHTML = '';
  const scope = resolveParameters(state.doc.parameters).scope;
  renderPresetRow(feature, fields);

  for (const f of fields) {
    if (f.showIf && !f.showIf(feature)) continue;

    const wrap = document.createElement('div');
    wrap.className = f.type === 'bool' ? 'field inline' : 'field';

    const value = f.get ? f.get(feature) : getPath(feature, f.key);
    // A label may be a function of the feature, for the rows whose name depends
    // on a setting above them: a shell's thickness is "Wall thickness" until
    // the wall straddles the surface, and then it is the inside one.
    const labelText = typeof f.label === 'function' ? f.label(feature) : f.label;

    if (f.type === 'action') {
      const btn = document.createElement('button');
      btn.textContent = labelText;
      btn.addEventListener('click', () => {
        f.run(feature);
        // Adding a set changes what rows there are, and the dialog's field list
        // was worked out when it opened, so it has to be worked out again.
        const fresh = describeFeature(feature);
        if (fresh?.fields) state.editing.fields = fresh.fields;
        renderFields();
        scheduleRebuild();
      });
      wrap.appendChild(btn);
      el.inspectorBody.appendChild(wrap);
      continue;
    }

    if (f.type === 'note') {
      const note = document.createElement('div');
      note.className = 'hint';
      note.textContent = f.text;
      el.inspectorBody.appendChild(note);
      continue;
    }

    if (f.type === 'pick') {
      // A row that is filled in by clicking in the viewport. The button arms
      // it; what is already chosen is written beside the label.
      const label = document.createElement('label');
      label.textContent = labelText;
      wrap.appendChild(label);
      const row = document.createElement('div');
      row.className = 'row';
      const summary = document.createElement('span');
      summary.className = 'picksummary';
      summary.textContent = f.summary ? f.summary(feature) : '';
      const btn = document.createElement('button');
      const armed = state.editing.pickInto === f.pick;
      btn.textContent = armed ? 'Picking' : 'Select';
      btn.className = armed ? 'accent' : '';
      btn.addEventListener('click', () => setEditPick(armed ? null : f.pick));
      const clear = document.createElement('button');
      clear.textContent = '\u2715';
      clear.title = 'Clear';
      clear.addEventListener('click', () => {
        if (f.clear) f.clear(feature);
        renderFields();
        scheduleRebuild();
      });
      row.appendChild(summary);
      row.appendChild(btn);
      row.appendChild(clear);
      wrap.appendChild(row);
      el.inspectorBody.appendChild(wrap);
      continue;
    }

    if (f.type === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.addEventListener('change', () => {
        if (f.set) f.set(feature, input.checked);
        else setPath(feature, f.key, input.checked);
        renderFields();
        rebuildAll();
      });
      const label = document.createElement('label');
      label.textContent = labelText;
      wrap.appendChild(input);
      wrap.appendChild(label);
    } else if (f.type === 'select') {
      const label = document.createElement('label');
      label.textContent = labelText;
      wrap.appendChild(label);
      const sel = document.createElement('select');
      for (const [val, text] of f.options) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = text;
        if (String(val) === String(value)) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        if (f.set) f.set(feature, sel.value);
        else setPath(feature, f.key, sel.value);
        // A choice can change what rows there are, and the dialog's field list
        // was worked out when it opened, so it has to be worked out again.
        // Coil asks for two of revolutions, height and pitch, and which two
        // depends on the type sitting right above them.
        const fresh = describeFeature(feature);
        if (fresh?.fields) state.editing.fields = fresh.fields;
        renderFields();
        rebuildAll();
      });
      wrap.appendChild(sel);
    } else if (f.type === 'text') {
      const label = document.createElement('label');
      label.textContent = labelText;
      wrap.appendChild(label);
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value ?? '';
      input.addEventListener('input', () => {
        if (f.set) f.set(feature, input.value);
        else setPath(feature, f.key, input.value);
      });
      wrap.appendChild(input);
    } else {
      const label = document.createElement('label');
      label.textContent = labelText;
      wrap.appendChild(label);
      const row = document.createElement('div');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value ?? '';
      const readout = document.createElement('span');
      readout.className = 'val';

      const refresh = () => {
        try {
          const n = evaluate(input.value, scope);
          readout.textContent = round(n, 3);
          readout.style.color = '';
        } catch (err) {
          readout.textContent = 'error';
          readout.style.color = '#e06c5f';
        }
      };
      refresh();

      input.addEventListener('input', () => {
        if (f.set) f.set(feature, input.value);
        else setPath(feature, f.key, input.value);
        refresh();
        scheduleRebuild();
      });
      // Typing `Width = 50` names the parameter here rather than in the
      // parameters dialog, which is Fusion's best small idea and the one thing
      // in that list worth stealing outright. On commit, not on every
      // keystroke, or typing the name would leave W, Wi and Wid behind it.
      input.addEventListener('change', () => {
        const made = parameterFromField(input.value);
        if (!made) return;
        input.value = made;
        if (f.set) f.set(feature, made);
        else setPath(feature, f.key, made);
        refresh();
        rebuildAll();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commitEdit();
      });
      row.appendChild(input);
      row.appendChild(readout);
      wrap.appendChild(row);
    }

    el.inspectorBody.appendChild(wrap);
  }

  const box = document.createElement('div');
  box.className = 'err-text';
  box.id = 'dialogErr';
  el.inspectorBody.appendChild(box);
  syncDialogError();
}

/**
 * Refresh only the dialog's message, without redrawing the fields.
 *
 * The fields are laid out once when the dialog opens, so a rebuild cannot
 * redraw them without throwing away half-typed text. But the rebuild is what
 * decides whether the feature has a problem, so the message has to be updated
 * separately or a dialog still says "select a profile" after one was picked.
 */
/**
 * The problems worth calling problems.
 *
 * A dialog that has just opened and has not been given its number yet is not a
 * failure, it is a dialog waiting to be finished. Extrude opens with a distance
 * of zero and nothing pointed at, on purpose, so pressing the button used to
 * put "Extrude has nothing to work from" in the browser under Problems, a red
 * exclamation beside it, and "1 problem" in the corner, before anything had
 * been done wrong. The dialog says what it still needs, in its own footer,
 * which is where that belongs. Everywhere else it reads as broken.
 *
 * Only while the dialog is open and only for a feature it is creating. Editing
 * an existing feature into a state that will not build is a real problem, and
 * so is that same feature the moment OK is pressed.
 */
function visibleErrors() {
  const editing = state.editing;
  const pending = editing?.isNew ? editing.feature?.id : null;
  return (state.result?.errors || []).filter((e) => !pending || e.feature !== pending);
}

function syncDialogError() {
  const box = document.getElementById('dialogErr');
  if (!box) return;
  const feature = state.editing?.feature;
  const errs = feature
    ? (state.result?.errors || []).filter((e) => e.feature === feature.id)
    : [];
  box.textContent = errs.length ? errs[0].message : '';
  box.style.display = errs.length ? '' : 'none';
}

/**
 * Put the origin planes back to whatever the View tab asks for.
 *
 * A pick that can take a plane turns them on to be clicked. Closing the dialog
 * is the only moment that knows they are no longer wanted, and without this
 * they stay drawn over the model until the tick box is touched.
 */
function restorePlanes() {
  const box = $('#chkPlanes');
  if (state.vp && box) state.vp.setPlanesVisible(box.checked);
}

/**
 * Point the next viewport click at one of the dialog's fields, or at none.
 * The profile row arms itself when the dialog opens with nothing chosen, which
 * is what lets Extrude be reached for before anything is selected.
 */
function setEditPick(which) {
  if (!state.editing) return;
  state.editing.pickInto = which;
  if (!which) state.hoverProfile = null;
  syncPickBar();
  // Arming or letting go changes which list owns the profile colours.
  renderSketchDisplay();
  state.vp.setPlanesVisible(
    [
      'startObject',
      'toObject',
      'neutral',
      'splitFace',
      'mirrorPlane',
      'alignFrom',
      'alignTo',
      'silhouetteDir',
      'moveDirection'
    ].includes(which)
  );
  renderFields();
  updateHints();
}

/**
 * Fold a viewport click into whichever dialog field is armed. Returns true when
 * it was taken, so ordinary selection does not also happen.
 */
function pickIntoEdit(hit) {
  const ed = state.editing;
  if (!ed || !ed.pickInto) return false;
  const f = ed.feature;

  if (ed.pickInto === 'profiles') {
    if (hit.kind === 'profile') {
      if (f.sketch && f.sketch !== hit.sketch) {
        setStatus('One extrude works from one sketch. Finish this one first.');
        return true;
      }
      f.sketch = hit.sketch;
      if (f.seeds === null) f.seeds = [];
      const at = f.seeds.findIndex((p) => samePoint(p, hit.seed));
      if (at >= 0) f.seeds.splice(at, 1);
      else f.seeds.push(hit.seed);
    } else if (hit.kind === 'face') {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const face = record?.topology?.faces[hit.faceId];
      if (!face || !face.planar) {
        setStatus('That face is curved. An extrude needs a flat one.');
        return true;
      }
      f.faces = f.faces || [];
      const ref = { bodyId: hit.bodyId, face: faceReference(face) };
      const at = f.faces.findIndex((x) => x.bodyId === ref.bodyId && sameFaceRef(x.face, ref.face));
      if (at >= 0) f.faces.splice(at, 1);
      else f.faces.push(ref);
    } else {
      return true;
    }
  } else if (blendPickRow(ed.pickInto)) {
    // An edge into one of a blend's sets, or into that set's hold line.
    if (hit.kind !== 'edge') return true;
    const { list, index } = blendPickRow(ed.pickInto);
    const set = f.sets?.[index];
    if (!set) return true;
    const record = (state.records || []).find((r) => r.id === hit.bodyId);
    const edge = record?.topology?.edges.find((e) => e.id === hit.edgeId);
    if (!edge) return true;
    set[list] = set[list] || [];
    const ref = edgeReference(edge, record.topology);

    // Tangent Chain, on by default the same as Fusion. One click takes the
    // whole run of edges that carry on smoothly from the one picked, which on
    // any part that is not all flats is the difference between one click and
    // thirty. A hold line is exempt: it is a single edge by definition.
    const chained =
      list === 'edges' && set.tangentChain !== false
        ? SEL.tangentEdgeRun(record.topology, [edge.id])
        : [edge.id];
    const refs = chained
      .map((id) => record.topology.edges.find((e) => e.id === id))
      .filter(Boolean)
      .map((e) => edgeReference(e, record.topology));

    // Clicking an edge that is already in takes its whole run back out, so the
    // gesture still undoes itself the way one edge always did.
    if (set[list].some((x) => sameEdgeRef(x, ref))) {
      set[list] = set[list].filter((x) => !refs.some((r) => sameEdgeRef(x, r)));
    } else {
      for (const r of refs) {
        if (!set[list].some((x) => sameEdgeRef(x, r))) set[list].push(r);
      }
    }
    if (!f.bodies || f.bodies === 'all') f.bodies = [hit.bodyId];
  } else if (ed.pickInto === 'embossFaces') {
    // A face reference here carries its body, because an emboss can put the
    // same profile onto faces of more than one body in a single feature.
    if (hit.kind !== 'face' || hit.faceId === null) return true;
    const record = (state.records || []).find((r) => r.id === hit.bodyId);
    const face = record?.topology?.faces[hit.faceId];
    if (!face) return true;
    if (!face.planar && !face.cylinder) {
      setStatus('Emboss works on a flat or a cylindrical face.');
      return true;
    }
    f.faces = f.faces || [];
    const ref = { bodyId: hit.bodyId, face: faceReference(face) };
    const at = f.faces.findIndex(
      (x) => x.bodyId === ref.bodyId && sameFaceRef(x.face, ref.face)
    );
    if (at >= 0) f.faces.splice(at, 1);
    else f.faces.push(ref);
  } else if (
    ed.pickInto === 'alignFrom' ||
    ed.pickInto === 'alignTo' ||
    ed.pickInto === 'silhouetteDir'
  ) {
    const key = ed.pickInto === 'alignFrom' ? 'from' : ed.pickInto === 'alignTo' ? 'to' : 'direction';
    if (hit.kind === 'plane') {
      f[key] = { plane: hit.planeName };
    } else if (hit.kind === 'face' && hit.faceId !== null) {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const face = record?.topology?.faces[hit.faceId];
      if (!face || !face.planar) {
        setStatus('That has to be a flat face or an origin plane.');
        return true;
      }
      f[key] = { bodyId: hit.bodyId, face: faceReference(face) };
    } else {
      return true;
    }
    // One face is all these rows take, so let go rather than swallowing the
    // next click as well.
    ed.pickInto = ed.pickInto === 'alignFrom' ? 'alignTo' : null;
    state.vp.setPlanesVisible(
      ed.pickInto ? true : $('#chkPlanes').checked
    );
  } else if (ed.pickInto === 'jointAxis2') {
    // The direction a pin slot slides along, or the one a planar joint runs in,
    // taken from an edge or a face rather than typed as three numbers.
    const j = state.editingJoint;
    if (!j?.origin) return true;
    if (hit.kind === 'edge') {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const edge = record?.topology?.edges.find((e) => e.id === hit.edgeId);
      if (edge?.kind === 'line') j.origin.axis2 = [...edge.dir];
      else if (edge?.axis) j.origin.axis2 = [...edge.axis];
      else return true;
    } else if (hit.kind === 'face' && hit.faceId !== null) {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const face = record?.topology?.faces[hit.faceId];
      if (!face) return true;
      j.origin.axis2 = face.planar ? [...face.normal] : [...face.cylinder.dir];
    } else {
      return true;
    }
    ed.pickInto = null;
  } else if (ed.pickInto === 'plasticFace') {
    if (hit.kind !== 'face' || hit.faceId === null) return true;
    const record = (state.records || []).find((r) => r.id === hit.bodyId);
    const face = record?.topology?.faces[hit.faceId];
    if (!face) return true;
    f.face = faceReference(face, record.topology);
    ed.pickInto = null;
  } else if (ed.pickInto === 'constructEdgeA' || ed.pickInto === 'constructEdgeB') {
    if (hit.kind !== 'edge') return true;
    const record = (state.records || []).find((r) => r.id === hit.bodyId);
    const edge = record?.topology?.edges.find((e) => e.id === hit.edgeId);
    if (!edge) return true;
    const which = ed.pickInto === 'constructEdgeA' ? 'edgeA' : 'edgeB';
    f.entry[which] = edgeReference(edge, record.topology);
    ed.pickInto = null;
  } else if (ed.pickInto === 'constructPath') {
    // A sketch curve or a model edge; both come back as a run of points when
    // the construction is resolved.
    if (hit.kind === 'sketchLine') {
      f.entry.path = { sketch: hit.sketch };
    } else if (hit.kind === 'edge') {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const edge = record?.topology?.edges.find((e) => e.id === hit.edgeId);
      if (!edge) return true;
      f.entry.path = { edge: edgeReference(edge, record.topology) };
    } else {
      return true;
    }
    ed.pickInto = null;
  } else if (ed.pickInto === 'openFaces' || ed.pickInto === 'draftFaces') {
    if (hit.kind !== 'face' || hit.faceId === null) return true;
    const record = (state.records || []).find((r) => r.id === hit.bodyId);
    const face = record?.topology?.faces[hit.faceId];
    if (!face) return true;
    const key = ed.pickInto === 'openFaces' ? 'openFaces' : 'faces';
    // A draft leans a flat face about the line where it meets the neutral
    // plane, and a curved one has no such line. It used to be taken anyway and
    // then skipped without a word, so the face sat in the list looking chosen
    // and nothing about the part changed. A shell can open any face at all, so
    // this is the draft's rule alone.
    if (key === 'faces' && !face.planar) {
      setStatus('That face is curved. A draft needs a flat one.');
      return true;
    }
    f[key] = f[key] || [];

    // Tangent Chain, which both of these have in Fusion. A wall is one wall by
    // eye and several faces in the topology once its corners have been
    // rounded, and picking them one at a time is the work this saves.
    //
    // For a draft the run is cut back to the flats, for the same reason a
    // curved face is refused above: what is in the list is what will lean. A
    // shell keeps the curves, because opening a rounded face is a perfectly
    // ordinary thing to want.
    const chained =
      f.tangentChain === false
        ? [hit.faceId]
        : key === 'faces'
          ? SEL.tangentRun(record.topology, [hit.faceId]).filter(
              (i) => record.topology.faces[i]?.planar
            )
          : SEL.tangentRun(record.topology, [hit.faceId]);
    const refs = chained
      .map((i) => record.topology.faces[i])
      .filter(Boolean)
      .map((x) => faceReference(x));

    const ref = faceReference(face);
    if (f[key].some((x) => sameFaceRef(x, ref))) {
      f[key] = f[key].filter((x) => !refs.some((r) => sameFaceRef(x, r)));
    } else {
      for (const r of refs) {
        if (!f[key].some((x) => sameFaceRef(x, r))) f[key].push(r);
      }
    }
    if (!f.bodies || f.bodies === 'all') f.bodies = [hit.bodyId];
  } else if (ed.pickInto === 'groupFaces') {
    // Any face at all, curved included: a face group is whatever was pointed
    // at, which is the whole reason for setting one by hand.
    if (hit.kind !== 'face' || hit.faceId === null) return true;
    const record = (state.records || []).find((r) => r.id === hit.bodyId);
    const face = record?.topology?.faces[hit.faceId];
    if (!face) return true;
    f.faces = f.faces || [];
    const ref = { bodyId: hit.bodyId, face: faceReference(face) };
    const at = f.faces.findIndex(
      (x) => x.bodyId === ref.bodyId && sameFaceRef(x.face, ref.face)
    );
    if (at >= 0) f.faces.splice(at, 1);
    else f.faces.push(ref);
    if (!f.bodies || f.bodies === 'all') f.bodies = [hit.bodyId];
  } else if (ed.pickInto === 'neutral') {
    if (hit.kind === 'plane') {
      f.neutral = hit.planeName;
      f.neutralRef = { plane: hit.planeName };
    } else if (hit.kind === 'face' && hit.faceId !== null) {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const face = record?.topology?.faces[hit.faceId];
      if (!face || !face.planar) {
        setStatus('A neutral plane has to be a flat face or an origin plane.');
        return true;
      }
      f.neutral = { face: faceReference(face) };
      f.neutralRef = { bodyId: hit.bodyId, face: faceReference(face) };
    } else {
      return true;
    }
    ed.pickInto = null;
    state.vp.setPlanesVisible($('#chkPlanes').checked);
  } else if (ed.pickInto === 'sections') {
    // Order matters for a loft, so sections are appended as they are clicked.
    f.sections = f.sections || [];
    let entry = null;
    if (hit.kind === 'profile') entry = { sketch: hit.sketch, seed: hit.seed };
    else if (hit.kind === 'sketchPoint') entry = { sketch: hit.sketch, point: hit.point };
    else if (hit.kind === 'face') {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const face = record?.topology?.faces[hit.faceId];
      if (!face || !face.planar) {
        setStatus('A loft section has to be a flat face, a profile, or a point.');
        return true;
      }
      entry = { face: { bodyId: hit.bodyId, face: faceReference(face) } };
    } else {
      return true;
    }
    const at = f.sections.findIndex((x) => sameSection(x, entry));
    if (at >= 0) f.sections.splice(at, 1);
    else f.sections.push(entry);
    // A loft grows a "move this one earlier" row per section past the first, so
    // picking one changes what rows there are and not only what they say. The
    // field list was worked out when the dialog opened. Done here rather than
    // for every pick because a dialog opened with a hand built list would have
    // its rows swapped out from under it.
    if (f.type === 'loft') state.editing.fields = loftFields(f);
  } else if (ed.pickInto === 'path' || ed.pickInto === 'rail') {
    const key = ed.pickInto;
    if (hit.kind === 'sketchLine') f[key] = { sketch: hit.sketch };
    else if (hit.kind === 'edge') {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const edge = record?.topology?.edges.find((e) => e.id === hit.edgeId);
      if (!edge) return true;
      const was = f[key]?.edges || [];
      f[key] = { edges: [...was, edgeReference(edge, record.topology)] };
      renderFields();
      scheduleRebuild();
      return true;
    } else {
      return true;
    }
    ed.pickInto = null;
  } else if (ed.pickInto === 'rails') {
    if (hit.kind !== 'sketchLine') return true;
    f.rails = f.rails || [];
    const at = f.rails.findIndex((r) => r.sketch === hit.sketch);
    if (at >= 0) f.rails.splice(at, 1);
    else f.rails.push({ sketch: hit.sketch });
  } else if (ed.pickInto === 'axis') {
    if (hit.kind === 'sketchLine') {
      f.axis = { type: 'entity', entity: hit.entity };
      if (!f.sketch) f.sketch = hit.sketch;
    } else if (hit.kind === 'edge') {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const edge = record?.topology?.edges.find((e) => e.id === hit.edgeId);
      if (!edge || edge.kind !== 'line') {
        setStatus('An axis has to be a straight edge.');
        return true;
      }
      f.axis = { type: 'edge', edge: edgeReference(edge, record.topology) };
    } else {
      return true;
    }
    ed.pickInto = null;
  } else if (ed.pickInto === 'startObject' || ed.pickInto === 'toObject') {
    const key = ed.pickInto;
    if (hit.kind === 'plane') f[key] = { plane: hit.planeName };
    else if (hit.kind === 'face') {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const face = record?.topology?.faces[hit.faceId];
      if (!face) return true;
      f[key] = { bodyId: hit.bodyId, face: faceReference(face) };
    } else if (hit.bodyId) {
      f[key] = { bodyId: hit.bodyId };
    } else {
      return true;
    }
    // One object is all it needs, so put the pointer back to normal.
    ed.pickInto = null;
    state.vp.setPlanesVisible($('#chkPlanes').checked);
  } else if (ed.pickInto === 'moveBodies') {
    if (!hit.bodyId) return true;
    if (!Array.isArray(f.bodies)) f.bodies = [];
    const at = f.bodies.indexOf(hit.bodyId);
    if (at >= 0) f.bodies.splice(at, 1);
    else f.bodies.push(hit.bodyId);
    if (!f.bodies.length) f.bodies = 'all';
  } else if (ed.pickInto === 'moveDirection') {
    // An edge lies along its own direction; a flat face gives the way it
    // faces. Anything else has no one direction to mean.
    const record = (state.records || []).find((r) => r.id === hit.bodyId);
    if (hit.kind === 'edge') {
      const edge = record?.topology?.edges.find((e) => e.id === hit.edgeId);
      if (!edge?.dir) {
        setStatus('That edge is curved, so it does not point one way.');
        return true;
      }
      f.direction = [...edge.dir];
      f.directionLabel = 'Along a model edge';
    } else if (hit.kind === 'face' && hit.faceId !== null) {
      const face = record?.topology?.faces[hit.faceId];
      if (!face?.planar) {
        setStatus('That face is curved, so it does not face one way.');
        return true;
      }
      f.direction = [...face.normal];
      f.directionLabel = 'Out from a flat face';
    } else if (hit.kind === 'plane') {
      const n = planeNormal(hit.planeName);
      if (!n) return true;
      f.direction = n;
      f.directionLabel = `Along the ${hit.planeName} normal`;
    } else {
      return true;
    }
    ed.pickInto = null;
    restorePlanes();
    setStatus(`${f.directionLabel}: ${f.direction.map((n) => round(n, 3)).join(', ')}.`);
  } else if (
    ed.pickInto === 'movePointFrom' ||
    ed.pickInto === 'movePointTo' ||
    ed.pickInto === 'movePivot'
  ) {
    // A corner, the middle of an edge, or the centre of a hole, in that order
    // of preference, because those are the places somebody means. The middle of
    // a face and the bare spot the ray landed on are what is left when none of
    // them is near, and they used to be the only two answers there were.
    const key =
      ed.pickInto === 'movePointFrom'
        ? 'fromPoint'
        : ed.pickInto === 'movePointTo'
          ? 'toPoint'
          : 'pivot';
    const p = state.lastPointer;
    const snap = p ? snapModelPoint(p.x, p.y) : null;
    let at = snap ? [...snap.at] : null;
    if (!at && hit.kind === 'face' && hit.faceId !== null) {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const face = record?.topology?.faces[hit.faceId];
      if (face) at = [...face.centre];
    }
    if (!at && hit.point) at = [hit.point.x, hit.point.y, hit.point.z];
    if (!at) return true;
    f[key] = at;
    ed.pickInto = null;
    setStatus(`Took the ${(snap?.label || 'point on the face').toLowerCase()} at ${at.map((n) => round(n, 2)).join(', ')}.`);
  } else if (ed.pickInto === 'splitFace' || ed.pickInto === 'mirrorPlane') {
    // A split takes a list of tools; a mirror takes one plane. Both arrive
    // here because both are pointing at a flat thing.
    const many = ed.pickInto === 'splitFace';
    let tool = null;
    if (hit.kind === 'plane') {
      tool = { plane: hit.planeName };
    } else if (hit.kind === 'face' && hit.faceId !== null) {
      const record = (state.records || []).find((r) => r.id === hit.bodyId);
      const face = record?.topology?.faces[hit.faceId];
      if (!face || !face.planar) {
        setStatus('That has to be a flat face or an origin plane.');
        return true;
      }
      tool = { bodyId: hit.bodyId, face: faceReference(face) };
    } else {
      return true;
    }

    if (many) {
      f.tools = f.tools || [];
      // Clicking one that is already in takes it out again, the same as every
      // other list this dialog fills.
      const at = f.tools.findIndex((x) =>
        x.plane && tool.plane
          ? String(optionForPlane(x.plane)) === String(optionForPlane(tool.plane))
          : !!x.face && !!tool.face && x.bodyId === tool.bodyId && sameFaceRef(x.face, tool.face)
      );
      if (at >= 0) f.tools.splice(at, 1);
      else f.tools.push(tool);
      // The row set grows a "remove this one" per tool, so the list has to be
      // worked out again rather than only redrawn.
      state.editing.fields = splitFields(f);
      // Stays armed: several tools is the point, and letting go after the
      // first would mean re-arming the row for every one after it.
      renderFields();
      syncPickBar();
      scheduleRebuild();
      return true;
    }

    f.planeRef = tool.plane ? { plane: tool.plane } : tool;
    f.plane = tool.plane ? tool.plane : { face: tool.face };
    ed.pickInto = null;
    state.vp.setPlanesVisible($('#chkPlanes').checked);
  } else if (ed.pickInto === 'combineTarget') {
    if (!hit.bodyId) return true;
    f.target = hit.bodyId;
    ed.pickInto = null;
  } else if (ed.pickInto === 'combineTools') {
    if (!hit.bodyId) return true;
    f.tools = f.tools || [];
    const at = f.tools.indexOf(hit.bodyId);
    if (at >= 0) f.tools.splice(at, 1);
    else f.tools.push(hit.bodyId);
  } else if (ed.pickInto === 'sheetEdges') {
    if (hit.kind !== 'edge' || hit.edgeId === null || hit.edgeId === undefined) return true;
    const rec = (state.records || []).find((r) => r.id === hit.bodyId);
    const edge = rec?.topology?.edges[hit.edgeId];
    if (!edge) return true;
    f.edges = f.edges || [];
    const ref = edgeReference(edge, rec.topology);
    const at = f.edges.findIndex(
      (e) => e.mid && ref.mid && Math.hypot(
        e.mid[0] - ref.mid[0], e.mid[1] - ref.mid[1], e.mid[2] - ref.mid[2]
      ) < 1e-6
    );
    if (at >= 0) f.edges.splice(at, 1);
    else f.edges.push(ref);
    // The part the edge belongs to is the part being worked on.
    if (!Array.isArray(f.bodies) || !f.bodies.includes(hit.bodyId)) {
      f.bodies = [hit.bodyId];
    }
  } else if (ed.pickInto === 'surfaceCurves') {
    if (hit.kind !== 'edge' || hit.edgeId === null || hit.edgeId === undefined) return true;
    const rec = (state.records || []).find((r) => r.id === hit.bodyId);
    const edge = rec?.topology?.edges[hit.edgeId];
    if (!edge) return true;
    f.edges = f.edges || [];
    // A second click on the same edge takes it back out again.
    const ref = edgeReference(edge, rec.topology);
    const at = f.edges.findIndex(
      (e) => e.mid && ref.mid && Math.hypot(
        e.mid[0] - ref.mid[0], e.mid[1] - ref.mid[1], e.mid[2] - ref.mid[2]
      ) < 1e-6
    );
    if (at >= 0) f.edges.splice(at, 1);
    else f.edges.push(ref);
    f.sketch = null;
  } else if (
    ed.pickInto === 'surfaceBodies' ||
    ed.pickInto === 'surfaceCutters' ||
    ed.pickInto === 'fillTools'
  ) {
    if (!hit.bodyId) return true;
    const key =
      ed.pickInto === 'surfaceBodies'
        ? 'surfaces'
        : ed.pickInto === 'surfaceCutters'
          ? 'cutters'
          : 'tools';
    f[key] = f[key] || [];
    const at = f[key].indexOf(hit.bodyId);
    if (at >= 0) f[key].splice(at, 1);
    else f[key].push(hit.bodyId);
  } else if (ed.pickInto === 'trimKeep') {
    if (!hit.point) return true;
    f.keep = [hit.point.x, hit.point.y, hit.point.z];
    ed.pickInto = null;
  } else if (ed.pickInto === 'eraseFaces') {
    if (hit.kind !== 'face' || hit.faceId === null) return true;
    const rec = (state.records || []).find((r) => r.id === hit.bodyId);
    const face = rec?.topology?.faces[hit.faceId];
    if (!face) return true;
    f.faces = f.faces || [];
    const key = `${hit.bodyId}:${face.id}`;
    // Clicking a face a second time takes it back out of the list, which on a
    // scan matters: picking the wrong lump is the normal case.
    const at = f.faces.findIndex((x) => `${x.bodyId}:${x.face?.id}` === key);
    if (at >= 0) f.faces.splice(at, 1);
    else f.faces.push({ bodyId: hit.bodyId, face: faceReference(face) });
  } else if (ed.pickInto === 'offsetFaces' || ed.pickInto === 'replaceFaces') {
    if (hit.kind !== 'face' || hit.faceId === null) return true;
    const rec = (state.records || []).find((r) => r.id === hit.bodyId);
    const face = rec?.topology?.faces[hit.faceId];
    if (!face) return true;
    f.faces = f.faces || [];
    f.faces.push({ bodyId: hit.bodyId, face: faceReference(face) });
  } else if (ed.pickInto === 'targets') {
    if (!hit.bodyId) return true;
    if (!Array.isArray(f.targets)) f.targets = [];
    const at = f.targets.indexOf(hit.bodyId);
    if (at >= 0) f.targets.splice(at, 1);
    else f.targets.push(hit.bodyId);
    if (!f.targets.length) f.targets = 'all';
  }

  renderFields();
  // The callout carries a running count, so it has to be redrawn on every pick.
  syncPickBar();
  // Straight away rather than on the debounced rebuild, so the region answers
  // the click at the moment it is clicked.
  renderSketchDisplay();
  scheduleRebuild();
  // Now that there is a sketch to measure against, get far enough round it to
  // see what the feature is going to build.
  turnToSeeDepth(f);
  return true;
}

/**
 * Two seed points are the same profile. A seed is `{x, y}` in sketch space,
 * which is what `interiorPoint` returns; comparing it as `[0]`/`[1]` yields
 * NaN, and NaN < tol is false, so every click read as a fresh profile and a
 * second click on one added it again instead of letting it go.
 */
function samePoint(a, b) {
  if (!a || !b) return false;
  const ax = Array.isArray(a) ? a[0] : a.x;
  const ay = Array.isArray(a) ? a[1] : a.y;
  const bx = Array.isArray(b) ? b[0] : b.x;
  const by = Array.isArray(b) ? b[1] : b.y;
  if (![ax, ay, bx, by].every(Number.isFinite)) return false;
  return Math.hypot(ax - bx, ay - by) < 1e-6;
}

/**
 * Two loft sections are the same pick. A section is a profile `{sketch, seed}`,
 * a sketch point `{sketch, point}`, or a planar face `{face:{bodyId, face}}`,
 * and the three do not compare the same way. Running them all through
 * `samePoint` returned false for points and faces, so clicking a section twice
 * listed it twice instead of taking it back off.
 */
function sameSection(a, b) {
  if (!a || !b) return false;
  if (a.face || b.face) {
    if (!a.face || !b.face) return false;
    return a.face.bodyId === b.face.bodyId && sameFaceRef(a.face.face, b.face.face);
  }
  if (a.sketch !== b.sketch) return false;
  if (a.point !== undefined || b.point !== undefined) return a.point === b.point;
  return samePoint(a.seed, b.seed);
}

function sameEdgeRef(a, b) {
  if (!a || !b) return false;
  return (
    Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) < 1e-6 &&
    Math.abs((a.length ?? 0) - (b.length ?? 0)) < 1e-4
  );
}

function sameFaceRef(a, b) {
  if (!a || !b) return false;
  return (
    Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) < 1e-6 &&
    Math.abs(a.area - b.area) < 1e-4
  );
}

let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuildAll(), 90);
}

function commitEdit() {
  if (!state.editing) return;
  hidePullValue();
  state.hoverProfile = null;
  restorePlanes();
  const { preEdit, title, feature } = state.editing;

  // A sketch that has been built on gets out of the way, the same as Fusion
  // turning off a consumed sketch. It stays in the browser to switch back on.
  if (feature?.sketch) state.hiddenSketches.add(feature.sketch);

  // What this dialog was left set to, so it can be offered back as "last used"
  // in the preset list. Offered, not applied: see openingPreset.
  if (presetTypeOf(feature) && state.editing.fields) {
    writePresetStore(
      PRESET.rememberLastUsed(
        presetStore(),
        presetTypeOf(feature),
        PRESET.captureValues(feature, state.editing.fields)
      )
    );
  }

  state.undo.push({ snapshot: preEdit, label: (title || 'feature').toLowerCase() });
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  state.redo.length = 0;
  state.editing = null;
  el.inspector.classList.add('hidden');
  // The callout that says which dialog is waiting to be pointed at belongs to
  // that dialog. Cancel took it down and OK did not, so accepting an extrude
  // left "EXTRUDE, click the profiles to use" floating by the pointer with no
  // dialog behind it for the rest of the session.
  syncPickBar();
  // What the feature was made from has been used. Leaving it selected leaves
  // the arrow and its box standing on it, offering to do the same thing again,
  // over the thing that was just built.
  clearGeometrySelection();
  state.dirty = true;
  rebuildAll();
  bakeIfDirectModelling();
  setStatus('Feature applied.');
}

function cancelEdit() {
  if (!state.editing) return;
  // The pull box belongs to the edit that opened it, however that edit ends.
  hidePullValue();
  state.hoverProfile = null;
  restorePlanes();
  const { feature, isNew } = state.editing;

  // A joint is added to the document before its dialog opens, so backing out
  // has to remove it again.
  if (feature?.type === 'jointEdit') {
    state.doc.joints = state.doc.joints.filter((j) => j.id !== feature.joint);
    state.editingJoint = null;
    state.editing = null;
    el.inspector.classList.add('hidden');
    syncPickBar();
    rebuildAll();
    return;
  }
  if (isNew) {
    state.doc.features = state.doc.features.filter((f) => f.id !== feature.id);
  } else {
    const restored = JSON.parse(state.editing.snapshot);
    const i = state.doc.features.findIndex((f) => f.id === feature.id);
    if (i >= 0) state.doc.features[i] = restored;
  }
  state.editing = null;
  el.inspector.classList.add('hidden');
  syncPickBar();
  rebuildAll();
}

function editFeature(feature) {
  if (feature.type === 'sketch') {
    exitSketch();
    enterSketch(feature);
    return;
  }
  const rebuilt = describeFeature(feature);
  if (!rebuilt) {
    setStatus('That feature has no editable settings.');
    return;
  }
  openFeatureEditor(feature, rebuilt.title, rebuilt.fields, true);
}

/* ---------------------------------------------------------------- */
/* Surfaces                                                          */
/* ---------------------------------------------------------------- */

/**
 * What a surface command builds from: the sketch in hand, or the edges picked.
 *
 * Surfaces are made off curves rather than off closed profiles, so the source
 * is a set of runs and not a set of regions. An open curve is a perfectly good
 * one, which is the difference between this and the solid commands.
 */
function surfaceSource() {
  const sketch = activeSketchId();
  const edges = [...selectedEdgeRefs().values()].flat();
  return { sketch: sketch || null, edges };
}

/** Every surface body in the model, newest first. */
function surfaceBodies() {
  return (state.records || []).filter((r) => r.sheet);
}

/** A count of what is in a list, for a dialog's summary line. */
function countOf(list, noun) {
  const n = list?.length || 0;
  return n ? `${n} ${noun}${n === 1 ? '' : 's'}` : 'none yet';
}

/** The curves a surface feature works from, as a dialog field. */
function curveField() {
  return {
    key: '__curves',
    label: 'Curves',
    type: 'pick',
    pick: 'surfaceCurves',
    summary: (f) =>
      f.sketch && !f.edges?.length
        ? 'the sketch'
        : countOf(f.edges, 'edge'),
    clear: (f) => {
      f.edges = [];
    }
  };
}

/** The surfaces a modify command works on, as a dialog field. */
function surfaceField(label = 'Surfaces') {
  return {
    key: '__surfaces',
    label,
    type: 'pick',
    pick: 'surfaceBodies',
    summary: (f) => (f.surfaces?.length ? countOf(f.surfaces, 'surface') : 'every surface'),
    clear: (f) => {
      f.surfaces = [];
    }
  };
}

/** Open a surface feature's dialog, having checked there is anything to build from. */
function startSurface(type, title, fields, extra = {}) {
  if (state.sketcher.active) finishSketch();
  const src = surfaceSource();
  if (!src.sketch && !src.edges.length && !extra.__noCurves) {
    setStatus('Select a sketch in the browser, or pick model edges, first.');
    return;
  }
  const feature = {
    id: uid('f'),
    type,
    sketch: src.sketch,
    edges: src.edges,
    ...extra
  };
  delete feature.__noCurves;
  openFeatureEditor(feature, title, fields);
}

function cmdSurfaceExtrude() {
  startSurface('surfaceExtrude', 'Extrude Surface', surfaceExtrudeFields(), {
    distance: '10',
    direction: 'one'
  });
}

function cmdSurfaceRevolve() {
  startSurface('surfaceRevolve', 'Revolve Surface', surfaceRevolveFields(), {
    axis: { type: 'y' },
    angle: '360'
  });
}

function cmdSurfaceSweep() {
  const sketches = Object.values(state.doc.sketches || {});
  if (sketches.length < 2) {
    setStatus('A swept surface needs one sketch for the section and another for the path.');
    return;
  }
  startSurface('surfaceSweep', 'Sweep Surface', surfaceSweepFields(), {
    path: { sketch: null },
    twist: '0'
  });
}

function cmdSurfaceLoft() {
  if (state.sketcher.active) finishSketch();
  const sketches = Object.values(state.doc.sketches || {});
  if (sketches.length < 2) {
    setStatus('A lofted surface needs at least two sketches.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'surfaceLoft',
    sections: sketches.slice(0, 2).map((sk) => ({ sketch: sk.id })),
    closed: false
  };
  openFeatureEditor(feature, 'Loft Surface', surfaceLoftFields(feature));
}

function cmdPatch() {
  if (state.sketcher.active) finishSketch();
  const src = surfaceSource();
  const sheets = surfaceBodies();
  if (!src.sketch && !src.edges.length && !sheets.length) {
    setStatus('Patch fills a closed boundary. Pick edges, a sketch, or a surface with an open edge.');
    return;
  }
  // Whichever surfaces are selected, and only those. Falling back to every
  // surface in the model would patch the rim of each one in turn, which is
  // almost never what was meant.
  const chosen = sheets.filter((s) => state.selection.bodies.has(s.id));
  const feature = {
    id: uid('f'),
    type: 'patch',
    sketch: src.edges.length ? null : src.sketch,
    edges: src.edges,
    surfaces: (chosen.length ? chosen : src.sketch || src.edges.length ? [] : sheets).map(
      (s) => s.id
    ),
    together: false
  };
  openFeatureEditor(feature, 'Patch', patchFields());
}

function cmdRuled() {
  startSurface('ruled', 'Ruled Surface', ruledFields(), {
    distance: '10',
    alignment: 'between',
    dir: [0, 0, 1]
  });
}

function cmdOffsetSurface() {
  if (state.sketcher.active) finishSketch();
  const faces = [];
  for (const [bodyId, refs] of selectedFaceRefs()) {
    for (const ref of refs) faces.push({ bodyId, face: ref });
  }
  const sheets = surfaceBodies();
  if (!faces.length && !sheets.length) {
    setStatus('Offset works off faces or a surface. Select some faces first.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'offsetSurface',
    faces,
    surfaces: faces.length ? [] : sheets.map((s) => s.id),
    distance: '2'
  };
  openFeatureEditor(feature, 'Offset Surface', offsetSurfaceFields());
}

function cmdTrimSurface() {
  if (state.sketcher.active) finishSketch();
  const sheets = surfaceBodies();
  if (sheets.length < 2) {
    setStatus('Trim needs a surface to cut and another to cut it with.');
    return;
  }
  const chosen = sheets.filter((s) => state.selection.bodies.has(s.id));
  const target = chosen[0] || sheets[0];
  const feature = {
    id: uid('f'),
    type: 'trimSurface',
    surfaces: [target.id],
    cutters: sheets.filter((s) => s.id !== target.id).map((s) => s.id),
    keep: null
  };
  openFeatureEditor(feature, 'Trim Surface', trimSurfaceFields());
  setEditPick('trimKeep');
  setStatus('Click the piece of the surface to keep.');
}

function cmdExtendSurface() {
  if (state.sketcher.active) finishSketch();
  if (!surfaceBodies().length) {
    setStatus('Extend needs a surface.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'extendSurface',
    surfaces: pickedSurfaceIds(),
    distance: '5'
  };
  openFeatureEditor(feature, 'Extend Surface', extendSurfaceFields());
}

function cmdUntrimSurface() {
  if (state.sketcher.active) finishSketch();
  if (!surfaceBodies().length) {
    setStatus('Untrim needs a surface.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'untrimSurface',
    surfaces: pickedSurfaceIds(),
    outer: true,
    margin: '0'
  };
  openFeatureEditor(feature, 'Untrim Surface', untrimSurfaceFields());
}

function cmdMergeSurface() {
  if (state.sketcher.active) finishSketch();
  if (surfaceBodies().length < 2) {
    setStatus('Merge needs two or more surfaces.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'mergeSurface',
    surfaces: pickedSurfaceIds(),
    tolerance: '0.01'
  };
  openFeatureEditor(feature, 'Merge Surfaces', mergeSurfaceFields());
}

function cmdStitch() {
  if (state.sketcher.active) finishSketch();
  const sheets = surfaceBodies();
  if (!sheets.length) {
    setStatus('Stitch joins surfaces. There are none yet.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'stitch',
    surfaces: pickedSurfaceIds(),
    tolerance: '0.01'
  };
  openFeatureEditor(feature, 'Stitch', stitchFields());
}

function cmdUnstitch() {
  if (state.sketcher.active) finishSketch();
  if (!state.result?.bodies.length) {
    setStatus('There is nothing to unstitch yet.');
    return;
  }
  const chosen = [...state.selection.bodies];
  const feature = {
    id: uid('f'),
    type: 'unstitch',
    bodies: chosen.length ? chosen : 'all'
  };
  openFeatureEditor(feature, 'Unstitch', unstitchFields());
}

function cmdReverseNormal() {
  if (state.sketcher.active) finishSketch();
  if (!surfaceBodies().length) {
    setStatus('Reverse Normal works on a surface.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'reverseNormal',
    surfaces: pickedSurfaceIds()
  };
  openFeatureEditor(feature, 'Reverse Normal', [surfaceField()]);
}

function cmdThicken() {
  if (state.sketcher.active) finishSketch();
  if (!surfaceBodies().length) {
    setStatus('Thicken turns a surface into a solid. There are none yet.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'thicken',
    surfaces: pickedSurfaceIds(),
    distance: '2',
    symmetric: false,
    keepSurface: false
  };
  openFeatureEditor(feature, 'Thicken', thickenFields());
}

/** Whichever surfaces are selected, or all of them. */
function pickedSurfaceIds() {
  const sheets = surfaceBodies();
  const chosen = sheets.filter((s) => state.selection.bodies.has(s.id));
  return (chosen.length ? chosen : sheets).map((s) => s.id);
}

function cmdBoundaryFill() {
  if (state.sketcher.active) finishSketch();
  const solids = (state.records || []).filter((r) => !r.sheet);
  const sheets = surfaceBodies();
  if (!solids.length) {
    setStatus('Boundary Fill divides solid bodies. There are none yet.');
    return;
  }
  if (!sheets.length) {
    setStatus('Boundary Fill needs a surface to divide with. Make one on the Surface tab.');
    return;
  }
  const chosen = [...state.selection.bodies].filter((id) => solids.some((s) => s.id === id));
  const feature = {
    id: uid('f'),
    type: 'boundaryFill',
    bodies: chosen.length ? chosen : 'all',
    tools: sheets.map((s) => s.id),
    cells: []
  };
  openFeatureEditor(feature, 'Boundary Fill', boundaryFillFields());
}

function cmdReplaceFace() {
  if (state.sketcher.active) finishSketch();
  const sheets = surfaceBodies();
  if (!sheets.length) {
    setStatus('Replace Face needs a surface to replace it with.');
    return;
  }
  const faces = [];
  for (const [bodyId, refs] of selectedFaceRefs()) {
    for (const ref of refs) faces.push({ bodyId, face: ref });
  }
  const feature = {
    id: uid('f'),
    type: 'replaceFace',
    faces,
    tool: sheets[0].id
  };
  openFeatureEditor(feature, 'Replace Face', replaceFaceFields());
  if (!faces.length) {
    setEditPick('replaceFaces');
    setStatus('Click the faces to replace.');
  }
}

/* -------- the fields those dialogs show -------- */

function surfaceExtrudeFields() {
  return [
    curveField(),
    { key: 'distance', label: 'Distance', type: 'expr' },
    {
      key: 'direction',
      label: 'Direction',
      type: 'select',
      options: [
        ['one', 'One side'],
        ['symmetric', 'Symmetric']
      ]
    }
  ];
}

function surfaceRevolveFields() {
  return [
    curveField(),
    {
      key: 'axis.type',
      label: 'Axis',
      type: 'select',
      options: [
        ['y', "The sketch's own vertical"],
        ['x', "The sketch's own horizontal"],
        ['world', 'A world axis']
      ]
    },
    {
      key: 'axis.worldAxis',
      label: 'World axis',
      type: 'select',
      showIf: (f) => f.axis?.type === 'world',
      options: [
        ['x', 'X'],
        ['y', 'Y'],
        ['z', 'Z']
      ]
    },
    { key: 'angle', label: 'Angle', type: 'expr' }
  ];
}

function surfaceSweepFields() {
  const sketchOptions = Object.values(state.doc.sketches || {}).map((sk) => [sk.id, sk.name]);
  return [
    curveField(),
    {
      key: 'path.sketch',
      label: 'Path sketch',
      type: 'select',
      options: [['', 'Pick one'], ...sketchOptions]
    },
    { key: 'twist', label: 'Twist', type: 'expr' }
  ];
}

function surfaceLoftFields(feature) {
  const sketchOptions = Object.values(state.doc.sketches || {}).map((sk) => [sk.id, sk.name]);
  const fields = (feature.sections || []).map((_, i) => ({
    key: `sections.${i}.sketch`,
    label: `Section ${i + 1}`,
    type: 'select',
    options: [['', 'Pick one'], ...sketchOptions]
  }));
  fields.push({ key: 'closed', label: 'Closed loop', type: 'bool' });
  return fields;
}

function patchFields() {
  return [
    curveField(),
    surfaceField('Open surfaces'),
    {
      key: 'together',
      label: 'Inner loops are holes',
      type: 'bool'
    }
  ];
}

function ruledFields() {
  return [
    curveField(),
    {
      key: 'alignment',
      label: 'Shape',
      type: 'select',
      options: [
        ['between', 'Between two curves'],
        ['direction', 'A band along a direction']
      ]
    },
    {
      key: 'distance',
      label: 'Width',
      type: 'expr',
      showIf: (f) => f.alignment === 'direction'
    }
  ];
}

function offsetSurfaceFields() {
  return [
    {
      key: '__faces',
      label: 'Faces',
      type: 'pick',
      pick: 'offsetFaces',
      summary: (f) => countOf(f.faces, 'face'),
      clear: (f) => {
        f.faces = [];
      }
    },
    surfaceField('Or surfaces'),
    { key: 'distance', label: 'Offset', type: 'expr' }
  ];
}

function trimSurfaceFields() {
  return [
    surfaceField('Surface to cut'),
    {
      key: '__cutters',
      label: 'Cut with',
      type: 'pick',
      pick: 'surfaceCutters',
      summary: (f) => countOf(f.cutters, 'body'),
      clear: (f) => {
        f.cutters = [];
      }
    },
    {
      key: '__keep',
      label: 'Keep the piece at',
      type: 'pick',
      pick: 'trimKeep',
      summary: (f) =>
        f.keep
          ? f.keep.map((v) => v.toFixed(1)).join(', ')
          : 'click the piece to keep',
      clear: (f) => {
        f.keep = null;
      }
    }
  ];
}

function extendSurfaceFields() {
  return [surfaceField(), { key: 'distance', label: 'Distance', type: 'expr' }];
}

function untrimSurfaceFields() {
  return [
    surfaceField(),
    { key: 'outer', label: 'Square the outside off too', type: 'bool' },
    { key: 'margin', label: 'Extra all round', type: 'expr' }
  ];
}

function mergeSurfaceFields() {
  return [surfaceField(), { key: 'tolerance', label: 'Gap to close', type: 'expr' }];
}

function stitchFields() {
  return [
    surfaceField(),
    { key: 'tolerance', label: 'Gap to close', type: 'expr' }
  ];
}

function unstitchFields() {
  return [
    {
      key: '__bodies',
      label: 'Bodies',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) => (f.bodies === 'all' ? 'every body' : countOf(f.bodies, 'body')),
      clear: (f) => {
        f.bodies = 'all';
      }
    }
  ];
}

function thickenFields() {
  return [
    surfaceField(),
    { key: 'distance', label: 'Thickness', type: 'expr' },
    { key: 'symmetric', label: 'Both sides', type: 'bool' },
    { key: 'keepSurface', label: 'Keep the surface too', type: 'bool' }
  ];
}

function boundaryFillFields() {
  return [
    {
      key: '__bodies',
      label: 'Bodies to divide',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) => (f.bodies === 'all' ? 'every body' : countOf(f.bodies, 'body')),
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    {
      key: '__tools',
      label: 'Divide with',
      type: 'pick',
      pick: 'fillTools',
      summary: (f) => countOf(f.tools, 'surface'),
      clear: (f) => {
        f.tools = [];
      }
    },
    {
      key: '__cells',
      label: '',
      type: 'note',
      text: 'Every cell is kept unless some are named below. Cells are numbered from zero in the order they were cut.'
    },
    { key: 'cells', label: 'Keep only', type: 'text' },
    { key: 'op', label: 'Operation', type: 'select', options: OP_OPTIONS }
  ];
}

function replaceFaceFields() {
  const sheets = surfaceBodies();
  return [
    {
      key: '__faces',
      label: 'Faces to replace',
      type: 'pick',
      pick: 'replaceFaces',
      summary: (f) => countOf(f.faces, 'face'),
      clear: (f) => {
        f.faces = [];
      }
    },
    {
      key: 'tool',
      label: 'Replace with',
      type: 'select',
      options: sheets.map((s) => [s.id, s.name])
    }
  ];
}

/* -------- the two sketch commands surfaces unlock -------- */

/**
 * Drop sketch curves onto a surface.
 *
 * The curves land where they meet the surface, so what comes back is not flat
 * and could not exist in a sketch that had to be. A curve that only partly
 * covers the surface comes back as the pieces that landed rather than as one
 * curve with a jump across the gap.
 */
function cmdProjectToSurface() {
  if (!state.sketcher.active) {
    setStatus('Project To Surface works inside a sketch.');
    return;
  }
  const sk = state.sketcher.sketch;
  const targets = (state.records || []).filter((r) =>
    state.selection.bodies.size ? state.selection.bodies.has(r.id) : true
  );
  if (!targets.length) {
    setStatus('Select the body or surface to project onto.');
    return;
  }

  const plane = state.sketcher.plane;
  const dir = plane.n;
  const runs = [];
  for (const ent of sk.entities) {
    if (ent.construction) continue;
    for (const run of entityRuns(sk, ent)) {
      const world = run.map((p) => {
        const w = sketchToWorld(plane, p.x, p.y, p.z || 0);
        return [w.x, w.y, w.z];
      });
      for (const target of targets) {
        runs.push(...projectRunOnto(world, dir, target.mesh));
      }
    }
  }
  if (!runs.length) {
    setStatus('Nothing in this sketch lands on that surface.');
    return;
  }

  pushUndo('project to surface');
  const made = state.sketcher.insertWorldCurves(runs, { asLines: false });
  state.dirty = true;
  rebuildAll();
  setStatus(`${made} curve${made === 1 ? '' : 's'} projected onto the surface.`);
}

/**
 * The lines of constant u or v across a surface.
 *
 * Only a surface built here has a u and a v to hold constant. A face lifted off
 * a solid is a triangle soup with no parameterisation, and saying so is better
 * than inventing one and calling it isoparametric.
 */
function cmdIsoCurve() {
  if (!state.sketcher.active) {
    setStatus('Isoparametric Curve works inside a sketch.');
    return;
  }
  const chosen = [...state.selection.bodies];
  const sheets = (state.result?.bodies || []).filter(
    (b) => !b.solid && b.sheet && (!chosen.length || chosen.includes(b.id))
  );
  if (!sheets.length) {
    setStatus('Select a surface. A solid face has no u and v to read curves off.');
    return;
  }

  const runs = [];
  for (const b of sheets) {
    if (!b.sheet.grid) {
      setStatus(`${b.name} was not built from a curve, so it has no isoparametric lines.`);
      continue;
    }
    for (const along of ['u', 'v']) {
      const curves = isoCurves(b.sheet, along, 5);
      if (curves) runs.push(...curves);
    }
  }
  if (!runs.length) return;

  pushUndo('isoparametric curve');
  const made = state.sketcher.insertWorldCurves(runs, { asLines: false });
  state.dirty = true;
  rebuildAll();
  setStatus(`${made} isoparametric curve${made === 1 ? '' : 's'}.`);
}

/**
 * The outline a body sweeps out when it is spun about an axis.
 *
 * A hex head spun about its shank is a cylinder as wide as the corners of the
 * flats, and that is the number that says whether a socket clears it. The same
 * outline is what a lathe would have to cut to make the part, which is where
 * Fusion's command comes from.
 *
 * It has to be measured against the material and not against the corners. A
 * hexagon's vertices all sit at one radius, so a profile read off the points
 * alone reports a hollow tube where there is a solid bar. Rays fired out from
 * the axis give the runs of radius that really hold material, and those are
 * what is drawn.
 */
function cmdSpunProfile() {
  if (!state.sketcher.active) {
    setStatus('Spun Profile draws into a sketch. Open one first.');
    return;
  }
  const solids = (state.result?.bodies || []).filter(
    (b) => b.solid && !state.hiddenBodies.has(b.id)
  );
  if (!solids.length) {
    setStatus('Spun Profile needs a solid body to measure.');
    return;
  }
  const chosen = state.selection.bodies.size
    ? solids.filter((b) => state.selection.bodies.has(b.id))
    : solids;

  const kept = state.spun || { axis: 'world:z', stations: '64' };
  showInspector(
    'Spun Profile',
    [
      {
        key: 'axis',
        label: 'Spun about',
        type: 'select',
        value: kept.axis,
        options: axisOptions()
      },
      { key: 'stations', label: 'How many readings along it', type: 'expr', value: kept.stations },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: `${chosen.length} bod${chosen.length === 1 ? 'y' : 'ies'}. The axis has to lie in this sketch's plane, or there is nothing to draw the profile on.`
      }
    ],
    (v) => {
      state.spun = { ...v };
      const scope = resolveParameters(state.doc.parameters);
      const spec = axisSpecFromOption(v.axis);
      const axis = worldAxisFor(spec);
      if (!axis) {
        setStatus('That axis could not be worked out.');
        return;
      }

      const plane = state.sketcher.plane;
      const n = plane.n;
      const dotN = axis.dir[0] * n[0] + axis.dir[1] * n[1] + axis.dir[2] * n[2];
      if (Math.abs(dotN) > 1e-3) {
        setStatus('That axis crosses this sketch rather than lying in it, so a profile of it would be a lie.');
        return;
      }
      // Out from the axis, staying in the sketch. There is only one such
      // direction up to sign, and which sign it is decides which side of the
      // axis the profile is drawn on.
      const out = norm3([
        n[1] * axis.dir[2] - n[2] * axis.dir[1],
        n[2] * axis.dir[0] - n[0] * axis.dir[2],
        n[0] * axis.dir[1] - n[1] * axis.dir[0]
      ]);
      if (!out) {
        setStatus('That axis and this sketch point the same way.');
        return;
      }

      const stations = Math.round(safeEval(v.stations, scope, 64));
      const runs = [];
      for (const body of chosen) {
        const profile = spunProfile(K.meshData(body.solid), axis, { stations });
        if (!profile) continue;
        runs.push(
          profile.loop.map(([t, r]) => [
            axis.origin[0] + axis.dir[0] * t + out[0] * r,
            axis.origin[1] + axis.dir[1] * t + out[1] * r,
            axis.origin[2] + axis.dir[2] * t + out[2] * r
          ])
        );
      }
      if (!runs.length) {
        setStatus('Nothing to spin about that axis.');
        return;
      }

      pushUndo('spun profile');
      const made = state.sketcher.insertWorldCurves(runs, { asLines: true });
      state.dirty = true;
      rebuildAll();
      setStatus(`${made} line${made === 1 ? '' : 's'} of spun profile.`);
    }
  );
}

/** A world axis from the spec a dropdown hands back. */
function worldAxisFor(spec) {
  if (!spec) return null;
  if (spec.worldAxis) {
    const dir =
      spec.worldAxis === 'x' ? [1, 0, 0] : spec.worldAxis === 'y' ? [0, 1, 0] : [0, 0, 1];
    return { origin: [0, 0, 0], dir };
  }
  if (spec.construction) {
    const found = state.result?.construction?.get(spec.construction);
    if (found && found.kind === 'axis') {
      return { origin: found.origin.slice(), dir: found.dir.slice() };
    }
  }
  return null;
}

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

/* ---------------------------------------------------------------- */
/* Sheet metal                                                       */
/* ---------------------------------------------------------------- */

/** Every sheet metal body in the model. */
function sheetBodies() {
  return (state.result?.bodies || []).filter((b) => b.sheetMetal);
}

/** Whichever sheet metal bodies are selected, or all of them. */
function pickedSheetIds() {
  const all = sheetBodies();
  const chosen = all.filter((b) => state.selection.bodies.has(b.id));
  return (chosen.length ? chosen : all).map((b) => b.id);
}

/**
 * The rules this document keeps, and which one is in force.
 *
 * A library rather than one rule, because a part that is aluminium at the
 * bracket and steel at its mount is two rules, and swapping the whole document
 * over to make the second one is how the first one gets lost. A feature can
 * name a rule of its own; anything that does not is made to the active one, so
 * changing that still changes every bend at once, which is what it is for.
 */
function cmdSheetRule() {
  if (state.sketcher.active) finishSketch();
  normalizeSheetRules(state.doc);
  const rules = state.doc.sheetMetalRules.map((r) => ({ ...r }));
  let at = Math.max(0, rules.findIndex((r) => r.name === state.doc.sheetMetalRule));

  const field = (key, label, type, options) => ({
    key,
    label,
    type,
    options,
    get: () => rules[at][key] ?? '',
    set: (_f, v) => {
      // Every field of a rule is an expression, and an expression is text even
      // when it happens to read as a number.
      rules[at][key] = String(v);
    }
  });

  showInspector(
    'Sheet Metal Rules',
    [
      {
        key: '__which',
        label: 'Rule',
        type: 'select',
        options: rules.map((r, i) => [String(i), r.name]),
        get: () => String(at),
        set: (_f, v) => {
          at = Number(v) || 0;
        }
      },
      {
        key: '__active',
        label: '',
        type: 'note',
        text: 'The one shown here becomes the active rule when you accept.'
      },
      field('name', 'Name', 'text'),
      field('thickness', 'Thickness', 'text'),
      field('bendRadius', 'Bend radius', 'text'),
      field('kFactor', 'K factor', 'text'),
      field('gap', 'Rip and miter gap', 'text'),
      field('reliefShape', 'Bend relief', 'select', SM.RELIEF_SHAPES),
      field('reliefWidth', 'Relief width', 'text'),
      field('reliefDepth', 'Relief depth', 'text'),
      field('cornerShape', 'Corner relief', 'select', SM.CORNER_SHAPES),
      field('cornerSize', 'Corner size', 'text'),
      {
        key: '__add',
        label: 'Copy this into a new rule',
        type: 'action',
        run: () => {
          rules.push({
            ...rules[at],
            name: SM.uniqueRuleName(rules, `${rules[at].name} copy`)
          });
          at = rules.length - 1;
        }
      },
      {
        key: '__drop',
        label: 'Remove this rule',
        type: 'action',
        showIf: () => rules.length > 1,
        run: () => {
          rules.splice(at, 1);
          at = Math.min(at, rules.length - 1);
        }
      },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'A blank relief size means the thickness. The K factor is how far through the material the neutral axis sits, and it is what the flat length turns on.'
      }
    ],
    () => {
      pushUndo('sheet metal rules');
      // Named while it was being edited, so a part that was made to the old
      // name is moved over rather than left pointing at nothing.
      const wasActive = state.doc.sheetMetalRule;
      const stillThere = rules.some((r) => r.name === wasActive);
      state.doc.sheetMetalRules = rules;
      state.doc.sheetMetalRule = rules[at]?.name || rules[0].name;
      if (!stillThere) {
        for (const f of state.doc.features) {
          if (f.rule === wasActive) f.rule = state.doc.sheetMetalRule;
        }
      }
      state.dirty = true;
      rebuildAll();
      setStatus(
        `Sheet metal rule: ${state.doc.sheetMetalRule}, ${rules[at].thickness} thick.`
      );
    }
  );
}

/**
 * The rule row every sheet metal feature carries.
 *
 * Blank means the document's active rule, which is what nearly every feature
 * wants. Naming one pins the feature to it, so a second part in a second
 * material does not move the moment the active rule changes.
 */
function sheetRuleField() {
  return {
    key: 'rule',
    label: 'Rule',
    type: 'select',
    options: () => [
      ['', `Active rule (${state.doc.sheetMetalRule})`],
      ...(state.doc.sheetMetalRules || []).map((r) => [r.name, r.name])
    ],
    get: (f) => f.rule || '',
    set: (f, v) => {
      f.rule = v || null;
    }
  };
}

/** Close the corner where two flanges run into each other. */
function cmdMiter() {
  if (state.sketcher.active) finishSketch();
  if (!sheetBodies().length) {
    setStatus('Miter works on a sheet metal body.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'miter',
    bodies: pickedSheetIds(),
    gap: '',
    rule: null
  };
  openFeatureEditor(feature, 'Miter', miterFields());
}

function miterFields() {
  return [
    {
      key: '__bodies',
      label: 'Bodies',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) => (f.bodies === 'all' ? 'every part' : countOf(f.bodies, 'part')),
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    { key: 'gap', label: 'Gap', type: 'expr' },
    sheetRuleField(),
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Every corner where two flanges meet is run into and then cut on the plane that bisects them. A blank gap means the rule.'
    }
  ];
}

/** A flat sheet from a closed profile, which every later panel hangs off. */
function cmdBaseFlange() {
  if (state.sketcher.active) finishSketch();
  const sketchId = activeSketchId();
  if (!sketchId && !state.selection.faces.size) {
    setStatus('Draw a closed profile and select its sketch, or pick a planar face.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'baseFlange',
    sketch: sketchId,
    seeds: sketchId ? activeSeeds(sketchId) : null,
    faces: []
  };
  openFeatureEditor(feature, 'Base Flange', baseFlangeFields());
  if (!feature.seeds?.length) {
    setEditPick('profiles');
    setStatus('Click the profile to make a sheet from.');
  }
}

/** A flange off one or more edges of a sheet metal part. */
function cmdFlange() {
  if (state.sketcher.active) finishSketch();
  if (!sheetBodies().length) {
    setStatus('Flange works on a sheet metal body. Make a base flange first.');
    return;
  }
  const edges = [...selectedEdgeRefs().values()].flat();
  const feature = {
    id: uid('f'),
    type: 'flange',
    bodies: pickedSheetIds(),
    edges,
    angle: '90',
    height: '20',
    radius: '',
    bendPosition: 'inside',
    relief: true
  };
  openFeatureEditor(feature, 'Flange', flangeFields());
  if (!edges.length) {
    setEditPick('sheetEdges');
    setStatus('Click the edges to put a flange on.');
  }
}

/** A whole folded part from one open section, swept a width. */
function cmdContourFlange() {
  if (state.sketcher.active) finishSketch();
  const sketchId = activeSketchId();
  if (!sketchId) {
    setStatus('Draw the part cross section as an open run of lines, then select that sketch.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'contourFlange',
    sketch: sketchId,
    entities: [],
    width: '40',
    radius: ''
  };
  openFeatureEditor(feature, 'Contour Flange', contourFlangeFields());
}

/** Fold a flat face along a sketched line. */
function cmdSheetFold() {
  if (state.sketcher.active) finishSketch();
  if (!sheetBodies().length) {
    setStatus('Fold works on a sheet metal body.');
    return;
  }
  const sketchId = activeSketchId();
  if (!sketchId) {
    setStatus('Draw the fold line on the face, select that sketch, then fold.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'sheetFold',
    bodies: pickedSheetIds(),
    sketch: sketchId,
    entities: [],
    angle: '90',
    radius: '',
    flip: false,
    bendLinePosition: 'center'
  };
  openFeatureEditor(feature, 'Fold', sheetFoldFields());
}

/** Flatten bends to work across them, and put them back afterwards. */
function cmdUnfold(refold) {
  if (state.sketcher.active) finishSketch();
  if (!sheetBodies().length) {
    setStatus(`${refold ? 'Refold' : 'Unfold'} works on a sheet metal body.`);
    return;
  }
  const feature = {
    id: uid('f'),
    type: refold ? 'refold' : 'unfold',
    bodies: pickedSheetIds(),
    bends: ''
  };
  openFeatureEditor(feature, refold ? 'Refold' : 'Unfold', unfoldFields(feature));
}

/** Cut a part so it can be laid out flat. */
function cmdRip() {
  if (state.sketcher.active) finishSketch();
  if (!sheetBodies().length) {
    setStatus('Rip works on a sheet metal body.');
    return;
  }
  const edges = [...selectedEdgeRefs().values()].flat();
  const feature = {
    id: uid('f'),
    type: 'rip',
    bodies: pickedSheetIds(),
    edges,
    gap: ''
  };
  openFeatureEditor(feature, 'Rip', ripFields());
  if (!edges.length) {
    setEditPick('sheetEdges');
    setStatus('Click the edge to tear along.');
  }
}

/** The notch where two bends meet at a corner. */
function cmdCornerRelief() {
  if (state.sketcher.active) finishSketch();
  if (!sheetBodies().length) {
    setStatus('Corner Relief works on a sheet metal body.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'cornerRelief',
    bodies: pickedSheetIds()
  };
  openFeatureEditor(feature, 'Corner Relief', [
    {
      key: '__bodies',
      label: 'Bodies',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) => (f.bodies === 'all' ? 'every part' : countOf(f.bodies, 'part')),
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    sheetRuleField(),
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'The shape and size come from the rule. Where three bends meet, the notch is cut big enough to clear all three.'
    }
  ]);
}

/** Read an ordinary solid as a folded sheet. */
function cmdConvertToSheetMetal() {
  if (state.sketcher.active) finishSketch();
  const solids = (state.result?.bodies || []).filter((b) => b.solid && !b.sheetMetal);
  if (!solids.length) {
    setStatus('Convert needs a solid body that is not already sheet metal.');
    return;
  }
  const chosen = solids.filter((b) => state.selection.bodies.has(b.id));
  const feature = {
    id: uid('f'),
    type: 'convertToSheetMetal',
    bodies: (chosen.length ? chosen : solids).map((b) => b.id)
  };
  openFeatureEditor(feature, 'Convert To Sheet Metal', [
    {
      key: '__bodies',
      label: 'Bodies',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) => (f.bodies === 'all' ? 'every body' : countOf(f.bodies, 'body')),
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'The thickness comes from the rule. A body that is not that thick is refused rather than quietly converted.'
    }
  ]);
}

/** The flat pattern, as a body of its own. */
function cmdFlatPattern() {
  if (state.sketcher.active) finishSketch();
  const parts = sheetBodies();
  if (!parts.length) {
    setStatus('Flat Pattern works on a sheet metal body.');
    return;
  }
  // Laid clear of the part it came from, which is where you want to look at it.
  let far = 0;
  for (const b of parts) {
    try {
      far = Math.max(far, K.boundingBox(b.solid).max[1]);
    } catch {
      /* an unmeasurable body just does not move the mark */
    }
  }
  const feature = {
    id: uid('f'),
    type: 'flatPattern',
    bodies: pickedSheetIds(),
    at: [0, far + 30, 0]
  };
  openFeatureEditor(feature, 'Flat Pattern', [
    {
      key: '__bodies',
      label: 'Parts',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) => (f.bodies === 'all' ? 'every part' : countOf(f.bodies, 'part')),
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'A separate body, not a view of the folded one. It is what a drawing and a DXF are made from.'
    }
  ]);
}

/**
 * The flat, as a DXF a laser cutter will take.
 *
 * Cut geometry and bend lines go on their own layers, because they mean
 * different things to whoever runs the machine: one is a path, the other is a
 * mark for the brake.
 */
async function cmdExportFlatDXF() {
  const flats = (state.result?.bodies || []).filter((b) => b.outline);
  if (!flats.length) {
    setStatus('Make a flat pattern first. That is what carries the outline.');
    return;
  }
  const chosen = flats.filter((b) => state.selection.bodies.has(b.id));
  const one = chosen[0] || flats[0];

  const text = SM.flatToDXF(one.outline);
  const base = (state.docPath ? state.docPath.split(/[\\/]/).pop() : 'Untitled').replace(
    /\.anvil$/i,
    ''
  );
  const res = await window.anvil.exportMesh(`${base} flat.dxf`, 'dxf', text);
  if (res.ok) {
    // What was cut is now a file on a disk somewhere, and the model will go on
    // changing. Remember the shape it had when it went out, so the moment the
    // model moves the app can say the file is behind rather than leaving
    // somebody to cut yesterday's part.
    state.doc.flatExports = state.doc.flatExports || {};
    state.doc.flatExports[one.id] = {
      path: res.path,
      at: Date.now(),
      key: outlineKey(one.outline)
    };
    state.dirty = true;
    setStatus(`Exported ${res.path.split(/[\\/]/).pop()}`);
    window.anvil.showItem(res.path);
    renderTree();
  } else if (res.error) {
    setStatus(`Export failed: ${res.error}`);
  }
}

/**
 * A short signature of a flat outline, for telling whether it has changed.
 *
 * Every point of every panel, rounded to a thousandth. Rounded because a
 * rebuild can move a point by a rounding error without the part being any
 * different, and telling somebody their file is out of date when it is not is
 * the fastest way to have the warning ignored.
 */
function outlineKey(outline) {
  if (!outline) return '';
  const bits = [];
  for (const panel of outline.panels || []) {
    for (const p of panel.contour || panel || []) {
      bits.push(Math.round(p[0] * 1000), Math.round(p[1] * 1000));
    }
  }
  for (const hole of outline.holes || []) {
    for (const p of hole) bits.push(Math.round(p[0] * 1000), Math.round(p[1] * 1000));
  }
  for (const line of outline.bendLines || []) {
    for (const p of [line.a, line.b]) {
      if (p) bits.push(Math.round(p[0] * 1000), Math.round(p[1] * 1000));
    }
  }
  // A rolling hash rather than the whole list: this is stored in the document
  // and read on every tree redraw.
  let h = 2166136261;
  for (const n of bits) {
    h ^= n & 0xffffffff;
    h = Math.imul(h, 16777619);
  }
  return `${bits.length}:${(h >>> 0).toString(16)}`;
}

/** Has the flat pattern moved since its DXF was written? */
function flatExportState(body) {
  const record = state.doc.flatExports?.[body.id];
  if (!record) return null;
  const now = outlineKey(body.outline);
  return {
    ...record,
    stale: now !== record.key,
    file: record.path ? record.path.split(/[\\/]/).pop() : ''
  };
}

/* -------- the fields those dialogs show -------- */

function baseFlangeFields() {
  return [
    {
      key: '__profiles',
      label: 'Profile',
      type: 'pick',
      pick: 'profiles',
      summary: (f) =>
        f.seeds === null || f.seeds === undefined
          ? 'the whole sketch'
          : countOf(f.seeds, 'profile'),
      clear: (f) => {
        f.seeds = [];
      }
    },
    sheetRuleField(),
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'The thickness comes from the rule, so a base flange has no thickness of its own to set.'
    }
  ];
}

function sheetBodyField(label = 'Parts') {
  return {
    key: '__bodies',
    label,
    type: 'pick',
    pick: 'moveBodies',
    summary: (f) => (f.bodies === 'all' ? 'every part' : countOf(f.bodies, 'part')),
    clear: (f) => {
      f.bodies = 'all';
    }
  };
}

function flangeFields() {
  return [
    {
      key: '__edges',
      label: 'Edges',
      type: 'pick',
      pick: 'sheetEdges',
      summary: (f) => countOf(f.edges, 'edge'),
      clear: (f) => {
        f.edges = [];
      }
    },
    { key: 'height', label: 'Height', type: 'expr' },
    { key: 'angle', label: 'Angle', type: 'expr' },
    { key: 'radius', label: 'Bend radius', type: 'expr' },
    sheetRuleField(),
    {
      key: 'bendPosition',
      label: 'Bend position',
      type: 'select',
      options: SM.BEND_POSITIONS
    },
    { key: 'relief', label: 'Bend relief', type: 'bool' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Bend radius blank means the rule. Bend position says what lines up with the edge you picked: the flange inside face, its outside face, the start of the bend, or the point the arc is tangent at.'
    }
  ];
}

function contourFlangeFields() {
  return [
    { key: 'width', label: 'Width', type: 'expr' },
    { key: 'radius', label: 'Bend radius', type: 'expr' },
    sheetRuleField(),
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'The sketch is the part cross section, drawn as one open run of lines. Every leg becomes a panel and every corner a bend.'
    }
  ];
}

function sheetFoldFields() {
  return [
    sheetBodyField(),
    { key: 'angle', label: 'Bend angle', type: 'expr' },
    { key: 'radius', label: 'Bend radius', type: 'expr' },
    { key: 'flip', label: 'Flip', type: 'bool' },
    {
      key: 'bendLinePosition',
      label: 'Bend line position',
      type: 'select',
      options: SM.BEND_LINE_POSITIONS
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Centred on the line the part loses no stock overall: each half gives up half the bend allowance and the arc puts it back.'
    }
  ];
}

function unfoldFields(feature) {
  const parts = sheetBodies().filter(
    (b) => feature.bodies === 'all' || feature.bodies.includes(b.id)
  );
  const bends = parts.flatMap((b) => b.sheetMetal.bends.map((x) => x.id));
  return [
    sheetBodyField(),
    {
      key: '__note',
      label: '',
      type: 'note',
      text: bends.length
        ? `${bends.length} bend${bends.length === 1 ? '' : 's'}, all of them unless some are named below.`
        : 'This part has no bends yet.'
    },
    { key: 'bends', label: 'Only these bends', type: 'text' }
  ];
}

function ripFields() {
  return [
    sheetBodyField(),
    {
      key: '__edges',
      label: 'Edges to tear',
      type: 'pick',
      pick: 'sheetEdges',
      summary: (f) => countOf(f.edges, 'edge'),
      clear: (f) => {
        f.edges = [];
      }
    },
    { key: 'gap', label: 'Gap', type: 'expr' },
    sheetRuleField(),
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'A gap blank means the rule. A shape that closes on itself has no flat until it is torn somewhere.'
    }
  ];
}

/* ---------------------------------------------------------------- */
/* Meshes                                                            */
/* ---------------------------------------------------------------- */

/** Every mesh body in the model. */
function meshBodies() {
  return (state.result?.bodies || []).filter((b) => b.mesh);
}

/** Whichever mesh bodies are selected, or all of them. */
function pickedMeshIds() {
  const all = meshBodies();
  const chosen = all.filter((b) => state.selection.bodies.has(b.id));
  return (chosen.length ? chosen : all).map((b) => b.id);
}

/** The mesh body field every Mesh tab dialog starts with. */
function meshBodyField(label = 'Mesh bodies') {
  return {
    key: '__bodies',
    label,
    type: 'pick',
    pick: 'moveBodies',
    summary: (f) => (f.bodies === 'all' ? 'every mesh' : countOf(f.bodies, 'mesh')),
    clear: (f) => {
      f.bodies = 'all';
    }
  };
}

/** Open a Mesh tab dialog, having checked there is a mesh to work on. */
function startMeshFeature(type, title, fields, extra = {}) {
  if (state.sketcher.active) finishSketch();
  if (!meshBodies().length) {
    setStatus('That works on a mesh body. Insert a mesh, or tessellate a solid.');
    return;
  }
  const feature = { id: uid('f'), type, bodies: pickedMeshIds(), ...extra };
  openFeatureEditor(feature, title, fields);
}

/**
 * A mesh off the disk.
 *
 * STL, OBJ or 3MF. The triangles go into the document rather than into the
 * feature, because nothing in the timeline can reproduce them: the file they
 * came from may not be there next time this is opened.
 */
/**
 * A STEP file, read as bodies.
 *
 * Every shell in the file becomes a body. A face the reader does not
 * understand yet, which today means anything on a B-spline, is counted and
 * said out loud rather than dropped: a part that is quietly missing a face is
 * a part you must not print, and the count is what tells you whether what you
 * have is usable.
 */
function insertSTEP(name, bytes) {
  let out;
  try {
    out = readSTEP(new TextDecoder().decode(bytes));
  } catch (err) {
    setStatus(`Could not read that STEP file: ${err.message}`);
    return;
  }
  if (!out.bodies.length) {
    setStatus(
      out.unread.length
        ? `Nothing readable in that STEP file. It is built from ${out.unread.join(', ')}.`
        : 'Nothing readable in that STEP file.'
    );
    return;
  }

  pushUndo('insert step');
  let made = 0;
  for (const body of out.bodies) {
    const key = uid('m');
    state.doc.meshData[key] = {
      verts: Array.from(body.mesh.vertProperties),
      tris: Array.from(body.mesh.triVerts)
    };
    insertFeature({
      id: uid('f'),
      type: 'insertMesh',
      data: key,
      label:
        body.name ||
        `${name.replace(/\.[^.]+$/, '')}${out.bodies.length > 1 ? ` ${made + 1}` : ''}`,
      scale: '1',
      at: [0, 0, 0]
    });
    made++;
  }
  state.dirty = true;
  rebuildAll();

  const missed = out.unreadFaces
    ? `, ${out.unreadFaces} face${out.unreadFaces === 1 ? '' : 's'} not read (${out.unread.join(', ')})`
    : '';
  setStatus(
    `${made} bod${made === 1 ? 'y' : 'ies'} from ${out.faces} face${out.faces === 1 ? '' : 's'}${missed}.`
  );
}

async function cmdInsertMesh() {
  if (state.sketcher.active) finishSketch();
  const res = await window.anvil.importBinary('mesh');
  if (!res.ok) {
    if (res.error) setStatus(`Could not read that: ${res.error}`);
    return;
  }

  const name = res.path.split(/[\\/]/).pop();
  const bytes = res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes);

  // STEP is not a mesh format and does not go down the mesh path. It carries
  // the surfaces themselves, so what arrives is a body built from planes and
  // cylinders rather than from triangles somebody else chose for us.
  if (/\.(step|stp)$/i.test(name)) {
    insertSTEP(name, bytes);
    return;
  }

  const kind = meshReaderFor(name);
  let mesh;
  try {
    if (kind === 'obj') mesh = parseOBJ(new TextDecoder().decode(bytes));
    else if (kind === '3mf') mesh = await parse3MF(bytes);
    else mesh = parseSTL(bytes);
  } catch (err) {
    setStatus(`Could not read that ${kind ? kind.toUpperCase() : 'file'}: ${err.message}`);
    return;
  }
  if (!mesh.triVerts.length) {
    setStatus('There are no triangles in that file.');
    return;
  }

  pushUndo('insert mesh');
  const key = uid('m');
  state.doc.meshData[key] = {
    verts: Array.from(mesh.vertProperties),
    tris: Array.from(mesh.triVerts)
  };
  const feature = {
    id: uid('f'),
    type: 'insertMesh',
    data: key,
    label: name.replace(/\.[^.]+$/, ''),
    scale: '1',
    at: [0, 0, 0]
  };
  openFeatureEditor(feature, 'Insert Mesh', insertMeshFields());
  setStatus(
    `${name}: ${(mesh.triVerts.length / 3).toLocaleString()} triangles.`
  );
}

/** A solid or a surface, taken as triangles so the mesh tools reach it. */
function cmdTessellate() {
  if (state.sketcher.active) finishSketch();
  const source = (state.result?.bodies || []).filter((b) => !b.mesh);
  if (!source.length) {
    setStatus('Tessellate takes a solid or a surface and gives you its triangles.');
    return;
  }
  const chosen = source.filter((b) => state.selection.bodies.has(b.id));
  const feature = {
    id: uid('f'),
    type: 'tessellate',
    bodies: (chosen.length ? chosen : source).map((b) => b.id)
  };
  openFeatureEditor(feature, 'Tessellate', [
    {
      key: '__bodies',
      label: 'Bodies',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) => (f.bodies === 'all' ? 'every body' : countOf(f.bodies, 'body')),
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'The body it came from stays where it is. Tessellating takes a mesh from something rather than turning it into one.'
    }
  ]);
}

function cmdMeshRepair() {
  startMeshFeature('meshRepair', 'Repair', meshRepairFields(), {
    tolerance: '0.0001',
    fillHoles: true,
    orient: true
  });
  reportHealth();
}

function cmdMeshStitch() {
  startMeshFeature('meshStitch', 'Stitch Mesh', meshStitchFields(), { tolerance: '0.01' });
  reportHealth();
}

function meshStitchFields() {
  return [
    meshBodyField(),
    { key: 'tolerance', label: 'Points closer than this are one point', type: 'expr' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Too small and nothing joins. Too large and detail the size of the tolerance is thrown away. Try it, look at the open edge count, and try again.'
    }
  ];
}

function cmdMeshPatch() {
  startMeshFeature('meshPatch', 'Patch Mesh', meshPatchFields(), { maxPerimeter: '0' });
  reportHealth();
}

function meshPatchFields() {
  return [
    meshBodyField(),
    { key: 'maxPerimeter', label: 'Biggest hole to fill, 0 for all', type: 'expr' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Measured round the rim of the hole, not in edges, so the same hole reads the same in a fine mesh and a coarse one. Filling every hole turns a part that was cut off into a bag.'
    }
  ];
}

/**
 * Move part of a mesh, with no history and nothing recognised first.
 *
 * The thing an imported mesh actually needs. A boss a millimetre out of place
 * gets moved without converting anything, and the falloff is what keeps the
 * surface continuous around what moved.
 */
function cmdMeshDirectEdit() {
  if (state.sketcher.active) finishSketch();
  const meshes = meshBodies();
  if (!meshes.length) {
    setStatus('Direct Edit works on a mesh body. Insert a mesh, or tessellate a solid.');
    return;
  }
  const picked = [];
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    if (meshes.some((b) => b.id === bodyId)) picked.push({ body: bodyId, face: index });
  }
  if (!picked.length) {
    setStatus('Select the part of the mesh to move.');
    return;
  }
  const feature = {
    id: uid('f'),
    type: 'meshDirectEdit',
    bodies: [...new Set(picked.map((f) => f.body))],
    faces: picked,
    direction: 'normal',
    distance: '1',
    falloff: '5'
  };
  openFeatureEditor(feature, 'Direct Edit', meshDirectEditFields());
}

function meshDirectEditFields() {
  return [
    {
      key: 'direction',
      label: 'Which way',
      type: 'select',
      options: [
        ['normal', 'Out of the face'],
        ['x', 'Along X'],
        ['y', 'Along Y'],
        ['z', 'Along Z']
      ]
    },
    { key: 'distance', label: 'How far', type: 'expr' },
    { key: 'falloff', label: 'How far the move carries', type: 'expr' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Without a falloff the region moves and its edges tear. With one the surface around it follows and stays continuous.'
    }
  ];
}

/**
 * What a body is made of, which is what its mass and its cost come from.
 *
 * Kept on the document rather than in the timeline, because it is not a step in
 * building the shape: rolling back past it should not turn a steel bracket into
 * a plastic one.
 */
function cmdPhysicalMaterial() {
  if (state.sketcher.active) finishSketch();
  const bodies = (state.result?.bodies || []).filter((b) => b.solid || b.sheet);
  if (!bodies.length) {
    setStatus('Nothing to give a material to yet.');
    return;
  }
  const chosen = state.selection.bodies.size
    ? bodies.filter((b) => state.selection.bodies.has(b.id))
    : bodies;
  const mats = state.doc.materials || {};
  const current = mats.byBody?.[chosen[0].id] || mats.default || 'pla';

  showInspector(
    'Physical Material',
    [
      {
        key: 'material',
        label: 'Material',
        type: 'select',
        value: current,
        options: MATERIAL_OPTIONS
      },
      {
        key: 'everything',
        label: 'Give it to every body',
        type: 'bool',
        value: false
      },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: `${chosen.length} bod${chosen.length === 1 ? 'y' : 'ies'}. A printed part is infill and air, so the mass this gives is the mass of the same shape solid.`
      }
    ],
    (v) => {
      pushUndo('material');
      state.doc.materials = state.doc.materials || {};
      state.doc.materials.byBody = state.doc.materials.byBody || {};
      if (v.everything) {
        state.doc.materials.default = v.material;
        state.doc.materials.byBody = {};
      } else {
        for (const b of chosen) state.doc.materials.byBody[b.id] = v.material;
      }
      state.dirty = true;
      renderTree();
      setStatus(
        v.everything
          ? `Everything is ${materialLabel(v.material)}.`
          : `${chosen.length} bod${chosen.length === 1 ? 'y is' : 'ies are'} ${materialLabel(v.material)}.`
      );
    }
  );
}

/**
 * What a body looks like, which is nothing to do with what it is made of.
 *
 * Fusion keeps these apart and it is right to: a steel bracket shown in red to
 * mark it as the one being worked on is still steel, and a change of colour
 * must not change what it weighs.
 */
function cmdAppearance() {
  if (state.sketcher.active) finishSketch();
  const bodies = state.result?.bodies || [];
  if (!bodies.length) {
    setStatus('Nothing to colour yet.');
    return;
  }
  const chosen = state.selection.bodies.size
    ? bodies.filter((b) => state.selection.bodies.has(b.id))
    : bodies;
  const kept = state.doc.appearance?.byBody?.[chosen[0].id] || '';

  showInspector(
    'Appearance',
    [
      {
        key: 'colour',
        label: 'Colour',
        type: 'select',
        value: kept,
        options: APPEARANCE_OPTIONS
      },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: `${chosen.length} bod${chosen.length === 1 ? 'y' : 'ies'}. Colour is what it looks like, not what it is made of, and it does not change what it weighs.`
      }
    ],
    (v) => {
      pushUndo('appearance');
      state.doc.appearance = state.doc.appearance || {};
      state.doc.appearance.byBody = state.doc.appearance.byBody || {};
      for (const b of chosen) {
        if (v.colour) state.doc.appearance.byBody[b.id] = v.colour;
        else delete state.doc.appearance.byBody[b.id];
      }
      state.dirty = true;
      rebuildAll();
      setStatus(
        v.colour
          ? `${chosen.length} bod${chosen.length === 1 ? 'y' : 'ies'} recoloured.`
          : 'Back to the ordinary colour.'
      );
    }
  );
}

/**
 * Build the whole timeline again from nothing.
 *
 * Anvil rebuilds as it goes, so this is not the everyday command it is in
 * Fusion. It is here for the one case that matters: the cache holds what the
 * last rebuild made, and if it is ever wrong, everything downstream of it is
 * wrong in a way that looks like a modelling mistake. This throws it away, so
 * "have I confused it" can be answered in a second rather than argued about.
 */
function cmdComputeAll() {
  if (state.sketcher.active) finishSketch();
  const t0 = performance.now();
  if (state.cache) {
    state.cache.dispose();
    state.cache = null;
  }
  rebuildAll();
  const ms = Math.round(performance.now() - t0);
  const errors = state.result?.errors?.length || 0;
  setStatus(
    errors
      ? `Rebuilt from nothing in ${ms} ms, with ${errors} problem${errors === 1 ? '' : 's'}.`
      : `Rebuilt from nothing in ${ms} ms. Everything is as it says.`
  );
}

// Off the one list that also holds the densities, so a material can never be
// offered here and be unknown to the thing that works out the mass.
const MATERIAL_OPTIONS = MATERIALS.map(([id, label]) => [id, label]);

const APPEARANCE_OPTIONS = [
  ['', 'The ordinary colour'],
  ['#b8564a', 'Red'],
  ['#c98a3c', 'Orange'],
  ['#c9b03c', 'Yellow'],
  ['#5d8f5a', 'Green'],
  ['#4a7fb8', 'Blue'],
  ['#7a5fa8', 'Violet'],
  ['#8a8f96', 'Grey'],
  ['#3c4148', 'Near black']
];

/** Say what is actually wrong, since that is what decides which knobs matter. */
function reportHealth() {
  const first = meshBodies()[0];
  if (!first) return;
  const h = meshHealth(first.sheet);
  setStatus(
    h.closed
      ? `${first.name}: ${h.triangles.toLocaleString()} triangles, closed and ready to convert.`
      : `${first.name}: ${h.triangles.toLocaleString()} triangles, ${h.openEdges} open edge${
          h.openEdges === 1 ? '' : 's'
        } in ${h.holes} hole${h.holes === 1 ? '' : 's'}${
          h.nonManifold ? `, ${h.nonManifold} edges with three or more faces` : ''
        }${h.degenerate ? `, ${h.degenerate} degenerate triangles` : ''}.`
  );
}

function cmdMeshReduce() {
  startMeshFeature('meshReduce', 'Reduce', meshReduceFields(), {
    by: 'ratio',
    ratio: '50',
    triangles: '2000'
  });
}

function cmdMeshRemesh() {
  startMeshFeature('meshRemesh', 'Remesh', meshRemeshFields(), {
    edgeLength: '',
    density: '40',
    iterations: '4',
    project: true
  });
}

function cmdMeshSmooth() {
  startMeshFeature('meshSmooth', 'Smooth', meshSmoothFields(), {
    iterations: '5',
    strength: '0.5',
    allowShrink: false,
    holdBoundary: true
  });
}

function cmdMeshPlaneCut() {
  startMeshFeature('meshPlaneCut', 'Plane Cut', meshPlaneCutFields(), {
    plane: 'XY',
    mode: 'trim',
    flip: false,
    fill: true
  });
  setEditPick('splitFace');
  setStatus('Click the plane or a flat face to cut against.');
}

function cmdMeshScale() {
  startMeshFeature('meshScale', 'Scale Mesh', meshScaleFields(), {
    factor: '1',
    nonUniform: false,
    sx: '1',
    sy: '1',
    sz: '1',
    pivotMode: 'centre'
  });
}

function meshScaleFields() {
  return [
    meshBodyField(),
    { key: 'factor', label: 'Factor', type: 'expr', showIf: (f) => !f.nonUniform },
    { key: 'nonUniform', label: 'Per axis', type: 'bool' },
    { key: 'sx', label: 'X factor', type: 'expr', showIf: (f) => f.nonUniform },
    { key: 'sy', label: 'Y factor', type: 'expr', showIf: (f) => f.nonUniform },
    { key: 'sz', label: 'Z factor', type: 'expr', showIf: (f) => f.nonUniform },
    {
      key: 'pivotMode',
      label: 'Scale about',
      type: 'select',
      options: [
        ['centre', 'The middle of the body'],
        ['origin', 'The world origin']
      ]
    }
  ];
}

function cmdMeshSeparate() {
  startMeshFeature('meshSeparate', 'Separate', [meshBodyField()]);
}

function cmdMeshMerge() {
  if (meshBodies().length < 2) {
    setStatus('Merge needs two or more mesh bodies.');
    return;
  }
  startMeshFeature('meshMerge', 'Merge Bodies', [meshBodyField()]);
}

function cmdMeshReverse() {
  startMeshFeature('meshReverse', 'Reverse Normal', [meshBodyField()]);
}

function cmdMeshErase() {
  if (state.sketcher.active) finishSketch();
  if (!meshBodies().length) {
    setStatus('Erase And Fill works on a mesh body.');
    return;
  }
  const faces = [];
  for (const [bodyId, refs] of selectedFaceRefs()) {
    for (const ref of refs) faces.push({ bodyId, face: ref });
  }
  const feature = { id: uid('f'), type: 'meshErase', faces, fill: true };
  openFeatureEditor(feature, 'Erase And Fill', meshEraseFields());
  if (!faces.length) {
    setEditPick('eraseFaces');
    setStatus('Click the faces to remove.');
  }
}

function cmdConvertMesh() {
  startMeshFeature('convertMesh', 'Convert Mesh', [
    meshBodyField(),
    { key: 'repair', label: 'Repair first', type: 'bool' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'A mesh has to be closed to be a solid. One that is not is refused and told why, rather than handed over and quietly wrong.'
    }
  ], { repair: true });
}

/**
 * Read a body back as features, whatever it arrived as.
 *
 * A model that came in from outside has no history: no extrude that made it, no
 * hole feature to point at. Fusion's answer is that an imported mesh stays a
 * mesh until you convert it, and a converted one is still a shape with no
 * features in it. Anvil's kernel is a mesh kernel, so the question here is not
 * whether it can be converted but what it is, and that can be measured: a
 * cylindrical face whose surface faces its own axis is a bore, and one that
 * meets both neighbours without a crease is a blend.
 *
 * What comes back is a reading, and it says which. Nothing is changed on the
 * model by looking at it.
 */
/* ------------------------------------------------------------------ */
/* Choosing things by dragging over them                               */
/* ------------------------------------------------------------------ */

/**
 * A selection box, and the paint mode that shares its machinery.
 *
 * Clicking one face at a time is the reason a model with four hundred of them
 * is abandoned rather than edited. A drag over the ones you want is the answer,
 * and the only real question is what "over" means: everything wholly inside the
 * box, or everything it touches. Both, decided by which way the drag went, the
 * way every other package decides it.
 */
function startBand(e) {
  const wrap = document.getElementById('viewwrap');
  const box = document.createElement('div');
  box.className = 'sk-band';
  wrap.appendChild(box);
  state.band = {
    x0: e.clientX,
    y0: e.clientY,
    x1: e.clientX,
    y1: e.clientY,
    el: box,
    add: e.shiftKey,
    pointerId: e.pointerId
  };
  try {
    state.vp.canvas.setPointerCapture(e.pointerId);
  } catch {
    /* capture is a convenience */
  }
}

function bandPointerMove(e) {
  const b = state.band;
  if (!b) return false;
  b.x1 = e.clientX;
  b.y1 = e.clientY;

  const r = document.getElementById('viewwrap').getBoundingClientRect();
  const left = Math.min(b.x0, b.x1) - r.left;
  const top = Math.min(b.y0, b.y1) - r.top;
  b.el.style.left = `${left}px`;
  b.el.style.top = `${top}px`;
  b.el.style.width = `${Math.abs(b.x1 - b.x0)}px`;
  b.el.style.height = `${Math.abs(b.y1 - b.y0)}px`;
  // Rightwards is solid and takes what is inside; leftwards is dashed and
  // takes what it touches. The band says which it is while it is being drawn.
  b.el.classList.toggle('crossing', b.x1 < b.x0);
  return true;
}

function bandPointerUp(e) {
  const b = state.band;
  if (!b) return false;
  state.band = null;
  b.el.remove();
  try {
    state.vp.canvas.releasePointerCapture(b.pointerId ?? e?.pointerId);
  } catch {
    /* already let go */
  }

  const w = Math.abs(b.x1 - b.x0);
  const h = Math.abs(b.y1 - b.y0);
  // A press that barely moved was a click on nothing, which clears and is
  // already done.
  if (w < 4 && h < 4) return true;

  const rect = {
    lo: [Math.min(b.x0, b.x1), Math.min(b.y0, b.y1)],
    hi: [Math.max(b.x0, b.x1), Math.max(b.y0, b.y1)]
  };
  const crossing = b.x1 < b.x0;
  const filter = activeFilter();
  let took = 0;

  for (const record of state.records || []) {
    if (!record.topology || !record.visible) continue;
    if (filter.faces !== false) {
      for (const face of record.topology.faces) {
        if (!facingUs(face)) continue;
        if (!inBand(facePoints(record, face), rect, crossing)) continue;
        state.selection.faces.add(`${record.id}:${face.id}`);
        took++;
      }
    }
    if (filter.edges !== false) {
      for (const edge of record.topology.edges) {
        if (edge.tangent) continue;
        if (!inBand(edge.points, rect, crossing)) continue;
        state.selection.edges.add(`${record.id}:${edge.id}`);
        took++;
      }
    }
  }

  state.vp.setSelection(state.selection.bodies);
  refreshHighlight();
  refreshPullHandle();
  renderTree();
  updateHints();
  setStatus(
    took
      ? `${took} ${crossing ? 'touched by' : 'inside'} the box.`
      : 'Nothing in the box.'
  );
  return true;
}

/** Is this face turned towards the camera? A box should not take the back. */
function facingUs(face) {
  const cam = state.vp.camera.position;
  const toEye = [
    cam.x - face.centre[0],
    cam.y - face.centre[1],
    cam.z - face.centre[2]
  ];
  return (
    face.normal[0] * toEye[0] + face.normal[1] * toEye[1] + face.normal[2] * toEye[2] > 0
  );
}

/**
 * Where a face is, in enough places to judge it.
 *
 * Its own corners rather than its centre, because a long face can have its
 * middle inside the box and both ends far outside it. Sampled rather than taken
 * whole: a face of four thousand triangles does not need four thousand tests to
 * answer this question.
 */
function facePoints(record, face) {
  const mesh = record.mesh;
  const stride = mesh.numProp;
  const out = [];
  const step = Math.max(1, Math.floor(face.tris.length / 24));
  for (let i = 0; i < face.tris.length; i += step) {
    const t = face.tris[i];
    for (let k = 0; k < 3; k++) {
      const v = mesh.triVerts[t * 3 + k] * stride;
      out.push([mesh.vertProperties[v], mesh.vertProperties[v + 1], mesh.vertProperties[v + 2]]);
    }
  }
  return out;
}

/** Wholly inside the box, or touching it, according to which was asked for. */
function inBand(points, rect, crossing) {
  if (!points?.length) return false;
  let any = false;
  for (const p of points) {
    const s = state.vp.worldToScreen(p[0], p[1], p[2]);
    if (!s || s.behind) {
      if (!crossing) return false;
      continue;
    }
    const inside =
      s.clientX >= rect.lo[0] &&
      s.clientX <= rect.hi[0] &&
      s.clientY >= rect.lo[1] &&
      s.clientY <= rect.hi[1];
    if (inside) {
      if (crossing) return true;
      any = true;
    } else if (!crossing) {
      return false;
    }
  }
  return crossing ? false : any;
}

/* ------------------------------------------------------------------ */
/* Choosing things                                                     */
/* ------------------------------------------------------------------ */

/**
 * The body whose faces are selected, and which faces they are.
 *
 * Every rule below works within one body, because a face index means nothing
 * without the topology it came from. Where faces from several bodies are
 * selected the first is used and the rest are said to be ignored, which is
 * honest and rare.
 */
function selectedFaceContext() {
  const byBody = new Map();
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    if (!byBody.has(bodyId)) byBody.set(bodyId, []);
    byBody.get(bodyId).push(index);
  }
  if (!byBody.size) return null;
  const [bodyId, faces] = [...byBody][0];
  const record = (state.records || []).find((r) => r.id === bodyId);
  if (!record?.topology) return null;
  return { record, faces, spread: byBody.size > 1 };
}

/** Put a set of face indices on one body into the selection. */
function chooseFaces(record, indices, what) {
  state.selection.faces.clear();
  state.selection.edges.clear();
  for (const i of indices) state.selection.faces.add(`${record.id}:${i}`);
  refreshHighlight();
  refreshPullHandle();
  renderTree();
  setStatus(`${indices.length} face${indices.length === 1 ? '' : 's'} ${what}.`);
}

/** One body's topology, whichever body is being talked about. */
function soleRecord() {
  const chosen = (state.records || []).filter((r) => state.selection.bodies.has(r.id));
  const list = chosen.length ? chosen : (state.records || []).filter((r) => r.topology);
  return list.length === 1 ? list[0] : null;
}

function cmdSelectInvert() {
  const ctx = selectedFaceContext();
  if (!ctx) {
    setStatus('Select a face first. Invert needs something to turn inside out.');
    return;
  }
  chooseFaces(
    ctx.record,
    SEL.invert(ctx.record.topology.faces.length, ctx.faces),
    'selected, the rest of the body'
  );
}

function cmdSelectGrow(rings = 1) {
  const ctx = selectedFaceContext();
  if (!ctx) {
    setStatus('Select a face to grow from.');
    return;
  }
  chooseFaces(ctx.record, SEL.grow(ctx.record.topology, ctx.faces, rings), 'after growing');
}

function cmdSelectShrink() {
  const ctx = selectedFaceContext();
  if (!ctx) {
    setStatus('Select some faces to shrink.');
    return;
  }
  const got = SEL.shrink(ctx.record.topology, ctx.faces);
  if (!got.length) {
    setStatus('Shrinking that leaves nothing. Every face of it is on the border.');
    return;
  }
  chooseFaces(ctx.record, got, 'after shrinking');
}

function cmdSelectTangent() {
  const ctx = selectedFaceContext();
  if (!ctx) {
    setStatus('Select a face. The run follows the surface it belongs to.');
    return;
  }
  chooseFaces(
    ctx.record,
    SEL.tangentRun(ctx.record.topology, ctx.faces),
    'in that smooth run'
  );
}

function cmdSelectSimilar() {
  const ctx = selectedFaceContext();
  if (!ctx) {
    setStatus('Select a face to match against.');
    return;
  }
  chooseFaces(ctx.record, SEL.similarFaces(ctx.record.topology, ctx.faces), 'of that shape');
}

/**
 * Everything reachable from what is selected without crossing a selected edge.
 *
 * The one that earns its keep on a shape nobody modelled: pick a face of a
 * pocket, pick the rim round it, and the pocket comes whole however many faces
 * it turns out to be made of.
 */
function cmdSeedAndBoundary() {
  const ctx = selectedFaceContext();
  if (!ctx) {
    setStatus('Select a face to start from, and the edges to stop at.');
    return;
  }
  const bounds = [];
  for (const key of state.selection.edges) {
    const { bodyId, index } = splitKey(key);
    if (bodyId === ctx.record.id) bounds.push(index);
  }
  chooseFaces(
    ctx.record,
    SEL.seedAndBoundary(ctx.record.topology, ctx.faces, bounds),
    bounds.length ? 'inside that boundary' : 'reachable, with no boundary set'
  );
}

/**
 * Faces under or over a size.
 *
 * The tool that makes an import workable. A downloaded model has a dozen faces
 * worth caring about and hundreds of chips; this is how the chips get dealt
 * with in one go instead of four hundred.
 */
function cmdSelectBySize() {
  const record = soleRecord();
  if (!record) {
    setStatus('Select one body to choose faces on.');
    return;
  }
  const range = SEL.sizeRange(record.topology);
  showInspector(
    'Select By Size',
    [
      {
        key: '__range',
        label: '',
        type: 'note',
        text:
          `${record.topology.faces.length} faces, from ${round(range.min, 3)} to ` +
          `${round(range.max, 1)} square ${displayUnit().label}.`
      },
      { key: 'min', label: 'At least', type: 'expr', value: '0' },
      { key: 'max', label: 'At most', type: 'expr', value: String(round(range.max, 3)) },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: 'Area, in the document units squared. Everything between the two is chosen.'
      }
    ],
    (values) => {
      const scope = resolveParameters(state.doc.parameters).scope;
      const min = safeEval(values.min, scope, 0);
      const max = safeEval(values.max, scope, Infinity);
      const got = SEL.facesBySize(record.topology, { min, max });
      if (!got.length) {
        setStatus('Nothing is that size.');
        return;
      }
      chooseFaces(record, got, `between ${round(min, 3)} and ${round(max, 3)}`);
    }
  );
}

/** Hide everything except what is selected, and put it back again. */
function cmdIsolate() {
  const keep = new Set(state.selection.bodies);
  for (const key of state.selection.faces) keep.add(splitKey(key).bodyId);
  for (const key of state.selection.edges) keep.add(splitKey(key).bodyId);
  if (!keep.size) {
    setStatus('Select something to isolate.');
    return;
  }
  for (const r of state.records || []) {
    if (!keep.has(r.id)) state.hiddenBodies.add(r.id);
  }
  rebuildAll();
  setStatus(`Isolated ${keep.size} bod${keep.size === 1 ? 'y' : 'ies'}.`);
}

function cmdUnisolate() {
  const n = state.hiddenBodies.size;
  state.hiddenBodies.clear();
  rebuildAll();
  setStatus(n ? `Showed ${n} hidden bod${n === 1 ? 'y' : 'ies'}.` : 'Nothing was hidden.');
}

/** What a click may land on, until it is set back. */
function cmdSelectPriority(kind) {
  state.selectPriority = kind;
  const said = {
    auto: 'Anything',
    body: 'Bodies only',
    face: 'Faces only',
    edge: 'Edges only',
    component: 'Components only'
  }[kind];
  setStatus(`${said} can be selected now.`);
  updateHints();
}

function cmdRecognise() {
  if (state.sketcher.active) finishSketch();
  const chosen = (state.result?.bodies || []).filter((b) =>
    state.selection.bodies.size ? state.selection.bodies.has(b.id) : true
  );
  const body = chosen.length === 1 ? chosen[0] : null;
  if (!body) {
    setStatus(
      chosen.length ? 'Select one body to read.' : 'There is nothing to read yet.'
    );
    return;
  }
  const record = (state.records || []).find((r) => r.id === body.id);
  if (!record?.topology) {
    setStatus('That body has no readable faces.');
    return;
  }

  const found = recognise(record.mesh, record.topology);
  const c = found.counts;
  const fields = [];

  const say = (text) => fields.push({ key: `__n${fields.length}`, label: '', type: 'note', text });

  say(
    `${c.faces} faces: ${c.flats} flat, ${c.curved} curved. ` +
      `${c.holes} hole${c.holes === 1 ? '' : 's'}, ${c.fillets} fillet${c.fillets === 1 ? '' : 's'}.`
  );

  if (!found.holes.length) say('No bores found. A hole is a cylindrical face whose surface faces its own axis.');
  for (const g of found.holeSizes) {
    const through = g.items.filter((h) => h.through).length;
    const deepest = Math.max(...g.items.map((h) => h.depth));
    fields.push({
      key: `__hole${g.size}`,
      label:
        `${g.items.length} \u00d7 \u2300${fmtLengthBare(g.size)} ` +
        `${through === g.items.length ? 'through' : through ? `${through} through` : 'blind'}` +
        `, to ${fmtLength(deepest)}`,
      type: 'action',
      run: () => {
        state.selection.faces.clear();
        state.selection.edges.clear();
        for (const h of g.items) state.selection.faces.add(`${body.id}:${h.face}`);
        refreshHighlight();
        refreshPullHandle();
        setStatus(`${g.items.length} bores of ${fmtLength(g.size)} selected.`);
      }
    });
  }

  for (const g of found.filletSizes) {
    fields.push({
      key: `__fillet${g.size}`,
      label: `${g.items.length} \u00d7 R${fmtLengthBare(g.size)} ${g.items[0].convex ? 'round' : 'inside'}`,
      type: 'action',
      run: () => {
        state.selection.faces.clear();
        state.selection.edges.clear();
        for (const f of g.items) state.selection.faces.add(`${body.id}:${f.face}`);
        refreshHighlight();
        refreshPullHandle();
        setStatus(`${g.items.length} fillets of ${fmtLength(g.size)} selected.`);
      }
    });
  }

  say(
    'Each row selects what it names, so it can be filled, offset or measured ' +
      'like anything else. Blends that run into each other are one surface and ' +
      'are not counted as separate fillets.'
  );

  showInspector(`Recognise \u2014 ${body.name}`, fields, () => {});
}

function cmdFaceGroups() {
  startMeshFeature('faceGroups', 'Generate Face Groups', [
    meshBodyField(),
    { key: 'angle', label: 'Angle', type: 'expr' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'How far two triangles can disagree and still be the same face. Loosen it on a scan, tighten it on something machined. This is also the way back: it throws away any group set by hand.'
    }
  ], { angle: '30' });
}

const FACE_GROUP_OPS = {
  pin: {
    title: 'Create Face Group',
    note: 'Each face picked is kept exactly as it stands, whatever angle is asked for later.',
    done: 'kept'
  },
  combine: {
    title: 'Combine Face Groups',
    note: 'Everything picked becomes one face. They have to touch, because a face that is in two places is not one face.',
    done: 'combined'
  },
  release: {
    title: 'Delete Face Groups',
    note: 'The faces picked go back to being worked out from the angle.',
    done: 'released'
  }
};

/**
 * Face groups set by hand.
 *
 * The angle is a good first guess and a poor last word: on a scan there is no
 * angle that keeps a moulded corner whole and still separates the two flats
 * beside it. At that point the answer has to be pointed at.
 */
function cmdFaceGroupEdit(op) {
  if (state.sketcher.active) finishSketch();
  const meshes = (state.result?.bodies || []).filter((b) => b.mesh);
  if (!meshes.length) {
    setStatus('Face groups are set on a mesh body.');
    return;
  }
  const how = FACE_GROUP_OPS[op] || FACE_GROUP_OPS.combine;
  // A face reference here carries its body, because a group can be set on more
  // than one mesh in the same feature.
  const faces = [];
  for (const [bodyId, refs] of selectedFaceRefs()) {
    for (const face of refs) faces.push({ bodyId, face });
  }
  const feature = {
    id: uid('f'),
    type: 'faceGroupEdit',
    op,
    bodies: faces.length ? [...new Set(faces.map((f) => f.bodyId))] : 'all',
    faces
  };
  openFeatureEditor(feature, how.title, faceGroupEditFields(feature));
  if (!faces.length) {
    setEditPick('groupFaces');
    setStatus('Click the faces to group.');
  }
}

function faceGroupEditFields(feature) {
  const how = FACE_GROUP_OPS[feature.op] || FACE_GROUP_OPS.combine;
  return [
    {
      key: '__faces',
      label: 'Faces',
      type: 'pick',
      pick: 'groupFaces',
      summary: (f) => countOf(f.faces, 'face'),
      clear: (f) => {
        f.faces = [];
      }
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: how.note
    }
  ];
}

/**
 * Push a mesh's surface in and out by the brightness of an image.
 *
 * A texture that is really there, in the geometry, so it survives being sliced
 * and printed rather than being a picture of one.
 */
async function cmdTextureExtrude() {
  if (state.sketcher.active) finishSketch();
  if (!meshBodies().length) {
    setStatus('Texture Extrude works on a mesh body.');
    return;
  }
  const res = await window.anvil.importBinary('image');
  if (!res.ok) {
    if (res.error) setStatus(`Could not read that: ${res.error}`);
    return;
  }

  let held;
  try {
    held = await grayscaleOf(res.bytes);
  } catch (err) {
    setStatus(`Could not read that image: ${err.message}`);
    return;
  }

  pushUndo('texture extrude');
  const key = uid('img');
  state.doc.imageData[key] = held;
  const feature = {
    id: uid('f'),
    type: 'textureExtrude',
    bodies: pickedMeshIds(),
    image: key,
    plane: 'XY',
    height: '1',
    size: '50',
    invert: false
  };
  openFeatureEditor(feature, 'Texture Extrude', textureExtrudeFields());
  setStatus(`${held.width} by ${held.height} image, laid on the plane.`);
}

/**
 * An image as one brightness per pixel.
 *
 * Kept small on purpose: a displacement map is sampled per vertex, and a mesh
 * with more vertices than the picture has pixels is a different problem from
 * one where the picture is too big to hold in a document.
 */
async function grayscaleOf(bytes) {
  const blob = new Blob([bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)]);
  const bitmap = await createImageBitmap(blob);
  const max = 512;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const gray = new Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // Rec. 709 luma, which is what the eye reads as brightness.
    gray[i] = Math.round(
      0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]
    );
  }
  bitmap.close?.();
  return { width: w, height: h, gray };
}

/**
 * The curve where a plane crosses a mesh, brought into the sketch.
 *
 * What it is for is reverse engineering: something to trace over when the only
 * thing you have is a scan.
 */
function cmdMeshSection() {
  if (!state.sketcher.active) {
    setStatus('Create Mesh Section Sketch works inside a sketch.');
    return;
  }
  const chosen = [...state.selection.bodies];
  const targets = meshBodies().filter((b) => !chosen.length || chosen.includes(b.id));
  if (!targets.length) {
    setStatus('Select a mesh body to take the section from.');
    return;
  }

  const plane = state.sketcher.plane;
  const runs = [];
  for (const b of targets) runs.push(...sectionCurves(b.sheet, plane));
  if (!runs.length) {
    setStatus('That plane does not cross the mesh.');
    return;
  }

  pushUndo('mesh section sketch');
  const made = state.sketcher.insertWorldCurves(runs, { asLines: true });
  state.dirty = true;
  rebuildAll();
  setStatus(`${runs.length} section curve${runs.length === 1 ? '' : 's'}, ${made} segments.`);
}

/* -------- the fields those dialogs show -------- */

function insertMeshFields() {
  return [
    { key: 'scale', label: 'Scale', type: 'expr' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'The file is in millimetres unless it says otherwise, which most do not. Scale by 25.4 for something drawn in inches.'
    }
  ];
}

function meshRepairFields() {
  return [
    meshBodyField(),
    { key: 'tolerance', label: 'Weld tolerance', type: 'expr' },
    { key: 'fillHoles', label: 'Fill holes', type: 'bool' },
    { key: 'orient', label: 'Agree on which way is out', type: 'bool' }
  ];
}

function meshReduceFields() {
  return [
    meshBodyField(),
    {
      key: 'by',
      label: 'Reduce by',
      type: 'select',
      options: [
        ['ratio', 'A proportion'],
        ['count', 'A triangle count']
      ]
    },
    {
      key: 'ratio',
      label: 'Keep, per cent',
      type: 'expr',
      showIf: (f) => (f.by || 'ratio') === 'ratio'
    },
    {
      key: 'triangles',
      label: 'Triangles',
      type: 'expr',
      showIf: (f) => f.by === 'count'
    }
  ];
}

function meshRemeshFields() {
  return [
    meshBodyField(),
    { key: 'edgeLength', label: 'Edge length', type: 'expr' },
    { key: 'density', label: 'Or divisions across', type: 'expr' },
    { key: 'iterations', label: 'Passes', type: 'expr' },
    { key: 'project', label: 'Hold the shape', type: 'bool' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Blank edge length means work it out from the size of the body. Holding the shape puts every vertex back on the surface it started on, which is what stops a remesh rounding off the corners.'
    }
  ];
}

function meshSmoothFields() {
  return [
    meshBodyField(),
    { key: 'iterations', label: 'Passes', type: 'expr' },
    { key: 'strength', label: 'Strength', type: 'expr' },
    { key: 'allowShrink', label: 'Let it shrink', type: 'bool' },
    { key: 'holdBoundary', label: 'Hold open edges', type: 'bool' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Smoothing shrinks unless it is stopped from doing so, which is why letting it is a choice rather than the default.'
    }
  ];
}

function meshPlaneCutFields() {
  return [
    meshBodyField(),
    {
      key: '__plane',
      label: 'Plane',
      type: 'pick',
      pick: 'splitFace',
      summary: (f) => (typeof f.plane === 'string' ? f.plane : 'a face'),
      clear: (f) => {
        f.plane = 'XY';
        f.faceRef = null;
      }
    },
    {
      key: 'mode',
      label: 'Cut type',
      type: 'select',
      options: [
        ['trim', 'Trim, keep one side'],
        ['split', 'Split into two bodies'],
        ['faces', 'Split the faces only']
      ]
    },
    { key: 'flip', label: 'Keep the other side', type: 'bool', showIf: (f) => f.mode === 'trim' },
    { key: 'fill', label: 'Cap the cut', type: 'bool', showIf: (f) => f.mode !== 'faces' }
  ];
}

function meshEraseFields() {
  return [
    {
      key: '__faces',
      label: 'Faces to remove',
      type: 'pick',
      pick: 'eraseFaces',
      summary: (f) => countOf(f.faces, 'face'),
      clear: (f) => {
        f.faces = [];
      }
    },
    { key: 'fill', label: 'Close the hole', type: 'bool' }
  ];
}

function textureExtrudeFields() {
  return [
    meshBodyField(),
    {
      key: '__plane',
      label: 'Lay it on',
      type: 'pick',
      pick: 'splitFace',
      summary: (f) => (typeof f.plane === 'string' ? f.plane : 'a face'),
      clear: (f) => {
        f.plane = 'XY';
        f.faceRef = null;
      }
    },
    { key: 'size', label: 'Image size', type: 'expr' },
    { key: 'height', label: 'Depth', type: 'expr' },
    { key: 'invert', label: 'Invert', type: 'bool' },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'White pushes out and black stays put, unless it is inverted. Remesh first if the triangles are coarser than the picture.'
    }
  ];
}

/* ---------------------------------------------------------------- */
/* Forms                                                             */
/* ---------------------------------------------------------------- */

/** Every form body in the model. */
function formBodies() {
  return (state.result?.bodies || []).filter((b) => b.form);
}

/**
 * The form being worked on.
 *
 * Whichever is selected, or the only one there is. A form is edited in place
 * rather than through a feature per change, so the commands need to know which
 * cage they are changing without a dialog asking every time.
 */
function activeForm() {
  const all = formBodies();
  if (!all.length) return null;
  const chosen = all.find((b) => state.selection.bodies.has(b.id));
  if (chosen) return chosen;
  for (const key of state.selection.faces) {
    const { bodyId } = splitKey(key);
    const hit = all.find((b) => b.id === bodyId);
    if (hit) return hit;
  }
  for (const key of state.selection.edges) {
    const { bodyId } = splitKey(key);
    const hit = all.find((b) => b.id === bodyId);
    if (hit) return hit;
  }
  return all.length === 1 ? all[0] : null;
}

/**
 * Which cage faces are selected, as indices into the cage.
 *
 * The body's own topology carries the cage face each of its faces came from,
 * because the cage mesh is tagged that way when it is built. So a click in the
 * viewport lands on a cage face without any picking code of its own.
 */
function selectedCageFaces(body) {
  const rec = (state.records || []).find((r) => r.id === body.id);
  const out = [];
  for (const key of state.selection.faces) {
    const { bodyId, index } = splitKey(key);
    if (bodyId !== body.id) continue;
    const face = rec?.topology?.faces[index];
    const at = face?.src?.face;
    if (at !== undefined && at >= 0) out.push(at);
  }
  return [...new Set(out)];
}

/** Which cage edges are selected, as pairs of cage point indices. */
function selectedCageEdges(body) {
  const rec = (state.records || []).find((r) => r.id === body.id);
  const cage = body.cage;
  const out = [];
  for (const key of state.selection.edges) {
    const { bodyId, index } = splitKey(key);
    if (bodyId !== body.id) continue;
    const edge = rec?.topology?.edges[index];
    if (!edge?.points?.length) continue;
    // The cage points the drawn edge runs between, found by position: the
    // topology's own vertices are the mesh's, and the mesh is the cage.
    const ends = [edge.points[0], edge.points[edge.points.length - 1]];
    const found = ends.map((p) => nearestCagePoint(cage, p));
    if (found[0] !== null && found[1] !== null && found[0] !== found[1]) {
      out.push([found[0], found[1]]);
    }
  }
  return out;
}

function nearestCagePoint(cage, p) {
  let best = null;
  cage.points.forEach((q, i) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (!best || d < best.d) best = { d, i };
  });
  return best && best.d < 1e-4 ? best.i : null;
}

/** The points those edges run between. */
function pointsOfEdges(pairs) {
  const out = new Set();
  for (const [a, b] of pairs) {
    out.add(a);
    out.add(b);
  }
  return [...out];
}

/**
 * Change the cage in place and rebuild.
 *
 * Every Form tab command goes through here, so undo, the dirty flag and the
 * rebuild are in one place rather than repeated fourteen times.
 */
function editCage(label, body, change) {
  const cage = state.doc.forms[body.form];
  if (!cage) {
    setStatus('That form is not in this document any more.');
    return false;
  }
  let next;
  try {
    next = change(cage);
  } catch (err) {
    setStatus(`Could not do that: ${err.message}`);
    return false;
  }
  if (!next) return false;

  pushUndo(label);
  next.name = cage.name;
  state.doc.forms[body.form] = next;
  state.dirty = true;
  clearGeometrySelection(false);
  rebuildAll();
  return true;
}

/* -------- creating a form -------- */

/**
 * Start a form from one of the shapes worth starting from.
 *
 * A cage rather than a surface: what appears is a handful of faces you can
 * grab, and the smooth shape they stand for. The primitives are the ones Fusion
 * offers, and the quadball is the one to reach for when the answer is round,
 * because it has no poles and so no pinch in the surface.
 */
function startFormPrimitive(shape) {
  if (state.sketcher.active) finishSketch();
  const id = uid('form');
  const feature = {
    id: uid('f'),
    type: 'form',
    form: id,
    shape,
    plane: 'XY',
    levels: '2',
    display: 'control',
    params: {
      width: '40',
      depth: '40',
      height: '40',
      radius: '20',
      tubeRadius: '6',
      length: '60',
      sides: '8',
      rows: '3',
      divisions: '2',
      nx: '2',
      ny: '2',
      nz: '2',
      capped: true,
      x: '0',
      y: '0',
      z: '0'
    }
  };
  state.doc.forms[id] = { ...buildFormCage(feature), name: formName() };
  openFeatureEditor(feature, `Form: ${shape}`, formFields(feature));
}

/** A name that is not already taken. */
function formName() {
  const used = new Set(Object.values(state.doc.forms || {}).map((f) => f.name));
  let n = 1;
  while (used.has(`Form ${n}`)) n++;
  return `Form ${n}`;
}

/** The cage a primitive's settings describe. */
function buildFormCage(feature) {
  const scope = resolveParameters(state.doc.parameters).scope;
  const num = (k, d) => safeEval(feature.params[k], scope, d);
  const plane = resolvePlane(feature.plane || 'XY', scope, state.result?.construction);
  const base = plane || { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };
  // Where on that plane it sits. A form is placed like anything else, and
  // without this every form in a document is built on top of the last.
  const p = {
    ...base,
    origin: [
      base.origin[0] + num('x', 0),
      base.origin[1] + num('y', 0),
      base.origin[2] + num('z', 0)
    ]
  };

  switch (feature.shape) {
    case 'plane':
      return FM.planeCage(p, num('width', 40), num('depth', 40), num('nx', 2), num('ny', 2));
    case 'cylinder':
      return FM.cylinderCage(
        p,
        num('radius', 20),
        num('length', 60),
        num('sides', 8),
        num('rows', 3),
        feature.params.capped !== false
      );
    case 'sphere':
      return FM.sphereCage(p, num('radius', 20), num('sides', 8), num('rows', 6));
    case 'torus':
      return FM.torusCage(p, num('radius', 20), num('tubeRadius', 6), num('sides', 12), num('rows', 8));
    case 'quadball':
      return FM.quadballCage(p, num('radius', 20), num('divisions', 2));
    default:
      return FM.boxCage(
        p,
        [num('width', 40), num('depth', 40), num('height', 40)],
        [num('nx', 2), num('ny', 2), num('nz', 2)]
      );
  }
}

/**
 * Rebuild the cage when a primitive's settings change.
 *
 * Only while the dialog that made it is open: once it is accepted the cage has
 * been shaped by hand and rebuilding it from a width and a height would throw
 * that away.
 */
function refreshFormCage(feature) {
  if (!feature?.form || !state.doc.forms[feature.form]) return;
  const name = state.doc.forms[feature.form].name;
  state.doc.forms[feature.form] = { ...buildFormCage(feature), name };
}

/* -------- editing the cage -------- */

function withForm(what, run) {
  if (state.sketcher.active) finishSketch();
  const body = activeForm();
  if (!body) {
    setStatus(`${what} works on a form. Make one from the Form tab first.`);
    return;
  }
  run(body);
}

function cmdFormSubdivideFaces() {
  withForm('Subdivide', (body) => {
    const faces = selectedCageFaces(body);
    if (!faces.length) {
      setStatus('Select the faces to subdivide.');
      return;
    }
    if (editCage('subdivide faces', body, (cage) => FM.subdivideFaces(cage, faces))) {
      setStatus(`${faces.length} face${faces.length === 1 ? '' : 's'} subdivided.`);
    }
  });
}

function cmdFormInsertEdge() {
  withForm('Insert Edge', (body) => {
    const edges = selectedCageEdges(body);
    if (!edges.length) {
      setStatus('Select an edge to run the new loop across.');
      return;
    }
    const [a, b] = edges[0];
    if (editCage('insert edge', body, (cage) => FM.insertEdgeLoop(cage, a, b, 0.5))) {
      setStatus('Edge loop inserted.');
    } else {
      setStatus('That edge is not on a run of quads, so there is no loop to insert.');
    }
  });
}

function cmdFormInsertPoint() {
  withForm('Insert Point', (body) => {
    const edges = selectedCageEdges(body);
    if (!edges.length) {
      setStatus('Select the edge to put a point in.');
      return;
    }
    const [a, b] = edges[0];
    if (editCage('insert point', body, (cage) => FM.insertPoint(cage, a, b))) {
      setStatus('Point inserted.');
    }
  });
}

function cmdFormDeleteFaces() {
  withForm('Delete', (body) => {
    const faces = selectedCageFaces(body);
    if (!faces.length) {
      setStatus('Select the faces to delete.');
      return;
    }
    if (editCage('delete faces', body, (cage) => FM.deleteFaces(cage, faces))) {
      setStatus(`${faces.length} face${faces.length === 1 ? '' : 's'} deleted.`);
    }
  });
}

function cmdFormFillHole() {
  withForm('Fill Hole', (body) => {
    const cage = state.doc.forms[body.form];
    const loops = FM.boundaryLoops(cage);
    if (!loops.length) {
      setStatus('There are no holes in this form.');
      return;
    }
    if (
      editCage('fill hole', body, (c) => {
        let out = c;
        for (const loop of FM.boundaryLoops(c)) {
          const next = FM.fillHole(out, loop, loop.length > 5 ? 'fan' : 'single');
          if (next) out = next;
        }
        return out;
      })
    ) {
      setStatus(`${loops.length} hole${loops.length === 1 ? '' : 's'} filled.`);
    }
  });
}

function cmdFormBridge() {
  withForm('Bridge', (body) => {
    const cage = state.doc.forms[body.form];
    const loops = FM.boundaryLoops(cage);
    if (loops.length < 2) {
      setStatus('Bridge joins two openings. Delete a face at each end first.');
      return;
    }
    if (loops[0].length !== loops[1].length) {
      setStatus(
        `Those two openings have ${loops[0].length} and ${loops[1].length} edges. A bridge needs the same number at each end.`
      );
      return;
    }
    const segments = 2;
    if (editCage('bridge', body, (c) => {
      const l = FM.boundaryLoops(c);
      return FM.bridge(c, l[0], l[1], segments);
    })) {
      setStatus('Bridged.');
    }
  });
}

function cmdFormCrease(on) {
  withForm(on ? 'Crease' : 'Uncrease', (body) => {
    const edges = selectedCageEdges(body);
    if (!edges.length) {
      setStatus(`Select the edges to ${on ? 'crease' : 'uncrease'}.`);
      return;
    }
    if (
      editCage(on ? 'crease' : 'uncrease', body, (cage) =>
        FM.creaseEdges(cage, edges, on ? 2 : 0)
      )
    ) {
      setStatus(
        `${edges.length} edge${edges.length === 1 ? '' : 's'} ${on ? 'creased' : 'uncreased'}.`
      );
    }
  });
}

function cmdFormWeld(unweld) {
  withForm(unweld ? 'Unweld' : 'Weld', (body) => {
    const verts = pointsOfEdges(selectedCageEdges(body));
    if (!verts.length) {
      setStatus('Select edges whose ends should be joined.');
      return;
    }
    if (
      editCage(unweld ? 'unweld' : 'weld', body, (cage) =>
        unweld ? FM.unweldVertices(cage, verts) : FM.weldVertices(cage, verts, 1e-3)
      )
    ) {
      setStatus(`${verts.length} point${verts.length === 1 ? '' : 's'} ${unweld ? 'unwelded' : 'welded'}.`);
    }
  });
}

/**
 * Build a form from curves that are already drawn.
 *
 * The six primitives are for starting from nothing. This is for starting from
 * a shape that has already been worked out in a sketch, which is what most
 * forms really begin as: a section and a path, or two sections to run between.
 *
 * A cage is not the surface it stands for. The surface lies inside the cage, so
 * a form built on a drawn curve runs near that curve rather than exactly
 * through it. Every package that does this behaves the same way, and it is the
 * whole difference between a form and a loft: a loft goes through the sections
 * given, and there is already a Loft for when that is what is wanted.
 */
function cmdFormFromCurve(kind) {
  if (state.sketcher.active) finishSketch();
  const sketches = sketchesWithCurves();
  if (!sketches.length) {
    setStatus('Draw the curve to build on first.');
    return;
  }
  const needsPath = kind === 'sweep' || kind === 'pipe';
  const needsSecond = kind === 'loft';
  if ((needsPath || needsSecond) && sketches.length < 2) {
    setStatus(
      needsPath
        ? 'This needs two sketches: the shape, and the path it follows.'
        : 'A loft needs two sketches to run between.'
    );
    return;
  }

  const titles = {
    extrude: 'Form: Extrude a curve',
    revolve: 'Form: Revolve a curve',
    sweep: 'Form: Sweep a curve',
    loft: 'Form: Loft between sketches',
    pipe: 'Form: Pipe along a path'
  };
  const list = sketches.map((sk) => [sk.id, sk.name]);
  const kept = state.formCurve || {};

  const fields = [
    {
      key: 'profile',
      label: kind === 'pipe' ? 'Path' : kind === 'loft' ? 'First sketch' : 'Shape',
      type: 'select',
      value: kept.profile || list[0][0],
      options: list
    }
  ];
  if (needsPath) {
    fields.push({
      key: 'path',
      label: 'Path',
      type: 'select',
      value: kept.path || list[Math.min(1, list.length - 1)][0],
      options: list
    });
  }
  if (needsSecond) {
    fields.push({
      key: 'second',
      label: 'Second sketch',
      type: 'select',
      value: kept.second || list[Math.min(1, list.length - 1)][0],
      options: list
    });
  }
  if (kind === 'extrude') {
    fields.push({ key: 'distance', label: 'How far', type: 'expr', value: kept.distance || '40' });
  }
  if (kind === 'revolve') {
    fields.push(
      {
        key: 'axis',
        label: 'About which axis',
        type: 'select',
        value: kept.axis || 'w:z',
        options: axisOptions()
      },
      { key: 'angle', label: 'How far round', type: 'expr', value: kept.angle || '360' },
      { key: 'sides', label: 'Faces round', type: 'expr', value: kept.sides || '8' }
    );
  }
  if (kind === 'pipe') {
    fields.push(
      { key: 'radius', label: 'Radius', type: 'expr', value: kept.radius || '5' },
      { key: 'sides', label: 'Faces round', type: 'expr', value: kept.sides || '8' }
    );
  }
  if (kind !== 'pipe') {
    fields.push({ key: 'points', label: 'Points along the shape', type: 'expr', value: kept.points || '8' });
  }
  fields.push({ key: 'rows', label: 'Rows along it', type: 'expr', value: kept.rows || '4' });
  fields.push({
    key: '__note',
    label: '',
    type: 'note',
    text: 'The cage runs on the curve; the surface it stands for lies inside it. Use a Loft if it has to pass through the section exactly.'
  });

  showInspector(titles[kind], fields, (v) => {
    state.formCurve = { ...state.formCurve, ...v };
    const scope = resolveParameters(state.doc.parameters);
    const num = (k, d) => safeEval(v[k], scope, d);
    const profile = worldRunOfSketch(v.profile);
    if (!profile) {
      setStatus('That sketch has no chain of curves in it.');
      return;
    }
    const opts = {
      points: Math.round(num('points', 8)),
      rows: Math.round(num('rows', 4)),
      sides: Math.round(num('sides', 8)),
      closed: !!profile.closed
    };

    let cage = null;
    if (kind === 'extrude') {
      const plane = sketchPlaneOf(v.profile);
      const n = plane ? plane.n : [0, 0, 1];
      const d = num('distance', 40);
      cage = FM.extrudeRunCage(profile, [n[0] * d, n[1] * d, n[2] * d], opts);
    } else if (kind === 'revolve') {
      const axis = worldAxisFor(axisSpecFromOption(v.axis));
      if (!axis) {
        setStatus('That axis could not be worked out.');
        return;
      }
      cage = FM.revolveRunCage(profile, axis.origin, axis.dir, num('angle', 360), opts);
    } else if (kind === 'sweep') {
      const path = worldRunOfSketch(v.path);
      if (!path) {
        setStatus('That path sketch has no chain of curves in it.');
        return;
      }
      cage = FM.sweepRunCage(profile, path, opts);
    } else if (kind === 'loft') {
      const second = worldRunOfSketch(v.second);
      if (!second) {
        setStatus('That second sketch has no chain of curves in it.');
        return;
      }
      cage = FM.loftRunsCage([profile, second], opts);
    } else if (kind === 'pipe') {
      cage = FM.pipeRunCage(profile, num('radius', 5), opts);
    }

    if (!cage) {
      setStatus('Nothing could be built from those curves.');
      return;
    }
    addFormBody(cage, titles[kind]);
  });
}

/** A cage from three or four picked points, which is the smallest form there is. */
function cmdFormFace() {
  if (state.sketcher.active) finishSketch();
  const picked = [];
  for (const record of state.records || []) {
    if (!record.topology) continue;
    for (const key of state.selection.edges) {
      const { bodyId, index } = splitKey(key);
      if (bodyId !== record.id) continue;
      const edge = record.topology.edges[index];
      if (edge?.points?.length) picked.push(edge.points[0], edge.points[edge.points.length - 1]);
    }
  }
  // Points that are the same place are one corner, whichever edge they came off.
  const corners = [];
  for (const p of picked) {
    if (!corners.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-4)) {
      corners.push(p.slice());
    }
  }
  if (corners.length < 3 || corners.length > 4) {
    setStatus(`A face needs three or four corners. Those edges gave ${corners.length}.`);
    return;
  }
  addFormBody(FM.faceCage(corners), 'Form: Face');
}

/** Put a built cage into the document as a form body. */
function addFormBody(cage, label) {
  if (!cage?.faces?.length) {
    setStatus('Nothing to build.');
    return;
  }
  pushUndo(label);
  const id = uid('form');
  state.doc.forms[id] = { ...cage, name: formName() };
  state.doc.features.push({
    id: uid('f'),
    type: 'form',
    form: id,
    shape: 'custom',
    levels: '2',
    display: 'control'
  });
  state.dirty = true;
  clearGeometrySelection(false);
  rebuildAll();
  setTab('form');
  setStatus(`${cage.points.length} points, ${cage.faces.length} faces.`);
}

/** Every sketch with a chain of curves in it, which is what these can build on. */
function sketchesWithCurves() {
  const out = [];
  for (const f of state.doc.features) {
    if (f.type !== 'sketch') continue;
    const sk = state.doc.sketches[f.sketch];
    if (sk && sk.entities.some((e) => e.type !== 'point')) out.push(sk);
  }
  return out;
}

/** The plane a sketch is drawn on, in world terms. */
function sketchPlaneOf(sketchId) {
  const sk = state.doc.sketches[sketchId];
  if (!sk) return null;
  const scope = resolveParameters(state.doc.parameters).scope;
  return resolvePlane(sk.plane, scope, state.result?.construction);
}

/**
 * A sketch's curves as one run of world points, in order along the chain.
 *
 * A closed chain comes back with its last point dropped. Left in, it is the
 * first point again, and a cage that wraps round would have a face whose two
 * ends are the same corner.
 */
function worldRunOfSketch(sketchId) {
  const sk = state.doc.sketches[sketchId];
  if (!sk) return null;
  const plane = sketchPlaneOf(sketchId);
  const chain = chainPath(sk, {});
  if (!chain?.points?.length) return null;
  const pts = chain.points.map((q) => {
    const w = sketchToWorld(plane, q.x, q.y, q.z || 0);
    return [w.x, w.y, w.z];
  });
  const first = pts[0];
  const last = pts[pts.length - 1];
  const meets = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]) < 1e-6;
  const run = meets && pts.length > 3 ? pts.slice(0, -1) : pts;
  run.closed = !!chain.closed || meets;
  return run;
}

/**
 * The sculpting verbs, which all work on what is picked in the cage.
 *
 * Every one of them takes points or edges rather than a dialog full of numbers,
 * because the whole way a form is worked is pick, do, look. The few that need a
 * number ask for one and remember it.
 */
function cmdFormSmooth() {
  withForm('Smooth', (body) => {
    const verts = cageVertsFromSelection(body);
    if (!verts.length) {
      setStatus('Select the points or edges to relax.');
      return;
    }
    const kept = state.formSmooth || { strength: '0.5', iterations: '2' };
    showInspector(
      'Smooth',
      [
        { key: 'strength', label: 'How far each pass goes', type: 'expr', value: kept.strength },
        { key: 'iterations', label: 'Passes', type: 'expr', value: kept.iterations },
        {
          key: '__note',
          label: '',
          type: 'note',
          text: `${verts.length} point${verts.length === 1 ? '' : 's'}. Two gentle passes land in nearly the same place as one hard one and keep more of the shape.`
        }
      ],
      (v) => {
        state.formSmooth = { ...v };
        const scope = resolveParameters(state.doc.parameters);
        const strength = safeEval(v.strength, scope, 0.5);
        const iterations = Math.round(safeEval(v.iterations, scope, 2));
        if (editCage('smooth', body, (cage) => FM.smoothPoints(cage, verts, { strength, iterations }))) {
          setStatus(`${verts.length} point${verts.length === 1 ? '' : 's'} relaxed.`);
        }
      }
    );
  });
}

function cmdFormStraighten() {
  withForm('Straighten', (body) => {
    const verts = cageVertsFromSelection(body);
    if (verts.length < 3) {
      setStatus('Select three or more points, or the edges through them.');
      return;
    }
    if (editCage('straighten', body, (cage) => FM.straightenPoints(cage, verts))) {
      setStatus(`${verts.length} points brought onto one line.`);
    }
  });
}

function cmdFormCylindrify() {
  withForm('Cylindrify', (body) => {
    const verts = cageVertsFromSelection(body);
    if (verts.length < 3) {
      setStatus('Select three or more points, or the edges through them.');
      return;
    }
    const kept = state.formCyl || { axis: '', radius: '' };
    showInspector(
      'Cylindrify',
      [
        {
          key: 'axis',
          label: 'About which axis',
          type: 'select',
          value: kept.axis,
          options: [['', 'Work it out from the points'], ...axisOptions()]
        },
        { key: 'radius', label: 'Radius, blank to keep what it is', type: 'text', value: kept.radius },
        {
          key: '__note',
          label: '',
          type: 'note',
          text: 'Worked out from the points, the axis is the direction they vary in most. That is right along a shaft and wrong around one, so say which for a ring.'
        }
      ],
      (v) => {
        state.formCyl = { ...v };
        const scope = resolveParameters(state.doc.parameters);
        const opts = {};
        if (v.axis) {
          const axis = worldAxisFor(axisSpecFromOption(v.axis));
          if (axis) {
            opts.dir = axis.dir;
            opts.origin = axis.origin;
          }
        }
        const r = String(v.radius || '').trim();
        if (r) opts.radius = safeEval(r, scope, 0);
        if (editCage('cylindrify', body, (cage) => FM.cylindrifyPoints(cage, verts, opts))) {
          setStatus(`${verts.length} points brought onto a cylinder.`);
        }
      }
    );
  });
}

function cmdFormSlide() {
  withForm('Slide Edge', (body) => {
    const verts = pointsOfEdges(selectedCageEdges(body));
    if (verts.length < 2) {
      setStatus('Select the edges to slide.');
      return;
    }
    const kept = state.formSlide || { amount: '0.25' };
    showInspector(
      'Slide Edge',
      [
        { key: 'amount', label: 'How far, minus one to one', type: 'expr', value: kept.amount },
        {
          key: '__note',
          label: '',
          type: 'note',
          text: 'The edges run along the surface rather than off it, so the shape is kept and only the spacing changes. Negative goes the other way.'
        }
      ],
      (v) => {
        state.formSlide = { ...v };
        const scope = resolveParameters(state.doc.parameters);
        const t = Math.max(-0.9, Math.min(0.9, safeEval(v.amount, scope, 0.25)));
        if (editCage('slide edge', body, (cage) => FM.slideEdges(cage, verts, t))) {
          setStatus(`${verts.length} points slid.`);
        }
      }
    );
  });
}

function cmdFormBevel() {
  withForm('Bevel Edge', (body) => {
    const edges = selectedCageEdges(body);
    if (!edges.length) {
      setStatus('Select an edge to bevel.');
      return;
    }
    const kept = state.formBevel || { offset: '0.2' };
    showInspector(
      'Bevel Edge',
      [
        { key: 'offset', label: 'How tight, 0.01 to 0.49', type: 'expr', value: kept.offset },
        {
          key: '__note',
          label: '',
          type: 'note',
          text: 'A bevel on a cage is an edge either side rather than a cut face. One edge smooths away; two close together hold the shape.'
        }
      ],
      (v) => {
        state.formBevel = { ...v };
        const scope = resolveParameters(state.doc.parameters);
        const offset = safeEval(v.offset, scope, 0.2);
        const [a, b] = edges[0];
        if (editCage('bevel edge', body, (cage) => FM.bevelEdge(cage, a, b, offset))) {
          setStatus('Edge bevelled.');
        }
      }
    );
  });
}

function cmdFormErase() {
  withForm('Erase And Fill', (body) => {
    const edges = selectedCageEdges(body);
    if (!edges.length) {
      setStatus('Select the edges to take out.');
      return;
    }
    if (editCage('erase and fill', body, (cage) => FM.eraseAndFill(cage, edges))) {
      setStatus(`${edges.length} edge${edges.length === 1 ? '' : 's'} taken out, the faces merged.`);
    } else {
      setStatus('Those edges are on the rim, so there is nothing on the other side to merge into.');
    }
  });
}

/**
 * Join two open edges into one.
 *
 * Both runs have to be the same length. This is a merge, not a fit: joining
 * runs divided differently would put a crease along the seam, and a crease that
 * was never asked for is worse than being told the two do not match.
 */
function cmdFormMergeEdge() {
  withForm('Merge Edge', (body) => {
    const edges = selectedCageEdges(body);
    const runs = openRunsFrom(body, edges);
    if (!runs || runs.length !== 2) {
      setStatus('Select two open edges of the same length, one from each side of the seam.');
      return;
    }
    const [a, b] = runs;
    if (a.length !== b.length) {
      setStatus(`Those runs are ${a.length} and ${b.length} points. They have to match.`);
      return;
    }
    if (editCage('merge edge', body, (cage) => FM.mergeEdgeRuns(cage, a, b))) {
      setStatus(`${a.length} pairs of points joined.`);
    }
  });
}

function cmdFormFreeze(on) {
  withForm(on ? 'Freeze' : 'Unfreeze', (body) => {
    const verts = cageVertsFromSelection(body);
    if (!verts.length) {
      setStatus(on ? 'Select the points to pin.' : 'Select the points to let go.');
      return;
    }
    if (editCage(on ? 'freeze' : 'unfreeze', body, (cage) => FM.setFrozen(cage, verts, on))) {
      setStatus(
        on
          ? `${verts.length} point${verts.length === 1 ? '' : 's'} pinned. Nothing will move them.`
          : `${verts.length} point${verts.length === 1 ? '' : 's'} let go.`
      );
    }
  });
}

function cmdFormInterpolate(on) {
  withForm(on ? 'Interpolate' : 'Un-interpolate', (body) => {
    const verts = cageVertsFromSelection(body);
    if (!verts.length) {
      setStatus('Select the points the surface should pass through.');
      return;
    }
    if (editCage(on ? 'interpolate' : 'un-interpolate', body, (cage) => FM.setInterpolated(cage, verts, on))) {
      setStatus(
        on
          ? `The surface now passes through ${verts.length} point${verts.length === 1 ? '' : 's'}.`
          : `${verts.length} point${verts.length === 1 ? '' : 's'} back to smooth.`
      );
    }
  });
}

/**
 * Bring part of a form onto a curve.
 *
 * Two commands over one operation, because the two things people want here are
 * opposite ways round. Match takes an open edge of a form that is nearly where
 * it belongs and puts it exactly on the edge of something else, so the two meet.
 * Edit By Curve takes a row of points and lays them out along a curve from one
 * end to the other, which moves them a long way on purpose and is how a form is
 * made to follow a line that was drawn for it.
 *
 * The curve is whatever edges are picked on another body. Nothing new has to be
 * learned to say where it is, and an edge of a solid is the commonest thing a
 * form has to meet.
 */
function cmdFormMatch(mode) {
  const title = mode === 'spread' ? 'Edit Form By Curve' : 'Match';
  withForm(title, (body) => {
    const verts = cageVertsFromSelection(body);
    if (!verts.length) {
      setStatus(`Select the form points to move, and the edges to ${mode === 'spread' ? 'follow' : 'meet'}.`);
      return;
    }
    const target = targetRunApartFrom(body.id);
    if (!target) {
      setStatus('Also select the edges on another body that say where they should go.');
      return;
    }

    const kept = state.formMatch || { strength: '1', extent: 'none', faces: '2' };
    showInspector(
      title,
      [
        { key: 'strength', label: 'How far of the way there', type: 'expr', value: kept.strength },
        {
          key: 'extent',
          label: 'Does the rest follow',
          type: 'select',
          value: mode === 'spread' ? kept.extent || 'faces' : 'none',
          options: [
            ['none', 'Only the points picked'],
            ['faces', 'And the rows behind them']
          ]
        },
        { key: 'faces', label: 'How many rows', type: 'expr', value: kept.faces },
        {
          key: '__note',
          label: '',
          type: 'note',
          text:
            mode === 'spread'
              ? `${verts.length} point${verts.length === 1 ? '' : 's'} laid out along ${target.length} points of curve, evenly from one end to the other.`
              : `${verts.length} point${verts.length === 1 ? '' : 's'} onto the nearest place on the curve.`
        }
      ],
      (v) => {
        state.formMatch = { ...v };
        const scope = resolveParameters(state.doc.parameters);
        const strength = safeEval(v.strength, scope, 1);
        const faces = Math.round(safeEval(v.faces, scope, 2));

        const done = editCage(mode === 'spread' ? 'edit by curve' : 'match', body, (cage) => {
          const opts = { mode, strength };
          if (v.extent === 'faces') {
            const adj = FM.adjacency(cage);
            opts.adjacency = adj;
            opts.weights = FM.softWeights(cage, verts, { extent: 'faces', faces }, adj);
          }
          return FM.matchPoints(cage, verts, target, opts);
        });
        if (done) {
          setStatus(
            mode === 'spread'
              ? `${verts.length} point${verts.length === 1 ? '' : 's'} laid along the curve.`
              : `${verts.length} point${verts.length === 1 ? '' : 's'} brought onto the curve.`
          );
        }
      }
    );
  });
}

/**
 * The picked edges of every body except this one, chained into one curve.
 *
 * Chained rather than taken as a bag: two edges of a fillet run end to end and
 * are one curve, and laying points along them in the order they were clicked
 * would double back.
 */
function targetRunApartFrom(bodyId) {
  const runs = [];
  for (const key of state.selection.edges) {
    const { bodyId: owner, index } = splitKey(key);
    if (owner === bodyId) continue;
    const record = (state.records || []).find((r) => r.id === owner);
    const edge = record?.topology?.edges[index];
    if (edge?.points?.length > 1) runs.push(edge.points.map((p) => p.slice()));
  }
  if (!runs.length) return null;
  if (runs.length === 1) return runs[0];

  // Join them end to end, taking whichever loose end is nearest each time.
  const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const out = runs.shift();
  let guard = 0;
  while (runs.length && guard++ < 512) {
    const tail = out[out.length - 1];
    let best = null;
    runs.forEach((run, i) => {
      for (const flip of [false, true]) {
        const ends = flip ? run.slice().reverse() : run;
        const d = gap(tail, ends[0]);
        if (!best || d < best.d) best = { d, i, ends };
      }
    });
    if (!best) break;
    runs.splice(best.i, 1);
    out.push(...best.ends.slice(1));
  }
  return out;
}

/** Cage points from whatever is picked: faces, edges, or both. */
function cageVertsFromSelection(body) {
  const out = new Set(pointsOfEdges(selectedCageEdges(body)));
  const cage = body.cage;
  if (cage) {
    for (const fi of selectedCageFaces(body)) {
      for (const v of cage.faces[fi] || []) out.add(v);
    }
  }
  return [...out];
}

/**
 * The picked edges walked into runs along the open rim.
 *
 * A merge needs two runs and needs to know which points pair with which, and
 * the only way to know that is to follow each rim in order rather than to take
 * the picked edges as a bag.
 */
function openRunsFrom(body, edges) {
  const cage = body.cage;
  if (!cage || !edges.length) return null;
  const wanted = new Set(edges.map(([a, b]) => `${Math.min(a, b)}_${Math.max(a, b)}`));
  const next = new Map();
  for (const [a, b] of edges) {
    if (!next.has(a)) next.set(a, []);
    if (!next.has(b)) next.set(b, []);
    next.get(a).push(b);
    next.get(b).push(a);
  }

  const runs = [];
  const used = new Set();
  for (const start of next.keys()) {
    if (used.has(start) || next.get(start).length !== 1) continue;
    const run = [start];
    used.add(start);
    let at = start;
    let guard = 0;
    while (guard++ < 4096) {
      const onward = (next.get(at) || []).find((n) => !used.has(n));
      if (onward === undefined) break;
      if (!wanted.has(`${Math.min(at, onward)}_${Math.max(at, onward)}`)) break;
      run.push(onward);
      used.add(onward);
      at = onward;
    }
    if (run.length > 1) runs.push(run);
  }
  return runs;
}

function cmdFormFlatten() {
  withForm('Flatten', (body) => {
    const verts = pointsOfEdges(selectedCageEdges(body));
    if (!verts.length) {
      setStatus('Select the edges whose points should be brought onto a plane.');
      return;
    }
    const scope = resolveParameters(state.doc.parameters).scope;
    const plane = resolvePlane('XY', scope, state.result?.construction);
    if (editCage('flatten', body, (cage) => FM.flatten(cage, verts, plane))) {
      setStatus(`${verts.length} points flattened onto XY.`);
    }
  });
}

function cmdFormMakeUniform() {
  withForm('Make Uniform', (body) => {
    if (editCage('make uniform', body, (cage) => FM.makeUniform(cage, 3))) {
      setStatus('Cage evened out.');
    }
  });
}

function cmdFormMirror() {
  withForm('Mirror Internal', (body) => {
    const scope = resolveParameters(state.doc.parameters).scope;
    const plane = resolvePlane('YZ', scope, state.result?.construction);
    if (editCage('mirror internal', body, (cage) => FM.mirrorInternal(cage, plane))) {
      setStatus('Symmetric about YZ. Both halves move together from now on.');
    } else {
      setStatus('Nothing lies on the near side of that plane.');
    }
  });
}

function cmdFormCircular() {
  withForm('Circular Internal', (body) => {
    const scope = resolveParameters(state.doc.parameters).scope;
    void scope;
    const count = 6;
    if (
      editCage('circular internal', body, (cage) =>
        FM.circularInternal(cage, { origin: [0, 0, 0], dir: [0, 0, 1] }, count)
      )
    ) {
      setStatus(`Repeated ${count} times about Z.`);
    } else {
      setStatus('Nothing lies in the first wedge about that axis.');
    }
  });
}

function cmdFormClearSymmetry() {
  withForm('Clear Symmetry', (body) => {
    if (editCage('clear symmetry', body, (cage) => FM.clearSymmetry(cage))) {
      setStatus('Symmetry cleared. The halves move on their own now.');
    }
  });
}

/** How the form is drawn: the cage, both, or the surface it stands for. */
function cmdFormDisplay(mode) {
  const body = activeForm();
  if (!body) {
    setStatus('Display Mode works on a form.');
    return;
  }
  const feature = state.doc.features.find((f) => f.id === body.createdBy);
  if (!feature) return;
  pushUndo('display mode');
  feature.display = mode;
  state.dirty = true;
  rebuildAll();
  setStatus(
    mode === 'box'
      ? 'The cage on its own.'
      : mode === 'smooth'
        ? 'The surface on its own. Nothing on it can be picked.'
        : 'The cage over the surface it stands for.'
  );
}

function cmdFinishForm() {
  if (state.sketcher.active) finishSketch();
  if (!formBodies().length) {
    setStatus('Finish Form turns a form into a solid. There are none yet.');
    return;
  }
  const chosen = formBodies().filter((b) => state.selection.bodies.has(b.id));
  const feature = {
    id: uid('f'),
    type: 'finishForm',
    bodies: (chosen.length ? chosen : formBodies()).map((b) => b.id),
    levels: '3',
    op: 'new',
    targets: 'all'
  };
  openFeatureEditor(feature, 'Finish Form', finishFormFields());
}

/**
 * Put a form body back into a state the subdivision can work on.
 *
 * The faults this finds do not show on screen. A point dragged onto another
 * point, a face left with two corners in the same place, the same face made
 * twice: the cage looks right and the smooth surface it stands for develops a
 * crease out of nowhere or a hole where there is plainly a face. Looking for
 * that by eye is the worst hour in modelling and this is a second.
 *
 * Filling holes is offered and not assumed. A form that is open is a normal
 * thing, and closing one is a change of shape rather than a repair.
 */
function cmdFormRepair() {
  if (state.sketcher.active) finishSketch();
  const forms = formBodies();
  if (!forms.length) {
    setStatus('Repair works on a form. There are none yet.');
    return;
  }
  const chosen = forms.filter((b) => state.selection.bodies.has(b.id));
  const targets = chosen.length ? chosen : forms;

  showInspector(
    'Repair Body',
    [
      { key: 'tolerance', label: 'Points closer than this are one point', type: 'expr', value: '0.01' },
      { key: 'fillHoles', label: 'Close any holes as well', type: 'bool', value: false },
      {
        key: '__note',
        label: '',
        type: 'note',
        text: `${targets.length} form${targets.length === 1 ? '' : 's'}. A form that is meant to be open is a normal thing, so holes are only closed if you ask.`
      }
    ],
    (v) => {
      const scope = resolveParameters(state.doc.parameters);
      const tolerance = Math.max(1e-6, safeEval(v.tolerance, scope, 0.01));
      const said = [];
      let touched = 0;

      for (const body of targets) {
        let found = null;
        const done = editCage('repair form', body, (cage) => {
          const out = FM.repairCage(cage, { tolerance, fillHoles: !!v.fillHoles });
          found = out.fixed;
          // Nothing wrong means nothing done. Handing back a rebuilt cage would
          // renumber every point and take the creases and the selection with it.
          return found.changed ? out.cage : null;
        });
        if (!found) continue;
        if (done) touched++;
        said.push(`${body.name}: ${repairWords(found)}`);
      }

      if (!said.length) {
        setStatus('Nothing to repair.');
        return;
      }
      showInspector(
        'Repair Body',
        said.map((text, i) => ({ key: `__r${i}`, label: '', type: 'note', text })),
        () => {}
      );
      setStatus(
        touched ? `Repaired ${touched} form${touched === 1 ? '' : 's'}.` : 'Nothing to repair.'
      );
    }
  );
}

/** What a repair did, in words rather than a row of counters. */
function repairWords(fixed) {
  const parts = [];
  const say = (n, one, many) => {
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  say(fixed.welded, 'point joined to another', 'points joined to others');
  say(fixed.degenerate, 'face that was no longer a face', 'faces that were no longer faces');
  say(fixed.duplicate, 'face made twice', 'faces made twice');
  say(fixed.orphaned, 'point nothing used', 'points nothing used');
  say(fixed.filled, 'hole closed', 'holes closed');
  say(fixed.flipped, 'face turned the right way', 'faces turned the right way');
  return parts.length ? parts.join(', ') : 'nothing wrong with it';
}

function cmdFormThicken() {
  if (state.sketcher.active) finishSketch();
  if (!formBodies().length) {
    setStatus('Thicken works on a form. There are none yet.');
    return;
  }
  const chosen = formBodies().filter((b) => state.selection.bodies.has(b.id));
  const feature = {
    id: uid('f'),
    type: 'formThicken',
    bodies: (chosen.length ? chosen : formBodies()).map((b) => b.id),
    levels: '3',
    distance: '2',
    symmetric: false,
    keepForm: false,
    op: 'new',
    targets: 'all'
  };
  openFeatureEditor(feature, 'Thicken Form', formThickenFields());
}

/* -------- the fields those dialogs show -------- */

function formFields(feature) {
  const shape = feature.shape || 'box';
  const size = {
    box: [
      { key: 'params.width', label: 'Width', type: 'expr' },
      { key: 'params.depth', label: 'Depth', type: 'expr' },
      { key: 'params.height', label: 'Height', type: 'expr' },
      { key: 'params.nx', label: 'Faces across X', type: 'expr' },
      { key: 'params.ny', label: 'Faces across Y', type: 'expr' },
      { key: 'params.nz', label: 'Faces across Z', type: 'expr' }
    ],
    plane: [
      { key: 'params.width', label: 'Width', type: 'expr' },
      { key: 'params.depth', label: 'Depth', type: 'expr' },
      { key: 'params.nx', label: 'Faces across', type: 'expr' },
      { key: 'params.ny', label: 'Faces along', type: 'expr' }
    ],
    cylinder: [
      { key: 'params.radius', label: 'Radius', type: 'expr' },
      { key: 'params.length', label: 'Height', type: 'expr' },
      { key: 'params.sides', label: 'Faces round', type: 'expr' },
      { key: 'params.rows', label: 'Faces up', type: 'expr' },
      { key: 'params.capped', label: 'Closed ends', type: 'bool' }
    ],
    sphere: [
      { key: 'params.radius', label: 'Radius', type: 'expr' },
      { key: 'params.sides', label: 'Faces round', type: 'expr' },
      { key: 'params.rows', label: 'Faces pole to pole', type: 'expr' }
    ],
    torus: [
      { key: 'params.radius', label: 'Ring radius', type: 'expr' },
      { key: 'params.tubeRadius', label: 'Tube radius', type: 'expr' },
      { key: 'params.sides', label: 'Faces round the ring', type: 'expr' },
      { key: 'params.rows', label: 'Faces round the tube', type: 'expr' }
    ],
    quadball: [
      { key: 'params.radius', label: 'Radius', type: 'expr' },
      { key: 'params.divisions', label: 'Faces per side', type: 'expr' }
    ]
  }[shape];

  return [
    {
      key: 'plane',
      label: 'Plane',
      type: 'select',
      options: [
        ['XY', 'XY'],
        ['XZ', 'XZ'],
        ['YZ', 'YZ']
      ]
    },
    ...size,
    { key: 'params.x', label: 'X', type: 'expr' },
    { key: 'params.y', label: 'Y', type: 'expr' },
    { key: 'params.z', label: 'Z', type: 'expr' },
    { key: 'levels', label: 'Smoothness', type: 'expr' },
    {
      key: 'display',
      label: 'Display',
      type: 'select',
      options: [
        ['box', 'Box'],
        ['control', 'Control frame'],
        ['smooth', 'Smooth']
      ]
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'The cage is what you shape and the surface is what it stands for. Once this dialog is accepted the size fields no longer rebuild it, because by then it has been shaped by hand.'
    }
  ];
}

function finishFormFields() {
  return [
    {
      key: '__bodies',
      label: 'Forms',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) => (f.bodies === 'all' ? 'every form' : countOf(f.bodies, 'form')),
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    { key: 'levels', label: 'Smoothness', type: 'expr' },
    {
      key: 'op',
      label: 'Operation',
      type: 'select',
      options: [
        ['new', 'New body'],
        ['join', 'Join'],
        ['cut', 'Cut'],
        ['intersect', 'Intersect']
      ]
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'A form has to be closed to become a solid. One with a hole in it is refused and told so, rather than handed over and quietly wrong.'
    }
  ];
}

function formThickenFields() {
  return [
    {
      key: '__bodies',
      label: 'Forms',
      type: 'pick',
      pick: 'moveBodies',
      summary: (f) => (f.bodies === 'all' ? 'every form' : countOf(f.bodies, 'form')),
      clear: (f) => {
        f.bodies = 'all';
      }
    },
    { key: 'distance', label: 'Thickness', type: 'expr' },
    { key: 'levels', label: 'Smoothness', type: 'expr' },
    { key: 'symmetric', label: 'Both sides', type: 'bool' },
    { key: 'keepForm', label: 'Keep the form too', type: 'bool' }
  ];
}

/* -------- vectors, for the drag arithmetic -------- */

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mulv = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const distance3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Where along a line the pointer's ray comes nearest to it.
 *
 * The standard two-line closest approach, and the one place a sign matters:
 * the vector between the two origins runs from the line to the ray, not the
 * other way, and getting it backwards drags everything the wrong way.
 */
function closestOnLine(ray, origin, dir) {
  const w = sub3(origin, ray.origin);
  const a = dot3(dir, dir);
  const b = dot3(dir, ray.direction);
  const c = dot3(ray.direction, ray.direction);
  const d = dot3(dir, w);
  const e = dot3(ray.direction, w);
  const denom = a * c - b * b;
  // A ray straight down the axis tells you nothing about where along it you
  // are, so the drag holds still rather than leaping.
  if (Math.abs(denom) < 1e-9) return 0;
  return (b * e - c * d) / denom;
}

/** Where the pointer's ray meets a plane, or null if it runs along it. */
function rayPlane(ray, origin, normal) {
  const denom = dot3(normal, ray.direction);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot3(sub3(origin, ray.origin), normal) / denom;
  if (t < 0) return null;
  return addv(ray.origin, mulv(ray.direction, t));
}

/** Which way the camera is looking, for the handle that scales everything. */
function cameraForward() {
  const m = state.vp.camera.matrixWorld.elements;
  return [m[8], m[9], m[10]];
}

/* ---------------------------------------------------------------- */
/* Edit Form                                                         */
/* ---------------------------------------------------------------- */

const TRANSFORM_MODES = [
  ['multi', 'Multi'],
  ['translation', 'Translation'],
  ['rotation', 'Rotation'],
  ['scale', 'Scale']
];

const COORD_SPACES = [
  ['world', 'World space'],
  ['view', 'View space'],
  ['selection', 'Selection space'],
  ['local', 'Local per entity']
];

const SELECT_FILTERS = [
  ['all', 'All'],
  ['vertex', 'Vertex'],
  ['edge', 'Edge'],
  ['face', 'Face'],
  ['body', 'Body']
];

/**
 * Edit Form: the state of a shaping session.
 *
 * Kept on `state` rather than in a feature, because it is a mode you are in
 * rather than a thing in the model. Nothing here is saved: what is saved is the
 * cage, which the drags change.
 */
function newEditForm(body) {
  return {
    bodyId: body.id,
    form: body.form,
    mode: 'multi',
    space: 'world',
    filter: 'all',
    soft: { extent: 'none', transition: 'smooth', distance: 15, faces: 2, weight: 1 },
    vertices: new Set(),
    drag: null
  };
}

/** Whether a shaping session is under way. */
function editingForm() {
  return state.editForm || null;
}

/**
 * Start shaping.
 *
 * The cage is shown over the surface it stands for, because that is the only
 * mode where you can see the shape and grab the thing that makes it at the same
 * time.
 */
function cmdEditForm() {
  if (state.sketcher.active) finishSketch();
  const body = activeForm();
  if (!body) {
    setStatus('Edit Form works on a form. Make one from the Form tab first.');
    return;
  }
  if (state.editForm) {
    endEditForm();
    return;
  }

  const feature = state.doc.features.find((f) => f.id === body.createdBy);
  if (feature && feature.display === 'smooth') {
    feature.display = 'control';
    rebuildAll();
  }

  state.editForm = newEditForm(body);
  // Whatever was already picked comes into the session, so pointing at a face
  // and reaching for Edit Form does what it looks like it does.
  seedEditFormSelection();
  refreshEditForm();
  showInspector('Edit Form', editFormFields(), () => endEditForm());
  setStatus('Drag a handle to move, turn or scale. Escape when done.');
}

function endEditForm() {
  state.editForm = null;
  state.vp.setGizmo(null);
  state.vp.setCagePoints(null);
  hideInspector();
  setStatus('Done shaping.');
}

/** Take whatever faces and edges are picked into the session as points. */
function seedEditFormSelection() {
  const ed = state.editForm;
  if (!ed) return;
  const body = (state.result?.bodies || []).find((b) => b.id === ed.bodyId);
  if (!body) return;
  const cage = state.doc.forms[ed.form];
  for (const fi of selectedCageFaces(body)) {
    for (const v of cage.faces[fi]) ed.vertices.add(v);
  }
  for (const [a, b] of selectedCageEdges(body)) {
    ed.vertices.add(a);
    ed.vertices.add(b);
  }
}

/** Redraw the cage marks and put the manipulator where the selection is. */
function refreshEditForm() {
  const ed = editingForm();
  if (!ed) return;
  const cage = state.doc.forms[ed.form];
  if (!cage) {
    endEditForm();
    return;
  }
  // Points that no longer exist go: a cage can lose points to a weld.
  for (const v of [...ed.vertices]) if (!cage.points[v]) ed.vertices.delete(v);

  state.vp.setCagePoints(cage.points, ed.vertices);
  if (!ed.vertices.size) {
    state.vp.setGizmo(null);
    return;
  }
  state.vp.setGizmo(gizmoFrame(cage, ed), ed.mode);
}

/** Where the manipulator sits, and which way its axes run. */
function gizmoFrame(cage, ed) {
  const verts = [...ed.vertices];
  const camera =
    ed.space === 'view'
      ? (() => {
          const m = state.vp.camera.matrixWorld.elements;
          return {
            x: [m[0], m[1], m[2]],
            y: [m[4], m[5], m[6]],
            z: [m[8], m[9], m[10]]
          };
        })()
      : null;
  const f = FM.selectionFrame(cage, verts, ed.space, camera);
  return { origin: f.origin, x: f.x, y: f.y, z: f.z };
}

/**
 * A click while shaping.
 *
 * The manipulator gets first refusal, then a cage point, then whatever the
 * ordinary picking finds. Returns true when it took the click, so the usual
 * selection does not also happen.
 */
function editFormPointerDown(e) {
  const ed = editingForm();
  if (!ed) return false;

  const handle = state.vp.pickGizmo(e.clientX, e.clientY);
  if (handle) {
    beginGizmoDrag(handle, e);
    return true;
  }

  const cage = state.doc.forms[ed.form];
  const additive = e.shiftKey || e.ctrlKey;

  if (ed.filter === 'vertex' || ed.filter === 'all') {
    const v = state.vp.pickCagePoint(e.clientX, e.clientY);
    if (v !== null && cage.points[v]) {
      if (!additive) ed.vertices.clear();
      if (ed.vertices.has(v) && additive) ed.vertices.delete(v);
      else ed.vertices.add(v);
      refreshEditForm();
      reportEditFormSelection();
      return true;
    }
  }

  const hit = state.vp.pickEntity(e.clientX, e.clientY, {
    edges: ed.filter === 'edge' || ed.filter === 'all'
  });
  if (!hit || hit.bodyId !== ed.bodyId) return false;

  const rec = (state.records || []).find((r) => r.id === ed.bodyId);
  let added = null;
  if (hit.kind === 'edge' && (ed.filter === 'edge' || ed.filter === 'all')) {
    const edge = rec?.topology?.edges[hit.edgeId];
    const ends = edge && [edge.points[0], edge.points[edge.points.length - 1]];
    added = ends ? ends.map((p) => nearestCagePoint(cage, p)).filter((v) => v !== null) : null;
  } else if (hit.kind === 'face' && (ed.filter === 'face' || ed.filter === 'all')) {
    const face = rec?.topology?.faces[hit.faceId];
    const at = face?.src?.face;
    if (at !== undefined && at >= 0) added = cage.faces[at].slice();
  } else if (ed.filter === 'body') {
    added = cage.points.map((_, i) => i);
  }
  if (!added?.length) return false;

  if (!additive) ed.vertices.clear();
  for (const v of added) ed.vertices.add(v);
  refreshEditForm();
  reportEditFormSelection();
  return true;
}

function reportEditFormSelection() {
  const ed = editingForm();
  if (!ed) return;
  const n = ed.vertices.size;
  setStatus(
    n
      ? `${n} point${n === 1 ? '' : 's'} picked. Drag a handle, or shift click to add.`
      : 'Nothing picked. Click the cage.'
  );
}

/**
 * Start a drag on one of the manipulator's handles.
 *
 * Everything the drag needs is worked out once, here: which points move and by
 * how much of the move each takes, where the frame is, and where on the handle
 * the pointer went down. After that a move is arithmetic.
 */
function beginGizmoDrag(handle, e) {
  const ed = editingForm();
  const cage = state.doc.forms[ed.form];
  const frame = gizmoFrame(cage, ed);
  const verts = [...ed.vertices];

  ed.drag = {
    handle,
    frame,
    verts,
    weights: FM.softWeights(cage, verts, ed.soft),
    before: cage,
    start: pointOnHandle(handle, frame, e),
    normals:
      ed.space === 'local'
        ? new Map(verts.map((v) => [v, FM.pointNormal(cage, v)]))
        : null,
    moved: false,
    pointerId: e.pointerId
  };
  try {
    state.vp.canvas.setPointerCapture(e.pointerId);
  } catch {
    /* some pointers cannot be captured, and the drag still works in the canvas */
  }
}

/** Where the pointer is, measured in whatever the handle cares about. */
function pointOnHandle(handle, frame, e) {
  const ray = state.vp.pointerRay(e.clientX, e.clientY);
  const axis = handle.axis >= 0 ? [frame.x, frame.y, frame.z][handle.axis] : frame.z;

  if (handle.kind === 'move' || handle.kind === 'scale') {
    return { t: closestOnLine(ray, frame.origin, axis) };
  }
  if (handle.kind === 'scaleAll') {
    const hit = rayPlane(ray, frame.origin, cameraForward());
    return { t: hit ? distance3(hit, frame.origin) : 0 };
  }
  if (handle.kind === 'movePlane') {
    const hit = rayPlane(ray, frame.origin, axis);
    return { point: hit };
  }
  // A turn: where round the ring the pointer is.
  const hit = rayPlane(ray, frame.origin, axis);
  if (!hit) return { angle: 0 };
  const u = [frame.x, frame.y, frame.z][(handle.axis + 1) % 3];
  const v = [frame.x, frame.y, frame.z][(handle.axis + 2) % 3];
  const d = sub3(hit, frame.origin);
  return { angle: Math.atan2(dot3(d, v), dot3(d, u)) };
}

/** The move a drag has come to, applied to the cage it started from. */
function editFormPointerMove(e) {
  const ed = editingForm();
  if (!ed?.drag) return false;
  const d = ed.drag;
  const now = pointOnHandle(d.handle, d.frame, e);
  const axis = d.handle.axis >= 0 ? [d.frame.x, d.frame.y, d.frame.z][d.handle.axis] : d.frame.z;

  let transform = null;
  if (d.handle.kind === 'move') {
    const delta = (now.t ?? 0) - (d.start.t ?? 0);
    if (ed.space === 'local' && d.normals) {
      // Each point along its own normal, which is how a whole face is pushed
      // out of a rounded body without shearing it.
      transform = (p, v) => addv(p, mulv(d.normals.get(v) || axis, delta));
    } else {
      transform = FM.translation(mulv(axis, delta));
    }
  } else if (d.handle.kind === 'movePlane') {
    if (!now.point || !d.start.point) return true;
    transform = FM.translation(sub3(now.point, d.start.point));
  } else if (d.handle.kind === 'rotate') {
    let turn = (now.angle ?? 0) - (d.start.angle ?? 0);
    // Round the back of the ring rather than the long way about.
    if (turn > Math.PI) turn -= Math.PI * 2;
    if (turn < -Math.PI) turn += Math.PI * 2;
    transform = FM.rotation(d.frame.origin, axis, turn);
  } else if (d.handle.kind === 'scale' || d.handle.kind === 'scaleAll') {
    const from = d.start.t ?? 0;
    const to = now.t ?? 0;
    const k = Math.abs(from) > 1e-9 ? Math.max(0.02, to / from) : 1;
    const factors = [1, 1, 1];
    if (d.handle.kind === 'scaleAll') factors[0] = factors[1] = factors[2] = k;
    else factors[d.handle.axis] = k;
    transform = FM.scaling(
      d.frame.origin,
      { x: d.frame.x, y: d.frame.y, z: d.frame.z },
      factors
    );
  }
  if (!transform) return true;

  state.doc.forms[ed.form] = Object.assign(
    FM.transformPoints(d.before, d.weights, transform),
    { name: d.before.name }
  );
  d.moved = true;
  rebuildAll();
  refreshEditForm();
  return true;
}

/** Let go: one undo entry for the whole drag, not one per frame. */
function editFormPointerUp(e) {
  const ed = editingForm();
  if (!ed?.drag) return false;
  const d = ed.drag;
  ed.drag = null;
  try {
    state.vp.canvas.releasePointerCapture(d.pointerId ?? e?.pointerId);
  } catch {
    /* already let go */
  }

  if (d.moved) {
    // The document already holds the result, so the undo entry is the cage as
    // it was before the drag began.
    const now = state.doc.forms[ed.form];
    state.doc.forms[ed.form] = d.before;
    pushUndo('edit form');
    state.doc.forms[ed.form] = now;
    state.dirty = true;
    rebuildAll();
  }
  refreshEditForm();
  return true;
}

/* -------- pulling a face out, and the selection helpers -------- */

/**
 * Pull a new face out of the ones picked.
 *
 * The lifted faces become the selection, so the drag that follows moves the new
 * limb rather than the hole it came out of.
 */
function cmdFormPull() {
  const ed = editingForm();
  const body = activeForm();
  if (!body) {
    setStatus('Pull works on a form.');
    return;
  }
  const faces = facesFromPoints(body, ed ? [...ed.vertices] : null);
  if (!faces.length) {
    setStatus('Pick the faces to pull out first.');
    return;
  }
  const cage = state.doc.forms[body.form];
  const made = FM.extrudeFaces(cage, faces, 0);
  if (!made) {
    setStatus('Those faces cannot be pulled out.');
    return;
  }
  pushUndo('pull face');
  made.cage.name = cage.name;
  state.doc.forms[body.form] = made.cage;
  state.dirty = true;
  if (ed) {
    ed.vertices = new Set(made.lifted);
  }
  rebuildAll();
  refreshEditForm();
  setStatus(
    `${faces.length} face${faces.length === 1 ? '' : 's'} pulled out. Drag to move them.`
  );
}

/** Which whole cage faces the picked points make up. */
function facesFromPoints(body, verts) {
  const cage = state.doc.forms[body.form];
  if (verts?.length) {
    const have = new Set(verts);
    return cage.faces
      .map((f, i) => i)
      .filter((i) => cage.faces[i].every((v) => have.has(v)));
  }
  return selectedCageFaces(body);
}

function cmdFormGrow(shrink) {
  const ed = editingForm();
  const body = activeForm();
  if (!ed || !body) {
    setStatus('Grow and shrink work while shaping a form.');
    return;
  }
  const cage = state.doc.forms[body.form];
  const adj = FM.adjacency(cage);
  const faces = facesFromPoints(body, [...ed.vertices]);
  const next = shrink
    ? FM.shrinkFaces(cage, faces, adj)
    : FM.growFaces(cage, faces, adj);
  if (!next.length) {
    setStatus(shrink ? 'Nothing would be left.' : 'Nothing to grow into.');
    return;
  }
  ed.vertices = new Set(FM.pointsOfFaces(cage, next));
  refreshEditForm();
  setStatus(`${next.length} face${next.length === 1 ? '' : 's'} picked.`);
}

function cmdFormLoop(ring) {
  const ed = editingForm();
  const body = activeForm();
  if (!ed || !body) {
    setStatus('Loop and ring work while shaping a form.');
    return;
  }
  const cage = state.doc.forms[body.form];
  const adj = FM.adjacency(cage);
  // Any edge of the cage both of whose ends are picked will do to start from.
  const start = [...adj.edges.values()].find(
    (e) => ed.vertices.has(e.a) && ed.vertices.has(e.b)
  );
  if (!start) {
    setStatus('Pick an edge first: two points that are joined.');
    return;
  }
  const found = ring
    ? FM.edgeRingSet(cage, start.a, start.b, adj)
    : FM.edgeLoop(cage, start.a, start.b, adj);
  for (const [a, b] of found) {
    ed.vertices.add(a);
    ed.vertices.add(b);
  }
  refreshEditForm();
  setStatus(`${found.length} edge${found.length === 1 ? '' : 's'} in the ${ring ? 'ring' : 'loop'}.`);
}

function cmdFormInvert() {
  const ed = editingForm();
  if (!ed) {
    setStatus('Invert works while shaping a form.');
    return;
  }
  const cage = state.doc.forms[ed.form];
  const next = new Set();
  cage.points.forEach((_, v) => {
    if (!ed.vertices.has(v)) next.add(v);
  });
  ed.vertices = next;
  refreshEditForm();
  reportEditFormSelection();
}

function cmdFormSelectAll() {
  const ed = editingForm();
  if (!ed) return;
  const cage = state.doc.forms[ed.form];
  ed.vertices = new Set(cage.points.map((_, v) => v));
  refreshEditForm();
  reportEditFormSelection();
}

/* -------- the dialog -------- */

function editFormFields() {
  const set = (key) => (f, value) => {
    const ed = editingForm();
    if (!ed) return;
    if (key.startsWith('soft.')) ed.soft[key.slice(5)] = value;
    else ed[key] = value;
    refreshEditForm();
  };
  const get = (key) => () => {
    const ed = editingForm();
    if (!ed) return '';
    return key.startsWith('soft.') ? ed.soft[key.slice(5)] : ed[key];
  };

  return [
    {
      key: 'mode',
      label: 'Transform mode',
      type: 'select',
      options: TRANSFORM_MODES,
      get: get('mode'),
      set: set('mode')
    },
    {
      key: 'space',
      label: 'Coordinate space',
      type: 'select',
      options: COORD_SPACES,
      get: get('space'),
      set: set('space')
    },
    {
      key: 'filter',
      label: 'Selection filter',
      type: 'select',
      options: SELECT_FILTERS,
      get: get('filter'),
      set: set('filter')
    },
    {
      key: 'soft.extent',
      label: 'Soft modification',
      type: 'select',
      options: FM.SOFT_EXTENTS,
      get: get('soft.extent'),
      set: set('soft.extent')
    },
    {
      key: 'soft.distance',
      label: 'Reach',
      type: 'expr',
      showIf: () => editingForm()?.soft.extent === 'distance',
      get: get('soft.distance'),
      set: set('soft.distance')
    },
    {
      key: 'soft.faces',
      label: 'Faces out',
      type: 'expr',
      showIf: () => editingForm()?.soft.extent === 'faces',
      get: get('soft.faces'),
      set: set('soft.faces')
    },
    {
      key: 'soft.transition',
      label: 'Transition',
      type: 'select',
      options: FM.TRANSITIONS,
      showIf: () => editingForm()?.soft.extent !== 'none',
      get: get('soft.transition'),
      set: set('soft.transition')
    },
    {
      key: 'soft.weight',
      label: 'Weight',
      type: 'expr',
      showIf: () => editingForm()?.soft.extent !== 'none',
      get: get('soft.weight'),
      set: set('soft.weight')
    },
    {
      key: '__note',
      label: '',
      type: 'note',
      text: 'Drag an arrow to move along it, a square to move in that plane, a ring to turn, a cube to scale. Shift click to add to the selection. Escape when done.'
    }
  ];
}

function describeFeature(feature) {
  const opOptions = [
    ['new', 'New body'],
    ['join', 'Join'],
    ['cut', 'Cut'],
    ['intersect', 'Intersect']
  ];
  switch (feature.type) {
    case 'form':
      return { title: `Form: ${feature.shape || 'box'}`, fields: formFields(feature) };
    case 'finishForm':
      return { title: 'Finish Form', fields: finishFormFields() };
    case 'formThicken':
      return { title: 'Thicken Form', fields: formThickenFields() };
    case 'insertMesh':
      return { title: 'Insert Mesh', fields: insertMeshFields() };
    case 'meshRepair':
      return { title: 'Repair', fields: meshRepairFields() };
    case 'meshStitch':
      return { title: 'Stitch Mesh', fields: meshStitchFields() };
    case 'meshPatch':
      return { title: 'Patch Mesh', fields: meshPatchFields() };
    case 'meshDirectEdit':
      return { title: 'Direct Edit', fields: meshDirectEditFields() };
    case 'meshReduce':
      return { title: 'Reduce', fields: meshReduceFields() };
    case 'meshRemesh':
      return { title: 'Remesh', fields: meshRemeshFields() };
    case 'meshSmooth':
      return { title: 'Smooth', fields: meshSmoothFields() };
    case 'meshPlaneCut':
      return { title: 'Plane Cut', fields: meshPlaneCutFields() };
    case 'meshErase':
      return { title: 'Erase And Fill', fields: meshEraseFields() };
    case 'textureExtrude':
      return { title: 'Texture Extrude', fields: textureExtrudeFields() };
    case 'baseFlange':
      return { title: 'Base Flange', fields: baseFlangeFields() };
    case 'flange':
      return { title: 'Flange', fields: flangeFields() };
    case 'hem':
      return { title: 'Hem', fields: hemFields() };
    case 'loftedFlange':
      return { title: 'Lofted Flange', fields: loftedFlangeFields() };
    case 'contourFlange':
      return { title: 'Contour Flange', fields: contourFlangeFields() };
    case 'sheetFold':
      return { title: 'Fold', fields: sheetFoldFields() };
    case 'unfold':
      return { title: 'Unfold', fields: unfoldFields(feature) };
    case 'refold':
      return { title: 'Refold', fields: unfoldFields(feature) };
    case 'rip':
      return { title: 'Rip', fields: ripFields() };
    case 'miter':
      return { title: 'Miter', fields: miterFields() };
    case 'faceGroupEdit':
      return {
        title: (FACE_GROUP_OPS[feature.op] || FACE_GROUP_OPS.combine).title,
        fields: faceGroupEditFields(feature)
      };
    case 'surfaceExtrude':
      return { title: 'Extrude Surface', fields: surfaceExtrudeFields() };
    case 'surfaceRevolve':
      return { title: 'Revolve Surface', fields: surfaceRevolveFields() };
    case 'surfaceSweep':
      return { title: 'Sweep Surface', fields: surfaceSweepFields() };
    case 'surfaceLoft':
      return { title: 'Loft Surface', fields: surfaceLoftFields(feature) };
    case 'patch':
      return { title: 'Patch', fields: patchFields() };
    case 'ruled':
      return { title: 'Ruled Surface', fields: ruledFields() };
    case 'offsetSurface':
      return { title: 'Offset Surface', fields: offsetSurfaceFields() };
    case 'trimSurface':
      return { title: 'Trim Surface', fields: trimSurfaceFields() };
    case 'extendSurface':
      return { title: 'Extend Surface', fields: extendSurfaceFields() };
    case 'untrimSurface':
      return { title: 'Untrim Surface', fields: untrimSurfaceFields() };
    case 'mergeSurface':
      return { title: 'Merge Surfaces', fields: mergeSurfaceFields() };
    case 'stitch':
      return { title: 'Stitch', fields: stitchFields() };
    case 'unstitch':
      return { title: 'Unstitch', fields: unstitchFields() };
    case 'reverseNormal':
      return { title: 'Reverse Normal', fields: [surfaceField()] };
    case 'thicken':
      return { title: 'Thicken', fields: thickenFields() };
    case 'boundaryFill':
      return { title: 'Boundary Fill', fields: boundaryFillFields() };
    case 'replaceFace':
      return { title: 'Replace Face', fields: replaceFaceFields() };
    case 'boss':
      return { title: 'Boss', fields: plasticFields('boss') };
    case 'rest':
      return { title: 'Rest', fields: plasticFields('rest') };
    case 'snapFit':
      return { title: 'Snap Fit', fields: plasticFields('snapFit') };
    case 'lip':
      return { title: 'Lip', fields: plasticFields('lip') };
    case 'extrude':
      return { title: 'Extrude', fields: extrudeFields() };
    case 'revolve':
      return { title: 'Revolve', fields: revolveFields() };
    case 'sweep':
      return { title: 'Sweep', fields: sweepFields() };
    case 'loft':
      return { title: 'Loft', fields: loftFields(feature) };
    case 'hole':
      return { title: 'Hole', fields: holeFields() };
    case 'primitive': {
      const shapeFields = {
        box: [
          { key: 'params.width', label: 'Width (X)', type: 'expr' },
          { key: 'params.depth', label: 'Depth (Y)', type: 'expr' },
          { key: 'params.height', label: 'Height (Z)', type: 'expr' }
        ],
        cylinder: [
          { key: 'params.diameter', label: 'Diameter', type: 'expr' },
          { key: 'params.height', label: 'Height', type: 'expr' }
        ],
        cone: [
          { key: 'params.diameter', label: 'Base diameter', type: 'expr' },
          { key: 'params.topDiameter', label: 'Top diameter', type: 'expr' },
          { key: 'params.height', label: 'Height', type: 'expr' }
        ],
        torus: [
          { key: 'params.diameter', label: 'Ring diameter', type: 'expr' },
          { key: 'params.tubeDiameter', label: 'Tube diameter', type: 'expr' }
        ],
        pipe: [
          { key: 'params.diameter', label: 'Outside diameter', type: 'expr' },
          { key: 'params.wall', label: 'Wall thickness', type: 'expr' },
          { key: 'params.height', label: 'Height', type: 'expr' }
        ]
      };
      return {
        title: feature.shape.charAt(0).toUpperCase() + feature.shape.slice(1),
        fields: [
          ...(shapeFields[feature.shape] || [
            { key: 'params.diameter', label: 'Diameter', type: 'expr' }
          ]),
          { key: 'params.x', label: 'Position X', type: 'expr' },
          { key: 'params.y', label: 'Position Y', type: 'expr' },
          { key: 'params.z', label: 'Position Z', type: 'expr' },
          { key: 'params.centered', label: 'Centre on origin', type: 'bool' },
          { key: 'op', label: 'Operation', type: 'select', options: OP_OPTIONS }
        ]
      };
    }
    case 'fillet':
      return { title: 'Fillet', fields: blendFieldsFor(feature, 'fillet') };
    case 'chamfer':
      return { title: 'Chamfer', fields: blendFieldsFor(feature, 'chamfer') };
    case 'shell':
      return { title: 'Shell', fields: shellFields() };
    case 'draft':
      return { title: 'Draft', fields: draftFields() };
    case 'patternRect':
      return { title: 'Rectangular Pattern', fields: patternRectFields() };
    case 'patternCirc':
      return { title: 'Circular Pattern', fields: patternCircFields() };
    case 'combine':
      return { title: 'Combine', fields: combineFields() };
    case 'move':
      return { title: 'Move', fields: moveFields() };
    case 'scale':
      return { title: 'Scale', fields: scaleFields() };
    case 'split':
      return { title: 'Split Body', fields: splitFields(feature) };
    case 'offsetFace':
      return { title: 'Press Pull', fields: pressPullFields() };
    case 'mirror':
      return { title: 'Mirror', fields: mirrorFields() };
    case 'coil':
      return { title: 'Coil', fields: coilFields(feature) };
    case 'emboss':
      return { title: 'Emboss', fields: embossFields() };
    case 'web':
      return { title: 'Web', fields: webFields(feature) };
    case 'align':
      return { title: 'Align', fields: alignFields() };
    case 'deleteFace':
      return { title: 'Delete Face', fields: deleteFaceFields() };
    case 'silhouetteSplit':
      return { title: 'Silhouette Split', fields: silhouetteFields() };
    case 'splitFace':
      return { title: 'Split Face', fields: splitFaceFields() };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Parameters panel                                                    */
/* ------------------------------------------------------------------ */

/**
 * Turn the camera square to whatever is being worked on.
 *
 * The open sketch's plane if there is one, otherwise a selected planar face.
 * The plane's own up axis is handed over as the roll, so the sketch's up is up
 * on screen rather than whatever the camera happened to be rolled to.
 */
/** Put the slice where the open sketch is, or take it away. */
function refreshSlice() {
  const sk = state.sliceSketch && state.sketcher.active ? state.sketcher.sketch : null;
  const plane = sk ? state.result?.sketchPlanes?.[sk.id] : null;
  state.vp.setSlice(plane ? { origin: plane.origin, n: plane.n } : null);
}

function cmdLookAt() {
  const sk = state.sketcher.active ? state.sketcher.sketch : null;
  const plane = sk ? state.result?.sketchPlanes?.[sk.id] : null;
  if (plane) {
    state.vp.setView(plane.n, true, plane.y);
    return;
  }
  const found = singleSelectedFace();
  if (found) {
    const b = basisFor(found.face.normal);
    state.vp.setView(found.face.normal, true, b.y);
    return;
  }
  setStatus('Open a sketch, or pick a flat face, to look straight at it.');
}

function showParameters() {
  if (state.editing) cancelEdit();
  el.inspectorTitle.textContent = 'Parameters';
  el.inspector.classList.remove('hidden');
  state.editing = null;
  renderParameters();
}

/**
 * Note that the model is behind the parameters.
 *
 * It shows the note it has rather than drawing the panel again. Re-rendering
 * would rebuild the very input being typed into and take the caret with it,
 * which is a worse bug than the one automatic compute is here to fix.
 */
function markParametersWaiting() {
  state.parametersWaiting = true;
  if (state.parametersWaitingEl) state.parametersWaitingEl.hidden = false;
}

function renderParameters() {
  const body = el.inspectorBody;
  body.innerHTML = '';

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent =
    'Name a value here and any dimension can use it. Expressions may reference other parameters, for example wall * 2.';
  body.appendChild(hint);

  // Every keystroke rebuilds the part, which on a heavy one is the difference
  // between editing five numbers and waiting five times. Fusion calls it
  // Automatic Compute and it is the same idea.
  const autoRow = document.createElement('div');
  autoRow.className = 'field inline';
  const autoBox = document.createElement('input');
  autoBox.type = 'checkbox';
  autoBox.checked = state.autoCompute !== false;
  const autoLabel = document.createElement('label');
  autoLabel.textContent = 'Compute as I type';
  autoBox.addEventListener('change', () => {
    state.autoCompute = autoBox.checked;
    // Turning it back on is what asks for the work that was put off.
    if (autoBox.checked && state.parametersWaiting) {
      state.parametersWaiting = false;
      rebuildAll();
    }
    renderParameters();
  });
  autoRow.appendChild(autoBox);
  autoRow.appendChild(autoLabel);
  body.appendChild(autoRow);

  // Built either way and hidden until it is wanted, so that saying "there is
  // work waiting" never has to redraw the table somebody is typing into.
  const waiting = document.createElement('div');
  waiting.className = 'hint';
  waiting.textContent = 'Changes are waiting. Tick the box to build them.';
  waiting.hidden = !(state.autoCompute === false && state.parametersWaiting);
  body.appendChild(waiting);
  state.parametersWaitingEl = waiting;

  const { scope, errors } = resolveParameters(state.doc.parameters);

  const table = document.createElement('table');
  table.className = 'params';
  table.innerHTML =
    '<thead><tr><th></th><th>Name</th><th>Expression</th><th>Value</th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');

  // Favourites first, and in the order they were made within each group. The
  // list is walked, not sorted in place: reordering the document's own array
  // would renumber every row and change what a delete button points at.
  const order = state.doc.parameters
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.favourite ? 1 : 0) - (a.p.favourite ? 1 : 0) || a.i - b.i);

  order.forEach(({ p, i }) => {
    const tr = document.createElement('tr');

    const tdStar = document.createElement('td');
    const star = document.createElement('button');
    star.textContent = p.favourite ? '★' : '☆';
    star.title = p.favourite ? 'A favourite. Click to drop it.' : 'Make it a favourite';
    star.className = 'starbtn';
    star.addEventListener('click', () => {
      p.favourite = !p.favourite;
      state.dirty = true;
      renderParameters();
    });
    tdStar.appendChild(star);

    const tdName = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = p.name;
    nameInput.addEventListener('change', () => {
      const clean = nameInput.value.replace(/[^A-Za-z0-9_]/g, '');
      if (clean && !state.doc.parameters.some((q, j) => j !== i && q.name === clean)) {
        p.name = clean;
      }
      nameInput.value = p.name;
      state.dirty = true;
      renderParameters();
      rebuildAll();
    });
    tdName.appendChild(nameInput);

    const tdExpr = document.createElement('td');
    const exprInput = document.createElement('input');
    exprInput.type = 'text';
    exprInput.value = p.expr;
    exprInput.addEventListener('input', () => {
      p.expr = exprInput.value;
      state.dirty = true;
      // With automatic compute off the model is left alone until the box is
      // ticked again. The value beside the row still updates, because that
      // costs nothing and it is how you check an expression before paying for
      // the rebuild it will cause.
      if (state.autoCompute === false) markParametersWaiting();
      else scheduleRebuild();
      const v = resolveParameters(state.doc.parameters);
      tdVal.textContent = v.errors[p.name] ? 'error' : round(v.scope[p.name], 4);
      tdVal.style.color = v.errors[p.name] ? '#e06c5f' : '';
    });
    tdExpr.appendChild(exprInput);

    const tdVal = document.createElement('td');
    tdVal.className = 'v';
    tdVal.textContent = errors[p.name] ? 'error' : round(scope[p.name], 4);
    if (errors[p.name]) {
      tdVal.style.color = '#e06c5f';
      tdVal.title = errors[p.name];
    }

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.textContent = '✕';
    del.style.padding = '1px 5px';
    del.addEventListener('click', () => {
      pushUndo('delete parameter');
      state.doc.parameters.splice(i, 1);
      state.dirty = true;
      renderParameters();
      rebuildAll();
    });
    tdDel.appendChild(del);

    tr.append(tdStar, tdName, tdExpr, tdVal, tdDel);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  body.appendChild(table);

  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '10px';

  const add = document.createElement('button');
  add.textContent = '+ Add parameter';
  add.addEventListener('click', () => {
    pushUndo('add parameter');
    let n = state.doc.parameters.length + 1;
    let name = `param${n}`;
    while (state.doc.parameters.some((p) => p.name === name)) name = `param${++n}`;
    state.doc.parameters.push({ name, expr: '10' });
    state.dirty = true;
    renderParameters();
    rebuildAll();
  });
  row.appendChild(add);

  const out = document.createElement('button');
  out.textContent = 'Export';
  out.title = 'Write the table out as a CSV';
  out.addEventListener('click', () => exportParameters());
  row.appendChild(out);

  const inn = document.createElement('button');
  inn.textContent = 'Import';
  inn.title = 'Read a CSV back in. A name already here keeps its place and takes the new expression.';
  inn.addEventListener('click', () => importParameters());
  row.appendChild(inn);

  body.appendChild(row);
}

/**
 * Take `Width = 50` typed into a dimension field and make the parameter.
 *
 * Returns the name to leave in the field, so the field ends up referring to the
 * parameter rather than holding a copy of the number, or null when what was
 * typed was an ordinary expression and nothing should happen.
 *
 * A name already in use is not quietly overwritten. Someone typing `wall = 3`
 * into a second field usually means "use the wall parameter here", and taking
 * that as an instruction to redefine wall would move every other feature that
 * reads it.
 */
function parameterFromField(text) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(String(text || ''));
  if (!m) return null;
  const [, name, expr] = m;

  const existing = state.doc.parameters.find((p) => p.name === name);
  if (existing) {
    setStatus(`${name} already exists, so the field now reads it. Change it in Parameters.`);
    return name;
  }

  // It has to evaluate, or the field is left as typed and the person can see
  // what they wrote. Silently making a broken parameter would put the error on
  // a row they are not looking at.
  const scope = resolveParameters(state.doc.parameters).scope;
  try {
    evaluate(expr, scope);
  } catch (err) {
    setStatus(`Could not make ${name}: ${err.message}`);
    return null;
  }

  pushUndo('add parameter');
  // Named where it is used, so it is a favourite by the act of being made,
  // which is what Fusion does with these too.
  state.doc.parameters.push({ name, expr, favourite: true });
  state.dirty = true;
  setStatus(`${name} = ${expr}. It is in Parameters now, marked a favourite.`);
  return name;
}

/* ------------------------------------------------------------------ */
/* Parameters in and out                                               */
/* ------------------------------------------------------------------ */

/**
 * Write the parameters out.
 *
 * The expression is what is kept, not the number it works out to: a table
 * exported from one part and read into another is meant to carry the reasoning,
 * and a column of numbers would carry only the answers. The value is written
 * too, as a fourth column nothing reads back, because a person opening the file
 * in a spreadsheet wants to see it.
 */
async function exportParameters() {
  const res = await window.anvil.exportText(
    'parameters.csv',
    'csv',
    'Comma separated values',
    parametersToCsv(state.doc.parameters)
  );
  if (res?.canceled) return;
  setStatus(
    res?.ok
      ? `${state.doc.parameters.length} parameter${state.doc.parameters.length === 1 ? '' : 's'} written to ${res.path}.`
      : `Could not write the parameters: ${res?.error || 'unknown'}`
  );
}

/**
 * Read a parameter list back in.
 *
 * A name already in the document keeps its row and takes the new expression,
 * so importing a revised table updates the part rather than filling it with
 * duplicates that shadow each other. Names not here yet are appended.
 */
async function importParameters() {
  const res = await window.anvil.importText('csv', 'Comma separated values');
  if (!res?.ok) {
    if (res && !res.canceled) setStatus(`Could not read that: ${res.error}`);
    return;
  }

  const { taken, skipped } = parametersFromCsv(res.text);
  let updated = 0;
  let added = 0;

  pushUndo('import parameters');
  for (const row of taken) {
    const existing = state.doc.parameters.find((p) => p.name === row.name);
    if (existing) {
      existing.expr = row.expr;
      if (row.comment) existing.comment = row.comment;
      updated++;
    } else {
      state.doc.parameters.push(row);
      added++;
    }
  }

  state.dirty = true;
  renderParameters();
  rebuildAll();

  const bits = [];
  if (added) bits.push(`${added} added`);
  if (updated) bits.push(`${updated} updated`);
  if (skipped.length) bits.push(`${skipped.length} skipped`);
  setStatus(bits.length ? `Parameters: ${bits.join(', ')}.` : 'Nothing in that file to import.');
}

/**
 * Measure whatever is picked next: one edge gives its length, a circular one its
 * radius and diameter, a face its area, and two picks the distance between
 * them. Nothing is added to the model.
 */
function startMeasure() {
  if (state.sketcher.active) {
    measureSketch();
    return;
  }
  const picks = [];
  beginPicking({
    prompt: 'Click an edge or a face to measure. Click a second for a distance.',
    filter: { faces: true, edges: true, bodies: false, profiles: false },
    onPick: (hit) => {
      const got = measureTarget(hit);
      if (!got) return;
      picks.push(got);
      if (picks.length === 1) {
        setStatus(`${got.what}. Click another to measure between them.`);
        return;
      }
      const a = picks[0];
      const b = picks[1];
      const d = Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1], a.at[2] - b.at[2]);
      setStatus(`Between centres: ${fmtLength(d)}. ${a.what} to ${b.what}.`);
      picks.length = 0;
    }
  });
}

/** Reduce a pick to a describable measurement and a point to measure from. */
function measureTarget(hit) {
  const record = (state.records || []).find((r) => r.id === hit.bodyId);
  if (!record) return null;
  if (hit.kind === 'edge') {
    const edge = record.topology.edges.find((e) => e.id === hit.edgeId);
    if (!edge) return null;
    const what =
      edge.kind === 'circle'
        ? `Circle radius ${fmtLength(edge.radius)}, diameter ${fmtLength(edge.radius * 2)}`
        : `Edge ${fmtLength(edge.length)} long`;
    const at = edge.centre || edge.start || edge.points[0];
    return { what, at };
  }
  const face = record.topology.faces[hit.faceId];
  if (!face) return null;
  const kind = face.planar ? 'Flat face' : 'Curved face';
  return { what: `${kind}, area ${fmtArea(face.area)}`, at: face.centre };
}

/** In a sketch, measure between the two selected points, or one entity. */
function measureSketch() {
  const sk = state.sketcher;
  const pts = [...sk.selection].filter((k) => k.startsWith('p')).map((k) => Number(k.slice(1)));
  if (pts.length === 2) {
    const a = sk.sketch.points[pts[0]];
    const b = sk.sketch.points[pts[1]];
    setStatus(
      `Distance ${fmtLength(Math.hypot(b.x - a.x, b.y - a.y))}, ` +
        `along X ${fmtLength(Math.abs(b.x - a.x))}, along Y ${fmtLength(Math.abs(b.y - a.y))}.`
    );
    return;
  }
  const ents = sk.selectedEntities();
  if (ents.length === 1) {
    const e = ents[0];
    if (e.type === 'line') {
      const a = sk.sketch.points[e.p[0]];
      const b = sk.sketch.points[e.p[1]];
      const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      setStatus(
        `Line ${fmtLength(Math.hypot(b.x - a.x, b.y - a.y))} long, ` +
          `at ${(((ang % 360) + 360) % 360).toFixed(2)} degrees.`
      );
      return;
    }
    if (e.type === 'circle') {
      setStatus(`Circle radius ${fmtLength(e.r)}, diameter ${fmtLength(e.r * 2)}.`);
      return;
    }
  }
  const regions = sk.selectedRegionObjects();
  if (regions.length) {
    const total = regions.reduce((n, r) => n + Math.abs(r.area), 0);
    setStatus(`${regions.length} profile${regions.length === 1 ? '' : 's'}, area ${fmtArea(total)}.`);
    return;
  }
  setStatus('Select two points, one line or circle, or a profile, then measure.');
}

function showOffsetPlane() {
  // Create Sketch used to be the only way to reach an offset plane. It asks by
  // pointing now, so the offset belongs with the rest of the construction
  // geometry, which is where Fusion keeps it anyway.
  startConstruction();
}

/* ------------------------------------------------------------------ */
/* Generic inspector form (used before a feature exists)               */
/* ------------------------------------------------------------------ */

function showInspector(title, fields, onOk) {
  if (state.editing) cancelEdit();
  el.inspectorTitle.textContent = title;
  el.inspector.classList.remove('hidden');
  el.inspectorBody.innerHTML = '';

  const values = {};
  for (const f of fields) values[f.key] = f.value;

  /**
   * Draw the rows.
   *
   * A row can either hold a value of its own, which is what every command that
   * asks a question once does, or read and write something live through `get`
   * and `set`, which is what a panel that stays open while you work needs. A
   * live choice redraws, so a row that only applies to one setting can appear
   * and disappear with it.
   */
  const draw = () => {
    el.inspectorBody.innerHTML = '';
    for (const f of fields) {
      if (f.showIf && !f.showIf()) continue;
      const current = f.get ? f.get() : values[f.key];

      // A row that only says something. Interference is nothing but these, so
      // without it the command reports its findings to an empty panel.
      if (f.type === 'note') {
        const note = document.createElement('div');
        note.className = 'hint';
        note.textContent = f.text;
        el.inspectorBody.appendChild(note);
        continue;
      }

      const wrap = document.createElement('div');
      wrap.className = 'field';
      const label = document.createElement('label');
      label.textContent = f.label;
      wrap.appendChild(label);

      const take = (v, redraw) => {
        if (f.set) {
          f.set(f, v);
          // Only a choice redraws. Redrawing on a keystroke would take the
          // focus out of the box being typed into.
          if (redraw) draw();
        } else {
          values[f.key] = v;
        }
      };

      if (f.type === 'action') {
        // The same row the feature editor has, so a panel that offers to add
        // or remove something reads the same wherever it is shown.
        const btn = document.createElement('button');
        btn.textContent = f.label;
        label.textContent = '';
        btn.addEventListener('click', () => {
          f.run();
          draw();
        });
        wrap.appendChild(btn);
        el.inspectorBody.appendChild(wrap);
        continue;
      }

      if (f.type === 'select') {
        const sel = document.createElement('select');
        for (const [v, t] of (typeof f.options === 'function' ? f.options() : f.options)) {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = t;
          if (String(v) === String(current)) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => take(sel.value, true));
        wrap.appendChild(sel);
      } else if (f.type === 'check' || f.type === 'bool') {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!current;
        box.addEventListener('change', () => take(box.checked, true));
        wrap.appendChild(box);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = current ?? '';
        input.addEventListener('input', () => {
          const n = Number(input.value);
          // A row that says it holds text keeps it. Without that a rule named
          // for its alloy number stops being a name the moment it is typed.
          const asNumber = f.get && f.type !== 'text' && Number.isFinite(n);
          take(asNumber ? n : input.value, false);
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') ok();
        });
        wrap.appendChild(input);
      }
      el.inspectorBody.appendChild(wrap);
    }
  };
  draw();

  const ok = () => {
    el.inspector.classList.add('hidden');
    $('#inspectorOk').onclick = null;
    onOk(values);
  };
  $('#inspectorOk').onclick = ok;
  const firstInput = el.inspectorBody.querySelector(
    '.field:not(.presetrow) input, .field:not(.presetrow) select'
  );
  if (firstInput) firstInput.focus();
}

/** Close whatever panel is open, without running its accept. */
function hideInspector() {
  el.inspector.classList.add('hidden');
  $('#inspectorOk').onclick = null;
}

/* ------------------------------------------------------------------ */
/* Modal value prompt                                                  */
/* ------------------------------------------------------------------ */

let modalResolve = null;

function promptValue(title, initial, cb) {
  const modal = $('#modal');
  $('#modalTitle').textContent = title;
  const body = $('#modalBody');
  body.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = initial;
  body.appendChild(input);
  modal.classList.remove('hidden');
  input.focus();
  input.select();

  modalResolve = cb;
  const done = () => closeModal(input.value);
  $('#modalOk').onclick = done;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') done();
    if (e.key === 'Escape') closeModal(null);
    e.stopPropagation();
  };
}

/** A modal list of choices, for the few places a dropdown has to be modal. */
/**
 * Ask for one line of text in the same modal the choice prompt uses.
 *
 * The window's own `prompt` is not available under the content security policy
 * this application runs with, and would look like a browser box anyway.
 */
function promptText(title, initial, cb) {
  const modal = $('#modal');
  $('#modalTitle').textContent = title;
  const body = $('#modalBody');
  body.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = initial ?? '';
  input.style.width = '100%';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closeModal(input.value);
  });
  body.appendChild(input);
  modal.classList.remove('hidden');
  input.focus();
  input.select();

  modalResolve = cb;
  $('#modalOk').onclick = () => closeModal(input.value);
}

function promptChoice(title, options, cb) {
  const modal = $('#modal');
  $('#modalTitle').textContent = title;
  const body = $('#modalBody');
  body.innerHTML = '';
  const sel = document.createElement('select');
  for (const [value, label] of options) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }
  body.appendChild(sel);
  modal.classList.remove('hidden');
  sel.focus();

  modalResolve = cb;
  $('#modalOk').onclick = () => closeModal(sel.value);
}

function closeModal(value) {
  $('#modal').classList.add('hidden');
  const cb = modalResolve;
  modalResolve = null;
  if (cb && value !== null) cb(value);
}

/* ------------------------------------------------------------------ */

/*
 * There is deliberately no beforeunload guard here.
 *
 * In a browser, preventing beforeunload asks "leave site?". In Electron it does
 * no such thing: it cancels the close outright and says nothing, so a dirty
 * document made the window impossible to shut. Asking about unsaved work is the
 * main process's job, in main.js, where a real dialog can be shown and the
 * answer acted on.
 */

boot();

/**
 * Scripting hook.
 *
 * Exposes the live document and the command dispatcher so a model can be built
 * without clicking, which is how the screenshot tool and any future macro work.
 * It reaches nothing the user could not reach through the interface.
 */
window.anvilDev = {
  state,
  runCommand,
  faceReference,
  jointTypes: JOINT_TYPES,
  rebuildAll,
  setTab,
  enterSketch,
  finishSketch,
  setStatus,
  get doc() {
    return state.doc;
  },
  get bodies() {
    return state.result ? state.result.bodies : [];
  },
  // The pull is the one interaction that cannot be checked by looking at the
  // document afterwards: it is a drag, and what it does depends on where the
  // camera is. These are here so a probe can measure it rather than infer it.
  axisDragAmount,
  pullTarget,
  edgeReference,
  // The parameter file readers, so a probe can put a table out and read it back
  // without going through a save dialog it cannot answer.
  expr: { parametersToCsv, parametersFromCsv },
  ready: () => !!state.result,
  isDirty: () => !!state.dirty,
  /** Save, and say whether it happened. Used by the close prompt. */
  saveNow: () => cmdSave(false)
};

export { state };
