/**
 * UrbanBlockTool — draw urban block polygon, auto-generate trimmed axes
 * and place sections on them.
 *
 * Pipeline: draw polygon → solve (priority trim + distribute) → create
 * section-axis features. Buffers for these sections are drawn by
 * modules/buffers (MapLibre layers) — no separate overlay system.
 *
 * Hotkey: U
 */

import { eventBus } from '../../core/EventBus.js';
import { Config } from '../../core/Config.js';
import { BaseDrawTool } from './BaseTool.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';
import { CompoundCommand } from '../../core/commands/CompoundCommand.js';
import { createProjection } from '../../core/geo/projection.js';
import { solveUrbanBlockFull, DEFAULT_PARAMS } from '../../core/urban-block/UrbanBlockSolver.js';
import { processPolyline } from '../../core/section-chain/processor.js';
import { buildChainCommands } from './SectionChainTool.js';
import { insetPoly } from '../../core/three/BoxGeometry.js';
import { log } from '../../core/Logger.js';
import { computeTowerFootprints } from '../../core/tower/TowerFootprints.js';
import { detectNorthEnd } from '../../core/tower/TowerPlacer.js';
import { DEFAULT_CELL_SIZE } from '../../core/tower/TowerGenerator.js';

export class UrbanBlockTool extends BaseDrawTool {
  // Static toggles used at block creation time. Both default off.
  static useGap = false;
  // When true, the urban block is filled by treating its outer ring as
  // a single polyline + the section-chain pipeline (sections + corners
  // at every vertex). CCW rings are reversed first since the corner-
  // cell decomposition currently only handles outer (CW) corners.
  static useCorners = false;
  // When true (and useCorners is also true), the northernmost long
  // edge that can fit ≥ 1 tower is reserved for a tower-axis; the
  // remaining edges form an open polyline that runs through the
  // section-chain (corners) pipeline.
  static useTowers = false;
  // Per-block opt-in: render apartment balconies on residential
  // floors (slab + glass parapets, staggered pattern by default).
  // Heavy on FPS, off by default; toggle in AxisOptions panel.
  static useBalconies = false;

  constructor(manager, featureStore, mapManager) {
    super(manager);
    this.id = 'urban-block';
    this.name = 'Urban Block';
    this.cursor = Config.cursors.crosshair;
    this._featureStore = featureStore;
    this._mapManager = mapManager;
  }

  onMapDoubleClick(_e) {
    if (this._points.length > 0) this._points.pop();
    if (this._points.length >= 3) this._complete();
  }

  onKeyDown(e) {
    if (e.key === 'Enter' && this._points.length >= 3) {
      this._complete();
    } else {
      super.onKeyDown(e);
    }
  }

