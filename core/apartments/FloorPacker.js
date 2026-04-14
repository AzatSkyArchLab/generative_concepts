/**
 * FloorPacker — composition-based greedy apartment packer.
 *
 * Phase 1 of the new packing algorithm.
 *
 * Given:
 *   - Floor 2 layout (base), WZ positions, LLU, corridor positions
 *   - Per-floor insolation maps
 *   - Target quota Q (from Phase 0 QuotaResolver)
 *
 * Algorithm per floor:
 *   1. Place torec apartments at edges (left, right)
 *   2. Partition remaining near/far rows into segments (bounded by WZ)
 *   3. Enumerate compositions per segment
 *   4. Filter by insolation validation
 *   5. Greedy-select composition closest to remaining quota
 *
 * Pure logic — no rendering, no Three.js.
 */

import { log } from '../Logger.js';

import { validateApartment, getFlag } from './ApartmentSolver.js';

import { nearToFar } from './CellTopology.js';
var TYPES = ['1K', '2K', '3K', '4K'];
var WIDTHS = { '1K': 2, '2K': 3, '3K': 4, '4K': 5 };
var LIVING = { '1K': 1, '2K': 2, '3K': 3, '4K': 4 };
var MIN_WIDTH = 2;
var MAX_WIDTH = 5;

// ── Compositions ───────────────────────────────────────

/**
 * Enumerate all valid partitions of a row segment into apartments.
 *
 * Each apartment must contain exactly one WZ from wzPositions.
 * Group sizes must be in [2..5].
 *
 * @param {number} start - first cell index (inclusive)
 * @param {number} end - last cell index (inclusive)
 * @param {Array<number>} wzPositions - sorted WZ positions within [start..end]
 * @returns {Array<Array<{start, end, wzCell, width, type}>>}
 */
function enumeratePartitions(start, end, wzPositions) {
  var results = [];
  if (wzPositions.length === 0) return results;

  function recurse(groupIdx, groupStart, current) {
    if (groupIdx === wzPositions.length) {
      // All WZ placed — check that we've covered everything
      if (groupStart > end + 1) {
        results.push(current.slice());
      }
      return;
    }

    var wz = wzPositions[groupIdx];
    var nextWZ = groupIdx + 1 < wzPositions.length ? wzPositions[groupIdx + 1] : end + 1;
    var isLast = groupIdx === wzPositions.length - 1;

    // Group must contain wz, start at groupStart
    // Group end can be from max(wz, groupStart+1) to min(groupStart+MAX_WIDTH-1, nextWZ-1, end)
    var minEnd = Math.max(wz, groupStart + MIN_WIDTH - 1);
    var maxEnd;
    if (isLast) {
      maxEnd = end; // last group must go to the end
    } else {
      maxEnd = Math.min(groupStart + MAX_WIDTH - 1, nextWZ - 1, end);
    }

    for (var gEnd = minEnd; gEnd <= maxEnd; gEnd++) {
      var width = gEnd - groupStart + 1;
      if (width < MIN_WIDTH || width > MAX_WIDTH) continue;
      // Verify exactly one WZ in this group
      var wzCount = 0;
      for (var wi = groupIdx; wi < wzPositions.length; wi++) {
        if (wzPositions[wi] >= groupStart && wzPositions[wi] <= gEnd) wzCount++;
        if (wzPositions[wi] > gEnd) break;
      }
      if (wzCount !== 1) continue;

      var typeKey = width <= 5 ? TYPES[width - 2] : null;
      if (!typeKey) continue;

      current.push({
        start: groupStart,
        end: gEnd,
        wzCell: wz,
        width: width,
        type: typeKey
      });

      if (isLast && gEnd === end) {
        results.push(current.slice());
      } else if (!isLast) {
        recurse(groupIdx + 1, gEnd + 1, current);
      }

      current.pop();
    }
  }

  recurse(0, start, []);
  return results;
}

// ── Insolation validation ──────────────────────────────

/**
 * Check if a partition entry passes insolation validation.
 *
 * @param {Object} entry - {start, end, wzCell, width, type}
 * @param {Object} insolMap - cellId -> 'p'/'w'/'f'
 * @returns {boolean}
 */
