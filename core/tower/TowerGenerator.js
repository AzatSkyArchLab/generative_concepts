/**
 * TowerGenerator — builds a rectangular cell grid for a tower footprint.
 *
 * Three standard sizes (colsAcross × rowsAlong):
 *   small:  7 × 7   (square, used for latitudinal axes)
 *   medium: 7 × 9
 *   large:  7 × 12
 *
 * Cell layout:
 *   - Perimeter (2 cells deep): apartment cells
 *   - Interior core: LLU cells
 *   - LLU exit: 2 cells punching from core to perimeter
 *     on the north-facing short side
 *
 * Cell indexing: row-major, id = row * cols + col
 * Row 0 = start-of-axis end, row N-1 = end-of-axis end.
 *
 * Pure math — no rendering, no map dependencies.
 */

var TOWER_SIZES = {
  small:  { rows: 7,  cols: 7 },
  medium: { rows: 9,  cols: 7 },
  large:  { rows: 12, cols: 7 }
};

var PERIMETER_DEPTH = 2;
var DEFAULT_CELL_SIZE = 3.3;

// ── Size Selection ───────────────────────────────────

/**
 * Choose tower size based on axis orientation and available length.
 *
 * Rules:
 * - Latitudinal axis → always small (square)
 * - Meridional axis → largest that fits (long side along axis)
 * - If only small fits regardless of orientation → small
 *
 * @param {string} orientation - 'lat' or 'lon'
 * @param {number} availableLength - meters available along axis for one tower
 * @param {number} cellSize - cell edge in meters (default 3.3)
 * @returns {string} 'small' | 'medium' | 'large'
 */
export function chooseTowerSize(orientation, availableLength, cellSize) {
  if (!cellSize) cellSize = DEFAULT_CELL_SIZE;

  if (orientation === 'lat') return 'small';

  // Meridional: try largest first
  var largeDim = TOWER_SIZES.large.rows * cellSize;
  if (availableLength >= largeDim) return 'large';

  var medDim = TOWER_SIZES.medium.rows * cellSize;
  if (availableLength >= medDim) return 'medium';

  return 'small';
}

/**
 * Get physical dimensions of a tower.
 *
 * @param {string} size - 'small' | 'medium' | 'large'
 * @param {number} [cellSize]
 * @returns {{ widthAcross: number, lengthAlong: number, rows: number, cols: number }}
 */
export function getTowerDimensions(size, cellSize) {
  if (!cellSize) cellSize = DEFAULT_CELL_SIZE;
  var s = TOWER_SIZES[size] || TOWER_SIZES.small;
  return {
    widthAcross: s.cols * cellSize,
    lengthAlong: s.rows * cellSize,
    rows: s.rows,
    cols: s.cols,
    cellSize: cellSize
  };
}

// ── Grid Generation ──────────────────────────────────

/**
 * Classify each cell in the grid.
 *
 * @param {number} rows
 * @param {number} cols
 * @param {string} exitSide - where LLU exit punches through perimeter:
 *   'row-start' = row 0 end (north end for merid, axis-start)
 *   'row-end'   = row N-1 end (north end for merid, axis-end)
 *   'col-low'   = column 0 side (north for lat, left-of-axis)
 *   'col-high'  = column N-1 side (north for lat, right-of-axis)
 * @returns {Array<Object>} cells [{id, row, col, type}]
 *   type: 'apartment' | 'llu' | 'llu-exit'
 */
export function classifyCells(rows, cols, exitSide) {
  if (!exitSide) exitSide = 'row-start';

  var cells = [];

  // Pass 1: mark perimeter vs interior
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      var id = r * cols + c;
      var isPerimeter = (
        r < PERIMETER_DEPTH || r >= rows - PERIMETER_DEPTH ||
        c < PERIMETER_DEPTH || c >= cols - PERIMETER_DEPTH
      );
      if (isPerimeter) {
        cells.push({ id: id, row: r, col: c, type: 'apartment' });
      } else {
        cells.push({ id: id, row: r, col: c, type: 'llu' });
      }
    }
  }

  // Pass 2: LLU exit — punch through perimeter toward north
  if (exitSide === 'row-start') {
    var exitCol = Math.floor(cols / 2);
    for (var er = PERIMETER_DEPTH - 1; er >= 0; er--) {
      cells[er * cols + exitCol].type = 'llu-exit';
    }
  } else if (exitSide === 'row-end') {
    var exitCol = Math.floor(cols / 2);
    for (var er = rows - PERIMETER_DEPTH; er < rows; er++) {
      cells[er * cols + exitCol].type = 'llu-exit';
    }
  } else if (exitSide === 'col-low') {
    // Exit through column 0 side, at center row
    var exitRow = Math.floor(rows / 2);
    for (var ec = PERIMETER_DEPTH - 1; ec >= 0; ec--) {
      cells[exitRow * cols + ec].type = 'llu-exit';
    }
  } else if (exitSide === 'col-high') {
    // Exit through column N-1 side, at center row
    var exitRow = Math.floor(rows / 2);
    for (var ec = cols - PERIMETER_DEPTH; ec < cols; ec++) {
      cells[exitRow * cols + ec].type = 'llu-exit';
    }
  }

  return cells;
}

// ── Polygon Generation ───────────────────────────────

