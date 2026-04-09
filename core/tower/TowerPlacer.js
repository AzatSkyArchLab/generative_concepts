/**
 * TowerPlacer — pack towers along an axis.
 *
 * Rules:
 * - Meridional axis: largest tower that fits, long side along axis
 * - Latitudinal axis: always small (square) towers
 * - Gap between towers: 20m default, configurable
 * - Maximize packing: fit as many towers as possible
 *
 * Similar to section distributor but for discrete tower sizes.
 */

import {
  chooseTowerSize, getTowerDimensions, generateTower,
  DEFAULT_CELL_SIZE
} from './TowerGenerator.js';

var DEFAULT_GAP = 20;

// ── Packing ──────────────────────────────────────────

/**
 * Compute tower sequence along an axis.
 *
 * @param {number} axisLength - total axis length in meters
 * @param {string} orientation - 'lat' or 'lon'
 * @param {Object} [options]
 * @param {number} [options.gap=20] - gap between towers in meters
 * @param {number} [options.cellSize=3.3]
 * @returns {Array<Object>} towers [{size, lengthAlong, widthAcross, offset}]
 *   offset = distance from axis start to tower center
 */
export function packTowers(axisLength, orientation, options) {
  if (!options) options = {};
  var gap = options.gap != null ? options.gap : DEFAULT_GAP;
  var cellSize = options.cellSize || DEFAULT_CELL_SIZE;
  var forcedSize = options.forcedSize || null;

  // Determine which tower size to use
  var size = forcedSize || chooseTowerSize(orientation, axisLength, cellSize);
  var dims = getTowerDimensions(size, cellSize, orientation);

  // Try to pack as many as possible with gap
  var towerLen = dims.lengthAlong;
  var towerWid = dims.widthAcross;

  // Single tower minimum
  if (axisLength < towerLen) {
    // Can't fit even one — try smaller sizes
    if (size === 'large') {
      size = 'medium';
      dims = getTowerDimensions(size, cellSize, orientation);
      towerLen = dims.lengthAlong;
    }
    if (axisLength < towerLen && size === 'medium') {
      size = 'small';
      dims = getTowerDimensions(size, cellSize, orientation);
      towerLen = dims.lengthAlong;
    }
    if (axisLength < towerLen) {
      return []; // can't fit any tower
    }
  }

  // Greedy pack: how many towers fit?
  // n towers + (n-1) gaps ≤ axisLength
  // n * towerLen + (n-1) * gap ≤ axisLength
  // n ≤ (axisLength + gap) / (towerLen + gap)
  var maxCount = Math.floor((axisLength + gap) / (towerLen + gap));
  if (maxCount < 1) maxCount = 1;

  // Verify fit
  var totalUsed = maxCount * towerLen + (maxCount - 1) * gap;
  while (totalUsed > axisLength + 0.01 && maxCount > 1) {
    maxCount--;
    totalUsed = maxCount * towerLen + (maxCount - 1) * gap;
  }

  if (maxCount < 1) return [];

  // Center the sequence on the axis
  var startOffset = (axisLength - totalUsed) / 2;

  var towers = [];
  for (var i = 0; i < maxCount; i++) {
    var towerStart = startOffset + i * (towerLen + gap);
    var towerCenter = towerStart + towerLen / 2;
    towers.push({
      index: i,
      size: size,
      lengthAlong: towerLen,
      widthAcross: towerWid,
      offset: towerCenter,     // distance from axis start to tower center
      startOffset: towerStart  // distance from axis start to tower leading edge
    });
  }

  return towers;
}

/**
 * Place towers along a concrete axis in meter coordinates.
 *
 * @param {[number,number]} startM - axis start in meters
 * @param {[number,number]} endM - axis end in meters
 * @param {string} orientation - 'lat' or 'lon'
 * @param {string} northEnd - 'start' or 'end' of axis faces north
 * @param {Object} [options] - gap, cellSize
 * @returns {Array<Object>} towers with full geometry
 */
export function placeTowersOnAxis(startM, endM, orientation, northEnd, options) {
  if (!options) options = {};
  var cellSize = options.cellSize || DEFAULT_CELL_SIZE;

  var dx = endM[0] - startM[0];
  var dy = endM[1] - startM[1];
  var axisLength = Math.sqrt(dx * dx + dy * dy);

  if (axisLength < 1) return [];

  var dirX = dx / axisLength;
  var dirY = dy / axisLength;

  // Axis angle: angle from Y-axis (north) clockwise
  var angle = Math.atan2(dirX, dirY);

  var sequence = packTowers(axisLength, orientation, options);
  var results = [];

  for (var i = 0; i < sequence.length; i++) {
    var t = sequence[i];

    // Tower center in world meters
    var cx = startM[0] + dirX * t.offset;
    var cy = startM[1] + dirY * t.offset;

    var tower = generateTower({
      size: t.size,
      cellSize: cellSize,
      northEnd: northEnd,
      centerX: cx,
      centerY: cy,
      angle: angle
    });

    tower.index = t.index;
    tower.size = t.size;
    tower.offset = t.offset;
    tower.startOffset = t.startOffset;
    results.push(tower);
  }

  return results;
}

/**
 * Determine which end of axis faces north.
 * North = positive Y in meter space.
 *
 * @param {[number,number]} startM
 * @param {[number,number]} endM
 * @returns {string} 'start' or 'end'
 */
export function detectNorthEnd(startM, endM) {
  // For meridional (N-S): north is positive Y
  // If end.y > start.y, end faces north → LLU exit at 'end'
  // If start.y > end.y, start faces north → LLU exit at 'start'
  if (endM[1] >= startM[1]) return 'end';
  return 'start';
}

export { DEFAULT_GAP };
