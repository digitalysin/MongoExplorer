import { useEffect, useState } from 'react';
import type { AppSettings, MongoToolName, ToolDetection } from '../../shared/types';
import { api, errorMessage, unwrap } from '../lib/api';
import { useStore } from '../state/store';
import { Badge, Button, Checkbox, Field, Modal, Select, Spinner, TextInput } from './ui';

const TOOLS: Array<{ name: MongoToolName; description: string }> = [
  { name: 'mongodump', description: 'Binary BSON dump of a database or collection' },
  { name: 'mongorestore', description: 'Restores a BSON dump produced by mongodump' },
  { name: 'mongoexport', description: 'Exports JSON/CSV using the official exporter' },
  { name: 'mongoimport', description: 'Imports JSON/CSV using the official importer' },
  { name: 'mongosh', description: 'Detected for reference; queries run through the driver' }
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const [draft, setDraft] = useState<AppSettings | null>(store.settings);
  const [detections, setDetections] = useState<ToolDetection[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [versions, setVersions] = useState<{
    app: string;
    electron: string;
    node: string;
    driver: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(store.settings);
  }, [store.settings]);

  useEffect(() => {
    void unwrap(api.app.version()).then(setVersions).catch(() => undefined);
    void detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detect = async () => {
    setDetecting(true);
    try {
      setDetections(await unwrap(api.tools.detect()));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setDetecting(false);
    }
  };

  if (!draft) return null;

  const patch = (changes: Partial<AppSettings>) =>
    setDraft((current) => (current ? { ...current, ...changes } : current));

  const save = async () => {
    await store.updateSettings(draft);
    await detect();
    onClose();
  };

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      width={760}
      footer={
        <>
          <span className="faint mono">
            {versions
              ? `Mongo Explorer ${versions.app} · Electron ${versions.electron} · Node ${versions.node} · driver ${versions.driver}`
              : ''}
          </span>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <section style={{ marginBottom: 22 }}>
        <h3 className="sidebar-title" style={{ marginBottom: 10 }}>
          Appearance & defaults
        </h3>
        <div className="form-grid">
          <Field label="Theme">
            <Select
              value={draft.theme}
              onChange={(event) => patch({ theme: event.target.value as AppSettings['theme'] })}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">Match system</option>
            </Select>
          </Field>
          <Field label="Default query limit">
            <TextInput
              type="number"
              value={draft.defaultQueryLimit}
              onChange={(event) => patch({ defaultQueryLimit: Number(event.target.value) || 200 })}
            />
          </Field>
          <Field label="CSV delimiter">
            <TextInput
              maxLength={1}
              value={draft.csvDelimiter}
              onChange={(event) => patch({ csvDelimiter: event.target.value })}
            />
          </Field>
        </div>
        <Checkbox
          label="Ask before dropping collections and databases"
          checked={draft.confirmDestructiveOps}
          onChange={(checked) => patch({ confirmDestructiveOps: checked })}
        />
      </section>

      <section>
        <h3 className="sidebar-title" style={{ marginBottom: 6 }}>
          MongoDB Database Tools (optional)
        </h3>
        <p className="dim" style={{ marginTop: 0, lineHeight: 1.6 }}>
          Mongo Explorer never needs these — connections, queries, statistics and JSON/CSV
          import/export all run through the MongoDB driver. Point to the binaries only if you want
          BSON dumps via <span className="inline-code">mongodump</span> /{' '}
          <span className="inline-code">mongorestore</span> or prefer the official
          exporter/importer. Leave a path empty to auto-detect from your <code>PATH</code>.
        </p>

        <div className="row" style={{ marginBottom: 10 }}>
          <Checkbox
            label="Prefer the external tools for import/export when available"
            checked={draft.useMongoTools}
            onChange={(checked) => patch({ useMongoTools: checked })}
          />
          <span className="spacer" />
          <Button size="sm" onClick={() => void detect()} disabled={detecting}>
            {detecting ? <Spinner label="Detecting…" /> : 'Detect installed tools'}
          </Button>
        </div>

        {TOOLS.map(({ name, description }) => {
          const detection = detections?.find((entry) => entry.tool === name);
          return (
            <div key={name} style={{ marginBottom: 14 }}>
              <div className="row" style={{ marginBottom: 4 }}>
                <span className="mono" style={{ fontWeight: 600 }}>
                  {name}
                </span>
                {detection?.ok ? (
                  <Badge tone="green">
                    found{detection.version ? ` · v${detection.version}` : ''}
                  </Badge>
                ) : (
                  <Badge tone="amber">not found</Badge>
                )}
                <span className="faint">{description}</span>
              </div>
              <div className="row">
                <TextInput
                  placeholder={detection?.path ?? `/usr/local/bin/${name}`}
                  value={draft.toolPaths[name]}
                  onChange={(event) =>
                    patch({ toolPaths: { ...draft.toolPaths, [name]: event.target.value } })
                  }
                />
                <Button
                  onClick={async () => {
                    const picked = await unwrap(
                      api.dialog.openFile({ title: `Locate ${name}` })
                    );
                    if (picked) patch({ toolPaths: { ...draft.toolPaths, [name]: picked } });
                  }}
                >
                  Browse…
                </Button>
                {detection?.path && !draft.toolPaths[name] ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Use the detected path"
                    onClick={() =>
                      patch({ toolPaths: { ...draft.toolPaths, [name]: detection.path! } })
                    }
                  >
                    Use detected
                  </Button>
                ) : null}
              </div>
              {detection && !detection.ok && detection.error ? (
                <span className="field-hint" style={{ color: 'var(--danger)' }}>
                  {detection.error}
                </span>
              ) : null}
            </div>
          );
        })}
      </section>

      {error ? <div className="error-box">{error}</div> : null}
    </Modal>
  );
}
