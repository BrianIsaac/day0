import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  agentIdFromUrl,
  APPROVE_CARD,
  ASK_AGAIN,
  COMPLETE_LINE,
  REPLY_PLACEHOLDER,
  TAKE_IT_ANYWAY,
} from '../../../../scripts/bed/rehearsal/driver';

const DASHBOARD = readFileSync('app/agent/[agentId]/AgentDashboard.tsx', 'utf8');
const CHAT = readFileSync('app/agent/[agentId]/ChatRoom.tsx', 'utf8');
const SURFACES = readFileSync('app/agent/[agentId]/mock/SurfacesTab.tsx', 'utf8');
const DOCUMENTATION = readFileSync('app/documentation/DocumentationPage.tsx', 'utf8');
const LANDING = readFileSync('app/page.tsx', 'utf8');
const DRIVER = readFileSync('scripts/bed/rehearsal/driver.ts', 'utf8');

describe('the dashboard driver', (): void => {
  it('reads the agent id out of the agent page URL', (): void => {
    expect(agentIdFromUrl('http://localhost:45213/agent/j57bs4z36f3dp3qt4kne7sqwqh8dn9ns')).toBe(
      'j57bs4z36f3dp3qt4kne7sqwqh8dn9ns',
    );
    expect(agentIdFromUrl('http://localhost:45213/agent/abc#surfaces')).toBe('abc');
    expect(() => agentIdFromUrl('http://localhost:45213/')).toThrow('not an agent page');
  });

  it('asks a failed turn again instead of answering a question nobody put', (): void => {
    // A failed turn opens the composer too, so waiting for the composer alone
    // would type the next scripted answer under an empty or half-said turn.
    expect(CHAT).toMatch(new RegExp(`>\\s*${ASK_AGAIN}\\s*</button>`));
    const wait = DRIVER.slice(
      DRIVER.indexOf('async waitForAgentTurn'),
      DRIVER.indexOf('async sendReply'),
    );
    expect(wait).toContain('name: ASK_AGAIN');
    expect(wait.indexOf('name: ASK_AGAIN')).toBeLessThan(wait.indexOf('composer.isEnabled()'));
  });

  it('hands a skipped ticket back with the control a skipped card renders, not a Retry it no longer has', (): void => {
    expect(DASHBOARD).toContain(`export const TAKE_IT_ANYWAY = '${TAKE_IT_ANYWAY}';`);
    const takeAnyway = DRIVER.slice(
      DRIVER.indexOf('async takeAnyway'),
      DRIVER.indexOf('async cancelPlan'),
    );
    expect(takeAnyway).toContain('name: TAKE_IT_ANYWAY, exact: true');
    expect(DRIVER).not.toContain("name: 'Retry', exact: true");
  });

  it('approves a surface card with its one Approve and waits for the verdict to leave proposed (Q10)', (): void => {
    const approveCard = DRIVER.slice(
      DRIVER.indexOf('async approveCard'),
      DRIVER.indexOf('private workCard'),
    );
    expect(approveCard).toContain('name: APPROVE_CARD, exact: true');
    expect(approveCard).toContain(':not([data-verdict="proposed"])');
    expect(approveCard).toContain("getByRole('alert')");
    expect(DRIVER).not.toMatch(/Approve as (manager|IT)/);
    expect(SURFACES).not.toMatch(/Approve as (manager|IT)/);
  });

  it("clicks the dashboard's own control texts, so a copy change here fails before a run does", (): void => {
    expect(CHAT).toContain(`'${REPLY_PLACEHOLDER}'`);
    expect(CHAT).toContain(COMPLETE_LINE);
    expect(DASHBOARD).toMatch(/>\s*Chat\s*<\/button>/);
    for (const [file, text] of [
      [DASHBOARD, 'Approve · author and verify'],
      [DASHBOARD, 'Approve plan'],
      [DASHBOARD, 'Approve all'],
      [SURFACES, `export const APPROVE_CARD = '${APPROVE_CARD}';`],
      [SURFACES, 'data-verdict={surface.verdict}'],
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
      'name: APPROVE_CARD, exact: true',
      ':not([data-verdict="proposed"])',
      'article#surface-',
      'input[id^="credential-"]',
      "'Location label'",
      "'Link location'",
      "'worker 1'",
    ]) {
      expect(DRIVER).toContain(selector);
    }
  });
});
