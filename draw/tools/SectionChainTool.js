/**
 * SectionChainTool — draw a polyline; sections (regular + corner) are
 * distributed along it using core/section-chain/processor.
 *
 * On finalize the chain produces a small graph of features tied via
 * `chainId`:
 *
 *   1) chain holder       (type='section-chain', LineString=polyline)
 *      Stores chain-level params (secWidth, secSide, cornersOn).
 *      Hidden from FeaturesLayer (filtered by type) so it doesn't
 *      double-render on top of section-axis lines.
 *
 *   2) section-axis × N    (one per polyline segment with at least one
 *      non-corner section). Built exactly like SectionTool's output:
 *      same property shape, same footprints structure. The existing
 *      section-gen pipeline picks them up automatically.
 *
 *   3) section-chain-corner × M (one per resolved corner). Stays as
 *      a separate entity — rendered by modules/section-chain.
 *
 * Click  — add point   · Right — flip side    · Move — live preview
 * Dbl/Enter — finish (≥2 points) · Backspace — drop · Escape — cancel
 *
 * Width is a chain-level setting controlled from the right panel:
 *   activate → emit `draw:section-chain:active` { width }
 *   panel input → emit `section-chain:width:set` { value } → tool
 *      updates preview. After finalization the same event with `id`
 *      is consumed by modules/section-chain to rebuild children.
 */

import { eventBus } from '../../core/EventBus.js';
import { Config } from '../../core/Config.js';
import { BaseTool } from './BaseTool.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';
import { CompoundCommand } from '../../core/commands/CompoundCommand.js';
import { SectionChainPreviewLayer } from '../layers/SectionChainPreviewLayer.js';
import { createProjection } from '../../core/geo/projection.js';
import { classifySegment } from '../../core/geo/orientation.js';
import { processPolyline } from '../../core/section-chain/processor.js';

export var SECTION_CHAIN_DEFAULTS = {
  width: 15,
  side: 1,
  cornersOn: true,
  footprint: 0
};

export class SectionChainTool extends BaseTool {
  constructor(manager, featureStore, mapManager) {
    super(manager);
    this.id = 'section-chain';
    this.name = 'Section Chain';
    this.cursor = Config.cursors.crosshair;
    this._featureStore = featureStore;
    this._mapManager = mapManager;
    this._previewLayer = null;
    this._points = [];
    this._tempPoint = null;
    this._proj = null;
    this._side = SECTION_CHAIN_DEFAULTS.side;
    this._width = SECTION_CHAIN_DEFAULTS.width;
    this._rightClickHandler = null;
    this._widthListener = null;
  }

  activate() {
    super.activate();
    this._reset();
    if (!this._previewLayer) {
      this._previewLayer = new SectionChainPreviewLayer(this._mapManager, 'scp');
      this._previewLayer.init();
    }
    var self = this;
    this._rightClickHandler = function (e) {
      e.preventDefault();
      if (self._points.length >= 1) {
        self._side = -self._side;
        self._refreshPreview();
      }
    };
    this._mapManager.getMap().getCanvas().addEventListener('contextmenu', this._rightClickHandler);

    this._widthListener = function (d) {
      // No `id` → addressed at the active draw tool. With `id` it
      // belongs to a finalized chain and is handled by the module.
      if (!d || d.value == null || d.id) return;
      var w = parseFloat(d.value);
      if (isNaN(w) || w <= 0) return;
      self._width = w;
      self._refreshPreview();
    };
    eventBus.on('section-chain:width:set', this._widthListener);

    eventBus.emit('draw:start');
    eventBus.emit('draw:section-chain:active', { width: this._width });
  }

  deactivate() {
    super.deactivate();
    if (this._previewLayer) this._previewLayer.clear();
    if (this._rightClickHandler) {
      this._mapManager.getMap().getCanvas().removeEventListener('contextmenu', this._rightClickHandler);
      this._rightClickHandler = null;
    }
    if (this._widthListener) {
      eventBus.off('section-chain:width:set', this._widthListener);
      this._widthListener = null;
    }
    this._reset();
    eventBus.emit('draw:end');
    eventBus.emit('draw:section-chain:inactive');
  }

