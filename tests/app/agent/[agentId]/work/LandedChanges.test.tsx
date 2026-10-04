import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  LandedChanges,
  NotSentLedger,
  notSentWords,
} from '../../../../../app/agent/[agentId]/work/LandedChanges';

const row = (place: number, effect: string) => ({
  tool: 'linear.save_comment',
  ok: true,
  effect,
  place,
});

describe('what reached the work environment', (): void => {
  it('leads with the green line and who decided, then a line per landed row with its tool', (): void => {
    const markup = renderToStaticMarkup(
      <LandedChanges
        rows={[row(0, 'Commented on REVOPS-5')]}
        fresh={new Set()}
        decided="approved from Slack"
      />,
    );
    expect(markup).toContain('1 action reached the work environment</span> · approved from Slack');
    expect(markup).toContain('<span class="sr-only">Landed: </span>Commented on REVOPS-5');
    // The words say what happened; the transport's name is not repeated beneath them.
    expect(markup).not.toContain('linear.save_comment');
    expect(markup).not.toContain('data-land');
  });

  it('names a landed row by its tool when it carries no effect of its own', (): void => {
    const markup = renderToStaticMarkup(
      <LandedChanges
        rows={[{ tool: 'linear.save_issue', ok: true, place: 0 }]}
        fresh={new Set()}
      />,
    );
    expect(markup).toContain('Applied linear.save_issue');
  });

  it('sets the small print’s parts apart, never run together (the 12-W bed)', (): void => {
    const markup = renderToStaticMarkup(
      <LandedChanges
        rows={[
          {
            ...row(0, 'Posted the first update'),
            providerId: '1787817600.000001',
            reusedFrom: 'w:run:0',
            reusedFromRun: 1,
          },
        ]}
        fresh={new Set()}
      />,
    );
    expect(markup.replace(/<[^>]+>/g, '')).toContain('id 1787817600.000001 · reused from run 1');
  });

  it('raises only the rows that just landed, beneath the rows already there (M7)', (): void => {
    const markup = renderToStaticMarkup(
      <LandedChanges
        rows={[row(0, 'Read REVOPS-5'), row(2, 'Commented'), row(3, 'Moved to Done')]}
        fresh={new Set([2, 3])}
      />,
    );
    const landing = markup.slice(markup.indexOf('data-land'));
    expect(landing).toContain('Commented');
    expect(landing).not.toContain('Read REVOPS-5');
    expect(landing.match(/--i:\d/g)).toEqual(['--i:0', '--i:1']);
  });

  it('settles a first landing as a whole, headline and all', (): void => {
    const markup = renderToStaticMarkup(
      <LandedChanges rows={[row(0, 'Commented')]} fresh={new Set([0])} />,
    );
    expect(markup).toMatch(/^<div data-land=""[^>]*><p[^>]*>.*reached the work environment/);
  });
});

describe('what was held and never sent', (): void => {
  it('says why each row was not sent: withheld by the manager, rejected with the run, or held', (): void => {
    expect(notSentWords('not approved by the manager')).toBe(
      'withheld by you; never sent, kept in the record',
    );
    expect(notSentWords('rejected by the manager: no')).toBe('rejected with the run; never sent');
    expect(notSentWords('no grant')).toBe('held: no grant; never sent');
    const markup = renderToStaticMarkup(
      <NotSentLedger
        rows={[
          {
            tool: 'slack.postMessage',
            ok: false,
            held: true,
            effect: 'DM to you',
            reason: 'not approved by the manager',
          },
        ]}
      />,
    );
    expect(markup).toContain('<span class="sr-only">Not sent: </span>DM to you');
    expect(renderToStaticMarkup(<NotSentLedger rows={[]} />)).toBe('');
  });
});
