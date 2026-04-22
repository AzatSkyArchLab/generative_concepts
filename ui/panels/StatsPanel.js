/**
 * StatsPanel — per-section and summary statistics display.
 *
 * Summary rows: Footprint · Apt. area · GBA · Green zone · Population.
 *
 * Green zone display rules:
 *   - no blocks / all zones zero → not shown
 *   - exactly one block → single row  "Green zone: X m²"
 *   - multiple blocks    → one row per block  "Block #k (id): X m²"
 *                          followed by         "Green zone total: Y m²"
 *
 * greenZone argument shape:
 *   { totalArea: number, perBlock: { [blockId]: area }, blockOrder: string[] }
 * The legacy scalar form (a plain number) is still accepted for resilience
 * in case a caller hasn't been updated.
 */

function fmtArea(m2) {
  if (m2 >= 1000) return (m2 / 1000).toFixed(1) + 'k m²';
  return Math.round(m2) + ' m²';
}

// Green-zone palette lives in one spot to keep the per-block rows,
// the summary row and the map layer visually consistent.
var GZ_COLOR = '#15803d';

function rowHTML(labelHTML, valueHTML) {
  return '<div class="stats-summary-row">'
    + '<span class="stats-label" style="color:' + GZ_COLOR + '">' + labelHTML + '</span>'
    + '<span class="stats-value" style="color:' + GZ_COLOR + '">' + valueHTML + '</span>'
    + '</div>';
}

function renderGreenZoneRows(gz) {
  if (gz == null) return '';

  // Back-compat: scalar value → one-row summary (no per-block data).
  if (typeof gz === 'number') {
    if (gz <= 0) return '';
    return rowHTML('Green zone', fmtArea(gz));
  }

  var order = (gz && gz.blockOrder) ? gz.blockOrder : [];
  var perBlock = (gz && gz.perBlock) ? gz.perBlock : {};
  var total = typeof gz.totalArea === 'number' ? gz.totalArea : 0;

  // Collect blocks with a positive area in the provided order.
  // Zero-area blocks (fully covered by footprints + fire buffers) are
  // skipped — a line with "0 m²" would be more noise than signal.
  var visibleIds = [];
  for (var i = 0; i < order.length; i++) {
    var id = order[i];
    if ((perBlock[id] || 0) > 0) visibleIds.push(id);
  }

  if (visibleIds.length === 0) return '';

  // Single-block case — keep the terse look of the original design.
  if (visibleIds.length === 1) {
    return rowHTML('Green zone', fmtArea(perBlock[visibleIds[0]]));
  }

  // Multi-block case — one line per block plus a total.
  var h = '';
  for (var j = 0; j < visibleIds.length; j++) {
    var bId = visibleIds[j];
    var label = 'Green zone · Block #' + (j + 1)
      + ' <small style="color:var(--text-muted)">' + bId.slice(0, 5) + '</small>';
    h += rowHTML(label, fmtArea(perBlock[bId]));
  }
  h += rowHTML('<strong>Green zone total</strong>',
               '<strong>' + fmtArea(total) + '</strong>');
  return h;
}

export function updateStats(stats, greenZone) {
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

  // Green zone rows — delegated to helper (handles single- and multi-block).
  h += renderGreenZoneRows(greenZone);

  h += '<div class="stats-summary-row stats-summary-row--pop">';
  h += '<span class="stats-label">Population <small style="color:var(--text-muted)">/50 m²</small></span>';
  h += '<span class="stats-value stats-value--pop">' + stats.totalPopulation + ' ppl</span>';
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
    h += ' <span class="stats-axis-sum">' + axisPop + ' ppl · ' + fmtArea(axisApt) + '</span></div>';

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
        h += '<span class="stats-sec-metric-label">' + (wz.orientation === 'lon' ? 'merid' : 'lat') + '</span>';
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
