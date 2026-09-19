import type { AppliedAction } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction, PlanStepOutcome } from '../../../src/work/types';

/**
 * Priya's `#revops-asks` ask from the fourth full internal run of 19 September
 * (main 0ba9479, real mode, autonomy on): the work item, its approved plan with
 * the declared obligations, the four phase-one actions with their ledger, and
 * the closing set (fill, Save, snapshot, manager DM) with the ledger the apply
 * wrote and the closing phase's plan-step accounting. The item ended
 * `completed` with no reply in its thread (finding W). Every string is the
 * run's own, read from `findings/priya-revops-asks-completed-no-reply.jsonl`;
 * each ledger `effect` is cut at 300 characters and the snapshot row's
 * `sessionRestore` is left out.
 */

export const REVOPS_ASKS_ASK = {
  "sourceCategory": "event-stream",
  "sourceSystem": "slack",
  "externalId": "C0BSF04TZ19:1789761481.815889",
  "externalClaimKey": "slack:T0BSQSQG0UU:C0BSF04TZ19:1789761481.815889",
  "title": "Slack mention in #revops-asks",
  "contentSummary": "<@U0BTFK6FLNL> can you confirm pipeline coverage for the three Friday standup deals before the Q3 close summary goes out?",
  "contentRefs": [
    "https://app.slack.com/client/T0BSQSQG0UU/C0BSF04TZ19/thread/C0BSF04TZ19-1789761481815889"
  ],
  "replyTarget": {
    "channel": "C0BSF04TZ19",
    "channelName": "revops-asks",
    "threadTs": "1789761481.815889"
  },
  "requester": "U0BTFHN6MKJ"
} as const;

/** The sibling ask that took the page-field claim, as the withheld rows name it. */
export const OPS_REQUESTS_ASK_TITLE = 'Slack mention in #ops-requests';

export const revopsAsksPlan = {
  "estimatedMinutes": 25,
  "expectedOutputType": "message",
  "obligations": {
    "basis": "judgement",
    "reason": "The plan says nothing about moving any Linear ticket's state; it refreshes the tile, drafts a manager-held reply and reports the tracker gap.",
    "steps": [
      {
        "kind": "read",
        "reads": [
          "looker-pipeline-tile"
        ],
        "reason": "Opens the documented browser sequence and snapshots the tile to check whether it already shows 74% with a current audit line.",
        "writes": []
      },
      {
        "kind": "conditional-write",
        "reads": [
          "looker-pipeline-tile"
        ],
        "reason": "Only if the tile lacks 74% with a current audit line, emit the fill/Save/snapshot refresh sequence and read back the audit line as evidence.",
        "writes": [
          "looker-pipeline-tile"
        ]
      },
      {
        "kind": "write",
        "reads": [],
        "reason": "Sends the drafted thread reply (figure, audit line, tracker gap) to the manager DM for approval of the exact text before anything is posted.",
        "writes": [
          "slack"
        ]
      },
      {
        "kind": "report",
        "reads": [],
        "reason": "Records the figure, audit line and tracker gap as a report in the run response, touching no surface.",
        "writes": []
      }
    ],
    "transition": "none",
    "transitionStep": null
  },
  "reversibility": "The tile holds a single hand-maintained figure; a refresh can be re-entered by the operations lead. The Slack reply is not sent until the manager approves the exact text. No Linear state changes are planned.",
  "riskNotes": "The three Friday standup deals cannot be individually confirmed: the Q4 pipeline tracker is not among the connected surfaces, and Northstar CRM is absent with no approved access path — per the checklist, Northstar plays no part in the close checks, so this is a tracker-access gap for the manager to settle at approval. The tile refresh write and the Slack thread reply are both held for the manager's literal approval while autonomous actions are off; a failed login, redirect, or missing audit line is recorded as data and the run stops rather than retrying.",
  "steps": [
    "Read the Looker pipeline tile page state by opening the documented browser sequence on looker-pipeline-tile (navigate, sign in as revops, snapshot) to see whether the tile already shows 74% with an audit line from this close.",
    "If the tile does not already show 74% with a current audit line, emit the full refresh sequence in the same session (fill Pipeline coverage with 74%, click Save, snapshot) and read back the audit line 'Last updated by <user> at <time> UTC' as evidence; this browser write parks for exact-action manager approval.",
    "Draft the reply to the ask in its #revops-asks thread quoting the visible figure and the audit line exactly, and send the draft to the manager DM for approval of the exact text before anything is posted; note in the draft that per-deal reconciliation for the three standup deals needs the Q4 pipeline tracker, which has no connected surface, and ask the manager to obtain an approved access path.",
    "Record the outcome (figure, audit line, tracker gap) as a report in this run's response for the manager."
  ],
  "summary": "Slack ask in #revops-asks: confirm pipeline coverage for the three Friday standup deals before the Q3 close summary goes out. The approved coverage figure for this close is 74% (Friday standup summary, per the tile runbook), so the work is to refresh the Looker pipeline tile by the documented browser sequence, read back the audit line as evidence, and draft a thread reply quoting the figure and audit line. The per-deal reconciliation (check 2 of the Q3 close checklist) needs the Q4 pipeline tracker, which is not a connected surface — that gap goes to the manager. All writes (browser save, Slack reply, any Linear audit comment) are held for the manager's literal approval while autonomous actions are off; only reads and the manager DM land now."
} as ExecutionPlan;

