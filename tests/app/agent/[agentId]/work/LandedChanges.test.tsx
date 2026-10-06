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

  it('says a row reused from this run’s first phase was already sent in this run (W12V-13)', (): void => {
    const markup = renderToStaticMarkup(
      <LandedChanges
        rows={[
          {
            ...row(0, 'Sent you a DM in Slack'),
            providerId: '1791151039.077839',
            idempotencyKey: 'w:run2:3',
            reusedFrom: 'w:run2:0',
            reusedFromRun: 2,
          },
        ]}
        fresh={new Set()}
      />,
    );
    const text = markup.replace(/<[^>]+>/g, '');
    expect(text).toContain('id 1791151039.077839 · already sent earlier in this run');
    expect(text).not.toContain('reused from run 2');
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

describe('a documented-API write that landed (12-J item 5c, wave 13 item 5)', (): void => {
  it('reads the line the card wrote from the action, the provider’s status in the small print, never its raw answer', (): void => {
    const markup = renderToStaticMarkup(
      <LandedChanges
        rows={[
          {
            tool: 'http.request',
            ok: true,
            place: 0,
            effect: 'HTTP 200 · {"ok":true,"channel":"C0BSQTE1H7E","ts":"1791181288.687059"}',
            providerId: '1791181288.687059',
            summary: 'Post to Slack channel <#C0BSQTE1H7E>: “Close week, note 1 of 2”',
          },
        ]}
        fresh={new Set()}
      />,
    );
    const text = markup.replace(/<[^>]+>/g, '');
    expect(text).toContain(
      'Landed: Post to Slack channel &lt;#C0BSQTE1H7E&gt;: “Close week, note 1 of 2”',
    );
    expect(text).toContain('id 1791181288.687059');
    // The transport's status is not the manager's: the second pass dropped it from the small print.
    expect(text).not.toContain('HTTP 200');
    expect(text).not.toContain('{&quot;ok&quot;:true');
  });
});
