/**
 * MidPlanner — gap-based apartment fill between torecs.
 *
 * Algorithm per floor:
 * 1. Identify midWZ (WZ stacks not consumed by torecs)
 * 2. For each row (near, far): sort midWZ, compute gaps between them
 * 3. Divide each gap: proportional to remaining quota
 * 4. Each WZ → apartment, type = living count
 * 5. Insolation: worst insol cell → WZ, rest → living
 * 6. Corridor assignment: if apartment owns both near+far → add corridor
 *
 * Pure logic — no rendering, no Three.js.
 */

import { validateApartment, getFlag } from './ApartmentSolver.js';
import { livingCells, livingCount } from './ApartmentTypes.js';

import { nearToFar } from './CellTopology.js';
var LIVING_COUNT = { '1K': 1, '2K': 2, '3K': 3, '4K': 4 };

// ── Gap Division ─────────────────────────────────────

/**
 * Divide a gap between two WZ (or between WZ and boundary).
 * Returns how many cells go to left WZ and how many to right WZ.
 *
 * With quota bias: if one WZ needs more cells (larger target type),
 * it gets priority. Default: split evenly.
 *
 * @param {number} gapSize - free cells in this gap
 * @param {number} leftNeed - how many more cells left WZ wants
 * @param {number} rightNeed - how many more cells right WZ wants
 * @returns {Array<number>} [leftTake, rightTake]
 */
function divideGap(gapSize, leftNeed, rightNeed) {
  if (gapSize === 0) return [0, 0];
  if (leftNeed <= 0 && rightNeed <= 0) {
    // Both satisfied — split evenly (excess goes to left)
    var half = Math.floor(gapSize / 2);
    return [gapSize - half, half];
  }
  if (leftNeed <= 0) return [0, gapSize];
  if (rightNeed <= 0) return [gapSize, 0];

  // Proportional split
  var total = leftNeed + rightNeed;
  var leftTake = Math.round(gapSize * leftNeed / total);
  var rightTake = gapSize - leftTake;
  return [leftTake, rightTake];
}

// ── Row Solver ───────────────────────────────────────

/**
 * Solve one row (near or far) of a floor.
 *
 * @param {Array<number>} midWZ - sorted WZ positions in this row
 * @param {number} rowStart - first cell index in row
 * @param {number} rowEnd - last cell index + 1 in row
 * @param {Object} torecCellSet - { cellId: true } cells consumed by torecs
 * @param {Object} lluSet - { cellId: true } LLU cells
 * @param {Object} insolMap - { cellId: 'p'|'w'|'f' }
 * @param {Object} remaining - { '1K': n, ... } mutable, decremented
 * @param {number} floorsLeft - for quota scaling
 * @returns {Array<Object>} apartments
 */
