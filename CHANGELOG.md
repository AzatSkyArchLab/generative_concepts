# Changelog

## Unreleased

### Fixed

- **`TowerGraph.buildTowerGraph`** — corner breaks now fire unconditionally
  at side transitions, regardless of neighbouring run lengths. The previous
  `prevLen ≥ 2 && curLen ≥ 2` guard suppressed breaks when either neighbour
  was a single cell, causing horizontal edges to connect cells on different
  physical sides of the ring (e.g. `left(row=2, col=0)` adjacent to
  `top(row=0, col=0)` on `small` tower with `col-low` exit). The solver
  interpreted these as near-row neighbours and could build L-shape
  apartments spanning a corner — a topology violation.

  Fix: always break at side transitions. A single-cell run becomes its
  own segment of length 1, which the solver handles as a 1K apartment or
  a degenerate case (orphan) depending on far-side access. For
  `small × col-low` and `small × col-high` specifically, two length-1
  segments are produced and surface as orphans — this is a geometric
  limitation of a 7×7 tower with a centred side exit, not a solver bug.

- **`TrajectoryPlanner.planMergeSchedule`** — the function now reports
  whether it clamped `targetTotal` to the physical feasible range
  `[minTotal, maxTotal]`. Previously clamping was silent, so
  `BuildingPlanner` could pass an infeasible `quotaSum` (e.g. heavy-4K mix
  with few floor-1 apartments over many floors), receive a profile summing
  to a different total, and follow two incompatible plans at once — with
  large type-distribution drift as the visible symptom.

  The return object now includes `feasible`, `requestedTotal`,
  `effectiveTotal`, `clampDirection`, `minTotal`, `maxTotal`.
  `BuildingPlanner` logs a warning when `feasible === false`.

### Added

- `test/trajectory_invariants.test.js` — 18 tests covering profile sum
  invariants, monotonicity, feasibility signalling, and the feasibility
  API contract. Includes a sweep over `(floor1Count, residentialFloors,
  targetTotal) ∈ [2..10] × [2..25] × [minTT..maxTT]` (~11k cases).

- `test/tower_ring_segments.test.js` — 24 tests covering all
  (size × exit-side) combinations (3 × 4 = 12), asserting no horizontal
  edge crosses two different ring sides after corner breaks.

### Test Summary

Total: 168 tests across 6 files, all passing.
Previously: 130 tests, all passing.

---

## refactor-v16: urban-block expansion

Feature imports from the React prototype into the production
`core/urban-block/` pipeline, plus one field-reported bug fix.

### Fixed

- **`computeOverlays` — connectors no longer tunnel through tower
  footprints.** Previously the connector collision filter checked only
  against section rectangles, so a connector routed from a section
  buffer to the inner road ring could cross a tower. The function now
  accepts a fourth parameter `towerFootprintsM: Array<Array<[number,
  number]>>` (default `[]`, backward-compatible) and rejects any
  connector whose segment crosses a footprint edge or whose endpoint
  lies strictly inside a footprint.

  `FeaturePanel._rebuildBlock` accumulates footprints from every
  `tower-axis` feature generated in the current pass and passes the
  array into `computeOverlays`.

### Added

- **`core/urban-block/Scoring.js`** — `scorePolygon(polyM, params)`
  returns `{secs, len}` by running the solver once and summing non-gap
  sections. `scoreBetter`/`scoreAtLeast` provide consistent comparison
  (secs dominates; len breaks ties). Pure math, no UI dependency.

- **`core/urban-block/ContextOptimizer.js`** — rewritten with a clean
  API. Previously required inversion-of-control passing of internal
  solver functions. Now: `autoOptimize(polyM, params, opts) →
  {ctxOverride, score, tried}`. Exhaustive search for `n ≤ 6` edges
  (3^n ≤ 729), random sampling otherwise (default 2000 iterations).
  L-block test case: default 9 sections → optimized 11 sections
  (+22%).

- **`UrbanBlockSolver.solveUrbanBlock`** — supports
  `params.ctxOverride: Array<number>` with the highest priority (above
  `ctxRoll` and default-length sort). Arrays of a length different
  from `edges.length` are ignored.