  _getPreviewGeometry() {
    if (this._points.length === 0) return null;
    var coords = this._points.slice();
    if (this._tempPoint) coords.push(this._tempPoint);
    if (coords.length < 2) return null;
    if (coords.length < 3) {
      return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords.concat([coords[0]])] } };
  }

  _complete() {
    if (this._points.length < 3) return;

    var polyLL = this._points.slice();
    var blockId = crypto.randomUUID();

    var bufDists = getGlobalBufferDists();
    var solveParams = Object.assign({}, DEFAULT_PARAMS, bufDists, {
      useGap: UrbanBlockTool.useGap
    });

    // Auto-pick the start vertex for corners-mode. The chain solver
    // drops the corner at the polyline endpoint, so this picks the
    // "best vertex to kill": WW > MM(shortest edge) > mixed > 0.
    if (UrbanBlockTool.useCorners) {
      try {
        solveParams.cornersStartIdx = computeBestCornerStartIdx(polyLL, solveParams.sw);
      } catch (err) {
        console.warn('[UrbanBlock] computeBestCornerStartIdx failed:', err);
        solveParams.cornersStartIdx = 0;
      }
    }

    var blockFeature = {
      type: 'Feature',
      properties: {
        id: blockId,
        type: 'polygon',
        urbanBlock: true,
        useGap: UrbanBlockTool.useGap,
        useCorners: UrbanBlockTool.useCorners,
        useTowers: UrbanBlockTool.useTowers,
        useBalconies: UrbanBlockTool.useBalconies,
        balconyPattern: 'staggered',
        solverParams: Object.assign({}, solveParams),
        createdAt: new Date().toISOString()
      },
      geometry: { type: 'Polygon', coordinates: [polyLL.concat([polyLL[0]])] }
    };

    var commands = [new AddFeatureCommand(this._featureStore, blockFeature)];

    console.log('[UrbanBlock] _complete useCorners=', UrbanBlockTool.useCorners,
      'useTowers=', UrbanBlockTool.useTowers);
    if (UrbanBlockTool.useTowers && UrbanBlockTool.useCorners) {
      // Towers + Corners: reserve northernmost long edge for a tower,
      // route the rest through the section-chain pipeline as an open
      // polyline.
      var pack;
      try {
        pack = buildBlockTowersAndCornersCommands(this._featureStore, polyLL,
          blockId, solveParams, solveParams.cornersStartIdx || 0);
      } catch (err) {
        console.error('[UrbanBlock] buildBlockTowersAndCornersCommands failed:', err);
        pack = { commands: [], towerCount: 0 };
      }
      for (var ti = 0; ti < pack.commands.length; ti++) commands.push(pack.commands[ti]);
      commandManager.execute(new CompoundCommand(commands, 'Add urban block (towers + corners)'));
      log.debug('[UrbanBlock] block ' + blockId.slice(0, 6) + ' (towers+corners): '
        + pack.towerCount + ' tower(s), ' + (pack.commands.length - pack.towerCount) + ' chain children');
    } else if (UrbanBlockTool.useTowers) {
      // Towers-only mode: tower on northernmost long edge + sections
      // on the remaining edges via the per-edge solver, with sections
      // overlapping the tower's expanded buffer trimmed out.
      var packSO;
      try {
        packSO = buildBlockTowersOnlyCommands(this._featureStore, polyLL,
          blockId, solveParams, solveParams.cornersStartIdx || 0);
      } catch (err) {
        console.error('[UrbanBlock] buildBlockTowersOnlyCommands failed:', err);
        packSO = { commands: [], towerCount: 0 };
      }
      for (var to = 0; to < packSO.commands.length; to++) commands.push(packSO.commands[to]);
      commandManager.execute(new CompoundCommand(commands, 'Add urban block (towers + sections)'));
      log.debug('[UrbanBlock] block ' + blockId.slice(0, 6) + ' (towers-only): '
        + packSO.towerCount + ' tower(s), ' + (packSO.commands.length - packSO.towerCount) + ' axes');
    } else if (UrbanBlockTool.useCorners) {
      // Corners-mode: fill via section-chain pipeline.
      var chainCmds;
      try {
        chainCmds = buildBlockChainCommands(this._featureStore, polyLL,
          blockId, solveParams.sw, solveParams.cornersStartIdx || 0);
      } catch (err) {
        console.error('[UrbanBlock] buildBlockChainCommands failed:', err);
        chainCmds = [];
      }
      console.log('[UrbanBlock] chain commands produced:', chainCmds.length);
      for (var c = 0; c < chainCmds.length; c++) commands.push(chainCmds[c]);
      commandManager.execute(new CompoundCommand(commands, 'Add urban block (with corners)'));
      log.debug('[UrbanBlock] block ' + blockId.slice(0, 6) + ' (corners): '
        + (chainCmds.length - 1) + ' chain children');
    } else {
      // Sections-only mode: existing per-edge solver.
      var axes = buildAxes(polyLL, solveParams);
      var axisFeatures = axesToFeatures(axes, blockId, solveParams.sw);
      for (var i = 0; i < axisFeatures.length; i++) {
        commands.push(new AddFeatureCommand(this._featureStore, axisFeatures[i]));
      }
      commandManager.execute(new CompoundCommand(commands, 'Add urban block'));
      log.debug('[UrbanBlock] block ' + blockId.slice(0, 6) + ': '
        + axisFeatures.length + ' axes');
    }

    eventBus.emit('draw:section:complete', blockFeature);
    this._reset();
    this._manager.clearPreview();
  }
}

/**
 * Read global buffer distances (populated by app.js). Keys match
 * DEFAULT_PARAMS: fire, endB, insol.
 */
export function getGlobalBufferDists() {
  try {
    if (typeof window !== 'undefined' && window.__UB_BUFFER_DISTS__) {
      return window.__UB_BUFFER_DISTS__;
    }
  } catch (_e) { /* no-op */ }
  return {};
}

/**
 * Corners-mode block fill — runs the section-chain pipeline on the
 * polygon's outer ring.
 *
 * Mid-edge trick: pick the LONGEST edge of the polygon, take its
 * midpoint, and start/end the polyline there. Result: every polygon
 * vertex sits at an INTERNAL polyline vertex → every vertex gets a
 * corner. The longest edge is split in two halves; each half still
 * accommodates standalone sections.
 *
 * Polygon is forced CW before processing — corner-cell decomposition
 * currently only handles outer (CW + side=+1) corners; inner corners
 * fall back to the hollow-floor renderer.
 *
 * @returns {AddFeatureCommand[]} chain holder + section axes + corners,
 *   each feature tagged with blockId so cascade-delete from the urban
 *   block also removes them.
 */
/**
 * Pick the polygon vertex whose corner is the best one to "kill" at
 * the polyline start/end junction. The chain solver doesn't form a
 * corner at the polyline endpoint, so whichever vertex sits at index 0
 * of the rotated ring loses its corner. Priority:
 *
 *   1. WW corner (both adjacent edges are latitudinal). Latitudinal
 *      sections are short and pair-flanked, so dropping a WW corner
 *      reads as a clean break in the perimeter.
 *   2. MM corner (both meridional). When picking among MM candidates,
 *      prefer the one whose shorter adjacent edge is shortest — kills
 *      the least amount of section.
 *   3. Mixed (WM/MW) — fallback. Pick the first.
 *   4. Vertex 0 if classification fails.
 */
