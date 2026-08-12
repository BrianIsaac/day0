'use client';

import { useEffect, useState } from 'react';

/**
 * One clock for the page.
 *
 * The Slack panel rendered local time and the event feed rendered UTC, so the
 * same event was stamped 03:12 in one panel and 19:12 in the other. Everything
 * that shows a time now reads from here, and here means the viewer's own zone:
 * the mock environment is meant to read like the tools it stands in for, and
 * those show a reader their own morning rather than the deployment's.
 *
 * The feed is the one place that says how long ago instead of when, because a
 * live feed is read for recency and a running clock beside a running list is
 * two things to reconcile. It carries the wall-clock time as a tooltip, in the
 * same zone as every other stamp on the page.
 */

/** Wall-clock time in the viewer's zone: what a Slack message is stamped with. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The same instant, to the second, for a tooltip. */
export function clockTimeWithSeconds(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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
