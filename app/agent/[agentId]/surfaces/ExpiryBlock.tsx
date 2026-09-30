'use client';

import { useId, useRef, useState } from 'react';
import type { Doc } from '@convex/_generated/dataModel';
import { SURFACE_ACCESS_DEFAULT_DAYS, SURFACE_ACCESS_MAX_DAYS } from '@/surfaces/access';
import { Button } from '../../../components/Button';
import { INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import { type ChangeOutcome, refusalText } from '../../../components/use-change';
import { clockTime, useAgentZone } from '../../../components/time';
import { accessStanding } from './card-words';

/**
 * The access periods a renewal offers, in days; Q5's `SURFACE_ACCESS_DEFAULT_DAYS` is chosen until
 * the manager picks another.
 */
export const ACCESS_PERIODS = [
  30,
  SURFACE_ACCESS_DEFAULT_DAYS,
  180,
  SURFACE_ACCESS_MAX_DAYS,
] as const;

/** Who set the end date, in the manager's words. */
const SET_BY_WORDS: Readonly<Record<NonNullable<Doc<'surfaces'>['accessSetBy']>, string>> = {
  approval: 'set when you approved the card',
  manager: 'set by you',
  upgrade: 'set by the upgrade',
};

/** Q5's rule, as the card says it under a running end date. */
export const EXPIRY_RULE =
  'A notice reaches you a week before. Renewing is your explicit act; a working probe never extends it.';

/** A surface as the expiry block reads it. */
export type ExpirySurface = Pick<
  Doc<'surfaces'>,
  '_id' | 'displayName' | 'verdict' | 'expiresAt' | 'accessSetBy' | 'reason'
>;

/**
 * The card's expiry block (Q5, U3, K): when access ends, in the employee's zone, who set the
 * date, and the one control that renews it for a chosen period from today (`surfaces.setAccessDays`),
 * which is also how an access that has ended comes back. A probe never moves the date and
 * nothing renews on its own, so this is the one place the manager keeps a connection alive. The
 * outcome is said in the block's live region; focus stays on the control, which stays.
 *
 * @param surface - The card's row.
 * @param now - The instant to judge the end date against.
 * @param onSetDays - Renews the access for that many days from now; resolves to the new end.
 * @returns The block, or nothing for a card whose access has not started.
 */
export function ExpiryBlock({
  surface,
  now,
  onSetDays,
}: {
  surface: ExpirySurface;
  now: number;
  onSetDays: (days: number) => Promise<{ expiresAt: number }>;
}) {
  const zone = useAgentZone();
  const periodId = useId();
  const [days, setDays] = useState<number>(SURFACE_ACCESS_DEFAULT_DAYS);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const control = useRef<HTMLButtonElement>(null);
  const standing = accessStanding(surface, now, zone);
  if (standing.kind === 'none') return null;
  const end = (
    <time dateTime={new Date(standing.expiresAt).toISOString()}>
      {clockTime(standing.expiresAt, zone)}
    </time>
  );
  const setBy = surface.accessSetBy ? ` (${SET_BY_WORDS[surface.accessSetBy]})` : '';
  const before = standing.expiresAt;
  const renew = (): void => {
    setBusy(true);
    setOutcome(null);
    // The chain ends in its own catch, which says the refusal in the live region.
    void onSetDays(days)
      .then((result) => {
        const ends = clockTime(result.expiresAt, zone);
        // A shorter period moves the end earlier: said as that, never as a renewal.
        setOutcome({
          tone: 'done',
          text:
            result.expiresAt < before
              ? `${surface.displayName} access now ends ${ends}, earlier than it did.`
              : `Renewed: ${surface.displayName} access now ends ${ends}.`,
        });
      })
      .catch((err: unknown) =>
        setOutcome({ tone: 'refused', text: refusalText(err, 'The access was not renewed.') }),
      )
      .finally(() => {
        setBusy(false);
        control.current?.focus();
      });
  };
  return (
    <div className="grid gap-3">
      <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
        <p className="text-[13px] text-[var(--color-muted)]">
          {standing.kind === 'ended' ? 'Access ended' : 'Access lasts until'}
        </p>
        <p
          className={`text-sm ${standing.kind === 'running' ? 'text-[var(--color-fg-2)]' : 'text-[var(--color-warn)]'}`}
        >
          {end}
          {setBy}.{' '}
          {standing.kind === 'ended'
            ? 'Nothing is read or sent through this card until you renew it.'
            : standing.kind === 'ending'
              ? 'After that, nothing is read or sent through this card until you renew it.'
              : EXPIRY_RULE}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <label htmlFor={periodId} className="text-[13px] font-medium text-[var(--color-fg-2)]">
            Access period
          </label>
          <select
            id={periodId}
            value={days}
            disabled={busy}
            onChange={(event) => setDays(Number(event.target.value))}
            className={`${INPUT_CLASS} w-auto`}
          >
            {ACCESS_PERIODS.map((period) => (
              <option key={period} value={period}>
                {period} days
              </option>
            ))}
          </select>
        </div>
        <Button
          ref={control}
          size="small"
          variant={standing.kind === 'running' ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={renew}
        >
          {busy ? 'Renewing…' : `Renew for ${days} days`}
        </Button>
      </div>
      <StatusRegion outcome={outcome} />
    </div>
  );
}
