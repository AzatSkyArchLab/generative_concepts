/**
 * InsolHelpers — insolation map construction for section-gen.
 */

import { state } from './state.js';

var _FLAG_PRIO = { 'f': 1, 'w': 2, 'p': 3 };

/**
 * Convert raw insolation points to graph-cell-ID → flag map.
 * Best flag wins when a cell has multiple points (e.g. torec end cells).
 * @param {Array} pts - raw insolation points
 * @param {number} N - cells per side
 * @param {Object} [graphNodes] - if provided, LLU cells are excluded
 * @param {number} [floor] - floor to check in graph (default 1)
 */
export function pointsToInsolMap(pts, N, graphNodes, floor) {
  if (!pts || pts.length === 0) return null;
  if (!floor) floor = 1;

  // Build LLU exclusion set from actual graph
  var lluSet = {};
  if (graphNodes) {
    for (var key in graphNodes) {
      if (!graphNodes.hasOwnProperty(key)) continue;
      var node = graphNodes[key];
      if (node.floor === floor && node.type === 'llu') {
        lluSet[node.cellId] = true;
      }
    }
  }

  var map = {};
  for (var i = 0; i < pts.length; i++) {
    var pt = pts[i];
    var graphCid = pt.side === 'near' ? pt.cellIdx : N + pt.cellIdx;
    // Skip LLU cells
    if (lluSet[graphCid]) continue;
    var oldFlag = map[graphCid];
    if (oldFlag === undefined || _FLAG_PRIO[pt.flag] > _FLAG_PRIO[oldFlag]) {
      map[graphCid] = pt.flag;
    }
  }
  return map;
}

export function buildInsolMap(lineId, secIdx, floorNum, N, graphNodes) {
  if (!state.insolCellMap || !state.insolCellMap[lineId] || !state.insolCellMap[lineId][secIdx]) return null;
  var secData = state.insolCellMap[lineId][secIdx];
  if (!secData[floorNum]) return null;
  return pointsToInsolMap(secData[floorNum].points, N, graphNodes, floorNum);
}

export function buildPerFloorInsol(lineId, secIdx, N, maxFloor, graphNodes) {
  var result = {};
  for (var fl = 1; fl <= maxFloor; fl++) {
    var map = buildInsolMap(lineId, secIdx, fl, N, graphNodes);
    if (map) result[fl] = map;
  }
  return result;
}
