import { describe, expect, it } from 'vitest';
import { pageLinkFromQuote } from '../../../src/surfaces/evidence';

describe('evidence page links', (): void => {
  it('reads a whole-quote index tag as a titled link', (): void => {
    expect(
      pageLinkFromQuote('<page url="https://app.notion.com/p/3c7a382da0a080968de5fd7bf18e5f21">Linear Automation</page>'),
    ).toEqual({ url: 'https://app.notion.com/p/3c7a382da0a080968de5fd7bf18e5f21', title: 'Linear Automation' });
    expect(pageLinkFromQuote('- <page url="https://n.example/p/1">  Slack  automation policy </page>\n')).toEqual({
      url: 'https://n.example/p/1',
      title: 'Slack automation policy',
    });
    expect(pageLinkFromQuote('<page url="https://n.example/p/1"></page>')).toEqual({
      url: 'https://n.example/p/1',
      title: 'https://n.example/p/1',
    });
  });

  it('leaves every other quote untouched', (): void => {
    expect(pageLinkFromQuote('# Linear automation')).toBeUndefined();
    expect(pageLinkFromQuote('See <page url="https://n.example/p/1">Linear</page> for the token.')).toBeUndefined();
    expect(pageLinkFromQuote('<page url="javascript:alert(1)">Linear</page>')).toBeUndefined();
    expect(pageLinkFromQuote('<page url="https://n.example/p/1">Linear</page> <page url="https://n.example/p/2">Slack</page>')).toBeUndefined();
    expect(pageLinkFromQuote(undefined)).toBeUndefined();
    expect(pageLinkFromQuote('')).toBeUndefined();
  });
});
