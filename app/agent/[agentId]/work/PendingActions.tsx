'use client';

import type { MockAction, ArgumentRepairAttempt } from '@/work/types';
import { type ActionVerdict, HELD_WITHHELD_TRANSITION } from '@/surfaces/policy';
import type { SurfaceRecord } from '@/surfaces/types';
import { type ReplyTarget, summariseAction } from '@/surfaces/summary';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { Disclosure } from '../../../components/Disclosure';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { ItemFoot, ItemSection } from './ItemParts';
import { pendingHeadline } from './work-item';
import {
  HELD_WITHHELD_TRANSITION_NOTE,
  HELD_BEFORE_AUTONOMY_NOTE,
  HELD_WHILE_SUPERVISED_NOTE,
} from '@/work/autonomy';
import { ActionPayload, RepairNote } from './RunDetails';

/**
 * The consequence line under the held writes' controls.
 *
 * @param employeeName - Who authored the writes.
 */
export function heldActionsWhy(employeeName: string): string {
  return `Approving sends exactly what is ticked, as ${employeeName} wrote it, and nothing else. Rejecting ends this run with nothing held sent and keeps your reason on the item for the retry.`;
}

/**
 * The exact-action gate, as round two section 3.7 draws it: on the warn ground, every row the
 * ladder did not apply on its own, in words first with a tick each, the verbatim payload one
 * 13 px disclosure away, and "Withhold this one" to leave a row out. Approve counts what is
 * ticked, so "Approve selected (1)" and "Approve all" never mean the same thing; Reject opens
 * a reason and reads "Reject with this reason", so the two are not twins. Rows classified
 * `auto` were applied before the manager saw the card and are listed with the changes that
 * reached the work environment; nothing else reaches a surface until it is approved here.
 */
