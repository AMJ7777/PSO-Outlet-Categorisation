/**
 * PSO North Region Site Map — merged backend
 * Pure Node.js (no external dependencies) so it runs anywhere with just
 * `node server.js` — no npm install required.
 *
 * Serves the frontend from /public and exposes a small REST API backed by
 * JSON files in /data, so pump additions, edits, deletions and new
 * categories persist across restarts.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const xlsx = require('./lib/xlsx');
const schema = require('./lib/schema');
const pumpData = require('./lib/pumpData');
const supabaseStore = require('./lib/supabaseStore');

const PORT = process.env.PORT || 3000;

/* Upload of the site-data sheet is gated on this. Override in the shell:
   PSO_ADMIN_PASSWORD='…' node server.js */
const ADMIN_PASSWORD = process.env.PSO_ADMIN_PASSWORD || 'pso-admin';

const MAX_BODY_BYTES = 25 * 1024 * 1024;

const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const OUTLETS_PATH = path.join(DATA_DIR, 'outlets.json');
const CATEGORIES_PATH = path.join(DATA_DIR, 'categories.json');
const FACILITIES_PATH = path.join(DATA_DIR, 'facilities.json');
const COLUMN_CONFIG_PATH = path.join(DATA_DIR, 'column-config.json');
const CUSTOM_COLUMNS_PATH = path.join(DATA_DIR, 'custom-columns.json');

/* The pump workbook is read once at boot and kept in memory — it is the
   source of the categorisation rubric and of the sheet's column names. */
let PUMP_DATA = null;

/* ---------------------------------------------------------------------
   Small JSON storage helpers — local data/*.json files by default, or
   Supabase (see lib/supabaseStore.js) when SUPABASE_URL and
   SUPABASE_SERVICE_ROLE_KEY are set, which Vercel deployments need since
   its filesystem is read-only/ephemeral in production. Every call site in
   this file just passes one of the five *_PATH constants above, so the
   backend switch happens here only — nothing downstream has to know which
   store is live.
   --------------------------------------------------------------------- */
function configKeyFor(filePath) {
  if (filePath === CATEGORIES_PATH) return 'categories';
  if (filePath === COLUMN_CONFIG_PATH) return 'column_config';
  if (filePath === CUSTOM_COLUMNS_PATH) return 'custom_columns';
  return null;
}

function readJson(filePath) {
  if (supabaseStore.enabled) {
    if (filePath === OUTLETS_PATH) return supabaseStore.readOutlets();
    if (filePath === FACILITIES_PATH) return supabaseStore.readFacilities();
    const key = configKeyFor(filePath);
    if (key) return supabaseStore.readConfig(key);
  }
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(data)); }
      catch (parseErr) { reject(parseErr); }
    });
  });
}
function writeJson(filePath, data) {
  if (supabaseStore.enabled) {
    if (filePath === OUTLETS_PATH) return supabaseStore.writeOutlets(data);
    if (filePath === FACILITIES_PATH) return supabaseStore.writeFacilities(data);
    const key = configKeyFor(filePath);
    if (key) return supabaseStore.writeConfig(key, data);
  }
  return new Promise((resolve, reject) => {
    fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8', (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function sendBinary(res, filename, mime, buffer) {
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': buffer.length,
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(buffer);
}
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

/* ---------------------------------------------------------------------
   Static file serving for /public
   --------------------------------------------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, urlPath) {
  let safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '') safePath = '/index.html';
  let filePath = path.join(PUBLIC_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA-style fallback for any unknown route
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500);
        res.end('Server error loading page.');
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

/* ---------------------------------------------------------------------
   Route handlers
   --------------------------------------------------------------------- */
async function handleGetOutlets(req, res) {
  try {
    const outlets = await readJson(OUTLETS_PATH);
    sendJson(res, 200, outlets);
  } catch (e) {
    console.error('Error reading outlets database:', e);
    sendJson(res, 500, { error: 'Failed to retrieve outlets data.' });
  }
}

async function handleAddOutlet(req, res) {
  let newOutlet;
  try { newOutlet = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'Invalid JSON body.' }); }

  if (!newOutlet || !newOutlet.code || !newOutlet.name) {
    return sendJson(res, 400, { error: 'Outlet code and name are required.' });
  }

  try {
    const outlets = await readJson(OUTLETS_PATH);
    const code = Number(newOutlet.code);
    if (outlets.some((o) => o.code === code)) {
      return sendJson(res, 400, { error: `Outlet with code ${code} already exists.` });
    }
    newOutlet.code = code;
    if (newOutlet.lat !== undefined) newOutlet.lat = Number(newOutlet.lat);
    if (newOutlet.lon !== undefined) newOutlet.lon = Number(newOutlet.lon);
    if (newOutlet.atp !== undefined && newOutlet.atp !== null) newOutlet.atp = Number(newOutlet.atp);

    outlets.push(newOutlet);
    await writeJson(OUTLETS_PATH, outlets);
    sendJson(res, 201, newOutlet);
  } catch (e) {
    console.error('Error saving new outlet:', e);
    sendJson(res, 500, { error: 'Failed to save new outlet.' });
  }
}