export function computeBestCornerStartIdx(polyLL, secWidth) {
  if (!polyLL || polyLL.length < 3) return 0;
  var cx = 0, cy = 0;
  for (var i = 0; i < polyLL.length; i++) { cx += polyLL[i][0]; cy += polyLL[i][1]; }
  cx /= polyLL.length; cy /= polyLL.length;
  var proj = createProjection(cx, cy);

  var polyM = [];
  for (var j = 0; j < polyLL.length; j++) polyM.push(proj.toMeters(polyLL[j][0], polyLL[j][1]));
  var sa = 0;
  for (var s = 0; s < polyM.length; s++) {
    var n = (s + 1) % polyM.length;
    sa += polyM[s][0] * polyM[n][1] - polyM[n][0] * polyM[s][1];
  }
  if (sa < 0) polyM.reverse();

  var insetM = insetPoly(polyM, secWidth);
  if (!insetM || insetM.length < 3) return 0;
  var N = insetM.length;

  function classifyEdge(a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) return 0;
    return Math.abs(dy / len) >= 0.7 ? 1 : 0;  // 1=lon (M), 0=lat (W)
  }

  var modes = [];
  var minLen = [];
  for (var v = 0; v < N; v++) {
    var prevV = (v - 1 + N) % N;
    var nextV = (v + 1) % N;
    var oIn = classifyEdge(insetM[prevV], insetM[v]);
    var oOut = classifyEdge(insetM[v], insetM[nextV]);
    if (oIn === 0 && oOut === 0) modes.push('WW');
    else if (oIn === 1 && oOut === 1) modes.push('MM');
    else modes.push('mixed');
    var dxA = insetM[v][0] - insetM[prevV][0], dyA = insetM[v][1] - insetM[prevV][1];
    var dxB = insetM[nextV][0] - insetM[v][0], dyB = insetM[nextV][1] - insetM[v][1];
    minLen.push(Math.min(Math.hypot(dxA, dyA), Math.hypot(dxB, dyB)));
  }

  // Priority 1: any WW corner.
  for (var w = 0; w < N; w++) if (modes[w] === 'WW') return w;
  // Priority 2: MM corner with shortest adjacent edge.
  var bestMM = -1, bestMMLen = Infinity;
  for (var m = 0; m < N; m++) {
    if (modes[m] !== 'MM') continue;
    if (minLen[m] < bestMMLen) { bestMMLen = minLen[m]; bestMM = m; }
  }
  if (bestMM >= 0) return bestMM;
  // Priority 3: first mixed corner.
  for (var x = 0; x < N; x++) if (modes[x] === 'mixed') return x;
  return 0;
}

// ── Tower placement helpers (shared by towers+corners and towers-only) ──

/**
 * Inflate a quad (rotated rectangle) outward by `margin` along each
 * edge's outward normal. Result is the same-shape polygon scaled out
 * by `margin` so that section solver's polygon-vs-segment subtraction
 * trims any axis crossing the buffered envelope. Falls back to AABB
 * expansion for non-quad inputs.
 */
function _inflateRect(poly, margin) {
  if (!poly || poly.length !== 4) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < (poly || []).length; i++) {
      if (poly[i][0] < minX) minX = poly[i][0];
      if (poly[i][1] < minY) minY = poly[i][1];
      if (poly[i][0] > maxX) maxX = poly[i][0];
      if (poly[i][1] > maxY) maxY = poly[i][1];
    }
    return [[minX - margin, minY - margin], [maxX + margin, minY - margin],
            [maxX + margin, maxY + margin], [minX - margin, maxY + margin]];
  }
  var n = 4;
  var cx = 0, cy = 0;
  for (var k = 0; k < n; k++) { cx += poly[k][0]; cy += poly[k][1]; }
  cx /= n; cy /= n;
  var lines = [];
  for (var e = 0; e < n; e++) {
    var a = poly[e], b = poly[(e + 1) % n];
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var L = Math.hypot(dx, dy) || 1;
    var nx = -dy / L, ny = dx / L;
    var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (nx * (mx - cx) + ny * (my - cy) < 0) { nx = -nx; ny = -ny; }
    lines.push({
      sx: a[0] + nx * margin, sy: a[1] + ny * margin,
      tx: b[0] + nx * margin, ty: b[1] + ny * margin
    });
  }
  function intersect(L1, L2) {
    var x1 = L1.sx, y1 = L1.sy, x2 = L1.tx, y2 = L1.ty;
    var x3 = L2.sx, y3 = L2.sy, x4 = L2.tx, y4 = L2.ty;
    var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;
    var t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
  }
  var out = [];
  for (var c = 0; c < n; c++) {
    var prev = lines[(c - 1 + n) % n];
    var next = lines[c];
    var p = intersect(prev, next);
    if (p) out.push(p);
    else out.push([(prev.sx + next.sx) / 2, (prev.sy + next.sy) / 2]);
  }
  return out;
}

/**
 * Build buffer polygons for a tower-axis to feed into the urban-block
 * solver as extra obstacles. Towers wear the same fire/end/insol
 * buffers as sections — fire (long faces), end (short faces), insol
 * (long faces). Implementation simplification: produce ONE buffer
 * polygon per tower equal to the tower footprint inflated by the
 * MAX of the three buffer distances. This over-trims slightly on the
 * short-edge axis (fire vs end), but keeps the tower clear of axis
 * placement conservatively.
 */
function _buildTowerBuffersM(towerFootprintsM, par) {
  var margin = Math.max(par.fire || 14, par.endB || 20, par.insol || 30);
  var bufs = [];
  for (var i = 0; i < towerFootprintsM.length; i++) {
    var poly = towerFootprintsM[i].polygon;
    if (poly && poly.length >= 3) bufs.push(_inflateRect(poly, margin));
  }
  return bufs;
}

