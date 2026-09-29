'use client';

import Link from 'next/link';
import { useId } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import {
  CLAIMED_BY_COLLEAGUE_SKIP_PREFIX,
  OUT_OF_SCOPE_SKIP_PREFIX,
  QUALITY_FIT_SKIP_PREFIX,
} from '@/work/types';
import { ButtonLink } from '../../components/Button';
import { Card } from '../../components/Card';
import { Columns } from '../../components/Columns';
import { Disclosure } from '../../components/Disclosure';
import { InboxEntry } from '../../components/InboxEntry';
import { RecordLine } from '../../components/RecordLine';
import { useEmployee } from './employee-context';
import { employeeTabHref } from './employee-tabs';
import { EmployeeRail } from './EmployeeRail';
import { TAKE_IT_ANYWAY } from './work/work-item';
import { useNow } from '../../components/time';

/** How many skipped items the page names under what else is waiting. */
export const SKIPPED_LINES = 5;

/** The prefixes a skip reason carries, which the manager is not meant to read. */
const SKIP_PREFIXES = [
  QUALITY_FIT_SKIP_PREFIX,
  OUT_OF_SCOPE_SKIP_PREFIX,
  CLAIMED_BY_COLLEAGUE_SKIP_PREFIX,
] as const;

/**
 * Why the employee set an item aside, in its own words: the verdict's reason without the prefix
 * that files it, or nothing when the row carries none.
 *
 * @param item - A skipped work item.
 */
export function skipReasonOf(item: Pick<Doc<'workItems'>, 'verdict'>): string | undefined {
  const verdict: unknown = item.verdict;
  const reason =
    typeof verdict === 'object' && verdict !== null
      ? (verdict as { reason?: unknown }).reason
      : undefined;
  if (typeof reason !== 'string' || reason.trim() === '') return undefined;
  const prefix = SKIP_PREFIXES.find((candidate) => reason.startsWith(candidate));
  const said = (prefix ? reason.slice(prefix.length) : reason).trim();
  return said === '' ? undefined : said.charAt(0).toUpperCase() + said.slice(1);
}

/** The verdict's stored reason, prefix and all, or nothing when the row carries none. */
function verdictReason(item: Pick<Doc<'workItems'>, 'verdict'>): string | undefined {
  const verdict: unknown = item.verdict;
  const reason =
    typeof verdict === 'object' && verdict !== null
      ? (verdict as { reason?: unknown }).reason
      : undefined;
  return typeof reason === 'string' ? reason : undefined;
}

/** Whether a skip is the employee's own judgement, which the manager can overrule on its card. */
function overrulable(item: Pick<Doc<'workItems'>, 'verdict'>): boolean {
  const reason = verdictReason(item);
  return (
    reason !== undefined &&
    (reason.startsWith(QUALITY_FIT_SKIP_PREFIX) || reason.startsWith(OUT_OF_SCOPE_SKIP_PREFIX))
  );
}

/**
 * What the employee set aside, in one short sentence of the manager's words: the item, and the
 * kind of judgement that set it aside, never the evaluator's own prose, which is kept as it was
 * recorded and shown one disclosure away.
 *
 * @param item - A skipped work item.
 * @param name - The employee.
 */
export function skippedSentence(
  item: Pick<Doc<'workItems'>, 'title' | 'verdict'>,
  name: string,
): string {
  const reason = verdictReason(item) ?? '';
  const skipped = `Skipped “${item.title}”`;
  if (reason.startsWith(OUT_OF_SCOPE_SKIP_PREFIX)) {
    return `${skipped}: it looked outside ${name}'s charter.`;
  }
  if (reason.startsWith(QUALITY_FIT_SKIP_PREFIX)) {
    return `${skipped}: it did not look worth doing as it stands.`;
  }
  if (reason.startsWith(CLAIMED_BY_COLLEAGUE_SKIP_PREFIX)) {
    return `${skipped}: a colleague is working it.`;
  }
  return `${skipped}.`;
}

/**
 * One item set aside: the sentence, then on a line of its own the link to its card, named with
 * the sentence so five of them are told apart, and the employee's own reason behind a disclosure.
 *
 * @param item - A skipped work item.
 * @param name - The employee.
 * @param work - The Work tab's address.
 */
