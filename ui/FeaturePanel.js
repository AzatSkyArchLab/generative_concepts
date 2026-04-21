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
import { getParams, computeFloorCount, computeBuildingHeight } from '../core/SectionParams.js';

import { renderBufferSection, onBuffersVisibility, syncBufferInputs } from './panels/BufferPanel.js';
import { renderInsolSection, updateInsolButton, showInsolResults, onInsolClear, onRaysVisibility } from './panels/InsolPanel.js';
import { renderAptMixSection, showBuildingPlan, resetBuildingPlans, updateAptMixVisibility, resetDistributeState } from './panels/AptMixPanel.js';
import { renderQuotaSection, updateQuotaResults, injectQuotaStyles } from './panels/QuotaPanel.js';
import { updateStats } from './panels/StatsPanel.js';
import { log } from '../core/Logger.js';

var PARAM_DEFS = [
  { key: 'sectionWidth', label: 'Section width', unit: 'm', step: 0.5, min: 10, max: 30 },
  { key: 'corridorWidth', label: 'Corridor width', unit: 'm', step: 0.5, min: 1, max: 5 },
  { key: 'cellWidth', label: 'Cell width', unit: 'm', step: 0.1, min: 2, max: 5 },
  { key: 'sectionHeight', label: 'Section height', unit: 'm', step: 1, min: 5, max: 75 },
  { key: 'firstFloorHeight', label: '1st floor H', unit: 'm', step: 0.1, min: 3, max: 6 },
  { key: 'typicalFloorHeight', label: 'Typical floor H', unit: 'm', step: 0.1, min: 2.5, max: 4 }
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
    this._undergroundVisible = false;
  }

  init() { this._render(); this._setupEvents(); }

  // ── Layout ──────────────────────────────────────────

  _render() {
    this._container.innerHTML =
      '<div class="panel-header"><span class="panel-title">Features</span>' +
      '<span class="panel-badge" id="feature-count">0</span></div>' +
      '<div class="panel-body"><div id="feature-list"></div><div id="section-props"></div>' +
      '<div id="axis-options-section"></div>' +
      '<div id="buffer-section"></div><div id="insol-section"></div>' +
      '<div id="underground-section"></div>' +
      '<div id="apt-mix-section"></div>' +
      '<div id="quota-section"></div>' +
      '<div id="stats-section"></div></div>';
    this._renderAxisOptions();
    this._renderBufferSectionConditional();
    renderInsolSection();
    this._renderUnderground();
    renderAptMixSection();
    renderQuotaSection();
    injectQuotaStyles();
  }

  _renderAxisOptions() {
    var el = document.getElementById('axis-options-section');
    if (!el) return;

    var has = this._hasSectionOrBlock();
    var alreadyRendered = el.innerHTML.trim().length > 0;

    // Short-circuit: no state transition, keep the DOM as-is. This
    // preserves user interactions (focus, listeners, toggle state)
    // when features:changed fires on buffer-slider rebuilds.
    if (has && alreadyRendered) return;
    if (!has && !alreadyRendered) return;
    if (!has) { el.innerHTML = ''; return; }

    // Transition: nothing → rendered. Build the markup once.
    var initialOn = false;
    try {
      if (typeof window !== 'undefined' && window.__UB_USE_GAP__ != null) initialOn = !!window.__UB_USE_GAP__;
    } catch (_e) { /* SSR-safe */ }
    var h = '<div class="props-divider"></div>';
    h += '<div class="param-row" id="ax-gap-row" style="cursor:pointer">';
    h += '<label class="param-label" style="cursor:pointer">Gap on axes &gt; 150m</label>';
    h += '<div class="param-input-wrap"><span id="ax-gap-indicator" style="font-size:11px;color:' + (initialOn ? 'var(--primary)' : 'var(--text-muted)') + ';font-weight:' + (initialOn ? '700' : '400') + '">' + (initialOn ? 'ON' : 'OFF') + '</span></div></div>';
    el.innerHTML = h;
    var row = document.getElementById('ax-gap-row');
    if (!row) return;
    row.addEventListener('click', function () {
      eventBus.emit('axis-options:gap:toggle');
    });
  }

  _renderBufferSectionConditional() {
    var el = document.getElementById('buffer-section');
    if (!el) return;
    var has = this._hasSectionOrBlock();
    var alreadyRendered = el.innerHTML.trim().length > 0;

    // Same transition-only logic as _renderAxisOptions — don't nuke
    // BufferPanel when features change (e.g. during block rebuild).
    if (has && alreadyRendered) return;
    if (!has && !alreadyRendered) return;
    if (!has) { el.innerHTML = ''; return; }
    renderBufferSection();
  }

  _hasSectionOrBlock() {
    var all = this._featureStore.toArray();
    for (var i = 0; i < all.length; i++) {
      var p = all[i].properties;
      if (p.type === 'section-axis' || p.urbanBlock) return true;
    }
    return false;
  }

  // ── Insol button helper ─────────────────────────────

  _refreshInsolButton() {
    updateInsolButton(this._featureStore, this._editAxisId, this._editSelectedIndices, this._selectedIds);
  }

  _renderUnderground() {
    var el = document.getElementById('underground-section');
    if (!el) return;

    var all = this._featureStore.toArray();
    var hasBuildings = false;
    for (var i = 0; i < all.length; i++) {
      var t = all[i].properties.type;
      if (t === 'section-axis' || t === 'tower-axis') { hasBuildings = true; break; }
    }
    var alreadyRendered = el.innerHTML.trim().length > 0;

    if (hasBuildings && alreadyRendered) return;
    if (!hasBuildings && !alreadyRendered) return;
    if (!hasBuildings) { el.innerHTML = ''; return; }

    var isVis = this._undergroundVisible;
    el.innerHTML =
      '<div style="padding:4px 12px">' +
      '<button class="ug-toggle-btn' + (isVis ? ' active' : '') + '" id="underground-toggle-btn">' +
      '<span class="ug-toggle-icon">▼</span>' +
      '<span id="underground-label">Underground volume</span>' +
      '<span id="underground-state" style="margin-left:auto;font-size:10px;color:' + (isVis ? 'var(--primary)' : 'var(--text-muted)') + ';font-weight:' + (isVis ? '700' : '400') + '">' + (isVis ? 'ON' : 'OFF') + '</span>' +
      '</button></div>';

    var btn = document.getElementById('underground-toggle-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        eventBus.emit('underground:toggle');
      });
    }
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
      self._renderAxisOptions();
      self._renderBufferSectionConditional();
      self._renderUnderground();
      resetDistributeState();
      resetBuildingPlans();
      // Stats/quota panels live-update from section-gen events while
      // processing runs. When every section disappears (block deleted,
      // full wipe) section-gen stops emitting and their innerHTML
      // would otherwise keep the last snapshot. Clear explicitly.
      if (!self._hasSectionOrBlock()) {
        updateStats(null);
        var quotaEl = document.getElementById('quota-section');
        if (quotaEl) quotaEl.innerHTML = '';
        // Insolation panel (compliance card + rays state) also keeps
        // its last render. Broadcast the clear — both the UI side
        // (InsolPanel.onInsolClear) and the insolation module
        // (deactivates LIVE, disposes ray meshes) listen for this.
        eventBus.emit('insolation:clear');
      }
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

    // Cross-panel sync: when any source emits a buffer distance change,
    // keep ALL related UI in sync — both the urban-block slider (if
    // shown) and the BufferPanel input. syncBufferInputs is called
    // unconditionally so BufferPanel stays in sync even when urban-block
    // panel is collapsed.
    eventBus.on('buffers:distance:changed', function (d) {
      if (!d || !d.key || d.value == null) return;

      // 1) Update urban-block slider if present and not focused.
      var sliderMap = { fire: 'ub-fire', end: 'ub-end', insolation: 'ub-insol' };
      var sid = sliderMap[d.key];
      if (sid) {
        var slider = document.getElementById(sid);
        var valSpan = document.getElementById(sid + '-val');
        if (slider && parseFloat(slider.value) !== d.value && !slider.matches(':focus')) {
          slider.value = d.value;
          if (valSpan) valSpan.textContent = slider.value + (slider.dataset.unit || '');
        }
      }

      // 2) Always keep BufferPanel inputs in sync (they skip themselves
      // internally via :focus check).
      var values = {};
      values[d.key] = d.value;
      syncBufferInputs(values);
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
    eventBus.on('building:plans:reset', function () { resetBuildingPlans(); });
    eventBus.on('building:plan:result', function (data) { showBuildingPlan(data.sectionKey, data.plan); });
    eventBus.on('quota:resolved', function (data) { updateQuotaResults(data); });

    eventBus.on('underground:visibility', function (d) {
      self._undergroundVisible = d.visible;
      var state = document.getElementById('underground-state');
      if (state) {
        state.textContent = d.visible ? 'ON' : 'OFF';
        state.style.color = d.visible ? 'var(--primary)' : 'var(--text-muted)';
        state.style.fontWeight = d.visible ? '700' : '400';
      }
      var btn = document.getElementById('underground-toggle-btn');
      if (btn) {
        if (d.visible) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    });
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
      var icon = ftype === 'section-axis' ? '▦' : (ftype === 'tower-axis' ? '⊞' : (ftype === 'road' ? '🛤' : '╱'));
      var label = ftype === 'section-axis' ? 'section' : (ftype === 'tower-axis' ? 'tower' : (ftype === 'road' ? 'road' : 'line'));
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
    if (this._selectedIds.length === 0 && !this._editAxisId) { propsEl.innerHTML = ''; eventBus.emit('block:ghost:update', null); return; }

    if (this._editAxisId && this._editSelectedIndices.length > 0) {
      var editF = this._featureStore.get(this._editAxisId);
      var isTower = editF && editF.properties.type === 'tower-axis';
      propsEl.innerHTML = isTower ? this._renderSelectedTowers() : this._renderSelectedSections();
      this._bindEditInputs();
      return;
    }

    if (this._editAxisId && this._editSelectedIndices.length === 0) {
      var f = this._featureStore.get(this._editAxisId);
      var numItems = f && f.properties.footprints ? f.properties.footprints.length : 0;
      var isTower = f && f.properties.type === 'tower-axis';
      var itemWord = isTower ? 'tower' : 'section';
      propsEl.innerHTML = '<div class="props-section" style="background:rgba(255,102,0,0.08);border-radius:6px;margin:4px 0">' +
        '<div class="props-header" style="color:#ff6600">Edit Mode</div>' +
        '<div style="padding:2px 12px 8px;font-size:11px;color:var(--text-secondary)">Click ' + itemWord + ' to select · Shift+click for multi-select<br>' +
        numItems + ' ' + itemWord + (numItems !== 1 ? 's' : '') + ' on this axis</div></div>';
      return;
    }

    var sectionFeatures = []; var lineFeatures = []; var towerFeatures = [];
    var blockFeature = null; var roadFeatures = [];
    for (var i = 0; i < this._selectedIds.length; i++) {
      var f = this._featureStore.get(this._selectedIds[i]);
      if (!f) continue;
      if (f.properties.type === 'section-axis') sectionFeatures.push(f);
      else if (f.properties.type === 'tower-axis') towerFeatures.push(f);
      else if (f.properties.urbanBlock) blockFeature = f;
      else if (f.properties.type === 'road') roadFeatures.push(f);
      else if (f.geometry.type === 'LineString') lineFeatures.push(f);
    }
    var html = '';
    if (blockFeature) {
      try { html += this._renderBlockProps(blockFeature); }
      catch (e) { html += '<div style="padding:12px;color:#ef4444;font-size:11px"><b>Panel error:</b> ' + e.message + '</div>'; log.error('[FeaturePanel] _renderBlockProps error:', e); }
    }
    if (sectionFeatures.length > 0) html += this._renderSectionProps(sectionFeatures);
    if (towerFeatures.length > 0) html += this._renderTowerProps(towerFeatures);
    if (roadFeatures.length > 0) html += this._renderRoadProps(roadFeatures);
    if (lineFeatures.length > 0) html += this._renderLineProps(lineFeatures);
    propsEl.innerHTML = html;
    this._bindInputs();
    this._bindBlockInputs(blockFeature);
    this._bindRoadInputs(roadFeatures);
    // Show ghost contour if block has original (pre-simplification) polygon
    if (blockFeature) {
      this._updateGhostContour(blockFeature);
    } else {
      eventBus.emit('block:ghost:update', null);
    }
  }

  _renderBlockProps(f) {
    // Minimal urban-block info panel: counts, total length, area,
    // and the useGap flag captured at creation time.
    var bid = f.properties.id;
    var all = this._featureStore.toArray();
    var axCount = 0, secCount = 0, totalLen = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i].properties.blockId !== bid) continue;
      axCount++;
      var fps = all[i].properties.footprints;
      if (fps) {
        secCount += fps.length;
        for (var j = 0; j < fps.length; j++) totalLen += fps[j].length || 0;
      }
    }
    var areaM2 = this._computeBlockAreaM2(f);
    var areaHa = areaM2 / 10000;
    var useGap = f.properties.useGap === true;
    var rollN = f.properties.solverParams && f.properties.solverParams.ctxRoll
      ? f.properties.solverParams.ctxRoll
      : 0;
    var h = '<div class="props-section"><div class="props-header">Urban block</div>';
    h += '<div class="props-computed" style="padding:0 12px">';
    h += '<div class="props-row"><span class="props-label">Area</span><span class="props-value">' + areaM2.toFixed(0) + ' m² <small>(' + areaHa.toFixed(2) + ' ha)</small></span></div>';
    h += '<div class="props-row"><span class="props-label">Axes</span><span class="props-value">' + axCount + '</span></div>';
    h += '<div class="props-row"><span class="props-label">Sections</span><span class="props-value">' + secCount + '</span></div>';
    h += '<div class="props-row"><span class="props-label">Total length</span><span class="props-value">' + totalLen.toFixed(1) + ' m</span></div>';
    h += '<div class="props-row"><span class="props-label">Gap &gt; 150m</span><span class="props-value">' + (useGap ? 'Yes' : 'No') + '</span></div>';
    h += '</div>';
    h += '<div style="padding:8px 12px;display:flex;gap:6px">';
    h += '<button class="ug-toggle-btn" data-block-shuffle="' + bid + '" ';
    h += 'style="flex:1">';
    h += 'Shuffle ctx' + (rollN > 0 ? ' <small style="color:var(--text-muted)">#' + rollN + '</small>' : '') + '</button>';
    h += '</div>';
    h += '<div style="padding:0 12px 8px">';
    h += '<button class="ug-toggle-btn" data-block-delete="' + bid + '" ';
    h += 'style="width:100%;color:#ef4444;border-color:rgba(239,68,68,0.3);background:rgba(239,68,68,0.05)">';
    h += 'Delete block</button>';
    h += '</div>';
    h += '</div>';
    return h;
  }

  _computeBlockAreaM2(f) {
    // Compute block polygon area via spherical-approximation to meters.
    // Uses local azimuthal-equidistant projection at the polygon centroid,
    // which is accurate to <0.01% at urban-block scales (<2 km).
    var coords = f.geometry && f.geometry.coordinates && f.geometry.coordinates[0];
    if (!coords || coords.length < 3) return 0;
    var cx = 0, cy = 0, n = 0;
    for (var i = 0; i < coords.length; i++) {
      if (i === coords.length - 1 && coords[i][0] === coords[0][0] && coords[i][1] === coords[0][1]) break;
      cx += coords[i][0]; cy += coords[i][1]; n++;
    }
    if (n === 0) return 0;
    cx /= n; cy /= n;
    var R = 6371000;
    var lat0 = cy * Math.PI / 180;
    var pts = [];
    for (var k = 0; k < coords.length; k++) {
      var lon = coords[k][0], lat = coords[k][1];
      var x = R * (lon - cx) * Math.PI / 180 * Math.cos(lat0);
      var y = R * (lat - cy) * Math.PI / 180;
      pts.push([x, y]);
    }
    // Shoelace
    var a = 0;
    for (var p = 0; p < pts.length; p++) {
      var q = (p + 1) % pts.length;
      a += pts[p][0] * pts[q][1] - pts[q][0] * pts[p][1];
    }
    return Math.abs(a) / 2;
  }

  _bindBlockInputs(blockFeature) {
    if (!blockFeature) return;
    var delBtn = document.querySelector('[data-block-delete]');
    if (delBtn) {
      var dBid = delBtn.getAttribute('data-block-delete');
      delBtn.addEventListener('click', function () {
        eventBus.emit('feature:delete-request', { id: dBid });
      });
    }
    var shufBtn = document.querySelector('[data-block-shuffle]');
    if (shufBtn) {
      var sBid = shufBtn.getAttribute('data-block-shuffle');
      shufBtn.addEventListener('click', function () {
        eventBus.emit('block:shuffle-ctx', { id: sBid });
      });
    }
  }

  _updateGhostContour(_blockFeature) {
    // Ghost contour feature was part of the simplification/rebuild
    // pipeline that got removed. Keep a stub so existing callers
    // don't throw.
    eventBus.emit('block:ghost:update', null);
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
    var fireAuto = 14;
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
    html += '<div class="props-row"><span class="props-label">Height</span><span class="props-value">' + bh.toFixed(1) + ' m</span></div>';
    html += '<div class="props-row"><span class="props-label">Fire buffer</span><span class="props-value">' + fireAuto + ' m <small>(auto)</small></span></div>';
    html += '</div>';

    html += '<div class="props-divider"></div>';
    html += '<div class="param-row"><label class="param-label" style="font-weight:600">Section height</label>';
    html += '<div class="param-input-wrap"><input type="number" class="param-input" id="sec-edit-height"';
    html += ' value="' + displayH + '" step="1" min="5" max="75"';
    if (!allSameH) html += ' placeholder="mixed"';
    html += '><span class="param-unit">m</span></div></div>';

    if (!allSameH) {
      html += '<div style="padding:2px 12px 4px;font-size:10px;color:#d97706">Selected sections have different heights. New value applies to all selected.</div>';
    }
    if (hasIndep) {
      html += '<div style="padding:2px 12px 8px;font-size:10px;color:#dc2626">Modified height — independent from axis default (' + params.sectionHeight + 'm)</div>';
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
    var editF = this._featureStore.get(this._editAxisId);
    var isTower = editF && editF.properties.type === 'tower-axis';
    var heightKey = isTower ? 'towerHeight' : 'sectionHeight';
    input.addEventListener('change', function (e) {
      var val = parseFloat(e.target.value);
      if (isNaN(val)) return;
      eventBus.emit('section:param:changed', {
        axisId: self._editAxisId,
        sectionIndices: self._editSelectedIndices.slice(),
        key: heightKey,
        value: val
      });
      setTimeout(function () { self._updateProps(); }, 100);
    });
    input.focus();
    input.select();
  }

  _renderSelectedTowers() {
    var f = this._featureStore.get(this._editAxisId);
    if (!f || !f.properties.footprints) return '';
    var fps = f.properties.footprints;
    var axisH = f.properties.towerHeight || 112;
    var indices = this._editSelectedIndices;
    var isSingle = indices.length === 1;

    var heights = [];
    var hasIndep = false;
    for (var i = 0; i < indices.length; i++) {
      var fp = fps[indices[i]];
      if (!fp) continue;
      var h = fp.towerHeight !== undefined ? fp.towerHeight : axisH;
      heights.push(h);
      if (fp.towerHeight !== undefined) hasIndep = true;
    }

    var allSameH = true;
    for (var i = 1; i < heights.length; i++) {
      if (heights[i] !== heights[0]) { allSameH = false; break; }
    }

    var displayH = heights[0] || axisH;
    var fc = computeFloorCount(displayH, 4.5, 3.0);
    var bh = computeBuildingHeight(displayH, 4.5, 3.0);

    var title;
    if (isSingle) {
      title = 'Tower #' + (indices[0] + 1);
    } else {
      var nums = [];
      for (var i = 0; i < indices.length; i++) nums.push('#' + (indices[i] + 1));
      title = 'Towers ' + nums.join(', ');
    }

    var html = '<div class="props-section" style="background:rgba(255,102,0,0.08);border-radius:6px;margin:4px 0">';
    html += '<div class="props-header" style="color:#ff6600">' + title;
    if (hasIndep) html += ' <span style="color:#dc2626;font-size:10px;font-weight:700;margin-left:4px">INDEPENDENT</span>';
    html += '</div>';

    html += '<div class="props-computed">';
    html += '<div class="props-row"><span class="props-label">Floors</span><span class="props-value">' + fc + 'F</span></div>';
    html += '<div class="props-row"><span class="props-label">Height</span><span class="props-value">' + bh.toFixed(1) + ' <small>m</small></span></div>';
    html += '</div>';

    html += '<div class="props-divider"></div>';
    html += '<div class="param-row"><label class="param-label" style="font-weight:600">Tower height</label>';
    html += '<div class="param-input-wrap"><input type="number" class="param-input" id="sec-edit-height"';
    html += ' value="' + displayH + '" step="3" min="15" max="150"';
    if (!allSameH) html += ' placeholder="mixed"';
    html += '><span class="param-unit">m</span></div></div>';

    if (!allSameH) {
      html += '<div style="padding:2px 12px 4px;font-size:10px;color:#d97706">Selected towers have different heights. New value applies to all selected.</div>';
    }
    if (hasIndep) {
      html += '<div style="padding:2px 12px 8px;font-size:10px;color:#dc2626">Modified height — independent from axis default (' + axisH + 'm)</div>';
    } else {
      html += '<div style="padding:2px 12px 8px;font-size:10px;color:var(--text-muted)">Change height to separate from axis group</div>';
    }

    html += '</div>';
    return html;
  }

  _renderSectionProps(features) {
    var params = getParams(features[0].properties);
    var totalLen = 0;
    for (var i = 0; i < features.length; i++) totalLen += features[i].properties.axisLength || 0;
    var footArea = totalLen * params.sectionWidth;
    var aptArea = footArea * 0.65;
    var fireAuto = 14;
    var label = features.length === 1 ? 'Section ' + features[0].properties.id.slice(0, 6) : features.length + ' sections';

    var h = '<div class="props-section"><div class="props-header">' + label + '</div>';
    h += '<div style="padding:0 12px 4px;font-size:10px;color:var(--text-muted)">Double-click on map to edit individual sections</div>';
    h += '<div class="props-computed">';
    h += '<div class="props-row"><span class="props-label">Axis length</span><span class="props-value">' + totalLen.toFixed(1) + ' m</span></div>';
    h += '<div class="props-row"><span class="props-label">Footprint</span><span class="props-value">' + footArea.toFixed(0) + ' m²</span></div>';
    h += '<div class="props-row"><span class="props-label">Apartment area</span><span class="props-value">' + aptArea.toFixed(0) + ' m² <small>(×0.65)</small></span></div>';
    h += '<div class="props-row"><span class="props-label">Fire buffer</span><span class="props-value">' + fireAuto + ' m <small>(auto)</small></span></div>';
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

  _renderTowerProps(features) {
    var f = features[0];
    var p = f.properties;
    var cellSize = p.cellSize || 3.3;
    var gap = p.towerGap != null ? p.towerGap : 20;
    var towerH = p.towerHeight || 112;
    var ori = p.orientation || '?';
    var fpCount = p.footprints ? p.footprints.length : 0;
    var axisLen = p.axisLength ? p.axisLength.toFixed(1) : '?';

    var floorCount = computeFloorCount(towerH, 4.5, 3.0);
    var buildingH = computeBuildingHeight(towerH, 4.5, 3.0);

    // Aggregate stats
    var totalFootprint = 0;
    var sizes = [];
    for (var i = 0; i < fpCount; i++) {
      var tfp = p.footprints[i];
      var s = tfp.size || 'small';
      if (sizes.indexOf(s) < 0) sizes.push(s);
      totalFootprint += tfp.length * cellSize * 7;
    }
    var AREA_COEFF = 0.65;
    var M2_PER_PERSON = 50;
    var residentialFloors = Math.max(0, floorCount - 1);
    var aptFloorArea = totalFootprint * AREA_COEFF;
    var totalAptArea = aptFloorArea * residentialFloors;
    var totalGBA = totalFootprint * floorCount;
    var population = Math.round(totalAptArea / M2_PER_PERSON);

    var label = features.length === 1 ? 'Tower ' + f.properties.id.slice(0, 6) : features.length + ' towers';

    var h = '<div class="props-section"><div class="props-header">' + label + '</div>';

    h += '<div class="props-computed">';
    h += '<div class="props-row"><span class="props-label">Orientation</span><span class="props-value">' + (ori === 'lon' ? 'merid' : 'lat') + (sizes.length > 0 ? ' <small>' + sizes.join(', ') + '</small>' : '') + '</span></div>';
    h += '<div class="props-row"><span class="props-label">Axis</span><span class="props-value">' + axisLen + ' <small>m</small></span></div>';
    h += '<div class="props-row"><span class="props-label">Towers</span><span class="props-value">' + fpCount + '</span></div>';
    h += '<div class="props-row"><span class="props-label">Floors</span><span class="props-value">' + floorCount + 'F</span></div>';
    h += '<div class="props-row"><span class="props-label">Footprint</span><span class="props-value">' + totalFootprint.toFixed(0) + ' <small>m²</small></span></div>';
    h += '<div class="props-row"><span class="props-label">Apt. area</span><span class="props-value">' + (totalAptArea / 1000).toFixed(1) + 'k <small>m² ×' + AREA_COEFF + '</small></span></div>';
    h += '<div class="props-row"><span class="props-label">GBA</span><span class="props-value">' + (totalGBA / 1000).toFixed(1) + 'k <small>m²</small></span></div>';
    h += '<div class="props-row"><span class="props-label">Population</span><span class="props-value">' + population + ' <small>ppl · /' + M2_PER_PERSON + ' m²</small></span></div>';
    h += '</div>';

    h += '<div class="props-divider"></div>';
    h += '<div class="params-toggle" id="params-toggle">';
    h += '<span class="params-toggle-label">Parameters</span>';
    h += '<span class="params-toggle-chevron' + (this._paramsOpen ? ' open' : '') + '" id="params-chevron">▸</span>';
    h += '</div>';
    h += '<div class="params-body' + (this._paramsOpen ? ' open' : '') + '" id="params-body">';

    h += '<div class="param-row"><label class="param-label">Tower height</label>';
    h += '<div class="param-input-wrap"><input type="number" class="param-input" data-key="towerHeight" data-target="tower"';
    h += ' value="' + towerH + '" step="3" min="15" max="150">';
    h += '<span class="param-unit">m</span></div></div>';

    h += '<div class="param-row"><label class="param-label">Cell size</label>';
    h += '<div class="param-input-wrap"><select class="param-select" data-key="cellSize" data-target="tower">';
    h += '<option value="3.0"' + (cellSize === 3.0 ? ' selected' : '') + '>3.0 m</option>';
    h += '<option value="3.3"' + (cellSize === 3.3 ? ' selected' : '') + '>3.3 m</option>';
    h += '</select></div></div>';

    h += '<div class="param-row"><label class="param-label">Gap</label>';
    h += '<div class="param-input-wrap"><input type="number" class="param-input" data-key="towerGap" data-target="tower"';
    h += ' value="' + gap + '" min="5" max="50" step="1">';
    h += '<span class="param-unit">m</span></div></div>';

    h += '</div></div>';
    return h;
  }

  _renderRoadProps(features) {
    var RTYPES = [
      { id: 0, label: '2 lanes (6m)', lanes: 2, width: 6 },
      { id: 1, label: '4 lanes (14m)', lanes: 4, width: 14 },
      { id: 2, label: '6 lanes (21m)', lanes: 6, width: 21 }
    ];
    var f = features[0];
    var rt = f.properties.roadType || 0;
    var totalLen = 0;
    for (var i = 0; i < features.length; i++) {
      var coords = features[i].geometry.coordinates;
      for (var j = 0; j < coords.length - 1; j++) {
        var dlng = (coords[j+1][0]-coords[j][0])*111320*Math.cos(coords[j][1]*Math.PI/180);
        var dlat = (coords[j+1][1]-coords[j][1])*110540;
        totalLen += Math.sqrt(dlng*dlng+dlat*dlat);
      }
    }
    var label = features.length === 1 ? 'Road ' + f.properties.id.slice(0, 6) : features.length + ' roads';
    var h = '<div class="props-section"><div class="props-header">' + label + '</div>';
    h += '<div class="props-computed"><div class="props-row"><span class="props-label">Length</span><span class="props-value">' + totalLen.toFixed(1) + ' m</span></div></div>';
    h += '<div style="padding:4px 12px"><label class="param-label" style="display:block;margin-bottom:4px">Road type</label>';
    h += '<div style="display:flex;gap:4px">';
    for (var ri = 0; ri < RTYPES.length; ri++) {
      var sel = ri === rt;
      h += '<button class="ug-toggle-btn road-type-btn' + (sel ? ' active' : '') + '" data-road-type="' + ri + '" style="flex:1;font-size:10px;' +
        (sel ? 'border-color:rgba(99,102,241,0.6);background:rgba(99,102,241,0.15);color:#6366f1;font-weight:700' : '') + '">' +
        RTYPES[ri].lanes + 'L · ' + RTYPES[ri].width + 'm</button>';
    }
    h += '</div></div>';
    h += '</div>';
    return h;
  }

  _bindRoadInputs(roadFeatures) {
    if (!roadFeatures || roadFeatures.length === 0) return;
    var WIDTHS = [6, 14, 21];
    var LANES = [2, 4, 6];
    var self = this;
    var btns = document.querySelectorAll('.road-type-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        var rt = parseInt(e.target.dataset.roadType);
        for (var fi = 0; fi < roadFeatures.length; fi++) {
          roadFeatures[fi].properties.roadType = rt;
          roadFeatures[fi].properties.roadWidth = WIDTHS[rt];
          roadFeatures[fi].properties.lanes = LANES[rt];
        }
        eventBus.emit('features:changed');
        self._updateProps();
      });
    }
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
      '<div class="props-computed"><div class="props-row"><span class="props-label">Length</span><span class="props-value">' + totalLen.toFixed(1) + ' m</span></div></div>' +
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

    // Tower inputs (select + number)
    var towerInputs = this._container.querySelectorAll('[data-target="tower"]');
    for (var i = 0; i < towerInputs.length; i++) {
      towerInputs[i].addEventListener('change', function (e) {
        var key = e.target.dataset.key;
        var val = parseFloat(e.target.value);
        if (isNaN(val)) return;
        for (var si = 0; si < self._selectedIds.length; si++) {
          var f = self._featureStore.get(self._selectedIds[si]);
          if (!f || f.properties.type !== 'tower-axis') continue;
          var oldVal = f.properties[key];
          var newP = {}; newP[key] = val;
          var oldP = {}; oldP[key] = oldVal;
          commandManager.execute(new UpdateFeatureCommand(
            self._featureStore, self._selectedIds[si], newP, oldP
          ));
        }
        eventBus.emit('features:changed');
      });
    }
  }
}
