/**
 * Outlet categorisation from the site-data workbooks.
 *
 * The category shown on the map is read from column C ("Category") of the
 * Pumps sheet in Site Data.xlsx, which lists every outlet in the network
 * together with its division, territory, sales area and the eight
 * categorisation signals.
 *
 * PSO_Pump_Data_v3.xlsx is still read for its DropdownLists sheet, which is
 * the allowed value set for those signals in the edit form, and its own Pumps
 * sheet fills in a division for any outlet Site Data.xlsx leaves blank. The
 * two spell one division differently — "Islamabad" against "RWP" — so RWP is
 * folded into Islamabad.
 *
 * Both workbooks are optional: they are not committed to the repository, and
 * when neither is present the outlets keep the categories already stored in
 * data/outlets.json.
 */
const path = require('path');
const fs = require('fs');
const xlsx = require('./xlsx');

const SITE_DATA_DIR = path.join(__dirname, '..', 'Site Data');
const PUMP_WORKBOOK = path.join(SITE_DATA_DIR, 'PSO_Pump_Data_v3.xlsx');
const SITE_WORKBOOK = path.join(SITE_DATA_DIR, 'Site Data.xlsx');

/* Two names for one division; the Pumps sheet's spelling is canonical. */
const DIVISION_ALIASES = { rwp: 'Islamabad' };

/* Signal column -> outlet field. These are carried through as outlet detail
   and as sheet columns; they are shown alongside the category. */
const SIGNAL_FIELDS = {
  'Location Context': 'location_context',
  'Traffic Pattern': 'traffic_pattern',
  'Land Use Pattern': 'land_use_pattern',
  'Typical Customer Profile': 'customer_profile',
  'Footfall Tier': 'footfall_tier',
  'Peak Sale Time': 'peak_sale_time',
  'Seasonality Impact': 'seasonality_impact',
  'Throughfare Type': 'throughfare_type'
};
const SIGNAL_COLUMNS = Object.keys(SIGNAL_FIELDS);

