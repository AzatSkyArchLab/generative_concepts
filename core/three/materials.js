/**
 * Materials — shared Three.js materials for section rendering.
 */

import * as THREE from 'three';

export var MATERIALS = {
  commercial:    new THREE.MeshLambertMaterial({ color: 0xffb74d, side: THREE.DoubleSide }),
  apartment:     new THREE.MeshLambertMaterial({ color: 0xdce8f0, side: THREE.DoubleSide }),
  corridor:      new THREE.MeshLambertMaterial({ color: 0xc8c8c8, side: THREE.DoubleSide }),
  llu:           new THREE.MeshLambertMaterial({ color: 0x4f81bd, side: THREE.DoubleSide }),
  commercial_f0: new THREE.MeshLambertMaterial({ color: 0xffb74d, side: THREE.DoubleSide }),
  apartment_f0:  new THREE.MeshLambertMaterial({ color: 0xffb74d, side: THREE.DoubleSide }),
  corridor_f0:   new THREE.MeshLambertMaterial({ color: 0xe0a040, side: THREE.DoubleSide }),
  llu_f0:        new THREE.MeshLambertMaterial({ color: 0x4f81bd, side: THREE.DoubleSide })
};

export var DIVIDER_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide });
export var EDGE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x666666 });
export var WIREFRAME_MATERIAL = new THREE.LineBasicMaterial({ color: 0x555555 });

export var WALL_MAT = new THREE.MeshLambertMaterial({ color: 0xf0f0f0, side: THREE.DoubleSide });
export var EXT_WALL_MAT = new THREE.MeshLambertMaterial({ color: 0x888888, side: THREE.DoubleSide });
export var GLASS_MAT = new THREE.MeshBasicMaterial({
  color: 0x6ec6e6, transparent: true, opacity: 0.45, side: THREE.DoubleSide
});
export var SLAB_MAT = new THREE.MeshLambertMaterial({ color: 0xbbbbbb, side: THREE.DoubleSide });
export var WIN_EDGE_MAT = new THREE.LineBasicMaterial({ color: 0x555555 });
export var TOP_CAP_MAT = new THREE.MeshLambertMaterial({ color: 0x444444, side: THREE.DoubleSide });

export function darkenColor(hexStr, factor) {
  var c = new THREE.Color(hexStr);
  c.r *= factor; c.g *= factor; c.b *= factor;
  return c;
}
