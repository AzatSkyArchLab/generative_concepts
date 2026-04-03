# Apartment Solver Architecture

## Active Pipeline

```
processor.js
  └─ ApartmentSolver.solveFloor()    — floor 1 (all 1K, max WZ)
  └─ WZPlanner.planWZStacks()        — WZ vertical stacks from floor 1
  └─ BuildingPlanner.planBuilding()  — orchestrator for floors 2+
       └─ MergePlanner.planFloorByMerge()  — copy prev → merge → rebalance
```

### Modules

| Module           | Lines | Role                                          |
|------------------|-------|-----------------------------------------------|
| ApartmentSolver  | 1587  | Floor 1: topology → torec → near → far → orphan → split → wet pairing |
| WZPlanner        | 152   | WZ stack extraction + orphan constraint validation (lat/lon) |
| BuildingPlanner  | 142   | Orchestrator: estimate total → global quota → floor-by-floor merge |
| MergePlanner     | 542   | Floors 2+: deep copy → score merge pairs → execute → rebalance |
| QuotaResolver    | 330   | Diophantine solver: Σ n_t·w_t = C, brute-force optimal |
| QuotaAllocator   | ~200  | Cross-section quota distribution |
| FloorPlanner     | 1264  | **Alternative strategy** for upper floors (WZ-centric SWEEP + NORMALIZE) |

### Strategy Choice

**MergePlanner** (active): top-down approach. Copies floor 1 layout, merges adjacent
apartments to grow types. Natural WZ deactivation, no orphan risk. Best for smooth
building profiles.

**FloorPlanner** (alternative): bottom-up approach. Places WZ first, then sweeps
remaining cells into apartments with quota-aware caps. Better composition-level control,
but more complex edge-case handling. Use when precise per-floor type distribution matters.

## `_archive/`

Retired modules (not imported anywhere). Kept for reference:

- **FloorPacker.js** (799 lines) — Composition-based partition enumeration. Superseded by MergePlanner.
- **MidPlanner.js** (696 lines) — Mid-segment solver. Logic absorbed into FloorPlanner phases.
- **TorecPlanner.js** (542 lines) — Torec builder. Logic inlined in FloorPlanner.buildTorecApt.

Total archived: 2037 lines.
