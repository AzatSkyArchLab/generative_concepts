/**
 * PolylineTileTool — draw a polyline-axis for the v2 section
 * generator (parallel branch to SectionChainTool).
 *
 * Same input model as LineTool (click to add points, double-click /
 * Enter to finish, Backspace to drop the last, Escape to cancel).
 * Produces a `polyline-tile` feature with the prototype's parameter
 * defaults baked into `properties.tileParams`. The downstream
 * processor (modules/polyline-tile/, not yet implemented) reads
 * those params and runs the cells → wedges → sections pipeline from
 * the prototype.
 *
 * Defaults match the prototype exactly:
 *   step = 3.0 m, depth = 6.0 m, buffer = 2.0 m, rows = 1, side = 'left',
 *   cornerR = 20 m, postIter = 5
 *
 * Coexistence: SectionChainTool keeps its own feature type
 * (`section-chain`), so the existing v1 pipeline is unaffected.
 */

import { eventBus } from '../../core/EventBus.js';
import { BaseDrawTool } from './BaseTool.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';

export class PolylineTileTool extends BaseDrawTool {
  /**
   * @param {Object} manager
   * @param {import('../../data/FeatureStore.js').FeatureStore} featureStore
   */
  constructor(manager, featureStore) {
    super(manager);
    this.id = 'polyline-tile';
    this.name = 'Polyline Tile';
    this._featureStore = featureStore;
  }

  onMapDoubleClick(_e) {
    if (this._points.length > 0) this._points.pop();
    if (this._points.length >= 2) this._complete();
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
      properties: { type: 'polyline-tile' },
      geometry: { type: 'LineString', coordinates: coords }
    };
  }

  _complete() {
    if (this._points.length < 2) return;
    var id = crypto.randomUUID();
    var feature = {
      type: 'Feature',
      properties: {
        id: id,
        type: 'polyline-tile',
        createdAt: new Date().toISOString(),
        // Параметры солвера v2 — копия дефолтов прототипа. Меняются
        // через будущую панель параметров; имена совпадают с
        // прототипом для прозрачного переноса алгоритма.
        tileParams: {
          step: 3.3,         // м, шаг ячейки вдоль ребра
          depth: 8.0,        // м, ширина/длина ячейки (глубина ряда)
          buffer: 2.0,       // м, толщина коридора между outer и inner
          rows: 3,           // 3 = outer + corridor + inner (полная структура)
          side: 'left',      // 'left' | 'right' — сторона выдавливания
          cornerR: 20.0      // м, угловая окружность (визуал)
        }
      },
      geometry: {
        type: 'LineString',
        coordinates: this._points.slice()
      }
    };
    commandManager.execute(new AddFeatureCommand(this._featureStore, feature));
    eventBus.emit('draw:polyline-tile:complete', feature);
    this._reset();
    this._manager.clearPreview();
    // Drop back to Select so the user can click section-start markers
    // to iterate through grouping variants — clicks while this tool
    // is active would otherwise try to start a new polyline.
    this._manager.deactivateTool();
  }
}