function _pointInPolygon(pt, poly) {
  var inside = false;
  var x = pt[0], y = pt[1];
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var xi = poly[i][0], yi = poly[i][1];
    var xj = poly[j][0], yj = poly[j][1];
    var intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Pick the best polygon edge to host a tower-axis. Filtering rules:
 *   1. Edge length ≥ smallest tower length-along (7 cells × cellSize).
 *   2. computeTowerFootprints packs at least one tower onto it.
 *   3. ALL footprint corners must lie inside the original polygon
 *      (this catches narrow blocks where the tower would punch out
 *      through the opposite edge, which the user explicitly forbids).
 *
 * Among eligible edges, sort by midpoint Y descending (northernmost
 * first). `startIdx` lets shuffle pick the next eligible edge in that
 * sorted order.
 *
 * Returns { edgeIdx, startM, endM, startLL, endLL, length, flipped,
 *   footprintsM, footprintsLL } or null.
 */
function _pickTowerEdge(polyM, polyLL, proj, startIdx) {
  var n = polyM.length;
  // Centroid in meters — used to flip tower toward interior.
  var cxM = 0, cyM = 0;
  for (var i = 0; i < n; i++) { cxM += polyM[i][0]; cyM += polyM[i][1]; }
  cxM /= n; cyM /= n;

  var candidates = [];
  for (var ei = 0; ei < n; ei++) {
    var ej = (ei + 1) % n;
    var a = polyM[ei], b = polyM[ej];
    var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 7 * DEFAULT_CELL_SIZE) continue;

    // Determine inward flip.
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var perpX = -dy / len, perpY = dx / len;
    var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    var dot = perpX * (cxM - mx) + perpY * (cyM - my);
    var flipped = dot < 0;

    var fpsM = computeTowerFootprints(a, b,
      { cellSize: DEFAULT_CELL_SIZE, towerGap: 20, flipped: flipped }, null);
    if (!fpsM || fpsM.length === 0) continue;

    // Verify each tower fits inside the polygon. Tower corners 0 and
    // 1 sit exactly on the polygon edge — ray-cast point-in-polygon
    // is unreliable for boundary points, so we test only the two
    // INNER corners (indices 2 and 3) and the centroid. If those
    // are inside, the tower's interior body is inside; the on-edge
    // corners are accepted by construction.
    var fits = true;
    for (var fi = 0; fi < fpsM.length && fits; fi++) {
      var poly = fpsM[fi].polygon;
      if (!_pointInPolygon([poly[2][0], poly[2][1]], polyM)) { fits = false; break; }
      if (!_pointInPolygon([poly[3][0], poly[3][1]], polyM)) { fits = false; break; }
      var cxF = (poly[0][0] + poly[1][0] + poly[2][0] + poly[3][0]) / 4;
      var cyF = (poly[0][1] + poly[1][1] + poly[2][1] + poly[3][1]) / 4;
      if (!_pointInPolygon([cxF, cyF], polyM)) { fits = false; break; }
    }
    if (!fits) continue;

    candidates.push({
      edgeIdx: ei,
      startM: a, endM: b,
      startLL: polyLL[ei], endLL: polyLL[ej],
      midY: (a[1] + b[1]) / 2,
      length: len,
      flipped: flipped,
      footprintsM: fpsM
    });
  }
  if (candidates.length === 0) return null;
  // Sort northernmost first (max midY).
  candidates.sort(function (p, q) { return q.midY - p.midY; });
  var pick = candidates[((startIdx || 0) % candidates.length + candidates.length) % candidates.length];

  // Project footprints to lng/lat for storage.
  pick.footprintsLL = computeTowerFootprints(pick.startM, pick.endM,
    { cellSize: DEFAULT_CELL_SIZE, towerGap: 20, flipped: pick.flipped },
    function (mx2, my2) { return proj.toLngLat(mx2, my2); });
  return pick;
}

function _buildTowerFeature(edge, blockId) {
  var northEnd = detectNorthEnd(edge.startM, edge.endM);
  return {
    type: 'Feature',
    properties: {
      id: crypto.randomUUID(),
      type: 'tower-axis',
      createdAt: new Date().toISOString(),
      flipped: edge.flipped,
      orientation: 'lat',
      axisLength: edge.length,
      cellSize: DEFAULT_CELL_SIZE,
      towerHeight: 112,
      towerGap: 20,
      forcedSize: null,
      northEnd: northEnd,
      footprints: edge.footprintsLL,
      blockId: blockId
    },
    geometry: {
      type: 'LineString',
      coordinates: [edge.startLL, edge.endLL]
    }
  };
}

/**
 * Shrink a 4-corner section footprint polygon (in meters) by an inflated
 * tower footprint. If the section overlaps any tower's expanded buffer
 * polygon, return null — caller drops it. Cheap AABB pre-filter then
 * polygon-corner test.
 */
