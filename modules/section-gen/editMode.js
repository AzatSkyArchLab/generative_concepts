/**
 * EditMode — section edit mode with shift+click multi-select.
 */

import { state } from './state.js';

export function enterEditMode(lineId) {
  state.editAxisId = lineId;
  state.editSelectedIndices = [];
  state.layer.clearHighlight();
  var fps = state.lineFootprints[lineId];
  if (fps && fps.length > 0) {
    state.layer.enterEditMode(fps, function () { exitEditMode(); });
  }
  state.eventBus.emit('section:edit-mode', { axisId: lineId });
}

export function exitEditMode() {
  state.editAxisId = null;
  state.editSelectedIndices = [];
  state.layer.exitEditMode();
  state.eventBus.emit('section:edit-exit');
}

export function updateEditHighlight() {
  var fps = state.lineFootprints[state.editAxisId];
  if (!fps) return;
  if (state.editSelectedIndices.length === 0) {
    state.layer.clearEditSelection(fps);
  } else {
    var selectedFPs = [];
    var dimFPs = [];
    for (var i = 0; i < fps.length; i++) {
      if (state.editSelectedIndices.indexOf(i) >= 0) selectedFPs.push(fps[i]);
      else dimFPs.push(fps[i]);
    }
    state.layer.selectEditSections(selectedFPs, dimFPs);
  }
}

export function selectSection(secIdx, addToSelection) {
  if (addToSelection) {
    var pos = state.editSelectedIndices.indexOf(secIdx);
    if (pos >= 0) state.editSelectedIndices.splice(pos, 1);
    else {
      state.editSelectedIndices.push(secIdx);
      state.editSelectedIndices.sort(function (a, b) { return a - b; });
    }
  } else {
    state.editSelectedIndices = [secIdx];
  }
  updateEditHighlight();
  state.eventBus.emit('section:individual:selected', {
    axisId: state.editAxisId, sectionIndices: state.editSelectedIndices.slice()
  });
}
