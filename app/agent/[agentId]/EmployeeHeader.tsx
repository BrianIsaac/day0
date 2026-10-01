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
import type { ManagerStanding } from '@/agent/manager-standing';
import { Button, ButtonLink } from '../../components/Button';
import {
  CHOOSE_ON_PEOPLE,
  HANDING_OVER_TO,
  managerLookupFailureLine,
  REPORTS_TO_YOU,
  THEN,
  untilRunsFinish,
  WHO_IS_NOT_YOU,
  type OpenHandover,
} from '../../handover-words';
import { employeeTabHref } from './employee-tabs';
import { INPUT_CLASS } from '../../components/Field';
import { Pill } from '../../components/Pill';
import { AgentPixelAvatar } from '../../home/PixelAvatar';

/**
 * An email address with the places a reader would split it marked as break opportunities: after
 * a `+` and before the `@`. A narrow header then wraps it there, and only an address with no such
 * place wider than the line breaks mid-word (the hosted walk's m32: "clerk" / "_test@...").
 */
export function addressWithBreaks(address: string): ReactNode[] {
  return address
    .split(/(?<=\+)|(?=@)/)
    .flatMap((part, index) => (index === 0 ? [part] : [<wbr key={index} />, part]));
}

/** What the line naming the employee's manager shows. */
export interface ManagerLineProps {
  readonly agent: Pick<Doc<'agents'>, '_id' | 'name' | 'bossEmail'>;
  /** The employee's standing against the owner's address, undefined while it is read. */
  readonly standing: ManagerStanding | undefined;
  /** The handover open on the employee, null when none is, undefined while it is read. */
  readonly open: OpenHandover | null | undefined;
  /** The stored reason of a chat surface whose probe could not find the manager. */
  readonly lookupFailure?: string;
}

/**
 * Who the employee reports to, on the line under its name (the transfer plan, section 7.2):
 * "Reports to you", with an asked handover as a link to People, an accepting one as who it goes
 * to once the runs finish, and an address that is not the owner's flagged with a link to People
 * to choose (section 11.2). The line has no control: a handover is a dialog with an account of
 * what happens, and People holds the only one (D14). Until the standing is read the line names
 * the address it stores. When a chat surface failed on looking the manager up the line says so,
 * because the card beside it would otherwise blame the credential.
 */
export function ManagerLine({ agent, standing, open, lookupFailure }: ManagerLineProps) {
  const people = employeeTabHref(agent._id, 'people');
  const mono = (address: string): ReactNode => (
    <span className="font-mono text-[var(--color-fg)] [overflow-wrap:anywhere]">
      {addressWithBreaks(address)}
    </span>
  );
  const lead =
    standing?.standing === 'you' ? REPORTS_TO_YOU : <>Reports to {mono(agent.bossEmail)}</>;
  // A link here is a 44 px target, as the zone line's control below it is (N14).
  const toPeople = (label: ReactNode): ReactNode => (
    <ButtonLink
      href={people}
      variant="text"
      size="small"
      className="!whitespace-normal [overflow-wrap:anywhere]"
    >
      {label}
    </ButtonLink>
  );
  let line: ReactNode;
  if (open?.state === 'asked') {
    line = (
      <>
        <span className="min-w-0">{lead} · </span>
        {toPeople(
          <span>
            {HANDING_OVER_TO} {mono(open.toAddress)}
          </span>,
        )}
      </>
    );
  } else if (open?.state === 'accepting') {
    line = (
      <span className="min-w-0">
        {lead}
        {untilRunsFinish(agent.name)} · {THEN} {mono(open.toAddress)}
      </span>
    );
  } else if (standing?.standing === 'other') {
    line = (
      <>
        <span className="min-w-0">
          {lead}
          {WHO_IS_NOT_YOU} ·{' '}
        </span>
        {toPeople(CHOOSE_ON_PEOPLE)}
      </>
    );
  } else {
    line = <span className="min-w-0">{lead}</span>;
  }
  // The handover moving on is another manager's doing, whichever tab is open: said once, when the
  // named manager accepts.
  const accepting = open?.state === 'accepting' ? open.transferId : null;
  const [heard, setHeard] = useState<string | null | undefined>(
    open === undefined ? undefined : accepting,
  );
  const [announced, setAnnounced] = useState('');
  if (open !== undefined && accepting !== heard) {
    if (heard !== undefined && accepting !== null && open?.state === 'accepting') {
      setAnnounced(
        `${standing?.standing === 'you' ? REPORTS_TO_YOU : `Reports to ${agent.bossEmail}`}${untilRunsFinish(agent.name)}, then ${open.toAddress}.`,
      );
    }
    setHeard(accepting);
  }
  return (
    <div>
      <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-[var(--color-muted)]">
        {line}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {announced}
      </p>
      {lookupFailure ? (
        <p className="mt-1 text-xs text-[var(--color-warn)]">
          {managerLookupFailureLine(lookupFailure)}
        </p>
      ) : null}
    </div>
  );
}

/** The zones the browser knows, UTC first, for the zone field's suggestions. */
function knownZones(): string[] {
  const listed =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return ['UTC', ...listed.filter((zone) => zone !== 'UTC')];
}

/** What the line naming the employee's zone shows and changes. */
export interface ZoneLineProps {
  readonly zone: string;
  /** Store the zone; the server answers with the zone it stored, in its canonical spelling. */
  readonly onChange: (zone: string) => Promise<{ zone: string } | void>;
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
export function ZoneLine({ zone, onChange }: ZoneLineProps) {
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

/** What the employee page's header is drawn from. */
export interface EmployeeHeaderProps {
  readonly agent: Doc<'agents'>;
  readonly charter: Doc<'charters'> | null;
  readonly phase?: OneToOnePhase['kind'];
  readonly managerLookupFailure?: string;
  readonly stage?: ReactNode;
}

/**
 * The employee page's header (round two section 3.3): the employee's face and name as the page's
 * one h1, who it reports to and any handover under way (the transfer plan, section 7.2), the zone
 * every time on the page is in with
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
}: EmployeeHeaderProps) {
  const surfaceConfig = useQuery(api.config.surfaceMode);
  const open = useQuery(api.managerTransfers.openForAgent, { agentId: agent._id });
  const standing = useQuery(api.agents.managerStanding, { agentId: agent._id });
  const setZone = useMutation(api.agents.setZone);
  const shown = shownEmployeeState(agent.state, charter);
  const status = employeeStateLabel(shown, autonomousActionsOn(agent), phase);
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3.5">
        <AgentPixelAvatar
          avatar={avatarById(agent.avatarId)}
          state={shown}
          phase={phase}
          label={agent.name}
        />
        <div className="min-w-0">
          {/* Focus comes here when a modal closes and what opened it has left the page. */}
          <h1
            tabIndex={-1}
            className="text-2xl font-semibold tracking-[-0.02em] break-words outline-none"
          >
            {agent.name}
          </h1>
          <ManagerLine
            agent={agent}
            standing={standing}
            open={open}
            lookupFailure={managerLookupFailure}
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