export const revopsAsksPhaseOne: MockAction[] = [
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
      "tool": "browser_snapshot",
      "toolArgsJson": "{}"
    },
    "tool": "mcp.call"
  }
];

export const revopsAsksPhaseOneLedger = [
  {
    "authority": "autonomous",
    "effect": "browser_navigate on looker-pipeline-tile · ### Ran Playwright code ```js await page.goto('http://looker-tile:8080/'); ``` ### Page - Page URL: http://looker-tile:8080/ - Page Title: Sign in - Looker ### Snapshot - [Snapshot](.playwright-mcp/page-2026-09-19T01-48-32-611Z.yml)",
    "idempotencyKey": "nh77jdv0197e3thhjmfy683h3x8eqr10:k97eeyrbrqfqv94tmpm7yk3prd8epg69:0",
    "ok": true,
    "tool": "mcp.call"
  },
  {
    "authority": "autonomous",
    "effect": "browser_fill_form on looker-pipeline-tile · ### Ran Playwright code ```js await page.getByRole('textbox', { name: 'Username' }).fill('revops'); await page.getByRole('textbox', { n…",
    "idempotencyKey": "nh77jdv0197e3thhjmfy683h3x8eqr10:k97eeyrbrqfqv94tmpm7yk3prd8epg69:1",
    "ok": true,
    "tool": "mcp.call"
  },
  {
    "authority": "autonomous",
    "effect": "browser_click on looker-pipeline-tile · ### Ran Playwright code ```js await page.getByRole('button', { name: 'Sign in' }).click(); ``` ### Page - Page URL: http://looker-tile:8080…",
    "idempotencyKey": "nh77jdv0197e3thhjmfy683h3x8eqr10:k97eeyrbrqfqv94tmpm7yk3prd8epg69:2",
    "ok": true,
    "tool": "mcp.call"
  },
  {
    "authority": "autonomous",
    "effect": "browser_snapshot on looker-pipeline-tile · visible figure 68%",
    "idempotencyKey": "nh77jdv0197e3thhjmfy683h3x8eqr10:k97eeyrbrqfqv94tmpm7yk3prd8epg69:3",
    "ok": true,
    "tool": "mcp.call"
  }
] as AppliedAction[];

export const revopsAsksClosing: MockAction[] = [
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
      "body": "{\"channel\":\"D0BS5SXMXPZ\",\"text\":\"Escalation on the pipeline coverage ask (C0BSF04TZ19:1789761481.815889): the Looker tile showed 68%, so I have emitted the documented refresh to 74% (fill, Save, snapshot) and will read back the audit line as evidence. The thread reply quoting the figure and audit line will be drafted once that read-back lands. Separately: per-deal reconciliation of the three Friday standup deals (check 2 of the Q3 close checklist) needs the Q4 pipeline tracker, which has no approved connection surface. Could you obtain an approved access path for it? I have not substituted another source.\"}",
      "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
      "method": "POST",
      "path": "/chat.postMessage",
      "surface": "slack"
    },
    "tool": "http.request"
  }
];

