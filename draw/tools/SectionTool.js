/**
 * SectionTool — stores footprints as lng/lat in feature properties
 * Feature type = 'section-axis'
 * Right-click flips. Escape cancels.
 */

import { eventBus } from '../../core/EventBus.js';
import { Config } from '../../core/Config.js';
import { BaseTool } from './BaseTool.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';
import { SectionPreviewLayer } from '../layers/SectionPreviewLayer.js';
import { createProjection } from '../../modules/urban-block/projection.js';
import { classifySegment } from '../../modules/section-distributor/orientation.js';
import { getSectionLengths, createSectionSequence } from '../../modules/section-distributor/distributor.js';

var SECTION_WIDTH = 18.0;

export class SectionTool extends BaseTool {
  constructor(manager, featureStore, mapManager) {
    super(manager);
    this.id = 'section';
    this.name = 'Section';
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

  /**
   * Compute footprints in BOTH meters (for preview) and lng/lat (for storage).
   */
  _computeFootprints(endLL) {
    var proj = this._proj;
    var startM = proj.toMeters(this._startLL[0], this._startLL[1]);
    var endM = proj.toMeters(endLL[0], endLL[1]);

    var dx = endM[0] - startM[0];
    var dy = endM[1] - startM[1];
    var totalLen = Math.sqrt(dx * dx + dy * dy);
    if (totalLen < 1) return { fpMeters: [], fpLngLat: [], oriName: 'lat', totalLen: 0 };

    var ori = classifySegment(startM, endM);
    var sectionLengths = getSectionLengths(ori.orientation);
    var minSL = Infinity;
    for (var i = 0; i < sectionLengths.length; i++) {
      if (sectionLengths[i] < minSL) minSL = sectionLengths[i];
    }
    if (totalLen < minSL) return { fpMeters: [], fpLngLat: [], oriName: ori.orientationName, totalLen: totalLen };

    var sequence = createSectionSequence(sectionLengths, totalLen);
    var dirX = dx / totalLen;
    var dirY = dy / totalLen;
    var perpX = this._flipped ? dirY : -dirY;
    var perpY = this._flipped ? -dirX : dirX;
    var ox = perpX * SECTION_WIDTH;
    var oy = perpY * SECTION_WIDTH;

    var fpMeters = [];
    var fpLngLat = [];
    var pos = 0;
    for (var i = 0; i < sequence.length; i++) {
      var sec = sequence[i];
      if (sec.isGap) { pos += sec.length; continue; }
      var sx = startM[0] + dirX * pos;
      var sy = startM[1] + dirY * pos;
      var ex = startM[0] + dirX * (pos + sec.length);
      var ey = startM[1] + dirY * (pos + sec.length);

      var polyM = [[sx, sy], [ex, ey], [ex + ox, ey + oy], [sx + ox, sy + oy]];
      fpMeters.push({ polygon: polyM, length: sec.length });

      // Convert to lng/lat for storage
      var polyLL = [];
      for (var j = 0; j < polyM.length; j++) {
        polyLL.push(proj.toLngLat(polyM[j][0], polyM[j][1]));
      }
      fpLngLat.push({ polygon: polyLL, length: sec.length });

      pos += sec.length;
    }
    return { fpMeters: fpMeters, fpLngLat: fpLngLat, oriName: ori.orientationName, totalLen: totalLen };
  }

  _updatePreview(cursorLL) {
    if (!this._proj || !this._previewLayer) return;
    var result = this._computeFootprints(cursorLL);
    // Preview uses meters + proj for conversion
    this._previewLayer.update(this._startLL, cursorLL, result.fpMeters, result.oriName, result.totalLen, this._proj);
  }

  _finalize(endLL) {
    if (!this._proj) return;
    var result = this._computeFootprints(endLL);

    var id = crypto.randomUUID();
    var feature = {
      type: 'Feature',
      properties: {
        id: id,
        type: 'section-axis',
        createdAt: new Date().toISOString(),
        flipped: this._flipped,
        orientation: result.oriName,
        axisLength: result.totalLen,
        footprints: result.fpLngLat  // stored as lng/lat
      },
      geometry: {
        type: 'LineString',
        coordinates: [this._startLL, endLL]
      }
    };

    commandManager.execute(new AddFeatureCommand(this._featureStore, feature));
    eventBus.emit('draw:section:complete', feature);

    if (this._previewLayer) this._previewLayer.clear();
    this._startLL = null;
    this._lastCursorLL = null;
    this._flipped = false;
  }
}
