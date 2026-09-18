/**
 * The 16 September 21:07 UTC browser failure, as recorded in the 17 September
 * export (`work.failed` payloads for the Slack mention and REVOPS-7): the
 * sign-in page the driver served, the two runs' action lists, and the Slack
 * mention's plan and closing set. The dashboard page is rendered the way
 * `looker-tile/server.js` renders it; the export holds only its evidence line.
 */
import type { McpClientLike } from '../../src/surfaces/mcp';
import type { ExecutionPlan, MockAction } from '../../src/work/types';

/** The page a new `--isolated` browser context shows before any navigate, as the ledger recorded it. */
export const BLANK_PAGE = '### Page\n- Page URL: about:blank\n### Snapshot\n```yaml\n```';

/** The tile's sign-in page, REVOPS-7 idx 1 of the export with its line breaks restored. */
export const SIGN_IN_PAGE = [
  '### Page',
  '- Page URL: http://looker-tile:8080/',
  '- Page Title: Sign in - Looker',
  '### Snapshot',
  '```yaml',
  '- main [ref=e2]:',
  '  - generic [ref=e3]:',
  '    - generic [ref=e4]: L',
  '    - generic [ref=e5]: Looker',
  '  - generic [ref=e6]:',
  '    - heading "Sign in" [level=1] [ref=e7]',
  '    - paragraph [ref=e8]: RevOps pipeline dashboard',
  '    - generic [ref=e9]:',
  '      - generic [ref=e10]: Username',
  '      - textbox "Username" [ref=e11]',
  '    - generic [ref=e12]:',
  '      - generic [ref=e13]: Password',
  '      - textbox "Password" [ref=e14]',
  '    - button "Sign in" [ref=e15] [cursor=pointer]',
  '  - paragraph [ref=e16]: Internal RevOps dashboard. No API or integration surface is available.',
  '```',
].join('\n');

/** The tile's one figure and its audit stamp, as the server keeps them. */
export interface TileState {
  value: string;
  updatedBy?: string;
  updatedAt?: string;
}

/**
 * The signed-in dashboard as the driver would render it.
 *
 * Args:
 *   tile: The figure and audit stamp the server holds now.
 *   url: The page's address after the request that rendered it.
 *
 * Returns:
 *   The snapshot text.
 */
export function dashboardPage(tile: TileState, url = 'http://looker-tile:8080/login'): string {
  const audit =
    tile.updatedBy && tile.updatedAt
      ? `Last updated by ${tile.updatedBy} at ${tile.updatedAt} UTC`
      : 'Never updated since this instance started.';
  return [
    '### Page',
    `- Page URL: ${url}`,
    '- Page Title: Pipeline coverage - Looker',
    '### Snapshot',
    '```yaml',
    '- main [ref=e2]:',
    '  - generic [ref=e3]:',
    '    - generic [ref=e4]: L',
    '    - generic [ref=e5]: Looker',
    '  - generic [ref=e6]:',
    '    - heading "Pipeline coverage" [level=1] [ref=e17]',
    '    - paragraph [ref=e18]: Q3 close · RevOps',
    '    - generic [ref=e19]:',
    `      - generic [ref=e20]: ${tile.value}`,
    '      - generic [ref=e21]: of target covered',
    '    - generic [ref=e22]:',
    '      - generic [ref=e23]: Pipeline coverage',
    `      - textbox "Pipeline coverage" [ref=e24]: ${tile.value}`,
    '    - button "Save" [ref=e25] [cursor=pointer]',
    `    - paragraph [ref=e26]: ${audit}`,
    '  - paragraph [ref=e16]: Internal RevOps dashboard. No API or integration surface is available.',
    '```',
  ].join('\n');
}

/** One call the driver served, with the browser context that served it. */
export interface TileDriverCall {
  context: number;
  /** Whose apply was running, when the test labelled it. */
  label?: string;
  tool: string;
  args: Record<string, unknown>;
}

type ToolResult = { isError?: true; content: Array<{ type: string; text: string }> };

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const failure = (value: string): ToolResult => ({ isError: true, ...text(value) });

/**
 * The pinned browser driver in front of one tile server, as a test double.
 *
 * Under `--isolated` every MCP session is its own browser context: a new
 * client starts at `about:blank`, signed out, and nothing it does reaches
 * another client's page. The tile behind them is one server, so a Save in
 * one context is what every later sign-in reads.
 */
export class TileDriver {
  readonly tile: TileState = { value: '68%' };
  readonly calls: TileDriverCall[] = [];
  /** Labels the calls that follow, so a test can tell whose apply a context served. */
  label: string | undefined;
  private contexts = 0;