function validateEntry(entry, insolMap) {
  var livingFlags = [];
  for (var c = entry.start; c <= entry.end; c++) {
    if (c === entry.wzCell) continue;
    livingFlags.push(getFlag(insolMap, c));
  }
  var result = validateApartment(livingFlags);
  return result.valid;
}

/**
 * Check if an entire partition passes insolation.
 *
 * @param {Array} partition
 * @param {Object} insolMap
 * @returns {boolean}
 */
function validatePartition(partition, insolMap) {
  for (var i = 0; i < partition.length; i++) {
    if (!validateEntry(partition[i], insolMap)) return false;
  }
  return true;
}

// ── Profile scoring ────────────────────────────────────

/**
 * Compute type profile for a partition.
 * @returns {Object} {1K: n, 2K: n, 3K: n, 4K: n}
 */
function partitionProfile(partition) {
  var profile = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
  for (var i = 0; i < partition.length; i++) {
    var t = partition[i].type;
    if (profile[t] !== undefined) profile[t]++;
  }
  return profile;
}

/**
 * Score how well a partition serves remaining quota.
 * Lower = better.
 *
 * @param {Object} profile - {1K: n, ...}
 * @param {Object} target - ideal per-floor counts {1K: n, ...}
 * @returns {number}
 */
function scoreProfile(profile, target) {
  var score = 0;
  for (var i = 0; i < TYPES.length; i++) {
    var t = TYPES[i];
    score += Math.abs((profile[t] || 0) - (target[t] || 0));
  }
  return score;
}

// ── Torec placement ────────────────────────────────────

/**
 * Place a torec apartment at one end.
 *
 * @param {string} side - 'left' or 'right'
 * @param {number} N - cells per row
 * @param {Array<number>} activeWZ - all active WZ on this floor
 * @param {Object} insolMap - cellId -> flag
 * @param {Array<number>} corrNears - near positions of corridors
 * @param {Object} remainder - remaining quota {1K: n, ...}
 * @returns {Object|null} apartment {type, cells, wetCell, torec, corridorLabel}
 */
function placeTorec(side, N, activeWZ, insolMap, corrNears, remainder) {
  var nearCell, farCell, corrNear;

  if (side === 'left') {
    nearCell = 0;
    farCell = nearToFar(0, N);
    corrNear = corrNears.length > 0 ? corrNears[0] : 0;
  } else {
    nearCell = N - 1;
    farCell = nearToFar(N - 1, N);
    corrNear = corrNears.length > 0 ? corrNears[corrNears.length - 1] : N - 1;
  }

  var corridorLabel = nearCell + '-' + farCell;

  // Base torec: 1K (near + far through corridor)
  var baseCells = [nearCell, farCell];
  var nearFlag = getFlag(insolMap, nearCell);
  var farFlag = getFlag(insolMap, farCell);

  // WZ goes on worst insolation cell
  var wzCell;
  if (nearFlag === 'f') wzCell = nearCell;
  else if (farFlag === 'f') wzCell = farCell;
  else if (nearFlag === 'w') wzCell = nearCell;
  else if (farFlag === 'w') wzCell = farCell;
  else wzCell = nearCell;

  // Check what types we can build, ordered by quota need
  var typeCandidates = [];
  for (var i = 0; i < TYPES.length; i++) {
    var t = TYPES[i];
    if ((remainder[t] || 0) > 0) typeCandidates.push(t);
  }
  // Sort by highest remaining need
  typeCandidates.sort(function (a, b) {
    return (remainder[b] || 0) - (remainder[a] || 0);
  });

  // Try each type starting from most-needed
  for (var ti = 0; ti < typeCandidates.length; ti++) {
    var tryType = typeCandidates[ti];
    var needed = WIDTHS[tryType];

    // Build cell list for this type
    var cells = [nearCell, farCell];
    var extra = needed - 2;

    // Extend on near side
    if (side === 'left') {
      for (var e = 1; e <= extra && nearCell + e < N; e++) cells.push(nearCell + e);
    } else {
      for (var e = 1; e <= extra && nearCell - e >= 0; e++) cells.push(nearCell - e);
    }

    if (cells.length < needed) continue;
    cells = cells.slice(0, needed);

    // Determine WZ from cells: pick worst insolation
    var worstCell = cells[0];
    var worstRank = flagRank(getFlag(insolMap, cells[0]));
    for (var ci = 1; ci < cells.length; ci++) {
      var r = flagRank(getFlag(insolMap, cells[ci]));
      if (r < worstRank) { worstRank = r; worstCell = cells[ci]; }
    }

    // Validate living cells
    var livingFlags = [];
    for (var ci = 0; ci < cells.length; ci++) {
      if (cells[ci] !== worstCell) livingFlags.push(getFlag(insolMap, cells[ci]));
    }
    var val = validateApartment(livingFlags);
    if (val.valid) {
      return {
        type: tryType,
        cells: cells.concat([corridorLabel]),
        wetCell: worstCell,
        torec: true,
        corridorLabel: corridorLabel
      };
    }
  }

  // Fallback: 1K
  return {
    type: '1K',
    cells: [nearCell, farCell, corridorLabel],
    wetCell: wzCell,
    torec: true,
    corridorLabel: corridorLabel
  };
}

