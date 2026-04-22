/**
 * Per-layer render configuration for the MetaTiler module.
 *
 * Most remote layers use the default generic render path (fill/line/
 * circle by geometry type, uniform violet colour). This file
 * declares overrides for specific layer ids that need something
 * richer — currently layer 104 (buildings), extruded and lazy-
 * loaded around a buffer zone drawn from the user's FeatureStore.
 *
 * Supported shapes:
 *   { type: 'default' }                 — plain fill/line/circle
 *   { type: 'buildings', ... }          — flat footprint + 3D
 *                                         extrusion with per-category
 *                                         heights/colours and buffer-
 *                                         gated rendering
 *
 * All attribute names live in this file — the module never hard-
 * codes field names. Swap the field names here if a different layer
 * uses a different schema.
 */

export var LAYER_CONFIG = {
  '104': {
    type: 'buildings',

    // Layer 104 (~480k features) is a mix of buildings, land plots,
    // structures and unfinished construction. We render only the
    // actual buildings — OBJ_TYPE == 'Здание'.
    baseFilter: ['==', ['get', 'OBJ_TYPE'], 'Здание'],

    // Binary split by the TYPE attribute. TYPE is ~45% null (rough
    // 55/45 filled/null), so the "other" bucket naturally absorbs
    // null values and everything that isn't explicitly residential.
    category: {
      field: 'TYPE',
      residentialValue: 'Жилой фонд'
    },

    // Floor-based height model. Residential: taller ground floor
    // (retail/lobby) + 3m upper floors. Non-residential: uniform 4m
    // per floor.
    //
    // FLOOR is ~54% null. Buildings without a floor count fall back
    // to defaultFloors = 1, yielding a 4m box in either branch.
    height: {
      field: 'FLOOR',
      residential: { groundFloor: 4, upperFloor: 3 },
      other:       { anyFloor: 4 },
      defaultFloors: 1
    },

    colors: {
      residential: {
        fill:      '#3b82f6',             // blue-500 extrusion body
        footprint: 'rgba(59,130,246,0.25)',
        outline:   '#1e40af'              // blue-800 footprint edge
      },
      other: {
        fill:      '#94a3b8',             // slate-400 extrusion body
        footprint: 'rgba(148,163,184,0.22)',
        outline:   '#475569'
      }
    },

    // Lazy loading: 3D extrusion visible only inside a buffer around
    // primary user-drawn features (axes / urban-blocks / polygons /
    // lines). Flat footprints are always on.
    //
    //   outerMeters — outer buffer = union of circles centred at the
    //                 CENTROID of each feature. 3D renders here.
    //   innerMeters — inner keep-out = union of Minkowski buffers
    //                 around polygon BOUNDARIES. 3D is suppressed
    //                 here (simulates "my site — no foreign bldgs").
    //                 Lines have no inner zone.
    //
    // Set enabled=false to always extrude the whole viewport.
    lazyLoad: {
      enabled: true,
      outerMeters: 300,
      innerMeters: 40
    },

    // Minimum zoom for extrusion — below this an extruded city looks
    // noisy and performance tanks. Footprints stay visible.
    extrusionMinZoom: 14
  }
};

export function getLayerConfig(layerId) {
  var cfg = LAYER_CONFIG[String(layerId)];
  if (cfg) return cfg;
  return { type: 'default' };
}
