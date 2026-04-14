/**
 * MergePlanner — merge-based apartment distribution.
 *
 * Core idea: floor 1 is all-1K (max WZ). Each upper floor copies
 * previous floor's layout and merges adjacent apartments to grow them.
 * One merge = one WZ deactivated → neighbor absorbs its cell.
 *
 * No orphans (start from full coverage, only merge).
 * No gap division (boundaries from previous floor).
 * WZ profile emerges naturally (merges = deactivations).
 *
 * v2: Directed growth scoring — merges that are stepping stones toward
 * larger needed types (2K→3K→4K chain) score positively even when
 * the immediate merged type is not in deficit. Fixes chronic 4K under-production.
 *
 * Algorithm per floor:
 *   1. Deep copy previous floor's apartments
 *   2. Compute merges_needed from remaining quota
 *   3. Boost merges when 3K/4K deficit > 25% of remaining
 *   4. Select best merge pairs (adjacent, direct need OR growth path, insol-aware)
 *   5. Execute merges (deactivate 1 WZ per merge, cap at 4K)
 *   6. Rebalance boundary cells between neighbors
 *   7. Reassign corridors
 */

import { validateApartment, getFlag } from './ApartmentSolver.js';
import { livingCount as countLiving } from './ApartmentTypes.js';
import { nearToFar } from './CellTopology.js';
var TYPE_WIDTH = { '1K': 2, '2K': 3, '3K': 4, '4K': 5 };
var LIVING_COUNT = { '1K': 1, '2K': 2, '3K': 3, '4K': 4 };

// ── Deep Copy ────────────────────────────────────────

function copyApartments(apartments) {
  var result = [];
  for (var i = 0; i < apartments.length; i++) {
    var apt = apartments[i];
    var cells = [];
    for (var ci = 0; ci < apt.cells.length; ci++) cells.push(apt.cells[ci]);
    result.push({
      cells: cells,
      wetCell: apt.wetCell,
      type: apt.type,
      valid: apt.valid,
      torec: apt.torec || false,
      corridorLabel: apt.corridorLabel || null
    });
  }
  return result;
}

function aptType(livingCount) {
  if (livingCount >= 4) return '4K';
  if (livingCount >= 3) return '3K';
  if (livingCount >= 2) return '2K';
  if (livingCount >= 1) return '1K';
  return 'orphan';
}

// ── Merge Logic ──────────────────────────────────────

/**
 * Check if two apartments are adjacent (share a boundary cell ±1).
 * Only considers numeric cells in the same row.
 */
function areAdjacent(aptA, aptB, N) {
  for (var ai = 0; ai < aptA.cells.length; ai++) {
    var ca = aptA.cells[ai];
    if (typeof ca !== 'number') continue;
    for (var bi = 0; bi < aptB.cells.length; bi++) {
      var cb = aptB.cells[bi];
      if (typeof cb !== 'number') continue;
      // Same row check
      var rowA = ca < N ? 0 : 1;
      var rowB = cb < N ? 0 : 1;
      if (rowA !== rowB) continue;
      if (Math.abs(ca - cb) === 1) return true;
    }
  }
  return false;
}

/**
 * Merge apartment B into apartment A.
 * B's WZ becomes living in merged apartment.
 * A's WZ stays (or swap if B's WZ has worse insol).
 *
 * @returns {Object} merged apartment
 */
