'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import type { Doc } from '@convex/_generated/dataModel';
import { avatarById } from '@/agent/avatar-pets';
import { useLightUpOnce } from './office-light-up';
import {
  desktopPlan,
  idlePlaces,
  phoneOfficeHeight,
  phonePlan,
  phoneRows,
  phoneSeat,
  type IdleFigure,
  type OfficePlan,
  type OfficePoint,
} from './office-places';
import { AgentPixelAvatar } from './PixelAvatar';
import type { RosterRow } from './types';

const OFFICE_ROOMS = [
  { left: 2, top: 4, width: 39, height: 31, tone: 'ops' },
  { left: 58, top: 4, width: 40, height: 31, tone: 'briefing' },
  { left: 2, top: 41, width: 31, height: 24, tone: 'archive' },
  { left: 64, top: 41, width: 34, height: 24, tone: 'studio' },
  { left: 2, top: 72, width: 31, height: 23, tone: 'lounge' },
  { left: 43, top: 70, width: 55, height: 25, tone: 'lab' },
] as const;

const OFFICE_CORRIDORS = [
  { left: 41, top: 4, width: 17, height: 91, axis: 'vertical' },
  { left: 33, top: 51, width: 31, height: 12, axis: 'horizontal' },
  { left: 33, top: 78, width: 10, height: 11, axis: 'horizontal' },
] as const;

const OFFICE_DECOR = [
  { kind: 'server', x: 8, y: 51 },
  { kind: 'server', x: 24, y: 51 },
  { kind: 'plant', x: 7, y: 88 },
  { kind: 'plant', x: 38, y: 74 },
  { kind: 'plant', x: 94, y: 36 },
  { kind: 'console', x: 52, y: 18 },
  { kind: 'console', x: 52, y: 83 },
  { kind: 'table', x: 77, y: 53 },
  { kind: 'table', x: 18, y: 84 },
] as const;

const OFFICE_SIGNALS = [
  { x: 49, y: 12, delay: 0 },
  { x: 49, y: 34, delay: 0.8 },
  { x: 39, y: 57, delay: 1.6 },
  { x: 58, y: 57, delay: 2.2 },
  { x: 49, y: 82, delay: 1.1 },
] as const;

/**
 * The desks, in the order employees take them: the employee at place n on the roster sits at desk
 * n when working. The first ten seats stand every two clear of each other by a figure's span
 * (`FIGURE_SPAN`), so ten employees at their desks never sit on each other (the wave 8 review's
 * A-M1: the seventh sat on the second, and the eighth on the fourth, the ninth and the tenth); of
 * the orders that do, this one leaves the idle figures most room, measured over every roster of
 * one to ten and every way of seating it. The first eight are always drawn and each employee past
 * them adds its own. Twenty seats cannot all stand clear, so from the eleventh on a desk may
 * share its room with one taken earlier. No seat stands lower than 86 percent, where a seated
 * figure, 140 px tall in an office 560 px tall, still clears the 8 px frame: the bottom rooms'
 * seats stood at 87 to 90 and cut their figures off, which only an eleventh employee met until
 * the first ten took two of them.
 */
const OFFICE_DESKS = [
  { x: 14, y: 17, seatX: 14, seatY: 25, variant: 'wide' },
  { x: 86, y: 17, seatX: 86, seatY: 25, variant: 'wide' },
  { x: 68, y: 31, seatX: 68, seatY: 37, variant: 'compact' },
  { x: 27, y: 50, seatX: 27, seatY: 58, variant: 'console' },
  { x: 90, y: 50, seatX: 90, seatY: 58, variant: 'compact' },
  { x: 67, y: 79, seatX: 67, seatY: 86, variant: 'wide' },
  { x: 55, y: 31, seatX: 51, seatY: 33, variant: 'console' },
  { x: 55, y: 65, seatX: 50, seatY: 63, variant: 'console' },
  { x: 13, y: 82, seatX: 13, seatY: 86, variant: 'compact' },
  { x: 93, y: 83, seatX: 89, seatY: 86, variant: 'console' },
  { x: 29, y: 17, seatX: 29, seatY: 25, variant: 'wide' },
  { x: 67, y: 17, seatX: 67, seatY: 25, variant: 'wide' },
  { x: 87, y: 31, seatX: 87, seatY: 37, variant: 'compact' },
  { x: 13, y: 50, seatX: 13, seatY: 58, variant: 'console' },
  { x: 73, y: 50, seatX: 73, seatY: 58, variant: 'compact' },
  { x: 53, y: 79, seatX: 53, seatY: 86, variant: 'wide' },
  { x: 83, y: 79, seatX: 83, seatY: 86, variant: 'wide' },
  { x: 28, y: 82, seatX: 28, seatY: 86, variant: 'compact' },
  { x: 15, y: 30, seatX: 15, seatY: 36, variant: 'compact' },
  { x: 30, y: 30, seatX: 30, seatY: 36, variant: 'compact' },
] as const;