/**
 * Generate cell polygons in local meter space.
 * Origin (0,0) = bottom-left corner of tower.
 * X = across (cols), Y = along axis (rows).
 *
 * WINDING: CW (matches section cells for correct insetPoly behavior).
 *
 * @param {number} rows
 * @param {number} cols
 * @param {number} cellSize
 * @returns {Array<Array<[number,number]>>} polygons[cellId] = 4 corners CW
 */
export function generateLocalPolygons(rows, cols, cellSize) {
  var polys = [];
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      var x0 = c * cellSize;
      var y0 = r * cellSize;
      var x1 = (c + 1) * cellSize;
      var y1 = (r + 1) * cellSize;
      // CW winding: BL → BR → TR → TL (matches section cell convention)
      polys.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    }
  }
  return polys;
}

/**
 * Generate tower cell polygons directly from a footprint polygon.
 * No separate rotation/translation step — cells are placed within
 * the parallelogram defined by the 4 footprint corners.
 *
 * Footprint polygon convention (from TowerTool):
 *   [0] = axis-start near edge
 *   [1] = axis-end near edge
 *   [2] = axis-end far edge
 *   [3] = axis-start far edge
 *
 * Along axis: [0]→[1] (rows direction)
 * Across:     [0]→[3] (cols direction)
 *
 * @param {Array<[number,number]>} fpPoly - 4 corners in meters
 * @param {number} rows
 * @param {number} cols
 * @returns {Array<Array<[number,number]>>} polygons[cellId] CW winding
 */
export function generateCellsFromFootprint(fpPoly, rows, cols) {
  var p0 = fpPoly[0]; // axis-start, near
  var p1 = fpPoly[1]; // axis-end, near
  var p3 = fpPoly[3]; // axis-start, far

  // Unit vectors along axis and across
  var axDx = (p1[0] - p0[0]) / rows;
  var axDy = (p1[1] - p0[1]) / rows;
  var acDx = (p3[0] - p0[0]) / cols;
  var acDy = (p3[1] - p0[1]) / cols;

  var polys = [];
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      // 4 corners of cell (r, c) — CW winding
      var bx = p0[0] + r * axDx + c * acDx;
      var by = p0[1] + r * axDy + c * acDy;
      var bl = [bx, by];
      var tl = [bx + axDx, by + axDy];
      var tr = [bx + axDx + acDx, by + axDy + acDy];
      var br = [bx + acDx, by + acDy];
      // CW winding: BL → BR → TR → TL (matches section cell convention)
      polys.push([bl, br, tr, tl]);
    }
  }
  return polys;
}

/**
 * Transform local polygons to world meter coordinates.
 *
 * @param {Array} localPolys - from generateLocalPolygons
 * @param {number} originX - tower center X in world meters
 * @param {number} originY - tower center Y in world meters
 * @param {number} angle - rotation angle in radians (0 = axis along Y)
 * @param {number} widthAcross - tower width
 * @param {number} lengthAlong - tower length along axis
 * @returns {Array<Array<[number,number]>>} world-space polygons
 */
export function transformToWorld(localPolys, originX, originY, angle, widthAcross, lengthAlong) {
  var cosA = Math.cos(angle);
  var sinA = Math.sin(angle);
  // Center offset: local origin is at (0,0), shift to center
  var cx = widthAcross / 2;
  var cy = lengthAlong / 2;

  var result = [];
  for (var pi = 0; pi < localPolys.length; pi++) {
    var poly = localPolys[pi];
    var worldPoly = [];
    for (var vi = 0; vi < poly.length; vi++) {
      // Shift to center
      var lx = poly[vi][0] - cx;
      var ly = poly[vi][1] - cy;
      // Rotate
      var wx = lx * cosA - ly * sinA + originX;
      var wy = lx * sinA + ly * cosA + originY;
      worldPoly.push([wx, wy]);
    }
    result.push(worldPoly);
  }
  return result;
}

/**
 * Full tower generation pipeline.
 *
 * @param {Object} params
 * @param {string} params.size - 'small' | 'medium' | 'large'
 * @param {number} [params.cellSize=3.3]
 * @param {string} [params.northEnd='start'] - which end faces north
 * @param {number} params.centerX - world X of tower center
 * @param {number} params.centerY - world Y of tower center
 * @param {number} params.angle - rotation angle in radians
 * @returns {Object} { cells, worldPolygons, dims, towerBBox }
 */
export function generateTower(params) {
  var cellSize = params.cellSize || DEFAULT_CELL_SIZE;
  var dims = getTowerDimensions(params.size, cellSize);
  var cells = classifyCells(dims.rows, dims.cols, params.exitSide || 'row-start');
  var localPolys = generateLocalPolygons(dims.rows, dims.cols, cellSize);
  var worldPolys = transformToWorld(
    localPolys, params.centerX, params.centerY,
    params.angle, dims.widthAcross, dims.lengthAlong
  );

  // BBox in world coords
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var pi = 0; pi < worldPolys.length; pi++) {
    for (var vi = 0; vi < worldPolys[pi].length; vi++) {
      var x = worldPolys[pi][vi][0];
      var y = worldPolys[pi][vi][1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  return {
    cells: cells,
    worldPolygons: worldPolys,
    dims: dims,
    towerBBox: { minX: minX, minY: minY, maxX: maxX, maxY: maxY }
  };
}

export { TOWER_SIZES, PERIMETER_DEPTH, DEFAULT_CELL_SIZE };
