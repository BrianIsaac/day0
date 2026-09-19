import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('convex/react', () => ({
  useQuery: (): undefined => undefined,
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

import type { Doc } from '../../../../convex/_generated/dataModel';
import { WorkItemCard, liveRetryNote, retryNoteToken } from '../../../../app/agent/[agentId]/AgentDashboard';
import { clockTime } from '../../../../app/agent/[agentId]/time';
import type { AutonomyChange } from '../../../../src/work/autonomy';
import rehearsal from '../../../fixtures/work/demo-rehearsal-2-2026-09-19.json';

/**
 * What the camera saw in demo rehearsal 2 (19 Sep 2026), rendered from that
 * sitting's own rows: `tests/fixtures/work/demo-rehearsal-2-2026-09-19.json`.
 */

const noop = (): void => undefined;
const resolved = async (): Promise<void> => undefined;

function changesFor(agentId: string): AutonomyChange[] {
  return rehearsal.autonomyChanges
    .filter((event) => event.agentId === agentId)
    .map((event) => ({ at: event.createdAt, on: event.payload.to }));
}

function card(row: unknown, autonomyChanges: AutonomyChange[], autonomousActions = true): string {
  return renderToStaticMarkup(
    <WorkItemCard
      item={row as Doc<'workItems'>}
      surfaces={[]}
      autonomousActions={autonomousActions}
      autonomyChanges={autonomyChanges}
      onApprovePlan={noop}
      onCancelPlan={noop}
      onRetryFailed={noop}
      onReconcileFailed={resolved}
      onApproveActions={resolved}
      onRejectActions={resolved}
      onResendDecision={resolved}
    />,
  );
}

describe('a plan drafted before autonomous actions were turned on', (): void => {
  const priya = rehearsal.workItems.priyaCompleted;
  const changes = changesFor(priya.agentId);

  it('says when the switch was turned on, between the plan text and the autonomous ledger', (): void => {
    const markup = card(priya, changes);
    const note = `Autonomous actions were turned on at ${clockTime(changes[0]!.at)}, after this plan was drafted; its actions were applied under it.`;
    expect(markup).toContain('Autonomous actions are off, so the browser write sequence');
    expect(markup).toContain(note);
    expect(markup.indexOf('Autonomous actions are off, so')).toBeLessThan(markup.indexOf(note));
    expect(markup.indexOf(note)).toBeLessThan(markup.indexOf('7 applied autonomously'));
  });

  it('keeps the stored plan text as drafted', (): void => {
    expect(card(priya, changes)).toContain(priya.plan.summary.replace(/'/g, '&#x27;'));
  });

  it('says nothing when the switch never changed after the draft', (): void => {
    expect(card(priya, [])).not.toContain('after this plan was drafted');
    expect(card(priya, [{ at: priya.planPendingAt - 1, on: true }])).not.toContain('after this plan was drafted');
  });

  it('counts the rows the switch authorised when the manager approved the rest (Mateo: 3 of 4)', (): void => {
    const mateo = rehearsal.workItems.mateoCompleted;
    const markup = card(mateo, changesFor(mateo.agentId));
    expect(markup).toContain('after this plan was drafted; 3 of its 4 actions were applied under it.');
    expect(markup).toContain('4 changes reached the work environment · 3 applied autonomously');
  });

  it('says nothing on a run the manager approved by hand', (): void => {
    const aiko = rehearsal.workItems.aikoCompleted;
    expect(card(aiko, [{ at: aiko.planPendingAt + 1, on: true }])).not.toContain('after this plan was drafted');
  });
});

describe('the note typed for a retry', (): void => {
  const aiko = rehearsal.workItems.aikoCompleted;
  const stopped = rehearsal.workItems.aikoStopped;
  const NOTE = aiko.managerFeedback.reason;

  it('belongs to the run it was typed for: the stopped run\'s note is not the finished run\'s', (): void => {
    const typedWhileStopped = { text: NOTE, token: retryNoteToken(stopped as never) };
    expect(liveRetryNote(typedWhileStopped, retryNoteToken(stopped as never))).toBe(NOTE);
    expect(liveRetryNote(typedWhileStopped, retryNoteToken(aiko as never))).toBe('');
  });

  it('is dropped when the same state comes round again after the note was sent', (): void => {
    const first = retryNoteToken({ state: 'failed' } as never);
    const again = retryNoteToken({ state: 'failed', managerFeedback: { at: 1789788836000 } } as never);
    expect(liveRetryNote({ text: NOTE, token: first }, again)).toBe('');
  });

  it('leaves the finished card without a reconciliation checklist nobody owes', (): void => {
    const markup = card(aiko, [], false);
    expect(markup).toContain('2 changes reached the work environment');
    expect(markup).not.toContain('Provider reconciliation required');
    expect(markup).not.toContain('Retry remains disabled');
  });

  it('still asks for it on the stopped card, where a retry is owed one', (): void => {
    expect(card(stopped, [], false)).toContain('Provider reconciliation required');
  });
});
