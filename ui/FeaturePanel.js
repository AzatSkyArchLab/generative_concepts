/**
 * FeaturePanel — coordinator for right sidebar.
 *
 * Delegates specialized UI sections to subpanels:
 *   BufferPanel  — buffer distance controls
 *   InsolPanel   — insolation analysis button/results
 *   AptMixPanel  — apartment mix controls + building plan
 *   StatsPanel   — section statistics
 *
 * Keeps: feature list, property editors, event wiring.
 */

import { eventBus } from '../core/EventBus.js';
import { commandManager } from '../core/commands/CommandManager.js';
import { UpdateFeatureCommand } from '../core/commands/UpdateFeatureCommand.js';
import { DEFAULT_PARAMS, getParams, computeFloorCount, computeBuildingHeight, autoFireDist } from '../core/SectionParams.js';

import { renderBufferSection, onBuffersVisibility } from './panels/BufferPanel.js';
import { renderInsolSection, updateInsolButton, showInsolResults, onInsolClear, onRaysVisibility } from './panels/InsolPanel.js';
import { renderAptMixSection, showBuildingPlan, updateAptMixVisibility, resetDistributeState } from './panels/AptMixPanel.js';
import { updateStats } from './panels/StatsPanel.js';

var PARAM_DEFS = [
  { key: 'sectionWidth', label: 'Section width', unit: 'м', step: 0.5, min: 10, max: 30 },
  { key: 'corridorWidth', label: 'Corridor width', unit: 'м', step: 0.5, min: 1, max: 5 },
  { key: 'cellWidth', label: 'Cell width', unit: 'м', step: 0.1, min: 2, max: 5 },
  { key: 'sectionHeight', label: 'Section height', unit: 'м', step: 1, min: 5, max: 75 },
  { key: 'firstFloorHeight', label: '1st floor H', unit: 'м', step: 0.1, min: 3, max: 6 },
  { key: 'typicalFloorHeight', label: 'Typical floor H', unit: 'м', step: 0.1, min: 2.5, max: 4 }
];

export class FeaturePanel {
  constructor(containerId, featureStore) {
    this._container = document.getElementById(containerId);
    if (!this._container) throw new Error('FeaturePanel #' + containerId + ' not found');
    this._featureStore = featureStore;
    this._selectedIds = [];
    this._buffersVisible = false;
    this._editAxisId = null;
    this._editSelectedIndices = [];
    this._paramsOpen = false;
  }

  init() { this._render(); this._setupEvents(); }

  // ── Layout ──────────────────────────────────────────

  _render() {
    this._container.innerHTML =
      '<div class="panel-header"><span class="panel-title">Features</span>' +
      '<span class="panel-badge" id="feature-count">0</span></div>' +
      '<div class="panel-body"><div id="feature-list"></div><div id="section-props"></div>' +
      '<div id="buffer-section"></div><div id="insol-section"></div>' +
      '<div id="apt-mix-section"></div>' +
      '<div id="stats-section"></div></div>';
    renderBufferSection();
    renderInsolSection();
    renderAptMixSection();
  }

  // ── Insol button helper ─────────────────────────────

  _refreshInsolButton() {
    updateInsolButton(this._featureStore, this._editAxisId, this._editSelectedIndices, this._selectedIds);
  }

  _updateAptMixVisibility() {
    var all = this._featureStore.toArray();
    var hasSections = false;
    for (var i = 0; i < all.length; i++) {
      if (all[i].properties.type === 'section-axis') { hasSections = true; break; }
    }
    updateAptMixVisibility(hasSections);
  }

  // ── Events ──────────────────────────────────────────

