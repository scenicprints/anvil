/**
 * The 3D viewport: scene, camera, navigation, body display, view cube.
 *
 * Navigation follows CAD conventions rather than game conventions. The middle
 * mouse button orbits, shift plus middle pans, and the wheel zooms toward the
 * cursor instead of toward the screen centre, so the point under the pointer
 * stays put.
 */

import * as THREE from './three.js';
import { buildGeometry, buildEdges } from './meshutil.js';

// Surfaces are drawn in a warmer tone than solids, so which is which reads at
// a glance rather than needing the browser to be checked.
const SHEET_COLOUR = 0xd9c187;

const UP = new THREE.Vector3(0, 0, 1);

/**
 * Mouse bindings, matching Fusion's defaults so muscle memory carries over:
 * the middle button pans, shift plus middle orbits, and the right button opens
 * a context menu rather than moving the camera.
 */
// How far a press on the view cube may travel and still count as a click on a
// face rather than the start of an orbit.
const CUBE_CLICK_SLOP = 4;

/**
 * Looking down from the front, right and above in equal measure: the standard
 * isometric, rather than the roughly-that the view used to open on.
 */
export const ISO_VIEW = [1, -1, 1];

export const NAV_DEFAULTS = {
  middle: 'pan',
  shiftMiddle: 'orbit',
  invertZoom: true, // scrolling forward zooms out, as Fusion ships
  zoomToCursor: true
};

/**
 * Which way is up on screen, for a pair of orbit angles.
 *
 * Away from the poles this is exactly the world up projected into the view
 * plane, which is what lookAt would have worked out anyway. Straight down the
 * world up axis the projection vanishes, lookAt falls back to a basis rolled
 * ninety degrees, and a sketch on XY then records a line drawn rightwards as
 * running up the screen. So it is written out here instead, where theta, which
 * no longer moves the camera, is free to serve as the roll.
 *
 * @returns {[number, number, number]} unit vector in world space
 */
