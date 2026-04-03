/**
 * TorecPlanner — torec assignment across all floors.
 *
 * Step 2: K_total = sum(activeWZ(fl) + 2). Q = round(K_total * alpha / 100).
 * Step 3: For each floor bottom-up, assign min type from remaining to torecs.
 *
 * Each torec contains one WZ (from stacks) + living cells.
 * Lat torec: geometry fixed by LLU position (deterministic type).
 * Lon torec: flexible, type chosen from quota.
 *
 * Pure logic — no rendering, no Three.js.
 */

import { validateApartment, getFlag } from './ApartmentSolver.js';

// ── Step 2: Global Quota ─────────────────────────────

/**
 * Compute global quota from total apartment count and target percentages.
 *
 * @param {number} totalApts - K_total
 * @param {Object} mix - { '1K': 40, '2K': 30, '3K': 20, '4K': 10 }
 * @returns {Object} { '1K': n, '2K': n, '3K': n, '4K': n }
 */
export function computeGlobalQuota(totalApts, mix) {
  var sum = (mix['1K'] || 0) + (mix['2K'] || 0) + (mix['3K'] || 0) + (mix['4K'] || 0);
  if (sum === 0) sum = 100;

  var types = ['1K', '2K', '3K', '4K'];
  var result = {};
  var assigned = 0;
  var fracs = {};

  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    var exact = totalApts * (mix[t] || 0) / sum;
    result[t] = Math.floor(exact);
    fracs[t] = exact - result[t];
    assigned += result[t];
  }

  // Distribute remainder to types with largest fractional parts
  var remaining = totalApts - assigned;
  while (remaining > 0) {
    var bestType = null;
    var bestFrac = -1;
    for (var i = 0; i < types.length; i++) {
      if (fracs[types[i]] > bestFrac) {
        bestFrac = fracs[types[i]];
        bestType = types[i];
      }
    }
    if (bestType) {
      result[bestType]++;
      fracs[bestType] = -1; // used
      remaining--;
    } else {
      break;
    }
  }

  return result;
}

// ── Torec Geometry ───────────────────────────────────

/**
 * Build ordered pool of cells available for a torec.
 * First cells = anchors (highest priority), then expansion cells.
 *
 * @param {'left'|'right'} side
 * @param {number} N - cells per side
 * @param {Array<number>} lluCellIds - LLU cell IDs (already mapped to near or far)
 * @param {string} orientation - 'lat' or 'lon'
 * @returns {Array<number>} ordered cell IDs
 */
function buildTorecPool(side, N, lluCellIds, orientation) {
  var lluSet = {};
  for (var i = 0; i < lluCellIds.length; i++) lluSet[lluCellIds[i]] = true;

  var nearAnchor, farAnchor, nearDir, farDir;
  if (side === 'left') {
    nearAnchor = 0;
    farAnchor = 2 * N - 1;
    nearDir = 1;   // expand rightward
    farDir = -1;   // expand leftward (in far numbering)
  } else {
    nearAnchor = N - 1;
    farAnchor = N;
    nearDir = -1;  // expand leftward
    farDir = 1;    // expand rightward (in far numbering)
  }

  var pool = [nearAnchor, farAnchor];

  if (orientation === 'lat') {
    // Lat: expand towards LLU (adj cells) + along far side
    // Near expansion (towards LLU — these cells have poor insol, good WZ candidates)
    for (var step = 1; step <= N; step++) {
      var nextNear = nearAnchor + nearDir * step;
      if (nextNear < 0 || nextNear >= N) break;
      if (lluSet[nextNear]) break;
      pool.push(nextNear);
    }
    // Far expansion (away from anchor, along far row)
    for (var step = 1; step <= N; step++) {
      var nextFar = farAnchor + farDir * step;
      if (nextFar < N || nextFar >= 2 * N) break;
      if (lluSet[nextFar]) break;
      pool.push(nextFar);
    }
  } else {
    // Lon: expand by pairs inward
    for (var step = 1; step <= 3; step++) {
      var nextNear = nearAnchor + nearDir * step;
      var nextFar = farAnchor + farDir * step;
      var nearOk = nextNear >= 0 && nextNear < N && !lluSet[nextNear];
      var farOk = nextFar >= N && nextFar < 2 * N && !lluSet[nextFar];
      if (!nearOk && !farOk) break;
      if (nearOk) pool.push(nextNear);
      if (farOk) pool.push(nextFar);
    }
  }

  return pool;
}

