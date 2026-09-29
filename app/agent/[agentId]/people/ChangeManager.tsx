'use client';

import { useRef, useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import { useChange } from '../../../components/use-change';

/**
 * What changing the manager moves, and what it leaves, in the manager's words (U9's
 * `agents.setBossEmail`, Q6). The address is who the employee reports to and whom its chat
 * surface DMs; the dashboard stays with the account that owns the employee.
 *
 * @param name - The employee's name.
 * @param mode - The deployment's surface mode.
 * @param channel - Whether a chat surface has found the current manager's DM.
 * @returns One line per consequence, in the order they happen.
 */
export function managerChangeLines(
  name: string,
  mode: 'mock' | 'real',
  channel: boolean,
): string[] {
  const record = `The record gains a manager change; decisions already made stay in it as they were.`;
  const dashboard = `This page stays with your account: the address is who ${name} reports to, not who signs in.`;
  if (mode === 'mock') {
    return [
      `In the hosted office the address is a name on the record: nothing is sent to it.`,
      record,
      dashboard,
    ];
  }
  return [
    channel
      ? `The chat surface looks the new manager up at once; once it finds them, decision requests and the DMs about finished work go to their DM, and the decision requests still open are sent to it again.`
      : `Once a chat surface is connected, it looks the new manager up and sends decision requests to their DM.`,
    record,
    dashboard,
  ];
}

/**
 * Change who the employee reports to, from the People tab: a button that opens a dialog with the
 * new address and what the change moves (Q6), saved through `agents.setBossEmail`. A refusal is
 * said inside the dialog and leaves it open; a change that lands closes it and is said beside the
 * button, where focus returns.
 *
 * @param agent - The employee.
 * @param mode - The deployment's surface mode.
 * @param channel - Whether a chat surface has found the current manager's DM.
 */
export function ChangeManager({
  agent,
  mode,
  channel,
}: {
  agent: Doc<'agents'>;
  mode: 'mock' | 'real';
  channel: boolean;
}) {
  const setBossEmail = useMutation(api.agents.setBossEmail);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(agent.bossEmail);
  const opener = useRef<HTMLButtonElement>(null);
  const change = useChange(opener);
  // Closing without a change leaves nothing said: a refusal inside the dialog is not repeated
  // beside the button once the manager has cancelled.
  const cancel = (): void => {
    change.clear();
    setOpen(false);
  };

  return (
    <div className="grid justify-items-start gap-2">
      <Button
        ref={opener}
        size="small"
        aria-haspopup="dialog"
        onClick={() => {
          setDraft(agent.bossEmail);
          change.clear();
          setOpen(true);
        }}
      >
        Change manager
      </Button>
      <StatusRegion outcome={open ? null : change.outcome} />
      {open ? (
        <Dialog title="Change manager" onClose={cancel} busy={change.busy}>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const next = draft.trim();
              change.run(() => setBossEmail({ agentId: agent._id, bossEmail: next }), {
                done: (result) =>
                  result.changed
                    ? `${agent.name} now reports to ${next}.`
                    : `${agent.name} already reports to ${next}.`,
                refused: 'The manager was not changed.',
                after: () => setOpen(false),
              });
            }}
          >
            <Field label="The new manager's email address" hint="As their chat account knows it.">
              {(control) => (
                <input
                  {...control}
                  type="email"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  value={draft}
                  disabled={change.busy}
                  onChange={(event) => setDraft(event.target.value)}
                  className={`${INPUT_CLASS} w-full`}
                />
              )}
            </Field>
            <div className="grid gap-2">
              <h3 className="text-[13px] font-medium text-[var(--color-fg-2)]">What moves</h3>
              <ul className="grid list-disc gap-1.5 pl-5 text-[15px] text-[var(--color-fg-2)]">
                {managerChangeLines(agent.name, mode, channel).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <StatusRegion outcome={change.outcome} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="large" disabled={change.busy} onClick={cancel}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="large" disabled={change.busy}>
                {change.busy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}