async function handleUpdateOutlet(req, res, code) {
  const numCode = Number(code);
  if (isNaN(numCode)) return sendJson(res, 400, { error: 'Invalid outlet code.' });

  let updatedData;
  try { updatedData = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'Invalid JSON body.' }); }

  try {
    const outlets = await readJson(OUTLETS_PATH);
    const index = outlets.findIndex((o) => o.code === numCode);
    if (index === -1) return sendJson(res, 404, { error: 'Outlet not found.' });

    const updatedOutlet = Object.assign({}, outlets[index], updatedData);
    updatedOutlet.code = numCode;
    if (updatedOutlet.lat !== undefined) updatedOutlet.lat = Number(updatedOutlet.lat);
    if (updatedOutlet.lon !== undefined) updatedOutlet.lon = Number(updatedOutlet.lon);
    if (updatedOutlet.atp !== undefined && updatedOutlet.atp !== null) updatedOutlet.atp = Number(updatedOutlet.atp);

    // Unless the category was pinned by hand, the Pumps sheet decides it.
    if (!updatedOutlet.manual_category) {
      const category = pumpData.categoryFor(numCode, PUMP_DATA);
      if (category) {
        updatedOutlet.category = category;
        updatedOutlet.category_source = 'pumps-sheet';
      }
    }
    const division = pumpData.divisionFor(numCode, PUMP_DATA) || updatedOutlet.division;
    if (division) updatedOutlet.division = division;

    outlets[index] = updatedOutlet;
    await writeJson(OUTLETS_PATH, outlets);
    sendJson(res, 200, updatedOutlet);
  } catch (e) {
    console.error('Error saving updated outlet:', e);
    sendJson(res, 500, { error: 'Failed to save updated outlet.' });
  }
}

async function handleDeleteOutlet(req, res, code) {
  const numCode = Number(code);
  if (isNaN(numCode)) return sendJson(res, 400, { error: 'Invalid outlet code.' });

  try {
    const outlets = await readJson(OUTLETS_PATH);
    const filtered = outlets.filter((o) => o.code !== numCode);
    if (filtered.length === outlets.length) return sendJson(res, 404, { error: 'Outlet not found.' });

    await writeJson(OUTLETS_PATH, filtered);

    try {
      const facilities = await readJson(FACILITIES_PATH);
      if (Object.prototype.hasOwnProperty.call(facilities, String(numCode))) {
        delete facilities[String(numCode)];
        await writeJson(FACILITIES_PATH, facilities);
      }
    } catch (e) { /* facilities cleanup is best-effort */ }

    sendJson(res, 200, { success: true });
  } catch (e) {
    console.error('Error deleting outlet:', e);
    sendJson(res, 500, { error: 'Failed to delete outlet.' });
  }
}

async function handleGetCategories(req, res) {
  try {
    const categories = await readJson(CATEGORIES_PATH);
    sendJson(res, 200, categories);
  } catch (e) {
    console.error('Error reading categories:', e);
    sendJson(res, 500, { error: 'Failed to retrieve categories.' });
  }
}

async function handleAddCategory(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'Invalid JSON body.' }); }

  const { category, color, bg } = body;
  if (!category || !color) return sendJson(res, 400, { error: 'Category name and color are required.' });

  try {
    const categories = await readJson(CATEGORIES_PATH);
    categories[category] = { color, bg: bg || `${color}20` };
    await writeJson(CATEGORIES_PATH, categories);
    sendJson(res, 201, categories);
  } catch (e) {
    console.error('Error saving category:', e);
    sendJson(res, 500, { error: 'Failed to save category.' });
  }
}

