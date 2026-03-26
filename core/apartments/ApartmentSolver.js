/**
 * ApartmentSolver v4.6.1 — Full квартирография
 *
 * Port of Rhino/GH solver to pure JS. No framework dependencies.
 *
 * Pipeline:
 * 1. Build section topology (near/far segments, LLU, corridors, torecs)
 * 2. Forced torec apartments (1 per physical end)
 * 3. Near sub-segments (LLU = barrier, greedy solve)
 * 4. Far segments (greedy solve)
 * 5. Global orphan resolution
 * 6. Split 5K+ apartments
 * 7. Global wet pairing (frozen-pair protection, torec skip)
 * 8. Wet quality report
 *
 * Insolation flags: 'p' = pass, 'w' = warning, 'f' = fail
 */

// ============================================================
// VALIDATION
// ============================================================

/**
 * Validate apartment insolation per SanPiN.
 * @param {Array<string>} livingFlags - 'p'/'w'/'f' per living cell
 * @returns {{ valid: boolean, type: string }}
 */
export function validateApartment(livingFlags) {
  var n = livingFlags.length;
  if (n === 0) return { valid: false, type: '?' };

  var p = 0, w = 0;
  for (var i = 0; i < n; i++) {
    if (livingFlags[i] === 'p') p++;
    else if (livingFlags[i] === 'w') w++;
  }

  var typeNames = { 1: '1K', 2: '2K', 3: '3K', 4: '4K', 5: '5K' };
  var aptType = typeNames[n] || (n + 'K');

  var requiredP = n <= 3 ? 1 : (n <= 5 ? 2 : 3);

  if (p >= requiredP) return { valid: true, type: aptType };

  // Compensation: 2w per missing p
  var deficit = requiredP - p;
  if (w >= deficit * 2) return { valid: true, type: aptType };

  return { valid: false, type: aptType };
}

export function getFlag(insolMap, cid) {
  if (insolMap && insolMap[cid] !== undefined) return insolMap[cid];
  return 'p';
}

// ============================================================
// TOPOLOGY
// ============================================================

function splitContiguous(ids) {
  if (ids.length === 0) return [];
  var segs = [];
  var cur = [ids[0]];
  for (var i = 1; i < ids.length; i++) {
    if (ids[i] === cur[cur.length - 1] + 1) {
      cur.push(ids[i]);
    } else {
      segs.push(cur.slice());
      cur = [ids[i]];
    }
  }
  segs.push(cur.slice());
  return segs;
}

/**
 * Build section topology from graph nodes.
 * @param {Object} graphNodes - { 'cellId:floor': node }
 * @param {number} N - cells per side
 * @param {number} targetFloor
 * @returns {Object} section topology
 */
export function buildSection(graphNodes, N, targetFloor) {
  var nearAll = [];
  var llu = [];
  var corridors = {};      // nearCid -> farCid
  var corridorKeys = {};   // nearCid -> corridorLabel

  // Near apartment cells
  for (var cid = 0; cid < N; cid++) {
    var key = cid + ':' + targetFloor;
    if (graphNodes[key] && graphNodes[key].type === 'apartment') {
      nearAll.push(cid);
    }
  }
  nearAll.sort(function (a, b) { return a - b; });

  var nearSegments = splitContiguous(nearAll);

  // LLU cells (far side)
  for (var cid = N; cid < 2 * N; cid++) {
    var key = cid + ':' + targetFloor;
    if (graphNodes[key] && graphNodes[key].type === 'llu') {
      llu.push(cid);
    }
  }

  // Corridors
  for (var nodeKey in graphNodes) {
    if (!graphNodes.hasOwnProperty(nodeKey)) continue;
    var node = graphNodes[nodeKey];
    if (node.floor !== targetFloor) continue;
    if (node.type !== 'corridor') continue;
    var rawId = String(node.cellId);
    if (rawId.indexOf('-') < 0) continue;
    var parts = rawId.split('-');
    var nCid = parseInt(parts[0]);
    var fCid = parseInt(parts[1]);
    corridors[nCid] = fCid;
    corridorKeys[nCid] = rawId;
  }

  // Reverse mapping far -> near
  var farToNear = {};
  for (var nc in corridors) {
    if (corridors.hasOwnProperty(nc)) {
      farToNear[corridors[nc]] = parseInt(nc);
    }
  }

  // Far segments
  var farSegments = [];
  var currentSeg = [];
  for (var nearPos = 0; nearPos < N; nearPos++) {
    var farCid = 2 * N - 1 - nearPos;
    var fkey = farCid + ':' + targetFloor;
    if (!graphNodes[fkey]) {
      if (currentSeg.length > 0) { farSegments.push(currentSeg.slice()); currentSeg = []; }
      continue;
    }
    if (graphNodes[fkey].type === 'apartment') {
      currentSeg.push(farCid);
    } else {
      if (currentSeg.length > 0) { farSegments.push(currentSeg.slice()); currentSeg = []; }
    }
  }
  if (currentSeg.length > 0) farSegments.push(currentSeg.slice());

  // Torecs: 1 corridor per physical end
  var sortedCorr = [];
  for (var nc in corridors) {
    if (corridors.hasOwnProperty(nc)) sortedCorr.push(parseInt(nc));
  }
  sortedCorr.sort(function (a, b) { return a - b; });

  var torecLeft = sortedCorr.length > 0 ? [sortedCorr[0]] : [];
  var torecRight = sortedCorr.length > 1 ? [sortedCorr[sortedCorr.length - 1]] : [];

  return {
    nearAll: nearAll, nearSegments: nearSegments, farSegments: farSegments,
    llu: llu, corridors: corridors, corridorKeys: corridorKeys,
    farToNear: farToNear, torecLeft: torecLeft, torecRight: torecRight, N: N
  };
}

