/**
 * InsolationRaycaster — Three.js raycasting adapter for insolation
 *
 * Bridges InsolationCalc (pure) with Three.js scene meshes.
 * Provides the `raycast(origin, direction)` function that InsolationCalc expects.
 */

import * as THREE from 'three';

var _raycaster = new THREE.Raycaster();

/**
 * Create a raycast function for a set of Three.js meshes.
 *
 * @param {Array<THREE.Mesh>} meshes - obstacle meshes
 * @param {number} [maxDistance=500]
 * @returns {Function} (origin: [x,y,z], direction: [x,y,z]) => distance|null
 */
export function createMeshRaycaster(meshes, maxDistance) {
  if (!maxDistance) maxDistance = 500;

  return function raycast(origin, direction) {
    var originVec = new THREE.Vector3(origin[0], origin[1], origin[2]);
    var dirVec = new THREE.Vector3(direction[0], direction[1], direction[2]).normalize();

    _raycaster.set(originVec, dirVec);
    _raycaster.far = maxDistance;
    _raycaster.near = 0.01;

    var intersections = _raycaster.intersectObjects(meshes, true);

    if (intersections.length > 0) {
      return intersections[0].distance;
    }

    return null;
  };
}

/**
 * Create a raycast function from raw mesh data (vertices + faces).
 * Builds a Three.js mesh internally — useful when meshes are not yet in scene.
 *
 * @param {Array<{vertices: Float32Array, indices: Uint32Array}>} meshDataArray
 * @param {number} [maxDistance=500]
 * @returns {Function} raycast function
 */
export function createRawMeshRaycaster(meshDataArray, maxDistance) {
  var meshes = [];

  for (var i = 0; i < meshDataArray.length; i++) {
    var data = meshDataArray[i];
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.vertices, 3));
    if (data.indices) {
      geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    }
    geo.computeBoundingSphere();

    var mat = new THREE.MeshBasicMaterial({ visible: false });
    var mesh = new THREE.Mesh(geo, mat);
    meshes.push(mesh);
  }

  return createMeshRaycaster(meshes, maxDistance);
}

/**
 * Helper: collect all meshes from a Three.js scene or group.
 *
 * @param {THREE.Object3D} root
 * @returns {Array<THREE.Mesh>}
 */
export function collectMeshes(root) {
  var meshes = [];
  root.traverse(function (child) {
    if (child.isMesh) meshes.push(child);
  });
  return meshes;
}