/** How many desks the office draws for this many employees: eight at least, one each past them. */
function deskCountFor(employees: number): number {
  return Math.max(8, Math.min(OFFICE_DESKS.length, employees));
}

/** The desk the employee at this place on the roster sits at when working. */
function deskFor(index: number): number {
  return index % OFFICE_DESKS.length;
}

type OfficeStyle = CSSProperties & {
  '--walk-duration'?: string;
  /** The element's place in the light-up stagger. */
  '--i'?: number;
  /** Where the element stands at a desktop width, as a share of the office (`day0-office-at`). */
  '--x'?: number;
  '--y'?: number;
  /** Where it stands on a phone: a share of the office's inner width, and px down (`phonePlan`). */
  '--px'?: number;
  '--py'?: number;
  /** How tall the office is on a phone, for as many rows as its employees need. */
  '--phone-height'?: string;
};

/** Where an element of the office stands: at a desktop width, and on a phone. */
interface OfficePlace {
  readonly desktop: OfficePoint;
  readonly phone: OfficePoint;
}

/**
 * The element's place as the custom properties `.day0-office-at` reads (`app/globals.css`): an
 * inline style cannot follow a breakpoint, so both places are handed to the stylesheet, which
 * draws the desktop's and, below `sm`, the phone's.
 */
function placeStyle(place: OfficePlace): OfficeStyle {
  return {
    '--x': place.desktop.x,
    '--y': place.desktop.y,
    '--px': place.phone.x,
    '--py': place.phone.y,
  };
}

/**
 * The mini office world: the employees at their desks or roaming the rooms.
 *
 * @param agents - The roster, undefined while it loads.
 * @param settled - Whether everything above the office on the page has arrived, so its light-up
 *   can tell whether it opens on screen.
 */
