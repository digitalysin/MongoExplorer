# Mongo Explorer

A cross-platform desktop GUI for MongoDB in the spirit of Studio 3T: save as many
connections as you like, run queries and read the results as a table, inspect
database and collection statistics, and move data in and out of collections.

Everything works **without the MongoDB Database Tools installed** — connections,
queries, statistics and JSON/NDJSON/CSV import & export all go through the
official Node.js driver. `mongodump`, `mongorestore`, `mongoexport` and
`mongoimport` are strictly optional: if you want BSON dumps or prefer the
official binaries, point the app at them in **Settings → MongoDB Database
Tools** (or let it auto-detect them from your `PATH`).

![Query results](docs/screenshot-query.png)

## Features

**Connections**
- Unlimited saved connections, each with its own host list, credentials, replica
  set, read preference, timeouts and TLS settings.
- Connection-string mode or individual-field mode, including `mongodb+srv`.
- Passwords are encrypted with the OS keychain (Keychain on macOS, DPAPI on
  Windows, libsecret on Linux) and stored apart from the connection file. If the
  OS offers no encryption the app refuses to save the password rather than
  writing it in plaintext.
- Test a connection before saving; connect to several deployments at once.

**Querying**
- mongosh-flavoured editor: `db.orders.find({ status: "paid" }).sort({ createdAt: -1 })`,
  `db.orders.aggregate([...])`, `countDocuments`, `updateMany`, `distinct`, and
  helpers such as `ObjectId()`, `ISODate()`, `NumberDecimal()` and `UUID()`
  (with or without `new`).
- Multi-statement scripts with `await` and an explicit `return`.
- Results as a typed table (double-click a nested value to inspect it) or as raw
  extended JSON, plus `Explain` for the execution plan.
- Row limit per tab, and page controls when there is more than fits: the row
  range is spelled out (`rows 101–200`) and the row numbers keep counting, so
  you always know where in the collection you are. Each page is one query with
  a larger skip, so nothing is held in memory to make paging possible.
- Every run is recorded in a searchable history (consecutive identical runs
  collapse into one), and any query can be saved under a name and reopened
  later from the same library.

**Editing**

![Document editor](docs/screenshot-document-editor.png)

- Edit a cell in place: double-click it (or select it and press Enter), type, and
  it is written with `$set` as soon as you move on — Enter, Tab to the next cell,
  or simply clicking another column. Escape cancels that cell.
- Nothing has to be remembered: an unwritten change outlines the cell in amber,
  ⌘S (Ctrl+S) saves it without closing the editor so you can keep typing, and an
  edit still in the box is written rather than discarded if you re-run the query,
  switch to the JSON view, or close the tab. Each save is confirmed in the cell
  itself with a brief flash and by one toast in the corner that updates rather
  than piling up; a rejected value stops you with a dialog and leaves the editor
  open so it can be fixed. ⌘S saves the JSON document editor too.
- The field keeps the BSON type it already had — a whole number typed into a
  `double` stays a double, an `ObjectId` stays an `ObjectId` — and only the
  edited cell repaints, so the query is not re-run.
![Editing a column across a selection of documents](docs/screenshot-batch-edit.png)

- Edit a column across many documents at once: click a cell and shift-click
  another (or hold Shift and use the arrow keys) to select a range, ⌘-click or
  shift-click the row numbers to select whole documents. A bar under the table
  counts what is selected, ⌘C copies it as tab-separated text a spreadsheet
  understands, and a right-click sets the column on every selected document,
  sets it to null, unsets it, or deletes them together. A batch `$set` is one
  `updateMany` per BSON type in the selection, so an `int32` next to a `double`
  each keep what they had; on a production connection the collection name has to
  be typed before it runs.
![A range of cells selected, counted under the table](docs/screenshot-multi-select.png)

- Right-click a row for the rest: edit the document as JSON, view or copy it,
  copy a value or the `_id`, filter the query by the clicked value, set a field
  to null or unset it, duplicate the document, or delete it.
- Edit a whole document from the result table: click the row number to open it in
  canonical extended JSON, so an edit round-trip cannot turn an `int64` into a
  double. Changing `_id` is refused rather than silently ignored.
- Insert new documents into the current collection and delete existing ones.
- Create indexes with keys, name, uniqueness, sparseness, TTL, a partial filter
  expression and a collation; drop any index except `_id_`.