function flagRank(flag) {
  if (flag === 'p') return 2;
  if (flag === 'w') return 1;
  return 0;
}

// ── Row packing ────────────────────────────────────────

/**
 * Pack one row (near or far) using compositions.
 *
 * @param {number} rowStart - first cell of row after torec removal
 * @param {number} rowEnd - last cell of row after torec removal
 * @param {Array<number>} wzInRow - sorted WZ positions in [rowStart..rowEnd]
 * @param {Object} insolMap
 * @param {Object} target - ideal per-floor profile
 * @returns {Object} { apartments: [...], profile: {1K:n,...} }
 */
function packRow(rowStart, rowEnd, wzInRow, insolMap, target) {
  if (wzInRow.length === 0 || rowStart > rowEnd) {
    return { apartments: [], profile: { '1K': 0, '2K': 0, '3K': 0, '4K': 0 } };
  }

  var partitions = enumeratePartitions(rowStart, rowEnd, wzInRow);

  // Filter by insolation
  var valid = [];
  for (var i = 0; i < partitions.length; i++) {
    if (validatePartition(partitions[i], insolMap)) valid.push(partitions[i]);
  }

  if (valid.length === 0) {
    // Fallback: try without validation (log warning)
    log.warn('[FloorPacker] no valid partition for row', rowStart, '-', rowEnd,
      'WZ:', wzInRow.join(','), '— using first raw partition');
    valid = partitions.length > 0 ? [partitions[0]] : [];
  }

  if (valid.length === 0) {
    return { apartments: [], profile: { '1K': 0, '2K': 0, '3K': 0, '4K': 0 } };
  }

  // Score each valid partition
  var bestIdx = 0;
  var bestScore = Infinity;
  for (var i = 0; i < valid.length; i++) {
    var prof = partitionProfile(valid[i]);
    var s = scoreProfile(prof, target);
    if (s < bestScore) { bestScore = s; bestIdx = i; }
  }

  var chosen = valid[bestIdx];
  var apartments = [];
  for (var i = 0; i < chosen.length; i++) {
    var entry = chosen[i];
    var cells = [];
    for (var c = entry.start; c <= entry.end; c++) cells.push(c);
    apartments.push({
      type: entry.type,
      cells: cells,
      wetCell: entry.wzCell,
      torec: false
    });
  }

  return { apartments: apartments, profile: partitionProfile(chosen) };
}

// ── Full floor packing ─────────────────────────────────

/**
 * Pack one floor using composition-based greedy.
 *
 * @param {Object} params
 * @param {number} params.N
 * @param {Array<number>} params.activeWZ - active WZ cell positions
 * @param {Array<number>} params.lluCells - LLU cell positions
 * @param {Object} params.insolMap - cellId -> 'p'/'w'/'f'
 * @param {Array<number>} params.corrNears - sorted corridor near positions
 * @param {Object} params.remainder - remaining quota {1K: n, ...}
 * @param {number} params.floorsLeft - floors remaining (for target division)
 * @param {string} params.orientation
 * @returns {Object} { apartments, placed, remainder }
 */
