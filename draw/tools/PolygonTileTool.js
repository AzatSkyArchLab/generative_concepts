/**
 * PolygonTileTool — draw a closed polygon contour for the v2 section
 * generator (parallel branch to UrbanBlockTool).
 *
 * Same input model as PolygonTool (click to add points, double-click /
 * Enter to finish min 3 pts, Backspace to drop last, Escape to cancel).
 * Produces a `polygon-tile` feature with the prototype's parameter
 * defaults baked into `properties.tileParams`. The downstream
 * processor (modules/polygon-tile/, not yet implemented) reads those
 * params and runs the cells → wedges → sections pipeline from the
 * prototype around the polygon's CW-normalised perimeter.
 *
 * Defaults match the prototype exactly. `side` is not used for
 * polygons — the inside of the polygon is always the extrusion side
 * (after CW normalisation in the processor).
 *
 * Coexistence: UrbanBlockTool keeps its own feature type
 * (`urbanBlock: true` on a polygon), so the existing v1 pipeline is
 * unaffected.
 */

import { eventBus } from '../../core/EventBus.js';
import { BaseDrawTool } from './BaseTool.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';

export class PolygonTileTool extends BaseDrawTool {
  /**
   * @param {Object} manager
   * @param {import('../../data/FeatureStore.js').FeatureStore} featureStore
   */
  constructor(manager, featureStore) {
    super(manager);
    this.id = 'polygon-tile';
    this.name = 'Polygon Tile';
    this._featureStore = featureStore;
  }

  onMapDoubleClick(_e) {
    if (this._points.length > 0) this._points.pop();
    if (this._points.length >= 3) this._complete();
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
    if (coords.length < 3) {
      return {
        type: 'Feature',
        properties: { type: 'polygon-tile' },
        geometry: { type: 'LineString', coordinates: coords }
      };
    }
    return {
      type: 'Feature',
      properties: { type: 'polygon-tile' },
      geometry: {
        type: 'Polygon',
        coordinates: [coords.concat([coords[0]])]
      }
    };
  }

  _complete() {
    if (this._points.length < 3) return;
    var id = crypto.randomUUID();
    var feature = {
      type: 'Feature',
      properties: {
        id: id,
        type: 'polygon-tile',
        createdAt: new Date().toISOString(),
        // Параметры солвера v2 — копия дефолтов прототипа.
        tileParams: {
          step: 3.3,
          depth: 8.0,
          buffer: 2.0,
          rows: 3,
          // `side` для полигона процессором игнорируется — всегда внутрь.
          cornerR: 20.0
        }
      },
      geometry: {
        type: 'Polygon',
        coordinates: [this._points.concat([this._points[0]])]
      }
    };
    commandManager.execute(new AddFeatureCommand(this._featureStore, feature));
    eventBus.emit('draw:polygon-tile:complete', feature);
    this._reset();
    this._manager.clearPreview();
    // Drop back to Select so the user can click section-start markers
    // to iterate through grouping variants — clicks while this tool
    // is active would otherwise try to start a new polygon.
    this._manager.deactivateTool();
  }
}
