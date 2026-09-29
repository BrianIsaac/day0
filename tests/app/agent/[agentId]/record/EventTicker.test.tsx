import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventTicker } from '../../../../../app/agent/[agentId]/record/EventTicker';

describe('EventTicker', (): void => {
  it('says the feed is loading, then that it has no events, then lists them', (): void => {
    expect(renderToStaticMarkup(<EventTicker events={undefined} titles={new Map()} />)).toContain(
      'loading the feed…',
    );
    expect(renderToStaticMarkup(<EventTicker events={[]} titles={new Map()} />)).toContain(
      'no events yet',
    );
  });
});