/**
 * Get max torec capacity (living cells = pool size - 1 for WZ).
 */
function torecMaxLiving(pool) {
  return Math.min(pool.length - 1, 4); // max 4K
}

/**
 * Width (cells) for apartment type.
 */
var TYPE_WIDTH = { '1K': 2, '2K': 3, '3K': 4, '4K': 5 };
var LIVING_COUNT = { '1K': 1, '2K': 2, '3K': 3, '4K': 4 };

/**
 * Build a torec apartment from pool, assigned type, and insolation.
 *
 * @param {Array<number>} pool - ordered cell IDs
 * @param {string} assignedType - '1K'..'4K'
 * @param {Object} insolMap - { cellId: 'p'|'w'|'f' }
 * @param {Array<number>} wzStacks - all WZ stack positions
 * @param {number} N - cells per side
 * @param {Array<number>} sortedCorrNears - corridor near positions
 * @param {number|null} fixedWZ - fixed WZ position (vertical consistency)
 * @returns {Object} apartment
 */
function buildTorecApt(pool, assignedType, insolMap, wzStacks, N, sortedCorrNears, fixedWZ) {
  var needCells = TYPE_WIDTH[assignedType] || 2;
  var takeCells = Math.min(needCells, pool.length);

  // If fixedWZ provided, ensure it's first in pool (always included in selection)
  var orderedPool = pool.slice();
  if (fixedWZ !== null && fixedWZ !== undefined) {
    var fwIdx = -1;
    for (var i = 0; i < orderedPool.length; i++) {
      if (orderedPool[i] === fixedWZ) { fwIdx = i; break; }
    }
    if (fwIdx > 0) {
      // Move to front
      orderedPool.splice(fwIdx, 1);
      orderedPool.unshift(fixedWZ);
    } else if (fwIdx < 0) {
      // Not in pool — prepend it
      orderedPool.unshift(fixedWZ);
      takeCells = Math.min(needCells, orderedPool.length);
    }
  }

  // Select cells from ordered pool
  var selectedCells = [];
  for (var i = 0; i < takeCells; i++) selectedCells.push(orderedPool[i]);

  // ── WZ selection: fixed position for vertical consistency ──
  var FLAG_SCORE = { 'f': 0, 'w': 1, 'p': 2 };
  var wzCell = null;

  if (fixedWZ !== null && fixedWZ !== undefined) {
    wzCell = fixedWZ;
  }

  // Fallback: dynamic WZ selection (only if fixedWZ not provided)
  if (wzCell === null) {
    var wzStackSet = {};
    for (var i = 0; i < wzStacks.length; i++) wzStackSet[wzStacks[i]] = true;

    wzCell = selectedCells[0]; // default
    var bestWZScore = 99;

    // First: try wzStack cells (vertical alignment)
    for (var i = 0; i < selectedCells.length; i++) {
      if (wzStackSet[selectedCells[i]]) {
        var f = getFlag(insolMap, selectedCells[i]);
        var s = FLAG_SCORE[f] !== undefined ? FLAG_SCORE[f] : 2;
        if (s < bestWZScore) {
          bestWZScore = s;
          wzCell = selectedCells[i];
        }
      }
    }

    // Fallback: worst insol cell
    if (bestWZScore === 99) {
      for (var i = 0; i < selectedCells.length; i++) {
        var f = getFlag(insolMap, selectedCells[i]);
        var s = FLAG_SCORE[f] !== undefined ? FLAG_SCORE[f] : 2;
        if (s < bestWZScore) {
          bestWZScore = s;
          wzCell = selectedCells[i];
        }
      }
    }
  }

  // Living cells = all selected except WZ
  var livingCells = [];
  for (var i = 0; i < selectedCells.length; i++) {
    if (selectedCells[i] !== wzCell) livingCells.push(selectedCells[i]);
  }

  // Validate insolation
  var flags = [];
  for (var i = 0; i < livingCells.length; i++) flags.push(getFlag(insolMap, livingCells[i]));
  var v = validateApartment(flags);

  // Determine actual type from living count
  var actualLiving = livingCells.length;
  var actualType = actualLiving >= 4 ? '4K' : actualLiving >= 3 ? '3K' : actualLiving >= 2 ? '2K' : '1K';

  // Build cells array: numeric cells + corridor labels
  var cells = [];
  for (var i = 0; i < selectedCells.length; i++) cells.push(selectedCells[i]);

  // Add corridors where both near and far are in apartment
  var cellSet = {};
  for (var i = 0; i < selectedCells.length; i++) cellSet[selectedCells[i]] = true;

  var corridorLabel = null;
  for (var i = 0; i < sortedCorrNears.length; i++) {
    var nearC = sortedCorrNears[i];
    var farC = 2 * N - 1 - nearC;
    if (cellSet[nearC] && cellSet[farC]) {
      var label = nearC + '-' + farC;
      cells.push(label);
      if (!corridorLabel) corridorLabel = label;
    }
  }

  return {
    cells: cells,
    wetCell: wzCell,
    livingCells: livingCells,
    type: actualType,
    valid: v.valid,
    torec: true,
    corridorLabel: corridorLabel
  };
}

