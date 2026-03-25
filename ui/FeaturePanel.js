/**
 * FeaturePanel — multi-section selection via shift+click
 * Shows height for selected sections, applies to all selected
 */

import { eventBus } from '../core/EventBus.js';
import { commandManager } from '../core/commands/CommandManager.js';
import { UpdateFeatureCommand } from '../core/commands/UpdateFeatureCommand.js';
import { DEFAULT_PARAMS, getParams, computeFloorCount, computeBuildingHeight, autoFireDist } from '../core/SectionParams.js';

var PARAM_DEFS = [
  { key: 'sectionWidth', label: 'Section width', unit: 'м', step: 0.5, min: 10, max: 30 },
  { key: 'corridorWidth', label: 'Corridor width', unit: 'м', step: 0.5, min: 1, max: 5 },
  { key: 'cellWidth', label: 'Cell width', unit: 'м', step: 0.1, min: 2, max: 5 },
  { key: 'sectionHeight', label: 'Section height', unit: 'м', step: 1, min: 5, max: 75 },
  { key: 'firstFloorHeight', label: '1st floor H', unit: 'м', step: 0.1, min: 3, max: 6 },
  { key: 'typicalFloorHeight', label: 'Typical floor H', unit: 'м', step: 0.1, min: 2.5, max: 4 }
];

