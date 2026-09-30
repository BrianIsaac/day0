/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../convex/_generated/dataModel';
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
          reconciliation={{ actor: 'boss@day0.local', confirmedAt: AT }}
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

describe('the manager line', (): void => {
  it('names the manager and offers the change on the header', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerLine bossEmail="boss@day0.local" onChange={async () => undefined} />,
    );
    expect(markup).toContain('Reports to');
    expect(markup).not.toMatch(/\bagent\b/i);
    expect(markup).toContain('boss<wbr/>@day0.local');
    expect(markup).toContain('Change manager');
    expect(markup).not.toContain('could not find this manager');
  });

  it('wraps a long address after its plus and before its at, never mid-word (walk m32)', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerLine
        bossEmail="day0-walk-20260930+clerk_test@example.com"
        onChange={async () => undefined}
      />,
    );
    expect(markup).toContain('day0-walk-20260930+<wbr/>clerk_test<wbr/>@example.com');
    expect(markup).not.toMatch(/\bbreak-all\b/);
  });

  it('says a failed manager lookup is the manager, not the credential', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerLine
        bossEmail="left@day0.local"
        lookupFailure="the manager email left@day0.local is not a member of this Slack workspace (users_not_found)."
        onChange={async () => undefined}
      />,
    );
    expect(markup).toContain(
      'could not find this manager: the manager email left@day0.local is not a member of this Slack workspace (users_not_found). The',
    );
    expect(markup).toContain('credential still works; change the manager');
    expect(markup).not.toContain('..');
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