- Create a database from the connection row, or a collection from the database
  row. MongoDB has no standalone create-database command — a database begins to
  exist once it holds a collection — so the dialog asks for both names at once.
  Drop a database or a collection from the same rows, behind a confirmation.

**Guard rails**
- Any connection can be marked **read-only**. Writes are refused in the main
  process rather than hidden in the interface, so no dialog, context menu,
  import or piece of query code can get around it.
- A connection marked **production** makes destructive work deliberate: you
  type the name of the collection or database before it is dropped.
- A query that writes is measured before it runs. The same code is executed
  with its writes counted instead of performed, so you are told
  “`updateMany` on `shop.orders` — 1,284 documents” and can still say no.
  `$out` and `$merge` stages run without their output stage, and a raw
  `runCommand` that writes is caught too.
- The scan is deliberately eager but not naive: a `deleteMany` inside a string
  or a comment is not a write, while a write it cannot count in advance is
  still reported as one. Clear the confirmation setting to skip the prompt.

**Statistics**

![Collection statistics](docs/screenshot-statistics.png)

- Server: version, topology, host, uptime, connections, storage engine.
- Database: collection/view/object counts, data, storage and index sizes, and a
  per-collection breakdown sorted by size.
- Collection: document count, average document size, storage, index list with
  keys, uniqueness, TTL, size and usage counters, plus a sampled field profile
  showing which fields exist and in what share of documents.

**Operations**

![Live operations](docs/screenshot-operations.png)

- What the deployment is running right now, oldest first, refreshing every two
  seconds: age, operation, namespace, a one-line command summary, the plan it
  chose, and which application sent it.
- Stop a runaway operation from the list. The prompt says what it will
  interrupt, and on a production connection it asks for the operation id to be
  typed; read-only connections cannot kill anything at all.
- Driver monitoring chatter and idle connections are filtered out by default,
  and this app's own queries can be hidden, so the list holds only real work.
- Alongside it, whatever the profiler recorded as slow — how long each took,
  the plan, and documents examined against documents returned. When profiling
  is off the panel says so and tells you how to turn it on.

**Import & export**
- Export a collection to a JSON array, NDJSON or CSV with an optional filter,
  projection, sort, skip and limit. Relaxed or canonical extended JSON; CSV
  columns are derived from a sample or specified by hand, and nested fields
  become dot-paths.
- Export **several collections or a whole database** in one job: choose the
  scope in the dialog, tick the collections you want (or take all of them), and
  each is written to its own file in a folder named after the database. The
  export icon on a database row in the sidebar opens straight on it. A shared
  filter and a per-collection limit let you take a sample of every collection,
  and one progress bar spans the whole job — it counts every collection up
  front, names the one it is on, and never restarts partway. When a collection
  fails the rest still run, and the summary lists what each one wrote, with
  failures marked. Views and internal collections are left out of a
  whole-database export, since a view holds no documents of its own.
  `mongodump` can take a whole database too, if you would rather have BSON.
- Import JSON arrays, NDJSON or CSV (auto-detected from the file), streamed in
  batches so multi-gigabyte files do not have to fit in memory. Insert, merge or
  replace on a chosen match key, optionally dropping the collection first.
- Import **a whole directory** back — the other half of a batch export. Each
  file becomes a collection named after it, the format is detected per file so
  one directory can mix JSON, NDJSON and CSV, and the files found are listed
  with their sizes to tick or untick before anything runs. Point it at the
  directory you exported to and it looks one level down for the database folder,
  where the export put them. With **replace** on `_id` a re-import is a restore
  rather than a duplication; with **drop each collection first** it is a clean
  restore. One bar covers the bytes of every chosen file, a file that fails is
  reported while the rest carry on, and the summary lists what each collection
  took.
- Optional external-tool routes: `mongodump`/`mongorestore` for BSON dumps and
  `mongoexport`/`mongoimport` if you prefer them. Their output is streamed into
  the dialog's log panel.
- A long transfer shows a progress bar with the share done, the documents or
  bytes covered, how long it has been running, the current rate and roughly how
  much longer it needs. Exports divide by a counted total, imports by the size
  of the file, and the external tools by the progress they print; a job nobody
  can measure gets a moving bar rather than a fake percentage.
- **Stop** ends a running transfer without closing the app, and says what it
  left behind. Close the dialog and the status bar keeps the bar, the percentage
  and the clock until the job ends.

![Exporting several collections at once](docs/screenshot-export-many.png)

