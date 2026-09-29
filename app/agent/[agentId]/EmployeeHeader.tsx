'use client';

import { useState, useRef, useMemo } from 'react';
import { useChange } from '../../components/use-change';
import { StatusRegion } from '../../components/StatusRegion';
import { isTimeZone, agentZone } from '@/lib/zone';
import type { Doc } from '@convex/_generated/dataModel';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { SUPERVISED_LABEL, autonomousActionsOn } from '@/work/autonomy';
import { NotificationModeControl } from './manage/NotificationModeControl';
import { managerNotificationMode } from '@/work/manager-notes';
import { AutonomyControl } from './manage/AutonomyControl';

/**
 * Who the agent reports to, and the control that changes it (Q6).
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
          <label className="text-2xl font-semibold tracking-tight" htmlFor="manager-email">
            Employee reporting to
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
            className="min-h-11 min-w-0 font-mono text-sm px-2 rounded border border-[var(--color-border)] bg-transparent"
          />
          <button
            type="submit"
            disabled={change.busy || draft.trim() === ''}
            className="min-h-11 text-xs px-3 rounded bg-[var(--color-accent)] text-[var(--color-bg)] disabled:opacity-50"
          >
            {change.busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={change.busy}
            onClick={() => {
              setDraft(bossEmail);
              change.clear();
              close();
            }}
            className="min-h-11 text-xs px-3 rounded border border-[var(--color-border)]"
          >
            Cancel
          </button>
        </form>
      ) : (
        <h1 className="text-2xl font-semibold tracking-tight">
          Employee reporting to{' '}
          <span className="font-mono break-all text-[var(--color-accent)]">{bossEmail}</span>{' '}
          <button
            ref={toggle}
            type="button"
            onClick={() => {
              setDraft(bossEmail);
              change.clear();
              setEditing(true);
            }}
            className="min-h-11 align-middle text-xs font-normal px-3 rounded border border-[var(--color-border)] text-[var(--color-muted)]"
          >
            Change manager
          </button>
        </h1>
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
    <div className="mt-1 text-xs text-[var(--color-muted)]">
      <p className="flex flex-wrap items-center gap-x-2">
        <span>
          Times on this page are in <span className="text-[var(--color-fg)]">{zone}</span>, the
          employee&apos;s day.
        </span>
        <button
          ref={toggle}
          type="button"
          aria-expanded={editing}
          aria-controls="zone-editor"
          onClick={() => {
            setDraft(zone);
            change.clear();
            setEditing(!editing);
          }}
          className="min-h-11 px-2 rounded border border-[var(--color-border)] text-[var(--color-fg)] hover:border-[var(--color-accent)]"
        >
          Change zone
        </button>
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
            className="min-h-11 min-w-0 flex-1 font-mono px-2 rounded border border-[var(--color-border)] bg-transparent text-[var(--color-fg)]"
          />
          <datalist id="agent-zone-options">
            {zones.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
          <button
            type="submit"
            disabled={busy || !valid || draft.trim() === zone}
            className="min-h-11 px-3 rounded bg-[var(--color-accent)] text-[var(--color-bg)] font-medium disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={close}
            className="min-h-11 px-3 rounded border border-[var(--color-border)] text-[var(--color-fg)]"
          >
            Cancel
          </button>
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

/** The page header: the employee's name, state, zone, autonomy switch and manager channel control. */
export function DashboardHeader({
  agent,
  charter,
  managerLookupFailure,
  managerChannel = false,
}: {
  agent: Doc<'agents'>;
  /** What the page is showing, which outranks the row when the two disagree. */
  charter: Doc<'charters'> | null;
  /** A chat surface's failure reason when its probe could not find the manager. */
  managerLookupFailure?: string;
  /** Whether a chat surface has found the manager's DM; the DM setting waits for one (N7). */
  managerChannel?: boolean;
}) {
  const surfaceConfig = useQuery(api.config.surfaceMode);
  const setBossEmail = useMutation(api.agents.setBossEmail);
  const setAutonomousActions = useMutation(api.agents.setAutonomousActions);
  const setManagerNotifications = useMutation(api.agents.setManagerNotifications);
  const setZone = useMutation(api.agents.setZone);
  const stateLabel: Record<Doc<'agents'>['state'], { text: string; tone: string }> = {
    deployed: {
      text: 'Deployed · awaiting Day-1 1:1',
      tone: 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]',
    },
    'day-one-in-progress': {
      text: 'Day-1 1:1 in progress',
      tone: 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]',
    },
    'charter-pending': {
      text: 'Charter drafted · awaiting boss approval',
      tone: 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]',
    },
    active: {
      text: `Active · ${SUPERVISED_LABEL}`,
      tone: 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]',
    },
  };
  // A charter on the page is the more recent fact: a pill reading "Day-1 1:1
  // in progress" above a drafted charter is wrong however the row got there.
  const displayState: Doc<'agents'>['state'] = charter
    ? charter.approved
      ? 'active'
      : 'charter-pending'
    : agent.state;
  const s = stateLabel[displayState];
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-accent)] mb-1">Day0</p>
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="px-2 py-1 rounded-full border border-[var(--color-border)] text-[10px]">
            {surfaceConfig?.label || 'loading'}
          </span>
          {/* In real mode the chip is the manager's autonomous-actions
              switch; the hosted mock has no gate for the switch to change, so
              it keeps the static label. */}
          {displayState === 'active' && surfaceConfig?.mode === 'real' && managerChannel ? (
            <NotificationModeControl
              mode={managerNotificationMode(agent)}
              onChange={(mode) => setManagerNotifications({ agentId: agent._id, mode })}
            />
          ) : null}
          {displayState === 'active' && surfaceConfig?.mode === 'real' ? (
            <AutonomyControl
              on={autonomousActionsOn(agent)}
              tone={s.tone}
              onChange={(on) => setAutonomousActions({ agentId: agent._id, on })}
            />
          ) : (
            <span className={`px-3 py-1 rounded-full text-xs font-medium ${s.tone}`}>{s.text}</span>
          )}
        </div>
      </div>
    </header>
  );
}