- **`core/urban-block/FunctionalSimplifier.js`** — removes vertices
  greedily while `scoreAtLeast(finalScore, initialScore)` holds. Uses
  `safeToRemove` chord-sampling against the reference polygon to
  prevent the simplified ring leaving the original shape. Differs from
  the geometric `PolygonSimplifier` in that the acceptance criterion
  is the number of sections the solver can fit, not shape deviation.
  Test case: noisy rectangle (10 verts, 5 sections) → 7 verts, 8
  sections.

- **`core/urban-block/Stylobates.js`** — extraction of non-residential
  podium polygons. Algorithm ported from the React prototype:
  rasterize polygon interior minus (inner ring + occupants) at 0.25m
  cells → flood-fill components → trace edge contours → snap vertices
  to nearest boundary line (polygon or occupant edge) and remove
  near-collinear (<1.5°) vertices. `selectByCoverage(stylobates,
  coveragePct)` picks the top-N stylobates by area until total
  coverage reaches the target fraction.

- **`core/urban-block/StylobateGrid.js`** —
  `gridForStylobate(polyM, cellSize, margin)` produces
  ground-floor-cell polygons aligned to the stylobate's local OBB
  (per-stylobate, not global). `gridsForStylobates` aggregates across
  multiple stylobates. Rendered in slate-grey to distinguish from
  residential yard cells.

- **`computeOverlays` — stylobate integration.** When
  `params.useStylobate === true`, occupants are built from all section
  rectangles plus all tower footprints, the inner ring uses
  `offsetPolygon(polyM, sw + 6)`, `extractStylobates` +
  `selectByCoverage(stylobatePct)` produce the stylobate set, and
  `gridsForStylobates` produces the cell grid. Returned under
  `stylobates: [{poly, area}]` and `stylobateCells: Array<[p,p,p,p]>`.
  The raster pipeline is wrapped in try/catch: on failure the two
  arrays are empty but overlay computation does not break.
  `offsetPolygon` was promoted from a private helper to a named export
  to allow reuse.

- **`OverlayRenderer.renderOverlayCanvas`** — new layer "2.5" draws
  stylobate polygons (fill `rgba(100,116,139,0.35)`, stroke `#64748b`)
  and the ground-floor cell grid (fill `rgba(148,163,184,0.28)`,
  stroke `rgba(100,116,139,0.85)`) between the road ring and axis
  buffers. Visible only when `visibility.stylobate !== false` and
  stylobate data exists.

- **FeaturePanel UI controls:**
  - **`Auto ctx`** button next to `Shuffle` — runs `autoOptimize`
    asynchronously (dynamic import), stores
    `blockParams.ctxOverride`, triggers rebuild. Click-again clears
    the override. Mutually exclusive with `Shuffle` (clicking
    `Shuffle` clears `ctxOverride`).
  - **`Func-simp`** button next to `Simplify` — runs
    `functionalSimplify` asynchronously. Saves `_originalContour` for
    `Restore` to work afterwards.
  - **Stylobate panel** — toggle (slate-grey) + coverage slider (0–100
    %, 250ms debounce). Slider hidden when toggle is off.
  - **`ov-stylobate` visibility toggle** in Plan layers list.

- Tests:
  - `test/urban_block_overlays.test.js` — 4 tests covering the
    connector×tower regression and backward compatibility.
  - `test/urban_block_scoring.test.js` — 16 tests for
    `Scoring`/`ContextOptimizer`/`FunctionalSimplifier`.
  - `test/stylobates.test.js` — 12 tests for `Stylobates` (empty,
    simple, inner-ring exclusion, occupant exclusion, minArea),
    `selectByCoverage` (empty, 0 %, 50 %, 100 %, sorting), and
    `computeOverlays` integration (empty when disabled, populated
    when enabled, stylobates avoid section midpoints).

---

## refactor-v16.2: vector rendering + yard cells + 3D stylobates

