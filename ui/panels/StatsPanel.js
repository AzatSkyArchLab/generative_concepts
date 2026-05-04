/**
 * StatsPanel — per-section and summary statistics display.
 *
 * Summary rows: Footprint · Apt. area · GBA · Green zone · Population
 *   · Playground / Sports areas with feasibility flags.
 *
 * Green zone display rules:
 *   - no blocks / all zones zero → not shown
 *   - exactly one block → single row  "Green zone: X m²"
 *   - multiple blocks    → one row per block  "Block #k (id): X m²"
 *                          followed by         "Green zone total: Y m²"
 *
 * greenZone argument shape:
 *   { totalArea: number, perBlock: { [blockId]: area }, blockOrder: string[] }
 *
 * playgrounds argument shape:
 *   { perBlock: { [blockId]: { population, areaA, areaB, areaC,
 *                              areaChild, areaSport,
 *                              requiredChild, requiredSport,
 *                              feasibleChild, feasibleSport } },
 *     total: {...same keys},
 *     blockOrder: [blockId, ...] }
 */

function fmtArea(m2) {
  if (m2 >= 1000) return (m2 / 1000).toFixed(1) + 'k m²';
  return Math.round(m2) + ' m²';
}

function fmtSignedArea(m2) {
  var sign = m2 >= 0 ? '+' : '−';
  var abs = Math.abs(m2);
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + 'k m²';
  return sign + Math.round(abs) + ' m²';
}

var SPP_COLOR = '#0369a1';  // sky-700

var GZ_COLOR = '#15803d';
var PG_COLORS = {
  A: '#ca8a04',    // toddler — yellow
  B: '#c2410c',    // active children — orange
  C: '#6d28d9',    // sports + adult leisure — violet
  child: '#ca8a04',
  sport: '#6d28d9'
};

function rowHTML(labelHTML, valueHTML, color) {
  var c = color || GZ_COLOR;
  return '<div class="stats-summary-row">'
    + '<span class="stats-label" style="color:' + c + '">' + labelHTML + '</span>'
    + '<span class="stats-value" style="color:' + c + '">' + valueHTML + '</span>'
    + '</div>';
}

