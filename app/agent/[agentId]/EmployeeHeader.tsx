'use client';

import { useState, useRef, useMemo, type ReactNode } from 'react';
import { useChange } from '../../components/use-change';
import { StatusRegion } from '../../components/StatusRegion';
import { isTimeZone, agentZone } from '@/lib/zone';
import type { Doc } from '@convex/_generated/dataModel';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { autonomousActionsOn } from '@/work/autonomy';
import { employeeStateLabel, shownEmployeeState } from '@/work/state-labels';
import { avatarById } from '@/agent/avatar-pets';
import type { OneToOnePhase } from '@/agent/one-to-one-phase';
import { Button } from '../../components/Button';
import { INPUT_CLASS } from '../../components/Field';
import { Pill } from '../../components/Pill';
import { AgentPixelAvatar } from '../../home/PixelAvatar';

/**
 * Who the employee reports to, and the control that changes it (Q6), on the line under the
 * employee's name.
 *
 * The address is the one the chat surface looks up to find the manager's DM,
 * so a manager who left, or whose account Slack no longer finds, is replaced
 * here rather than by a reset. When a chat surface failed on that lookup the
 * line says so, because the card beside it would otherwise blame the credential.
 */
export function ManagerLine({
  bossEmail,
  lookupFailure,
  onChange,
}: {
  bossEmail: string;
  /** The stored reason of a chat surface whose probe could not find the manager. */
  lookupFailure?: string;
  onChange: (bossEmail: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bossEmail);
  const toggle = useRef<HTMLButtonElement>(null);
  const change = useChange(toggle);
  const close = (): void => {
    setEditing(false);
    toggle.current?.focus();
  };
  const save = (): void => {
    const next = draft.trim();
    change.run(() => onChange(next), {
      done: `The employee now reports to ${next}.`,
      refused: 'The manager was not changed.',
      after: () => setEditing(false),
    });
  };
  return (
    <div>
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className="text-sm text-[var(--color-muted)]" htmlFor="manager-email">
            Reports to
          </label>
          <input
            id="manager-email"
            type="email"
            autoFocus
            value={draft}
            disabled={change.busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setDraft(bossEmail);
                close();
              }
            }}
            className={`${INPUT_CLASS} flex-1 font-mono sm:max-w-80`}
          />
          <Button
            type="submit"
            variant="primary"
            size="small"
            disabled={change.busy || draft.trim() === ''}
          >
            {change.busy ? 'Saving…' : 'Save'}
          </Button>
          <Button
            size="small"
            disabled={change.busy}
            onClick={() => {
              setDraft(bossEmail);
              change.clear();
              close();
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-[var(--color-muted)]">
          <span className="min-w-0">
            Reports to{' '}
            <span className="font-mono break-all text-[var(--color-fg)]">{bossEmail}</span>
          </span>
          <Button
            ref={toggle}
            variant="text"
            size="small"
            onClick={() => {
              setDraft(bossEmail);
              change.clear();
              setEditing(true);
            }}
          >
            Change manager
          </Button>
        </p>
      )}
      {editing ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Decisions waiting in the previous manager&apos;s DM are sent again to the new one once the
          chat surface finds them.
        </p>
      ) : null}
      {lookupFailure && !editing ? (
        <p className="mt-1 text-xs text-[var(--color-warn)]">
          The chat surface could not find this manager: {lookupFailure.replace(/\.$/, '')}. The
          credential still works; change the manager to someone the workspace knows.
        </p>
      ) : null}
      <StatusRegion outcome={change.outcome} />
    </div>
  );
}

/** The zones the browser knows, UTC first, for the zone field's suggestions. */
function knownZones(): string[] {
  const listed =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return ['UTC', ...listed.filter((zone) => zone !== 'UTC')];
}

/**
 * The employee's day (N12): the zone every time on this page is printed in,
 * and the control that changes it (`agents.setZone`).
 *
 * The line says the zone once so a stamp never needs its own; changing it
 * moves every stamp here and every day boundary the server draws (the daily
 * cap, the expiry notice, the digest's "since yesterday"). The outcome is
 * announced in the line's live region and focus returns to the control.
 */
