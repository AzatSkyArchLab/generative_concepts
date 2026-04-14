/**
 * FloorPlanReport — HTML report with proportionally scaled floor plans.
 * Cell sizes match actual geometry (cellWidth, sectionWidth, corridorWidth).
 * PDF export via window.print().
 */

import { APT_COLORS_REPORT as APT_COLORS } from '../core/constants/ApartmentColors.js';
import { corridorLabel as makeCorrLabel, farToNear } from '../core/apartments/CellTopology.js';

// Pixels per meter for report rendering
var PX_PER_M = 14;

export function generateReport(buildingPlans, graphDataMap) {
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8">';
  html += '<title>U·B·SYSTEM — Floor Plans Report</title>';
  html += '<style>' + getCSS() + '</style></head><body>';
  html += '<div class="report-header">';
  html += '<h1>U·B·SYSTEM — Floor Plans Report</h1>';
  html += '<button class="pdf-btn" onclick="window.print()">Export PDF</button>';
  html += '</div>';

  for (var planKey in buildingPlans) {
    if (!buildingPlans.hasOwnProperty(planKey)) continue;
    var plan = buildingPlans[planKey];
    var graphData = graphDataMap[planKey];
    if (!graphData) continue;

    var p = graphData.params;
    var aptDepth = (p.sectionWidth - p.corridorWidth) / 2.0;

    html += '<div class="section-block">';
    html += '<h2>Section: ' + planKey.split('_')[0].slice(0, 8) + ' #' + (parseInt(planKey.split('_')[1]) + 1) + '</h2>';
    html += '<div class="section-meta">';
    html += 'Cell: ' + p.cellWidth.toFixed(1) + 'm · Section: ' + p.sectionWidth.toFixed(1) + 'm';
    html += ' · Corridor: ' + p.corridorWidth.toFixed(1) + 'm · Apt depth: ' + aptDepth.toFixed(1) + 'm';
    html += ' · N: ' + graphData.N + ' cells/side · Floors: ' + graphData.floorCount;
    html += '</div>';
    html += renderDeviation(plan);
    html += '<div class="profile-info">WZ Profile: ';
    if (plan.profile) html += plan.profile.join(' → ');
    html += '</div>';

    for (var fi = plan.floors.length - 1; fi >= 0; fi--) {
      var flInsol = (graphData.perFloorInsol && graphData.perFloorInsol[plan.floors[fi].floor]) || {};
      html += renderFloorPlan(plan.floors[fi], graphData, aptDepth, flInsol);
    }

    // Debug dump
    html += renderDebugDump(planKey, plan, graphData);
    html += '</div>';
  }

  html += '</body></html>';
  var win = window.open('', '_blank');
  if (win) { win.document.write(html); win.document.close(); }
}

function renderDeviation(plan) {
  var h = '<table class="dev-table"><tr><th>Type</th><th>Target</th><th>Actual</th><th>Δ</th></tr>';
  var types = ['1K', '2K', '3K', '4K'];
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    var d = plan.deviation[t] || { target: 0, actual: 0, delta: 0, targetPct: 0, actualPct: 0 };
    var cls = d.delta === 0 ? 'ok' : (d.delta > 0 ? 'over' : 'under');
    var ds = d.delta > 0 ? '+' + d.delta : String(d.delta);
    h += '<tr><td class="type-cell" style="background:' + APT_COLORS[t].living + '">' + t + '</td>';
    h += '<td>' + d.target + ' <small>(' + d.targetPct + '%)</small></td>';
    h += '<td>' + d.actual + ' <small>(' + d.actualPct + '%)</small></td>';
    h += '<td class="' + cls + '">' + ds + '</td></tr>';
  }
  h += '<tr class="total-row"><td>Total</td><td>' + plan.totalTarget + '</td><td>' + plan.totalActual + '</td><td></td></tr>';
  if (plan.orphanCount > 0) h += '<tr><td colspan="4" class="under">Orphans: ' + plan.orphanCount + '</td></tr>';
  h += '</table>';
  return h;
}

