import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DraftingNotice,
  draftingOutcome,
  draftingWords,
} from '../../../../../app/agent/[agentId]/one-to-one/DraftingNotice';

const refused = {
  kind: 'settled',
  outcome: { ok: false, late: false, reason: 'charter synthesis failed' },
} as const;

describe('what the room says while the charter drafts', (): void => {
  it('names what is happening and how long it usually takes', (): void => {
    expect(draftingWords('Mira', { kind: 'drafting' }, { kind: 'posting' })).toEqual({
      failed: false,
      lead: 'Drafting your charter, usually under a minute.',
      detail: 'Your answers are kept beside it, so you can re-read what you said while you review.',
    });
  });

  it('lets the session outrank a failed post the deployment is already retrying', (): void => {
    expect(
      draftingWords('Mira', { kind: 'drafting', retrying: 'model timed out' }, refused),
    ).toMatchObject({
      failed: false,
      detail: 'The last attempt did not finish, so Mira is trying again.',
    });
  });

  it('says a post refused before any session held it failed, and that nothing is lost', (): void => {
    expect(draftingWords('Mira', { kind: 'talking' }, refused)).toEqual({
      failed: true,
      lead: 'The charter could not be drafted: charter synthesis failed.',
      detail: 'Nothing you said is lost. Draft it again when you are ready.',
    });
  });

  it('says the draft failed for good once the session has, with both ways on', (): void => {
    const html = renderToStaticMarkup(
      <DraftingNotice
        name="Mira"
        phase={{ kind: 'failed', reason: 'model timed out' }}
        post={{ kind: 'idle' }}
        onDraftAgain={() => undefined}
        onHoldAgain={() => undefined}
      />,
    );
    expect(html).toMatch(/^<div tabindex="-1" data-drafting="failed"/);
    expect(html).toContain(
      'The charter could not be drafted: every attempt ended without a usable draft.',
    );
    expect(html).not.toContain('model timed out');
    expect(html).toMatch(/<button[^>]*>Draft again<\/button>/);
    expect(html).toMatch(/<button[^>]*>Hold the one-to-one again<\/button>/);
  });

  it('draws the drafting line with no control, the room saying it in its own status region', (): void => {
    const html = renderToStaticMarkup(
      <DraftingNotice
        name="Mira"
        phase={{ kind: 'drafting' }}
        post={{ kind: 'posting' }}
        onDraftAgain={() => undefined}
        onHoldAgain={() => undefined}
      />,
    );
    expect(html).toMatch(/^<div tabindex="-1" data-drafting="drafting"/);
    expect(
      draftingOutcome(draftingWords('Mira', { kind: 'drafting' }, { kind: 'posting' })),
    ).toEqual({
      tone: 'done',
      text: 'Drafting your charter, usually under a minute. Your answers are kept beside it, so you can re-read what you said while you review.',
    });
    expect(html).not.toContain('<button');
  });
});
