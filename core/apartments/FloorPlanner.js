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

export function planFloor(allWZ, activeWZ, insolMap, N, lluCells, floorPlan, sortedCorrNears, orientation) {
  if (!insolMap) insolMap = {};
  if (!floorPlan) floorPlan = [];
  if (!sortedCorrNears) sortedCorrNears = [];
  if (!orientation) orientation = 'lon';

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

  var leftTarget = pickTorecType(remaining, orientation);
  var leftTorec = buildTorecApt(0, 2 * N - 1, N, activeSet, usedCells, blocked, insolMap, sortedCorrNears, leftTarget, orientation, lluCells);
  if (leftTorec) {
    apartments.push(leftTorec);
    if (placed[leftTorec.type] !== undefined) placed[leftTorec.type]++;
    consumeRemaining(remaining, leftTorec.type);
    markUsed(leftTorec.cells, usedCells, torecCells);
  }

  var rightTarget = pickTorecType(remaining, orientation);
  var rightTorec = buildTorecApt(N - 1, N, N, activeSet, usedCells, blocked, insolMap, sortedCorrNears, rightTarget, orientation, lluCells);
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

  // Phase 1b: STEAL — stranded WZ steals ADJACENT cell from neighbor
  // Critical: stolen cell must be adjacent (±1) to the WZ itself
  for (var i = 0; i < midWZ.length; i++) {
    var wz = midWZ[i];
    if (allocated[wz].length > 0) continue;

    var isNear = wz < N;
    // Find nearest mid WZ in same row with 2+ cells AND adjacent cell
    var bestDonor = null;
    var bestCell = null;
    var bestDist = Infinity;
    for (var j = 0; j < midWZ.length; j++) {
      if (j === i) continue;
      var dWZ = midWZ[j];
      if ((dWZ < N) !== isNear) continue;
      if (allocated[dWZ].length < 2) continue;
      // Find a cell in donor's group adjacent to wz
      var donorGroup = allocated[dWZ];
      for (var gi = 0; gi < donorGroup.length; gi++) {
        if (Math.abs(donorGroup[gi] - wz) === 1) {
          var d = Math.abs(wz - dWZ);
          if (d < bestDist) { bestDist = d; bestDonor = dWZ; bestCell = donorGroup[gi]; }
          break;
        }
      }
    }

    if (bestDonor !== null && bestCell !== null) {
      var donorGroup = allocated[bestDonor];
      var ci = donorGroup.indexOf(bestCell);
      if (ci >= 0) donorGroup.splice(ci, 1);
      allocated[wz].push(bestCell);
    } else {
      // Try stealing from torec — only adjacent cells
      for (var ai = 0; ai < apartments.length; ai++) {
        if (!apartments[ai].torec) continue;
        var tCells = apartments[ai].cells;
        for (var ci = tCells.length - 1; ci >= 0; ci--) {
          var tc = tCells[ci];
          if (typeof tc !== 'number') continue;
          if (tc === apartments[ai].wetCell) continue;
          if ((tc < N) !== isNear) continue;
          if (Math.abs(tc - wz) !== 1) continue; // must be adjacent
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

  // Phase 2b: ABSORB STRANDED — WZ with 0 cells after expand gets merged
  // into nearest adjacent WZ that HAS cells. Loop to handle chains.
  var absorbedWZ = {};
  var absorbChanged = true;
  while (absorbChanged) {
    absorbChanged = false;
    for (var i = 0; i < midWZ.length; i++) {
      var wz = midWZ[i];
      if (absorbedWZ[wz]) continue;
      if (allocated[wz].length > 0) continue;
      var isNear = wz < N;

      var bestNeighbor = null;
      var bestDist = Infinity;
      for (var j = 0; j < midWZ.length; j++) {
        if (j === i) continue;
        if (absorbedWZ[midWZ[j]]) continue;
        var nwz = midWZ[j];
        if ((nwz < N) !== isNear) continue;
        if (allocated[nwz].length === 0) continue; // neighbor must have cells
        var d = Math.abs(wz - nwz);
        if (d > 3) continue;
        if (d < bestDist) { bestDist = d; bestNeighbor = nwz; }
      }

      if (bestNeighbor !== null) {
        allocated[bestNeighbor].push(wz);
        usedCells[wz] = true;
        absorbedWZ[wz] = true;
        absorbChanged = true;
      }
    }
  }

  // Remove absorbed WZ AND empty WZ (failed absorb) from midWZ list.
  // Empty WZ become regular cells — SWEEP can assign them normally.
  var activeMidWZ = [];
  for (var i = 0; i < midWZ.length; i++) {
    if (absorbedWZ[midWZ[i]]) continue;
    if (allocated[midWZ[i]].length === 0) {
      // This WZ has no cells and wasn't absorbed — treat as regular cell
      usedCells[midWZ[i]] = false; // ensure it's available for SWEEP
      continue;
    }
    activeMidWZ.push(midWZ[i]);
  }
  midWZ = activeMidWZ;

  // Phase 3: SWEEP — every remaining cell must be assigned
  // Build barrier set for path: LLU + active mid WZ + torec cells (occupied)
  var sweepBarriers = {};
  if (lluCells) {
    for (var i = 0; i < lluCells.length; i++) sweepBarriers[lluCells[i]] = true;
  }
  for (var i = 0; i < midWZ.length; i++) sweepBarriers[midWZ[i]] = true;
  for (var k in torecCells) sweepBarriers[k] = true;

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
      // Last resort same-row: nearest torec, must be adjacent to existing cells
      if (bestWZ === null) {
        var bestTi = -1;
        for (var ai = 0; ai < apartments.length; ai++) {
          if (!apartments[ai].torec) continue;
          if (torecNumericCount(apartments[ai]) >= 5) continue;
          var tCells = apartments[ai].cells;
          var adjFound = false;
          for (var tci = 0; tci < tCells.length; tci++) {
            if (typeof tCells[tci] === 'number' && Math.abs(tCells[tci] - c) === 1) {
              adjFound = true; break;
            }
          }
          if (adjFound) { bestTi = ai; break; }
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
    // Torec fallback (must be adjacent to existing cells, cap 5)
    if (bestWZ === null) {
      var bestTorec = -1;
      for (var ai = 0; ai < apartments.length; ai++) {
        if (!apartments[ai].torec) continue;
        if (torecNumericCount(apartments[ai]) >= 5) continue;
        var tCells = apartments[ai].cells;
        var adjFound = false;
        for (var tci = 0; tci < tCells.length; tci++) {
          if (typeof tCells[tci] === 'number' && Math.abs(tCells[tci] - c) === 1) {
            adjFound = true; break;
          }
        }
        if (adjFound) { bestTorec = ai; break; }
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

  // Phase 3c: CREATE — new apartments from unassigned contiguous cells.
  // After WZ deactivation, some cells can't reach any capped WZ or torec.
  // Group contiguous orphans in same row, pick worst-insol cell as WZ.
  for (var row = 0; row < 2; row++) {
    var rowStart = row === 0 ? 0 : N;
    var rowEnd = row === 0 ? N : 2 * N;
    var orphanGroup = [];
    for (var c = rowStart; c < rowEnd; c++) {
      if (usedCells[c]) {
        if (orphanGroup.length >= 2) {
          var newApt = createOrphanApartment(orphanGroup, insolMap);
          apartments.push(newApt);
          if (placed[newApt.type] !== undefined) placed[newApt.type]++;
          for (var oi = 0; oi < orphanGroup.length; oi++) usedCells[orphanGroup[oi]] = true;
        } else if (orphanGroup.length === 1) {
          // Single cell: try absorb into adjacent existing apartment
          var absorbed = absorbSingleCell(orphanGroup[0], apartments, allocated, midWZ, N);
          usedCells[orphanGroup[0]] = true;
          if (!absorbed) {
            // Last resort: orphan apartment
            apartments.push({ cells: [orphanGroup[0]], wetCell: orphanGroup[0], type: 'orphan', valid: false, torec: false, corridorLabel: null });
          }
        }
        orphanGroup = [];
      } else {
        orphanGroup.push(c);
      }
    }
    // Handle trailing group
    if (orphanGroup.length >= 2) {
      var newApt = createOrphanApartment(orphanGroup, insolMap);
      apartments.push(newApt);
      if (placed[newApt.type] !== undefined) placed[newApt.type]++;
      for (var oi = 0; oi < orphanGroup.length; oi++) usedCells[orphanGroup[oi]] = true;
    } else if (orphanGroup.length === 1) {
      var absorbed = absorbSingleCell(orphanGroup[0], apartments, allocated, midWZ, N);
      usedCells[orphanGroup[0]] = true;
      if (!absorbed) {
        apartments.push({ cells: [orphanGroup[0]], wetCell: orphanGroup[0], type: 'orphan', valid: false, torec: false, corridorLabel: null });
      }
    }
  }

  // Phase 4: BUILD — apartments from allocated cells, split if >4 living
  for (var i = 0; i < midWZ.length; i++) {
    var wz = midWZ[i];
    var group = allocated[wz] || [];
    group.sort(function (a, b) { return Math.abs(a - wz) - Math.abs(b - wz); });

    if (group.length === 0) continue; // absorbed WZ, skip

    if (group.length <= 4) {
      // Normal: wz + up to 4 living
      var cells = [wz];
      for (var ci = 0; ci < group.length; ci++) cells.push(group[ci]);
      var flags = [];
      for (var fi = 0; fi < group.length; fi++) flags.push(getFlag(insolMap, group[fi]));
      var v = validateApartment(flags);
      var type = v.valid ? v.type : (group.length >= 4 ? '4K' : group.length >= 3 ? '3K' : group.length >= 2 ? '2K' : '1K');
      apartments.push({ cells: cells, wetCell: wz, type: type, valid: v.valid, torec: false, corridorLabel: null });
      if (placed[type] !== undefined) placed[type]++;
    } else {
      // 5+ living cells: main apartment gets wz + closest 3, remainder gets split off
      var mainLiving = group.slice(0, 3);
      var mainCells = [wz];
      for (var ci = 0; ci < mainLiving.length; ci++) mainCells.push(mainLiving[ci]);
      var mainFlags = [];
      for (var fi = 0; fi < mainLiving.length; fi++) mainFlags.push(getFlag(insolMap, mainLiving[fi]));
      var mv = validateApartment(mainFlags);
      var mainType = mv.valid ? mv.type : '3K';
      apartments.push({ cells: mainCells, wetCell: wz, type: mainType, valid: mv.valid, torec: false, corridorLabel: null });
      if (placed[mainType] !== undefined) placed[mainType]++;

      // Remainder: split into apartments of 2-5 cells each
      var remainder = group.slice(3);
      while (remainder.length > 0) {
        var chunkSize = Math.min(remainder.length, 5); // max 5 cells = wz+4living
        if (remainder.length - chunkSize === 1) chunkSize = Math.min(chunkSize + 1, remainder.length); // avoid orphan single
        var chunk = remainder.splice(0, chunkSize);
        var newApt = createOrphanApartment(chunk, insolMap);
        apartments.push(newApt);
        if (placed[newApt.type] !== undefined) placed[newApt.type]++;
      }
    }
  }

  // Phase 4a: REGROUP — dissolve invalid apartments, redistribute cells
  var fpRegrouped = true;
  var fpRegroupMax = 10;
  while (fpRegrouped && fpRegroupMax > 0) {
    fpRegrouped = false;
    fpRegroupMax--;
    for (var ai = apartments.length - 1; ai >= 0; ai--) {
      var apt = apartments[ai];
      if (apt.valid !== false || apt.type === 'orphan') continue;

      var freedCells = [];
      for (var ci = 0; ci < apt.cells.length; ci++) {
        if (typeof apt.cells[ci] === 'number') freedCells.push(apt.cells[ci]);
      }
      if (freedCells.length === 0) continue;

      if (placed[apt.type] !== undefined && placed[apt.type] > 0) placed[apt.type]--;
      apartments.splice(ai, 1);

      var cellToAptFP = {};
      for (var bi = 0; bi < apartments.length; bi++) {
        var bCells = apartments[bi].cells || [];
        for (var ci = 0; ci < bCells.length; ci++) {
          if (typeof bCells[ci] === 'number') cellToAptFP[bCells[ci]] = bi;
        }
      }

      for (var fi = 0; fi < freedCells.length; fi++) {
        var fc = freedCells[fi];
        var absorbed = false;
        for (var delta = -1; delta <= 1; delta += 2) {
          var nb = fc + delta;
          if (cellToAptFP[nb] === undefined) continue;
          var bi = cellToAptFP[nb];
          var target = apartments[bi];
          if (!target.valid && target.type !== 'orphan') continue;

          var tLiving = [];
          var tCells = target.cells || [];
          for (var ci = 0; ci < tCells.length; ci++) {
            if (typeof tCells[ci] === 'number' && tCells[ci] !== target.wetCell)
              tLiving.push(tCells[ci]);
          }
          if (tLiving.length >= 4) continue;

          tLiving.push(fc);
          var flags = [];
          for (var k = 0; k < tLiving.length; k++) flags.push(getFlag(insolMap, tLiving[k]));
          var nv = validateApartment(flags);
          if (nv.valid) {
            var oldType = target.type;
            target.cells.push(fc);
            target.type = nv.type;
            target.valid = true;
            if (oldType !== nv.type) {
              if (placed[oldType] !== undefined && placed[oldType] > 0) placed[oldType]--;
              if (placed[nv.type] !== undefined) placed[nv.type]++;
            }
            cellToAptFP[fc] = bi;
            absorbed = true;
            break;
          }
        }
        if (!absorbed) {
          apartments.push({ cells: [fc], wetCell: fc, type: 'orphan', valid: false, torec: false, corridorLabel: null });
        }
      }
      fpRegrouped = true;
      break;
    }
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

function pickTorecType(remaining, orientation) {
  if (orientation === 'lat') {
    // Latitudinal: prefer 3K/4K; 2K only if neither available
    var primary = ['4K', '3K'];
    var best = null;
    var bestCount = -1;
    for (var i = 0; i < primary.length; i++) {
      if ((remaining[primary[i]] || 0) > bestCount) {
        bestCount = remaining[primary[i]] || 0;
        best = primary[i];
      }
    }
    if (best && bestCount > 0) return best;
    // Fallback: 2K minimum (never 1K for lat torec)
    if ((remaining['2K'] || 0) > 0) return '2K';
    return '3K'; // force 3K even if not in remaining
  }
  // Meridional: original preference order
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

function buildTorecApt(nearEnd, farEnd, N, activeSet, usedCells, blocked, insolMap, sortedCorrNears, targetType, orientation, lluCells) {
  if (usedCells[nearEnd] && !activeSet[nearEnd]) return null;
  if (usedCells[farEnd] && !activeSet[farEnd]) return null;

  var nearDir = nearEnd === 0 ? 1 : -1;
  var farDir = farEnd === 2 * N - 1 ? -1 : 1;
  var isLat = (orientation === 'lat');

  var wzCell = null;
  if (activeSet[nearEnd]) wzCell = nearEnd;
  else if (activeSet[farEnd]) wzCell = farEnd;
  else {
    if (activeSet[nearEnd + nearDir]) wzCell = nearEnd + nearDir;
    else if (activeSet[farEnd + farDir]) wzCell = farEnd + farDir;
  }
  if (!wzCell) return null;

  // Collect ring cells: start with anchor pair, expand inward
  var ringCells = [];
  if (!blocked[nearEnd] || activeSet[nearEnd]) ringCells.push(nearEnd);
  if (!blocked[farEnd] || activeSet[farEnd]) ringCells.push(farEnd);

  if (isLat) {
    // Lat: expand along side WITHOUT LLU, max 3 steps (matching first floor)
    var lluOnFar = false;
    if (lluCells) {
      for (var li = 0; li < lluCells.length; li++) {
        if (lluCells[li] >= N) { lluOnFar = true; break; }
      }
    }
    if (!lluOnFar) {
      // LLU on near → expand along far
      for (var step = 1; step <= 3; step++) {
        var nextFar = farEnd + farDir * step;
        if (nextFar < N || nextFar >= 2 * N) break;
        if (blocked[nextFar] && !activeSet[nextFar]) break;
        ringCells.push(nextFar);
      }
    } else {
      // LLU on far → expand along near
      for (var step = 1; step <= 3; step++) {
        var nextNear = nearEnd + nearDir * step;
        if (nextNear < 0 || nextNear >= N) break;
        if (blocked[nextNear] && !activeSet[nextNear]) break;
        ringCells.push(nextNear);
      }
    }
  } else {
    // Lon: expand by pairs (1 step max)
    var nextNear = nearEnd + nearDir;
    var nextFar = farEnd + farDir;
    var canExpand = (nextNear >= 0 && nextNear < N && (!blocked[nextNear] || activeSet[nextNear])) &&
                    (nextFar >= N && nextFar < 2 * N && (!blocked[nextFar] || activeSet[nextFar]));
    if (canExpand) {
      ringCells.push(nextNear);
      ringCells.push(nextFar);
    }
  }

  var livingCells = [];
  for (var i = 0; i < ringCells.length; i++) {
    if (ringCells[i] !== wzCell) livingCells.push(ringCells[i]);
  }
  if (livingCells.length === 0) return null;

  var living;
  if (isLat) {
    // Lat: prefer 3 living (3K), minimum 2 (2K), cap by targetType
    var targetLiving = Math.min(TYPE_LIVING[targetType] || 3, livingCells.length);
    if (targetLiving < 2 && livingCells.length >= 2) targetLiving = 2;
    if (targetLiving < 3 && livingCells.length >= 3) targetLiving = 3;
    living = livingCells.slice(0, targetLiving);
  } else {
    var targetLiving = Math.min(TYPE_LIVING[targetType] || 1, livingCells.length);
    living = livingCells.slice(0, targetLiving);
  }

  // Build set of all numeric cells in this apartment (wz + living)
  var aptCellSet = {};
  aptCellSet[wzCell] = true;
  for (var i = 0; i < living.length; i++) aptCellSet[living[i]] = true;

  // Corridor rule: include corridor "a-b" if BOTH a and b are in aptCellSet
  var corridors = [];
  for (var i = 0; i < sortedCorrNears.length; i++) {
    var nearC = sortedCorrNears[i];
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

  var type = v.valid ? v.type : (living.length >= 4 ? '4K' : living.length >= 3 ? '3K' : living.length >= 2 ? '2K' : '1K');
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

/**
 * Count numeric cells in a torec apartment (for size cap).
 */
function torecNumericCount(apt) {
  var count = 0;
  var cells = apt.cells || [];
  for (var i = 0; i < cells.length; i++) {
    if (typeof cells[i] === 'number') count++;
  }
  return count;
}

/**
 * Create apartment from contiguous orphan cells.
 * Pick worst-insolation cell as WZ, rest as living.
 */
function createOrphanApartment(cells, insolMap) {
  // Pick worst-insol cell as WZ
  var FLAG_SCORE = { 'f': 0, 'w': 1, 'p': 2 };
  var worstIdx = 0;
  var worstScore = 3;
  for (var i = 0; i < cells.length; i++) {
    var f = getFlag(insolMap, cells[i]);
    var s = FLAG_SCORE[f] !== undefined ? FLAG_SCORE[f] : 2;
    if (s < worstScore) { worstScore = s; worstIdx = i; }
  }
  var wzCell = cells[worstIdx];
  var living = [];
  for (var i = 0; i < cells.length; i++) {
    if (i !== worstIdx) living.push(cells[i]);
  }
  var livingCount = Math.min(living.length, 4);
  var flags = [];
  for (var i = 0; i < livingCount; i++) flags.push(getFlag(insolMap, living[i]));
  var v = validateApartment(flags);
  var type = v.valid ? v.type : (livingCount >= 4 ? '4K' : livingCount >= 3 ? '3K' : livingCount >= 2 ? '2K' : '1K');

  var aptCells = [wzCell];
  for (var i = 0; i < living.length; i++) aptCells.push(living[i]);
  return { cells: aptCells, wetCell: wzCell, type: type, valid: v.valid, torec: false, corridorLabel: null };
}

/**
 * Try to absorb a single orphan cell into the nearest adjacent apartment.
 * Returns true if absorbed.
 */
function absorbSingleCell(c, apartments, allocated, midWZ, N) {
  // Try mid WZ apartments: find one where c is adjacent, with <4 living
  for (var wi = 0; wi < midWZ.length; wi++) {
    var wz = midWZ[wi];
    var group = allocated[wz];
    if (!group || group.length >= 4) continue;
    if (isAdjacentToGroup(c, wz, group)) {
      group.push(c);
      return true;
    }
  }
  // Try torec: adjacent + cap 5 numeric cells
  for (var ai = 0; ai < apartments.length; ai++) {
    var apt = apartments[ai];
    if (!apt.torec) continue;
    if (torecNumericCount(apt) >= 5) continue;
    var cells = apt.cells;
    for (var ci = 0; ci < cells.length; ci++) {
      if (typeof cells[ci] === 'number' && Math.abs(cells[ci] - c) === 1) {
        apt.cells.push(c);
        return true;
      }
    }
  }
  // Fallback: any regular apartment with adjacent cell (for far cells behind LLU)
  for (var ai = 0; ai < apartments.length; ai++) {
    var apt = apartments[ai];
    if (apt.torec) continue;
    var cells = apt.cells;
    for (var ci = 0; ci < cells.length; ci++) {
      if (typeof cells[ci] === 'number' && Math.abs(cells[ci] - c) === 1) {
        apt.cells.push(c);
        return true;
      }
    }
  }
  // Last resort: torec with cap 5
  for (var ai = 0; ai < apartments.length; ai++) {
    var apt = apartments[ai];
    if (!apt.torec) continue;
    if (torecNumericCount(apt) >= 5) continue;
    var cells = apt.cells;
    for (var ci = 0; ci < cells.length; ci++) {
      if (typeof cells[ci] === 'number' && Math.abs(cells[ci] - c) === 1) {
        apt.cells.push(c);
        return true;
      }
    }
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
