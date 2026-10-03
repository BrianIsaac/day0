import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import {
  ProgressSection,
  refusedSkillsOf,
  VerdictSection,
  type ItemVerdict,
  type RefusedSkill,
} from '../../../../../app/agent/[agentId]/work/VerdictSection';
import { AT, DRAWN, SURFACES } from '../../../../fixtures/work/drawn-states';

function verdict(
  state: Doc<'workItems'>['state'],
  value: ItemVerdict,
  fields = {},
  refusedSkill?: RefusedSkill,
): string {
  const item = { ...DRAWN.planPending, state, verdict: value, ...fields } as Doc<'workItems'>;
  return renderToStaticMarkup(
    <VerdictSection
      item={item}
      verdict={value}
      surfaces={SURFACES}
      now={AT}
      {...(refusedSkill === undefined ? {} : { refusedSkill })}
    />,
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
    const reasoned = verdict('needs-skill', {
      decision: 'needs-skill',
      suggestedSkillName: 'linear-update-issue',
      reason:
        'no registered skill covers ticket update on a kanban surface; agent will propose "linear-update-issue"',
    });
    expect(reasoned).toContain(
      ': linear-update-issue. No registered skill covers ticket update on a kanban surface. <a',
    );
    expect(reasoned).not.toContain('will propose');
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

describe("an item whose skill's draft failed Day0's check (D3 (b), a product call)", (): void => {
  const waiting: ItemVerdict = {
    decision: 'needs-skill',
    reason: 'the authored skill is not a reusable procedure: it names REVOPS-204',
  };

  it('says the draft failed its check, that nothing retries it on its own, and links to its Retry', (): void => {
    const markup = verdict(
      'needs-skill',
      waiting,
      {},
      {
        skillId: 'skill-1',
        name: 'kanban-comment-and-close',
        retryable: true,
      },
    );
    expect(markup).toContain(
      'Waiting on a skill</span>: kanban-comment-and-close. Its draft failed Day0&#x27;s check, and nothing tries it again on its own: ',
    );
    expect(markup).toMatch(
      /<a [^>]*href="\/agent\/a-mira\/skills#skill-skill-1"[^>]*>Retry it on the Skills tab<\/a>\./,
    );
    expect(markup).not.toContain('holds the proposal');
  });

  it('says Retry is spent after the last attempt, and links to the skill on the Skills tab', (): void => {
    const markup = verdict(
      'needs-skill',
      waiting,
      {},
      {
        skillId: 'skill-1',
        name: 'kanban-comment-and-close',
        retryable: false,
      },
    );
    expect(markup).toContain('Its draft failed Day0&#x27;s check on every attempt: ');
    expect(markup).toMatch(
      /<a [^>]*href="\/agent\/a-mira\/skills#skill-skill-1"[^>]*>The Skills tab<\/a> offers Give up\./,
    );
  });

  it('reads the failed skills by id, with whether Retry is still offered', (): void => {
    const refused = refusedSkillsOf([
      { _id: 'skill-1', name: 'kanban-comment-and-close', state: 'failed', authoringAttempts: 1 },
      { _id: 'skill-2', name: 'chat-thread-reply', state: 'failed', authoringAttempts: 3 },
    ]);
    expect(refused.get('skill-1')).toEqual({
      skillId: 'skill-1',
      name: 'kanban-comment-and-close',
      retryable: true,
    });
    expect(refused.get('skill-2')?.retryable).toBe(false);
  });
});
