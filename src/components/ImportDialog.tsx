import { useEffect, useState } from 'react';
import type { ImportCandidate, ImportFormat, ImportMode, TransferPart } from '../../shared/types';
import { api, errorMessage, unwrap } from '../lib/api';
import { formatBytes, formatDuration, formatNumber, plural } from '../lib/format';
import { isCancellation } from '../lib/transferProgress';
import { useStore } from '../state/store';
import { TransferProgressPanel } from './TransferProgressPanel';
import { useToolDetection, useTransferLog } from './transfer';
import { Badge, Button, Checkbox, Field, Modal, Select, Spinner, TextInput } from './ui';

type ImportKind = ImportFormat | 'mongorestore' | 'mongoimport';

/** One file into one collection, or a directory of them. */
type ImportScope = 'file' | 'directory';

const FORMAT_OPTIONS: Array<{ value: ImportKind; label: string }> = [
  { value: 'auto', label: 'Detect from file (JSON / NDJSON / CSV)' },
  { value: 'json-array', label: 'JSON array' },
  { value: 'ndjson', label: 'JSON lines / NDJSON' },
  { value: 'csv', label: 'CSV' },
  { value: 'mongoimport', label: 'mongoimport (external tool)' },
  { value: 'mongorestore', label: 'mongorestore — BSON dump (external tool)' }
];