export function screenUpFor(phi, theta) {
  const cp = Math.cos(phi);
  const v = [-cp * Math.sin(theta), -cp * Math.cos(theta), Math.sin(phi)];
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * The theta that puts `up` up the screen when looking along the world up axis.
 * `sign` is +1 looking down from above, -1 looking up from below.
 */
export function rollTheta(sign, up) {
  return sign > 0 ? Math.atan2(-up[0], -up[1]) : Math.atan2(up[0], up[1]);
}

export class Viewport {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // A light drafting ground. Shaded solids read as objects sitting on paper,
    // and the feature edges can be near black, which is how a part is drawn.
    this.renderer.setClearColor(0xbcb9b2, 1);
    this.renderer.sortObjects = true;
    this.renderer.localClippingEnabled = true;

    this.scene = new THREE.Scene();
    this.scene.up = UP;

    // Z is up, matching every mechanical CAD package and every slicer.
    THREE.Object3D.DEFAULT_UP = UP.clone();

    this.perspective = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
    this.usePerspective = true;
    this.camera = this.perspective;

    this.target = new THREE.Vector3(0, 0, 0);
    // acos(1/sqrt 3) and three quarters of pi: the isometric, which is also
    // what the home button returns to.
    this.spherical = new THREE.Spherical(220, Math.acos(1 / Math.sqrt(3)), Math.PI * 0.75);
    this.orthoZoom = 120;

    this.bodyGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    this.helperGroup = new THREE.Group();
    this.scene.add(this.helperGroup, this.bodyGroup, this.overlayGroup);

    this.bodies = new Map();
    this.hover = null;
    this.selection = new Set();

    this._setupLights();
    this._setupHelpers();
    this._setupViewCube();
    this._setupNavigation();

    this.needsRender = true;
    this._onResize();
    window.addEventListener('resize', () => this._onResize());

    // The window is not the only thing that changes the viewport's size. Opening
    // a side panel narrows it with no window event at all, and the canvas keeps
    // the inline width it was last given and spills over the panel that just
    // appeared, which hides it completely while leaving it laid out and
    // clickable-looking. Watch the element itself instead.
    if (typeof ResizeObserver !== 'undefined') {
      this._sizeWatch = new ResizeObserver(() => this._onResize());
      this._sizeWatch.observe(this.canvas.parentElement);
    }

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ---------------------------------------------------------------- */

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0xfbf9f4, 0x9a968d, 1.0);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(0.6, -0.9, 1.2);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xece7dc, 0.5);
    fill.position.set(-1.1, 0.4, 0.35);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.3);
    rim.position.set(0.2, 1.0, -0.8);
    this.scene.add(rim);

    this.cameraLight = new THREE.DirectionalLight(0xffffff, 0.25);
    this.scene.add(this.cameraLight);
  }

  _setupHelpers() {
    this.grid = new THREE.Group();
    this._buildGrid(200, 10);
    this.helperGroup.add(this.grid);

    const axisLen = 40;
    const axes = new THREE.Group();
    // Both halves, so the quadrant you are sketching in is readable. Drawn from
    // -len to +len rather than out from the origin.
    const mk = (dir, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([
        dir.clone().multiplyScalar(-axisLen),
        dir.clone().multiplyScalar(axisLen)
      ]);
      const m = new THREE.LineBasicMaterial({
        color,
        depthTest: false,
        transparent: true,
        opacity: 0.85
      });
      const line = new THREE.Line(g, m);
      line.renderOrder = 3;
      return line;
    };
    axes.add(mk(new THREE.Vector3(1, 0, 0), 0xa8402a));
    axes.add(mk(new THREE.Vector3(0, 1, 0), 0x3d7a44));
    axes.add(mk(new THREE.Vector3(0, 0, 1), 0x3a5f8a));
    this.axes = axes;
    this.helperGroup.add(axes);

    this.originPlanes = new THREE.Group();
    this.originPlanes.visible = false;
    const planeDefs = [
      { name: 'XY', color: 0x3a5f8a, rot: [0, 0, 0] },
      { name: 'XZ', color: 0x3d7a44, rot: [Math.PI / 2, 0, 0] },
      { name: 'YZ', color: 0xa8402a, rot: [0, Math.PI / 2, 0] }
    ];
    for (const def of planeDefs) {
      const geo = new THREE.PlaneGeometry(60, 60);
      const mat = new THREE.MeshBasicMaterial({
        color: def.color,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.set(...def.rot);
      mesh.userData.planeName = def.name;
      mesh.userData.pickable = 'plane';
      this.originPlanes.add(mesh);
    }
    this.helperGroup.add(this.originPlanes);
  }

  _buildGrid(extent, step) {
    while (this.grid.children.length) {
      const c = this.grid.children.pop();
      c.geometry.dispose();
      c.material.dispose();
    }
    const minor = [];
    const major = [];
    for (let i = -extent; i <= extent; i += step) {
      const isMajor = Math.abs(i % (step * 10)) < 1e-9;
      const arr = isMajor ? major : minor;
      arr.push(-extent, i, 0, extent, i, 0);
      arr.push(i, -extent, 0, i, extent, 0);
    }
    const mkLines = (arr, color, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
      const l = new THREE.LineSegments(g, m);
      l.renderOrder = -1;
      return l;
    };
    this.grid.add(mkLines(minor, 0xaeaba3, 0.4));
    this.grid.add(mkLines(major, 0x99968e, 0.55));
  }

  /* ---------------------------------------------------------------- */

  _setupViewCube() {
    this.cubeScene = new THREE.Scene();
    this.cubeCamera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 100);
    // The cube is a screen-space widget, so its camera keeps the screen's own
    // up vector rather than the model's Z-up.
    this.cubeCamera.up.set(0, 1, 0);

    const group = new THREE.Group();
    const faceLabels = [
      { dir: [1, 0, 0], text: 'RIGHT' },
      { dir: [-1, 0, 0], text: 'LEFT' },
      { dir: [0, 1, 0], text: 'BACK' },
      { dir: [0, -1, 0], text: 'FRONT' },
      { dir: [0, 0, 1], text: 'TOP' },
      { dir: [0, 0, -1], text: 'BOTTOM' }
    ];

    for (const f of faceLabels) {
      const tex = this._labelTexture(f.text);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
      const geo = new THREE.PlaneGeometry(1.4, 1.4);
      const mesh = new THREE.Mesh(geo, mat);
      const d = new THREE.Vector3(...f.dir);
      mesh.position.copy(d).multiplyScalar(0.701);
      // The top and bottom labels face along the default up, so lookAt has no
      // up left to work with. Hand it world Y, which is the way those two views
      // put the model on screen, and the text reads the right way round.
      if (Math.abs(d.z) > 0.5) mesh.up.set(0, 1, 0);
      mesh.lookAt(d.clone().multiplyScalar(2));
      mesh.userData.viewDir = f.dir;
      group.add(mesh);
    }

    const boxGeo = new THREE.BoxGeometry(1.4, 1.4, 1.4);
    const boxMat = new THREE.MeshBasicMaterial({ color: 0xe4e1da });
    group.add(new THREE.Mesh(boxGeo, boxMat));

    const edgeGeo = new THREE.EdgesGeometry(boxGeo);
    group.add(
      new THREE.LineSegments(
        edgeGeo,
        new THREE.LineBasicMaterial({ color: 0x8d8980 })
      )
    );

    this.cubeGroup = group;
    this.cubeScene.add(group);
  }

  _labelTexture(text) {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#e4e1da';
    g.fillRect(0, 0, size, size);
    g.strokeStyle = '#ada89c';
    g.lineWidth = 3;
    g.strokeRect(2, 2, size - 4, size - 4);
    g.fillStyle = '#23221d';
    g.font = '17px "Helvetica Neue", Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, size / 2, size / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ---------------------------------------------------------------- */

  _setupNavigation() {
    const el = this.canvas;
    this.nav = { mode: null, lastX: 0, lastY: 0, moved: 0 };
    this.bindings = { ...NAV_DEFAULTS };

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Only a click, not the end of a drag, should open the menu.
      if (this.onContextMenu && this.nav.moved < 4) this.onContextMenu(e);
    });

    el.addEventListener('pointerdown', (e) => {
      // The cube is handled here rather than by the page, so it works while a
      // sketch is open: a sketch takes every other click in the viewport.
      if (e.button === 0) {
        const dir = this.pickViewCube(e.clientX, e.clientY);
        if (dir) {
          this.cubeNav = { dir, lastX: e.clientX, lastY: e.clientY, moved: 0 };
          e.preventDefault();
          el.setPointerCapture(e.pointerId);
          return;
        }
      }

      if (this.onPointerDown && this.onPointerDown(e) === true) return;
      if (e.button !== 1) return;
      const mode = e.shiftKey ? this.bindings.shiftMiddle : this.bindings.middle;
      if (mode !== 'pan' && mode !== 'orbit') return;
      e.preventDefault();
      this.nav.mode = mode;
      this.nav.moved = 0;
      this.nav.lastX = e.clientX;
      this.nav.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      // Dragging the cube orbits, the same as dragging the model does.
      if (this.cubeNav) {
        const dx = e.clientX - this.cubeNav.lastX;
        const dy = e.clientY - this.cubeNav.lastY;
        this.cubeNav.lastX = e.clientX;
        this.cubeNav.lastY = e.clientY;
        this.cubeNav.moved += Math.abs(dx) + Math.abs(dy);
        if (this.cubeNav.moved > CUBE_CLICK_SLOP) {
          this.spherical.theta -= dx * 0.01;
          this.spherical.phi -= dy * 0.01;
          const lim = 0.001;
          this.spherical.phi = Math.max(lim, Math.min(Math.PI - lim, this.spherical.phi));
          this.invalidate();
        }
        return;
      }

      if (!this.nav.mode) {
        if (this.onPointerMove) this.onPointerMove(e);
        return;
      }
      const dx = e.clientX - this.nav.lastX;
      const dy = e.clientY - this.nav.lastY;
      this.nav.lastX = e.clientX;
      this.nav.lastY = e.clientY;
      this.nav.moved += Math.abs(dx) + Math.abs(dy);

      if (this.nav.mode === 'orbit') {
        this.spherical.theta -= dx * 0.008;
        this.spherical.phi -= dy * 0.008;
        const lim = 0.001;
        this.spherical.phi = Math.max(lim, Math.min(Math.PI - lim, this.spherical.phi));
      } else {
        this._pan(dx, dy);
      }
      this.invalidate();
    });

    const endNav = (e) => {
      if (this.cubeNav) {
        const c = this.cubeNav;
        this.cubeNav = null;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* pointer already released */
        }
        // A press that barely moved was a click on a face, so snap to it.
        if (c.moved <= CUBE_CLICK_SLOP && c.dir !== 'inside') this.setView(c.dir);
        return;
      }
      if (this.nav.mode) {
        this.nav.mode = null;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* pointer already released */
        }
      }
      if (this.onPointerUp) this.onPointerUp(e);
    };
    el.addEventListener('pointerup', endNav);
    el.addEventListener('pointercancel', endNav);

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this._zoomAtCursor(e);
      },
      { passive: false }
    );
  }

  _pan(dx, dy) {
    const dist = this.usePerspective
      ? this.spherical.radius
      : this.orthoZoom * 2;
    const rect = this.canvas.getBoundingClientRect();
    const scale = this.usePerspective
      ? (2 * dist * Math.tan((this.perspective.fov * Math.PI) / 360)) / rect.height
      : (this.orthoZoom * 2) / rect.height;

    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.camera.updateMatrixWorld();
    right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    up.setFromMatrixColumn(this.camera.matrixWorld, 1);

    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(up, dy * scale);
  }

  _zoomAtCursor(e) {
    const before = this.bindings.zoomToCursor
      ? this.screenToWorldOnPlane(e.clientX, e.clientY)
      : null;

    const direction = this.bindings.invertZoom ? 1 : -1;
    const factor = Math.pow(
      0.94,
      direction * Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 60 + 1)
    );
    if (this.usePerspective) {
      this.spherical.radius = THREE.MathUtils.clamp(
        this.spherical.radius * factor,
        0.5,
        50000
      );
    } else {
      this.orthoZoom = THREE.MathUtils.clamp(this.orthoZoom * factor, 0.2, 20000);
    }
    this._syncCamera();

    if (before) {
      const after = this.screenToWorldOnPlane(e.clientX, e.clientY);
      if (after) this.target.add(before.sub(after));
    }
    this.invalidate();
  }

  /** Intersection of the cursor ray with the plane through the orbit target. */
  screenToWorldOnPlane(clientX, clientY, planeNormal) {
    const ray = this.raycastRay(clientX, clientY);
    if (!ray) return null;
    const n = planeNormal
      ? planeNormal.clone()
      : this.camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.target);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, hit) ? hit : null;
  }

  /** How much world space one screen pixel covers at the target distance. */
  pixelWorldSize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!this.usePerspective) return (this.orthoZoom * 2) / Math.max(rect.height, 1);
    return (
      (2 * this.spherical.radius * Math.tan((this.perspective.fov * Math.PI) / 360)) /
      Math.max(rect.height, 1)
    );
  }

  raycastRay(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    rc.params.Line = { threshold: this.pixelSize(clientX, clientY) * 6 };
    rc.params.Points = { threshold: this.pixelSize(clientX, clientY) * 8 };
    return rc;
  }

  /** World-space size of one screen pixel, for hit tolerance and marker scale. */
  pixelSize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!this.usePerspective) return (this.orthoZoom * 2) / rect.height;
    return (
      (2 * this.spherical.radius * Math.tan((this.perspective.fov * Math.PI) / 360)) /
      rect.height
    );
  }

  /* ---------------------------------------------------------------- */

  _screenUp() {
    const { phi, theta } = this.spherical;
    return new THREE.Vector3(...screenUpFor(phi, theta));
  }

  _syncCamera() {
    const offset = new THREE.Vector3().setFromSpherical(this.spherical);
    // Spherical is Y-up internally; swap so the model space stays Z-up.
    const pos = new THREE.Vector3(offset.x, offset.z, offset.y);

    // The world up projected into the view plane, worked out here rather than
    // left to lookAt. Looking straight down Z the two are parallel, and three's
    // fallback for that picks a basis rolled ninety degrees: a sketch on XY
    // then records a line drawn rightwards as going up, and the constraint
    // inferred from it is vertical when the screen shows horizontal.
    const up = this._screenUp();

    this.perspective.position.copy(this.target).add(pos);
    this.perspective.up.copy(up);
    this.perspective.lookAt(this.target);

    this.ortho.position.copy(this.target).add(pos);
    this.ortho.up.copy(up);
    this.ortho.lookAt(this.target);

    const rect = this.canvas.getBoundingClientRect();
    const aspect = Math.max(rect.width / Math.max(rect.height, 1), 0.001);
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();

    this.ortho.left = -this.orthoZoom * aspect;
    this.ortho.right = this.orthoZoom * aspect;
    this.ortho.top = this.orthoZoom;
    this.ortho.bottom = -this.orthoZoom;
    this.ortho.updateProjectionMatrix();

    this.camera = this.usePerspective ? this.perspective : this.ortho;
    this.cameraLight.position.copy(this.camera.position);
  }

  setProjection(perspective) {
    if (this.usePerspective === perspective) return;
    // Keep the apparent size the same when swapping projections.
    if (perspective) {
      this.spherical.radius =
        this.orthoZoom / Math.tan((this.perspective.fov * Math.PI) / 360);
    } else {
      this.orthoZoom = this.spherical.radius * Math.tan((this.perspective.fov * Math.PI) / 360);
    }
    this.usePerspective = perspective;
    this.invalidate();
  }

  /**
   * Look along `dir`. `up` asks for a particular screen up and is honoured
   * looking straight down Z, where the roll is free; elsewhere the world up
   * settles it and the hint is ignored.
   */
  setView(dir, animate = true, up = null) {
    const v = new THREE.Vector3(...dir).normalize();
    const r = this.spherical.radius;
    const target = new THREE.Spherical().setFromVector3(
      new THREE.Vector3(v.x, v.z, v.y).multiplyScalar(r)
    );
    if (Math.abs(v.z) > 0.999) {
      // setFromVector3 leaves theta at zero here because the camera does not
      // move with it. It is the roll, so it has to be chosen: default to world
      // Y up the screen, which is what Top and Bottom mean everywhere else.
      target.theta = rollTheta(v.z > 0 ? 1 : -1, up || [0, 1, 0]);
    }
    if (!animate) {
      this.spherical.copy(target);
      this.invalidate();
      return;
    }
    this._animateTo(target);
  }

  setHomeView() {
    this.setView(ISO_VIEW);
  }

  _animateTo(targetSpherical) {
    const start = this.spherical.clone();
    const t0 = performance.now();
    const dur = 260;
    let dTheta = targetSpherical.theta - start.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;

    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.spherical.radius = start.radius + (targetSpherical.radius - start.radius) * e;
      this.spherical.phi = start.phi + (targetSpherical.phi - start.phi) * e;
      this.spherical.theta = start.theta + dTheta * e;
      this.invalidate();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  fit(padding = 1.35) {
    const box = new THREE.Box3();
    let any = false;
    this.bodyGroup.traverse((o) => {
      if (o.isMesh && o.visible) {
        o.geometry.computeBoundingBox();
        box.expandByObject(o);
        any = true;
      }
    });
    if (!any) {
      this.target.set(0, 0, 0);
      this.spherical.radius = 220;
      this.orthoZoom = 120;
      this.invalidate();
      return;
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);
    this.target.copy(center);
    this.spherical.radius = (radius * padding) / Math.tan((this.perspective.fov * Math.PI) / 360);
    this.orthoZoom = radius * padding;
    this.invalidate();
  }

  /* ---------------------------------------------------------------- */

  setBodies(bodyRecords) {
    const seen = new Set();

    for (const rec of bodyRecords) {
      seen.add(rec.id);
      let entry = this.bodies.get(rec.id);
      // An inspection can hand over a different mesh to draw. The record keeps
      // its real one, so picking, measuring and export are unaffected.
      const shown = rec.displayMesh || rec.mesh;
      const geom = buildGeometry(shown);
      // Model edges from the topology when it is available, so what is drawn
      // is what can be selected. Crease detection is the fallback.
      const edgeGeom =
        rec.displayMesh || !rec.topology ? buildEdges(shown) : this._edgeGeometry(rec);

      if (!entry) {
        // A pale warm grey, brighter than the ground it sits on, with no
        // metal in it. The shape is the subject, not the finish.
        const mat = new THREE.MeshStandardMaterial({
          color: rec.sheet ? SHEET_COLOUR : 0xe0dcd2,
          metalness: 0.0,
          roughness: 0.62,
          flatShading: false,
          side: rec.sheet ? THREE.DoubleSide : THREE.FrontSide
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.bodyId = rec.id;
        mesh.userData.pickable = 'body';

        const lineMat = new THREE.LineBasicMaterial({
          color: 0x2a2822,
          transparent: true,
          opacity: 0.92
        });
        const lines = new THREE.LineSegments(edgeGeom, lineMat);
        lines.renderOrder = 2;
        mesh.add(lines);

        entry = { mesh, lines, mat };
        this.bodies.set(rec.id, entry);
        this.bodyGroup.add(mesh);
      } else {
        entry.mesh.geometry.dispose();
        entry.lines.geometry.dispose();
        entry.mesh.geometry = geom;
        entry.lines.geometry = edgeGeom;
      }
      // A polished finish, for reading reflections off a surface. It is a
      // material swap and nothing else: the geometry is untouched, and the
      // moment the analysis goes away so does the chrome.
      if (rec.chrome) {
        entry.mat.metalness = 1;
        entry.mat.roughness = 0.08;
        entry.mat.color.set(0xf2f0ec);
        entry.mat.envMapIntensity = 1.4;
      } else if (entry.mat.metalness) {
        entry.mat.metalness = 0;
        entry.mat.roughness = 0.62;
        entry.mat.color.set(rec.sheet ? SHEET_COLOUR : 0xe0dcd2);
      }

      // A surface has no inside, so it is drawn from both sides and in its own
      // warmer tone. Being able to tell one from a solid at a glance is the
      // whole reason it looks different: everything you can do with it is
      // different too.
      const wantSide = rec.sheet ? THREE.DoubleSide : THREE.FrontSide;
      if (entry.mat.side !== wantSide) {
        entry.mat.side = wantSide;
        entry.mat.needsUpdate = true;
      }
      if (rec.sheet && !rec.chrome && !entry.mat.vertexColors) {
        entry.mat.color.set(SHEET_COLOUR);
      }

      // Coloured per vertex when an analysis says so, and back to the plain
      // warm grey the moment it does not.
      if (
        !rec.chrome &&
        rec.vertexColours &&
        rec.vertexColours.length === shown.vertProperties.length
      ) {
        geom.setAttribute(
          'color',
          new THREE.Float32BufferAttribute(rec.vertexColours, 3)
        );
        entry.mat.vertexColors = true;
        entry.mat.color.set(0xffffff);
      } else if (entry.mat.vertexColors) {
        entry.mat.vertexColors = false;
        entry.mat.color.set(rec.sheet ? SHEET_COLOUR : 0xe0dcd2);
      }
      entry.mat.needsUpdate = true;

      // What colour this body is when nothing is happening to it. Selection and
      // hover both paint over the material, so they have to be able to put back
      // what was there, which is not the same for every body.
      entry.base = rec.chrome
        ? 0xf2f0ec
        : entry.mat.vertexColors
          ? 0xffffff
          : rec.sheet
            ? SHEET_COLOUR
            : 0xe0dcd2;

      entry.mesh.visible = rec.visible !== false && !(rec.displayMesh === null);
      entry.record = rec;
      entry.segEdge = this._lastSegEdge || null;
      this._lastSegEdge = null;
    }

    for (const [id, entry] of [...this.bodies]) {
      if (seen.has(id)) continue;
      this.bodyGroup.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.lines.geometry.dispose();
      entry.mat.dispose();
      this.bodies.delete(id);
    }

    this._applyHighlights();
    this.invalidate();
  }

  /** Model edges as one line set, with a map from segment back to edge id. */
  _edgeGeometry(rec) {
    const verts = [];
    const segEdge = [];
    for (const edge of rec.topology.edges) {
      // Tangent boundaries stay selectable but are not drawn, which is what
      // keeps a filleted corner reading as one smooth surface.
      if (edge.tangent) continue;
      for (let i = 0; i < edge.points.length - 1; i++) {
        const a = edge.points[i];
        const b = edge.points[i + 1];
        verts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        segEdge.push(edge.id);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this._lastSegEdge = segEdge;
    return geom;
  }

  /**
   * Overlay the faces and edges currently under the cursor or selected.
   * Drawn as separate throwaway geometry rather than by recolouring the body,
   * because a face is a subset of triangles, not an object of its own.
   */
  setHighlight({ faces = [], edges = [], hoverFace = null, hoverEdge = null } = {}) {
    if (!this.highlightGroup) {
      this.highlightGroup = new THREE.Group();
      this.overlayGroup.add(this.highlightGroup);
    }
    const g = this.highlightGroup;
    while (g.children.length) {
      const c = g.children.pop();
      c.geometry.dispose();
      c.material.dispose();
    }

    const faceMesh = (ref, color, opacity) => {
      const entry = this.bodies.get(ref.bodyId);
      if (!entry || !entry.record?.topology) return;
      const face = entry.record.topology.faces[ref.faceId];
      if (!face) return;
      const mesh = entry.record.mesh;
      const stride = mesh.numProp;
      const pos = mesh.vertProperties;
      const tris = mesh.triVerts;
      const arr = new Float32Array(face.tris.length * 9);
      let o = 0;
      for (const t of face.tris) {
        for (let k = 0; k < 3; k++) {
          const b = tris[t * 3 + k] * stride;
          arr[o++] = pos[b];
          arr[o++] = pos[b + 1];
          arr[o++] = pos[b + 2];
        }
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
      });
      const m = new THREE.Mesh(geom, mat);
      m.renderOrder = 4;
      g.add(m);
    };

    const edgeLine = (ref, color) => {
      const entry = this.bodies.get(ref.bodyId);
      if (!entry || !entry.record?.topology) return;
      const edge = entry.record.topology.edges[ref.edgeId];
      if (!edge) return;
      const verts = [];
      for (let i = 0; i < edge.points.length - 1; i++) {
        const a = edge.points[i];
        const b = edge.points[i + 1];
        verts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
      const line = new THREE.LineSegments(geom, mat);
      line.renderOrder = 9;
      g.add(line);
    };

    // Hover is a whisper in grey; the accent is spent only on what is chosen.
    if (hoverFace) faceMesh(hoverFace, 0x6f6b62, 0.22);
    for (const f of faces) faceMesh(f, 0xd84b1e, 0.4);
    if (hoverEdge) edgeLine(hoverEdge, 0x4a463e);
    for (const e of edges) edgeLine(e, 0xd84b1e);

    this.invalidate();
  }

  /**
   * What is under the cursor. Edges win over faces within a few pixels, which
   * is what makes picking an edge to fillet feel reliable.
   */
  pickEntity(clientX, clientY, opts = {}) {
    const rc = this.raycastRay(clientX, clientY);
    const visible = [...this.bodies.entries()].filter(([, b]) => b.mesh.visible);

    if (opts.edges !== false) {
      let best = null;
      const px = this.pixelSize();
      rc.params.Line = { threshold: px * 5 };
      for (const [id, entry] of visible) {
        if (!entry.segEdge) continue;
        const hits = rc.intersectObject(entry.lines, false);
        for (const h of hits) {
          const seg = Math.floor(h.index / 2);
          const edgeId = entry.segEdge[seg];
          if (edgeId === undefined) continue;
          if (!best || h.distance < best.distance) {
            best = { kind: 'edge', bodyId: id, edgeId, point: h.point, distance: h.distance };
          }
        }
      }
      if (best) return best;
    }

    const meshes = visible.map(([, b]) => b.mesh);
    const hits = rc.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const hit = hits[0];
    const bodyId = hit.object.userData.bodyId;
    const entry = this.bodies.get(bodyId);
    const topo = entry?.record?.topology;
    const faceId = topo && hit.faceIndex !== undefined ? topo.triFace[hit.faceIndex] : null;
    return {
      kind: faceId !== null && faceId >= 0 ? 'face' : 'body',
      bodyId,
      faceId: faceId >= 0 ? faceId : null,
      point: hit.point,
      distance: hit.distance
    };
  }

  setSelection(ids) {
    this.selection = new Set(ids);
    this._applyHighlights();
    this.invalidate();
  }

  setHover(id) {
    if (this.hover === id) return;
    this.hover = id;
    this._applyHighlights();
    this.invalidate();
  }

  _applyHighlights() {
    const white = new THREE.Color(0xffffff);
    for (const [id, entry] of this.bodies) {
      const selected = this.selection.has(id);
      const hovered = this.hover === id;
      const base = entry.base ?? 0xe0dcd2;
      if (selected) entry.mat.color.setHex(0xe8b8a4);
      else if (hovered) entry.mat.color.setHex(base).lerp(white, 0.3);
      else entry.mat.color.setHex(base);
      entry.mat.emissive = new THREE.Color(selected ? 0x3a1408 : 0x000000);
    }
  }

  setGridVisible(v) {
    this.grid.visible = v;
    this.invalidate();
  }

  setOriginVisible(v) {
    this.axes.visible = v;
    this.invalidate();
  }

  setPlanesVisible(v) {
    this.originPlanes.visible = v;
    this.invalidate();
  }

  /** Light up one origin plane by name, so it is obvious what a click will take. */
  setPlaneHover(name) {
    if (this._planeHover === name) return;
    this._planeHover = name;
    for (const mesh of this.originPlanes.children) {
      mesh.material.opacity = mesh.userData.planeName === name ? 0.32 : 0.12;
    }
    this.invalidate();
  }

  setBodiesVisible(v) {
    this.bodyGroup.visible = v;
    this.invalidate();
  }

  setBodyOpacity(alpha) {
    for (const [, entry] of this.bodies) {
      entry.mat.transparent = alpha < 1;
      entry.mat.opacity = alpha;
      entry.mat.depthWrite = alpha >= 1;
      entry.mat.needsUpdate = true;
    }
    this.invalidate();
  }

  /* ---------------------------------------------------------------- */

  pickBody(clientX, clientY) {
    const rc = this.raycastRay(clientX, clientY);
    const meshes = [...this.bodies.values()].map((b) => b.mesh).filter((m) => m.visible);
    const hits = rc.intersectObjects(meshes, false);
    if (!hits.length) return null;
    return {
      bodyId: hits[0].object.userData.bodyId,
      point: hits[0].point,
      faceNormal: hits[0].face
        ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld)
        : null,
      faceIndex: hits[0].faceIndex,
      object: hits[0].object
    };
  }

  /** Where a world point lands on screen, in client coordinates. */
  worldToScreen(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      clientX: rect.left + ((v.x + 1) / 2) * rect.width,
      clientY: rect.top + ((-v.y + 1) / 2) * rect.height,
      behind: v.z > 1
    };
  }

  pickPlane(clientX, clientY) {
    if (!this.originPlanes.visible) return null;
    const rc = this.raycastRay(clientX, clientY);
    const hits = rc.intersectObjects(this.originPlanes.children, false);
    if (!hits.length) return null;
    return { planeName: hits[0].object.userData.planeName, point: hits[0].point };
  }

  pickViewCube(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const size = 96;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const cx = rect.width - size - 12;
    const cy = 12;
    if (x < cx || x > cx + size || y < cy || y > cy + size) return null;

    const ndc = new THREE.Vector2(
      ((x - cx) / size) * 2 - 1,
      -((y - cy) / size) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.cubeCamera);
    const hits = rc.intersectObjects(this.cubeGroup.children, false);
    for (const h of hits) {
      if (h.object.userData.viewDir) return h.object.userData.viewDir;
    }
    return 'inside';
  }

  /* ---------------------------------------------------------------- */

  invalidate() {
    this.needsRender = true;
  }

  _onResize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    // Nothing to do when the size has not actually moved, which also keeps the
    // size observer from feeding itself.
    if (this._lastW === rect.width && this._lastH === rect.height) return;
    this._lastW = rect.width;
    this._lastH = rect.height;
    this.renderer.setSize(rect.width, rect.height, false);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.invalidate();
  }

  _loop() {
    requestAnimationFrame(this._loop);
    if (!this.needsRender) return;
    this.needsRender = false;

    this._syncCamera();

    const rect = this.canvas.getBoundingClientRect();
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, rect.width, rect.height);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // View cube, drawn over the top right corner.
    const size = 96;
    const pad = 12;
    this.cubeGroup.quaternion.copy(this.camera.quaternion).invert();
    this.cubeCamera.position.set(0, 0, 6);
    this.cubeCamera.lookAt(0, 0, 0);
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(rect.width - size - pad, rect.height - size - pad, size, size);
    this.renderer.setScissor(rect.width - size - pad, rect.height - size - pad, size, size);
    this.renderer.clearDepth();
    this.renderer.render(this.cubeScene, this.cubeCamera);
    this.renderer.setScissorTest(false);

    // Anything drawn in HTML over the canvas (dimension text, constraint
    // glyphs) repositions here, once the camera for this frame is final.
    if (this.onRendered) this.onRendered();
  }
}

export { UP };
