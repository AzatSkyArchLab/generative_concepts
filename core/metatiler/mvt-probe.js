/**
 * mvt-probe — read source-layer names AND field keys from an MVT tile.
 *
 * Why
 * ---
 * MVT tile = PB container with named sub-layers. For each sub-layer
 * we need two things:
 *   - name    — so MapLibre style layers can bind to it
 *   - keys    — the list of attribute names, used by the main module
 *               to construct cross-field substring-search expressions
 *               (e.g. "highlight polygons where any attribute contains
 *               'жилая'").
 *
 * We parse just enough of the protobuf for those two fields; every
 * other field is skipped by wire type. No geometry decoding, no
 * values parsing.
 *
 * Scope
 * -----
 * Tile.layers = field 3 (length-delimited, repeated Layer messages)
 * Layer.name  = field 1 (string)
 * Layer.keys  = field 3 (repeated string)
 *
 * Wire types in brief:
 *   0 varint     1 fixed64     2 length-delimited     5 fixed32
 *
 * Compressed tiles
 * ----------------
 * Metapolis serves tiles with Content-Encoding: zstd. Modern browsers
 * auto-decode on the main-thread fetch path (Chrome 123+, Firefox 126+,
 * Safari 17.2+), so resp.arrayBuffer() yields decompressed bytes.
 */

// ── Public entry points ────────────────────────────────

/**
 * Fetch one tile and return per-layer info.
 *
 * @param {string} tileURL - fully resolved URL with no placeholders
 * @returns {Promise<Array<{name: string, keys: string[]}>>}
 */
export function probeTileForLayerInfo(tileURL) {
  return fetch(tileURL, { method: 'GET', credentials: 'omit' }).then(function (resp) {
    if (!resp.ok) {
      var err = new Error('HTTP ' + resp.status);
      err.status = resp.status;
      throw err;
    }
    return resp.arrayBuffer();
  }).then(function (buf) {
    if (!buf || buf.byteLength === 0) return [];
    return extractLayerInfo(new Uint8Array(buf));
  });
}

/**
 * Back-compat: return just the list of layer names.
 *
 * @param {string} tileURL
 * @returns {Promise<string[]>}
 */
export function probeTileForLayerNames(tileURL) {
  return probeTileForLayerInfo(tileURL).then(function (info) {
    var out = [];
    for (var i = 0; i < info.length; i++) out.push(info[i].name);
    return out;
  });
}

/**
 * Synchronous parser: extract per-layer info from an MVT buffer.
 *
 * @param {Uint8Array} buf
 * @returns {Array<{name: string, keys: string[]}>}
 */
export function extractLayerInfo(buf) {
  var results = [];
  var pos = 0;
  var end = buf.length;

  while (pos < end) {
    var tagRead = readVarint(buf, pos);
    pos = tagRead.pos;
    var fieldNum = tagRead.value >>> 3;
    var wireType = tagRead.value & 7;

    if (fieldNum === 3 && wireType === 2) {
      // Tile.layers — descend into the sub-message.
      var lenRead = readVarint(buf, pos);
      pos = lenRead.pos;
      var layerEnd = pos + lenRead.value;

      var layerName = null;
      var layerKeys = [];

      while (pos < layerEnd) {
        var innerTag = readVarint(buf, pos);
        pos = innerTag.pos;
        var innerField = innerTag.value >>> 3;
        var innerWire = innerTag.value & 7;

        if (innerField === 1 && innerWire === 2) {
          // Layer.name
          var nameLen = readVarint(buf, pos);
          pos = nameLen.pos;
          layerName = utf8Decode(buf, pos, nameLen.value);
          pos += nameLen.value;
        } else if (innerField === 3 && innerWire === 2) {
          // Layer.keys (repeated string — each appears with its own tag)
          var keyLen = readVarint(buf, pos);
          pos = keyLen.pos;
          layerKeys.push(utf8Decode(buf, pos, keyLen.value));
          pos += keyLen.value;
        } else {
          pos = skipField(buf, pos, innerWire);
        }
      }
      pos = layerEnd;

      if (layerName) results.push({ name: layerName, keys: layerKeys });
    } else {
      pos = skipField(buf, pos, wireType);
    }
  }

  return results;
}

/**
 * Back-compat: return just names from a buffer.
 *
 * @param {Uint8Array} buf
 * @returns {string[]}
 */
export function extractLayerNames(buf) {
  var info = extractLayerInfo(buf);
  var names = [];
  for (var i = 0; i < info.length; i++) names.push(info[i].name);
  return names;
}

/**
 * Convert lng/lat to XYZ tile coordinates.
 *
 * @returns {{z: number, x: number, y: number}}
 */
export function lngLatToTileXY(lng, lat, z) {
  var n = Math.pow(2, z);
  var normLng = ((lng + 180) % 360 + 360) % 360 - 180;
  var x = Math.floor((normLng + 180) / 360 * n);
  if (x < 0) x = 0;
  if (x >= n) x = n - 1;
  var latClamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  var latRad = latClamped * Math.PI / 180;
  var y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
  if (y < 0) y = 0;
  if (y >= n) y = n - 1;
  return { z: z, x: x, y: y };
}

// ── Protobuf primitives ────────────────────────────────

function readVarint(buf, pos) {
  var value = 0;
  var shift = 0;
  var b;
  while (pos < buf.length) {
    b = buf[pos++];
    if (shift < 28) {
      value |= (b & 0x7f) << shift;
    } else {
      value += (b & 0x7f) * Math.pow(2, shift);
    }
    if ((b & 0x80) === 0) return { value: value, pos: pos };
    shift += 7;
    if (shift >= 64) throw new Error('varint too long at pos ' + pos);
  }
  throw new Error('varint truncated at pos ' + pos);
}

function skipField(buf, pos, wireType) {
  if (wireType === 0) {
    while (pos < buf.length && (buf[pos] & 0x80) !== 0) pos++;
    return pos + 1;
  }
  if (wireType === 1) return pos + 8;
  if (wireType === 2) {
    var r = readVarint(buf, pos);
    return r.pos + r.value;
  }
  if (wireType === 5) return pos + 4;
  throw new Error('unsupported wire type ' + wireType + ' at pos ' + pos);
}

function utf8Decode(buf, pos, len) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(buf.subarray(pos, pos + len));
  }
  var s = '';
  for (var i = 0; i < len; i++) s += String.fromCharCode(buf[pos + i]);
  try { return decodeURIComponent(escape(s)); }
  catch (_e) { return s; }
}
