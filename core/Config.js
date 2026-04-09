/**
 * Application configuration
 */

export const Config = {
  map: {
    center: [37.618, 55.751],   // Moscow
    zoom: 15,
    minZoom: 2,
    maxZoom: 20,
    pitch: 45,
    bearing: 0,
    style: {
      backgroundColor: '#ffffff'
    }
  },

  basemaps: {
    osm: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
    esriSatellite: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
  },

  cursors: {
    default: 'default',
    pointer: 'pointer',
    crosshair: 'crosshair',
    grab: 'grab',
    grabbing: 'grabbing'
  },

  solver: {
    /** QuotaResolver: search radius around continuous optimum (O(1) mode) */
    quotaSearchRadius: 4,
    /** QuotaResolver: brute-force threshold (C ≤ limit → exhaustive) */
    quotaBruteForceLimit: 300,
    /** Global downsize / regroup iteration caps */
    maxRegroupIter: 30,
    maxDownsizeIter: 20,
    /** MergePlanner dynamic rebalance iteration cap */
    maxRebalanceIter: 30,
    /** FloorPlanner segment-level downsize cap */
    maxSegmentDownsizeIter: 20
  },

  draw: {
    fillColor: '#3b82f6',
    fillOpacity: 0.25,
    lineColor: '#3b82f6',
    lineWidth: 2,
    selectedColor: '#f59e0b',
    selectedWidth: 3,
    hitboxWidth: 15,
    previewOpacity: 0.15,
    vertexRadius: 5,
    vertexColor: '#ffffff',
    vertexStrokeColor: '#3b82f6',
    vertexStrokeWidth: 2
  }
};
