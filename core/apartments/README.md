# Apartment Solver Architecture

## Active Pipeline

```
processor.js
  └─ ApartmentSolver.solveFloor()    — floor 1 (all 1K, max WZ)
  └─ WZPlanner.planWZStacks()        — WZ vertical stacks from floor 1
  └─ BuildingPlanner.planBuilding()  — orchestrator for floors 2+
       └─ TrajectoryPlanner.planMergeSchedule()  — cascade-aware merge scheduling
       └─ MergePlanner.planFloorByMerge()        — copy prev → merge → rebalance
```

### Modules

| Module            | Lines | Role                                          |
|-------------------|-------|-----------------------------------------------|
| ApartmentSolver   | ~1600 | Floor 1: topology → torec → near → far → orphan → regroup → downsize → split → wet pairing |
| WZPlanner         | 151   | WZ stack extraction + orphan constraint validation (lat/lon) |
| BuildingPlanner   | 179   | Orchestrator v8: cumulative tracking, no-drift quota, dynamic per-floor target |
| MergePlanner      | 934   | Floors 2+: deep copy → score merge pairs → execute → dynamic rebalance |
| QuotaResolver     | 446   | Diophantine solver: Σ n_t·w_t = C, O(1) for C>300 |
| TrajectoryPlanner | 154   | Cascade multiplier: ideal WZ profile → per-floor merge schedule |
| QuotaAllocator    | ~157  | Cross-section quota distribution |
| FloorPlanner      | ~1270 | **Alternative strategy** for upper floors (WZ-centric SWEEP + NORMALIZE) |

### Strategy Choice

**MergePlanner** (active): top-down approach. Copies floor 1 layout, merges adjacent
apartments to grow types. Natural WZ deactivation, no orphan risk. Best for smooth
building profiles.

**FloorPlanner** (alternative): bottom-up approach. Places WZ first, then sweeps
remaining cells into apartments with quota-aware caps. Better composition-level control,
but more complex edge-case handling. Use when precise per-floor type distribution matters.

## `_archive/`

Retired modules (not imported anywhere). Kept for reference:

- **BuildingPlanner_v7_merge.js** (149 lines) — v7 with incremental remaining (drift bug). Replaced by v8.
- **FloorPacker.js** (799 lines) — Composition-based partition enumeration. Superseded by MergePlanner.
- **MidPlanner.js** (696 lines) — Mid-segment solver. Logic absorbed into FloorPlanner phases.
- **TorecPlanner.js** (542 lines) — Torec builder. Logic inlined in FloorPlanner.buildTorecApt.