var BUFFER_DEFS = [
  { key: 'fire', label: 'Fire', unit: 'м', step: 1, min: 1, max: 30, color: '#dc2626', def: 11 },
  { key: 'end', label: 'End', unit: 'м', step: 1, min: 5, max: 40, color: '#2563eb', def: 20 },
  { key: 'insolation', label: 'Insol', unit: 'м', step: 5, min: 10, max: 80, color: '#16a34a', def: 40 }
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
  }

  init() { this._render(); this._setupEvents(); }

  _render() {
    this._container.innerHTML =
      '<div class="panel-header"><span class="panel-title">Features</span>' +
      '<span class="panel-badge" id="feature-count">0</span></div>' +
      '<div class="panel-body"><div id="feature-list"></div><div id="section-props"></div>' +
      '<div id="buffer-section"></div><div id="insol-section"></div>' +
      '<div id="apt-mix-section"></div>' +
      '<div id="stats-section"></div></div>';
    this._renderBufferSection();
    this._renderInsolSection();
    this._renderAptMixSection();
  }

  _renderBufferSection() {
    var el = document.getElementById('buffer-section');
    if (!el) return;
    var h = '<div class="props-divider"></div>';
    h += '<div class="param-row" style="cursor:pointer" id="buffer-toggle-row">';
    h += '<label class="param-label" style="font-weight:600;cursor:pointer">Buffers</label>';
    h += '<div class="param-input-wrap"><span id="buffer-toggle-indicator" style="font-size:11px;color:var(--text-muted)">OFF</span></div></div>';
    h += '<div id="buffer-params" style="display:none">';
    for (var i = 0; i < BUFFER_DEFS.length; i++) {
      var d = BUFFER_DEFS[i];
      var autoLabel = d.key === 'fire' ? ' <small style="color:var(--text-muted)">(auto)</small>' : '';
      h += '<div class="param-row"><span style="width:8px;height:8px;border-radius:2px;background:' + d.color + ';flex-shrink:0"></span>';
      h += '<label class="param-label" style="flex:1">' + d.label + autoLabel + '</label>';
      h += '<div class="param-input-wrap"><input type="number" class="param-input" data-buf="' + d.key + '"';
      h += ' value="' + d.def + '" step="' + d.step + '" min="' + d.min + '" max="' + d.max + '" style="width:44px"';
      h += (d.key === 'fire' ? ' disabled title="Auto: ≤28m→11m, >28m→14m"' : '') + '>';
      h += '<span class="param-unit">' + d.unit + '</span></div></div>';
    }
    h += '</div>';
    el.innerHTML = h;
    var toggleRow = document.getElementById('buffer-toggle-row');
    if (toggleRow) toggleRow.addEventListener('click', function () { eventBus.emit('buffers:toggle'); });
    var inputs = document.querySelectorAll('.param-input[data-buf]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('change', function (e) {
        var val = parseFloat(e.target.value);
        if (!isNaN(val)) eventBus.emit('buffers:distance:changed', { key: e.target.dataset.buf, value: val });
      });
    }
  }

  _renderInsolSection() {
    var el = document.getElementById('insol-section');
    if (!el) return;
    var h = '<div class="props-divider"></div>';
    h += '<div class="insol-panel" id="insol-panel">';
    h += '<div id="insol-btn-wrap"></div>';
    h += '<div id="insol-results" style="display:none"></div>';
    h += '</div>';
    el.innerHTML = h;
  }

  _renderAptMixSection() {
    var el = document.getElementById('apt-mix-section');
    if (!el) return;
    var h = '<div class="props-divider"></div>';
    h += '<div class="apt-mix-panel">';
    h += '<div class="apt-mix-header">Apartment Mix</div>';
    h += '<div class="apt-mix-inputs">';
    var types = [
      { key: '1K', color: '#ade8f4', def: 40 },
      { key: '2K', color: '#90ee90', def: 30 },
      { key: '3K', color: '#ffdab9', def: 20 },
      { key: '4K', color: '#dda0dd', def: 10 }
    ];
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      h += '<div class="apt-mix-row">';
      h += '<span class="apt-mix-swatch" style="background:' + t.color + '"></span>';
      h += '<span class="apt-mix-label">' + t.key + '</span>';
      h += '<input type="number" class="apt-mix-input" data-apt="' + t.key + '"';
      h += ' value="' + t.def + '" min="0" max="100" step="5">';
      h += '<span class="apt-mix-unit">%</span>';
      h += '</div>';
    }
    h += '<div class="apt-mix-total" id="apt-mix-total">Total: 100%</div>';
    h += '</div>';
    h += '<div class="apt-mix-actions">';
    h += '<button class="apt-mix-btn" id="apt-mix-distribute">Distribute apartments</button>';
    h += '<button class="apt-mix-btn apt-mix-btn--reset" id="apt-mix-reset" style="display:none">Reset to floor 1</button>';
    h += '<button class="apt-mix-btn apt-mix-btn--report" id="apt-mix-report" style="display:none">Floor plans report</button>';
    h += '</div>';
    h += '<div id="building-plan-results"></div>';
    h += '<div id="wz-status"></div>';
    h += '</div>';
    el.innerHTML = h;

    // Bind inputs
    var self = this;
    var inputs = el.querySelectorAll('.apt-mix-input');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('change', function () {
        self._updateMixTotal();
        eventBus.emit('apt-mix:changed', self._getAptMix());
      });
    }
    var distBtn = document.getElementById('apt-mix-distribute');
    if (distBtn) {
      distBtn.addEventListener('click', function () {
        eventBus.emit('apt-mix:distribute', self._getAptMix());
        distBtn.style.display = 'none';
        var resetBtn = document.getElementById('apt-mix-reset');
        if (resetBtn) resetBtn.style.display = 'block';
        var repBtn = document.getElementById('apt-mix-report');
        if (repBtn) repBtn.style.display = 'block';
      });
    }
    var resetBtn = document.getElementById('apt-mix-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        eventBus.emit('apt-mix:reset');
        resetBtn.style.display = 'none';
        var repBtn = document.getElementById('apt-mix-report');
        if (repBtn) repBtn.style.display = 'none';
        var dBtn = document.getElementById('apt-mix-distribute');
        if (dBtn) dBtn.style.display = 'block';
        var resEl = document.getElementById('building-plan-results');
        if (resEl) resEl.innerHTML = '';
      });
    }
    var reportBtn = document.getElementById('apt-mix-report');
    if (reportBtn) {
      reportBtn.addEventListener('click', function () {
        eventBus.emit('building:report:generate');
      });
    }
  }

  _getAptMix() {
    var mix = { '1K': 40, '2K': 30, '3K': 20, '4K': 10 };
    var inputs = document.querySelectorAll('.apt-mix-input');
    for (var i = 0; i < inputs.length; i++) {
      var key = inputs[i].dataset.apt;
      mix[key] = parseInt(inputs[i].value) || 0;
    }
    return mix;
  }

  _updateMixTotal() {
    var mix = this._getAptMix();
    var total = mix['1K'] + mix['2K'] + mix['3K'] + mix['4K'];
    var el = document.getElementById('apt-mix-total');
    if (el) {
      el.textContent = 'Total: ' + total + '%';
      el.style.color = total === 100 ? 'var(--success)' : 'var(--danger)';
    }
  }

  /**
   * Context-aware insolation button.
   * Adapts label and action to current selection state:
   *   - No selection → "All sections"
   *   - Axis selected → "Axis · N sections"  
   *   - Edit mode, section selected → "Section #N"
   *   - Global active → show LIVE badge
   */
  _updateInsolButton() {
    var wrap = document.getElementById('insol-btn-wrap');
    if (!wrap) return;

    // Check if any sections exist
    var all = this._featureStore.toArray();
    var hasSections = false;
    for (var i = 0; i < all.length; i++) {
      if (all[i].properties.type === 'section-axis') { hasSections = true; break; }
    }

    if (!hasSections) { wrap.innerHTML = ''; return; }

    // Determine context
    var scope, label, event, eventData;

    if (this._editAxisId && this._editSelectedIndices.length === 1) {
      // Edit mode — single section selected
      scope = 'section';
      var secNum = this._editSelectedIndices[0] + 1;
      label = 'Section #' + secNum;
      event = 'insolation:analyze:section';
      eventData = { axisId: this._editAxisId, sectionIdx: this._editSelectedIndices[0] };
    } else if (this._editAxisId) {
      // Edit mode — no section or multi-select
      scope = 'axis';
      var f = this._featureStore.get(this._editAxisId);
      var n = f && f.properties.footprints ? f.properties.footprints.length : 0;
      label = 'Editing axis · ' + n + ' sect.';
      event = 'insolation:analyze:axis';
      eventData = { axisId: this._editAxisId };
    } else if (this._selectedIds.length === 1) {
      // Axis selected
      var f = this._featureStore.get(this._selectedIds[0]);
      if (f && f.properties.type === 'section-axis') {
        scope = 'axis';
        var n = f.properties.footprints ? f.properties.footprints.length : 0;
        label = 'Selected axis · ' + n + ' sect.';
        event = 'insolation:analyze:axis';
        eventData = { axisId: this._selectedIds[0] };
      } else {
        scope = 'global';
        label = 'All sections';
        event = 'insolation:analyze:global';
        eventData = null;
      }
    } else {
      scope = 'global';
      label = 'All sections';
      event = 'insolation:analyze:global';
      eventData = null;
    }

    // Check if global is live (results card visible)
    var resultsEl = document.getElementById('insol-results');
    var isLive = resultsEl && resultsEl.style.display === 'block';

    var h = '<button class="insol-btn insol-btn--analyze" id="insol-analyze-btn" data-scope="' + scope + '">';
    h += '<span class="insol-btn-icon">◐</span>';
    h += '<span class="insol-btn-label">' + label + '</span>';
    if (isLive && scope === 'global') {
      h += '<span class="insol-live-badge">LIVE</span>';
    }
    h += '</button>';

    wrap.innerHTML = h;

    var btn = document.getElementById('insol-analyze-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        eventBus.emit(event, eventData);
      });
    }
  }

  _showInsolResults(data) {
    var el = document.getElementById('insol-results');
    if (!el) return;
    var levelLabel = data.level === 'global' ? 'All sections' : data.level === 'axis' ? 'Selected axis' : 'Section';
    el.style.display = 'block';
    el.innerHTML =
      '<div class="insol-results-card">' +
      '<div class="insol-results-header">' + levelLabel + ' — ' + data.total + ' points</div>' +
      '<div class="insol-results-bar">' +
        '<div class="insol-bar-pass" style="width:' + (data.total > 0 ? data.pass / data.total * 100 : 0) + '%"></div>' +
        '<div class="insol-bar-warn" style="width:' + (data.total > 0 ? data.warning / data.total * 100 : 0) + '%"></div>' +
        '<div class="insol-bar-fail" style="width:' + (data.total > 0 ? data.fail / data.total * 100 : 0) + '%"></div>' +
      '</div>' +
      '<div class="insol-results-stats">' +
        '<span class="insol-stat insol-stat--pass">' + data.pass + ' pass</span>' +
        '<span class="insol-stat insol-stat--warn">' + data.warning + ' warn</span>' +
        '<span class="insol-stat insol-stat--fail">' + data.fail + ' fail</span>' +
      '</div>' +
      '<div class="insol-compliance">' + data.complianceRate + '% compliance</div>' +
      '<div class="insol-actions">' +
        '<button class="insol-btn insol-btn--rays" id="insol-rays-btn">' +
          '<span class="insol-btn-icon">⟋</span> <span id="insol-rays-label">Show rays</span></button>' +
        '<button class="insol-btn insol-btn--clear" id="insol-clear-btn">Clear results</button>' +
      '</div>' +
      '</div>';
    var clearBtn = document.getElementById('insol-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', function () { eventBus.emit('insolation:clear'); el.style.display = 'none'; });
    var raysBtn = document.getElementById('insol-rays-btn');
    if (raysBtn) raysBtn.addEventListener('click', function () { eventBus.emit('insolation:rays:toggle'); });
  }

  _setupEvents() {
    var self = this;
    eventBus.on('features:changed', function () { self._updateList(); self._updateProps(); self._updateInsolButton(); });
    eventBus.on('feature:selected', function (d) {
      self._selectedIds = [d.id]; self._editAxisId = null; self._editSelectedIndices = [];
      self._updateList(); self._updateProps(); self._updateInsolButton();
    });
    eventBus.on('feature:multiselect', function (d) {
      var idx = self._selectedIds.indexOf(d.id);
      if (idx >= 0) self._selectedIds.splice(idx, 1);
      else self._selectedIds.push(d.id);
      self._editAxisId = null; self._editSelectedIndices = [];
      self._updateList(); self._updateProps(); self._updateInsolButton();
    });
    eventBus.on('feature:deselected', function () {
      self._selectedIds = []; self._editAxisId = null; self._editSelectedIndices = [];
      self._updateList(); self._updateProps(); self._updateInsolButton();
    });
    eventBus.on('section:edit-mode', function (d) {
      self._editAxisId = d.axisId; self._editSelectedIndices = [];
      self._selectedIds = [d.axisId];
      self._updateList(); self._updateProps(); self._updateInsolButton();
    });
    eventBus.on('section:edit-exit', function () {
      self._editAxisId = null; self._editSelectedIndices = [];
      self._updateProps(); self._updateInsolButton();
    });
    eventBus.on('section:individual:selected', function (d) {
      self._editAxisId = d.axisId;
      self._editSelectedIndices = d.sectionIndices || [];
      self._updateProps(); self._updateInsolButton();
    });
    eventBus.on('buffers:visibility', function (d) {
      self._buffersVisible = d.visible;
      var ind = document.getElementById('buffer-toggle-indicator');
      var params = document.getElementById('buffer-params');
      if (ind) { ind.textContent = d.visible ? 'ON' : 'OFF'; ind.style.color = d.visible ? 'var(--primary)' : 'var(--text-muted)'; ind.style.fontWeight = d.visible ? '700' : '400'; }
      if (params) params.style.display = d.visible ? 'block' : 'none';
    });

    this._container.addEventListener('click', function (e) {
      var item = e.target.closest('.feature-item');
      if (!item) return;
      var id = item.dataset.id;
      if (!id) return;
      if (e.ctrlKey || e.metaKey) eventBus.emit('feature:multiselect', { id: id });
      else eventBus.emit('sidebar:feature:click', { id: id });
    });

    eventBus.on('insolation:results', function (data) {
      self._showInsolResults(data);
      self._updateInsolButton();
    });
    eventBus.on('insolation:clear', function () {
      var el = document.getElementById('insol-results');
      if (el) el.style.display = 'none';
      self._updateInsolButton();
    });
    eventBus.on('insolation:rays:visibility', function (d) {
      var lbl = document.getElementById('insol-rays-label');
      if (lbl) lbl.textContent = d.visible ? 'Hide rays' : 'Show rays';
    });
    eventBus.on('draw:section:complete', function () { self._updateInsolButton(); });
    eventBus.on('section-gen:stats', function (stats) { self._updateStats(stats); });
    eventBus.on('building:plan:result', function (data) { self._showBuildingPlan(data.plan); });
  }

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

  _updateProps() {
    var propsEl = document.getElementById('section-props');
    if (!propsEl) return;
    if (this._selectedIds.length === 0 && !this._editAxisId) { propsEl.innerHTML = ''; return; }

    // Individual sections selected in edit mode
    if (this._editAxisId && this._editSelectedIndices.length > 0) {
      propsEl.innerHTML = this._renderSelectedSections();
      this._bindEditInputs();
      return;
    }

    // Edit mode, no section selected
    if (this._editAxisId && this._editSelectedIndices.length === 0) {
      var f = this._featureStore.get(this._editAxisId);
      var numSec = f && f.properties.footprints ? f.properties.footprints.length : 0;
      propsEl.innerHTML = '<div class="props-section" style="background:rgba(255,102,0,0.08);border-radius:6px;margin:4px 0">' +
        '<div class="props-header" style="color:#ff6600">Edit Mode</div>' +
        '<div style="padding:2px 12px 8px;font-size:11px;color:var(--text-secondary)">Click section to select · Shift+click for multi-select<br>' +
        numSec + ' sections on this axis</div></div>';
      return;
    }

    // Normal mode
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

    // Get heights of selected sections
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

    // Title
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
    h += '<span class="params-toggle-chevron" id="params-chevron">▸</span>';
    h += '</div>';
    h += '<div class="params-body" id="params-body">';
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
    // Params toggle
    var toggle = document.getElementById('params-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var body = document.getElementById('params-body');
        var chev = document.getElementById('params-chevron');
        if (body && chev) {
          body.classList.toggle('open');
          chev.classList.toggle('open');
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

  _showBuildingPlan(plan) {
    var el = document.getElementById('building-plan-results');
    if (!el || !plan) return;

    var dev = plan.deviation;
    var h = '<div class="bplan-card">';
    h += '<div class="bplan-header">Distribution Result</div>';
    h += '<div class="bplan-table">';
    h += '<div class="bplan-row bplan-row--header">';
    h += '<span>Type</span><span>Target</span><span>Actual</span><span>Δ</span>';
    h += '</div>';
    var types = ['1K', '2K', '3K', '4K'];
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      var d = dev[t];
      var deltaClass = d.delta === 0 ? 'bplan-ok' : (d.delta > 0 ? 'bplan-over' : 'bplan-under');
      var deltaStr = d.delta > 0 ? '+' + d.delta : String(d.delta);
      h += '<div class="bplan-row">';
      h += '<span class="bplan-type">' + t + '</span>';
      h += '<span>' + d.target + ' <small>(' + d.targetPct + '%)</small></span>';
      h += '<span>' + d.actual + ' <small>(' + d.actualPct + '%)</small></span>';
      h += '<span class="' + deltaClass + '">' + deltaStr + '</span>';
      h += '</div>';
    }
    h += '</div>';
    h += '<div class="bplan-summary">';
    h += 'Total: ' + plan.totalActual + '/' + plan.totalTarget + ' apts';
    h += ' · ' + plan.floors.length + ' floors';
    if (plan.orphanCount > 0) h += ' · <span style="color:var(--danger)">' + plan.orphanCount + ' orphan</span>';
    h += '</div>';
    h += '</div>';
    el.innerHTML = h;
  }

  _updateStats(stats) {
    var el = document.getElementById('stats-section');
    if (!el) return;
    if (!stats || stats.sections.length === 0) { el.innerHTML = ''; return; }

    var h = '<div class="props-divider"></div>';
    h += '<div class="stats-panel">';

    // Summary totals
    h += '<div class="stats-summary">';
    h += '<div class="stats-summary-row">';
    h += '<span class="stats-label">Footprint</span>';
    h += '<span class="stats-value">' + fmtArea(stats.totalFootprint) + '</span>';
    h += '</div>';
    h += '<div class="stats-summary-row">';
    h += '<span class="stats-label">Apt. area <small style="color:var(--text-muted)">×0.65</small></span>';
    h += '<span class="stats-value">' + fmtArea(stats.totalAptArea) + '</span>';
    h += '</div>';
    h += '<div class="stats-summary-row">';
    h += '<span class="stats-label">GBA</span>';
    var totalGBA = 0;
    for (var gi = 0; gi < stats.sections.length; gi++) totalGBA += stats.sections[gi].totalGBA;
    h += '<span class="stats-value">' + fmtArea(totalGBA) + '</span>';
    h += '</div>';
    h += '<div class="stats-summary-row stats-summary-row--pop">';
    h += '<span class="stats-label">Population <small style="color:var(--text-muted)">/50 m²</small></span>';
    h += '<span class="stats-value stats-value--pop">' + stats.totalPopulation + ' чел</span>';
    h += '</div>';
    h += '</div>';

    // Per-section cards grouped by axis
    h += '<div class="stats-sections">';
    var axisMap = {};
    var axisOrder = [];
    for (var i = 0; i < stats.sections.length; i++) {
      var s = stats.sections[i];
      if (!axisMap[s.axisId]) { axisMap[s.axisId] = []; axisOrder.push(s.axisId); }
      axisMap[s.axisId].push(s);
    }
    for (var ai = 0; ai < axisOrder.length; ai++) {
      var axId = axisOrder[ai];
      var secs = axisMap[axId];
      var axisPop = 0;
      var axisApt = 0;
      for (var si = 0; si < secs.length; si++) {
        axisPop += secs[si].population;
        axisApt += secs[si].totalAptArea;
      }
      h += '<div class="stats-axis-header">Axis ' + axId.slice(0, 5);
      h += ' <span class="stats-axis-sum">' + axisPop + ' чел · ' + fmtArea(axisApt) + '</span></div>';

      for (var si = 0; si < secs.length; si++) {
        var s = secs[si];
        var wz = s.wzPlan;
        h += '<div class="stats-sec-card">';
        h += '<div class="stats-sec-idx">#' + (s.secIdx + 1) + '</div>';
        h += '<div class="stats-sec-metric"><span class="stats-sec-metric-label">Floors</span><span class="stats-sec-metric-value">' + s.floorCount + 'F</span></div>';
        h += '<div class="stats-sec-metric"><span class="stats-sec-metric-label">Footprint</span><span class="stats-sec-metric-value">' + fmtArea(s.footprintArea) + '</span></div>';
        h += '<div class="stats-sec-metric"><span class="stats-sec-metric-label">Apt ×0.65</span><span class="stats-sec-metric-value">' + fmtArea(s.aptFloorArea) + '/fl</span></div>';
        h += '<div class="stats-sec-metric"><span class="stats-sec-metric-label">Pop</span><span class="stats-sec-metric-value stats-sec-metric-value--pop">' + s.population + '</span></div>';
        if (wz) {
          var wzClass = wz.feasible ? 'wz-ok' : 'wz-fail';
          var wzIcon = wz.feasible ? '✓' : '✗';
          var wzLabel = wz.wzCount + ' WZ · ' + Math.round(wz.pairRatio * 100) + '% paired';
          if (wz.totalOrphans > 0 && wz.orientation === 'lon') {
            wzLabel += ' · ' + wz.totalOrphans + ' orph';
          } else if (wz.southOrphans > 0) {
            wzLabel += ' · ' + wz.southOrphans + ' S-orph';
          }
          h += '<div class="stats-sec-metric stats-sec-wz ' + wzClass + '" style="grid-column:2/4">';
          h += '<span class="stats-sec-metric-label">' + (wz.orientation === 'lon' ? 'мерид' : 'шир') + '</span>';
          h += '<span class="stats-sec-metric-value">' + wzIcon + ' ' + wzLabel + '</span>';
          h += '</div>';
        }
        h += '</div>';
      }
    }
    h += '</div>';

    h += '</div>';
    el.innerHTML = h;
  }
}

function fmtArea(m2) {
  if (m2 >= 1000) return (m2 / 1000).toFixed(1) + 'k m²';
  return Math.round(m2) + ' m²';
}