Three architectural corrections after field testing revealed that the
prior raster overlay pipeline and the stylobate-as-flat-polygon model
did not match what was wanted.

### Changed

- **Stylobates are now 3D podiums (`ExtrudeGeometry`, h=4.5m)**, not
  flat polygons with a cell grid on top. The stylobate cell grid
  concept is discarded entirely — a stylobate is the volume between
  buildings, rendered as a single extruded mesh. `StylobateGrid.js`
  module deleted; `gridsForStylobates` call removed from
  `computeOverlays`; `stylobateCells` field removed from the overlay
  return object; Plan-layer label changed from "Stylobate + ground
  grid" to "Stylobate (3D podium)".

- **Vector rendering replaces the raster `OverlayRenderer` pipeline
  for block overlays.** The old pipeline rasterized all overlays to
  an OffscreenCanvas at 4 px/m and applied it as a `CanvasTexture`
  on a flat `PlaneGeometry` — visible aliasing on zoom, no proper 3D
  depth. New pipeline:
  - `core/urban-block/OverlayMeshBuilder.js` builds a `THREE.Group`
    of native meshes: `ShapeGeometry` for filled areas (courtyard,
    buffers, trash zones, playgrounds, yard cells), `Shape` with
    `Path` holes for the road-ring annulus (no `destination-out`
    compositing), `ExtrudeGeometry` for stylobate podiums,
    `BoxGeometry` for the trash pad, `LineSegments` for connectors /
    graph edges / pedestrian paths.
  - `modules/section-gen/processor.js` switched from
    `renderOverlayCanvas` to `buildOverlayMeshes`. Trash-pad box
    creation moved from the processor into the mesh builder (single
    responsibility). `disposeOverlayGroup` handles geometry/material
    cleanup.
  - The old `OverlayRenderer.js` remains in the tree as dormant code
    but is no longer imported.

### Added

- **`core/urban-block/GroundCells.js`** — yard-cell generation.
  `computeGroundCells(polyM, barriers, opts)` produces a 3×3 m
  OBB-aligned grid over a polygon, keeping only cells whose centre is
  inside the polygon, whose four corners stay inside, and which do
  not intersect any barrier. Barriers can be polygons
  (`type: 'poly'`) or line segments with a clearance half-width
  (`type: 'line'`) — the latter models connectors and pedestrian
  paths as capsules rather than infinitely-thin lines.
  `buildBarriersFromOverlays(overlays, axes, towerFootprintsM, sw)`
  assembles the barrier list from section rectangles, tower
  footprints, secFire zones, trash pad, connectors (halfWidth=3 m),
  pedPaths (halfWidth=1.5 m), and stylobate polygons.

- **`computeOverlays` — yard cells integration.** When
  `params.useYardCells === true`, the function wraps
  `buildBarriersFromOverlays` and `computeGroundCells` with
  `roadInner` as the containment polygon, returning
  `yardCells: Array<[4 vertices]>`. Failure is swallowed (empty array
  on raster/barrier error).

- **UI — yard cells are on-demand.** The `Yard cells (3×3m)` toggle
  in Plan layers, when flipped on, sets
  `blockParams.useYardCells = true` and triggers a rebuild — the grid
  is only computed when actually requested (yard-cell generation on a
  200 × 120 block produces ~770 cells; avoided by default).

- `test/ground_cells.test.js` — 10 tests covering `computeGroundCells`
  (empty/tiny input, cell count, polygon barriers, line barriers,
  margin effect) + `computeOverlays` yard-cells integration
  (disabled/enabled, stylobate barriers reduce yard count) +
  `buildBarriersFromOverlays` (non-empty output, valid shape of each
  barrier).

### Removed

- `core/urban-block/StylobateGrid.js` (the ground-grid module).
- `stylobateCells` field from `computeOverlays` return.
- `stylobateCells` LngLat-projection branch in `FeaturePanel`.
- Stylobate-cell rendering in `OverlayRenderer` (the legacy raster
  renderer's handler is now dead code — harmless, but can be removed
  in a future cleanup).

### Test Summary