  _setupEvents() {
    var self = this;

    eventBus.on('features:changed', function () {
      self._updateList(); self._updateProps(); self._refreshInsolButton();
      self._updateAptMixVisibility();
      resetDistributeState();
    });
    eventBus.on('feature:selected', function (d) {
      self._selectedIds = [d.id]; self._editAxisId = null; self._editSelectedIndices = [];
      self._updateList(); self._updateProps(); self._refreshInsolButton();
    });
    eventBus.on('feature:multiselect', function (d) {
      var idx = self._selectedIds.indexOf(d.id);
      if (idx >= 0) self._selectedIds.splice(idx, 1);
      else self._selectedIds.push(d.id);
      self._editAxisId = null; self._editSelectedIndices = [];
      self._updateList(); self._updateProps(); self._refreshInsolButton();
    });
    eventBus.on('feature:deselected', function () {
      self._selectedIds = []; self._editAxisId = null; self._editSelectedIndices = [];
      self._updateList(); self._updateProps(); self._refreshInsolButton();
    });
    eventBus.on('section:edit-mode', function (d) {
      self._editAxisId = d.axisId; self._editSelectedIndices = [];
      self._selectedIds = [d.axisId];
      self._updateList(); self._updateProps(); self._refreshInsolButton();
    });
    eventBus.on('section:edit-exit', function () {
      self._editAxisId = null; self._editSelectedIndices = [];
      self._updateProps(); self._refreshInsolButton();
    });
    eventBus.on('section:individual:selected', function (d) {
      self._editAxisId = d.axisId;
      self._editSelectedIndices = d.sectionIndices || [];
      self._updateProps(); self._refreshInsolButton();
    });

    eventBus.on('buffers:visibility', function (d) {
      self._buffersVisible = d.visible;
      onBuffersVisibility(d);
    });

    this._container.addEventListener('click', function (e) {
      var item = e.target.closest('.feature-item');
      if (!item) return;
      var id = item.dataset.id;
      if (!id) return;
      if (e.ctrlKey || e.metaKey) eventBus.emit('feature:multiselect', { id: id });
      else eventBus.emit('sidebar:feature:click', { id: id });
    });

    // Insol panel events
    eventBus.on('insolation:results', function (data) {
      showInsolResults(data);
      self._refreshInsolButton();
    });
    eventBus.on('insolation:clear', function () {
      onInsolClear();
      self._refreshInsolButton();
    });
    eventBus.on('insolation:rays:visibility', onRaysVisibility);
    eventBus.on('draw:section:complete', function () { self._refreshInsolButton(); });

    // Stats + building plan
    eventBus.on('section-gen:stats', function (stats) { updateStats(stats); });
    eventBus.on('building:plan:result', function (data) { showBuildingPlan(data.plan); });
  }

  // ── Feature list ────────────────────────────────────

  _updateList() {
    var countEl = document.getElementById('feature-count');
    var listEl = document.getElementById('feature-list');
    if (!countEl || !listEl) return;
    var features = this._featureStore.toArray();
    countEl.textContent = String(features.length);
    if (features.length === 0) { listEl.innerHTML = '<div class="panel-empty">Press S to draw sections</div>'; return; }
    var html = '';
    for (var i = 0; i < features.length; i++) {
      var f = features[i]; var id = f.properties.id;
      var ftype = f.properties.type || 'feature';
      var icon = ftype === 'section-axis' ? '▦' : '╱';
      var label = ftype === 'section-axis' ? 'section' : 'line';
      var sel = this._selectedIds.indexOf(id) >= 0 ? ' selected' : '';
      var editBadge = (this._editAxisId === id) ? ' <small style="color:var(--primary)">[edit]</small>' : '';
      html += '<div class="feature-item' + sel + '" data-id="' + id + '"><span class="feature-icon">' + icon + '</span>' +
        '<span class="feature-name">' + label + ' ' + id.slice(0, 6) + editBadge + '</span></div>';
    }
    listEl.innerHTML = html;
  }

  // ── Properties ──────────────────────────────────────

  _updateProps() {
    var propsEl = document.getElementById('section-props');
    if (!propsEl) return;
    if (this._selectedIds.length === 0 && !this._editAxisId) { propsEl.innerHTML = ''; return; }

    if (this._editAxisId && this._editSelectedIndices.length > 0) {
      propsEl.innerHTML = this._renderSelectedSections();
      this._bindEditInputs();
      return;
    }

    if (this._editAxisId && this._editSelectedIndices.length === 0) {
      var f = this._featureStore.get(this._editAxisId);
      var numSec = f && f.properties.footprints ? f.properties.footprints.length : 0;
      propsEl.innerHTML = '<div class="props-section" style="background:rgba(255,102,0,0.08);border-radius:6px;margin:4px 0">' +
        '<div class="props-header" style="color:#ff6600">Edit Mode</div>' +
        '<div style="padding:2px 12px 8px;font-size:11px;color:var(--text-secondary)">Click section to select · Shift+click for multi-select<br>' +
        numSec + ' sections on this axis</div></div>';
      return;
    }

    var sectionFeatures = []; var lineFeatures = [];
    for (var i = 0; i < this._selectedIds.length; i++) {
      var f = this._featureStore.get(this._selectedIds[i]);
      if (!f) continue;
      if (f.properties.type === 'section-axis') sectionFeatures.push(f);
      else if (f.geometry.type === 'LineString') lineFeatures.push(f);
    }
    var html = '';
    if (sectionFeatures.length > 0) html += this._renderSectionProps(sectionFeatures);
    if (lineFeatures.length > 0) html += this._renderLineProps(lineFeatures);
    propsEl.innerHTML = html;
    this._bindInputs();
  }

