/**
 * ThreeOverlay — Three.js on a SEPARATE canvas over MapLibre
 *
 * Solves all depth/culling/state issues by not sharing WebGL context.
 * MapLibre CustomLayer is used only to capture the projection matrix.
 * Three.js renders to its own canvas with its own depth buffer.
 */

import maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { computeSunVector, dateToDayOfYear } from './SunPosition.js';
import { INSOL_CONFIG } from '../insolation/InsolationConfig.js';

export class ThreeOverlay {
  constructor(mapManager) {
    this._mapManager = mapManager;
    this._scene = new THREE.Scene();
    this._camera = new THREE.Camera();
    this._renderer = null;
    this._canvas = null;
    this._map = null;
    this._layerId = 'three-sync';
    this._initialized = false;

    this._originX = 0;
    this._originY = 0;
    this._originZ = 0;
    this._scale = 0;
    this._originSet = false;
    this._lastMatrix = null;

    // Whitewash mode — when true, every Mesh in the scene (existing
    // and added afterwards) gets a single white material. Original
    // material is stashed on `mesh.userData.origMat` so toggling off
    // restores it. LineSegments / sprites / transparent materials
    // are skipped so the wireframes and glass keep reading correctly.
    this._whitewashed = false;
    this._whiteMat = new THREE.MeshLambertMaterial({
      color: 0xffffff, side: THREE.DoubleSide
    });

    // Sun light + ground plane — created in init(). Sun position is
    // astronomical (computeSunVector); shadow casting is gated by
    // whitewash so we don't pay the perf cost during normal editing.
    this._sunLight = null;
    this._groundPlane = null;
    // Default sun config — June 21 (summer solstice), 14:00 local
    // solar time. Phase 4 will hook hour/day to a UI control.
    this._sunConfig = {
      latitude: INSOL_CONFIG.latitude,
      dayOfYear: dateToDayOfYear(6, 21),
      hour: 14
    };
  }

