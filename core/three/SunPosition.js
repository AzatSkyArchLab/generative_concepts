/**
 * SunPosition — astronomical sun direction for shadow casting.
 *
 * Produces a unit vector pointing FROM the observer TOWARD the sun,
 * in the scene's coordinate convention X=East, Y=North, Z=Up. Drop
 * straight into a THREE.DirectionalLight: scale by a large distance
 * and use as `light.position`, with target at origin.
 *
 * Formulas:
 *   declination  — Cooper's equation (good to ~½° year-round)
 *   hour angle   — 15° per hour from local solar noon
 *   altitude     — sin α = sin φ sin δ + cos φ cos δ cos H
 *   azimuth      — measured from North, clockwise (compass bearing)
 *
 * Caller is responsible for converting wall-clock time to local solar
 * time (longitude correction, equation of time) — accuracy to within
 * ~15 min is plenty for shadow visualisation.
 */

var DEG = Math.PI / 180;

/**
 * @param {number} latitude   - degrees N (negative for southern hemisphere)
 * @param {number} dayOfYear  - 1..365
 * @param {number} hour       - 0..24, local solar time (decimal)
 * @returns {{ x: number, y: number, z: number, altitude: number, azimuth: number }}
 *   Unit vector + the underlying spherical coords (radians).
 */
export function computeSunVector(latitude, dayOfYear, hour) {
  var phi = latitude * DEG;
  // Solar declination — Cooper 1969.
  var declRad = 23.45 * DEG * Math.sin(2 * Math.PI * (dayOfYear - 81) / 365);
  // Hour angle: negative before noon, positive after.
  var hourAngle = (hour - 12) * 15 * DEG;

  var sinAlt = Math.sin(phi) * Math.sin(declRad)
             + Math.cos(phi) * Math.cos(declRad) * Math.cos(hourAngle);
  sinAlt = Math.max(-1, Math.min(1, sinAlt));
  var alt = Math.asin(sinAlt);

  // Azimuth from North, clockwise. Numerator can drift slightly out
  // of [-1, 1] due to fp noise — clamp before acos.
  var cosAlt = Math.cos(alt);
  var az;
  if (cosAlt < 1e-6) {
    // Sun at zenith — azimuth undefined; pick south.
    az = Math.PI;
  } else {
    var cosAz = (Math.sin(declRad) - Math.sin(phi) * sinAlt) / (Math.cos(phi) * cosAlt);
    cosAz = Math.max(-1, Math.min(1, cosAz));
    az = Math.acos(cosAz);
    if (hourAngle > 0) az = 2 * Math.PI - az;  // afternoon → west of south
  }

  // East-North-Up unit vector. Note negative altitude means sun is
  // below horizon (night) — caller can detect via z < 0.
  var x = cosAlt * Math.sin(az);
  var y = cosAlt * Math.cos(az);
  var z = sinAlt;

  return { x: x, y: y, z: z, altitude: alt, azimuth: az };
}

/**
 * Convert calendar date to day of year (1..365). Ignores leap years —
 * the sub-day error is well under shadow-rendering precision.
 *
 * @param {number} month  - 1..12
 * @param {number} day    - 1..31
 * @returns {number}
 */
export function dateToDayOfYear(month, day) {
  var monthOffsets = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  var m = Math.max(1, Math.min(12, Math.round(month)));
  var d = Math.max(1, Math.min(31, Math.round(day)));
  return monthOffsets[m - 1] + d;
}