function renderFloorPlan(floorData, graphData, aptDepth, insolMap) {
  var fl = floorData.floor;
  var apts = floorData.apartments || [];
  var N = graphData.N;
  var nodes = graphData.nodes;
  var p = graphData.params;

  var cellW = Math.round(p.cellWidth * PX_PER_M);
  var nearH = Math.round(aptDepth * PX_PER_M);
  var corrH = Math.round(p.corridorWidth * PX_PER_M);
  var farH = nearH;

  // Cell → apartment map
  var cellMap = {};
  for (var ai = 0; ai < apts.length; ai++) {
    var apt = apts[ai];
    var cells = apt.cells || [];
    for (var ci = 0; ci < cells.length; ci++) {
      var cid = cells[ci];
      var role;
      if (typeof cid === 'string') role = 'corridor';
      else if (cid === apt.wetCell) role = 'wet';
      else role = 'living';
      cellMap[cid] = { aptIdx: ai, type: apt.type, role: role, valid: apt.valid };
    }
    // Ensure corridorLabel is mapped even if not in cells (floor 1 torec)
    if (apt.corridorLabel && !cellMap[apt.corridorLabel]) {
      cellMap[apt.corridorLabel] = { aptIdx: ai, type: apt.type, role: 'corridor', valid: apt.valid };
    }
  }

  // Collect nodes
  var nearCells = [];
  var farCells = [];
  var corrCells = [];
  for (var key in nodes) {
    if (!nodes.hasOwnProperty(key)) continue;
    var node = nodes[key];
    if (node.floor !== 1) continue;
    if (typeof node.cellId === 'number') {
      if (node.cellId < N) nearCells.push(node);
      else farCells.push(node);
    } else if (node.type === 'corridor') corrCells.push(node);
  }
  nearCells.sort(function (a, b) { return a.cellId - b.cellId; });
  farCells.sort(function (a, b) { return a.cellId - b.cellId; });
  corrCells.sort(function (a, b) {
    var na = parseInt(String(a.cellId).split('-')[0]);
    var nb = parseInt(String(b.cellId).split('-')[0]);
    return na - nb;
  });

  // Summary
  var tc = { '1K': 0, '2K': 0, '3K': 0, '4K': 0, orphan: 0 };
  for (var ai = 0; ai < apts.length; ai++) {
    if (tc[apts[ai].type] !== undefined) tc[apts[ai].type]++;
    else tc.orphan++;
  }
  var summary = [];
  for (var t in tc) { if (tc[t] > 0) summary.push(t + ':' + tc[t]); }

  var totalW = nearCells.length * (cellW + 1) + 2;
  var h = '<div class="floor-block">';
  h += '<div class="floor-header">Floor ' + (fl + 1);
  h += '<span class="floor-meta"> ' + apts.length + ' apts · WZ:' + (floorData.activeWZ || '?');
  h += ' · ' + summary.join(' ') + '</span></div>';

  h += '<div class="floor-grid" style="width:' + totalW + 'px">';

  // Helper: get group ID for a cell.
  // Apartments → aptIdx (0+), LLU → -100 (shared group), unowned corridors → -200 (shared group), other → -1
  var LLU_GROUP = -100;
  var CORR_GROUP = -200;
  function aptIdx(cellId) {
    var ci = cellMap[cellId];
    if (ci) return ci.aptIdx;
    // Check if LLU
    if (typeof cellId === 'number') {
      for (var nk in nodes) {
        if (!nodes.hasOwnProperty(nk)) continue;
        var nd = nodes[nk];
        if (nd.floor === 1 && nd.cellId === cellId && nd.type === 'llu') return LLU_GROUP;
      }
    }
    // Unowned corridor
    if (typeof cellId === 'string' && cellId.indexOf('-') >= 0) return CORR_GROUP;
    return -1;
  }

  // Near row
  h += '<div class="cell-row">';
  for (var i = 0; i < nearCells.length; i++) {
    var cid = nearCells[i].cellId;
    var prevApt = i > 0 ? aptIdx(nearCells[i - 1].cellId) : -2;
    var nextApt = i < nearCells.length - 1 ? aptIdx(nearCells[i + 1].cellId) : -2;
    var myApt = aptIdx(cid);
    var corrId = makeCorrLabel(cid, N);
    var corrApt = aptIdx(corrId);
    var borders = {
      left: i === 0 || myApt !== prevApt || myApt === -1,
      right: i === nearCells.length - 1 || myApt !== nextApt || myApt === -1,
      top: true,  // exterior facade
      bottom: myApt === -1 || myApt !== corrApt
    };
    h += renderCell(cid, cellMap, cellW, nearH, nearCells[i].type, insolMap, borders);
  }
  h += '</div>';

  // Corridor row
  h += '<div class="cell-row">';
  for (var i = 0; i < corrCells.length; i++) {
    var cid = String(corrCells[i].cellId);
    var parts = cid.split('-');
    var nearC = parseInt(parts[0]);
    var farC = parseInt(parts[1]);
    var prevCorrId = i > 0 ? String(corrCells[i - 1].cellId) : null;
    var nextCorrId = i < corrCells.length - 1 ? String(corrCells[i + 1].cellId) : null;
    var myApt = aptIdx(cid);
    var nearApt = aptIdx(nearC);
    var farApt = aptIdx(farC);
    var prevApt = prevCorrId ? aptIdx(prevCorrId) : -2;
    var nextApt = nextCorrId ? aptIdx(nextCorrId) : -2;
    var borders = {
      left: i === 0 || myApt !== prevApt || myApt === -1,
      right: i === corrCells.length - 1 || myApt !== nextApt || myApt === -1,
      top: myApt === -1 || myApt !== nearApt,
      bottom: myApt === -1 || myApt !== farApt
    };
    h += renderCell(cid, cellMap, cellW, corrH, 'corridor', insolMap, borders);
  }
  h += '</div>';

  // Far row (reversed to match spatial)
  h += '<div class="cell-row">';
  for (var i = farCells.length - 1; i >= 0; i--) {
    var cid = farCells[i].cellId;
    // In display: left neighbor = farCells[i+1], right = farCells[i-1] (reversed)
    var prevApt = i < farCells.length - 1 ? aptIdx(farCells[i + 1].cellId) : -2;
    var nextApt = i > 0 ? aptIdx(farCells[i - 1].cellId) : -2;
    var myApt = aptIdx(cid);
    var nearC = farToNear(cid, N);
    var corrId = nearC + '-' + cid;
    var corrApt = aptIdx(corrId);
    var borders = {
      left: i === farCells.length - 1 || myApt !== prevApt || myApt === -1,
      right: i === 0 || myApt !== nextApt || myApt === -1,
      top: myApt === -1 || myApt !== corrApt,
      bottom: true  // exterior facade
    };
    h += renderCell(cid, cellMap, cellW, farH, farCells[i].type, insolMap, borders);
  }
  h += '</div>';

  h += '</div></div>';
  return h;
}

