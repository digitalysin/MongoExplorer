import { useEffect, useState } from 'react';
import type { DocumentRef } from '../../shared/types';
import { api, errorMessage, unwrap } from '../lib/api';
import { useStore } from '../state/store';
import { Badge, Button, Modal, Spinner } from './ui';

export interface DocumentEditorTarget {
  connectionId: string;
  database: string;
  collection: string;
  /** Canonical EJSON of the `_id`; omitted when inserting a new document. */
  idJson?: string;
}

const NEW_DOCUMENT_TEMPLATE = '{\n  \n}';

/**
 * Loads the document in canonical extended JSON so an edit round-trip cannot
 * turn an int64 into a double, then writes it back with replaceOne.
 */
export function DocumentEditor({
  target,
  onClose,
  onChanged
}: {
  target: DocumentEditorTarget;
  onClose: () => void;
  onChanged: () => void;
}) {
  const store = useStore();
  const isNew = !target.idJson;
  const [text, setText] = useState(isNew ? NEW_DOCUMENT_TEMPLATE : '');
  const [loading, setLoading] = useState(!isNew);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const ref: DocumentRef | null = target.idJson
    ? {
        connectionId: target.connectionId,
        database: target.database,
        collection: target.collection,
        idJson: target.idJson
      }
    : null;

  useEffect(() => {
    if (!ref) return;
    setLoading(true);
    void unwrap(api.data.getDocument(ref))
      .then((json) => {
        setText(json);
        setError(null);
      })
      .catch((caught) => setError(errorMessage(caught)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.idJson, target.collection, target.database, target.connectionId]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (ref) {
        await unwrap(api.data.replaceDocument(ref, text));
        store.notify(`Saved the document in ${target.collection}`, 'document-save');
      } else {
        await unwrap(
          api.data.insertDocument(target.connectionId, target.database, target.collection, text)
        );
        store.notify(`Inserted a document into ${target.collection}`);
      }
      onChanged();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!ref) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.data.deleteDocument(ref));
      store.notify('Deleted the document');
      onChanged();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? `Insert into ${target.collection}` : `Edit document in ${target.collection}`}
      subtitle="Canonical extended JSON — BSON types such as $oid, $date and $numberLong are preserved exactly."
      onClose={onClose}
      width={780}
      footer={
        <>
          {ref ? (
            confirmingDelete ? (
              <>
                <span className="dim">Delete this document permanently?</span>
                <Button size="sm" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy}>
                  Delete
                </Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => setConfirmingDelete(true)} disabled={busy}>
                Delete
              </Button>
            )
          ) : null}
          <span className="spacer" />
          {dirty ? <Badge tone="amber">Unsaved changes</Badge> : null}
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || loading}>
            {busy ? <Spinner label="Saving…" /> : isNew ? 'Insert' : 'Save'}
          </Button>
        </>
      }
    >
      {loading ? (
        <Spinner label="Loading the document…" />
      ) : (
        <textarea
          className="input"
          style={{ minHeight: 380, fontSize: 12.5, lineHeight: 1.55 }}
          spellCheck={false}
          value={text}
          onKeyDown={(event) => {
            // The same keystroke as the table: ⌘S / Ctrl+S writes the document.
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              if (!busy && !loading) void save();
            }
          }}
          onChange={(event) => {
            setText(event.target.value);
            setDirty(true);
          }}
        />
      )}
      {error ? <div className="error-box">{error}</div> : null}
    </Modal>
  );
}
