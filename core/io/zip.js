/**
 * Minimal ZIP encoder for "stored" (uncompressed) entries.
 *
 * PNG / JPEG payloads don't compress meaningfully, so storing them
 * uncompressed keeps the encoder tiny and avoids pulling in a
 * deflate dependency.
 *
 * Spec: PKZIP appnote.txt, sections on the local file header,
 * central directory header, and end-of-central-directory record.
 */

var _crcTable = null;
function buildCrcTable() {
  var table = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(bytes) {
  if (!_crcTable) _crcTable = buildCrcTable();
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ _crcTable[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Decode a `data:...;base64,…` URL into a Uint8Array.
 */
export function dataUrlToBytes(dataUrl) {
  var comma = dataUrl.indexOf(',');
  var base64 = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
  // Strip whitespace just in case (some sources line-wrap base64).
  base64 = base64.replace(/\s+/g, '');
  var bin = atob(base64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Build a ZIP archive containing the given files, all stored
 * uncompressed.
 *
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {Uint8Array}
 */
export function buildZip(files) {
  var encoder = new TextEncoder();
  var localParts = [];
  var centralParts = [];
  var offset = 0;

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var nameBytes = encoder.encode(f.name);
    var crc = crc32(f.data);
    var size = f.data.length;

    var local = new Uint8Array(30 + nameBytes.length);
    var dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);    // signature
    dv.setUint16(4, 20, true);             // version needed
    dv.setUint16(6, 0x0800, true);         // flags: utf-8 filename
    dv.setUint16(8, 0, true);              // compression: stored
    dv.setUint16(10, 0, true);             // mod time
    dv.setUint16(12, 0, true);             // mod date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);          // compressed size
    dv.setUint32(22, size, true);          // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);             // extra field length
    local.set(nameBytes, 30);
    localParts.push(local, f.data);

    var central = new Uint8Array(46 + nameBytes.length);
    var cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true);   // central signature
    cdv.setUint16(4, 20, true);            // version made by
    cdv.setUint16(6, 20, true);            // version needed
    cdv.setUint16(8, 0x0800, true);        // flags
    cdv.setUint16(10, 0, true);            // compression
    cdv.setUint16(12, 0, true);            // mod time
    cdv.setUint16(14, 0, true);            // mod date
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);            // extra
    cdv.setUint16(32, 0, true);            // comment
    cdv.setUint16(34, 0, true);            // disk number
    cdv.setUint16(36, 0, true);            // internal attrs
    cdv.setUint32(38, 0, true);            // external attrs
    cdv.setUint32(42, offset, true);       // local header offset
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + size;
  }

  var centralStart = offset;
  var centralSize = 0;
  for (var c = 0; c < centralParts.length; c++) centralSize += centralParts[c].length;

  var eocd = new Uint8Array(22);
  var edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralStart, true);
  edv.setUint16(20, 0, true);

  var totalSize = offset + centralSize + 22;
  var out = new Uint8Array(totalSize);
  var p = 0;
  for (var li = 0; li < localParts.length; li++) {
    out.set(localParts[li], p); p += localParts[li].length;
  }
  for (var ci = 0; ci < centralParts.length; ci++) {
    out.set(centralParts[ci], p); p += centralParts[ci].length;
  }
  out.set(eocd, p);
  return out;
}

/**
 * Trigger a browser download of the given byte buffer.
 */
export function downloadBytes(bytes, filename, mimeType) {
  var blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}