function mergeApartments(aptA, aptB, insolMap) {
  var FLAG_SCORE = { 'f': 0, 'w': 1, 'p': 2 };

  // Collect all numeric cells from both
  var allCells = [];
  var corrLabels = [];
  for (var i = 0; i < aptA.cells.length; i++) {
    if (typeof aptA.cells[i] === 'number') allCells.push(aptA.cells[i]);
    else corrLabels.push(aptA.cells[i]);
  }
  for (var i = 0; i < aptB.cells.length; i++) {
    if (typeof aptB.cells[i] === 'number') allCells.push(aptB.cells[i]);
    // Don't carry B's corridors — will reassign later
  }

  // Choose WZ: keep the one with worst insol (most suitable for bathroom)
  var wzA = aptA.wetCell;
  var wzB = aptB.wetCell;
  var scoreA = FLAG_SCORE[getFlag(insolMap, wzA)] !== undefined ? FLAG_SCORE[getFlag(insolMap, wzA)] : 2;
  var scoreB = FLAG_SCORE[getFlag(insolMap, wzB)] !== undefined ? FLAG_SCORE[getFlag(insolMap, wzB)] : 2;

  var keepWZ = scoreA <= scoreB ? wzA : wzB; // lower score = worse insol = keep as WZ

  // Build cells array
  var cells = [];
  for (var i = 0; i < allCells.length; i++) cells.push(allCells[i]);
  // Keep corridor labels from A only (B's corridors may be invalid after merge)
  for (var i = 0; i < corrLabels.length; i++) cells.push(corrLabels[i]);

  // Count living
  var livCount = 0;
  for (var i = 0; i < allCells.length; i++) {
    if (allCells[i] !== keepWZ) livCount++;
  }

  var type = aptType(livCount);

  // Validate insol
  var livingCells = [];
  for (var i = 0; i < allCells.length; i++) {
    if (allCells[i] !== keepWZ) livingCells.push(allCells[i]);
  }
  var flags = [];
  for (var i = 0; i < livingCells.length; i++) flags.push(getFlag(insolMap, livingCells[i]));
  var v = validateApartment(flags);

  return {
    cells: cells,
    wetCell: keepWZ,
    type: type,
    valid: v.valid,
    torec: aptA.torec || aptB.torec,
    corridorLabel: aptA.corridorLabel || aptB.corridorLabel || null
  };
}

/**
 * Score a potential merge pair for priority.
 * Higher score = merge first.
 *
 * Three tiers:
 *   1. Direct need: merged type is in remaining quota → high score
 *   2. Growth path: merged type is a stepping stone toward a larger
 *      needed type (2K→3K→4K) → medium score
 *   3. No benefit → 0
 */
function scoreMergePair(aptA, aptB, insolMap, remaining) {
  var livingA = countLiving(aptA);
  var livingB = countLiving(aptB);
  var mergedLiving = livingA + livingB + 1; // +1 because deactivated WZ becomes living

  // Can't exceed 4K
  if (mergedLiving > 4) return -1;

  var mergedType = aptType(mergedLiving);

  // Bonuses (applied to both direct need and growth path)
  var pairBonus = Math.abs(aptA.wetCell - aptB.wetCell) <= 2 ? 10 : 0;
  var smallBonus = (livingA <= 1 && livingB <= 1) ? 5 : 0;

  // Terminal bonus: 4K is the hardest type to produce (requires 2-floor
  // growth chain). Scale with deficit — aggressive when many 4K needed,
  // gentle when close to target. Capped to not dominate over 3K needs.
  var terminalBonus = 0;
  if (mergedType === '4K') {
    var deficit4K = Math.max(0, remaining['4K'] || 0);
    terminalBonus = Math.min(15, deficit4K * 2);
  }

  // Tier 1: Direct need — merged type is what we're looking for
  var need = remaining[mergedType] || 0;
  if (need > 0) {
    return need + pairBonus + smallBonus + terminalBonus;
  }

  // Tier 2: Growth path — merged type is a stepping stone to a larger needed type
  // Chain: 1K → 2K → 3K → 4K. If merging to 2K and we need 3K or 4K,
  // this merge is a valuable growth step.
  var NEXT = { '1K': '2K', '2K': '3K', '3K': '4K' };
  var growthNeed = 0;
  var steps = 0;
  var nextType = NEXT[mergedType];
  while (nextType) {
    steps++;
    var n = remaining[nextType] || 0;
    if (n > 0) growthNeed = Math.max(growthNeed, n);
    nextType = NEXT[nextType];
  }

  if (growthNeed > 0) {
    // Score: lower than direct need, penalized by distance in growth chain.
    // steps=1: merge to 3K when need 4K (close), steps=2: merge to 2K when need 4K (far)
    var growthScore = Math.max(1, Math.ceil(growthNeed / (steps + 1)));
    return growthScore + Math.floor(pairBonus / 2) + Math.floor(smallBonus / 2);
  }

  return 0; // no growth benefit
}

// ── Corridor Assignment ──────────────────────────────

