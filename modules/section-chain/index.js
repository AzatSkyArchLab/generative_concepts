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
import { MATERIALS, EDGE_MATERIAL } from '../../core/three/materials.js';

var FIRST_FLOOR_H = 4.5;
var TYPICAL_FLOOR_H = 3.0;
var TOTAL_FLOORS = 9;
var BUILDING_TOP = FIRST_FLOOR_H + (TOTAL_FLOORS - 1) * TYPICAL_FLOOR_H; // 28.5m

var module_ = {
  id: 'section-chain',

  init: function (ctx) {
    var self = this;
    this._ctx = ctx;
    this._layer = new SectionChainPreviewLayer(ctx.mapManager, 'scs');
    this._layer.init();
    this._meshGroup = null;
    this._origin = null;     // [lng, lat] cached from `section-gen:origin`

    ctx.eventBus.on('section-gen:origin', function (origin) {
      if (origin && origin.length >= 2) self._origin = [origin[0], origin[1]];
    });
    ctx.eventBus.on('features:changed', function () { self._refresh(); });
    ctx.eventBus.on('section-chain:width:set', function (d) {
      if (!d || !d.id || d.value == null) return;
      var v = parseFloat(d.value);
      if (isNaN(v) || v <= 0) return;
      self._regenerateChain(d.id, v);
    });

    self._refresh();
  },

  destroy: function () {
    if (this._layer) { this._layer.destroy(); this._layer = null; }
    this._disposeMeshes();
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

    if (cellPlan && !cellPlan.fallback && cellPlan.cells) {
      return buildCornerFromCells(cellPlan, polyM);
    }
    return buildCornerSolid(polyM);
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
 * Cell-decomposed first floor + wireframe-only volume on top, mirroring
 * the regular section-axis behaviour: floors 2+ are an open frame so the
 * cell articulation at floor 0 is visible from any camera angle.
 */
function buildCornerFromCells(plan, lOutlineM) {
  var meshes = [];
  for (var i = 0; i < plan.cells.length; i++) {
    var c = plan.cells[i];
    if (!c.poly || c.poly.length < 3) continue;
    var prism = buildExtrudedPrism(c.poly, 0, FIRST_FLOOR_H, cellMaterialFor(c.type));
    if (prism) { meshes.push(prism.mesh); meshes.push(prism.edges); }
  }
  // Top — wireframe only (no fill).
  var top = buildExtrudedPrism(lOutlineM, FIRST_FLOOR_H, BUILDING_TOP, MATERIALS.apartment);
  if (top) meshes.push(top.edges);
  return meshes;
}

/**
 * Fallback for inner corners and other cases where cell distribution
 * can't run. Solid commercial volume 0..4.5m + wireframe-only top
 * 4.5..28.5m. Top stays open so the corner reads consistently with
 * the cell-based variant and with regular sections.
 */
function buildCornerSolid(polyM) {
  if (polyM.length < 3) return [];
  var meshes = [];
  var bot = buildExtrudedPrism(polyM, 0, FIRST_FLOOR_H, MATERIALS.commercial);
  if (bot) { meshes.push(bot.mesh); meshes.push(bot.edges); }
  var top = buildExtrudedPrism(polyM, FIRST_FLOOR_H, BUILDING_TOP, MATERIALS.apartment);
  if (top) meshes.push(top.edges);
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
