/**
 * section-chain module — manages corner sections of a section chain.
 *
 * Sections (non-corner) of a chain are spawned as `section-axis`
 * features by SectionChainTool and processed by the existing
 * section-gen pipeline (single source of truth, no duplicate code).
 *
 * Corners stay as a separate entity (`section-chain-corner`) because
 * their footprint is not a 4-corner box and doesn't fit the section
 * pipeline. This module renders them in two places:
 *
 *   1) MapLibre 2D overlay   — orange / dark-blue / dark-red fill
 *      depending on `mode` (WW / WM-MW / MM).
 *   2) Three.js 3D meshes    — bottom prism 0..4.5m + top prism
 *      4.5..28.5m (9 floors total). No apartment plan.
 *
 * Width edits at chain level are routed through this module:
 *   `section-chain:width:set` { id, value } → find the chain holder,
 *   wipe all chainId-tagged children (axes + corners), re-run
 *   processPolyline, recreate them via the same builder used by the
 *   tool. Single CompoundCommand for atomic undo.
 */

import * as THREE from 'three';
import { SectionChainPreviewLayer } from '../../draw/layers/SectionChainPreviewLayer.js';
import { createProjection } from '../../core/geo/projection.js';
import { processPolyline } from '../../core/section-chain/processor.js';
import { buildCornerCells } from '../../core/section-chain/corner-cells.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { CompoundCommand } from '../../core/commands/CompoundCommand.js';
import { RemoveFeatureCommand } from '../../core/commands/RemoveFeatureCommand.js';
import { buildChainCommands } from '../../draw/tools/SectionChainTool.js';
import { MATERIALS, EDGE_MATERIAL, GROUND_FLOOR_MAT } from '../../core/three/materials.js';
import {
  buildDetailedCornerFloor0,
  buildDetailedCornerFloor1,
  buildLLURoofFromCells,
  buildCornerTopSlab,
  buildHollowGroundFloor,
  buildHollowResidentialFloor
} from '../../core/three/MeshBuilder.js';
import { computeFloorCount, computeBuildingHeight } from '../../core/SectionParams.js';

var FIRST_FLOOR_H = 4.5;
var TYPICAL_FLOOR_H = 3.0;
var DEFAULT_SECTION_HEIGHT = 28;

