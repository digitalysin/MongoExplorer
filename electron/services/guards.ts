import type { ConnectionEnvironment } from '../../shared/types.js';
import { getConnection } from './connections.js';

/**
 * Read-only is enforced here, in the main process, rather than by hiding
 * buttons: the renderer can be wrong, and a connection pointed at production
 * is exactly where being wrong is expensive.
 */
export function assertWritable(connectionId: string | null, action: string): void {
  if (!connectionId) return;
  const config = tryGetConnection(connectionId);
  if (!config?.readOnly) return;
  throw new Error(
    `“${config.name}” is marked read-only, so ${action} was refused. Turn read-only off in the connection's settings if you meant to write to it.`
  );
}

export function connectionIsReadOnly(connectionId: string): boolean {
  return Boolean(tryGetConnection(connectionId)?.readOnly);
}

export function connectionEnvironment(connectionId: string): ConnectionEnvironment {
  return tryGetConnection(connectionId)?.environment ?? 'development';
}

function tryGetConnection(connectionId: string) {
  try {
    return getConnection(connectionId);
  } catch {
    // An unknown connection cannot be written to anyway; let the caller fail
    // on its own terms rather than reporting a guard error.
    return null;
  }
}