export function packFloor(params) {
  var N = params.N;
  var activeWZ = params.activeWZ;
  var lluCells = params.lluCells || [];
  var insolMap = params.insolMap || {};
  var corrNears = params.corrNears || [];
  var remainder = {};
  for (var i = 0; i < TYPES.length; i++) {
    remainder[TYPES[i]] = params.remainder[TYPES[i]] || 0;
  }
  var floorsLeft = params.floorsLeft || 1;

  var apartments = [];
  var placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };

  // Build sets for fast lookup
  var wzSet = {};
  for (var i = 0; i < activeWZ.length; i++) wzSet[activeWZ[i]] = true;
  var lluSet = {};
  for (var i = 0; i < lluCells.length; i++) lluSet[lluCells[i]] = true;
  var usedCells = {};
  for (var k in lluSet) usedCells[k] = true;

  // ── Step 1: Torecs ─────────────────────────────────

  var leftTorec = placeTorec('left', N, activeWZ, insolMap, corrNears, remainder);
  if (leftTorec) {
    apartments.push(leftTorec);
    placed[leftTorec.type]++;
    remainder[leftTorec.type] = Math.max(0, remainder[leftTorec.type] - 1);
    for (var ci = 0; ci < leftTorec.cells.length; ci++) {
      var c = leftTorec.cells[ci];
      if (typeof c === 'number') usedCells[c] = true;
    }
  }

  var rightTorec = placeTorec('right', N, activeWZ, insolMap, corrNears, remainder);
  if (rightTorec) {
    apartments.push(rightTorec);
    placed[rightTorec.type]++;
    remainder[rightTorec.type] = Math.max(0, remainder[rightTorec.type] - 1);
    for (var ci = 0; ci < rightTorec.cells.length; ci++) {
      var c = rightTorec.cells[ci];
      if (typeof c === 'number') usedCells[c] = true;
    }
  }

  // ── Step 2: Per-floor target ───────────────────────

  var target = {};
  for (var i = 0; i < TYPES.length; i++) {
    target[TYPES[i]] = Math.round(remainder[TYPES[i]] / floorsLeft);
  }

  // ── Step 3: Pack near row (split by LLU) ────────────

  var nearSegments = [];
  var curNearSeg = [];
  var curNearWZ = [];
  for (var c = 0; c < N; c++) {
    if (usedCells[c] || lluSet[c]) {
      if (curNearSeg.length > 0 && curNearWZ.length > 0) {
        nearSegments.push({ cells: curNearSeg.slice(), wz: curNearWZ.slice() });
      }
      curNearSeg = [];
      curNearWZ = [];
      continue;
    }
    curNearSeg.push(c);
    if (wzSet[c]) curNearWZ.push(c);
  }
  if (curNearSeg.length > 0 && curNearWZ.length > 0) {
    nearSegments.push({ cells: curNearSeg.slice(), wz: curNearWZ.slice() });
  }

  for (var nsi = 0; nsi < nearSegments.length; nsi++) {
    var nseg = nearSegments[nsi];
    var nsStart = nseg.cells[0];
    var nsEnd = nseg.cells[nseg.cells.length - 1];
    var nsWZ = nseg.wz.slice();

    var nearResult = packRow(nsStart, nsEnd, nsWZ, insolMap, target);
    for (var i = 0; i < nearResult.apartments.length; i++) {
      apartments.push(nearResult.apartments[i]);
    }
    for (var t in nearResult.profile) {
      if (placed[t] !== undefined) placed[t] += nearResult.profile[t];
      if (remainder[t] !== undefined) remainder[t] = Math.max(0, remainder[t] - nearResult.profile[t]);
    }
    for (var i = 0; i < TYPES.length; i++) {
      target[TYPES[i]] = Math.round(remainder[TYPES[i]] / floorsLeft);
    }
  }

  // ── Step 4: Pack far row ───────────────────────────

  // Far row: cells N..2N-1, but reversed order
  // Find usable far cells and WZ in far, accounting for LLU
  var farSegments = [];
  var currentSeg = [];
  var currentWZ = [];
  // Iterate far in "near-parallel" order: 2N-1, 2N-2, ..., N
  for (var pos = 0; pos < N; pos++) {
    var c = nearToFar(pos, N);
    if (usedCells[c] || lluSet[c]) {
      if (currentSeg.length > 0 && currentWZ.length > 0) {
        farSegments.push({ cells: currentSeg.slice(), wz: currentWZ.slice() });
      }
      currentSeg = [];
      currentWZ = [];
      continue;
    }
    currentSeg.push(c);
    if (wzSet[c]) currentWZ.push(c);
  }
  if (currentSeg.length > 0 && currentWZ.length > 0) {
    farSegments.push({ cells: currentSeg.slice(), wz: currentWZ.slice() });
  }

  for (var si = 0; si < farSegments.length; si++) {
    var seg = farSegments[si];
    // Sort cells for partition enumeration
    var sortedCells = seg.cells.slice().sort(function (a, b) { return a - b; });
    var sortedWZ = seg.wz.slice().sort(function (a, b) { return a - b; });
    var segStart = sortedCells[0];
    var segEnd = sortedCells[sortedCells.length - 1];

    var farResult = packRow(segStart, segEnd, sortedWZ, insolMap, target);
    for (var i = 0; i < farResult.apartments.length; i++) {
      apartments.push(farResult.apartments[i]);
    }
    for (var t in farResult.profile) {
      if (placed[t] !== undefined) placed[t] += farResult.profile[t];
      if (remainder[t] !== undefined) remainder[t] = Math.max(0, remainder[t] - farResult.profile[t]);
    }
    // Update target
    for (var i = 0; i < TYPES.length; i++) {
      target[TYPES[i]] = Math.round(remainder[TYPES[i]] / floorsLeft);
    }
  }

  return {
    apartments: apartments,
    placed: placed,
    remainder: remainder
  };
}

