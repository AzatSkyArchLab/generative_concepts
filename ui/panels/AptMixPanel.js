/**
 * AptMixPanel — apartment mix inputs, distribute/reset, building plan display.
 * Consistent with props-section styling. Clear target vs actual comparison.
 */

import { eventBus } from '../../core/EventBus.js';

var _accPlans = {};

var APT_TYPES = [
  { key: '1K', color: '#ade8f4', def: 40 },
  { key: '2K', color: '#90ee90', def: 30 },
  { key: '3K', color: '#ffdab9', def: 20 },
  { key: '4K', color: '#dda0dd', def: 10 }
];

export function renderAptMixSection() {
  var el = document.getElementById('apt-mix-section');
  if (!el) return;
  el.style.display = 'none';

  var h = '<div class="props-divider"></div>';
  h += '<div class="apt-mix-panel">';
  h += '<div class="props-header-small">Apartment Mix</div>';
  h += '<div class="apt-mix-inputs">';

  for (var i = 0; i < APT_TYPES.length; i++) {
    var t = APT_TYPES[i];
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
  h += '<button class="apt-mix-btn apt-mix-btn--secondary" id="apt-mix-reset" style="display:none">Reset to floor 1</button>';
  h += '<button class="apt-mix-btn apt-mix-btn--secondary" id="apt-mix-report" style="display:none">Floor plans report</button>';
  h += '</div>';

  h += '<div id="building-plan-results"></div>';
  h += '</div>';

  el.innerHTML = h;

  // Bind inputs
  var inputs = el.querySelectorAll('.apt-mix-input');
  for (var i = 0; i < inputs.length; i++) {
    inputs[i].addEventListener('change', function () {
      updateMixTotal();
      eventBus.emit('apt-mix:changed', getAptMix());
    });
  }

  var distBtn = document.getElementById('apt-mix-distribute');
  if (distBtn) {
    distBtn.addEventListener('click', function () {
      eventBus.emit('apt-mix:distribute', getAptMix());
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
      resetBuildingPlans();
    });
  }

  var reportBtn = document.getElementById('apt-mix-report');
  if (reportBtn) {
    reportBtn.addEventListener('click', function () {
      eventBus.emit('building:report:generate');
    });
  }
}

export function getAptMix() {
  var mix = {};
  var inputs = document.querySelectorAll('.apt-mix-input');
  for (var i = 0; i < inputs.length; i++) {
    var key = inputs[i].getAttribute('data-apt');
    mix[key] = parseInt(inputs[i].value) || 0;
  }
  return mix;
}

export function updateMixTotal() {
  var mix = getAptMix();
  var total = (mix['1K'] || 0) + (mix['2K'] || 0) + (mix['3K'] || 0) + (mix['4K'] || 0);
  var el = document.getElementById('apt-mix-total');
  if (el) {
    el.textContent = 'Total: ' + total + '%';
    el.style.color = total === 100 ? 'var(--success)' : 'var(--danger)';
  }
}

export function resetBuildingPlans() {
  _accPlans = {};
  var el = document.getElementById('building-plan-results');
  if (el) el.innerHTML = '';
}

export function showBuildingPlan(sectionKey, plan) {
  var el = document.getElementById('building-plan-results');
  if (!el || !plan) return;
  _accPlans[sectionKey] = plan;

  var keys = [];
  for (var k in _accPlans) { if (_accPlans.hasOwnProperty(k)) keys.push(k); }
  var types = ['1K', '2K', '3K', '4K'];

  // Aggregate across sections
  var aggTarget = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
  var aggActual = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
  var aggOrphan = 0;
  var aggFloors = 0;

  for (var ki = 0; ki < keys.length; ki++) {
    var p = _accPlans[keys[ki]];
    var d = p.deviation;
    for (var ti = 0; ti < types.length; ti++) {
      var t = types[ti];
      aggTarget[t] += (d[t] ? d[t].target : 0);
      aggActual[t] += (d[t] ? d[t].actual : 0);
    }
    aggOrphan += (p.orphanCount || 0);
    aggFloors += (p.floors ? p.floors.length : 0);
  }

  var totalTarget = aggTarget['1K'] + aggTarget['2K'] + aggTarget['3K'] + aggTarget['4K'];
  var totalActual = aggActual['1K'] + aggActual['2K'] + aggActual['3K'] + aggActual['4K'];

  // ── Build HTML ──
  var h = '<div class="bplan-card">';

  // Header
  h += '<div class="bplan-header">Distribution Result';
  if (keys.length > 1) h += ' <span class="bplan-count">(' + keys.length + ' sections)</span>';
  h += '</div>';

  // Table
  h += '<div class="bplan-table">';
  h += '<div class="bplan-row bplan-row--header">';
  h += '<span>Type</span><span>Target</span><span>Actual</span><span>Δ</span>';
  h += '</div>';

  for (var ti = 0; ti < types.length; ti++) {
    var t = types[ti];
    if (aggTarget[t] === 0 && aggActual[t] === 0) continue;

    var delta = aggActual[t] - aggTarget[t];
    var deltaClass = delta === 0 ? 'bplan-ok' : (delta > 0 ? 'bplan-over' : 'bplan-under');
    var deltaStr = delta === 0 ? '=' : (delta > 0 ? '+' + delta : String(delta));

    var tPct = totalTarget > 0 ? Math.round(aggTarget[t] / totalTarget * 100) : 0;
    var aPct = totalActual > 0 ? Math.round(aggActual[t] / totalActual * 100) : 0;

    h += '<div class="bplan-row">';
    h += '<span class="bplan-type">' + t + '</span>';
    h += '<span>' + aggTarget[t] + ' <small>' + tPct + '%</small></span>';
    h += '<span>' + aggActual[t] + ' <small>' + aPct + '%</small></span>';
    h += '<span class="' + deltaClass + '">' + deltaStr + '</span>';
    h += '</div>';

    // Percentage bar
    var barMax = Math.max(tPct, aPct, 1);
    var targetW = Math.round(tPct / barMax * 100);
    var actualW = Math.round(aPct / barMax * 100);
    h += '<div class="bplan-bar">';
    h += '<div class="bplan-bar-target" style="width:' + targetW + '%"></div>';
    h += '<div class="bplan-bar-actual" style="width:' + actualW + '%"></div>';
    h += '</div>';
  }
  h += '</div>';

  // Summary
  h += '<div class="bplan-summary">';
  h += totalActual + ' apts · ' + aggFloors + ' floors';
  if (totalActual !== totalTarget) {
    h += ' · target ' + totalTarget;
  }
  if (aggOrphan > 0) {
    h += ' · <span class="bplan-under">' + aggOrphan + ' orphan</span>';
  }
  h += '</div>';

  // Per-section details
  if (keys.length > 1) {
    h += '<div class="bplan-sections">';
    for (var ki = 0; ki < keys.length; ki++) {
      var sk = keys[ki];
      var sp = _accPlans[sk];
      var sd = sp.deviation;

      // Short section key (last 8 chars + index)
      var shortKey = sk.length > 12 ? sk.substring(sk.length - 12) : sk;

      h += '<div class="bplan-sec">';
      h += '<div class="bplan-sec-title">' + shortKey + '</div>';
      h += '<div class="bplan-sec-detail">';

      var secParts = [];
      for (var ti = 0; ti < types.length; ti++) {
        var t = types[ti];
        if (sd[t] && (sd[t].target > 0 || sd[t].actual > 0)) {
          var sDelta = sd[t].actual - sd[t].target;
          var sDeltaStr = sDelta === 0 ? '=' : (sDelta > 0 ? '+' + sDelta : String(sDelta));
          var sDeltaClass = sDelta === 0 ? 'bplan-ok' : (sDelta > 0 ? 'bplan-over' : 'bplan-under');
          secParts.push(t + ':' + sd[t].actual + '/' + sd[t].target +
            ' <span class="' + sDeltaClass + '">' + sDeltaStr + '</span>');
        }
      }
      h += secParts.join(' · ');
      h += '</div>';

      // Profile
      if (sp.profile) {
        h += '<div class="bplan-sec-profile">WZ: ' + sp.profile.join(' → ') + '</div>';
      }

      if (sp.orphanCount > 0) {
        h += '<div class="bplan-under" style="font-size:10px">' + sp.orphanCount + ' orphan</div>';
      }

      h += '</div>';
    }
    h += '</div>';
  }

  h += '</div>';
  el.innerHTML = h;
}

export function updateAptMixVisibility(hasSections) {
  var el = document.getElementById('apt-mix-section');
  if (el) el.style.display = hasSections ? 'block' : 'none';
}

export function resetDistributeState() {
  var distBtn = document.getElementById('apt-mix-distribute');
  var resetBtn = document.getElementById('apt-mix-reset');
  var repBtn = document.getElementById('apt-mix-report');
  if (distBtn) distBtn.style.display = 'block';
  if (resetBtn) resetBtn.style.display = 'none';
  if (repBtn) repBtn.style.display = 'none';
}
