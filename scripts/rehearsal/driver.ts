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
  /** Open the Surfaces tab of the agent page. */
  openSurfaces(): Promise<void>;
  /** Type a credential into a card's landing form and submit it. */
  landCredential(slug: string, value: string): Promise<void>;
  /** Approve a proposed card as the manager and as IT. */
  approveCard(slug: string): Promise<void>;
  /** Approve a proposed skill by name. */
  approveSkill(name: string): Promise<void>;
  /** Approve the drafted plan on a work item card. */
  approvePlan(title: string): Promise<void>;
  /** Approve every held action on a work item card. */
  approveAll(title: string): Promise<void>;
  /** Retry a skipped, failed or completed item, with a note when given. */
  retry(title: string, note?: string): Promise<void>;
  /** Cancel the plan on another item's card. */
  cancelPlan(title: string): Promise<void>;
  /** Return to the agent page's work queue. */
  showAgent(): Promise<void>;
  /** A full-page screenshot to a path. */
  screenshot(path: string): Promise<void>;
  /** Close the browser. */
  close(): Promise<void>;
}

/** The chat composer's placeholder while the manager may type. */
export const REPLY_PLACEHOLDER = 'type your reply…';
/** The line the chat shows once the seventh topic is answered. */
export const COMPLETE_LINE = 'conversation complete';

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
   *
   * Returns:
   *   The dashboard.
   */
  static async open(origin: string): Promise<PlaywrightDashboard> {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
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
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await complete.isVisible()) return 'complete';
      if ((await composer.count()) > 0 && (await composer.isEnabled())) return 'reply';
      await this.page.waitForTimeout(500);
    }
    throw new Error(`the 1:1 neither opened the composer nor completed within ${timeoutMs / 1000} s`);
  }

  async sendReply(text: string): Promise<void> {
    const composer = this.page.getByPlaceholder(REPLY_PLACEHOLDER);
    await composer.fill(text);
    await this.page.getByRole('button', { name: 'Send', exact: true }).click();
    await composer.and(this.page.locator(':disabled')).waitFor({ state: 'attached', timeout: 10_000 }).catch(() => undefined);
  }

  async lastAgentMessage(): Promise<string> {
    const bubbles = this.page.locator('div:not(.text-right) > div.inline-block');
    const count = await bubbles.count();
    return count === 0 ? '' : ((await bubbles.nth(count - 1).textContent()) ?? '').trim();
  }

  async approveCharter(): Promise<void> {
    await this.page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  }

  async openSurfaces(): Promise<void> {
    await this.page.goto(`${this.origin}/agent/${this.requireAgent()}#surfaces`, { waitUntil: 'networkidle' });
    await this.page.locator('article[id^="surface-"]').first().waitFor();
  }

  private card(slug: string): Locator {
    return this.page.locator(`article#surface-${slug}`);
  }

  async landCredential(slug: string, value: string): Promise<void> {
    const card = this.card(slug);
    const input = card.locator('input[id^="credential-"]');
    await input.fill(value);
    await card.getByRole('button', { name: /Land/ }).click();
    await input.waitFor({ state: 'detached', timeout: 60_000 });
  }

  async approveCard(slug: string): Promise<void> {
    const card = this.card(slug);
    await card.getByRole('button', { name: 'Approve as manager' }).click();
    await card.getByText('Manager approved').waitFor();
    await card.getByRole('button', { name: 'Approve as IT' }).click();
    await card.getByText('IT approved').waitFor({ timeout: 10_000 }).catch(() => undefined);
  }

  private workCard(title: string): Locator {
    return this.page
      .locator('h3', { hasText: title })
      .locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
  }

  async approveSkill(name: string): Promise<void> {
    await this.showAgent();
    const skill = this.page
      .locator('span.font-medium', { hasText: name })
      .locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
    await skill.getByRole('button', { name: 'Approve · author and verify' }).click();
  }

  async approvePlan(title: string): Promise<void> {
    await this.showAgent();
    await this.workCard(title).getByRole('button', { name: 'Approve plan' }).click();
  }

  async approveAll(title: string): Promise<void> {
    await this.showAgent();
    await this.workCard(title).getByRole('button', { name: 'Approve all' }).click();
  }

  async retry(title: string, note?: string): Promise<void> {
    await this.showAgent();
    const card = this.workCard(title);
    if (note !== undefined) await card.getByLabel('note for the retry').fill(note);
    await card.getByRole('button', { name: 'Retry', exact: true }).click();
  }

  async cancelPlan(title: string): Promise<void> {
    await this.showAgent();
    await this.workCard(title).getByRole('button', { name: 'Cancel', exact: true }).click();
  }

  async showAgent(): Promise<void> {
    const url = `${this.origin}/agent/${this.requireAgent()}`;
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
