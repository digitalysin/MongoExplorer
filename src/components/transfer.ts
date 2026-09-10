import { useEffect, useRef, useState } from 'react';
import type { ToolDetection, TransferProgress } from '../../shared/types';
import { api, unwrap } from '../lib/api';

/** Collects progress lines emitted by the main process while a job runs. */
export function useTransferLog() {
  const [lines, setLines] = useState<string[]>([]);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return api.transfer.onProgress((event) => {
      setProgress(event);
      if (event.message) {
        setLines((current) => [...current.slice(-400), event.message as string]);
      }
      if (event.errors?.length) {
        setLines((current) => [...current.slice(-400), ...event.errors!.map((e) => `error: ${e}`)]);
      }
    });
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  return {
    lines,
    progress,
    containerRef,
    reset: () => {
      setLines([]);
      setProgress(null);
    }
  };
}

export function useToolDetection(enabled: boolean) {
  const [tools, setTools] = useState<ToolDetection[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setTools(await unwrap(api.tools.detect()));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!enabled || tools) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { tools, loading, refresh };
}

export function suggestFileName(
  database: string,
  collection: string,
  extension: string
): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${database}.${collection}-${stamp}.${extension}`;
}
