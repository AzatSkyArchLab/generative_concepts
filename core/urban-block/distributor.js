/**
 * Distributor — pack standard section lengths along an axis
 *
 * Algorithm:
 * 1. For axes < 150m: greedy fill with largest-first, no gap
 * 2. For axes >= 150m: try to fit sections + gap (~22m target)
 *
 * Section lengths come from config based on orientation:
 *   latitudinal: [23.1, 26.4]
 *   meridional:  [29.7, 33, 36.3, 39.6, 36, 42.9, 46.2]
 */

var DEFAULT_CONFIG = {
  latitudinal_lengths: [23.1, 26.4],
  longitudinal_lengths: [29.7, 33, 36.3, 39.6, 36, 42.9, 46.2],
  target_gap: 22,
  cell_width: 3.3
};

/**
 * Get section lengths for a given orientation.
 * @param {number} orientation - 0=lat, 1=lon
 * @param {Object} [config]
 * @returns {number[]}
 */
export function getSectionLengths(orientation, config) {
  var cfg = config || DEFAULT_CONFIG;
  if (orientation === 1) {
    return cfg.longitudinal_lengths;
  }
  return cfg.latitudinal_lengths;
}

// ═══════════════════════════════════════════════════════
// Core bin-packing
// ═══════════════════════════════════════════════════════

/**
 * Greedy fill: pack as many sections as possible into lineLength.
 * Tries all combinations (brute-force for small counts).
 *
 * @param {number[]} lengths - available section lengths (will be sorted desc)
 * @param {number} lineLength
 * @returns {{ counts: number[], remainder: number, sorted: number[] }}
 */
function greedyFill(lengths, lineLength) {
  var sorted = lengths.slice().sort(function (a, b) { return b - a; });

  var bestCounts = [];
  for (var i = 0; i < sorted.length; i++) {
    bestCounts.push(0);
  }
  var bestRemainder = lineLength;

  // Recursive brute force (small search space for typical inputs)
  function tryFill(remaining, counts, idx) {
    if (idx >= sorted.length) {
      var total = 0;
      for (var i = 0; i < counts.length; i++) {
        total += sorted[i] * counts[i];
      }
      if (total <= lineLength && remaining >= 0 && remaining < bestRemainder) {
        bestRemainder = remaining;
        for (var i = 0; i < counts.length; i++) {
          bestCounts[i] = counts[i];
        }
      }
      return;
    }
    var maxFit = Math.floor(remaining / sorted[idx]);
    for (var c = maxFit; c >= 0; c--) {
      counts[idx] = c;
      var newRem = remaining - sorted[idx] * c;
      if (newRem >= 0) {
        tryFill(newRem, counts, idx + 1);
      }
    }
  }

  var initCounts = [];
  for (var i = 0; i < sorted.length; i++) {
    initCounts.push(0);
  }
  tryFill(lineLength, initCounts, 0);

  return { counts: bestCounts, remainder: bestRemainder, sorted: sorted };
}

/**
 * Fill with gap: try to fit sections + a gap close to targetGap.
 *
 * @param {number[]} lengths
 * @param {number} lineLength
 * @param {number} targetGap
 * @returns {{ counts: number[], gap: number, sorted: number[] } | null}
 */
function fillWithGap(lengths, lineLength, targetGap) {
  var sorted = lengths.slice().sort(function (a, b) { return b - a; });

  var bestCounts = null;
  var bestGapDiff = Infinity;
  var bestGap = 0;
  var bestSectionCount = 0;

  // Compute max counts per length
  var maxCounts = [];
  for (var i = 0; i < sorted.length; i++) {
    maxCounts.push(Math.min(Math.floor(lineLength / sorted[i]) + 1, 15));
  }

  // Generate all combinations (itertools.product equivalent)
  // Use iterative approach with counter array
  var counters = [];
  for (var i = 0; i < sorted.length; i++) {
    counters.push(0);
  }

  var done = false;
  while (!done) {
    // Evaluate current combination
    var total = 0;
    var sectionCount = 0;
    for (var i = 0; i < sorted.length; i++) {
      total += sorted[i] * counters[i];
      sectionCount += counters[i];
    }

    var gap = lineLength - total;
    if (gap >= 20 && total <= lineLength && sectionCount > 0) {
      var gd = Math.abs(gap - targetGap);
      if (gd < bestGapDiff || (gd === bestGapDiff && sectionCount > bestSectionCount)) {
        bestGapDiff = gd;
        bestGap = gap;
        bestSectionCount = sectionCount;
        bestCounts = counters.slice();
      }
    }

    // Increment counters (odometer-style)
    var carry = true;
    for (var i = sorted.length - 1; i >= 0 && carry; i--) {
      counters[i]++;
      if (counters[i] <= maxCounts[i]) {
        carry = false;
      } else {
        counters[i] = 0;
      }
    }
    if (carry) done = true;
  }

  if (bestCounts === null) return null;

  return { counts: bestCounts, gap: bestGap, sorted: sorted };
}

// ═══════════════════════════════════════════════════════
// Section sequence
// ═══════════════════════════════════════════════════════

/**
 * Create a sequence of sections for an axis.
 * Returns array of { length, isGap }.
 *
 * @param {number[]} sectionLengths - available standard lengths
 * @param {number} axisLength - total axis length in meters
 * @param {number} [targetGap=22]
 * @param {boolean} [useGap=false] - insert courtyard gap on axes >= 150m
 * @returns {Array<{ length: number, isGap: boolean }>}
 */