function renderGreenZoneRows(gz) {
  if (gz == null) return '';
  if (typeof gz === 'number') {
    if (gz <= 0) return '';
    return rowHTML('Green zone', fmtArea(gz));
  }

  var order = (gz && gz.blockOrder) ? gz.blockOrder : [];
  var perBlock = (gz && gz.perBlock) ? gz.perBlock : {};
  var total = typeof gz.totalArea === 'number' ? gz.totalArea : 0;

  var visibleIds = [];
  for (var i = 0; i < order.length; i++) {
    var id = order[i];
    if ((perBlock[id] || 0) > 0) visibleIds.push(id);
  }

  if (visibleIds.length === 0) return '';

  if (visibleIds.length === 1) {
    return rowHTML('Green zone', fmtArea(perBlock[visibleIds[0]]));
  }

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

// ── Playgrounds rendering ──────────────────────────────────

/**
 * Compact feasibility marker: ✓ in green or ✗ in red, with required
 * area in parentheses if failing.
 */
function feasMarker(areaHave, areaNeed, passing) {
  if (passing) {
    return '<span style="color:#16a34a;font-weight:600;margin-left:4px">✓</span>';
  }
  var deficit = Math.max(0, areaNeed - areaHave);
  return '<span style="color:#dc2626;font-weight:600;margin-left:4px" title="Need ' + fmtArea(areaNeed) + '">✗ −' + fmtArea(deficit) + '</span>';
}

function renderPlaygroundsRows(pg) {
  if (!pg || !pg.blockOrder || pg.blockOrder.length === 0) return '';

  var order = pg.blockOrder;
  var perBlock = pg.perBlock || {};
  var total = pg.total || {};
  if (total.population <= 0) return '';

  // Build per-block rows (only for blocks with population > 0).
  var visible = [];
  for (var i = 0; i < order.length; i++) {
    var id = order[i];
    var b = perBlock[id];
    if (b && b.population > 0) visible.push(id);
  }

  if (visible.length === 0) return '';

  var h = '<div class="props-divider" style="margin:6px 0"></div>';

  function rowsForBlock(b, prefix) {
    var r = '';
    // Child playgrounds: A + B area vs required
    r += rowHTML(
      prefix + 'Playground <small style="color:var(--text-muted)">A+B · 0.5×pop</small>',
      fmtArea(b.areaChild) + feasMarker(b.areaChild, b.requiredChild, b.feasibleChild),
      PG_COLORS.child
    );
    // Sports: C area vs required
    r += rowHTML(
      prefix + 'Sports <small style="color:var(--text-muted)">C · 0.1×pop</small>',
      fmtArea(b.areaSport) + feasMarker(b.areaSport, b.requiredSport, b.feasibleSport),
      PG_COLORS.sport
    );
    return r;
  }

  if (visible.length === 1) {
    var only = perBlock[visible[0]];
    h += rowsForBlock(only, '');
    return h;
  }

  // Multi-block: one set per block + total at end.
  for (var j = 0; j < visible.length; j++) {
    var bId = visible[j];
    var b = perBlock[bId];
    var prefix = 'Block #' + (j + 1)
      + ' <small style="color:var(--text-muted)">' + bId.slice(0, 5) + '</small> · ';
    h += rowsForBlock(b, prefix);
  }
  // Total
  h += rowHTML(
    '<strong>Playground total</strong> <small style="color:var(--text-muted)">A+B</small>',
    '<strong>' + fmtArea(total.areaChild) + '</strong>'
      + feasMarker(total.areaChild, total.requiredChild, total.feasibleChild),
    PG_COLORS.child
  );
  h += rowHTML(
    '<strong>Sports total</strong> <small style="color:var(--text-muted)">C</small>',
    '<strong>' + fmtArea(total.areaSport) + '</strong>'
      + feasMarker(total.areaSport, total.requiredSport, total.feasibleSport),
    PG_COLORS.sport
  );
  return h;
}

/**
 * Per-block population breakdown. Only shown when there's more than
 * one block (single-block case is already covered by the total).
 */
function renderPopulationPerBlock(pg) {
  if (!pg || !pg.blockOrder || pg.blockOrder.length < 2) return '';
  var perBlock = pg.perBlock || {};
  var order = pg.blockOrder;
  var h = '';
  for (var i = 0; i < order.length; i++) {
    var id = order[i];
    var b = perBlock[id];
    if (!b || b.population <= 0) continue;
    h += '<div class="stats-summary-row">';
    h += '<span class="stats-label" style="color:var(--text-muted);padding-left:8px">'
      + '↳ Block #' + (i + 1)
      + ' <small>' + id.slice(0, 5) + '</small></span>';
    h += '<span class="stats-value" style="color:var(--text-muted)">'
      + b.population + ' ppl</span>';
    h += '</div>';
  }
  return h;
}

/**
 * Per-block SPP (target GBA) progress row. Shows achieved vs target
 * with a signed delta and a feasibility marker. `perBlockSPP` comes
 * from the section-gen processor and only includes blocks whose
 * solverParams.targetSPP > 0 — blocks without a target don't show.
 *
 * Feasibility is "within 5% of target" (matches distributor's own
 * flag); an aboveMax counter shows when sections broke their
 * orientation range (soft breach).
 */
function renderSPPRows(perBlockSPP, blockOrder) {
  if (!perBlockSPP) return '';
  var ids = Object.keys(perBlockSPP);
  if (ids.length === 0) return '';

  var order = (blockOrder && blockOrder.length > 0)
    ? blockOrder.filter(function (id) { return perBlockSPP[id]; })
    : ids;
  if (order.length === 0) return '';

  function oneRow(label, achieved, target, feasible, aboveMax, sectionCount) {
    var delta = achieved - target;
    var deltaPct = target > 0 ? (delta / target) * 100 : 0;
    var okMarker = feasible
      ? '<span style="color:#16a34a;font-weight:600;margin-left:4px">✓</span>'
      : '<span style="color:#dc2626;font-weight:600;margin-left:4px">✗</span>';
    var breachMarker = aboveMax > 0
      ? ' <small style="color:#dc2626" title="Sections above orientation max height">△' + aboveMax + '/' + sectionCount + '</small>'
      : '';
    var value = fmtArea(achieved) + ' / ' + fmtArea(target)
      + ' <small style="color:var(--text-muted)">(' + fmtSignedArea(delta)
      + ', ' + (delta >= 0 ? '+' : '') + deltaPct.toFixed(1) + '%)</small>'
      + okMarker + breachMarker;
    return '<div class="stats-summary-row">'
      + '<span class="stats-label" style="color:' + SPP_COLOR + '">' + label + '</span>'
      + '<span class="stats-value" style="color:' + SPP_COLOR + '">' + value + '</span>'
      + '</div>';
  }

  if (order.length === 1) {
    var only = perBlockSPP[order[0]];
    return oneRow('SPP <small style="color:var(--text-muted)">achieved / target</small>',
      only.achievedSPP, only.targetSPP, only.feasible, only.aboveMaxCount, only.sectionCount);
  }

  var h = '';
  var totalTarget = 0, totalAchieved = 0;
  var allFeasible = true;
  for (var i = 0; i < order.length; i++) {
    var id = order[i];
    var e = perBlockSPP[id];
    totalTarget += e.targetSPP;
    totalAchieved += e.achievedSPP;
    if (!e.feasible) allFeasible = false;
    h += oneRow('SPP · Block #' + (i + 1)
      + ' <small style="color:var(--text-muted)">' + id.slice(0, 5) + '</small>',
      e.achievedSPP, e.targetSPP, e.feasible, e.aboveMaxCount, e.sectionCount);
  }
  h += oneRow('<strong>SPP total</strong>', totalAchieved, totalTarget,
    allFeasible && Math.abs(totalAchieved - totalTarget) < 0.05 * totalTarget,
    0, 0);
  return h;
}

// ── Main render ─────────────────────────────────────────────

export function updateStats(stats, greenZone, playgrounds) {
  var el = document.getElementById('stats-section');
  if (!el) return;
  if (!stats || stats.sections.length === 0) { el.innerHTML = ''; return; }

  var h = '<div class="props-divider"></div>';
  h += '<div class="stats-panel">';

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

  // Per-block SPP progress (only shown for blocks with targetSPP set).
  // blockOrder prefers green-zone ordering so per-block rows align
  // with the rest of the panel; falls back to playgrounds order or
  // object key order.
  var sppBlockOrder = (greenZone && greenZone.blockOrder)
    || (playgrounds && playgrounds.blockOrder)
    || null;
  h += renderSPPRows(stats.perBlockSPP, sppBlockOrder);

  h += renderGreenZoneRows(greenZone);

  h += '<div class="stats-summary-row stats-summary-row--pop">';
  h += '<span class="stats-label">Population <small style="color:var(--text-muted)">/50 m²</small></span>';
  h += '<span class="stats-value stats-value--pop">' + stats.totalPopulation + ' ppl</span>';
  h += '</div>';
  // Per-block population split when multiple blocks.
  h += renderPopulationPerBlock(playgrounds);

  // Playgrounds + sports feasibility
  h += renderPlaygroundsRows(playgrounds);

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

    for (var si2 = 0; si2 < secs.length; si2++) {
      var s = secs[si2];
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