function solveRow(midWZ, rowStart, rowEnd, torecCellSet, lluSet, insolMap, remaining, floorsLeft) {
  if (midWZ.length === 0) return [];

  // ── 1. Find free cells in this row ──
  var wzSet = {};
  for (var i = 0; i < midWZ.length; i++) wzSet[midWZ[i]] = true;

  var freeCells = [];
  for (var c = rowStart; c < rowEnd; c++) {
    if (torecCellSet[c] || lluSet[c] || wzSet[c]) continue;
    freeCells.push(c);
  }

  // ── 2. Build segments: groups of free cells between barriers ──
  // Barriers = torec cells, LLU, WZ positions
  // Each segment is bounded by WZ on one or both sides

  // For each midWZ, find its left and right reachable free cells
  var wzCells = {};  // wzPos → [leftCells, rightCells]
  for (var wi = 0; wi < midWZ.length; wi++) {
    var wz = midWZ[wi];
    var leftCells = [];
    var rightCells = [];

    // Scan left
    for (var c = wz - 1; c >= rowStart; c--) {
      if (torecCellSet[c] || lluSet[c] || wzSet[c]) break;
      leftCells.push(c);
    }
    leftCells.reverse(); // order: low→high

    // Scan right
    for (var c = wz + 1; c < rowEnd; c++) {
      if (torecCellSet[c] || lluSet[c] || wzSet[c]) break;
      rightCells.push(c);
    }

    wzCells[wz] = { left: leftCells, right: rightCells };
  }

  // ── 3. Compute target living per WZ from remaining quota ──
  var sumR = 0;
  var types = ['1K', '2K', '3K', '4K'];
  for (var i = 0; i < types.length; i++) {
    sumR += Math.max(0, remaining[types[i]] || 0);
  }

  // Average target living: weighted by remaining quota
  var avgTarget = 1;
  if (sumR > 0) {
    var weightedSum = 0;
    for (var i = 0; i < types.length; i++) {
      var r = Math.max(0, remaining[types[i]] || 0);
      weightedSum += r * LIVING_COUNT[types[i]];
    }
    avgTarget = weightedSum / sumR;
  }

  // Per-WZ target: scale by how many WZ share the remaining quota
  // Simple: each WZ targets avgTarget living cells (capped at 4)
  var perWZTarget = Math.min(Math.round(avgTarget), 4);
  if (perWZTarget < 1) perWZTarget = 1;

  // ── 4. Divide gaps between adjacent WZ ──
  for (var wi = 0; wi < midWZ.length - 1; wi++) {
    var wzL = midWZ[wi];
    var wzR = midWZ[wi + 1];

    // Shared gap = right cells of wzL ∩ left cells of wzR
    var rightOfL = wzCells[wzL].right;
    var leftOfR = wzCells[wzR].left;

    // Find overlap (cells reachable from both)
    var overlapSet = {};
    for (var i = 0; i < rightOfL.length; i++) overlapSet[rightOfL[i]] = true;
    var overlap = [];
    for (var i = 0; i < leftOfR.length; i++) {
      if (overlapSet[leftOfR[i]]) overlap.push(leftOfR[i]);
    }

    if (overlap.length === 0) continue;

    // How many cells each WZ already has from non-shared sides
    var leftHas = wzCells[wzL].left.length;
    var rightHas = wzCells[wzR].right.length;

    var leftNeed = Math.max(0, perWZTarget - leftHas);
    var rightNeed = Math.max(0, perWZTarget - rightHas);

    var split = divideGap(overlap.length, leftNeed, rightNeed);

    // Assign: first split[0] cells to wzL, rest to wzR
    overlap.sort(function (a, b) { return a - b; });
    var splitPoint = split[0];

    // Update: wzL.right = cells up to splitPoint, wzR.left = cells from splitPoint
    var newRightL = [];
    var newLeftR = [];
    for (var i = 0; i < overlap.length; i++) {
      if (i < splitPoint) newRightL.push(overlap[i]);
      else newLeftR.push(overlap[i]);
    }

    // Also keep non-overlapping parts
    var finalRightL = [];
    for (var i = 0; i < rightOfL.length; i++) {
      if (!overlapSet[rightOfL[i]] || newRightL.indexOf(rightOfL[i]) >= 0) {
        // Keep: either not in overlap, or assigned to L
      }
    }
    // Simpler: just replace right/left with split result
    wzCells[wzL].right = newRightL;
    wzCells[wzR].left = newLeftR;
  }

  // ── 5. Build apartments ──
  var FLAG_SCORE = { 'f': 0, 'w': 1, 'p': 2 };
  var apartments = [];

  for (var wi = 0; wi < midWZ.length; wi++) {
    var wz = midWZ[wi];
    var allLiving = [];
    var leftC = wzCells[wz].left;
    var rightC = wzCells[wz].right;
    for (var i = 0; i < leftC.length; i++) allLiving.push(leftC[i]);
    for (var i = 0; i < rightC.length; i++) allLiving.push(rightC[i]);

    // Cap at 4 living
    if (allLiving.length > 4) {
      // Sort by distance to WZ, take closest 4
      allLiving.sort(function (a, b) {
        return Math.abs(a - wz) - Math.abs(b - wz);
      });
      allLiving = allLiving.slice(0, 4);
    }

    if (allLiving.length === 0) {
      // Stranded WZ: no free cells reachable → orphan
      apartments.push({
        cells: [wz], wetCell: wz, type: 'orphan',
        valid: false, torec: false, corridorLabel: null
      });
      continue;
    }

    // WZ stays at fixed position (vertical consistency)
    var wzCell = wz;

    // Validate insolation
    var flags = [];
    for (var i = 0; i < allLiving.length; i++) flags.push(getFlag(insolMap, allLiving[i]));
    var v = validateApartment(flags);

    var livingCount = allLiving.length;
    var type = livingCount >= 4 ? '4K' : livingCount >= 3 ? '3K' : livingCount >= 2 ? '2K' : '1K';

    var cells = [wzCell];
    for (var i = 0; i < allLiving.length; i++) cells.push(allLiving[i]);

    apartments.push({
      cells: cells, wetCell: wzCell, type: type,
      valid: v.valid, torec: false, corridorLabel: null
    });

    // Update remaining
    if (remaining[type] !== undefined) remaining[type]--;
  }

  return apartments;
}