export function OfficeWorld({
  agents,
  settled,
}: {
  agents: readonly RosterRow[] | undefined;
  settled: boolean;
}) {
  const visibleAgents = agents ?? [];
  const deskCount = deskCountFor(visibleAgents.length);
  const office = useRef<HTMLDivElement>(null);
  useLightUpOnce(office, settled);
  const layout = officeLayout(visibleAgents);
  const seating = seatingOf(visibleAgents, layout);
  const [roaming, setRoaming] = useState<Roaming>({ seating, places: {} });
  // Roaming places are only good for the seating they were chosen against: once the roster
  // changes, each idle employee opens again at once rather than a tick later (the second review's
  // x9, a stale tick that stood a figure on a seat just taken).
  const destinations = roaming.seating === seating ? roaming.places : NO_PLACES;
  // Where each idle employee opens, stable between renders; the roaming below moves them on.
  const opening = idleOffice(layout);
  const officeStyle: OfficeStyle = { '--phone-height': `${layout.phoneHeight}px` };

  useEffect(() => {
    const roster = officeLayout(agents ?? []);
    if (roster.idle.length === 0) return;
    const start = idleOffice(roster);
    const pick = (spots: readonly OfficePoint[]): OfficePoint =>
      spots[Math.floor(Math.random() * spots.length)] ?? spots[0];
    const timer = window.setInterval(() => {
      setRoaming((current) => {
        const kept = current.seating === seating ? current.places : NO_PLACES;
        const from = (agentId: string): OfficePlace | undefined => kept[agentId] ?? start[agentId];
        return {
          seating,
          places: placesById(
            idlePlaces(
              roster.idle.map((figure) => ({ ...figure, previous: from(figure.agentId)?.desktop })),
              roster.seated,
              pick,
              roster.desktop,
            ),
            idlePlaces(
              roster.idle.map((figure) => ({ ...figure, previous: from(figure.agentId)?.phone })),
              roster.phoneSeated,
              pick,
              roster.phone,
            ),
          ),
        };
      });
    }, 3400);
    return () => window.clearInterval(timer);
  }, [agents, seating]);

  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">Mini office world</h2>
        <span className="text-xs text-[var(--color-muted)]">{visibleAgents.length} total</span>
      </div>

      <div
        ref={office}
        className="day0-pixel-office relative min-h-[560px] overflow-hidden max-sm:min-h-(--phone-height)"
        style={officeStyle}
      >
        {OFFICE_ROOMS.map((room, index) => (
          <OfficeRoom key={`${room.left}-${room.top}`} room={room} index={index} />
        ))}

        {OFFICE_CORRIDORS.map((corridor) => (
          <OfficeCorridor key={`${corridor.left}-${corridor.top}`} corridor={corridor} />
        ))}

        {OFFICE_DECOR.map((decor, index) => (
          <OfficeDecor
            key={`${decor.kind}-${decor.x}-${decor.y}-${index}`}
            decor={decor}
            index={index}
          />
        ))}

        {OFFICE_SIGNALS.map((signal) => (
          <OfficeSignal key={`${signal.x}-${signal.y}`} signal={signal} />
        ))}

        {OFFICE_DESKS.slice(0, deskCount).map((desk, index) => (
          <OfficeDesk key={`${desk.x}-${desk.y}-${index}`} desk={desk} index={index} />
        ))}

        {visibleAgents.length === 0 ? (
          <div className="day0-pixel-office-empty absolute left-5 top-5 z-10 px-3 py-2 text-xs uppercase tracking-[0.16em] text-[var(--color-muted)]">
            {agents ? 'office ready' : 'syncing office'}
          </div>
        ) : null}

        {visibleAgents.map((agent, index) => {
          const seat = OFFICE_DESKS[deskFor(index)];
          const place = layout.working.has(agent.agentId)
            ? { desktop: { x: seat.seatX, y: seat.seatY }, phone: phoneSeat(index) }
            : (destinations[agent.agentId] ?? opening[agent.agentId]);
          return (
            <OfficeAgent
              key={agent.agentId}
              agent={agent}
              place={place}
              working={layout.working.has(agent.agentId)}
            />
          );
        })}
      </div>
    </section>
  );
}

function OfficeRoom({ room, index }: { room: (typeof OFFICE_ROOMS)[number]; index: number }) {
  const style: OfficeStyle = { ...rectStyle(room), '--i': index };
  return (
    <div
      className={`day0-pixel-room day0-pixel-room-${room.tone} absolute`}
      style={style}
      aria-hidden="true"
    >
      {/* The wash that rises and falls as the room lights up; invisible otherwise. */}
      <span className="day0-pixel-room-light" aria-hidden="true" />
    </div>
  );
}

function OfficeCorridor({ corridor }: { corridor: (typeof OFFICE_CORRIDORS)[number] }) {
  return (
    <div
      className={`day0-pixel-corridor day0-pixel-corridor-${corridor.axis} absolute`}
      style={rectStyle(corridor)}
      aria-hidden="true"
    />
  );
}

function OfficeDecor({ decor, index }: { decor: (typeof OFFICE_DECOR)[number]; index: number }) {
  const style: OfficeStyle = { left: `${decor.x}%`, top: `${decor.y}%`, '--i': index };
  return (
    <div
      className={`day0-pixel-decor day0-pixel-${decor.kind} absolute -translate-x-1/2 -translate-y-1/2`}
      style={style}
      aria-hidden="true"
    />
  );
}