// ============================================================
// CORRIDOR ACCESS (v4.6.1)
// ============================================================

function checkCorridorAccess(apt, corridors, farToNear, torecCorrNears) {
  var cells = apt.cells || [];
  for (var i = 0; i < cells.length; i++) {
    var cid = cells[i];
    if (typeof cid !== 'number') continue;
    // Near cell: direct corridor access
    if (corridors[cid] !== undefined && !torecCorrNears[cid]) return true;
    // Far cell: mirror corridor
    if (farToNear[cid] !== undefined) {
      var nCid = farToNear[cid];
      if (!torecCorrNears[nCid]) return true;
    }
  }
  return false;
}

// ============================================================
// GROW (f-cluster handling)
// ============================================================

function findFClusters(segment, insolMap, used) {
  var clusters = [];
  var n = segment.length;
  var i = 0;
  while (i < n) {
    if (!used[i] && getFlag(insolMap, segment[i]) === 'f') {
      var start = i;
      while (i < n && !used[i] && getFlag(insolMap, segment[i]) === 'f') i++;
      clusters.push([start, i - 1]);
    } else { i++; }
  }
  return clusters;
}

function growRight(segment, insolMap, startIdx, used) {
  var n = segment.length;
  var wetIdx = startIdx;
  var living = [];
  var idx = startIdx + 1;
  while (idx < n) {
    if (used[idx]) break;
    living.push(idx);
    var flags = [];
    for (var li = 0; li < living.length; li++) flags.push(getFlag(insolMap, segment[living[li]]));
    var v = validateApartment(flags);
    if (v.valid) {
      var allIdx = [wetIdx];
      for (var li = 0; li < living.length; li++) allIdx.push(living[li]);
      return { indices: allIdx, wetIdx: wetIdx, livingIndices: living.slice(), type: v.type, valid: true };
    }
    idx++;
  }
  return null;
}

function growLeft(segment, insolMap, startIdx, used) {
  var wetIdx = startIdx;
  var living = [];
  var idx = startIdx - 1;
  while (idx >= 0) {
    if (used[idx]) break;
    living.unshift(idx);
    var flags = [];
    for (var li = 0; li < living.length; li++) flags.push(getFlag(insolMap, segment[living[li]]));
    var v = validateApartment(flags);
    if (v.valid) {
      var allIdx = living.slice();
      allIdx.push(wetIdx);
      return { indices: allIdx, wetIdx: wetIdx, livingIndices: living.slice(), type: v.type, valid: true };
    }
    idx--;
  }
  return null;
}

function growBoth(segment, insolMap, fStart, fEnd, used) {
  var results = [];
  var rightApt = growRight(segment, insolMap, fEnd, used);
  if (rightApt) {
    for (var i = 0; i < rightApt.indices.length; i++) used[rightApt.indices[i]] = true;
    results.push(rightApt);
  }
  if (fStart !== fEnd || !rightApt) {
    if (!used[fStart]) {
      var leftApt = growLeft(segment, insolMap, fStart, used);
      if (leftApt) {
        for (var i = 0; i < leftApt.indices.length; i++) used[leftApt.indices[i]] = true;
        results.push(leftApt);
      }
    }
  }
  for (var fi = fStart; fi <= fEnd; fi++) {
    if (used[fi]) continue;
    var apt = growRight(segment, insolMap, fi, used);
    if (!apt) apt = growLeft(segment, insolMap, fi, used);
    if (apt) {
      for (var i = 0; i < apt.indices.length; i++) used[apt.indices[i]] = true;
      results.push(apt);
    } else {
      used[fi] = true;
      results.push({ indices: [fi], wetIdx: fi, livingIndices: [], type: 'orphan', valid: false });
    }
  }
  return results;
}

// ============================================================
// WET OPTIMIZATION
// ============================================================

function trySetWet(apt, newWetIdx, segment, insolMap) {
  if (apt.indices.indexOf(newWetIdx) < 0) return false;
  var newLiving = [];
  for (var i = 0; i < apt.indices.length; i++) {
    if (apt.indices[i] !== newWetIdx) newLiving.push(apt.indices[i]);
  }
  if (newLiving.length === 0) return false;
  var flags = [];
  for (var i = 0; i < newLiving.length; i++) flags.push(getFlag(insolMap, segment[newLiving[i]]));
  var v = validateApartment(flags);
  if (v.valid) {
    apt.wetIdx = newWetIdx;
    apt.livingIndices = newLiving;
    apt.type = v.type;
    apt.valid = true;
    return true;
  }
  return false;
}

