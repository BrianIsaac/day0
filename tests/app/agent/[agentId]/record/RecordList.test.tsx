/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../../../../convex/_generated/dataModel';
import type { RecordEntry } from '../../../../../src/events/record-filters';

/** What the record's paginated query answers, and every argument set and page request it saw. */
const backend = vi.hoisted(() => ({
  entries: [] as unknown[],
  status: 'Exhausted' as string,
  args: [] as unknown[],
  loads: [] as number[],
}));

vi.mock('convex/react', () => ({
  usePaginatedQuery: (reference: unknown, args: unknown) => {
    expect(getFunctionName(reference as never)).toBe('events:record');
    backend.args.push(args);
    return {
      results: backend.entries,
      status: backend.status,
      isLoading: backend.status === 'LoadingFirstPage' || backend.status === 'LoadingMore',
      loadMore: (count: number): void => {
        backend.loads.push(count);
      },
    };
  },
}));

import { AgentZoneContext } from '../../../../../app/agent/[agentId]/time';
import {
  RECORD_PAGE,
  RecordFilters,
  RecordList,
  type RecordView,
} from '../../../../../app/agent/[agentId]/record/RecordList';
import { mount, press } from '../../../../fixtures/dom/press';
import { useState } from 'react';

const agentId = 'agent-1' as Id<'agents'>;

/** A stored event as the reader returns it. */
function entry(
  id: string,
  type: string,
  payload: unknown,
  createdAt: number,
  itemTitle?: string,
): RecordEntry {
  const event = {
    _id: id as Id<'events'>,
    _creationTime: createdAt,
    agentId,
    type,
    payload,
    createdAt,
  } as Doc<'events'>;
  return itemTitle === undefined ? { event } : { event, itemTitle };
}

/** The record with its chips, as the tab draws them. */
function Recorded({ zone = 'Asia/Singapore' }: { zone?: string }) {
  const [view, setView] = useState<RecordView>('all');
  return (
    <AgentZoneContext value={zone}>
      <RecordFilters selected={view} onSelect={setView} />
      <RecordList agentId={agentId} name="Mira" view={view} />
    </AgentZoneContext>
  );
}

afterEach((): void => {
  backend.entries = [];
  backend.status = 'Exhausted';
  backend.args = [];
  backend.loads = [];
  document.body.replaceChildren();
});

describe('RecordList', (): void => {
  it('says the record is loading, then that nothing is recorded, rather than an empty list', (): void => {
    backend.status = 'LoadingFirstPage';
    const loading = mount(<Recorded />);
    expect(loading.container.textContent).toContain('Loading the record');
    expect(loading.container.textContent).not.toContain('Nothing recorded yet.');
    loading.unmount();
    backend.status = 'Exhausted';
    const empty = mount(<Recorded />);
    expect(empty.container.textContent).toContain('Nothing recorded yet.');
    expect(empty.container.textContent).not.toContain('That is the whole record.');
    empty.unmount();
  });

  it('says each event in plain words with its dot, its time in the employee’s zone and its payload one step away', (): void => {
    backend.entries = [
      entry(
        'e2',
        'work.actions-pending',
        { workItemId: 'w1', heldIndexes: [0] },
        Date.UTC(2026, 8, 26, 6, 39),
        'Draft response for new tier-two RevOps ask',
      ),
      entry('e1', 'charter.approved', { version: '0.1' }, Date.UTC(2026, 8, 26, 6, 23)),
    ];
    const view = mount(<Recorded />);
    const lines = [
      ...view.container.querySelectorAll('ol[aria-label="The record, newest first"] > li'),
    ];
    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toContain(
      'Held: Mira held 1 action on “Draft response for new tier-two RevOps ask” for you. Nothing has reached a surface.',
    );
    // Singapore is eight hours ahead of UTC: the stamp is the employee's day, not the viewer's.
    expect(lines[0]?.querySelector('time')?.textContent).toBe('26 Sep 2026, 14:39');
    expect(lines[1]?.textContent).toContain('Landed: You approved charter version 0.1.');
    const payload = lines[0]?.querySelector('details');
    expect(payload?.open).toBe(false);
    // Inline after the sentence, as drawn, not a row between the sentence and its time; its
    // text wraps anywhere, so a long token cannot widen the page on a phone.
    expect(payload?.className).toMatch(/\binline\b/);
    expect(payload?.parentElement?.lastChild).not.toBe(
      payload?.parentElement?.querySelector('time'),
    );
    expect(payload?.querySelector('summary')?.className).toMatch(/\bmin-h-11\b/);
    expect(payload?.querySelector('pre')?.className).toMatch(/\bwrap-anywhere\b/);
    expect(payload?.querySelector('summary')?.textContent).toContain('Payload');
    expect(JSON.parse(payload?.querySelector('pre')?.textContent ?? '')).toEqual({
      id: 'e2',
      type: 'work.actions-pending',
      at: '2026-09-26T06:39:00.000Z',
      payload: { workItemId: 'w1', heldIndexes: [0] },
    });
    expect(view.container.textContent).toContain('That is the whole record.');
    view.unmount();
  });

  it('shows one filter at a time, the record asked again under it, each chip a 44 px toggle', async (): Promise<void> => {
    const view = mount(<Recorded />);
    const chips = [...view.container.querySelectorAll('[role="group"] button')];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'All',
      'Writes',
      'Your decisions',
      'Reads',
      'Refused and withheld',
      'Charter',
    ]);
    for (const chip of chips) expect(chip.className).toMatch(/\bmin-h-11\b/);
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
      'false',
    ]);
    expect(backend.args.at(-1)).toEqual({ agentId });
    await press(view.container, 'Refused and withheld');
    expect(backend.args.at(-1)).toEqual({ agentId, filter: 'refused' });
    expect(
      [...view.container.querySelectorAll('[aria-pressed="true"]')].map((chip) => chip.textContent),
    ).toEqual(['Refused and withheld']);
    expect(view.container.textContent).toContain(
      'Nothing recorded under refused and withheld yet.',
    );
    await press(view.container, 'All');
    expect(backend.args.at(-1)).toEqual({ agentId });
    view.unmount();
  });

  it('adds a page of older lines on Show older, and says so while they load', async (): Promise<void> => {
    backend.entries = [entry('e1', 'work.completed', {}, 1)];
    backend.status = 'CanLoadMore';
    const view = mount(<Recorded />);
    await press(view.container, 'Show older');
    expect(backend.loads).toEqual([RECORD_PAGE]);
    view.unmount();
    backend.status = 'LoadingMore';
    const loading = mount(<Recorded />);
    const more = [...loading.container.querySelectorAll('button')].find(
      (control) => control.textContent === 'Loading older lines',
    );
    expect(more?.disabled).toBe(true);
    loading.unmount();
  });
});
