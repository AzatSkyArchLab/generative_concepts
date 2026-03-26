/**
 * StatsPanel — per-section and summary statistics display.
 */

function fmtArea(m2) {
  if (m2 >= 1000) return (m2 / 1000).toFixed(1) + 'k m²';
  return Math.round(m2) + ' m²';
}

export function updateStats(stats) {
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
