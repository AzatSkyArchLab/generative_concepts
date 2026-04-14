/**
 * vec2 — shared 2D vector helpers.
 *
 * Previously copy-pasted in UrbanBlockSolver, UrbanBlockOverlays,
 * and OverlayRenderer. Now a single source of truth.
 *
 * All functions take [x, y] arrays, return new [x, y] arrays.
 * No mutation, no side effects.
 */

export function vec(x, y) { return [x, y]; }
export function vSub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
export function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
export function vSc(v, s) { return [v[0] * s, v[1] * s]; }
export function vLen(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1]); }
export function vNorm(v) { var l = vLen(v); return l > 1e-9 ? [v[0] / l, v[1] / l] : [0, 0]; }
export function vDot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
export function vPerp(v) { return [-v[1], v[0]]; }
export function vCross(a, b) { return a[0] * b[1] - a[1] * b[0]; }
