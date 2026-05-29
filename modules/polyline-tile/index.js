/**
 * polyline-tile module — v2 generator branch renderer (STRUCTURE-only).
 *
 * Listens to features:changed, runs the structure processor on every
 * `polyline-tile` / `polygon-tile` feature, and renders the resulting
 * tiles (outer cells, corridor cells, inner cells, wedges, remnants)
 * as MapLibre fill + line layers. Section grouping is INTENTIONALLY
 * not done here — there's no palette, no group outlines, no numbered
 * labels, no clickable start points. Free cells are colour-coded by
 * their lat/lon classification so the user can verify the structure.
 *
 * Layer stack (top to bottom of map):
 *   ptl-axis-line  — the user's drawn polyline/polygon, red dashed
 *   ptl-line-cell  — thin gray outline on every tile
 *   ptl-fill       — tile fill, coloured by type/role
 */

import { processTileFeature } from '../../core/polyline-tile/processor.js';

var SRC_TILES = 'ptl-tiles';
var SRC_AXIS = 'ptl-axis';
var SRC_VERTS = 'ptl-vertices';
var SRC_SECTIONS = 'ptl-sections';
var LAYER_FILL = 'ptl-fill';
var LAYER_LINE_CELL = 'ptl-line-cell';
var LAYER_AXIS = 'ptl-axis-line';
var LAYER_VERT_HALO = 'ptl-vert-halo';
var LAYER_VERT_DOT = 'ptl-vert-dot';
var LAYER_SECTION_FILL = 'ptl-section-fill';
var LAYER_SECTION_LINE = 'ptl-section-line';
var LAYER_SECTION_LABEL = 'ptl-section-label';

// Distinct transparent overlays cycled per section so neighbours read
// apart. Kept light so the underlying cells stay visible.
var SECTION_PALETTE = [
  'rgba(239, 68, 68, 0.18)',   // red
  'rgba(16, 185, 129, 0.18)',  // emerald
  'rgba(59, 130, 246, 0.18)',  // blue
  'rgba(217, 119, 6, 0.18)',   // amber
  'rgba(139, 92, 246, 0.18)',  // violet
  'rgba(236, 72, 153, 0.18)',  // pink
  'rgba(20, 184, 166, 0.18)',  // teal
  'rgba(132, 204, 22, 0.18)'   // lime
];

// Free-cell colour codes per type (matches prototype's --lat-fill /
// --lon-fill). Lets the user VERIFY classification visually:
// blue = lat (E-W edges), orange = lon (N-S edges).
var LAT_FREE_FILL = 'rgba(37, 99, 235, 0.22)';    // blue — широтная (E-W)
var LON_FREE_FILL = 'rgba(249, 115, 22, 0.22)';   // orange — меридиональная (N-S)
var CORRIDOR_FILL = 'rgba(115, 115, 115, 0.22)';  // corridor cells
// Distinct fills for "non-standard" tiles adjacent to corners:
// wedges = corner elements themselves, remnants = leftover strips
// between the regular grid edge and the miter cut.
var WEDGE_FILL    = 'rgba(147, 51, 234, 0.40)';   // purple — угловые элементы
var REMNANT_FILL  = 'rgba(22, 163, 74, 0.35)';    // green — нестандартные ячейки у углов
var NEUTRAL_FILL  = 'rgba(180, 180, 180, 0.28)';  // fallback
var CELL_BORDER   = 'rgba(110, 110, 110, 0.55)';
var WEDGE_BORDER  = 'rgba(147, 51, 234, 0.85)';
var REMNANT_BORDER = 'rgba(22, 163, 74, 0.85)';