export function ImportDialog({
  connectionId,
  database,
  collection: initialCollection,
  onClose,
  onImported
}: {
  connectionId: string;
  database: string;
  collection?: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const store = useStore();
  const [scope, setScope] = useState<ImportScope>('file');
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [parts, setParts] = useState<TransferPart[] | null>(null);
  const [collection, setCollection] = useState(initialCollection ?? '');
  const [kind, setKind] = useState<ImportKind>('auto');
  const [source, setSource] = useState('');
  const [mode, setMode] = useState<ImportMode>('insert');
  const [upsertFields, setUpsertFields] = useState('_id');
  const [drop, setDrop] = useState(false);
  const [stopOnError, setStopOnError] = useState(false);
  const [batchSize, setBatchSize] = useState('1000');
  const [csvDelimiter, setCsvDelimiter] = useState(',');
  const [csvHasHeader, setCsvHasHeader] = useState(true);
  const [csvInferTypes, setCsvInferTypes] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const usesTool = kind === 'mongorestore' || kind === 'mongoimport';
  const many = scope === 'directory' && !usesTool;
  const { tools, loading: detecting, refresh } = useToolDetection(usesTool);
  const log = useTransferLog();
  const detection = tools?.find((tool) => tool.tool === kind);

  // What the chosen directory holds, so the user sees it before it runs.
  useEffect(() => {
    if (!many || !source) {
      setCandidates(null);
      return;
    }
    let current = true;
    void unwrap(api.transfer.importableFiles(source))
      .then((found) => {
        if (!current) return;
        setCandidates(found);
        setPicked(found.map((candidate) => candidate.filePath));
      })
      .catch((caught) => {
        if (current) setError(errorMessage(caught));
      });
    return () => {
      current = false;
    };
  }, [many, source]);

  // The tools bring their own directory handling, and a format per file is
  // detected on the way in, so neither choice belongs to a directory import.
  useEffect(() => {
    if (scope === 'directory' && !usesTool && kind !== 'auto') setKind('auto');
  }, [kind, scope, usesTool]);

  const toggleFile = (filePath: string, on: boolean) =>
    setPicked((current) =>
      on ? [...current, filePath] : current.filter((entry) => entry !== filePath)
    );

  const pickSource = async () => {
    if (kind === 'mongorestore' || many) {
      const directory = await unwrap(
        api.dialog.openDirectory({
          title: many ? 'Choose a directory of files' : 'Choose the dump directory'
        })
      );
      if (directory) setSource(directory);
      return;
    }
    const file = await unwrap(
      api.dialog.openFile({
        title: 'Choose a file to import',
        filters: [
          { name: 'Data files', extensions: ['json', 'ndjson', 'jsonl', 'csv', 'tsv'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
    );
    if (file) setSource(file);
  };

  const run = async () => {
    if (!source) {
      setError('Choose the file or directory to import.');
      return;
    }
    if (!usesTool && !many && !collection.trim()) {
      setError('Enter the target collection name.');
      return;
    }
    if (many && picked.length === 0) {
      setError('Choose at least one file to import.');
      return;
    }
    setRunning(true);
    setError(null);
    setDone(null);
    setParts(null);
    log.reset();
    try {
      if (many) {
        const result = await unwrap(
          api.transfer.importDirectory({
            connectionId,
            database,
            directory: source,
            files: picked,
            mode,
            upsertFields:
              mode === 'insert'
                ? undefined
                : upsertFields.split(',').map((field) => field.trim()).filter(Boolean),
            dropBeforeImport: drop,
            stopOnError,
            batchSize: Number(batchSize) || 1000,
            csvDelimiter,
            csvHasHeader,
            csvInferTypes
          })
        );
        setParts(result.parts ?? null);
        const collections = result.parts?.length ?? 0;
        setDone(
          `Imported ${plural(result.processed, 'document')} into ${plural(
            collections,
            'collection'
          )} in ${formatDuration(result.durationMs)}`
        );
        if (result.ok) {
          store.notify(
            `Imported ${plural(result.processed, 'document')} into ${plural(
              collections,
              'collection'
            )}`
          );
        } else {
          store.reportError(
            `The import finished with problems in ${result.errors.length} of ${plural(
              collections,
              'collection'
            )}`,
            result.errors.slice(0, 5).join('\n')
          );
        }
      } else if (usesTool) {
        await unwrap(
          api.tools.run({
            connectionId,
            tool: kind === 'mongorestore' ? 'mongorestore' : 'mongoimport',
            database,
            collection: collection.trim() || undefined,
            target: source,
            drop,
            format: kind === 'mongoimport' ? (source.endsWith('.csv') ? 'csv' : 'json') : undefined
          })
        );
        setDone(`${kind} finished.`);
        store.notify(`${kind} finished`);
      } else {
        const result = await unwrap(
          api.transfer.importCollection({
            connectionId,
            database,
            collection: collection.trim(),
            format: kind as ImportFormat,
            filePath: source,
            mode,
            upsertFields:
              mode === 'insert'
                ? undefined
                : upsertFields.split(',').map((field) => field.trim()).filter(Boolean),
            dropBeforeImport: drop,
            stopOnError,
            batchSize: Number(batchSize) || 1000,
            csvDelimiter,
            csvHasHeader,
            csvInferTypes
          })
        );
        setDone(
          `Imported ${formatNumber(result.processed)} documents in ${formatDuration(result.durationMs)}${
            result.failed > 0 ? ` — ${formatNumber(result.failed)} failed` : ''
          }`
        );
        if (result.failed > 0) {
          store.reportError(
            `${formatNumber(result.failed)} of ${formatNumber(
              result.processed + result.failed
            )} documents were not imported`,
            result.errors.slice(0, 5).join('\n')
          );
        } else {
          store.notify(`Imported ${formatNumber(result.processed)} documents`);
        }
      }
      onImported();
    } catch (caught) {
      if (isCancellation(caught)) {
        setDone('Stopped before it finished. Documents already written stay in the collection.');
        store.notify('Stopped the import');
        onImported();
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
      title={many ? `Import a directory into ${database}` : `Import into ${database}`}
      subtitle="JSON, NDJSON and CSV are read natively; BSON dumps need mongorestore."
      onClose={onClose}
      width={700}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => void run()} disabled={running}>
            {running ? <Spinner label="Importing…" /> : 'Import'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field
          label="What to import"
          hint={many ? 'One collection per file, named after the file.' : 'A single file.'}
        >
          <Select value={scope} onChange={(event) => setScope(event.target.value as ImportScope)}>
            <option value="file">One file</option>
            <option value="directory">A directory of files</option>
          </Select>
        </Field>
        <Field label="Source format">
          <Select value={kind} onChange={(event) => setKind(event.target.value as ImportKind)}>
            {FORMAT_OPTIONS.filter(
              (entry) =>
                scope === 'file' ||
                entry.value === 'auto' ||
                entry.value === 'mongorestore' ||
                entry.value === 'mongoimport'
            ).map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={kind === 'mongorestore' ? 'Dump directory' : many ? 'Source directory' : 'Source file'}
        >
          <div className="row">
            <TextInput value={source} onChange={(event) => setSource(event.target.value)} />
            <Button onClick={() => void pickSource()}>Browse…</Button>
          </div>
        </Field>
        {!many ? (
          <Field
            label="Target collection"
            hint={
              kind === 'mongorestore'
                ? 'Leave empty to restore every collection in the dump.'
                : 'Created automatically if it does not exist.'
            }
          >
            <TextInput value={collection} onChange={(event) => setCollection(event.target.value)} />
          </Field>
        ) : null}
        {!usesTool ? (
          <Field label="Batch size">
            <TextInput
              type="number"
              value={batchSize}
              onChange={(event) => setBatchSize(event.target.value)}
            />
          </Field>
        ) : null}
      </div>

      {many && source ? (
        <Field
          label={`Files — ${picked.length} of ${candidates?.length ?? 0} chosen`}
          wide
          hint="Each file lands in a collection named after it. Formats are detected per file."
        >
          {candidates === null ? (
            <Spinner label="Looking in the directory…" />
          ) : candidates.length === 0 ? (
            <span className="dim">
              No JSON, NDJSON or CSV files here. Choose the directory that holds the files.
            </span>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 6 }}>
                <Button
                  size="sm"
                  onClick={() => setPicked(candidates.map((candidate) => candidate.filePath))}
                >
                  All
                </Button>
                <Button size="sm" onClick={() => setPicked([])}>
                  None
                </Button>
              </div>
              <div className="pick-list">
                {candidates.map((candidate) => (
                  <Checkbox
                    key={candidate.filePath}
                    label={`${candidate.collection} — ${formatBytes(candidate.bytes)}`}
                    checked={picked.includes(candidate.filePath)}
                    onChange={(on) => toggleFile(candidate.filePath, on)}
                  />
                ))}
              </div>
            </>
          )}
        </Field>
      ) : null}

      {usesTool ? (
        <div className="row row-wrap" style={{ marginBottom: 14 }}>
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
              <span className="dim">Set its full path in Settings → MongoDB Database Tools.</span>
            </>
          )}
          <Button size="sm" onClick={() => void refresh()}>
            Re-detect
          </Button>
        </div>
      ) : null}

      {!usesTool ? (
        <>
          <div className="form-grid">
            <Field label="On duplicate">
              <Select value={mode} onChange={(event) => setMode(event.target.value as ImportMode)}>
                <option value="insert">Insert only (fail on duplicates)</option>
                <option value="upsert">Merge fields into existing documents</option>
                <option value="replace">Replace existing documents</option>
              </Select>
            </Field>
            {mode !== 'insert' ? (
              <Field label="Match on fields" hint="Comma separated, e.g. _id or email, tenantId">
                <TextInput
                  value={upsertFields}
                  onChange={(event) => setUpsertFields(event.target.value)}
                />
              </Field>
            ) : null}
          </div>

          {kind === 'csv' ||
          (kind === 'auto' && !many && source.toLowerCase().endsWith('.csv')) ||
          (many && (candidates ?? []).some((candidate) => candidate.filePath.endsWith('.csv'))) ? (
            <div className="form-grid">
              <Field label="Delimiter">
                <TextInput
                  value={csvDelimiter}
                  maxLength={1}
                  onChange={(event) => setCsvDelimiter(event.target.value)}
                />
              </Field>
              <div>
                <Checkbox
                  label="First row contains column names"
                  checked={csvHasHeader}
                  onChange={setCsvHasHeader}
                />
                <Checkbox
                  label="Detect numbers, booleans and dates"
                  checked={csvInferTypes}
                  onChange={setCsvInferTypes}
                />
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="row row-wrap">
        <Checkbox
          label={many ? 'Drop each target collection first' : 'Drop the target collection first'}
          checked={drop}
          onChange={setDrop}
        />
        {!usesTool ? (
          <Checkbox label="Stop on first error" checked={stopOnError} onChange={setStopOnError} />
        ) : null}
      </div>

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
                : `✓ ${part.collection} — ${formatNumber(part.processed)} documents${
                    part.failed ? `, ${formatNumber(part.failed)} failed` : ''
                  }`
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
