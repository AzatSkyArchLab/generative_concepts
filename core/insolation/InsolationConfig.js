/**
 * InsolationConfig — structural constants for insolation analysis.
 *
 * These were previously hardcoded as `var` in modules/insolation/index.js.
 * They depend on the building's constructive system (monolith/panel/brick)
 * and normative requirements. Centralizing them here enables future
 * per-project configuration via UI or config file.
 */

export var INSOL_CONFIG = {
  /** Default latitude for sun vectors (degrees N) */
  latitude: 55,

  /** GOST R 57795-2017 normative requirement (minutes) */
  normativeMinutes: 120,

  /** Offset from facade face inward (meters, negative = inward) */
  facadeOffset: -0.4,

  /** Dot marker radius for visualization (meters) */
  pointRadius: 0.6,

  /** Maximum ray travel distance (meters) */
  maxRayDistance: 500,

  /** Free ray visualization length (meters) */
  rayFreeLength: 80,

  // ── Constructive parameters ──────────────────────────

  /** External wall thickness (meters) */
  extWallThickness: 0.6,

  /** Window opening width (meters) */
  windowWidth: 1.8,

  /** Window opening height (meters) */
  windowHeight: 1.5,

  /** Window sill height above floor slab (meters) */
  windowSillHeight: 1.2,

  /** Floor slab thickness (meters) */
  slabThickness: 0.3,

  /** LLU shaft extension above roof (meters) */
  lluAboveRoof: 2.5
};