// ── Orphan Absorption ────────────────────────────────

/**
 * Absorb unassigned cells into apartments.
 * Rules:
 * 1. Same-row mid apartment (adjacent cell) — preferred
 * 2. Torec apartment (has cells in same row, adjacent) — fallback
 * 3. NEVER cross-row into non-torec apartment
 *
 * @param {Array<Object>} midApts - mid apartments
 * @param {Array<Object>} torecApts - torec apartments (span both rows)
 * @param {number} rowStart
 * @param {number} rowEnd
 * @param {Object} torecCellSet
 * @param {Object} lluSet
 * @param {number} N
 */
function absorbOrphans(midApts, torecApts, rowStart, rowEnd, torecCellSet, lluSet, N) {
  // Build cell→apartment map (mid + torec combined)
  var allApts = [];
  for (var i = 0; i < midApts.length; i++) allApts.push({ apt: midApts[i], isTorec: false });
  for (var i = 0; i < torecApts.length; i++) allApts.push({ apt: torecApts[i], isTorec: true });

  var cellToEntry = {};
  for (var ei = 0; ei < allApts.length; ei++) {
    var cs = allApts[ei].apt.cells;
    for (var ci = 0; ci < cs.length; ci++) {
      if (typeof cs[ci] === 'number') cellToEntry[cs[ci]] = ei;
    }
  }

  for (var c = rowStart; c < rowEnd; c++) {
    if (torecCellSet[c] || lluSet[c] || cellToEntry[c] !== undefined) continue;

    var absorbed = false;

    // Pass 1: same-row mid apartment (adjacent)
    for (var delta = 1; delta <= 3 && !absorbed; delta++) {
      for (var dir = -1; dir <= 1 && !absorbed; dir += 2) {
        var nb = c + dir * delta;
        if (nb < rowStart || nb >= rowEnd) continue;
        if (cellToEntry[nb] === undefined) continue;
        var entry = allApts[cellToEntry[nb]];
        if (entry.isTorec) continue; // skip torecs in pass 1
        entry.apt.cells.push(c);
        cellToEntry[c] = cellToEntry[nb];
        absorbed = true;
      }
    }

    // Pass 2: torec apartment (adjacent in same row)
    for (var delta = 1; delta <= 5 && !absorbed; delta++) {
      for (var dir = -1; dir <= 1 && !absorbed; dir += 2) {
        var nb = c + dir * delta;
        if (nb < rowStart || nb >= rowEnd) continue;
        if (cellToEntry[nb] === undefined) continue;
        var entry = allApts[cellToEntry[nb]];
        if (!entry.isTorec) continue; // only torecs in pass 2
        entry.apt.cells.push(c);
        cellToEntry[c] = cellToEntry[nb];
        absorbed = true;
      }
    }

    // Pass 3: any torec (even if not same-row adjacent — torec spans both rows)
    if (!absorbed) {
      for (var ti = 0; ti < torecApts.length; ti++) {
        var tCells = torecApts[ti].cells;
        for (var tci = 0; tci < tCells.length; tci++) {
          if (typeof tCells[tci] !== 'number') continue;
          if (Math.abs(tCells[tci] - c) <= 2) {
            torecApts[ti].cells.push(c);
            absorbed = true;
            break;
          }
        }
        if (absorbed) break;
      }
    }
  }

  // Recount types for all modified torecs
  for (var ti = 0; ti < torecApts.length; ti++) {
    var apt = torecApts[ti];
    var livCount = livingCount(apt);
    apt.type = livCount >= 4 ? '4K' : livCount >= 3 ? '3K' : livCount >= 2 ? '2K' : '1K';
  }
}

// ── Corridor Assignment ──────────────────────────────

/**
 * Assign corridors to mid apartments that own both near and far cells.
 */
function assignCorridors(apartments, sortedCorrNears, N) {
  for (var ai = 0; ai < apartments.length; ai++) {
    var apt = apartments[ai];
    if (apt.corridorLabel) continue;
    var cellSet = {};
    for (var ci = 0; ci < apt.cells.length; ci++) {
      if (typeof apt.cells[ci] === 'number') cellSet[apt.cells[ci]] = true;
    }
    for (var cni = 0; cni < sortedCorrNears.length; cni++) {
      var nearC = sortedCorrNears[cni];
      var farC = nearToFar(nearC, N);
      if (cellSet[nearC] && cellSet[farC]) {
        var label = nearC + '-' + farC;
        apt.cells.push(label);
        if (!apt.corridorLabel) apt.corridorLabel = label;
      }
    }
  }
}

