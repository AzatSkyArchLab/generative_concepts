/**
 * Orientation — classify line segments as latitudinal or meridional
 *
 * Uses dot product with north vector [0, 1].
 * Y axis = north in meter space.
 *
 * latitudinal (шир) = runs east-west, dot < 0.7
 * meridional (мерид) = runs north-south, dot >= 0.7
 */

/**
 * Classify a single segment by its orientation.
 *
 * @param {[number, number]} startM - start point in meters
 * @param {[number, number]} endM - end point in meters
 * @returns {{ orientation: number, dotProduct: number, orientationName: string }}
 *   orientation: 0 = latitudinal, 1 = meridional
 */
export function classifySegment(startM, endM) {
  var dx = endM[0] - startM[0];
  var dy = endM[1] - startM[1];
  var len = Math.sqrt(dx * dx + dy * dy);

  if (len < 1e-6) {
    return { orientation: 0, dotProduct: 0, orientationName: 'lat' };
  }

  // Normalized direction
  var dirX = dx / len;
  var dirY = dy / len;

  // Dot product with north [0, 1]
  var dot = Math.abs(dirY);

  if (dot >= 0.7) {
    return { orientation: 1, dotProduct: dot, orientationName: 'lon' };
  }
  return { orientation: 0, dotProduct: dot, orientationName: 'lat' };
}

/**
 * Classify a polyline (may have multiple segments).
 * Uses overall direction from first to last point.
 *
 * @param {Array<[number, number]>} coordsM - coordinates in meters
 * @returns {{ orientation: number, dotProduct: number, orientationName: string }}
 */
export function classifyPolyline(coordsM) {
  if (coordsM.length < 2) {
    return { orientation: 0, dotProduct: 0, orientationName: 'lat' };
  }
  var first = coordsM[0];
  var last = coordsM[coordsM.length - 1];
  return classifySegment(first, last);
}
