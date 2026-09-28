import Link from 'next/link';
import { clockTime } from '../agent/[agentId]/time';
import { useArrival } from '../arrival';
import type { NeedsYouEntry, NeedsYouInbox } from './types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long an entry has waited, in the coarsest unit that stays honest:
 * minutes under an hour, hours and minutes under a day, days beyond. A wait
 * the server could only bound reads "over".
 *
 * @param since - When the entry began to wait.
 * @param now - The page's clock.
 * @param atLeast - Whether `since` is a bound rather than the instant.
 */
export function waitingFor(since: number, now: number, atLeast: boolean): string {
  const elapsed = Math.max(0, now - since);
  const prefix = atLeast ? 'waiting over' : 'waiting';
  if (elapsed < MINUTE_MS) return `${prefix} under a minute`;
  if (elapsed < HOUR_MS) return `${prefix} ${Math.floor(elapsed / MINUTE_MS)} min`;
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${prefix} ${hours} h` : `${prefix} ${hours} h ${minutes} min`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  return `${prefix} ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** What the manager is asked for and what it is about, in the manager's words. */
function described(entry: NeedsYouEntry): { readonly ask: string; readonly about: string } {
  switch (entry.kind) {
    case 'charter':
      return { ask: 'a charter to review', about: 'Drafted from your one-to-one.' };
    case 'plan':
      return {
        ask: 'a plan to approve',
        about:
          entry.questions === 0
            ? `${entry.subject}.`
            : `${entry.subject}. ${entry.questions === 1 ? 'One charter question' : `${entry.questions} charter questions`}.`,
      };
    case 'held':
      return {
        ask:
          entry.heldWrites === 1
            ? 'a write is held for you'
            : `${entry.heldWrites} writes are held for you`,
        about: `${entry.subject}.`,
      };
    case 'skill':
      return {
        ask: 'a skill to approve',
        about:
          entry.waitingItems === 1
            ? `${entry.subject}, which 1 item waits on.`
            : `${entry.subject}, which ${entry.waitingItems} items wait on.`,
      };
    case 'parked':
      return {
        ask: {
          connection: 'an item waiting on a connection',
          permission: 'an item waiting on a read grant',
          evaluation: 'an item parked until you send it again',
        }[entry.reason],
        about: `${entry.subject}.`,
      };
    case 'stopped':
      return {
        ask: 'an item stopped short of done',
        about: `${entry.subject}. Retry is on its card.`,
      };
    case 'surface':
      return { ask: 'a system to approve', about: `${entry.subject}, before it is connected.` };
  }
}

function NeedsYouItem({ entry, now }: { entry: NeedsYouEntry; now: number }) {
  const { ask, about } = described(entry);
  const held = entry.kind === 'held';
  return (
    <li>
      <Link
        href={`/agent/${entry.agentId}`}
        className={`flex flex-col gap-3 rounded-lg border px-5 py-4 transition hover:bg-[var(--color-bg)]/60 sm:flex-row sm:items-center sm:justify-between ${
          held ? 'border-[var(--color-warn)]/50' : 'border-[var(--color-border)]'
        }`}
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {entry.employeeName} · {ask}
          </p>
          <p className="mt-1 text-sm text-[var(--color-fg)]/80">{about}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-[var(--color-muted)]">
            <span>{waitingFor(entry.waitingSince, now, entry.waitingAtLeast)}</span>
            {held && !entry.waitingAtLeast ? (
              <span>held since {clockTime(entry.waitingSince, entry.zone)}</span>
            ) : null}
          </p>
        </div>
        <span
          className={`self-start whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-medium sm:self-center ${
            held
              ? 'border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10 text-[var(--color-ok)]'
              : 'border-[var(--color-border)] text-[var(--color-fg)]'
          }`}
        >
          {held ? 'Decide' : 'Open'}
        </span>
      </Link>
    </li>
  );
}

/**
 * The needs-you inbox (N7): every decision waiting on the manager across
 * their employees, longest wait first, each a link to the employee's page
 * where it is decided.
 *
 * @param inbox - The inbox as `work.needsYou` returns it, undefined while it loads.
 * @param now - The page's clock, so the waits age.
 */
export function NeedsYouList({ inbox, now }: { inbox: NeedsYouInbox | undefined; now: number }) {
  const more = inbox ? inbox.total - inbox.entries.length : 0;
  // The entries are a second tier inside the card, as the Work tab's rows are (v4 section 1.3).
  const arriving = useArrival(inbox !== undefined && inbox.entries.length > 0);
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">Needs you</h2>
        <span className="text-xs text-[var(--color-muted)]">ordered by wait</span>
      </div>
      {inbox === undefined ? (
        <p className="px-5 py-4 text-sm text-[var(--color-muted)]">Loading</p>
      ) : inbox.entries.length === 0 ? (
        <p className="px-5 py-4 text-sm text-[var(--color-muted)]">Nothing is waiting on you.</p>
      ) : (
        <ol data-cards={arriving ? 'rows' : undefined} className="flex flex-col gap-3 p-5">
          {inbox.entries.map((entry) => (
            <NeedsYouItem key={entry.key} entry={entry} now={now} />
          ))}
        </ol>
      )}
      {more > 0 ? (
        <p className="border-t border-[var(--color-border)] px-5 py-3 text-xs text-[var(--color-muted)]">
          {more} more on your employees’ pages.
        </p>
      ) : null}
    </section>
  );
}
