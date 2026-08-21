/**
 * Minimal XLSX reader/writer — pure Node, no npm install.
 *
 * An .xlsx file is a ZIP of XML parts. Node ships zlib, so both halves of
 * the job (inflate to read, CRC32 + stored entries to write) can be done
 * with built-ins only, which keeps `node server.js` dependency-free.
 */
const fs = require('fs');
const zlib = require('zlib');

/* ---------------------------------------------------------------------
   ZIP
   --------------------------------------------------------------------- */
const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function unzip(buf) {
  const files = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP directory found).');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Corrupt .xlsx central directory.');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    if (method === 0) files[name] = raw;
    else if (method === 8) files[name] = zlib.inflateRawSync(raw);
    else throw new Error('Unsupported compression in .xlsx entry ' + name);

    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Builds a ZIP with stored (uncompressed) entries — no deflate state to get wrong. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  entries.forEach(function (entry) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // stored
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date — fixed, so exports are reproducible
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  });

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

/* ---------------------------------------------------------------------
   XML helpers
   --------------------------------------------------------------------- */
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(Number(d)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // control characters are illegal in XML 1.0 and make Excel refuse the file
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function colName(idx) {
  let n = idx + 1, s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function colToIdx(ref) {
  const letters = String(ref).match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ---------------------------------------------------------------------
   Reading
   --------------------------------------------------------------------- */
function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) text += decodeEntities(t[1]);
    out.push(text);
  }
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>|<row[^>]*\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const inner = rm[1] || '';
    const row = [];
    const cRe = /<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(inner))) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const refM = attrs.match(/r="([A-Z]+\d+)"/);
      const idx = refM ? colToIdx(refM[1]) : row.length;
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      let val = '';
      if (type === 'inlineStr') {
        const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(body))) val += decodeEntities(t[1]);
      } else {
        const vM = body.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        if (vM) {
          const raw = decodeEntities(vM[1]);
          if (type === 's') val = shared[Number(raw)] === undefined ? '' : shared[Number(raw)];
          else val = raw;
        }
      }
      row[idx] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    rows.push(row);
  }
  return rows;
}

/**
 * Reads a workbook into [{ name, rows }], where rows are arrays of strings.
 * Accepts a path or a Buffer.
 */
function readWorkbook(source) {
  const buf = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  const files = unzip(buf);
  if (!files['xl/workbook.xml']) throw new Error('Not a valid .xlsx workbook.');

  const wb = files['xl/workbook.xml'].toString('utf8');
  const relsXml = files['xl/_rels/workbook.xml.rels']
    ? files['xl/_rels/workbook.xml.rels'].toString('utf8')
    : '';
  const relMap = {};
  const relRe = /<Relationship([^>]*)\/>/g;
  let r;
  while ((r = relRe.exec(relsXml))) {
    const id = (r[1].match(/Id="([^"]+)"/) || [])[1];
    let target = (r[1].match(/Target="([^"]+)"/) || [])[1];
    if (target && target.charAt(0) !== '/') target = 'xl/' + target.replace(/^\.\//, '');
    if (target && target.charAt(0) === '/') target = target.slice(1);
    relMap[id] = target;
  }

  const shared = parseSharedStrings(
    files['xl/sharedStrings.xml'] ? files['xl/sharedStrings.xml'].toString('utf8') : ''
  );

  const sheets = [];
  const sheetRe = /<sheet([^>]*?)\/>/g;
  let s;
  while ((s = sheetRe.exec(wb))) {
    const name = decodeEntities((s[1].match(/name="([^"]*)"/) || [])[1] || '');
    const rid = (s[1].match(/r:id="([^"]+)"/) || [])[1];
    const target = relMap[rid];
    if (!target || !files[target]) { sheets.push({ name: name, rows: [] }); continue; }
    sheets.push({ name: name, rows: parseSheet(files[target].toString('utf8'), shared) });
  }
  return sheets;
}

/**
 * Turns raw rows into { header, records } where records are header-keyed
 * objects. Leading blank/title rows are skipped, so the first row carrying
 * two or more filled cells is taken as the header.
 */
function sheetToObjects(rows) {
  let headerIdx = -1;
  for (let i = 0; i < rows.length && i < 20; i++) {
    const filled = rows[i].filter(function (c) { return String(c).trim() !== ''; });
    if (filled.length >= 2) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return { header: [], records: [] };

  const header = rows[headerIdx].map(function (h) { return String(h).trim(); });
  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some(function (c) { return String(c).trim() !== ''; })) continue;
    const rec = {};
    header.forEach(function (h, idx) {
      if (h === '') return;
      rec[h] = row[idx] === undefined ? '' : String(row[idx]).trim();
    });
    records.push(rec);
  }
  return { header: header, records: records };
}

/* ---------------------------------------------------------------------
   Writing
   --------------------------------------------------------------------- */
function cellXml(ref, value) {
  if (value === null || value === undefined || value === '') {
    return '<c r="' + ref + '"/>';
  }
  if (typeof value === 'number' && isFinite(value)) {
    return '<c r="' + ref + '"><v>' + value + '</v></c>';
  }
  return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
    escapeXml(value) + '</t></is></c>';
}

function sheetXml(rows) {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>';
  rows.forEach(function (row, rIdx) {
    xml += '<row r="' + (rIdx + 1) + '">';
    row.forEach(function (value, cIdx) {
      xml += cellXml(colName(cIdx) + (rIdx + 1), value);
    });
    xml += '</row>';
  });
  return xml + '</sheetData></worksheet>';
}

/**
 * Builds an .xlsx Buffer from [{ name, rows }] where rows are arrays of
 * strings/numbers. The first row is the header by convention only.
 */
function writeWorkbook(sheets) {
  const parts = [];

  parts.push({
    name: '[Content_Types].xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (s, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ' +
          'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '</Types>'
  });

  parts.push({
    name: '_rels/.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
  });

  parts.push({
    name: 'xl/workbook.xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map(function (s, i) {
        return '<sheet name="' + escapeXml(String(s.name).slice(0, 31)) + '" sheetId="' +
          (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') +
      '</sheets></workbook>'
  });

  parts.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) {
        return '<Relationship Id="rId' + (i + 1) + '" ' +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
          'Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '</Relationships>'
  });

  sheets.forEach(function (s, i) {
    parts.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s.rows) });
  });

  return zip(parts);
}

module.exports = { readWorkbook, sheetToObjects, writeWorkbook, colName };
