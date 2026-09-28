'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { deploymentZone, formatStamp } from '@/lib/zone';

/**
 * One clock for the page.
 *
 * The Slack panel rendered local time and the event feed rendered UTC, so the
 * same event was stamped 03:12 in one panel and 19:12 in the other. Everything
 * that shows a time now reads from here, and every stamp carries its date: a
 * time with no date cannot be placed once the page spans more than a day.
 *
 * The zone is the agent's (decision N12: set at deploy, editable on the card),
 * so the manager and anyone they share the page with read the agent's day.
 * A caller that has no agent row to hand passes nothing, and the stamp is in
 * the viewer's own zone, still with its date.
 *
 * The feed is the one place that says how long ago instead of when, because a
 * live feed is read for recency and a running clock beside a running list is
 * two things to reconcile. It carries the wall-clock time as a tooltip, in the
 * same zone as every other stamp on the page.
 */

/**
 * The agent's zone for everything the dashboard stamps. The page provides it
 * from the agent row, so a stamp deep in a card reads the same day as the
 * header without the zone being handed down through every component.
 */
export const AgentZoneContext = createContext<string | undefined>(undefined);

/**
 * The zone the page's stamps are in: the agent's, or undefined outside an
 * agent's page, where a stamp is in the viewer's zone.
 */
export function useAgentZone(): string | undefined {
  return useContext(AgentZoneContext);
}

/**
 * An instant with its date and time, in the agent's zone when given and the
 * viewer's otherwise: `28 Sep 2026, 14:05`.
 */
export function clockTime(ms: number, zone?: string): string {
  return formatStamp(ms, zone ?? deploymentZone());
}

/** The same instant, to the second, for a tooltip. */
export function clockTimeWithSeconds(ms: number, zone?: string): string {
  return formatStamp(ms, zone ?? deploymentZone(), { seconds: true });
}

/** How long ago, in the shortest form that stays honest. */
export function relativeTime(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * A clock that ticks, so relative stamps age on their own. Without it a feed
 * that stops receiving events keeps reporting the last one as "just now".
 */
export function useNow(intervalMs = 15000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
