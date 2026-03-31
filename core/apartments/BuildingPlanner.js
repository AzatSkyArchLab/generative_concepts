/**
 * BuildingPlanner v2 — full monotonic profile enumeration.
 *
 * Enumerates all monotonic non-increasing WZ profiles (step 0, 1, or 2 per floor).
 * Evaluates each with FloorPlanner, picks lowest deviation from target mix.
 * Guarantees best achievable result within search space.
 */

import { planFloor, computeQuota } from './FloorPlanner.js';

var PROFILE_GEN_LIMIT = 50000;
var PROFILE_EVAL_LIMIT = 5000;

/**
 * Generate all monotonic profiles: each floor can reduce by 0..maxStep from previous.
 * Early-exits if generation exceeds PROFILE_GEN_LIMIT.
 * Uses stratified sampling (by total WZ) when reducing to PROFILE_EVAL_LIMIT.
 */
function generateAllProfiles(maxWZ, minWZ, numFloors) {
  var profiles = [];
  var current = [maxWZ];
  var overflow = false;

  function recurse(depth, prev) {
    if (overflow) return;
    if (depth === numFloors) {
      profiles.push(current.slice());
      if (profiles.length >= PROFILE_GEN_LIMIT) overflow = true;
      return;
    }
    var maxStep = Math.min(4, prev - minWZ);
    for (var step = 0; step <= maxStep; step++) {
      if (overflow) return;
      var val = prev - step;
      if (val < minWZ) break;
      current.push(val);
      recurse(depth + 1, val);
      current.pop();
    }
  }

  recurse(1, maxWZ);

  if (profiles.length <= PROFILE_EVAL_LIMIT) return profiles;

  // Stratified sampling: group by totalWZ, sample from each stratum
  var byTotal = {};
  var totalMin = Infinity;
  var totalMax = -Infinity;
  for (var i = 0; i < profiles.length; i++) {
    var sum = 0;
    for (var j = 0; j < profiles[i].length; j++) sum += profiles[i][j];
    if (sum < totalMin) totalMin = sum;
    if (sum > totalMax) totalMax = sum;
    if (!byTotal[sum]) byTotal[sum] = [];
    byTotal[sum].push(profiles[i]);
  }

  // Collect all strata keys sorted
  var strata = [];
  for (var k in byTotal) {
    if (byTotal.hasOwnProperty(k)) strata.push(parseInt(k));
  }
  strata.sort(function (a, b) { return a - b; });

  // Allocate budget proportionally to stratum size, min 1 per stratum
  var sampled = [];
  var budgetLeft = PROFILE_EVAL_LIMIT;
  for (var si = 0; si < strata.length; si++) {
    var bucket = byTotal[strata[si]];
    var share = Math.max(1, Math.round(bucket.length / profiles.length * PROFILE_EVAL_LIMIT));
    share = Math.min(share, budgetLeft, bucket.length);
    // Uniform sample within stratum
    var step = bucket.length <= share ? 1 : Math.floor(bucket.length / share);
    for (var bi = 0; bi < bucket.length && sampled.length < PROFILE_EVAL_LIMIT; bi += step) {
      sampled.push(bucket[bi]);
    }
    budgetLeft = PROFILE_EVAL_LIMIT - sampled.length;
    if (budgetLeft <= 0) break;
  }

  return sampled;
}

/**
 * Choose which WZ to deactivate.
 * CRITICAL: maintain at least 1 WZ per row (near and far).
 */
function selectActiveWZ(prevActive, targetCount, insolMap, N) {
  if (targetCount >= prevActive.length) return prevActive.slice();

  var activeSet = {};
  for (var i = 0; i < prevActive.length; i++) activeSet[prevActive[i]] = true;

  // Separate by row
  var nearWZ = [];
  var farWZ = [];
  for (var i = 0; i < prevActive.length; i++) {
    if (prevActive[i] < N) nearWZ.push(prevActive[i]);
    else farWZ.push(prevActive[i]);
  }

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

  // Remove: paired first, low quality first
  scored.sort(function (a, b) {
    if (b.isPaired !== a.isPaired) return b.isPaired - a.isPaired;
    return a.quality - b.quality;
  });

  // Remove one at a time, ensuring min 1 per row
  var removed = {};
  var nearRemaining = nearWZ.length;
  var farRemaining = farWZ.length;
  var toRemove = scored.length - targetCount;

  for (var i = 0; i < scored.length && toRemove > 0; i++) {
    var wz = scored[i].wz;
    var isNear = scored[i].isNear;
    // Don't remove if it's the last WZ in its row
    if (isNear && nearRemaining <= 1) continue;
    if (!isNear && farRemaining <= 1) continue;
    removed[wz] = true;
    if (isNear) nearRemaining--;
    else farRemaining--;
    toRemove--;
  }

  var newActive = [];
  for (var i = 0; i < prevActive.length; i++) {
    if (!removed[prevActive[i]]) newActive.push(prevActive[i]);
  }
  newActive.sort(function (a, b) { return a - b; });
  return newActive;
}

