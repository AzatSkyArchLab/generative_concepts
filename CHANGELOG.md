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
