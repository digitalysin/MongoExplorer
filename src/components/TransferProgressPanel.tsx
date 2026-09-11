import type { TransferProgress } from '../../shared/types';
import { summarizeTransfer } from '../lib/transferProgress';
import { useTicker } from './transfer';
import { Button, ProgressBar } from './ui';

const HEADING: Record<TransferProgress['kind'], string> = {
  export: 'Exporting',
  import: 'Importing',
  tool: 'Working'
};

const SHORT: Record<TransferProgress['kind'], string> = {
  export: 'Export',
  import: 'Import',
  tool: 'Job'
};

/** The same job in one line, for when the dialog has been closed on top of it. */
export function TransferStatus({ progress }: { progress: TransferProgress }) {
  const now = useTicker(true);
  const summary = summarizeTransfer(progress, now);
  const text = [
    summary.percentLabel,
    summary.elapsedLabel,
    summary.remainingLabel ? `${summary.remainingLabel} left` : null
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  return (
    <span className="transfer-status" title={progress.message ?? undefined}>
      <span>{SHORT[progress.kind]}</span>
      <ProgressBar fraction={summary.fraction} />
      <span>{text}</span>
    </span>
  );
}

/**
 * What a long transfer looks like while it runs: how far along it is, how long
 * it has taken, roughly how much longer, and a way out of it.
 */
export function TransferProgressPanel({
  progress,
  onCancel
}: {
  progress: TransferProgress;
  onCancel?: () => void;
}) {
  const running = progress.phase === 'starting' || progress.phase === 'running';
  const now = useTicker(running);
  const summary = summarizeTransfer(progress, now);

  const meta = [
    `elapsed ${summary.elapsedLabel}`,
    summary.remainingLabel
      ? `about ${summary.remainingLabel} left`
      : summary.fraction === null
        ? null
        : 'estimating the time left…',
    summary.rateLabel,
    summary.byteLabel
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="transfer-progress">
      <div className="row">
        <strong>{summary.percentLabel ?? HEADING[progress.kind]}</strong>
        {summary.countLabel ? <span className="dim">{summary.countLabel}</span> : null}
        <span className="spacer" />
        {onCancel && running ? (
          <Button size="sm" onClick={onCancel}>
            Stop
          </Button>
        ) : null}
      </div>
      <ProgressBar fraction={summary.fraction} />
      <div className="faint transfer-progress-meta">{meta.join(' · ')}</div>
    </div>
  );
}
