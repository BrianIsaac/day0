/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: unknown }>,
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation:
    (reference: unknown) =>
    async (args?: unknown): Promise<unknown> => {
      backend.calls.push({ name: getFunctionName(reference as never), args });
      return null;
    },
}));

import {
  CancelHandoverDialog,
  cutSystems,
  HandOverDialog,
  reapprovedSystems,
  MakeItYou,
  type CutCandidate,
} from '../../../../../app/agent/[agentId]/people/HandOver';
import { useChange } from '../../../../../app/components/use-change';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { EMPLOYEE_ROW } from '../../../../fixtures/dom/employee';
import { mount, press, said, unmountAll } from '../../../../fixtures/dom/press';

/** One card, as `surfaces.listForAgent` lists it. */
function card(fields: Partial<CutCandidate> & Pick<CutCandidate, 'displayName'>): CutCandidate {
  return { verdict: 'proposed', ...fields } as CutCandidate;
}

describe('cutSystems (the rule surfaceHandoverOf states for the move)', () => {
  it('cuts a card bound to a credential or a provisioned app, or standing on the old approval', () => {
    expect(
      cutSystems([
        card({ displayName: 'Linear', verdict: 'connected', credentialId: 'c1' as never }),
        card({
          displayName: 'Slack',
          provisioning: { clientSecretCredentialId: 'c2' } as CutCandidate['provisioning'],
        }),
        card({ displayName: 'Looker', verdict: 'absent', managerApprovedAt: 5 }),
        card({ displayName: 'Jira', verdict: 'approved' }),
        card({ displayName: 'Notion' }),
        card({ displayName: 'Linear', verdict: 'ungranted' }),
      ]),
    ).toEqual(['Linear', 'Slack', 'Looker', 'Jira']);
  });
});

describe('reapprovedSystems (the cards a handover keeps for re-approval, A25)', () => {
  it("names each card that keeps the employee's own identity and whom it keeps acting as, and cuts it from nothing", () => {
    const kept = card({
      displayName: 'Slack',
      verdict: 'connected',
      credentialId: 'c1' as never,
      organisationConnectionId: 'connection-slack' as never,
      actsAs: { kind: 'own-app', label: 'Leo (Day0)' },
    });
    const shared = card({
      displayName: 'Linear',
      verdict: 'connected',
      credentialId: 'c2' as never,
      organisationConnectionId: 'connection-linear' as never,
      actsAs: { kind: 'shared-app', label: 'Linear' },
    });
    const pasted = card({
      displayName: 'Notion',
      verdict: 'connected',
      credentialId: 'c3' as never,
    });
    expect(reapprovedSystems([kept, shared, pasted], 'Leo')).toEqual([
      { system: 'Slack', identity: "Leo's own app" },
      { system: 'Linear', identity: 'the Day0 app your employees share' },
    ]);
    expect(cutSystems([kept, shared, pasted])).toEqual(['Notion']);
  });
});

/** A dialog with a change of its own, as the Manager card hands one in. */
function Harness({ which }: { which: 'hand-over' | 'cancel' | 'make' }) {
  const card = useRef<HTMLDivElement>(null);
  const change = useChange(card);
  const landed = (): HTMLElement | null => card.current;
  return (
    <div ref={card} tabIndex={-1}>
      <p role="status">{change.outcome?.text ?? ''}</p>
      {which === 'hand-over' ? (
        <HandOverDialog
          agent={EMPLOYEE_ROW}
          mode="mock"
          change={change}
          landed={landed}
          onClose={() => undefined}
        />
      ) : which === 'cancel' ? (
        <CancelHandoverDialog
          transferId={'transfer-1' as Id<'managerTransfers'>}
          toAddress="lead@day0.local"
          change={change}
          landed={landed}
          onClose={() => undefined}
        />
      ) : (
        <MakeItYou agent={EMPLOYEE_ROW} change={change} landed={landed} />
      )}
    </div>
  );
}

describe('the hand-over controls', () => {
  afterEach(() => {
    unmountAll();
    backend.calls = [];
    backend.queries = {};
  });

  it('asks in the hosted office without reading the cards, which nothing cuts there', () => {
    mount(<Harness which="hand-over" />);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      "In the hosted office, the office's systems go with Mira.",
    );
    const ask = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Ask them',
    );
    expect(ask?.disabled).toBe(false);
    expect(dialog?.querySelector('textarea')?.maxLength).toBe(1000);
  });

  it('cancels the request it names', async () => {
    const view = mount(<Harness which="cancel" />);
    await press(document.body, 'Cancel the handover');
    expect(backend.calls).toEqual([
      { name: 'managerTransfers:cancel', args: { transferId: 'transfer-1' } },
    ]);
    expect(said(view.container)).toEqual(['The handover to lead@day0.local is cancelled.']);
  });

  it('makes the owner the manager of the employee it names', async () => {
    const view = mount(<Harness which="make" />);
    await press(view.container, 'Make it you');
    expect(backend.calls).toEqual([
      { name: 'agents:adoptManagerAddress', args: { agentId: 'agent-1' } },
    ]);
    expect(said(view.container)).toEqual(['Mira now reports to you.']);
  });
});