function _sectionOverlapsTower(fpM, towerFootprintsM, bufferM) {
  // AABB of the section
  var sxMin = Infinity, syMin = Infinity, sxMax = -Infinity, syMax = -Infinity;
  for (var i = 0; i < fpM.length; i++) {
    if (fpM[i][0] < sxMin) sxMin = fpM[i][0];
    if (fpM[i][1] < syMin) syMin = fpM[i][1];
    if (fpM[i][0] > sxMax) sxMax = fpM[i][0];
    if (fpM[i][1] > syMax) syMax = fpM[i][1];
  }
  for (var t = 0; t < towerFootprintsM.length; t++) {
    var tp = towerFootprintsM[t].polygon;
    var txMin = Infinity, tyMin = Infinity, txMax = -Infinity, tyMax = -Infinity;
    for (var k = 0; k < tp.length; k++) {
      if (tp[k][0] < txMin) txMin = tp[k][0];
      if (tp[k][1] < tyMin) tyMin = tp[k][1];
      if (tp[k][0] > txMax) txMax = tp[k][0];
      if (tp[k][1] > tyMax) tyMax = tp[k][1];
    }
    txMin -= bufferM; tyMin -= bufferM; txMax += bufferM; tyMax += bufferM;
    if (sxMax < txMin || sxMin > txMax || syMax < tyMin || syMin > tyMax) continue;
    // AABB intersects → check if any section corner is inside the
    // buffered tower AABB (cheap & sufficient for tight axes).
    return true;
  }
  return false;
}

/**
 * Towers + corners block fill.
 *
 * Picks the (startIdx-th, sorted northernmost-first) eligible polygon
 * edge and reserves it for a `tower-axis`. The remaining edges become
 * an OPEN polyline routed through the section-chain pipeline. Open-
 * polyline endpoints are pulled inward by `endB` so the chain doesn't
 * butt against the tower.
 */
function buildBlockTowersAndCornersCommands(featureStore, polyLL, blockId, params, startIdx) {
  var out = { commands: [], towerCount: 0 };
  var secWidth = params.sw;
  // Use the maximum of all section-equivalent buffers as the chain
  // clearance distance — same envelope the solver uses to trim
  // sections when towers are present in the towers-only path.
  var endB = Math.max(params.fire || 14, params.endB || 20, params.insol || 30);

  var cx = 0, cy = 0;
  for (var i = 0; i < polyLL.length; i++) { cx += polyLL[i][0]; cy += polyLL[i][1]; }
  cx /= polyLL.length; cy /= polyLL.length;
  var proj = createProjection(cx, cy);

  var polyM = [];
  for (var j = 0; j < polyLL.length; j++) polyM.push(proj.toMeters(polyLL[j][0], polyLL[j][1]));
  var sa = 0;
  for (var s = 0; s < polyM.length; s++) {
    var nn = (s + 1) % polyM.length;
    sa += polyM[s][0] * polyM[nn][1] - polyM[nn][0] * polyM[s][1];
  }
  if (sa < 0) { polyM.reverse(); polyLL = polyLL.slice().reverse(); }

  var edge = _pickTowerEdge(polyM, polyLL, proj, startIdx);
  if (!edge) {
    log.debug('[UrbanBlock] towers+corners: no eligible edge, falling back to corners');
    var chainCmds = buildBlockChainCommands(featureStore, polyLL, blockId, secWidth, startIdx);
    out.commands = chainCmds;
    return out;
  }

  out.commands.push(new AddFeatureCommand(featureStore, _buildTowerFeature(edge, blockId)));
  out.towerCount = 1;

  // Build OPEN inset polyline that skips the towered edge.
  var insetM = insetPoly(polyM, secWidth);
  if (!insetM || insetM.length < 3) {
    log.warn('[UrbanBlock] towers+corners: inset failed; tower placed but no chain');
    return out;
  }
  var nIn = insetM.length;
  var startV = (edge.edgeIdx + 1) % nIn;
  var endV = edge.edgeIdx % nIn;
  var ptsMRaw = [];
  var v = startV;
  for (var step = 0; step < nIn; step++) {
    ptsMRaw.push([insetM[v][0], insetM[v][1]]);
    if (v === endV && step > 0) break;
    v = (v + 1) % nIn;
  }
  if (ptsMRaw.length < 2) return out;

  // Pull first/last point inward along their adjacent segments by endB
  // so the chain doesn't butt against the tower's footprint.
  function shiftAlong(from, to, dist) {
    var dxs = to[0] - from[0], dys = to[1] - from[1];
    var L = Math.hypot(dxs, dys);
    if (L <= dist + 1e-3) return null; // segment too short to keep
    var k = dist / L;
    return [from[0] + dxs * k, from[1] + dys * k];
  }
  if (ptsMRaw.length >= 2) {
    var shifted = shiftAlong(ptsMRaw[0], ptsMRaw[1], endB);
    if (shifted) ptsMRaw[0] = shifted;
  }
  if (ptsMRaw.length >= 2) {
    var last = ptsMRaw.length - 1;
    var shifted2 = shiftAlong(ptsMRaw[last], ptsMRaw[last - 1], endB);
    if (shifted2) ptsMRaw[last] = shifted2;
  }

  var ptsM = [], ptsLL = [];
  for (var pp = 0; pp < ptsMRaw.length; pp++) {
    ptsM.push({ x: ptsMRaw[pp][0], y: ptsMRaw[pp][1] });
    ptsLL.push(proj.toLngLat(ptsMRaw[pp][0], ptsMRaw[pp][1]));
  }

  var side = -1;
  var layout = processPolyline(ptsM, {
    width: secWidth, side: side, cornersOn: true, footprint: 0
  });
  console.log('[UrbanBlock] towers+corners: pts=', ptsM.length,
    'sections=', layout.sections.length, 'corners=', layout.corners.length);
  var chainCmds2 = buildChainCommands(featureStore, proj, ptsLL, ptsM, layout,
    secWidth, side, undefined, blockId);
  for (var ck = 0; ck < chainCmds2.length; ck++) out.commands.push(chainCmds2[ck]);
  return out;
}

