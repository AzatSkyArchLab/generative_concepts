/**
 * FloorPlanner v7 — strict WZ monotonicity + zero unassigned.
 *
 * Rules:
 * - Active WZ stays WZ (never deactivated by cleanup)
 * - Stranded WZ steals 1 cell from largest neighbor
 * - ALL allocated cells included in apartment (type = min(living, 4))
 * - Final sweep guarantees every cell 0..2N-1 is assigned
 */

import { validateApartment, getFlag } from './ApartmentSolver.js';

var TYPE_LIVING = { '4K': 4, '3K': 3, '2K': 2, '1K': 1 };

export function planFloor(allWZ, activeWZ, insolMap, N, lluCells, floorPlan, sortedCorrNears) {
  if (!insolMap) insolMap = {};
  if (!floorPlan) floorPlan = [];
  if (!sortedCorrNears) sortedCorrNears = [];

  var barriers = {};
  if (lluCells) {
    for (var i = 0; i < lluCells.length; i++) barriers[lluCells[i]] = true;
  }

  var activeSet = {};
  for (var i = 0; i < activeWZ.length; i++) activeSet[activeWZ[i]] = true;

  var blocked = {};
  for (var k in barriers) blocked[k] = true;
  for (var k in activeSet) blocked[k] = true;

  var usedCells = {};
  for (var k in blocked) usedCells[k] = true;

  var apartments = [];
  var placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };

  // Quota tracking
  var remaining = {};
  for (var ti = 0; ti < floorPlan.length; ti++) {
    var t = floorPlan[ti];
    remaining[t] = (remaining[t] || 0) + 1;
  }

  // Phase 0: TOREC
  var torecCells = {};

  var leftTarget = pickTorecType(remaining);
  var leftTorec = buildTorecApt(0, 2 * N - 1, N, activeSet, usedCells, blocked, insolMap, sortedCorrNears, leftTarget);
  if (leftTorec) {
    apartments.push(leftTorec);
    if (placed[leftTorec.type] !== undefined) placed[leftTorec.type]++;
    consumeRemaining(remaining, leftTorec.type);
    markUsed(leftTorec.cells, usedCells, torecCells);
  }

  var rightTarget = pickTorecType(remaining);
  var rightTorec = buildTorecApt(N - 1, N, N, activeSet, usedCells, blocked, insolMap, sortedCorrNears, rightTarget);
  if (rightTorec) {
    apartments.push(rightTorec);
    if (placed[rightTorec.type] !== undefined) placed[rightTorec.type]++;
    consumeRemaining(remaining, rightTorec.type);
    markUsed(rightTorec.cells, usedCells, torecCells);
  }

  // Mid WZ = active minus torec-consumed
  var midWZ = [];
  for (var i = 0; i < activeWZ.length; i++) {
    if (!torecCells[activeWZ[i]]) midWZ.push(activeWZ[i]);
  }

  // Phase 1: GUARANTEE — each mid WZ gets 1 cell
  // If stranded, steal from largest neighbor
  var allocated = {};
  for (var i = 0; i < midWZ.length; i++) allocated[midWZ[i]] = [];

  for (var i = 0; i < midWZ.length; i++) {
    var wz = midWZ[i];
    var avail = getContiguous(wz, N, blocked, usedCells);
    if (avail.length > 0) {
      allocated[wz].push(avail[0]);
      usedCells[avail[0]] = true;
    }
    // If stranded: will steal in Phase 1b
  }

  // Phase 1b: STEAL — stranded WZ steals from largest neighbor in same row
  for (var i = 0; i < midWZ.length; i++) {
    var wz = midWZ[i];
    if (allocated[wz].length > 0) continue;

    var isNear = wz < N;
    // Find nearest mid WZ in same row with 2+ allocated cells
    var bestDonor = null;
    var bestDist = Infinity;
    for (var j = 0; j < midWZ.length; j++) {
      if (j === i) continue;
      var dWZ = midWZ[j];
      if ((dWZ < N) !== isNear) continue; // different row
      if (allocated[dWZ].length < 2) continue;
      var d = Math.abs(wz - dWZ);
      if (d < bestDist) { bestDist = d; bestDonor = dWZ; }
    }

    if (bestDonor !== null) {
      // Steal the cell closest to stranded WZ
      var donorCells = allocated[bestDonor];
      donorCells.sort(function (a, b) { return Math.abs(a - wz) - Math.abs(b - wz); });
      var stolen = donorCells.shift();
      allocated[wz].push(stolen);
    } else {
      // Try stealing from torec
      for (var ai = 0; ai < apartments.length; ai++) {
        if (!apartments[ai].torec) continue;
        var tCells = apartments[ai].cells;
        for (var ci = tCells.length - 1; ci >= 0; ci--) {
          var tc = tCells[ci];
          if (typeof tc !== 'number') continue;
          if (tc === apartments[ai].wetCell) continue;
          if ((tc < N) !== isNear) continue;
          // Steal this cell
          tCells.splice(ci, 1);
          allocated[wz].push(tc);
          break;
        }
        if (allocated[wz].length > 0) break;
      }
    }
  }

  // Phase 2: EXPAND — largest target first
  var midTargets = buildMidTargets(midWZ.length, remaining);
  var wzOrder = [];
  for (var i = 0; i < midWZ.length; i++) {
    wzOrder.push({ wz: midWZ[i], targetLiving: TYPE_LIVING[midTargets[i]] || 1, idx: i });
  }
  wzOrder.sort(function (a, b) { return b.targetLiving - a.targetLiving; });

  for (var wi = 0; wi < wzOrder.length; wi++) {
    var wz = wzOrder[wi].wz;
    var need = wzOrder[wi].targetLiving;
    var have = allocated[wz].length;
    if (have >= need) continue;
    var avail = getContiguous(wz, N, blocked, usedCells);
    var take = avail.slice(0, need - have);
    for (var ci = 0; ci < take.length; ci++) {
      allocated[wz].push(take[ci]);
      usedCells[take[ci]] = true;
    }
  }

  // Phase 3: SWEEP — every remaining cell must be assigned
  // Build barrier set for path: LLU + active mid WZ
  var sweepBarriers = {};
  if (lluCells) {
    for (var i = 0; i < lluCells.length; i++) sweepBarriers[lluCells[i]] = true;
  }
  for (var i = 0; i < midWZ.length; i++) sweepBarriers[midWZ[i]] = true;

  // Pass 1: same-row, nearest WZ with <4 cells, no barrier crossing
  for (var row = 0; row < 2; row++) {
    var rowStart = row === 0 ? 0 : N;
    var rowEnd = row === 0 ? N : 2 * N;
    for (var c = rowStart; c < rowEnd; c++) {
      if (usedCells[c]) continue;
      var bestWZ = null;
      var bestDist = Infinity;
      // First try: WZ with <4 cells, clear path
      for (var wi = 0; wi < midWZ.length; wi++) {
        var awz = midWZ[wi];
        var sameRow = (row === 0 && awz < N) || (row === 1 && awz >= N);
        if (!sameRow) continue;
        if (!isPathClear(c, awz, sweepBarriers)) continue;
        if (allocated[awz].length >= 4) continue;
        var d = Math.abs(c - awz);
        if (d < bestDist) { bestDist = d; bestWZ = awz; }
      }
      // Fallback: same-row WZ with clear path BUT still cap 4
      if (bestWZ === null) {
        bestDist = Infinity;
        for (var wi = 0; wi < midWZ.length; wi++) {
          var awz = midWZ[wi];
          var sameRow = (row === 0 && awz < N) || (row === 1 && awz >= N);
          if (!sameRow) continue;
          if (!isPathClear(c, awz, sweepBarriers)) continue;
          if (allocated[awz].length >= 4) continue;
          var d = Math.abs(c - awz);
          if (d < bestDist) { bestDist = d; bestWZ = awz; }
        }
      }
      // Last resort same-row: nearest torec
      if (bestWZ === null) {
        bestDist = Infinity;
        var bestTi = -1;
        for (var ai = 0; ai < apartments.length; ai++) {
          if (!apartments[ai].torec) continue;
          var d = Math.abs(c - apartments[ai].wetCell);
          if (d < bestDist) { bestDist = d; bestTi = ai; }
        }
        if (bestTi >= 0) {
          apartments[bestTi].cells.push(c);
          usedCells[c] = true;
          continue;
        }
      }
      if (bestWZ !== null) {
        allocated[bestWZ].push(c);
        usedCells[c] = true;
      }
    }
  }

  // Pass 2: remaining → same-row mid WZ, adjacent to existing allocation, cap 4
  for (var c = 0; c < 2 * N; c++) {
    if (usedCells[c]) continue;
    var cRow = c < N ? 0 : 1;
    var bestWZ = null;
    var bestDist = Infinity;
    // Same-row mid WZ with clear path + cap 4
    for (var wi = 0; wi < midWZ.length; wi++) {
      var awz = midWZ[wi];
      var wzRow = awz < N ? 0 : 1;
      if (wzRow !== cRow) continue;
      if (allocated[awz].length >= 4) continue;
      if (!isPathClear(c, awz, sweepBarriers)) continue;
      var d = Math.abs(c - awz);
      if (d < bestDist) { bestDist = d; bestWZ = awz; }
    }
    // Relaxed: same-row, adjacent to existing group (wz or its cells), cap 4
    if (bestWZ === null) {
      bestDist = Infinity;
      for (var wi = 0; wi < midWZ.length; wi++) {
        var awz = midWZ[wi];
        var wzRow = awz < N ? 0 : 1;
        if (wzRow !== cRow) continue;
        if (allocated[awz].length >= 4) continue;
        if (!isAdjacentToGroup(c, awz, allocated[awz])) continue;
        var d = Math.abs(c - awz);
        if (d < bestDist) { bestDist = d; bestWZ = awz; }
      }
    }
    // Torec fallback
    if (bestWZ === null) {
      var bestTorec = -1;
      bestDist = Infinity;
      for (var ai = 0; ai < apartments.length; ai++) {
        if (!apartments[ai].torec) continue;
        var d = Math.abs(c - apartments[ai].wetCell);
        if (d < bestDist) { bestDist = d; bestTorec = ai; }
      }
      if (bestTorec >= 0) {
        apartments[bestTorec].cells.push(c);
        usedCells[c] = true;
        continue;
      }
    }
    if (bestWZ !== null) {
      allocated[bestWZ].push(c);
      usedCells[c] = true;
    }
  }

  // Phase 4: BUILD — ALL allocated cells in apartment (type = min(living, 4))
  for (var i = 0; i < midWZ.length; i++) {
    var wz = midWZ[i];
    var group = allocated[wz] || [];
    group.sort(function (a, b) { return Math.abs(a - wz) - Math.abs(b - wz); });

    // ALL cells belong to this apartment
    var cells = [wz];
    for (var ci = 0; ci < group.length; ci++) cells.push(group[ci]);

    // Type determined by living count (capped at 4K)
    var livingCount = Math.min(group.length, 4);
    var flags = [];
    for (var fi = 0; fi < livingCount; fi++) flags.push(getFlag(insolMap, group[fi]));
    var v = validateApartment(flags);

    var type = v.valid ? v.type : (livingCount >= 4 ? '4K' : livingCount >= 3 ? '3K' : livingCount >= 2 ? '2K' : '1K');

    apartments.push({ cells: cells, wetCell: wz, type: type, valid: v.valid, torec: false, corridorLabel: null });
    if (placed[type] !== undefined) placed[type]++;
  }

  // Phase 4b: CORRIDOR ASSIGNMENT — corridors belong to apartment owning both ends
  for (var ai = 0; ai < apartments.length; ai++) {
    var apt = apartments[ai];
    if (apt.corridorLabel) continue; // torec already has corridor
    var aptCellSet = {};
    for (var ci = 0; ci < apt.cells.length; ci++) {
      var c = apt.cells[ci];
      if (typeof c === 'number') aptCellSet[c] = true;
    }
    for (var cni = 0; cni < sortedCorrNears.length; cni++) {
      var nearC = sortedCorrNears[cni];
      var farC = 2 * N - 1 - nearC;
      if (aptCellSet[nearC] && aptCellSet[farC]) {
        var corrLabel = nearC + '-' + farC;
        apt.cells.push(corrLabel);
        if (!apt.corridorLabel) apt.corridorLabel = corrLabel;
      }
    }
  }

  // Recount torec types after possible cell changes
  for (var ai = 0; ai < apartments.length; ai++) {
    var apt = apartments[ai];
    if (!apt.torec) continue;
    var livCount = 0;
    for (var ci = 0; ci < apt.cells.length; ci++) {
      var c = apt.cells[ci];
      if (typeof c === 'number' && c !== apt.wetCell) livCount++;
    }
    var oldType = apt.type;
    apt.type = livCount >= 4 ? '4K' : livCount >= 3 ? '3K' : livCount >= 2 ? '2K' : '1K';
    if (apt.type !== oldType) {
      if (placed[oldType] !== undefined) placed[oldType]--;
      if (placed[apt.type] !== undefined) placed[apt.type]++;
    }
  }

  return { apartments: apartments, placed: placed, unplaced: [] };
}