// ── WZ reduction ───────────────────────────────────────

/**
 * Choose which WZ to deactivate when reducing count.
 * Enforces max density: each row can hold at most floor(rowLen/2) WZ.
 * Near row after torecs ≈ N-2 cells, far ≈ N-2-lluCount cells.
 *
 * @param {Array<number>} prevActive - current active WZ positions
 * @param {number} targetCount - desired WZ count
 * @param {Object} insolMap - cellId -> 'p'/'w'/'f'
 * @param {number} N - cells per row
 * @param {number} lluCount - LLU cells count (in far row)
 * @returns {Array<number>} new active WZ
 */
function selectActiveWZ(prevActive, targetCount, insolMap, N, lluCount) {
  if (!lluCount) lluCount = 0;

  var activeSet = {};
  for (var i = 0; i < prevActive.length; i++) activeSet[prevActive[i]] = true;

  var nearWZ = [];
  var farWZ = [];
  for (var i = 0; i < prevActive.length; i++) {
    if (prevActive[i] < N) nearWZ.push(prevActive[i]);
    else farWZ.push(prevActive[i]);
  }

  // Max WZ per row: row must have >= 2 cells per WZ (min apartment = 2)
  var nearRowLen = Math.max(0, N - 2);
  var farRowLen = Math.max(0, N - 2 - lluCount);
  var maxNearWZ = Math.max(1, Math.floor(nearRowLen / 2));
  var maxFarWZ = Math.max(1, Math.floor(farRowLen / 2));

  // Effective target: can't exceed per-row maximums
  var effectiveTarget = Math.min(targetCount, maxNearWZ + maxFarWZ + 2);
  // +2 for torec WZ (one per side, not counted in row)

  // Score each WZ: paired + good neighbors = remove first
  var scored = [];
  for (var i = 0; i < prevActive.length; i++) {
    var wz = prevActive[i];
    var hasPair = (activeSet[wz - 1] || activeSet[wz + 1]) ? 1 : 0;
    var quality = 0;
    for (var d = -1; d <= 1; d += 2) {
      var f = insolMap ? insolMap[wz + d] : null;
      if (f === 'p') quality += 2;
      else if (f === 'w') quality += 1;
    }
    scored.push({ wz: wz, isPaired: hasPair, quality: quality, isNear: wz < N });
  }

  // Remove: paired first, then low quality first
  scored.sort(function (a, b) {
    if (b.isPaired !== a.isPaired) return b.isPaired - a.isPaired;
    return a.quality - b.quality;
  });

  var removed = {};
  var nearRemaining = nearWZ.length;
  var farRemaining = farWZ.length;
  var toRemove = Math.max(0, scored.length - effectiveTarget);

  // Also force removal if a row exceeds its max
  var nearOverflow = Math.max(0, nearRemaining - maxNearWZ);
  var farOverflow = Math.max(0, farRemaining - maxFarWZ);
  toRemove = Math.max(toRemove, nearOverflow + farOverflow);

  for (var i = 0; i < scored.length && toRemove > 0; i++) {
    var wz = scored[i].wz;
    var isNear = scored[i].isNear;
    // Don't remove last WZ in a row
    if (isNear && nearRemaining <= 1) continue;
    if (!isNear && farRemaining <= 1) continue;
    // Prefer removing from overflowing row
    if (nearOverflow > 0 && isNear) {
      removed[wz] = true;
      nearRemaining--;
      nearOverflow--;
      toRemove--;
    } else if (farOverflow > 0 && !isNear) {
      removed[wz] = true;
      farRemaining--;
      farOverflow--;
      toRemove--;
    } else if (nearOverflow === 0 && farOverflow === 0) {
      // Normal removal
      if (isNear && nearRemaining > maxNearWZ) {
        removed[wz] = true;
        nearRemaining--;
        toRemove--;
      } else if (!isNear && farRemaining > maxFarWZ) {
        removed[wz] = true;
        farRemaining--;
        toRemove--;
      } else if (isNear && nearRemaining > 1) {
        removed[wz] = true;
        nearRemaining--;
        toRemove--;
      } else if (!isNear && farRemaining > 1) {
        removed[wz] = true;
        farRemaining--;
        toRemove--;
      }
    }
  }

  var newActive = [];
  for (var i = 0; i < prevActive.length; i++) {
    if (!removed[prevActive[i]]) newActive.push(prevActive[i]);
  }
  newActive.sort(function (a, b) { return a - b; });

  // Post-check: break adjacent WZ pairs (partition impossible if 2 WZ are neighbors)
  var changed = true;
  while (changed) {
    changed = false;
    for (var i = 0; i < newActive.length - 1; i++) {
      if (newActive[i + 1] - newActive[i] === 1) {
        // Adjacent pair found — remove the one with worse insolation neighbors
        var q0 = 0;
        var q1 = 0;
        for (var d = -1; d <= 1; d += 2) {
          var f0 = insolMap ? insolMap[newActive[i] + d] : null;
          var f1 = insolMap ? insolMap[newActive[i + 1] + d] : null;
          if (f0 === 'p') q0 += 2; else if (f0 === 'w') q0 += 1;
          if (f1 === 'p') q1 += 2; else if (f1 === 'w') q1 += 1;
        }
        // Remove the one with lower quality (keep the better one)
        var removeIdx = q0 <= q1 ? i : i + 1;
        // But don't remove last WZ in its row
        var removeWZ = newActive[removeIdx];
        var isNearR = removeWZ < N;
        var rowCount = 0;
        for (var j = 0; j < newActive.length; j++) {
          if ((newActive[j] < N) === isNearR) rowCount++;
        }
        if (rowCount <= 1) {
          // Try removing the other one instead
          removeIdx = removeIdx === i ? i + 1 : i;
          removeWZ = newActive[removeIdx];
          isNearR = removeWZ < N;
          rowCount = 0;
          for (var j = 0; j < newActive.length; j++) {
            if ((newActive[j] < N) === isNearR) rowCount++;
          }
          if (rowCount <= 1) continue; // can't break this pair safely
        }
        newActive.splice(removeIdx, 1);
        changed = true;
        break;
      }
    }
  }

  return newActive;
}

