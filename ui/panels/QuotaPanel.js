/**
 * QuotaPanel — Phase 0 quota resolution debug display.
 *
 * Shows Diophantine solutions as collapsible dropdown in right panel.
 * Temporary debug tool — will be removed after algorithm is finalized.
 */


var _lastResults = {};

export function renderQuotaSection() {
  var el = document.getElementById('quota-section');
  if (!el) return;
  el.style.display = 'none';
  el.innerHTML = '';
}

export function updateQuotaResults(data) {
  var el = document.getElementById('quota-section');
  if (!el) return;
  if (!data || !data.sections || data.sections.length === 0) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  _lastResults = data;
  el.style.display = 'block';

  var h = '<div class="props-divider"></div>';
  h += '<div class="quota-panel">';
  h += '<div class="quota-header" id="quota-toggle">';
  h += '<span class="quota-arrow" id="quota-arrow">&#9654;</span> ';
  h += 'Phase 0: Quota Target</div>';
  h += '<div class="quota-body" id="quota-body" style="display:none">';

  for (var si = 0; si < data.sections.length; si++) {
    var sec = data.sections[si];
    h += renderSection(sec);
  }

  h += '</div></div>';
  el.innerHTML = h;

  var toggle = document.getElementById('quota-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var body = document.getElementById('quota-body');
      var arrow = document.getElementById('quota-arrow');
      if (!body) return;
      if (body.style.display === 'none') {
        body.style.display = 'block';
        if (arrow) arrow.innerHTML = '&#9660;';
      } else {
        body.style.display = 'none';
        if (arrow) arrow.innerHTML = '&#9654;';
      }
    });
  }
}

function renderSection(sec) {
  var h = '';
  h += '<div class="quota-section-block">';
  h += '<div class="quota-sec-title">' + sec.key + '</div>';
  h += '<div class="quota-sec-meta">';
  h += sec.cellsPerFloor + ' cells/floor &middot; ';
  h += sec.residentialFloors + ' floors &middot; ';
  h += sec.totalCells + ' total cells';
  h += '</div>';

  // Best solution
  if (sec.best) {
    h += '<div class="quota-best">';
    h += '<div class="quota-best-label">Best Q:</div>';
    h += '<div class="quota-best-value">' + formatCounts(sec.best.counts) + '</div>';
    h += '<div class="quota-best-fracs">' + formatFractions(sec.best.fractions) + '</div>';
    h += '<div class="quota-best-dev">dev=' + sec.best.deviation.toFixed(3) +
      ' &middot; ' + sec.best.totalApartments + ' apts</div>';
    h += '</div>';
  }

  // Floor 2 placed
  if (sec.floor2Placed) {
    h += '<div class="quota-floor2">';
    h += '<span class="quota-floor2-label">Floor 2:</span> ';
    h += formatCounts(sec.floor2Placed);
    h += '</div>';
  }

  // Remainder
  if (sec.remainder) {
    var remClass = sec.feasible ? 'quota-rem-ok' : 'quota-rem-fail';
    h += '<div class="quota-remainder ' + remClass + '">';
    h += '<span class="quota-rem-label">Remainder:</span> ';
    h += formatCounts(sec.remainder.remainder);
    if (!sec.feasible) {
      h += ' <span class="quota-rem-warn">SHORTFALL</span>';
    }
    h += '</div>';
  }

  // Candidates dropdown
  if (sec.candidates && sec.candidates.length > 1) {
    var cid = 'quota-cands-' + sec.key.replace(/[^a-zA-Z0-9]/g, '_');
    h += '<div class="quota-cands-toggle" onclick="';
    h += 'var b=document.getElementById(\'' + cid + '\');';
    h += 'b.style.display=b.style.display===\'none\'?\'block\':\'none\'">';
    h += '&#9654; ' + sec.candidates.length + ' candidates</div>';
    h += '<div class="quota-cands-list" id="' + cid + '" style="display:none">';
    for (var ci = 0; ci < sec.candidates.length; ci++) {
      var c = sec.candidates[ci];
      var isBest = ci === 0;
      h += '<div class="quota-cand-row' + (isBest ? ' quota-cand-best' : '') + '">';
      h += '<span class="quota-cand-num">#' + (ci + 1) + '</span> ';
      h += formatCounts(c.counts);
      h += ' <span class="quota-cand-dev">dev=' + c.deviation.toFixed(3) + '</span>';
      h += '</div>';
    }
    h += '</div>';
  }

  h += '</div>';
  return h;
}