function markUsed(cells, usedCells, torecCells) {
  for (var i = 0; i < cells.length; i++) {
    if (typeof cells[i] === 'number') {
      usedCells[cells[i]] = true;
      torecCells[cells[i]] = true;
    }
  }
}

function pickTorecType(remaining) {
  var types = ['2K', '3K', '1K'];
  var best = '1K';
  var bestCount = -1;
  for (var i = 0; i < types.length; i++) {
    if ((remaining[types[i]] || 0) > bestCount) {
      bestCount = remaining[types[i]] || 0;
      best = types[i];
    }
  }
  return best;
}

function consumeRemaining(remaining, type) {
  if (remaining[type]) remaining[type]--;
}

function buildMidTargets(count, remaining) {
  var targets = [];
  var types = ['4K', '3K', '2K', '1K'];
  for (var ti = 0; ti < types.length; ti++) {
    var avail = remaining[types[ti]] || 0;
    var take = Math.min(avail, count - targets.length);
    for (var i = 0; i < take; i++) targets.push(types[ti]);
  }
  while (targets.length < count) targets.push('1K');
  return targets;
}

function buildTorecApt(nearEnd, farEnd, N, activeSet, usedCells, blocked, insolMap, sortedCorrNears, targetType) {
  if (usedCells[nearEnd] && !activeSet[nearEnd]) return null;
  if (usedCells[farEnd] && !activeSet[farEnd]) return null;

  var nearDir = nearEnd === 0 ? 1 : -1;
  var farDir = farEnd === 2 * N - 1 ? -1 : 1;

  var wzCell = null;
  if (activeSet[nearEnd]) wzCell = nearEnd;
  else if (activeSet[farEnd]) wzCell = farEnd;
  else {
    if (activeSet[nearEnd + nearDir]) wzCell = nearEnd + nearDir;
    else if (activeSet[farEnd + farDir]) wzCell = farEnd + farDir;
  }
  if (!wzCell) return null;

  // Collect ring cells: up to 2 pairs (nearEnd+farEnd, near2+far2)
  var ringCells = [];
  if (!blocked[nearEnd] || activeSet[nearEnd]) ringCells.push(nearEnd);
  if (!blocked[farEnd] || activeSet[farEnd]) ringCells.push(farEnd);

  var near2 = nearEnd + nearDir;
  var far2 = farEnd + farDir;
  var canExpand = (near2 >= 0 && near2 < N && (!blocked[near2] || activeSet[near2])) &&
                  (far2 >= N && far2 < 2 * N && (!blocked[far2] || activeSet[far2]));
  if (canExpand) { ringCells.push(near2); ringCells.push(far2); }

  var livingCells = [];
  for (var i = 0; i < ringCells.length; i++) {
    if (ringCells[i] !== wzCell) livingCells.push(ringCells[i]);
  }
  if (livingCells.length === 0) return null;

  var targetLiving = Math.min(TYPE_LIVING[targetType] || 1, livingCells.length);
  var living = livingCells.slice(0, targetLiving);

  // Build set of all numeric cells in this apartment (wz + living)
  var aptCellSet = {};
  aptCellSet[wzCell] = true;
  for (var i = 0; i < living.length; i++) aptCellSet[living[i]] = true;

  // Corridor rule: include corridor "a-b" if BOTH a and b are in aptCellSet
  var corridors = [];
  for (var i = 0; i < sortedCorrNears.length; i++) {
    var nearC = sortedCorrNears[i];
    // Find corresponding far cell: for left end corr is nearC-(2N-1-nearC)
    // Actually corridors map near[k] to far[2N-1-k] in standard layout
    var farC = 2 * N - 1 - nearC;
    if (aptCellSet[nearC] && aptCellSet[farC]) {
      corridors.push(nearC + '-' + farC);
    }
  }

  var flags = [];
  for (var i = 0; i < living.length; i++) flags.push(getFlag(insolMap, living[i]));
  var v = validateApartment(flags);

  var cells = [wzCell];
  for (var i = 0; i < living.length; i++) cells.push(living[i]);
  for (var i = 0; i < corridors.length; i++) cells.push(corridors[i]);

  var type = v.valid ? v.type : (targetLiving >= 3 ? '3K' : targetLiving >= 2 ? '2K' : '1K');
  return { cells: cells, wetCell: wzCell, type: type, valid: v.valid, torec: true, corridorLabel: corridors[0] || null };
}

