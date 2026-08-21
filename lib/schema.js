/**
 * The canonical outlet sheet schema.
 *
 * These column names are the contract shared by three things:
 *   - the Excel/CSV export of existing outlets,
 *   - the import that updates site data (a sheet is rejected unless its
 *     column names match this list exactly),
 *   - the "Pumps" sheet of Site Data/PSO_Pump_Data_v3.xlsx, whose columns
 *     are reproduced here verbatim so an exported sheet can be filled in
 *     against the same rubric and handed straight back.
 *
 * Every field the Add-outlet form collects appears here, so an export is a
 * complete round-trip of an outlet.
 */

/* Columns 1-5 mirror the Pumps sheet exactly; the rubric block below does too.
 * `required` marks a column that must be present in an uploaded sheet's
 * header row; a missing optional column simply leaves that field empty for
 * every imported row instead of rejecting the file. The key column is always
 * required, no matter what an edited config says. Column labels and the
 * required flag can both be edited from inside the app (Import sheet ->
 * Column settings) and are persisted over the defaults below — see
 * loadConfig/applyConfig. */
const COLUMNS = [
  { column: 'Outlet Number',             field: 'code',              type: 'number', key: true, required: true },
  { column: 'Pump Name',                 field: 'name',              type: 'string', required: true },
  { column: 'Division',                  field: 'division',          type: 'string', required: true },
  { column: 'Territory',                 field: 'territory',         type: 'string', required: true },
  { column: 'Sales Area',                field: 'sales_area',        type: 'string', required: true },

  { column: 'Category',                  field: 'category',          type: 'string', required: true },
  { column: 'City',                      field: 'city',              type: 'string', required: true },
  { column: 'District',                  field: 'district',          type: 'string', required: true },
  { column: 'Province',                  field: 'province',          type: 'string', required: true },
  { column: 'Location',                  field: 'location',          type: 'string', required: true },
  { column: 'ATP (KL/month)',            field: 'atp',               type: 'number', required: true },
  { column: 'Operation Type',            field: 'operated',          type: 'string', required: true },
  { column: 'Financing',                 field: 'finance',           type: 'string', required: true },
  { column: 'Latitude',                  field: 'lat',               type: 'number', required: true },
  { column: 'Longitude',                 field: 'lon',               type: 'number', required: true },
  { column: 'Match Confidence',          field: 'match_type',        type: 'string', required: true },
  { column: 'Runner-up Category',        field: 'runner_up',         type: 'string', required: true },
  { column: 'Old Tag',                   field: 'old_tag',           type: 'string', required: true },

  { column: 'Location Context',          field: 'location_context',  type: 'string', rubric: true, required: true },
  { column: 'Traffic Pattern',           field: 'traffic_pattern',   type: 'string', rubric: true, required: true },
  { column: 'Land Use Pattern',          field: 'land_use_pattern',  type: 'string', rubric: true, required: true },
  { column: 'Typical Customer Profile',  field: 'customer_profile',  type: 'string', rubric: true, required: true },
  { column: 'Footfall Tier',             field: 'footfall_tier',     type: 'string', rubric: true, required: true },
  { column: 'Peak Sale Time',            field: 'peak_sale_time',    type: 'string', rubric: true, required: true },
  { column: 'Seasonality Impact',        field: 'seasonality_impact', type: 'string', rubric: true, required: true },
  { column: 'Throughfare Type',          field: 'throughfare_type',  type: 'string', rubric: true, required: true },

  { column: 'PSO Cards',                 field: 'cards',             type: 'bool', facility: true, required: true },
  { column: 'Shop Stop',                 field: 'shop',              type: 'bool', facility: true, required: true },
  { column: 'VIBE',                      field: 'vibe',              type: 'bool', facility: true, required: true },
  { column: 'R-95',                      field: 'r95',               type: 'bool', facility: true, required: true },
  { column: 'Brand Alliance',            field: 'alli',              type: 'string', facility: true, required: true }
];

