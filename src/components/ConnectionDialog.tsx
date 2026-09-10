import { useEffect, useState } from 'react';
import type { ConnectionConfig, ConnectionSecrets, ServerInfo } from '../../shared/types';
import { api, errorMessage, unwrap } from '../lib/api';
import { useStore } from '../state/store';
import { Badge, Button, Checkbox, Field, Modal, Select, Spinner, TextInput } from './ui';

type Draft = Partial<ConnectionConfig> & { name: string };

const EMPTY_DRAFT: Draft = {
  name: '',
  mode: 'uri',
  uri: 'mongodb://localhost:27017',
  hosts: ['localhost:27017'],
  srv: false,
  readPreference: 'primary',
  authMechanism: 'DEFAULT',
  savePassword: true,
  connectTimeoutMs: 10_000,
  serverSelectionTimeoutMs: 10_000,
  tls: {
    enabled: false,
    allowInvalidCertificates: false,
    allowInvalidHostnames: false
  }
};

export function ConnectionDialog({
  initial,
  onClose,
  onSaved
}: {
  initial: ConnectionConfig | null;
  onClose: () => void;
  onSaved: (config: ConnectionConfig, connectNow: boolean) => void;
}) {
  const store = useStore();
  const [draft, setDraft] = useState<Draft>(initial ? { ...EMPTY_DRAFT, ...initial } : EMPTY_DRAFT);
  const [password, setPassword] = useState('');
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [tab, setTab] = useState<'general' | 'tls' | 'advanced'>('general');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!initial) return;
    void unwrap(api.connections.hasSavedPassword(initial.id))
      .then(setHasStoredPassword)
      .catch(() => setHasStoredPassword(false));
  }, [initial]);

  // A test result describes the values as they were when it ran; once a field changes it is stale
  // and only misleads, so it goes away with the edit.
  const patch = (changes: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setError(null);
    setTestResult(null);
  };

  const secrets = (): ConnectionSecrets => (password ? { password } : {});

  const runTest = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      // Always test what is on screen: testing the saved connection would ignore unsaved edits.
      const info = await unwrap(api.connections.testDraft(draft, secrets()));
      setTestResult(info);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setTesting(false);
    }
  };

  const save = async (connectNow: boolean) => {
    if (!draft.name.trim()) {
      setError('Give the connection a name so you can tell it apart from the others.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await unwrap(api.connections.save(draft, secrets()));
      await store.refreshConnections();
      onSaved(saved, connectNow);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={initial ? `Edit "${initial.name}"` : 'New connection'}
      subtitle="Every connection is saved separately, with its own credentials in the OS keychain."
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button onClick={() => void runTest()} disabled={testing}>
            {testing ? <Spinner label="Testing…" /> : 'Test connection'}
          </Button>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save(false)} disabled={saving}>
            Save
          </Button>
          <Button variant="primary" onClick={() => void save(true)} disabled={saving}>
            Save & connect
          </Button>
        </>
      }
    >
      <div className="segmented" style={{ marginBottom: 16 }}>
        {(['general', 'tls', 'advanced'] as const).map((key) => (
          <button
            key={key}
            className={tab === key ? 'is-active' : ''}
            onClick={() => setTab(key)}
            type="button"
          >
            {key === 'tls' ? 'TLS/SSL' : key === 'general' ? 'General' : 'Advanced'}
          </button>
        ))}
      </div>

      {tab === 'general' ? (
        <>
          <div className="form-grid">
            <Field label="Connection name">
              <TextInput
                value={draft.name}
                autoFocus
                placeholder="Production — orders"
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Field>
            <Field label="Colour tag" hint="Shown as the status dot in the sidebar.">
              <TextInput
                type="color"
                value={draft.color ?? '#3ba55d'}
                onChange={(event) => patch({ color: event.target.value })}
              />
            </Field>
          </div>

          <div className="segmented" style={{ marginBottom: 14 }}>
            <button
              type="button"
              className={draft.mode !== 'fields' ? 'is-active' : ''}
              onClick={() => patch({ mode: 'uri' })}
            >
              Connection string
            </button>
            <button
              type="button"
              className={draft.mode === 'fields' ? 'is-active' : ''}
              onClick={() => patch({ mode: 'fields' })}
            >
              Individual fields
            </button>
          </div>

          {draft.mode === 'fields' ? (
            <>
              <div className="form-grid">
                <Field
                  label="Hosts"
                  wide
                  hint="Comma separated, e.g. host1:27017, host2:27017. For SRV records use the hostname only."
                >
                  <TextInput
                    value={(draft.hosts ?? []).join(', ')}
                    placeholder="localhost:27017"
                    onChange={(event) =>
                      patch({ hosts: event.target.value.split(',').map((host) => host.trim()) })
                    }
                  />
                </Field>
                <Field label="Username">
                  <TextInput
                    value={draft.username ?? ''}
                    onChange={(event) => patch({ username: event.target.value })}
                  />
                </Field>
                <Field
                  label="Password"
                  hint={hasStoredPassword ? 'A password is already stored — leave blank to keep it.' : undefined}
                >
                  <TextInput
                    type="password"
                    value={password}
                    placeholder={hasStoredPassword ? '••••••••' : ''}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
                <Field label="Authentication database">
                  <TextInput
                    value={draft.authDatabase ?? ''}
                    placeholder="admin"
                    onChange={(event) => patch({ authDatabase: event.target.value })}
                  />
                </Field>
                <Field label="Default database" hint="Pre-selected when the connection opens.">
                  <TextInput
                    value={draft.defaultDatabase ?? ''}
                    onChange={(event) => patch({ defaultDatabase: event.target.value })}
                  />
                </Field>
                <Field label="Replica set">
                  <TextInput
                    value={draft.replicaSet ?? ''}
                    onChange={(event) => patch({ replicaSet: event.target.value })}
                  />
                </Field>
                <Field label="Auth mechanism">
                  <Select
                    value={draft.authMechanism ?? 'DEFAULT'}
                    onChange={(event) =>
                      patch({ authMechanism: event.target.value as Draft['authMechanism'] })
                    }
                  >
                    {['DEFAULT', 'SCRAM-SHA-1', 'SCRAM-SHA-256', 'MONGODB-X509', 'PLAIN', 'MONGODB-AWS'].map(
                      (mechanism) => (
                        <option key={mechanism} value={mechanism}>
                          {mechanism}
                        </option>
                      )
                    )}
                  </Select>
                </Field>
              </div>
              <Checkbox
                label="Use DNS seed list (mongodb+srv)"
                checked={Boolean(draft.srv)}
                onChange={(checked) => patch({ srv: checked })}
              />
              <Checkbox
                label="Direct connection (skip topology discovery)"
                checked={Boolean(draft.directConnection)}
                onChange={(checked) => patch({ directConnection: checked })}
              />
            </>
          ) : (
            <>
              <Field
                label="Connection string"
                wide
                hint="mongodb://user@host:27017/?authSource=admin — leave the password out and type it below."
              >
                <TextInput
                  value={draft.uri ?? ''}
                  placeholder="mongodb+srv://user@cluster0.example.mongodb.net"
                  onChange={(event) => patch({ uri: event.target.value })}
                />
              </Field>
              <div className="form-grid">
                <Field
                  label="Password"
                  hint={
                    hasStoredPassword
                      ? 'A password is already stored — leave blank to keep it.'
                      : 'Injected into the URI at connect time.'
                  }
                >
                  <TextInput
                    type="password"
                    value={password}
                    placeholder={hasStoredPassword ? '••••••••' : ''}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
                <Field label="Default database">
                  <TextInput
                    value={draft.defaultDatabase ?? ''}
                    onChange={(event) => patch({ defaultDatabase: event.target.value })}
                  />
                </Field>
              </div>
            </>
          )}

          <Checkbox
            label="Save password in the OS keychain"
            checked={draft.savePassword !== false}
            onChange={(checked) => patch({ savePassword: checked })}
          />
        </>
      ) : null}

      {tab === 'tls' ? (
        <>
          <Checkbox
            label="Enable TLS/SSL"
            checked={Boolean(draft.tls?.enabled)}
            onChange={(checked) =>
              patch({ tls: { ...(draft.tls ?? EMPTY_DRAFT.tls!), enabled: checked } })
            }
          />
          <Checkbox
            label="Allow invalid certificates"
            disabled={!draft.tls?.enabled}
            checked={Boolean(draft.tls?.allowInvalidCertificates)}
            onChange={(checked) =>
              patch({
                tls: { ...(draft.tls ?? EMPTY_DRAFT.tls!), allowInvalidCertificates: checked }
              })
            }
          />
          <Checkbox
            label="Allow invalid hostnames"
            disabled={!draft.tls?.enabled}
            checked={Boolean(draft.tls?.allowInvalidHostnames)}
            onChange={(checked) =>
              patch({
                tls: { ...(draft.tls ?? EMPTY_DRAFT.tls!), allowInvalidHostnames: checked }
              })
            }
          />
          <FilePickerField
            label="Certificate authority (CA) file"
            value={draft.tls?.caFile ?? ''}
            disabled={!draft.tls?.enabled}
            onChange={(value) => patch({ tls: { ...(draft.tls ?? EMPTY_DRAFT.tls!), caFile: value } })}
          />
          <FilePickerField
            label="Client certificate key file (.pem)"
            value={draft.tls?.certificateKeyFile ?? ''}
            disabled={!draft.tls?.enabled}
            onChange={(value) =>
              patch({ tls: { ...(draft.tls ?? EMPTY_DRAFT.tls!), certificateKeyFile: value } })
            }
          />
        </>
      ) : null}

      {tab === 'advanced' ? (
        <div className="form-grid">
          <Field label="Read preference">
            <Select
              value={draft.readPreference ?? 'primary'}
              onChange={(event) =>
                patch({ readPreference: event.target.value as Draft['readPreference'] })
              }
            >
              {['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'].map(
                (preference) => (
                  <option key={preference} value={preference}>
                    {preference}
                  </option>
                )
              )}
            </Select>
          </Field>
          <Field label="Connect timeout (ms)">
            <TextInput
              type="number"
              value={draft.connectTimeoutMs ?? 10_000}
              onChange={(event) => patch({ connectTimeoutMs: Number(event.target.value) })}
            />
          </Field>
          <Field label="Server selection timeout (ms)">
            <TextInput
              type="number"
              value={draft.serverSelectionTimeoutMs ?? 10_000}
              onChange={(event) => patch({ serverSelectionTimeoutMs: Number(event.target.value) })}
            />
          </Field>
        </div>
      ) : null}

      {testResult ? (
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="row row-wrap">
            <Badge tone="green">Connected</Badge>
            <span className="dim">MongoDB {testResult.version}</span>
            <span className="dim">{testResult.topology}</span>
            {testResult.storageEngine ? (
              <span className="dim">{testResult.storageEngine}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? <div className="error-box">{error}</div> : null}
    </Modal>
  );
}

function FilePickerField({
  label,
  value,
  disabled,
  onChange
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <div className="row">
        <TextInput
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          disabled={disabled}
          onClick={async () => {
            const picked = await unwrap(api.dialog.openFile({ title: label }));
            if (picked) onChange(picked);
          }}
        >
          Browse…
        </Button>
      </div>
    </Field>
  );
}
