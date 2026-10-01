'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import type { ManagerStanding } from '@/agent/manager-standing';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import type { DeploymentProfile } from '@/lib/surface-mode';
import { deploymentZone } from '@/lib/zone';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Chip } from '../../../components/Chip';
import { Columns } from '../../../components/Columns';
import { StatusRegion } from '../../../components/StatusRegion';
import { useChange } from '../../../components/use-change';
import {
  acceptingCardLine,
  askedCardLine,
  CANCEL_THE_HANDOVER,
  CHANGE_THE_ADDRESS,
  endedCardLine,
  HAND_OVER,
  handOverToLabel,
  LOCAL_DEV_HANDOVER_LINE,
  MANAGER_DUTY,
  otherStandingLine,
  type HandoverDeparture,
  type OpenHandover,
} from '../../../handover-words';
import { useEmployee } from '../employee-context';
import { addressWithBreaks } from '../EmployeeHeader';
import { EmployeeRail } from '../EmployeeRail';
import { clockTime, useAgentZone } from '../../../components/time';
import { CancelHandoverDialog, HandOverDialog, MakeItYou } from './HandOver';

/** How the employee reaches a person the charter names, as the one-to-one settled it. */
export type IntroPath = 'manager' | 'self' | 'tbd';

/** A person the charter names, as the People tab reads the charter's body. */
export interface NamedPerson {
  readonly name: string;
  readonly topic: string;
  /** Absent on a charter drafted before the one-to-one asked how to reach each person. */
  readonly introPath?: IntroPath;
}

/** How the employee reaches each person, in the manager's words. */
const INTRO_WORDS: Readonly<Record<IntroPath, string>> = {
  manager: 'you introduce them',
  self: 'reaches out directly',
  tbd: 'how to reach them is not settled',
};

/**
 * Whether a stored value is one of the introduction paths.
 *
 * @param value - What the charter row holds.
 */
function isIntroPath(value: unknown): value is IntroPath {
  return value === 'manager' || value === 'self' || value === 'tbd';
}

/**
 * The people a charter names, read defensively: a charter drafted before the list existed, or a
 * row missing a field, names nobody rather than breaking the tab.
 *
 * @param body - The charter's stored body.
 */
export function namedPeople(body: unknown): NamedPerson[] {
  if (typeof body !== 'object' || body === null) return [];
  const listed: unknown = (body as { namedCollaborators?: unknown }).namedCollaborators;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry: unknown): NamedPerson[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, topic, introPath } = entry as {
      name?: unknown;
      topic?: unknown;
      introPath?: unknown;
    };
    if (typeof name !== 'string' || name.trim() === '') return [];
    return [
      {
        name,
        topic: typeof topic === 'string' ? topic : '',
        ...(isIntroPath(introPath) ? { introPath } : {}),
      },
    ];
  });
}

/**
 * Where the charter's people stand, for the line under each: the charter version that names them
 * and whether the manager approved it. The one-to-one names them first and an amendment can add
 * one; the row does not say which, so the line does not either.
 *
 * @param charter - The charter the tab reads.
 * @param zone - The employee's zone, for the approval's date.
 */
export function provenanceLine(charter: Doc<'charters'>, zone: string | undefined): string {
  const version = `charter version ${charter.version}`;
  if (!charter.approved) return `Named in ${version}, not approved yet.`;
  return charter.approvedAt === undefined
    ? `Named in ${version}, approved by you.`
    : `Named in ${version}, approved by you ${clockTime(charter.approvedAt, zone)}.`;
}

/**
 * The People tab (round two section 3.9, `agent-people.html`), as far as the product records
 * people: the manager, with the handover to another manager (the transfer plan, section 7.1)
 * and the flag on an address that is not the owner's (section 11.2), and the people the
 * charter names from the one-to-one with where each came from and how the employee reaches them.
 * The proposals the drawing confirms from a card (from the team pages and the one-to-one, matched
 * to a chat account) wait on the people records (A1); the tab says so rather than drawing
 * controls that do nothing.
 */