function SkippedLine({ item, name, work }: { item: Doc<'workItems'>; name: string; work: string }) {
  const sentenceId = useId();
  const linkId = `${sentenceId}-link`;
  const reason = skipReasonOf(item);
  return (
    <RecordLine kind="withheld">
      <p id={sentenceId}>{skippedSentence(item, name)}</p>
      <div className="flex flex-wrap items-start gap-x-5">
        <ButtonLink
          id={linkId}
          href={`${work}#item-${item._id}`}
          aria-labelledby={`${linkId} ${sentenceId}`}
          variant="text"
        >
          {overrulable(item) ? `${TAKE_IT_ANYWAY} on the Work tab` : 'Open it on the Work tab'}
        </ButtonLink>
        {reason !== undefined ? (
          <Disclosure summary={`Why ${name} skipped it`}>
            <p className="text-[13px] text-[var(--color-fg-2)]">{reason}</p>
          </Disclosure>
        ) : null}
      </div>
    </RecordLine>
  );
}

/**
 * What waits on nobody: each item the employee set aside, newest first, in a short sentence with
 * the link to its card on the Work tab, where the manager can give it the work anyway, and the
 * employee's reason a disclosure away; and whether a reorientation card is open (none can be
 * yet, A11), with the page that says what it covers.
 */
function SetAside({ title, skipped }: { title: string; skipped: readonly Doc<'workItems'>[] }) {
  const { agent } = useEmployee();
  const work = employeeTabHref(agent._id, 'work');
  // Newest first: what the employee set aside most recently is the likeliest to still matter.
  const newest = [...skipped].sort((left, right) => right._creationTime - left._creationTime);
  const more = newest.length - SKIPPED_LINES;
  return (
    <Card title={title}>
      <ul className="grid gap-2">
        {newest.length === 0 ? (
          <RecordLine kind="withheld">{agent.name} has set nothing aside.</RecordLine>
        ) : (
          newest
            .slice(0, SKIPPED_LINES)
            .map((item) => <SkippedLine key={item._id} item={item} name={agent.name} work={work} />)
        )}
        <RecordLine kind="noted">
          No reorientation card is open.{' '}
          <Link href={`/agent/${agent._id}/reorientation`}>What reorientation covers</Link>.
        </RecordLine>
      </ul>
      {more > 0 ? (
        <p className="mt-3 text-[13px] text-[var(--color-muted)]">
          {more} more set aside, on the <Link href={work}>Work tab</Link>.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * The Needs you tab, the employee page's default (N7, round two section 3.6): what waits on the
 * manager first, longest wait first, each with the one control that opens where it is decided;
 * then what the employee set aside, which waits on nobody. The entries are the employee's share
 * of the company home's inbox, read by the same rules (`work.needsYouForAgent`).
 */
export function NeedsYouView() {
  const { agent, arriving } = useEmployee();
  const agentId = agent._id;
  const inbox = useQuery(api.work.needsYouForAgent, { agentId });
  const workItems = useQuery(api.work.listForAgent, { agentId });
  const now = useNow();
  const skipped = (workItems ?? []).filter((item) => item.state === 'skipped');
  const waiting = inbox?.entries ?? [];
  const more = inbox ? inbox.total - inbox.entries.length : 0;
  return (
    <Columns arriving={arriving} aside={<EmployeeRail />}>
      {inbox === undefined ? (
        <p role="status" className="text-sm text-[var(--color-muted)]">
          Loading what waits on you
        </p>
      ) : waiting.length > 0 ? (
        <ol aria-label="Needs you, longest wait first" className="grid gap-3">
          {waiting.map((entry) => (
            <InboxEntry key={entry.key} entry={entry} now={now} />
          ))}
        </ol>
      ) : null}
      {more > 0 ? (
        <p className="text-[13px] text-[var(--color-muted)]">
          {more} more wait on you; each shows on its own tab.
        </p>
      ) : null}
      {inbox !== undefined && workItems !== undefined ? (
        <SetAside
          title={
            waiting.length > 0 ? 'Nothing else is waiting on you' : 'Nothing is waiting on you'
          }
          skipped={skipped}
        />
      ) : null}
    </Columns>
  );
}