  onMapClick(e) {
    var ll = [e.lngLat.lng, e.lngLat.lat];
    if (this._points.length === 0) {
      this._proj = createProjection(ll[0], ll[1]);
      this._side = SECTION_CHAIN_DEFAULTS.side;
    }
    this._points.push(ll);
    eventBus.emit('draw:point:added', { point: ll, total: this._points.length });
    this._refreshPreview();
  }

  onMapMouseMove(e) {
    if (this._points.length === 0) return;
    this._tempPoint = [e.lngLat.lng, e.lngLat.lat];
    this._refreshPreview();
  }

  onMapDoubleClick(_e) {
    if (this._points.length > 0) this._points.pop();
    if (this._points.length >= 2) this._finalize();
    else this._cancel();
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      this._cancel();
    } else if (e.key === 'Enter' && this._points.length >= 2) {
      this._finalize();
    } else if (e.key === 'Backspace' && this._points.length > 0) {
      e.preventDefault();
      this._points.pop();
      eventBus.emit('draw:point:removed', { total: this._points.length });
      this._refreshPreview();
    }
  }

  _activeAxis() {
    var axis = this._points.slice();
    if (this._tempPoint && this._points.length >= 1) axis.push(this._tempPoint);
    return axis;
  }

  _toMeters(axisLngLat) {
    var ptsM = [];
    for (var i = 0; i < axisLngLat.length; i++) {
      var m = this._proj.toMeters(axisLngLat[i][0], axisLngLat[i][1]);
      ptsM.push({ x: m[0], y: m[1] });
    }
    return ptsM;
  }

  _refreshPreview() {
    if (!this._previewLayer || !this._proj) return;
    var axis = this._activeAxis();
    if (axis.length < 2) {
      this._previewLayer.update(axis, { sections: [], corners: [], gaps: [], totalGap: 0 }, this._proj);
      return;
    }
    var ptsM = this._toMeters(axis);
    var layout = processPolyline(ptsM, {
      width: this._width,
      side: this._side,
      cornersOn: SECTION_CHAIN_DEFAULTS.cornersOn,
      footprint: SECTION_CHAIN_DEFAULTS.footprint
    });
    this._previewLayer.update(axis, layout, this._proj);
  }

  _finalize() {
    if (!this._proj || this._points.length < 2) return;
    var ptsLL = this._points.slice();
    var ptsM = this._toMeters(ptsLL);
    var layout = processPolyline(ptsM, {
      width: this._width,
      side: this._side,
      cornersOn: SECTION_CHAIN_DEFAULTS.cornersOn,
      footprint: SECTION_CHAIN_DEFAULTS.footprint
    });
    var commands = buildChainCommands(this._featureStore, this._proj,
      ptsLL, ptsM, layout, this._width, this._side);
    if (commands.length > 0) {
      commandManager.execute(new CompoundCommand(commands, 'Add section chain'));
      eventBus.emit('draw:section-chain:complete', { count: commands.length });
    }

    if (this._previewLayer) this._previewLayer.clear();
    this._reset();
  }

  _cancel() {
    if (this._previewLayer) this._previewLayer.clear();
    this._reset();
    eventBus.emit('draw:cancelled');
  }

  _reset() {
    this._points = [];
    this._tempPoint = null;
    this._proj = null;
    this._side = SECTION_CHAIN_DEFAULTS.side;
  }
}

/**
 * Build commands for a chain finalization. Exposed as a free function so
 * the section-chain module can reuse the exact same logic when
 * regenerating a chain after a width edit.
 *
 * Returns an array of AddFeatureCommand instances. Caller wraps in
 * CompoundCommand if it wants atomic undo.
 */