/**
 * Towers + sections (no corners). Place tower on the picked edge,
 * run the per-edge solver, then drop any section axis whose footprint
 * collides with the tower's buffer. A simple AABB-overlap is used —
 * sufficient because tower buffers are convex and axes don't cross
 * the tower's own row.
 */
function buildBlockTowersOnlyCommands(featureStore, polyLL, blockId, params, startIdx) {
  var out = { commands: [], towerCount: 0 };

  var cx = 0, cy = 0;
  for (var i = 0; i < polyLL.length; i++) { cx += polyLL[i][0]; cy += polyLL[i][1]; }
  cx /= polyLL.length; cy /= polyLL.length;
  var proj = createProjection(cx, cy);

  var polyM = [];
  for (var j = 0; j < polyLL.length; j++) polyM.push(proj.toMeters(polyLL[j][0], polyLL[j][1]));
  var sa = 0;
  for (var s = 0; s < polyM.length; s++) {
    var nn = (s + 1) % polyM.length;
    sa += polyM[s][0] * polyM[nn][1] - polyM[nn][0] * polyM[s][1];
  }
  if (sa < 0) { polyM.reverse(); polyLL = polyLL.slice().reverse(); }

  var edge = _pickTowerEdge(polyM, polyLL, proj, startIdx);
  if (!edge) {
    log.debug('[UrbanBlock] towers-only: no eligible edge, plain solver');
    var axes = buildAxes(polyLL, params);
    var axisFeatures = axesToFeatures(axes, blockId, params.sw);
    for (var k = 0; k < axisFeatures.length; k++) {
      out.commands.push(new AddFeatureCommand(featureStore, axisFeatures[k]));
    }
    return out;
  }

  out.commands.push(new AddFeatureCommand(featureStore, _buildTowerFeature(edge, blockId)));
  out.towerCount = 1;

  // Feed the tower's fire/end/insol envelope into the solver as an
  // extra buffer obstacle. prioTrim seeds allBufs with these before
  // processing edges, so every section axis (including the highest-
  // priority one) is shortened or dropped where it crosses the tower
  // envelope — same semantics as section-vs-section trimming.
  var paramsWithTower = Object.assign({}, params, {
    extraBufs: _buildTowerBuffersM(edge.footprintsM, params)
  });
  var axes2 = buildAxes(polyLL, paramsWithTower);
  // Drop the section axis that runs along the towered polygon edge —
  // the tower IS the building there; placing a section overlaps it.
  // We match by geometry (axis midpoint inside any tower footprint)
  // rather than by edge id, since the solver may have reversed the
  // polygon to CW and re-indexed edges.
  var keptAxes = [];
  var droppedTowerHost = 0;
  for (var ax0 = 0; ax0 < axes2.length; ax0++) {
    var ax2 = axes2[ax0];
    if (!ax2 || !ax2.start || !ax2.end) { keptAxes.push(ax2); continue; }
    var midX = (ax2.start[0] + ax2.end[0]) / 2;
    var midY = (ax2.start[1] + ax2.end[1]) / 2;
    var hostsTower = false;
    for (var fpi = 0; fpi < edge.footprintsM.length; fpi++) {
      if (_pointInPolygon([midX, midY], edge.footprintsM[fpi].polygon)) {
        hostsTower = true;
        break;
      }
    }
    if (hostsTower) { droppedTowerHost++; continue; }
    keptAxes.push(ax2);
  }
  keptAxes.__proj = axes2.__proj;
  var allAxisFeatures = axesToFeatures(keptAxes, blockId, params.sw);
  for (var ax = 0; ax < allAxisFeatures.length; ax++) {
    out.commands.push(new AddFeatureCommand(featureStore, allAxisFeatures[ax]));
  }
  log.debug('[UrbanBlock] towers-only: tower placed + ' + allAxisFeatures.length
    + ' axes (' + droppedTowerHost + ' tower-host axis dropped)');
  return out;
}

