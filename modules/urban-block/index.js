/**
 * Urban-block 2D + 3D module.
 *
 *   - White block plane: rendered as a MapLibre fill layer so it
 *     sits BELOW playgrounds / buffers / yard cells (which are also
 *     MapLibre fill layers). Three.js is on top of MapLibre, so a
 *     plane in Three.js would always cover those overlays — that's
 *     why the plane lives on the map side, not in the 3D scene.
 *     Visible only in white-model mode.
 *
 *   - Context buildings shadow stand-in: extruded volumes from the
 *     metatiler buffer, rendered in Three.js so the sun light's
 *     shadow pass hits real building faces. Split into residential
 *     (light blue) vs other (white) for the AI render color code.
 */

import { createProjection } from '../../core/geo/projection.js';
import { getExtractedBuildings } from '../metatiler/index.js';
import { buildContextMeshData } from '../../core/metatiler/buildings-local.js';

var SOURCE_ID = 'urban-block-plane-src';
var FILL_LAYER_ID = 'urban-block-plane-fill';

var module_ = {
  id: 'urban-block-2d3d',

  init: function (ctx) {
    var self = this;
    this._ctx = ctx;
    this._origin = null;
    this._whitewashed = false;

    this._setupMapLayer();

    ctx.eventBus.on('section-gen:origin', function (origin) {
      if (!origin || origin.length < 2) return;
      var prev = self._origin;
      var changed = !prev
        || Math.abs(prev[0] - origin[0]) > 1e-9
        || Math.abs(prev[1] - origin[1]) > 1e-9;
      self._origin = [origin[0], origin[1]];
      if (changed) self._rebuildContextBuildings();
    });

    ctx.eventBus.on('features:changed', function () {
      self._refreshPlaneSource();
    });

    ctx.eventBus.on('metatiler:buildings:extracted', function () {
      self._rebuildContextBuildings();
    });
    ctx.eventBus.on('metatiler:layer:changed', function () {
      self._rebuildContextBuildings();
    });

    ctx.eventBus.on('whitewash:changed', function (d) {
      self._whitewashed = !!(d && d.enabled);
      self._applyWhitewashVisibility();
    });
    // Also catch the request-form so we sync visibility even if the
    // overlay's broadcast hasn't fired yet.
    ctx.eventBus.on('whitewash:set', function (d) {
      self._whitewashed = !!(d && d.enabled);
      self._applyWhitewashVisibility();
    });

    self._refreshPlaneSource();
  },

  destroy: function () {
    var mm = this._ctx && this._ctx.mapManager;
    if (mm) {
      mm.removeLayer(FILL_LAYER_ID);
      var map = mm.getMap();
      if (map && map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }
  },

  // ── MapLibre white plane ─────────────────────────────

  _setupMapLayer: function () {
    var mm = this._ctx.mapManager;
    if (!mm) return;
    mm.addGeoJSONSource(SOURCE_ID, { type: 'FeatureCollection', features: [] });
    // Insert below the metatiler buffer/playground layers. We pick a
    // beforeId by looking for the first layer whose id matches a known
    // overlay prefix; if none is found yet (overlay modules init AFTER
    // us), MapLibre appends it last, and the overlay modules — when
    // they add their own layers — will end up above us as long as they
    // also call addLayer without a beforeId (default = end of stack).
    var beforeId = this._findOverlayBeforeId();
    mm.addLayer({
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      layout: { visibility: 'none' }, // shown only in white-model mode
      paint: {
        'fill-color': '#ffffff',
        'fill-opacity': 1.0
      }
    }, beforeId);
  },

  _findOverlayBeforeId: function () {
    var mm = this._ctx.mapManager;
    if (!mm) return undefined;
    var map = mm.getMap();
    if (!map || !map.getStyle) return undefined;
    try {
      var style = map.getStyle();
      var layers = (style && style.layers) || [];
      // Anything that looks like an overlay layer (greenzone /
      // playgrounds / metatiler / buffers / sec / tower / drawn).
      // The plane should sit BELOW all of these.
      var rx = /^(metatiler|greenzone|playgrounds|buffers|sec-|tower|fp-|features|drawn|insol-|sectionchain|scs-)/;
      for (var i = 0; i < layers.length; i++) {
        if (rx.test(layers[i].id)) return layers[i].id;
      }
    } catch (_e) { /* no-op */ }
    return undefined;
  },

  _refreshPlaneSource: function () {
    var mm = this._ctx.mapManager;
    if (!mm) return;
    var all = this._ctx.featureStore.toArray();
    var features = [];
    for (var i = 0; i < all.length; i++) {
      var f = all[i];
      var p = f.properties || {};
      if (!p.urbanBlock) continue;
      // Pass through the polygon as-is.
      features.push({
        type: 'Feature',
        properties: { id: p.id },
        geometry: f.geometry
      });
    }
    mm.updateGeoJSONSource(SOURCE_ID, {
      type: 'FeatureCollection',
      features: features
    });
  },

  _applyWhitewashVisibility: function () {
    var mm = this._ctx.mapManager;
    if (!mm) return;
    mm.setLayoutProperty(FILL_LAYER_ID, 'visibility',
      this._whitewashed ? 'visible' : 'none');
  },

  // ── Three.js context-buildings shadow stand-in ───────

  _rebuildContextBuildings: function () {
    var ctx = this._ctx;
    var overlay = ctx && ctx.threeOverlay;
    if (!overlay || !overlay.setContextBuildings) return;

    var features = getExtractedBuildings();
    if (!features || features.length === 0) {
      overlay.setContextBuildings(null);
      return;
    }
    var origin = this._origin;
    if (!origin) return;
    var proj = createProjection(origin[0], origin[1]);

    function isResidential(f) {
      return f && f.properties && f.properties.TYPE === 'Жилой фонд';
    }
    function isOther(f) { return !isResidential(f); }

    var residentialData = buildContextMeshData(features, proj, isResidential);
    var otherData = buildContextMeshData(features, proj, isOther);
    if (!residentialData && !otherData) {
      overlay.setContextBuildings(null);
      return;
    }
    overlay.setContextBuildings({
      residential: residentialData
        ? { positions: residentialData.positions, indices: residentialData.indices }
        : null,
      other: otherData
        ? { positions: otherData.positions, indices: otherData.indices }
        : null
    });
  }
};

export default module_;
