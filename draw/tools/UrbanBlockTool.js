/**
 * UrbanBlockTool — draw urban block polygon, auto-generate trimmed axes
 * and place sections on them.
 *
 * Pipeline: draw polygon → solve (priority trim + distribute) → create
 * section-axis features. Buffers for these sections are drawn by
 * modules/buffers (MapLibre layers) — no separate overlay system.
 *
 * Hotkey: U
 */

import { eventBus } from '../../core/EventBus.js';
import { Config } from '../../core/Config.js';
import { BaseDrawTool } from './BaseTool.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';
import { CompoundCommand } from '../../core/commands/CompoundCommand.js';
import { createProjection } from '../../core/geo/projection.js';
import { solveUrbanBlockFull, DEFAULT_PARAMS } from '../../core/urban-block/UrbanBlockSolver.js';
import { log } from '../../core/Logger.js';

export class UrbanBlockTool extends BaseDrawTool {
  // Static toggle used at block creation time. Default off.
  static useGap = false;

  constructor(manager, featureStore, mapManager) {
    super(manager);
    this.id = 'urban-block';
    this.name = 'Urban Block';
    this.cursor = Config.cursors.crosshair;
    this._featureStore = featureStore;
    this._mapManager = mapManager;
  }

  onMapDoubleClick(_e) {
    if (this._points.length > 0) this._points.pop();
    if (this._points.length >= 3) this._complete();
  }

  onKeyDown(e) {
    if (e.key === 'Enter' && this._points.length >= 3) {
      this._complete();
    } else {
      super.onKeyDown(e);
    }
  }

  _getPreviewGeometry() {
    if (this._points.length === 0) return null;
    var coords = this._points.slice();
    if (this._tempPoint) coords.push(this._tempPoint);
    if (coords.length < 2) return null;
    if (coords.length < 3) {
      return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords.concat([coords[0]])] } };
  }

  _complete() {
    if (this._points.length < 3) return;

    var polyLL = this._points.slice();
    var blockId = crypto.randomUUID();

    var bufDists = getGlobalBufferDists();
    var solveParams = Object.assign({}, DEFAULT_PARAMS, bufDists, {
      useGap: UrbanBlockTool.useGap
    });

    var axes = buildAxes(polyLL, solveParams);

    // Block polygon feature stores solverParams so later buffer changes
    // can rebuild the same polygon deterministically.
    var blockFeature = {
      type: 'Feature',
      properties: {
        id: blockId,
        type: 'polygon',
        urbanBlock: true,
        useGap: UrbanBlockTool.useGap,
        solverParams: Object.assign({}, solveParams),
        createdAt: new Date().toISOString()
      },
      geometry: { type: 'Polygon', coordinates: [polyLL.concat([polyLL[0]])] }
    };

    var commands = [new AddFeatureCommand(this._featureStore, blockFeature)];
    var axisFeatures = axesToFeatures(axes, blockId, solveParams.sw);
    for (var i = 0; i < axisFeatures.length; i++) {
      commands.push(new AddFeatureCommand(this._featureStore, axisFeatures[i]));
    }

    commandManager.execute(new CompoundCommand(commands, 'Add urban block'));
    eventBus.emit('draw:section:complete', blockFeature);
    log.debug('[UrbanBlock] block ' + blockId.slice(0, 6) + ': ' + axisFeatures.length + ' axes');

    this._reset();
    this._manager.clearPreview();
  }
}

/**
 * Read global buffer distances (populated by app.js). Keys match
 * DEFAULT_PARAMS: fire, endB, insol.
 */
export function getGlobalBufferDists() {
  try {
    if (typeof window !== 'undefined' && window.__UB_BUFFER_DISTS__) {
      return window.__UB_BUFFER_DISTS__;
    }
  } catch (_e) { /* no-op */ }
  return {};
}

function buildAxes(polyLL, solveParams) {
  var cx = 0, cy = 0;
  for (var i = 0; i < polyLL.length; i++) { cx += polyLL[i][0]; cy += polyLL[i][1]; }
  cx /= polyLL.length; cy /= polyLL.length;
  var proj = createProjection(cx, cy);

  var polyM = [];
  for (var j = 0; j < polyLL.length; j++) {
    polyM.push(proj.toMeters(polyLL[j][0], polyLL[j][1]));
  }
  var area = 0;
  for (var k = 0; k < polyM.length; k++) {
    var next = (k + 1) % polyM.length;
    area += (polyM[next][0] + polyM[k][0]) * (polyM[next][1] - polyM[k][1]);
  }
  if (area < 0) polyM.reverse();

  var result = solveUrbanBlockFull(polyM, solveParams);
  var raw = result.axes || [];
  raw.__proj = proj;
  return raw;
}

