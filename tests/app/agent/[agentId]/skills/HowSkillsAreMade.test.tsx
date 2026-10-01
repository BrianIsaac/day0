import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HowSkillsAreMade } from '../../../../../app/agent/[agentId]/skills/HowSkillsAreMade';

describe('HowSkillsAreMade', (): void => {
  it('sets out the three steps in order, naming the employee, and the one-run rule', (): void => {
    const html = renderToStaticMarkup(<HowSkillsAreMade name="Mira" />);
    expect(html).toContain('>How a skill is made</h2>');
    const steps = [...html.matchAll(/<li>(.*?)<\/li>/g)].map((step) => step[1]);
    expect(steps).toEqual([
      'Mira proposes one when work needs it, naming the item.',
      'You approve; Mira writes it and checks it with a smoke test in a sandbox.',
      'It registers only once the check passes; a draft that fails stays on this tab with the reason, and Retry feeds the reason back, for up to 3 attempts.',
    ]);
    expect(html).toContain('Retry waits while one is running and opens once it finishes');
  });

  it('says a registered skill keeps running while it is re-checked or revised, and what Retire and Withdraw reach (10-C)', (): void => {
    const html = renderToStaticMarkup(<HowSkillsAreMade name="Mira" />);
    expect(html).toContain(
      'A registered skill keeps running while it is revised, and while it is re-checked unless the check fails. Retire takes it from Mira alone; when other employees run the same version, the same dialog can withdraw it from all of them.',
    );
  });

  it('says a colleague’s verified skill can be adopted instead, and is checked again first (A-m9)', (): void => {
    const html = renderToStaticMarkup(<HowSkillsAreMade name="Mira" />);
    expect(html).toContain(
      'When another of your employees already has a verified skill that does the same job, Mira can adopt it instead: one approval, and the sandbox checks it again for Mira before it runs.',
    );
  });
});
