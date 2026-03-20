/**
 * Graph — builds section graph with configurable floor heights
 */

/**
 * Compute floor count.
 * @param {number} sectionHeight - total height in meters
 * @param {number} firstH
 * @param {number} typicalH
 * @returns {number}
 */
export function computeFloorCount(sectionHeight, firstH, typicalH) {
  if (!firstH) firstH = 4.5;
  if (!typicalH) typicalH = 3.0;
  if (sectionHeight <= firstH) return 1;
  var remaining = sectionHeight - firstH;
  var typicalFloors = Math.floor(remaining / typicalH);
  return 1 + typicalFloors + 1;
}

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
      var corrId = i + '-' + (2 * N - 1 - i);
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
      var corrId = i + '-' + (2 * N - 1 - i);
      edges.push({ from: i + ':' + floor, to: corrId + ':' + floor, type: 'corridor' });
      edges.push({ from: corrId + ':' + floor, to: (N + i) + ':' + floor, type: 'corridor' }); // fixed: was farId
    }
    // Horizontal corridors
    for (var i = 0; i < N - 1; i++) {
      var corrA = i + '-' + (2 * N - 1 - i);
      var corrB = (i + 1) + '-' + (2 * N - 2 - i);
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