function OfficeSignal({ signal }: { signal: (typeof OFFICE_SIGNALS)[number] }) {
  return (
    <div
      className="day0-pixel-signal absolute"
      style={{
        left: `${signal.x}%`,
        top: `${signal.y}%`,
        animationDelay: `${signal.delay}s`,
      }}
      aria-hidden="true"
    />
  );
}

/**
 * A desk and its chair, at a desktop width only: a phone figure is a third of the office wide and
 * covers the desk it sits at, and an idle one would stand on an empty desk, so a phone draws the
 * figures alone (the phone office, superseding UX 12's four phone desks).
 */
function OfficeDesk({ desk, index }: { desk: (typeof OFFICE_DESKS)[number]; index: number }) {
  const chairStyle: OfficeStyle = { '--x': desk.seatX, '--y': desk.seatY, '--i': index };
  const deskStyle: OfficeStyle = { '--x': desk.x, '--y': desk.y, '--i': index };
  return (
    <>
      <div
        className={`day0-pixel-chair day0-pixel-chair-${desk.variant} day0-office-at absolute -translate-x-1/2 -translate-y-1/2 max-sm:hidden`}
        style={chairStyle}
        aria-hidden="true"
      />
      <div
        className={`day0-pixel-desk day0-pixel-desk-${desk.variant} day0-office-at absolute -translate-x-1/2 -translate-y-1/2 max-sm:hidden`}
        style={deskStyle}
        aria-hidden="true"
      >
        <div className="day0-pixel-monitor absolute left-3 right-3 top-2 h-4">
          <span className="absolute left-2 top-1 h-1 w-8 bg-[var(--color-accent)]/70" />
        </div>
        <div className="day0-pixel-keyboard absolute bottom-2 left-4 h-3 w-7" />
        <div className="day0-pixel-notepad absolute bottom-2 right-4 h-3 w-5" />
      </div>
    </>
  );
}

function rectStyle(rect: { left: number; top: number; width: number; height: number }) {
  return {
    left: `${rect.left}%`,
    top: `${rect.top}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`,
  };
}

/** Who is at a desk and who stands elsewhere, and where the desks' sitters sit. */
interface OfficeLayout {
  readonly working: ReadonlySet<string>;
  readonly seated: readonly OfficePoint[];
  /** Where the same sitters sit on a phone. */
  readonly phoneSeated: readonly OfficePoint[];
  readonly idle: readonly IdleFigure[];
  /** The desktop office's plan, clear of the desks it draws. */
  readonly desktop: OfficePlan;
  /** The phone office's plan, with a row for every three employees. */
  readonly phone: OfficePlan;
  /** How tall the phone office is, in px, for those rows. */
  readonly phoneHeight: number;
}

/** Where the idle employees roam to, and the seating those places were chosen against. */
interface Roaming {
  readonly seating: string;
  readonly places: Readonly<Record<string, OfficePlace>>;
}

const NO_PLACES: Readonly<Record<string, OfficePlace>> = {};

/**
 * What the idle employees' places depend on, as one key: who stands where on the roster (their
 * desks and phone seats), their names (their seeds) and who is at a desk.
 */
function seatingOf(agents: readonly RosterRow[], layout: OfficeLayout): string {
  return agents
    .map((agent) => `${agent.agentId}:${agent.name}:${layout.working.has(agent.agentId) ? 1 : 0}`)
    .join('|');
}

/** Each idle employee's desktop and phone places, by id, from the two plans' own placements. */
function placesById(
  desktop: Readonly<Record<string, OfficePoint>>,
  phone: Readonly<Record<string, OfficePoint>>,
): Record<string, OfficePlace> {
  return Object.fromEntries(
    Object.entries(desktop).map(([agentId, point]) => [
      agentId,
      { desktop: point, phone: phone[agentId] ?? point },
    ]),
  );
}

/** Where each idle employee opens, on both plans. */
function idleOffice(layout: OfficeLayout): Record<string, OfficePlace> {
  return placesById(
    idlePlaces(layout.idle, layout.seated, undefined, layout.desktop),
    idlePlaces(layout.idle, layout.phoneSeated, undefined, layout.phone),
  );
}

