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

/** What a renewal answers: the new end, and what else it needs (11-AR's `setAccessDays`). */
export interface Renewed {
  readonly expiresAt: number;
  /** The identity the expiry revoked at the vendor, issued again on the card. */
  readonly reissue?: 'install' | 'authorise';
  /** A pasted key whose system IT connected: the move to the employee's own identity (A27). */
  readonly offer?: 'own-identity';
}

/** The move off a pasted key the card offers at its renewal (A27): its words and its control. */
export interface MoveOffer {
  readonly words: string;
  /** The button's words, naming the key it moves off. */
  readonly label: string;
  readonly onMove: () => void;
}

/** What a renewal needs next, said after the renewal itself: the identity issued again. */
const REISSUE_WORDS: Readonly<Record<NonNullable<Renewed['reissue']>, string>> = {
  install: 'The end revoked its access, so install its app again below.',
  authorise: 'The end revoked its access, so Connect it again below.',
};

/** A surface as the expiry block reads it. */
export type ExpirySurface = Pick<
  Doc<'surfaces'>,
  '_id' | 'displayName' | 'verdict' | 'expiresAt' | 'accessSetBy' | 'reason'
>;

/** What brings back a card an administrator ended by revoking its connection, in place of Renew. */
export const REVOKED_CONNECTION_NOTE =
  'IT revoked the organisation’s connection this card used, so renewing brings nothing back: it connects again once IT connects the system again.';

/**
 * The card's expiry block (Q5, U3, K): when access ends, in the employee's zone, who set the
 * date, and the one control that renews it for a chosen period from today (`surfaces.setAccessDays`),
 * which is also how an access that has ended comes back. A probe never moves the date and
 * nothing renews on its own, so this is the one place the manager keeps a connection alive. The
 * outcome is said in the block's live region; focus stays on the control, which stays.
 *
 * A renewal that needs the identity issued again says so, and the card's own row issues it (A26). A
 * card on a pasted key whose system IT has since connected is offered the move to the employee's
 * own identity from the week its access ends, and after a renewal that offers it; the key keeps
 * working meanwhile (A27). An ended card can say what the end did beyond the card (`endedNote`:
 * a Slack bot's channels, RM4).
 *
 * @param surface - The card's row.
 * @param now - The instant to judge the end date against.
 * @param onSetDays - Renews the access for that many days from now; resolves to the new end and
 *   what the renewal needs.
 * @param endedNote - What the end did beyond the card, said while the access has ended.
 * @param move - The move off a pasted key, where the card offers one.
 * @param connectionRevoked - The card's organisation connection was revoked by an administrator,
 *   which ended it: no renewal is offered, since none brings it back, and the block says what does.
 * @returns The block, or nothing for a card whose access has not started.
 */
export function ExpiryBlock({
  surface,
  now,
  onSetDays,
  endedNote,
  move,
  connectionRevoked = false,
}: {
  surface: ExpirySurface;
  now: number;
  onSetDays: (days: number) => Promise<Renewed>;
  endedNote?: string;
  move?: MoveOffer;
  connectionRevoked?: boolean;
}) {
  const zone = useAgentZone();
  const periodId = useId();
  const [days, setDays] = useState<number>(SURFACE_ACCESS_DEFAULT_DAYS);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const [offered, setOffered] = useState(false);
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
        const next = result.reissue === undefined ? '' : ` ${REISSUE_WORDS[result.reissue]}`;
        // A shorter period moves the end earlier: said as that, never as a renewal.
        setOutcome({
          tone: 'done',
          text:
            result.expiresAt < before
              ? `${surface.displayName} access now ends ${ends}, earlier than it did.${next}`
              : `Renewed: ${surface.displayName} access now ends ${ends}.${next}`,
        });
        if (result.offer === 'own-identity') setOffered(true);
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
      {connectionRevoked ? (
        <p className="text-sm text-[var(--color-warn)]">{REVOKED_CONNECTION_NOTE}</p>
      ) : (
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
      )}
      <StatusRegion outcome={outcome} />
      {standing.kind === 'ended' && endedNote !== undefined ? (
        <p className="text-sm text-[var(--color-warn)]">{endedNote}</p>
      ) : null}
      {move !== undefined && (standing.kind !== 'running' || offered) ? (
        <div className="grid gap-2 rounded-lg bg-[var(--color-inset)] p-3 text-sm">
          <p className="text-[var(--color-fg-2)]">{move.words}</p>
          <div>
            <Button size="small" onClick={move.onMove}>
              {move.label}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
