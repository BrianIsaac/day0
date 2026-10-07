import type { Doc } from '@convex/_generated/dataModel';
import { isSyncHeldReason } from '@/docs/sync-held';
import type { Tone } from '../components/tone';
import { clockTime } from '../components/time';

/** A linked source's state in the manager's words, with the tone its chip takes. */
export interface SourceStatusWords {
  /** The chip's short label. */
  readonly text: string;
  readonly tone: Tone;
  /** When the source was last read, beside the chip; absent before a sync has finished. */
  readonly lastRead?: string;
}

/**
 * What a linked source's sync state means to the manager: read, being read, held by the
 * deployment's pause, or not read and why it waits, with when it was last read. A refusal is drawn
 * in warn, never on a danger fill (A D4 (b)); a hold waits on nobody (W12V-2).
 *
 * @param source - The source's status, last sync time and last error.
 * @param zone - The zone the time is said in; the viewer's when absent.
 */
export function sourceStatus(
  source: Pick<Doc<'docSources'>, 'status' | 'lastSyncAt' | 'lastError'>,
  zone?: string,
): SourceStatusWords {
  const lastRead =
    source.lastSyncAt === undefined ? {} : { lastRead: clockTime(source.lastSyncAt, zone) };
  switch (source.status) {
    case 'synced':
      return { text: 'Read', tone: 'ok', ...lastRead };
    case 'linking':
      return { text: 'Reading', tone: 'accent', ...lastRead };
    case 'error':
      // A sync the deployment's pause held tried nothing, so it did not fail to read (W12V-2).
      return isSyncHeldReason(source.lastError)
        ? { text: 'Held', tone: 'muted', ...lastRead }
        : { text: 'Could not read', tone: 'warn', ...lastRead };
    case 'credential-not-landed':
      return { text: 'Secret not stored', tone: 'warn', ...lastRead };
    case 'held':
      return { text: 'Held', tone: 'muted', ...lastRead };
  }
}
