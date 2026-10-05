/*
 * How often the Socket Mode bridge's heartbeat is kept and how long it counts (wave 13, 13-FS;
 * D-6 (b)). Import-free, so a card in the browser can say the window without pulling in the
 * server's environment reads.
 */

/**
 * How old an unchanged report may grow before the backend writes it again: the bridge reports
 * every 30 seconds, and a row rewritten that often would wake every reader of it for nothing.
 */
export const SOCKET_HEARTBEAT_REFRESH_MS = 2 * 60_000;

/**
 * How recent a live report must be for a card to read the bridge as live: the refresh, the sync
 * that lands it (30 seconds) and one missed sync (30 seconds). A bridge that stops cleanly reports
 * every app down as it goes; one that dies unseen reads as down this long after its last report.
 */
export const SOCKET_HEARTBEAT_FRESH_MS = 3 * 60_000;