function reassignCorridors(apartments, sortedCorrNears, N) {
  // Remove all existing corridor labels
  for (var ai = 0; ai < apartments.length; ai++) {
    var apt = apartments[ai];
    var numOnly = [];
    for (var ci = 0; ci < apt.cells.length; ci++) {
      if (typeof apt.cells[ci] === 'number') numOnly.push(apt.cells[ci]);
    }
    apt.cells = numOnly;
    apt.corridorLabel = null;
  }

  // Build global cell→apartment map
  var cellToApt = {};
  for (var ai = 0; ai < apartments.length; ai++) {
    for (var ci = 0; ci < apartments[ai].cells.length; ci++) {
      var c = apartments[ai].cells[ci];
      if (typeof c === 'number') cellToApt[c] = ai;
    }
  }

  // Assign corridors
  // Rule: corridor is shared infrastructure (evacuation path).
  // Only assign to apartment if:
  //   a) Same apartment owns BOTH near and far cells, OR
  //   b) Outermost corridor (torec end) → assign to torec
  var assigned = {};
  for (var cni = 0; cni < sortedCorrNears.length; cni++) {
    var nearC = sortedCorrNears[cni];
    var farC = nearToFar(nearC, N);
    var label = nearC + '-' + farC;

    var nearOwner = cellToApt[nearC];
    var farOwner = cellToApt[farC];

    var owner = -1;

    if (nearOwner !== undefined && farOwner !== undefined && nearOwner === farOwner) {
      // Same apartment owns both → assign
      owner = nearOwner;
    } else {
      // Different owners: only outermost (torec end) gets assigned
      var isOutermost = nearC === 0 || nearC === N - 1;
      if (isOutermost) {
        if (nearOwner !== undefined && apartments[nearOwner] && apartments[nearOwner].torec) owner = nearOwner;
        else if (farOwner !== undefined && apartments[farOwner] && apartments[farOwner].torec) owner = farOwner;
      }
      // All other corridors: unassigned (shared corridor spine)
    }

    if (owner >= 0 && !assigned[label]) {
      apartments[owner].cells.push(label);
      if (!apartments[owner].corridorLabel) apartments[owner].corridorLabel = label;
      assigned[label] = true;
    }
  }
}

// ── Main: Plan One Floor ─────────────────────────────

/**
 * Plan one floor by merging from previous floor's layout.
 *
 * @param {Array<Object>} prevApartments - previous floor's apartments
 * @param {Object} insolMap - { cellId: 'p'|'w'|'f' }
 * @param {Object} remaining - mutable { '1K': n, ... }
 * @param {number} floorsLeft - for scaling
 * @param {number} N
 * @param {Array<number>} sortedCorrNears
 * @param {number} [targetMerges] - override merge count from TrajectoryPlanner
 * @returns {Object} { apartments, placed }
 */