function formatCounts(counts) {
  var types = ['1K', '2K', '3K', '4K'];
  var parts = [];
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    var n = counts[t] || 0;
    if (n > 0) parts.push(n + '&times;' + t);
  }
  return parts.join(' + ') || '(empty)';
}

function formatFractions(fracs) {
  var types = ['1K', '2K', '3K', '4K'];
  var parts = [];
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    var f = fracs[t] || 0;
    if (f > 0) parts.push(t + ':' + Math.round(f * 100) + '%');
  }
  return parts.join(' ');
}

// ── Styles (injected once) ─────────────────────────────

var _stylesInjected = false;

export function injectQuotaStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;

  var css = '';
  css += '.quota-panel { padding: 0 8px 8px; font-size: 11px; }';
  css += '.quota-header { cursor: pointer; font-weight: 600; font-size: 11px; padding: 6px 0; color: var(--text-primary); user-select: none; }';
  css += '.quota-arrow { font-size: 9px; display: inline-block; transition: transform 0.15s; }';
  css += '.quota-body { padding: 0 0 4px; }';
  css += '.quota-section-block { margin: 4px 0 8px; padding: 6px; border-radius: 4px; background: var(--bg-secondary, rgba(0,0,0,0.03)); }';
  css += '.quota-sec-title { font-weight: 600; font-size: 11px; margin-bottom: 2px; }';
  css += '.quota-sec-meta { font-size: 10px; color: var(--text-muted, #888); margin-bottom: 6px; }';
  css += '.quota-best { margin: 4px 0; padding: 4px 6px; border-radius: 3px; background: rgba(34,197,94,0.08); border-left: 2px solid #22c55e; }';
  css += '.quota-best-label { font-weight: 600; font-size: 10px; color: #16a34a; }';
  css += '.quota-best-value { font-size: 11px; font-weight: 500; margin: 1px 0; }';
  css += '.quota-best-fracs { font-size: 10px; color: var(--text-muted, #888); }';
  css += '.quota-best-dev { font-size: 10px; color: var(--text-muted, #888); }';
  css += '.quota-floor2 { font-size: 10px; margin: 3px 0; }';
  css += '.quota-floor2-label { font-weight: 600; }';
  css += '.quota-remainder { font-size: 10px; margin: 3px 0; }';
  css += '.quota-rem-label { font-weight: 600; }';
  css += '.quota-rem-ok { color: var(--text-primary); }';
  css += '.quota-rem-fail { color: #ef4444; }';
  css += '.quota-rem-warn { background: #ef4444; color: #fff; padding: 0 4px; border-radius: 2px; font-size: 9px; font-weight: 600; }';
  css += '.quota-cands-toggle { cursor: pointer; font-size: 10px; color: var(--text-muted, #888); margin-top: 4px; user-select: none; }';
  css += '.quota-cands-toggle:hover { color: var(--text-primary); }';
  css += '.quota-cands-list { padding: 2px 0 0 8px; }';
  css += '.quota-cand-row { font-size: 10px; padding: 1px 0; }';
  css += '.quota-cand-best { font-weight: 600; }';
  css += '.quota-cand-num { color: var(--text-muted, #888); }';
  css += '.quota-cand-dev { color: var(--text-muted, #888); }';

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}
