/**
 * Section Gen — module entry point.
 *
 * Architecture after refactor:
 *   state.js        — centralized mutable state
 *   editMode.js     — edit mode enter/exit/select
 *   clickHandler.js — map click/dblclick/hover handlers
 *   insolHelpers.js — insolation map construction
 *   processor.js    — processAllSections (main build cycle)
 *   index.js        — init/destroy + event wiring (this file)
 */

import { UpdateFeatureCommand } from '../../core/commands/UpdateFeatureCommand.js';
import { SectionGenLayer } from './SectionGenLayer.js';
import { generateReport } from '../../ui/FloorPlanReport.js';

import { state, resetState } from './state.js';
import { highlightIds, removeAllMapHandlers } from './clickHandler.js';
import { processAllSections } from './processor.js';

// ── Event handlers ──────────────────────────────────

function onSelected(d) {
  if (state.editAxisId) return;
  state.highlightedIds = [d.id];
  highlightIds(state.highlightedIds);
}

function onInsolCellMap(cellMap) {
  state.insolCellMap = cellMap;
  state.buildingPlans = {}; state.sectionMixes = null;  // force rebuild with new insol data
  processAllSections();
}

function onMultiselect(d) {
  if (state.editAxisId) return;
  var idx = state.highlightedIds.indexOf(d.id);
  if (idx >= 0) state.highlightedIds.splice(idx, 1);
  else state.highlightedIds.push(d.id);
  highlightIds(state.highlightedIds);
}

function onDeselected() {
  state.highlightedIds = [];
  if (state.layer) state.layer.clearHighlight();
}

function onChanged() {
  state.distributed = false;
  state.buildingPlans = {}; state.sectionMixes = null;
  state.graphDataMap = {};
  processAllSections();
}

function onSectionParamChanged(data) {
  if (!data.axisId) return;
  var f = state.featureStore.get(data.axisId);
  if (!f || !f.properties.footprints) return;
  var indices = data.sectionIndices || (data.sectionIdx !== undefined ? [data.sectionIdx] : []);
  if (indices.length === 0) return;

  // Snapshot old footprints for undo
  var oldFP = [];
  for (var i = 0; i < f.properties.footprints.length; i++) {
    var oc = {};
    for (var k in f.properties.footprints[i]) {
      if (f.properties.footprints[i].hasOwnProperty(k)) oc[k] = f.properties.footprints[i][k];
    }
    oldFP.push(oc);
  }

  // Build new footprints
  var newFP = [];
  for (var i = 0; i < f.properties.footprints.length; i++) {
    var copy = {};
    for (var k in f.properties.footprints[i]) {
      if (f.properties.footprints[i].hasOwnProperty(k)) copy[k] = f.properties.footprints[i][k];
    }
    if (indices.indexOf(i) >= 0) copy[data.key] = data.value;
    newFP.push(copy);
  }

  if (state.commandManager) {
    state.commandManager.execute(new UpdateFeatureCommand(
      state.featureStore, data.axisId, { footprints: newFP }, { footprints: oldFP }
    ));
  } else {
    state.featureStore.update(data.axisId, { footprints: newFP });
  }
  processAllSections();
  state.eventBus.emit('buffers:recompute');
}

// ── Module ──────────────────────────────────────────

var sectionGenModule = {
  id: 'section-gen',

  init: function (ctx) {
    state.eventBus = ctx.eventBus;
    state.featureStore = ctx.featureStore;
    state.mapManager = ctx.mapManager;
    state.threeOverlay = ctx.threeOverlay || null;
    state.commandManager = ctx.commandManager || null;

    state.layer = new SectionGenLayer(ctx.mapManager);
    state.layer.init();

    state.unsubs.push(state.eventBus.on('draw:section:complete', onChanged));
    state.unsubs.push(state.eventBus.on('features:changed', onChanged));
    state.unsubs.push(state.eventBus.on('section-gen:params:changed', onChanged));
    state.unsubs.push(state.eventBus.on('section:param:changed', onSectionParamChanged));
    state.unsubs.push(state.eventBus.on('feature:selected', onSelected));
    state.unsubs.push(state.eventBus.on('feature:multiselect', onMultiselect));
    state.unsubs.push(state.eventBus.on('feature:deselected', onDeselected));
    state.unsubs.push(state.eventBus.on('insolation:cell-map', onInsolCellMap));

    state.unsubs.push(state.eventBus.on('apt-mix:distribute', function (mix) {
      state.aptMix = mix || state.aptMix;
      state.distributed = true;
      state.buildingPlans = {}; state.sectionMixes = null;
      state.eventBus.emit('insolation:run-multi-floor');
    }));
    state.unsubs.push(state.eventBus.on('apt-mix:changed', function (mix) {
      state.aptMix = mix || state.aptMix;
    }));
    state.unsubs.push(state.eventBus.on('apt-mix:reset', function () {
      state.distributed = false;
      state.buildingPlans = {}; state.sectionMixes = null;
      state.graphDataMap = {};
      state.eventBus.emit('insolation:analyze:global');
    }));
    state.unsubs.push(state.eventBus.on('building:report:generate', function () {
      generateReport(state.buildingPlans, state.graphDataMap);
    }));

    console.log('[section-gen] initialized');
  },

  destroy: function () {
    for (var i = 0; i < state.unsubs.length; i++) { state.unsubs[i](); }
    if (state.keyHandler) {
      document.removeEventListener('keydown', state.keyHandler);
    }
    var map = state.mapManager ? state.mapManager.getMap() : null;
    if (map) removeAllMapHandlers(map);
    if (state.threeOverlay) state.threeOverlay.clear();
    if (state.layer) { state.layer.destroy(); }
    resetState();
  }
};

export default sectionGenModule;
