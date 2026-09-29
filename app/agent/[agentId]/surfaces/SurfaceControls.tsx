'use client';

import type { Doc } from '@convex/_generated/dataModel';
import { useAgentZone, clockTime } from '../time';
import { useState, useRef } from 'react';
import { type ChangeOutcome, refusalText } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';

/** Q5's access length, in days: what a renewal offers until the manager types another. */
export const DEFAULT_ACCESS_DAYS = 90;

/** How long before the end date the card warns, as the server's notice does (Q5). */
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/** The verdicts of an approved card, whose access runs on a clock. */
const ACCESS_VERDICTS: ReadonlySet<string> = new Set([
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
]);

/** Who set the end date, in the manager's words. */
const ACCESS_SET_BY_WORDS: Readonly<Record<NonNullable<Doc<'surfaces'>['accessSetBy']>, string>> = {
  approval: 'set when you approved the card',
  manager: 'set by you',
  upgrade: 'set by the upgrade',
};

/** A surface as the access row reads it. */
export type AccessSurface = Pick<
  Doc<'surfaces'>,
  '_id' | 'displayName' | 'verdict' | 'expiresAt' | 'accessSetBy' | 'reason'
>;

/**
 * The card's access line (Q5): when access ends, in the employee's zone, who
 * set the date, and the control that sets it again, which is also the
 * explicit renewal of an access that has ended (`surfaces.setAccessDays`).
 *
 * A probe never moves the date and nothing renews on its own, so the line is
 * the one place the manager keeps a connection alive. The outcome is announced
 * in the row's live region and focus returns to the control.
 *
 * Args:
 *   props: The surface, the instant to judge the warning against, and the setter.
 *
 * Returns:
 *   The row, or nothing for a card whose access has not started.
 */
