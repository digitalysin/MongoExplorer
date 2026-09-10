/**
 * Turns driver and OS-level connection failures into something a person can act on.
 *
 * The Node driver reports the first hop it failed at, so a wrong hostname arrives as a bare
 * `getaddrinfo ENOTFOUND host` and an unreachable one as a server-selection timeout wrapping the
 * real cause several layers down. Both read as noise unless you already know the driver.
 */
import type { ConnectionConfig } from '../../shared/types.js';

interface ErrorLike {
  code?: string | number;
  codeName?: string;
  syscall?: string;
  hostname?: string;
  address?: string;
  port?: number;
  message?: string;
  cause?: unknown;
  reason?: unknown;
  servers?: unknown;
  /** Per-server failure held by a topology description. */
  error?: unknown;
}

const asErrorLike = (value: unknown): ErrorLike | null =>
  value && typeof value === 'object' ? (value as ErrorLike) : null;

/**
 * Walks an error and everything it wraps: `cause` chains plus the per-server errors held by a
 * MongoServerSelectionError's topology description.
 */
function* chain(error: unknown, seen = new Set<unknown>()): Generator<ErrorLike> {
  const current = asErrorLike(error);
  if (!current || seen.has(current)) return;
  seen.add(current);
  yield current;

  yield* chain(current.cause, seen);
  yield* chain(current.reason, seen);

  const servers = current.servers;
  if (servers instanceof Map) {
    for (const description of servers.values()) {
      yield* chain(asErrorLike(description)?.error, seen);
    }
  }
}

/** The first entry in the chain carrying one of the codes we know how to explain. */
function findCode(error: unknown, codes: string[]): ErrorLike | null {
  for (const link of chain(error)) {
    if (typeof link.code === 'string' && codes.includes(link.code)) return link;
    // Some driver layers keep the code only in the message.
    if (typeof link.message === 'string' && codes.some((code) => link.message!.includes(code))) {
      return link;
    }
  }
  return null;
}

function hostLabel(link: ErrorLike | null, config: Partial<ConnectionConfig>): string {
  const fromError = link?.hostname ?? link?.address;
  if (fromError) return String(fromError);
  const fromMessage = link?.message?.match(/(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\s+(\S+)/)?.[1];
  if (fromMessage) return fromMessage;
  if (config.mode === 'uri' && config.uri) {
    const parsed = config.uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?,]+)/i)?.[1];
    if (parsed) return parsed;
  }
  return config.hosts?.[0] ?? 'the server';
}

const bareHost = (host: string): string => host.replace(/:\d+$/, '').toLowerCase();

/** The hosts the user actually entered, whichever input mode they used. */
function configuredHosts(config: Partial<ConnectionConfig>): string[] {
  if (config.mode !== 'fields') {
    const authority = config.uri?.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i)?.[1] ?? '';
    return authority.split(',').filter(Boolean).map(bareHost);
  }
  return (config.hosts ?? []).map(bareHost);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Returns an Error whose message names the likely cause, keeping the original as `cause` so the
 * driver's own wording is still available for debugging.
 */
export function explainConnectionError(
  error: unknown,
  config: Partial<ConnectionConfig>
): Error {
  const isSrv = config.mode === 'uri' ? /^mongodb\+srv:/i.test(config.uri ?? '') : config.srv;
  const original = messageOf(error);

  const notFound = findCode(error, ['ENOTFOUND']);
  if (notFound) {
    const host = hostLabel(notFound, config);
    if (original.includes('querySrv')) {
      return wrap(
        `No SRV record (_mongodb._tcp.${host}) exists for "${host}". Check the hostname for a typo, and if it is an internal host, that you are on the VPN that publishes it.`,
        error
      );
    }
    // A replica set reports its members by their own names. When the failure names a host the user
    // never entered, the address they gave was reached and the member list is what broke.
    if (!configuredHosts(config).includes(bareHost(host))) {
      return wrap(
        `Reached the server, but the replica set advertises its members as "${host}", and that name does not resolve here. Tick "Direct connection (skip topology discovery)" to talk only to the address you entered.`,
        error
      );
    }
    return wrap(
      `DNS returned no address for "${host}". Check the hostname for a typo, and if it is an internal host, that you are on the VPN that publishes it.`,
      error
    );
  }

  const dnsDown = findCode(error, ['EAI_AGAIN']);
  if (dnsDown) {
    return wrap(
      `The DNS lookup for "${hostLabel(dnsDown, config)}" did not get an answer. The resolver is unreachable — check your network or VPN connection.`,
      error
    );
  }

  const refused = findCode(error, ['ECONNREFUSED']);
  if (refused) {
    const where = refused.address
      ? `${refused.address}${refused.port ? `:${refused.port}` : ''}`
      : hostLabel(refused, config);
    return wrap(
      `${where} refused the connection. The address is reachable but nothing is listening on that port — check the port number and that MongoDB is running.`,
      error
    );
  }

  const timedOut = findCode(error, ['ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);
  if (timedOut) {
    return wrap(
      `No reply from "${hostLabel(timedOut, config)}". The address did not respond — usually a firewall, a security group, or a missing VPN route.`,
      error
    );
  }

  const tls = findCode(error, [
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID'
  ]);
  if (tls) {
    return wrap(
      `The TLS certificate was rejected (${tls.code ?? 'certificate error'}). Point the connection at the right CA file, or allow invalid certificates in the TLS section if this is a self-signed deployment.`,
      error
    );
  }

  if (/Authentication failed|bad auth|AuthenticationFailed|not authorized/i.test(original)) {
    const authSource = config.authDatabase || 'admin';
    return wrap(
      `${config.username ? `Authentication failed for "${config.username}"` : 'Authentication failed'} against the "${authSource}" database. Check the password and that the authentication database is the one the user was created in.`,
      error
    );
  }

  if (/Server selection timed out/i.test(original)) {
    return wrap(
      `Could not reach ${hostLabel(null, config)} within the server-selection timeout. Nothing answered — check the host and port, the VPN, and whether the replica set name matches.`,
      error
    );
  }

  if (isSrv && /SRV/i.test(original)) {
    return wrap(`The SRV lookup failed: ${original}`, error);
  }

  return error instanceof Error ? error : new Error(original);
}

function wrap(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}