export function planFloorByMerge(prevApartments, insolMap, remaining, floorsLeft, N, sortedCorrNears, targetMerges, floorCells, mix) {
  // 1. Deep copy
  var apartments = copyApartments(prevApartments);

  // 2. Compute merges needed
  var types = ['1K', '2K', '3K', '4K'];
  var sumR = 0;
  for (var i = 0; i < types.length; i++) {
    sumR += Math.max(0, remaining[types[i]] || 0);
  }

  // Use remaining for merge scoring
  var scoreRef = remaining;

  var currentCount = apartments.length;
  var mergesThisFloor;

  if (targetMerges !== undefined && targetMerges !== null) {
    mergesThisFloor = Math.min(Math.max(0, targetMerges), currentCount - 2);
  } else {
    // Fallback heuristic
    var totalCells = 0;
    for (var ai = 0; ai < apartments.length; ai++) {
      for (var ci = 0; ci < apartments[ai].cells.length; ci++) {
        if (typeof apartments[ai].cells[ci] === 'number') totalCells++;
      }
    }
    var weightedSum = 0;
    for (var i = 0; i < types.length; i++) {
      weightedSum += Math.max(0, remaining[types[i]] || 0) * TYPE_WIDTH[types[i]];
    }
    var targetAvgWidth = sumR > 0 ? weightedSum / sumR : 2;
    var targetCount = Math.max(2, Math.round(totalCells / targetAvgWidth));
    var mergesNeeded = Math.max(0, currentCount - targetCount);
    mergesThisFloor = Math.max(0, Math.ceil(mergesNeeded / Math.max(1, Math.sqrt(floorsLeft))));
    if (mergesThisFloor > mergesNeeded) mergesThisFloor = mergesNeeded;
    if (mergesNeeded > 0 && mergesThisFloor === 0) mergesThisFloor = 1;
  }

  // 3. Merge
  var isScheduled = (targetMerges !== undefined && targetMerges !== null && targetMerges > 0);

  for (var m = 0; m < mergesThisFloor; m++) {
    var bestScore = -1;
    var bestI = -1;
    var bestJ = -1;

    for (var ai = 0; ai < apartments.length; ai++) {
      if (countLiving(apartments[ai]) >= 4) continue;
      for (var bi = ai + 1; bi < apartments.length; bi++) {
        if (countLiving(apartments[bi]) >= 4) continue;
        if (!areAdjacent(apartments[ai], apartments[bi], N)) continue;
        var score = scoreMergePair(apartments[ai], apartments[bi], insolMap, scoreRef);
        if (isScheduled && score === 0) score = 1;
        if (score > bestScore) { bestScore = score; bestI = ai; bestJ = bi; }
      }
    }
    if (bestI < 0 || bestScore < 0) break;

    apartments[bestI] = mergeApartments(apartments[bestI], apartments[bestJ], insolMap);
    apartments.splice(bestJ, 1);
  }

  // 4. SINGLE rebalance pass: dynamic per-floor target
  // Compute target for THIS floor's actual apartment count and cell count
  if (mix && floorCells > 0) {
    var aptCount = apartments.length;

    // Determine forbidden types (0% in mix)
    var mixSum = 0;
    for (var i = 0; i < types.length; i++) mixSum += (mix[types[i]] || 0);
    if (mixSum === 0) mixSum = 100;
    var forbidden = {};
    for (var i = 0; i < types.length; i++) {
      if ((mix[types[i]] || 0) === 0) forbidden[types[i]] = true;
    }

    // Find best composition: Σ n_t = aptCount, Σ n_t * w_t = floorCells
    // Minimize L1 area deviation from mix
    var dynTarget = solveDynTarget(aptCount, floorCells, mix, forbidden);
    if (dynTarget) {
      dynamicRebalance(apartments, dynTarget, insolMap, N);
    }
  }

  return finalize(apartments, remaining, sortedCorrNears, N);
}

// ── Dynamic Target Solver ─────────────────────────────

/**
 * Find best type distribution for K apartments in C cells.
 * Constraints: Σ n_t = K, Σ n_t * w_t = C, n_t >= 0 integer.
 * Forbidden types get n_t = 0.
 * Objective: minimize L1 area deviation from mix.
 *
 * Small K (typically 5-16), brute-force O(K^2) over 2 free vars.
 */
function solveDynTarget(K, C, mix, forbidden) {
  var types = ['1K', '2K', '3K', '4K'];
  var w = { '1K': 2, '2K': 3, '3K': 4, '4K': 5 };

  var mixSum = 0;
  for (var i = 0; i < types.length; i++) mixSum += (mix[types[i]] || 0);
  if (mixSum === 0) mixSum = 100;
  var alpha = {};
  for (var i = 0; i < types.length; i++) alpha[types[i]] = (mix[types[i]] || 0) / mixSum;

  var active = [];
  for (var i = 0; i < types.length; i++) {
    if (!forbidden[types[i]]) active.push(types[i]);
  }
  if (active.length === 0) return null;

  var best = null;
  var bestDev = Infinity;

  // Enumerate all valid distributions with up to 4 active types
  // Use first (active.length - 1) types as free variables, last from constraints
  var na = active.length;
  var last = active[na - 1];
  var wLast = w[last];

  if (na === 1) {
    // Only one active type: n_last = K, check cells
    if (K * wLast === C) {
      best = {};
      for (var i = 0; i < types.length; i++) best[types[i]] = 0;
      best[last] = K;
    }
    return best;
  }

  // Enumerate free variables (all except last)
  function enumerate(depth, kLeft, cLeft, sol) {
    if (depth === na - 1) {
      // Last active type absorbs remainder
      if (kLeft < 0) return;
      if (cLeft !== kLeft * wLast) return;
      sol[last] = kLeft;

      // Score
      var dev = 0;
      for (var i = 0; i < types.length; i++) {
        var frac = C > 0 ? ((sol[types[i]] || 0) * w[types[i]]) / C : 0;
        dev += Math.abs(frac - alpha[types[i]]);
      }
      if (dev < bestDev) {
        bestDev = dev;
        best = {};
        for (var i = 0; i < types.length; i++) best[types[i]] = sol[types[i]] || 0;
      }
      return;
    }

    var t = active[depth];
    var wt = w[t];
    var maxN = Math.min(kLeft, Math.floor(cLeft / wt));
    for (var n = 0; n <= maxN; n++) {
      sol[t] = n;
      enumerate(depth + 1, kLeft - n, cLeft - n * wt, sol);
    }
    sol[t] = 0;
  }

  var sol = {};
  for (var i = 0; i < types.length; i++) sol[types[i]] = 0;
  enumerate(0, K, C, sol);

  return best;
}

