/**
 * Section-Gen State — centralized mutable state.
 *
 * Replaces 20+ module-level `var` declarations.
 * Single import, easy to reset in destroy().
 */

export var state = {
  layer: null,
  threeOverlay: null,
  eventBus: null,
  featureStore: null,
  mapManager: null,
  commandManager: null,

  unsubs: [],
  lineFootprints: {},
  highlightedIds: [],
  clickWired: false,
  editAxisId: null,
  editSelectedIndices: [],
  keyHandler: null,
  mapHandlers: [],
  insolCellMap: null,
  stableOrigin: null,   // fixed projection origin — set once, never shifts
  distributed: false,    // true after "Distribute apartments" button
  aptMix: { '1K': 40, '2K': 30, '3K': 20, '4K': 10 },
  buildingPlans: {},     // { lineId_fi: buildingPlanResult }
  graphDataMap: {},      // { lineId_fi: { nodes, N, params, floorCount } }
  sectionMixes: null,     // { lineId_fi: adjustedMix } — computed by QuotaAllocator
  undergroundGroup: null,
  undergroundVisible: true
};

/**
 * Reset all state to initial values. Called from destroy().
 */
export function resetState() {
  state.layer = null;
  state.threeOverlay = null;
  state.eventBus = null;
  state.featureStore = null;
  state.mapManager = null;
  state.commandManager = null;

  state.unsubs = [];
  state.lineFootprints = {};
  state.highlightedIds = [];
  state.clickWired = false;
  state.editAxisId = null;
  state.editSelectedIndices = [];
  state.keyHandler = null;
  state.mapHandlers = [];
  state.insolCellMap = null;
  state.stableOrigin = null;
  state.distributed = false;
  state.aptMix = { '1K': 40, '2K': 30, '3K': 20, '4K': 10 };
  state.buildingPlans = {};
  state.graphDataMap = {};
  state.sectionMixes = null;
  state.undergroundGroup = null;
  state.undergroundVisible = true;
}