function optimizeWetInSegment(apartments, segment, insolMap) {
  var normal = [];
  for (var i = 0; i < apartments.length; i++) {
    var a = apartments[i];
    if (a.type === 'orphan' || a.indices.length < 2) continue;
    normal.push(a);
  }
  if (normal.length < 2) return;
  normal.sort(function (a, b) { return Math.min.apply(null, a.indices) - Math.min.apply(null, b.indices); });

  var pi = 0;
  while (pi + 1 < normal.length) {
    var aptA = normal[pi];
    var aptB = normal[pi + 1];
    var maxA = Math.max.apply(null, aptA.indices);
    var minB = Math.min.apply(null, aptB.indices);
    if (minB - maxA === 1) {
      var oldWet = aptA.wetIdx;
      var oldLiving = aptA.livingIndices.slice();
      var oldType = aptA.type;
      var oldValid = aptA.valid;
      var okA = trySetWet(aptA, maxA, segment, insolMap);
      if (okA) {
        var okB = trySetWet(aptB, minB, segment, insolMap);
        if (!okB) {
          aptA.wetIdx = oldWet;
          aptA.livingIndices = oldLiving;
          aptA.type = oldType;
          aptA.valid = oldValid;
        }
      }
    }
    pi += 2;
  }
}

// ============================================================
// SLICE W-BLOCK
// ============================================================

function sliceWBlock(blockIndices, segment, insolMap, segLen, used) {
  var L = blockIndices.length;
  if (L === 0) return [];
  var results = [];

  var firstIdx = blockIndices[0];
  var lastIdx = blockIndices[L - 1];
  var leftWet = (firstIdx > 0 && !used[firstIdx - 1]) ? firstIdx - 1 : null;
  var rightWet = (lastIdx < segLen - 1 && !used[lastIdx + 1]) ? lastIdx + 1 : null;

  var pos = 0;

  if (leftWet !== null && L >= 1) {
    var flags = [getFlag(insolMap, segment[blockIndices[0]])];
    var v = validateApartment(flags);
    results.push({
      indices: [leftWet, blockIndices[0]], wetIdx: leftWet,
      livingIndices: [blockIndices[0]], type: v.type, valid: v.valid
    });
    pos = 1;
  }

  while (pos + 2 < L) {
    var i0 = blockIndices[pos], i1 = blockIndices[pos + 1], i2 = blockIndices[pos + 2];
    var lf = [getFlag(insolMap, segment[i0]), getFlag(insolMap, segment[i1])];
    var v = validateApartment(lf);
    results.push({
      indices: [i0, i1, i2], wetIdx: i2,
      livingIndices: [i0, i1], type: v.type, valid: v.valid
    });
    pos += 3;

    if (pos + 2 < L) {
      var j0 = blockIndices[pos], j1 = blockIndices[pos + 1], j2 = blockIndices[pos + 2];
      var lf2 = [getFlag(insolMap, segment[j1]), getFlag(insolMap, segment[j2])];
      var v2 = validateApartment(lf2);
      results.push({
        indices: [j0, j1, j2], wetIdx: j0,
        livingIndices: [j1, j2], type: v2.type, valid: v2.valid
      });
      pos += 3;
    }
  }

  // Remaining — matches Python exactly
  var rem = [];
  for (var ri = pos; ri < L; ri++) rem.push(blockIndices[ri]);

  if (rem.length === 2) {
    var f1 = getFlag(insolMap, segment[rem[1]]);
    if (f1 !== 'f') {
      results.push({ indices: [rem[0], rem[1]], wetIdx: rem[0], livingIndices: [rem[1]], type: '1K', valid: true });
    } else {
      results.push({ indices: [rem[0], rem[1]], wetIdx: rem[1], livingIndices: [rem[0]], type: '1K', valid: true });
    }
  } else if (rem.length === 1) {
    if (rightWet !== null) {
      results.push({ indices: [rem[0], rightWet], wetIdx: rightWet, livingIndices: [rem[0]], type: '1K', valid: true });
    } else if (results.length > 0) {
      var prev = results[results.length - 1];
      prev.indices.push(rem[0]);
      prev.livingIndices.push(rem[0]);
      var nf = [];
      for (var i = 0; i < prev.livingIndices.length; i++) nf.push(getFlag(insolMap, segment[prev.livingIndices[i]]));
      var nv = validateApartment(nf);
      prev.type = nv.type; prev.valid = nv.valid;
    } else {
      results.push({ indices: [rem[0]], wetIdx: rem[0], livingIndices: [], type: 'orphan', valid: false });
    }
  }

  return results;
}

// ============================================================
// GREEDY SOLVE SEGMENT
// ============================================================