var module_ = {
  id: 'section-chain',

  init: function (ctx) {
    var self = this;
    this._ctx = ctx;
    this._layer = new SectionChainPreviewLayer(ctx.mapManager, 'scs');
    this._layer.init();
    this._meshGroup = null;
    this._origin = null;     // [lng, lat] cached from `section-gen:origin`
    this._mapHandlers = [];
    this._selectedCornerId = null;

    ctx.eventBus.on('section-gen:origin', function (origin) {
      if (origin && origin.length >= 2) self._origin = [origin[0], origin[1]];
    });
    ctx.eventBus.on('features:changed', function () {
      self._refresh();
      // After data refresh, re-paint the selection highlight (the
      // corner may have been re-emitted with fresh geometry).
      if (self._selectedCornerId) self._paintSelected(self._selectedCornerId);
    });
    // section-gen's processAllSections wipes the entire Three scene
    // before re-adding section meshes. We need to re-stamp the corner
    // group on top once that finishes — otherwise editing a regular
    // section's height (which calls processAllSections directly,
    // outside the features:changed flow) leaves corners without 3D.
    ctx.eventBus.on('section-gen:rebuilt', function () { self._refresh(); });
    ctx.eventBus.on('section-chain:width:set', function (d) {
      if (!d || !d.id || d.value == null) return;
      var v = parseFloat(d.value);
      if (isNaN(v) || v <= 0) return;
      self._regenerateChain(d.id, v);
    });

    // Selection bridge: drawManager.selectFeature(id) updates
    // FeaturesLayer's _selectedIds and emits feature:selected. We
    // own the corner highlight on the map (corners aren't in
    // FeaturesLayer) so subscribe and paint our own outline.
    ctx.eventBus.on('feature:selected', function (d) {
      if (!d || !d.id) return;
      var feat = ctx.featureStore.get(d.id);
      if (feat && feat.properties && feat.properties.type === 'section-chain-corner') {
        self._selectedCornerId = d.id;
        self._paintSelected(d.id);
      } else {
        // Different feature type was selected — clear our highlight.
        self._selectedCornerId = null;
        self._layer.setSelectedCornerRing(null);
      }
    });
    ctx.eventBus.on('feature:deselected', function () {
      self._selectedCornerId = null;
      self._layer.setSelectedCornerRing(null);
      self._layer.setHoverCornerRing(null);
    });

    // Per-corner height edit — fires from FeaturePanel slider/input.
    ctx.eventBus.on('corner:sectionHeight:set', function (d) {
      if (!d || !d.id || !(d.value > 0)) return;
      var feat = ctx.featureStore.get(d.id);
      if (!feat || feat.properties.type !== 'section-chain-corner') return;
      feat.properties.sectionHeight = d.value;
      ctx.eventBus.emit('features:changed');
    });

    self._setupMapHandlers();
    self._refresh();
  },

  destroy: function () {
    this._teardownMapHandlers();
    if (this._layer) { this._layer.destroy(); this._layer = null; }
    this._disposeMeshes();
  },

  _setupMapHandlers: function () {
    var self = this;
    var map = this._ctx.mapManager.getMap();
    if (!map) return;
    var layerId = this._layer.getCornerClickLayerId();

    function on(event, fn) {
      map.on(event, layerId, fn);
      self._mapHandlers.push({ event: event, fn: fn });
    }

    on('click', function (e) {
      if (!e.features || e.features.length === 0) return;
      e.preventDefault && e.preventDefault();
      var cornerId = e.features[0].properties.cornerId;
      if (!cornerId) return;
      // Toggle behavior matches sidebar:feature:click in app.js: if
      // already selected, clear; otherwise select via drawManager.
      self._ctx.eventBus.emit('sidebar:feature:click', { id: cornerId });
    });

    on('dblclick', function (e) {
      if (!e.features || e.features.length === 0) return;
      // Stop the map zoom on dblclick of a corner.
      if (e.originalEvent && e.originalEvent.preventDefault) {
        e.originalEvent.preventDefault();
      }
      e.preventDefault && e.preventDefault();
      var cornerId = e.features[0].properties.cornerId;
      if (!cornerId) return;
      // Select the corner (so the panel renders) and ask the panel
      // to focus the height input.
      self._ctx.eventBus.emit('sidebar:feature:click', { id: cornerId });
      self._ctx.eventBus.emit('corner:edit:focus', { id: cornerId });
    });

    on('mouseenter', function (e) {
      self._ctx.mapManager.setCursor('pointer');
      if (e.features && e.features[0]) {
        var cornerId = e.features[0].properties.cornerId;
        if (cornerId && cornerId !== self._selectedCornerId) {
          var feat = self._ctx.featureStore.get(cornerId);
          if (feat && feat.properties && feat.properties.polygon) {
            self._layer.setHoverCornerRing(feat.properties.polygon);
          }
        }
      }
    });
    on('mousemove', function (e) {
      if (!e.features || !e.features[0]) return;
      var cornerId = e.features[0].properties.cornerId;
      if (!cornerId || cornerId === self._selectedCornerId) {
        self._layer.setHoverCornerRing(null);
        return;
      }
      var feat = self._ctx.featureStore.get(cornerId);
      if (feat && feat.properties && feat.properties.polygon) {
        self._layer.setHoverCornerRing(feat.properties.polygon);
      }
    });
    on('mouseleave', function () {
      self._ctx.mapManager.setCursor('grab');
      self._layer.setHoverCornerRing(null);
    });
  },

  _teardownMapHandlers: function () {
    var map = this._ctx && this._ctx.mapManager && this._ctx.mapManager.getMap();
    if (!map || !this._mapHandlers) { this._mapHandlers = []; return; }
    var layerId = this._layer && this._layer.getCornerClickLayerId();
    for (var i = 0; i < this._mapHandlers.length; i++) {
      var h = this._mapHandlers[i];
      if (layerId) map.off(h.event, layerId, h.fn);
      else map.off(h.event, h.fn);
    }
    this._mapHandlers = [];
  },

  _paintSelected: function (cornerId) {
    var feat = this._ctx.featureStore.get(cornerId);
    if (feat && feat.properties && feat.properties.polygon) {
      this._layer.setSelectedCornerRing(feat.properties.polygon);
    } else {
      this._layer.setSelectedCornerRing(null);
    }
  },

  // ── Width regeneration: recreate children for a chain ──

  _regenerateChain: function (chainId, newWidth) {
    var store = this._ctx.featureStore;
    var holder = store.get(chainId);
    if (!holder || holder.properties.type !== 'section-chain') return;
    var coords = holder.geometry && holder.geometry.coordinates;
    if (!coords || coords.length < 2) return;

    // Remove all children of this chain.
    var all = store.getAll().features;
    var removeCmds = [];
    for (var i = 0; i < all.length; i++) {
      var p = all[i].properties;
      if (!p || p.chainId !== chainId) continue;
      if (p.type !== 'section-axis' && p.type !== 'section-chain-corner') continue;
      removeCmds.push(new RemoveFeatureCommand(store, p.id));
    }
    // Remove the holder itself — buildChainCommands creates a fresh
    // holder with the new width. We rely on chainId being a stable
    // uuid passed forward so that any UI selection on this chain
    // bridges across the regenerate.
    removeCmds.push(new RemoveFeatureCommand(store, chainId));

    // Re-run layout with new width.
    var origin = coords[0];
    var proj = createProjection(origin[0], origin[1]);
    var ptsM = [];
    for (var k = 0; k < coords.length; k++) {
      var m = proj.toMeters(coords[k][0], coords[k][1]);
      ptsM.push({ x: m[0], y: m[1] });
    }
    var side = holder.properties.secSide || 1;
    var layout = processPolyline(ptsM, {
      width: newWidth,
      side: side,
      cornersOn: holder.properties.cornersOn !== false,
      footprint: holder.properties.footprint || 0
    });
    var addCmds = buildChainCommands(store, proj, coords, ptsM, layout, newWidth, side, chainId);
    var all_ = removeCmds.concat(addCmds);
    if (all_.length > 0) {
      commandManager.execute(new CompoundCommand(all_, 'Update chain width'));
    }
  },

  // ── 2D + 3D refresh ────────────────────────────────────

  _refresh: function () {
    var corners = this._collectCorners();
    this._layer.updateStored(this._cornersAsFeatures(corners));
    this._rebuildMeshes(corners);
  },

  _collectCorners: function () {
    var all = this._ctx.featureStore.getAll().features;
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].properties && all[i].properties.type === 'section-chain-corner') {
        out.push(all[i]);
      }
    }
    return out;
  },

  /**
   * Adapter: SectionChainPreviewLayer.updateStored expects features
   * with `properties.corners` arrays. Our standalone corner features
   * each have a single `polygon` — wrap to fit the same renderer.
   */
  _cornersAsFeatures: function (corners) {
    var bagged = [];
    for (var i = 0; i < corners.length; i++) {
      var c = corners[i];
      bagged.push({
        type: 'Feature',
        properties: {
          id: c.properties.id,
          corners: [{
            id: c.properties.id,
            polygon: c.properties.polygon,
            mode: c.properties.mode,
            armA: c.properties.armA,
            armB: c.properties.armB,
            totalLen: c.properties.totalLen
          }],
          sections: [],
          gaps: []
        },
        geometry: { type: 'LineString', coordinates: [] }   // hide axis
      });
    }
    return bagged;
  },

  // ── 3D meshes ─────────────────────────────────────────

  _disposeMeshes: function () {
    var overlay = this._ctx.threeOverlay;
    if (!overlay || !this._meshGroup) return;
    overlay.removeMesh(this._meshGroup);
    overlay._disposeDeep(this._meshGroup);
    this._meshGroup = null;
  },

  _rebuildMeshes: function (corners) {
    var overlay = this._ctx.threeOverlay;
    if (!overlay) return;
    this._disposeMeshes();
    if (corners.length === 0) return;

    var firstPoly = corners[0].properties.polygon;
    if (!firstPoly || firstPoly.length === 0) return;
    var origin = this._origin || [firstPoly[0][0], firstPoly[0][1]];
    if (!overlay._originSet) {
      overlay.setOrigin(origin[0], origin[1]);
      this._origin = origin;
    }
    var proj = createProjection(origin[0], origin[1]);
    var store = this._ctx.featureStore;

    var group = new THREE.Group();
    for (var i = 0; i < corners.length; i++) {
      var corner = corners[i];
      var meshes = this._buildCornerMeshes(corner, proj, store);
      for (var m = 0; m < meshes.length; m++) group.add(meshes[m]);
    }
    overlay.addMesh(group);
    this._meshGroup = group;
    overlay.requestRender();
  },

  _buildCornerMeshes: function (corner, proj, store) {
    var p = corner.properties;
    var ringLL = p.polygon;
    if (!ringLL || ringLL.length < 3) return [];
    var polyM = ringLLToM(ringLL, proj);
    if (polyM.length < 3) return [];

    // Try cell distribution. Need vertex / prev / next from chain
    // holder; if anything is missing, fall back to the simple solid
    // extrude (current behaviour for corners).
    var holder = store.get(p.chainId);
    var cellPlan = null;
    if (holder && holder.geometry && holder.geometry.coordinates) {
      var line = holder.geometry.coordinates;
      var vIdx = p.chainVertexIdx;
      if (vIdx > 0 && vIdx < line.length - 1) {
        var Vm = proj.toMeters(line[vIdx][0], line[vIdx][1]);
        var prevM = proj.toMeters(line[vIdx - 1][0], line[vIdx - 1][1]);
        var nextM = proj.toMeters(line[vIdx + 1][0], line[vIdx + 1][1]);
        cellPlan = buildCornerCells({
          vertex: Vm, prev: prevM, next: nextM,
          armA: p.armA, armB: p.armB,
          secWidth: holder.properties.secWidth || 15,
          side: holder.properties.secSide || 1,
          mode: p.mode || 'WW',
          sectionHeight: p.sectionHeight || 28
        });
      }
    }

    var secH = p.sectionHeight || (holder && holder.properties.sectionHeight) || DEFAULT_SECTION_HEIGHT;
    if (cellPlan && !cellPlan.fallback && cellPlan.cells) {
      return buildCornerFromCells(cellPlan, polyM, secH);
    }
    return buildCornerSolid(polyM, secH);
  }
};