async function handleGetFacilities(req, res) {
  try {
    const facilities = await readJson(FACILITIES_PATH);
    sendJson(res, 200, facilities);
  } catch (e) {
    console.error('Error reading facilities database:', e);
    sendJson(res, 500, { error: 'Failed to retrieve facilities data.' });
  }
}

async function handleUpdateFacility(req, res, code) {
  let updatedData;
  try { updatedData = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: 'Invalid JSON body.' }); }

  try {
    const facilities = await readJson(FACILITIES_PATH);
    const existing = facilities[code] || { cards: false, mid: '', shop: false, vibe: false, r95: false, alli: '' };
    facilities[code] = Object.assign({}, existing, updatedData);
    await writeJson(FACILITIES_PATH, facilities);
    sendJson(res, 200, facilities[code]);
  } catch (e) {
    console.error('Error saving facility record:', e);
    sendJson(res, 500, { error: 'Failed to save facility record.' });
  }
}

/* ---------------------------------------------------------------------
   Site-data sheet: export, import and pump-sheet categorisation
   --------------------------------------------------------------------- */
function isAdmin(body) {
  return !!body && typeof body.password === 'string' && body.password === ADMIN_PASSWORD;
}

/** Rows for the export, in schema order, optionally limited to some codes. */
async function buildExportRows(codesParam) {
  const outlets = await readJson(OUTLETS_PATH);
  let facilities = {};
  try { facilities = await readJson(FACILITIES_PATH); } catch (e) { /* optional */ }

  let selected = outlets;
  if (codesParam) {
    const wanted = {};
    String(codesParam).split(',').forEach(function (c) {
      const t = c.trim();
      if (t) wanted[t] = true;
    });
    if (Object.keys(wanted).length) {
      selected = outlets.filter(function (o) { return wanted[String(o.code)]; });
    }
  }

  const rows = [schema.COLUMN_NAMES];
  selected.forEach(function (o) {
    rows.push(schema.outletToRow(o, facilities[String(o.code)]));
  });
  return { rows: rows, count: selected.length };
}

function exportFilename(ext) {
  const stamp = new Date().toISOString().slice(0, 10);
  return 'PSO-North-Region-Outlets-' + stamp + '.' + ext;
}

/**
 * Export scope arrives as ?codes=… on a GET, or { codes: [...] } on a POST —
 * the filtered view can run to a thousand outlets, which is too long for a URL.
 */
async function exportScope(req, url) {
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (body && Array.isArray(body.codes)) return body.codes.join(',');
    return null;
  }
  return url.searchParams.get('codes');
}