/** Header comparison ignores case, surrounding space and repeated spaces only. */
function normalizeHeader(h) {
  return String(h === null || h === undefined ? '' : h)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

let COLUMN_NAMES, KEY_COLUMN, RUBRIC_FIELDS, CANONICAL_BY_NORMALIZED;

/** Recomputes the derived lookups after COLUMNS' labels/required flags change. */
function reindex() {
  COLUMN_NAMES = COLUMNS.map(function (c) { return c.column; });
  KEY_COLUMN = COLUMNS.filter(function (c) { return c.key; })[0].column;
  RUBRIC_FIELDS = COLUMNS.filter(function (c) { return c.rubric; })
    .map(function (c) { return c.field; });
  CANONICAL_BY_NORMALIZED = {};
  COLUMNS.forEach(function (c) { CANONICAL_BY_NORMALIZED[normalizeHeader(c.column)] = c; });
}
reindex();

/**
 * Applies an edited column mapping: [{ field, column, required }, ...].
 * Only the label and required flag can change — fields, types and facility/
 * rubric membership stay fixed. The key column is always forced required.
 * Unknown fields are ignored; entries with a blank column name are ignored.
 */
function applyConfig(overrides) {
  const byField = {};
  (overrides || []).forEach(function (o) { if (o && o.field) byField[o.field] = o; });

  COLUMNS.forEach(function (c) {
    const o = byField[c.field];
    if (!o) return;
    const label = String(o.column === null || o.column === undefined ? '' : o.column).trim();
    if (label) c.column = label;
    c.required = c.key ? true : !!o.required;
  });

  reindex();
}

/**
 * Checks an uploaded sheet's header row against the schema. Only required
 * columns count toward `missing` — an absent optional column is fine and
 * leaves that field empty for every row.
 * Returns { ok, missing, unexpected, duplicated }.
 */
function validateHeader(header) {
  const seen = {};
  const duplicated = [];
  const unexpected = [];

  (header || []).forEach(function (h) {
    const norm = normalizeHeader(h);
    if (norm === '') return;
    if (seen[norm]) { duplicated.push(String(h).trim()); return; }
    seen[norm] = true;
    if (!CANONICAL_BY_NORMALIZED[norm]) unexpected.push(String(h).trim());
  });

  const missing = COLUMNS
    .filter(function (c) { return c.required && !seen[normalizeHeader(c.column)]; })
    .map(function (c) { return c.column; });

  return {
    ok: missing.length === 0 && unexpected.length === 0 && duplicated.length === 0,
    missing: missing,
    unexpected: unexpected,
    duplicated: duplicated
  };
}

function toBool(v) {
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  return s === 'y' || s === 'yes' || s === 'true' || s === '1';
}

function toNumber(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
}

/** Builds one sheet row (array, schema order) from an outlet + its facility record. */
function outletToRow(outlet, facility) {
  facility = facility || {};
  return COLUMNS.map(function (c) {
    const source = c.facility ? facility : outlet;
    const raw = source[c.field];
    if (c.type === 'bool') return raw ? 'Y' : 'N';
    if (c.type === 'number') {
      const n = toNumber(raw);
      return n === null ? '' : n;
    }
    return raw === null || raw === undefined ? '' : String(raw);
  });
}

/**
 * Turns a header-keyed sheet record into { code, outlet, facility }.
 * Blank cells are returned as undefined so an import can leave the existing
 * value alone rather than wiping it.
 */
function rowToOutlet(record) {
  const outlet = {};
  const facility = {};
  let code = null;

  COLUMNS.forEach(function (c) {
    // find the record's key for this column regardless of case/spacing
    let raw;
    for (const k in record) {
      if (normalizeHeader(k) === normalizeHeader(c.column)) { raw = record[k]; break; }
    }
    const blank = raw === null || raw === undefined || String(raw).trim() === '';

    if (c.key) { code = toNumber(raw); return; }

    const target = c.facility ? facility : outlet;
    if (c.type === 'bool') { if (!blank) target[c.field] = toBool(raw); return; }
    if (blank) return;
    if (c.type === 'number') target[c.field] = toNumber(raw);
    else target[c.field] = String(raw).trim();
  });

  return { code: code, outlet: outlet, facility: facility };
}

module.exports = {
  COLUMNS: COLUMNS,
  normalizeHeader: normalizeHeader,
  validateHeader: validateHeader,
  applyConfig: applyConfig,
  outletToRow: outletToRow,
  rowToOutlet: rowToOutlet,
  toBool: toBool,
  toNumber: toNumber
};

/* COLUMN_NAMES/KEY_COLUMN/RUBRIC_FIELDS change when applyConfig() edits a
 * label or the required set, so these stay live getters rather than values
 * snapshotted at require() time. */
Object.defineProperty(module.exports, 'COLUMN_NAMES', { enumerable: true, get: function () { return COLUMN_NAMES; } });
Object.defineProperty(module.exports, 'KEY_COLUMN', { enumerable: true, get: function () { return KEY_COLUMN; } });
Object.defineProperty(module.exports, 'RUBRIC_FIELDS', { enumerable: true, get: function () { return RUBRIC_FIELDS; } });