// ── Step 3: Assign Torecs ────────────────────────────

/**
 * Assign torec types across all floors.
 * Bottom-up: min available type from remaining quota.
 *
 * @param {Object} params
 * @param {number} params.N
 * @param {number} params.floorCount - total floors (including commercial)
 * @param {Array<number>} params.wzStacks - WZ positions from floor 1
 * @param {Array<Object>} params.floor1Apartments - floor 1 apartments (from solver)
 * @param {Object} params.mix - { '1K': 40, ... }
 * @param {Array<number>} params.lluCellIds - LLU cell IDs
 * @param {Array<number>} params.sortedCorrNears - corridor near positions
 * @param {string} params.orientation - 'lat' or 'lon'
 * @param {Object} params.perFloorInsol - { floorNum: { cellId: 'p'|'w'|'f' } }
 * @returns {Object} { floors, quota, remaining, totalPlaced, deviation }
 */
export function planTorecs(params) {
  var N = params.N;
  var floorCount = params.floorCount;
  var wzStacks = params.wzStacks || [];
  var floor1Apartments = params.floor1Apartments || [];
  var mix = params.mix;
  var lluCellIds = params.lluCellIds || [];
  var sortedCorrNears = params.sortedCorrNears || [];
  var orientation = params.orientation || 'lon';
  var perFloorInsol = params.perFloorInsol || {};

  var residentialFloors = floorCount - 1;
  if (residentialFloors < 1) {
    return {
      floors: [], quota: {}, remaining: {}, totalPlaced: {},
      deviation: {}, totalTarget: 0, totalActual: 0
    };
  }

  // ── Step 1: Count total apartments ──
  // For now: all WZ active on all floors (no deactivation yet)
  var aptsPerFloor = wzStacks.length + 2; // WZ + 2 torecs
  var K_total = aptsPerFloor * residentialFloors;

  console.log('[TorecPlanner] K_total=' + K_total +
    ' (WZ=' + wzStacks.length + ' + 2 torecs) × ' + residentialFloors + ' floors');

  // ── Step 2: Global quota ──
  var quota = computeGlobalQuota(K_total, mix);
  console.log('[TorecPlanner] quota:', JSON.stringify(quota));

  // ── Build torec pools ──
  var leftPool = buildTorecPool('left', N, lluCellIds, orientation);
  var rightPool = buildTorecPool('right', N, lluCellIds, orientation);

  var leftMaxLiving = torecMaxLiving(leftPool);
  var rightMaxLiving = torecMaxLiving(rightPool);

  console.log('[TorecPlanner] leftPool:', leftPool.join(','),
    'maxLiving=' + leftMaxLiving);
  console.log('[TorecPlanner] rightPool:', rightPool.join(','),
    'maxLiving=' + rightMaxLiving);

  // ── Step 3: Assign torecs bottom-up ──
  var remaining = {
    '1K': quota['1K'] || 0,
    '2K': quota['2K'] || 0,
    '3K': quota['3K'] || 0,
    '4K': quota['4K'] || 0
  };

  // Floor 1: subtract from quota
  var floor1Placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
  for (var i = 0; i < floor1Apartments.length; i++) {
    var t = floor1Apartments[i].type;
    if (floor1Placed[t] !== undefined) floor1Placed[t]++;
  }
  remaining['1K'] -= floor1Placed['1K'];
  remaining['2K'] -= floor1Placed['2K'];
  remaining['3K'] -= floor1Placed['3K'];
  remaining['4K'] -= floor1Placed['4K'];

  // ── Extract fixed torec WZ from floor 1 ──
  // WZ position in torec must be stable across all floors.
  // Once a position is WZ on floor 1, it stays WZ on all upper floors.
  // If it becomes living → stack is broken forever.
  var leftTorecWZ = null;
  var rightTorecWZ = null;
  for (var i = 0; i < floor1Apartments.length; i++) {
    var apt = floor1Apartments[i];
    if (!apt.torec) continue;
    var hasCellZero = false;
    var hasCellNm1 = false;
    var cells = apt.cells || [];
    for (var ci = 0; ci < cells.length; ci++) {
      if (cells[ci] === 0 || cells[ci] === 2 * N - 1) hasCellZero = true;
      if (cells[ci] === N - 1 || cells[ci] === N) hasCellNm1 = true;
    }
    if (hasCellZero && leftTorecWZ === null) leftTorecWZ = apt.wetCell;
    if (hasCellNm1 && rightTorecWZ === null) rightTorecWZ = apt.wetCell;
  }
  console.log('[TorecPlanner] fixed WZ: left=' + leftTorecWZ + ' right=' + rightTorecWZ);

  var floors = [];
  // Floor 1: keep as-is
  floors.push({
    floor: 1,
    apartments: floor1Apartments,
    placed: floor1Placed,
    activeWZ: wzStacks.length
  });

  var types = ['1K', '2K', '3K', '4K'];

  // ── Build torec type sequence: proportional to remaining, sorted small→large ──
  var torecCount = (residentialFloors - 1) * 2; // floors 2..K, 2 torecs each
  var maxCap = Math.max(leftMaxLiving, rightMaxLiving);
  var torecSeq = buildTorecSequence(remaining, torecCount, maxCap);

  console.log('[TorecPlanner] torec sequence (' + torecSeq.length + '):', torecSeq.join(','));

  var seqIdx = 0;
  for (var fl = 2; fl <= residentialFloors; fl++) {
    var insolMap = perFloorInsol[fl] || {};

    // Take next 2 types from sequence
    var leftType = seqIdx < torecSeq.length ? torecSeq[seqIdx++] : '1K';
    var rightType = seqIdx < torecSeq.length ? torecSeq[seqIdx++] : '1K';

    // Cap by actual pool capacity
    if (LIVING_COUNT[leftType] > leftMaxLiving) leftType = capType(leftMaxLiving);
    if (LIVING_COUNT[rightType] > rightMaxLiving) rightType = capType(rightMaxLiving);

    remaining[leftType]--;
    remaining[rightType]--;

    // Build apartments
    var floorApts = [];

    var leftApt = buildTorecApt(leftPool, leftType, insolMap, wzStacks, N, sortedCorrNears, leftTorecWZ);
    floorApts.push(leftApt);

    var rightApt = buildTorecApt(rightPool, rightType, insolMap, wzStacks, N, sortedCorrNears, rightTorecWZ);
    floorApts.push(rightApt);

    var flPlaced = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
    for (var i = 0; i < floorApts.length; i++) {
      var at = floorApts[i].type;
      if (flPlaced[at] !== undefined) flPlaced[at]++;
    }

    floors.push({
      floor: fl,
      apartments: floorApts,
      placed: flPlaced,
      activeWZ: wzStacks.length
    });
  }

  // ── Totals ──
  var totalPlaced = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
  for (var fi = 0; fi < floors.length; fi++) {
    for (var i = 0; i < types.length; i++) {
      totalPlaced[types[i]] += (floors[fi].placed[types[i]] || 0);
    }
  }

  var totalActual = totalPlaced['1K'] + totalPlaced['2K'] + totalPlaced['3K'] + totalPlaced['4K'];

  var deviation = {};
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    var tPct = K_total > 0 ? Math.round(quota[t] / K_total * 100) : 0;
    var aPct = totalActual > 0 ? Math.round(totalPlaced[t] / totalActual * 100) : 0;
    deviation[t] = {
      target: quota[t],
      actual: totalPlaced[t],
      targetPct: tPct,
      actualPct: aPct,
      delta: totalPlaced[t] - quota[t]
    };
  }

  console.log('[TorecPlanner] totalPlaced:', JSON.stringify(totalPlaced));
  console.log('[TorecPlanner] remaining after torecs:', JSON.stringify(remaining));

  return {
    floors: floors,
    quota: quota,
    remaining: remaining,
    totalPlaced: totalPlaced,
    deviation: deviation,
    totalTarget: K_total,
    totalActual: totalActual,
    orphanCount: 0,
    feasible: true,
    deviationScore: 0
  };
}