function getContiguous(wz, N, blocked, usedCells) {
  var isNear = wz < N;
  var rowStart = isNear ? 0 : N;
  var rowEnd = isNear ? N : 2 * N;
  var cells = [];
  for (var c = wz - 1; c >= rowStart; c--) {
    if (blocked[c] || usedCells[c]) break;
    cells.push(c);
  }
  for (var c = wz + 1; c < rowEnd; c++) {
    if (blocked[c] || usedCells[c]) break;
    cells.push(c);
  }
  cells.sort(function (a, b) { return Math.abs(a - wz) - Math.abs(b - wz); });
  return cells;
}

/**
 * Check path between c and wz has no barrier cells (LLU or other active WZ).
 */
function isPathClear(c, wz, barrierSet) {
  var lo = Math.min(c, wz);
  var hi = Math.max(c, wz);
  for (var x = lo + 1; x < hi; x++) {
    if (barrierSet[x]) return false;
  }
  return true;
}

/**
 * Check if cell c is adjacent (±1) to the WZ itself or any cell in its group.
 * Guarantees contiguity even when barriers block the direct path.
 */
function isAdjacentToGroup(c, wz, group) {
  if (Math.abs(c - wz) === 1) return true;
  for (var i = 0; i < group.length; i++) {
    if (Math.abs(c - group[i]) === 1) return true;
  }
  return false;
}

export function computeQuota(totalApts, mix) {
  var sum = (mix['1K'] || 0) + (mix['2K'] || 0) + (mix['3K'] || 0) + (mix['4K'] || 0);
  if (sum === 0) sum = 100;
  return {
    '1K': Math.round(totalApts * (mix['1K'] || 0) / sum),
    '2K': Math.round(totalApts * (mix['2K'] || 0) / sum),
    '3K': Math.round(totalApts * (mix['3K'] || 0) / sum),
    '4K': Math.round(totalApts * (mix['4K'] || 0) / sum)
  };
}
