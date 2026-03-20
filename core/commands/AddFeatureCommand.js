/**
 * AddFeatureCommand — adds a feature to the store (undoable)
 */

export class AddFeatureCommand {
  /**
   * @param {import('../../data/FeatureStore.js').FeatureStore} store
   * @param {Object} feature - GeoJSON Feature
   */
  constructor(store, feature) {
    this._store = store;
    this._feature = feature;
    this._id = feature.properties.id;
    this.description = 'Add ' + (feature.properties.type || 'feature');
  }

  execute() {
    this._store.add(this._feature);
  }

  undo() {
    this._store.remove(this._id);
  }
}