function buildBlockChainCommands(featureStore, polyLL, blockId, secWidth, startIdx) {
  var cx = 0, cy = 0;
  for (var i = 0; i < polyLL.length; i++) { cx += polyLL[i][0]; cy += polyLL[i][1]; }
  cx /= polyLL.length; cy /= polyLL.length;
  var proj = createProjection(cx, cy);

  var polyM = [];
  for (var j = 0; j < polyLL.length; j++) polyM.push(proj.toMeters(polyLL[j][0], polyLL[j][1]));
  // Force CCW (signedArea > 0). The inset trick below relies on CCW
  // winding so side=-1 puts cells outside the inset polyline → between
  // inset and the original polygon → INSIDE the original urban block.
  var sa = 0;
  for (var s = 0; s < polyM.length; s++) {
    var n = (s + 1) % polyM.length;
    sa += polyM[s][0] * polyM[n][1] - polyM[n][0] * polyM[s][1];
  }
  if (sa < 0) { polyM.reverse(); polyLL = polyLL.slice().reverse(); }

  // Inset trick: shrink the polygon inward by the section width. The
  // shrunk polygon becomes the chain "polyline"; sections extend
  // outward by W and land between the inset and the original polygon
  // edge — i.e., INSIDE the urban block. Corners become outer (cells
  // diverge at vertices, no overlap), so the chain solver decomposes
  // them with the full apartment+corridor+LLU layout.
  var insetM = insetPoly(polyM, secWidth);
  if (!insetM || insetM.length < 3) {
    console.warn('[UrbanBlock] inset failed or polygon too small for section width', secWidth);
    return [];
  }

  var N = insetM.length;
  // Rotate the inset ring so the chain polyline starts at the user's
  // chosen vertex. processPolyline treats the first/last point as the
  // polyline endpoint (no corner there), so shuffling the start vertex
  // moves the "missing corner" around the polygon — useful when the
  // missed corner happens to be the user's most-visible one.
  var rot = ((startIdx || 0) % N + N) % N;
  var ptsLL = [];
  var ptsM = [];
  for (var p = 0; p < N; p++) {
    var idx = (p + rot) % N;
    ptsLL.push(proj.toLngLat(insetM[idx][0], insetM[idx][1]));
    ptsM.push({ x: insetM[idx][0], y: insetM[idx][1] });
  }
  // Close the polyline (N+1 points). Loses the corner at vertex 0 —
  // acceptable for a first pass.
  ptsLL.push(ptsLL[0]);
  ptsM.push({ x: ptsM[0].x, y: ptsM[0].y });

  // CCW inset + side=-1 → cells extrude outward (toward original polygon
  // edge) and corners are outer (cells decompose).
  var side = -1;
  var layout = processPolyline(ptsM, {
    width: secWidth,
    side: side,
    cornersOn: true,
    footprint: 0
  });
  console.log('[UrbanBlock] processPolyline: pts=', ptsM.length,
    'sections=', layout.sections.length, 'corners=', layout.corners.length);

  return buildChainCommands(featureStore, proj, ptsLL, ptsM, layout,
    secWidth, side, undefined, blockId);
}

function buildAxes(polyLL, solveParams) {
  var cx = 0, cy = 0;
  for (var i = 0; i < polyLL.length; i++) { cx += polyLL[i][0]; cy += polyLL[i][1]; }
  cx /= polyLL.length; cy /= polyLL.length;
  var proj = createProjection(cx, cy);

  var polyM = [];
  for (var j = 0; j < polyLL.length; j++) {
    polyM.push(proj.toMeters(polyLL[j][0], polyLL[j][1]));
  }
  var area = 0;
  for (var k = 0; k < polyM.length; k++) {
    var next = (k + 1) % polyM.length;
    area += (polyM[next][0] + polyM[k][0]) * (polyM[next][1] - polyM[k][1]);
  }
  if (area < 0) polyM.reverse();

  var result = solveUrbanBlockFull(polyM, solveParams);
  var raw = result.axes || [];
  raw.__proj = proj;
  return raw;
}

function axesToFeatures(axes, blockId, sw) {
  var proj = axes.__proj;
  var features = [];
  for (var ai = 0; ai < axes.length; ai++) {
    var ax = axes[ai];
    if (ax.removed || ax.length < 3 || !ax.oi || !ax.secs || ax.secs.length === 0) continue;
    var startLL = proj.toLngLat(ax.start[0], ax.start[1]);
    var endLL = proj.toLngLat(ax.end[0], ax.end[1]);
    var oriName = ax.oriName || (ax.orientation === 1 ? 'lon' : 'lat');
    var od = ax.oi.od;
    var axLen = ax.length;
    var dirN = axLen > 0
      ? [(ax.end[0] - ax.start[0]) / axLen, (ax.end[1] - ax.start[1]) / axLen]
      : [1, 0];
    var ox = od[0] * sw;
    var oy = od[1] * sw;

    var fpLngLat = [];
    var pos = 0;
    for (var si = 0; si < ax.secs.length; si++) {
      var sec = ax.secs[si];
      if (sec.gap) { pos += sec.l; continue; }
      var sx = ax.start[0] + dirN[0] * pos;
      var sy = ax.start[1] + dirN[1] * pos;
      var ex = ax.start[0] + dirN[0] * (pos + sec.l);
      var ey = ax.start[1] + dirN[1] * (pos + sec.l);
      var pm = [[sx, sy], [ex, ey], [ex + ox, ey + oy], [sx + ox, sy + oy]];
      var pll = [];
      for (var j = 0; j < pm.length; j++) pll.push(proj.toLngLat(pm[j][0], pm[j][1]));
      fpLngLat.push({ polygon: pll, length: sec.l });
      pos += sec.l;
    }
    if (fpLngLat.length === 0) continue;

    features.push({
      type: 'Feature',
      properties: {
        id: crypto.randomUUID(),
        type: 'section-axis',
        createdAt: new Date().toISOString(),
        flipped: false,
        orientation: oriName,
        axisLength: axLen,
        footprints: fpLngLat,
        blockId: blockId
      },
      geometry: { type: 'LineString', coordinates: [startLL, endLL] }
    });
  }
  return features;
}

