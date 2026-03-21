/**
 * Projection — local tangent plane projection (equirectangular)
 *
 * Converts lng/lat ↔ meters relative to a centroid.
 * Accurate for urban-scale areas (< 5km).
 */

var DEG2RAD = Math.PI / 180;
var RAD2DEG = 180 / Math.PI;

/**
 * Create a projector centered at the given lng/lat.
 * All meter coordinates are relative to this origin.
 *
 * @param {number} originLng
 * @param {number} originLat
 * @returns {{ toMeters(lng, lat), toLngLat(mx, my), originLng, originLat }}
 */
export function createProjection(originLng, originLat) {
  var cosLat = Math.cos(originLat * DEG2RAD);
  // Meters per degree at this latitude
  var mPerDegLng = 111320 * cosLat;
  var mPerDegLat = 110540;

  return {
    originLng: originLng,
    originLat: originLat,

    /**
     * @param {number} lng
     * @param {number} lat
     * @returns {[number, number]} [mx, my] in meters
     */
    toMeters: function (lng, lat) {
      var mx = (lng - originLng) * mPerDegLng;
      var my = (lat - originLat) * mPerDegLat;
      return [mx, my];
    },

    /**
     * @param {number} mx
     * @param {number} my
     * @returns {[number, number]} [lng, lat]
     */
    toLngLat: function (mx, my) {
      var lng = originLng + mx / mPerDegLng;
      var lat = originLat + my / mPerDegLat;
      return [lng, lat];
    },

    /**
     * Convert array of [lng, lat] to array of [mx, my]
     * @param {Array<[number, number]>} coords
     * @returns {Array<[number, number]>}
     */
    coordsToMeters: function (coords) {
      var result = [];
      for (var i = 0; i < coords.length; i++) {
        result.push(this.toMeters(coords[i][0], coords[i][1]));
      }
      return result;
    },

    /**
     * Convert array of [mx, my] to array of [lng, lat]
     * @param {Array<[number, number]>} meters
     * @returns {Array<[number, number]>}
     */
    metersToCoords: function (meters) {
      var result = [];
      for (var i = 0; i < meters.length; i++) {
        result.push(this.toLngLat(meters[i][0], meters[i][1]));
      }
      return result;
    }
  };
}

/**
 * Compute centroid of a coordinate ring [lng, lat]
 * @param {Array<[number, number]>} coords
 * @returns {[number, number]}
 */
export function centroid(coords) {
  var sumLng = 0;
  var sumLat = 0;
  var n = coords.length;
  // Skip closing point if ring is closed
  if (n > 1 && coords[0][0] === coords[n - 1][0] && coords[0][1] === coords[n - 1][1]) {
    n = n - 1;
  }
  for (var i = 0; i < n; i++) {
    sumLng += coords[i][0];
    sumLat += coords[i][1];
  }
  return [sumLng / n, sumLat / n];
}
