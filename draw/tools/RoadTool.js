/**
 * RoadTool — draw external road polylines.
 *
 * Identical to LineTool but creates features with type: 'road'.
 * Roads are used by "Connect to roads" in block properties.
 */

import { eventBus } from '../../core/EventBus.js';
import { BaseDrawTool } from './BaseTool.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';

export class RoadTool extends BaseDrawTool {
  constructor(manager, featureStore) {
    super(manager);
    this.id = 'road';
    this.name = 'Road';
    this._featureStore = featureStore;
  }

  onMapDoubleClick(_e) {
    if (this._points.length > 0) this._points.pop();
    if (this._points.length >= 2) this._complete();
  }

  onKeyDown(e) {
    if (e.key === 'Enter' && this._points.length >= 2) this._complete();
    else super.onKeyDown(e);
  }

  _getPreviewGeometry() {
    if (this._points.length === 0) return null;
    var coords = this._points.slice();
    if (this._tempPoint) coords.push(this._tempPoint);
    if (coords.length < 2) return null;
    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
  }

  _complete() {
    if (this._points.length < 2) return;
    var id = crypto.randomUUID();
    var road = {
      type: 'Feature',
      properties: { id: id, type: 'road', roadType: 0, roadWidth: 6, lanes: 2, createdAt: new Date().toISOString() },
      geometry: { type: 'LineString', coordinates: this._points.slice() }
    };
    commandManager.execute(new AddFeatureCommand(this._featureStore, road));
    eventBus.emit('draw:road:complete', road);
    this._reset();
    this._manager.clearPreview();
  }
}
