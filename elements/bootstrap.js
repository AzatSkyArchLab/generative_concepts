/**
 * Element registration — central place where every library-element
 * module is imported and handed to the registry. Called once at app
 * boot, before any module that depends on the registry runs.
 *
 * Keep this list flat and explicit: each entry is one import + one
 * register() call. New elements ship by adding two lines here.
 */

import { register } from './registry.js';
import towerResidentialV1 from './buildings/tower-residential-v1/index.js';

export function registerLibraryElements() {
  register(towerResidentialV1);
}
