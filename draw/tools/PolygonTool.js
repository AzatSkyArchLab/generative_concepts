/**
 * PolygonTool — draw polygons
 *
 * Click to add points, double-click or Enter to complete (min 3 pts),
 * Backspace to remove last point, Escape to cancel.
 */

import { eventBus } from '../../core/EventBus.js';
import { BaseDrawTool } from './BaseTool.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';

export class PolygonTool extends BaseDrawTool {
  /**
   * @param {Object} manager
   * @param {import('../../data/FeatureStore.js').FeatureStore} featureStore
   */
  constructor(manager, featureStore) {
    super(manager);
    this.id = 'polygon';
    this.name = 'Polygon';
    this._featureStore = featureStore;
  }

  onMapDoubleClick(_e) {
    // Remove extra point from the dblclick's second click
    if (this._points.length > 0) {
      this._points.pop();
    }
    if (this._points.length >= 3) {
      this._complete();
    }
  }

  onKeyDown(e) {
    if (e.key === 'Enter' && this._points.length >= 3) {
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

    // Line until 3 points
    if (coords.length < 3) {
      return {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords }
      };
    }

    // Closed polygon
    return {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [coords.concat([coords[0]])]
      }
    };
  }

  _complete() {
    if (this._points.length < 3) return;

    var id = crypto.randomUUID();
    var polygon = {
      type: 'Feature',
      properties: {
        id: id,
        type: 'polygon',
        createdAt: new Date().toISOString()
      },
      geometry: {
        type: 'Polygon',
        coordinates: [this._points.concat([this._points[0]])]
      }
    };

    commandManager.execute(new AddFeatureCommand(this._featureStore, polygon));
    eventBus.emit('draw:polygon:complete', polygon);

    this._reset();
    this._manager.clearPreview();
  }
}
