/**
 * The 19 Sep second full run's `#ops-requests` ask (finding N), as the export
 * kept it: work item `nh77je61fq3d5tzb740nja1w918enm63`, the plan that began by creating a Linear ticket,
 * the eight actions the run emitted and the ledger beside them. Row 0 is the
 * create the attribution rule refused; rows 1 to 6 are the tile sequence and
 * row 7 the thread reply, all landed under the switch. Values are verbatim
 * from `workItems/documents.jsonl` in that run's export; nothing is invented.
 */
import type { MockAction } from '../../src/work/types';

export const REFUSED_CREATE_RUN = {
  "workItemId": "nh77je61fq3d5tzb740nja1w918enm63",
  "title": "Slack mention in #ops-requests",
  "contentSummary": "<@U0BTFK6FLNL> please refresh the pipeline tile to the standup figure",
  "replyTarget": {
    "channel": "C0C2U2UJUTU",
    "channelName": "ops-requests",
    "threadTs": "1789761553.312049"
  },
  "skipReason": "1 of 7 actions did not change the work environment: mcp.call (shared credential write without attributable content)",
  "plan": {
    "estimatedMinutes": 15,
    "expectedOutputType": "ticket-update",
    "obligations": {
      "basis": "judgement",
      "plannerTransition": "promised",
      "reason": "The plan moves the ticket to Done only if the tile's audit line, read back after the save, confirms the refresh landed; otherwise the ticket stays in progress.",
      "steps": [
        {
          "kind": "write",
          "reads": [],
          "reason": "Creates the Linear ticket in team REVOPS, project Q3 close recording the #ops-requests ask.",
          "writes": [
            "linear"
          ]
        },
        {
          "kind": "write",
          "reads": [
            "looker-pipeline-tile"
          ],
          "reason": "Runs the documented browser refresh sequence on the tile, saving 74%, then reads back the snapshot to quote the figure and audit line; stops with the observed failure if the audit line does not appear.",
          "writes": [
            "looker-pipeline-tile"
          ]
        },
        {
          "kind": "write",
          "reads": [],
          "reason": "Adds the audit comment on the Linear ticket quoting the tile's figure and audit line, or the observed failure.",
          "writes": [
            "linear"
          ]
        },
        {
          "kind": "write",
          "reads": [],
          "reason": "Posts the reply in the originating #ops-requests thread confirming the refresh with figure and audit line, or reporting the failure.",
          "writes": [
            "slack"
          ]
        },
        {
          "kind": "conditional-write",
          "reads": [
            "looker-pipeline-tile"
          ],
          "reason": "Moves the Linear ticket to Done only if the read-back audit line confirms the change landed.",
          "writes": [
            "linear"
          ]
        }
      ],
      "transition": "conditional-on-evidence",
      "transitionStep": 5
    },
    "reversibility": "The tile holds a single value that can be re-entered; the Linear comment and Slack reply are additive; the ticket state change is trivially reversible.",
    "riskNotes": "The runbook fixes the figure at 74% from the Friday standup summary, so no figure clarification is needed. If the Looker login or audit-line read-back fails, the ticket stays in progress with a failure comment and the operations lead is escalated via the manager DM. Northstar CRM and NetLedger play no part; no action is planned on them (no connected surface).",
    "steps": [
      "Create the ticket in Linear team REVOPS, project Q3 close recording the ask from #ops-requests thread C0C2U2UJUTU-1789761553.312049 (refresh the pipeline tile to the standup figure).",
      "Run the documented refresh sequence on looker-pipeline-tile in one browser session: navigate to http://looker-tile:8080/, sign in as revops, enter 74% in Pipeline coverage, click Save, then read back the snapshot and quote the visible figure and the audit line 'Last updated by <user> at <time> UTC'. If the page redirects, login fails, or the audit line does not appear, record the observed failure and stop.",
      "Add an audit comment on the Linear ticket stating the work completed and quoting the tile's figure and audit line (or the observed failure, leaving the ticket in progress).",
      "Reply in the originating Slack thread (channel C0C2U2UJUTU, thread_ts 1789761553.312049) confirming the refresh with the figure and audit line, or reporting the failure.",
      "If the audit line confirms the change landed, move the Linear ticket to Done with save_issue."
    ],
    "summary": "A #ops-requests ask asks for the pipeline tile to be refreshed to the standup figure. The revops handbook covers this work, so the ask is mine. The runbook fixes the approved figure at 74% and prescribes the browser sequence on the connected looker-pipeline-tile surface. I will triage the ask into a Linear ticket (team REVOPS, project Q3 close), run the documented refresh sequence, quote the tile's audit line as evidence in an audit comment, reply in the source Slack thread, and close the ticket."
  },
  "actions": [
    {
      "args": {
        "surface": "linear",
        "tool": "save_issue",
        "toolArgsJson": "{\"team\":\"REVOPS\",\"title\":\"Refresh the Looker pipeline tile to the standup figure\",\"description\":\"Ask from #ops-requests thread C0C2U2UJUTU:1789761553.312049: refresh the pipeline tile to the standup figure. Approved figure for this close: 74% (Friday standup coverage summary, per the tile runbook). Work: documented browser refresh sequence, audit line read back as evidence.\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_navigate",
        "toolArgsJson": "{\"url\":\"http://looker-tile:8080/\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_fill_form",
        "toolArgsJson": "{\"fields\":[{\"name\":\"Username\",\"value\":\"revops\"},{\"name\":\"Password\",\"value\":\"{{secret}}\"}]}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_click",
        "toolArgsJson": "{\"element\":\"Sign in\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_fill_form",
        "toolArgsJson": "{\"fields\":[{\"name\":\"Pipeline coverage\",\"value\":\"74%\"}]}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_click",
        "toolArgsJson": "{\"element\":\"Save\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_snapshot",
        "toolArgsJson": "{}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "body": "{\"channel\":\"C0C2U2UJUTU\",\"thread_ts\":\"1789761553.312049\",\"text\":\"Pipeline tile refreshed to the standup figure: the tile now shows 74%, audit line 'Last updated by revops at 2026-09-18 21:44:11 UTC'. Note: the Linear audit ticket for this ask (source thread C0C2U2UJUTU:1789761553.312049) could not be created — the Linear write failed — so the audit comment and ticket closure are pending; flagging to the manager.\"}",
        "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
        "method": "POST",
        "path": "/chat.postMessage",
        "surface": "slack"
      },
      "tool": "http.request"
    }
  ],
  "applied": [
    {
      "idempotencyKey": "nh77je61fq3d5tzb740nja1w918enm63:k978jhw6aye3qjk6zm92txxxn18envga:0",
      "ok": false,
      "reason": "shared credential write without attributable content",
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "browser_navigate on looker-pipeline-tile · ### Ran Playwright code ```js await page.goto('http://looker-tile:8080/'); ``` ### Page - Page URL: http://looker-tile:8080/ - Page Title: Sign in - Looker ### Snapshot - [Snapshot](.playwright-mcp/page-2026-09-18T21-44-07-765Z.yml)",
      "idempotencyKey": "nh77je61fq3d5tzb740nja1w918enm63:k978jhw6aye3qjk6zm92txxxn18envga:1",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "browser_fill_form on looker-pipeline-tile · ### Ran Playwright code ```js await page.getByRole('textbox', { name: 'Username' }).fill('revops'); await page.getByRole('textbox', { n…",
      "idempotencyKey": "nh77je61fq3d5tzb740nja1w918enm63:k978jhw6aye3qjk6zm92txxxn18envga:2",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "browser_click on looker-pipeline-tile · ### Ran Playwright code ```js await page.getByRole('button', { name: 'Sign in' }).click(); ``` ### Page - Page URL: http://looker-tile:8080…",
      "idempotencyKey": "nh77je61fq3d5tzb740nja1w918enm63:k978jhw6aye3qjk6zm92txxxn18envga:3",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "browser_fill_form on looker-pipeline-tile · ### Ran Playwright code ```js await page.getByRole('textbox', { name: 'Pipeline coverage' }).fill('74%'); ```",
      "idempotencyKey": "nh77je61fq3d5tzb740nja1w918enm63:k978jhw6aye3qjk6zm92txxxn18envga:4",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "browser_click on looker-pipeline-tile · ### Ran Playwright code ```js await page.getByRole('button', { name: 'Save' }).click(); ``` ### Page - Page URL: http://looker-tile:8080/ti…",
      "idempotencyKey": "nh77je61fq3d5tzb740nja1w918enm63:k978jhw6aye3qjk6zm92txxxn18envga:5",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "browser_snapshot on looker-pipeline-tile · visible figure 74% · Last updated by revops at 2026-09-18 21:44:11 UTC",
      "idempotencyKey": "nh77je61fq3d5tzb740nja1w918enm63:k978jhw6aye3qjk6zm92txxxn18envga:6",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "HTTP 200 · {\"ok\":true,\"channel\":\"C0C2U2UJUTU\",\"ts\":\"1789767883.691869\",\"message\":{\"subtype\":\"bot_message\",\"text\":\"Pipeline tile refreshed to the standup figure: the tile now shows…",
      "idempotencyKey": "nh77je61fq3d5tzb740nja1w918enm63:k978jhw6aye3qjk6zm92txxxn18envga:7",
      "ok": true,
      "providerId": "1789767883.691869",
      "tool": "http.request"
    }
  ],
  "planStepOutcomes": [
    {
      "evidence": "Ledger row 0: the save_issue call creating the ticket in team REVOPS, project Q3 close failed ('shared credential write without attributable content'). No ticket exists, so no identifier can be cited.",
      "status": "blocked",
      "step": 1
    },
    {
      "evidence": "Ledger rows 1-6: navigate, sign-in form, Sign in click, Pipeline coverage filled with 74%, Save click, and snapshot read-back showing visible figure 74% and audit line 'Last updated by revops at 2026-09-18 21:44:11 UTC'.",
      "status": "satisfied",
      "step": 2
    },
    {
      "evidence": "No Linear ticket was created (ledger row 0 failed), so there is no issue on which to post the audit comment quoting the figure and audit line.",
      "status": "blocked",
      "step": 3
    },
    {
      "evidence": "The chat.postMessage action in this response replies in channel C0C2U2UJUTU, thread_ts 1789761553.312049, confirming the refresh with the figure and audit line and reporting the ticket-creation failure.",
      "status": "satisfied",
      "step": 4
    },
    {
      "evidence": "The audit line confirms the change landed (ledger row 6), but no Linear ticket exists to move to Done; the save_issue state change cannot be emitted without an issue id.",
      "status": "blocked",
      "step": 5
    }
  ],
  "prerequisiteCount": 7
} as const;

/** Row 0 of the run: the ticket create, with the arguments the skill authored. */
export const REFUSED_CREATE_ACTION: MockAction = {
  tool: REFUSED_CREATE_RUN.actions[0].tool,
  args: { ...REFUSED_CREATE_RUN.actions[0].args },
};