// ── Post-Process ─────────────────────────────────────

/**
 * Post-process mid apartments:
 * 1. Merge orphan apartments (type='orphan') into adjacent neighbor
 * 2. Recount types from actual cell data
 * 3. Split oversized apartments if quota says too many of that type
 *
 * @param {Array<Object>} apartments - mutable array
 * @param {Object} insolMap
 * @param {Object} remaining - mutable quota remaining
 * @param {number} N
 */
function postProcess(apartments, insolMap, remaining, N) {
  // ── Step 1: Merge orphan apartments into neighbors ──
  var merged = true;
  var maxIter = 20;
  while (merged && maxIter > 0) {
    merged = false;
    maxIter--;

    for (var ai = apartments.length - 1; ai >= 0; ai--) {
      var apt = apartments[ai];
      if (apt.type !== 'orphan') continue;

      var orphanCell = null;
      for (var ci = 0; ci < apt.cells.length; ci++) {
        if (typeof apt.cells[ci] === 'number') { orphanCell = apt.cells[ci]; break; }
      }
      if (orphanCell === null) {
        apartments.splice(ai, 1);
        merged = true;
        break;
      }

      // Find adjacent apartment (same-row or torec only)
      var orphanRow = orphanCell < N ? 0 : 1;
      var absorbed = false;
      for (var delta = -1; delta <= 1; delta += 2) {
        var nb = orphanCell + delta;
        for (var bi = 0; bi < apartments.length; bi++) {
          if (bi === ai) continue;
          // Row check: only same-row or torec
          if (!apartments[bi].torec) {
            var bRow = -1;
            var bNums = apartments[bi].cells;
            for (var ci = 0; ci < bNums.length; ci++) {
              if (typeof bNums[ci] === 'number') { bRow = bNums[ci] < N ? 0 : 1; break; }
            }
            if (bRow >= 0 && bRow !== orphanRow) continue;
          }
          var bCells = apartments[bi].cells;
          var found = false;
          for (var ci = 0; ci < bCells.length; ci++) {
            if (bCells[ci] === nb) { found = true; break; }
          }
          if (!found) continue;

          // Merge: add orphan cell to neighbor
          apartments[bi].cells.push(orphanCell);

          // Recount living
          var livCount = 0;
          for (var ci = 0; ci < apartments[bi].cells.length; ci++) {
            var c = apartments[bi].cells[ci];
            if (typeof c === 'number' && c !== apartments[bi].wetCell) livCount++;
          }
          var oldType = apartments[bi].type;
          apartments[bi].type = livCount >= 4 ? '4K' : livCount >= 3 ? '3K' : livCount >= 2 ? '2K' : '1K';

          // Update remaining
          if (oldType !== apartments[bi].type) {
            if (remaining[oldType] !== undefined) remaining[oldType]++;
            if (remaining[apartments[bi].type] !== undefined) remaining[apartments[bi].type]--;
          }

          // Remove orphan
          apartments.splice(ai, 1);
          absorbed = true;
          break;
        }
        if (absorbed) break;
      }

      if (absorbed) {
        merged = true;
        break; // restart scan
      } else {
        // Can't merge — force absorb: same-row or torec, ignore cap
        for (var bi = 0; bi < apartments.length; bi++) {
          if (bi === ai) continue;
          // Row check
          if (!apartments[bi].torec) {
            var bRow2 = -1;
            var bNums2 = apartments[bi].cells;
            for (var ci = 0; ci < bNums2.length; ci++) {
              if (typeof bNums2[ci] === 'number') { bRow2 = bNums2[ci] < N ? 0 : 1; break; }
            }
            if (bRow2 >= 0 && bRow2 !== orphanRow) continue;
          }
          var bCells = apartments[bi].cells;
          for (var ci = 0; ci < bCells.length; ci++) {
            if (typeof bCells[ci] !== 'number') continue;
            if (Math.abs(bCells[ci] - orphanCell) <= 2) {
              apartments[bi].cells.push(orphanCell);
              var livCount = 0;
              for (var k = 0; k < apartments[bi].cells.length; k++) {
                var c = apartments[bi].cells[k];
                if (typeof c === 'number' && c !== apartments[bi].wetCell) livCount++;
              }
              var oldType = apartments[bi].type;
              apartments[bi].type = livCount >= 4 ? '4K' : livCount >= 3 ? '3K' : livCount >= 2 ? '2K' : '1K';
              if (oldType !== apartments[bi].type) {
                if (remaining[oldType] !== undefined) remaining[oldType]++;
                if (remaining[apartments[bi].type] !== undefined) remaining[apartments[bi].type]--;
              }
              apartments.splice(ai, 1);
              absorbed = true;
              break;
            }
          }
          if (absorbed) break;
        }
        if (absorbed) { merged = true; break; }
      }
    }
  }

  // ── Step 2: Recount types from actual cells ──
  for (var ai = 0; ai < apartments.length; ai++) {
    var apt = apartments[ai];
    if (apt.type === 'orphan') continue;
    var livCount = livingCount(apt);
    var correctType = livCount >= 4 ? '4K' : livCount >= 3 ? '3K' : livCount >= 2 ? '2K' : livCount >= 1 ? '1K' : 'orphan';
    if (apt.type !== correctType) {
      if (remaining[apt.type] !== undefined) remaining[apt.type]++;
      apt.type = correctType;
      if (remaining[correctType] !== undefined) remaining[correctType]--;
    }
    // Re-validate insolation
    var aptLiving = livingCells(apt);
    var flags = [];
    for (var ci = 0; ci < aptLiving.length; ci++) flags.push(getFlag(insolMap, aptLiving[ci]));
    var v = validateApartment(flags);
    apt.valid = v.valid;
  }

  // ── Step 3: Split oversized if quota excess ──
  // If remaining[type] < 0, we have too many of that type.
  // Try splitting: 4K → 2K+1K (needs extra WZ → not possible without stoyak)
  // Instead: downgrade by transferring 1 cell to smaller neighbor.
  var splitIter = 10;
  while (splitIter > 0) {
    splitIter--;
    var changed = false;

    for (var ai = 0; ai < apartments.length; ai++) {
      var apt = apartments[ai];
      var t = apt.type;
      if (t === 'orphan') continue;
      if ((remaining[t] || 0) >= 0) continue; // not over quota

      // Over quota for this type — try to shrink by donating 1 cell to neighbor
      var livCells = livingCells(apt);
      if (livCells.length < 2) continue; // can't shrink 1K

      // Find boundary living cell adjacent to another apartment
      for (var li = livCells.length - 1; li >= 0; li--) {
        var dCell = livCells[li];
        var donated = false;

        for (var bi = 0; bi < apartments.length; bi++) {
          if (bi === ai) continue;
          var bCells = apartments[bi].cells;
          var adjacent = false;
          for (var bci = 0; bci < bCells.length; bci++) {
            if (typeof bCells[bci] === 'number' && Math.abs(bCells[bci] - dCell) === 1) {
              adjacent = true;
              break;
            }
          }
          if (!adjacent) continue;

          // Check receiver won't exceed 4 living
          var bLiv = 0;
          for (var bci = 0; bci < bCells.length; bci++) {
            if (typeof bCells[bci] === 'number' && bCells[bci] !== apartments[bi].wetCell) bLiv++;
          }
          if (bLiv >= 4) continue;

          // Check receiver type is under quota
          var newBType = (bLiv + 1) >= 4 ? '4K' : (bLiv + 1) >= 3 ? '3K' : (bLiv + 1) >= 2 ? '2K' : '1K';
          if ((remaining[newBType] || 0) < 0) continue; // receiver type also over

          // Transfer
          // Remove from donor
          var newDonorCells = [];
          for (var ci = 0; ci < apt.cells.length; ci++) {
            if (apt.cells[ci] !== dCell) newDonorCells.push(apt.cells[ci]);
          }
          apt.cells = newDonorCells;

          // Add to receiver
          apartments[bi].cells.push(dCell);

          // Recount donor
          var dLiv = 0;
          for (var ci = 0; ci < apt.cells.length; ci++) {
            if (typeof apt.cells[ci] === 'number' && apt.cells[ci] !== apt.wetCell) dLiv++;
          }
          var newDType = dLiv >= 4 ? '4K' : dLiv >= 3 ? '3K' : dLiv >= 2 ? '2K' : dLiv >= 1 ? '1K' : 'orphan';
          remaining[t]++; // old type freed
          remaining[newDType]--; // new type consumed
          apt.type = newDType;

          // Recount receiver
          var oldBType = apartments[bi].type;
          apartments[bi].type = newBType;
          remaining[oldBType]++;
          remaining[newBType]--;

          donated = true;
          changed = true;
          break;
        }
        if (donated) break;
      }
      if (changed) break;
    }
    if (!changed) break;
  }
}

