/**
 * The manager's hands: every approval the rehearsal makes goes through the
 * real dashboard in a real browser, the way the operator does it, and the
 * screenshots are taken from that same page. The interface is what the phases
 * depend on; the Playwright class is the one implementation.
 */
import type { Browser, Locator, Page } from 'playwright';

/** What the phases ask of the dashboard. */
export interface Dashboard {
  /** Open the unlock URL once, which sets the no-auth cookie for this browser. */
  unlock(url: string): Promise<void>;
  /** Link a folder source on the documentation page. */
  linkFolder(label: string, locator: string): Promise<void>;
  /** Deploy an agent from the landing page and return its id. */
  deploy(name: string): Promise<string>;
  /** Pick chat for the Day-1 1:1. */
  chooseChat(): Promise<void>;
  /** Wait for the composer to open for a reply, or the closing line. */
  waitForAgentTurn(timeoutMs: number): Promise<'reply' | 'complete'>;
  /** Send one reply in the 1:1. */
  sendReply(text: string): Promise<void>;
  /** The agent's last message in the 1:1, for the record. */
  lastAgentMessage(): Promise<string>;
  /** Approve the drafted charter. */
  approveCharter(): Promise<void>;
  /** Open the Surfaces tab of the employee page. */
  openSurfaces(): Promise<void>;
  /** Type a credential into a card's landing form and submit it. */
  landCredential(slug: string, value: string): Promise<void>;
  /** Approve a proposed card with its one approval and wait until it is no longer proposed. */
  approveCard(slug: string): Promise<void>;
  /** Approve a proposed skill by name. */
  approveSkill(name: string): Promise<void>;
  /** Approve the drafted plan on a work item card. */
  approvePlan(title: string): Promise<void>;
  /** Approve every held action on a work item card. */
  approveAll(title: string): Promise<void>;
  /** Hand a skipped item back to the agent from its card, waiving the skip. */
  takeAnyway(title: string): Promise<void>;
  /** Cancel the plan on another item's card. */
  cancelPlan(title: string): Promise<void>;
  /** Open one tab of the employee page, unless it is open already. */
  showTab(tab: EmployeeTabSegment): Promise<void>;
  /** A full-page screenshot to a path. */
  screenshot(path: string): Promise<void>;
  /** Close the browser. */
  close(): Promise<void>;
}

/**
 * The tabs of the employee page, as their route segments. The driver cannot read the page's own
 * list (scripts never import `app/`), so the rendered test pins this copy to it.
 */
export const EMPLOYEE_TAB_SEGMENTS = [
  'needs-you',
  'work',
  'charter',
  'people',
  'documentation',
  'skills',
  'surfaces',
  'record',
  'manage',
] as const;

/** One tab of the employee page. */
export type EmployeeTabSegment = (typeof EMPLOYEE_TAB_SEGMENTS)[number];

/**
 * The address of one tab of an employee's page: Needs you is the page itself.
 *
 * @param agentId - The employee.
 * @param tab - The tab.
 */
export function tabPath(agentId: string, tab: EmployeeTabSegment): string {
  return tab === 'needs-you' ? `/agent/${agentId}` : `/agent/${agentId}/${tab}`;
}

/** The charter's approval, "Approve charter" or, with rules struck, "Approve charter, N rules struck". */
export const APPROVE_CHARTER = /^Approve charter\b/;
/** A drafted plan's approval: "Approve plan", or "Approve plan with answers" once it asks anything. */
export const APPROVE_PLAN = /^Approve plan( with answers)?$/;
/** Every held action's approval on a work item. */
export const APPROVE_ALL = 'Approve all';
/** A proposed skill's approval. */
export const APPROVE_SKILL = 'Approve · author and verify';
/** The control that opens a plan's cancellation, and the one that sends it with no reason. */
export const CANCEL_ITEM = 'Cancel this item';
export const CANCEL_WITHOUT_REASON = 'Cancel without a reason';
/** The prefix a screen reader hears before each of the employee's turns in the 1:1's log. */
export const EMPLOYEE_TURN = 'Employee: ';
/** The credential field a card draws once it is approved. */
export const CREDENTIAL_INPUT = 'input[id^="credential-"]';

/**
 * The selector of one surface's card: the card carries the surface's slug as its id and its
 * verdict as `data-verdict`.
 *
 * @param slug - The surface's slug.
 */
export function surfaceCard(slug: string): string {
  return `#surface-${slug}`;
}