function axesToFeatures(axes, blockId, sw) {
  var proj = axes.__proj;
  var features = [];
  for (var ai = 0; ai < axes.length; ai++) {
    var ax = axes[ai];
    if (ax.removed || ax.length < 3 || !ax.oi || !ax.secs || ax.secs.length === 0) continue;
    var startLL = proj.toLngLat(ax.start[0], ax.start[1]);
    var endLL = proj.toLngLat(ax.end[0], ax.end[1]);
    var oriName = ax.oriName || (ax.orientation === 1 ? 'lon' : 'lat');
    var od = ax.oi.od;
    var axLen = ax.length;
    var dirN = axLen > 0
      ? [(ax.end[0] - ax.start[0]) / axLen, (ax.end[1] - ax.start[1]) / axLen]
      : [1, 0];
    var ox = od[0] * sw;
    var oy = od[1] * sw;

    var fpLngLat = [];
    var pos = 0;
    for (var si = 0; si < ax.secs.length; si++) {
      var sec = ax.secs[si];
      if (sec.gap) { pos += sec.l; continue; }
      var sx = ax.start[0] + dirN[0] * pos;
      var sy = ax.start[1] + dirN[1] * pos;
      var ex = ax.start[0] + dirN[0] * (pos + sec.l);
      var ey = ax.start[1] + dirN[1] * (pos + sec.l);
      var pm = [[sx, sy], [ex, ey], [ex + ox, ey + oy], [sx + ox, sy + oy]];
      var pll = [];
      for (var j = 0; j < pm.length; j++) pll.push(proj.toLngLat(pm[j][0], pm[j][1]));
      fpLngLat.push({ polygon: pll, length: sec.l });
      pos += sec.l;
    }
    if (fpLngLat.length === 0) continue;

    features.push({
      type: 'Feature',
      properties: {
        id: crypto.randomUUID(),
        type: 'section-axis',
        createdAt: new Date().toISOString(),
        flipped: false,
        orientation: oriName,
        axisLength: axLen,
        footprints: fpLngLat,
        blockId: blockId
      },
      geometry: { type: 'LineString', coordinates: [startLL, endLL] }
    });
  }
  return features;
}

/**
 * Rebuild one block's axes/sections after solver-affecting params change.
 * Removes existing section-axis features for this block and recreates
 * them with the new params. Does NOT recreate the block polygon itself.
 */
export function rebuildBlockAxes(featureStore, blockFeature, overrideParams) {
  if (!blockFeature || !blockFeature.properties || !blockFeature.properties.urbanBlock) return;
  var polyLL = extractPolyLL(blockFeature);
  if (!polyLL || polyLL.length < 3) return;

  var existing = blockFeature.properties.solverParams || Object.assign({}, DEFAULT_PARAMS);
  var newParams = Object.assign({}, existing, overrideParams || {});
  newParams.useGap = blockFeature.properties.useGap === true;

  var axes = buildAxes(polyLL, newParams);
  var blockId = blockFeature.properties.id;

  var all = featureStore.toArray();
  for (var i = 0; i < all.length; i++) {
    var f = all[i];
    if (f.properties.blockId === blockId && f.properties.type === 'section-axis') {
      featureStore.remove(f.properties.id);
    }
  }

  var axisFeatures = axesToFeatures(axes, blockId, newParams.sw);
  for (var k = 0; k < axisFeatures.length; k++) {
    featureStore.add(axisFeatures[k]);
  }

  blockFeature.properties.solverParams = newParams;
  eventBus.emit('features:changed');
}

/**
 * Rebuild ALL urban-blocks in the feature store with new override params.
 * Applied when BufferPanel sliders (fire/end) change.
 */
export function rebuildAllBlocks(featureStore, overrideParams) {
  var all = featureStore.toArray();
  // Snapshot block features first — feature store mutates during rebuild.
  var blocks = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].properties && all[i].properties.urbanBlock) blocks.push(all[i]);
  }
  for (var b = 0; b < blocks.length; b++) {
    rebuildBlockAxes(featureStore, blocks[b], overrideParams);
  }
  return blocks.length;
}

function extractPolyLL(blockFeature) {
  var coords = blockFeature.geometry && blockFeature.geometry.coordinates && blockFeature.geometry.coordinates[0];
  if (!coords) return null;
  var out = coords.slice();
  if (out.length >= 2) {
    var a = out[0], b = out[out.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

/**
 * Collect the feature id of a block polygon plus all its children
 * (section-axis features that reference the block via blockId). Used
 * by the delete handler in app.js to build one CompoundCommand —
 * removing the polygon also removes all sections in one undo step.
 *
 * @param {Object} featureStore
 * @param {string} blockId
 * @returns {string[]} feature ids, parent first
 */
export function collectBlockFeatureIds(featureStore, blockId) {
  var all = featureStore.toArray();
  var ids = [];
  // Block polygon first.
  for (var i = 0; i < all.length; i++) {
    if (all[i].properties.id === blockId) { ids.push(blockId); break; }
  }
  for (var j = 0; j < all.length; j++) {
    var f = all[j];
    if (f.properties.id === blockId) continue;
    if (f.properties.blockId === blockId) ids.push(f.properties.id);
  }
  return ids;
}

/**
 * Delete all features belonging to a block (polygon + axes).
 * Non-undoable — kept for internal cleanup paths. For user-facing
 * deletes use collectBlockFeatureIds + RemoveFeatureCommand.
 */
export function deleteBlock(featureStore, blockId) {
  var all = featureStore.toArray();
  var toRemove = [];
  for (var i = 0; i < all.length; i++) {
    var f = all[i];
    if (f.properties.id === blockId || f.properties.blockId === blockId) {
      toRemove.push(f.properties.id);
    }
  }
  for (var i = 0; i < toRemove.length; i++) {
    featureStore.remove(toRemove[i]);
  }
  return toRemove.length;
}