  _renderSelectedSections() {
    var f = this._featureStore.get(this._editAxisId);
    if (!f || !f.properties.footprints) return '';
    var fps = f.properties.footprints;
    var params = getParams(f.properties);

    var indices = this._editSelectedIndices;
    var isSingle = indices.length === 1;

    var heights = [];
    var hasIndep = false;
    for (var i = 0; i < indices.length; i++) {
      var fp = fps[indices[i]];
      if (!fp) continue;
      var h = fp.sectionHeight !== undefined ? fp.sectionHeight : params.sectionHeight;
      heights.push(h);
      if (fp.sectionHeight !== undefined) hasIndep = true;
    }

    var allSameH = true;
    for (var i = 1; i < heights.length; i++) {
      if (heights[i] !== heights[0]) { allSameH = false; break; }
    }

    var displayH = allSameH ? heights[0] : heights[0];
    var fireAuto = autoFireDist(displayH);
    var fc = computeFloorCount(displayH, params.firstFloorHeight, params.typicalFloorHeight);
    var bh = computeBuildingHeight(displayH, params.firstFloorHeight, params.typicalFloorHeight);

    var title;
    if (isSingle) {
      title = 'Section #' + (indices[0] + 1);
    } else {
      var nums = [];
      for (var i = 0; i < indices.length; i++) nums.push('#' + (indices[i] + 1));
      title = 'Sections ' + nums.join(', ');
    }

    var html = '<div class="props-section" style="background:rgba(255,102,0,0.08);border-radius:6px;margin:4px 0">';
    html += '<div class="props-header" style="color:#ff6600">' + title;
    if (hasIndep) html += ' <span style="color:#dc2626;font-size:10px;font-weight:700;margin-left:4px">INDEPENDENT</span>';
    html += '</div>';

    html += '<div class="props-computed">';
    html += '<div class="props-row"><span class="props-label">Floors</span><span class="props-value">' + fc + 'F</span></div>';
    html += '<div class="props-row"><span class="props-label">Height</span><span class="props-value">' + bh.toFixed(1) + ' м</span></div>';
    html += '<div class="props-row"><span class="props-label">Fire buffer</span><span class="props-value">' + fireAuto + ' м <small>(auto)</small></span></div>';
    html += '</div>';

    html += '<div class="props-divider"></div>';
    html += '<div class="param-row"><label class="param-label" style="font-weight:600">Section height</label>';
    html += '<div class="param-input-wrap"><input type="number" class="param-input" id="sec-edit-height"';
    html += ' value="' + displayH + '" step="1" min="5" max="75"';
    if (!allSameH) html += ' placeholder="mixed"';
    html += '><span class="param-unit">м</span></div></div>';

    if (!allSameH) {
      html += '<div style="padding:2px 12px 4px;font-size:10px;color:#d97706">Selected sections have different heights. New value applies to all selected.</div>';
    }
    if (hasIndep) {
      html += '<div style="padding:2px 12px 8px;font-size:10px;color:#dc2626">Modified height — independent from axis default (' + params.sectionHeight + 'м)</div>';
    } else {
      html += '<div style="padding:2px 12px 8px;font-size:10px;color:var(--text-muted)">Change height to separate from axis group</div>';
    }

    html += '</div>';
    return html;
  }

  _bindEditInputs() {
    var self = this;
    var input = document.getElementById('sec-edit-height');
    if (!input) return;
    input.addEventListener('change', function (e) {
      var val = parseFloat(e.target.value);
      if (isNaN(val)) return;
      eventBus.emit('section:param:changed', {
        axisId: self._editAxisId,
        sectionIndices: self._editSelectedIndices.slice(),
        key: 'sectionHeight',
        value: val
      });
      setTimeout(function () { self._updateProps(); }, 100);
    });
    input.focus();
    input.select();
  }

