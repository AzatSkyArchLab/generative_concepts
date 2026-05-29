/**
 * LibraryPlaceTool — single-click placement for parametric library
 * elements (towers, sections, stylobates, …).
 *
 * Activation contract:
 *   drawManager.activateTool('library-place')
 *     ── before activating ──
 *     LibraryPlaceTool.pendingElementId = '<id-from-registry>'
 *     LibraryPlaceTool.pendingPreset    = '<preset-name>' | null
 *
 * On the first map click we create a Point feature carrying:
 *
 *   {
 *     type: 'library-element',
 *     elementId: <element id>,
 *     preset:    <preset name, optional>,
 *     elementParams: {},               // user overrides, empty at start
 *     rotation: 0,                     // degrees, applied outside element
 *   }
 *
 * The render side (modules/library-elements) sees the new feature
 * via `features:changed`, looks the element up in the registry,
 * resolves params (defaults + preset + user), and stamps the
 * Three.js meshes at the projected lng/lat.
 *
 * After the click we drop back to the SELECT tool — the spec asks
 * for *placement on click*, not a continuous stamping tool. The
 * caller can re-activate the tool for the next stamp.
 */

import { eventBus } from '../../core/EventBus.js';
import { Config } from '../../core/Config.js';
import { BaseTool } from './BaseTool.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';
import { log } from '../../core/Logger.js';

export class LibraryPlaceTool extends BaseTool {
  /**
   * @param {Object} manager  DrawManager
   * @param {Object} featureStore
   */
  constructor(manager, featureStore) {
    super(manager);
    this.id = 'library-place';
    this.name = 'Place library element';
    this.cursor = Config.cursors.crosshair;
    this._featureStore = featureStore;
  }

  activate() {
    super.activate();
    // The picker UI sets these statics right before activation.
    var elId = LibraryPlaceTool.pendingElementId;
    if (!elId) {
      log.debug('[LibraryPlaceTool] activated with no pending element — aborting');
      // Defer drop-back so the caller's activate() call returns first.
      var self = this;
      setTimeout(function () { self._manager.deactivateTool(); }, 0);
      return;
    }
    eventBus.emit('library-place:start', { elementId: elId });
  }

  deactivate() {
    super.deactivate();
    // Clear pending so a future plain activation doesn't accidentally
    // pick up the previous element.
    LibraryPlaceTool.pendingElementId = null;
    LibraryPlaceTool.pendingPreset = null;
    eventBus.emit('library-place:end');
  }

  onMapClick(e) {
    var elementId = LibraryPlaceTool.pendingElementId;
    if (!elementId) return;
    var preset = LibraryPlaceTool.pendingPreset || null;

    var id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'le-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

    var feature = {
      type: 'Feature',
      properties: {
        id: id,
        type: 'library-element',
        elementId: elementId,
        preset: preset,
        elementParams: {},
        rotation: 0,
        createdAt: new Date().toISOString()
      },
      geometry: {
        type: 'Point',
        coordinates: [e.lngLat.lng, e.lngLat.lat]
      }
    };

    commandManager.execute(new AddFeatureCommand(this._featureStore, feature));
    eventBus.emit('library-place:placed', { id: id, elementId: elementId, feature: feature });

    // Drop back to select — placement is a single-shot action.
    this._manager.deactivateTool();
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      this._manager.deactivateTool();
    }
  }
}

// Statics for handoff from the picker UI. Plain mutable globals
// (matching the pattern used by UrbanBlockTool/SectionTool toggles).
LibraryPlaceTool.pendingElementId = null;
LibraryPlaceTool.pendingPreset = null;
