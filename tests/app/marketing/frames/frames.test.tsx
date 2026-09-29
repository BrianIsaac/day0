import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CharterFrame } from '../../../../app/marketing/frames/CharterFrame';
import { DocumentationFrame } from '../../../../app/marketing/frames/DocumentationFrame';
import { HeldWriteFrame } from '../../../../app/marketing/frames/HeldWriteFrame';
import { OneToOneFrame } from '../../../../app/marketing/frames/OneToOneFrame';

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the documentation frame', () => {
  const html = renderToStaticMarkup(<DocumentationFrame />);

  it('lists synced pages by source, one sequence step per row', () => {
    expect(text(html)).toContain('Documentation · 2 sources · 15 pages');
    expect(text(html)).toContain(
      'Revenue operations handbook Folder SYNCED'.replace('SYNCED', 'Synced'),
    );
    expect([...html.matchAll(/<tr data-seq=""/g)]).toHaveLength(3);
  });
});

describe('the one-to-one frame', () => {
  const html = renderToStaticMarkup(<OneToOneFrame />);

  it('shows the employee asking the first of seven questions and the manager answering', () => {
    expect(text(html)).toContain('Day-1 one-to-one · question 1 of 7');
    expect(text(html)).toContain('Your employee Why did the team hire me');
    expect(text(html)).toContain('You Small RevOps team drowning in tier-2 asks');
  });
});

describe('the charter frame', () => {
  const html = renderToStaticMarkup(<CharterFrame />);

  it('quotes the manager on the kept rule and strikes the derived one', () => {
    expect(text(html)).toContain('“there&#x27;s also Northstar CRM');
    expect(text(html)).toContain('in the charter as Access or execute work in Northstar CRM.');
    expect(html).toMatch(/<p data-seq="strike" class="[^"]*line-through[^"]*">Take ownership/);
    expect(text(html)).toContain('derived by your employee · struck by you');
    expect(text(html)).toContain('Confirmed');
    expect(text(html)).toContain('Struck');
  });
});

describe('the held-write frame', () => {
  const html = renderToStaticMarkup(<HeldWriteFrame />);

  it('shows the exact held comment, that nothing has landed, and the product’s own two controls', () => {
    expect(text(html)).toContain('1 action is waiting for you Comment on LOG-2 in Linear');
    expect(text(html)).toContain('Carrier: Meridian Freight; revised ETA: 26 September');
    expect(text(html)).toContain('Nothing has reached a surface.');
    expect(html).toMatch(/<div data-seq="" style="--i:5" aria-hidden="true"/);
    expect(text(html)).toContain('Approve all Reject run');
    expect(html).not.toContain('<button');
  });
});
