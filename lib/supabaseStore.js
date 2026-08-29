/**
 * Minimal Supabase data layer — stands in for the local data/*.json files
 * when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both set (needed on
 * Vercel, whose filesystem is read-only/ephemeral in production, so the
 * plain fs.writeFile the app otherwise uses wouldn't persist anything).
 *
 * Talks to Supabase's REST API (PostgREST) directly over plain fetch
 * instead of the @supabase/supabase-js SDK, matching this project's
 * zero-dependency approach (see lib/xlsx.js, which hand-rolls its own
 * .xlsx reader/writer the same way). See supabase/schema.sql for the three
 * tables this reads and writes.
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const enabled = !!(SUPABASE_URL && SUPABASE_KEY);

function restUrl(path) {
  return SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/' + path;
}

async function rest(path, options) {
  options = options || {};
  const res = await fetch(restUrl(path), Object.assign({}, options, {
    headers: Object.assign({
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json'
    }, options.headers || {})
  }));
  if (!res.ok) {
    const body = await res.text().catch(function () { return ''; });
    throw new Error('Supabase ' + (options.method || 'GET') + ' ' + path + ' failed: ' + res.status + ' ' + body);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* Supabase's PostgREST caps rows per response (1000 by default) regardless
   of table size, so a plain select silently truncates outlets/facilities —
   both have 1000+ rows. Page through with limit/offset until a page comes
   back short of PAGE_SIZE. */
const PAGE_SIZE = 1000;

async function restAll(path) {
  const sep = path.indexOf('?') === -1 ? '?' : '&';
  let rows = [];
  let offset = 0;
  while (true) {
    const page = await rest(path + sep + 'limit=' + PAGE_SIZE + '&offset=' + offset);
    rows = rows.concat(page || []);
    if (!page || page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function readOutlets() {
  const rows = await restAll('outlets?select=data');
  return (rows || []).map(function (r) { return r.data; });
}

/** Full replace, matching writeJson(OUTLETS_PATH, outlets)'s whole-array-overwrite semantics. */
async function writeOutlets(outlets) {
  await rest('outlets?code=not.is.null', { method: 'DELETE' });
  if (!outlets.length) return;
  await rest('outlets', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(outlets.map(function (o) { return { code: o.code, data: o }; }))
  });
}

async function readFacilities() {
  const rows = await restAll('facilities?select=code,data');
  const out = {};
  (rows || []).forEach(function (r) { out[r.code] = r.data; });
  return out;
}

async function writeFacilities(facilities) {
  await rest('facilities?code=not.is.null', { method: 'DELETE' });
  const codes = Object.keys(facilities);
  if (!codes.length) return;
  await rest('facilities', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(codes.map(function (code) { return { code: code, data: facilities[code] }; }))
  });
}

/** Rejects when the key has never been written, mirroring fs.readFile's ENOENT on a missing file. */
async function readConfig(key) {
  const rows = await rest('app_config?select=value&key=eq.' + encodeURIComponent(key));
  if (!rows || !rows.length) throw new Error('No app_config row for "' + key + '" yet.');
  return rows[0].value;
}

async function writeConfig(key, value) {
  await rest('app_config', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ key: key, value: value }])
  });
}

module.exports = {
  enabled: enabled,
  readOutlets: readOutlets,
  writeOutlets: writeOutlets,
  readFacilities: readFacilities,
  writeFacilities: writeFacilities,
  readConfig: readConfig,
  writeConfig: writeConfig
};
