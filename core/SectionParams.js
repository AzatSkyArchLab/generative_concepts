/**
 * SectionParams — shared defaults and floor/height computations.
 * Single source of truth for section parameters.
 */

export var DEFAULT_PARAMS = {
  sectionWidth: 18.0,
  corridorWidth: 2.0,
  cellWidth: 3.3,
  sectionHeight: 28,
  firstFloorHeight: 4.5,
  typicalFloorHeight: 3.0
};

/**
 * Compute floor count from section height.
 * @param {number} sectionHeight - total height in meters
 * @param {number} [firstH=4.5]
 * @param {number} [typicalH=3.0]
 * @returns {number}
 */
export function computeFloorCount(sectionHeight, firstH, typicalH) {
  if (!firstH) firstH = DEFAULT_PARAMS.firstFloorHeight;
  if (!typicalH) typicalH = DEFAULT_PARAMS.typicalFloorHeight;
  if (sectionHeight <= firstH) return 1;
  var remaining = sectionHeight - firstH;
  return 1 + Math.floor(remaining / typicalH) + 1;
}

/**
 * Compute building height from section height.
 * @param {number} sectionHeight
 * @param {number} [firstH=4.5]
 * @param {number} [typicalH=3.0]
 * @returns {number}
 */
export function computeBuildingHeight(sectionHeight, firstH, typicalH) {
  if (!firstH) firstH = DEFAULT_PARAMS.firstFloorHeight;
  if (!typicalH) typicalH = DEFAULT_PARAMS.typicalFloorHeight;
  var fc = computeFloorCount(sectionHeight, firstH, typicalH);
  if (fc <= 1) return firstH;
  return firstH + (fc - 1) * typicalH;
}

/**
 * Get params from feature properties with fallback to defaults.
 * @param {Object} featureProps
 * @returns {Object}
 */
export function getParams(featureProps) {
  var p = {};
  for (var k in DEFAULT_PARAMS) {
    if (DEFAULT_PARAMS.hasOwnProperty(k))
      p[k] = featureProps[k] !== undefined ? featureProps[k] : DEFAULT_PARAMS[k];
  }
  return p;
}

/**
 * Get section height for a footprint (per-section override or axis default).
 * @param {Object} fp - footprint object
 * @param {Object} axisParams - axis-level params
 * @returns {number}
 */
export function getSectionHeight(fp, axisParams) {
  if (fp.sectionHeight !== undefined) return fp.sectionHeight;
  return axisParams.sectionHeight;
}
