import { useEffect, useState } from 'react';
import type { ExportFormat, TransferPart } from '../../shared/types';
import { api, errorMessage, unwrap } from '../lib/api';
import { formatDuration, formatNumber } from '../lib/format';
import { isCancellation } from '../lib/transferProgress';
import { useStore } from '../state/store';
import { TransferProgressPanel } from './TransferProgressPanel';
import { suggestFileName, useToolDetection, useTransferLog } from './transfer';
import { Badge, Button, Checkbox, Field, Modal, Select, Spinner, TextInput } from './ui';

type ExportKind = ExportFormat | 'mongodump' | 'mongoexport';

const FORMAT_OPTIONS: Array<{ value: ExportKind; label: string; extension: string }> = [
  { value: 'json-array', label: 'JSON array (.json)', extension: 'json' },
  { value: 'ndjson', label: 'JSON lines / NDJSON (.ndjson)', extension: 'ndjson' },
  { value: 'csv', label: 'CSV (.csv)', extension: 'csv' },
  { value: 'mongoexport', label: 'mongoexport (external tool)', extension: 'json' },
  { value: 'mongodump', label: 'mongodump — BSON dump (external tool)', extension: '' }
];

/** What the export covers. Anything but one collection writes a directory. */
type ExportScope = 'collection' | 'selected' | 'database';