export function PendingActions({
  actions,
  verdicts,
  surfaces,
  replyTarget,
  autonomousActions = false,
  repairs,
  busy = false,
  employeeName = 'the employee',
  onApprove,
  onReject,
}: {
  actions: MockAction[];
  verdicts: ActionVerdict[];
  surfaces: SurfaceRecord[];
  replyTarget?: ReplyTarget;
  /** Whether the agent's switch is on now; the card says why the rows are waiting either way. */
  autonomousActions?: boolean;
  /** The one repair each held write earned before the hold, by action index. */
  repairs?: ArgumentRepairAttempt[];
  /** A decision on this card is in flight; the controls wait for it. */
  busy?: boolean;
  /** Who authored the writes, as the consequence line names them. */
  employeeName?: string;
  /** Approve the rows; the card says what it came to in its live region. */
  onApprove: (approvedIndexes: number[]) => void;
  /** Reject the run with the manager's reason; said on the card too. */
  onReject: (reason: string) => void;
}) {
  const id = useId();
  // The gate decided each row when it held the run: `auto` rows are already
  // applied and are not shown here; `refused` rows (a missing grant, an
  // unconnected surface, a forged trailer) cannot be ticked and the server
  // refuses them at approval; `held` rows are the manager's to approve. The
  // "Approve all" button is disabled while a refused row exists so it never
  // promises what the gate will not deliver.
  const refusedIndexes = useMemo(
    () =>
      new Set(
        verdicts.flatMap((verdict, index) => (verdict.disposition === 'refused' ? [index] : [])),
      ),
    [verdicts],
  );
  const heldIndexes = useMemo(
    () => verdicts.flatMap((verdict, index) => (verdict.disposition === 'held' ? [index] : [])),
    [verdicts],
  );
  const shown = useMemo(
    () =>
      actions
        .map((action, index) => ({ action, index }))
        .filter(({ index }) => verdicts[index]?.disposition !== 'auto'),
    [actions, verdicts],
  );
  const [selected, setSelected] = useState<Set<number>>(() => new Set(heldIndexes));
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const reasonField = useRef<HTMLInputElement>(null);
  // The reason is the next thing the manager writes once Reject opens it.
  useEffect(() => {
    if (rejecting) reasonField.current?.focus();
  }, [rejecting]);

  function toggle(index: number, on: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  const anyRefused = refusedIndexes.size > 0;
  const withheld = heldIndexes.filter((index) => !selected.has(index)).length;
  return (
    <>
      <ItemSection tone="warn">
        <p className="text-[15px] font-semibold text-[var(--color-warn)]">
          {pendingHeadline(verdicts)}
          {withheld > 0 ? ` · ${withheld} withheld by you` : ''}
        </p>
        {heldIndexes.length > 0 ? (
          <p className="text-[13px] text-[var(--color-fg-2)]">
            {heldIndexes.every((index) => {
              const verdict = verdicts[index];
              return verdict?.disposition === 'held' && verdict.reason === HELD_WITHHELD_TRANSITION;
            })
              ? HELD_WITHHELD_TRANSITION_NOTE
              : autonomousActions
                ? HELD_BEFORE_AUTONOMY_NOTE
                : HELD_WHILE_SUPERVISED_NOTE}
          </p>
        ) : null}
        {actions.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-2)]">
            The skill emitted no actions. Approving lands nothing; reject to send it back.
          </p>
        ) : (
          <ul className="grid">
            {shown.map(({ action, index }) => {
              const verdict = verdicts[index];
              const refused = verdict?.disposition === 'refused';
              const on = selected.has(index);
              const summary = summariseAction(action, surfaces, { replyTarget });
              return (
                <li
                  key={index}
                  className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-2 border-t border-[var(--color-warn-line)] py-3 first:border-t-0"
                >
                  <label className="flex min-h-11 min-w-11 items-start justify-center pt-3">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy || refused}
                      onChange={(event) => toggle(index, event.target.checked)}
                      aria-label={`approve: ${summary}`}
                      className="size-[18px] accent-[var(--color-accent)]"
                    />
                  </label>
                  <div className="min-w-0 pt-2.5">
                    <p
                      className={`text-[15px] break-words ${
                        refused || !on
                          ? 'text-[var(--color-muted)] line-through decoration-[var(--color-border-2)]'
                          : 'font-medium text-[var(--color-fg)]'
                      }`}
                    >
                      {summary}
                    </p>
                    <p className="text-[13px] text-[var(--color-muted)]">
                      {refused
                        ? `Refused by Day0's gate: ${verdict.reason}. It cannot be sent.`
                        : !on
                          ? 'Withheld by you: it will not be sent, and stays in the record.'
                          : verdict?.disposition === 'held'
                            ? `Held: ${verdict.reason}.`
                            : null}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-4">
                      {refused ? null : (
                        <Button
                          variant="text"
                          size="small"
                          disabled={busy}
                          onClick={() => toggle(index, !on)}
                          aria-label={`${on ? 'Withhold this one' : 'Include it again'}: ${summary}`}
                        >
                          {on ? 'Withhold this one' : 'Include it again'}
                        </Button>
                      )}
                      <Disclosure summary="Exact payload">
                        <ActionPayload action={action} />
                      </Disclosure>
                    </div>
                    <RepairNote repair={repairs?.find((attempt) => attempt.index === index)} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </ItemSection>
      <ItemFoot why={heldActionsWhy(employeeName)}>
        <Button
          variant="approve"
          size="large"
          disabled={busy || actions.length === 0}
          onClick={() => onApprove([...selected].sort((a, b) => a - b))}
        >
          Approve selected ({selected.size})
        </Button>
        <Button
          disabled={busy || anyRefused || heldIndexes.length === 0}
          title={anyRefused ? APPROVE_ALL_REFUSED : undefined}
          aria-describedby={anyRefused ? `${id}-all` : undefined}
          onClick={() => onApprove(heldIndexes)}
        >
          Approve all
        </Button>
        <Button
          aria-expanded={rejecting}
          aria-controls={rejecting ? `${id}-reject` : undefined}
          disabled={busy}
          onClick={() => setRejecting((open) => !open)}
        >
          Reject the run
        </Button>
        {anyRefused ? (
          <p id={`${id}-all`} className="basis-full text-[13px] text-[var(--color-muted)]">
            {APPROVE_ALL_REFUSED}
          </p>
        ) : null}
      </ItemFoot>
      {rejecting ? (
        <ItemSection>
          <div id={`${id}-reject`} className="grid gap-3">
            <Field
              label="Reason for rejecting"
              hint={`Kept with the item and shown to ${employeeName} on a retry.`}
            >
              {(control) => (
                <input
                  {...control}
                  ref={reasonField}
                  type="text"
                  value={reason}
                  disabled={busy}
                  onChange={(event) => setReason(event.target.value)}
                  className={`${INPUT_CLASS} w-full`}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="small"
                disabled={busy}
                onClick={() => onReject(reason)}
              >
                {reason.trim() ? 'Reject with this reason' : 'Reject without a reason'}
              </Button>
              <Button
                variant="quiet"
                size="small"
                disabled={busy}
                onClick={() => setRejecting(false)}
              >
                Keep it held
              </Button>
            </div>
          </div>
        </ItemSection>
      ) : null}
    </>
  );
}

/** Why Approve all is disabled while the gate refuses a row, beside the button and for its hover. */
const APPROVE_ALL_REFUSED =
  'A row in this run is refused by the gate and cannot be approved; approve the rest by selection.';
