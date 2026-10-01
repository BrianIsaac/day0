'use client';

import { useId } from 'react';
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@convex/_generated/api';
import { deploymentZone } from '@/lib/zone';
import { clockTime } from './time';
import { ButtonLink } from './Button';
import { reviewHref } from '../home/transfer-link';

/** One thing waiting on the manager, as `work.needsYou` and `work.needsYouForAgent` return it. */
export type InboxItem = FunctionReturnType<typeof api.work.needsYou>['entries'][number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long an entry has waited, in the coarsest unit that stays honest: minutes under an hour,
 * hours and minutes under a day, days beyond. A wait the server could only bound reads "over".
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

/** An entry in the manager's words: what is asked of them, what it is about, and the one control. */
export interface InboxEntryWords {
  /** What the manager is asked for, lower case so it can follow an employee's name. */
  readonly ask: string;
  readonly about: string;
  /** The label of the entry's one control. */
  readonly control: string;
}

/**
 * What an entry asks of the manager, in their words, for every kind the inbox lists.
 *
 * @param entry - The entry.
 */
export function inboxEntryWords(entry: InboxItem): InboxEntryWords {
  switch (entry.kind) {
    case 'one-to-one':
      return {
        ask: 'a one-to-one to hold',
        about: 'Its Day-1 one-to-one. Nothing it does starts before it.',
        control: 'Hold the one-to-one',
      };
    case 'charter':
      return {
        ask: 'a charter to review',
        about: 'Drafted from your one-to-one.',
        control: 'Review the charter',
      };
    case 'plan':
      return {
        ask: 'a plan to approve',
        about:
          entry.questions === 0
            ? `${entry.subject}.`
            : `${entry.subject}. ${entry.questions === 1 ? 'One charter question' : `${entry.questions} charter questions`}.`,
        control: 'Open the plan',
      };
    case 'held':
      return {
        ask:
          entry.heldWrites === 1
            ? 'a write is held for you'
            : `${entry.heldWrites} writes are held for you`,
        about: `${entry.subject}.`,
        control: 'Decide',
      };
    case 'skill':
      return {
        ask: 'a skill to approve',
        about:
          entry.waitingItems === 1
            ? `${entry.subject}, which 1 item waits on.`
            : `${entry.subject}, which ${entry.waitingItems} items wait on.`,
        control: 'Open',
      };
    case 'parked':
      return {
        ask: {
          connection: 'an item waiting on a connection',
          permission: 'an item waiting on a read grant',
          evaluation: 'an item parked until you send it again',
        }[entry.reason],
        about: `${entry.subject}.`,
        control: 'Open',
      };
    case 'stopped':
      return {
        ask: 'an item stopped short of done',
        about: `${entry.subject}. Retry is on its card.`,
        control: 'Open',
      };
    case 'surface':
      return {
        ask: 'a system to approve',
        about: `${entry.subject}, before it is connected.`,
        control: 'Open',
      };
    case 'transfer': {
      // The employee is not the viewer's yet, so the date is in the viewer's zone, named (N12).
      const zone = deploymentZone();
      return {
        ask: 'an employee to take on',
        // The address sits inside the sentence, never first (the wave 9 review's U4-m7).
        about: `Its manager, ${entry.fromAddress}, asks you to take it on. Expires ${clockTime(entry.expiresAt, zone)}, ${zone} time.`,
        control: 'Review',
      };
    }
  }
}

/**
 * Where an entry's control goes: the tab of the employee's page that performs it, for a work
 * item the item's own card on the Work tab (`#item-<id>`), which the queue scrolls to and focuses,
 * and for a handover the acceptance dialog on the home (`/?transfer=<id>`).
 *
 * @param entry - The entry.
 */
export function inboxEntryHref(entry: InboxItem): string {
  const page = `/agent/${entry.agentId}`;
  switch (entry.kind) {
    case 'one-to-one':
      return page;
    case 'charter':
      return `${page}/charter`;
    case 'plan':
    case 'held':
    case 'parked':
    case 'stopped':
      return `${page}/work#item-${entry.workItemId}`;
    case 'skill':
      return `${page}/skills`;
    case 'surface':
      return `${page}/surfaces`;
    case 'transfer':
      // The employee's page refuses a caller who does not own it yet; the home opens the dialog.
      return reviewHref(entry.transferId);
  }
}

/** The first letter upper case, for an ask that opens its line. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One entry of the needs-you inbox (N7): what waits on the manager, what it is about, how long it
 * has waited (and, for held writes, since when, in the employee's zone), and the one control that
 * takes the manager to where it is decided, named by its label and the entry's title so a list of
 * links never reads "Open, Open, Open". A held write is the one entry in the warn tone; its
 * control goes to the decision and so keeps the plain look, never the approval's. The company home names the employee each entry is about; the
 * employee's own page does not.
 *
 * @param entry - The entry.
 * @param now - The page's clock, so the wait ages.
 * @param named - Whether the line leads with the employee's name.
 */
export function InboxEntry({
  entry,
  now,
  named = false,
}: {
  entry: InboxItem;
  now: number;
  named?: boolean;
}) {
  const titleId = useId();
  const controlId = `${titleId}-control`;
  const { ask, about, control } = inboxEntryWords(entry);
  const held = entry.kind === 'held';
  return (
    <li
      className={`grid grid-cols-1 items-center gap-3 rounded-xl border bg-[var(--color-card)] px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4 sm:px-5 sm:py-4 ${
        held ? 'border-[var(--color-warn-line)]' : 'border-[var(--color-border)]'
      }`}
    >
      <div className="grid min-w-0 gap-1">
        <p
          id={titleId}
          className="text-[15px] font-semibold text-[var(--color-fg)] [overflow-wrap:anywhere]"
        >
          {named ? `${entry.employeeName} · ${ask}` : sentence(ask)}
        </p>
        <p className="text-sm text-[var(--color-fg-2)] [overflow-wrap:anywhere]">{about}</p>
        <p className="flex flex-wrap gap-x-2.5 text-[13px] text-[var(--color-muted)]">
          <span>{waitingFor(entry.waitingSince, now, entry.waitingAtLeast)}</span>
          {held && !entry.waitingAtLeast ? (
            <span>held since {clockTime(entry.waitingSince, entry.zone)}</span>
          ) : null}
        </p>
      </div>
      <div className="flex sm:justify-end">
        <ButtonLink
          id={controlId}
          href={inboxEntryHref(entry)}
          size="small"
          aria-labelledby={`${controlId} ${titleId}`}
        >
          {control}
        </ButtonLink>
      </div>
    </li>
  );
}