  /**
   * Args:
   *   password: The credential the sign-in form accepts.
   *   refuse: Answers a call with a driver error instead of serving it.
   */
  constructor(
    private readonly password: string,
    private readonly refuse: (call: TileDriverCall) => string | undefined = () => undefined,
  ) {}

  /** Every context that served a call under this label. */
  contextsServing(label: string): Set<number> {
    return new Set(this.calls.filter((call) => call.label === label).map((call) => call.context));
  }

  /**
   * A new MCP client, which is a new browser context.
   *
   * Args:
   *   serverName: The surface slug the tools are namespaced under.
   *
   * Returns:
   *   The client.
   */
  client(serverName: string): McpClientLike {
    this.contexts += 1;
    const context = this.contexts;
    const page = {
      at: 'blank' as 'blank' | 'sign-in' | 'dashboard',
      url: 'about:blank',
      signedIn: false,
      fields: new Map<string, string>(),
    };
    const render = (): string =>
      page.at === 'blank'
        ? BLANK_PAGE
        : page.at === 'sign-in'
          ? SIGN_IN_PAGE
          : dashboardPage(this.tile, page.url);
    const tools: Record<string, (args: Record<string, unknown>) => ToolResult> = {
      browser_navigate: (args) => {
        page.url = new URL(String(args.url)).href;
        page.at = page.signedIn ? 'dashboard' : 'sign-in';
        return text(
          `### Page\n- Page URL: ${page.url}\n- Page Title: ${page.signedIn ? 'Pipeline coverage' : 'Sign in'} - Looker`,
        );
      },
      browser_snapshot: () => text(render()),
      browser_fill_form: (args) => {
        if (page.at === 'blank') return failure('Error: no page is open');
        for (const field of (args.fields as Array<{ name: string; value: string }>) ?? []) {
          page.fields.set(field.name, field.value);
        }
        return text('### Ran Playwright code\nawait page.getByRole(...).fill(...)');
      },
      browser_click: (args) => {
        const element = String(args.element);
        if (page.at === 'sign-in' && element === 'Sign in') {
          if (page.fields.get('Username') === 'revops' && page.fields.get('Password') === this.password) {
            page.signedIn = true;
            page.at = 'dashboard';
            page.url = 'http://looker-tile:8080/login';
          }
          return text(`### Page\n- Page URL: ${page.url}`);
        }
        if (page.at === 'dashboard' && element === 'Save') {
          this.tile.value = page.fields.get('Pipeline coverage') ?? this.tile.value;
          this.tile.updatedBy = 'revops';
          this.tile.updatedAt = '2026-09-16 21:07:34';
          page.url = 'http://looker-tile:8080/tile';
          return text(`### Page\n- Page URL: ${page.url}`);
        }
        return failure(`Error: no element "${element}" on ${page.url}`);
      },
    };
    return {
      listTools: async () =>
        Object.fromEntries(
          Object.entries(tools).map(([tool, handler]) => [
            `${serverName}_${tool}`,
            {
              execute: async (args: unknown): Promise<unknown> => {
                const call: TileDriverCall = {
                  context,
                  label: this.label,
                  tool,
                  args: (args ?? {}) as Record<string, unknown>,
                };
                this.calls.push(call);
                const refused = this.refuse(call);
                return refused ? failure(refused) : handler(call.args);
              },
            },
          ]),
        ),
      disconnect: async (): Promise<void> => {},
    };
  }
}

const looker = (tool: string, args: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call',
  args: { surface: 'looker', tool, toolArgsJson: JSON.stringify(args) },
});

const navigate = looker('browser_navigate', { url: 'http://looker-tile:8080/' });
const signIn = looker('browser_fill_form', {
  fields: [
    { name: 'Username', value: 'revops' },
    { name: 'Password', value: '{{secret}}' },
  ],
});
const clickSignIn = looker('browser_click', { element: 'Sign in' });
const snapshot = looker('browser_snapshot', {});
const fillCoverage = looker('browser_fill_form', {
  fields: [{ name: 'Pipeline coverage', value: '74%' }],
});
const clickSave = looker('browser_click', { element: 'Save' });

/** The manager's DM channel on the export's Slack surface. */
export const MANAGER_DM = 'D0BS5SXMXPZ';

/** The Slack mention's phase one, idx 0-3: navigate, sign in, read the tile. */
export const slackPhaseOne: MockAction[] = [navigate, signIn, clickSignIn, snapshot];

/** The Slack mention's closing set, idx 4-7: the model's own, with no navigate and no sign-in. */
export const slackClosing: MockAction[] = [
  fillCoverage,
  clickSave,
  snapshot,
  {
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      headersJson: JSON.stringify({
        Authorization: 'Bearer {{secret}}',
        'Content-Type': 'application/json; charset=utf-8',
      }),
      body: JSON.stringify({
        channel: MANAGER_DM,
        text: 'Coverage ask (C0BSF04TZ19 / 1787746453.202809): the Looker tile showed 68%, not the approved 74%, so I applied the documented refresh (74% entered, Save clicked) and am reading back the audit line. The thread reply quoting the figure and audit line will follow once that read-back lands. Also flagging: per-deal reconciliation for the three Friday standup deals cannot be confirmed - no Q4 pipeline tracker surface is connected and Northstar CRM has no approved access path. Should I request an approved access path?',
      }),
    },
  },
];