function greedySolveSegment(segment, insolMap) {
  var n = segment.length;
  var used = [];
  for (var i = 0; i < n; i++) used.push(false);
  var apartments = [];

  // Phase 1: f-clusters → grow around them
  var clusters = findFClusters(segment, insolMap, used);
  for (var ci = 0; ci < clusters.length; ci++) {
    var newApts = growBoth(segment, insolMap, clusters[ci][0], clusters[ci][1], used);
    for (var ai = 0; ai < newApts.length; ai++) apartments.push(newApts[ai]);
  }

  // Phase 2: w-blocks → slice into apartments
  var i = 0;
  while (i < n) {
    if (used[i] || getFlag(insolMap, segment[i]) !== 'w') { i++; continue; }
    var wStart = i;
    while (i < n && !used[i] && getFlag(insolMap, segment[i]) === 'w') i++;
    var blockIndices = [];
    for (var bi = wStart; bi < i; bi++) blockIndices.push(bi);
    var blockApts = sliceWBlock(blockIndices, segment, insolMap, n, used);
    for (var ai = 0; ai < blockApts.length; ai++) {
      for (var ii = 0; ii < blockApts[ai].indices.length; ii++) used[blockApts[ai].indices[ii]] = true;
      apartments.push(blockApts[ai]);
    }
  }

  // Phase 3: remaining p-cells → pair into 1K or triplet into 2K
  var remaining = [];
  for (var i = 0; i < n; i++) { if (!used[i]) remaining.push(i); }
  var ri = 0;
  while (ri < remaining.length) {
    var idxA = remaining[ri];
    var flagA = getFlag(insolMap, segment[idxA]);

    // Contiguous pair?
    if (ri + 1 < remaining.length && remaining[ri + 1] === idxA + 1) {
      var idxB = remaining[ri + 1];
      var flagB = getFlag(insolMap, segment[idxB]);

      // At least one p → valid 1K
      if (flagA === 'p') {
        apartments.push({ indices: [idxA, idxB], wetIdx: idxB, livingIndices: [idxA], type: '1K', valid: true });
        used[idxA] = true; used[idxB] = true; ri += 2; continue;
      }
      if (flagB === 'p') {
        apartments.push({ indices: [idxA, idxB], wetIdx: idxA, livingIndices: [idxB], type: '1K', valid: true });
        used[idxA] = true; used[idxB] = true; ri += 2; continue;
      }

      // Both w or f → try triplet (2K with wet at end)
      if (ri + 2 < remaining.length && remaining[ri + 2] === idxB + 1) {
        var idxC = remaining[ri + 2];
        var vTrip = validateApartment([flagA, flagB]);
        if (vTrip.valid) {
          apartments.push({ indices: [idxA, idxB, idxC], wetIdx: idxC, livingIndices: [idxA, idxB], type: '2K', valid: true });
          used[idxA] = true; used[idxB] = true; used[idxC] = true; ri += 3; continue;
        }
      }

      // Fallback: invalid 1K (matches Python: hardcoded valid:false)
      apartments.push({ indices: [idxA, idxB], wetIdx: idxB, livingIndices: [idxA], type: '1K', valid: false });
      used[idxA] = true; used[idxB] = true; ri += 2;
    } else {
      // Single cell — skip, Phase 3b will handle
      ri++;
    }
  }

  // Phase 3b: orphan cells → absorb into neighboring apartments
  for (var i = 0; i < n; i++) {
    if (used[i]) continue;
    var absorbed = false;

    // Try absorb into adjacent apartment (no size cap — matches Python)
    for (var di = 0; di < 2; di++) {
      var nb = i + (di === 0 ? 1 : -1);
      if (nb < 0 || nb >= n) continue;
      for (var ai = 0; ai < apartments.length; ai++) {
        if (apartments[ai].indices.indexOf(nb) < 0) continue;
        var testLiving = apartments[ai].livingIndices.slice();
        testLiving.push(i);
        var testFlags = [];
        for (var ti = 0; ti < testLiving.length; ti++) testFlags.push(getFlag(insolMap, segment[testLiving[ti]]));
        var tv = validateApartment(testFlags);
        if (tv.valid) {
          apartments[ai].indices.push(i);
          apartments[ai].livingIndices = testLiving;
          apartments[ai].type = tv.type;
          apartments[ai].valid = true;
          used[i] = true; absorbed = true; break;
        }
      }
      if (absorbed) break;
    }
    if (!absorbed) {
      apartments.push({ indices: [i], wetIdx: i, livingIndices: [], type: 'orphan', valid: false });
      used[i] = true;
    }
  }

  // Phase 4: wet optimization (pair adjacent wets)
  optimizeWetInSegment(apartments, segment, insolMap);

  // Convert segment indices → cell IDs
  for (var ai = 0; ai < apartments.length; ai++) {
    var apt = apartments[ai];
    var cellIds = [];
    for (var ii = 0; ii < apt.indices.length; ii++) cellIds.push(segment[apt.indices[ii]]);
    apt.cells = cellIds;
    apt.wetCell = segment[apt.wetIdx];
  }

  return apartments;
}

// ============================================================
// TOREC (forced, 1 per end)
// ============================================================

/**
 * For meridional (lon): standard 1K torecs (near+far pair).
 * For latitudinal (lat): expanded 3K/4K torecs — torec ends
 * always get large apartments because they receive insolation
 * from the end facade. 1K/2K only go in the middle.
 *
 * Expansion grabs cell pairs inward: (0,2N-1) → (1,2N-2) → (2,2N-3)...
 * Picks worst-insol cell as WZ, rest as living.
 * Defaults to 3K, upgrades to 4K if insolation demands it.
 */
