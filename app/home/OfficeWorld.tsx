'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import type { Doc } from '@convex/_generated/dataModel';
import { avatarById } from '@/agent/avatar-pets';
import { useLightUpOnce } from './office-light-up';
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

const OFFICE_IDLE_SPOTS = [
  { x: 49, y: 17 },
  { x: 49, y: 32 },
  { x: 48, y: 48 },
  { x: 49, y: 62 },
  { x: 39, y: 57 },
  { x: 58, y: 56 },
  { x: 38, y: 83 },
  { x: 50, y: 86 },
  { x: 74, y: 37 },
  { x: 19, y: 37 },
] as const;

interface OfficePoint {
  x: number;
  y: number;
}

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

type OfficeStyle = CSSProperties & {
  '--walk-duration'?: string;
  /** The element's place in the light-up stagger. */
  '--i'?: number;
};

/**
 * Half a name plate's width: a figure's centre never comes nearer the box's
 * edge than this, so at a phone's width the plate is not cut off by the
 * office's clipping while the desk it sits at stays near the edge.
 */
const FIGURE_EDGE_INSET = '4.5rem';

/** The mini office world: the employees at their desks or roaming the rooms. */
export function OfficeWorld({ agents }: { agents: RosterRow[] | undefined }) {
  const visibleAgents = agents ?? [];
  const deskCount = Math.max(8, Math.min(OFFICE_DESKS.length, visibleAgents.length));
  const [agentDestinations, setAgentDestinations] = useState<Record<string, OfficePoint>>({});
  const office = useRef<HTMLDivElement>(null);
  useLightUpOnce(office);

  // Agents open at the deterministic idle spot `OfficeAgent` derives from their
  // id and start roaming from the first tick, so no synchronous seeding here.
  useEffect(() => {
    const currentAgents = agents ?? [];
    if (!currentAgents.length) return;

    const timer = window.setInterval(() => {
      setAgentDestinations((current) => {
        const next: Record<string, OfficePoint> = {};

        for (const agent of currentAgents) {
          if (!agentIsWorking(agent.state)) {
            next[agent.agentId] = randomOfficePoint(current[agent.agentId]);
          }
        }

        return next;
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
          <OfficeDesk key={`${desk.x}-${desk.y}-${index}`} desk={desk} index={index} />
        ))}

        {visibleAgents.length === 0 ? (
          <div className="day0-pixel-office-empty absolute left-5 top-5 z-10 px-3 py-2 text-xs uppercase tracking-[0.16em] text-[var(--color-muted)]">
            {agents ? 'office ready' : 'syncing office'}
          </div>
        ) : null}

        {visibleAgents.map((agent, index) => (
          <OfficeAgent
            key={agent.agentId}
            agent={agent}
            destination={agentDestinations[agent.agentId]}
            index={index}
          />
        ))}
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

function OfficeDesk({ desk, index }: { desk: (typeof OFFICE_DESKS)[number]; index: number }) {
  const chairStyle: OfficeStyle = { left: `${desk.seatX}%`, top: `${desk.seatY}%`, '--i': index };
  const deskStyle: OfficeStyle = { left: `${desk.x}%`, top: `${desk.y}%`, '--i': index };
  return (
    <>
      <div
        className={`day0-pixel-chair day0-pixel-chair-${desk.variant} absolute -translate-x-1/2 -translate-y-1/2`}
        style={chairStyle}
        aria-hidden="true"
      />
      <div
        className={`day0-pixel-desk day0-pixel-desk-${desk.variant} absolute -translate-x-1/2 -translate-y-1/2`}
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

function OfficeAgent({
  agent,
  destination,
  index,
}: {
  agent: RosterRow;
  destination: OfficePoint | undefined;
  index: number;
}) {
  const working = agentIsWorking(agent.state, agent.openCount);
  const desk = OFFICE_DESKS[index % OFFICE_DESKS.length];
  const seed = hashString(`${agent.agentId}:${agent.name}`);
  const idleSpot = OFFICE_IDLE_SPOTS[seed % OFFICE_IDLE_SPOTS.length];
  const idleX = destination?.x ?? clamp(idleSpot.x + ((seed >> 5) % 13) - 6, 8, 92);
  const idleY = destination?.y ?? clamp(idleSpot.y + ((seed >> 11) % 11) - 5, 12, 90);
  const x = working ? desk.seatX : idleX;
  const y = working ? desk.seatY : idleY;
  const style: OfficeStyle = {
    left: `clamp(${FIGURE_EDGE_INSET}, ${x}%, calc(100% - ${FIGURE_EDGE_INSET}))`,
    top: `${y}%`,
    '--walk-duration': `${2700 + (seed % 700)}ms`,
  };

  return (
    <Link
      href={`/agent/${agent.agentId}`}
      className={`day0-office-agent absolute z-10 -translate-x-1/2 -translate-y-1/2 outline-none ${
        working ? 'day0-office-agent-seated' : 'day0-office-agent-walking'
      }`}
      style={style}
      title={`${agent.name}, ${working ? 'working at a desk' : 'roaming the office'}`}
    >
      <div className={working ? 'day0-office-agent-working' : 'day0-office-agent-roaming'}>
        <AgentPixelAvatar
          avatar={avatarById(agent.avatarId)}
          state={agent.state}
          label={agent.name}
        />
        <div className="day0-pixel-nameplate mt-1 max-w-36 px-2 py-1 text-center">
          <div className="truncate text-xs text-[var(--color-fg)]">{agent.name}</div>
          <div className="truncate text-xs text-[var(--color-fg)]/70" title={agent.roleLine}>
            {agent.roleLine}
          </div>
        </div>
        <div className="mt-1 rounded-full border border-[var(--color-border)] bg-[var(--color-card)]/90 px-2 py-0.5 text-center text-xs whitespace-nowrap text-[var(--color-muted)]">
          reads {agent.docSourceCount} {agent.docSourceCount === 1 ? 'location' : 'locations'}
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function randomOfficePoint(previous: OfficePoint | undefined): OfficePoint {
  const candidates = previous
    ? OFFICE_IDLE_SPOTS.filter(
        (spot) => Math.abs(spot.x - previous.x) + Math.abs(spot.y - previous.y) > 18,
      )
    : OFFICE_IDLE_SPOTS;
  const spot = candidates[Math.floor(Math.random() * candidates.length)] ?? OFFICE_IDLE_SPOTS[0];
  const jitterX = Math.floor(Math.random() * 13) - 6;
  const jitterY = Math.floor(Math.random() * 11) - 5;

  return {
    x: clamp(spot.x + jitterX, 8, 92),
    y: clamp(spot.y + jitterY, 12, 90),
  };
}

function agentIsWorking(state: Doc<'agents'>['state'], openWorkCount = 0) {
  return state === 'day-one-in-progress' || openWorkCount > 0;
}