async function handleExportXlsx(req, res, url) {
  try {
    const built = await buildExportRows(await exportScope(req, url));
    const buffer = xlsx.writeWorkbook([{ name: 'Pumps', rows: built.rows }]);
    sendBinary(
      res,
      exportFilename('xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer
    );
  } catch (e) {
    console.error('Error building the Excel export:', e);
    sendJson(res, 500, { error: 'Failed to build the Excel export.' });
  }
}

async function handleExportCsv(req, res, url) {
  try {
    const built = await buildExportRows(await exportScope(req, url));
    const csv = built.rows.map(function (row) {
      return row.map(function (v) {
        return '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\r\n');
    // the BOM keeps Excel from mangling non-ASCII site names
    sendBinary(res, exportFilename('csv'), 'text/csv; charset=utf-8', Buffer.from('﻿' + csv, 'utf8'));
  } catch (e) {
    console.error('Error building the CSV export:', e);
    sendJson(res, 500, { error: 'Failed to build the CSV export.' });
  }
}

async function handleGetSchema(req, res) {
  sendJson(res, 200, {
    columns: schema.COLUMN_NAMES,
    keyColumn: schema.KEY_COLUMN,
    rubricFields: schema.RUBRIC_FIELDS,
    fields: schema.COLUMNS.map(function (c) {
      return {
        column: c.column, field: c.field, type: c.type,
        facility: !!c.facility, rubric: !!c.rubric, key: !!c.key, required: !!c.required
      };
    }),
    rubricChoices: PUMP_DATA ? PUMP_DATA.choices : {},
    categories: PUMP_DATA ? PUMP_DATA.categories : [],
    divisions: PUMP_DATA ? PUMP_DATA.divisions : [],
    workbooks: PUMP_DATA ? PUMP_DATA.sources : []
  });
}

/**
 * Admin-only. Lets the sheet's column names and which ones are required for
 * import be edited from inside the app instead of the source code — a
 * column left optional simply comes back empty on every imported row when a
 * sheet doesn't carry it. Accepts { password, columns: [{ field, column,
 * required }, ...] }; only known fields are recognised and the key column
 * (Outlet Number) is always required regardless of what is posted.
 */
async function handleUpdateSchemaColumns(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: e.message || 'Invalid request body.' }); }

  if (!isAdmin(body)) {
    return sendJson(res, 401, { error: 'Incorrect admin password. The column settings were not changed.' });
  }
  if (!Array.isArray(body.columns)) {
    return sendJson(res, 400, { error: 'Expected a "columns" list.' });
  }

  const byField = {};
  body.columns.forEach(function (o) { if (o && typeof o.field === 'string') byField[o.field] = o; });

  const knownFields = {};
  schema.COLUMNS.forEach(function (c) { knownFields[c.field] = true; });
  const unknown = Object.keys(byField).filter(function (f) { return !knownFields[f]; });
  if (unknown.length) {
    return sendJson(res, 422, { error: 'Unknown field(s): ' + unknown.join(', ') + '.' });
  }

  // Simulate the merged label set before touching anything, so a bad edit
  // (blank or duplicate label) is rejected without partially applying.
  const seen = {};
  const duplicated = [];
  const blank = [];
  schema.COLUMNS.forEach(function (c) {
    const o = byField[c.field];
    const label = o && typeof o.column === 'string' ? o.column.trim() : c.column;
    if (!label) { blank.push(c.field); return; }
    const norm = schema.normalizeHeader(label);
    if (seen[norm]) duplicated.push(label); else seen[norm] = true;
  });
  if (blank.length) {
    return sendJson(res, 422, { error: 'Column name cannot be blank for: ' + blank.join(', ') + '.' });
  }
  if (duplicated.length) {
    return sendJson(res, 422, { error: 'Column names must be unique. Repeated: ' + duplicated.join(', ') + '.' });
  }

  schema.applyConfig(body.columns);

  const persisted = schema.COLUMNS.map(function (c) {
    return { field: c.field, column: c.column, required: !!c.required };
  });
  try {
    await writeJson(COLUMN_CONFIG_PATH, persisted);
  } catch (e) {
    console.error('Could not persist the column settings:', e);
    return sendJson(res, 500, { error: 'The settings were applied but could not be saved to disk.' });
  }

  return handleGetSchema(req, res);
}

/**
 * Admin-only. Adds a brand new column to the sheet schema — { password,
 * column, type } — so a new data category can be tracked (and shows up in
 * the next export/import) without touching the source code. Persisted to
 * CUSTOM_COLUMNS_PATH so it survives a restart.
 */
async function handleAddSchemaColumn(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: e.message || 'Invalid request body.' }); }

  if (!isAdmin(body)) {
    return sendJson(res, 401, { error: 'Incorrect admin password. The column was not added.' });
  }

  let added;
  try {
    added = schema.addColumn({ column: body.column, type: body.type });
  } catch (e) {
    return sendJson(res, 422, { error: e.message });
  }

  let customColumns = [];
  try {
    const saved = await readJson(CUSTOM_COLUMNS_PATH);
    if (Array.isArray(saved)) customColumns = saved;
  } catch (e) { /* none yet */ }
  customColumns.push({ field: added.field, column: added.column, type: added.type });
  try {
    await writeJson(CUSTOM_COLUMNS_PATH, customColumns);
  } catch (e) {
    console.error('Could not persist the new column:', e);
    return sendJson(res, 500, { error: 'The column was added but could not be saved to disk.' });
  }

  return handleGetSchema(req, res);
}

/**
 * Admin-only. Accepts { password, filename, data } where data is the base64
 * of an .xlsx/.csv whose column names must match the schema exactly.
 */