// ── Dynamic Rebalance ─────────────────────────────────

/**
 * Single rebalance pass to match dynTarget.
 * Replaces the old triple-rebalance (rebalance + growthRebalance + floorTargetRebalance).
 */
function dynamicRebalance(apartments, dynTarget, insolMap, N) {
  var types = ['1K', '2K', '3K', '4K'];
  var maxIter = 30;

  for (var iter = 0; iter < maxIter; iter++) {
    var placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
    for (var ai = 0; ai < apartments.length; ai++) {
      var t = apartments[ai].type;
      if (placed[t] !== undefined) placed[t]++;
    }

    var deficit = {};
    var totalAbsDev = 0;
    for (var i = 0; i < types.length; i++) {
      deficit[types[i]] = (dynTarget[types[i]] || 0) - (placed[types[i]] || 0);
      totalAbsDev += Math.abs(deficit[types[i]]);
    }
    if (totalAbsDev <= 1) break;

    var improved = false;

    for (var ai = 0; ai < apartments.length; ai++) {
      var livA = countLiving(apartments[ai]);
      var typeA = apartments[ai].type;
      if ((deficit[typeA] || 0) >= 0) continue; // not oversupplied

      for (var bi = 0; bi < apartments.length; bi++) {
        if (bi === ai) continue;
        if (!areAdjacent(apartments[ai], apartments[bi], N)) continue;

        var livB = countLiving(apartments[bi]);
        var typeB = apartments[bi].type;

        // Try shrink A, grow B
        if (livA >= 2 && livB + 1 <= 4) {
          var newTypeA = aptType(livA - 1);
          var newTypeB = aptType(livB + 1);

          // Would this improve L1?
          var oldD = Math.abs(deficit[typeA] || 0) + Math.abs(deficit[typeB] || 0)
            + Math.abs(deficit[newTypeA] || 0) + Math.abs(deficit[newTypeB] || 0);

          // Simulate deficit change
          var sim = {};
          for (var i = 0; i < types.length; i++) sim[types[i]] = deficit[types[i]] || 0;
          if (typeA !== newTypeA) { sim[typeA]++; sim[newTypeA]--; }
          if (typeB !== newTypeB) { sim[typeB]++; sim[newTypeB]--; }

          var newD = Math.abs(sim[typeA]) + Math.abs(sim[typeB])
            + Math.abs(sim[newTypeA]) + Math.abs(sim[newTypeB]);

          if (newD < oldD) {
            var transferred = transferCell(apartments[ai], apartments[bi], N, insolMap);
            if (transferred) {
              apartments[ai].type = newTypeA;
              apartments[bi].type = newTypeB;
              improved = true;
              break;
            }
          }
        }
      }
      if (improved) break;
    }
    if (!improved) break;
  }
}

// ── Rebalance ────────────────────────────────────────

/**
 * Transfer boundary cells between adjacent apartments to better match quota.
 * Moves the boundary without changing WZ: only living cells transfer.
 *
 * Example: [3K] [1K] with remaining wanting 2K → transfer 1 cell → [2K] [2K]
 *
 * Multiple passes until no improvement.
 */
