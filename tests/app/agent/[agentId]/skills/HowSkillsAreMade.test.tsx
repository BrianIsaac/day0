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
      'It registers only once the check passes; a draft that fails stays on this tab with the reason, and Retry feeds the reason back.',
    ]);
    expect(html).toContain('Retry waits while one is running and opens once it finishes');
  });
});