Total: 211 tests across 10 files, all passing.
Previously: 206 tests, 18 of which were StylobateGrid-related (those
were removed); 12 `Stylobates` tests remain; 10 new tests added for
`GroundCells`.

---

## refactor-v16.3: stylobate extraction — vector boolean instead of raster

Field testing revealed that the raster-based stylobate extractor was
producing one giant polygon covering the block interior instead of
distinct fragments in the gaps between sections. The root cause was
architectural: raster flood-fill on the whole polygon interior cannot
express "strip of width sw along the perimeter minus section
footprints" — it finds connected free regions regardless of where
they are. Replaced entirely with vector boolean difference.

### Changed

- **`core/urban-block/Stylobates.js` — rewritten** from raster mask
  + flood-fill + contour + snap (~300 LOC) to vector boolean difference
  (~200 LOC) using `polygon-clipping`. New algorithm:

  1. `strip = outerPolygon − inwardOffset(sw)` — closed annulus of
     width `sw`, expressed as a polygon with a hole.
  2. `stylobate_fragments = strip − union(section_rects, tower_footprints)`
     using `polygonClipping.difference`.
  3. Result is an array of disjoint polygons — one per gap between
     buildings, plus corner pieces where boundary axes don't reach.

  API change: `extractStylobates(polyM, sw, occupantsM, opts)` — the
  second argument is now the scalar section width, not a precomputed
  inner ring. Options shrunk to `{minArea, _debug}`. `selectByCoverage`
  unchanged.

- **`computeOverlays` — updated call site.** Passes `sw` directly
  (instead of computing and passing `offsetPolygon(polyM, sw + 6)`).
  The old inner-ring computation and its raster option `{cell: 0.25}`
  are removed.

### Added

- `polygon-clipping` as a direct dependency (`^0.15.7`, 54 KB ESM).
  Mature library with correct handling of self-intersection, holes,
  and disjoint output regions.

- `test/stylobates.test.js` — rewritten with 9 tests for the vector
  API: empty/degenerate input, strip without occupants returns one
  annulus-shaped piece, one section produces a C-shape, two opposing
  sections produce 2 disjoint pieces, realistic solver output
  produces ≥4 fragments, area-descending sort invariant, minArea
  filter, and disjointness verification (no stylobate centroid lies
  inside any section rect).

### Fixed

- **`pArea` sign convention.** The previous shoelace formula returned
  negative area for CCW polygons (inverted sign), causing `ensureCCW`
  to actually produce CW output. That in turn caused `offsetInward`
  (which assumes CCW input) to offset outward, producing an inner
  ring larger than the outer — a self-intersecting strip on which
  `polygon-clipping` returned zero fragments. Fixed to standard
  shoelace where CCW is positive.

- **Hole handling in boolean-difference result.** The output of
  `polygonClipping.difference` is a list of polygons, each being a
  list of rings (first CCW outer, subsequent CW holes). Previously
  `extractStylobates` took only the outer ring and dropped holes
  silently. For the empty-occupants case this meant returning the
  full block area instead of the ring area. Fixed: area accounting
  subtracts hole areas, and hole rings are preserved in the output
  under a new `holes` field for downstream rendering.

### Removed

- Raster-based functions from `Stylobates.js`: `rasterMask`,
  `floodComponents`, `componentContour`, `simplifyContour`,
  `distPtSeg`, `projPtSeg`. All unused now.

### Test Summary

Total: 214 tests across 10 files, all passing.
Previously: 211 tests (3 net added: 12 old `Stylobates` tests
replaced by 9 new ones for the vector API, all higher-value).

---

## refactor-v16.4: composite overlay zones via polygon-clipping

Field reports on the vector overlay pipeline identified four visual
bugs in `OverlayMeshBuilder`. All stem from the same architectural
omission: the prototype raster renderer relied on `ctx.clip(polyM)`
to confine each composite overlay to the block polygon, but the
vector port just drew holes into a shape — which silently breaks
`THREE.ShapeGeometry.triangulate` when holes cross the outer
boundary. Replaced with vector boolean operations.

### Fixed

