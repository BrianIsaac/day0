import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import {
  ProgressSection,
  VerdictSection,
  type ItemVerdict,
} from '../../../../../app/agent/[agentId]/work/VerdictSection';
import { AT, DRAWN, SLACK } from '../../../../fixtures/work/drawn-states';

function verdict(state: Doc<'workItems'>['state'], value: ItemVerdict, fields = {}): string {
  const item = { ...DRAWN.planPending, state, verdict: value, ...fields } as Doc<'workItems'>;
  return renderToStaticMarkup(
    <VerdictSection item={item} verdict={value} surfaces={[SLACK]} now={AT} />,
  );
}

describe('why an item that is not moving is where it is', (): void => {
  it('says a parked item waits on a system, a grant or the charter, in the manager’s words', (): void => {
    const connection = verdict('deferred', {
      decision: 'defer',
      reason: 'awaiting-connection',
      missingSurface: 'slack',
    });
    expect(connection).toContain('Parked</span> until Slack');
    expect(connection).toContain('(connected now)');
    expect(connection).toMatch(/<a href="#surfaces"[^>]*>Surfaces tab<\/a>/);
    expect(
      verdict('deferred', {
        decision: 'defer',
        reason: 'awaiting-connection',
        missingSurface: 'looker',
      }),
    ).toContain('looker is connected (not listed among the surfaces)');
    expect(verdict('deferred', { decision: 'defer', reason: 'awaiting-charter' })).toContain(
      'waiting for you to approve the charter; it is evaluated once you do.',
    );
  });

  it('points an item waiting on a skill at the Skills tab, and says why a cancelled one stopped', (): void => {
    const skill = verdict('needs-skill', {
      decision: 'needs-skill',
      suggestedSkillName: 'draft-tier-two-reply',
    });
    expect(skill).toContain('Waiting on a skill</span>: draft-tier-two-reply.');
    expect(skill).toContain('href="/agent/a-mira/skills"');
    expect(
      verdict(
        'cancelled',
        { decision: 'claim' },
        { skipReason: 'plan cancelled by the manager: comment instead' },
      ),
    ).toContain('Cancelled.</span> plan cancelled by the manager: comment instead');
  });

  it('says why a discovered item queued at the cap is not moving, and names any other verdict plainly', (): void => {
    expect(
      verdict('discovered', {
        decision: 'queue',
        reason: 'WIP cap reached: supervised cold-start limit is 1',
      }),
    ).toContain(
      'Queued.</span> Waiting for a free slot: WIP cap reached: supervised cold-start limit is 1.',
    );
    expect(verdict('deferred', { decision: 'defer', reason: 'awaiting-something-new' })).toContain(
      'Parked:</span> awaiting-something-new.',
    );
    expect(
      verdict('deferred', {
        decision: 'defer',
        reason: 'awaiting-permission',
        missingPermissions: [],
      }),
    ).toContain('Parked:</span> awaiting-permission.');
  });

  it('says nothing of an item moving on its own', (): void => {
    expect(verdict('plan-pending', { decision: 'claim' })).toBe('');
  });
});

describe("a working item's progress", (): void => {
  it('marks the part under way for assistive technology, and says nothing for a settled item', (): void => {
    const working = renderToStaticMarkup(
      <ProgressSection item={DRAWN.working} autonomous={false} />,
    );
    expect(working).toContain('>Reading and drafting</h4>');
    expect(working).toMatch(
      /<li aria-current="step"[^>]*>Read and draft<span class="sr-only">, under way<\/span><\/li>/,
    );
    expect(renderToStaticMarkup(<ProgressSection item={DRAWN.landed} autonomous={false} />)).toBe(
      '',
    );
  });
});
