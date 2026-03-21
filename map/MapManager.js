/**
 * MapManager — creates and manages the MapLibre GL map instance
 */

import maplibregl from 'maplibre-gl';
import { eventBus } from '../core/EventBus.js';
import { Config } from '../core/Config.js';

export class MapManager {
  constructor(containerId) {
    this._containerId = containerId;
    this._map = null;
    this._currentBasemap = 'osm';
  }

  async init() {
    return new Promise((resolve, reject) => {
      try {
        this._map = new maplibregl.Map({
          container: this._containerId,
          style: this._createBaseStyle(),
          center: Config.map.center,
          zoom: Config.map.zoom,
          minZoom: Config.map.minZoom,
          maxZoom: Config.map.maxZoom,
          pitch: Config.map.pitch,
          bearing: Config.map.bearing,
          antialias: true
        });

        this._map.on('load', () => {
          this._setupMapEvents();
          eventBus.emit('map:loaded');
          resolve();
        });

        this._map.on('error', (e) => {
          if (e.error && e.error.message && e.error.message.includes('tile')) return;
          if (e.sourceId) return;
          console.error('Map error:', e);
          reject(e);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  _createBaseStyle() {
    return {
      version: 8,
      glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
      sources: {
        'osm': {
          type: 'raster',
          tiles: [Config.basemaps.osm],
          tileSize: 256,
          attribution: '&copy; OpenStreetMap contributors'
        },
        'esri-satellite': {
          type: 'raster',
          tiles: [Config.basemaps.esriSatellite],
          tileSize: 256,
          attribution: '&copy; Esri'
        }
      },
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: { 'background-color': Config.map.style.backgroundColor }
        },
        {
          id: 'osm-tiles',
          type: 'raster',
          source: 'osm',
          minzoom: 0,
          maxzoom: 19
        },
        {
          id: 'satellite-tiles',
          type: 'raster',
          source: 'esri-satellite',
          minzoom: 0,
          maxzoom: 19,
          layout: { visibility: 'none' }
        }
      ]
    };
  }

  _setupMapEvents() {
    var m = this._map;
    if (!m) return;

    m.on('click', function (e) {
      eventBus.emit('map:click', { lngLat: e.lngLat, point: e.point });
    });

    m.on('dblclick', function (e) {
      eventBus.emit('map:dblclick', { lngLat: e.lngLat, point: e.point });
    });

    m.on('mousemove', function (e) {
      eventBus.emit('map:mousemove', { lngLat: e.lngLat, point: e.point });
    });

    m.on('moveend', function () {
      eventBus.emit('map:moveend', {
        center: m.getCenter(),
        zoom: m.getZoom(),
        bounds: m.getBounds()
      });
    });
  }

  setBasemap(type) {
    if (!this._map) return;
    this._currentBasemap = type;
    this._map.setLayoutProperty('osm-tiles', 'visibility', type === 'osm' ? 'visible' : 'none');
    this._map.setLayoutProperty('satellite-tiles', 'visibility', type === 'satellite' ? 'visible' : 'none');
    eventBus.emit('map:basemap:changed', { type });
  }

  getBasemap() { return this._currentBasemap; }

  addGeoJSONSource(id, data) {
    if (!this._map || this._map.getSource(id)) return;
    this._map.addSource(id, { type: 'geojson', data });
  }

  updateGeoJSONSource(id, data) {
    if (!this._map) return;
    var src = this._map.getSource(id);
    if (src) src.setData(data);
  }

  addLayer(spec, beforeId) {
    if (!this._map || this._map.getLayer(spec.id)) return;
    this._map.addLayer(spec, beforeId);
  }

  removeLayer(id) {
    if (!this._map || !this._map.getLayer(id)) return;
    this._map.removeLayer(id);
  }

  setLayoutProperty(layerId, name, value) {
    if (!this._map) return;
    this._map.setLayoutProperty(layerId, name, value);
  }

  setPaintProperty(layerId, name, value) {
    if (!this._map) return;
    this._map.setPaintProperty(layerId, name, value);
  }

  setFilter(layerId, filter) {
    if (!this._map) return;
    this._map.setFilter(layerId, filter);
  }

  setCursor(cursor) {
    var canvas = this._map ? this._map.getCanvas() : null;
    if (canvas) canvas.style.cursor = cursor;
  }

  queryRenderedFeatures(point, options) {
    if (!this._map) return [];
    return this._map.queryRenderedFeatures(point, options);
  }

  getMap() { return this._map; }
  getZoom() { return this._map ? this._map.getZoom() : Config.map.zoom; }
  getCenter() { return this._map ? this._map.getCenter() : null; }
  getPitch() { return this._map ? this._map.getPitch() : 0; }
  getBearing() { return this._map ? this._map.getBearing() : 0; }

  flyTo(center, zoom) {
    if (this._map) this._map.flyTo({ center, zoom });
  }

  fitBounds(bounds, padding) {
    if (this._map) this._map.fitBounds(bounds, { padding: padding || 50 });
  }

  resetNorth() {
    if (this._map) this._map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
  }

  disableDoubleClickZoom() {
    if (this._map) this._map.doubleClickZoom.disable();
  }
}