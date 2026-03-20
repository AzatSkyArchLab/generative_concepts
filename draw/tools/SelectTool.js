/**
 * SelectTool — default tool for selecting features on the map
 */

import { BaseTool } from './BaseTool.js';
import { Config } from '../../core/Config.js';

export class SelectTool extends BaseTool {
  /**
   * @param {Object} manager
   * @param {import('../../data/FeatureStore.js').FeatureStore} featureStore
   */
  constructor(manager, featureStore) {
    super(manager);
    this.id = 'select';
    this.name = 'Select';
    this.cursor = Config.cursors.grab;
    this._featureStore = featureStore;
  }

  onMapClick(e) {
    const hits = this._manager.queryFeaturesAtPoint(e.point);
    if (hits.length > 0) {
      const id = hits[0].properties.id;
      if (id) {
        this._manager.selectFeature(id);
        return;
      }
    }
    this._manager.clearSelection();
  }
}
