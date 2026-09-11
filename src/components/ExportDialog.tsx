import { useState } from 'react';
import type { ExportFormat } from '../../shared/types';
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

export function ExportDialog({
  connectionId,
  database,
  collection,
  onClose
}: {
  connectionId: string;
  database: string;
  collection: string;
  onClose: () => void;
}) {
  const store = useStore();
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
  const { tools, loading: detecting, refresh } = useToolDetection(usesTool);
  const log = useTransferLog();
  const detection = tools?.find((tool) => tool.tool === kind);
  const option = FORMAT_OPTIONS.find((entry) => entry.value === kind)!;

  const pickTarget = async () => {
    if (kind === 'mongodump') {
      const directory = await unwrap(api.dialog.openDirectory({ title: 'Choose a dump directory' }));
      if (directory) setTarget(directory);
      return;
    }
    const file = await unwrap(
      api.dialog.saveFile({
        title: 'Export to file',
        defaultPath: suggestFileName(database, collection, option.extension),
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
      setError('Choose where the export should be written.');
      return;
    }
    setRunning(true);
    setError(null);
    setDone(null);
    log.reset();
    try {
      if (usesTool) {
        await unwrap(
          api.tools.run({
            connectionId,
            tool: kind === 'mongodump' ? 'mongodump' : 'mongoexport',
            database,
            collection,
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
            collection,
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
      title={`Export ${database}.${collection}`}
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
        <Field label="Format">
          <Select value={kind} onChange={(event) => setKind(event.target.value as ExportKind)}>
            {FORMAT_OPTIONS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={kind === 'mongodump' ? 'Output directory' : 'Output file'}>
          <div className="row">
            <TextInput value={target} onChange={(event) => setTarget(event.target.value)} />
            <Button onClick={() => void pickTarget()}>Browse…</Button>
          </div>
        </Field>
      </div>

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

      {!usesTool ? (
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

          {kind === 'csv' ? (
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
          ) : (
            <div className="row row-wrap">
              <Checkbox label="Pretty-print" checked={prettyPrint} onChange={setPrettyPrint} />
              <Checkbox
                label="Canonical EJSON (preserves exact BSON types)"
                checked={canonical}
                onChange={setCanonical}
              />
            </div>
          )}
        </>
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

      {done ? (
        <div className="stack" style={{ marginTop: 12 }}>
          <Badge tone="green">{done}</Badge>
        </div>
      ) : null}
      {error ? <div className="error-box">{error}</div> : null}
    </Modal>
  );
}
