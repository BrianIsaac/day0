/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../../../convex/_generated/dataModel';
import {
  ManagerFeedbackNote,
  ProviderReconciliationControl,
} from '../../../../app/agent/[agentId]/work/RunDetails';
import {
  ZoneLine,
  EmployeeHeader,
  ManagerLine,
} from '../../../../app/agent/[agentId]/EmployeeHeader';
import { focusedName, mount, press, said, settle, typeInto } from '../../../fixtures/dom/press';
import { AgentZoneContext } from '../../../../app/components/time';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

describe('header state pill', (): void => {
  const agent = {
    _id: 'agent-1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Day0',
    state: 'active',
    createdAt: 1,
  } as unknown as Doc<'agents'>;
  const charter = {
    _id: 'charter-1',
    _creationTime: 2,
    agentId: agent._id,
    version: '0.0',
    body: {},
    approved: true,
    createdAt: 2,
  } as unknown as Doc<'charters'>;

  it('names the supervised state on an active agent, not the retired posture ladder', (): void => {
    const markup = renderToStaticMarkup(<EmployeeHeader agent={agent} charter={charter} />);
    expect(markup).toContain('Active · Supervised');
    expect(markup).not.toContain('cold-start');
    expect(markup).not.toContain('posture');
  });

  it('says Paused in the pill of a paused employee, in the warn hue, and the face says it too (12-P)', (): void => {
    const markup = renderToStaticMarkup(
      <EmployeeHeader agent={{ ...agent, pausedAt: 5 }} charter={charter} />,
    );
    expect(markup).toMatch(/text-\[var\(--color-warn\)\][^>]*>Paused</);
    expect(markup).toContain('title="Day0, paused"');
    expect(markup).not.toContain('Active · Supervised');
    // Every tab carries the header, so the hold is said where the held work is listed too.
    expect(markup).toContain('Nothing new starts until you resume Day0 on Manage.');
    expect(renderToStaticMarkup(<EmployeeHeader agent={agent} charter={charter} />)).not.toContain(
      'Nothing new starts',
    );
  });

  it("makes the employee's name the page's one heading, and the manager a line beneath it", (): void => {
    const markup = renderToStaticMarkup(
      <EmployeeHeader agent={{ ...agent, name: 'Mira' }} charter={charter} />,
    );
    expect(markup.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(markup).toMatch(/<h1[^>]*>Mira<\/h1>/);
    expect(markup).toMatch(/Reports to <span[^>]*>boss<wbr\/>@day0\.local<\/span>/);
    expect(markup).not.toContain('Employee reporting to');
  });

  it("says the state the charter on the page makes, in the manager's words, beside the office", (): void => {
    backend.queries['config:surfaceMode'] = { mode: 'mock', label: 'mock' };
    try {
      const pill = (row: Doc<'agents'>, shown: Doc<'charters'> | null): string =>
        renderToStaticMarkup(<EmployeeHeader agent={row} charter={shown} />);
      expect(pill({ ...agent, state: 'deployed' }, null)).toContain('Waiting for your one-to-one');
      expect(pill({ ...agent, state: 'day-one-in-progress' }, null)).toContain(
        'In your one-to-one',
      );
      expect(
        pill({ ...agent, state: 'day-one-in-progress' }, { ...charter, approved: false }),
      ).toContain('Charter to review');
      expect(pill({ ...agent, autonomousActions: true }, charter)).toContain('Active · Autonomous');
      expect(pill(agent, charter)).toContain('>mock office</span>');
    } finally {
      delete backend.queries['config:surfaceMode'];
    }
  });

  it('leaves the autonomy switch and the manager DM setting to the Manage tab', (): void => {
    backend.queries['config:surfaceMode'] = { mode: 'real', label: 'real (local)' };
    try {
      const markup = renderToStaticMarkup(<EmployeeHeader agent={agent} charter={charter} />);
      expect(markup).not.toContain('role="switch"');
      expect(markup).not.toContain('Manager DMs');
    } finally {
      delete backend.queries['config:surfaceMode'];
    }
  });
});

describe("the employee's day on the page (N12, review M8)", (): void => {
  const AT = Date.UTC(2026, 8, 27, 16, 5, 9);
  const agent = {
    _id: 'agent-1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Day0',
    state: 'active',
    zone: 'Asia/Singapore',
    createdAt: 1,
  } as unknown as Doc<'agents'>;

  it("names the agent's zone under the manager and offers to change it", (): void => {
    const markup = renderToStaticMarkup(<EmployeeHeader agent={agent} charter={null} />);
    expect(markup).toContain('Times on this page are in <span');
    expect(markup).toContain('>Asia/Singapore</span>, the employee&#x27;s day.');
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Change zone<\/button>/);
    expect(markup).toContain('role="status"');
  });

  it('prints the confirmed reconciliation in the agent\u2019s zone, not as a UTC ISO string', (): void => {
    const markup = renderToStaticMarkup(
      <AgentZoneContext value="Asia/Singapore">
        <ProviderReconciliationControl
          entries={[]}
          reconciliation={{ by: 'you', confirmedAt: AT }}
          onConfirm={async () => undefined}
        />
      </AgentZoneContext>,
    );
    expect(markup).toContain('>28 Sep 2026, 00:05</time>');
    expect(markup).toContain('dateTime="2026-09-27T16:05:09.000Z"');
    expect(markup).not.toContain('>2026-09-27T16:05:09.000Z<');
  });

  it("stamps the manager's note and the feed's tooltip in the agent's zone", (): void => {
    const markup = renderToStaticMarkup(
      <AgentZoneContext value="Asia/Singapore">
        <ManagerFeedbackNote feedback={{ reason: 'Use template B.', at: AT, kind: 'retry-note' }} />
      </AgentZoneContext>,
    );
    expect(markup).toContain('28 Sep 2026, 00:05:09');
    expect(markup).not.toContain('27 Sep 2026, 16:05:09');
  });
});