export const revopsAsksClosingLedger = [
  {
    "effect": "mcp.call looker-pipeline-tile · browser_fill_form · {fields: [{name: \"Pipeline coverage\", value: \"74%\"}]}",
    "held": true,
    "idempotencyKey": "nh77jdv0197e3thhjmfy683h3x8eqr10:k97eeyrbrqfqv94tmpm7yk3prd8epg69:4",
    "ok": true,
    "reason": "withheld for another work item's claim: the page field \"pipeline coverage\" on looker-pipeline-tile is held by this employee's work item \"Slack mention in #ops-requests\" (executing); one work item writes an external item, so this write is not sent",
    "tool": "mcp.call"
  },
  {
    "effect": "mcp.call looker-pipeline-tile · browser_click · {element: \"Save\"}",
    "held": true,
    "idempotencyKey": "nh77jdv0197e3thhjmfy683h3x8eqr10:k97eeyrbrqfqv94tmpm7yk3prd8epg69:5",
    "ok": true,
    "reason": "withheld for another work item's claim: the page field \"pipeline coverage\" on looker-pipeline-tile is held by this employee's work item \"Slack mention in #ops-requests\" (executing); one work item writes an external item, so this write is not sent",
    "tool": "mcp.call"
  },
  {
    "authority": "autonomous",
    "effect": "browser_snapshot on looker-pipeline-tile · visible figure 68%",
    "idempotencyKey": "nh77jdv0197e3thhjmfy683h3x8eqr10:k97eeyrbrqfqv94tmpm7yk3prd8epg69:6",
    "ok": true,
    "tool": "mcp.call"
  },
  {
    "authority": "autonomous",
    "effect": "HTTP 200 · {\"ok\":true,\"channel\":\"D0BS5SXMXPZ\",\"ts\":\"1789782539.692389\",\"message\":{\"subtype\":\"bot_message\",\"text\":\"Escalation on the pipeline coverage ask (C0BSF04TZ19:1789761481.8…",
    "idempotencyKey": "nh77jdv0197e3thhjmfy683h3x8eqr10:k97eeyrbrqfqv94tmpm7yk3prd8epg69:7",
    "ok": true,
    "providerId": "1789782539.692389",
    "tool": "http.request"
  }
] as AppliedAction[];

export const revopsAsksOutcomes = [
  {
    "evidence": "Ledger rows 0-3: browser_navigate, sign-in fill, Sign in click and browser_snapshot landed on looker-pipeline-tile; the snapshot read the visible figure as 68%, so the tile did not already show 74% with a current audit line.",
    "status": "satisfied",
    "step": 1
  },
  {
    "evidence": "Actions 0-2 in this response emit the full refresh sequence in the same session: browser_fill_form with Pipeline coverage 74%, browser_click Save, browser_snapshot read-back for the audit line 'Last updated by <user> at <time> UTC'.",
    "status": "satisfied",
    "step": 2
  },
  {
    "evidence": "The thread reply must quote the visible figure and the audit line exactly, but the audit line exists only after the Save/snapshot in this response lands; it is not in the ledger, so the reply cannot be truthfully authored yet. The tracker-gap half of this step is fulfilled by action 3, the manager DM asking for an approved access path to the Q4 pipeline tracker.",
    "status": "blocked",
    "step": 3
  },
  {
    "evidence": "The outcome (tile read 68%, refresh emitted, audit line pending read-back, tracker gap escalated) is recorded in this response's draft and notes.",
    "status": "satisfied",
    "step": 4
  }
] as PlanStepOutcome[];

export const revopsAsksDraft = "Close status for the pipeline coverage ask (C0BSF04TZ19:1789761481.815889):\n\n1. Tile read: the Looker pipeline tile was opened and read in this run's browser session. It currently shows 68% with no audit line from this close — it does NOT already show the approved 74%, so the refresh sequence is being emitted now (fill Pipeline coverage with 74%, click Save, snapshot read-back).\n2. Refresh: the fill/Save/snapshot actions in this response perform the refresh by the documented sequence in 'How to refresh the Looker pipeline tile'. The evidence will be the audit line 'Last updated by <user> at <time> UTC' read back from the snapshot; that line is not yet in the ledger, so the figure cannot be reported as updated until it is read.\n3. Thread reply: the reply to the #revops-asks ask must quote the visible figure and the audit line exactly. It cannot be truthfully authored until the snapshot read-back lands, so it is not emitted in this response; it will be drafted from the applied ledger once the audit line exists.\n4. Tracker gap: per-deal reconciliation (check 2 of the Q3 close checklist) needs the Q4 pipeline tracker, which has no approved connection surface. Per the onboarding page ('Where the work needs a system that has no approved connection surface... ask the manager to obtain an approved access path'), this is escalated to the manager DM now (action 3).\n5. No Linear audit comment or state change is emitted: the originating surface is Slack, and the only Linear items related to this work (REVOPS-27 'Refresh the Looker pipeline tile', REVOPS-28 'Add the Q3 close-summary audit note') are other work items on the external-items list, so nothing is written to them from this run.";

export const revopsAsksNotes = "The tile showed 68%, not the approved 74%, so the refresh was required. The thread reply is withheld because the audit line it must quote exists only after the Save/snapshot in this response lands; authoring it now would assert an unevidenced figure. The Q4 pipeline tracker has no connected surface; escalated via manager DM.";