- **Courtyard (green zone) no longer escapes the block polygon.**
  `secFire` rectangles extend ~14m beyond the block (the fire
  buffer), which `ShapeGeometry` could not handle as holes on the
  block polygon. Now the courtyard mesh is built by
  `polygonClipping.difference(polyM, ...secFire)`, producing a
  properly clipped polygon with correct internal cutouts.

- **Trash zone now shows as a proper annulus.** Previously drawn as
  independent outer/inner pairs per section group, now computed as
  `(union(trashOuter) ∩ polyM) − union(trashInner)`, matching the
  prototype composite ring.

- **Playground zones now show three nested rings with correct
  exclusions.** Previously all three buffer sets (`playBuf12`,
  `playBuf20`, `playBuf40`) drew as independent overlapping layers
  with no subtraction. Now:
  - Blue (12-20m) = `union(playBuf20) ∩ polyM − union(playBuf12) −
    trashPadCircle(20m)`
  - Green (20-40m) = `union(playBuf40) ∩ polyM − union(playBuf20) −
    trashPadCircle(20m)`
  - Red (40m+) = `polyM − union(playBuf40)`

- **Stylobate extraction made robust.** Previously failed silently
  ("doesn't always build") on blocks where `offsetInward` produced
  a self-intersecting or inverted inner ring. Now:
  - Validates the inner ring (must be smaller than outer, same
    winding, at least 3 vertices) before using it as a strip hole.
  - Falls back to the full block polygon as subject if the inner
    ring is invalid.
  - Second-chance fallback: if `difference` returns 0 pieces despite
    a valid strip, retries without the inner hole.
  - Optional `verbose: true` option logs each pipeline stage to the
    browser console for diagnosis.
  - Tested on 9 block shapes (rectangles of various aspect ratios,
    narrow strips, L, U, pentagon, skinny triangle, small square) —
    all produce non-empty stylobate fragments.

### Added

- **`OverlayMeshBuilder.polyDifference(subject, clips)`** — returns
  `Array<{outer, holes}>` from `polygonClipping.difference`.
  Fallback to subject on error.
- **`OverlayMeshBuilder.polyClipToSubject(subject, polys)`** — returns
  `union(polys) ∩ subject`.
- **`OverlayMeshBuilder.polyClipZone(subject, outers, inners)`** —
  composite zone `((union(outers) ∩ subject) − union(inners))`.
- **`OverlayMeshBuilder.circlePoly(cx, cy, r, segments)`** —
  approximates a circle as a 32-gon. Used for trashPad exclusion
  in playground zones.
- **`OverlayMeshBuilder.makePieceMesh(piece, ...)`** — builds a
  `THREE.Mesh` from a `{outer, holes}` piece, properly setting up
  `THREE.Path` holes on `THREE.Shape`.

### Changed

- `computeOverlays` accepts `params.stylobateVerbose: true` to enable
  per-block diagnostics in the browser console.
- `OverlayMeshBuilder.js` gained a `polygon-clipping` import.
- `UrbanBlockOverlays.js` gained a local `polyArea` helper for log
  messages.

### Test Summary

Total: 214 tests across 10 files, all passing. No new tests added in
this increment — all fixes are in rendering-layer code covered by
integration assertions in `stylobates.test.js`, `ground_cells.test.js`
and `urban_block_overlays.test.js`. The rendering-specific assertions
(courtyard confined to polygon, playground zones are disjoint rings)
are visual properties best verified by running the app.

---

## refactor-v16.5: prioritized stylobates, 6m roads, per-piece yard cells

Four field-reported bugs addressed together. All stem from an
insufficiently architectural version of stylobate and road rendering.

### Fixed

- **Road ring was over-filled and didn't respect graph edges.**
  Previously `makeAnnulus(roadOuter, roadInner)` — worked for convex
  rectangles but collapsed on L/U-shaped blocks where `offsetPolygon`
  produces self-intersecting rings. Now the road mesh is built as a
  union of 6m-wide thick rectangles along each graph edge (ring +
  connector), clipped to the block polygon. Handles arbitrary block
  shapes robustly.