export function AccessRow({
  surface,
  now,
  onSetDays,
}: {
  surface: AccessSurface;
  now: number;
  onSetDays: (days: number) => Promise<{ expiresAt: number }>;
}): React.ReactNode {
  const zone = useAgentZone();
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState(String(DEFAULT_ACCESS_DAYS));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  if (!ACCESS_VERDICTS.has(surface.verdict) || surface.expiresAt === undefined) return null;
  // The hourly sweep marks an ended card `expired`; until it runs, and on a
  // card whose reason a later failure replaced, the passed date says it.
  const ended = surface.reason === 'expired' || surface.expiresAt <= now;
  const endingSoon = !ended && surface.expiresAt - now <= EXPIRY_WARNING_MS;
  const fieldId = `access-days-${surface._id}`;
  const close = (): void => {
    setEditing(false);
    toggle.current?.focus();
  };
  const save = (): void => {
    setBusy(true);
    setOutcome(null);
    // The chain ends in its own catch, which says the refusal in the live region.
    void onSetDays(Number(days))
      .then((result) => {
        setOutcome({
          tone: 'done',
          text: `${ended ? 'Access renewed' : 'Access length set'}: ${surface.displayName} access now ends ${clockTime(result.expiresAt, zone)}.`,
        });
        close();
      })
      .catch((err: unknown) =>
        setOutcome({ tone: 'refused', text: refusalText(err, 'The access length was not set.') }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div
      className={`mt-3 rounded border p-2 text-xs ${
        ended || endingSoon ? 'border-[var(--color-warn)]/40' : 'border-[var(--color-border)]'
      }`}
    >
      <p className={ended || endingSoon ? 'text-[var(--color-warn)]' : undefined}>
        {ended ? 'Access ended ' : 'Access ends '}
        <time dateTime={new Date(surface.expiresAt).toISOString()}>
          {clockTime(surface.expiresAt, zone)}
        </time>
        {surface.accessSetBy ? ` · ${ACCESS_SET_BY_WORDS[surface.accessSetBy]}` : ''}
        {ended
          ? '. Nothing is read or sent through this card until you renew it.'
          : endingSoon
            ? '. That is within a week; renew it to keep the connection.'
            : '.'}
      </p>
      <button
        ref={toggle}
        type="button"
        aria-expanded={editing}
        aria-controls={`${fieldId}-form`}
        onClick={() => {
          setOutcome(null);
          setEditing(!editing);
        }}
        className="mt-2 min-h-11 rounded border px-3 text-xs"
      >
        {ended ? 'Renew access' : 'Change the end date'}
      </button>
      {editing ? (
        <form
          id={`${fieldId}-form`}
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label htmlFor={fieldId}>Days from now</label>
          <input
            id={fieldId}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            required
            autoFocus
            value={days}
            disabled={busy}
            onChange={(event) => setDays(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
            className="min-h-11 w-24 rounded border bg-transparent px-2"
          />
          <button
            type="submit"
            disabled={busy || days.trim() === ''}
            className="min-h-11 rounded border px-3 disabled:opacity-50"
          >
            {busy ? 'Saving…' : ended ? 'Renew' : 'Set'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={close}
            className="min-h-11 rounded border px-3 disabled:opacity-50"
          >
            Cancel
          </button>
        </form>
      ) : null}
      <StatusRegion outcome={outcome} />
    </div>
  );
}

/** A surface as the tools row reads it. */
export type ToolsSurface = Pick<
  Doc<'surfaces'>,
  '_id' | 'displayName' | 'verdict' | 'toolAllowlist' | 'approvedToolAllowlist' | 'withheldTools'
>;

/**
 * The tools a connected card calls, and the manager's control to change the
 * tools it may call (U10 D2 (b), the re-approval of a narrowed card).
 *
 * The first connection after an approval freezes the approved list; a later
 * probe that finds more tools keeps them back (the row's `withheldTools`)
 * until the manager approves them here, and nothing else widens the list
 * (`surfaces.approveTools`). Taking a tool off stops it at once; one added is
 * called once the next probe finds the provider offers it.
 *
 * Args:
 *   props: The surface and the approval callback.
 *
 * Returns:
 *   The row, or nothing for a card that is not connected.
 */
export function ToolsRow({
  surface,
  onApprove,
}: {
  surface: ToolsSurface;
  onApprove: (tools: string[]) => Promise<unknown>;
}): React.ReactNode {
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<readonly string[]>([]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  if (surface.verdict !== 'connected') return null;
  const calls = surface.toolAllowlist ?? [];
  const approved = surface.approvedToolAllowlist ?? calls;
  const notOffered = approved.filter((tool) => !calls.includes(tool));
  const keptBack = (surface.withheldTools ?? []).filter((tool) => !approved.includes(tool));
  const options = [...new Set([...approved, ...keptBack, ...added])];
  const formId = `tools-${surface._id}`;
  const open = (): void => {
    setChosen(new Set(approved));
    setAdded([]);
    setTyped('');
    setOutcome(null);
    setEditing(true);
  };
  const close = (): void => {
    setEditing(false);
    toggle.current?.focus();
  };
  const addTyped = (): void => {
    const tool = typed.trim();
    if (tool === '') return;
    if (!options.includes(tool)) setAdded([...added, tool]);
    setChosen(new Set([...chosen, tool]));
    setTyped('');
  };
  const save = (): void => {
    const tools = options.filter((tool) => chosen.has(tool));
    setBusy(true);
    setOutcome(null);
    // The chain ends in its own catch, which says the refusal in the live region.
    void onApprove(tools)
      .then(() => {
        const gained = tools.filter((tool) => !approved.includes(tool));
        const dropped = approved.filter((tool) => !tools.includes(tool));
        const changes = [
          gained.length > 0 ? `added ${gained.join(', ')}` : '',
          dropped.length > 0 ? `removed ${dropped.join(', ')}` : '',
        ].filter(Boolean);
        setOutcome({
          tone: 'done',
          text: `Approved tools saved${changes.length > 0 ? `: ${changes.join('; ')}` : ''}. Day0 checks the connection now; an added tool is called once the provider offers it.`,
        });
        close();
      })
      .catch((err: unknown) =>
        setOutcome({
          tone: 'refused',
          text: refusalText(err, 'The approved tools were not saved.'),
        }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="mt-3 rounded border border-[var(--color-border)] p-2 text-xs">
      <p>
        <span className="text-[var(--color-muted)]">Scopes: </span>
        {calls.length > 0 ? calls.join(', ') : 'no tool the provider offers is approved'}
      </p>
      {notOffered.length > 0 ? (
        <p className="mt-1 text-[var(--color-muted)]">
          Approved, not offered by the provider at the last check: {notOffered.join(', ')}
        </p>
      ) : null}
      {keptBack.length > 0 ? (
        <p className="mt-1 text-[var(--color-warn)]">
          Withheld, outside your approval: {keptBack.join(', ')}. Approve them here to let the
          employee call them.
        </p>
      ) : null}
      <button
        ref={toggle}
        type="button"
        aria-expanded={editing}
        aria-controls={formId}
        onClick={() => (editing ? close() : open())}
        className="mt-2 min-h-11 rounded border px-3 text-xs"
      >
        Change approved tools
      </button>
      {editing ? (
        <form
          id={formId}
          className="mt-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        >
          <fieldset>
            <legend className="text-[var(--color-muted)]">
              Tools {surface.displayName} may call
            </legend>
            <ul className="mt-1 space-y-1">
              {options.map((tool) => (
                <li key={tool}>
                  <label className="inline-flex min-h-11 items-center gap-2 font-mono">
                    <input
                      type="checkbox"
                      checked={chosen.has(tool)}
                      disabled={busy}
                      onChange={(event) => {
                        const next = new Set(chosen);
                        if (event.target.checked) next.add(tool);
                        else next.delete(tool);
                        setChosen(next);
                      }}
                    />
                    {tool}
                    {keptBack.includes(tool) ? (
                      <span className="font-sans text-[var(--color-warn)]">withheld</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${formId}-add`}>Another tool, by its name</label>
            <input
              id={`${formId}-add`}
              value={typed}
              disabled={busy}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTyped();
                }
              }}
              className="min-h-11 min-w-0 flex-1 rounded border bg-transparent px-2 font-mono"
            />
            <button
              type="button"
              disabled={busy || typed.trim() === ''}
              onClick={addTyped}
              className="min-h-11 rounded border px-3 disabled:opacity-50"
            >
              Add
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy || chosen.size === 0}
              className="min-h-11 rounded border px-3 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save approved tools'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={close}
              className="min-h-11 rounded border px-3 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <StatusRegion outcome={outcome} />
    </div>
  );
}
