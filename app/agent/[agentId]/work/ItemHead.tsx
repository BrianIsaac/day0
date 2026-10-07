'use client';

import type { Doc } from '@convex/_generated/dataModel';
import type { SurfaceRecord } from '@/surfaces/types';
import { sourceLine, withoutSlackMentions, type ListedWorkItem } from '@/work/item-display';
import { undeliveredDecisionReason } from '@/work/manager-channel';
import { Button } from '../../../components/Button';
import { connectedManagerChannel } from '../manager-channel';
import { clockTime, clockTimeWithSeconds } from '../../../components/time';
import { Quote, Tag } from './ItemParts';
import { StateChip } from './RunDetails';
import { decisionAttribution } from './work-item';

/** Where intake found an item, in words: a chat mention is the inbox, a ticket the ticket queue. */
const SOURCE_WORDS: Readonly<Record<string, string>> = {
  'event-stream': 'inbox',
  'ticket-queue': 'ticket queue',
};

/**
 * An intake category in words, or as the row keeps it when it has none.
 *
 * @param category - The row's `sourceCategory`.
 */
export function sourceWords(category: string): string {
  return SOURCE_WORDS[category] ?? category;
}

/**
 * Who decided the item's plan or writes, where and when: "approved from Slack at 14:41". Every
 * stamp carries its time (N7).
 *
 * @param decision - The row's decision record.
 * @param zone - The employee's zone.
 * @returns The words, or null while nothing is decided.
 */
export function DecisionStamp({
  decision,
  zone,
}: {
  decision: Doc<'workItems'>['decision'];
  zone: string | undefined;
}) {
  const decided = decisionAttribution(decision);
  if (!decided) return null;
  const at = decision?.decidedAt;
  return (
    <>
      {decided}
      {at !== undefined ? (
        <>
          {' at '}
          <time dateTime={new Date(at).toISOString()} title={clockTimeWithSeconds(at, zone)}>
            {clockTime(at, zone)}
          </time>
        </>
      ) : null}
    </>
  );
}

/**
 * The top of a work item: its state in the manager's words beside where it came from, its
 * title, who asked and what they asked, and the decision's own lines (who decided and when; a
 * request that never reached the manager's channel, with the control that asks again).
 *
 * @param item - The row.
 * @param surfaces - The employee's surfaces, for the manager channel a parked row can be asked on.
 * @param now - The page's clock, for a request past its recovery bound.
 * @param zone - The employee's zone, for the decision's time.
 * @param busy - A decision on the card is in flight; the ask-again control waits for it.
 * @param onAskAgain - Ask on the named channel, or resend there.
 * @param stampDecision - Whether the head says who decided; a landed card says it on its green
 *   line instead.
 */
export function ItemHead({
  item,
  surfaces,
  now,
  zone,
  busy,
  onAskAgain,
  stampDecision = true,
}: {
  item: ListedWorkItem;
  surfaces: readonly SurfaceRecord[];
  now: number;
  zone: string | undefined;
  busy: boolean;
  onAskAgain: (surfaceName: string) => void;
  stampDecision?: boolean;
}) {
  const from = sourceLine(item);
  const decided = stampDecision ? decisionAttribution(item.decision) : undefined;
  // The phone request is shown only when it is known not to have arrived: a
  // recorded failure, or a silent send past the recovery bound. In flight,
  // delivered and decided requests say nothing here.
  const undelivered =
    item.state === 'plan-pending' || item.state === 'actions-pending'
      ? undeliveredDecisionReason(item.decision, now)
      : undefined;
  // A row that parked while no manager channel was connected was never asked;
  // once a channel is, the card can ask (the sweep also does, a lease later).
  const askable =
    !item.decision &&
    (item.state === 'plan-pending' ||
      (item.state === 'actions-pending' && item.approvedIndexes === undefined))
      ? connectedManagerChannel([...surfaces], now)
      : undefined;
  const tag = [item.sourceSystem, sourceWords(item.sourceCategory), item.priority]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="grid gap-2 px-4 pt-4 pb-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <StateChip item={item} />
        <Tag>{tag}</Tag>
      </div>
      <h3
        id={`work-item-${item._id}`}
        className="text-base leading-snug font-semibold text-[var(--color-fg)]"
      >
        {withoutSlackMentions(item.title)}
      </h3>
      <p className="line-clamp-2 text-sm text-[var(--color-fg-2)]">
        {from ? `${from}: ` : null}
        <Quote>{withoutSlackMentions(item.contentSummary)}</Quote>
      </p>
      {decided ? (
        <p className="text-[13px] text-[var(--color-muted)] first-letter:uppercase">
          <DecisionStamp decision={item.decision} zone={zone} />.
        </p>
      ) : null}
      {askable ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[var(--color-muted)]">
          <span>
            {item.state === 'plan-pending' ? 'This plan was' : 'These actions were'} not asked on{' '}
            {askable.displayName} yet: they parked while no manager channel was connected.
          </span>
          <Button size="small" disabled={busy} onClick={() => onAskAgain(askable.displayName)}>
            Ask on {askable.displayName}
          </Button>
        </div>
      ) : null}
      {undelivered && item.decision ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[var(--color-warn)]">
          <span>
            {item.decision.surfaceName} request not delivered
            {undelivered === 'request not delivered' ? '' : ` (${undelivered})`}
          </span>
          <Button
            size="small"
            disabled={busy}
            onClick={() => onAskAgain(item.decision?.surfaceName ?? 'the manager channel')}
          >
            Resend
          </Button>
        </div>
      ) : null}
    </div>
  );
}
