/**
 * Graph — builds section graph with configurable floor heights
 */

export { computeFloorCount } from '../../core/SectionParams.js';
import { corridorLabel as makeCorrLabel } from '../../core/apartments/CellTopology.js';

export function computeZOffset(floor, firstH, typicalH) {
  if (floor === 0) return 0;
  return firstH + (floor - 1) * typicalH;
}

/**
 * Build section graph.
 */
export function buildSectionGraph(N, nearCells, farCells, corridorCells,
                                   northSide, lluIndices, lluTag, floorCount) {
  var nodes = {};
  var edges = [];

  var lluSet = {};
  for (var li = 0; li < lluIndices.length; li++) {
    lluSet[lluIndices[li]] = true;
  }

  for (var floor = 0; floor < floorCount; floor++) {
    var isFirstFloor = (floor === 0);

    for (var i = 0; i < N; i++) {
      var isLLU = (northSide === 'near' && lluSet[i] === true);
      var cellType;
      if (isLLU) cellType = 'llu';
      else if (isFirstFloor) cellType = 'commercial';
      else cellType = 'apartment';

      nodes[i + ':' + floor] = {
        cellId: i, floor: floor, type: cellType, side: 'near',
        polygon: nearCells[i], lluTag: isLLU ? lluTag : null,
        label: i + '.' + floor
      };
    }

    for (var i = 0; i < N; i++) {
      var farId = N + i;
      var isLLU = (northSide === 'far' && lluSet[i] === true);
      var cellType;
      if (isLLU) cellType = 'llu';
      else if (isFirstFloor) cellType = 'commercial';
      else cellType = 'apartment';

      nodes[farId + ':' + floor] = {
        cellId: farId, floor: floor, type: cellType, side: 'far',
        polygon: farCells[i], lluTag: isLLU ? lluTag : null,
        label: farId + '.' + floor
      };
    }

    for (var i = 0; i < N; i++) {
      var corrId = makeCorrLabel(i, N);
      nodes[corrId + ':' + floor] = {
        cellId: corrId, floor: floor, type: 'corridor', side: 'center',
        polygon: corridorCells[i], lluTag: null,
        label: corrId + '.' + floor
      };
    }

    // Horizontal near
    for (var i = 0; i < N - 1; i++) {
      edges.push({ from: i + ':' + floor, to: (i + 1) + ':' + floor, type: 'horizontal' });
    }
    // Horizontal far
    for (var i = 0; i < N - 1; i++) {
      edges.push({ from: (N + i) + ':' + floor, to: (N + i + 1) + ':' + floor, type: 'horizontal' });
    }
    // Corridor links
    for (var i = 0; i < N; i++) {
      var corrId = makeCorrLabel(i, N);
      edges.push({ from: i + ':' + floor, to: corrId + ':' + floor, type: 'corridor' });
      edges.push({ from: corrId + ':' + floor, to: (N + i) + ':' + floor, type: 'corridor' }); // fixed: was farId
    }
    // Horizontal corridors
    for (var i = 0; i < N - 1; i++) {
      var corrA = makeCorrLabel(i, N);
      var corrB = makeCorrLabel(i + 1, N);
      edges.push({ from: corrA + ':' + floor, to: corrB + ':' + floor, type: 'horizontal' });
    }
  }

  // Vertical
  for (var floor = 0; floor < floorCount - 1; floor++) {
    for (var key in nodes) {
      if (!nodes.hasOwnProperty(key)) continue;
      if (nodes[key].floor !== floor) continue;
      var upper = nodes[key].cellId + ':' + (floor + 1);
      if (nodes[upper]) {
        edges.push({ from: key, to: upper, type: 'vertical' });
      }
    }
  }

  return { nodes: nodes, edges: edges };
}
