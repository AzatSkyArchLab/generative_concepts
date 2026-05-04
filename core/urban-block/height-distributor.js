/**
 * Height distributor — assign per-section floor counts so that the
 * total gross building area (СПП / GBA) of an urban block
 * approximates a user-specified target, while respecting orientation-
 * based height preferences.
 *
 * Inputs:
 *   - sections: [{ fpId, axisId, orientation: 'lat'|'lon',
 *                  footprintArea: number, centroidY: number }]
 *   - targetSPP:  target total GBA in m²
 *   - params:     { firstFloorHeight, typicalFloorHeight }
 *   - options:    { hLonMin:55, hLonMax:75, hLatMin:28, hLatMax:55 }
 *
 * Output: sections with added { assignedFloors, assignedHeight }.
 *
 * Algorithm (deterministic greedy):
 *   1. Start each section at its ORIENTATION MIN height
 *      (floorCount that yields ≥ hMin).
 *   2. If current GBA < target:
 *      Phase A: +1 floor to the northernmost section that hasn't
 *        reached its orientation MAX. Repeat.
 *      Phase B: if all sections hit MAX and GBA still < target,
 *        keep adding +1 floor to the northernmost section (soft
 *        upper bound — we prefer going above MAX over missing
 *        the SPP target). Stop when |gba - target| < step/2.
 *   3. If current GBA > target at minimums, it means the block
 *      is too large for the target — switch to TAKE -1 floor from
 *      the southernmost section (but not below a hard floor of 1).
 *   4. Terminate when:
 *        - adding/removing one floor anywhere would move the error
 *          further from target, OR
 *        - no section can be moved in the needed direction.
 *
 * Why greedy suffices:
 *   This is a bounded integer programming problem — we could solve
 *   exactly with branch-and-bound, but sections vary in footprint
 *   by at most a factor of 2-3 in practice, so the greedy solution
 *   is within one footprint-per-floor of optimal. And the northern-
 *   preference tiebreaker makes the result visually stable.
 */

// ── Height / floor utilities ───────────────────────────────

/**
 * Minimum floor count whose resulting height ≥ targetH.
 * Mirrors computeBuildingHeight: building = firstH + (fc-1) × typicalH.
 * Ground floor is 1, which gives height = firstH. Each added floor
 * adds typicalH. So we want smallest fc where firstH + (fc-1)×typ ≥ targetH.
 */
function floorsFor(h, firstH, typicalH) {
  if (h <= firstH) return 1;
  return 1 + Math.ceil((h - firstH) / typicalH);
}

function heightFor(floors, firstH, typicalH) {
  if (floors <= 1) return firstH;
  return firstH + (floors - 1) * typicalH;
}

// ── Public entry point ─────────────────────────────────────

export var DEFAULT_HEIGHT_RANGES = {
  hLonMin: 55, hLonMax: 75,
  hLatMin: 28, hLatMax: 55
};

/**
 * Absolute hard floor: no section may drop below this floor count
 * regardless of target SPP. A 5-floor minimum keeps residential
 * sections viable — below that both the building plan pipeline
 * (needs ≥ 3 residential floors to run QuotaAllocator) and the
 * insolation / WZ stacking logic start producing empty geometry.
 *
 * If the user's target SPP is so small that even 5-floor-minimum
 * construction exceeds it, we just accept the resulting positive
 * delta — "the block is too big for this SPP" is a valid state.
 */
export var HARD_MIN_FLOORS = 5;

/**
 * @param {Array<Object>} sections — mutated in place with `assignedFloors`
 *   and `assignedHeight`.
 * @param {number} targetSPP
 * @param {Object} params — { firstFloorHeight, typicalFloorHeight }
 * @param {Object} [options]
 * @returns {{
 *   achievedSPP: number,
 *   deltaSPP: number,
 *   perSection: Array,
 *   feasible: boolean,
 *   aboveMaxCount: number
 * }}
 */