/**
 * The employee's last turn in the 1:1's log, without the prefix only a screen reader hears.
 *
 * @param turns - The text of each of the log's turns, in order.
 * @returns The turn, or an empty string when the employee has not spoken yet.
 */
export function lastEmployeeTurn(turns: readonly string[]): string {
  const last = [...turns].reverse().find((turn) => turn.startsWith(EMPLOYEE_TURN));
  return last === undefined ? '' : last.slice(EMPLOYEE_TURN.length).trim();
}

/** The chat composer's placeholder while the manager may type. */
export const REPLY_PLACEHOLDER = 'type your reply…';
/** The line the chat shows once the seventh topic is answered. */
export const COMPLETE_LINE = 'conversation complete';
/** The control a failed turn (empty, cut off, or a stream error) offers in the 1:1. */
export const ASK_AGAIN = 'Ask again';
/** The control a skipped card offers in place of Retry, for a skip the manager may waive. */
export const TAKE_IT_ANYWAY = 'Take it anyway';
/** The one control that approves a proposed surface card (Q10). */
export const APPROVE_CARD = 'Approve';
/** How long an approved card may take to leave `proposed` on the page. */
const APPROVAL_WAIT_MS = 30_000;
/** How many failed turns one wait asks again before the 1:1 is judged stuck. */
const MAX_ASK_AGAIN = 3;

/**
 * The agent id out of the agent page's URL.
 *
 * Args:
 *   url: The page URL after deploy.
 *
 * Returns:
 *   The id.
 *
 * Raises:
 *   Error: When the URL is not an agent page.
 */
