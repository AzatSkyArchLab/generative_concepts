/**
 * Urban-block 3D module — owns the white shadow-catching ground plane
 * inside each urban-block polygon.
 *
 * The plane sits at z=-0.01 (just below the section base at z=0) so:
 *   1. Sections / corners visually rest on it.
 *   2. Shadows from the sun light land on it (receiveShadow=true).
 *   3. It hides the map under the block, giving the structure a sense
 *      of being "slightly raised" above the basemap.
 *
 * Whitewash-aware: tagged `whiteModelExtra` so only visible in white
 * model mode. Tagged `skipWhitewash` so its already-white material is
 * not replaced during the whitewash pass.
 */

import * as THREE from 'three';
import { createProjection } from '../../core/geo/projection.js';
import { getExtractedBuildings } from '../metatiler/index.js';
import { buildContextMeshData } from '../../core/metatiler/buildings-local.js';

var module_ = {
  id: 'urban-block-3d',

  init: function (ctx) {
    var self = this;
    this._ctx = ctx;
    this._meshByBlockId = {};
    this._origin = null;

    ctx.eventBus.on('section-gen:origin', function (origin) {
      if (origin && origin.length >= 2) self._origin = [origin[0], origin[1]];
    });
    ctx.eventBus.on('features:changed', function () { self._refresh(); });

    // Surrounding-buildings shadow stand-in. Whenever metatiler
    // extracts a fresh building set (buffer change, layer toggle), we
    // rebuild the ShadowMaterial mesh so the sun light's shadow pass
    // hits real building faces rather than nothing.
    ctx.eventBus.on('metatiler:buildings:extracted', function () {
      self._rebuildContextBuildings();
    });
    ctx.eventBus.on('metatiler:layer:changed', function () {
      // Layer toggled / removed — features list may have shrunk.
      self._rebuildContextBuildings();
    });

    self._refresh();
  },

  destroy: function () {
    var overlay = this._ctx && this._ctx.threeOverlay;
    if (overlay) {
      var ids = Object.keys(this._meshByBlockId);
      for (var i = 0; i < ids.length; i++) {
        var m = this._meshByBlockId[ids[i]];
        overlay.removeMesh(m);
        if (m.geometry) m.geometry.dispose();
        if (m.material && m.material.dispose) m.material.dispose();
      }
    }
    this._meshByBlockId = {};
  },

  _refresh: function () {
    var ctx = this._ctx;
    var overlay = ctx && ctx.threeOverlay;
    if (!overlay) return;

    var all = ctx.featureStore.toArray();
    var seen = {};

    for (var i = 0; i < all.length; i++) {
      var f = all[i];
      var p = f.properties || {};
      if (!p.urbanBlock) continue;
      seen[p.id] = true;
      if (this._meshByBlockId[p.id]) continue; // already built

      var origin = this._resolveOrigin(f);
      if (!origin) continue;
      if (!overlay._originSet) overlay.setOrigin(origin[0], origin[1]);

      var proj = createProjection(origin[0], origin[1]);
      var mesh = this._buildBlockGround(f, proj);
      if (mesh) {
        this._meshByBlockId[p.id] = mesh;
        overlay.addMesh(mesh);
      }
    }

    var ids = Object.keys(this._meshByBlockId);
    for (var k = 0; k < ids.length; k++) {
      if (seen[ids[k]]) continue;
      var stale = this._meshByBlockId[ids[k]];
      overlay.removeMesh(stale);
      if (stale.geometry) stale.geometry.dispose();
      if (stale.material && stale.material.dispose) stale.material.dispose();
      delete this._meshByBlockId[ids[k]];
    }
  },

  _resolveOrigin: function (feature) {
    if (this._origin) return this._origin;
    var coords = feature.geometry && feature.geometry.coordinates && feature.geometry.coordinates[0];
    if (!coords || coords.length < 3) return null;
    var cx = 0, cy = 0, n = 0;
    for (var i = 0; i < coords.length - 1; i++) {
      cx += coords[i][0]; cy += coords[i][1]; n++;
    }
    if (n === 0) return null;
    return [cx / n, cy / n];
  },

  _rebuildContextBuildings: function () {
    var ctx = this._ctx;
    var overlay = ctx && ctx.threeOverlay;
    if (!overlay || !overlay.setContextBuildingsShadow) return;

    var features = getExtractedBuildings();
    if (!features || features.length === 0) {
      overlay.setContextBuildingsShadow(null, null);
      return;
    }
    // Origin is in lng/lat — section-gen:origin seeds it before any
    // building extraction normally happens (sections must exist for
    // metatiler buffers to take shape). If origin isn't ready yet we
    // skip; the next features:changed will retry once it is.
    var origin = this._origin;
    if (!origin) return;
    var proj = createProjection(origin[0], origin[1]);
    var data = buildContextMeshData(features, proj);
    if (!data) {
      overlay.setContextBuildingsShadow(null, null);
      return;
    }
    overlay.setContextBuildingsShadow(data.positions, data.indices);
  },

  _buildBlockGround: function (feature, proj) {
    var coords = feature.geometry && feature.geometry.coordinates && feature.geometry.coordinates[0];
    if (!coords || coords.length < 4) return null;

    var pts = [];
    for (var i = 0; i < coords.length - 1; i++) {
      var m = proj.toMeters(coords[i][0], coords[i][1]);
      pts.push([m[0], m[1]]);
    }
    if (pts.length < 3) return null;

    var shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (var j = 1; j < pts.length; j++) shape.lineTo(pts[j][0], pts[j][1]);
    shape.closePath();

    var geo = new THREE.ShapeGeometry(shape);
    geo.translate(0, 0, -0.01); // 1cm below section base
    geo.computeVertexNormals();

    var mat = new THREE.MeshStandardMaterial({
      color: 0xf2f2f2,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide
    });
    mat.userData = { skipWhitewash: true };

    var mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData.whiteModelExtra = true;
    mesh.userData.skipWhitewash = true;
    mesh.userData.blockId = feature.properties.id;
    return mesh;
  }
};

export default module_;