describe('the manager line (the transfer plan 7.2, D14)', (): void => {
  const MIRA = { _id: 'agent-1', name: 'Mira', bossEmail: 'boss@day0.local' } as Pick<
    Doc<'agents'>,
    '_id' | 'name' | 'bossEmail'
  >;
  const OPEN = {
    transferId: 'transfer-1' as Id<'managerTransfers'>,
    agentId: 'agent-1' as Id<'agents'>,
    toAddress: 'lead@day0.local',
    state: 'asked' as const,
    requestedAt: 1,
    expiresAt: 2,
  };

  /** The line's text as a reader hears it, every tag dropped. */
  function text(markup: string): string {
    return markup
      .replace(/<[^>]*>/g, '')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;|\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  it('says the employee reports to you, with no control: People holds the only one', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerLine agent={MIRA} standing={{ standing: 'you' }} open={null} />,
    );
    expect(text(markup)).toBe('Reports to you');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('Change manager');
    expect(markup.replace(/<[^>]*>/g, ' ')).not.toMatch(/\bagent\b/i);
  });

  it('names the address until the standing is read, wrapped after its plus and before its at (walk m32)', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerLine
        agent={{ ...MIRA, bossEmail: 'day0-walk-20260930+clerk_test@example.com' }}
        standing={undefined}
        open={undefined}
      />,
    );
    expect(markup).toContain('day0-walk-20260930+<wbr/>clerk_test<wbr/>@example.com');
    expect(markup).not.toMatch(/\bbreak-all\b/);
  });

  it('says an asked handover, the second half a link to People', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerLine agent={MIRA} standing={{ standing: 'you' }} open={OPEN} />,
    );
    expect(text(markup)).toBe('Reports to you · handing over to lead@day0.local');
    const link = /<a([^>]*)href="\/agent\/agent-1\/people"[^>]*>(.*?)<\/a>/.exec(markup);
    expect(text(link?.[2]?.replace(/&nbsp;/g, ' ') ?? '')).toBe('handing over to lead@day0.local');
    // A 44 px target, as the zone line's control is (N14), and one run of text: the link's flex
    // box would otherwise split it into two underlined pieces with a gap between.
    expect(link?.[1]).toContain('min-h-11');
    const inside = link?.[2] ?? '';
    expect(inside.startsWith('<span>') && inside.endsWith('</span>')).toBe(true);
  });

  it('says it aloud when the named manager accepts, which nobody on this page did', (): void => {
    const view = mount(<ManagerLine agent={MIRA} standing={{ standing: 'you' }} open={OPEN} />);
    const region = view.container.querySelector('[role="status"]');
    expect(region?.textContent).toBe('');
    act((): void =>
      view.root.render(
        <ManagerLine
          agent={MIRA}
          standing={{ standing: 'you' }}
          open={{ ...OPEN, state: 'accepting', settleBy: 3 }}
        />,
      ),
    );
    expect(said(view.container)).toEqual([
      "Reports to you until Mira's runs finish, then lead@day0.local.",
    ]);
    view.unmount();
  });

  it('says nothing aloud for a handover already accepting when the page opens', (): void => {
    const view = mount(
      <ManagerLine
        agent={MIRA}
        standing={{ standing: 'you' }}
        open={{ ...OPEN, state: 'accepting', settleBy: 3 }}
      />,
    );
    expect(said(view.container)).toEqual([]);
    view.unmount();
  });

  it('says an accepting handover until the runs finish', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerLine
        agent={MIRA}
        standing={{ standing: 'you' }}
        open={{ ...OPEN, state: 'accepting', settleBy: 3 }}
      />,
    );
    expect(text(markup)).toBe("Reports to you until Mira's runs finish · then lead@day0.local");
    expect(markup).not.toContain('<a');
  });

  it('flags an address that is not the owner’s and sends the owner to People to choose (D17)', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerLine
        agent={{ ...MIRA, bossEmail: 'ana@day0.local' }}
        standing={{ standing: 'other', bossEmail: 'ana@day0.local' }}
        open={null}
      />,
    );
    expect(text(markup)).toBe('Reports to ana@day0.local, who is not you · choose on People');
    expect(markup).toMatch(/<a[^>]*href="\/agent\/agent-1\/people"[^>]*>choose on People<\/a>/);
  });

  it('names the address, unflagged, for an evaluation employee and an unverified owner', (): void => {
    for (const standing of ['evaluation', 'unverified'] as const) {
      const markup = renderToStaticMarkup(
        <ManagerLine agent={MIRA} standing={{ standing }} open={null} />,
      );
      expect(text(markup)).toBe('Reports to boss@day0.local');
    }
  });

  it('says a failed manager lookup is the manager, not the credential, without offering an edit', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerLine
        agent={MIRA}
        standing={{ standing: 'you' }}
        open={null}
        lookupFailure="the manager email left@day0.local is not a member of this Slack workspace (users_not_found)."
      />,
    );
    expect(markup).toContain(
      'could not find this manager: the manager email left@day0.local is not a member of this Slack workspace (users_not_found). The credential still works; the manager&#x27;s address must be one the workspace knows.',
    );
    expect(markup).not.toContain('change the manager');
    expect(markup).not.toContain('..');
  });

  it('reads the open handover and the standing for the header, and changes nothing from it', (): void => {
    backend.queries['managerTransfers:openForAgent'] = OPEN;
    backend.queries['agents:managerStanding'] = { standing: 'you' };
    try {
      const markup = renderToStaticMarkup(
        <EmployeeHeader
          agent={{ ...MIRA, state: 'active', createdAt: 1, _creationTime: 1 } as Doc<'agents'>}
          charter={null}
        />,
      );
      expect(text(markup)).toContain('Reports to you · handing over to lead@day0.local');
      expect(markup).not.toContain('Change manager');
    } finally {
      delete backend.queries['managerTransfers:openForAgent'];
      delete backend.queries['agents:managerStanding'];
    }
  });
});

describe("the zone line's confirmation (wave 3.5 review m10)", (): void => {
  it('says the zone the server stored, in its spelling, not the one typed, and gives focus back to Change zone', async (): Promise<void> => {
    const view = mount(<ZoneLine zone="UTC" onChange={async () => ({ zone: 'Asia/Singapore' })} />);
    await press(view.container, 'Change zone');
    const field = view.container.querySelector<HTMLInputElement>('#agent-zone');
    if (!field) throw new Error('no zone field');
    typeInto(field, 'asia/singapore');
    const save = [...view.container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Save',
    );
    save?.focus();
    await act(async (): Promise<void> => {
      save?.click();
    });
    await settle();
    expect(said(view.container)).toEqual([
      "The employee's day is now Asia/Singapore; every time on this page is in it.",
    ]);
    expect(focusedName()).toBe('Change zone');
    view.unmount();
  });
});
