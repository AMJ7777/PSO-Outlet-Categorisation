/**
 * One-time push of the local data/*.json files into Supabase. Run this
 * once, after creating a Supabase project and running supabase/schema.sql
 * in its SQL editor, to seed the tables from what's on disk here:
 *
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=xxxx \
 *   node scripts/migrate-to-supabase.js
 *
 * Safe to re-run — each table is fully replaced from the local files
 * every time, same as a normal writeJson() call in the app.
 */
const path = require('path');
const fs = require('fs');
const supabaseStore = require('../lib/supabaseStore');

const DATA_DIR = path.join(__dirname, '..', 'data');

function readJsonFile(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
}

async function main() {
  if (!supabaseStore.enabled) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first — see the header comment in this file.');
    process.exitCode = 1;
    return;
  }

  const outlets = readJsonFile('outlets.json');
  console.log('Writing ' + outlets.length + ' outlets...');
  await supabaseStore.writeOutlets(outlets);

  const facilities = readJsonFile('facilities.json');
  console.log('Writing ' + Object.keys(facilities).length + ' facility records...');
  await supabaseStore.writeFacilities(facilities);

  const categories = readJsonFile('categories.json');
  console.log('Writing categories...');
  await supabaseStore.writeConfig('categories', categories);

  const columnConfig = readJsonFile('column-config.json');
  console.log('Writing column config...');
  await supabaseStore.writeConfig('column_config', columnConfig);

  try {
    const customColumns = readJsonFile('custom-columns.json');
    console.log('Writing custom columns...');
    await supabaseStore.writeConfig('custom_columns', customColumns);
  } catch (e) {
    console.log('No custom-columns.json yet — skipping (fine, none have been added).');
  }

  console.log('Done.');
}

main().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exitCode = 1;
});