function rebalance(apartments, remaining, insolMap, N) {
  var types = ['1K', '2K', '3K', '4K'];
  var maxIter = 20;

  for (var iter = 0; iter < maxIter; iter++) {
    var improved = false;

    for (var ai = 0; ai < apartments.length; ai++) {
      for (var bi = ai + 1; bi < apartments.length; bi++) {
        if (!areAdjacent(apartments[ai], apartments[bi], N)) continue;

        var livA = countLiving(apartments[ai]);
        var livB = countLiving(apartments[bi]);
        var typeA = apartments[ai].type;
        var typeB = apartments[bi].type;

        // Current "badness": how far from quota
        var needA = remaining[typeA] || 0;
        var needB = remaining[typeB] || 0;
        var currentBad = Math.max(0, -needA) + Math.max(0, -needB);

        // Try transfer A→B (shrink A, grow B)
        if (livA >= 2) {
          var newTypeA = aptType(livA - 1);
          var newTypeB = aptType(livB + 1);
          if (livB + 1 <= 4) {
            var newNeedA = (remaining[newTypeA] || 0) + (typeA === newTypeA ? 0 : 1);
            var newNeedB = (remaining[newTypeB] || 0) - (typeB === newTypeB ? 0 : 1);
            var newBad = Math.max(0, -newNeedA) + Math.max(0, -newNeedB);

            if (newBad < currentBad) {
              var transferred = transferCell(apartments[ai], apartments[bi], N, insolMap);
              if (transferred) {
                if (typeA !== newTypeA) { remaining[typeA]++; remaining[newTypeA]--; }
                if (typeB !== newTypeB) { remaining[typeB]++; remaining[newTypeB]--; }
                apartments[ai].type = newTypeA;
                apartments[bi].type = newTypeB;
                improved = true;
                break;
              }
            }
          }
        }

        // Try transfer B→A (shrink B, grow A)
        if (livB >= 2 && !improved) {
          var newTypeA2 = aptType(livA + 1);
          var newTypeB2 = aptType(livB - 1);
          if (livA + 1 <= 4) {
            var newNeedA2 = (remaining[newTypeA2] || 0) - (typeA === newTypeA2 ? 0 : 1);
            var newNeedB2 = (remaining[newTypeB2] || 0) + (typeB === newTypeB2 ? 0 : 1);
            var newBad2 = Math.max(0, -newNeedA2) + Math.max(0, -newNeedB2);

            if (newBad2 < currentBad) {
              var transferred2 = transferCell(apartments[bi], apartments[ai], N, insolMap);
              if (transferred2) {
                if (typeA !== newTypeA2) { remaining[typeA]++; remaining[newTypeA2]--; }
                if (typeB !== newTypeB2) { remaining[typeB]++; remaining[newTypeB2]--; }
                apartments[ai].type = newTypeA2;
                apartments[bi].type = newTypeB2;
                improved = true;
                break;
              }
            }
          }
        }

        if (improved) break;
      }
      if (improved) break;
    }

    if (!improved) break;
  }
}

/**
 * Transfer one boundary living cell from donor to receiver.
 * The cell must be adjacent to a cell in the receiver AND
 * must not be the donor's WZ.
 *
 * Validates insolation: rejects transfers that would make
 * either apartment invalid (e.g., 1K living without 'p').
 *
 * @param {Object} donor
 * @param {Object} receiver
 * @param {number} N
 * @param {Object} [insolMap] - if provided, validates insolation after transfer
 * @returns {boolean} true if transfer succeeded
 */
