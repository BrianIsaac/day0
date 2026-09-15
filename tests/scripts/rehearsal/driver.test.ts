import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentIdFromUrl, COMPLETE_LINE, REPLY_PLACEHOLDER } from '../../../scripts/rehearsal/driver';

const DASHBOARD = readFileSync('app/agent/[agentId]/AgentDashboard.tsx', 'utf8');
const CHAT = readFileSync('app/agent/[agentId]/ChatRoom.tsx', 'utf8');
const SURFACES = readFileSync('app/agent/[agentId]/mock/SurfacesTab.tsx', 'utf8');
const DOCUMENTATION = readFileSync('app/documentation/DocumentationPage.tsx', 'utf8');
const LANDING = readFileSync('app/page.tsx', 'utf8');
const DRIVER = readFileSync('scripts/rehearsal/driver.ts', 'utf8');

describe('the dashboard driver', (): void => {
  it('reads the agent id out of the agent page URL', (): void => {
    expect(agentIdFromUrl('http://localhost:45213/agent/j57bs4z36f3dp3qt4kne7sqwqh8dn9ns')).toBe(
      'j57bs4z36f3dp3qt4kne7sqwqh8dn9ns',
    );
    expect(agentIdFromUrl('http://localhost:45213/agent/abc#surfaces')).toBe('abc');
    expect(() => agentIdFromUrl('http://localhost:45213/')).toThrow('not an agent page');
  });

  it("clicks the dashboard's own control texts, so a copy change here fails before a run does", (): void => {
    expect(CHAT).toContain(`'${REPLY_PLACEHOLDER}'`);
    expect(CHAT).toContain(COMPLETE_LINE);
    expect(DASHBOARD).toMatch(/>\s*Chat\s*<\/button>/);
    for (const [file, text] of [
      [DASHBOARD, 'Approve · author and verify'],
      [DASHBOARD, 'Approve plan'],
      [DASHBOARD, 'Approve all'],
      [DASHBOARD, 'aria-label="note for the retry"'],
      [SURFACES, 'Approve as manager'],
      [SURFACES, 'Approve as IT'],
      [SURFACES, 'id={`surface-${surface.slug}`}'],
      [SURFACES, 'id={`credential-${props.credentialLabel}`}'],
      [DOCUMENTATION, 'placeholder="Location label"'],
      [DOCUMENTATION, 'Link location'],
      [LANDING, 'placeholder="worker 1"'],
      [CHAT, 'Day-1 1:1 · chat mode'],
    ] as const) {
      expect(file).toContain(text);
    }
    for (const selector of [
      "'Approve · author and verify'",
      "'Approve plan'",
      "'Approve all'",
      "'Approve as manager'",
      "'Approve as IT'",
      'article#surface-',
      'input[id^="credential-"]',
      "'Location label'",
      "'Link location'",
      "'worker 1'",
      "'note for the retry'",
    ]) {
      expect(DRIVER).toContain(selector);
    }
  });
});