  _renderSectionProps(features) {
    var params = getParams(features[0].properties);
    var totalLen = 0;
    for (var i = 0; i < features.length; i++) totalLen += features[i].properties.axisLength || 0;
    var footArea = totalLen * params.sectionWidth;
    var aptArea = footArea * 0.65;
    var fireAuto = autoFireDist(params.sectionHeight);
    var label = features.length === 1 ? 'Section ' + features[0].properties.id.slice(0, 6) : features.length + ' sections';

    var h = '<div class="props-section"><div class="props-header">' + label + '</div>';
    h += '<div style="padding:0 12px 4px;font-size:10px;color:var(--text-muted)">Double-click on map to edit individual sections</div>';
    h += '<div class="props-computed">';
    h += '<div class="props-row"><span class="props-label">Axis length</span><span class="props-value">' + totalLen.toFixed(1) + ' м</span></div>';
    h += '<div class="props-row"><span class="props-label">Footprint</span><span class="props-value">' + footArea.toFixed(0) + ' м²</span></div>';
    h += '<div class="props-row"><span class="props-label">Apartment area</span><span class="props-value">' + aptArea.toFixed(0) + ' м² <small>(×0.65)</small></span></div>';
    h += '<div class="props-row"><span class="props-label">Fire buffer</span><span class="props-value">' + fireAuto + ' м <small>(auto)</small></span></div>';
    h += '</div><div class="props-divider"></div>';
    h += '<div class="params-toggle" id="params-toggle">';
    h += '<span class="params-toggle-label">Parameters</span>';
    h += '<span class="params-toggle-chevron' + (this._paramsOpen ? ' open' : '') + '" id="params-chevron">▸</span>';
    h += '</div>';
    h += '<div class="params-body' + (this._paramsOpen ? ' open' : '') + '" id="params-body">';
    for (var pi = 0; pi < PARAM_DEFS.length; pi++) {
      var d = PARAM_DEFS[pi];
      h += '<div class="param-row"><label class="param-label">' + d.label + '</label>' +
        '<div class="param-input-wrap"><input type="number" class="param-input" data-key="' + d.key + '" data-target="section"' +
        ' value="' + params[d.key] + '" step="' + d.step + '" min="' + d.min + '" max="' + d.max + '">' +
        '<span class="param-unit">' + d.unit + '</span></div></div>';
    }
    h += '</div></div>';
    return h;
  }

  _renderLineProps(features) {
    var totalLen = 0;
    for (var i = 0; i < features.length; i++) {
      var coords = features[i].geometry.coordinates;
      for (var j = 0; j < coords.length - 1; j++) {
        var dlng = (coords[j+1][0]-coords[j][0])*111320*Math.cos(coords[j][1]*Math.PI/180);
        var dlat = (coords[j+1][1]-coords[j][1])*110540;
        totalLen += Math.sqrt(dlng*dlng+dlat*dlat);
      }
    }
    var color = features[0].properties.color || '#3388ff';
    var label = features.length === 1 ? 'Line ' + features[0].properties.id.slice(0, 6) : features.length + ' lines';
    return '<div class="props-section"><div class="props-header">' + label + '</div>' +
      '<div class="props-computed"><div class="props-row"><span class="props-label">Length</span><span class="props-value">' + totalLen.toFixed(1) + ' м</span></div></div>' +
      '<div class="param-row"><label class="param-label">Color</label><div class="param-input-wrap"><input type="color" class="param-color" data-key="color" data-target="line" value="' + color + '"></div></div></div>';
  }

  _bindInputs() {
    var self = this;
    var toggle = document.getElementById('params-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var body = document.getElementById('params-body');
        var chev = document.getElementById('params-chevron');
        if (body && chev) {
          body.classList.toggle('open');
          chev.classList.toggle('open');
          self._paramsOpen = body.classList.contains('open');
        }
      });
    }
    var inputs = this._container.querySelectorAll('.param-input[data-target="section"]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('change', function (e) {
        var key = e.target.dataset.key; var val = parseFloat(e.target.value);
        if (isNaN(val)) return;
        for (var si = 0; si < self._selectedIds.length; si++) {
          var f = self._featureStore.get(self._selectedIds[si]);
          if (!f) continue;
          var oldVal = f.properties[key];
          var newProps = {}; newProps[key] = val;
          var oldProps = {}; oldProps[key] = oldVal;
          commandManager.execute(new UpdateFeatureCommand(
            self._featureStore, self._selectedIds[si], newProps, oldProps
          ));
        }
        eventBus.emit('section-gen:params:changed');
        eventBus.emit('buffers:recompute');
      });
    }
    var colorInputs = this._container.querySelectorAll('.param-color[data-target="line"]');
    for (var i = 0; i < colorInputs.length; i++) {
      colorInputs[i].addEventListener('input', function (e) {
        for (var si = 0; si < self._selectedIds.length; si++) {
          var f = self._featureStore.get(self._selectedIds[si]);
          var oldColor = f ? f.properties.color : '#3388ff';
          commandManager.execute(new UpdateFeatureCommand(
            self._featureStore, self._selectedIds[si],
            { color: e.target.value }, { color: oldColor }
          ));
        }
        eventBus.emit('features:changed');
      });
    }
  }
}
