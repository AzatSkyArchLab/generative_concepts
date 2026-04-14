/**
 * UrbanBlockTool — draw urban block polygon, auto-generate trimmed axes.
 *
 * Pipeline: draw polygon → solve (priority trim + distribute) → create axes.
 * All sections/towers face inward. Grouped by blockId.
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
import { computeOverlays } from '../../core/urban-block/UrbanBlockOverlays.js';
import { log } from '../../core/Logger.js';

var SECTION_WIDTH = 18.0;

export class UrbanBlockTool extends BaseDrawTool {
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

    // Projection from centroid
    var cx = 0; var cy = 0;
    for (var i = 0; i < polyLL.length; i++) { cx += polyLL[i][0]; cy += polyLL[i][1]; }
    cx /= polyLL.length; cy /= polyLL.length;
    var proj = createProjection(cx, cy);

    // Convert to meters
    var polyM = [];
    for (var i = 0; i < polyLL.length; i++) {
      polyM.push(proj.toMeters(polyLL[i][0], polyLL[i][1]));
    }

    // Ensure CCW
    var area = 0;
    for (var i = 0; i < polyM.length; i++) {
      var j = (i + 1) % polyM.length;
      area += (polyM[j][0] + polyM[i][0]) * (polyM[j][1] - polyM[i][1]);
    }
    if (area < 0) { polyM.reverse(); polyLL.reverse(); }

    // Run solver with priority trimming + buffer subtraction + simplification
    var solveResult = solveUrbanBlockFull(polyM, DEFAULT_PARAMS);
    var axes = solveResult.axes;
    var workPolyM = solveResult.polyM;
    var sw = DEFAULT_PARAMS.sw;
    var commands = [];

    // Compute overlays (roads, graph, trash, buffers) — use simplified polygon
    var overlays = computeOverlays(workPolyM, axes, DEFAULT_PARAMS);
    function polyToLL(p) { var r = []; for (var i = 0; i < p.length; i++) r.push(proj.toLngLat(p[i][0], p[i][1])); return r; }
    function polysToLL(arr) { var r = []; for (var i = 0; i < arr.length; i++) r.push(polyToLL(arr[i])); return r; }

    // Block polygon (first command)
    var blockFeature = {
      type: 'Feature',
      properties: {
        id: blockId, type: 'polygon', createdAt: new Date().toISOString(),
        urbanBlock: true, blockParams: Object.assign({}, DEFAULT_PARAMS),
        overlays: {
          secFire: polysToLL(overlays.secFire),
          roadOuter: overlays.roadOuter.length >= 3 ? polyToLL(overlays.roadOuter) : [],
          roadInner: overlays.roadInner.length >= 3 ? polyToLL(overlays.roadInner) : [],
          connectors: overlays.connectors.map(function (c) { return { from: proj.toLngLat(c.from[0], c.from[1]), to: proj.toLngLat(c.to[0], c.to[1]) }; }),
          connectorQuads: polysToLL(overlays.connectorQuads || []),
          graphNodes: overlays.graphNodes.map(function (n) { return { pt: proj.toLngLat(n.pt[0], n.pt[1]), type: n.type }; }),
          graphEdges: overlays.graphEdges,
          trashPad: overlays.trashPad ? { center: proj.toLngLat(overlays.trashPad.center[0], overlays.trashPad.center[1]), rect: polyToLL(overlays.trashPad.rect) } : null,
          trashInner: polysToLL(overlays.trashInner),
          trashOuter: polysToLL(overlays.trashOuter),
          playBuf12: polysToLL(overlays.playBuf12),
          playBuf20: polysToLL(overlays.playBuf20),
          playBuf40: polysToLL(overlays.playBuf40),
          bufferZones: (function () {
            var bz = [];
            for (var bi = 0; bi < axes.length; bi++) {
              if (!axes[bi].bufs) continue;
              var types = ['fire', 'end', 'insol'];
              for (var ti = 0; ti < types.length; ti++) {
                var bp = axes[bi].bufs[types[ti]];
                if (bp && bp.length === 4) bz.push({ type: types[ti], polygon: polyToLL(bp) });
              }
            }
            return bz;
          })()
        }
      },
      geometry: { type: 'Polygon', coordinates: [polyLL.concat([polyLL[0]])] }
    };
    // Store meters data for canvas overlay renderer
    blockFeature.properties._overlaysM = overlays;
    blockFeature.properties._polyM = polyM;
    blockFeature.properties._params = Object.assign({}, DEFAULT_PARAMS);
    blockFeature.properties._projCenter = [cx, cy];
    commands.push(new AddFeatureCommand(this._featureStore, blockFeature));

    for (var ai = 0; ai < axes.length; ai++) {
      var ax = axes[ai];
      if (ax.removed || ax.length < 3 || !ax.oi || !ax.secs || ax.secs.length === 0) continue;
      var startLL = proj.toLngLat(ax.start[0], ax.start[1]);
      var endLL = proj.toLngLat(ax.end[0], ax.end[1]);
      var oriName = ax.oriName || (ax.orientation === 1 ? 'lon' : 'lat');
      var od = ax.oi.od;
      var dirV = [ax.end[0] - ax.start[0], ax.end[1] - ax.start[1]];
      var axLen = ax.length;
      var dirN = axLen > 0 ? [dirV[0] / axLen, dirV[1] / axLen] : [1, 0];
      var ox = od[0] * sw; var oy = od[1] * sw;

      var fpLngLat = []; var pos = 0;
      for (var si = 0; si < ax.secs.length; si++) {
        var sec = ax.secs[si];
        if (sec.gap) { pos += sec.l; continue; }
        var sx = ax.start[0] + dirN[0] * pos; var sy = ax.start[1] + dirN[1] * pos;
        var ex = ax.start[0] + dirN[0] * (pos + sec.l); var ey = ax.start[1] + dirN[1] * (pos + sec.l);
        var pm = [[sx, sy], [ex, ey], [ex + ox, ey + oy], [sx + ox, sy + oy]];
        var pll = [];
        for (var j = 0; j < pm.length; j++) pll.push(proj.toLngLat(pm[j][0], pm[j][1]));
        fpLngLat.push({ polygon: pll, length: sec.l });
        pos += sec.l;
      }
      if (fpLngLat.length === 0) continue;

      commands.push(new AddFeatureCommand(this._featureStore, {
        type: 'Feature',
        properties: {
          id: crypto.randomUUID(), type: 'section-axis',
          createdAt: new Date().toISOString(), flipped: false,
          orientation: oriName, axisLength: axLen,
          footprints: fpLngLat, blockId: blockId,
          context: ax.context, trimmed: ax.trimmed || false
        },
        geometry: { type: 'LineString', coordinates: [startLL, endLL] }
      }));
    }

    // Single compound command — one Ctrl+Z undoes entire block
    commandManager.execute(new CompoundCommand(commands, 'Add urban block'));
    eventBus.emit('draw:section:complete', blockFeature);
    log.debug('[UrbanBlock] block ' + blockId.slice(0, 6) + ': ' + (commands.length - 1) + ' axes');

    this._reset();
    this._manager.clearPreview();
  }
}

/**
 * Delete all features belonging to a block (polygon + axes).
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
