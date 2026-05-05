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
 * Corner sections (when present, marked `isCorner: true`) are locked
 * at this floor count regardless of target SPP. Their contribution to
 * the building stack is fixed: we subtract their SPP from the target
 * before distributing the remainder among regular sections. 9 floors
 * = 28.5 m at the standard 4.5/3.0 split.
 */
export var CORNER_LOCKED_FLOORS = 9;

/**
 * Latitudinal-axis pair rule — when a latitudinal axis splits its
 * sections into two height groups, the difference must be at least
 * this many floors so the variation reads architecturally.
 */
var LAT_PAIR_MIN_FLOOR_DIFF = 3;

/**
 * @param {Array<Object>} sections — mutated in place with `assignedFloors`
 *   and `assignedHeight`. Each entry: { fpId, axisId, orientation,
 *   footprintArea, centroidY, isCorner? }. Corners are locked at
 *   CORNER_LOCKED_FLOORS; regular sections distribute the remainder.
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

  // ── Phase 1: lock corners at CORNER_LOCKED_FLOORS ─────────
  //
  // Corners (urban-block corners-mode) keep a fixed 9-floor stack so
  // the L-shaped corner volumes read consistently. Their SPP is
  // subtracted from the target; the remainder distributes to the
  // regular sections.
  var lockedSPP = 0;
  var regulars = [];
  for (var i = 0; i < sections.length; i++) {
    var s = sections[i];
    if (s.isCorner) {
      s.assignedFloors = CORNER_LOCKED_FLOORS;
      s.assignedHeight = heightFor(CORNER_LOCKED_FLOORS, firstH, typH);
      lockedSPP += s.footprintArea * CORNER_LOCKED_FLOORS;
    } else {
      regulars.push(s);
    }
  }
  var adjTarget = Math.max(0, targetSPP - lockedSPP);

  // ── Phase 2: group regular sections by axisId ─────────────
  //
  // Same-axis sections share one floor count by default. Latitudinal
  // axes can later split their sections into adjacent pairs with a
  // height difference of at least LAT_PAIR_MIN_FLOOR_DIFF floors.
  var axesMap = {};
  for (var ri = 0; ri < regulars.length; ri++) {
    var sr = regulars[ri];
    var aid = sr.axisId;
    if (!axesMap[aid]) {
      axesMap[aid] = {
        axisId: aid,
        sections: [],
        totalArea: 0,
        sumCentroidY: 0,
        orientation: sr.orientation
      };
    }
    axesMap[aid].sections.push(sr);
    axesMap[aid].totalArea += sr.footprintArea;
    axesMap[aid].sumCentroidY += sr.centroidY;
  }
  var axes = [];
  for (var aid2 in axesMap) {
    if (!axesMap.hasOwnProperty(aid2)) continue;
    var a0 = axesMap[aid2];
    a0.avgCentroidY = a0.sumCentroidY / a0.sections.length;
    var hMin = a0.orientation === 'lon' ? opts.hLonMin : opts.hLatMin;
    var hMax = a0.orientation === 'lon' ? opts.hLonMax : opts.hLatMax;
    a0.minFloors = Math.max(HARD_MIN_FLOORS, floorsFor(hMin, firstH, typH));
    a0.maxFloors = Math.max(a0.minFloors, floorsFor(hMax, firstH, typH));
    a0.assignedFloors = a0.minFloors;
    axes.push(a0);
  }

  function axisGBA() {
    var sum = 0;
    for (var j = 0; j < axes.length; j++) {
      sum += axes[j].totalArea * axes[j].assignedFloors;
    }
    return sum;
  }

  // Growth order: meridional axes first (longer / more vertical-friendly),
  // then latitudinal. Within each orientation group we prefer the
  // northernmost first. This mirrors the user's priority rule:
  //   tower > meridional > latitudinal, growth always toward north.
  // Towers are subtracted from the target before this function is
  // called, so within the regular pool we just enforce the mer>lat>
  // by-north order here.
  function axesByNorthern() {
    return axes.slice().sort(function (a, b) {
      var ra = a.orientation === 'lon' ? 0 : 1;
      var rb = b.orientation === 'lon' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      var dy = b.avgCentroidY - a.avgCentroidY;
      if (Math.abs(dy) > 1e-3) return dy;
      return b.totalArea - a.totalArea;
    });
  }
  // Strip order: opposite — latitudinal axes first, then meridional;
  // and within each, the southernmost first. This protects the
  // "tall meridional north" silhouette when SPP is over target.
  function axesBySouthern() {
    return axes.slice().sort(function (a, b) {
      var ra = a.orientation === 'lon' ? 1 : 0;
      var rb = b.orientation === 'lon' ? 1 : 0;
      if (ra !== rb) return ra - rb;
      var dy = a.avgCentroidY - b.avgCentroidY;
      if (Math.abs(dy) > 1e-3) return dy;
      return b.totalArea - a.totalArea;
    });
  }

  // ── Phase 3: greedy distribution at axis level ────────────
  //
  // Every axis carries one floor count; bumping the axis bumps every
  // section in it. Northern axes go first when adding so the result
  // also reads "north taller than south" without an explicit boost.
  var gba = axisGBA();
  if (gba > adjTarget && axes.length > 0) {
    // Strip from southern axes.
    var southFirst = axesBySouthern();
    var guardS = 0;
    while (guardS < 10000) {
      guardS++;
      var bestAxisS = null;
      var bestErrS = Math.abs(gba - adjTarget);
      for (var k = 0; k < southFirst.length; k++) {
        var ax = southFirst[k];
        if (ax.assignedFloors <= HARD_MIN_FLOORS) continue;
        var c = gba - ax.totalArea;
        var e = Math.abs(c - adjTarget);
        if (e < bestErrS) { bestErrS = e; bestAxisS = ax; }
      }
      if (!bestAxisS) break;
      bestAxisS.assignedFloors -= 1;
      gba -= bestAxisS.totalArea;
    }
  } else if (gba < adjTarget && axes.length > 0) {
    var northFirst = axesByNorthern();
    var guardA = 0;
    while (gba < adjTarget && guardA < 10000) {
      guardA++;
      var picked = null;
      for (var m = 0; m < northFirst.length; m++) {
        var axN = northFirst[m];
        if (axN.assignedFloors < axN.maxFloors) { picked = axN; break; }
      }
      if (!picked) break;
      picked.assignedFloors += 1;
      gba += picked.totalArea;
    }

    // Step-back if overshot by one full axis.
    if (gba > adjTarget) {
      var overE = Math.abs(gba - adjTarget);
      for (var p = 0; p < northFirst.length; p++) {
        var axP = northFirst[p];
        if (axP.assignedFloors <= axP.minFloors) continue;
        var c2 = gba - axP.totalArea;
        if (Math.abs(c2 - adjTarget) < overE) {
          axP.assignedFloors -= 1;
          gba = c2;
          overE = Math.abs(gba - adjTarget);
        }
      }
    }

    // Soft-max breach intentionally disabled: hard-cap at hLat/hLon
    // max (55m / 75m). Sections must never exceed tower height (112m
    // by default), so going over the orientation max is forbidden.
    // If SPP target can't be met within max, accept the positive
    // delta — the user explicitly tolerates that.
  }

  // ── Phase 4: optional latitudinal pair-split ──────────────
  //
  // For any latitudinal axis with an EVEN number of sections, allow
  // the assigned floor count to split into two adjacent groups with
  // a difference of at least LAT_PAIR_MIN_FLOOR_DIFF floors. The
  // northern half (or southern half rotated to north preference) gets
  // the higher count. Skipped here for simplicity — every section in
  // an axis takes the axis-level count. Hook reserved for future
  // refinement; baseline already satisfies "neighbour same height"
  // because every section in an axis is neighbour-of-neighbour.
  // (A pair-split implementation would re-distribute floors WITHIN an
  // axis, keeping its sum-of-floors equal to N × axis.assignedFloors
  // so the SPP target stays put.)

  // ── Phase 5: write the per-axis floor count to every section ──
  for (var ax2 = 0; ax2 < axes.length; ax2++) {
    var aF = axes[ax2];
    for (var sx = 0; sx < aF.sections.length; sx++) {
      var sS = aF.sections[sx];
      sS.assignedFloors = aF.assignedFloors;
      sS.assignedHeight = heightFor(aF.assignedFloors, firstH, typH);
      sS._minFloors = aF.minFloors;
      sS._maxFloors = aF.maxFloors;
    }
  }

  // ── Phase 6: final SPP + per-section dump ─────────────────
  function totalGBA() {
    var sum = 0;
    for (var t = 0; t < sections.length; t++) {
      sum += sections[t].footprintArea * (sections[t].assignedFloors || 0);
    }
    return sum;
  }

  var aboveMaxCount = 0;
  var perSection = [];
  for (var r = 0; r < sections.length; r++) {
    var s6 = sections[r];
    if (!s6.assignedHeight && s6.assignedFloors) {
      s6.assignedHeight = heightFor(s6.assignedFloors, firstH, typH);
    }
    var minF = s6._minFloors != null ? s6._minFloors : (s6.isCorner ? CORNER_LOCKED_FLOORS : HARD_MIN_FLOORS);
    var maxF = s6._maxFloors != null ? s6._maxFloors : (s6.isCorner ? CORNER_LOCKED_FLOORS : minF);
    if (!s6.isCorner && s6.assignedFloors > maxF) aboveMaxCount++;
    perSection.push({
      fpId: s6.fpId, axisId: s6.axisId, orientation: s6.orientation,
      footprintArea: s6.footprintArea, centroidY: s6.centroidY,
      assignedFloors: s6.assignedFloors, assignedHeight: s6.assignedHeight,
      minFloors: minF, maxFloors: maxF,
      isCorner: !!s6.isCorner,
      aboveMax: !s6.isCorner && s6.assignedFloors > maxF
    });
    delete s6._minFloors;
    delete s6._maxFloors;
  }

  var achieved = totalGBA();
  return {
    achievedSPP: achieved,
    deltaSPP: achieved - targetSPP,
    perSection: perSection,
    feasible: Math.abs(achieved - targetSPP) < 0.05 * targetSPP,
    aboveMaxCount: aboveMaxCount
  };
}