// ── Building loop ──────────────────────────────────────

/**
 * Pack entire building floors 2..K using greedy composition approach.
 *
 * @param {Object} params
 * @param {number} params.N
 * @param {number} params.floorCount - total floors (including commercial)
 * @param {Array<number>} params.allWZ - WZ positions from floor 2
 * @param {Array<Object>} params.floor1Apartments - floor 2 apartment list
 * @param {Object} params.perFloorInsol - {floorNum: insolMap}
 * @param {Array<number>} params.lluCells
 * @param {Array<number>} params.corrNears
 * @param {string} params.orientation
 * @param {Object} params.quota - target Q from Phase 0 {1K:n, 2K:n, 3K:n, 4K:n}
 * @returns {Object} { floors, totalPlaced, deviation }
 */
export function packBuilding(params) {
  var N = params.N;
  var floorCount = params.floorCount;
  var allWZ = params.allWZ;
  var floor1Apartments = params.floor1Apartments || [];
  var perFloorInsol = params.perFloorInsol || {};
  var lluCells = params.lluCells || [];
  var corrNears = params.corrNears || [];
  var orientation = params.orientation || 'lon';
  var quota = params.quota;

  var residentialFloors = floorCount - 1;
  var floors = [];

  // Floor 1 (= floor 2 in building, base)
  var fl1Placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
  for (var i = 0; i < floor1Apartments.length; i++) {
    var t = floor1Apartments[i].type;
    if (fl1Placed[t] !== undefined) fl1Placed[t]++;
  }
  floors.push({ floor: 1, apartments: floor1Apartments, placed: fl1Placed });

  // Remainder after floor 1
  var remainder = {};
  for (var i = 0; i < TYPES.length; i++) {
    var t = TYPES[i];
    remainder[t] = Math.max(0, (quota[t] || 0) - fl1Placed[t]);
  }

  log.debug('[FloorPacker] building start: Q=' + JSON.stringify(quota) +
    ' fl1=' + JSON.stringify(fl1Placed) +
    ' R=' + JSON.stringify(remainder) +
    ' floors=' + residentialFloors);

  // Greedy: floors 2..K (residential floor index)
  var prevWZ = allWZ.slice();
  for (var fl = 2; fl <= residentialFloors; fl++) {
    var floorsLeft = residentialFloors - fl + 1;
    var floorInsol = perFloorInsol[fl] || {};

    // ── WZ reduction: target count from remainder ────
    var targetAptsPerFloor = 0;
    for (var i = 0; i < TYPES.length; i++) {
      targetAptsPerFloor += Math.round((remainder[TYPES[i]] || 0) / floorsLeft);
    }
    // Clamp: min 2 (at least 1 per row), max = previous count
    var targetWZCount = Math.max(2, Math.min(targetAptsPerFloor, prevWZ.length));

    var activeWZ = selectActiveWZ(prevWZ, targetWZCount, floorInsol, N, lluCells.length);

    var result = packFloor({
      N: N,
      activeWZ: activeWZ,
      lluCells: lluCells,
      insolMap: floorInsol,
      corrNears: corrNears,
      remainder: remainder,
      floorsLeft: floorsLeft,
      orientation: orientation
    });

    floors.push({
      floor: fl,
      apartments: result.apartments,
      placed: result.placed,
      activeWZ: activeWZ.length
    });

    // Update remainder
    for (var i = 0; i < TYPES.length; i++) {
      var t = TYPES[i];
      remainder[t] = Math.max(0, remainder[t] - (result.placed[t] || 0));
    }

    log.debug('[FloorPacker] floor', fl,
      'WZ:', prevWZ.length + '→' + activeWZ.length,
      'placed:', JSON.stringify(result.placed),
      'R:', JSON.stringify(remainder));

    prevWZ = activeWZ;
  }

  // Totals
  var totalPlaced = { '1K': 0, '2K': 0, '3K': 0, '4K': 0, orphan: 0 };
  for (var fi = 0; fi < floors.length; fi++) {
    for (var t in floors[fi].placed) {
      if (totalPlaced[t] !== undefined) totalPlaced[t] += floors[fi].placed[t];
    }
  }

  var deviation = {};
  for (var i = 0; i < TYPES.length; i++) {
    var t = TYPES[i];
    deviation[t] = {
      target: quota[t] || 0,
      actual: totalPlaced[t] || 0,
      delta: (totalPlaced[t] || 0) - (quota[t] || 0)
    };
  }

  log.debug('[FloorPacker] TOTAL placed:', JSON.stringify(totalPlaced),
    'target:', JSON.stringify(quota),
    'deviation:', JSON.stringify(deviation));

  return {
    floors: floors,
    totalPlaced: totalPlaced,
    originalQuota: quota,
    deviation: deviation,
    totalTarget: totalPlaced['1K'] + totalPlaced['2K'] + totalPlaced['3K'] + totalPlaced['4K'],
    totalActual: totalPlaced['1K'] + totalPlaced['2K'] + totalPlaced['3K'] + totalPlaced['4K'],
    orphanCount: 0,
    feasible: remainder['1K'] === 0 && remainder['2K'] === 0 &&
      remainder['3K'] === 0 && remainder['4K'] === 0
  };
}