var module_ = {
  id: 'polyline-tile',

  init: function (ctx) {
    var self = this;
    this._ctx = ctx;
    this._initialized = false;
    this._setupLayers();
    ctx.eventBus.on('features:changed', function () { self._refresh(); });
  },

  destroy: function () {
    var mm = this._ctx && this._ctx.mapManager;
    if (!mm) return;
    var map = mm.getMap();
    if (!map) return;
    [LAYER_SECTION_LABEL, LAYER_SECTION_LINE, LAYER_SECTION_FILL,
     LAYER_VERT_DOT, LAYER_VERT_HALO,
     LAYER_LINE_CELL, LAYER_FILL, LAYER_AXIS].forEach(function (id) {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    [SRC_TILES, SRC_AXIS, SRC_VERTS, SRC_SECTIONS].forEach(function (id) {
      if (map.getSource(id)) map.removeSource(id);
    });
  },

  // ── Layer setup ──────────────────────────────────────

  _setupLayers: function () {
    if (this._initialized) return;
    var mm = this._ctx.mapManager;
    if (!mm) { console.warn('[polyline-tile] no mapManager — skip setup'); return; }
    var map = mm.getMap();
    if (!map) { console.warn('[polyline-tile] no map — skip setup'); return; }

    var EMPTY = { type: 'FeatureCollection', features: [] };
    mm.addGeoJSONSource(SRC_AXIS,  EMPTY);
    mm.addGeoJSONSource(SRC_TILES, EMPTY);
    mm.addGeoJSONSource(SRC_VERTS, EMPTY);
    mm.addGeoJSONSource(SRC_SECTIONS, EMPTY);

    // ─── Fill: data-driven by kind/row/type ───
    // - corridor row (ANY kind — cell, wedge, remnant) → gray
    // - wedge        → purple
    // - remnant      → green
    // - outer/inner lat cell → BLUE (широтная, E-W)
    // - outer/inner lon cell → ORANGE (меридиональная, N-S)
    // The corridor-row check comes FIRST so corridor wedges and
    // remnants stay gray (otherwise they'd be tinted purple/green).
    var fillColor = [
      'case',
      ['==', ['get', 'row'],  'corridor'], CORRIDOR_FILL,
      ['==', ['get', 'kind'], 'wedge'],   WEDGE_FILL,
      ['==', ['get', 'kind'], 'remnant'], REMNANT_FILL,
      ['==', ['get', 'type'], 'lat'],     LAT_FREE_FILL,
      ['==', ['get', 'type'], 'lon'],     LON_FREE_FILL,
      NEUTRAL_FILL
    ];

    mm.addLayer({
      id: LAYER_FILL,
      type: 'fill',
      source: SRC_TILES,
      paint: { 'fill-color': fillColor, 'fill-opacity': 1 }
    });
    // Border colour follows fill colour family. Corridor-row tiles
    // share the gray cell border regardless of kind so the corridor
    // band reads as one continuous gray run, with wedge/remnant
    // accents only on outer/inner rows.
    var lineColor = [
      'case',
      ['==', ['get', 'row'],  'corridor'], CELL_BORDER,
      ['==', ['get', 'kind'], 'wedge'],   WEDGE_BORDER,
      ['==', ['get', 'kind'], 'remnant'], REMNANT_BORDER,
      CELL_BORDER
    ];
    var lineWidth = [
      'case',
      ['==', ['get', 'row'],  'corridor'], 0.7,
      ['==', ['get', 'kind'], 'wedge'],   1.2,
      ['==', ['get', 'kind'], 'remnant'], 1.2,
      0.7
    ];
    mm.addLayer({
      id: LAYER_LINE_CELL,
      type: 'line',
      source: SRC_TILES,
      paint: {
        'line-color': lineColor,
        'line-width': lineWidth,
        'line-opacity': 0.85
      }
    });
    mm.addLayer({
      id: LAYER_AXIS,
      type: 'line',
      source: SRC_AXIS,
      paint: {
        'line-color': '#ef4444', 'line-width': 1.5,
        'line-dasharray': [3, 3], 'line-opacity': 0.7
      }
    });

    // ─── Section overlays ───
    // Transparent unique-coloured fill per group (colour cycles
    // through SECTION_PALETTE by paletteIdx) + a darker outline.
    try {
      mm.addLayer({
        id: LAYER_SECTION_FILL,
        type: 'fill',
        source: SRC_SECTIONS,
        filter: ['!=', ['get', 'isLabel'], true],
        paint: {
          'fill-color': ['get', 'fillColor'],
          'fill-opacity': 1
        }
      });
      mm.addLayer({
        id: LAYER_SECTION_LINE,
        type: 'line',
        source: SRC_SECTIONS,
        filter: ['!=', ['get', 'isLabel'], true],
        paint: {
          // Dark-gray outer contour around every group. Corner sections
          // are a single L-ring, so this traces the outer perimeter
          // cleanly (no internal seams).
          'line-color': '#3a3a3a',
          'line-width': 2,
          'line-opacity': 0.95
        }
      });
    } catch (err) {
      console.warn('[polyline-tile] section overlay layers failed:', err);
    }

    // ─── Vertex diagnostic markers ───
    // One dot per polyline / polygon vertex, colour-coded by what
    // the algorithm decided this corner is. The user can verify which
    // corners are picked up for the "obtuse-convex" edge-shift.
    //   red    — obtuse-convex (the corners that get the edge-shift)
    //   yellow — acute-convex  (cells are NOT shifted here)
    //   teal   — reflex        (last cell snaps to vertex itself)
    //   gray   — open polyline end (no corner math)
    // A black ring is drawn around each shifted vertex so it really
    // pops on top of the tile colours. NB: kept LARGE (radius 14) and
    // free of any symbol/text layer to avoid the glyphs-URL pitfall
    // that silently breaks setup on some MapLibre styles.
    var vertColor = [
      'match', ['get', 'class'],
      'obtuse-convex', '#dc2626',   // red
      'acute-convex',  '#eab308',   // yellow
      'reflex',        '#0d9488',   // teal
      'end',           '#94a3b8',   // slate-gray
      '#94a3b8'
    ];
    // Inner markers (on the axis, V itself) — FILLED solid dot.
    // Outer markers (at section's outer miter, ~18 m off axis) — RING
    // (hollow with thick coloured stroke), so the user can tell at a
    // glance which point is the inside corner and which the outside.
    try {
      mm.addLayer({
        id: LAYER_VERT_HALO,
        type: 'circle',
        source: SRC_VERTS,
        paint: {
          'circle-radius': 14,
          'circle-color': vertColor,
          'circle-opacity': [
            'case', ['==', ['get', 'role'], 'outer'], 0.10, 0.30
          ],
          'circle-stroke-width': [
            'case', ['==', ['get', 'shifted'], true], 2.5, 0
          ],
          'circle-stroke-color': '#111111'
        }
      });
      mm.addLayer({
        id: LAYER_VERT_DOT,
        type: 'circle',
        source: SRC_VERTS,
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'case', ['==', ['get', 'role'], 'outer'], '#ffffff', vertColor
          ],
          'circle-stroke-color': [
            'case', ['==', ['get', 'role'], 'outer'], vertColor, '#ffffff'
          ],
          'circle-stroke-width': [
            'case', ['==', ['get', 'role'], 'outer'], 3, 2
          ],
          'circle-opacity': 1.0
        }
      });
    } catch (err) {
      console.warn('[polyline-tile] vertex marker layers failed:', err);
    }

    // ─── Section labels (type + raw area + living area) ───
    try {
      mm.addLayer({
        id: LAYER_SECTION_LABEL,
        type: 'symbol',
        source: SRC_SECTIONS,
        filter: ['==', ['get', 'isLabel'], true],
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Regular'],
          'text-size': 13,
          'text-line-height': 1.2,
          'text-anchor': 'center',
          'text-allow-overlap': true
        },
        paint: {
          'text-color': '#111111',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.8
        }
      });
    } catch (err) {
      console.warn('[polyline-tile] section label layer failed:', err);
    }

    this._initialized = true;
    console.log('[polyline-tile] layers ready (structure + sections)');
    this._refresh();
  },

  // ── Reconciliation ───────────────────────────────────

  _refresh: function () {
    if (!this._initialized) return;
    var mm = this._ctx.mapManager;
    if (!mm) return;

    var all = this._ctx.featureStore.toArray();
    var tileFeats = [];
    var axisFeats = [];
    var vertFeats = [];
    var sectionFeats = [];
    var sectionSeq = 0;  // global counter for palette cycling

    for (var i = 0; i < all.length; i++) {
      var f = all[i];
      var p = f.properties || {};
      var mode;
      if (p.type === 'polyline-tile') mode = 'polyline';
      else if (p.type === 'polygon-tile') mode = 'polygon';
      else continue;

      var coords = this._extractCoords(f, mode);
      if (!coords || coords.length < 2) continue;
      var params = p.tileParams || this._defaultParams();

      var result;
      try {
        result = processTileFeature(coords, params, mode);
      } catch (err) {
        console.error('[polyline-tile] processor failed for ' + p.id + ':', err);
        continue;
      }

      for (var t = 0; t < result.tiles.length; t++) {
        var tile = result.tiles[t];
        var ring = closeRing(tile.cornersLngLat);
        if (!ring || ring.length < 4) continue;
        tileFeats.push({
          type: 'Feature',
          properties: {
            featureId: p.id,
            kind: tile.kind,
            row: tile.row,
            type: tile.type,
            edgeIdx:   (tile.edgeIdx   == null ? -1 : tile.edgeIdx),
            cellIdx:   (tile.cellIdx   == null ? -1 : tile.cellIdx),
            vertexIdx: (tile.vertexIdx == null ? -1 : tile.vertexIdx)
          },
          geometry: { type: 'Polygon', coordinates: [ring] }
        });
      }

      axisFeats.push({
        type: 'Feature',
        properties: { featureId: p.id, mode: mode },
        geometry: mode === 'polygon'
          ? { type: 'Polygon', coordinates: f.geometry.coordinates }
          : { type: 'LineString', coordinates: f.geometry.coordinates }
      });

      // Vertex diagnostic features: TWO Points per polyline vertex.
      //   role='inner' — on the axis (V itself), the section's inner corner
      //   role='outer' — at the section's outer-perimeter miter point
      // Both share the same classification (their interior angle is the
      // same since the outer perimeter is just an offset of the axis).
      // The user asked to see BOTH so the section's corner geometry
      // is unambiguous on the map.
      if (result.vertices && result.vertices.length) {
        for (var v = 0; v < result.vertices.length; v++) {
          var vert = result.vertices[v];
          var commonProps = {
            featureId: p.id,
            idx: vert.idx,
            class: vert.class,
            shifted: !!vert.shifted,
            cos: vert.cosInterior == null ? null : Number(vert.cosInterior.toFixed(3))
          };
          vertFeats.push({
            type: 'Feature',
            properties: Object.assign({}, commonProps, { role: 'inner' }),
            geometry: { type: 'Point', coordinates: vert.lngLat }
          });
          if (vert.outerLngLat) {
            vertFeats.push({
              type: 'Feature',
              properties: Object.assign({}, commonProps, { role: 'outer' }),
              geometry: { type: 'Point', coordinates: vert.outerLngLat }
            });
          }
        }
      }

      // Section groups: transparent overlay (unique colour) + label.
      // A section may have MANY polygons (corner sections are L-shaped =
      // edge0 run + corner element polys + edge1 run). All polys of one
      // section share its colour; a single label sits at the centroid.
      if (result.sections && result.sections.length) {
        for (var s = 0; s < result.sections.length; s++) {
          var sec = result.sections[s];
          var pi = sectionSeq % SECTION_PALETTE.length;
          var fillC = SECTION_PALETTE[pi];
          var lineC = fillC.replace(/0\.18\)$/, '0.9)');  // opaque outline
          // Type letter: straight lat→Ш, lon→М; corner sections carry
          // the corner-type string (e.g. 'Ш-М') directly.
          var typeLabel = (sec.type === 'lon') ? 'М'
            : (sec.type === 'lat') ? 'Ш' : sec.type;
          var label = typeLabel + '\n' +
            Math.round(sec.areaRaw) + ' м²\n' +
            Math.round(sec.areaLiving) + ' м² (·0.65)';
          var polys = sec.polygonsLngLat || [];
          for (var pg = 0; pg < polys.length; pg++) {
            var ring = closeRing(polys[pg]);
            if (!ring || ring.length < 4) continue;
            sectionFeats.push({
              type: 'Feature',
              properties: {
                featureId: p.id,
                sectionType: sec.type,
                isCorner: !!sec.isCorner,
                tripleCount: sec.tripleCount,
                areaRaw: Math.round(sec.areaRaw),
                areaLiving: Math.round(sec.areaLiving),
                fillColor: fillC,
                lineColor: lineC,
                label: label
              },
              geometry: { type: 'Polygon', coordinates: [ring] }
            });
          }
          // One label point at the section centroid.
          sectionFeats.push({
            type: 'Feature',
            properties: {
              featureId: p.id,
              isLabel: true,
              fillColor: 'rgba(0,0,0,0)',
              lineColor: 'rgba(0,0,0,0)',
              label: label
            },
            geometry: { type: 'Point', coordinates: sec.centroidLngLat }
          });
          sectionSeq++;
        }
      }
    }

    mm.updateGeoJSONSource(SRC_TILES, { type: 'FeatureCollection', features: tileFeats });
    mm.updateGeoJSONSource(SRC_AXIS,  { type: 'FeatureCollection', features: axisFeats });
    mm.updateGeoJSONSource(SRC_VERTS, { type: 'FeatureCollection', features: vertFeats });
    mm.updateGeoJSONSource(SRC_SECTIONS, { type: 'FeatureCollection', features: sectionFeats });
    console.log('[polyline-tile] refresh —',
      tileFeats.length, 'tiles,',
      axisFeats.length, 'axes,',
      vertFeats.length, 'vertex markers,',
      sectionFeats.length, 'section features');
  },

  _extractCoords: function (feat, mode) {
    var g = feat.geometry;
    if (!g) return null;
    if (mode === 'polyline' && g.type === 'LineString') return g.coordinates;
    if (mode === 'polygon' && g.type === 'Polygon') {
      var ring = g.coordinates && g.coordinates[0];
      return ring || null;
    }
    return null;
  },

  _defaultParams: function () {
    return {
      step: 3.3, depth: 8.0, buffer: 2.0, rows: 3, side: 'left',
      cornerR: 20.0
    };
  }
};

// ── Helpers ──────────────────────────────────────────────

// Make sure a ring is closed (first === last). MapLibre's fill renderer
// is forgiving but explicit closure avoids edge-case bugs.
function closeRing(corners) {
  if (!corners || corners.length < 3) return null;
  var out = corners.slice();
  var f = out[0], l = out[out.length - 1];
  if (Math.abs(f[0] - l[0]) > 1e-9 || Math.abs(f[1] - l[1]) > 1e-9) {
    out.push([f[0], f[1]]);
  }
  return out;
}

export default module_;
