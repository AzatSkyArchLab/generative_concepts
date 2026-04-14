/**
 * QuotaAllocator — cross-section apartment mix distribution.
 *
 * Instead of giving every section the same aptMix, analyze floor 1
 * results to determine each section's "potential" for each apartment type.
 * Lat sections naturally produce 3K/4K (large torecs), so they get
 * higher 3K/4K quota. Lon sections produce 1K/2K efficiently,
 * so they absorb the small apartment quota.
 *
 * Input: array of section profiles (from floor 1 solver results).
 * Output: per-section adjusted mix that sums to the global target.
 */

import { log } from '../Logger.js';

/**
 * Compute section potential from floor 1 results.
 * Returns {1K, 2K, 3K, 4K} weights — higher = more natural fit.
 */
function computePotential(profile) {
  var ori = profile.orientation;
  var fl1 = profile.floor1Placed;

  if (ori === 'lat') {
    // Lat sections: torecs force 3K/4K, middle has limited room for 1K
    // Floor 1 already shows the structural bias
    return {
      '1K': 0.5,  // can make some 1K in middle, but limited
      '2K': 1.0,  // moderate — w-blocks in far segment
      '3K': 2.0,  // natural — torec size + f-cluster grows
      '4K': 2.5   // natural — large torecs, upper floor expansion
    };
  }

  // Lon (meridional): 1K torecs, both facades have p → lots of 1K/2K pairs
  return {
    '1K': 2.5,  // natural — p-pairs everywhere
    '2K': 2.0,  // natural — w-block slicing
    '3K': 1.0,  // possible but not natural
    '4K': 0.5   // only through w-block merge or upper floors
  };
}

/**
 * Allocate per-section mixes from global mix.
 *
 * @param {Array} sectionProfiles - [{key, orientation, floor1Placed, totalEstimate, floorCount}]
 * @param {Object} globalMix - {1K: 40, 2K: 30, 3K: 20, 4K: 10} (percentages)
 * @returns {Object} { sectionKey: {1K, 2K, 3K, 4K} } — percentage mixes per section
 */
export function allocateQuotas(sectionProfiles, globalMix) {
  if (!sectionProfiles || sectionProfiles.length === 0) return {};
  if (sectionProfiles.length === 1) {
    // Single section — use global mix as-is
    var result = {};
    result[sectionProfiles[0].key] = {
      '1K': globalMix['1K'] != null ? globalMix['1K'] : 40,
      '2K': globalMix['2K'] != null ? globalMix['2K'] : 30,
      '3K': globalMix['3K'] != null ? globalMix['3K'] : 20,
      '4K': globalMix['4K'] != null ? globalMix['4K'] : 10
    };
    return result;
  }

  var types = ['1K', '2K', '3K', '4K'];

  // Step 1: total apartments across all sections
  var totalApts = 0;
  for (var si = 0; si < sectionProfiles.length; si++) {
    totalApts += sectionProfiles[si].totalEstimate;
  }
  if (totalApts === 0) totalApts = 1;

  // Step 2: global target counts
  var mixSum = 0;
  for (var ti = 0; ti < types.length; ti++) {
    mixSum += (globalMix[types[ti]] || 0);
  }
  if (mixSum === 0) mixSum = 100;

  var globalTarget = {};
  for (var ti = 0; ti < types.length; ti++) {
    globalTarget[types[ti]] = totalApts * (globalMix[types[ti]] || 0) / mixSum;
  }

  // Step 3: compute weighted demand per section per type
  // demand[si][type] = potential[type] * sectionApts
  var demands = [];
  var totalDemand = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };

  for (var si = 0; si < sectionProfiles.length; si++) {
    var pot = computePotential(sectionProfiles[si]);
    var secApts = sectionProfiles[si].totalEstimate;
    var d = {};
    for (var ti = 0; ti < types.length; ti++) {
      var t = types[ti];
      d[t] = pot[t] * secApts;
      totalDemand[t] += d[t];
    }
    demands.push(d);
  }

  // Step 4: allocate global target proportionally to demand
  // sectionQuota[si][type] = globalTarget[type] * demand[si][type] / totalDemand[type]
  var quotas = [];
  for (var si = 0; si < sectionProfiles.length; si++) {
    var q = {};
    for (var ti = 0; ti < types.length; ti++) {
      var t = types[ti];
      if (totalDemand[t] > 0) {
        q[t] = globalTarget[t] * demands[si][t] / totalDemand[t];
      } else {
        q[t] = 0;
      }
    }
    quotas.push(q);
  }

  // Step 5: convert to percentage mix per section
  // Each section's quota → percentage of that section's total
  var result = {};
  for (var si = 0; si < sectionProfiles.length; si++) {
    var secTotal = 0;
    for (var ti = 0; ti < types.length; ti++) {
      secTotal += quotas[si][types[ti]];
    }
    if (secTotal === 0) secTotal = 1;

    var mix = {};
    for (var ti = 0; ti < types.length; ti++) {
      mix[types[ti]] = Math.round(quotas[si][types[ti]] / secTotal * 100);
    }

    // Normalize to 100%
    var mixTotal = 0;
    for (var ti = 0; ti < types.length; ti++) mixTotal += mix[types[ti]];
    if (mixTotal !== 100 && mixTotal > 0) {
      // Adjust largest type
      var maxT = '1K';
      for (var ti = 1; ti < types.length; ti++) {
        if (mix[types[ti]] > mix[maxT]) maxT = types[ti];
      }
      mix[maxT] += (100 - mixTotal);
    }

    result[sectionProfiles[si].key] = mix;
  }

  // Log allocation
  log.debug('[QuotaAllocator] global mix:', JSON.stringify(globalMix));
  for (var si = 0; si < sectionProfiles.length; si++) {
    var p = sectionProfiles[si];
    log.debug('[QuotaAllocator]', p.key, p.orientation,
      'apts≈' + p.totalEstimate,
      '→ mix:', JSON.stringify(result[p.key]));
  }

  return result;
}
