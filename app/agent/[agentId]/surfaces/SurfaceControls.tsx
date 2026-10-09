'use client';

import type { Doc } from '@convex/_generated/dataModel';
import { useState, useRef } from 'react';
import { Button } from '../../../components/Button';
import { INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import { type ChangeOutcome, refusalText } from '../../../components/use-change';

/**
 * What an employee's own Slack app calls whatever the approved list says (D-3, as ruled; W13-R15):
 * the manager's DM and the edit of Day0's own request (wording draft).
 */
export const OWN_APP_CHANNEL_NOTE =
  "Whatever this list says, this employee's own app can always message you and edit its own requests for your approval.";

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
  ownSlackApp = false,
  onApprove,
}: {
  surface: ToolsSurface;
  /** A Slack card on the employee's own app, whose manager channel is Day0's (D-3, W13-R15). */
  ownSlackApp?: boolean;
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
    <div className="grid gap-2 text-sm">
      <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
        <p className="text-[13px] text-[var(--color-muted)]">May call</p>
        {calls.length > 0 ? (
          <p className="font-mono text-[13px] break-words text-[var(--color-fg-2)]">
            {calls.join(', ')}
          </p>
        ) : (
          <p className="text-sm text-[var(--color-fg-2)]">
            No tool the provider offers is approved.
          </p>
        )}
      </div>
      {notOffered.length > 0 ? (
        <p className="text-[13px] text-[var(--color-muted)]">
          Approved, not offered by the provider at the last check: {notOffered.join(', ')}
        </p>
      ) : null}
      {ownSlackApp ? (
        <p className="text-[13px] text-[var(--color-muted)]">{OWN_APP_CHANNEL_NOTE}</p>
      ) : null}
      {keptBack.length > 0 ? (
        <p className="text-[var(--color-warn)]">
          Withheld, outside your approval: {keptBack.join(', ')}. Approve them here to let the
          employee call them.
        </p>
      ) : null}
      <div>
        <Button
          ref={toggle}
          size="small"
          aria-expanded={editing}
          aria-controls={formId}
          onClick={() => (editing ? close() : open())}
        >
          Change approved tools
        </Button>
      </div>
      {editing ? (
        <form
          id={formId}
          className="grid gap-3"
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
            <legend className="text-[13px] font-medium text-[var(--color-fg-2)]">
              Tools {surface.displayName} may call
            </legend>
            <ul className="mt-1 grid gap-0.5">
              {options.map((tool) => (
                <li key={tool}>
                  <label className="inline-flex min-h-11 items-center gap-2.5 font-mono text-[13px]">
                    <input
                      type="checkbox"
                      className="size-[18px] accent-[var(--color-accent)]"
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
          <div className="grid gap-1.5">
            <label
              htmlFor={`${formId}-add`}
              className="text-[13px] font-medium text-[var(--color-fg-2)]"
            >
              Another tool, by its name
            </label>
            <div className="flex flex-wrap gap-2">
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
                className={`${INPUT_CLASS} flex-1 font-mono`}
              />
              <Button size="small" disabled={busy || typed.trim() === ''} onClick={addTyped}>
                Add
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="small"
              variant="primary"
              disabled={busy || chosen.size === 0}
            >
              {busy ? 'Saving…' : 'Save approved tools'}
            </Button>
            <Button size="small" variant="quiet" disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <StatusRegion outcome={outcome} />
    </div>
  );
}
