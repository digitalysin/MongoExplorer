import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type {
  ActiveConnectionInfo,
  AppSettings,
  CollectionSummary,
  ConnectionConfig,
  ConnectionSecrets,
  DatabaseSummary,
  TransferProgress
} from '../../shared/types';
import { api, errorMessage, unwrap } from '../lib/api';

/**
 * Toasts only ever carry good news — they fade on their own, which would let a
 * failure go unread. Failures go to `reportError` and its blocking dialog.
 */
export interface Toast {
  id: string;
  kind: 'info' | 'success';
  message: string;
  detail?: string;
}

export interface ErrorReport {
  message: string;
  detail?: string;
}

export interface Selection {
  connectionId: string;
  database: string | null;
  collection: string | null;
}

export interface ActivityEntry extends TransferProgress {
  at: string;
}

interface StoreValue {
  connections: ConnectionConfig[];
  active: Record<string, ActiveConnectionInfo>;
  databases: Record<string, DatabaseSummary[]>;
  collections: Record<string, CollectionSummary[]>;
  loadingKeys: Record<string, boolean>;
  selection: Selection | null;
  settings: AppSettings | null;
  toasts: Toast[];
  /** The failure currently held in front of the user, if any. */
  errorReport: ErrorReport | null;
  activity: ActivityEntry[];
  busy: boolean;
  refreshConnections: () => Promise<void>;
  connect: (id: string, secrets?: ConnectionSecrets) => Promise<boolean>;
  disconnect: (id: string) => Promise<void>;
  loadDatabases: (connectionId: string, force?: boolean) => Promise<void>;
  loadCollections: (connectionId: string, database: string, force?: boolean) => Promise<void>;
  select: (selection: Selection | null) => void;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  /** Confirms a finished operation without interrupting anyone. */
  notify: (message: string) => void;
  /** Stops the user with what failed and why. */
  reportError: (message: string, error?: unknown) => void;
  dismissError: () => void;
  clearActivity: () => void;
  isConnected: (id: string) => boolean;
}

const StoreContext = createContext<StoreValue | null>(null);

