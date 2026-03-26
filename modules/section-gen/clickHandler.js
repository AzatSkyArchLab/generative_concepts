/**
 * ClickHandler — map click/dblclick/hover for section footprints.
 * Manages map event handler lifecycle for proper cleanup.
 */

import { state } from './state.js';
import { enterEditMode, exitEditMode, selectSection } from './editMode.js';

export function highlightIds(ids) {
  if (!state.layer) return;
  var allFps = [];
  for (var i = 0; i < ids.length; i++) {
    var fps = state.lineFootprints[ids[i]];
    if (fps) {
      for (var j = 0; j < fps.length; j++) allFps.push(fps[j]);
    }
  }
  if (allFps.length > 0) state.layer.highlightRaw(allFps);
  else state.layer.clearHighlight();
}

function _addMapHandler(map, event, layerOrFn, fn) {
  if (fn) {
    map.on(event, layerOrFn, fn);
    state.mapHandlers.push({ event: event, layer: layerOrFn, fn: fn });
  } else {
    map.on(event, layerOrFn);
    state.mapHandlers.push({ event: event, fn: layerOrFn });
  }
}

export function removeAllMapHandlers(map) {
  for (var i = 0; i < state.mapHandlers.length; i++) {
    var h = state.mapHandlers[i];
    if (h.layer) map.off(h.event, h.layer, h.fn);
    else map.off(h.event, h.fn);
  }
  state.mapHandlers = [];
}

export function setupClickHandler() {
  if (state.clickWired) return;
  var map = state.mapManager.getMap();
  if (!map) return;
  var clickLayerId = state.layer.getClickLayerId();

  _addMapHandler(map, 'click', clickLayerId, function (e) {
    if (!e.features || e.features.length === 0) return;
    var props = e.features[0].properties;
    var lineId = props.lineId;
    var secIdx = props.secIdx !== undefined ? parseInt(props.secIdx) : -1;

    if (state.editAxisId) {
      if (lineId === state.editAxisId && secIdx >= 0) selectSection(secIdx, e.originalEvent.shiftKey);
      return;
    }

    state.highlightedIds = [lineId];
    highlightIds(state.highlightedIds);
    state.eventBus.emit('sidebar:feature:click', { id: lineId });
  });

  _addMapHandler(map, 'dblclick', clickLayerId, function (e) {
    if (!e.features || e.features.length === 0) return;
    e.preventDefault();
    var lineId = e.features[0].properties.lineId;
    if (!lineId || state.editAxisId) return;
    state.layer.clearHighlight();
    enterEditMode(lineId);
  });

  _addMapHandler(map, 'mouseenter', clickLayerId, function () { state.mapManager.setCursor('pointer'); });
  _addMapHandler(map, 'mouseleave', clickLayerId, function () { state.mapManager.setCursor('grab'); });

  state.keyHandler = function (e) { if (e.key === 'Escape' && state.editAxisId) exitEditMode(); };
  document.addEventListener('keydown', state.keyHandler);

  state.clickWired = true;
}