function norm(s) {
  return String(s === null || s === undefined ? '' : s)
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalDivision(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (raw === '') return '';
  return DIVISION_ALIASES[norm(raw)] || raw;
}

function sheet(sheets, name) {
  const found = sheets.filter(function (s) { return norm(s.name) === norm(name); })[0];
  return found ? xlsx.sheetToObjects(found.rows) : { header: [], records: [] };
}

function readWorkbook(file) {
  if (!fs.existsSync(file)) return null;
  try { return xlsx.readWorkbook(file); }
  catch (e) {
    console.warn('Could not read ' + path.basename(file) + ':', e.message);
    return null;
  }
}

/** Case-insensitive header lookup, so "DIVISION" and "Division" both resolve. */
function pick(record, header, wanted) {
  const key = header.filter(function (h) { return norm(h) === norm(wanted); })[0];
  return key === undefined ? '' : record[key];
}

/**
 * Reads both workbooks. Returns null only when neither is present, so a
 * checkout without the Site Data folder still boots.
 */
function load() {
  const pumpSheets = readWorkbook(PUMP_WORKBOOK);
  const siteSheets = readWorkbook(SITE_WORKBOOK);
  if (!pumpSheets && !siteSheets) return null;

  const sitePumps = siteSheets ? sheet(siteSheets, 'Pumps') : { header: [], records: [] };
  const legacyPumps = pumpSheets ? sheet(pumpSheets, 'Pumps') : { header: [], records: [] };
  const dropdowns = pumpSheets ? sheet(pumpSheets, 'DropdownLists') : { header: [], records: [] };
  const outletDetails = siteSheets ? sheet(siteSheets, 'Outlet Details') : { header: [], records: [] };

  /* code -> { category, division, signals } from Site Data.xlsx's Pumps sheet */
  const primary = {};
  sitePumps.records.forEach(function (row) {
    const code = String(pick(row, sitePumps.header, 'Outlet Number')).trim();
    if (code === '') return;
    const signals = {};
    SIGNAL_COLUMNS.forEach(function (col) {
      const v = String(pick(row, sitePumps.header, col)).trim();
      if (v !== '') signals[SIGNAL_FIELDS[col]] = v;
    });
    primary[code] = {
      category: String(pick(row, sitePumps.header, 'Category')).trim(),
      division: canonicalDivision(pick(row, sitePumps.header, 'Division')),
      territory: String(pick(row, sitePumps.header, 'Territory')).trim(),
      sales_area: String(pick(row, sitePumps.header, 'Sales Area')).trim(),
      signals: signals
    };
  });

  /* code -> division for anything the Pumps sheet leaves without one */
  const fallback = {};
  outletDetails.records.forEach(function (row) {
    const code = String(pick(row, outletDetails.header, 'CODE NO')).trim();
    if (code === '') return;
    const division = canonicalDivision(pick(row, outletDetails.header, 'DIVISION'));
    if (division !== '') fallback[code] = division;
  });
  legacyPumps.records.forEach(function (row) {
    const code = String(pick(row, legacyPumps.header, 'Outlet Number')).trim();
    if (code === '') return;
    const division = canonicalDivision(pick(row, legacyPumps.header, 'Division'));
    if (division !== '') fallback[code] = division;
  });

  const categories = [];
  const divisions = [];
  Object.keys(primary).forEach(function (c) {
    const cat = primary[c].category;
    if (cat && categories.indexOf(cat) === -1) categories.push(cat);
    const d = primary[c].division;
    if (d && divisions.indexOf(d) === -1) divisions.push(d);
  });
  Object.keys(fallback).forEach(function (c) {
    const d = fallback[c];
    if (d && divisions.indexOf(d) === -1) divisions.push(d);
  });
  categories.sort();
  divisions.sort();

  return {
    primary: primary,
    fallback: fallback,
    categories: categories,
    divisions: divisions,
    choices: buildChoices(dropdowns),
    sources: [
      siteSheets ? path.basename(SITE_WORKBOOK) : null,
      pumpSheets ? path.basename(PUMP_WORKBOOK) : null
    ].filter(Boolean)
  };
}

/** DropdownLists is the allowed value set for each signal in the edit form. */
function buildChoices(dropdowns) {
  const choices = {};
  SIGNAL_COLUMNS.forEach(function (col) {
    const seen = {};
    const values = [];
    dropdowns.records.forEach(function (r) {
      const v = String(pick(r, dropdowns.header, col)).trim();
      if (v === '' || seen[norm(v)]) return;
      seen[norm(v)] = true;
      values.push(v);
    });
    choices[SIGNAL_FIELDS[col]] = values;
  });
  return choices;
}

/** The category the Pumps sheet gives an outlet, or '' when it lists none. */
function categoryFor(code, data) {
  if (!data) return '';
  const row = data.primary[String(code)];
  return row && row.category ? row.category : '';
}

/** The division an outlet belongs to, or '' when neither workbook lists it. */
function divisionFor(code, data) {
  if (!data) return '';
  const key = String(code);
  const fromPumps = data.primary[key];
  if (fromPumps && fromPumps.division) return fromPumps.division;
  return data.fallback[key] || '';
}

/**
 * Sets every outlet's category from the Pumps sheet, in place.
 * Categories pinned by hand (`manual_category`) are left alone.
 */
function applyToOutlets(outlets, data) {
  const summary = {
    sources: data ? data.sources : [],
    fromPumpSheet: 0,
    uncovered: 0,
    changed: 0,
    skippedManual: 0,
    byCategory: {}
  };
  if (!data) return summary;

  outlets.forEach(function (outlet) {
    const key = String(outlet.code);
    const fromPumps = data.primary[key];

    if (fromPumps) {
      if (fromPumps.territory) outlet.territory = fromPumps.territory;
      if (fromPumps.sales_area) outlet.sales_area = fromPumps.sales_area;
      Object.keys(fromPumps.signals).forEach(function (field) {
        outlet[field] = fromPumps.signals[field];
      });
    }

    const division = divisionFor(key, data);
    if (division) outlet.division = division;

    const category = categoryFor(key, data);
    if (category === '') { summary.uncovered++; return; }

    summary.fromPumpSheet++;
    summary.byCategory[category] = (summary.byCategory[category] || 0) + 1;

    if (outlet.manual_category) { summary.skippedManual++; return; }
    if (outlet.category !== category) summary.changed++;
    outlet.category = category;
    outlet.category_source = 'pumps-sheet';
  });

  return summary;
}

module.exports = {
  PUMP_WORKBOOK: PUMP_WORKBOOK,
  SITE_WORKBOOK: SITE_WORKBOOK,
  SIGNAL_COLUMNS: SIGNAL_COLUMNS,
  SIGNAL_FIELDS: SIGNAL_FIELDS,
  load: load,
  applyToOutlets: applyToOutlets,
  categoryFor: categoryFor,
  divisionFor: divisionFor
};