async function handleImport(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: e.message || 'Invalid request body.' }); }

  if (!isAdmin(body)) {
    return sendJson(res, 401, { error: 'Incorrect admin password. The site data was not changed.' });
  }
  if (!body.data) return sendJson(res, 400, { error: 'No file was uploaded.' });

  let parsed;
  try {
    const buffer = Buffer.from(body.data, 'base64');
    const name = String(body.filename || '').toLowerCase();
    if (name.endsWith('.csv')) parsed = parseCsvSheet(buffer.toString('utf8'));
    else {
      const sheets = xlsx.readWorkbook(buffer);
      // prefer a sheet called Pumps, else the first with data
      const chosen = sheets.filter(function (s) {
        return schema.normalizeHeader(s.name) === 'pumps';
      })[0] || sheets.filter(function (s) { return s.rows.length > 1; })[0] || sheets[0];
      if (!chosen) throw new Error('The workbook has no sheets.');
      parsed = xlsx.sheetToObjects(chosen.rows);
    }
  } catch (e) {
    return sendJson(res, 400, { error: 'Could not read that file: ' + e.message });
  }

  const check = schema.validateHeader(parsed.header);
  if (!check.ok) {
    return sendJson(res, 422, {
      error: 'This sheet does not match the site data format, so nothing was changed.',
      expected: schema.COLUMN_NAMES,
      found: parsed.header.filter(function (h) { return String(h).trim() !== ''; }),
      missing: check.missing,
      unexpected: check.unexpected,
      duplicated: check.duplicated
    });
  }
  if (!parsed.records.length) {
    return sendJson(res, 422, { error: 'The sheet has the right columns but no data rows.' });
  }

  try {
    const outlets = await readJson(OUTLETS_PATH);
    let facilities = {};
    try { facilities = await readJson(FACILITIES_PATH); } catch (e) { /* optional */ }

    const byCode = {};
    outlets.forEach(function (o) { byCode[String(o.code)] = o; });

    const result = { updated: 0, added: 0, recategorised: 0, skipped: [], total: parsed.records.length };

    parsed.records.forEach(function (record, i) {
      const mapped = schema.rowToOutlet(record);
      if (mapped.code === null) {
        result.skipped.push({ row: i + 2, reason: 'Missing or non-numeric ' + schema.KEY_COLUMN });
        return;
      }

      let outlet = byCode[String(mapped.code)];
      const isNew = !outlet;
      if (isNew) {
        if (!mapped.outlet.name) {
          result.skipped.push({ row: i + 2, reason: 'New outlet ' + mapped.code + ' has no Pump Name' });
          return;
        }
        outlet = { code: mapped.code };
        outlets.push(outlet);
        byCode[String(mapped.code)] = outlet;
      }

      const categoryFromSheet = mapped.outlet.category;
      Object.assign(outlet, mapped.outlet);
      outlet.code = mapped.code;

      // The sheet's own Category cell wins; the Pumps sheet fills the blanks.
      const category = categoryFromSheet || pumpData.categoryFor(mapped.code, PUMP_DATA);
      if (category) {
        outlet.category = category;
        outlet.category_source = categoryFromSheet ? 'sheet' : 'pumps-sheet';
        outlet.manual_category = false;
        result.recategorised++;
      }
      const division = mapped.outlet.division || pumpData.divisionFor(mapped.code, PUMP_DATA);
      if (division) outlet.division = division;

      if (Object.keys(mapped.facility).length) {
        const existing = facilities[String(mapped.code)] ||
          { cards: false, mid: '', shop: false, vibe: false, r95: false, alli: '' };
        facilities[String(mapped.code)] = Object.assign({}, existing, mapped.facility);
      }

      if (isNew) result.added++; else result.updated++;
    });

    await writeJson(OUTLETS_PATH, outlets);
    await writeJson(FACILITIES_PATH, facilities);

    result.skipped = result.skipped.slice(0, 25);
    sendJson(res, 200, Object.assign({ ok: true }, result));
  } catch (e) {
    console.error('Error applying the imported sheet:', e);
    sendJson(res, 500, { error: 'Failed to apply the imported sheet.' });
  }
}

/** Minimal RFC-4180 CSV reader, so an exported CSV can be re-imported too. */
function parseCsvSheet(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return xlsx.sheetToObjects(rows);
}