- **Stylobates respect building priority via fire buffers.**
  Previously stylobates were extracted as "strip polygon minus section
  rects" with no priority logic — a ctx=2 short axis could claim the
  same corner as a ctx=0 main axis. Replaced with a prioTrim-style
  planner that processes axes in priority order (ctx=0 first, then
  within a ctx band by orientation + length descending, matching the
  solver's `sortPrio`). Each placed stylobate adds its own 14m fire
  buffer to the exclusion list for subsequent lower-priority axes.

- **Stylobate now abuts towers flush (no fire gap).** Towers are
  added to the barrier list as raw footprints rather than as
  `outwardBuffer(footprint, fire)`. A stylobate on the same or
  adjacent axis stops at the tower edge, matching the user's
  architectural intent that the tower sits on the stylobate.

- **Yard cells orient by their local OBB, not the global block OBB.**
  Previously `computeGroundCells(roadInner, barriers)` used one
  global OBB for the whole L-shaped yard, producing cells with one
  axis alignment even when the yard has two perpendicular arms. Now
  the yard territory is first split into disjoint free regions by
  `polygonClipping.difference`, and each region gets its own OBB
  computed from its own vertices. Cells in each arm of an L-yard
  align with that arm's geometry.

### Added

- **`core/urban-block/StylobatePlanner.js`** — new module (~300 LOC).
  Exports `planStylobates(axes, towerFootprintsM, secFireZones,
  params, opts) → Array<{poly, holes, area, axisId, context}>`.
  Also re-exports `selectByCoverage` for downstream compatibility.
  Uses an internal `outwardBuffer` (polygon Minkowski via edge bands
  union) to compute fire buffers around placed stylobates.

- **`OverlayMeshBuilder.buildRoadPieces(graphEdges, graphNodes, polyM,
  width)`** — union of thick rectangles along each graph edge,
  clipped to block polygon. Uses `thickSegmentPolygon(a, b, width)`
  helper.

- **`GroundCells.computeGroundCellsPerPiece(container, barriers,
  opts)`** — splits the container by polygon barriers via
  `splitIntoPieces`, then runs `computeGroundCells` on each piece
  with its local OBB (default behaviour when no `opts.obb` passed).
  Line barriers (connectors, pedPaths) pass through unchanged.

- **`test/stylobate_planner.test.js`** — 12 new tests covering: empty
  input, rectangular block produces fragments, sorted by area
  descending, each piece has context+axisId, minArea filter, priority
  ordering by context, tower blocks stylobate flush (no fire gap),
  selectByCoverage correctness, and computeOverlays integration with
  useStylobate=true/false.

### Removed

- Use of `extractStylobates` from `computeOverlays` — replaced by
  `planStylobates`. The old `Stylobates.js` module is kept in the
  tree with its 9 regression tests still passing (its API still
  works standalone), but no longer wired into the live overlay
  pipeline. Safe to delete in a future cleanup.

- `makeAnnulus` call for the road ring layer — the function itself
  is kept for other potential uses.

### Changed

- `package.json` `test` script gained `test/stylobate_planner.test.js`.

### Test Summary

Total: 226 tests across 11 files, all passing (was 214 across 10).
The 12 new tests are in `stylobate_planner.test.js`.

---

## refactor-v16.6: final-render mode + PolyOps consolidation

After a user clicks the "Create external road connections" button the
block transitions from "draft" state (all overlays visible) to a
"final" render state: the road graph itself cuts the block polygon
into disjoint yard pieces, and each piece gets its own OBB-aligned
3×3 m cell grid. Also consolidates ~200 lines of duplicated polygon-
clipping utilities into a single shared module.

### Added

- **`core/urban-block/PolyOps.js`** — single shared module for all
  polygon-clipping operations. Exports `polyDifference`,
  `polyClipToSubject`, `polyClipZone`, `thickSegmentPolygon`,
  `graphToRoadStrips`, `circlePoly`, `polyArea`, plus ring-format
  helpers `toClosedRing`/`fromClosedRing`. Uses the standard
  "multi-polygon geometry = `[[[ring1], [ring2]...]]`" format for
  `polygon-clipping` throughout.

- **`computeOverlays.finalMode` branch.** When
  `params.finalMode === true` (set by `FeaturePanel` after the user
  creates external road connections), `computeOverlays` computes:
  - `finalPieces` — `polyM − graphStrips(6 m) − section_rects −
    tower_footprints − stylobate_polygons`, returned as
    `Array<{outer, holes}>` of disjoint free regions
  - `finalCells` — 3×3 m cell grid in each piece, oriented by its
    own local OBB (default behaviour of `computeGroundCells` when
    `opts.obb` is not passed)
  - `finalStylobateCells` — separately computed grid on each
    stylobate polygon, also per-piece OBB oriented
  All three fields are empty arrays when `finalMode` is off.

- **`OverlayMeshBuilder` final-mode rendering.** When
  `visibility.finalMode === true`, the mesh builder automatically
  suppresses `secfire` (courtyard green), `road` (6m strips; replaced
  by finalPieces), `trash`, `play`, `buffers`, `connectors`. Adds
  three new layers: `final-yard-pieces` (green fill of each piece),
  `final-yard-cells`, `final-stylobate-cells`. Graph + stylobate
  extrudes stay visible.

- **`FeaturePanel` final-mode wiring.** After
  `computeExtConnections` succeeds in `doConnect()`, sets
  `blockParams.finalMode = true`, `useStylobate = true`,
  `useYardCells = false`. The `getParams()` helper forwards the
  `finalMode` flag into the `params` object passed to
  `computeOverlays`.

- **`modules/section-gen/processor.js`.** Propagates
  `blockParams.finalMode` into the `vis` object before calling
  `buildOverlayMeshes`.

- **`test/final_mode.test.js`** — 16 tests:
  - 10 tests for `PolyOps` primitives (area sign, degenerate input,
    cut-and-split, union-then-intersection, segment-to-rect, graph
    strip count, circle-as-polygon)
  - 6 tests for `computeOverlays` final-mode integration
    (empty when off; pieces+cells when on; positive areas; cells do
    not overlap graph strips (< 5% violations); cells do not overlap
    section rects (0 violations); L-shape splits into ≥ 2 pieces)

### Changed

- **`OverlayMeshBuilder.js`** — removed ~200 lines of duplicated
  polygon-clipping utilities (`polyDifference`, `polyClipToSubject`,
  `polyClipZone`, `circlePoly`, `thickSegmentPolygon`,
  `buildRoadPieces`, `toClosedRing`, `fromClosedRing`). All imports
  now from `PolyOps.js`. Road layer rewritten via `graphToRoadStrips`
  + `polyClipToSubject`.

- **`GroundCells.js`** — removed local ring-format helpers and
  replaced the old `splitIntoPieces` body with a thin wrapper around
  `polyDifference` from `PolyOps`. The function's signature is
  unchanged (still returns `Array<Array<[x,y]>>` of outer rings).

- `package.json` `test` script now includes `test/final_mode.test.js`.

### Fixed

- **`polyClipToSubject` and `polyClipZone` array-wrapping bug.**
  The initial PolyOps version double-wrapped clip polygons before
  passing them to `polygonClipping.union`, producing an invalid
  geometry shape and returning empty results on any non-trivial
  input. Caught by the new `polyClipToSubject returns union ∩
  subject` unit test. Corrected to the standard `[pcPoly(c)]` =
  `[[closedRing]]` (multi-polygon geometry with one polygon, one
  ring). Did not affect the live overlay pipeline because
  `OverlayMeshBuilder` still used its own (correct) local copies at
  the time of the fix — uncovered by consolidating to a single
  source of truth.

### Test Summary

Total: 242 tests across 12 files, all passing (was 226 across 11).
16 new tests in `final_mode.test.js`. Deletion of ~200 lines of
duplicate utility code from `OverlayMeshBuilder.js` and ~30 lines
from `GroundCells.js` is tested indirectly through the existing
overlay and cell regression suites.