function solveTorecForced(section, insolMap, targetFloor, orientation) {
  var torecApts = [];
  var corridors = section.corridors;
  var corridorKeys = section.corridorKeys;
  var N = section.N;
  var nearUsed = {};
  var farUsed = {};
  var isLat = (orientation === 'lat');

  var groups = [section.torecLeft, section.torecRight];
  var directions = [1, -1]; // left expands rightward, right expands leftward

  for (var gi = 0; gi < groups.length; gi++) {
    var group = groups[gi];
    if (group.length === 0) continue;
    var anchorNear = group[0];
    if (nearUsed[anchorNear]) continue;
    if (corridors[anchorNear] === undefined) continue;
    var anchorFar = corridors[anchorNear];
    if (farUsed[anchorFar]) continue;

    if (!isLat) {
      // Meridional: standard 1K torec (unchanged)
      var nearFlag = getFlag(insolMap, anchorNear);
      var farFlag = getFlag(insolMap, anchorFar);
      var wetCell, livingCell;
      if (nearFlag === 'p') { wetCell = anchorFar; livingCell = anchorNear; }
      else if (farFlag === 'p') { wetCell = anchorNear; livingCell = anchorFar; }
      else { wetCell = anchorNear; livingCell = anchorFar; }

      var v = validateApartment([getFlag(insolMap, livingCell)]);
      torecApts.push({
        cells: [anchorNear, anchorFar], corridorLabel: corridorKeys[anchorNear],
        wetCell: wetCell, livingCells: [livingCell],
        type: v.type, torec: true, valid: v.valid
      });
      nearUsed[anchorNear] = true;
      farUsed[anchorFar] = true;
      continue;
    }

    // ── Latitudinal: expand torec to 3K/4K ──
    var dir = directions[gi];
    var nearCells = [anchorNear];
    var farCells = [anchorFar];
    var corrLabels = [];
    if (corridorKeys[anchorNear]) corrLabels.push(corridorKeys[anchorNear]);

    // Expand inward up to 4 pairs total (enough for 4K)
    for (var step = 1; step <= 3; step++) {
      var nextNear = anchorNear + dir * step;
      if (nextNear < 0 || nextNear >= N) break;
      // Check node exists and is apartment type
      var nKey = nextNear + ':' + targetFloor;
      if (!section.nearAll || section.nearAll.indexOf(nextNear) < 0) {
        // Check if it's at least not LLU
        var isLLU = false;
        for (var li = 0; li < section.llu.length; li++) {
          if (section.llu[li] === nextNear || section.llu[li] === (2 * N - 1 - nextNear)) { isLLU = true; break; }
        }
        if (isLLU) break;
      }
      var nextFar = corridors[nextNear];
      if (nextFar === undefined) {
        // Compute mirror far
        nextFar = 2 * N - 1 - nextNear;
      }
      if (nextFar < N || nextFar >= 2 * N) break;
      nearCells.push(nextNear);
      farCells.push(nextFar);
      if (corridorKeys[nextNear]) corrLabels.push(corridorKeys[nextNear]);
    }

    // All cells: near + far
    var allCells = [];
    for (var ci = 0; ci < nearCells.length; ci++) allCells.push(nearCells[ci]);
    for (var ci = 0; ci < farCells.length; ci++) allCells.push(farCells[ci]);

    // Determine target size: 3K default, 4K if f-cells present
    var fCount = 0;
    for (var ci = 0; ci < allCells.length; ci++) {
      if (getFlag(insolMap, allCells[ci]) === 'f') fCount++;
    }
    var targetLiving = fCount > 0 ? 4 : 3;

    // Trim to target size: WZ + targetLiving = targetLiving+1 total cells
    var totalNeeded = targetLiving + 1;
    while (allCells.length > totalNeeded && nearCells.length > 1) {
      // Remove furthest pair
      var removedNear = nearCells.pop();
      var removedFar = farCells.pop();
      allCells = [];
      for (var ci = 0; ci < nearCells.length; ci++) allCells.push(nearCells[ci]);
      for (var ci = 0; ci < farCells.length; ci++) allCells.push(farCells[ci]);
    }

    // Pick worst-insol cell as WZ
    var FLAG_SCORE = { 'f': 0, 'w': 1, 'p': 2 };
    var worstIdx = 0;
    var worstScore = 3;
    for (var ci = 0; ci < allCells.length; ci++) {
      var f = getFlag(insolMap, allCells[ci]);
      var s = FLAG_SCORE[f] !== undefined ? FLAG_SCORE[f] : 2;
      if (s < worstScore) { worstScore = s; worstIdx = ci; }
    }
    var wetCell = allCells[worstIdx];
    var livingCells = [];
    for (var ci = 0; ci < allCells.length; ci++) {
      if (ci !== worstIdx) livingCells.push(allCells[ci]);
    }

    var flags = [];
    for (var ci = 0; ci < livingCells.length; ci++) flags.push(getFlag(insolMap, livingCells[ci]));
    var v = validateApartment(flags);

    // Build cells array: all numeric + corridor labels
    var aptCells = allCells.slice();
    for (var ci = 0; ci < corrLabels.length; ci++) {
      // Only include corridor if both ends are in apartment
      var parts = corrLabels[ci].split('-');
      var cNear = parseInt(parts[0]);
      var cFar = parseInt(parts[1]);
      var hasNear = false; var hasFar = false;
      for (var ai = 0; ai < allCells.length; ai++) {
        if (allCells[ai] === cNear) hasNear = true;
        if (allCells[ai] === cFar) hasFar = true;
      }
      if (hasNear && hasFar) aptCells.push(corrLabels[ci]);
    }

    var type = v.valid ? v.type : (livingCells.length >= 4 ? '4K' : livingCells.length >= 3 ? '3K' : livingCells.length >= 2 ? '2K' : '1K');
    torecApts.push({
      cells: aptCells, corridorLabel: corrLabels[0] || null,
      wetCell: wetCell, livingCells: livingCells,
      type: type, torec: true, valid: v.valid
    });

    for (var ci = 0; ci < nearCells.length; ci++) nearUsed[nearCells[ci]] = true;
    for (var ci = 0; ci < farCells.length; ci++) farUsed[farCells[ci]] = true;
  }

  return { apartments: torecApts, nearUsed: nearUsed, farUsed: farUsed };
}

