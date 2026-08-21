# PSO North Region Site Map — Merged App

This package combines:
- **Frontend UI/UX**: the new frontend you supplied (`PSO_North_Region_Site_Map__4_.html`) — kept exactly as-is, including the nearby search, geolocation, facility filters (Shop Stop / VIBE / PSO Cards / alliances), inline "Edit details" panel, CSV export, and the full mobile bottom-sheet experience.
- **Backend**: rebuilt from the `anti` package's Node/Express server, converted to a dependency-free Node `http` server (no `npm install` required) so it runs anywhere with just Node.js installed.
- **Categorisation data**: the outlet **category** field (Metropolitan/CBD, Local Convenience, Agri/Rural, Pitstop, Highway) uses the corrected categorisation from the `anti` dataset, as requested — everything else about each outlet (name, coordinates, facilities, etc.) comes from the new frontend's dataset.

## New features added (ported from the `anti` frontend, restyled to match the new UI)

In the left-hand rail (desktop) and the mobile menu, there is now a **"Manage outlets"** section with two actions:

### + Add new pump
Opens a form to add a pump with:
- Outlet code, name, address, city, district, province, sales area
- **Category dropdown** — pick an existing category, or choose **"+ Add new category"** to create a brand-new one on the fly (name + colour). New categories are saved to the backend and immediately appear in the filter rail, legend, and mobile chips.
- Operation type, financing, ATP, runner-up category, match confidence
- **Latitude/longitude fields**, plus a **"Mark location on map"** button — click it, then click anywhere on the map (or drag the pin) to set the coordinates instead of typing them.

New pumps appear on the map immediately and are saved to `data/outlets.json` on the server.

### Remove pump
Search by name or code, pick the pump from the results, confirm — it's removed from the map and deleted from `data/outlets.json` (and its facility record, if any).

Existing **Edit details** (already in the new frontend) now also saves changes back to the server, so edits persist across restarts.

### Export outlet sheet

Available from the left rail on desktop and from the mobile menu / filter drawer.
Exports either **all outlets** or **only the sites the current filters show**, as:

- **Excel (.xlsx)** — generated server-side, no npm packages involved.
- **CSV**.
- **Send to WhatsApp** — where the browser supports sharing files (phones, and
  desktops with Web Share), the sheet goes straight into the OS share sheet and
  you pick WhatsApp. Everywhere else the sheet is downloaded and WhatsApp is
  opened with a covering message to attach it to, with an **Open WhatsApp** link
  as a backstop in case a popup blocker swallows the automatic open.

The sheet's columns are the same ones the **Pumps** tab of the pump workbook
uses, so an export can be filled in and handed straight back through the import.

### Import outlet sheet (admin only)

Also in the rail and the mobile menu. Updates existing site data from a sheet
(.xlsx or .csv) whose column names match the export exactly. A sheet with any
column missing, misspelt, repeated or extra is **rejected and nothing is
changed** — the error names the offending columns.

Uploading requires the **admin password**, which defaults to `pso-admin`.
Change it by setting an environment variable before starting the server:

```bash
PSO_ADMIN_PASSWORD='your-password' node server.js
```

Rows are matched on `Outlet Number`. A row whose code is not yet in the
database is added as a new outlet; a row with no code is skipped and reported.

### Categorisation from the pump workbook

`Site Data/PSO_Pump_Data_v3.xlsx` drives the site categories:

- Its **Definitions** tab is the rubric — one row per category (Metropolitan/CBD,
  Local Convenience, Agri/Rural, Pitstop, Highway) giving the signals that
  category implies.
- Its **Pumps** tab records those signals per outlet, plus Division / Territory /
  Sales Area.

At startup the server scores each outlet's recorded signals against the rubric
and assigns the best-matching category, weighting land use and location context
highest — the order the workbook itself recommends. Of the 379 pump rows, 373
match an outlet and 151 carry enough signals to be scored; the rest keep their
stored category.

The signals are shown in each site's detail panel and can be edited from the
**Edit details** form, which re-scores the category on save. Choosing a category
by hand pins it (`manual_category`), so later syncs and imports leave it alone.

## Running it

```bash
npm start
# or simply:
node server.js
```

Then open **http://localhost:3000**.

No `npm install` is required — the server only uses Node's built-in modules.

## Project structure

```
server.js            — backend (outlets, categories, facilities, sheet export/import + static files)
package.json
lib/
  xlsx.js             — dependency-free .xlsx reader and writer (Node zlib only)
  schema.js           — the outlet sheet column contract shared by export and import
  pumpData.js         — reads the pump workbook and scores categories against its rubric
Site Data/
  PSO_Pump_Data_v3.xlsx — categorisation rubric + per-outlet signals
data/
  outlets.json        — 1,052 outlets (new frontend's data, anti's category assignments)
  categories.json      — 5 categories + colours (extendable via the Add Pump form)
  facilities.json      — Shop Stop / VIBE / PSO Cards / alliance data, keyed by outlet code
public/
  index.html           — the frontend (new UI, with Add/Remove pump features added)
```

## API

| Method | Endpoint                 | Purpose                                  |
|--------|---------------------------|-------------------------------------------|
| GET    | `/api/outlets`             | List all outlets                          |
| POST   | `/api/outlets`             | Add a new outlet                          |
| PUT    | `/api/outlets/:code`       | Update an outlet                          |
| DELETE | `/api/outlets/:code`       | Delete an outlet                          |
| GET    | `/api/categories`          | List categories                           |
| POST   | `/api/categories`          | Add/update a category                     |
| GET    | `/api/facilities`          | List facility (Shop/VIBE/Cards) records   |
| PUT    | `/api/facilities/:code`    | Update a facility record                  |
| GET    | `/api/schema`             | Sheet column names + rubric dropdown values |
| GET/POST | `/api/export.xlsx`       | Outlet sheet as Excel (POST body `{codes}` to limit scope) |
| GET/POST | `/api/export.csv`        | Outlet sheet as CSV                       |
| POST   | `/api/import`             | Admin: update site data from a matching sheet |
| POST   | `/api/categorise`         | Admin: re-run the pump-sheet categorisation |
| POST   | `/api/admin/verify`       | Check the admin password                  |

If the server is unreachable (e.g. the page is opened directly as a file), the frontend falls back to its embedded dataset so the map still works standalone — you just won't be able to persist new pumps.