function renderCell(cellId, cellMap, w, h, nodeType, insolMap, aptBorders) {
  var info = cellMap[cellId];
  var bg = '#e8e8e8';
  var label = String(cellId);
  var sub = '';

  // Insol flag for numeric cells
  var insolFlag = '';
  if (insolMap && typeof cellId === 'number' && insolMap[cellId]) {
    insolFlag = insolMap[cellId];
  }

  if (nodeType === 'llu') { bg = '#4f81bd'; label = 'LLU'; }
  else if (nodeType === 'corridor' && !info) { bg = '#d0d0d0'; label = ''; }

  if (info) {
    var pal = APT_COLORS[info.type] || APT_COLORS['orphan'];
    bg = (info.role === 'wet' || info.role === 'corridor') ? pal.wet : pal.living;
    sub = 'A' + info.aptIdx + ' ' + info.type;
    if (info.role === 'wet') sub += ' wz';
    else if (info.role === 'corridor') sub += ' corr';
    else if (insolFlag) sub += ' ' + insolFlag;
  } else if (insolFlag) {
    sub = insolFlag;
  }

  // Insol flag color indicator
  var flagDot = '';
  if (insolFlag === 'p') flagDot = '<span class="flag-dot flag-p"></span>';
  else if (insolFlag === 'w') flagDot = '<span class="flag-dot flag-w"></span>';
  else if (insolFlag === 'f') flagDot = '<span class="flag-dot flag-f"></span>';

  // Apartment boundary borders: thick dark on edges between apartments, thin inside
  var bT = '1px solid rgba(0,0,0,0.08)';
  var bR = bT; var bB = bT; var bL = bT;
  var APT_BORDER = '2px solid #333';
  if (aptBorders) {
    if (aptBorders.left) bL = APT_BORDER;
    if (aptBorders.right) bR = APT_BORDER;
    if (aptBorders.top) bT = APT_BORDER;
    if (aptBorders.bottom) bB = APT_BORDER;
  }
  if (info && !info.valid) { bT = '2px solid #e53e3e'; bR = bT; bB = bT; bL = bT; }
  var borderStyle = bT + ';border-right:' + bR + ';border-bottom:' + bB + ';border-left:' + bL;

  var s = '<div class="cell" style="width:' + w + 'px;height:' + h + 'px;background:' + bg + ';border-top:' + borderStyle + '">';
  s += '<div class="cell-id">' + label + flagDot + '</div>';
  if (sub) s += '<div class="cell-sub">' + sub + '</div>';
  s += '</div>';
  return s;
}