/**
 * Build per-floor target types from remaining quota.
 * Uses round (not ceil) and caps each type at its actual remaining count
 * to prevent systematic over-allocation across floors.
 */
function buildFloorPlan(wzCount, remaining, fl, totalFloors) {
  var progress = (fl - 1) / Math.max(totalFloors - 1, 1);
  var floorsLeft = Math.max(totalFloors - fl + 1, 1);

  var types = progress < 0.5
    ? ['1K', '2K', '3K', '4K']
    : ['4K', '3K', '2K', '1K'];

  var plan = [];
  var consumed = {};
  for (var ti = 0; ti < types.length; ti++) {
    var t = types[ti];
    var rem = remaining[t] || 0;
    var share = Math.round(rem / floorsLeft);
    // Cap: never plan more than what actually remains for this type
    share = Math.min(share, rem);
    var count = Math.min(share, wzCount - plan.length);
    for (var i = 0; i < count; i++) plan.push(t);
    consumed[t] = count;
  }

  while (plan.length < wzCount) {
    var filled = false;
    for (var ti = types.length - 1; ti >= 0; ti--) {
      var t = types[ti];
      if ((remaining[t] || 0) - (consumed[t] || 0) > 0) {
        plan.push(t);
        consumed[t] = (consumed[t] || 0) + 1;
        filled = true;
        break;
      }
    }
    if (!filled) plan.push('1K');
  }

  return plan;
}

/**
 * Run one building plan with given profile.
 */
function runWithProfile(profile, allWZ, floor1Apartments, perFloorInsol, N, lluCells, mix, sortedCorrNears, orientation, quota) {
  var residentialFloors = profile.length;
  var floors = [];

  var floor1Placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
  for (var i = 0; i < floor1Apartments.length; i++) {
    var t = floor1Apartments[i].type;
    if (floor1Placed[t] !== undefined) floor1Placed[t]++;
  }
  floors.push({ floor: 1, apartments: floor1Apartments, placed: floor1Placed, activeWZ: allWZ.length });

  // Use Phase 0 Diophantine quota if available, else fall back to percentage-based
  var totalQuota;
  var totalAptEstimate;
  if (quota) {
    totalQuota = { '1K': quota['1K'] || 0, '2K': quota['2K'] || 0, '3K': quota['3K'] || 0, '4K': quota['4K'] || 0 };
    totalAptEstimate = totalQuota['1K'] + totalQuota['2K'] + totalQuota['3K'] + totalQuota['4K'];
  } else {
    totalAptEstimate = allWZ.length;
    for (var pi = 1; pi < profile.length; pi++) totalAptEstimate += profile[pi];
    totalQuota = computeQuota(totalAptEstimate, mix);
  }

  var remaining = {
    '1K': Math.max(0, totalQuota['1K'] - floor1Placed['1K']),
    '2K': Math.max(0, totalQuota['2K'] - floor1Placed['2K']),
    '3K': Math.max(0, totalQuota['3K'] - floor1Placed['3K']),
    '4K': Math.max(0, totalQuota['4K'] - floor1Placed['4K'])
  };

  var prevActive = allWZ.slice();
  for (var fl = 2; fl <= residentialFloors; fl++) {
    var targetWZCount = profile[fl - 1];
    var floorInsol = perFloorInsol[fl] || {};
    var active = selectActiveWZ(prevActive, targetWZCount, floorInsol, N);
    var floorPlan = buildFloorPlan(active.length, remaining, fl, residentialFloors);
    var result = planFloor(allWZ, active, floorInsol, N, lluCells, floorPlan, sortedCorrNears, orientation);

    for (var t in result.placed) {
      if (remaining[t] !== undefined) remaining[t] = Math.max(0, remaining[t] - (result.placed[t] || 0));
    }

    floors.push({ floor: fl, apartments: result.apartments, placed: result.placed, activeWZ: active.length });

    // WZ stacking enforcement: find which active WZ actually became WZ on this floor.
    // Any active WZ that ended up as living (stranded) must be removed for higher floors.
    var actualWZ = {};
    for (var ai = 0; ai < result.apartments.length; ai++) {
      var wc = result.apartments[ai].wetCell;
      if (typeof wc === 'number') actualWZ[wc] = true;
    }
    var filteredActive = [];
    for (var ai2 = 0; ai2 < active.length; ai2++) {
      if (actualWZ[active[ai2]]) {
        filteredActive.push(active[ai2]);
      }
    }
    prevActive = filteredActive;
  }

  // Compute score
  var totalPlaced = { '1K': 0, '2K': 0, '3K': 0, '4K': 0, orphan: 0 };
  for (var fi = 0; fi < floors.length; fi++) {
    for (var ai = 0; ai < floors[fi].apartments.length; ai++) {
      var t = floors[fi].apartments[ai].type;
      if (totalPlaced[t] !== undefined) totalPlaced[t]++;
      else totalPlaced.orphan = (totalPlaced.orphan || 0) + 1;
    }
  }

  var totalApts = totalPlaced['1K'] + totalPlaced['2K'] + totalPlaced['3K'] + totalPlaced['4K'];
  var score = 0;
  var deviation = {};
  var types = ['1K', '2K', '3K', '4K'];
  for (var i = 0; i < types.length; i++) {
    var dt = types[i];
    var tPct = totalAptEstimate > 0 ? totalQuota[dt] / totalAptEstimate * 100 : 0;
    var aPct = totalApts > 0 ? totalPlaced[dt] / totalApts * 100 : 0;
    deviation[dt] = {
      target: totalQuota[dt], actual: totalPlaced[dt],
      targetPct: Math.round(tPct), actualPct: Math.round(aPct),
      delta: totalPlaced[dt] - totalQuota[dt]
    };
    // Percentage-based score: weight by how far from target %
    score += Math.abs(aPct - tPct);
  }
  score += (totalPlaced.orphan || 0) * 50;

  return {
    floors: floors, totalPlaced: totalPlaced, originalQuota: totalQuota,
    deviation: deviation, totalTarget: totalAptEstimate, totalActual: totalApts,
    orphanCount: totalPlaced.orphan || 0, feasible: (totalPlaced.orphan || 0) === 0,
    deviationScore: score, profile: profile
  };
}

