/**
 * Validation — apartment insolation validation per SanPiN.
 *
 * Extracted from ApartmentSolver.js. No dependencies.
 */

/**
 * Validate apartment insolation per SanPiN.
 * @param {Array<string>} livingFlags - 'p'/'w'/'f' per living cell
 * @returns {{ valid: boolean, type: string }}
 */
export function validateApartment(livingFlags) {
  var n = livingFlags.length;
  if (n === 0) return { valid: false, type: '?' };

  var p = 0, w = 0;
  for (var i = 0; i < n; i++) {
    if (livingFlags[i] === 'p') p++;
    else if (livingFlags[i] === 'w') w++;
  }

  var typeNames = { 1: '1K', 2: '2K', 3: '3K', 4: '4K', 5: '5K' };
  var aptType = typeNames[n] || (n + 'K');

  var requiredP = n <= 3 ? 1 : (n <= 5 ? 2 : 3);

  if (p >= requiredP) return { valid: true, type: aptType };

  // Compensation: 2w per missing p
  var deficit = requiredP - p;
  if (w >= deficit * 2) return { valid: true, type: aptType };

  return { valid: false, type: aptType };
}

export function getFlag(insolMap, cid) {
  if (insolMap && insolMap[cid] !== undefined) return insolMap[cid];
  return 'p';
}
