/**
 * RemoveFeatureCommand — removes a feature from the store (undoable)
 */

export class RemoveFeatureCommand {
  /**
   * @param {import('../../data/FeatureStore.js').FeatureStore} store
   * @param {string} id
   */
  constructor(store, id) {
    this._store = store;
    this._id = id;
    this._feature = null;
    this.description = 'Remove feature';
  }

  execute() {
    this._feature = this._store.get(this._id);
    this._store.remove(this._id);
  }

  undo() {
    if (this._feature) {
      this._store.add(this._feature);
    }
  }
}