/**
 * Split the roster into the employees at their desks and the ones standing: an employee in its
 * one-to-one or with work open sits at the desk its place on the roster gives it.
 *
 * @param agents - The roster, in order.
 */
function officeLayout(agents: readonly RosterRow[]): OfficeLayout {
  const working = new Set<string>();
  const seated: OfficePoint[] = [];
  const phoneSeated: OfficePoint[] = [];
  const idle: IdleFigure[] = [];
  agents.forEach((agent, index) => {
    if (agentIsWorking(agent.state, agent.openCount)) {
      const seat = OFFICE_DESKS[deskFor(index)];
      working.add(agent.agentId);
      seated.push({ x: seat.seatX, y: seat.seatY });
      phoneSeated.push(phoneSeat(index));
    } else {
      idle.push({ agentId: agent.agentId, seed: figureSeed(agent) });
    }
  });
  const rows = phoneRows(agents.length);
  const drawn = OFFICE_DESKS.slice(0, deskCountFor(agents.length)).flatMap((desk) => [
    { x: desk.x, y: desk.y },
    { x: desk.seatX, y: desk.seatY },
  ]);
  return {
    working,
    seated,
    phoneSeated,
    idle,
    desktop: desktopPlan(drawn),
    phone: phonePlan(rows),
    phoneHeight: phoneOfficeHeight(rows),
  };
}

/** A number of the employee's own, for its first spot and its walking pace. */
function figureSeed(agent: Pick<RosterRow, 'agentId' | 'name'>): number {
  return hashString(`${agent.agentId}:${agent.name}`);
}

function OfficeAgent({
  agent,
  place,
  working,
}: {
  agent: RosterRow;
  place: OfficePlace;
  working: boolean;
}) {
  const style: OfficeStyle = {
    ...placeStyle(place),
    '--walk-duration': `${2700 + (figureSeed(agent) % 700)}ms`,
  };

  return (
    <Link
      href={`/agent/${agent.agentId}`}
      className={`day0-office-agent day0-office-at absolute z-10 -translate-x-1/2 -translate-y-1/2 ${
        working ? 'day0-office-agent-seated' : 'day0-office-agent-walking'
      }`}
      style={style}
      title={`${agent.name}, ${working ? 'working at a desk' : 'roaming the office'}`}
    >
      <div className={working ? 'day0-office-agent-working' : 'day0-office-agent-roaming'}>
        <AgentPixelAvatar
          avatar={avatarById(agent.avatarId)}
          state={agent.state}
          phase={agent.phase}
          label={agent.name}
        />
        <div className="day0-pixel-nameplate mt-1 max-w-36 px-2 py-1 text-center max-sm:max-w-none">
          <div className="truncate text-xs text-[var(--color-fg)]">{agent.name}</div>
          {/* A phone figure is a third of the office wide, too narrow for a role cut to a few
            letters: the roster beneath prints it whole (the pre-tag pass's minor 10). */}
          <div
            className="truncate text-xs text-[var(--color-fg)]/70 max-sm:hidden"
            title={agent.roleLine}
          >
            {agent.roleLine}
          </div>
        </div>
        <div className="mt-1 truncate rounded-full border border-[var(--color-border)] bg-[var(--color-card)]/90 px-2 py-0.5 text-center text-xs whitespace-nowrap text-[var(--color-muted)] max-sm:rounded-lg max-sm:px-1 max-sm:whitespace-normal">
          {/* A phone figure is a third of the office wide: the count says it without the verb,
            on two lines where one does not hold it. */}
          <span className="max-sm:sr-only">reads </span>
          {agent.docSourceCount} {agent.docSourceCount === 1 ? 'location' : 'locations'}
        </div>
      </div>
    </Link>
  );
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function agentIsWorking(state: Doc<'agents'>['state'], openWorkCount = 0) {
  return state === 'day-one-in-progress' || openWorkCount > 0;
}
