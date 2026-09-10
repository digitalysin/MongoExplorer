import { useState } from 'react';
import { api, errorMessage, unwrap } from '../lib/api';
import { Button, Field, Modal, TextInput } from './ui';

export interface CreateTarget {
  kind: 'database' | 'collection';
  connectionId: string;
  /** The parent database when creating a collection. */
  database?: string;
}

interface CreateDialogProps {
  target: CreateTarget;
  onClose: () => void;
  onCreated: (database: string, collection: string) => void;
}

export function CreateDialog({ target, onClose, onCreated }: CreateDialogProps) {
  const creatingDatabase = target.kind === 'database';
  const [database, setDatabase] = useState(target.database ?? '');
  const [collection, setCollection] = useState(creatingDatabase ? 'documents' : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const db = database.trim();
    const coll = collection.trim();
    setError(null);
    setSaving(true);
    try {
      if (creatingDatabase) {
        await unwrap(api.data.createDatabase(target.connectionId, db, coll));
      } else {
        await unwrap(api.data.createCollection(target.connectionId, db, coll));
      }
      onCreated(db, coll);
    } catch (failure) {
      setError(errorMessage(failure));
      setSaving(false);
    }
  };

  const canSubmit = database.trim() !== '' && collection.trim() !== '' && !saving;

  return (
    <Modal
      title={creatingDatabase ? 'New database' : 'New collection'}
      subtitle={
        creatingDatabase
          ? 'MongoDB creates a database the moment it holds its first collection, so name both here.'
          : `In ${target.database}`
      }
      onClose={onClose}
      width={460}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <div
        className="form-grid"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && canSubmit) void submit();
        }}
      >
        {creatingDatabase ? (
          <Field label="Database name" wide>
            <TextInput
              autoFocus
              value={database}
              placeholder="analytics"
              onChange={(event) => setDatabase(event.target.value)}
            />
          </Field>
        ) : null}
        <Field
          label={creatingDatabase ? 'First collection' : 'Collection name'}
          hint={creatingDatabase ? 'Required — an empty database would not survive.' : undefined}
          wide
        >
          <TextInput
            autoFocus={!creatingDatabase}
            value={collection}
            placeholder="events"
            onChange={(event) => setCollection(event.target.value)}
          />
        </Field>
      </div>
      {error ? <div className="error-box">{error}</div> : null}
    </Modal>
  );
}