function renderDebugDump(planKey, plan, graphData) {
  var N = graphData.N;
  var insol = graphData.perFloorInsol || {};
  var allWZ = plan.profile ? [] : [];

  var lines = [];
  lines.push('=== DEBUG: ' + planKey + ' ===');
  lines.push('N=' + N + ' floorCount=' + graphData.floorCount);
  lines.push('profile: [' + (plan.profile ? plan.profile.join(',') : '?') + ']');
  lines.push('target: ' + JSON.stringify(plan.originalQuota));
  lines.push('actual: ' + JSON.stringify(plan.totalPlaced));
  lines.push('score: ' + (plan.deviationScore || '?'));
  lines.push('');

  for (var fi = 0; fi < plan.floors.length; fi++) {
    var fd = plan.floors[fi];
    var fl = fd.floor;
    var flInsol = insol[fl] || {};
    lines.push('--- Floor ' + (fl + 1) + ' (activeWZ: ' + (fd.activeWZ || '?') + ') ---');

    // Collect all WZ for this floor
    var wzSet = {};
    for (var ai = 0; ai < fd.apartments.length; ai++) {
      var wc = fd.apartments[ai].wetCell;
      if (wc !== undefined && wc !== null) wzSet[wc] = true;
    }

    // Near row dump
    var nearLine = 'Near: ';
    for (var c = 0; c < N; c++) {
      nearLine += fmtCell(c, fd, flInsol, wzSet, graphData) + ' ';
    }
    lines.push(nearLine.trim());

    // Far row dump
    var farLine = 'Far:  ';
    for (var c = N; c < 2 * N; c++) {
      farLine += fmtCell(c, fd, flInsol, wzSet, graphData) + ' ';
    }
    lines.push(farLine.trim());

    // Apartments summary
    for (var ai = 0; ai < fd.apartments.length; ai++) {
      var apt = fd.apartments[ai];
      var cellStr = '';
      var cells = apt.cells || [];
      for (var ci = 0; ci < cells.length; ci++) {
        var cid = cells[ci];
        var role;
        if (typeof cid === 'string') role = 'corr';
        else if (cid === apt.wetCell) role = 'wz';
        else role = 'liv';
        var flag = (typeof cid === 'number' && flInsol[cid]) ? flInsol[cid] : '-';
        cellStr += cid + '(' + role + '/' + flag + ')';
        if (ci < cells.length - 1) cellStr += ',';
      }
      // Show corridorLabel if not already in cells
      if (apt.corridorLabel && cellStr.indexOf(apt.corridorLabel) < 0) {
        cellStr += ',' + apt.corridorLabel + '(corr/-)';
      }
      var validStr = apt.valid ? 'OK' : 'FAIL';
      lines.push('  A' + ai + ' ' + apt.type + ' [' + validStr + '] cells=[' + cellStr + ']');
    }
    lines.push('');
  }

  var txt = lines.join('\n');
  var h = '<div class="debug-section">';
  h += '<div class="debug-header">Debug Dump <button class="copy-btn" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.textContent)">Copy</button></div>';
  h += '<pre class="debug-pre">' + escapeHtml(txt) + '</pre>';
  h += '</div>';
  return h;
}