// ── Main: Fill Mid ───────────────────────────────────

/**
 * Fill mid cells for one floor.
 *
 * @param {Object} params
 * @param {Array<Object>} params.torecApts - torec apartments on this floor
 * @param {Array<number>} params.wzStacks - all WZ stack positions
 * @param {number} params.N
 * @param {Array<number>} params.lluCellIds
 * @param {Array<number>} params.sortedCorrNears
 * @param {Object} params.insolMap - { cellId: 'p'|'w'|'f' }
 * @param {Object} params.remaining - mutable { '1K': n, ... }
 * @param {number} params.floorsLeft
 * @returns {Object} { apartments: [...], placed: { '1K': n, ... } }
 */
export function fillMid(params) {
  var torecApts = params.torecApts || [];
  var wzStacks = params.wzStacks || [];
  var N = params.N;
  var lluCellIds = params.lluCellIds || [];
  var sortedCorrNears = params.sortedCorrNears || [];
  var insolMap = params.insolMap || {};
  var remaining = params.remaining;
  var floorsLeft = params.floorsLeft || 1;

  // Build torec cell set
  var torecCellSet = {};
  for (var ai = 0; ai < torecApts.length; ai++) {
    var cs = torecApts[ai].cells || [];
    for (var ci = 0; ci < cs.length; ci++) {
      if (typeof cs[ci] === 'number') torecCellSet[cs[ci]] = true;
    }
  }

  // Build LLU set
  var lluSet = {};
  for (var i = 0; i < lluCellIds.length; i++) lluSet[lluCellIds[i]] = true;

  // Find midWZ: WZ stacks not consumed by torecs
  var midWZ = [];
  for (var i = 0; i < wzStacks.length; i++) {
    if (!torecCellSet[wzStacks[i]]) midWZ.push(wzStacks[i]);
  }

  // Split midWZ into near and far rows
  var nearMidWZ = [];
  var farMidWZ = [];
  for (var i = 0; i < midWZ.length; i++) {
    if (midWZ[i] < N) nearMidWZ.push(midWZ[i]);
    else farMidWZ.push(midWZ[i]);
  }
  nearMidWZ.sort(function (a, b) { return a - b; });
  farMidWZ.sort(function (a, b) { return a - b; });

  // Solve each row
  var nearApts = solveRow(nearMidWZ, 0, N, torecCellSet, lluSet, insolMap, remaining, floorsLeft);
  var farApts = solveRow(farMidWZ, N, 2 * N, torecCellSet, lluSet, insolMap, remaining, floorsLeft);

  // Combine
  var midApts = [];
  for (var i = 0; i < nearApts.length; i++) midApts.push(nearApts[i]);
  for (var i = 0; i < farApts.length; i++) midApts.push(farApts[i]);

  // Absorb orphan cells (unassigned free cells → same-row apt or torec)
  absorbOrphans(midApts, torecApts, 0, N, torecCellSet, lluSet, N);
  absorbOrphans(midApts, torecApts, N, 2 * N, torecCellSet, lluSet, N);

  // Post-process: merge orphan apartments, then split oversized per quota
  // Operates on combined list (torec + mid) so orphan mid WZ can merge into torec
  var allApts = [];
  for (var i = 0; i < torecApts.length; i++) allApts.push(torecApts[i]);
  for (var i = 0; i < midApts.length; i++) allApts.push(midApts[i]);
  postProcess(allApts, insolMap, remaining, N);

  // Separate back: mid apts = everything after torecs
  midApts = [];
  for (var i = torecApts.length; i < allApts.length; i++) {
    if (allApts[i].type !== '_removed') midApts.push(allApts[i]);
  }
  // Also filter removed from allApts (orphans that got merged)
  var cleanMid = [];
  for (var i = 0; i < midApts.length; i++) {
    if (midApts[i].type !== 'orphan' || midApts[i].cells.length > 0) cleanMid.push(midApts[i]);
  }
  midApts = cleanMid;

  // Assign corridors
  assignCorridors(midApts, sortedCorrNears, N);

  // Count placed
  var placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
  for (var i = 0; i < midApts.length; i++) {
    var t = midApts[i].type;
    if (placed[t] !== undefined) placed[t]++;
  }

  return { apartments: midApts, placed: placed };
}