export function createSectionSequence(sectionLengths, axisLength, targetGap, useGap) {
  if (targetGap === undefined) targetGap = 22;
  if (useGap === undefined) useGap = false;

  var needGap = useGap && axisLength >= 150;
  var minSL = Infinity;
  for (var i = 0; i < sectionLengths.length; i++) {
    if (sectionLengths[i] < minSL) minSL = sectionLengths[i];
  }

  if (axisLength < minSL) {
    return [];
  }

  var result = [];

  if (needGap) {
    // Try with gap first
    var gapResult = fillWithGap(sectionLengths, axisLength, targetGap);

    if (gapResult !== null) {
      // Build section list
      var sections = [];
      for (var i = 0; i < gapResult.counts.length; i++) {
        for (var j = 0; j < gapResult.counts[i]; j++) {
          sections.push({ length: gapResult.sorted[i], isGap: false });
        }
      }

      // Insert gap in the middle
      if (gapResult.gap >= 20 && sections.length >= 2) {
        var gapIdx;
        if (sections.length >= 5) {
          gapIdx = 2 + Math.floor(Math.random() * (sections.length - 4));
        } else {
          gapIdx = 1 + Math.floor(Math.random() * Math.max(1, sections.length - 1));
        }
        sections.splice(gapIdx, 0, { length: gapResult.gap, isGap: true });
      }
      return sections;
    }

    // Fallback: greedy fill, then try to create gap by removing sections
    var greedy = greedyFill(sectionLengths, axisLength);
    var fallbackSections = [];
    for (var i = 0; i < greedy.counts.length; i++) {
      for (var j = 0; j < greedy.counts[i]; j++) {
        fallbackSections.push({ length: greedy.sorted[i], isGap: false });
      }
    }

    var remainder = greedy.remainder;
    while (remainder < 22 && fallbackSections.length > 2) {
      var removed = fallbackSections.pop();
      remainder += removed.length;
    }

    if (remainder >= 20 && fallbackSections.length >= 2) {
      var gi;
      if (fallbackSections.length >= 5) {
        gi = 2 + Math.floor(Math.random() * (fallbackSections.length - 4));
      } else {
        gi = 1 + Math.floor(Math.random() * Math.max(1, fallbackSections.length - 1));
      }
      fallbackSections.splice(gi, 0, { length: remainder, isGap: true });
    }
    return fallbackSections;

  } else {
    // No gap needed — just greedy fill
    var fill = greedyFill(sectionLengths, axisLength);
    for (var i = 0; i < fill.counts.length; i++) {
      for (var j = 0; j < fill.counts[i]; j++) {
        result.push({ length: fill.sorted[i], isGap: false });
      }
    }
    return result;
  }
}

// ═══════════════════════════════════════════════════════
// Place sections along a polyline
// ═══════════════════════════════════════════════════════

/**
 * Place sections along a polyline in meter space.
 * Returns positioned sections with start/end points.
 *
 * @param {Array<[number, number]>} coordsM - polyline in meters
 * @param {Array<{ length: number, isGap: boolean }>} sequence
 * @param {number} totalLength - axis length in meters
 * @returns {Array<{ length: number, isGap: boolean, startM: [number,number], endM: [number,number] }>}
 */
export function placeSections(coordsM, sequence, totalLength) {
  if (totalLength <= 0 || coordsM.length < 2) return [];

  var positioned = [];
  var pos = 0;

  for (var i = 0; i < sequence.length; i++) {
    var sec = sequence[i];
    var startNorm = pos / totalLength;
    var endNorm = (pos + sec.length) / totalLength;

    // Clamp
    if (startNorm > 1) startNorm = 1;
    if (endNorm > 1) endNorm = 1;

    var startPt = interpolatePolyline(coordsM, startNorm, totalLength);
    var endPt = interpolatePolyline(coordsM, endNorm, totalLength);

    positioned.push({
      length: sec.length,
      isGap: sec.isGap,
      startM: startPt,
      endM: endPt,
      startPos: pos,
      endPos: pos + sec.length
    });

    pos += sec.length;
  }

  return positioned;
}

/**
 * Interpolate a point on a polyline at normalized position [0..1].
 *
 * @param {Array<[number, number]>} coords
 * @param {number} t - normalized [0..1]
 * @param {number} totalLength
 * @returns {[number, number]}
 */
function interpolatePolyline(coords, t, totalLength) {
  var targetDist = t * totalLength;
  if (targetDist <= 0) return [coords[0][0], coords[0][1]];

  var accumulated = 0;
  for (var i = 0; i < coords.length - 1; i++) {
    var dx = coords[i + 1][0] - coords[i][0];
    var dy = coords[i + 1][1] - coords[i][1];
    var segLen = Math.sqrt(dx * dx + dy * dy);

    if (accumulated + segLen >= targetDist) {
      var frac = (targetDist - accumulated) / segLen;
      return [
        coords[i][0] + dx * frac,
        coords[i][1] + dy * frac
      ];
    }
    accumulated += segLen;
  }

  var last = coords[coords.length - 1];
  return [last[0], last[1]];
}

/**
 * Compute total length of a polyline in meters.
 * @param {Array<[number, number]>} coordsM
 * @returns {number}
 */
export function polylineLength(coordsM) {
  var total = 0;
  for (var i = 0; i < coordsM.length - 1; i++) {
    var dx = coordsM[i + 1][0] - coordsM[i][0];
    var dy = coordsM[i + 1][1] - coordsM[i][1];
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}