function transferCell(donor, receiver, N, insolMap) {
  // Build receiver cell set
  var recvSet = {};
  for (var ci = 0; ci < receiver.cells.length; ci++) {
    if (typeof receiver.cells[ci] === 'number') recvSet[receiver.cells[ci]] = true;
  }

  // Find boundary cell in donor: living, adjacent to receiver, same row
  var donorLiving = [];
  for (var ci = 0; ci < donor.cells.length; ci++) {
    var c = donor.cells[ci];
    if (typeof c === 'number' && c !== donor.wetCell) donorLiving.push(c);
  }

  // Sort: prefer cells furthest from WZ (boundary cells)
  donorLiving.sort(function (a, b) {
    return Math.abs(b - donor.wetCell) - Math.abs(a - donor.wetCell);
  });

  for (var di = 0; di < donorLiving.length; di++) {
    var cell = donorLiving[di];
    var cellRow = cell < N ? 0 : 1;

    // Check if adjacent to any receiver cell in same row
    for (var delta = -1; delta <= 1; delta += 2) {
      var nb = cell + delta;
      if (!recvSet[nb]) continue;
      var nbRow = nb < N ? 0 : 1;
      if (nbRow !== cellRow) continue;

      // ── Insolation guard: validate both apartments after transfer ──
      if (insolMap) {
        // Donor's remaining living after losing `cell`
        var donorRemLiving = [];
        for (var k = 0; k < donorLiving.length; k++) {
          if (donorLiving[k] !== cell) donorRemLiving.push(donorLiving[k]);
        }
        // Reject if donor would have 0 living (degenerate WZ-only apartment)
        if (donorRemLiving.length === 0) continue;
        var dFlags = [];
        for (var k = 0; k < donorRemLiving.length; k++) {
          dFlags.push(getFlag(insolMap, donorRemLiving[k]));
        }
        if (!validateApartment(dFlags).valid) continue;

        // Receiver's living after gaining `cell`
        var recvLiving = [];
        for (var k = 0; k < receiver.cells.length; k++) {
          var rc = receiver.cells[k];
          if (typeof rc === 'number' && rc !== receiver.wetCell) recvLiving.push(rc);
        }
        recvLiving.push(cell);
        var rFlags = [];
        for (var k = 0; k < recvLiving.length; k++) {
          rFlags.push(getFlag(insolMap, recvLiving[k]));
        }
        if (!validateApartment(rFlags).valid) continue;
      }

      // Valid transfer: remove from donor, add to receiver
      var newDonorCells = [];
      for (var ci = 0; ci < donor.cells.length; ci++) {
        if (donor.cells[ci] !== cell) newDonorCells.push(donor.cells[ci]);
      }
      donor.cells = newDonorCells;
      receiver.cells.push(cell);
      return true;
    }
  }

  return false;
}

// ── Growth Rebalance ────────────────────────────────

/**
 * Proactively convert 3K+1K adjacent pairs into 2K+2K
 * when 4K apartments are needed in the quota.
 *
 * Growth chain: 3K → transfer 1 cell → 2K + 2K.
 * Then on the next floor: 2K + 1K → merge → 4K.
 *
 * Normal rebalance only triggers on overproduction (remaining < 0).
 * This pass triggers on GROWTH NEED (remaining['4K'] > 0).
 *
 * Limit: at most remaining['4K'] conversions per call,
 * so we don't over-convert 3K into 2K.
 */
