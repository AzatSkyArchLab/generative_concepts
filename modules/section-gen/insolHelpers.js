/**
 * InsolHelpers — insolation map construction for section-gen.
 */

import { state } from './state.js';

var _FLAG_PRIO = { 'f': 1, 'w': 2, 'p': 3 };

export function pointsToInsolMap(pts, N) {
  if (!pts || pts.length === 0) return null;
  var map = {};
  for (var i = 0; i < pts.length; i++) {
    var pt = pts[i];
    var graphCid = pt.side === 'near' ? pt.cellIdx : N + pt.cellIdx;
    var oldFlag = map[graphCid];
    if (oldFlag === undefined || _FLAG_PRIO[pt.flag] > _FLAG_PRIO[oldFlag]) {
      map[graphCid] = pt.flag;
    }
  }
  return map;
}

export function buildInsolMap(lineId, secIdx, floorNum, N) {
  if (!state.insolCellMap || !state.insolCellMap[lineId] || !state.insolCellMap[lineId][secIdx]) return null;
  var secData = state.insolCellMap[lineId][secIdx];
  if (!secData[floorNum]) return null;
  return pointsToInsolMap(secData[floorNum].points, N);
}

export function buildPerFloorInsol(lineId, secIdx, N, maxFloor) {
  var result = {};
  for (var fl = 1; fl <= maxFloor; fl++) {
    var map = buildInsolMap(lineId, secIdx, fl, N);
    if (map) result[fl] = map;
  }
  return result;
}
