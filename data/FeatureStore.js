/**
 * FeatureStore — storage for drawn GeoJSON features
 *
 * Responsibilities:
 * - CRUD operations
 * - Emit events on changes
 * - Export / import GeoJSON
 */

import { eventBus } from '../core/EventBus.js';

export class FeatureStore {
  constructor() {
    /** @type {Map<string, Object>} */
    this._features = new Map();
  }

  /** @param {Object} feature - GeoJSON Feature with properties.id */
  add(feature) {
    const id = feature.properties && feature.properties.id;
    if (!id) {
      console.warn('FeatureStore: feature has no id, skipping');
      return;
    }
    this._features.set(id, feature);
    eventBus.emit('features:changed');
    eventBus.emit('feature:added', { id, feature });
  }

  /** @param {string} id @returns {boolean} */
  remove(id) {
    if (!this._features.has(id)) return false;
    this._features.delete(id);
    eventBus.emit('features:changed');
    eventBus.emit('feature:removed', { id });
    return true;
  }

  /** @param {string} id @returns {Object|undefined} */
  get(id) {
    return this._features.get(id);
  }

  /** @param {string} id @param {Object} updates */
  update(id, updates) {
    const f = this._features.get(id);
    if (!f) return false;
    Object.assign(f.properties, updates, { updatedAt: new Date().toISOString() });
    eventBus.emit('features:changed');
    eventBus.emit('feature:updated', { id, feature: f });
    return true;
  }

  /** @returns {Object} GeoJSON FeatureCollection */
  getAll() {
    return {
      type: 'FeatureCollection',
      features: Array.from(this._features.values())
    };
  }

  /** @returns {Array} */
  toArray() {
    return Array.from(this._features.values());
  }

  /** @returns {string[]} */
  getIds() {
    return Array.from(this._features.keys());
  }

  /** @param {string} id @returns {boolean} */
  has(id) {
    return this._features.has(id);
  }

  /** @returns {number} */
  count() {
    return this._features.size;
  }

  clear() {
    this._features.clear();
    eventBus.emit('features:changed');
    eventBus.emit('features:cleared');
  }

  /** @param {Object} geojson - FeatureCollection */
  import(geojson) {
    for (let i = 0; i < geojson.features.length; i++) {
      const f = geojson.features[i];
      if (f.properties && f.properties.id) {
        this._features.set(f.properties.id, f);
      }
    }
    eventBus.emit('features:changed');
    eventBus.emit('features:imported', { count: geojson.features.length });
  }

  /** @returns {string} GeoJSON string */
  export() {
    return JSON.stringify(this.getAll(), null, 2);
  }
}

export const featureStore = new FeatureStore();