export default module_;

// ── helpers ────────────────────────────────────────────

function ringLLToM(ringLL, proj) {
  var arr = [];
  for (var i = 0; i < ringLL.length; i++) {
    if (i === ringLL.length - 1 && ringLL.length >= 2 &&
        ringLL[i][0] === ringLL[0][0] && ringLL[i][1] === ringLL[0][1]) break;
    var m = proj.toMeters(ringLL[i][0], ringLL[i][1]);
    arr.push([m[0], m[1]]);
  }
  return arr;
}

// Material palette for first-floor cells. Reuses existing section-gen
// floor-0 materials so corners and adjacent sections read as one
// volume. The non-standard apartment uses the apartment_f0 colour with
// a slight darkening so it's visually distinguishable but still clearly
// part of the building.
// Deep terracotta — clearly distinct from the commercial_f0 orange so
// the non-standard apartment reads as its own zone in the cell layout.
var NON_STANDARD_MAT = new THREE.MeshLambertMaterial({
  color: 0x7a3a14, side: THREE.DoubleSide
});

function cellMaterialFor(type) {
  if (type === 'corridor') return MATERIALS.corridor_f0;
  if (type === 'llu') return MATERIALS.llu_f0;
  if (type === 'non-standard') return NON_STANDARD_MAT;
  return MATERIALS.commercial_f0;          // 'apartment'
}

