/**
 * MeshBuilder — barrel re-export.
 *
 * Split into focused modules:
 *   materials.js      — Three.js materials
 *   BoxGeometry.js    — low-level box geometry, edges, insetPoly
 *   Labels.js         — text sprites (cell, floor, detail)
 *   SectionMeshes.js  — wireframe, divider, cell/section meshes, upper floors
 *   DetailedFloor.js  — buildDetailedFloor1 with walls/windows/facades
 *
 * This barrel ensures existing imports remain unchanged:
 *   import { buildSectionMeshes, ... } from '../../core/three/MeshBuilder.js';
 */

export { buildBoxGeometry, buildBoxEdges, insetPoly } from './BoxGeometry.js';
export { buildCellLabelSprite, buildFloorLabel, buildDetailLabel } from './Labels.js';
export {
  buildSectionWireframe,
  buildDividerWall,
  buildCellMesh,
  buildCellMeshColored,
  buildSectionMeshes,
  buildUpperFloors
} from './SectionMeshes.js';
export { buildDetailedFloor1, buildLLURoof, buildDetailedTowerFloor1 } from './DetailedFloor.js';
