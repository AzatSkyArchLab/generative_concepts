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
import { solveUrbanBlockFull } from '../core/urban-block/UrbanBlockSolver.js';
import { computeOverlays, computeExtConnections } from '../core/urban-block/UrbanBlockOverlays.js';
import { createProjection } from '../core/geo/projection.js';
import { simplifyPolygon } from '../core/geo/PolygonSimplifier.js';
import { computeTowerFootprints } from '../core/tower/TowerFootprints.js';
import { detectNorthEnd } from '../core/tower/TowerPlacer.js';
import { isInsolLiveActive } from '../modules/insolation/index.js';
import { commandManager } from '../core/commands/CommandManager.js';
import { UpdateFeatureCommand } from '../core/commands/UpdateFeatureCommand.js';
import { getParams, computeFloorCount, computeBuildingHeight, autoFireDist } from '../core/SectionParams.js';

import { renderBufferSection, onBuffersVisibility } from './panels/BufferPanel.js';
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
    this._undergroundVisible = true;
  }

  init() { this._render(); this._setupEvents(); }

  // ── Layout ──────────────────────────────────────────

  _render() {
    this._container.innerHTML =
      '<div class="panel-header"><span class="panel-title">Features</span>' +
      '<span class="panel-badge" id="feature-count">0</span></div>' +
      '<div class="panel-body"><div id="feature-list"></div><div id="section-props"></div>' +
      '<div id="buffer-section"></div><div id="insol-section"></div>' +
      '<div id="underground-section"></div>' +
      '<div id="apt-mix-section"></div>' +
      '<div id="quota-section"></div>' +
      '<div id="stats-section"></div></div>';
    renderBufferSection();
    renderInsolSection();
    this._renderUnderground();
    renderAptMixSection();
    renderQuotaSection();
    injectQuotaStyles();
  }

  // ── Insol button helper ─────────────────────────────

  _refreshInsolButton() {
    updateInsolButton(this._featureStore, this._editAxisId, this._editSelectedIndices, this._selectedIds);
  }

  _renderUnderground() {
    var el = document.getElementById('underground-section');
    if (!el) return;

    // Only show when there are section or tower axes
    var all = this._featureStore.toArray();
    var hasBuildings = false;
    for (var i = 0; i < all.length; i++) {
      var t = all[i].properties.type;
      if (t === 'section-axis' || t === 'tower-axis') { hasBuildings = true; break; }
    }
    if (!hasBuildings) { el.innerHTML = ''; return; }

    var isVis = this._undergroundVisible;
    el.innerHTML =
      '<div style="padding:4px 12px">' +
      '<button class="ug-toggle-btn' + (isVis ? ' active' : '') + '" id="underground-toggle-btn">' +
      '<span class="ug-toggle-icon">▼</span>' +
      '<span id="underground-label">' + (isVis ? 'Hide underground' : 'Show underground') + '</span>' +
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
      self._renderUnderground();
      resetDistributeState();
      resetBuildingPlans();
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
    eventBus.on('building:plans:reset', function () { resetBuildingPlans(); });
    eventBus.on('building:plan:result', function (data) { showBuildingPlan(data.sectionKey, data.plan); });
    eventBus.on('quota:resolved', function (data) { updateQuotaResults(data); });

    eventBus.on('underground:visibility', function (d) {
      self._undergroundVisible = d.visible;
      var lbl = document.getElementById('underground-label');
      if (lbl) lbl.textContent = d.visible ? 'Hide underground' : 'Show underground';
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
    var bid = f.properties.id;
    var p = f.properties.blockParams || {};
    var all = this._featureStore.toArray();
    var axCount = 0; var secCount = 0; var totalLen = 0;
    var latSecs = 0; var lonSecs = 0; var trimCount = 0;
    var actualSPP = 0; var totalOrphans = 0;
    var AREA_COEFF = 0.65;
    for (var i = 0; i < all.length; i++) {
      if (all[i].properties.blockId !== bid) continue;
      axCount++;
      var fps = all[i].properties.footprints;
      if (fps) { secCount += fps.length; for (var j = 0; j < fps.length; j++) totalLen += fps[j].length; }
      if (all[i].properties.orientation === 'lat') latSecs += (fps ? fps.length : 0);
      else lonSecs += (fps ? fps.length : 0);
      if (all[i].properties.trimmed) trimCount++;
      // Compute actual SPP contribution
      var axH = all[i].properties.sectionHeight || all[i].properties.towerHeight || 28;
      var axFpArea = (all[i].properties.axisLength || 0) * (p.sw || 18);
      var axFloors = Math.max(1, 1 + Math.floor((axH - 4.5) / 3.0));
      var axResid = Math.max(0, axFloors - 1);
      actualSPP += axFpArea * AREA_COEFF * axResid;
    }
    var targetSPP = p.spp || 80000;
    var deltaSPP = actualSPP - targetSPP;
    var ctxRoll = p.ctxRoll || 0;

    var h = '<div class="props-section"><div class="props-header">Urban Block</div>';
    h += '<div class="props-computed">';
    h += '<div class="props-row"><span class="props-label">Axes</span><span class="props-value">' + axCount + ' <small>trimmed ' + trimCount + '</small></span></div>';
    h += '<div class="props-row"><span class="props-label">Sections</span><span class="props-value">' + secCount + ' <small>[L]' + latSecs + ' [M]' + lonSecs + '</small></span></div>';
    h += '<div class="props-row"><span class="props-label">Length</span><span class="props-value">' + totalLen.toFixed(0) + ' m</span></div>';
    h += '<div class="props-row"><span class="props-label">GBA actual</span><span class="props-value" style="font-weight:700">' + Math.round(actualSPP).toLocaleString() + ' <small>m²</small></span></div>';
    h += '<div class="props-row"><span class="props-label">GBA target</span><span class="props-value">' + Math.round(targetSPP).toLocaleString() + ' <small style="color:' + (Math.abs(deltaSPP) < targetSPP * 0.05 ? '#22c55e' : '#ef4444') + '">' + (deltaSPP >= 0 ? '+' : '') + Math.round(deltaSPP).toLocaleString() + '</small></span></div>';
    h += '</div>';

    // Typology
    h += '<div class="props-divider"></div>';
    h += '<div style="padding:4px 12px;display:flex;gap:4px">';
    var typo = p.typo || 0;
    h += '<button id="ub-typo-0" class="ug-toggle-btn' + (typo === 0 ? ' active' : '') + '" style="flex:1;font-size:10px">Sections</button>';
    h += '<button id="ub-typo-1" class="ug-toggle-btn' + (typo === 1 ? ' active' : '') + '" style="flex:1;font-size:10px">Tower+S</button>';
    h += '</div>';

    // Parameters
    h += '<div class="props-divider"></div>';
    h += '<div class="props-header-small">Parameters</div>';
    h += '<div style="padding:0 12px">';
    var sliders = [
      ['ub-sw', 'Section width', p.sw != null ? p.sw : 18, 10, 25, 1, 'm'],
      ['ub-fire', 'Fire buffer', p.fire != null ? p.fire : 14, 6, 30, 1, 'm'],
      ['ub-end', 'End buffer', p.endB != null ? p.endB : 20, 10, 40, 1, 'm'],
      ['ub-insol', 'Insolation', p.insol != null ? p.insol : 25, 10, 80, 1, 'm'],
      ['ub-gap', 'Gap', p.gapTarget != null ? p.gapTarget : 22, 15, 40, 1, 'm']
    ];
    for (var si = 0; si < sliders.length; si++) {
      var s = sliders[si];
      h += '<div class="param-row"><label class="param-label">' + s[1] + '</label>' +
        '<div style="display:flex;align-items:center;gap:4px;flex:1">' +
        '<input type="range" id="' + s[0] + '" min="' + s[3] + '" max="' + s[4] + '" step="' + s[5] + '" value="' + s[2] + '" data-unit="' + s[6] + '" style="flex:1;height:3px;accent-color:var(--primary)">' +
        '<span id="' + s[0] + '-val" style="min-width:32px;text-align:right;font-weight:600;font-size:10px;color:var(--primary)">' + s[2] + s[6] + '</span>' +
        '</div></div>';
    }
    h += '<div class="param-row"><label class="param-label">Latitudinal [L]</label>' +
      '<input id="ub-lat-lens" class="param-input" value="' + (p.latLens || [24, 27]).join(',') + '" style="width:80px"></div>';
    h += '<div class="param-row"><label class="param-label">Meridional [M]</label>' +
      '<input id="ub-lon-lens" class="param-input" value="' + (p.lonLens || [30, 36, 39, 42, 46, 49]).join(',') + '" style="width:80px"></div>';
    h += '</div>';

    // SPP
    h += '<div class="props-divider"></div>';
    h += '<div class="props-header-small">Heights (GBA)</div>';
    h += '<div style="padding:0 12px">';
    h += '<div class="param-row"><label class="param-label">Target SPP</label>' +
      '<div style="display:flex;align-items:center;gap:4px;flex:1">' +
      '<input type="range" id="ub-spp" min="20000" max="200000" step="5000" value="' + (p.spp || 80000) + '" data-unit="m²" style="flex:1;height:3px;accent-color:#f59e0b">' +
      '<span id="ub-spp-val" style="min-width:48px;text-align:right;font-weight:600;font-size:10px;color:#f59e0b">' + (p.spp || 80000) + 'm²</span>' +
      '</div></div>';
    var insolLive = false;
    try { insolLive = isInsolLiveActive(); } catch (e) { /* module not ready */ }
    h += '<button id="block-spp-btn" class="ug-toggle-btn' + (insolLive ? ' active' : '') + '" style="width:100%;border-color:rgba(245,158,11,' + (insolLive ? '0.4' : '0.15') + ');color:' + (insolLive ? '#f59e0b' : '#94a3b8') + ';font-size:10px;margin:4px 0;' + (insolLive ? '' : 'cursor:not-allowed;opacity:0.5') + '">▲ Apply heights' + (insolLive ? '' : ' (needs Live insol)') + '</button>';
    h += '</div>';

    // Overlay visibility toggles
    h += '<div class="props-divider"></div>';
    h += '<div class="props-header-small">Plan layers</div>';
    h += '<div style="padding:0 12px 4px">';
    var vis = (f.properties.overlayVisibility) || {};
    var layers = [
      ['ov-buffers', 'Buffers (fire/end/insol)', vis.buffers !== false],
      ['ov-secfire', 'Courtyard (green zone)', vis.secfire !== false],
      ['ov-road', 'Road ring', vis.road !== false],
      ['ov-connectors', 'Connectors', vis.connectors !== false],
      ['ov-graph', 'Road network graph', vis.graph !== false],
      ['ov-trash', 'Waste pad + zone', vis.trash !== false],
      ['ov-play', 'Playgrounds', vis.play !== false]
    ];
    for (var li = 0; li < layers.length; li++) {
      var lyr = layers[li];
      h += '<div id="' + lyr[0] + '" data-on="' + (lyr[2] ? '1' : '0') + '" style="display:flex;align-items:center;gap:6px;margin-bottom:3px;cursor:pointer;user-select:none">' +
        '<div style="width:26px;height:14px;border-radius:7px;background:' + (lyr[2] ? 'var(--primary)' : 'rgba(148,163,184,0.35)') + ';position:relative;transition:0.15s">' +
        '<div style="width:10px;height:10px;border-radius:5px;background:#fff;position:absolute;top:2px;left:' + (lyr[2] ? '14px' : '2px') + ';transition:0.15s"></div></div>' +
        '<span style="font-size:10px">' + lyr[1] + '</span></div>';
    }
    h += '</div>';

    // Actions
    h += '<div class="props-divider"></div>';
    h += '<div style="padding:4px 12px;display:flex;gap:4px">';
    h += '<button id="block-ctx-btn" class="ug-toggle-btn" style="flex:1;font-size:10px">Shuffle #' + ctxRoll + '</button>';
    h += '<button id="block-rebuild-btn" class="ug-toggle-btn" style="flex:1;font-size:10px;border-color:rgba(59,130,246,0.4);color:var(--primary)">↻ Rebuild</button>';
    h += '</div>';
    var vertCount = 0;
    if (f.geometry && f.geometry.coordinates && f.geometry.coordinates[0]) {
      vertCount = f.geometry.coordinates[0].length;
      if (vertCount > 0) {
        var first = f.geometry.coordinates[0][0];
        var last = f.geometry.coordinates[0][vertCount - 1];
        if (Math.abs(first[0] - last[0]) < 1e-8 && Math.abs(first[1] - last[1]) < 1e-8) vertCount--;
      }
    }
    var hasOriginal = !!(f.properties._originalContour);
    var origVertCount = 0;
    if (hasOriginal) {
      origVertCount = f.properties._originalContour.length;
      if (origVertCount > 1) {
        var of = f.properties._originalContour[0], ol = f.properties._originalContour[origVertCount - 1];
        if (Math.abs(of[0] - ol[0]) < 1e-8 && Math.abs(of[1] - ol[1]) < 1e-8) origVertCount--;
      }
    }
    h += '<div style="padding:2px 12px;display:flex;gap:4px">';
    if (hasOriginal) {
      h += '<button id="block-simplify-btn" class="ug-toggle-btn" style="flex:1;font-size:10px;border-color:rgba(16,185,129,0.4);color:#10b981;background:rgba(16,185,129,0.1)">✓ ' + vertCount + 'v <small>was ' + origVertCount + '</small></button>';
      h += '<button id="block-restore-btn" class="ug-toggle-btn" style="flex:1;font-size:10px;border-color:rgba(245,158,11,0.4);color:#f59e0b">↩ Restore (' + origVertCount + 'v)</button>';
    } else {
      h += '<button id="block-simplify-btn" class="ug-toggle-btn" style="flex:1;font-size:10px;border-color:rgba(16,185,129,0.4);color:#10b981">⊟ Simplify (' + vertCount + 'v)</button>';
    }
    h += '<button id="block-delete-btn" class="ug-toggle-btn" style="flex:1;font-size:10px;border-color:rgba(239,68,68,0.3);color:#ef4444">✕ Delete</button>';
    h += '</div>';

    // Connect to roads
    var roadCount = 0;
    var all2 = this._featureStore.toArray();
    for (var ri = 0; ri < all2.length; ri++) { if (all2[ri].properties.type === 'road') roadCount++; }
    if (roadCount > 0) {
      var extConns = f.properties._extConns;
      var connCount = extConns ? extConns.length : 0;
      var activeCount = 0;
      if (extConns) { for (var eci = 0; eci < extConns.length; eci++) { if (extConns[eci].active) activeCount++; } }
      var ne = p.numEntries || 2;
      h += '<div class="props-divider"></div>';
      h += '<div class="props-header-small">External roads</div>';
      h += '<div style="padding:0 12px 4px">';
      h += '<div class="param-row"><label class="param-label">Entries</label>' +
        '<div style="display:flex;align-items:center;gap:4px;flex:1">' +
        '<input type="range" id="ub-entries" min="1" max="8" step="1" value="' + ne + '" style="flex:1;height:3px;accent-color:#6366f1">' +
        '<span id="ub-entries-val" style="min-width:20px;text-align:right;font-weight:600;font-size:10px;color:#6366f1">' + ne + '</span>' +
        '</div></div>';
      h += '<button id="block-connect-roads-btn" class="ug-toggle-btn" style="width:100%;font-size:10px;border-color:rgba(99,102,241,0.4);color:#6366f1;margin:4px 0">';
      if (connCount > 0) {
        h += '⟷ ' + activeCount + '/' + connCount + ' connections · ' + roadCount + ' road' + (roadCount > 1 ? 's' : '');
      } else {
        h += '⟷ Connect to ' + roadCount + ' road' + (roadCount > 1 ? 's' : '');
      }
      h += '</button>';
      h += '</div>';
    }

    h += '</div>';
    return h;
  }

  _bindBlockInputs(blockFeature) {
    if (!blockFeature) return;
    var bid = blockFeature.properties.id;
    var self = this;

    // Live slider updates
    var sliderIds = ['ub-sw', 'ub-fire', 'ub-end', 'ub-insol', 'ub-gap', 'ub-spp'];
    for (var si = 0; si < sliderIds.length; si++) {
      (function (sid) {
        var slider = document.getElementById(sid);
        var valSpan = document.getElementById(sid + '-val');
        if (slider && valSpan) {
          slider.addEventListener('input', function () {
            valSpan.textContent = slider.value + (slider.dataset.unit || '');
          });
        }
      })(sliderIds[si]);
    }

    // Typology buttons
    var typo0 = document.getElementById('ub-typo-0');
    var typo1 = document.getElementById('ub-typo-1');
    if (typo0) typo0.addEventListener('click', function () {
      blockFeature.properties.blockParams.typo = 0;
      self._rebuildBlock(blockFeature);
    });
    if (typo1) typo1.addEventListener('click', function () {
      blockFeature.properties.blockParams.typo = 1;
      self._rebuildBlock(blockFeature);
    });

    // Context rolling
    var ctxBtn = document.getElementById('block-ctx-btn');
    if (ctxBtn) {
      ctxBtn.addEventListener('click', function () {
        var p = blockFeature.properties.blockParams;
        p.ctxRoll = (p.ctxRoll || 0) + 1;
        self._rebuildBlock(blockFeature);
      });
    }

    // Delete
    var delBtn = document.getElementById('block-delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', function () {
        var all = self._featureStore.toArray();
        for (var i = 0; i < all.length; i++) {
          if (all[i].properties.id === bid || all[i].properties.blockId === bid) {
            self._featureStore._features.delete(all[i].properties.id);
          }
        }
        self._selectedIds = [];
        self._editAxisId = null;
        self._editSelectedIndices = [];
        eventBus.emit('feature:deselected');
        eventBus.emit('features:changed');
      });
    }

    // Simplify contour
    var simpBtn = document.getElementById('block-simplify-btn');
    if (simpBtn) {
      simpBtn.addEventListener('click', function () {
        // If already simplified, re-simplify from current (not original)
        var coords = blockFeature.geometry.coordinates[0];
        if (!coords || coords.length < 4) return;
        var ring = [];
        for (var i = 0; i < coords.length; i++) ring.push(coords[i]);
        // Remove closing duplicate
        if (ring.length > 1) {
          var f = ring[0], l = ring[ring.length - 1];
          if (Math.abs(f[0] - l[0]) < 1e-8 && Math.abs(f[1] - l[1]) < 1e-8) ring.pop();
        }
        if (ring.length < 4) return;
        var proj = createProjection(ring[0][0], ring[0][1]);
        var metersRing = [];
        for (var i = 0; i < ring.length; i++) {
          metersRing.push(proj.toMeters(ring[i][0], ring[i][1]));
        }
        var sr = simplifyPolygon(metersRing, { areaTol: 0.02, collinearTol: 0.01 });
        if (sr.newCount >= sr.origCount) {
          log.info('[Simplify] no vertices to remove (' + sr.origCount + 'v)');
          return;
        }
        log.info('[Simplify]', sr.origCount, '→', sr.newCount, 'verts, ΔS=' + (sr.areaError * 100).toFixed(2) + '%');
        // Save original contour (only first time)
        if (!blockFeature.properties._originalContour) {
          blockFeature.properties._originalContour = coords.slice();
        }
        var newCoords = [];
        for (var i = 0; i < sr.simplified.length; i++) {
          newCoords.push(proj.toLngLat(sr.simplified[i][0], sr.simplified[i][1]));
        }
        newCoords.push(newCoords[0]); // close ring
        blockFeature.geometry.coordinates = [newCoords];
        self._updateGhostContour(blockFeature);
        self._rebuildBlock(blockFeature);
      });
    }

    // Restore original contour
    var restoreBtn = document.getElementById('block-restore-btn');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', function () {
        var orig = blockFeature.properties._originalContour;
        if (!orig) return;
        blockFeature.geometry.coordinates = [orig.slice()];
        delete blockFeature.properties._originalContour;
        self._updateGhostContour(blockFeature);
        self._rebuildBlock(blockFeature);
      });
    }

    // Rebuild
    var rebuildBtn = document.getElementById('block-rebuild-btn');
    if (rebuildBtn) {
      rebuildBtn.addEventListener('click', function () {
        self._rebuildBlock(blockFeature);
      });
    }

    // Connect to roads — entries slider
    var entriesSlider = document.getElementById('ub-entries');
    if (entriesSlider) {
      entriesSlider.addEventListener('input', function () {
        var val = parseInt(entriesSlider.value);
        document.getElementById('ub-entries-val').textContent = val;
        if (!blockFeature.properties.blockParams) blockFeature.properties.blockParams = {};
        blockFeature.properties.blockParams.numEntries = val;
        // Re-run connect if already connected
        if (blockFeature.properties._extConns && blockFeature.properties._extConns.length > 0) {
          doConnect();
        }
      });
    }

    function doConnect() {
      var all = self._featureStore.toArray();
      // Use the SAME projection as overlay computation
      var projCenter = blockFeature.properties._projCenter;
      if (!projCenter) return;
      var proj = createProjection(projCenter[0], projCenter[1]);
      // Collect road polylines in meters (same projection)
      var roadPolylinesM = [];
      for (var ri = 0; ri < all.length; ri++) {
        if (all[ri].properties.type !== 'road') continue;
        var coords = all[ri].geometry.coordinates;
        if (!coords || coords.length < 2) continue;
        var roadM = [];
        for (var ci = 0; ci < coords.length; ci++) {
          roadM.push(proj.toMeters(coords[ci][0], coords[ci][1]));
        }
        roadPolylinesM.push(roadM);
      }
      if (roadPolylinesM.length === 0) return;
      // Get block polygon in meters (or reuse stored _polyM)
      var polyM = blockFeature.properties._polyM;
      if (!polyM || polyM.length < 3) return;
      // Get overlay connectors
      var overlaysM = blockFeature.properties._overlaysM;
      if (!overlaysM || !overlaysM.connectors || overlaysM.connectors.length === 0) return;
      // Compute connections
      var bp = blockFeature.properties.blockParams || {};
      var numEntries = bp.numEntries || 2;
      var result = computeExtConnections(overlaysM.connectors, roadPolylinesM, polyM, numEntries);
      // Convert back to lngLat for rendering
      var extConnsLL = [];
      for (var ei = 0; ei < result.connections.length; ei++) {
        var ec = result.connections[ei];
        extConnsLL.push({
          from: proj.toLngLat(ec.from[0], ec.from[1]),
          proj: proj.toLngLat(ec.proj[0], ec.proj[1]),
          dist: ec.dist,
          roadIdx: ec.roadIdx,
          active: ec.active
        });
      }
      blockFeature.properties._extConns = extConnsLL;
      blockFeature.properties._activeBoundary = result.activeBoundary;
      eventBus.emit('features:changed');
      self._updateProps();
    }

    var connectBtn = document.getElementById('block-connect-roads-btn');
    if (connectBtn) {
      connectBtn.addEventListener('click', doConnect);
    }

    // SPP (only works with insol Live active)
    var sppBtn = document.getElementById('block-spp-btn');
    if (sppBtn) {
      sppBtn.addEventListener('click', function () {
        if (!isInsolLiveActive()) return;
        self._applySPP(blockFeature);
      });
    }

    // Overlay visibility toggles
    var ovToggles = ['ov-buffers', 'ov-secfire', 'ov-road', 'ov-connectors', 'ov-graph', 'ov-trash', 'ov-play'];
    var ovKeys = ['buffers', 'secfire', 'road', 'connectors', 'graph', 'trash', 'play'];
    for (var oti = 0; oti < ovToggles.length; oti++) {
      (function (tid, key) {
        var el = document.getElementById(tid);
        if (!el) return;
        el.addEventListener('click', function () {
          var isOn = el.dataset.on === '1';
          el.dataset.on = isOn ? '0' : '1';
          var sw = el.querySelector('div');
          var knob = sw ? sw.querySelector('div') : null;
          if (sw) sw.style.background = isOn ? 'rgba(148,163,184,0.35)' : 'var(--primary)';
          if (knob) knob.style.left = isOn ? '2px' : '14px';
          if (!blockFeature.properties.overlayVisibility) blockFeature.properties.overlayVisibility = {};
          blockFeature.properties.overlayVisibility[key] = !isOn;
          eventBus.emit('features:changed');
        });
      })(ovToggles[oti], ovKeys[oti]);
    }
  }

  _applySPP(blockFeature) {
    var bid = blockFeature.properties.id;
    var sppEl = document.getElementById('ub-spp');
    var targetSPP = sppEl ? parseFloat(sppEl.value) : 80000;
    blockFeature.properties.blockParams.spp = targetSPP;

    var AREA_COEFF = 0.65;
    var FIRST_FLOOR_H = 4.5;
    var TYPICAL_FLOOR_H = 3.0;
    var MAX_H = 250; // absolute ceiling

    var all = this._featureStore.toArray();
    var axes = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].properties.blockId !== bid) continue;
      var f = all[i];
      var fps = f.properties.footprints;
      if (!fps || fps.length === 0) continue;
      var coords = f.geometry.coordinates;
      var avgY = (coords && coords.length >= 2) ? (coords[0][1] + coords[1][1]) / 2 : 0;
      axes.push({
        feature: f,
        isTower: f.properties.type === 'tower-axis',
        isLat: f.properties.orientation === 'lat',
        northness: avgY,
        fpArea: f.properties.axisLength * (blockFeature.properties.blockParams.sw || 18)
      });
    }
    if (axes.length === 0) return;

    // Sort priority: towers first, then merid by northness desc, then lat by northness desc
    axes.sort(function (a, b) {
      var pa = a.isTower ? 0 : a.isLat ? 2 : 1;
      var pb = b.isTower ? 0 : b.isLat ? 2 : 1;
      if (pa !== pb) return pa - pb;
      return b.northness - a.northness;
    });

    function floorCount(h) {
      if (h <= FIRST_FLOOR_H) return 1;
      return 1 + Math.floor((h - FIRST_FLOOR_H) / TYPICAL_FLOOR_H);
    }
    function heightForFloors(n) { return FIRST_FLOOR_H + (n - 1) * TYPICAL_FLOOR_H; }
    function computeSPP(hMap) {
      var total = 0;
      for (var i = 0; i < axes.length; i++) {
        total += axes[i].fpArea * AREA_COEFF * Math.max(0, floorCount(hMap[i]) - 1);
      }
      return total;
    }

    // Standard start: towers=112, merid=55, lat=28
    var hMap = [];
    for (var i = 0; i < axes.length; i++) {
      if (axes[i].isTower) hMap.push(112);
      else if (axes[i].isLat) hMap.push(28);
      else hMap.push(55);
    }

    var spp = computeSPP(hMap);
    log.debug('[SPP] standard start: ' + Math.round(spp) + ' target: ' + targetSPP);

    // Phase 1: upgrade one floor at a time, priority order, up to 50 iterations
    for (var iter = 0; iter < 50 && spp < targetSPP * 0.95; iter++) {
      var upgraded = false;
      for (var i = 0; i < axes.length; i++) {
        if (spp >= targetSPP * 0.95) break;
        var oldH = hMap[i];
        var newH = heightForFloors(floorCount(oldH) + 1);
        if (newH > MAX_H) continue;
        hMap[i] = newH;
        var newSpp = computeSPP(hMap);
        if (newSpp > targetSPP * 1.05) { hMap[i] = oldH; continue; }
        spp = newSpp;
        upgraded = true;
      }
      if (!upgraded) break;
    }

    // Phase 2: if still low, force-upgrade highest-priority axes beyond limit
    if (spp < targetSPP * 0.95) {
      for (var i = 0; i < axes.length && spp < targetSPP * 0.95; i++) {
        while (spp < targetSPP * 0.95 && hMap[i] < MAX_H) {
          hMap[i] = heightForFloors(floorCount(hMap[i]) + 1);
          spp = computeSPP(hMap);
        }
      }
    }

    // Phase 3: if too high, downgrade from south (lowest priority)
    if (spp > targetSPP * 1.05) {
      for (var i = axes.length - 1; i >= 0 && spp > targetSPP * 1.05; i--) {
        while (spp > targetSPP * 1.05 && floorCount(hMap[i]) > 2) {
          hMap[i] = heightForFloors(floorCount(hMap[i]) - 1);
          spp = computeSPP(hMap);
        }
      }
    }

    // Phase 4: staircase smoothing (max ±2 floors between neighbors of same type)
    for (var pass = 0; pass < 3; pass++) {
      for (var i = 1; i < axes.length; i++) {
        if (axes[i].isTower || axes[i - 1].isTower) continue;
        if (axes[i].isLat !== axes[i - 1].isLat) continue;
        var fA = floorCount(hMap[i - 1]); var fB = floorCount(hMap[i]);
        if (fA - fB > 2) hMap[i] = heightForFloors(fA - 2);
        else if (fB - fA > 2) hMap[i - 1] = heightForFloors(fB - 2);
      }
    }

    // Apply
    for (var i = 0; i < axes.length; i++) {
      if (axes[i].isTower) axes[i].feature.properties.towerHeight = hMap[i];
      else axes[i].feature.properties.sectionHeight = hMap[i];
    }

    spp = computeSPP(hMap);
    log.debug('[SPP] result=' + Math.round(spp) + 'm² (' + (targetSPP > 0 ? (spp / targetSPP * 100).toFixed(0) : '?') + '%) heights=' +
      axes.map(function (a, i) { return (a.isTower ? 'T' : a.isLat ? 'L' : 'M') + ':' + hMap[i] + 'm(' + floorCount(hMap[i]) + 'F)'; }).join(' '));

    eventBus.emit('features:changed');
  }

  _updateGhostContour(blockFeature) {
    var orig = blockFeature.properties._originalContour;
    if (orig && orig.length >= 3) {
      eventBus.emit('block:ghost:update', { coords: orig });
    } else {
      eventBus.emit('block:ghost:update', null);
    }
  }

  _rebuildBlock(blockFeature) {
    var bid = blockFeature.properties.id;

    // Read current slider values
    function val(id, fallback) {
      var el = document.getElementById(id);
      return el ? parseFloat(el.value) : fallback;
    }
    function parseLens(id, fallback) {
      var el = document.getElementById(id);
      if (!el) return fallback;
      return el.value.split(',').map(function (v) { return parseFloat(v.trim()); }).filter(function (v) { return !isNaN(v) && v > 0; });
    }

    var params = {
      sw: val('ub-sw', 18),
      fire: val('ub-fire', 14),
      endB: val('ub-end', 20),
      insol: val('ub-insol', 25),
      gapTarget: val('ub-gap', 22),
      latLens: parseLens('ub-lat-lens', [24, 27]),
      lonLens: parseLens('ub-lon-lens', [30, 36, 39, 42, 46, 49]),
      ctxRoll: (blockFeature.properties.blockParams || {}).ctxRoll || 0,
      typo: (blockFeature.properties.blockParams || {}).typo || 0,
      spp: (blockFeature.properties.blockParams || {}).spp || 80000
    };

    // Update blockParams on feature
    blockFeature.properties.blockParams = params;

    // Remove old axes (keep polygon)
    var all = this._featureStore.toArray();
    for (var i = 0; i < all.length; i++) {
      if (all[i].properties.blockId === bid) {
        this._featureStore._features.delete(all[i].properties.id);
      }
    }

    // Get polygon coords from geometry
    var polyLL = blockFeature.geometry.coordinates[0].slice();
    if (polyLL.length > 0 && polyLL[polyLL.length - 1][0] === polyLL[0][0] &&
        polyLL[polyLL.length - 1][1] === polyLL[0][1]) {
      polyLL.pop(); // remove closing vertex
    }

    // Project to meters
    var cx = 0; var cy = 0;
    for (var i = 0; i < polyLL.length; i++) { cx += polyLL[i][0]; cy += polyLL[i][1]; }
    cx /= polyLL.length; cy /= polyLL.length;
    var proj = createProjection(cx, cy);

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

    // Solve (with simplification)
    var solveResult = solveUrbanBlockFull(polyM, params);
    var axes = solveResult.axes;
    var workPolyM = solveResult.polyM;
    var sw = params.sw;
    var created = 0;

    // Detect tower edge when typo=1
    var towerEdgeId = -1;
    if (params.typo === 1) {
      // Northernmost vertex (max Y in meters)
      var northIdx = 0;
      for (var ni = 1; ni < workPolyM.length; ni++) {
        if (workPolyM[ni][1] > workPolyM[northIdx][1]) northIdx = ni;
      }
      var prevEI = (northIdx - 1 + workPolyM.length) % workPolyM.length;
      var nextEI = northIdx;
      var candidates = [];
      for (var ci = 0; ci < axes.length; ci++) {
        var te = axes[ci];
        if (te.removed || te.length < 23.1 || !te.oi) continue;
        if (te.id === prevEI || te.id === nextEI) candidates.push(te);
      }
      candidates.sort(function (a, b) { return b.orientation - a.orientation || b.length - a.length; });
      if (candidates.length > 0) towerEdgeId = candidates[0].id;
    }

    // Overlays computed separately via computeOverlays

    for (var ai = 0; ai < axes.length; ai++) {
      var ax = axes[ai];
      if (ax.removed || ax.length < 3 || !ax.oi) continue;
      if (!ax.secs || ax.secs.length === 0) continue;

      var startLL = proj.toLngLat(ax.start[0], ax.start[1]);
      var endLL = proj.toLngLat(ax.end[0], ax.end[1]);
      var oriName = ax.oriName || (ax.orientation === 1 ? 'lon' : 'lat');

      // Tower axis
      if (params.typo === 1 && ax.id === towerEdgeId) {
        var tProps = { cellSize: 3.3, towerGap: 20, flipped: false };
        var startM = ax.start; var endM = ax.end;
        var tFpM = computeTowerFootprints(startM, endM, tProps, null);
        var tFpLL = computeTowerFootprints(startM, endM, tProps,
          function (mx, my) { return proj.toLngLat(mx, my); });
        if (tFpLL.length > 0) {
          var northEnd = detectNorthEnd(startM, endM);
          var tid = crypto.randomUUID();
          this._featureStore._features.set(tid, {
            type: 'Feature',
            properties: {
              id: tid, type: 'tower-axis',
              createdAt: new Date().toISOString(),
              orientation: oriName, axisLength: ax.length,
              cellSize: 3.3, towerHeight: 112, towerGap: 20,
              northEnd: northEnd, footprints: tFpLL,
              blockId: bid, context: ax.context
            },
            geometry: { type: 'LineString', coordinates: [startLL, endLL] }
          });
          created++;
          continue;
        }
      }

      // Section axis
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

      var id = crypto.randomUUID();
      this._featureStore._features.set(id, {
        type: 'Feature',
        properties: {
          id: id, type: 'section-axis',
          createdAt: new Date().toISOString(), flipped: false,
          orientation: oriName, axisLength: axLen,
          footprints: fpLngLat, blockId: bid,
          context: ax.context, trimmed: ax.trimmed || false
        },
        geometry: { type: 'LineString', coordinates: [startLL, endLL] }
      });
      created++;
    }

    // Store overlays on block feature
    var overlays = computeOverlays(workPolyM, axes, params);
    // Convert overlay polygons to lngLat
    function polyToLL(p) { var r = []; for (var i = 0; i < p.length; i++) r.push(proj.toLngLat(p[i][0], p[i][1])); return r; }
    function polysToLL(arr) { var r = []; for (var i = 0; i < arr.length; i++) r.push(polyToLL(arr[i])); return r; }
    blockFeature.properties.overlays = {
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
        for (var ai2 = 0; ai2 < axes.length; ai2++) {
          var ax2 = axes[ai2];
          if (!ax2.bufs) continue;
          var types = ['fire', 'end', 'insol'];
          for (var ti2 = 0; ti2 < types.length; ti2++) {
            var bp = ax2.bufs[types[ti2]];
            if (bp && bp.length === 4) bz.push({ type: types[ti2], polygon: polyToLL(bp) });
          }
        }
        return bz;
      })()
    };
    // Store meters data for canvas-based overlay renderer
    blockFeature.properties._overlaysM = overlays;
    blockFeature.properties._polyM = polyM;
    blockFeature.properties._params = params;
    blockFeature.properties._projCenter = [cx, cy]; // lngLat center of local projection

    log.debug('[UrbanBlock] rebuilt ' + bid.slice(0, 6) + ': ' + created + ' axes, ' +
      overlays.connectors.length + ' connectors, trash=' + (overlays.trashPad ? 'yes' : 'no'));
    this._selectedIds = [bid];
    eventBus.emit('features:changed');
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
    var fireAuto = autoFireDist(params.sectionHeight);
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