// ============================================================
// SPLIT 5K+
// ============================================================

function splitLargeApartments(allApartments, insolMap) {
  var result = [];
  for (var ai = 0; ai < allApartments.length; ai++) {
    var apt = allApartments[ai];
    var ac = apt.cells || [];
    if (ac.length <= 5 || apt.torec) { result.push(apt); continue; }

    var pair = trySplitCells(ac, insolMap);
    if (pair) { result.push(pair[0]); result.push(pair[1]); }
    else { result.push(apt); }
  }
  return result;
}

function trySplitCells(ac, insolMap) {
  var n = ac.length;
  for (var k = 2; k <= n - 2; k++) {
    var leftCells = ac.slice(0, k);
    var rightCells = ac.slice(k);
    var combos = [[k - 1, 0], [0, 0], [k - 1, rightCells.length - 1], [0, rightCells.length - 1]];
    for (var ci = 0; ci < combos.length; ci++) {
      var lwi = combos[ci][0], rwi = combos[ci][1];

      var leftLiving = [];
      for (var i = 0; i < leftCells.length; i++) { if (i !== lwi) leftLiving.push(leftCells[i]); }
      var leftFlags = [];
      for (var i = 0; i < leftLiving.length; i++) leftFlags.push(getFlag(insolMap, leftLiving[i]));
      var lv = validateApartment(leftFlags);
      if (!lv.valid) continue;

      var rightLiving = [];
      for (var i = 0; i < rightCells.length; i++) { if (i !== rwi) rightLiving.push(rightCells[i]); }
      var rightFlags = [];
      for (var i = 0; i < rightLiving.length; i++) rightFlags.push(getFlag(insolMap, rightLiving[i]));
      var rv = validateApartment(rightFlags);
      if (!rv.valid) continue;

      return [
        { cells: leftCells.slice(), wetCell: leftCells[lwi], type: lv.type, valid: true },
        { cells: rightCells.slice(), wetCell: rightCells[rwi], type: rv.type, valid: true }
      ];
    }
  }
  return null;
}

// ============================================================
// GLOBAL WET PAIRING (v4.6.1)
// ============================================================

function globalWetPairing(allApartments, insolMap) {
  if (allApartments.length < 2) return 0;
  var totalMoves = 0;

  for (var iteration = 0; iteration < 5; iteration++) {
    var currentWets = {};
    for (var ai = 0; ai < allApartments.length; ai++) {
      var wc = allApartments[ai].wetCell;
      if (wc !== undefined && typeof wc === 'number') currentWets[wc] = true;
    }

    var frozen = {};
    for (var wc in currentWets) {
      var w = parseInt(wc);
      if (currentWets[w + 1] || currentWets[w - 1]) frozen[w] = true;
    }

    var cellToApt = {};
    for (var ai = 0; ai < allApartments.length; ai++) {
      var cells = allApartments[ai].cells || [];
      for (var ci = 0; ci < cells.length; ci++) {
        if (typeof cells[ci] === 'number') cellToApt[cells[ci]] = ai;
      }
    }

    var movesThisPass = 0;
    var visited = {};

    for (var ai = 0; ai < allApartments.length; ai++) {
      var aptA = allApartments[ai];
      if (!aptA.cells || aptA.cells.length < 2) continue;
      if (aptA.torec) continue;
      if (frozen[aptA.wetCell]) continue;

      for (var ci = 0; ci < aptA.cells.length; ci++) {
        var cidA = aptA.cells[ci];
        if (typeof cidA !== 'number') continue;
        for (var delta = -1; delta <= 1; delta += 2) {
          var nb = cidA + delta;
          if (cellToApt[nb] === undefined || cellToApt[nb] === ai) continue;
          var bi = cellToApt[nb];
          var pairKey = Math.min(ai, bi) + ':' + Math.max(ai, bi);
          if (visited[pairKey]) continue;
          visited[pairKey] = true;

          var aptB = allApartments[bi];
          if (!aptB.cells || aptB.cells.length < 2) continue;
          if (aptB.torec) continue;
          if (frozen[aptB.wetCell]) continue;

          // Already paired?
          if (aptA.wetCell !== undefined && aptB.wetCell !== undefined) {
            if (Math.abs(aptA.wetCell - aptB.wetCell) === 1) continue;
          }

          // Find boundary pairs
          var setB = {};
          for (var bi2 = 0; bi2 < aptB.cells.length; bi2++) {
            if (typeof aptB.cells[bi2] === 'number') setB[aptB.cells[bi2]] = true;
          }
          var boundary = [];
          for (var ai2 = 0; ai2 < aptA.cells.length; ai2++) {
            var ca = aptA.cells[ai2];
            if (typeof ca !== 'number') continue;
            if (setB[ca + 1]) boundary.push([ca, ca + 1]);
            if (setB[ca - 1]) boundary.push([ca, ca - 1]);
          }

          var paired = false;
          for (var bdi = 0; bdi < boundary.length; bdi++) {
            if (tryPairWets(aptA, boundary[bdi][0], aptB, boundary[bdi][1], insolMap)) {
              movesThisPass++;
              frozen[boundary[bdi][0]] = true;
              frozen[boundary[bdi][1]] = true;
              paired = true; break;
            }
          }
          if (paired) break;
        }
      }
    }
    totalMoves += movesThisPass;
    if (movesThisPass === 0) break;
  }
  return totalMoves;
}

