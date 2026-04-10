/**
 * ThreeOverlay — Three.js on a SEPARATE canvas over MapLibre
 *
 * Solves all depth/culling/state issues by not sharing WebGL context.
 * MapLibre CustomLayer is used only to capture the projection matrix.
 * Three.js renders to its own canvas with its own depth buffer.
 */

import maplibregl from 'maplibre-gl';
import * as THREE from 'three';

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
    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      alpha: true  // transparent background → map shows through
    });
    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.setClearColor(0x000000, 0);  // fully transparent
    this._renderer.setSize(mapCanvas.clientWidth, mapCanvas.clientHeight, false);

    // Lighting
    var ambient = new THREE.AmbientLight(0xffffff, 0.65);
    this._scene.add(ambient);

    var dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(100, 200, 300);
    this._scene.add(dir);

    var fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(-80, -100, 150);
    this._scene.add(fill);

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

  requestRender() {
    if (this._map) this._map.triggerRepaint();
  }

  addMesh(obj) {
    this._scene.add(obj);
    if (this._map) this._map.triggerRepaint();
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