/**
 * Cell-decomposed corner. Floor 0 (cocoll) and floor 1 (first
 * residential) are always visible — matches the section pipeline
 * which also keeps floor 1 always lit. Floors 2..N-1 detailed,
 * LLU stack and top slab live in a whiteModelExtra group so the
 * heavy meshes only appear in White-model mode.
 */
function buildCornerFromCells(plan, lOutlineM, sectionHeight) {
  var meshes = [];
  var floorCount = computeFloorCount(sectionHeight, FIRST_FLOOR_H, TYPICAL_FLOOR_H);
  var buildingH = computeBuildingHeight(sectionHeight, FIRST_FLOOR_H, TYPICAL_FLOOR_H);
  var outline = plan.outline || lOutlineM;

  // Floor 0 — concrete cocoll with storefronts on outline edges.
  meshes.push(buildDetailedCornerFloor0(plan.cells, outline, 0, FIRST_FLOOR_H));

  // Floor 1 — first residential, always visible.
  meshes.push(buildDetailedCornerFloor1(
    plan.cells, outline, FIRST_FLOOR_H, FIRST_FLOOR_H + TYPICAL_FLOOR_H));

  // Wireframe outline for the rest of the volume — non-WM mode shows
  // the full silhouette without the heavy mesh weight.
  var wire = buildExtrudedPrism(
    lOutlineM, FIRST_FLOOR_H + TYPICAL_FLOOR_H, buildingH, MATERIALS.apartment);
  if (wire) meshes.push(wire.edges);

  // White-model fills: floors 2..N-1 detailed + LLU stack + top slab.
  var wm = new THREE.Group();
  wm.userData.whiteModelExtra = true;
  for (var fl = 2; fl < floorCount; fl++) {
    var fBaseZ = FIRST_FLOOR_H + (fl - 1) * TYPICAL_FLOOR_H;
    var fTopZ = fBaseZ + TYPICAL_FLOOR_H;
    wm.add(buildDetailedCornerFloor1(plan.cells, outline, fBaseZ, fTopZ));
  }
  wm.add(buildLLURoofFromCells(plan.cells, buildingH + 0.5, 2.5));
  wm.add(buildCornerTopSlab(outline, buildingH, 0.5));
  meshes.push(wm);

  return meshes;
}