function tryPairWets(aptA, newWetA, aptB, newWetB, insolMap) {
  if (!aptA.cells || !aptB.cells) return false;
  if (aptA.cells.indexOf(newWetA) < 0 || aptB.cells.indexOf(newWetB) < 0) return false;

  var livingA = [];
  for (var i = 0; i < aptA.cells.length; i++) { if (aptA.cells[i] !== newWetA) livingA.push(aptA.cells[i]); }
  if (livingA.length === 0) return false;
  var flagsA = [];
  for (var i = 0; i < livingA.length; i++) { if (typeof livingA[i] === 'number') flagsA.push(getFlag(insolMap, livingA[i])); }
  var vA = validateApartment(flagsA);
  if (!vA.valid) return false;

  var livingB = [];
  for (var i = 0; i < aptB.cells.length; i++) { if (aptB.cells[i] !== newWetB) livingB.push(aptB.cells[i]); }
  if (livingB.length === 0) return false;
  var flagsB = [];
  for (var i = 0; i < livingB.length; i++) { if (typeof livingB[i] === 'number') flagsB.push(getFlag(insolMap, livingB[i])); }
  var vB = validateApartment(flagsB);
  if (!vB.valid) return false;

  aptA.wetCell = newWetA; aptA.type = vA.type; aptA.valid = true;
  aptB.wetCell = newWetB; aptB.type = vB.type; aptB.valid = true;
  return true;
}

// ============================================================
// WET QUALITY REPORT
// ============================================================

export function wetQualityReport(allApartments) {
  var wets = [];
  for (var ai = 0; ai < allApartments.length; ai++) {
    var wc = allApartments[ai].wetCell;
    if (wc !== undefined && typeof wc === 'number') wets.push(wc);
  }
  wets.sort(function (a, b) { return a - b; });

  var wetSet = {};
  for (var i = 0; i < wets.length; i++) wetSet[wets[i]] = true;

  var pairs = [];
  var inPair = {};
  for (var i = 0; i < wets.length - 1; i++) {
    if (wets[i + 1] - wets[i] === 1) {
      pairs.push([wets[i], wets[i + 1]]);
      inPair[wets[i]] = true;
      inPair[wets[i + 1]] = true;
    }
  }

  var unpaired = [];
  for (var i = 0; i < wets.length; i++) { if (!inPair[wets[i]]) unpaired.push(wets[i]); }

  var pairedCount = Object.keys(inPair).length;
  var total = wets.length;

  return {
    wetCells: wets, totalWets: total,
    pairedCount: pairedCount, unpaired: unpaired,
    pairRatio: total > 0 ? pairedCount / total : 0,
    pairs: pairs
  };
}

// ============================================================
// MAIN SOLVER
// ============================================================

/**
 * Full apartment solver pipeline.
 *
 * @param {Object} graphNodes - section-gen graph nodes
 * @param {number} N - cells per side
 * @param {number} targetFloor - floor to solve (typically 1)
 * @param {Object} [insolMap] - { cellId: 'p'|'w'|'f' }
 * @param {string} [orientation] - 'lat' or 'lon'; affects torec sizing
 * @returns {Object} result
 */
