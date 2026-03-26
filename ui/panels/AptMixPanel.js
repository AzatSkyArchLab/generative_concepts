/**
 * AptMixPanel — apartment mix inputs, distribute/reset, building plan display.
 */

import { eventBus } from '../../core/EventBus.js';

export function renderAptMixSection() {
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

export function getAptMix() {
  var mix = { '1K': 40, '2K': 30, '3K': 20, '4K': 10 };
  var inputs = document.querySelectorAll('.apt-mix-input');
  for (var i = 0; i < inputs.length; i++) {
    var key = inputs[i].dataset.apt;
    mix[key] = parseInt(inputs[i].value) || 0;
  }
  return mix;
}

export function updateMixTotal() {
  var mix = getAptMix();
  var total = mix['1K'] + mix['2K'] + mix['3K'] + mix['4K'];
  var el = document.getElementById('apt-mix-total');
  if (el) {
    el.textContent = 'Total: ' + total + '%';
    el.style.color = total === 100 ? 'var(--success)' : 'var(--danger)';
  }
}

export function showBuildingPlan(plan) {
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
