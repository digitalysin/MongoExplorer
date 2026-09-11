import { useState } from 'react';
import { api, errorMessage, unwrap } from '../lib/api';
import { useStore } from '../state/store';
import { Button, Checkbox, Field, Modal, TextInput } from './ui';

export function IndexDialog({
  connectionId,
  database,
  collection,
  onClose,
  onCreated
}: {
  connectionId: string;
  database: string;
  collection: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const store = useStore();
  const [keys, setKeys] = useState('{ }');
  const [name, setName] = useState('');
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [ttl, setTtl] = useState('');
  const [partialFilter, setPartialFilter] = useState('');
  const [collation, setCollation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await unwrap(
        api.data.createIndex({
          connectionId,
          database,
          collection,
          keys,
          name: name.trim() || undefined,
          unique,
          sparse,
          expireAfterSeconds: ttl.trim() ? Number(ttl) : null,
          partialFilter: partialFilter.trim() || undefined,
          collation: collation.trim() || undefined
        })
      );
      store.notify(`Created the index “${result.name}”`);
      onCreated();
      onClose();
      return result;
    } catch (caught) {
      setError(errorMessage(caught));
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Create an index on ${collection}`}
      subtitle="Building an index locks nothing on modern MongoDB, but it does consume I/O on large collections."
      onClose={onClose}
      width={620}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} disabled={busy}>
            Create index
          </Button>
        </>
      }
    >
      <Field
        label="Keys"
        wide
        hint="1 ascending, -1 descending, or a type such as &quot;text&quot; / &quot;2dsphere&quot;. Example: { status: 1, createdAt: -1 }"
      >
        <textarea
          className="input"
          rows={2}
          value={keys}
          autoFocus
          onChange={(event) => setKeys(event.target.value)}
        />
      </Field>

      <div className="form-grid">
        <Field label="Name" hint="Optional — MongoDB derives one from the keys.">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field
          label="TTL (seconds)"
          hint="Single date field only; documents expire after this many seconds."
        >
          <TextInput
            type="number"
            value={ttl}
            placeholder="none"
            onChange={(event) => setTtl(event.target.value)}
          />
        </Field>
      </div>

      <div className="row row-wrap">
        <Checkbox label="Unique" checked={unique} onChange={setUnique} />
        <Checkbox label="Sparse" checked={sparse} onChange={setSparse} />
      </div>

      <Field label="Partial filter expression" wide hint='e.g. { archived: false }'>
        <TextInput
          value={partialFilter}
          onChange={(event) => setPartialFilter(event.target.value)}
        />
      </Field>
      <Field label="Collation" wide hint='e.g. { locale: "en", strength: 2 } for case-insensitive matching'>
        <TextInput value={collation} onChange={(event) => setCollation(event.target.value)} />
      </Field>

      {error ? <div className="error-box">{error}</div> : null}
    </Modal>
  );
}
