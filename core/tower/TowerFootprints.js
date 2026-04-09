/**
 * TowerFootprints — recompute tower footprints from axis + properties.
 *
 * Shared between TowerTool (at draw time) and Processor (on rebuild).
 * This ensures cellSize/gap changes are always reflected.
 */

import { packTowers } from './TowerPlacer.js';
import { DEFAULT_CELL_SIZE } from './TowerGenerator.js';
import { classifySegment } from '../../modules/urban-block/orientation.js';

/**
 * Compute tower footprint polygons from axis endpoints and properties.
 *
 * @param {[number,number]} startM - axis start in meters
 * @param {[number,number]} endM - axis end in meters
 * @param {Object} props - feature properties (cellSize, towerGap, flipped, orientation)
 * @param {Function} toLngLat - proj.toLngLat
 * @returns {Array<Object>} footprints [{polygon, length, size}] in lng/lat
 */
export function computeTowerFootprints(startM, endM, props, toLngLat) {
  var dx = endM[0] - startM[0];
  var dy = endM[1] - startM[1];
  var totalLen = Math.sqrt(dx * dx + dy * dy);
  if (totalLen < 1) return [];

  var cellSize = props.cellSize || DEFAULT_CELL_SIZE;
  var gap = props.towerGap != null ? props.towerGap : 20;
  var flipped = props.flipped || false;
  var forcedSize = props.forcedSize || null;

  var ori = classifySegment(startM, endM);
  var towers = packTowers(totalLen, ori.orientationName, { cellSize: cellSize, gap: gap, forcedSize: forcedSize });
  if (towers.length === 0) return [];

  var dirX = dx / totalLen;
  var dirY = dy / totalLen;
  var perpX = flipped ? dirY : -dirY;
  var perpY = flipped ? -dirX : dirX;

  var result = [];
  for (var i = 0; i < towers.length; i++) {
    var t = towers[i];
    var ts = t.startOffset;
    var te = ts + t.lengthAlong;
    var hw = t.widthAcross;

    var sx = startM[0] + dirX * ts;
    var sy = startM[1] + dirY * ts;
    var ex = startM[0] + dirX * te;
    var ey = startM[1] + dirY * te;
    var ox = perpX * hw;
    var oy = perpY * hw;

    var polyM = [[sx, sy], [ex, ey], [ex + ox, ey + oy], [sx + ox, sy + oy]];

    if (toLngLat) {
      var polyLL = [];
      for (var j = 0; j < polyM.length; j++) {
        polyLL.push(toLngLat(polyM[j][0], polyM[j][1]));
      }
      result.push({ polygon: polyLL, length: t.lengthAlong, size: t.size });
    } else {
      result.push({ polygon: polyM, length: t.lengthAlong, size: t.size });
    }
  }
  return result;
}