export function distributeHeights(sections, targetSPP, params, options) {
  var opts = Object.assign({}, DEFAULT_HEIGHT_RANGES, options || {});
  var firstH = params.firstFloorHeight || 4.5;
  var typH = params.typicalFloorHeight || 3.0;

  if (!sections || sections.length === 0 || !(targetSPP > 0)) {
    return {
      achievedSPP: 0, deltaSPP: -targetSPP || 0,
      perSection: [], feasible: false, aboveMaxCount: 0
    };
  }

  // Per-section bookkeeping
  for (var i = 0; i < sections.length; i++) {
    var s = sections[i];
    var hMin = s.orientation === 'lon' ? opts.hLonMin : opts.hLatMin;
    var hMax = s.orientation === 'lon' ? opts.hLonMax : opts.hLatMax;
    // Start from the orientation-based minimum, but never below the
    // absolute hard floor (5 floors) — we cannot render residential
    // sections below that without empty geometry.
    s._minFloors = Math.max(HARD_MIN_FLOORS, floorsFor(hMin, firstH, typH));
    s._maxFloors = Math.max(s._minFloors, floorsFor(hMax, firstH, typH));
    s.assignedFloors = s._minFloors;
  }

  function currentGBA() {
    var sum = 0;
    for (var j = 0; j < sections.length; j++) {
      sum += sections[j].footprintArea * sections[j].assignedFloors;
    }
    return sum;
  }

  // Sort helpers. Cloned arrays so we can re-sort without reordering
  // the caller's reference.
  function byNorthernThenArea(arr) {
    // Primary: northernmost first. When two sections have the same
    // centroid Y within a millimetre, prefer the larger footprint —
    // one extra floor there moves us closer to target per step, so
    // greedy converges slightly faster.
    return arr.slice().sort(function (a, b) {
      var dy = b.centroidY - a.centroidY;
      if (Math.abs(dy) > 1e-3) return dy;
      return b.footprintArea - a.footprintArea;
    });
  }

  function bySouthernThenArea(arr) {
    return arr.slice().sort(function (a, b) {
      var dy = a.centroidY - b.centroidY;
      if (Math.abs(dy) > 1e-3) return dy;
      return b.footprintArea - a.footprintArea;
    });
  }

  var gba = currentGBA();

  // Case: minimums already overshoot — strip floors from southern
  // sections until as close to target as possible.
  if (gba > targetSPP) {
    var southFirst = bySouthernThenArea(sections);
    // Repeat until |delta| can't be reduced by -1 floor anywhere.
    var guard = 0;
    while (guard < 10000) {
      guard++;
      var bestS = null;
      var bestErr = Math.abs(gba - targetSPP);
      for (var k = 0; k < southFirst.length; k++) {
        var s2 = southFirst[k];
        // Never drop below the hard minimum (5 floors) — see
        // HARD_MIN_FLOORS rationale.
        if (s2.assignedFloors <= HARD_MIN_FLOORS) continue;
        var candidateGba = gba - s2.footprintArea;
        var err = Math.abs(candidateGba - targetSPP);
        if (err < bestErr) { bestErr = err; bestS = s2; }
      }
      if (!bestS) break;
      bestS.assignedFloors -= 1;
      gba -= bestS.footprintArea;
    }
  } else if (gba < targetSPP) {
    // Phase A: add +1 floor to the northernmost under-max section
    // until either target reached or everyone maxed out.
    var northFirst = byNorthernThenArea(sections);
    var guardA = 0;
    while (gba < targetSPP && guardA < 10000) {
      guardA++;
      var picked = null;
      for (var m = 0; m < northFirst.length; m++) {
        var s3 = northFirst[m];
        if (s3.assignedFloors < s3._maxFloors) { picked = s3; break; }
      }
      if (!picked) break; // all maxed — phase A done
      picked.assignedFloors += 1;
      gba += picked.footprintArea;
    }

    // Phase B: if we overshot target by adding a full floor at the
    // last step, check whether stepping back gives less error. This
    // is the "±1 floor" termination condition.
    if (gba > targetSPP) {
      // Try removing the last added floor from any northern section
      // if it was in range. We iterate once — the 'overshoot' after
      // a step is at most one section-worth.
      var overErr = Math.abs(gba - targetSPP);
      for (var p = 0; p < northFirst.length; p++) {
        var s4 = northFirst[p];
        if (s4.assignedFloors <= s4._minFloors) continue;
        var candGba = gba - s4.footprintArea;
        if (Math.abs(candGba - targetSPP) < overErr) {
          s4.assignedFloors -= 1;
          gba = candGba;
          overErr = Math.abs(gba - targetSPP);
        }
      }
    }

    // Phase C (soft-max breach): target still not reached because
    // every section already at its MAX. Keep adding floors above
    // MAX, northern-preferred, until |delta| ≤ one-floor-step.
    if (gba < targetSPP) {
      var guardC = 0;
      while (gba < targetSPP && guardC < 10000) {
        guardC++;
        // Among all sections find the one whose +1 floor produces
        // the smallest |newGBA - target|. If adding anywhere
        // overshoots and makes error worse, stop.
        var best = null;
        var bestErrC = Math.abs(gba - targetSPP);
        // Iterate northern-first so ties favour northern sections.
        for (var q = 0; q < northFirst.length; q++) {
          var s5 = northFirst[q];
          var newGba = gba + s5.footprintArea;
          var e = Math.abs(newGba - targetSPP);
          if (e < bestErrC - 1e-6) {
            bestErrC = e;
            best = s5;
          }
        }
        if (!best) break;
        best.assignedFloors += 1;
        gba += best.footprintArea;
      }
    }
  }

  // Fill in final heights + count how many sections broke their
  // orientation max (feasibility signal).
  var aboveMaxCount = 0;
  var perSection = [];
  for (var r = 0; r < sections.length; r++) {
    var s6 = sections[r];
    s6.assignedHeight = heightFor(s6.assignedFloors, firstH, typH);
    if (s6.assignedFloors > s6._maxFloors) aboveMaxCount++;
    perSection.push({
      fpId: s6.fpId, axisId: s6.axisId, orientation: s6.orientation,
      footprintArea: s6.footprintArea, centroidY: s6.centroidY,
      assignedFloors: s6.assignedFloors, assignedHeight: s6.assignedHeight,
      minFloors: s6._minFloors, maxFloors: s6._maxFloors,
      aboveMax: s6.assignedFloors > s6._maxFloors
    });
    // Remove scratch fields from the input objects.
    delete s6._minFloors;
    delete s6._maxFloors;
  }

  var achieved = currentGBA();
  return {
    achievedSPP: achieved,
    deltaSPP: achieved - targetSPP,
    perSection: perSection,
    feasible: Math.abs(achieved - targetSPP) < 0.05 * targetSPP,  // within 5%
    aboveMaxCount: aboveMaxCount
  };
}