  setOrigin(lng, lat) {
    var mc = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], 0);
    this._originX = mc.x;
    this._originY = mc.y;
    this._originZ = mc.z || 0;
    this._scale = mc.meterInMercatorCoordinateUnits();
    this._originSet = true;
  }

  init() {
    if (this._initialized) return;
    var map = this._mapManager.getMap();
    if (!map) return;
    this._map = map;

    // Create overlay canvas
    var mapCanvas = map.getCanvas();
    this._canvas = document.createElement('canvas');
    this._canvas.style.position = 'absolute';
    this._canvas.style.top = '0';
    this._canvas.style.left = '0';
    this._canvas.style.pointerEvents = 'none';  // clicks pass through to map
    this._canvas.width = mapCanvas.width;
    this._canvas.height = mapCanvas.height;
    this._canvas.style.width = mapCanvas.style.width;
    this._canvas.style.height = mapCanvas.style.height;

    mapCanvas.parentElement.appendChild(this._canvas);

    // Create independent renderer
    // preserveDrawingBuffer=true so canvas.toDataURL() works for the
    // AI-render screenshot path. Tiny perf cost on most hardware.
    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      alpha: true,  // transparent background → map shows through
      preserveDrawingBuffer: true
    });
    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.setClearColor(0x000000, 0);  // fully transparent
    this._renderer.setSize(mapCanvas.clientWidth, mapCanvas.clientHeight, false);
    // Soft shadows — gated by sun light's castShadow flag (toggled
    // with whitewash) so the shadow pass only runs in white-model.
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Lighting
    var ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this._scene.add(ambient);

    // Sun — astronomical direction. castShadow toggled with whitewash.
    this._sunLight = new THREE.DirectionalLight(0xffffff, 0.9);
    this._scene.add(this._sunLight);
    this._scene.add(this._sunLight.target);
    var SHADOW_HALF = 250;  // tighter ortho extent → better shadow texel density
    this._sunLight.shadow.camera.near = 1;
    this._sunLight.shadow.camera.far = 2400;
    this._sunLight.shadow.camera.left = -SHADOW_HALF;
    this._sunLight.shadow.camera.right = SHADOW_HALF;
    this._sunLight.shadow.camera.top = SHADOW_HALF;
    this._sunLight.shadow.camera.bottom = -SHADOW_HALF;
    this._sunLight.shadow.mapSize.set(2048, 2048);
    this._sunLight.shadow.bias = -0.0005;
    this._sunLight.shadow.normalBias = 0.03;
    this._sunLight.castShadow = false;  // turned on when whitewash enables
    this._applySunPosition();

    var fill = new THREE.DirectionalLight(0xffffff, 0.2);
    fill.position.set(-80, -100, 150);
    this._scene.add(fill);

    // Shadow-catcher plane — invisible everywhere except where a
    // shadow lands on it, so the actual MapLibre map stays visible
    // under it and shadows appear as dark patches on the map.
    var planeGeo = new THREE.PlaneGeometry(2000, 2000);
    var planeMat = new THREE.ShadowMaterial({
      color: 0x000000, opacity: 0.55, depthWrite: false
    });
    this._groundPlane = new THREE.Mesh(planeGeo, planeMat);
    // Sit slightly below z=0 so cocoll's bottom face doesn't z-fight
    // against the plane, but close enough for the shadow lookup to be
    // accurate at the building base.
    this._groundPlane.position.set(0, 0, -0.05);
    this._groundPlane.receiveShadow = true;
    this._groundPlane.userData.whiteModelExtra = true;
    this._groundPlane.visible = false;
    this._scene.add(this._groundPlane);

    // Sync layer — captures matrix from MapLibre every frame
    var self = this;

    var syncLayer = {
      id: this._layerId,
      type: 'custom',
      renderingMode: '3d',
      onAdd: function () {},
      render: function (gl, matrix) {
        self._lastMatrix = matrix;
        self._renderFrame();
      }
    };

    map.addLayer(syncLayer);

    // Resize handling
    var resizeObserver = new ResizeObserver(function () {
      var mc = map.getCanvas();
      self._canvas.width = mc.width;
      self._canvas.height = mc.height;
      self._canvas.style.width = mc.style.width;
      self._canvas.style.height = mc.style.height;
      self._renderer.setSize(mc.clientWidth, mc.clientHeight, false);
    });
    resizeObserver.observe(mapCanvas);
    this._resizeObserver = resizeObserver;

    this._initialized = true;
  }

  _renderFrame() {
    if (!this._renderer || !this._originSet || !this._lastMatrix) return;

    // Force matrix updates on the sun light + target so the shadow
    // camera follows the current sun position. Three.js auto-updates
    // these inside renderer.render(), but the custom MVP camera path
    // is non-standard enough that an explicit update is the safer
    // bet for shadow correctness.
    if (this._sunLight && this._sunLight.castShadow) {
      this._sunLight.target.updateMatrixWorld(true);
      this._sunLight.updateMatrixWorld(true);
    }

    var s = this._scale;

    var modelMatrix = new THREE.Matrix4()
      .makeTranslation(this._originX, this._originY, this._originZ)
      .scale(new THREE.Vector3(s, -s, s));

    var mvp = new THREE.Matrix4().fromArray(this._lastMatrix).multiply(modelMatrix);

    this._camera.projectionMatrix = mvp;
    this._camera.projectionMatrixInverse.copy(mvp).invert();

    this._renderer.render(this._scene, this._camera);
  }

  getScene() { return this._scene; }

  getCanvas() { return this._canvas; }

  /**
   * Move the sun light to match the current sunConfig. Called on
   * init and whenever Phase-4 controls update hour/day/latitude.
   */
  _applySunPosition() {
    if (!this._sunLight) return;
    var v = computeSunVector(this._sunConfig.latitude,
      this._sunConfig.dayOfYear, this._sunConfig.hour);
    // Place the light far along the sun direction so the rays read as
    // parallel; the orthographic shadow camera handles the rest.
    var SUN_DIST = 800;
    this._sunLight.position.set(v.x * SUN_DIST, v.y * SUN_DIST, Math.max(v.z, 0.05) * SUN_DIST);
    this._sunLight.target.position.set(0, 0, 0);
    this._sunLight.target.updateMatrixWorld();
    if (this._sunLight.shadow && this._sunLight.shadow.camera) {
      this._sunLight.shadow.camera.updateProjectionMatrix();
    }
  }

  /**
   * Update the sun configuration and re-apply position. Phase 4 wires
   * UI sliders into this. Object-merge so callers can pass any subset.
   */
  setSunConfig(cfg) {
    if (!cfg) return;
    if (cfg.latitude != null)  this._sunConfig.latitude  = cfg.latitude;
    if (cfg.dayOfYear != null) this._sunConfig.dayOfYear = cfg.dayOfYear;
    if (cfg.hour != null)      this._sunConfig.hour      = cfg.hour;
    this._applySunPosition();
    if (this._map) this._map.triggerRepaint();
  }
  getSunConfig() { return Object.assign({}, this._sunConfig); }

  requestRender() {
    if (this._map) this._map.triggerRepaint();
  }

  /**
   * Render one frame synchronously using the last matrix from MapLibre.
   * Used by the AI-render screenshot pipeline so toDataURL captures the
   * intended state (e.g. whitewash just toggled on) without waiting for
   * the next MapLibre repaint.
   */
  forceRender() {
    this._renderFrame();
  }

  addMesh(obj) {
    this._scene.add(obj);
    // Always reconcile the new subtree with the current whitewash
    // state — covers material swap, hideInWhitewash, and
    // whiteModelExtra (which needs an initial-invisible apply when
    // added while WM is off).
    this._whitewashSubtree(obj, this._whitewashed);
    // Tag every mesh in the subtree so the sun light's shadow pass
    // sees them. Glass / sprite materials self-skip via Three.js's
    // depth-write rules, so this blanket assignment is safe.
    obj.traverse(function (o) {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    if (this._map) this._map.triggerRepaint();
  }

  /**
   * Toggle whitewash. When enabled, every existing Mesh switches to a
   * single white material; subsequent `addMesh` calls inherit the
   * mode automatically. Disabling restores each mesh's original
   * material from `userData.origMat`.
   */
  setWhitewash(enabled) {
    enabled = !!enabled;
    if (this._whitewashed === enabled) return;
    this._whitewashed = enabled;
    var self = this;
    this._scene.traverse(function (obj) { self._whitewashOne(obj, enabled); });
    // Sun shadow pass is only paid for in white-model mode — the
    // shadow map is hidden behind colourful materials anyway and the
    // perf hit is real on heavy scenes.
    if (this._sunLight) this._sunLight.castShadow = enabled;
    if (this._map) this._map.triggerRepaint();
  }

  isWhitewashed() { return this._whitewashed; }

  _whitewashSubtree(root, enabled) {
    var self = this;
    root.traverse(function (obj) { self._whitewashOne(obj, enabled); });
  }

  _whitewashOne(obj, enabled) {
    // Hide-flag — works for any object type (Mesh, Sprite, Group,
    // LineSegments). Used to drop floor labels, insol dots, ray
    // visualizations etc. from the screenshot. The original visible
    // state is stashed so toggling off is symmetric.
    if (obj.userData && obj.userData.hideInWhitewash) {
      if (enabled) {
        if (obj.userData._wwOrigVisible === undefined) {
          obj.userData._wwOrigVisible = obj.visible;
        }
        obj.visible = false;
      } else if (obj.userData._wwOrigVisible !== undefined) {
        obj.visible = obj.userData._wwOrigVisible;
        delete obj.userData._wwOrigVisible;
      }
    }

    // Show-only-in-whitewash flag — used for tower full-height detailed
    // floors, tower LLU roof extrusion, and the 0.5 m top slab. These
    // are heavy meshes that we only want to render in white-model mode.
    if (obj.userData && obj.userData.whiteModelExtra) {
      obj.visible = enabled;
    }

    // Material swap — only for solid meshes. Transparent / sprite
    // materials are skipped so glass + labels keep reading correctly.
    if (!obj.isMesh || !obj.material) return;
    var mat = obj.material;
    if (Array.isArray(mat)) return;
    if (mat.transparent) return;
    // Explicit opt-out — set either on the mesh (per-instance) or on
    // the material (covers every mesh that shares this reference, e.g.
    // MATERIALS.llu, GROUND_FLOOR_MAT, ROOF_*_MAT).
    if (obj.userData && obj.userData.skipWhitewash) return;
    if (mat.userData && mat.userData.skipWhitewash) return;
    if (enabled) {
      if (!obj.userData.origMat) obj.userData.origMat = mat;
      obj.material = this._whiteMat;
    } else if (obj.userData.origMat) {
      obj.material = obj.userData.origMat;
      obj.userData.origMat = null;
    }
  }

  removeMesh(obj) {
    this._scene.remove(obj);
    if (this._map) this._map.triggerRepaint();
  }

  clear() {
    var toRemove = [];
    for (var i = 0; i < this._scene.children.length; i++) {
      var child = this._scene.children[i];
      if (!child.isLight) toRemove.push(child);
    }
    for (var i = 0; i < toRemove.length; i++) {
      this._scene.remove(toRemove[i]);
      this._disposeDeep(toRemove[i]);
    }
    if (this._map) this._map.triggerRepaint();
  }

  _disposeDeep(obj) {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        for (var i = 0; i < obj.material.length; i++) obj.material[i].dispose();
      } else {
        obj.material.dispose();
      }
    }
    if (obj.children) {
      for (var i = obj.children.length - 1; i >= 0; i--) {
        this._disposeDeep(obj.children[i]);
      }
    }
  }

  destroy() {
    this.clear();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._map && this._map.getLayer(this._layerId)) {
      this._map.removeLayer(this._layerId);
    }
    if (this._canvas && this._canvas.parentElement) {
      this._canvas.parentElement.removeChild(this._canvas);
    }
    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }
    this._initialized = false;
  }
}
