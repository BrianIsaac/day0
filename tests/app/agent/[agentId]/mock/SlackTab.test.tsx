import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * The office opens on whichever conversation the pane selects for itself, so
 * the fixture is shaped like the seeded one that exposed the defect: the
 * alphabetically first slug is an empty DM, and the row the rail draws first
 * is a channel that has messages. `listChannels` returns rows through the
 * `by_agent_slug` index, so the fixture is in slug order, not rail order.
 */
const state = vi.hoisted(() => ({ channelsOnly: false, dmsOnly: false }));

const CHANNELS = [
  { _id: 'c-aman', slug: 'dm-aman', displayName: 'Aman', kind: 'dm' },
  { _id: 'c-manager', slug: 'dm-manager', displayName: 'Manager', kind: 'dm' },
  { _id: 'c-revops', slug: 'revops-asks', displayName: '#revops-asks', kind: 'channel' },
] as const;

const MESSAGES: Readonly<Record<string, readonly { body: string }[]>> = {
  'dm-aman': [],
  'dm-manager': [{ body: 'Manager DM body' }],
  'revops-asks': [{ body: 'Pipeline hygiene, please' }],
};

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown => {
    const name = getFunctionName(reference as never);
    if (name === 'mock:listChannels') {
      if (state.channelsOnly) return CHANNELS.filter((c) => c.kind === 'channel');
      if (state.dmsOnly) return CHANNELS.filter((c) => c.kind === 'dm');
      return CHANNELS;
    }
    if (name === 'mock:listMessages') {
      if (args === 'skip') return undefined;
      const slug = (args as { channelSlug: string }).channelSlug;
      return (MESSAGES[slug] ?? []).map((m, i) => ({
        _id: `${slug}-${i}`,
        sender: 'Priya',
        senderKind: 'human',
        body: m.body,
        timestamp: 1_757_000_000_000 + i,
      }));
    }
    return undefined;
  },
}));

import type { Id } from '../../../../../convex/_generated/dataModel';
import { SlackTab } from '../../../../../app/agent/[agentId]/mock/SlackTab';

const agentId = 'agent-1' as Id<'agents'>;
const EMPTY_CONVERSATION = 'no messages in this channel yet';
const ACTIVE = 'text-[var(--color-accent)]';

/** The rail rows in the order they are drawn, with whether each is selected. */
function railRows(html: string): { label: string; active: boolean }[] {
  return [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => ({
    label: m[2],
    active: m[1].includes(ACTIVE),
  }));
}

describe('the conversation the mock office opens on', (): void => {
  it('is the first row the rail draws, not the alphabetically first slug', (): void => {
    const html = renderToStaticMarkup(<SlackTab agentId={agentId} />);

    const rows = railRows(html);
    expect(rows.map((r) => r.label)).toEqual(['#revops-asks', 'Aman', 'Manager']);
    expect(rows.filter((r) => r.active).map((r) => r.label)).toEqual(['#revops-asks']);

    expect(html).toContain('Pipeline hygiene, please');
    expect(html).not.toContain(EMPTY_CONVERSATION);
  });

  it('falls back to the first direct message when no channel is seeded', (): void => {
    state.dmsOnly = true;
    try {
      const html = renderToStaticMarkup(<SlackTab agentId={agentId} />);
      const rows = railRows(html);
      expect(rows.map((r) => r.label)).toEqual(['Aman', 'Manager']);
      expect(rows.filter((r) => r.active).map((r) => r.label)).toEqual(['Aman']);
      expect(html).toContain(EMPTY_CONVERSATION);
    } finally {
      state.dmsOnly = false;
    }
  });

  it('opens on the first channel when there are no direct messages', (): void => {
    state.channelsOnly = true;
    try {
      const html = renderToStaticMarkup(<SlackTab agentId={agentId} />);
      expect(
        railRows(html)
          .filter((r) => r.active)
          .map((r) => r.label),
      ).toEqual(['#revops-asks']);
      expect(html).toContain('Pipeline hygiene, please');
    } finally {
      state.channelsOnly = false;
    }
  });
});