export function buildChainCommands(featureStore, proj, ptsLL, ptsM, layout, width, side, chainId) {
  var commands = [];
  if (!chainId) chainId = crypto.randomUUID();

  // 1) Chain holder
  var holder = {
    type: 'Feature',
    properties: {
      id: chainId,
      type: 'section-chain',
      createdAt: new Date().toISOString(),
      secWidth: width,
      secSide: side,
      cornersOn: true,
      footprint: 0,
      totalGap: layout.totalGap || 0
    },
    geometry: {
      type: 'LineString',
      coordinates: ptsLL.slice()
    }
  };
  commands.push(new AddFeatureCommand(featureStore, holder));

  // 2) Group sections by segIdx
  var bySeg = {};
  for (var i = 0; i < layout.sections.length; i++) {
    var sec = layout.sections[i];
    var k = sec.segIdx != null ? sec.segIdx : 0;
    if (!bySeg[k]) bySeg[k] = [];
    bySeg[k].push(sec);
  }

  // 3) One section-axis feature per segment that has at least one
  //    non-corner section. Footprint shape matches SectionTool exactly.
  for (var segIdx = 0; segIdx < ptsLL.length - 1; segIdx++) {
    var segSections = bySeg[segIdx];
    if (!segSections || segSections.length === 0) continue;

    var startLL = ptsLL[segIdx];
    var endLL = ptsLL[segIdx + 1];
    var startM = ptsM[segIdx];
    var endM = ptsM[segIdx + 1];
    var dx = endM.x - startM.x, dy = endM.y - startM.y;
    var axisLen = Math.sqrt(dx * dx + dy * dy);

    var oriResult = classifySegment([startM.x, startM.y], [endM.x, endM.y]);
    var footprintsLL = [];
    for (var s = 0; s < segSections.length; s++) {
      var sec2 = segSections[s];
      var ringLL = [];
      for (var v = 0; v < sec2.poly.length; v++) {
        ringLL.push(proj.toLngLat(sec2.poly[v].x, sec2.poly[v].y));
      }
      footprintsLL.push({ polygon: ringLL, length: sec2.len });
    }

    var axisId = crypto.randomUUID();
    var axisFeature = {
      type: 'Feature',
      properties: {
        id: axisId,
        type: 'section-axis',
        createdAt: new Date().toISOString(),
        chainId: chainId,
        chainSegIdx: segIdx,
        flipped: side !== 1,
        orientation: oriResult.orientationName,
        axisLength: axisLen,
        sectionWidth: width,
        footprints: footprintsLL
      },
      geometry: {
        type: 'LineString',
        coordinates: [startLL, endLL]
      }
    };
    commands.push(new AddFeatureCommand(featureStore, axisFeature));
  }

  // 4) One section-chain-corner per corner. Geometry is a Point at
  //    the polyline vertex so FeaturesLayer doesn't render a stray
  //    line/polygon — corner visuals come from the section-chain
  //    module's own MapLibre + Three.js layers.
  for (var ci = 0; ci < layout.corners.length; ci++) {
    var c = layout.corners[ci];
    var ringLL = [];
    for (var pv = 0; pv < c.poly.length; pv++) {
      ringLL.push(proj.toLngLat(c.poly[pv].x, c.poly[pv].y));
    }
    var vIdx = c.vertexIdx != null ? c.vertexIdx : 0;
    var vertexLL = ptsLL[Math.max(0, Math.min(ptsLL.length - 1, vIdx))];

    var cornerFeature = {
      type: 'Feature',
      properties: {
        id: crypto.randomUUID(),
        type: 'section-chain-corner',
        createdAt: new Date().toISOString(),
        chainId: chainId,
        chainVertexIdx: vIdx,
        mode: c.mode || '',
        armA: c.armA_actual != null ? c.armA_actual : c.armA_std,
        armB: c.armB,
        totalLen: c.totalLen,
        polygon: ringLL
      },
      geometry: {
        type: 'Point',
        coordinates: vertexLL
      }
    };
    commands.push(new AddFeatureCommand(featureStore, cornerFeature));
  }

  return commands;
}
