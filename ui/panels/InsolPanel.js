/**
 * InsolPanel — insolation analysis button, results, ray toggle.
 */

import { eventBus } from '../../core/EventBus.js';

export function renderInsolSection() {
  var el = document.getElementById('insol-section');
  if (!el) return;
  var h = '<div class="props-divider"></div>';
  h += '<div class="insol-panel" id="insol-panel">';
  h += '<div id="insol-btn-wrap"></div>';
  h += '<div id="insol-results" style="display:none"></div>';
  h += '</div>';
  el.innerHTML = h;
}

/**
 * Context-aware insolation button.
 * Adapts label and action to current selection state.
 */
export function updateInsolButton(featureStore, editAxisId, editSelectedIndices, selectedIds) {
  var wrap = document.getElementById('insol-btn-wrap');
  if (!wrap) return;

  var all = featureStore.toArray();
  var hasSections = false;
  var hasTowers = false;
  for (var i = 0; i < all.length; i++) {
    if (all[i].properties.type === 'section-axis') hasSections = true;
    else if (all[i].properties.type === 'tower-axis') hasTowers = true;
  }
  if (!hasSections && !hasTowers) { wrap.innerHTML = ''; return; }

  var scope, label, event, eventData;

  if (editAxisId && editSelectedIndices.length === 1) {
    var editF = featureStore.get(editAxisId);
    var isTower = editF && editF.properties.type === 'tower-axis';
    scope = 'section';
    var itemNum = editSelectedIndices[0] + 1;
    label = (isTower ? 'Tower' : 'Section') + ' #' + itemNum;
    event = 'insolation:analyze:section';
    eventData = { axisId: editAxisId, sectionIdx: editSelectedIndices[0] };
  } else if (editAxisId) {
    scope = 'axis';
    var f = featureStore.get(editAxisId);
    var isTower = f && f.properties.type === 'tower-axis';
    var n = f && f.properties.footprints ? f.properties.footprints.length : 0;
    label = 'Editing axis · ' + n + (isTower ? ' tower' : ' sect') + '.';
    event = 'insolation:analyze:axis';
    eventData = { axisId: editAxisId };
  } else if (selectedIds.length === 1) {
    var f = featureStore.get(selectedIds[0]);
    if (f && (f.properties.type === 'section-axis' || f.properties.type === 'tower-axis')) {
      scope = 'axis';
      var isTower = f.properties.type === 'tower-axis';
      var n = f.properties.footprints ? f.properties.footprints.length : 0;
      label = 'Selected · ' + n + (isTower ? ' tower' : ' sect') + '.';
      event = 'insolation:analyze:axis';
      eventData = { axisId: selectedIds[0] };
    } else {
      scope = 'global';
      label = 'All buildings';
      event = 'insolation:analyze:global';
      eventData = null;
    }
  } else {
    scope = 'global';
    label = 'All buildings';
    event = 'insolation:analyze:global';
    eventData = null;
  }

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

export function showInsolResults(data) {
  var el = document.getElementById('insol-results');
  if (!el) return;
  var levelLabel = data.level === 'global' ? 'All buildings' : data.level === 'axis' ? 'Selected axis' : 'Section';
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
  if (clearBtn) clearBtn.addEventListener('click', function () {
    eventBus.emit('insolation:clear');
    el.style.display = 'none';
  });
  var raysBtn = document.getElementById('insol-rays-btn');
  if (raysBtn) raysBtn.addEventListener('click', function () {
    eventBus.emit('insolation:rays:toggle');
  });
}

export function onInsolClear() {
  var el = document.getElementById('insol-results');
  if (el) el.style.display = 'none';
}

export function onRaysVisibility(d) {
  var lbl = document.getElementById('insol-rays-label');
  if (lbl) lbl.textContent = d.visible ? 'Hide rays' : 'Show rays';
}