/* ---------------------------------------------------------------------
   Router
   --------------------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  try {
    if (pathname === '/api/outlets' && method === 'GET') return await handleGetOutlets(req, res);
    if (pathname === '/api/outlets' && method === 'POST') return await handleAddOutlet(req, res);

    let m = pathname.match(/^\/api\/outlets\/([^/]+)$/);
    if (m && method === 'PUT') return await handleUpdateOutlet(req, res, decodeURIComponent(m[1]));
    if (m && method === 'DELETE') return await handleDeleteOutlet(req, res, decodeURIComponent(m[1]));

    if (pathname === '/api/categories' && method === 'GET') return await handleGetCategories(req, res);
    if (pathname === '/api/categories' && method === 'POST') return await handleAddCategory(req, res);

    if (pathname === '/api/facilities' && method === 'GET') return await handleGetFacilities(req, res);
    m = pathname.match(/^\/api\/facilities\/([^/]+)$/);
    if (m && method === 'PUT') return await handleUpdateFacility(req, res, decodeURIComponent(m[1]));

    if (pathname === '/api/schema' && method === 'GET') return await handleGetSchema(req, res);
    if (pathname === '/api/schema/columns' && method === 'POST') return await handleUpdateSchemaColumns(req, res);
    if (pathname === '/api/schema/add-column' && method === 'POST') return await handleAddSchemaColumn(req, res);
    if (pathname === '/api/export.xlsx' && (method === 'GET' || method === 'POST')) return await handleExportXlsx(req, res, url);
    if (pathname === '/api/export.csv' && (method === 'GET' || method === 'POST')) return await handleExportCsv(req, res, url);
    if (pathname === '/api/import' && method === 'POST') return await handleImport(req, res);

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });

    // Everything else falls through to static file serving of the frontend
    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error('Unhandled server error:', err);
    sendJson(res, 500, { error: 'Internal server error.' });
  }
});

/* ---------------------------------------------------------------------
   Boot: fold the pump workbook into the stored outlets, then listen.
   Categories a person set by hand are left alone (`manual_category`).
   --------------------------------------------------------------------- */
async function syncPumpWorkbook() {
  PUMP_DATA = pumpData.load();
  if (!PUMP_DATA) {
    console.warn('Site Data workbooks not found — outlets keep their stored categories.');
    return;
  }

  try {
    const outlets = await readJson(OUTLETS_PATH);
    const summary = pumpData.applyToOutlets(outlets, PUMP_DATA);
    if (summary.changed) await writeJson(OUTLETS_PATH, outlets);
    console.log(
      'Categories from ' + summary.sources.join(' + ') + ': ' +
      summary.fromPumpSheet + ' from the Pumps sheet, ' +
      summary.uncovered + ' the sheet does not list, ' +
      summary.changed + ' category change(s)' +
      (summary.skippedManual ? ', ' + summary.skippedManual + ' kept as manually set' : '') + '.'
    );
  } catch (e) {
    console.error('Could not apply the sheet categorisation:', e.message);
  }
}

/* Columns added via Import sheet -> "Add a new column" (handleAddSchemaColumn)
   are restored before loadColumnConfig below, so a later rename/required
   edit of one of them (also persisted in COLUMN_CONFIG_PATH) still applies. */
async function loadCustomColumns() {
  try {
    const saved = await readJson(CUSTOM_COLUMNS_PATH);
    if (Array.isArray(saved)) {
      saved.forEach((def) => {
        try { schema.addColumn(def); }
        catch (e) { console.error('Could not restore custom column ' + (def && def.column) + ':', e.message); }
      });
    }
  } catch (e) { /* none added yet */ }
}

/* A previously saved column mapping (Import sheet -> Column settings)
   overrides the defaults in lib/schema.js on every boot. */
async function loadColumnConfig() {
  try {
    const saved = await readJson(COLUMN_CONFIG_PATH);
    if (Array.isArray(saved)) schema.applyConfig(saved);
  } catch (e) { /* no saved config yet — keep the defaults */ }
}

loadCustomColumns().then(loadColumnConfig).then(syncPumpWorkbook).then(() => {
  server.listen(PORT, () => {
    console.log(`PSO North Region Site Map server running on http://localhost:${PORT}`);
    console.log('Site-data upload is admin-gated (set PSO_ADMIN_PASSWORD to change the password).');
    console.log(supabaseStore.enabled
      ? 'Data store: Supabase (SUPABASE_URL set).'
      : 'Data store: local JSON files in /data (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to use Supabase instead).');
  });
});