/**
 * Rebuild one block's axes/sections after solver-affecting params change.
 * Removes existing section-axis features for this block and recreates
 * them with the new params. Does NOT recreate the block polygon itself.
 */
export function rebuildBlockAxes(featureStore, blockFeature, overrideParams) {
  if (!blockFeature || !blockFeature.properties || !blockFeature.properties.urbanBlock) return;
  var polyLL = extractPolyLL(blockFeature);
  if (!polyLL || polyLL.length < 3) return;

  var existing = blockFeature.properties.solverParams || Object.assign({}, DEFAULT_PARAMS);
  var newParams = Object.assign({}, existing, overrideParams || {});
  newParams.useGap = blockFeature.properties.useGap === true;
  var blockId = blockFeature.properties.id;

  // Wipe ALL chain children of this block — sections, corners, chain
  // holders, towers. All paths tag children with blockId, so this
  // single sweep covers every fill mode.
  var all = featureStore.toArray();
  for (var i = 0; i < all.length; i++) {
    var f = all[i];
    if (f.properties.blockId !== blockId) continue;
    var t = f.properties.type;
    if (t === 'section-axis' || t === 'section-chain' ||
        t === 'section-chain-corner' || t === 'tower-axis') {
      featureStore.remove(f.properties.id);
    }
  }

  var useCorners = blockFeature.properties.useCorners === true;
  var useTowers = blockFeature.properties.useTowers === true;

  if (useTowers && useCorners) {
    var pack = buildBlockTowersAndCornersCommands(featureStore, polyLL, blockId,
      newParams, newParams.cornersStartIdx || 0);
    for (var pi = 0; pi < pack.commands.length; pi++) pack.commands[pi].execute();
  } else if (useTowers) {
    var packSO = buildBlockTowersOnlyCommands(featureStore, polyLL, blockId,
      newParams, newParams.cornersStartIdx || 0);
    for (var ps = 0; ps < packSO.commands.length; ps++) packSO.commands[ps].execute();
  } else if (useCorners) {
    // Corners-mode: rebuild the chain. AddFeatureCommand wraps the
    // store.add call; for an inline rebuild we skip the command layer
    // (this path is triggered by buffer-slider live updates, not user
    // intent — undo of the buffer drag is what restores prior state).
    var chainCmds = buildBlockChainCommands(featureStore, polyLL, blockId,
      newParams.sw, newParams.cornersStartIdx || 0);
    for (var c = 0; c < chainCmds.length; c++) chainCmds[c].execute();
  } else {
    var axes = buildAxes(polyLL, newParams);
    var axisFeatures = axesToFeatures(axes, blockId, newParams.sw);
    for (var k = 0; k < axisFeatures.length; k++) {
      featureStore.add(axisFeatures[k]);
    }
  }

  blockFeature.properties.solverParams = newParams;
  eventBus.emit('features:changed');
}

/**
 * Rebuild ALL urban-blocks in the feature store with new override params.
 * Applied when BufferPanel sliders (fire/end) change.
 */
export function rebuildAllBlocks(featureStore, overrideParams) {
  var all = featureStore.toArray();
  // Snapshot block features first — feature store mutates during rebuild.
  var blocks = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].properties && all[i].properties.urbanBlock) blocks.push(all[i]);
  }
  for (var b = 0; b < blocks.length; b++) {
    rebuildBlockAxes(featureStore, blocks[b], overrideParams);
  }
  return blocks.length;
}

function extractPolyLL(blockFeature) {
  var coords = blockFeature.geometry && blockFeature.geometry.coordinates && blockFeature.geometry.coordinates[0];
  if (!coords) return null;
  var out = coords.slice();
  if (out.length >= 2) {
    var a = out[0], b = out[out.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

/**
 * Collect the feature id of a block polygon plus all its children
 * (section-axis features that reference the block via blockId). Used
 * by the delete handler in app.js to build one CompoundCommand —
 * removing the polygon also removes all sections in one undo step.
 *
 * @param {Object} featureStore
 * @param {string} blockId
 * @returns {string[]} feature ids, parent first
 */
export function collectBlockFeatureIds(featureStore, blockId) {
  var all = featureStore.toArray();
  var ids = [];
  // Block polygon first.
  for (var i = 0; i < all.length; i++) {
    if (all[i].properties.id === blockId) { ids.push(blockId); break; }
  }
  for (var j = 0; j < all.length; j++) {
    var f = all[j];
    if (f.properties.id === blockId) continue;
    if (f.properties.blockId === blockId) ids.push(f.properties.id);
  }
  return ids;
}

/**
 * Delete all features belonging to a block (polygon + axes).
 * Non-undoable — kept for internal cleanup paths. For user-facing
 * deletes use collectBlockFeatureIds + RemoveFeatureCommand.
 */
export function deleteBlock(featureStore, blockId) {
  var all = featureStore.toArray();
  var toRemove = [];
  for (var i = 0; i < all.length; i++) {
    var f = all[i];
    if (f.properties.id === blockId || f.properties.blockId === blockId) {
      toRemove.push(f.properties.id);
    }
  }
  for (var i = 0; i < toRemove.length; i++) {
    featureStore.remove(toRemove[i]);
  }
  return toRemove.length;
}