export function ZoneLine({
  zone,
  onChange,
}: {
  zone: string;
  /** Store the zone; the server answers with the zone it stored, in its canonical spelling. */
  onChange: (zone: string) => Promise<{ zone: string } | void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(zone);
  const toggle = useRef<HTMLButtonElement>(null);
  const change = useChange(toggle);
  const busy = change.busy;
  const zones = useMemo((): string[] => knownZones(), []);
  const valid = isTimeZone(draft.trim());
  const close = (): void => {
    setEditing(false);
    toggle.current?.focus();
  };
  const save = (): void => {
    const next = draft.trim();
    change.run(() => onChange(next), {
      // The stored zone, not the typed one: the server settles the spelling (m10).
      done: (stored) =>
        `The employee's day is now ${stored?.zone ?? next}; every time on this page is in it.`,
      refused: 'The zone was not changed.',
      after: () => setEditing(false),
    });
  };
  return (
    <div className="text-sm text-[var(--color-muted)]">
      <p className="flex flex-wrap items-center gap-x-2">
        <span>
          Times on this page are in <span className="text-[var(--color-fg)]">{zone}</span>, the
          employee&apos;s day.
        </span>
        <Button
          ref={toggle}
          variant="text"
          size="small"
          aria-expanded={editing}
          aria-controls="zone-editor"
          onClick={() => {
            setDraft(zone);
            change.clear();
            setEditing(!editing);
          }}
        >
          Change zone
        </Button>
      </p>
      {editing ? (
        <form
          id="zone-editor"
          className="mt-1 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save();
          }}
        >
          <label htmlFor="agent-zone" className="text-[var(--color-fg)]">
            Zone
          </label>
          <input
            id="agent-zone"
            list="agent-zone-options"
            autoFocus
            value={draft}
            disabled={busy}
            aria-invalid={!valid}
            aria-describedby="agent-zone-hint"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
            className={`${INPUT_CLASS} flex-1 font-mono sm:max-w-80`}
          />
          <datalist id="agent-zone-options">
            {zones.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
          <Button
            type="submit"
            variant="primary"
            size="small"
            disabled={busy || !valid || draft.trim() === zone}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button size="small" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <p id="agent-zone-hint" className="basis-full">
            {valid
              ? 'A zone name such as Europe/London or Asia/Singapore.'
              : `${draft.trim() || 'An empty name'} is not a zone this browser knows; pick one from the list.`}
          </p>
        </form>
      ) : null}
      <StatusRegion outcome={change.outcome} />
    </div>
  );
}

/**
 * The employee page's header (round two section 3.3): the employee's face and name as the page's
 * one h1, who it reports to with Change manager (U9), the zone every time on the page is in with
 * its control (K), and beside them the office it works in and its state in the manager's words,
 * with the first week's stage under them once the employee is working. The autonomy switch and
 * the manager-DM setting are the Manage tab's.
 *
 * @param agent - The employee.
 * @param charter - What the page is showing, which outranks the row when the two disagree.
 * @param phase - Where the one-to-one stands (`oneToOnePhase`), so the pill says when a charter is being drafted.
 * @param managerLookupFailure - A chat surface's reason when its probe could not find the manager.
 * @param stage - The first week's card (`FirstWeekCard`), under the pills; none before the
 *   employee is working, when the whole rail runs under the header instead.
 */
export function EmployeeHeader({
  agent,
  charter,
  phase,
  managerLookupFailure,
  stage,
}: {
  agent: Doc<'agents'>;
  charter: Doc<'charters'> | null;
  phase?: OneToOnePhase['kind'];
  managerLookupFailure?: string;
  stage?: ReactNode;
}) {
  const surfaceConfig = useQuery(api.config.surfaceMode);
  const setBossEmail = useMutation(api.agents.setBossEmail);
  const setZone = useMutation(api.agents.setZone);
  const shown = shownEmployeeState(agent.state, charter);
  const status = employeeStateLabel(shown, autonomousActionsOn(agent), phase);
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3.5">
        <AgentPixelAvatar avatar={avatarById(agent.avatarId)} state={shown} label={agent.name} />
        <div className="min-w-0">
          {/* Focus comes here when a modal closes and what opened it has left the page. */}
          <h1
            tabIndex={-1}
            className="text-2xl font-semibold tracking-[-0.02em] break-words outline-none"
          >
            {agent.name}
          </h1>
          <ManagerLine
            bossEmail={agent.bossEmail}
            lookupFailure={managerLookupFailure}
            onChange={(bossEmail) => setBossEmail({ agentId: agent._id, bossEmail })}
          />
          <ZoneLine
            zone={agentZone(agent)}
            onChange={(zone) => setZone({ agentId: agent._id, zone })}
          />
        </div>
      </div>
      <div className="grid basis-full justify-items-start gap-2 sm:basis-auto sm:justify-items-end">
        <div className="flex flex-wrap items-center gap-2">
          {surfaceConfig ? (
            <Pill>{surfaceConfig.mode === 'mock' ? 'mock office' : surfaceConfig.label}</Pill>
          ) : null}
          <Pill tone={status.tone}>{status.text}</Pill>
        </div>
        {stage}
      </div>
    </header>
  );
}
