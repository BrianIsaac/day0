'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import type { Doc } from '@convex/_generated/dataModel';
import { avatarById } from '@/agent/avatar-pets';
import { useLightUpOnce } from './office-light-up';
import {
  idlePlaces,
  phoneSeat,
  PHONE_PLAN,
  type IdleFigure,
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

const OFFICE_DESKS = [
  { x: 14, y: 17, seatX: 14, seatY: 25, variant: 'wide' },
  { x: 29, y: 17, seatX: 29, seatY: 25, variant: 'wide' },
  { x: 67, y: 17, seatX: 67, seatY: 25, variant: 'wide' },
  { x: 86, y: 17, seatX: 86, seatY: 25, variant: 'wide' },
  { x: 68, y: 31, seatX: 68, seatY: 37, variant: 'compact' },
  { x: 87, y: 31, seatX: 87, seatY: 37, variant: 'compact' },
  { x: 13, y: 50, seatX: 13, seatY: 58, variant: 'console' },
  { x: 27, y: 50, seatX: 27, seatY: 58, variant: 'console' },
  { x: 73, y: 50, seatX: 73, seatY: 58, variant: 'compact' },
  { x: 90, y: 50, seatX: 90, seatY: 58, variant: 'compact' },
  { x: 53, y: 79, seatX: 53, seatY: 87, variant: 'wide' },
  { x: 67, y: 79, seatX: 67, seatY: 87, variant: 'wide' },
  { x: 83, y: 79, seatX: 83, seatY: 87, variant: 'wide' },
  { x: 13, y: 82, seatX: 13, seatY: 90, variant: 'compact' },
  { x: 28, y: 82, seatX: 28, seatY: 90, variant: 'compact' },
  { x: 15, y: 30, seatX: 15, seatY: 36, variant: 'compact' },
  { x: 30, y: 30, seatX: 30, seatY: 36, variant: 'compact' },
  { x: 55, y: 31, seatX: 51, seatY: 33, variant: 'console' },
  { x: 55, y: 65, seatX: 50, seatY: 63, variant: 'console' },
  { x: 93, y: 83, seatX: 89, seatY: 88, variant: 'console' },
] as const;

/**
 * The order employees take the eight desks always drawn: far apart first, so
 * two name plates never sit on each other while the office has room (the
 * first two desks are 15 percent apart, less than a plate is wide). Past the
 * eighth, each employee takes the desk its arrival adds.
 */
const SEAT_ORDER = [0, 2, 6, 3, 7, 1, 4, 5] as const;

/** The desk the employee at this place on the roster sits at when working. */
function deskFor(index: number): number {
  return (SEAT_ORDER[index] ?? index) % OFFICE_DESKS.length;
}

/** The place on the roster whose employee sits at this desk, which a phone seats in that order. */
function sitterOf(desk: number): number {
  const index = SEAT_ORDER.indexOf(desk as (typeof SEAT_ORDER)[number]);
  return index === -1 ? desk : index;
}

/** How far above its chair a desk stands, as a share of the office's height. */
const DESK_ABOVE_SEAT = 8;

type OfficeStyle = CSSProperties & {
  '--walk-duration'?: string;
  /** The element's place in the light-up stagger. */
  '--i'?: number;
  /** Where the element stands at a desktop width, as a share of the office (`day0-office-at`). */
  '--x'?: number;
  '--y'?: number;
  /** Where it stands on a phone, as a share of the office's inner width and height (`PHONE_PLAN`). */
  '--px'?: number;
  '--py'?: number;
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

/** The fewest desks a phone draws (UX 12, v3 option c): the ones the first four employees take. */
const PHONE_DESK_MINIMUM = 4;

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
  const deskCount = Math.max(8, Math.min(OFFICE_DESKS.length, visibleAgents.length));
  const phoneDesks = new Set(
    Array.from({ length: Math.max(PHONE_DESK_MINIMUM, visibleAgents.length) }, (_, index) =>
      deskFor(index),
    ),
  );
  const [agentDestinations, setAgentDestinations] = useState<Record<string, OfficePlace>>({});
  const office = useRef<HTMLDivElement>(null);
  useLightUpOnce(office, settled);
  const layout = officeLayout(visibleAgents);
  // Where each idle employee opens, stable between renders; the roaming below moves them on.
  const opening = idleOffice(layout);

  useEffect(() => {
    const roster = officeLayout(agents ?? []);
    if (roster.idle.length === 0) return;
    const start = idleOffice(roster);
    const pick = (spots: readonly OfficePoint[]): OfficePoint =>
      spots[Math.floor(Math.random() * spots.length)] ?? spots[0];
    const timer = window.setInterval(() => {
      setAgentDestinations((current) => {
        const from = (agentId: string): OfficePlace | undefined =>
          current[agentId] ?? start[agentId];
        return placesById(
          idlePlaces(
            roster.idle.map((figure) => ({ ...figure, previous: from(figure.agentId)?.desktop })),
            roster.seated,
            pick,
          ),
          idlePlaces(
            roster.idle.map((figure) => ({ ...figure, previous: from(figure.agentId)?.phone })),
            roster.phoneSeated,
            pick,
            PHONE_PLAN,
          ),
        );
      });
    }, 3400);
    return () => window.clearInterval(timer);
  }, [agents]);

  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">Mini office world</h2>
        <span className="text-xs text-[var(--color-muted)]">{visibleAgents.length} total</span>
      </div>

      <div ref={office} className="day0-pixel-office relative min-h-[560px] overflow-hidden">
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
          <OfficeDesk
            key={`${desk.x}-${desk.y}-${index}`}
            desk={desk}
            index={index}
            onPhone={phoneDesks.has(index)}
          />
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
            : (agentDestinations[agent.agentId] ?? opening[agent.agentId]);
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

function OfficeDesk({
  desk,
  index,
  onPhone,
}: {
  desk: (typeof OFFICE_DESKS)[number];
  index: number;
  onPhone: boolean;
}) {
  // On a phone the desk stands where its sitter's seat is (`phoneSeat`), just above the chair.
  const seat = phoneSeat(sitterOf(index));
  const chairStyle: OfficeStyle = {
    ...placeStyle({ desktop: { x: desk.seatX, y: desk.seatY }, phone: seat }),
    '--i': index,
  };
  const deskStyle: OfficeStyle = {
    ...placeStyle({
      desktop: { x: desk.x, y: desk.y },
      phone: { x: seat.x, y: seat.y - DESK_ABOVE_SEAT },
    }),
    '--i': index,
  };
  const phone = onPhone ? '' : ' max-sm:hidden';
  return (
    <>
      <div
        className={`day0-pixel-chair day0-pixel-chair-${desk.variant} day0-office-at absolute -translate-x-1/2 -translate-y-1/2${phone}`}
        style={chairStyle}
        aria-hidden="true"
      />
      <div
        className={`day0-pixel-desk day0-pixel-desk-${desk.variant} day0-office-at absolute -translate-x-1/2 -translate-y-1/2${phone}`}
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
    idlePlaces(layout.idle, layout.seated),
    idlePlaces(layout.idle, layout.phoneSeated, undefined, PHONE_PLAN),
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
  return { working, seated, phoneSeated, idle };
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
          <div className="truncate text-xs text-[var(--color-fg)]/70" title={agent.roleLine}>
            {agent.roleLine}
          </div>
        </div>
        <div className="mt-1 truncate rounded-full border border-[var(--color-border)] bg-[var(--color-card)]/90 px-2 py-0.5 text-center text-xs whitespace-nowrap text-[var(--color-muted)]">
          {/* A phone figure is a third of the office wide: the count says it without the verb. */}
          <span className="max-sm:hidden">reads </span>
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
