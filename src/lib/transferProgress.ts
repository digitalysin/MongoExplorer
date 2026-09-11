import type { TransferProgress } from '../../shared/types';
import { formatBytes, formatElapsed, formatNumber } from './format';

export interface TransferSummary {
  /** Null when nothing countable is known, which the bar shows as open-ended. */
  fraction: number | null;
  percentLabel: string | null;
  countLabel: string | null;
  byteLabel: string | null;
  rateLabel: string | null;
  elapsedLabel: string;
  /** Null until there is enough progress for the estimate to mean anything. */
  remainingLabel: string | null;
}

/**
 * One place to turn a progress event into what the user reads, so the dialog
 * and the status bar can never disagree about how far along a job is.
 */
export function summarizeTransfer(progress: TransferProgress, now: number): TransferSummary {
  const { processed, total, bytes, totalBytes } = progress;
  const elapsedMs = Math.max(0, now - Date.parse(progress.startedAt));

  const byDocuments = total !== null && total > 0 ? processed / total : null;
  const byBytes =
    byDocuments === null && totalBytes && totalBytes > 0 && bytes !== undefined
      ? bytes / totalBytes
      : null;
  const fraction = byDocuments ?? byBytes;

  const seconds = elapsedMs / 1000;
  // Below a second the rate is mostly noise, and so is anything derived from it.
  const rate = seconds >= 1 ? processed / seconds : null;
  const remainingMs =
    fraction !== null && fraction > 0.005 && fraction < 1 && elapsedMs > 1500
      ? (elapsedMs * (1 - fraction)) / fraction
      : null;

  return {
    fraction: fraction === null ? null : Math.min(1, fraction),
    percentLabel: fraction === null ? null : `${Math.min(100, Math.floor(fraction * 100))}%`,
    countLabel:
      processed > 0 || total !== null
        ? `${formatNumber(processed)}${total !== null ? ` / ${formatNumber(total)}` : ''} documents`
        : null,
    byteLabel:
      bytes === undefined
        ? null
        : `${formatBytes(bytes)}${totalBytes ? ` / ${formatBytes(totalBytes)}` : ''}`,
    rateLabel: rate && rate >= 1 ? `${formatNumber(Math.round(rate))} docs/s` : null,
    elapsedLabel: formatElapsed(elapsedMs),
    remainingLabel: remainingMs === null ? null : formatElapsed(remainingMs)
  };
}

/** True when a job ended because the user asked it to stop. */
export function isCancellation(error: unknown): boolean {
  return /cancelled by user/i.test(error instanceof Error ? error.message : String(error));
}