function countLivingCells(graphNodes) {
  var count = 0;
  for (var key in graphNodes) {
    if (!graphNodes.hasOwnProperty(key)) continue;
    var node = graphNodes[key];
    if (node.floor === 1 && node.type === 'apartment') count++;
  }
  return count;
}

/**
 * Main entry.
 */
export function planBuilding(params) {
  var N = params.N;
  var floorCount = params.floorCount;
  var allWZ = params.wzStacks;
  var floor1Apartments = params.floor1Apartments || [];
  var mix = params.mix;
  var perFloorInsol = params.perFloorInsol || {};
  var lluCells = params.lluCells || [];
  var sortedCorrNears = params.sortedCorrNears || [];
  var orientation = params.orientation || 'lon';
  var quota = params.quota || null;  // Phase 0 Diophantine target

  var residentialFloors = floorCount - 1;
  if (residentialFloors < 1 || allWZ.length === 0) {
    return { floors: [], totalPlaced: {}, originalQuota: {}, deviation: {},
      totalTarget: 0, totalActual: 0, orphanCount: 0, feasible: false };
  }

  var maxWZ = allWZ.length;
  var livingPerFloor = countLivingCells(params.graphNodes);
  var absMinWZ = Math.max(2, Math.ceil(livingPerFloor / 4));

  // Generate all monotonic profiles (step 0/1/2 per floor)
  var profiles = generateAllProfiles(maxWZ, absMinWZ, residentialFloors);
  console.log('[BuildingPlanner] evaluating', profiles.length, 'profiles',
    '(maxWZ=' + maxWZ + ', minWZ=' + absMinWZ + ', floors=' + residentialFloors + ')');

  var bestResult = null;
  var bestScore = Infinity;

  for (var pi = 0; pi < profiles.length; pi++) {
    var result = runWithProfile(profiles[pi], allWZ, floor1Apartments, perFloorInsol, N, lluCells, mix, sortedCorrNears, orientation, quota);
    if (result.deviationScore < bestScore) {
      bestScore = result.deviationScore;
      bestResult = result;
    }
  }

  if (bestResult) {
    console.log('[BuildingPlanner] best of', profiles.length, 'profiles:',
      bestResult.profile.join(','), 'score:', bestScore,
      'placed:', JSON.stringify(bestResult.totalPlaced),
      'target:', JSON.stringify(bestResult.originalQuota));
  }

  return bestResult || { floors: [], totalPlaced: {}, originalQuota: {}, deviation: {},
    totalTarget: 0, totalActual: 0, orphanCount: 0, feasible: false };
}
