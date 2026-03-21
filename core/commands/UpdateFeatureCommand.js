/**
 * UpdateFeatureCommand — undoable property update on a feature.
 * Stores old and new values for rollback.
 */

export class UpdateFeatureCommand {
  /**
   * @param {FeatureStore} store
   * @param {string} featureId
   * @param {Object} newProps - { key: value } to apply
   * @param {Object} oldProps - { key: value } before change (for undo)
   */
  constructor(store, featureId, newProps, oldProps) {
    this._store = store;
    this._id = featureId;
    this._newProps = newProps;
    this._oldProps = oldProps;
  }

  execute() {
    this._store.update(this._id, this._newProps);
  }

  undo() {
    this._store.update(this._id, this._oldProps);
  }
}