export function agentIdFromUrl(url: string): string {
  const match = /\/agent\/([^/?#]+)/.exec(url);
  if (!match) throw new Error(`not an agent page: ${url}`);
  return match[1];
}

const ACTION_TIMEOUT_MS = 30_000;

/** The dashboard driven by Playwright's bundled Chromium. */
export class PlaywrightDashboard implements Dashboard {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly origin: string,
  ) {}

  /**
   * Launch the browser and open one page.
   *
   * Args:
   *   origin: The app's origin, `http://localhost:<port>`.
   *   headed: Show the browser window instead of running headless.
   *
   * Returns:
   *   The dashboard.
   */
  static async open(origin: string, headed = false): Promise<PlaywrightDashboard> {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: !headed });
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    const page = await context.newPage();
    return new PlaywrightDashboard(browser, page, origin);
  }

  private agentId?: string;

  async unlock(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'networkidle' });
    await this.page.goto(`${this.origin}/`, { waitUntil: 'networkidle' });
    await this.page.getByPlaceholder('worker 1').waitFor();
  }

  async linkFolder(label: string, locator: string): Promise<void> {
    await this.page.goto(`${this.origin}/documentation`, { waitUntil: 'networkidle' });
    const form = this.page.locator('form', { has: this.page.getByPlaceholder('Location label') });
    await form.locator('select').first().selectOption('folder');
    await form.getByPlaceholder('Location label').fill(label);
    await form.locator('textarea').fill(locator);
    await form.getByRole('button', { name: 'Link location' }).click();
    await this.page.getByText(label, { exact: false }).first().waitFor();
  }

  async deploy(name: string): Promise<string> {
    await this.page.goto(`${this.origin}/`, { waitUntil: 'networkidle' });
    await this.page.getByPlaceholder('worker 1').fill(name);
    await this.page.getByRole('button', { name: 'Deploy', exact: true }).click();
    await this.page.waitForURL(/\/agent\//, { timeout: 60_000 });
    this.agentId = agentIdFromUrl(this.page.url());
    return this.agentId;
  }

  async chooseChat(): Promise<void> {
    await this.page.getByRole('button', { name: 'Chat', exact: true }).click();
    await this.page.getByText('Day-1 1:1 · chat mode').waitFor();
  }

  async waitForAgentTurn(timeoutMs: number): Promise<'reply' | 'complete'> {
    const composer = this.page.getByPlaceholder(REPLY_PLACEHOLDER);
    const complete = this.page.getByText(COMPLETE_LINE, { exact: false }).first();
    const askAgain = this.page.getByRole('button', { name: ASK_AGAIN, exact: true });
    const deadline = Date.now() + timeoutMs;
    let asked = 0;
    while (Date.now() < deadline) {
      if (await complete.isVisible()) return 'complete';
      // A failed turn opens the composer as well, so it is checked first: the
      // manager asks again, and does not answer a question that was never put.
      if (await askAgain.isVisible()) {
        if (asked === MAX_ASK_AGAIN)
          throw new Error(`the 1:1 failed a turn ${MAX_ASK_AGAIN + 1} times running`);
        asked += 1;
        await askAgain.click();
        continue;
      }
      if ((await composer.count()) > 0 && (await composer.isEnabled())) return 'reply';
      await this.page.waitForTimeout(500);
    }
    throw new Error(
      `the 1:1 neither opened the composer nor completed within ${timeoutMs / 1000} s`,
    );
  }

  async sendReply(text: string): Promise<void> {
    const composer = this.page.getByPlaceholder(REPLY_PLACEHOLDER);
    await composer.fill(text);
    await this.page.getByRole('button', { name: 'Send', exact: true }).click();
    await composer
      .and(this.page.locator(':disabled'))
      .waitFor({ state: 'attached', timeout: 10_000 })
      // A reply fast enough to re-enable the composer first is never seen disabled; the next wait reads the turn.
      .catch(() => undefined);
  }

  async lastAgentMessage(): Promise<string> {
    const turns = await this.page.getByRole('log').locator(':scope > div').allTextContents();
    return lastEmployeeTurn(turns);
  }

  async approveCharter(): Promise<void> {
    await this.showTab('charter');
    await this.page.getByRole('button', { name: APPROVE_CHARTER }).click();
  }

  async openSurfaces(): Promise<void> {
    await this.showTab('surfaces');
    await this.page.locator('[id^="surface-"][data-verdict]').first().waitFor();
  }

  private card(slug: string): Locator {
    return this.page.locator(surfaceCard(slug));
  }

  async landCredential(slug: string, value: string): Promise<void> {
    const card = this.card(slug);
    const input = card.locator(CREDENTIAL_INPUT);
    await input.fill(value);
    await card.getByRole('button', { name: /Land/ }).click();
    await input.waitFor({ state: 'detached', timeout: 60_000 });
  }

  async approveCard(slug: string): Promise<void> {
    const card = this.card(slug);
    const approve = card.getByRole('button', { name: APPROVE_CARD, exact: true });
    // A card the server would refuse draws Approve disabled with the reason as its description.
    if (await approve.isDisabled()) {
      const reason = await approve.getAttribute('aria-describedby');
      const words = reason ? await this.page.locator(`[id="${reason}"]`).textContent() : null;
      throw new Error(`the ${slug} card cannot be approved: ${words ?? 'no reason drawn'}`);
    }
    await approve.click();
    const approved = this.page.locator(`${surfaceCard(slug)}:not([data-verdict="proposed"])`);
    const refused = card.getByRole('alert');
    await approved.or(refused).first().waitFor({ timeout: APPROVAL_WAIT_MS });
    if (await refused.isVisible()) {
      throw new Error(`the ${slug} card was not approved: ${(await refused.textContent()) ?? ''}`);
    }
  }

  private workCard(title: string): Locator {
    return this.page.getByRole('article', { name: title, exact: true });
  }

  async approveSkill(name: string): Promise<void> {
    await this.showTab('skills');
    const skill = this.page
      .getByRole('listitem')
      .filter({ has: this.page.getByText(name, { exact: true }) });
    await skill.getByRole('button', { name: APPROVE_SKILL, exact: true }).click();
  }

  async approvePlan(title: string): Promise<void> {
    await this.showTab('work');
    await this.workCard(title).getByRole('button', { name: APPROVE_PLAN }).click();
  }

  async approveAll(title: string): Promise<void> {
    await this.showTab('work');
    await this.workCard(title).getByRole('button', { name: APPROVE_ALL, exact: true }).click();
  }

  async takeAnyway(title: string): Promise<void> {
    await this.showTab('work');
    await this.workCard(title).getByRole('button', { name: TAKE_IT_ANYWAY, exact: true }).click();
  }

  async cancelPlan(title: string): Promise<void> {
    await this.showTab('work');
    const card = this.workCard(title);
    await card.getByRole('button', { name: CANCEL_ITEM, exact: true }).click();
    await card.getByRole('button', { name: CANCEL_WITHOUT_REASON, exact: true }).click();
  }

  async showTab(tab: EmployeeTabSegment): Promise<void> {
    const url = `${this.origin}${tabPath(this.requireAgent(), tab)}`;
    if (this.page.url().split('#')[0] !== url) {
      await this.page.goto(url, { waitUntil: 'networkidle' });
    }
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true });
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private requireAgent(): string {
    if (!this.agentId) throw new Error('no agent has been deployed on this dashboard yet.');
    return this.agentId;
  }
}
