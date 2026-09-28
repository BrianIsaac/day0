import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOSTED_DEMO_NOTICE } from '../../../src/demo/hosted-notice';

const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

/** The README's "Who receives what" sentence for the hosted demo, up to where real mode starts. */
function readmeHostedSentence(): string {
  const match = /Who receives what\. (On the hosted demo, .+?\.) In real mode/.exec(README);
  if (!match) throw new Error('the README no longer has its "Who receives what" hosted sentence');
  return match[1]!;
}

/** Every recipient either text could name: the services the product reaches or could reach. */
const CANDIDATES = [
  'Clerk',
  'Vercel',
  'Convex',
  'model provider',
  'Daytona',
  'ElevenLabs',
  'MCP Registry',
  'Featherless',
  'OpenAI',
  'Notion',
  'Linear',
  'Slack',
] as const;

const notice = [HOSTED_DEMO_NOTICE.heading, ...HOSTED_DEMO_NOTICE.paragraphs].join(' ');

describe('the hosted-demo notice (N6)', () => {
  it('names exactly the recipients the README names for the hosted demo', () => {
    const hosted = readmeHostedSentence();
    const named = (text: string): string[] => CANDIDATES.filter((name) => text.includes(name));
    expect(named(notice)).toEqual(named(hosted));
    expect(named(hosted)).toEqual([
      'Clerk',
      'Vercel',
      'Convex',
      'model provider',
      'Daytona',
      'ElevenLabs',
    ]);
  });

  it('says the voice provider receives the email address, as the README does', () => {
    expect(readmeHostedSentence()).toContain("ElevenLabs with the manager's email address");
    expect(notice).toContain('ElevenLabs with your email address');
  });

  it('links the README disclosures for the whole account', () => {
    expect(HOSTED_DEMO_NOTICE.link.href).toBe('https://github.com/BrianIsaac/day0#disclosures');
    expect(README).toContain('## Disclosures');
  });

  it('promises nothing the README does not: no retention period, no registry lookup', () => {
    expect(notice).not.toMatch(/kept longer|retain|deleted after|MCP Registry/i);
  });
});
