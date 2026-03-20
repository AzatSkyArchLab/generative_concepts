/**
 * LineTool — draw polylines
 *
 * Click to add points, double-click or Enter to complete (min 2 pts),
 * Backspace to remove last point, Escape to cancel.
 */

import { eventBus } from '../../core/EventBus.js';
import { BaseDrawTool } from './BaseTool.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';

export class LineTool extends BaseDrawTool {
  /**
   * @param {Object} manager
   * @param {import('../../data/FeatureStore.js').FeatureStore} featureStore
   */
  constructor(manager, featureStore) {
    super(manager);
    this.id = 'line';
    this.name = 'Line';
    this._featureStore = featureStore;
  }

  onMapDoubleClick(_e) {
    if (this._points.length > 0) {
      this._points.pop();
    }
    if (this._points.length >= 2) {
      this._complete();
    }
  }

  onKeyDown(e) {
    if (e.key === 'Enter' && this._points.length >= 2) {
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

    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords }
    };
  }

  _complete() {
    if (this._points.length < 2) return;

    var id = crypto.randomUUID();
    var line = {
      type: 'Feature',
      properties: {
        id: id,
        type: 'line',
        createdAt: new Date().toISOString()
      },
      geometry: {
        type: 'LineString',
        coordinates: this._points.slice()
      }
    };

    commandManager.execute(new AddFeatureCommand(this._featureStore, line));
    eventBus.emit('draw:line:complete', line);

    this._reset();
    this._manager.clearPreview();
  }
}