/**
 * Fallback for inner corners (reflex at V) and degenerate cases where
 * buildCornerCells declines to decompose. Renders walls + slabs on the
 * outline directly — no cell-box extrude — so concave L-shapes don't
 * trip the per-edge inset path. Visual language matches the cell-based
 * branch: cocoll storefronts on every outline edge, residential
 * windows on the upper floors, top slab in WM mode.
 */
function buildCornerSolid(polyM, sectionHeight) {
  if (polyM.length < 3) return [];
  var meshes = [];
  var floorCount = computeFloorCount(sectionHeight, FIRST_FLOOR_H, TYPICAL_FLOOR_H);
  var buildingH = computeBuildingHeight(sectionHeight, FIRST_FLOOR_H, TYPICAL_FLOOR_H);

  // Floor 0 — concrete plinth + storefronts on every outline edge.
  meshes.push(buildHollowGroundFloor(polyM, 0, FIRST_FLOOR_H));

  // Floor 1 — residential floor slab + windows on every outline edge.
  meshes.push(buildHollowResidentialFloor(
    polyM, FIRST_FLOOR_H, FIRST_FLOOR_H + TYPICAL_FLOOR_H));

  // Wireframe outline for the upper volume.
  var wire = buildExtrudedPrism(
    polyM, FIRST_FLOOR_H + TYPICAL_FLOOR_H, buildingH, MATERIALS.apartment);
  if (wire) meshes.push(wire.edges);

  // White-model fills: floors 2..N-1 hollow + top slab.
  var wm = new THREE.Group();
  wm.userData.whiteModelExtra = true;
  for (var fl = 2; fl < floorCount; fl++) {
    var fBaseZ = FIRST_FLOOR_H + (fl - 1) * TYPICAL_FLOOR_H;
    var fTopZ = fBaseZ + TYPICAL_FLOOR_H;
    wm.add(buildHollowResidentialFloor(polyM, fBaseZ, fTopZ));
  }
  wm.add(buildCornerTopSlab(polyM, buildingH, 0.5));
  meshes.push(wm);
  return meshes;
}

function buildExtrudedPrism(poly, baseZ, topZ, material) {
  if (poly.length < 3 || topZ <= baseZ) return null;
  var shape = new THREE.Shape();
  shape.moveTo(poly[0][0], poly[0][1]);
  for (var i = 1; i < poly.length; i++) shape.lineTo(poly[i][0], poly[i][1]);
  shape.closePath();
  var geo = new THREE.ExtrudeGeometry(shape, {
    depth: topZ - baseZ,
    bevelEnabled: false
  });
  geo.translate(0, 0, baseZ);
  geo.computeVertexNormals();
  var mesh = new THREE.Mesh(geo, material);
  var edgeGeo = new THREE.EdgesGeometry(geo);
  var edges = new THREE.LineSegments(edgeGeo, EDGE_MATERIAL);
  return { mesh: mesh, edges: edges };
}
