'use client';

import type { MockAction, ArgumentRepairAttempt } from '@/work/types';
import { type ActionVerdict, HELD_WITHHELD_TRANSITION } from '@/surfaces/policy';
import type { SurfaceRecord } from '@/surfaces/types';
import { type ReplyTarget, summariseAction } from '@/surfaces/summary';
import { useId, useMemo, useState } from 'react';
import { pendingHeadline } from './work-item';
import {
  HELD_WITHHELD_TRANSITION_NOTE,
  HELD_BEFORE_AUTONOMY_NOTE,
  HELD_WHILE_SUPERVISED_NOTE,
} from '@/work/autonomy';
import { ActionPayload, RepairNote } from './RunDetails';

/**
 * The exact-action gate: every row the ladder did not apply on its own,
 * verbatim, with a checkbox each. Rows classified `auto` were applied before
 * the manager saw the card and are listed with the changes that reached the
 * work environment; nothing else reaches a surface until it is approved here.
 */
export function PendingActions({
  actions,
  verdicts,
  surfaces,
  replyTarget,
  autonomousActions = false,
  repairs,
  busy = false,
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
  /** Approve the rows; the card says what it came to in its live region. */
  onApprove: (approvedIndexes: number[]) => void;
  /** Reject the run with the manager's reason; said on the card too. */
  onReject: (reason: string) => void;
}) {
  const reasonId = useId();
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

  function toggle(index: number, on: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  const anyRefused = refusedIndexes.size > 0;
  return (
    <div className="mt-3 p-2 rounded-md bg-[var(--color-warn)]/10 border border-[var(--color-warn)]/30 text-xs">
      <p className="text-[var(--color-warn)] font-medium mb-1">{pendingHeadline(verdicts)}</p>
      {heldIndexes.length > 0 ? (
        <p className="text-[var(--color-muted)] mb-1">
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
        <p className="text-[var(--color-muted)]">
          The skill emitted no actions. Approving lands nothing; reject to send it back.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map(({ action, index }) => {
            const verdict = verdicts[index];
            const refused = verdict?.disposition === 'refused';
            const on = selected.has(index);
            const summary = summariseAction(action, surfaces, { replyTarget });
            return (
              <li key={index} className="flex items-start gap-2">
                <label className="flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy || refused}
                    onChange={(event) => toggle(index, event.target.checked)}
                    aria-label={`approve: ${summary}`}
                  />
                </label>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-[var(--color-fg)] break-words">
                    {summary}
                    {refused ? (
                      <span className="text-[var(--color-warn)]">
                        {' '}
                        · refused · {verdict.reason}
                      </span>
                    ) : verdict?.disposition === 'held' ? (
                      <span className="text-[var(--color-muted)]"> · {verdict.reason}</span>
                    ) : null}
                  </p>
                  <details className="mt-0.5">
                    <summary className="min-h-11 py-3 text-[10px] text-[var(--color-muted)] cursor-pointer select-none">
                      exact payload
                    </summary>
                    <ActionPayload action={action} />
                  </details>
                  <RepairNote repair={repairs?.find((attempt) => attempt.index === index)} />
                  <div className="flex items-center gap-2 mt-0.5">
                    {!refused && !on ? (
                      <span className="text-[10px] text-[var(--color-muted)]">
                        held · will not be sent
                      </span>
                    ) : null}
                    {refused ? null : on ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(index, false)}
                        aria-label={`reject this action: ${summary}`}
                        className="min-h-11 px-1 text-[10px] text-[var(--color-danger)] underline"
                      >
                        reject this action
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(index, true)}
                        aria-label={`include: ${summary}`}
                        className="min-h-11 px-1 text-[10px] text-[var(--color-accent)] underline"
                      >
                        include
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <button
          type="button"
          disabled={busy || actions.length === 0}
          onClick={() => onApprove([...selected].sort((a, b) => a - b))}
          className="min-h-11 px-3 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] text-xs font-medium disabled:opacity-50"
        >
          Approve selected ({selected.size})
        </button>
        <button
          type="button"
          disabled={busy || anyRefused || heldIndexes.length === 0}
          title={anyRefused ? APPROVE_ALL_REFUSED : undefined}
          aria-describedby={anyRefused ? `${reasonId}-all` : undefined}
          onClick={() => onApprove(heldIndexes)}
          className="min-h-11 px-3 rounded-md border border-[var(--color-ok)]/40 text-[var(--color-ok)] text-xs disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Approve all
        </button>
        {anyRefused ? (
          <p id={`${reasonId}-all`} className="basis-full text-[10px] text-[var(--color-muted)]">
            {APPROVE_ALL_REFUSED}
          </p>
        ) : null}
        <label htmlFor={reasonId} className="basis-full text-[10px] text-[var(--color-muted)]">
          Reason for rejecting the run
        </label>
        <input
          id={reasonId}
          type="text"
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
          className="min-h-11 flex-1 min-w-[10rem] px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => onReject(reason)}
          className="min-h-11 px-3 rounded-md border border-[var(--color-border)] hover:border-[var(--color-danger)] text-xs"
        >
          Reject run
        </button>
      </div>
    </div>
  );
}

/** Why Approve all is disabled while the gate refuses a row, beside the button and for its hover. */
const APPROVE_ALL_REFUSED =
  'A row in this run is refused by the gate and cannot be approved; approve the rest by selection.';