/**
 * Build torec type sequence: proportional to remaining, sorted small→large.
 * Small types go to lower floors, large to upper — natural gradient.
 *
 * @param {Object} remaining - { '1K': n, ... }
 * @param {number} count - total torec slots
 * @param {number} maxLiving - max living cells in any torec
 * @returns {Array<string>} sorted types ['1K','1K','2K','2K','3K',...]
 */
function buildTorecSequence(remaining, count, maxLiving) {
  var types = ['1K', '2K', '3K', '4K'];
  var living = { '1K': 1, '2K': 2, '3K': 3, '4K': 4 };

  // Filter to types that fit
  var sumR = 0;
  for (var i = 0; i < types.length; i++) {
    if (living[types[i]] <= maxLiving && (remaining[types[i]] || 0) > 0) {
      sumR += remaining[types[i]];
    }
  }
  if (sumR === 0) {
    var seq = [];
    for (var i = 0; i < count; i++) seq.push('1K');
    return seq;
  }

  // Proportional allocation
  var alloc = {};
  var assigned = 0;
  var fracs = {};
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    if (living[t] > maxLiving || (remaining[t] || 0) <= 0) {
      alloc[t] = 0;
      fracs[t] = 0;
      continue;
    }
    var exact = count * (remaining[t] || 0) / sumR;
    alloc[t] = Math.floor(exact);
    fracs[t] = exact - alloc[t];
    assigned += alloc[t];
  }

  // Distribute remainder
  var left = count - assigned;
  while (left > 0) {
    var bestT = null;
    var bestF = -1;
    for (var i = 0; i < types.length; i++) {
      if (living[types[i]] > maxLiving) continue;
      if (fracs[types[i]] > bestF) {
        bestF = fracs[types[i]];
        bestT = types[i];
      }
    }
    if (bestT) {
      alloc[bestT]++;
      fracs[bestT] = -1;
      left--;
    } else break;
  }

  // Build sorted sequence: 1K first (bottom floors), 4K last (top floors)
  var seq = [];
  for (var i = 0; i < types.length; i++) {
    var n = alloc[types[i]] || 0;
    for (var j = 0; j < n; j++) seq.push(types[i]);
  }
  return seq;
}

/**
 * Cap type to fit within max living capacity.
 */
function capType(maxLiving) {
  if (maxLiving >= 4) return '4K';
  if (maxLiving >= 3) return '3K';
  if (maxLiving >= 2) return '2K';
  return '1K';
}
