/**
 * CellTopology — near↔far cell ID mapping.
 *
 * Convention: a section has N cells per facade.
 *   near cells: 0 .. N-1
 *   far cells:  N .. 2N-1
 *
 * The mirror mapping is: farCid = 2N - 1 - nearCid.
 * This was previously hardcoded in 14+ places.
 *
 * Pure math, no dependencies.
 */

/**
 * Near cell index → mirrored far cell index.
 * @param {number} nearCid - near cell id (0 .. N-1)
 * @param {number} N - cells per side
 * @returns {number} far cell id (N .. 2N-1)
 */
export function nearToFar(nearCid, N) {
  return 2 * N - 1 - nearCid;
}

/**
 * Far cell index → mirrored near cell index.
 * @param {number} farCid - far cell id (N .. 2N-1)
 * @param {number} N - cells per side
 * @returns {number} near cell id (0 .. N-1)
 */
export function farToNear(farCid, N) {
  return 2 * N - 1 - farCid;
}

/**
 * Build corridor label string from near cell position.
 * @param {number} nearCid
 * @param {number} N
 * @returns {string} e.g. '3-18'
 */
export function corridorLabel(nearCid, N) {
  return nearCid + '-' + nearToFar(nearCid, N);
}

/**
 * Check if a cell id is on the near side.
 * @param {number} cid
 * @param {number} N
 * @returns {boolean}
 */
export function isNearCell(cid, N) {
  return cid >= 0 && cid < N;
}

/**
 * Check if a cell id is on the far side.
 * @param {number} cid
 * @param {number} N
 * @returns {boolean}
 */
export function isFarCell(cid, N) {
  return cid >= N && cid < 2 * N;
}
