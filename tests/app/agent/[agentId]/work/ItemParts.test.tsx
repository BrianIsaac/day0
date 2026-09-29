import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Help,
  ItemFoot,
  ItemSection,
  Lead,
  Note,
  Quote,
  Tag,
} from '../../../../../app/agent/[agentId]/work/ItemParts';

describe('the parts a work item is drawn from', (): void => {
  it('sets a section under a hairline with its muted heading, and the held writes on the warn ground', (): void => {
    const plain = renderToStaticMarkup(<ItemSection title="Plan">steps</ItemSection>);
    expect(plain).toMatch(/<h4[^>]*>Plan<\/h4>steps/);
    expect(plain).toContain('border-[var(--color-border)]');
    const held = renderToStaticMarkup(<ItemSection tone="warn">held</ItemSection>);
    expect(held).toContain('bg-[var(--color-warn-soft)]');
    expect(held).not.toContain('<h4');
  });

  it('says the consequence beneath the controls, on a line of its own', (): void => {
    const foot = renderToStaticMarkup(
      <ItemFoot why="Approving runs the plan.">
        <button type="button">Approve plan</button>
      </ItemFoot>,
    );
    expect(foot).toMatch(
      /Approve plan<\/button><p class="basis-full[^"]*">Approving runs the plan\.<\/p>/,
    );
  });

  it('draws a note on its tone and never on the danger fill', (): void => {
    for (const tone of ['plain', 'ok', 'accent', 'warn'] as const) {
      const note = renderToStaticMarkup(
        <Note tone={tone}>
          <Lead>Skipped.</Lead> Out of scope.
        </Note>,
      );
      expect(note).toMatch(/^<p /);
      expect(note).not.toContain('danger');
    }
    expect(renderToStaticMarkup(<Note tone="ok">x</Note>)).toContain('bg-[var(--color-ok-soft)]');
  });

  it('marks up help, a tag and a quotation as what they are', (): void => {
    expect(renderToStaticMarkup(<Help id="h">Optional.</Help>)).toBe(
      '<p id="h" class="text-[13px] text-[var(--color-muted)]">Optional.</p>',
    );
    expect(renderToStaticMarkup(<Tag>slack · inbox</Tag>)).toContain('>slack · inbox</span>');
    expect(renderToStaticMarkup(<Quote>Can you take this?</Quote>)).toMatch(
      /^<q [^>]*>Can you take this\?<\/q>$/,
    );
  });
});
