import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DraftingNotice,
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
      detail: 'The last attempt did not finish (model timed out), so Mira is trying again.',
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
    expect(html).toMatch(/^<div role="alert"/);
    expect(html).toContain('The charter could not be drafted: model timed out.');
    expect(html).toMatch(/<button[^>]*>Draft again<\/button>/);
    expect(html).toMatch(/<button[^>]*>Hold the one-to-one again<\/button>/);
  });

  it('draws the drafting line as a status, not an alert', (): void => {
    const html = renderToStaticMarkup(
      <DraftingNotice
        name="Mira"
        phase={{ kind: 'drafting' }}
        post={{ kind: 'posting' }}
        onDraftAgain={() => undefined}
        onHoldAgain={() => undefined}
      />,
    );
    expect(html).toMatch(/^<p role="status"/);
    expect(html).not.toContain('<button');
  });
});
