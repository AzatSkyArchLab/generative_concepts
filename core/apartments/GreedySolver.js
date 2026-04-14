/**
 * GreedySolver — floor-level greedy apartment solver.
 *
 * Pipeline per segment:
 *   1. f-clusters → grow around them
 *   2. w-blocks → slice into apartments  
 *   3. Remaining p-cells → pair/triple
 *   4. Wet optimization
 *
 * Also contains solveTorecForced for end-apartment placement.
 */

import { validateApartment, getFlag } from './Validation.js';

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

  // Python: leftWet = wet, first w-cell = living
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

  // Remaining — exact Python v4.6.1
  var rem = [];
  for (var ri = pos; ri < L; ri++) rem.push(blockIndices[ri]);

  if (rem.length === 2) {
    var f1 = getFlag(insolMap, segment[rem[1]]);
    var remV;
    if (f1 !== 'f') {
      remV = validateApartment([getFlag(insolMap, segment[rem[1]])]);
      results.push({ indices: [rem[0], rem[1]], wetIdx: rem[0], livingIndices: [rem[1]], type: remV.type, valid: remV.valid });
    } else {
      remV = validateApartment([getFlag(insolMap, segment[rem[0]])]);
      results.push({ indices: [rem[0], rem[1]], wetIdx: rem[1], livingIndices: [rem[0]], type: remV.type, valid: remV.valid });
    }
  } else if (rem.length === 1) {
    if (rightWet !== null) {
      var rwV = validateApartment([getFlag(insolMap, segment[rem[0]])]);
      results.push({ indices: [rem[0], rightWet], wetIdx: rightWet, livingIndices: [rem[0]], type: rwV.type, valid: rwV.valid });
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

export function greedySolveSegment(segment, insolMap) {
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

  // Phase 3b: orphan cells → absorb into neighboring apartments if valid, else orphan
  // Exact Python v4.6.1 logic
  for (var i = 0; i < n; i++) {
    if (used[i]) continue;
    var absorbed = false;

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

  // Phase 3c: REGROUP — dissolve invalid apartments, redistribute cells
  // Example: invalid 1K [w,w] next to 2K [p,wz,p] → merge w into 2K → 3K
  var regrouped = true;
  while (regrouped) {
    regrouped = false;
    for (var ai = apartments.length - 1; ai >= 0; ai--) {
      var apt = apartments[ai];
      if (apt.valid !== false || apt.type === 'orphan') continue;

      // Dissolve: free all cells
      for (var ii = 0; ii < apt.indices.length; ii++) {
        used[apt.indices[ii]] = false;
      }
      var freedCells = apt.indices.slice();
      apartments.splice(ai, 1);

      // Try absorb each freed cell into adjacent valid apartment
      for (var fi = 0; fi < freedCells.length; fi++) {
        var fc = freedCells[fi];
        if (used[fc]) continue;
        var absorbed = false;
        for (var di = 0; di < 2; di++) {
          var nb = fc + (di === 0 ? 1 : -1);
          if (nb < 0 || nb >= n) continue;
          for (var bi = 0; bi < apartments.length; bi++) {
            if (apartments[bi].indices.indexOf(nb) < 0) continue;
            if (apartments[bi].type === 'orphan') continue;
            var testLiving = apartments[bi].livingIndices.slice();
            testLiving.push(fc);
            var testFlags = [];
            for (var ti = 0; ti < testLiving.length; ti++) testFlags.push(getFlag(insolMap, segment[testLiving[ti]]));
            var tv = validateApartment(testFlags);
            if (tv.valid) {
              apartments[bi].indices.push(fc);
              apartments[bi].livingIndices = testLiving;
              apartments[bi].type = tv.type;
              apartments[bi].valid = true;
              used[fc] = true;
              absorbed = true;
              break;
            }
          }
          if (absorbed) break;
        }
        if (!absorbed) {
          // Try as WZ for adjacent apartment (swap wet if better)
          for (var di = 0; di < 2; di++) {
            var nb = fc + (di === 0 ? 1 : -1);
            if (nb < 0 || nb >= n) continue;
            for (var bi = 0; bi < apartments.length; bi++) {
              if (apartments[bi].indices.indexOf(nb) < 0) continue;
              if (apartments[bi].type === 'orphan') continue;
              // Try: fc becomes new WZ, old WZ becomes living
              var oldWet = apartments[bi].wetIdx;
              var newLiving = [];
              for (var k = 0; k < apartments[bi].indices.length; k++) {
                newLiving.push(apartments[bi].indices[k]);
              }
              // old wet now living, fc is new wet
              var newFlags = [];
              for (var k = 0; k < newLiving.length; k++) newFlags.push(getFlag(insolMap, segment[newLiving[k]]));
              var nv = validateApartment(newFlags);
              if (nv.valid) {
                apartments[bi].indices.push(fc);
                apartments[bi].wetIdx = fc;
                apartments[bi].livingIndices = newLiving;
                apartments[bi].type = nv.type;
                apartments[bi].valid = true;
                used[fc] = true;
                absorbed = true;
                break;
              }
            }
            if (absorbed) break;
          }
        }
        if (!absorbed) {
          apartments.push({ indices: [fc], wetIdx: fc, livingIndices: [], type: 'orphan', valid: false });
          used[fc] = true;
        }
      }
      regrouped = true;
      break; // restart scan after dissolve
    }
  }

  // Phase 3d: DOWNSIZE — transfer 1 boundary living cell from larger to smaller neighbor
  // Goal: maximize small apartments. Gap >= 2 prevents ping-pong.
  // After transfer, try WZ reassignment in donor for better insol placement.
  var dsChanged = true;
  var dsMaxIter = 20;
  while (dsChanged && dsMaxIter > 0) {
    dsChanged = false;
    dsMaxIter--;
    for (var ai = 0; ai < apartments.length; ai++) {
      var donor = apartments[ai];
      if (donor.type === 'orphan' || !donor.valid) continue;
      if (donor.livingIndices.length < 2) continue;

      for (var bi = 0; bi < apartments.length; bi++) {
        if (bi === ai) continue;
        var recv = apartments[bi];
        if (recv.type === 'orphan' || !recv.valid) continue;
        // Gap >= 2: donor must have at least 2 more living than receiver
        if (recv.livingIndices.length >= donor.livingIndices.length - 1) continue;

        // Find boundary cell: donor living cell adjacent to recv cell
        for (var li = donor.livingIndices.length - 1; li >= 0; li--) {
          var dCell = donor.livingIndices[li];
          var isAdj = false;
          for (var ri = 0; ri < recv.indices.length; ri++) {
            if (Math.abs(dCell - recv.indices[ri]) === 1) { isAdj = true; break; }
          }
          if (!isAdj) continue;

          // Test receiver with added cell
          var newRecvLiving = recv.livingIndices.slice();
          newRecvLiving.push(dCell);
          var rfFlags = [];
          for (var k = 0; k < newRecvLiving.length; k++) rfFlags.push(getFlag(insolMap, segment[newRecvLiving[k]]));
          var rv = validateApartment(rfFlags);
          if (!rv.valid) continue;

          // Test donor without cell — try all possible WZ positions
          var newDonorIndices = [];
          for (var k = 0; k < donor.indices.length; k++) {
            if (donor.indices[k] !== dCell) newDonorIndices.push(donor.indices[k]);
          }
          if (newDonorIndices.length < 2) continue;

          var bestDonorWZ = -1;
          var bestDonorType = null;
          var bestDonorLiving = null;
          var bestDonorWZScore = 99;
          var FLAG_DS = { 'f': 0, 'w': 1, 'p': 2 };
          for (var wi = 0; wi < newDonorIndices.length; wi++) {
            var tryWZ = newDonorIndices[wi];
            var tryLiving = [];
            for (var k = 0; k < newDonorIndices.length; k++) {
              if (k !== wi) tryLiving.push(newDonorIndices[k]);
            }
            var dfFlags = [];
            for (var k = 0; k < tryLiving.length; k++) dfFlags.push(getFlag(insolMap, segment[tryLiving[k]]));
            var dv = validateApartment(dfFlags);
            if (dv.valid) {
              // Prefer worst-insol cell as WZ (keep best for living)
              var wzScore = FLAG_DS[getFlag(insolMap, segment[tryWZ])] || 0;
              if (bestDonorWZ < 0 || wzScore < bestDonorWZScore) {
                bestDonorWZScore = wzScore;
                bestDonorWZ = tryWZ;
                bestDonorType = dv.type;
                bestDonorLiving = tryLiving;
              }
            }
          }
          if (bestDonorWZ < 0) continue;

          // Execute transfer
          donor.indices = newDonorIndices;
          donor.wetIdx = bestDonorWZ;
          donor.livingIndices = bestDonorLiving;
          donor.type = bestDonorType;
          donor.valid = true;

          recv.indices.push(dCell);
          recv.livingIndices = newRecvLiving;
          recv.type = rv.type;
          recv.valid = true;

          dsChanged = true;
          break;
        }
        if (dsChanged) break;
      }
      if (dsChanged) break;
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
export function solveTorecForced(section, insolMap, targetFloor, orientation) {
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

    // ── Latitudinal: torec expands along side WITHOUT LLU ──
    var dir = directions[gi];
    var corrLabels = [];
    if (corridorKeys[anchorNear]) corrLabels.push(corridorKeys[anchorNear]);

    // Determine which side has LLU
    var lluOnNear = false;
    var lluOnFar = false;
    var lluSet = {};
    for (var li = 0; li < section.llu.length; li++) {
      lluSet[section.llu[li]] = true;
      if (section.llu[li] < N) lluOnNear = true;
      else lluOnFar = true;
    }

    // Build cell pool: anchor pair + near extra (f/w → WZ candidates) + far expansion
    var nearExtra = [];
    var farExpansion = [];
    if (!lluOnFar) {
      // LLU on near → main expansion along far, near extra toward LLU
      var farDir = -dir;
      for (var step = 1; step <= 3; step++) {
        var nextFar = anchorFar + farDir * step;
        if (nextFar < N || nextFar >= 2 * N) break;
        if (lluSet[nextFar]) break;
        farExpansion.push(nextFar);
      }
      // Near cells between anchor and LLU — f/w cells, natural WZ
      for (var step = 1; step <= 3; step++) {
        var nextNear = anchorNear + dir * step;
        if (nextNear < 0 || nextNear >= N) break;
        if (lluSet[nextNear]) break;
        nearExtra.push(nextNear);
      }
    } else {
      // LLU on far → main expansion along near, far extra toward LLU
      for (var step = 1; step <= 3; step++) {
        var nextNear = anchorNear + dir * step;
        if (nextNear < 0 || nextNear >= N) break;
        if (lluSet[nextNear]) break;
        farExpansion.push(nextNear);
      }
      var farDir = -dir;
      for (var step = 1; step <= 3; step++) {
        var nextFar = anchorFar + farDir * step;
        if (nextFar < N || nextFar >= 2 * N) break;
        if (lluSet[nextFar]) break;
        nearExtra.push(nextFar);
      }
    }
    // Priority: anchor pair → near extra (f/w WZ candidates) → far expansion (p cells)
    // This ensures f-cells get included in torec, freeing far p-cells for 1K pairs
    var allAvail = [anchorNear, anchorFar];
    for (var ei = 0; ei < nearExtra.length; ei++) allAvail.push(nearExtra[ei]);
    for (var ei = 0; ei < farExpansion.length; ei++) allAvail.push(farExpansion[ei]);

    var FLAG_SCORE = { 'f': 0, 'w': 1, 'p': 2 };
    var bestApt = null;

    // Try sizes: 3 cells (2K), 4 cells (3K), 6 cells (3K/4K), 8 cells (4K)
    var sizes = [4, 6, 8, 3]; // prefer 3K first, then larger, then 2K fallback
    for (var si = 0; si < sizes.length; si++) {
      var trySize = Math.min(sizes[si], allAvail.length);
      if (trySize < 3) continue; // minimum 2K = 3 cells
      var tryCells = allAvail.slice(0, trySize);

      // Pick worst-insol cell as WZ
      var worstIdx = 0;
      var worstScore = 3;
      for (var ci = 0; ci < tryCells.length; ci++) {
        var f = getFlag(insolMap, tryCells[ci]);
        var s = FLAG_SCORE[f] !== undefined ? FLAG_SCORE[f] : 2;
        if (s < worstScore) { worstScore = s; worstIdx = ci; }
      }
      var tryWZ = tryCells[worstIdx];

      // Living cells sorted by quality (best first)
      var tryLiving = [];
      for (var ci = 0; ci < tryCells.length; ci++) {
        if (ci !== worstIdx) tryLiving.push(tryCells[ci]);
      }
      tryLiving.sort(function (a, b) {
        var fa = FLAG_SCORE[getFlag(insolMap, a)] || 0;
        var fb = FLAG_SCORE[getFlag(insolMap, b)] || 0;
        return fb - fa;
      });

      // Try 3K (3 living) — preferred for lat torec
      if (tryLiving.length >= 3) {
        var living3 = tryLiving.slice(0, 3);
        var flags3 = [];
        for (var fi = 0; fi < living3.length; fi++) flags3.push(getFlag(insolMap, living3[fi]));
        var v3 = validateApartment(flags3);
        if (v3.valid) {
          bestApt = { wz: tryWZ, living: living3, allUsed: [tryWZ].concat(living3), type: v3.type, valid: true };
          break;
        }
      }

      // Try 4K (4 living)
      if (tryLiving.length >= 4) {
        var living4 = tryLiving.slice(0, 4);
        var flags4 = [];
        for (var fi = 0; fi < living4.length; fi++) flags4.push(getFlag(insolMap, living4[fi]));
        var v4 = validateApartment(flags4);
        if (v4.valid) {
          bestApt = { wz: tryWZ, living: living4, allUsed: [tryWZ].concat(living4), type: v4.type, valid: true };
          break;
        }
      }

      // Try 2K (2 living) — minimum for lat torec
      if (tryLiving.length >= 2) {
        var living2 = tryLiving.slice(0, 2);
        var flags2 = [];
        for (var fi = 0; fi < living2.length; fi++) flags2.push(getFlag(insolMap, living2[fi]));
        var v2 = validateApartment(flags2);
        if (v2.valid) {
          bestApt = { wz: tryWZ, living: living2, allUsed: [tryWZ].concat(living2), type: v2.type, valid: true };
          break;
        }
      }
    }

    // Fallback: force minimum 2K (never 1K for lat torec)
    if (!bestApt) {
      var fallSize = Math.min(allAvail.length, 4);
      if (fallSize < 3) fallSize = Math.min(allAvail.length, 3); // try at least 3 cells
      var fallCells = allAvail.slice(0, fallSize);
      var fwIdx = 0;
      var fwScore = 3;
      for (var ci = 0; ci < fallCells.length; ci++) {
        var f = getFlag(insolMap, fallCells[ci]);
        var s = FLAG_SCORE[f] !== undefined ? FLAG_SCORE[f] : 2;
        if (s < fwScore) { fwScore = s; fwIdx = ci; }
      }
      var fwz = fallCells[fwIdx];
      var fliv = [];
      for (var ci = 0; ci < fallCells.length; ci++) { if (ci !== fwIdx) fliv.push(fallCells[ci]); }
      var ff = [];
      for (var fi = 0; fi < fliv.length; fi++) ff.push(getFlag(insolMap, fliv[fi]));
      var fv = validateApartment(ff);
      bestApt = { wz: fwz, living: fliv, allUsed: [fwz].concat(fliv),
        type: fv.valid ? fv.type : (fliv.length >= 3 ? '3K' : '2K'), valid: fv.valid };
    }

    // Build apartment cells with corridors
    var aptCells = bestApt.allUsed.slice();
    var aptCellSet = {};
    for (var ci = 0; ci < aptCells.length; ci++) aptCellSet[aptCells[ci]] = true;
    for (var ci = 0; ci < corrLabels.length; ci++) {
      var parts = corrLabels[ci].split('-');
      if (aptCellSet[parseInt(parts[0])] && aptCellSet[parseInt(parts[1])]) {
        aptCells.push(corrLabels[ci]);
      }
    }

    torecApts.push({
      cells: aptCells, corridorLabel: corrLabels[0] || null,
      wetCell: bestApt.wz, livingCells: bestApt.living,
      type: bestApt.type, torec: true, valid: bestApt.valid
    });

    for (var cid in aptCellSet) {
      if (!aptCellSet.hasOwnProperty(cid)) continue;
      var c = parseInt(cid);
      if (c < N) nearUsed[c] = true;
      else farUsed[c] = true;
    }
  }

  return { apartments: torecApts, nearUsed: nearUsed, farUsed: farUsed };
}
