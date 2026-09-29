import type { Doc } from '@convex/_generated/dataModel';
import type { Tone } from '../components/tone';
import { clockTime } from '../agent/[agentId]/time';

/** A linked source's state in the manager's words, with the tone its chip takes. */
export interface SourceStatusWords {
  /** The chip's short label. */
  readonly text: string;
  readonly tone: Tone;
  /** When the source was last read, beside the chip; absent before a sync has finished. */
  readonly lastRead?: string;
}

/**
 * What a linked source's sync state means to the manager: read, being read, or not read and why
 * it waits, with when it was last read. A refusal is drawn in warn, never on a danger fill
 * (A D4 (b)).
 *
 * @param source - The source's status and last sync time.
 * @param zone - The zone the time is said in; the viewer's when absent.
 */
export function sourceStatus(
  source: Pick<Doc<'docSources'>, 'status' | 'lastSyncAt'>,
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
      return { text: 'Could not read', tone: 'warn', ...lastRead };
    case 'credential-not-landed':
      return { text: 'Secret not stored', tone: 'warn', ...lastRead };
  }
}
