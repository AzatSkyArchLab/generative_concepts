/**
 * BaseTool — base class for all tools (select, etc.)
 * BaseDrawTool — base class for drawing tools (polygon, line)
 *
 * Usage:
 * - Click to add points
 * - Backspace to remove last point
 * - Escape to cancel
 * - Subclass implements getPreviewGeometry() and complete()
 */

import { eventBus } from '../../core/EventBus.js';
import { Config } from '../../core/Config.js';

// ── BaseTool ───────────────────────────────────────────

export class BaseTool {
  /**
   * @param {Object} manager - IDrawManager interface
   */
  constructor(manager) {
    /** @type {string} */
    this.id = '';
    /** @type {string} */
    this.name = '';
    /** @type {string} */
    this.cursor = Config.cursors.default;
    this._manager = manager;
    this._isActive = false;
  }

  activate() {
    this._isActive = true;
    this._manager.setCursor(this.cursor);
    eventBus.emit('tool:activated', { id: this.id, cursor: this.cursor });
  }

  deactivate() {
    this._isActive = false;
    eventBus.emit('tool:deactivated', { id: this.id });
  }

  // Optional handlers — override in subclass
  onMapClick(e) {}
  onMapDoubleClick(e) {}
  onMapMouseMove(e) {}
  onKeyDown(e) {}
}

// ── BaseDrawTool ───────────────────────────────────────

export class BaseDrawTool extends BaseTool {
  constructor(manager) {
    super(manager);
    this.cursor = Config.cursors.crosshair;
    /** @type {Array<[number, number]>} */
    this._points = [];
    /** @type {[number, number]|null} */
    this._tempPoint = null;
  }

  activate() {
    super.activate();
    this._reset();
    eventBus.emit('draw:start');
  }

  deactivate() {
    super.deactivate();
    this._reset();
    this._manager.clearPreview();
    eventBus.emit('draw:end');
  }

  onMapClick(e) {
    const coord = [e.lngLat.lng, e.lngLat.lat];
    this._points.push(coord);
    this._manager.updatePreview(this._getPreviewGeometry());
    eventBus.emit('draw:point:added', { point: coord, total: this._points.length });
  }

  onMapMouseMove(e) {
    if (this._points.length === 0) return;
    this._tempPoint = [e.lngLat.lng, e.lngLat.lat];
    this._manager.updatePreview(this._getPreviewGeometry());
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      this._reset();
      this._manager.clearPreview();
      eventBus.emit('draw:cancelled');
    } else if (e.key === 'Backspace' && this._points.length > 0) {
      e.preventDefault();
      this._points.pop();
      this._manager.updatePreview(this._getPreviewGeometry());
      eventBus.emit('draw:point:removed', { total: this._points.length });
    }
  }

  _reset() {
    this._points = [];
    this._tempPoint = null;
  }

  /**
   * Get current preview geometry — override in subclass
   * @returns {Object|null} GeoJSON Feature
   */
  _getPreviewGeometry() {
    return null;
  }

  /**
   * Complete drawing — override in subclass
   */
  _complete() {}
}