export function PeopleView() {
  const { agent, charter, surfaceMode, arriving } = useEmployee();
  const zone = useAgentZone();
  const named = namedPeople(charter?.body);
  return (
    <Columns
      arriving={arriving}
      aside={
        <>
          <Card title={`What ${agent.name} reads from this`}>
            <p className="text-sm text-[var(--color-fg-2)]">
              Each name, what they are the person for and how to reach them, under Key relationships
              in the identity file {agent.name} works from, rewritten whenever the charter changes.
              No account or credential of theirs.
            </p>
          </Card>
          <EmployeeRail />
        </>
      }
    >
      <ManagerCard agent={agent} surfaceMode={surfaceMode} />
      <Card title="Named in the charter" meta={named.length > 0 ? `${named.length}` : undefined}>
        {named.length === 0 || charter === null ? (
          <p className="text-sm text-[var(--color-muted)]">
            The charter names nobody yet. The Day-1 one-to-one asks who {agent.name} works with.
          </p>
        ) : (
          <ul className="grid gap-4">
            {named.map((person, index) => (
              // Two people can share a name; their place in the charter tells them apart.
              <li key={`${index}-${person.name}`} className="grid gap-0.5">
                <p className="text-[15px] text-[var(--color-fg-2)]">
                  <span className="font-semibold text-[var(--color-fg)]">{person.name}</span>
                  {person.topic ? ` · ${person.topic}` : null}
                  {person.introPath ? ` · ${INTRO_WORDS[person.introPath]}` : null}
                </p>
                <p className="text-[13px] text-[var(--color-muted)]">
                  {provenanceLine(charter, zone)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Proposed">
        <p className="text-sm text-[var(--color-fg-2)]">
          {agent.name} does not propose people for you to confirm yet. The names above are the ones
          your one-to-one gave the charter; to add or remove one, amend the charter.
        </p>
      </Card>
    </Columns>
  );
}

/** A request that ended unaccepted, as the card reads it from `managerTransfers.departures`. */
export type EndedHandover = HandoverDeparture & { readonly state: 'declined' | 'expired' };

/**
 * What the Manager card shows (the transfer plan, sections 7.1 and 11.2), by the request open on
 * the employee first, then the employee's standing; a request that ended unaccepted rides along
 * with the standing until another is asked.
 */
export type ManagerCardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'asked'; readonly open: OpenHandover }
  | { readonly kind: 'accepting'; readonly open: OpenHandover }
  | {
      readonly kind: 'standing';
      readonly standing: ManagerStanding;
      readonly ended: EndedHandover | undefined;
    };

/**
 * The newest request for this employee among the old manager's, when it ended unaccepted: a
 * request accepted since (the employee handed back) ends the line.
 *
 * @param departures - The manager's finished requests, newest answer first.
 * @param agentId - The employee.
 */
export function lastEndedHandover(
  departures: readonly HandoverDeparture[] | undefined,
  agentId: Doc<'agents'>['_id'],
): EndedHandover | undefined {
  const newest = departures?.find((departure) => departure.agentId === agentId);
  if (newest === undefined || newest.state === 'accepted') return undefined;
  return { ...newest, state: newest.state };
}

/**
 * The Manager card's state from what it reads, each undefined while it loads.
 *
 * @param open - The request open on the employee, or null.
 * @param standing - The employee's standing against the owner's address.
 * @param ended - The newest request that ended unaccepted.
 */
export function managerCardState(
  open: OpenHandover | null | undefined,
  standing: ManagerStanding | undefined,
  ended: EndedHandover | undefined,
): ManagerCardState {
  if (open === undefined || standing === undefined) return { kind: 'loading' };
  if (open !== null) return { kind: open.state, open };
  return { kind: 'standing', standing, ended };
}

/**
 * How many of the employee's runs are in flight: items executing, and items whose held actions
 * were approved and whose apply is scheduled or running, as the move counts them before it
 * settles (the transfer plan, section 6.4).
 *
 * @param items - The employee's work items.
 */
export function runsInFlightOf(
  items: readonly Pick<Doc<'workItems'>, 'state' | 'approvedIndexes'>[],
): number {
  return items.filter(
    (item) =>
      item.state === 'executing' ||
      (item.state === 'actions-pending' && item.approvedIndexes !== undefined),
  ).length;
}

/**
 * Whether this browser signs in as the one manager of an installation that has no other: the
 * local sign-in under the `local-dev` profile, as `managerTransfers.ask` refuses it. The hosted
 * demo leaves the profile unset, but signs in through Clerk.
 *
 * @param profile - The deployment's profile, undefined while it loads.
 */
export function signedInAsTheOneManager(profile: DeploymentProfile | undefined): boolean {
  return DEV_NO_AUTH && profile === 'local-dev';
}

/** Which of the card's dialogs is open. */
type CardDialog =
  | { readonly kind: 'hand-over'; readonly address?: string }
  | { readonly kind: 'change'; readonly open: OpenHandover }
  | { readonly kind: 'cancel'; readonly open: OpenHandover };

/** What the Manager card is drawn from. */
interface ManagerCardProps {
  readonly agent: Doc<'agents'>;
  readonly surfaceMode: 'mock' | 'real' | undefined;
}

/**
 * The Manager card (plan 7.1 and section 11.2): the address the employee reports to, what being
 * its manager means, and the handover in every state: none open (**Hand over**), asked (**Change
 * the address**, **Cancel the handover**), accepting (no control), and the newest request that
 * ended unaccepted; and the flag on an address that is not the owner's (**Hand over to {address}**,
 * **Make it you**). Every change is said in the card's one status region and focus comes to the
 * card, since the control that made it leaves with the state it changed.
 */
function ManagerCard({ agent, surfaceMode }: ManagerCardProps) {
  const open = useQuery(api.managerTransfers.openForAgent, { agentId: agent._id });
  const standing = useQuery(api.agents.managerStanding, { agentId: agent._id });
  const departures = useQuery(api.managerTransfers.departures, {});
  const config = useQuery(api.config.surfaceMode);
  const accepting = open?.state === 'accepting';
  const work = useQuery(api.work.listForAgent, accepting ? { agentId: agent._id } : 'skip');
  const [dialog, setDialog] = useState<CardDialog | null>(null);
  const card = useRef<HTMLElement>(null);
  const flagId = useId();
  const change = useChange(card);
  const landed = (): HTMLElement | null => card.current;
  const zone = deploymentZone();
  const state = managerCardState(open, standing, lastEndedHandover(departures, agent._id));
  const oneManager = signedInAsTheOneManager(config?.deploymentProfile);
  // A decline or an expiry is the named manager's doing, or the clock's: said once, when the
  // request that was open comes back ended. The ended request may arrive a read after the open
  // one goes, so the card waits for it by id.
  const openId = state.kind === 'asked' ? state.open.transferId : null;
  const [watched, setWatched] = useState<string | null | undefined>(
    state.kind === 'loading' ? undefined : openId,
  );
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const [heard, setHeard] = useState('');
  if (state.kind !== 'loading' && openId !== watched) {
    setAwaiting(watched ?? null);
    setWatched(openId);
  }
  if (awaiting !== null && state.kind === 'standing' && state.ended?.transferId === awaiting) {
    setHeard(endedCardLine(state.ended, zone));
    setAwaiting(null);
  }
  const closeDialog = (): void => {
    // A refusal said inside the dialog is not said again on the card once it is closed (m38).
    if (change.outcome?.tone === 'refused') change.clear();
    setDialog(null);
  };
  const openDialog = (next: CardDialog): void => {
    change.clear();
    setDialog(next);
  };
  // The dialog's account of what happens depends on the mode, so it waits for it.
  const handOver = (address?: string, label = HAND_OVER): ReactNode =>
    oneManager || surfaceMode === undefined ? null : (
      <Button
        size="small"
        aria-haspopup="dialog"
        disabled={change.busy}
        onClick={() => openDialog({ kind: 'hand-over', address })}
        // A label that carries an address wraps anywhere rather than run out of the card.
        className="!whitespace-normal text-left [overflow-wrap:anywhere]"
      >
        {label}
      </Button>
    );

  const lines: string[] = [];
  let controls: ReactNode = null;
  switch (state.kind) {
    case 'loading':
      lines.push(MANAGER_DUTY);
      break;
    case 'asked':
      lines.push(
        askedCardLine({
          name: agent.name,
          to: state.open.toAddress,
          requestedAt: state.open.requestedAt,
          expiresAt: state.open.expiresAt,
          zone,
        }),
      );
      controls = (
        <>
          {surfaceMode === undefined ? null : (
            <Button
              size="small"
              aria-haspopup="dialog"
              disabled={change.busy}
              onClick={() => openDialog({ kind: 'change', open: state.open })}
            >
              {CHANGE_THE_ADDRESS}
            </Button>
          )}
          <Button
            size="small"
            variant="quiet"
            aria-haspopup="dialog"
            disabled={change.busy}
            onClick={() => openDialog({ kind: 'cancel', open: state.open })}
          >
            {CANCEL_THE_HANDOVER}
          </Button>
        </>
      );
      break;
    case 'accepting':
      lines.push(
        acceptingCardLine({
          name: agent.name,
          to: state.open.toAddress,
          runs: work === undefined ? undefined : runsInFlightOf(work),
          settleBy: state.open.settleBy,
          zone,
        }),
      );
      break;
    case 'standing': {
      if (state.standing.standing === 'other') {
        lines.push(otherStandingLine(agent.name, state.standing.bossEmail));
        controls = (
          <>
            {handOver(state.standing.bossEmail, handOverToLabel(state.standing.bossEmail))}
            <MakeItYou agent={agent} change={change} landed={landed} describedBy={flagId} />
          </>
        );
      } else {
        lines.push(MANAGER_DUTY);
        controls = handOver();
      }
      if (state.ended !== undefined) lines.push(endedCardLine(state.ended, zone));
      if (oneManager) lines.push(LOCAL_DEV_HANDOVER_LINE);
      break;
    }
    default: {
      const unknown: never = state;
      throw new Error(`unhandled manager card state ${String(unknown)}`);
    }
  }

  const flagged = state.kind === 'standing' && state.standing.standing === 'other';
  return (
    <Card title="Manager" focusRef={card} tone={flagged ? 'warn' : undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="flex flex-wrap items-center gap-2 text-[15px]">
            <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
              {addressWithBreaks(agent.bossEmail)}
            </span>
            {standing?.standing === 'you' ? <Chip tone="you">you</Chip> : null}
            <Chip tone="muted">manager</Chip>
          </p>
          {lines.map((line, index) => (
            <p
              key={line}
              // The flag is the first line, and what Make it you answers.
              id={flagged && index === 0 ? flagId : undefined}
              className="text-sm whitespace-pre-line text-[var(--color-fg-2)] [overflow-wrap:anywhere]"
            >
              {line}
            </p>
          ))}
        </div>
        {controls === null ? null : <div className="flex flex-wrap gap-2">{controls}</div>}
      </div>
      <StatusRegion outcome={dialog === null ? change.outcome : null} />
      <p role="status" aria-live="polite" className="sr-only">
        {heard}
      </p>
      {dialog?.kind === 'hand-over' && surfaceMode !== undefined ? (
        <HandOverDialog
          agent={agent}
          mode={surfaceMode}
          address={dialog.address}
          change={change}
          landed={landed}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === 'change' && surfaceMode !== undefined ? (
        <HandOverDialog
          agent={agent}
          mode={surfaceMode}
          changing={{
            transferId: dialog.open.transferId,
            toAddress: dialog.open.toAddress,
            ...(dialog.open.note === undefined ? {} : { note: dialog.open.note }),
          }}
          change={change}
          landed={landed}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === 'cancel' ? (
        <CancelHandoverDialog
          transferId={dialog.open.transferId}
          toAddress={dialog.open.toAddress}
          change={change}
          landed={landed}
          onClose={closeDialog}
        />
      ) : null}
    </Card>
  );
}