function fmtCell(cellId, floorData, flInsol, wzSet, graphData) {
  // Check if LLU
  var nodes = graphData.nodes;
  for (var key in nodes) {
    if (!nodes.hasOwnProperty(key)) continue;
    var node = nodes[key];
    if (node.floor === 1 && node.cellId === cellId && node.type === 'llu') return '[LLU]';
  }

  var isWZ = wzSet[cellId] ? true : false;
  var flag = flInsol[cellId] || '-';

  // Find apartment for this cell
  var aptInfo = null;
  for (var ai = 0; ai < floorData.apartments.length; ai++) {
    var apt = floorData.apartments[ai];
    var cells = apt.cells || [];
    for (var ci = 0; ci < cells.length; ci++) {
      if (cells[ci] === cellId) {
        var role = cellId === apt.wetCell ? 'wz' : 'liv';
        aptInfo = { ai: ai, type: apt.type, role: role, valid: apt.valid };
        break;
      }
    }
    if (aptInfo) break;
  }

  if (!aptInfo) return cellId + '(?/' + flag + ')';
  var v = aptInfo.valid ? '' : '!';
  return cellId + '(A' + aptInfo.ai + '.' + aptInfo.type + v + '.' + aptInfo.role + '/' + flag + ')';
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getCSS() {
  return [
    '* { box-sizing: border-box; }',
    'body { font-family: -apple-system, "Segoe UI", sans-serif; margin: 20px; background: #0f172a; color: #e2e8f0; }',
    '@media print { body { background: white; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; } .pdf-btn { display:none; } .section-block { break-inside: avoid; background: #f8f9fa !important; } .floor-block { break-inside: avoid; background: #fff !important; } .dev-table th { background: #e5e7eb !important; color: #111 !important; } .cell { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; } h1, h2, .floor-header, .profile-info, .section-meta { color: #111 !important; } .floor-meta { color: #555 !important; } }',
    '.report-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }',
    'h1 { font-size: 16px; color: #7eb8da; margin: 0; }',
    '.pdf-btn { padding: 6px 16px; border: none; border-radius: 6px; background: #3b82f6; color: white; font-size: 12px; font-weight: 600; cursor: pointer; }',
    '.pdf-btn:hover { background: #2563eb; }',
    'h2 { font-size: 13px; color: #94a3b8; margin: 12px 0 4px; }',
    '.section-block { margin-bottom: 24px; padding: 12px; background: #1e293b; border-radius: 8px; }',
    '.section-meta { font-size: 10px; color: #64748b; margin-bottom: 8px; font-family: "SF Mono", "Fira Code", monospace; }',
    '.profile-info { font-size: 10px; color: #64748b; margin-bottom: 10px; font-family: "SF Mono", monospace; }',
    '.dev-table { border-collapse: collapse; margin-bottom: 12px; font-size: 10px; font-family: "SF Mono", monospace; }',
    '.dev-table th, .dev-table td { padding: 2px 8px; border: 1px solid #334155; text-align: center; }',
    '.dev-table th { background: #1e293b; color: #94a3b8; font-weight: 600; }',
    '.type-cell { font-weight: 700; color: #111; }',
    '.total-row td { font-weight: 600; border-top: 2px solid #475569; }',
    '.ok { color: #22c55e; font-weight: 600; }',
    '.over { color: #f59e0b; font-weight: 600; }',
    '.under { color: #ef4444; font-weight: 600; }',
    '.floor-block { margin: 6px 0; padding: 6px 8px; background: #0f172a; border-radius: 4px; border-left: 3px solid #334155; }',
    '.floor-header { font-size: 11px; font-weight: 600; color: #7eb8da; margin-bottom: 4px; }',
    '.floor-meta { font-weight: 400; color: #64748b; font-size: 9px; }',
    '.floor-grid { overflow-x: auto; padding: 2px 0; }',
    '.cell-row { display: flex; gap: 1px; margin-bottom: 1px; }',
    '.cell { display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: 2px; flex-shrink: 0; overflow: hidden; position: relative; }',
    '.cell-id { font-size: 8px; font-weight: 700; color: #333; font-family: "SF Mono", monospace; line-height: 1; }',
    '.cell-sub { font-size: 6px; color: #555; white-space: nowrap; font-family: "SF Mono", monospace; line-height: 1; margin-top: 1px; }',
    '.flag-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-left: 2px; vertical-align: middle; }',
    '.flag-p { background: #22c55e; }',
    '.flag-w { background: #f59e0b; }',
    '.flag-f { background: #ef4444; }',
    '.debug-section { margin-top: 16px; border-top: 2px solid #334155; padding-top: 12px; }',
    '.debug-header { font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }',
    '.copy-btn { padding: 2px 10px; border: 1px solid #475569; border-radius: 4px; background: #1e293b; color: #94a3b8; font-size: 10px; cursor: pointer; }',
    '.copy-btn:hover { background: #334155; color: #e2e8f0; }',
    '.debug-pre { background: #0a0e1a; border: 1px solid #1e293b; border-radius: 4px; padding: 10px; font-size: 9px; font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace; color: #a5f3b4; overflow-x: auto; white-space: pre; line-height: 1.5; max-height: 600px; overflow-y: auto; }',
    '@media print { .debug-section { display: none; } }',
  ].join('\n');
}