export function solveFloor(graphNodes, N, targetFloor, insolMap, orientation) {
  if (!insolMap) insolMap = {};
  if (!orientation) orientation = 'lon';

  var section = buildSection(graphNodes, N, targetFloor);
  var allApartments = [];

  // Step 0: forced torecs
  var torecResult = solveTorecForced(section, insolMap, targetFloor, orientation);
  var torecApts = torecResult.apartments;
  var torecNearUsed = torecResult.nearUsed;
  var torecFarUsed = torecResult.farUsed;

  var torecCorrNears = {};
  for (var i = 0; i < torecApts.length; i++) {
    var cells = torecApts[i].cells;
    for (var ci = 0; ci < cells.length; ci++) {
      if (typeof cells[ci] === 'number' && section.corridors[cells[ci]] !== undefined) {
        torecCorrNears[cells[ci]] = true;
      }
    }
  }
  for (var i = 0; i < torecApts.length; i++) allApartments.push(torecApts[i]);

  // Step 1: near sub-segments
  var nearUsed = {};
  for (var k in torecNearUsed) nearUsed[k] = true;
  for (var si = 0; si < section.nearSegments.length; si++) {
    var seg = section.nearSegments[si];
    var remaining = [];
    for (var i = 0; i < seg.length; i++) { if (!nearUsed[seg[i]]) remaining.push(seg[i]); }
    if (remaining.length === 0) continue;
    var nearApts = greedySolveSegment(remaining, insolMap);
    for (var ai = 0; ai < nearApts.length; ai++) {
      var apt = nearApts[ai];
      for (var ci = 0; ci < apt.cells.length; ci++) nearUsed[apt.cells[ci]] = true;
      allApartments.push(apt);
    }
  }

  // Step 2: far segments
  var farUsed = {};
  for (var k in torecFarUsed) farUsed[k] = true;
  for (var si = 0; si < section.farSegments.length; si++) {
    var seg = section.farSegments[si];
    var remaining = [];
    for (var i = 0; i < seg.length; i++) { if (!farUsed[seg[i]]) remaining.push(seg[i]); }
    if (remaining.length === 0) continue;
    var farApts = greedySolveSegment(remaining, insolMap);
    for (var ai = 0; ai < farApts.length; ai++) allApartments.push(farApts[ai]);
  }

  // Step 3: global orphan resolution (matches Python solve_floor exactly)
  var orphanResolved = 0;
  var changed = true;
  while (changed) {
    changed = false;
    var cellToApt = {};
    for (var ai = 0; ai < allApartments.length; ai++) {
      var cs3 = allApartments[ai].cells || [];
      for (var ci = 0; ci < cs3.length; ci++) {
        if (typeof cs3[ci] === 'number') cellToApt[cs3[ci]] = ai;
      }
    }
    for (var ai = 0; ai < allApartments.length; ai++) {
      var apt = allApartments[ai];
      if (apt.type !== 'orphan') continue;
      var orphanCid = apt.cells[0];
      var absorbed = false;

      for (var delta = -1; delta <= 1; delta += 2) {
        var nbCid = orphanCid + delta;
        if (cellToApt[nbCid] === undefined || cellToApt[nbCid] === ai) continue;
        var bi = cellToApt[nbCid];
        var target = allApartments[bi];
        var targetCells = target.cells || [];

        var oldWet = target.wetCell;

        // Option A: orphan becomes living cell
        var newLiving = [];
        for (var ci = 0; ci < targetCells.length; ci++) {
          if (targetCells[ci] !== oldWet && typeof targetCells[ci] === 'number')
            newLiving.push(targetCells[ci]);
        }
        newLiving.push(orphanCid);

        var flags = [];
        for (var fi = 0; fi < newLiving.length; fi++) flags.push(getFlag(insolMap, newLiving[fi]));
        var nv = validateApartment(flags);

        if (nv.valid) {
          target.cells.push(orphanCid);
          target.type = nv.type;
          target.valid = true;

          // If orphan is 'f', try making it wet instead (free up old wet as living)
          var orphanFlag = getFlag(insolMap, orphanCid);
          if (orphanFlag === 'f' && oldWet !== undefined && oldWet !== null) {
            var testLiving = [];
            for (var ci = 0; ci < target.cells.length; ci++) {
              if (target.cells[ci] !== orphanCid && typeof target.cells[ci] === 'number')
                testLiving.push(target.cells[ci]);
            }
            var tf = [];
            for (var fi = 0; fi < testLiving.length; fi++) tf.push(getFlag(insolMap, testLiving[fi]));
            var tv = validateApartment(tf);
            if (tv.valid) {
              target.wetCell = orphanCid;
              target.type = tv.type;
            }
          }

          apt.type = '_absorbed';
          orphanResolved++;
          changed = true;
          absorbed = true;
          break;
        }
      }
    }
  }
  allApartments = allApartments.filter(function (a) { return a.type !== '_absorbed'; });

  // Step 4: split 5K+
  allApartments = splitLargeApartments(allApartments, insolMap);

  // Step 5: global wet pairing
  var wetMoves = globalWetPairing(allApartments, insolMap);

  // Step 6: wet quality report
  var wq = wetQualityReport(allApartments);

  // Stats
  var typeCounts = { '1K': 0, '2K': 0, '3K': 0, '4K': 0, orphan: 0 };
  var invalid = 0;
  var noCorr = 0;
  for (var ai = 0; ai < allApartments.length; ai++) {
    var apt = allApartments[ai];
    if (typeCounts[apt.type] !== undefined) typeCounts[apt.type]++;
    if (!apt.valid) invalid++;
    if (!apt.torec) {
      if (!checkCorridorAccess(apt, section.corridors, section.farToNear, torecCorrNears)) noCorr++;
    }
  }

  var orphanCount = typeCounts.orphan || 0;
  var feasible = orphanCount === 0;

  return {
    floor: targetFloor,
    apartments: allApartments,
    section: section,
    typeCounts: typeCounts,
    total: allApartments.length,
    invalid: invalid,
    wetPairs: wq.pairs.length,
    noCorr: noCorr,
    feasible: feasible,
    orphanCount: orphanCount,
    wetQuality: wq,
    wetMoves: wetMoves,
    orphanResolved: orphanResolved
  };
}