function growthRebalance(apartments, remaining, insolMap, N) {
  var need4K = remaining['4K'] || 0;
  if (need4K <= 0) return;

  // Count current 3K apartments on this floor
  var current3K = 0;
  for (var ai = 0; ai < apartments.length; ai++) {
    if (countLiving(apartments[ai]) === 3) current3K++;
  }
  if (current3K === 0) return;

  // Proportional allocation: split 3K between direct quota and 4K growth.
  // Ratio of 3K that should be converted to 2K for 4K trajectory.
  var need3K = Math.max(0, remaining['3K'] || 0);
  var ratio = need4K / Math.max(1, need3K + need4K);
  var maxConversions = Math.max(need4K > 0 ? 1 : 0, Math.floor(current3K * ratio));

  // Never convert more than we have or need
  maxConversions = Math.min(maxConversions, current3K, need4K);

  var conversions = 0;
  var maxIter = 20;

  for (var iter = 0; iter < maxIter && conversions < maxConversions; iter++) {
    var found = false;

    for (var ai = 0; ai < apartments.length; ai++) {
      var livA = countLiving(apartments[ai]);
      if (livA !== 3) continue;

      for (var bi = 0; bi < apartments.length; bi++) {
        if (bi === ai) continue;
        var livB = countLiving(apartments[bi]);
        if (livB !== 1) continue;
        if (!areAdjacent(apartments[ai], apartments[bi], N)) continue;

        var transferred = transferCell(apartments[ai], apartments[bi], N, insolMap);
        if (transferred) {
          remaining['3K'] = (remaining['3K'] || 0) + 1;
          remaining['1K'] = (remaining['1K'] || 0) + 1;
          remaining['2K'] = (remaining['2K'] || 0) - 2;

          apartments[ai].type = aptType(livA - 1);
          apartments[bi].type = aptType(livB + 1);

          conversions++;
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) break;
  }
}

// ── Floor-Target Rebalance ────────────────────────────

/**
 * Fine-tune apartment types on this floor to match floorTarget.
 *
 * After merges and global rebalance, the floor may have surplus of
 * one type (e.g., 3K) and deficit of another (e.g., 2K). This pass
 * transfers cells between adjacent apartments to fix the distribution.
 *
 * Only fires when it can produce a net improvement in L1 deviation
 * from floorTarget. Does not affect global remaining.
 */
function floorTargetRebalance(apartments, floorTarget, insolMap, N) {
  var types = ['1K', '2K', '3K', '4K'];
  var maxIter = 20;

  for (var iter = 0; iter < maxIter; iter++) {
    // Compute current floor placement
    var placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
    for (var ai = 0; ai < apartments.length; ai++) {
      var t = apartments[ai].type;
      if (placed[t] !== undefined) placed[t]++;
    }

    // Compute deficit
    var deficit = {};
    var totalAbsDev = 0;
    for (var i = 0; i < types.length; i++) {
      deficit[types[i]] = (floorTarget[types[i]] || 0) - (placed[types[i]] || 0);
      totalAbsDev += Math.abs(deficit[types[i]]);
    }

    if (totalAbsDev <= 1) break; // close enough

    // Find a transfer that reduces total deviation
    var improved = false;

    for (var ai = 0; ai < apartments.length; ai++) {
      var livA = countLiving(apartments[ai]);
      var typeA = apartments[ai].type;
      if (deficit[typeA] >= 0) continue; // not oversupplied

      for (var bi = 0; bi < apartments.length; bi++) {
        if (bi === ai) continue;
        if (!areAdjacent(apartments[ai], apartments[bi], N)) continue;

        var livB = countLiving(apartments[bi]);
        var typeB = apartments[bi].type;

        // Try shrink A (surplus type), grow B
        if (livA >= 2 && livB + 1 <= 4) {
          var newTypeA = aptType(livA - 1);
          var newTypeB = aptType(livB + 1);

          // Check if this reduces total deviation
          var oldDev = Math.abs(deficit[typeA]) + Math.abs(deficit[typeB])
            + Math.abs(deficit[newTypeA] || 0) + Math.abs(deficit[newTypeB] || 0);
          var dA = (deficit[typeA] || 0) + 1;
          var dB = (deficit[typeB] || 0) + 1;
          var dNA = (deficit[newTypeA] || 0) - 1;
          var dNB = (deficit[newTypeB] || 0) - 1;
          // Adjust for same-type transitions
          if (typeA === newTypeA) { dA = deficit[typeA]; dNA = deficit[newTypeA]; }
          if (typeB === newTypeB) { dB = deficit[typeB]; dNB = deficit[newTypeB]; }
          if (typeA === newTypeB) { dA = deficit[typeA] + 1; dNB = deficit[newTypeB] - 1; }
          if (newTypeA === typeB) { dNA = deficit[newTypeA] - 1; dB = deficit[typeB] + 1; }

          var newDev = Math.abs(dA) + Math.abs(dB) + Math.abs(dNA) + Math.abs(dNB);

          if (newDev < oldDev) {
            var transferred = transferCell(apartments[ai], apartments[bi], N, insolMap);
            if (transferred) {
              apartments[ai].type = newTypeA;
              apartments[bi].type = newTypeB;
              improved = true;
              break;
            }
          }
        }
      }
      if (improved) break;
    }

    if (!improved) break;
  }
}

function finalize(apartments, remaining, sortedCorrNears, N) {
  // Reassign corridors
  reassignCorridors(apartments, sortedCorrNears, N);

  // Recount types
  for (var ai = 0; ai < apartments.length; ai++) {
    var liv = countLiving(apartments[ai]);
    apartments[ai].type = aptType(liv);
  }

  // Count placed
  var placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
  for (var ai = 0; ai < apartments.length; ai++) {
    var t = apartments[ai].type;
    if (placed[t] !== undefined) placed[t]++;
  }

  // Count active WZ
  var wzCount = 0;
  for (var ai = 0; ai < apartments.length; ai++) {
    if (typeof apartments[ai].wetCell === 'number') wzCount++;
  }

  return { apartments: apartments, placed: placed, activeWZ: wzCount };
}

// ── Global Quota ─────────────────────────────────────

/**
 * Compute global quota from total apartment count and target percentages.
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

  var left = totalApts - assigned;
  while (left > 0) {
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
      fracs[bestType] = -1;
      left--;
    } else break;
  }

  return result;
}