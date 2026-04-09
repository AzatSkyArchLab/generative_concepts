/**
 * TowerTool — draw a tower axis, preview tower placement.
 *
 * Click start → drag → click end.
 * Feature type = 'tower-axis'.
 * Right-click flips side. Escape cancels.
 */

import { eventBus } from '../../core/EventBus.js';
import { Config } from '../../core/Config.js';
import { BaseTool } from './BaseTool.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';
import { SectionPreviewLayer } from '../layers/SectionPreviewLayer.js';
import { createProjection } from '../../core/geo/projection.js';
import { classifySegment } from '../../modules/urban-block/orientation.js';
import { detectNorthEnd } from '../../core/tower/TowerPlacer.js';
import { DEFAULT_CELL_SIZE } from '../../core/tower/TowerGenerator.js';
import { computeTowerFootprints } from '../../core/tower/TowerFootprints.js';

export class TowerTool extends BaseTool {
  constructor(manager, featureStore, mapManager) {
    super(manager);
    this.id = 'tower';
    this.name = 'Tower';
    this.cursor = Config.cursors.crosshair;
    this._featureStore = featureStore;
    this._mapManager = mapManager;
    this._previewLayer = null;
    this._startLL = null;
    this._proj = null;
    this._flipped = false;
    this._lastCursorLL = null;
    this._rightClickHandler = null;
  }

  activate() {
    super.activate();
    this._startLL = null;
    this._flipped = false;
    if (!this._previewLayer) {
      this._previewLayer = new SectionPreviewLayer(this._mapManager);
      this._previewLayer.init();
    }
    var self = this;
    this._rightClickHandler = function (e) {
      e.preventDefault();
      if (self._startLL) {
        self._flipped = !self._flipped;
        if (self._lastCursorLL) self._updatePreview(self._lastCursorLL);
      }
    };
    this._mapManager.getMap().getCanvas().addEventListener('contextmenu', this._rightClickHandler);
    eventBus.emit('draw:start');
  }

  deactivate() {
    super.deactivate();
    if (this._previewLayer) this._previewLayer.clear();
    if (this._rightClickHandler) {
      this._mapManager.getMap().getCanvas().removeEventListener('contextmenu', this._rightClickHandler);
      this._rightClickHandler = null;
    }
    this._startLL = null;
    this._lastCursorLL = null;
    eventBus.emit('draw:end');
  }

  onMapClick(e) {
    var ll = [e.lngLat.lng, e.lngLat.lat];
    if (!this._startLL) {
      this._startLL = ll;
      this._proj = createProjection(ll[0], ll[1]);
      this._flipped = false;
      eventBus.emit('draw:point:added', { point: ll, total: 1 });
    } else {
      this._finalize(ll);
    }
  }

  onMapMouseMove(e) {
    if (!this._startLL) return;
    this._lastCursorLL = [e.lngLat.lng, e.lngLat.lat];
    this._updatePreview(this._lastCursorLL);
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      this._startLL = null;
      this._lastCursorLL = null;
      if (this._previewLayer) this._previewLayer.clear();
      eventBus.emit('draw:cancelled');
    }
  }

  _computeFootprints(endLL) {
    var proj = this._proj;
    var startM = proj.toMeters(this._startLL[0], this._startLL[1]);
    var endM = proj.toMeters(endLL[0], endLL[1]);

    var dx = endM[0] - startM[0];
    var dy = endM[1] - startM[1];
    var totalLen = Math.sqrt(dx * dx + dy * dy);
    if (totalLen < 1) return { fpMeters: [], fpLngLat: [], oriName: 'lat', totalLen: 0 };

    var ori = classifySegment(startM, endM);
    var props = { cellSize: DEFAULT_CELL_SIZE, towerGap: 20, flipped: this._flipped };

    // Meter-space (for preview)
    var fpMeters = computeTowerFootprints(startM, endM, props, null);
    // Lng/lat (for storage)
    var fpLngLat = computeTowerFootprints(startM, endM, props,
      function (mx, my) { return proj.toLngLat(mx, my); });

    return {
      fpMeters: fpMeters,
      fpLngLat: fpLngLat,
      oriName: ori.orientationName,
      totalLen: totalLen,
      towerCount: fpLngLat.length
    };
  }

  _updatePreview(cursorLL) {
    if (!this._proj || !this._previewLayer) return;
    var result = this._computeFootprints(cursorLL);
    this._previewLayer.update(
      this._startLL, cursorLL, result.fpMeters,
      result.oriName,
      result.totalLen, this._proj
    );
  }

  _finalize(endLL) {
    if (!this._proj) return;
    var result = this._computeFootprints(endLL);

    var proj = this._proj;
    var startM = proj.toMeters(this._startLL[0], this._startLL[1]);
    var endM = proj.toMeters(endLL[0], endLL[1]);
    var northEnd = detectNorthEnd(startM, endM);

    var id = crypto.randomUUID();
    var feature = {
      type: 'Feature',
      properties: {
        id: id,
        type: 'tower-axis',
        createdAt: new Date().toISOString(),
        flipped: this._flipped,
        orientation: result.oriName,
        axisLength: result.totalLen,
        cellSize: DEFAULT_CELL_SIZE,
        towerHeight: 112,
        towerGap: 20,
        northEnd: northEnd,
        footprints: result.fpLngLat
      },
      geometry: {
        type: 'LineString',
        coordinates: [this._startLL, endLL]
      }
    };

    commandManager.execute(new AddFeatureCommand(this._featureStore, feature));
    eventBus.emit('draw:tower:complete', feature);

    if (this._previewLayer) this._previewLayer.clear();
    this._startLL = null;
    this._lastCursorLL = null;
    this._flipped = false;
  }
}