![Importing a directory back](docs/screenshot-import-directory.png)

![Import in progress](docs/screenshot-import-progress.png)

**Telling you what happened**
- A finished operation confirms itself with a small toast in the corner that
  fades on its own — no OS notifications, nothing to dismiss.
- A failed one stops you with a dialog naming the operation and quoting the
  reason underneath, because a failure you can scroll past is worse than none.
  Even a promise nobody caught ends up there rather than only in the console.

![Settings with tool paths](docs/screenshot-settings.png)

## Requirements

- Node.js 20 or newer (only to build; the packaged app is self-contained).
- A reachable MongoDB deployment (4.4+ recommended).

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` starts the Vite dev server for the renderer, rebuilds the main and
preload bundles on change, and launches Electron against them.

## Building distributables

```bash
npm run icon        # regenerate build/icon.png (already committed)
npm run dist:mac    # .dmg + .zip  (arm64 + x64)
npm run dist:win    # NSIS installer + portable .exe
npm run dist:linux  # AppImage + .deb + .tar.gz
```

Installers land in `release/`. Each platform must be built on its own OS, or in
CI: `.github/workflows/build.yml` builds all three on every pull request and
uploads the installers as artifacts.

## Releases

Every push to `main` publishes a GitHub Release, via
`.github/workflows/release.yml`:

1. **verify** — typecheck, build and the smoke suite against a real MongoDB.
2. **version** — bumps the patch version, commits it back to `main` as
   `chore: release vX.Y.Z [skip ci]` and pushes the tag. Nothing is released if
   verification failed.
3. **package** — macOS, Linux and Windows build in parallel from that tag and
   upload their installers into a single draft release.
4. **publish** — flips the draft to the latest release, with notes listing every
   commit since the previous tag.

The bump is pushed with `GITHUB_TOKEN`, which by design does not trigger another
run, so releases cannot loop. For a MINOR or MAJOR release, bump the version
yourself (`npm version minor --no-git-tag-version`) and push; the next patch bump
continues from there.

macOS builds are unsigned by default. To sign and notarise, set
`CSC_LINK`/`CSC_KEY_PASSWORD` and the notarisation credentials before running
`npm run dist:mac`.

## Verifying

```bash
npm run typecheck   # renderer and main process
npm run smoke       # end-to-end services test against a real mongod
npm run ui-check    # boots the real UI, clicks through it, writes screenshots
```

Both harnesses start a throwaway `mongod` on port 27099 and shut it down
afterwards; if something is already listening there they reuse it instead. Set
`MONGO_TEST_PORT` to move it, or start your own server beforehand if `mongod` is
not on your `PATH`.

The smoke test's 47 checks cover query execution and serialization, cursor
limits, shell helpers, statistics, index creation and dropping, document
editing with BSON-type preservation, query history and saved queries, every
import/export format, CSV quoting edge cases, duplicate-key handling, the
external-tool integration and secret storage. `ui-check` clicks through the real
UI, writes screenshots to `artifacts/`, and fails on any renderer console error.

## Project layout

```
electron/            main process
  main.ts            window, menu, lifecycle
  ipc.ts             every IPC handler, each returning a Result envelope
  services/
    store.ts         connection/settings files + OS-encrypted secret vault
    connections.ts   connection CRUD, URI building, client options
    pool.ts          live MongoClients and server info
    query.ts         query evaluation and result shaping
    stats.ts         statistics, index management, document editing
    library.ts       query history and saved queries
    transfer.ts      native streaming import & export
    tools.ts         optional MongoDB Database Tools detection and execution
    csv.ts           CSV encode/parse and document flattening
    bsonEval.ts      shell-style BSON helpers for user-supplied expressions
electron/preload.ts  the only renderer↔main bridge (context isolation is on)
shared/types.ts      types shared by both processes
src/                 React renderer
scripts/             build, dev, icon, mongod, smoke and UI-check harnesses
```

## Security notes

- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`;
  it can only reach the API surface declared in `shared/types.ts`.
- A content security policy blocks remote scripts, and external links open in
  the system browser.
- Query code runs in the main process (it needs the driver), with `require`,
  `process`, `module` and the other Node globals shadowed. Treat the editor with
  the same trust you would give a `mongosh` session: do not paste code you have
  not read.
- Passwords never appear in logs; connection strings are redacted before being
  shown or passed to external tools.

## Licence

Copyright © 2026 digitalysin. Released under the [MIT licence](LICENSE).