/** REVOPS-7's phase one, idx 0-6: the whole tile sequence in one invocation. */
export const revops7PhaseOne: MockAction[] = [
  navigate,
  snapshot,
  signIn,
  clickSignIn,
  fillCoverage,
  clickSave,
  snapshot,
];

/** The Slack mention's approved plan, as the export's item row carries it. */
export const slackPlan: ExecutionPlan = {
  summary:
    'Slack ask in #revops-asks: confirm pipeline coverage for the three Friday standup deals before the Q3 close summary. The approved coverage figure is documented (74%), so I will verify the Looker tile shows it with a fresh audit line, refreshing only if it does not, then reply in the originating thread.',
  steps: [
    'Open the Looker pipeline tile at http://looker-tile:8080/ in the connected browser session, sign in with the stored revops credential, and read the visible figure and audit line.',
    "If the tile does not already show 74% with an audit line from this close, fill 'Pipeline coverage' with 74% exactly and click Save, then read back the audit line ('Last updated by <user> at <time> UTC') in the same session; if the page redirects, login fails, or no audit line appears, record the failure and stop.",
    'Reply in the originating #revops-asks thread (channel C0BSF04TZ19, thread_ts 1787746453.202809) quoting the visible figure and audit line as the coverage confirmation, and stating that per-deal reconciliation for the three Friday standup deals cannot be confirmed because no Q4 pipeline tracker surface is connected and Northstar CRM has no approved access path.',
    'Record the outcome and the named gap in the run response summary for the manager.',
  ],
  expectedOutputType: 'message',
  riskNotes:
    'No Q4 pipeline tracker surface is connected and Northstar CRM is absent, so deal reconciliation is reported as not confirmed in the reply rather than attempted.',
  reversibility:
    'The Slack reply is a normal message that can be corrected with a follow-up. The refresh only fires if the tile does not already show the approved figure.',
  estimatedMinutes: 15,
  obligations: {
    steps: [
      { kind: 'read', reads: ['looker'], writes: [] },
      { kind: 'conditional-write', reads: ['looker'], writes: ['looker'] },
      { kind: 'write', reads: [], writes: ['slack'] },
      { kind: 'report', reads: [], writes: [] },
    ],
    transition: 'none',
    transitionStep: null,
    basis: 'judgement',
  },
};

/** The Slack mention's closing reply, draft, notes and plan-step accounting as exported. */
export const slackClosingReply = {
  draft:
    "Coverage check for the #revops-asks ask (channel C0BSF04TZ19, thread 1787746453.202809): the Looker tile was opened and signed in successfully, but the visible figure read 68%, not the approved 74%. The refresh sequence has been emitted in this response: fill 'Pipeline coverage' with 74%, click Save, and read back the audit line in the same session. A manager DM has been sent flagging that the tile needed a refresh and that the reply will follow once the audit line is read.",
  notes:
    "The tile showed 68% before refresh, so the plan's conditional refresh branch applies; the thread reply is withheld because the audit-line evidence it must quote does not exist in the ledger yet.",
  actions: slackClosing,
  procedureTrails: [],
  planStepOutcomes: [
    {
      step: 1,
      status: 'satisfied' as const,
      basis: 'ledger' as const,
      evidence:
        "Ledger rows 0-3: browser_navigate to http://looker-tile:8080/ (title 'Sign in - Looker'), fill_form with revops credential, click 'Sign in', snapshot showing visible figure 68%.",
    },
    {
      step: 2,
      status: 'satisfied' as const,
      basis: 'ledger' as const,
      evidence:
        "Actions 0-2 in this response: browser_fill_form 'Pipeline coverage' = 74% exactly, browser_click 'Save', browser_snapshot to read back the audit line in the same session.",
    },
    {
      step: 3,
      status: 'blocked' as const,
      basis: 'ledger' as const,
      evidence:
        'The reply must quote the visible figure and audit line as coverage confirmation, but the ledger shows only the pre-refresh figure (68%); the post-save audit line is not yet in the ledger, so no truthful reply text can be authored in this response.',
    },
    {
      step: 4,
      status: 'satisfied' as const,
      basis: 'ledger' as const,
      evidence:
        'This run response summary (draft and notes) records the outcome and the named gap: tile showed 68%, refresh applied, per-deal reconciliation unconfirmable.',
    },
  ],
};
