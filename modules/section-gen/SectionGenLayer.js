/**
 * SectionGenLayer — edit mode with thick selection, close button, floor labels
 */

export class SectionGenLayer {
  constructor(mapManager) {
    this._map = mapManager;
    this._initialized = false;
    this._closeBtn = null;
    this._onCloseCallback = null;

    this.PLAN_SOURCE = 'sg-plan';
    this.FOOT_SOURCE = 'sg-foot';
    this.AXIS_SOURCE = 'sg-axis';
    this.LABELS_SOURCE = 'sg-labels';
    this.FLOOR_LABELS_SOURCE = 'sg-floor-labels';
    this.HIGHLIGHT_SOURCE = 'sg-highlight';
    this.CLICK_SOURCE = 'sg-click';
    this.EDIT_OVERLAY_SOURCE = 'sg-edit-overlay';
    this.EDIT_ALL_SOURCE = 'sg-edit-all';
    this.EDIT_DIM_SOURCE = 'sg-edit-dim';
    this.EDIT_SELECTED_SOURCE = 'sg-edit-selected';
  }

  init() {
    if (this._initialized) return;
    var e = { type: 'FeatureCollection', features: [] };
    var allSrc = [this.PLAN_SOURCE, this.FOOT_SOURCE, this.AXIS_SOURCE,
    this.LABELS_SOURCE, this.FLOOR_LABELS_SOURCE, this.HIGHLIGHT_SOURCE,
    this.CLICK_SOURCE, this.EDIT_OVERLAY_SOURCE, this.EDIT_ALL_SOURCE,
    this.EDIT_DIM_SOURCE, this.EDIT_SELECTED_SOURCE];
    for (var i = 0; i < allSrc.length; i++) this._map.addGeoJSONSource(allSrc[i], e);

    var map = this._map.getMap();
    if (!map) return;

    // Edit layers (hidden)
    map.addLayer({
      id: 'sg-edit-overlay-fill', type: 'fill', source: this.EDIT_OVERLAY_SOURCE,
      paint: { 'fill-color': '#000', 'fill-opacity': 0.5 }, layout: { 'visibility': 'none' }
    });
    map.addLayer({
      id: 'sg-edit-all-fill', type: 'fill', source: this.EDIT_ALL_SOURCE,
      paint: { 'fill-color': '#fff', 'fill-opacity': 0.7 }, layout: { 'visibility': 'none' }
    });
    map.addLayer({
      id: 'sg-edit-all-line', type: 'line', source: this.EDIT_ALL_SOURCE,
      paint: { 'line-color': '#ff8c00', 'line-width': 2, 'line-dasharray': [4, 2] }, layout: { 'visibility': 'none' }
    });
    map.addLayer({
      id: 'sg-edit-dim-fill', type: 'fill', source: this.EDIT_DIM_SOURCE,
      paint: { 'fill-color': '#000', 'fill-opacity': 0.2 }, layout: { 'visibility': 'none' }
    });
    map.addLayer({
      id: 'sg-edit-selected-fill', type: 'fill', source: this.EDIT_SELECTED_SOURCE,
      paint: { 'fill-color': '#ff8c00', 'fill-opacity': 0.3 }, layout: { 'visibility': 'none' }
    });
    map.addLayer({
      id: 'sg-edit-selected-line', type: 'line', source: this.EDIT_SELECTED_SOURCE,
      paint: { 'line-color': '#151515', 'line-width': 12 }, layout: { 'visibility': 'none' }
    });

    // Normal layers
    map.addLayer({
      id: 'sg-highlight-fill', type: 'fill', source: this.HIGHLIGHT_SOURCE,
      paint: { 'fill-color': '#ff8c00', 'fill-opacity': 0.35 }
    });
    map.addLayer({
      id: 'sg-highlight-line', type: 'line', source: this.HIGHLIGHT_SOURCE,
      paint: { 'line-color': '#232323', 'line-width': 12 }
    });
    map.addLayer({
      id: 'sg-axis-line', type: 'line', source: this.AXIS_SOURCE,
      paint: { 'line-color': '#888', 'line-width': 2, 'line-dasharray': [6, 4] }
    });
    map.addLayer({
      id: 'sg-foot-line', type: 'line', source: this.FOOT_SOURCE,
      paint: { 'line-color': '#333', 'line-width': 3 }
    });
    map.addLayer({
      id: 'sg-plan-fill', type: 'fill', source: this.PLAN_SOURCE,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1.0 }
    });
    map.addLayer({
      id: 'sg-plan-line', type: 'line', source: this.PLAN_SOURCE,
      paint: { 'line-color': '#555', 'line-width': 1 }
    });
    map.addLayer({
      id: 'sg-click-layer', type: 'fill', source: this.CLICK_SOURCE,
      paint: { 'fill-color': 'transparent', 'fill-opacity': 0 }
    });
    map.addLayer({
      id: 'sg-labels-text', type: 'symbol', source: this.LABELS_SOURCE,
      layout: {
        'text-field': ['get', 'label'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-allow-overlap': true
      },
      paint: { 'text-color': '#333', 'text-halo-color': '#fff', 'text-halo-width': 1 }
    });
    map.addLayer({
      id: 'sg-floor-labels-text', type: 'symbol', source: this.FLOOR_LABELS_SOURCE,
      layout: {
        'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['Open Sans Bold'],
        'text-allow-overlap': true, 'text-anchor': 'bottom-left', 'text-offset': [0.4, -0.4]
      },
      paint: { 'text-color': '#444', 'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.5 }
    });

    this._initialized = true;
  }

  getClickLayerId() { return 'sg-click-layer'; }

  enterEditMode(sectionFPs, onClose) {
    var map = this._map.getMap();
    if (!map) return;
    this._onCloseCallback = onClose;

    this._map.updateGeoJSONSource(this.EDIT_OVERLAY_SOURCE, {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] }
      }]
    });

    var allF = [];
    for (var i = 0; i < sectionFPs.length; i++) {
      allF.push({
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [sectionFPs[i].ring] }
      });
    }
    this._map.updateGeoJSONSource(this.EDIT_ALL_SOURCE, { type: 'FeatureCollection', features: allF });
    this._map.updateGeoJSONSource(this.EDIT_DIM_SOURCE, { type: 'FeatureCollection', features: allF });
    this._map.updateGeoJSONSource(this.EDIT_SELECTED_SOURCE, { type: 'FeatureCollection', features: [] });
    this._map.updateGeoJSONSource(this.HIGHLIGHT_SOURCE, { type: 'FeatureCollection', features: [] });

    var editLayers = ['sg-edit-overlay-fill', 'sg-edit-all-fill', 'sg-edit-all-line',
      'sg-edit-dim-fill', 'sg-edit-selected-fill', 'sg-edit-selected-line'];
    for (var i = 0; i < editLayers.length; i++) map.setLayoutProperty(editLayers[i], 'visibility', 'visible');

    this._createCloseButton();
  }

  /**
   * Highlight multiple selected sections, dim the rest.
   */
  selectEditSections(selectedFPs, dimFPs) {
    var selF = [];
    for (var i = 0; i < selectedFPs.length; i++) {
      selF.push({
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [selectedFPs[i].ring] }
      });
    }
    this._map.updateGeoJSONSource(this.EDIT_SELECTED_SOURCE, { type: 'FeatureCollection', features: selF });

    var dimF = [];
    for (var i = 0; i < dimFPs.length; i++) {
      dimF.push({
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [dimFPs[i].ring] }
      });
    }
    this._map.updateGeoJSONSource(this.EDIT_DIM_SOURCE, { type: 'FeatureCollection', features: dimF });
  }

  /**
   * Clear selection — all sections equally dimmed.
   */
  clearEditSelection(allFPs) {
    this._map.updateGeoJSONSource(this.EDIT_SELECTED_SOURCE, { type: 'FeatureCollection', features: [] });
    var allF = [];
    for (var i = 0; i < allFPs.length; i++) {
      allF.push({
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [allFPs[i].ring] }
      });
    }
    this._map.updateGeoJSONSource(this.EDIT_DIM_SOURCE, { type: 'FeatureCollection', features: allF });
  }

  exitEditMode() {
    var map = this._map.getMap();
    if (!map) return;
    var e = { type: 'FeatureCollection', features: [] };
    var editSrc = [this.EDIT_OVERLAY_SOURCE, this.EDIT_ALL_SOURCE, this.EDIT_DIM_SOURCE, this.EDIT_SELECTED_SOURCE];
    for (var i = 0; i < editSrc.length; i++) this._map.updateGeoJSONSource(editSrc[i], e);
    var editLayers = ['sg-edit-overlay-fill', 'sg-edit-all-fill', 'sg-edit-all-line',
      'sg-edit-dim-fill', 'sg-edit-selected-fill', 'sg-edit-selected-line'];
    for (var i = 0; i < editLayers.length; i++) map.setLayoutProperty(editLayers[i], 'visibility', 'none');
    this._removeCloseButton();
  }

  _createCloseButton() {
    this._removeCloseButton();
    var btn = document.createElement('div');
    btn.className = 'edit-mode-close';
    btn.innerHTML = '<span class="edit-close-x">✕</span><span class="edit-close-text">Exit edit mode · Esc</span>';
    this._map.getMap().getContainer().appendChild(btn);
    this._closeBtn = btn;
    var self = this;
    btn.addEventListener('click', function () { if (self._onCloseCallback) self._onCloseCallback(); });
  }

  _removeCloseButton() {
    if (this._closeBtn && this._closeBtn.parentElement) this._closeBtn.parentElement.removeChild(this._closeBtn);
    this._closeBtn = null;
  }

  update(cellsLL, footprintsLL) {
    var planF = []; var labelF = []; var axisF = []; var floorLabelF = [];
    for (var i = 0; i < cellsLL.length; i++) {
      var c = cellsLL[i];
      planF.push({
        type: 'Feature', properties: { color: c.color },
        geometry: { type: 'Polygon', coordinates: [c.ring] }
      });
      if (c.label) {
        var cx = 0; var cy = 0;
        for (var j = 0; j < c.ring.length - 1; j++) { cx += c.ring[j][0]; cy += c.ring[j][1]; }
        cx /= (c.ring.length - 1); cy /= (c.ring.length - 1);
        labelF.push({
          type: 'Feature', properties: { label: c.label },
          geometry: { type: 'Point', coordinates: [cx, cy] }
        });
      }
    }

    var footF = []; var clickF = []; var seenAxes = {};
    for (var i = 0; i < footprintsLL.length; i++) {
      var fp = footprintsLL[i];
      footF.push({
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [fp.ring] }
      });
      clickF.push({
        type: 'Feature',
        properties: { lineId: fp.lineId || '', secIdx: fp.secIdx !== undefined ? fp.secIdx : -1 },
        geometry: { type: 'Polygon', coordinates: [fp.ring] }
      });

      // Floor count label at corner c (ring[2])
      if (fp.floorCount && fp.floorCount > 0) {
        floorLabelF.push({
          type: 'Feature',
          properties: { label: fp.floorCount + 'F' },
          geometry: { type: 'Point', coordinates: fp.ring[2] }
        });
      }

      if (fp.lineId && !seenAxes[fp.lineId]) seenAxes[fp.lineId] = { start: fp.ring[0], end: null };
      if (fp.lineId) seenAxes[fp.lineId].end = fp.ring[1];
    }
    for (var lid in seenAxes) {
      if (!seenAxes.hasOwnProperty(lid)) continue;
      var ax = seenAxes[lid];
      if (ax.start && ax.end) axisF.push({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: [ax.start, ax.end] }
      });
    }

    this._map.updateGeoJSONSource(this.PLAN_SOURCE, { type: 'FeatureCollection', features: planF });
    this._map.updateGeoJSONSource(this.FOOT_SOURCE, { type: 'FeatureCollection', features: footF });
    this._map.updateGeoJSONSource(this.AXIS_SOURCE, { type: 'FeatureCollection', features: axisF });
    this._map.updateGeoJSONSource(this.CLICK_SOURCE, { type: 'FeatureCollection', features: clickF });
    this._map.updateGeoJSONSource(this.LABELS_SOURCE, { type: 'FeatureCollection', features: labelF });
    this._map.updateGeoJSONSource(this.FLOOR_LABELS_SOURCE, { type: 'FeatureCollection', features: floorLabelF });
  }

  highlightRaw(fpsLL) {
    var f = [];
    for (var i = 0; i < fpsLL.length; i++)
      f.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [fpsLL[i].ring] } });
    this._map.updateGeoJSONSource(this.HIGHLIGHT_SOURCE, { type: 'FeatureCollection', features: f });
  }

  clearHighlight() {
    this._map.updateGeoJSONSource(this.HIGHLIGHT_SOURCE, { type: 'FeatureCollection', features: [] });
  }

  clear() {
    var e = { type: 'FeatureCollection', features: [] };
    var allSrc = [this.PLAN_SOURCE, this.FOOT_SOURCE, this.AXIS_SOURCE, this.CLICK_SOURCE,
    this.LABELS_SOURCE, this.FLOOR_LABELS_SOURCE, this.HIGHLIGHT_SOURCE,
    this.EDIT_OVERLAY_SOURCE, this.EDIT_ALL_SOURCE, this.EDIT_DIM_SOURCE, this.EDIT_SELECTED_SOURCE];
    for (var i = 0; i < allSrc.length; i++) this._map.updateGeoJSONSource(allSrc[i], e);
  }

  destroy() {
    this._removeCloseButton();
    var map = this._map.getMap();
    if (!map) return;
    var layers = ['sg-floor-labels-text', 'sg-labels-text', 'sg-click-layer',
      'sg-edit-selected-line', 'sg-edit-selected-fill', 'sg-edit-dim-fill',
      'sg-edit-all-line', 'sg-edit-all-fill', 'sg-edit-overlay-fill',
      'sg-plan-line', 'sg-plan-fill', 'sg-foot-line', 'sg-axis-line',
      'sg-highlight-line', 'sg-highlight-fill'];
    for (var i = 0; i < layers.length; i++) { if (map.getLayer(layers[i])) map.removeLayer(layers[i]); }
    var allSrc = [this.FLOOR_LABELS_SOURCE, this.LABELS_SOURCE, this.CLICK_SOURCE,
    this.PLAN_SOURCE, this.FOOT_SOURCE, this.AXIS_SOURCE, this.HIGHLIGHT_SOURCE,
    this.EDIT_OVERLAY_SOURCE, this.EDIT_ALL_SOURCE, this.EDIT_DIM_SOURCE, this.EDIT_SELECTED_SOURCE];
    for (var i = 0; i < allSrc.length; i++) { if (map.getSource(allSrc[i])) map.removeSource(allSrc[i]); }
    this._initialized = false;
  }
}