export const collectionsKey = (connectionId: string, database: string) =>
  `${connectionId}::${database}`;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [active, setActive] = useState<Record<string, ActiveConnectionInfo>>({});
  const [databases, setDatabases] = useState<Record<string, DatabaseSummary[]>>({});
  const [collections, setCollections] = useState<Record<string, CollectionSummary[]>>({});
  const [loadingKeys, setLoadingKeys] = useState<Record<string, boolean>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [errorReport, setErrorReport] = useState<ErrorReport | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const toastCounter = useRef(0);

  const pushToast = useCallback((toast: Omit<Toast, 'id'>) => {
    toastCounter.current += 1;
    const id = `toast-${toastCounter.current}`;
    setToasts((current) => [...current, { ...toast, id }]);
    setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 4000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const notify = useCallback(
    (message: string) => pushToast({ kind: 'success', message }),
    [pushToast]
  );

  const reportError = useCallback((message: string, error?: unknown) => {
    const detail = error === undefined ? undefined : errorMessage(error);
    // The dialog is modal, so keep the first failure rather than overwriting it
    // with whatever else fell over as a consequence.
    setErrorReport((current) => current ?? { message, detail });
  }, []);

  const dismissError = useCallback(() => setErrorReport(null), []);

  const setLoading = useCallback((key: string, value: boolean) => {
    setLoadingKeys((current) => ({ ...current, [key]: value }));
  }, []);

  const refreshConnections = useCallback(async () => {
    try {
      const [list, activeList, currentSettings] = await Promise.all([
        unwrap(api.connections.list()),
        unwrap(api.connections.active()),
        unwrap(api.settings.get())
      ]);
      setConnections(list);
      setActive(Object.fromEntries(activeList.map((info) => [info.connectionId, info])));
      setSettings(currentSettings);
    } catch (error) {
      reportError('Could not load the saved connections', error);
    }
  }, [reportError]);

  const loadDatabases = useCallback(
    async (connectionId: string, force = false) => {
      if (!force && databases[connectionId]) return;
      setLoading(connectionId, true);
      try {
        const list = await unwrap(api.data.listDatabases(connectionId));
        setDatabases((current) => ({ ...current, [connectionId]: list }));
      } catch (error) {
        reportError('Could not list the databases', error);
      } finally {
        setLoading(connectionId, false);
      }
    },
    [databases, reportError, setLoading]
  );

  const loadCollections = useCallback(
    async (connectionId: string, database: string, force = false) => {
      const key = collectionsKey(connectionId, database);
      if (!force && collections[key]) return;
      setLoading(key, true);
      try {
        const list = await unwrap(api.data.listCollections(connectionId, database));
        setCollections((current) => ({ ...current, [key]: list }));
      } catch (error) {
        reportError(`Could not list the collections in ${database}`, error);
      } finally {
        setLoading(key, false);
      }
    },
    [collections, reportError, setLoading]
  );

  const connect = useCallback(
    async (id: string, secrets?: ConnectionSecrets) => {
      setBusy(true);
      try {
        const info = await unwrap(api.connections.connect(id, secrets));
        setActive((current) => ({ ...current, [id]: info }));
        await loadDatabases(id, true);
        const defaultDatabase =
          connections.find((entry) => entry.id === id)?.defaultDatabase ?? null;
        setSelection({ connectionId: id, database: defaultDatabase, collection: null });
        if (defaultDatabase) await loadCollections(id, defaultDatabase, true);
        notify(`Connected to ${info.name}`);
        return true;
      } catch (error) {
        reportError('Could not connect to the deployment', error);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [connections, loadCollections, loadDatabases, notify, reportError]
  );

  const disconnect = useCallback(
    async (id: string) => {
      const name = active[id]?.name ?? 'the deployment';
      try {
        await unwrap(api.connections.disconnect(id));
        notify(`Disconnected from ${name}`);
      } catch (error) {
        reportError('Could not close the connection cleanly', error);
      }
      setActive((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setDatabases((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setCollections((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !key.startsWith(`${id}::`))
        )
      );
      setSelection((current) => (current?.connectionId === id ? null : current));
    },
    [active, notify, reportError]
  );

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        const updated = await unwrap(api.settings.update(patch));
        setSettings(updated);
        notify('Saved the settings');
      } catch (error) {
        reportError('Could not save the settings', error);
      }
    },
    [notify, reportError]
  );

  useEffect(() => {
    void refreshConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A promise nobody caught still failed an operation the user started.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) =>
      reportError('An operation failed unexpectedly', event.reason);
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, [reportError]);

  useEffect(() => {
    return api.transfer.onProgress((progress) => {
      setActivity((current) => {
        const entry: ActivityEntry = { ...progress, at: new Date().toISOString() };
        const existing = current.findIndex((item) => item.jobId === progress.jobId);
        if (existing >= 0) {
          const next = [...current];
          next[existing] = entry;
          return next;
        }
        return [entry, ...current].slice(0, 50);
      });
    });
  }, []);

  useEffect(() => {
    const theme = settings?.theme ?? 'dark';
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : theme;
    document.documentElement.dataset.theme = resolved;
  }, [settings?.theme]);

  const value = useMemo<StoreValue>(
    () => ({
      connections,
      active,
      databases,
      collections,
      loadingKeys,
      selection,
      settings,
      toasts,
      errorReport,
      activity,
      busy,
      refreshConnections,
      connect,
      disconnect,
      loadDatabases,
      loadCollections,
      select: setSelection,
      updateSettings,
      pushToast,
      dismissToast,
      notify,
      reportError,
      dismissError,
      clearActivity: () => setActivity([]),
      isConnected: (id: string) => Boolean(active[id])
    }),
    [
      connections,
      active,
      databases,
      collections,
      loadingKeys,
      selection,
      settings,
      toasts,
      errorReport,
      activity,
      busy,
      refreshConnections,
      connect,
      disconnect,
      loadDatabases,
      loadCollections,
      updateSettings,
      pushToast,
      dismissToast,
      notify,
      reportError,
      dismissError
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside <StoreProvider>.');
  return store;
}