export function ExportDialog({
  connectionId,
  database,
  collection,
  onClose
}: {
  connectionId: string;
  database: string;
  /** Absent when the export was opened on a database rather than a collection. */
  collection?: string;
  onClose: () => void;
}) {
  const store = useStore();
  const [scope, setScope] = useState<ExportScope>(collection ? 'collection' : 'database');
  const [available, setAvailable] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string[]>(collection ? [collection] : []);
  const [parts, setParts] = useState<TransferPart[] | null>(null);
  const [kind, setKind] = useState<ExportKind>('json-array');
  const [target, setTarget] = useState('');
  const [filter, setFilter] = useState('');
  const [projection, setProjection] = useState('');
  const [sort, setSort] = useState('');
  const [limit, setLimit] = useState('');
  const [skip, setSkip] = useState('');
  const [fields, setFields] = useState('');
  const [prettyPrint, setPrettyPrint] = useState(false);
  const [canonical, setCanonical] = useState(false);
  const [gzip, setGzip] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const usesTool = kind === 'mongodump' || kind === 'mongoexport';
  const many = scope !== 'collection';
  // A directory holds one file per collection; a single collection is one file.
  const wantsDirectory = many || kind === 'mongodump';

  // The list is only needed once the export covers more than one collection.
  useEffect(() => {
    if (!many || available !== null) return;
    void unwrap(api.transfer.exportableCollections(connectionId, database))
      .then((names) => {
        setAvailable(names);
        setPicked((current) => (current.length > 0 ? current : names));
      })
      .catch((caught) => setError(errorMessage(caught)));
  }, [available, connectionId, database, many]);

  // mongoexport takes one collection at a time, and mongodump takes a whole
  // database but not a hand-picked set of collections.
  useEffect(() => {
    if (scope === 'selected' && usesTool) setKind('json-array');
    if (scope === 'database' && kind === 'mongoexport') setKind('json-array');
  }, [kind, scope, usesTool]);

  const toggleCollection = (name: string, on: boolean) =>
    setPicked((current) =>
      on ? [...current, name].sort() : current.filter((entry) => entry !== name)
    );
  const { tools, loading: detecting, refresh } = useToolDetection(usesTool);
  const log = useTransferLog();
  const detection = tools?.find((tool) => tool.tool === kind);
  const option = FORMAT_OPTIONS.find((entry) => entry.value === kind)!;

  const pickTarget = async () => {
    if (wantsDirectory) {
      const directory = await unwrap(
        api.dialog.openDirectory({
          title: kind === 'mongodump' ? 'Choose a dump directory' : 'Choose a directory'
        })
      );
      if (directory) setTarget(directory);
      return;
    }
    const file = await unwrap(
      api.dialog.saveFile({
        title: 'Export to file',
        defaultPath: suggestFileName(database, collection ?? database, option.extension),
        filters: [
          { name: option.label, extensions: [option.extension] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
    );
    if (file) setTarget(file);
  };

  const run = async () => {
    if (!target) {
      setError(
        wantsDirectory
          ? 'Choose a directory for the export.'
          : 'Choose where the export should be written.'
      );
      return;
    }
    if (scope === 'selected' && picked.length === 0) {
      setError('Choose at least one collection to export.');
      return;
    }
    setRunning(true);
    setError(null);
    setDone(null);
    setParts(null);
    log.reset();
    try {
      if (many && !usesTool) {
        const result = await unwrap(
          api.transfer.exportCollections({
            connectionId,
            database,
            collections: scope === 'database' ? [] : picked,
            format: kind as ExportFormat,
            directory: target,
            filter: filter || undefined,
            limit: limit ? Number(limit) : undefined,
            jsonMode: canonical ? 'canonical' : 'relaxed',
            prettyPrint
          })
        );
        setParts(result.parts ?? null);
        const collections = result.parts?.length ?? 0;
        setDone(
          `Exported ${formatNumber(result.processed)} documents from ${collections} collections in ${formatDuration(result.durationMs)} to ${result.filePath}`
        );
        if (result.failed > 0) {
          setError(
            `${result.failed} of ${collections} collections failed:\n${result.errors.join('\n')}`
          );
        }
        store.notify(
          `Exported ${formatNumber(result.processed)} documents from ${collections - result.failed} collections`
        );
      } else if (usesTool) {
        await unwrap(
          api.tools.run({
            connectionId,
            tool: kind === 'mongodump' ? 'mongodump' : 'mongoexport',
            database,
            // mongodump without a collection dumps the whole database.
            collection: many ? undefined : collection,
            target,
            gzip,
            format: kind === 'mongoexport' ? 'json' : undefined,
            fields: fields ? fields.split(',').map((field) => field.trim()) : undefined,
            query: filter || undefined
          })
        );
        setDone(`${kind} finished. Output written to ${target}`);
        store.notify(`${kind} finished`);
      } else {
        const result = await unwrap(
          api.transfer.exportCollection({
            connectionId,
            database,
            collection: collection as string,
            format: kind,
            filePath: target,
            filter: filter || undefined,
            projection: projection || undefined,
            sort: sort || undefined,
            limit: limit ? Number(limit) : undefined,
            skip: skip ? Number(skip) : undefined,
            fields: fields ? fields.split(',').map((field) => field.trim()) : undefined,
            jsonMode: canonical ? 'canonical' : 'relaxed',
            prettyPrint
          })
        );
        setDone(
          `Exported ${formatNumber(result.processed)} documents in ${formatDuration(result.durationMs)} to ${result.filePath}`
        );
        store.notify(`Exported ${formatNumber(result.processed)} documents`);
      }
    } catch (caught) {
      if (isCancellation(caught)) {
        setDone('Stopped before it finished. The partial file is still on disk.');
        store.notify('Stopped the export');
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setRunning(false);
    }
  };

  const stop = async () => {
    const jobId = log.progress?.jobId;
    if (jobId) await unwrap(api.transfer.cancel(jobId));
  };

  return (
    <Modal
      title={
        scope === 'database'
          ? `Export the ${database} database`
          : scope === 'selected'
            ? `Export collections from ${database}`
            : `Export ${database}.${collection}`
      }
      subtitle="The built-in engine talks to MongoDB directly — no external binaries required."
      onClose={onClose}
      width={700}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => void run()} disabled={running}>
            {running ? <Spinner label="Exporting…" /> : 'Export'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field
          label="What to export"
          hint={
            many
              ? 'One file per collection, in a folder named after the database.'
              : 'A single file.'
          }
        >
          <Select
            value={scope}
            onChange={(event) => setScope(event.target.value as ExportScope)}
          >
            {collection ? <option value="collection">This collection ({collection})</option> : null}
            <option value="selected">Chosen collections…</option>
            <option value="database">The whole {database} database</option>
          </Select>
        </Field>
        <Field label="Format">
          <Select value={kind} onChange={(event) => setKind(event.target.value as ExportKind)}>
            {FORMAT_OPTIONS.filter(
              (entry) =>
                !many ||
                (entry.value === 'mongodump'
                  ? scope === 'database'
                  : entry.value !== 'mongoexport')
            ).map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={wantsDirectory ? 'Output directory' : 'Output file'}>
          <div className="row">
            <TextInput value={target} onChange={(event) => setTarget(event.target.value)} />
            <Button onClick={() => void pickTarget()}>Browse…</Button>
          </div>
        </Field>
      </div>

      {scope === 'selected' ? (
        <Field
          label={`Collections — ${picked.length} of ${available?.length ?? 0} chosen`}
          wide
          hint="Every chosen collection is written to its own file."
        >
          {available === null ? (
            <Spinner label="Looking up the collections…" />
          ) : (
            <>
              <div className="row" style={{ marginBottom: 6 }}>
                <Button size="sm" onClick={() => setPicked(available)}>
                  All
                </Button>
                <Button size="sm" onClick={() => setPicked([])}>
                  None
                </Button>
              </div>
              <div className="pick-list">
                {available.map((name) => (
                  <Checkbox
                    key={name}
                    label={name}
                    checked={picked.includes(name)}
                    onChange={(on) => toggleCollection(name, on)}
                  />
                ))}
              </div>
            </>
          )}
        </Field>
      ) : null}

      {scope === 'database' && !usesTool ? (
        <div className="stack" style={{ marginBottom: 12 }}>
          <span className="dim">
            {available === null
              ? 'Looking up the collections…'
              : `${available.length} collections will be written to ${
                  target || 'the chosen directory'
                }/${database}. Views and internal collections are left out.`}
          </span>
        </div>
      ) : null}

      {usesTool ? (
        <div className="stack" style={{ marginBottom: 14 }}>
          <div className="row row-wrap">
            {detecting ? (
              <Spinner label="Looking for the tool…" />
            ) : detection?.ok ? (
              <>
                <Badge tone="green">{kind} found</Badge>
                <span className="mono faint">{detection.path}</span>
                {detection.version ? <span className="dim">v{detection.version}</span> : null}
              </>
            ) : (
              <>
                <Badge tone="red">{kind} not found</Badge>
                <span className="dim">
                  Set its full path in Settings → MongoDB Database Tools, then re-detect.
                </span>
              </>
            )}
            <Button size="sm" onClick={() => void refresh()}>
              Re-detect
            </Button>
          </div>
          {kind === 'mongodump' ? (
            <Checkbox label="Compress output (--gzip)" checked={gzip} onChange={setGzip} />
          ) : null}
        </div>
      ) : null}

      <Field
        label="Filter"
        wide
        hint={
          usesTool
            ? 'Passed to the tool as --query, so it must be strict JSON.'
            : 'Shell syntax is allowed, e.g. { createdAt: { $gt: ISODate("2024-01-01") } }'
        }
      >
        <textarea
          className="input"
          rows={2}
          value={filter}
          placeholder="{}"
          onChange={(event) => setFilter(event.target.value)}
        />
      </Field>

      {!usesTool && many ? (
        <Field label="Limit per collection" hint="Leave empty to export all of each collection.">
          <TextInput
            type="number"
            value={limit}
            placeholder="all"
            onChange={(event) => setLimit(event.target.value)}
          />
        </Field>
      ) : null}

      {!usesTool && !many ? (
        <>
          <div className="form-grid">
            <Field label="Projection" hint='e.g. { name: 1, email: 1, _id: 0 }'>
              <TextInput
                value={projection}
                onChange={(event) => setProjection(event.target.value)}
              />
            </Field>
            <Field label="Sort" hint='e.g. { createdAt: -1 }'>
              <TextInput value={sort} onChange={(event) => setSort(event.target.value)} />
            </Field>
            <Field label="Limit">
              <TextInput
                type="number"
                value={limit}
                placeholder="all"
                onChange={(event) => setLimit(event.target.value)}
              />
            </Field>
            <Field label="Skip">
              <TextInput
                type="number"
                value={skip}
                placeholder="0"
                onChange={(event) => setSkip(event.target.value)}
              />
            </Field>
          </div>

        </>
      ) : null}

      {!usesTool && kind === 'csv' && !many ? (
        <Field
          label="Columns"
          wide
          hint="Comma separated dot-paths. Leave empty to derive them from the first 500 documents."
        >
          <TextInput
            value={fields}
            placeholder="_id, name, address.city"
            onChange={(event) => setFields(event.target.value)}
          />
        </Field>
      ) : null}

      {!usesTool && kind !== 'csv' ? (
        <div className="row row-wrap">
          <Checkbox label="Pretty-print" checked={prettyPrint} onChange={setPrettyPrint} />
          <Checkbox
            label="Canonical EJSON (preserves exact BSON types)"
            checked={canonical}
            onChange={setCanonical}
          />
        </div>
      ) : null}

      {kind === 'mongoexport' ? (
        <Field label="Fields" wide hint="Required when exporting CSV through mongoexport.">
          <TextInput value={fields} onChange={(event) => setFields(event.target.value)} />
        </Field>
      ) : null}

      {log.progress && running ? (
        <TransferProgressPanel progress={log.progress} onCancel={() => void stop()} />
      ) : null}

      {log.lines.length > 0 ? (
        <div className="log-panel" ref={log.containerRef}>
          {log.lines.join('\n')}
        </div>
      ) : null}

      {parts ? (
        <div className="log-panel" style={{ marginTop: 12 }}>
          {parts
            .map((part) =>
              part.error
                ? `✗ ${part.collection} — ${part.error}`
                : `✓ ${part.collection} — ${formatNumber(part.processed)} documents → ${part.filePath}`
            )
            .join('\n')}
        </div>
      ) : null}

      {done ? (
        <div className="stack" style={{ marginTop: 12 }}>
          <Badge tone="green">{done}</Badge>
        </div>
      ) : null}
      {error ? <div className="error-box">{error}</div> : null}
    </Modal>
  );
}
